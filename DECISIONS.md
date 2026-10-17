# DECISIONS

Status: **pre-implementation draft.** Sections marked _(to be completed)_ are filled in as the matching phase in [plan.md](./plan.md) lands. Decisions below reflect the plan; any deviation during implementation will be edited in place and noted.

## 1. System invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Stock never negative; never sell more than available | Conditional `UPDATE ... WHERE stock >= q` in the checkout transaction; DB `CHECK (stock >= 0)` backstop |
| I2 | A cart yields at most one order | `orders.cart_id UNIQUE`; cart row `FOR UPDATE` |
| I3 | Checkout retry creates no second order and no second stock decrement | Cart is the idempotency key; replay returns stored order |
| I4 | A coupon is redeemed at most once | Conditional `UPDATE coupons ... WHERE status='AVAILABLE'`; `orders.coupon_id UNIQUE` |
| I5 | A failed checkout consumes no stock or coupon | Everything inside one DB transaction |
| I6 | At most one coupon per milestone | `coupons.milestone UNIQUE` + advisory lock on generation |
| I7 | An order explains itself after product data changes | Snapshot of names, unit prices, percent, discount in `order_items` / `orders` |
| I8 | `0 <= total <= subtotal`; no float money | `NUMERIC(12,2)` storage, integer-minor-unit arithmetic, clamped discount, DB `CHECK` |
| I9 | Reports reconcile with orders/coupons and never write | Read-only `REPEATABLE READ` transaction; derived only from persisted rows |

## 2. Ambiguities and selected semantics

| Ambiguity | Selected semantics |
|---|---|
| Price changes between add and checkout | Cart stores price at add; cart view shows live price and a `priceChanged` flag. Checkout re-validates in its transaction: a differing live price gives `409 PRICE_CHANGED` (old/new per line) and changes nothing; retry with `acceptPriceChanges: true` charges live prices. Order snapshots the charged price. |
| Availability changes between add and checkout | No reservation. Add/update fast-fail when `quantity > stock`; checkout is authoritative and returns `409 INSUFFICIENT_STOCK` listing every short line. Cart remains open. |
| What counts as "successfully placed order" | A committed row in `orders`. Orders paid with a coupon count. |
| "Every nth order": how milestones are counted | Milestone k exists when `COUNT(orders) >= k * n`. Counted from committed rows, not from a sequence (sequences skip values on rollback). |
| Several milestones crossed before admin acts | One coupon per milestone, generated one per admin call, lowest unrewarded first. `409 NO_ELIGIBLE_MILESTONE` when none. |
| Who may use a coupon | Any bearer of the code (not bound to a customer). |
| What the discount applies to | Whole order subtotal, one coupon per order, percentage fixed at generation time. |
| Coupon expiry | None (deferred). |
| Coupon with a failed checkout | Stays `AVAILABLE`; claim and rollback are in the same transaction. |
| Checkout retry with a different coupon | `409 CART_ALREADY_CHECKED_OUT`; the original order stands. |
| Cart quantity bounds | Integer 1..99 per line; adding an existing product increments, `PATCH` sets. |
| Payment | `PaymentGateway` interface with a fake that approves; invoked inside the transaction so a decline rolls everything back. |
| Which operations are admin | Coupon generation, coupon listing, order listing, report (`/api/admin/*`). The order listing exists so the report can be reconciled against orders the API returns; it is unpaginated (deferred). No auth implemented. |

## 3. Material decisions

### Decision: Exact decimal storage, integer arithmetic, half-up rounding

**Context:** Totals and percent discounts must be exact and deterministic.

**Options considered:** plain JS float `number`; decimal library; integer minor units; Postgres `numeric`.

**Choice:** Store money as `NUMERIC(12,2)` columns named `price`, `subtotal`, `discount`, `total`. The API exposes decimal strings (`"19.99"`). The repository layer converts to integer minor units (1999) on read and back on write; all arithmetic happens on those integers, guarded against exceeding the safe-integer range. Discount = `floor((subtotal * x + 50) / 100)`, clamped to `[0, subtotal]`.

