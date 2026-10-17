import type { TransactionRunner } from "../db/transaction";
import { type DiscountStrategy, NoDiscount, PercentageDiscount } from "../domain/discount";
import {
	ConflictError,
	NotFoundError,
	PaymentDeclinedError,
	UnprocessableError,
} from "../domain/errors";
import { formatMoney } from "../domain/money";
import { detectPriceChanges, priceOrder } from "../domain/order-pricing";
import type { PaymentGateway } from "../payment/payment-gateway";
import type {
	CartRepository,
	CouponRepository,
	OrderRepository,
	ProductRepository,
} from "../repositories";
import { normalizeCouponCode } from "./coupon.service";
import { type OrderView, toOrderView } from "./order-view";

export type CheckoutInput = {
	/** Optional single-use coupon code. Case-insensitive. */
	couponCode?: string;
	/** Accept live prices that differ from the prices recorded when the items were added. */
	acceptPriceChanges?: boolean;
};

export type CheckoutResult = {
	order: OrderView;
	/** True when this request returned an order created by an earlier request for the same cart. */
	replayed: boolean;
};

/**
 * Places an order for a cart. The whole operation is one transaction, so it either happens
 * completely (stock taken, payment accepted, order stored, cart closed) or not at all.
 */
export class CheckoutService {
	constructor(
		private readonly transactions: TransactionRunner,
		private readonly carts: CartRepository,
		private readonly products: ProductRepository,
		private readonly orders: OrderRepository,
		private readonly coupons: CouponRepository,
		private readonly payments: PaymentGateway,
	) {}

	async checkout(cartId: string, input: CheckoutInput = {}): Promise<CheckoutResult> {
		const couponCode =
			input.couponCode === undefined ? null : normalizeCouponCode(input.couponCode);

		return this.transactions.run(async (tx) => {
			// 1. Serialize everything that touches this cart. A concurrent retry waits here.
			const cart = await this.carts.lockForUpdate(tx, cartId);
			if (!cart) throw new NotFoundError("CART_NOT_FOUND", `Cart ${cartId} does not exist`);

			// 2. Already checked out: a retry of the same request returns the original order and
			//    changes nothing. A different request (another coupon) is refused, not re-priced.
			if (cart.status === "CHECKED_OUT") {
				const existing = await this.orders.findByCartId(tx, cartId);
				if (!existing) throw new Error(`Cart ${cartId} is checked out but has no order`);
				if ((couponCode ?? null) !== (existing.coupon?.code ?? null)) {
					throw new ConflictError(
						"CART_ALREADY_CHECKED_OUT",
						"This cart was already checked out with a different coupon. The original order stands.",
						{ cartId, orderId: existing.id },
					);
				}
				return { order: toOrderView(existing), replayed: true };
			}

			const lines = await this.carts.findCheckoutLines(tx, cartId);
			if (lines.length === 0) {
				throw new UnprocessableError("CART_EMPTY", "Cannot check out an empty cart", { cartId });
			}

			// 3. Lock the products in id order. Prices and stock are now frozen for this transaction.
			const products = await this.products.lockForCheckout(
				tx,
				lines.map((line) => line.productId),
			);
			const live = lines.map((line) => {
				const product = products.get(line.productId);
				if (!product) throw new Error(`Product ${line.productId} vanished while in a cart`);
				return { ...line, product };
			});

			// 4. Price check: the shopper must not be charged an amount they have not seen.
			const changes = detectPriceChanges(
				live.map((line) => ({
					productId: line.productId,
					unitPriceAtAdd: line.unitPriceAtAdd,
					livePrice: line.product.price,
				})),
			);
			if (changes.length > 0 && !input.acceptPriceChanges) {
				throw new ConflictError(
					"PRICE_CHANGED",
					"Prices changed since items were added. Review them and retry with acceptPriceChanges: true.",
					{
						lines: changes.map((change) => ({
							productId: change.productId,
							oldUnitPrice: formatMoney(change.oldUnitPrice),
							newUnitPrice: formatMoney(change.newUnitPrice),
						})),
					},
				);
			}

			// 5. Stock check: report every short line at once.
			const shortages = live
				.filter((line) => line.quantity > line.product.stock)
				.map((line) => ({
					productId: line.productId,
					requested: line.quantity,
					available: line.product.stock,
				}));
			if (shortages.length > 0) {
				throw new ConflictError("INSUFFICIENT_STOCK", "Not enough stock for some items", {
					lines: shortages,
				});
			}

			// 6. Claim the coupon (last lock in the fixed order: cart, products, coupon). It is only
			//    marked redeemed if this transaction commits; any failure below releases it again.
			let discount: DiscountStrategy = new NoDiscount();
			let coupon: { id: string; code: string; discountPercent: number } | undefined;
			if (couponCode !== null) {
				const claimed = await this.coupons.redeemIfAvailable(tx, couponCode);
				if (!claimed) {
					const known = await this.coupons.findByCode(tx, couponCode);
					if (!known) {
						throw new UnprocessableError("COUPON_NOT_FOUND", "Coupon code does not exist", {
							couponCode,
						});
					}
					throw new ConflictError("COUPON_ALREADY_REDEEMED", "Coupon has already been redeemed", {
						couponCode,
					});
				}
				coupon = { id: claimed.id, code: couponCode, discountPercent: claimed.discountPercent };
				discount = new PercentageDiscount(claimed.discountPercent);
			}

			// Price from the locked rows, so what is charged is what is stored.
			const priced = priceOrder(
				live.map((line) => ({
					productId: line.productId,
					name: line.product.name,
					unitPrice: line.product.price,
					quantity: line.quantity,
				})),
				discount,
			);

			// 7. Take the stock. The statement re-checks the quantity, so even without the lock
			//    above it could not drive stock negative.
			for (const line of live) {
				if (!(await this.products.decrementStock(tx, line.productId, line.quantity))) {
					throw new ConflictError("INSUFFICIENT_STOCK", "Not enough stock for some items", {
						lines: [
							{
								productId: line.productId,
								requested: line.quantity,
								available: line.product.stock,
							},
						],
					});
				}
			}

			// 8. Payment. A decline throws, which rolls back the stock taken above.
			const payment = await this.payments.charge({
				idempotencyKey: cartId,
				amount: priced.total,
			});
			if (!payment.approved) {
				throw new PaymentDeclinedError("Payment was declined", { reason: payment.reason });
			}

			// 9. Store the order snapshot and close the cart, in the same transaction.
			const order = await this.orders.create(tx, {
				cartId,
				lines: priced.lines,
				subtotal: priced.subtotal,
				discount: priced.discount,
				total: priced.total,
				coupon,
			});
			if (coupon) await this.coupons.linkOrder(tx, coupon.id, order.id);
			await this.carts.markCheckedOut(tx, cartId);

			return { order: toOrderView(order), replayed: false };
		});
	}
}
