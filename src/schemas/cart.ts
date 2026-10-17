import { Type } from "@sinclair/typebox";
import { t } from "elysia";
import { Money, Uuid } from "./common";

export const CartLineModel = t.Object(
	{
		productId: Uuid,
		name: t.String(),
		quantity: Type.Integer(),
		unitPrice: { ...Money, description: "Current catalog price (what checkout would charge)" },
		unitPriceAtAdd: { ...Money, description: "Price recorded when the line was added" },
		priceChanged: t.Boolean({ description: "True when unitPrice differs from unitPriceAtAdd" }),
		lineTotal: Money,
	},
	{ title: "CartLine" },
);

export const CartModel = t.Object(
	{
		id: Uuid,
		status: t.Union([t.Literal("OPEN"), t.Literal("CHECKED_OUT")]),
		items: t.Array(CartLineModel),
		totalQuantity: Type.Integer(),
		subtotal: { ...Money, description: "Sum of line totals at current prices, before any coupon" },
	},
	{ title: "Cart" },
);

// Plain TypeBox integer on purpose: Elysia's own t.Integer coerces numeric strings ("2" -> 2),
// which would let a malformed quantity enter a cart silently.
const Quantity = Type.Integer({ minimum: 1, maximum: 99, description: "Whole units, 1 to 99" });

export const CartParams = t.Object({ id: Uuid });
export const CartItemParams = t.Object({ id: Uuid, productId: Uuid });
export const AddItemBody = t.Object({ productId: Uuid, quantity: Quantity });
export const SetQuantityBody = t.Object({ quantity: Quantity });
