import { describe, expect, test } from "bun:test";
import { ERROR_CATALOG, type ErrorCode } from "../../src/docs/error-catalog";
import { checkout, createTestApp, get, MISSING_ID, newCart, post } from "../helpers/app";
import { createProduct, resetDb } from "../helpers/db";

const app = createTestApp();

// biome-ignore lint/suspicious/noExplicitAny: the OpenAPI document is inspected loosely
async function loadSpec(): Promise<any> {
	const response = await app.handle(new Request("http://localhost/swagger/json"));
	return response.json();
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * Elysia adds `additionalProperties: false` to shared schema objects the first time any app
 * compiles a route that uses them, so the generated spec differs by that one keyword depending on
 * what ran earlier in the process. It is cosmetic, so the staleness check ignores it.
 */
function withoutAdditionalProperties(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(withoutAdditionalProperties);
	if (node && typeof node === "object") {
		return Object.fromEntries(
			Object.entries(node)
				.filter(([key]) => key !== "additionalProperties")
				.map(([key, value]) => [key, withoutAdditionalProperties(value)]),
		);
	}
	return node;
}

describe("OpenAPI document", () => {
	test("every operation is summarised, tagged and documents a success response", async () => {
		const spec = await loadSpec();
		const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
			// biome-ignore lint/suspicious/noExplicitAny: loosely typed spec node
			Object.entries(item as Record<string, any>)
				.filter(([method]) => HTTP_METHODS.includes(method))
				.map(([method, operation]) => ({ id: `${method.toUpperCase()} ${path}`, operation })),
		);

		expect(operations.length).toBeGreaterThanOrEqual(14);
		for (const { id, operation } of operations) {
			expect(operation.summary, `${id} needs a summary`).toBeTruthy();
			expect(operation.tags?.length, `${id} needs a tag`).toBeGreaterThan(0);
			const successes = Object.keys(operation.responses).filter((code) => code.startsWith("2"));
			expect(successes.length, `${id} needs a 2xx response`).toBeGreaterThan(0);
		}
	});

	test("operations that take input document the 400 validation error", async () => {
		const spec = await loadSpec();
		for (const [path, item] of Object.entries(spec.paths)) {
			// biome-ignore lint/suspicious/noExplicitAny: loosely typed spec node
			for (const [method, operation] of Object.entries(item as Record<string, any>)) {
				if (!HTTP_METHODS.includes(method)) continue;
				const takesInput = (operation.parameters?.length ?? 0) > 0 || operation.requestBody;
				if (takesInput && path.startsWith("/api")) {
					expect(operation.responses["400"], `${method} ${path} should document 400`).toBeDefined();
				}
			}
		}
	});

	test("checkout documents every failure a client must handle", async () => {
		const spec = await loadSpec();
		const checkout = spec.paths["/api/carts/{id}/checkout"].post;
		for (const status of ["200", "201", "400", "402", "404", "409", "422"]) {
			expect(checkout.responses[status], `checkout should document ${status}`).toBeDefined();
		}
	});

	test("the description lists every error code, with the status from the catalog", async () => {
		const spec = await loadSpec();
		for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
			expect(spec.info.description).toContain(`\`${code}\` | ${entry.status} |`);
		}
	});

	test("the committed openapi.json matches the live spec (run `bun run openapi` if this fails)", async () => {
		const committed = await Bun.file("openapi.json").json();
		expect(withoutAdditionalProperties(committed)).toEqual(
			withoutAdditionalProperties(await loadSpec()),
		);
	});
});

describe("error catalog", () => {
	test("statuses in the catalog match what the API actually returns", async () => {
		await resetDb();
		const product = await createProduct({ stock: 2 });
		const cartId = await newCart();
		const responses = [
			await get(`/carts/${MISSING_ID}`), // CART_NOT_FOUND
			await get(`/products/${MISSING_ID}`), // PRODUCT_NOT_FOUND
			await get(`/orders/${MISSING_ID}`), // ORDER_NOT_FOUND
			await get("/products/not-a-uuid"), // VALIDATION_ERROR
			await post(`/carts/${cartId}/items`, { productId: product.id, quantity: 5 }), // INSUFFICIENT_STOCK
			await checkout(cartId), // CART_EMPTY
			await post("/admin/coupons/generate"), // NO_ELIGIBLE_MILESTONE
		];

		for (const response of responses) {
			const code = response.body.code as ErrorCode;
			expect(ERROR_CATALOG[code], `${code} should be in the catalog`).toBeDefined();
			expect(response.status, `${code}`).toBe(ERROR_CATALOG[code].status);
		}
		expect(responses.map((r) => r.body.code)).toEqual([
			"CART_NOT_FOUND",
			"PRODUCT_NOT_FOUND",
			"ORDER_NOT_FOUND",
			"VALIDATION_ERROR",
			"INSUFFICIENT_STOCK",
			"CART_EMPTY",
			"NO_ELIGIBLE_MILESTONE",
		]);
	});
});
