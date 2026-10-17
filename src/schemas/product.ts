import { t } from "elysia";
import { Money, Uuid } from "./common";

export const ProductModel = t.Object(
	{
		id: Uuid,
		name: t.String(),
		price: Money,
		stock: t.Integer({ description: "Units currently available (not a reservation)" }),
	},
	{ title: "Product" },
);

export const ProductParams = t.Object({ id: Uuid });
