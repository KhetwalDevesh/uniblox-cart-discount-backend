# DECISIONS

Reasoning behind the checkout and rewards service: what must always be true, where each guarantee is enforced, the ambiguities I resolved, the trade-offs, and what I left out. Setup and run instructions are in the [README](./README.md); the original phased plan is in [plan.md](./plan.md).

**Approximate time spent:** _TODO (author): fill in before submitting._

## Contents

1. [System invariants](#1-system-invariants)
2. [Ambiguities and selected semantics](#2-ambiguities-and-selected-semantics)
3. [Material decisions](#3-material-decisions)
4. [Transaction, concurrency and idempotency strategy](#4-transaction-concurrency-and-idempotency-strategy)
5. [Money and rounding rules](#5-money-and-rounding-rules)
6. [Error model](#6-error-model)
7. [Testing and validation](#7-testing-and-validation)
8. [Implemented vs deferred](#8-implemented-vs-deferred)
9. [Known weaknesses](#9-known-weaknesses)
10. [Evolution to multiple instances and production scale](#10-evolution-to-multiple-instances-and-production-scale)
11. [How I used AI tools](#11-how-i-used-ai-tools)
12. [What I would examine in another two hours](#12-what-i-would-examine-in-another-two-hours)

---

## 1. System invariants

| # | Invariant | Enforced by | Where |
|---|---|---|---|
| I1 | Stock never goes negative; never sell more than is available | Product rows locked for the transaction, stock checked against the locked rows, then taken with a compare-and-set `UPDATE ... WHERE stock >= q` that must change exactly one row. DB `CHECK (stock >= 0)` is the last backstop. | [product.repository.ts](src/repositories/product.repository.ts) `lockForCheckout`, `decrementStock`; [checkout.service.ts](src/services/checkout.service.ts); migration |
| I2 | A cart produces at most one order | Cart row locked `FOR UPDATE` at checkout; `orders.cart_id` is `UNIQUE` | [cart.repository.ts](src/repositories/cart.repository.ts) `lockForUpdate`; migration |
| I3 | A checkout retry creates no second order and takes no stock twice | The cart is the idempotency key: a checked-out cart replays its stored order | [checkout.service.ts](src/services/checkout.service.ts) step 2 |
| I4 | A coupon is redeemed at most once | One statement: `UPDATE coupons SET status='REDEEMED' WHERE code=? AND status='AVAILABLE'`; `orders.coupon_id` is `UNIQUE` | [coupon.repository.ts](src/repositories/coupon.repository.ts) `redeemIfAvailable` |
| I5 | A failed checkout consumes nothing: no stock, no coupon, cart stays open | Everything happens in one DB transaction, so any thrown error rolls it all back | [transaction.ts](src/db/transaction.ts); [checkout.service.ts](src/services/checkout.service.ts) |
| I6 | At most one coupon per milestone | Advisory lock around count-and-insert; `coupons.milestone` is `UNIQUE` | [coupon.service.ts](src/services/coupon.service.ts) `generate`; migration |
| I7 | An order explains itself even after product data changes | Names, unit prices, line totals, coupon code and percent are copied into `order_items` / `orders`; `order_items` has no FK to `products` | [order.repository.ts](src/repositories/order.repository.ts); schema |
| I8 | `0 <= total <= subtotal`, `total = subtotal - discount`; money is exact | `NUMERIC(12,2)` storage; integer arithmetic; discount clamped; DB `CHECK` constraints | [money.ts](src/domain/money.ts), [discount.ts](src/domain/discount.ts); migration |
| I9 | The report reconciles with orders and coupons and never writes | One read-only `REPEATABLE READ` transaction; the service verifies its own totals | [report.service.ts](src/services/report.service.ts) |
| I10 | An item cannot enter a cart that is being or has been checked out | Cart mutations take the same row lock, then require status `OPEN` | [cart.service.ts](src/services/cart.service.ts) `mutate` |

Every invariant has two layers where practical: application logic that gives a good error, and a database constraint that holds even if the application is wrong. [schema-constraints.test.ts](tests/integration/schema-constraints.test.ts) exercises the database layer directly, bypassing the application.

---

## 2. Ambiguities and selected semantics

| Ambiguity | What I chose |
|---|---|
| Price changes between add and checkout | The cart records the price at add, but is not a price promise. Checkout re-validates; a differing live price gives `409 PRICE_CHANGED` (old and new per line) and changes nothing. Retrying with `acceptPriceChanges: true` charges live prices. The order snapshots what was charged. |
| Availability changes between add and checkout | No reservation. Add and update fast-fail when the quantity exceeds stock; checkout is authoritative and returns `409 INSUFFICIENT_STOCK` listing every short line. The cart stays open. |
| Does a quantity change accept a new price? | No. Quantity changes never refresh the recorded price, otherwise a changed price could be accepted silently. Removing and re-adding a line records the current price. |
| What is a "successfully placed order" | A committed row in `orders`. Orders that used a coupon count. Failed checkouts do not. |
| How "every nth order" is counted | Milestone k is reached when `COUNT(orders) >= k * n`, counted from committed rows, never from a sequence (sequences skip values on rollback). |
| Several milestones reached before the admin acts | One coupon per milestone, one per admin call, lowest unrewarded first. Milestones are never skipped or lost. `409 NO_ELIGIBLE_MILESTONE` when none is pending. |
| Who generates coupons, and who receives them | An administrator triggers generation. A coupon is a bearer code, not tied to a customer. **Open question:** the assignment's opening sentence ("made available after every nth order") can also be read as automatic issuance; see [decision 9](#decision-9-coupon-generation-is-admin-triggered). |
| What a coupon discounts | The whole order subtotal, one coupon per order, percentage fixed at generation time (`x` is copied onto the coupon). |
| Coupon expiry | None. Deferred. |
| A coupon on a checkout that fails | Stays `AVAILABLE`: the claim and the rollback share one transaction. |
| Checkout retry with a different coupon, or none | `409 CART_ALREADY_CHECKED_OUT`; the original order stands. The same request replays. |
| Cart reuse after checkout | A cart is single-use. The next purchase starts a new cart. |
| Customer identity | None. Carts are anonymous; the cart id is the handle. Milestones are store-wide, not per customer. Authentication and authorization are out of scope. |
| Quantity bounds | Integer 1 to 99 per line. Adding an existing product increments; `PATCH` sets an absolute value and is idempotent. |
| Currency | None. Amounts are plain numbers. |
| Payment | A `PaymentGateway` interface with a fake that approves. It runs inside the checkout transaction so a decline rolls back stock and coupon. |
| Administrative operations | Coupon generation, coupon listing, order listing, report: everything under `/api/admin`. Not authenticated. |

---

## 3. Material decisions

### Decision 1: Exact decimal storage, integer arithmetic, half-up rounding

**Context:** Totals and percent discounts must be exact and deterministic.

**Options considered:** JS floats; a decimal library; integer minor units in the database; Postgres `NUMERIC`.

**Choice:** Store money as `NUMERIC(12,2)` columns named `price`, `subtotal`, `discount`, `total`. The API exposes decimal strings (`"19.99"`). The repository layer converts to integer minor units (1999) on read and back on write, and all arithmetic uses those integers.

**Why:** `NUMERIC` is exact, self-describing (a column called `price` holds 19.99), and works with DB `CHECK`s. Converting at one boundary ([mappers.ts](src/repositories/mappers.ts)) keeps JS floats out of money math without adding a dependency.

**Consequences:** One conversion boundary that must stay disciplined (never `Number(decimal)`). No currency concept; multiple currencies or sub-cent precision would need a currency-aware Money type. Rules in [section 5](#5-money-and-rounding-rules).

### Decision 2: The cart is the idempotency key

**Context:** Clients retry checkout after timeouts and must not double-order or take stock twice.

**Options considered:** A required `Idempotency-Key` header with a keys table; a client-generated order id; the cart itself.

**Choice:** The cart is the key. `orders.cart_id` is unique; a retry returns the stored order (`200`, `Idempotent-Replayed: true`).

**Why:** A cart is checked out once by definition, so there is nothing extra for a client to get wrong, and the guarantee rests on a unique constraint, not on application logic.

**Consequences:** Cart and order are one-to-one. Multi-order carts would need a separate key table. A retry with a different body (another coupon) is refused rather than treated as a new attempt.

### Decision 3: Pessimistic row locks plus compare-and-set updates

**Context:** Concurrent checkouts must not oversell, and two checkouts must not share a coupon.

**Options considered:** `SERIALIZABLE` with retry; optimistic version column with retry loops; in-process mutex; `SELECT ... FOR UPDATE`; conditional `UPDATE` alone.

**Choice:** `READ COMMITTED` with explicit locks in a fixed order (cart, products in id order, coupon). Prices and stock are validated against the locked rows, and stock is taken with `UPDATE ... WHERE stock >= q`, asserting one row changed.

**Why:** Locking the product rows means the price validated is the price stored and the stock checked is the stock taken. The compare-and-set is independent insurance: mutation testing showed stock stays correct even with the product lock removed. Locking all rows in one `ORDER BY id` statement prevents deadlocks. An in-process mutex would break with more than one app instance.

**Consequences:** A hot product serializes its checkouts on one row. `SERIALIZABLE` would be simpler to reason about but needs retry plumbing and aborts more under contention.

### Decision 4: No stock reservation when adding to a cart

**Context:** Should adding to a cart hold inventory?

**Options considered:** Reserve on add with a TTL; reserve at checkout start; no reservation.

**Choice:** No reservation. Validate at add for fast feedback; enforce at checkout.

**Why:** Reservations need expiry jobs and invite hoarding; the requirement is only to never oversell.

**Consequences:** A shopper can see an item as available and still be refused at checkout. The error says exactly which lines are short and by how much.

### Decision 5: Checkout rejects price changes unless the client accepts them

**Context:** A product's price may change after an item was added and before checkout.

**Options considered:** Lock the price at add time; silently charge the live price; an opt-in guard (`expectedTotal`); reject unless accepted; a separate pre-checkout review endpoint.

**Choice:** Checkout re-validates in its own transaction. A changed price returns `409 PRICE_CHANGED` with old and new prices; the client retries with `acceptPriceChanges: true`.

**Why:** Safe by default: no shopper is charged an amount they have not seen, and protection needs no client cooperation. Stale prices are not honoured because a product's price is its current price. Doing both the price and stock checks inside the checkout transaction avoids the check-then-act gap a separate pre-check would have. The price check runs before any write, so nothing needs undoing.

**Consequences:** One extra round trip when a price changed. A replayed checkout ignores `acceptPriceChanges`. The cart view still flags `priceChanged` so clients can warn earlier.

### Decision 6: Orders are immutable snapshots in their own tables

**Context:** An order must explain what was bought and how the total was computed, even if products change.

**Options considered:** Join orders to live products; copy the cart items; copy into a JSON column; separate `order_items` snapshot rows.

**Choice:** `order_items` stores product name, unit price, quantity and line total as charged. It deliberately has no foreign key to `products`.

**Why:** `cart_items` is mutable working state with no name snapshot and a price that may not be the charged one. Real rows (not JSON) keep per-line `CHECK`s and let the report aggregate by SQL.

**Consequences:** Some duplication of product data, which is the point. The report names a product by its latest order's name.

### Decision 7: Milestones from `COUNT(*)` under a lock, with a unique milestone number

**Context:** "Every nth order" must survive rollbacks, concurrent generation, and repeated admin calls.

**Options considered:** A counter row incremented per order; the order sequence modulo n; count at generation time.

**Choice:** Count committed orders at generation time under an advisory lock; `coupons.milestone` is unique.

**Why:** Sequences have gaps; a counter row adds a contention point to every checkout. Counting touches only the rare admin path, and the unique index is the final guard against duplicates.

**Consequences:** `COUNT(*)` on a very large orders table would need a maintained counter later. Redemption does not affect the milestone grid: an unused coupon does not delay the next one.

### Decision 8: The coupon is claimed inside the checkout transaction

**Context:** A coupon must not be lost to a failed checkout or used twice.

**Options considered:** Reserve, then confirm after payment, with an expiry; claim inside the order transaction.

**Choice:** Claim with a conditional update in the same transaction as stock and order creation.

**Why:** Rollback restores the coupon automatically. There is no intermediate "reserved" state that could leak or need expiring.

**Consequences:** A concurrent loser waits briefly on the row lock, then gets `COUPON_ALREADY_REDEEMED`. The coupon row is locked until the checkout finishes.

### Decision 9: Coupon generation is admin-triggered

**Context:** The assignment both says a coupon is "made available after every nth order" and gives administrators an operation to "request coupon generation".

**Options considered:** (a) Only the admin endpoint creates coupons. (b) Auto-issue inside the checkout transaction when the order count reaches a multiple of n and return it to that buyer, keeping the admin endpoint as a catch-up. (c) A background job.

**Choice:** (a), as the more literal reading: an admin operation exists, and the report counts "generated" separately from "available", which only differs if generation is a distinct step.

**Why:** Simpler, and generation never adds work or failure modes to checkout.

**Consequences:** A shopper who hits a milestone does not receive a coupon in the same response; it must reach them out of band. This is the main semantic gap and I flagged it as open. Option (b) is a small change: extract `generateIfEligible(tx)` from `CouponService.generate` and call it from checkout; the advisory lock and `UNIQUE(milestone)` already make that safe.

### Decision 10: The payment abstraction runs inside the transaction

**Context:** No real payments, but the failure ordering matters.

**Options considered:** Treat checkout as paid; a fake gateway before commit; charge after commit.

**Choice:** A `PaymentGateway` port and a fake, called after stock and coupon are claimed and before the order is stored, keyed by cart id.

**Why:** It lets tests prove that a decline leaves stock and coupon untouched, which is the failure ordering that matters.

**Consequences:** Wrong for a real provider: it holds row locks across a network call, and the transaction runner's deadlock retry could call the gateway twice (see [weaknesses](#9-known-weaknesses)). The production design is in [section 10](#10-evolution-to-multiple-instances-and-production-scale).

### Decision 11: The report is one read-only snapshot that checks itself

**Context:** The report must reconcile with orders and coupons and never mutate state.

**Options considered:** Several independent queries; a materialized view; one consistent snapshot.

**Choice:** One `REPEATABLE READ`, read-only transaction. The service verifies gross minus discounts equals net, order lines sum to gross, and available plus redeemed equals generated, and fails loudly otherwise. There is no timestamp in the response, so repeated calls with unchanged data are identical. `GET /admin/orders` exists so the report can be reconciled against API data.

**Why:** Separate queries could mix moments while checkouts commit. A test polls the report during 40 concurrent checkouts; downgrading to `READ COMMITTED` made it fail in 3 of 3 runs.

**Consequences:** The aggregates scan all orders (fine here, not at scale), and the order listing is unpaginated.

### Decision 12: One typed error catalog

**Context:** Clients must be able to tell failures apart and know what to do.

**Choice:** Every error is an `AppError` subclass with a stable `code`; one handler produces the response; one typed catalog ([error-catalog.ts](src/docs/error-catalog.ts)) documents each code and is rendered into the Swagger description. Adding a code without documenting it fails the type check, and a test confirms real responses match the catalog's status.

**Why:** Docs generated from the same source as the code cannot drift.

**Consequences:** Slightly more ceremony per new error. See [section 6](#6-error-model).

---

## 4. Transaction, concurrency and idempotency strategy

### Checkout sequence

`CheckoutService.checkout` runs as one transaction ([checkout.service.ts](src/services/checkout.service.ts)):

| Step | Action | On failure |
|---|---|---|
| 1 | Lock the cart row (`FOR UPDATE`). Concurrent attempts on this cart queue here. | `404 CART_NOT_FOUND` |
| 2 | If the cart is already `CHECKED_OUT`, return the stored order (replay), or `409 CART_ALREADY_CHECKED_OUT` if this request used a different coupon. Nothing else is touched. | |
| 3 | Load the cart lines. | `422 CART_EMPTY` |
| 4 | Lock the product rows in ascending id order in one statement. Prices and stock are frozen for this transaction. | |
| 5 | Price check against the locked prices. | `409 PRICE_CHANGED` |
| 6 | Stock check against the locked stock, collecting every short line. | `409 INSUFFICIENT_STOCK` |
| 7 | If a coupon was supplied, claim it with the compare-and-set update. | `422 COUPON_NOT_FOUND` / `409 COUPON_ALREADY_REDEEMED` |
| 8 | Price the order from the locked rows and apply the discount. | |
| 9 | Take stock with `UPDATE ... WHERE stock >= q`, one row each. | `409 INSUFFICIENT_STOCK` |
| 10 | Charge the payment gateway. | `402 PAYMENT_DECLINED` |
| 11 | Insert the order and its line snapshots, link the coupon, mark the cart `CHECKED_OUT`. Commit. | |

Any thrown error before commit rolls back everything. The cart is marked `CHECKED_OUT` only in step 11, after every check has passed.

### Lock order

All code takes locks in one global order: **cart row, then product rows (ascending id), then coupon row.** Two checkouts therefore never wait on each other in a cycle. Coupon generation uses a separate advisory lock and touches no product or cart rows.

### Idempotency cases

| Situation | Outcome |
|---|---|
| First request succeeds | `201` with the order |
| Response lost, client retries | `200`, `Idempotent-Replayed: true`, the same order, stock not touched again |
| Retry arrives while the first is still running | Waits at the cart lock, then replays (or runs fresh if the first rolled back) |
| First attempt failed (stock, price, payment, coupon) | Nothing was stored; the retry is a normal fresh attempt |
| Same cart, different coupon or none | `409 CART_ALREADY_CHECKED_OUT`; the original order stands |
| Replay after the product's price or stock changed | Still the original order; replays read the stored order only |
| 10 simultaneous requests for one cart | 1 x `201` and 9 x `200` with one order id; stock taken once (tested) |

### What a failed checkout leaves behind

For every failure the result is identical: stock unchanged, coupon still `AVAILABLE`, cart still `OPEN`, no order. This holds for an empty cart, a price change, short stock, an unknown or used coupon, a declined payment, and unexpected errors.

### Transaction runner

[transaction.ts](src/db/transaction.ts) is the only place transactions begin. It defaults to `READ COMMITTED`, supports `REPEATABLE READ` and a read-only mode (used by the report), sets a 10 s transaction timeout and a 5 s wait for a connection, and retries the whole transaction up to 3 times on Postgres deadlock or serialization failure. Repositories take the transaction client explicitly, so a locking query cannot silently run on another connection.

---

## 5. Money and rounding rules

- Stored as `NUMERIC(12,2)`; exposed as decimal strings with exactly two digits.
- All arithmetic uses integer minor units (1999 = 19.99). Parsing and formatting happen only at the boundaries ([money.ts](src/domain/money.ts), [mappers.ts](src/repositories/mappers.ts)). Values beyond the safe-integer range are rejected.
- Line total = unit price x quantity. Subtotal = sum of line totals.
- Discount = `floor((subtotal x percent + 50) / 100)`, computed in BigInt, so it is **rounded half up**, then clamped to `[0, subtotal]`. It applies once, to the whole subtotal, never per line.
- Total = subtotal - discount, so it can never be negative.

| Subtotal | Percent | Exact | Discount | Total |
|---|---|---|---|---|
| 1.05 | 10 | 0.105 | 0.11 | 0.94 |
| 1.04 | 10 | 0.104 | 0.10 | 0.94 |
| 0.05 | 10 | 0.005 | 0.01 | 0.04 |
| 0.04 | 10 | 0.004 | 0.00 | 0.04 |
| 59.97 | 10 | 5.997 | 6.00 | 53.97 |
| 59.97 | 100 | 59.97 | 59.97 | 0.00 |

A coupon whose discount rounds to 0.00 is still consumed. Totals that float arithmetic gets wrong stay exact: 19.99 x 3 is 59.97, and one thousand additions of 0.10 are exactly 100.00 (both tested).

---

## 6. Error model

Every error has one body: `{ "status": "error", "code": "...", "message": "...", "details": {...}? }`. Clients branch on `code`; `details` is structured (for example the short lines with `requested` and `available`).

| HTTP | Used for | Reasoning |
|---|---|---|
| 400 | Malformed input: bad ids, quantities, bodies | The request itself is wrong; retrying unchanged cannot help |
| 402 | Payment declined | A distinct, retryable-with-other-payment outcome |
| 404 | Missing product, cart, item, order, route | |
| 409 | State conflicts: short stock, changed price, closed cart, coupon already used, no eligible milestone | Valid request, but it clashes with current state; changing the state or the request can resolve it |
| 422 | Well-formed but unprocessable: empty cart, unknown coupon | Not a race; the request as given cannot succeed |
| 500 | Unexpected | Details are logged, never returned |
| 503 | Database unreachable | Safe to retry; checkout is idempotent |

Other choices: a successful replay is `200` with `Idempotent-Replayed: true`, distinct from a first-time `201`. Validation failures list each field. The full table of codes is rendered in the Swagger description from [error-catalog.ts](src/docs/error-catalog.ts). Quantities use a strict integer type, because Elysia's own `t.Integer` coerces `"2"` to `2`, which would let a malformed quantity enter a cart silently.

---

## 7. Testing and validation

141 tests across 16 files, run against a real PostgreSQL test database (the invariants live in locks and constraints, so mocking the database would prove little). `bun test` migrates the test database itself and refuses to run against anything not named `*_test`.

| Area | What it proves |
|---|---|
| Unit: money, discount, pricing, errors, config | Rounding boundaries, float traps, discount clamping, price-change detection, error contract |
| [schema-constraints](tests/integration/schema-constraints.test.ts) | The database itself rejects negative stock, a second order per cart, a coupon on two orders, a duplicate milestone, unbalanced orders, and keeps order lines after a product is deleted |
| [checkout-concurrency](tests/integration/checkout-concurrency.test.ts) | 20 shoppers racing for 5 units give exactly 5 orders and stock 0; a losing multi-line checkout takes nothing; 10 simultaneous checkouts of one cart give one order and one deduction; opposite-order carts do not deadlock |
| [coupon-race](tests/integration/coupon-race.test.ts) | 10 carts on one coupon give exactly one winner and stock moves by one; a coupon held by a checkout that then fails is not lost to a competitor; 10 simultaneous generation requests give one coupon (or exactly milestones 1 and 2 when two are due) |
| [coupon-lifecycle](tests/integration/coupon-lifecycle.test.ts) | Failed checkouts (stock, price, payment) never consume a coupon; exact discount math; replay semantics |
| [report](tests/integration/report.test.ts) | Hand-computed figures; reconciliation with the orders and coupons endpoints; no state change on repeated calls; consistency while 40 checkouts commit |
| [docs](tests/integration/docs.test.ts) | Every operation is documented; the catalog matches real responses; `openapi.json` is current |

**Mutation checks.** For each guard I removed it and confirmed a test fails. Two were informative rather than clean passes:

| Guard removed | Result |
|---|---|
| Cart row lock | Same-cart retry-storm test and the concurrent cart-edit tests fail |
| Product row lock only | **Still passes**, by design: the compare-and-set update keeps stock correct on its own (defence in depth) |
| Product lock and the `stock >= q` guard | Both oversell tests fail |
| Reverse the product lock order (for everyone) | **No test fails.** A uniform order cannot deadlock, so the opposite-order test only protects against a later switch to per-line locking. I do not claim it proves more. |
| Coupon `status = 'AVAILABLE'` guard | Single-use test and the 10-way race fail |
| Advisory lock on generation | The 10-way single-milestone test fails; the two-milestone variant still passes (the unique constraint settles it), so the lock is proven by one test |
| Report `REPEATABLE READ` | Consistency test fails in 3 of 3 runs |

**Other validation.** [scripts/demo.ts](scripts/demo.ts) (`bun run demo`) runs the oversell, retry-storm and coupon races against a real running server and reconciles the report. I also did a fresh clone with brand-new databases in a clean environment and followed the README, which found a real bug (see [section 11](#11-how-i-used-ai-tools)).

---

## 8. Implemented vs deferred

**Implemented:** products and seed data; a Dockerfile and compose `api` service so the whole stack starts with `bun run stack:up` (migrates, seeds an empty database, runs as an unprivileged user); carts (create, view, add, set, remove) with validation; checkout with idempotent replay, price and stock re-validation, coupons and a payment port; orders as snapshots; milestone coupon generation and single-use redemption; admin listing and a self-checking report; Swagger UI, `openapi.json`, an executable `.http` walkthrough and a race demo script.

**Deferred on purpose:**

| Deferred | Why it was safe to skip, and what it would take |
|---|---|
| Authentication and authorization | Out of scope; admin routes sit under one group where a guard plugin goes |
| Coupon expiry; binding a coupon to a customer | Not required. Expiry is one column, one `WHERE` clause and an `expired` count in the report |
| Automatic coupon issuance to the nth buyer | Open interpretation, see decision 9; a small change |
| Product admin (create, restock, reprice) | Seed data covers evaluation |
| Stock reservations | Decision 4 |
| A real two-phase payment flow | Section 10 |
| Order cancellation and refunds | Would need rules for restoring stock and coupons |
| Pagination of admin lists | Fine at this scale |
| Rate limiting, metrics, tracing | Production concerns |
| Cleaning up abandoned carts | They are cheap rows |

---

## 9. Known weaknesses

Things I would point out myself:

1. **Payment is called inside the database transaction.** Fine for a fake. With a real provider it holds product-row locks across a network call, and because the runner retries the whole transaction on deadlock, the charge could be attempted twice. It needs the authorize-then-finalize design in section 10.
2. **Hot products serialize.** Every checkout of one product queues on its row lock for the duration of the transaction, and a waiting transaction holds a pooled connection (pool of 20, 10 s timeouts). Under heavy contention, requests could time out rather than fail fast. A `lock_timeout` and a smaller critical section would help.
3. **Coupon codes can be guessed by brute force.** They carry about 40 bits of randomness and checkout has no rate limiting, so a determined client could probe codes.
4. **A generated coupon reaches nobody automatically** (decision 9).
5. **The report and admin order list scan whole tables** and are unpaginated.
6. **`COUNT(*)` of orders** drives milestones; fine now, a maintained counter later.
7. **The report names a product by its latest order's name**, which is a presentation choice.
8. **One invariant violation is a plain 500:** a checked-out cart with no order throws a generic error (it should be impossible; the database constraints and single transaction prevent it).
9. **The 99-unit line cap is arbitrary.**

---

## 10. Evolution to multiple instances and production scale

- **Multiple app instances need no change to the invariants.** Instances are stateless, and every guarantee rests on PostgreSQL locks and constraints, not process memory. This is why an in-process mutex was rejected.
- **Payments.** Create the order as `PENDING_PAYMENT` with stock reserved in a short transaction; call the provider outside any DB transaction using an idempotency key; finalize on confirmation or release on failure; add a reconciliation job for orphaned pending orders and webhook handling. Move the runner's retry so it never re-runs a side effect.
- **Hot-product contention.** Shorter critical sections, a per-SKU stock ledger or sharded counters, a `lock_timeout` to fail fast, or queueing checkouts per SKU.
- **Read load.** Serve the report from a replica or from incrementally maintained aggregates; paginate and index admin lists.
- **Idempotency.** Add a generic `Idempotency-Key` table if checkout stops being one-to-one with carts.
- **Coupons.** Add expiry and customer binding; rate-limit redemption attempts; move to a maintained milestone counter if `COUNT(*)` becomes costly; issue automatically at the milestone.
- **Operations.** Authentication and authorization, rate limiting, structured tracing and metrics, connection pooling (PgBouncer in transaction mode needs care with advisory and row locks held per transaction, which these are), migrations in CI, a load test of the hot-SKU path.
- **Schema.** Separate order and inventory services would replace the single-transaction guarantee with a saga or outbox; that is the main cost of leaving the single database.

---

## 11. How I used AI tools

I used Claude Code to draft the plan, scaffold the project and write most of the code, working phase by phase and reviewing each phase before committing. The decisions below are where my review changed the AI's direction or where validation caught its mistakes.

**Redirected by me**

1. **Price-change policy.** The first design charged the live price and offered an optional `expectedTotal` guard. I asked that checkout itself verify both price and stock and refuse with a 409. The design became "reject by default unless `acceptPriceChanges`" (decision 5). A separate pre-checkout review endpoint, which the AI also proposed, I dropped in favour of checking inside the checkout transaction, which avoids a check-then-act gap.
2. **Money columns.** The plan used integer `price_cents` columns and a currency code. I asked for plain `price` with no currency, which led to `NUMERIC(12,2)` with integer arithmetic at the repository boundary (decision 1).
3. **Coupon timing.** I challenged admin-only generation: it cannot work in real time for a shopper in checkout. The AI conceded the gap and proposed auto-issuing the coupon to the nth buyer. I have not decided yet, so the implementation stays admin-triggered, matching the assignment's admin endpoint, and the question is recorded as open (decision 9). It is the first thing I would settle.
4. **Naming.** I asked for domain-specific names, so `multiplyMoney` and `sumMoney` became `calculateLineTotal` and `calculateSubtotal` in the pricing module.

**Corrected by validation**

5. **Framework default that weakened validation.** A cart test that sends `"2"` as a quantity returned 200: Elysia's `t.Integer` coerces numeric strings. I replaced it with a strict integer type for quantities and recorded why (section 6).
6. **A setup script that only worked on my machine.** `bun run db:test:migrate` used shell variable expansion and passed locally because my shell had the variables exported. A fresh clone in a clean environment showed it silently migrated nothing, leaving the test database empty. I replaced it with a Bun script, and the test setup now migrates the database itself.
7. **A plan statement that defeated its own guard.** The plan said `PATCH` would refresh a line's recorded price. While implementing, I saw this lets a price change be accepted silently, so quantity changes now never refresh it.
8. **Tests that proved less than claimed.** Mutation checks showed that removing the product lock alone, or reversing the lock order, did not fail the tests I had written to guard them. I documented what each test actually proves (section 7) instead of leaving an overstated claim.
9. **Tooling surprises.** Prisma queries are lazy thenables, so `expect(...).rejects` reported false failures until I awaited them inside an async function. The package manager pulled a Prisma 8 release candidate and TypeScript 7; I pinned to the same majors as my reference project. Elysia mutates shared schema objects, making the generated OpenAPI spec differ by `additionalProperties` depending on test order; the staleness check ignores that one keyword.

**How I validated AI-written code:** concurrency tests with `Promise.all` against a real database, database-level constraint tests that bypass the application, mutation checks of every guard, a race demo against a running server, a clean-clone setup run, and type checking and linting on every phase. I reviewed each phase's code before committing it and asked for walkthroughs of the repository, transaction, locking and checkout code.

---

## 12. What I would examine in another two hours

In rough priority order:

1. **Settle coupon delivery.** Decide with the product owner whether the nth buyer should receive the coupon in the checkout response, then implement `generateIfEligible(tx)` shared with the admin endpoint and add the matching race tests.
2. **Take payment out of the transaction.** Implement the pending-order flow and stop the runner from re-running side effects.
3. **Load-test the hot-product path** with many concurrent checkouts of one SKU against the connection pool, and add a `lock_timeout` so contention degrades into fast 409/503 responses instead of timeouts.
4. **Coupon abuse protection:** redemption rate limiting and expiry.
5. **Automate the mutation checks** so each guard is verified on every run, not by hand.
6. **Pagination and indexes** for the admin lists and a check of the report's query plans.
7. **Harden the container image:** a production-only dependency install, a CI image build, and a healthcheck that also verifies the database round trip.
