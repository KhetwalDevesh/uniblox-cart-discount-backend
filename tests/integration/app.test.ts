import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { createContainer } from "../../src/container";
import { ConflictError, NotFoundError, UnprocessableError } from "../../src/domain/errors";
import { errorHandler } from "../../src/lib/error-handler";

const app = createApp(createContainer(loadConfig()));
// biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
const readJson = async (response: Response): Promise<any> => response.json();
const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

describe("system endpoints", () => {
	test("GET /health reports ok when the database is reachable", async () => {
		const response = await get("/health");
		expect(response.status).toBe(200);
		const body = await readJson(response);
		expect(body.status).toBe("ok");
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
	});

	test("unknown routes return the uniform error body", async () => {
		const response = await get("/nope");
		expect(response.status).toBe(404);
		expect(await readJson(response)).toEqual({
			status: "error",
			code: "ROUTE_NOT_FOUND",
			message: "Route not found",
		});
	});
});

describe("swagger", () => {
	test("serves the Swagger UI page", async () => {
		const response = await get("/swagger");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect((await response.text()).toLowerCase()).toContain("swagger");
	});

	test("serves an OpenAPI document that describes the API", async () => {
		const response = await get("/swagger/json");
		expect(response.status).toBe(200);
		const spec = await readJson(response);
		expect(spec.openapi).toStartWith("3.");
		expect(spec.info.title).toBe("Cart & Rewards API");
		expect(spec.paths["/health"].get.tags).toContain("System");
		expect(spec.tags.map((tag: { name: string }) => tag.name)).toContain("Admin");
	});
});

describe("error handler", () => {
	const probe = new Elysia()
		.use(errorHandler)
		.get("/conflict", () => {
			throw new ConflictError("INSUFFICIENT_STOCK", "Not enough stock", {
				lines: [{ productId: "p1", requested: 5, available: 2 }],
			});
		})
		.get("/missing", () => {
			throw new NotFoundError("CART_NOT_FOUND", "Cart not found");
		})
		.get("/unprocessable", () => {
			throw new UnprocessableError("CART_EMPTY", "Cart is empty");
		})
		.get("/crash", () => {
			throw new Error("secret internal detail");
		})
		.post("/validate", ({ body }) => body, {
			body: t.Object({ quantity: t.Integer({ minimum: 1 }) }),
		});

	const call = (path: string, init?: RequestInit) =>
		probe.handle(new Request(`http://localhost${path}`, init));

	test("maps domain errors to their status, code and details", async () => {
		const conflict = await call("/conflict");
		expect(conflict.status).toBe(409);
		expect(await readJson(conflict)).toEqual({
			status: "error",
			code: "INSUFFICIENT_STOCK",
			message: "Not enough stock",
			details: { lines: [{ productId: "p1", requested: 5, available: 2 }] },
		});
		expect((await call("/missing")).status).toBe(404);
		expect((await call("/unprocessable")).status).toBe(422);
	});

	test("hides unexpected error details from clients", async () => {
		const response = await call("/crash");
		expect(response.status).toBe(500);
		const body = await readJson(response);
		expect(body.code).toBe("INTERNAL_ERROR");
		expect(JSON.stringify(body)).not.toContain("secret internal detail");
	});

	test("validation failures return 400 with per-field details", async () => {
		const response = await call("/validate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ quantity: 0 }),
		});
		expect(response.status).toBe(400);
		const body = await readJson(response);
		expect(body.code).toBe("VALIDATION_ERROR");
		expect(body.details.errors[0].field).toContain("quantity");
	});

	test("malformed JSON returns 400 INVALID_BODY", async () => {
		const response = await call("/validate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(response.status).toBe(400);
		expect((await readJson(response)).code).toBe("INVALID_BODY");
	});
});
