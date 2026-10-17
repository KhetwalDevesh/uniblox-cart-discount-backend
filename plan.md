# Plan: Reliable Checkout and Rewards Service

Backend for an ecommerce store: carts, checkout, orders, and an "every nth order earns a coupon" reward. Correctness under retries and concurrency is the main goal; CRUD is incidental.

Companion doc: [DECISIONS.md](./DECISIONS.md) (design rationale, filled in progressively as phases land).

## 1. Tech stack

Mirrors the structure and tooling of `../tracepoint-backend`.

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Bun | `bun run`, `bun test` |
| HTTP | Elysia | Typed validation via `t` (TypeBox), plugin-based routers |
| API docs | `@elysiajs/openapi` with `provider: "swagger-ui"` | Served at `/swagger`, spec at `/swagger/json`; schemas come from the same TypeBox definitions used for validation (DRY) |
| DB | PostgreSQL 16 in Docker (`docker-compose.yml`) | Real row locks and constraints; one dev DB + one test DB |
| ORM / migrations | Prisma 7 + `@prisma/adapter-pg` | Migrations and typed reads; `$queryRaw` for `SELECT ... FOR UPDATE` and conditional updates |
| Lint/format | Biome (tabs, width 100) | Same config as reference |
| Git hygiene | Husky + commitlint (conventional commits) | One commit per phase (or sub-step) |
| Logging | pino via `@bogeychan/elysia-logger` | Same `lib/logger.ts` pattern |
| Tests | `bun test` against the real Postgres test DB | No mocking of the DB: the invariants live in the DB |

Prisma is the persistence tool, but its API stays behind repository classes so services never import it. The only place that knows about locking SQL is the repository layer.

## 2. Domain model and invariants

### Invariants (each is enforced in a specific place; see DECISIONS.md for the mapping)

| # | Invariant | Enforced by |
|---|---|---|
| I1 | `stock >= 0` always; never sell more than available | Conditional `UPDATE products SET stock = stock - q WHERE id = $1 AND stock >= q` in the checkout transaction, plus DB `CHECK (stock >= 0)` as a backstop |
| I2 | A cart produces at most one order | `orders.cart_id UNIQUE` and cart row lock (`FOR UPDATE`) at checkout |
| I3 | Retrying a checkout never creates a second order or decrements stock twice | Cart is the natural idempotency key: replay returns the stored order |
| I4 | A coupon is redeemed at most once | Atomic `UPDATE coupons SET status='REDEEMED' ... WHERE code=$1 AND status='AVAILABLE'`, plus `orders.coupon_id UNIQUE` |
| I5 | A failed checkout consumes nothing (stock, coupon, cart state) | Single DB transaction; every effect rolls back together |
| I6 | One coupon per milestone | `coupons.milestone UNIQUE` plus advisory lock during generation |
| I7 | An order is a self-contained snapshot (names, unit prices, discount, percent applied) | `order_items` and `orders` copy all values at placement time |
| I8 | `0 <= total <= subtotal`; money is exact | `NUMERIC(12,2)` columns; all arithmetic in integer minor units (converted at the repository boundary); discount clamped; DB `CHECK` constraints |
| I9 | Reports reconcile and never mutate | Read-only transaction at `REPEATABLE READ`; all figures derived from `orders` / `order_items` / `coupons` |

### Tables

```
products      id uuid pk, name, price numeric(12,2) CHECK(price>=0), stock int CHECK(stock>=0), created_at, updated_at
carts         id uuid pk, status ('OPEN'|'CHECKED_OUT'), created_at, checked_out_at
cart_items    cart_id fk, product_id fk, quantity int CHECK(quantity>0), unit_price_at_add numeric(12,2),
              added_at, PRIMARY KEY (cart_id, product_id)
orders        id uuid pk, cart_id uuid UNIQUE fk, order_number bigint generated,
              subtotal, discount, total (all numeric(12,2)), coupon_id UNIQUE NULL fk, coupon_code NULL,
              discount_percent NULL, placed_at
              CHECK (discount >= 0 AND discount <= subtotal AND total = subtotal - discount)
order_items   id, order_id fk, product_id, product_name, unit_price, quantity, line_total
coupons       id uuid pk, code UNIQUE, milestone int UNIQUE, discount_percent int, status ('AVAILABLE'|'REDEEMED'),
              generated_at, redeemed_at NULL, redeemed_order_id UNIQUE NULL
```

