import { Elysia, t } from "elysia";
import { ErrorResponse } from "../schemas/common";
import { ProductModel, ProductParams } from "../schemas/product";
import type { CatalogService } from "../services/catalog.service";

export const productRouter = (catalog: CatalogService) =>
	new Elysia({ prefix: "/products", tags: ["Products"] })
		.get("/", () => catalog.list(), {
			response: { 200: t.Array(ProductModel) },
			detail: {
				summary: "List products",
				description: "Returns every product with its current price and available stock.",
			},
		})
		.get("/:id", ({ params }) => catalog.get(params.id), {
			params: ProductParams,
			response: { 200: ProductModel, 400: ErrorResponse, 404: ErrorResponse },
			detail: {
				summary: "Get a product",
				description: "Errors: `404 PRODUCT_NOT_FOUND`, `400 VALIDATION_ERROR` (id is not a UUID).",
			},
		});
