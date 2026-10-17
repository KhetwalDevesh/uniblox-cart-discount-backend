import type { Tx } from "../db/transaction";
import { type Minor, parseMoney } from "../domain/money";
import { decimalToMinor } from "./mappers";

export type ProductRecord = {
	id: string;
	name: string;
	price: Minor;
	stock: number;
};

export class ProductRepository {
	async list(client: Tx): Promise<ProductRecord[]> {
		const rows = await client.product.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] });
		return rows.map((row) => ({ ...row, price: decimalToMinor(row.price) }));
	}

	async findById(client: Tx, id: string): Promise<ProductRecord | null> {
		const row = await client.product.findUnique({ where: { id } });
		return row ? { ...row, price: decimalToMinor(row.price) } : null;
	}

	/**
	 * Locks the given product rows (FOR UPDATE) and returns their current values.
	 * Rows are locked in ascending id order in every checkout, so two checkouts with overlapping
	 * products can never wait on each other in opposite order (no deadlocks). Because the rows are
	 * locked, the price and stock read here cannot change before this transaction ends.
	 */
	async lockForCheckout(tx: Tx, ids: string[]): Promise<Map<string, ProductRecord>> {
		const rows = await tx.$queryRaw<{ id: string; name: string; price: string; stock: number }[]>`
			SELECT id::text AS id, name, price::text AS price, stock
			FROM products
			WHERE id = ANY(${ids}::uuid[])
			ORDER BY id
			FOR UPDATE`;
		return new Map(rows.map((row) => [row.id, { ...row, price: parseMoney(row.price) }]));
	}

	/**
	 * Atomically takes `quantity` units. The guard lives in the statement itself (compare-and-set),
	 * so it is correct even if the lock above were ever missing. Returns false when stock is short.
	 */
	async decrementStock(tx: Tx, id: string, quantity: number): Promise<boolean> {
		const updated = await tx.$executeRaw`
			UPDATE products SET stock = stock - ${quantity}, updated_at = now()
			WHERE id = ${id}::uuid AND stock >= ${quantity}`;
		return updated === 1;
	}
}
