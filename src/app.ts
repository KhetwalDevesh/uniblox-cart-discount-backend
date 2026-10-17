import { openapi } from "@elysiajs/openapi";
import { Elysia, t } from "elysia";
import type { Container } from "./container";
import { ServiceUnavailableError } from "./domain/errors";
import { errorHandler } from "./lib/error-handler";
import { log } from "./lib/logger";
import { cartRouter } from "./router/carts";
import { productRouter } from "./router/products";
import { ErrorResponse } from "./schemas/common";

const API_DESCRIPTION = `
Carts, idempotent checkout, orders and an every-nth-order coupon reward.

**Errors** always use one shape: \`{ "status": "error", "code": "...", "message": "...", "details": {...}? }\`.
Branch on \`code\`, not on \`message\`. Money amounts are decimal strings such as \`"19.99"\`.

**Administrative operations** live under \`/api/admin\`. Authentication is not implemented.
`.trim();

/**
 * Builds the HTTP app from a container. Kept separate from listen() so tests can call
 * app.handle(request) directly against the real database without opening a port.
 */
export function createApp(container: Container) {
	return new Elysia()
		.use(errorHandler)
		.use(log.into())
		.use(
			openapi({
				provider: "swagger-ui",
				path: "/swagger",
				documentation: {
					info: { title: "Cart & Rewards API", version: "1.0.0", description: API_DESCRIPTION },
					tags: [
						{ name: "System", description: "Service health" },
						{ name: "Products", description: "Product catalog" },
						{ name: "Carts", description: "Cart lifecycle and checkout" },
						{ name: "Orders", description: "Placed orders" },
						{ name: "Admin", description: "Administrative operations (no auth implemented)" },
					],
				},
			}),
		)
		.get(
			"/",
			() => ({ name: "Cart & Rewards API", version: "1.0.0", docs: "/swagger", health: "/health" }),
			{ detail: { hide: true } },
		)
		.get(
			"/health",
			async () => {
				try {
					await container.db.$queryRaw`SELECT 1`;
				} catch {
					throw new ServiceUnavailableError("Database is unreachable.");
				}
				return { status: "ok" as const, timestamp: new Date().toISOString() };
			},
			{
				response: {
					200: t.Object({ status: t.Literal("ok"), timestamp: t.String({ format: "date-time" }) }),
					503: ErrorResponse,
				},
				detail: {
					tags: ["System"],
					summary: "Health check",
					description: "Returns 200 when the service can reach its database, 503 otherwise.",
				},
			},
		)
		.group("/api", (api) =>
			api.use(productRouter(container.catalog)).use(cartRouter(container.carts)),
		);
}

export type App = ReturnType<typeof createApp>;
