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
bun run db:migrate            # applies migrations   (available from phase 2)
bun run db:seed               # seeds products       (available from phase 2)
bun run dev                   # API on http://localhost:4000, Swagger UI at /swagger (phase 3)
bun test                      # runs tests against the test database
```

Postgres is exposed on port **5433** to avoid clashing with a local Postgres on 5432.
Two databases are created: `cart_discount` (dev) and `cart_discount_test` (tests).

## Status

Built in phases; see the phase list in [plan.md](./plan.md). Sections below are completed as the phases land.

_API reference, endpoint walkthrough and approximate time spent: added in the final phases._
