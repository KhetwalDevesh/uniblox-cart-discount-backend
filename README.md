# Cart, Checkout and Rewards Service

Backend for an ecommerce store: carts, idempotent checkout, orders, and a coupon issued after every nth placed order.
Stack: Bun, Elysia, Prisma, PostgreSQL (Docker), Swagger UI.

- Plan and phases: [plan.md](./plan.md)
- Design rationale, invariants, trade-offs: [DECISIONS.md](./DECISIONS.md)

## Quick start

```bash
bun install
cp .env.example .env          # already done if .env exists
bun run db:up                 # starts Postgres on localhost:5433 (waits until healthy)
bun run db:migrate            # applies migrations to the dev database
bun run db:seed               # seeds 7 products (two with very low stock); re-running resets them
bun run db:test:migrate       # applies migrations to the test database (needed once before bun test)
bun run dev                   # API on http://localhost:4000, Swagger UI at /swagger (phase 3)
bun test                      # runs tests against the test database
```

Postgres is exposed on port **5433** to avoid clashing with a local Postgres on 5432.
Two databases are created: `cart_discount` (dev) and `cart_discount_test` (tests).

## API documentation

| What | Where |
|---|---|
| Interactive docs (Swagger UI) | http://localhost:4000/swagger |
| OpenAPI 3 document | [openapi.json](./openapi.json) (regenerate with `bun run openapi`; a test fails if it is stale) |
| Executable request walkthrough | [docs/api.http](./docs/api.http) (VS Code REST Client / IntelliJ HTTP Client) |
| Concurrency demo against a running server | `bun run demo` (races carts for limited stock and for one coupon, prints outcomes) |
| Error codes | listed in the Swagger description; source of truth is [src/docs/error-catalog.ts](./src/docs/error-catalog.ts) |

Endpoints (all under `/api`; administrative ones are under `/admin`, no authentication implemented):

| Method | Path | Purpose |
|---|---|---|
| GET | `/products`, `/products/{id}` | Catalog with price and available stock |
| POST | `/carts` | Create a cart |
| GET | `/carts/{id}` | View lines, live prices, `priceChanged`, subtotal |
| POST | `/carts/{id}/items` | Add an item (adds to an existing line) |
| PATCH / DELETE | `/carts/{id}/items/{productId}` | Set quantity / remove |
| POST | `/carts/{id}/checkout` | Place the order; optional `couponCode`, `acceptPriceChanges`; safe to retry |
| GET | `/orders/{id}` | The order exactly as placed |
| POST | `/admin/coupons/generate` | Create the coupon for the next reached, unrewarded milestone |
| GET | `/admin/coupons`, `/admin/orders` | List coupons (filter by status) / orders |
| GET | `/admin/report` | Quantities per product, gross, discounts, net, coupons, order count |

## Status

Built in phases; see the phase list in [plan.md](./plan.md). Sections below are completed as the phases land.

_API reference, endpoint walkthrough and approximate time spent: added in the final phases._