**Why:** `numeric` is exact and self-describing (a column called `price` holds 19.99, not 1999), and DB `CHECK`s work on it directly. Converting to integers at one boundary keeps JS floats out of money math with no extra dependency. Half-up is the common consumer expectation and is documented.

**Consequences:** One conversion boundary that must be tested (parse/format round-trips, no `Number(decimal)` shortcuts). Amounts are plain numbers with no currency; supporting currencies or sub-cent precision (e.g. tax) would need a currency-aware Money type.

### Decision: Cart as the natural idempotency key

**Context:** Clients retry checkout after timeouts and must not double-order or double-charge stock.

**Options considered:** Required `Idempotency-Key` header with a keys table; cart-as-key; client-generated order id.

**Choice:** Cart is the key. `orders.cart_id` is unique; a replay returns the stored order (`200`, `Idempotent-Replayed: true`).

**Why:** A cart is by definition checked out once, so there is nothing extra for clients to get wrong, and the guarantee is backed by a DB unique constraint rather than app logic.

**Consequences:** One-to-one cart/order. If checkout should support partial or multi-order carts, a separate key table becomes necessary. A retry with a different body (different coupon) is rejected rather than treated as a new attempt.

### Decision: Pessimistic row locks plus conditional updates

**Context:** Concurrent checkouts must not oversell; two checkouts must not share a coupon.

**Options considered:** `SERIALIZABLE` with retry; optimistic version column with retry; `SELECT ... FOR UPDATE`; conditional `UPDATE` (compare-and-set in SQL); in-process mutex.

**Choice:** `READ COMMITTED` transaction. Lock the cart row `FOR UPDATE`, then lock the products' rows in one `ORDER BY id FOR UPDATE` statement, validate price and stock against those locked rows, and take stock with a conditional `UPDATE ... WHERE stock >= q` (compare-and-set), asserting one row changed. The coupon is claimed the same way.

**Why:** Locking the product rows means the price validated is the price stored in the order, and the stock checked is the stock taken. The conditional update makes the guard and the write one atomic statement, so stock stays correct even if the lock were missing (mutation test: removing only the product lock still passes; removing the guard too fails the oversell tests). Locking all rows in one ordered statement prevents deadlocks. An in-process mutex would break with more than one instance.

**Consequences:** Hot products serialize on their row (acceptable here). `SERIALIZABLE` would be simpler to reason about but needs retry plumbing and aborts more under contention.

### Decision: No stock reservation when adding to cart

**Context:** Whether adding to a cart should hold inventory.

**Options considered:** Reserve on add with TTL; reserve at checkout start; no reservation.

**Choice:** No reservation; validate at add (fast feedback) and enforce at checkout.

**Why:** Reservations need expiry jobs and invite hoarding; the requirement is only that we never oversell.

**Consequences:** A user can see an item "available" and fail at checkout. The error lists exactly which lines are short.

### Decision: Checkout rejects price changes unless the client accepts them

**Context:** Product price or stock may change after an item was added to a cart and before checkout.

**Options considered:** Lock the price at add time; silently charge the live price; opt-in guard (`expectedTotal`); reject on change unless the client explicitly accepts; separate pre-checkout review endpoint.

**Choice:** The cart records `unit_price_at_add` but is not a price promise. Checkout re-validates inside its own transaction. A differing live price returns `409 PRICE_CHANGED` with old/new price per line and changes nothing; the client retries with `acceptPriceChanges: true` to be charged live prices. Stock is checked in the same transaction (see previous decision) and short lines return `409 INSUFFICIENT_STOCK`.

**Why:** Safe by default: a shopper is never charged an amount they have not seen, and protection needs no client cooperation. We do not honour stale prices, since the product's price is defined as its current price. Doing both checks inside the checkout transaction avoids the check-then-act gap a separate pre-check would have; the price check runs before any stock or coupon claim, so nothing needs undoing.

**Consequences:** One extra confirm round trip when a price changed. A replayed checkout (idempotent) ignores `acceptPriceChanges` and returns the stored order. Cart view still flags `priceChanged` so clients can warn earlier.

### Decision: Milestones from `COUNT(*)` with a unique milestone number

