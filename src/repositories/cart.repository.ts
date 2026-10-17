import type { Tx } from "../db/transaction";
import { formatMoney, type Minor } from "../domain/money";
import { decimalToMinor } from "./mappers";

export type CartStatus = "OPEN" | "CHECKED_OUT";

export type CartLineRecord = {
	productId: string;
	name: string;
	quantity: number;
	/** Price recorded when the line was added. */
	unitPriceAtAdd: Minor;
	/** Current catalog price. */
	livePrice: Minor;
};

export type CartRecord = {
	id: string;
	status: CartStatus;
	lines: CartLineRecord[];
};

export class CartRepository {
	async create(client: Tx): Promise<string> {
		const cart = await client.cart.create({ data: {}, select: { id: true } });
		return cart.id;
	}

	/**
	 * Locks the cart row for the rest of the transaction. Every cart mutation (and, later,
	 * checkout) takes this lock first, so operations on one cart run one at a time.
	 * Must be called with a transaction client, otherwise the lock is released immediately.
	 */
	async lockForUpdate(tx: Tx, id: string): Promise<{ status: CartStatus } | null> {
		const rows = await tx.$queryRaw<{ status: CartStatus }[]>`
			SELECT status FROM carts WHERE id = ${id}::uuid FOR UPDATE`;
		return rows[0] ?? null;
	}

	async findRecord(client: Tx, id: string): Promise<CartRecord | null> {
		const cart = await client.cart.findUnique({
			where: { id },
			include: { items: { include: { product: true }, orderBy: [{ addedAt: "asc" }] } },
		});
		if (!cart) return null;
		return {
			id: cart.id,
			status: cart.status,
			lines: cart.items.map((item) => ({
				productId: item.productId,
				name: item.product.name,
				quantity: item.quantity,
				unitPriceAtAdd: decimalToMinor(item.unitPriceAtAdd),
				livePrice: decimalToMinor(item.product.price),
			})),
		};
	}

	async findLineQuantity(client: Tx, cartId: string, productId: string): Promise<number | null> {
		const item = await client.cartItem.findUnique({
			where: { cartId_productId: { cartId, productId } },
			select: { quantity: true },
		});
		return item?.quantity ?? null;
	}

	async insertLine(
		tx: Tx,
		line: { cartId: string; productId: string; quantity: number; unitPriceAtAdd: Minor },
	): Promise<void> {
		await tx.cartItem.create({
			data: {
				cartId: line.cartId,
				productId: line.productId,
				quantity: line.quantity,
				unitPriceAtAdd: formatMoney(line.unitPriceAtAdd),
			},
		});
	}

	async setLineQuantity(
		tx: Tx,
		cartId: string,
		productId: string,
		quantity: number,
	): Promise<void> {
		await tx.cartItem.update({
			where: { cartId_productId: { cartId, productId } },
			data: { quantity },
		});
	}

	/** Returns true when a line was removed. */
	async deleteLine(tx: Tx, cartId: string, productId: string): Promise<boolean> {
		const { count } = await tx.cartItem.deleteMany({ where: { cartId, productId } });
		return count > 0;
	}

	/** Lines as recorded in the cart, without live product data (checkout reads that under lock). */
	async findCheckoutLines(
		tx: Tx,
		cartId: string,
	): Promise<{ productId: string; quantity: number; unitPriceAtAdd: Minor }[]> {
		const items = await tx.cartItem.findMany({
			where: { cartId },
			orderBy: [{ productId: "asc" }],
		});
		return items.map((item) => ({
			productId: item.productId,
			quantity: item.quantity,
			unitPriceAtAdd: decimalToMinor(item.unitPriceAtAdd),
		}));
	}

	async markCheckedOut(tx: Tx, cartId: string): Promise<void> {
		await tx.cart.update({
			where: { id: cartId },
			data: { status: "CHECKED_OUT", checkedOutAt: new Date() },
		});
	}
}
