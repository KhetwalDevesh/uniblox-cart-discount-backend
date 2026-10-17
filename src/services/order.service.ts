import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../domain/errors";
import type { OrderRepository } from "../repositories";
import { type OrderView, toOrderView } from "./order-view";

export class OrderService {
	constructor(
		private readonly db: PrismaClient,
		private readonly orders: OrderRepository,
	) {}

	async get(id: string): Promise<OrderView> {
		const order = await this.orders.findById(this.db, id);
		if (!order) throw new NotFoundError("ORDER_NOT_FOUND", `Order ${id} does not exist`);
		return toOrderView(order);
	}
}