Notes:
- `CHECK` constraints and partial/unique indexes are added by hand to the Prisma migration SQL (Prisma's schema DSL cannot express CHECKs).
- Milestone counting uses `COUNT(*) FROM orders`, not a sequence value. Sequences leave gaps when transactions roll back, which would silently shift "every nth order".
- `n` and `x` come from env (`COUPON_EVERY_N_ORDERS`, `COUPON_DISCOUNT_PERCENT`), validated at boot. `discount_percent` is copied onto each coupon when generated, so later config changes never rewrite history.

## 3. Semantics chosen for ambiguous rules (summary; full reasoning in DECISIONS.md)

- **Money:** stored as `NUMERIC(12,2)` (columns named `price`, `subtotal`, `discount`, `total`, ...), exposed in the API as decimal strings such as `"19.99"`. The repository layer converts between the decimal string and integer minor units (`"19.99"` <-> `1999`); all arithmetic in services and `domain/money.ts` uses integers only, never JS floats. Amounts are plain numbers with no currency concept. Percent discount = `round_half_up(subtotal * x / 100)` in integer math (`floor((subtotal * x + 50) / 100)`), then clamped to `[0, subtotal]`. Discount applies to the order subtotal, not per line.
- **Price changes after add (decided):** a cart is not a price promise; checkout is the only authority and re-validates inside its transaction.
  - `cart_items.unit_price_at_add` records the price when the line was added. Quantity changes (`POST` increment, `PATCH`) never refresh it, so a price change cannot be accepted silently; removing and re-adding the line records the current price. Cart view shows live prices and `priceChanged: true` on lines whose live price differs.
  - At checkout, if any live price differs from the stored price, return `409 PRICE_CHANGED` with `details.lines[] = { productId, oldUnitPrice, newUnitPrice }`. Nothing is charged or changed.
  - The client shows the new prices. To accept, it retries checkout with `acceptPriceChanges: true`; the order is then charged at live prices.
  - Orders snapshot the price actually charged, so later edits never alter them.
  - Safe by default: no surprise charges, no client code needed for protection.
- **Availability (decided):** no reservation at add time (avoids hoarding and expiry machinery). Add/update validate `quantity <= stock` as a fast-fail only. Checkout is authoritative: an atomic conditional stock update per line. Any short line returns `409 INSUFFICIENT_STOCK` with `details.lines[] = { productId, requested, available }` for every short line; the transaction rolls back and the cart stays open.
- **Pre-checkout validation:** no separate review endpoint. Checkout performs both checks itself in one transaction, so there is no check-then-act gap.
- **Cart quantity rules:** integer 1..99 per line. Adding an existing product increments (`POST`); `PATCH` sets an absolute quantity (idempotent); `DELETE` removes.
- **Checkout idempotency:** the cart is the idempotency key. First success returns `201`; a replay with the same body returns `200` with the same order and header `Idempotent-Replayed: true`; a replay with a different coupon code returns `409 CART_ALREADY_CHECKED_OUT`. An empty cart returns `422 CART_EMPTY`.
- **Coupons:** generated only by an admin call. The service counts placed orders `N`, eligible milestones are `floor(N / n)`; each call creates one coupon for the lowest unrewarded milestone, or `409 NO_ELIGIBLE_MILESTONE`. A coupon is a bearer code, not bound to a customer, applies one percent discount to the whole order subtotal, one coupon per order, no expiry (documented as deferred). Orders that use a coupon still count toward milestones.
- **Coupon failure:** unknown code `422 COUPON_NOT_FOUND`; already redeemed `409 COUPON_ALREADY_REDEEMED`. Any failure rolls back, so the coupon stays `AVAILABLE`.
- **Payment:** `PaymentGateway` interface with a `FakePaymentGateway` (always approves, configurable failure for tests). It is called inside the checkout transaction, after stock and coupon are claimed and before commit, with the order id as its idempotency key; a decline throws `402 PAYMENT_DECLINED` and everything rolls back.
- **Admin:** all `/api/admin/*` routes. Not authenticated (out of scope); isolated under one route group so a guard plugin is a one-line change.

## 4. Architecture and code structure

Layered, dependency direction is inward: `routes -> services -> repositories`, with pure `domain` code used by services.

```
src/
  index.ts                      # bootstrap: build app, listen, graceful shutdown
  app.ts                        # createApp(container): wires plugins, openapi, error handler (testable without listen)
  config/
    env.ts                      # parse + validate env once (n, x, DATABASE_URL, PORT)
  container.ts                  # composition root: constructs repositories, services, gateway (manual DI)
  db/
    index.ts                    # pool + PrismaClient (as reference), retry extension
    transaction.ts              # TransactionRunner (Unit of Work): run(fn, {isolation}) -> fn(tx)
    seed.ts                     # >= 5 products, one with limited stock
  domain/
    money.ts                    # Money helpers: parse/format decimal string <-> integer minor units, add, percentOf (round half up), clamp; no floats
    discount.ts                 # DiscountStrategy interface + PercentageDiscount (extensible: fixed, capped)
    errors.ts                   # AppError base + concrete subclasses (code, status, details)
    order-pricing.ts            # calculateLineTotal, calculateSubtotal, priceOrder (lines + discount strategy -> totals), detectPriceChanges
  repositories/
    product.repository.ts
    cart.repository.ts          # lockForUpdate(cartId), item upserts
    order.repository.ts
    coupon.repository.ts        # redeemIfAvailable(), createForMilestone()
    report.repository.ts        # aggregate SQL only
    index.ts
  services/
    catalog.service.ts          # list/get products
    cart.service.ts             # create/view/add/update/remove with validation + totals view
    checkout.service.ts         # orchestrates the transaction (see section 5)
    order.service.ts
    coupon.service.ts           # milestone eligibility + generation + listing
    report.service.ts
  payment/
    payment-gateway.ts          # interface
    fake-payment-gateway.ts
  router/
    products.ts  carts.ts  orders.ts  admin.ts   # Elysia plugins; thin: validate, call service, shape response
  schemas/
    common.ts  cart.ts  order.ts  coupon.ts  report.ts   # TypeBox models shared by validation AND OpenAPI
  lib/
    logger.ts
tests/
  helpers/                      # test DB reset, factories, app builder
  unit/        money.test.ts  discount.test.ts  order-pricing.test.ts
  integration/ cart.test.ts  checkout-idempotency.test.ts  checkout-concurrency.test.ts
               coupon-lifecycle.test.ts  coupon-race.test.ts  report-reconciliation.test.ts
prisma/  schema.prisma  migrations/
scripts/ generate-openapi.ts
```

### Design patterns and where they apply

| Pattern | Where | Why |
|---|---|---|
| Repository | `repositories/*` | Services never see Prisma or raw SQL; swap persistence, test in isolation |
| Unit of Work / Transaction runner | `db/transaction.ts` | One place defines transaction boundaries, isolation level, and retry on serialization failure; services stay declarative |
| Strategy | `DiscountStrategy`, `PaymentGateway` | New discount kinds or real payment providers plug in without touching checkout (Open/Closed) |
| Dependency Injection (manual, composition root) | `container.ts` | Dependency Inversion: services depend on interfaces; tests inject a failing gateway |
| Service layer / Facade | `services/*` | Routes stay thin; business rules live in one layer |
| Domain error hierarchy | `domain/errors.ts` | One mapping from error class to HTTP status and error code (single global handler) |
| Pure functional core | `money.ts`, `order-pricing.ts` | Deterministic, trivially unit-testable calculations |

SOLID/DRY notes:
- **S:** routes shape HTTP, services own rules, repositories own SQL, domain owns math.
- **O/L:** discount and payment behaviours are extended by new implementations of an interface.
- **I:** small interfaces (`PaymentGateway.charge`, `DiscountStrategy.compute`), not one fat repository interface.
- **D:** services receive dependencies via constructors.
- **DRY:** TypeBox schemas define validation, types (`Static<>`) and OpenAPI in one place; money math lives only in `domain/money.ts`; one error handler; one `cartView` builder used by every cart endpoint.

## 5. Checkout transaction (core algorithm)

`CheckoutService.checkout(cartId, { couponCode?, acceptPriceChanges? })` runs in one transaction (`READ COMMITTED` + explicit row locks):

1. `SELECT ... FROM carts WHERE id=$1 FOR UPDATE`. Serializes concurrent retries of the same cart. Not found: `404 CART_NOT_FOUND`.
2. If `status = CHECKED_OUT`: load the stored order. Same coupon code as the stored order: return it (replay, `200`). Different: `409 CART_ALREADY_CHECKED_OUT`. Done. Then load the cart's lines; empty: `422 CART_EMPTY`.
3. Lock the product rows of the cart's lines in ascending id order (`SELECT ... WHERE id = ANY($ids) ORDER BY id FOR UPDATE`, one statement). Prices and stock are now frozen for this transaction, and the same fixed order in every checkout means no deadlocks. Everything below uses these locked values, so the price validated is the price stored.
4. Price check: if any locked live price differs from `unit_price_at_add` and `acceptPriceChanges` is not true, abort with `409 PRICE_CHANGED` (old/new price per line). Runs before any write, so nothing needs undoing. (On an idempotent replay in step 2, `acceptPriceChanges` is ignored.)
5. Stock check: any line with `quantity > stock` is collected; if any, abort with `409 INSUFFICIENT_STOCK` listing every short line. Otherwise price the order (integer minor units, `order-pricing`) and take the stock per line with the compare-and-set `UPDATE products SET stock = stock - $q WHERE id = $id AND stock >= $q`, asserting one row updated. This second guard keeps stock correct even if the lock were ever missing (defence in depth, verified by mutation testing).
6. If coupon supplied: `UPDATE coupons SET status='REDEEMED', redeemed_at=now() WHERE code=$1 AND status='AVAILABLE' RETURNING id, discount_percent`. No row: distinguish not found vs already redeemed with a follow-up read, abort. Compute discount via `PercentageDiscount`, clamped.
7. `PaymentGateway.charge(total, idempotencyKey = cartId)`; decline aborts.
8. Insert `orders` and `order_items` snapshots; set `coupons.redeemed_order_id`; set cart `CHECKED_OUT`.
9. Commit. Any thrown error rolls back all of steps 5-8, so a failed checkout cannot consume stock or a coupon (I5).

Cart mutations (`add/update/remove`) take the same `FOR UPDATE` on the cart row and reject with `409 CART_NOT_OPEN` once checked out, so an item cannot slip into a cart mid-checkout.

Coupon generation (`CouponService.generate`), one transaction:
1. `pg_advisory_xact_lock(<const>)` to serialize generators.
2. `N = COUNT(*) FROM orders`; `eligible = floor(N / n)`; `latest = MAX(milestone) FROM coupons` (0 if none).
3. If `latest >= eligible`: `409 NO_ELIGIBLE_MILESTONE`. Else insert coupon for milestone `latest + 1` with a random code; `UNIQUE(milestone)` is the final guard.

Report (`ReportService.summary`): one `REPEATABLE READ`, read-only transaction so all aggregates see one snapshot. Sections: quantity by product (from `order_items`), `grossRevenue = SUM(subtotal)`, `totalDiscounts = SUM(discount)`, `netRevenue = SUM(total)` (asserted equal to gross minus discounts), coupons by status, `ordersCount`.

## 6. API surface

Base path `/api`. Errors always: `{ "status": "error", "code": "<STABLE_CODE>", "message": "...", "details": {...}? }`.

| Method | Path | Success | Key errors |
|---|---|---|---|
| GET | `/products` | 200 list | |
| GET | `/products/:id` | 200 | 404 `PRODUCT_NOT_FOUND` |
| POST | `/carts` | 201 cart | |
| GET | `/carts/:id` | 200 cart view (lines, live prices, `priceChanged`, subtotal) | 404 `CART_NOT_FOUND` |
| POST | `/carts/:id/items` `{productId, quantity}` | 200 cart view | 400 validation, 404 `PRODUCT_NOT_FOUND`, 409 `INSUFFICIENT_STOCK`, 409 `CART_NOT_OPEN` |
| PATCH | `/carts/:id/items/:productId` `{quantity}` | 200 cart view | 404 `ITEM_NOT_IN_CART`, 409 `INSUFFICIENT_STOCK`, 409 `CART_NOT_OPEN` |
| DELETE | `/carts/:id/items/:productId` | 200 cart view | 404 `ITEM_NOT_IN_CART`, 409 `CART_NOT_OPEN` |
| POST | `/carts/:id/checkout` `{couponCode?, acceptPriceChanges?}` | 201 order (200 + `Idempotent-Replayed: true` on replay) | 404, 409 `INSUFFICIENT_STOCK` / `PRICE_CHANGED` / `COUPON_ALREADY_REDEEMED` / `CART_ALREADY_CHECKED_OUT`, 422 `CART_EMPTY` / `COUPON_NOT_FOUND`, 402 `PAYMENT_DECLINED` |
| GET | `/orders/:id` | 200 order (items, subtotal, discount, total, coupon) | 404 `ORDER_NOT_FOUND` |
| POST | `/admin/coupons/generate` | 201 coupon | 409 `NO_ELIGIBLE_MILESTONE` |
| GET | `/admin/coupons` | 200 list (filter `status`) | |
| GET | `/admin/orders` | 200 list of all orders (same shape as `GET /orders/:id`; unpaginated) | |
| GET | `/admin/report` | 200 summary | |

Admin operations: coupon generation, coupon listing, order listing (needed to verify report reconciliation), report. Everything else is customer-facing. Product admin (create/restock) is deferred; seed data covers evaluation.

Other endpoints: `GET /health`, `GET /swagger` (UI), `GET /swagger/json` (spec). `scripts/generate-openapi.ts` writes `openapi.json` to the repo for offline reading. Every route gets `detail.summary`, `detail.tags`, and typed `response` maps including the error shape.

## 7. Implementation phases

Each phase ends green (typecheck + lint + that phase's tests) and is committed with a conventional commit. Order matters: pure code first, then persistence, then concurrency-sensitive flows.

### Phase 0: Scaffolding and docs
- `git init`; add `.gitignore`, `package.json`, `tsconfig.json`, `biome.json`, Husky + commitlint (copied from reference).
- `docker-compose.yml`: `postgres:16-alpine` on host port 5433 (avoids clashing with a local 5432) with healthcheck, volume, and an init script creating `cart_discount` and `cart_discount_test` databases. `.env.example`.
- `README.md` skeleton, this `plan.md`, `DECISIONS.md` skeleton.
- Commit: `chore: scaffold bun project, docker postgres, tooling and planning docs`

### Phase 1: Domain core (pure, no I/O)
- `money.ts`, `discount.ts`, `order-pricing.ts`, `errors.ts`.
- Unit tests: rounding half-up boundaries, 100% discount, tiny subtotals, clamp never negative, large values (no overflow past safe int), determinism.
- Commit: `feat(domain): integer money, discount strategy, pricing and error model`

### Phase 2: Persistence
- Prisma schema, migration with hand-written `CHECK` constraints and unique indexes, `db/index.ts`, `transaction.ts`, seed (6 products, one with stock 3, one with stock 1 optional).
- Test helpers: reset DB between tests against the test DB.
- Commit: `feat(db): schema, constraints, migrations, seed and transaction runner`

### Phase 3: App skeleton, config, error handling, Swagger
- `env.ts`, `container.ts`, `app.ts`, global error handler mapping `AppError` to JSON, validation errors to `400 VALIDATION_ERROR`, `/health`, OpenAPI plugin with `swagger-ui` provider.
- Commit: `feat(api): app bootstrap, error contract and swagger ui`

### Phase 4: Catalog and carts
- Product/cart repositories and services, routers, schemas. Cart row locking on mutations. Cart view builder with live prices and `priceChanged`.
- Tests: invalid product, zero/negative/non-integer/huge quantity, quantity above stock, increment vs set, remove, view totals, concurrent adds on one cart end consistent.
- Commit: `feat(cart): product catalog and cart operations with validation`

### Phase 5: Checkout and orders (no coupons yet)
- `CheckoutService` steps 1-5, 7-9 above, payment gateway interface + fake, `GET /orders/:id`.
- Tests: happy path snapshot, empty cart, insufficient stock rollback leaves earlier lines untouched, price change returns `409 PRICE_CHANGED` with nothing changed, then succeeds at the live price with `acceptPriceChanges: true`, order snapshot survives product price edit, payment decline rolls back.
- **Concurrency tests:** (a) 20 parallel checkouts of different carts for a product with stock 5: exactly 5 succeed, stock ends 0; (b) 10 parallel checkouts of the same cart: one order, replays identical, stock decremented once; (c) opposite-order multi-product carts do not deadlock.
- Commit: `feat(checkout): transactional checkout with idempotent replay and oversell protection`

### Phase 6: Coupons and discounts at checkout
- `CouponService.generate`, coupon repository (`redeemIfAvailable`), step 6 in checkout, admin routes.
- Tests: no coupon before milestone; one per milestone; generate twice returns `NO_ELIGIBLE_MILESTONE`; concurrent generate yields one coupon; coupon applied correctly; reuse rejected; unknown code; **failed checkout (out of stock / payment decline) leaves coupon `AVAILABLE`**; **two concurrent checkouts with the same coupon: exactly one wins, the loser leaves its stock untouched**; discount never negative at 100%.
- Commit: `feat(coupons): milestone coupon generation and single-use redemption at checkout`

### Phase 7: Admin reporting
- `ReportRepository` aggregate SQL, `ReportService`, `/admin/report`, read-only snapshot transaction.
- Tests: figures reconcile with orders/coupons fetched through the API; `gross - discounts == net`; repeated calls produce identical output and no row changes; report during concurrent checkouts is internally consistent.
- Commit: `feat(admin): reconcilable read-only summary report`

### Phase 8: API documentation polish and executable examples
- Complete OpenAPI metadata, error response schemas, examples. `scripts/generate-openapi.ts` writes `openapi.json`. `docs/api.http` (or a curl script) demonstrating: normal flow, retry flow, coupon flow, oversell race.
- Commit: `docs(api): openapi spec, error catalog and executable examples`

### Phase 9: DECISIONS.md completion and README
- Fill every required DECISIONS.md section with what was actually built (see checklist below), including the AI-use account with a real correction example and the time spent. README: setup, run, test, seed, endpoints, curl walkthrough.
- Commit: `docs: finalize decisions, setup and run instructions`

### Phase 10 (stretch, only if time remains)
- Dockerfile + `api` service in compose; tiny script that fires N parallel checkouts and prints outcome counts (demonstrates the guarantees to a reviewer).
- Commit: `chore: dockerized api and race demo script`

Time budget (target 5h): P0 0.5h, P1 0.5h, P2 0.5h, P3 0.5h, P4 0.75h, P5 1h, P6 0.75h, P7 0.4h, P8 0.3h, P9 0.5h.

## 8. Testing strategy

- Real Postgres test DB (`cart_discount_test`), migrated before the run, truncated between tests. Concurrency is exercised by `Promise.all` over HTTP calls against `app.handle(...)` (no network needed) so the real pool and real locks are used.
- A small number of high-value tests: oversell race, retry storm, coupon double-redeem race, coupon-survives-failed-checkout, concurrent generation, report reconciliation, money rounding.
- Mutation sanity check at the end: temporarily remove the `FOR UPDATE` / `stock >= q` guard / coupon status guard and confirm the matching test fails. Record the result in DECISIONS.md.

## 9. Scripts (package.json)

`dev`, `start`, `db:up` (docker compose up -d postgres), `db:generate`, `db:migrate`, `db:seed`, `db:reset`, `test` (runs against test DB), `openapi`, `typecheck`, `lint`, `format`.

Evaluator quick start target:
```
docker compose up -d postgres
bun install && cp .env.example .env
bun run db:migrate && bun run db:seed
bun run dev          # http://localhost:4000/swagger
bun test
```

## 10. DECISIONS.md checklist (required content)

- [ ] System invariants (table above, with enforcement location)
- [ ] Ambiguities and chosen semantics (section 3)
- [ ] At least five material decisions with Context/Options/Choice/Why/Consequences:
  1. `NUMERIC(12,2)` storage, integer-minor-unit arithmetic, half-up rounding
  2. Cart as natural idempotency key vs `Idempotency-Key` header
  3. Row locks + conditional UPDATE vs optimistic versioning vs SERIALIZABLE
  4. No stock reservation at add time
  5. Price-change policy (checkout rejects with `409 PRICE_CHANGED` unless `acceptPriceChanges: true`)
  6. Milestone via `COUNT(*)` + `UNIQUE(milestone)` vs sequence/counter
  7. Coupon claimed inside checkout transaction vs separate reserve/confirm
  8. Payment inside the transaction vs after commit
- [ ] Transaction, concurrency, idempotency strategy
- [ ] Money and rounding rules
- [ ] Error model
- [ ] Implemented vs deferred
- [ ] Multi-instance and production scale evolution
- [ ] AI usage with a real corrected/rejected example
- [ ] What to examine in another two hours
- [ ] Approximate time spent

## 11. Intentionally deferred (recorded in DECISIONS.md)

Authentication/authorization, coupon expiry and per-customer binding, product admin CRUD, stock reservations with TTL, outbox/real payment with two-phase flow, order cancel/refund (would need coupon/stock restoration rules), pagination on admin lists, rate limiting, metrics/tracing.

## 12. Risks to watch

- Prisma `$queryRaw` inside interactive transactions must use the `tx` client, or locks silently run on another connection. The repository methods take `tx` explicitly to make that hard to get wrong.
- Interactive transaction timeout (default 5s): set explicitly; keep payment call fast.
- Test isolation: truncate with `RESTART IDENTITY CASCADE`; do not run test files in parallel against one DB (`bun test --max-concurrency 1` or per-file schema).
- Report totals (`gross`, `discounts`, `net`) are summed in SQL on `numeric`, or in integer minor units; never as JS floats.
- Prisma returns `bigint` for aggregates and `Decimal` for `numeric`: convert at the repository boundary (decimal string -> integer minor units) so no float ever touches money. Never use `Number(decimal)` for arithmetic.
