import type { PrismaClient } from "@prisma/client";
import type { TransactionRunner, Tx } from "../db/transaction";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors";
import type { CartRepository, ProductRepository } from "../repositories";
import { buildCartView, type CartView } from "./cart-view";

export const MAX_LINE_QUANTITY = 99;

export class CartService {
	constructor(
		private readonly db: PrismaClient,
		private readonly transactions: TransactionRunner,
		private readonly carts: CartRepository,
		private readonly products: ProductRepository,
	) {}

	async create(): Promise<CartView> {
		const id = await this.carts.create(this.db);
		return this.view(this.db, id);
	}

	async get(cartId: string): Promise<CartView> {
		return this.view(this.db, cartId);
	}

	/** Adds `quantity` units. An existing line is incremented; its recorded price is kept. */
	async addItem(cartId: string, productId: string, quantity: number): Promise<CartView> {
		return this.mutate(cartId, async (tx) => {
			const product = await this.products.findById(tx, productId);
			if (!product)
				throw new NotFoundError("PRODUCT_NOT_FOUND", `Product ${productId} does not exist`);

			const existing = await this.carts.findLineQuantity(tx, cartId, productId);
			const resulting = (existing ?? 0) + quantity;
			this.assertQuantityAllowed(productId, resulting, product.stock);

			if (existing === null) {
				await this.carts.insertLine(tx, {
					cartId,
					productId,
					quantity,
					unitPriceAtAdd: product.price,
				});
			} else {
				await this.carts.setLineQuantity(tx, cartId, productId, resulting);
			}
		});
	}

	/** Sets an absolute quantity (idempotent, safe to retry). */
	async setQuantity(cartId: string, productId: string, quantity: number): Promise<CartView> {
		return this.mutate(cartId, async (tx) => {
			if ((await this.carts.findLineQuantity(tx, cartId, productId)) === null) {
				throw this.itemNotInCart(cartId, productId);
			}
			const product = await this.products.findById(tx, productId);
			if (!product)
				throw new NotFoundError("PRODUCT_NOT_FOUND", `Product ${productId} does not exist`);

			this.assertQuantityAllowed(productId, quantity, product.stock);
			await this.carts.setLineQuantity(tx, cartId, productId, quantity);
		});
	}

	async removeItem(cartId: string, productId: string): Promise<CartView> {
		return this.mutate(cartId, async (tx) => {
			if (!(await this.carts.deleteLine(tx, cartId, productId))) {
				throw this.itemNotInCart(cartId, productId);
			}
		});
	}

	/**
	 * Runs a cart change in one transaction holding the cart row lock. Concurrent changes to the
	 * same cart therefore run one after another, so read-modify-write on a line cannot lose
	 * updates, and nothing can be added once the cart is no longer open.
	 */
	private async mutate(cartId: string, change: (tx: Tx) => Promise<void>): Promise<CartView> {
		return this.transactions.run(async (tx) => {
			const locked = await this.carts.lockForUpdate(tx, cartId);
			if (!locked) throw this.cartNotFound(cartId);
			if (locked.status !== "OPEN") {
				throw new ConflictError("CART_NOT_OPEN", "Cart has already been checked out", { cartId });
			}
			await change(tx);
			return this.view(tx, cartId);
		});
	}

	private async view(client: Tx, cartId: string): Promise<CartView> {
		const record = await this.carts.findRecord(client, cartId);
		if (!record) throw this.cartNotFound(cartId);
		return buildCartView(record);
	}

	/** Quantity bounds plus a fast-fail stock check. Checkout re-checks stock authoritatively. */
	private assertQuantityAllowed(productId: string, quantity: number, stock: number): void {
		if (quantity > MAX_LINE_QUANTITY) {
			throw new ValidationError(`A cart line cannot exceed ${MAX_LINE_QUANTITY} units`, {
				productId,
				requested: quantity,
				max: MAX_LINE_QUANTITY,
			});
		}
		if (quantity > stock) {
			throw new ConflictError("INSUFFICIENT_STOCK", "Not enough stock for the requested quantity", {
				lines: [{ productId, requested: quantity, available: stock }],
			});
		}
	}

	private cartNotFound(cartId: string) {
		return new NotFoundError("CART_NOT_FOUND", `Cart ${cartId} does not exist`);
	}

	private itemNotInCart(cartId: string, productId: string) {
		return new NotFoundError("ITEM_NOT_IN_CART", `Product ${productId} is not in cart ${cartId}`);
	}
}
