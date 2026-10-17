import { Type } from "@sinclair/typebox";
import { t } from "elysia";
import { Money, Uuid } from "./common";

export const OrderItemModel = t.Object(
	{
		productId: Uuid,
		name: t.String({ description: "Product name at the time of purchase" }),
		quantity: Type.Integer(),
		unitPrice: { ...Money, description: "Unit price charged" },
		lineTotal: Money,
	},
	{ title: "OrderItem" },
);

export const OrderModel = t.Object(
	{
		id: Uuid,
		orderNumber: Type.Integer({
			description: "Display number. May have gaps; not used for milestones.",
		}),
		cartId: Uuid,
		items: t.Array(OrderItemModel),
		subtotal: Money,
		discount: Money,
		total: { ...Money, description: "subtotal - discount" },
		coupon: t.Union([t.Object({ code: t.String(), discountPercent: Type.Integer() }), t.Null()]),
		placedAt: t.String({ format: "date-time" }),
	},
	{ title: "Order" },
);

export const OrderParams = t.Object({ id: Uuid });

export const CheckoutBody = t.Object({
	acceptPriceChanges: t.Optional(
		t.Boolean({
			description:
				"Set true to be charged current prices when they differ from the prices recorded when items were added",
		}),
	),
});
