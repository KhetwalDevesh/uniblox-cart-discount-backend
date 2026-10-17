import { Elysia } from "elysia";
import { ErrorResponse } from "../schemas/common";
import { OrderModel, OrderParams } from "../schemas/order";
import type { OrderService } from "../services/order.service";

export const orderRouter = (orders: OrderService) =>
	new Elysia({ prefix: "/orders", tags: ["Orders"] }).get(
		"/:id",
		({ params }) => orders.get(params.id),
		{
			params: OrderParams,
			response: { 200: OrderModel, 400: ErrorResponse, 404: ErrorResponse },
			detail: {
				summary: "Get an order",
				description:
					"Returns the order exactly as placed: item names, unit prices, quantities, subtotal, " +
					"discount and total. Later product edits never change it. Errors: `404 ORDER_NOT_FOUND`.",
			},
		},
	);
