import { beforeEach, describe, expect, test } from "bun:test";
import { get, MISSING_ID } from "../helpers/app";
import { createProduct, resetDb } from "../helpers/db";

beforeEach(resetDb);

describe("GET /products", () => {
	test("lists products with decimal-string prices and stock", async () => {
		await createProduct({ name: "Mug", price: "19.99", stock: 7 });
		await createProduct({ name: "Cup", price: "5.00", stock: 0 });

		const result = await get("/products");

		expect(result.status).toBe(200);
		expect(result.body.map((p: { name: string }) => p.name)).toEqual(["Cup", "Mug"]);
		expect(result.body[1]).toMatchObject({ name: "Mug", price: "19.99", stock: 7 });
	});
});

describe("GET /products/:id", () => {
	test("returns one product", async () => {
		const product = await createProduct({ name: "Mug", price: "19.99" });
		const result = await get(`/products/${product.id}`);
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ id: product.id, name: "Mug", price: "19.99" });
	});

	test("unknown product is 404 PRODUCT_NOT_FOUND", async () => {
		const result = await get(`/products/${MISSING_ID}`);
		expect(result.status).toBe(404);
		expect(result.body.code).toBe("PRODUCT_NOT_FOUND");
	});

	test("a malformed id is 400, not a server error", async () => {
		const result = await get("/products/not-a-uuid");
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("VALIDATION_ERROR");
	});
});