**Context:** "Every nth successful order" must be robust to rollbacks, concurrent generation, and repeated admin calls.

**Options considered:** Counter row incremented per order; order sequence value `% n`; count orders at generation time.

**Choice:** Count committed orders at generation time under an advisory lock; `coupons.milestone UNIQUE`.

**Why:** Sequences have gaps; a counter row adds a contention point to every checkout. Counting touches only the rare admin path, and the unique index is the final guard against duplicates.

**Consequences:** Coupons are only created on admin request, per the requirement. A very large orders table would need an indexed/cached counter later.

### Decision: Coupon claimed inside the checkout transaction

**Context:** A coupon must not be lost to a failed checkout or used by two checkouts.

**Options considered:** Separate reserve then confirm with expiry; claim inside the order transaction.

**Choice:** Claim with a conditional update inside the same transaction as stock and order creation.

**Why:** Rollback restores the coupon automatically; there is no intermediate "reserved" state to leak or expire.

**Consequences:** A concurrent loser waits briefly on the row lock then gets `COUPON_ALREADY_REDEEMED`.

### Decision: Payment abstraction invoked inside the transaction

**Context:** No real payments, but the failure ordering matters.

**Options considered:** Treat checkout as paid; fake gateway before commit; charge after commit.

**Choice:** `PaymentGateway` interface and a fake, called after stock/coupon claims and before commit, keyed by cart id.

**Why:** Lets tests prove that a decline leaves stock and coupon untouched.

**Consequences:** Holding a transaction open during a remote call is wrong at scale; see section 8.

## 4. Transaction, concurrency and idempotency strategy _(to be completed after Phase 5-6 with the final code references)_

Summary of the plan: one transaction per checkout; locks taken in the fixed order cart, products (sorted by id), coupon; all claims are conditional updates; unique constraints on `orders.cart_id`, `orders.coupon_id`, `coupons.milestone` are the last line of defense. See plan.md section 5.

## 5. Money and rounding rules

`NUMERIC(12,2)` storage, integer-minor-unit arithmetic; no currency concept (plain numbers); discount `floor((subtotal*x + 50)/100)` clamped to `[0, subtotal]`; total = subtotal - discount; applied once to the order subtotal. _(Examples table added with Phase 1 tests.)_

## 6. Error model

Uniform body `{ status: "error", code, message, details? }`. Codes are stable strings; HTTP status distinguishes class: `400` malformed input, `402` payment, `404` missing, `409` state conflict (stock, price, coupon redeemed, cart closed), `422` semantically invalid (empty cart, unknown coupon), `5xx` unexpected. _(Full catalog added in Phase 8.)_

## 7. Implemented vs deferred

_(To be completed. Planned deferrals: authentication, coupon expiry/customer binding, product admin CRUD, stock reservations, real payment two-phase flow, order cancel/refund, pagination of admin lists, rate limiting, observability.)_

## 8. Evolution to multiple instances and production scale

- App instances are stateless; correctness already depends only on PostgreSQL locks and constraints, not process memory, so horizontal scaling needs no change to the invariants.
- Payment: move to authorize-then-capture with an outbox. Create the order in `PENDING_PAYMENT`, call the provider outside the DB transaction with an idempotency key, finalize on confirmation; add a reconciliation job for orphaned pending orders.
- Hot-product contention: shorter transactions, per-SKU stock ledger, or queueing checkouts per SKU.
- Read load: report from a replica or materialized/incrementally maintained aggregates.
- Idempotency: add a generic `Idempotency-Key` table if checkouts stop being one-to-one with carts.
- Add authN/Z, rate limiting, structured tracing, DB migrations in CI, connection pooling (PgBouncer).

## 9. AI usage _(to be completed at the end with a real example)_

Claude Code was used to draft the plan and scaffold. Required: a concrete example of AI output that was corrected, rejected or redirected, plus how behaviour was validated (concurrency tests, mutation sanity checks).

## 10. If given another two hours _(to be completed)_

Initial candidates: mutation-test every guard against its race test, load test hot-SKU contention, add coupon expiry and customer binding, review lock ordering when carts include many lines.

## 11. Approximate time spent _(to be completed)_
