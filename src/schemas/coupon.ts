import { Type } from "@sinclair/typebox";
import { t } from "elysia";
import { Uuid } from "./common";

export const CouponModel = t.Object(
	{
		id: Uuid,
		code: t.String({ examples: ["SAVE10-K7Q2XM4P"] }),
		milestone: Type.Integer({
			description: "Order milestone this coupon rewards (1 = first n orders)",
		}),
		discountPercent: Type.Integer({ description: "Percentage taken off the order subtotal" }),
		status: t.Union([t.Literal("AVAILABLE"), t.Literal("REDEEMED")]),
		generatedAt: t.String({ format: "date-time" }),
		redeemedAt: t.Union([t.String({ format: "date-time" }), t.Null()]),
		redeemedOrderId: t.Union([Uuid, t.Null()]),
	},
	{ title: "Coupon" },
);

export const CouponListQuery = t.Object({
	status: t.Optional(t.Union([t.Literal("AVAILABLE"), t.Literal("REDEEMED")])),
});
