import type { Tx } from "../db/transaction";
import type { Minor } from "../domain/money";
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
}
