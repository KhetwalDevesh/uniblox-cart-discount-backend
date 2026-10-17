import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../domain/errors";
import { formatMoney } from "../domain/money";
import type { ProductRecord, ProductRepository } from "../repositories";

export type ProductView = {
	id: string;
	name: string;
	price: string;
	/** Units currently available. Not a reservation: checkout is the authoritative check. */
	stock: number;
};

function toView(product: ProductRecord): ProductView {
	return {
		id: product.id,
		name: product.name,
		price: formatMoney(product.price),
		stock: product.stock,
	};
}

export class CatalogService {
	constructor(
		private readonly db: PrismaClient,
		private readonly products: ProductRepository,
	) {}

	async list(): Promise<ProductView[]> {
		return (await this.products.list(this.db)).map(toView);
	}

	async get(id: string): Promise<ProductView> {
		const product = await this.products.findById(this.db, id);
		if (!product) throw new NotFoundError("PRODUCT_NOT_FOUND", `Product ${id} does not exist`);
		return toView(product);
	}
}
