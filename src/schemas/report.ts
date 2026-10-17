import { Type } from "@sinclair/typebox";
import { t } from "elysia";
import { Money, Uuid } from "./common";

export const ReportModel = t.Object(
	{
		ordersCount: Type.Integer({ description: "Successfully placed orders" }),
		purchasedQuantityByProduct: t.Array(
			t.Object({
				productId: Uuid,
				name: t.String({ description: "Product name on its most recent order" }),
				quantity: Type.Integer({ description: "Units sold across all orders" }),
			}),
		),
		revenue: t.Object({
			gross: { ...Money, description: "Sum of order subtotals, before discounts" },
			discounts: { ...Money, description: "Total discounts granted" },
			net: { ...Money, description: "gross - discounts (equals the sum of order totals)" },
		}),
		coupons: t.Object({
			generated: Type.Integer(),
			available: Type.Integer({ description: "Generated and not yet redeemed" }),
			redeemed: Type.Integer(),
		}),
	},
	{ title: "Report" },
);
