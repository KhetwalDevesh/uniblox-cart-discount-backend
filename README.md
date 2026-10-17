# Cart, Checkout and Rewards Service

Backend for an ecommerce store: carts, idempotent checkout, orders, and a discount coupon made available after every n-th successfully placed order. Built to behave predictably under retries, concurrent checkouts, changing inventory and competing coupon use.

**Stack:** Bun, Elysia, Prisma, PostgreSQL 16 (Docker), Swagger UI. 141 automated tests run against a real database.

- **Design rationale, invariants, trade-offs, deferred work, AI usage:** [DECISIONS.md](./DECISIONS.md)
- **Original phased plan:** [plan.md](./plan.md)

**Approximate time spent:** _TODO (author): fill in before submitting._

## How to run and test the application

**The short version:** the API and database run in Docker; you drive them from your own terminal.

```bash
docker compose up -d --build --wait    # API + database in Docker (nothing else to install)
./scripts/demo.sh                      # concurrent checkouts fired from your terminal (needs curl and jq)
```

Then try individual requests with the curl commands in section 4, or the Swagger UI at http://localhost:4000/swagger. The details of each step follow.

### 1. Prerequisites

| Tool | Needed for | Check |
|---|---|---|
| [Docker](https://www.docker.com) with Compose (Docker Desktop or Engine, **running**) | running the database, the API and the tests | `docker info` |
| `curl` and [`jq`](https://jqlang.github.io/jq/) | the manual testing steps in section 4 | `curl --version`, `jq --version` |
| [Bun](https://bun.sh) 1.x | **optional**: only for the local development route (Option B) | `bun --version` |

You do not need Bun to run, test or try the application: Docker is enough. No credentials, accounts or external services are needed. Ports **5433** (Postgres) and **4000** (API) must be free.

### 2. Start the application

Run these from the repository root.

#### Option A: Docker only (no Bun needed)

```bash
docker compose up -d --build --wait
```

This builds the API image and starts PostgreSQL and the API, and returns once both are healthy (the first build takes a minute or two). The API container applies the database migrations and seeds the 7 demo products automatically, but only when the database is empty, so restarting it never resets your data. It runs as an unprivileged user.

- API: **http://localhost:4000**, interactive Swagger UI: **http://localhost:4000/swagger**
- Stop it: `docker compose down` (data is kept in a Docker volume). Wipe everything, including data: `docker compose down -v`.
- Logs: `docker compose logs -f api`
- Postgres is on host port 5433 so it does not clash with a local Postgres on 5432. Two databases exist: `cart_discount` (the app) and `cart_discount_test` (the tests, created on first start).

#### Option B: local development with Bun

For editing the code with hot reload. The database still runs in Docker.

```bash
# 1. install dependencies
bun install

# 2. create your environment file (the defaults work as-is)
cp .env.example .env

# 3. start only PostgreSQL in Docker (waits until it is healthy)
bun run db:up

# 4. generate the Prisma client
bun run db:generate

# 5. create the tables
bun run db:deploy

# 6. seed the data: 7 products, two of them with very limited stock
bun run db:seed

# 7. start the API with hot reload
bun run dev
```

Stop with `Ctrl+C`, and `bun run db:down` to stop Postgres. Use either option, not both at once: the Option A container and `bun run dev` both listen on port 4000. (`bun run stack:up` and `bun run stack:down` are shortcuts for the Option A commands.)

#### Seeded products

The ids are fixed, so the commands in this README work on any machine:

| Product | Price | Stock | Id |
|---|---|---|---|
| Wireless Mouse | 24.99 | 100 | `11111111-1111-4111-8111-111111111111` |
| Mechanical Keyboard | 89.50 | 50 | `22222222-2222-4222-8222-222222222222` |
| USB-C Cable | 9.99 | 200 | `33333333-3333-4333-8333-333333333333` |
| Laptop Stand | 34.00 | 40 | `44444444-4444-4444-8444-444444444444` |
| Noise-Cancelling Headphones | 149.99 | 25 | `55555555-5555-4555-8555-555555555555` |
| Limited Edition Keycap Set | 59.00 | **3** | `66666666-6666-4666-8666-666666666666` |
| Signed Collector Poster | 19.99 | **1** | `77777777-7777-4777-8777-777777777777` |

### 3. Run the automated tests

| Route | Command |
|---|---|
| Docker only | `docker compose run --rm tests` (starts Postgres if needed; the first run builds a test image) |
| With Bun | `bun run db:up`, then `bun test` |

The tests use the separate `cart_discount_test` database, migrate it automatically, and refuse to run against any database not named `*_test`, so your app data is never touched. They include concurrency tests (parallel checkouts racing for stock and coupons, retry storms, concurrent coupon generation, reports taken while orders commit) and tests that bypass the application to prove the database constraints themselves. Expected result: 141 tests pass.

With Bun you can also run `bun run typecheck` and `bun run lint`.

### 4. Manual testing with curl

Start from a clean state (stock restored, no orders). Keep the API running (section 2).

```bash
# Docker only:
docker compose exec api bun src/db/seed.ts
# With Bun:
bun run db:seed
```

Both restore the seeded names, prices and stock but keep existing orders; see section 6 to also clear orders.

**Step 0: set up variables and helpers (once per terminal)**

```bash
BASE=http://localhost:4000
API=$BASE/api
MOUSE=11111111-1111-4111-8111-111111111111
KEYBOARD=22222222-2222-4222-8222-222222222222
CABLE=33333333-3333-4333-8333-333333333333
KEYCAPS=66666666-6666-4666-8666-666666666666
JSON='content-type: application/json'

# show: print the response body followed by the HTTP status
show() { curl -s -w "\n-> HTTP %{http_code}\n" "$@"; }

# cart_with PRODUCT_ID QUANTITY: create a cart holding that item and print the cart id
cart_with() {
  local cart
  cart=$(curl -s -X POST $API/carts | jq -r .id)
  curl -s -o /dev/null -X POST $API/carts/$cart/items -H "$JSON" \
    -d "{\"productId\":\"$1\",\"quantity\":$2}"
  echo "$cart"
}

# checkout CART_ID [JSON_BODY]: check the cart out
checkout() { curl -s -X POST $API/carts/$1/checkout -H "$JSON" -d "${2:-{\}}"; }
```

**Step 1: health and catalog**

```bash
show $BASE/health                    # -> HTTP 200  {"status":"ok",...}
curl -s $API/products | jq           # 7 products with price and stock
show $API/products/$KEYCAPS          # one product; stock 3
```

**Step 2: build a cart (add, increase, set, view, remove)**

```bash
CART=$(curl -s -X POST $API/carts | jq -r .id); echo $CART     # a new empty cart

show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":2}"
#   -> HTTP 200  subtotal "49.98"   (2 x 24.99, exact)

show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$KEYBOARD\",\"quantity\":1}"
#   -> HTTP 200  subtotal "139.48"

show -X PATCH $API/carts/$CART/items/$MOUSE -H "$JSON" -d '{"quantity":3}'
#   -> HTTP 200  mouse quantity set to 3 (absolute), subtotal "164.47"

show -X DELETE $API/carts/$CART/items/$KEYBOARD
#   -> HTTP 200  keyboard removed, subtotal "74.97"

show $API/carts/$CART                # view: lines, live prices, priceChanged:false, subtotal
```

**Step 3: invalid input is rejected and never enters the cart**

```bash
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":0}"
#   -> HTTP 400  VALIDATION_ERROR   (quantity must be an integer 1 to 99)
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":1.5}"
#   -> HTTP 400  VALIDATION_ERROR
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":\"2\"}"
#   -> HTTP 400  VALIDATION_ERROR   (a string is not silently converted)
show -X POST $API/carts/$CART/items -H "$JSON" \
  -d '{"productId":"99999999-9999-4999-8999-999999999999","quantity":1}'
#   -> HTTP 404  PRODUCT_NOT_FOUND
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$KEYCAPS\",\"quantity\":4}"
#   -> HTTP 409  INSUFFICIENT_STOCK (details.lines: requested 4, available 3)
show $API/carts/$CART                # still only the 3 mice
```

**Step 4: checkout, and retrying it safely**

```bash
curl -s -o /tmp/order.json -w "-> HTTP %{http_code}\n" -X POST $API/carts/$CART/checkout -H "$JSON" -d '{}'
#   -> HTTP 201
jq . /tmp/order.json                 # items with names and prices, subtotal 74.97, discount 0.00, total 74.97
ORDER=$(jq -r .id /tmp/order.json)

# RETRY the same checkout (as if the response was lost):
curl -si -X POST $API/carts/$CART/checkout -H "$JSON" -d '{}' | grep -iE "^HTTP|idempotent-replayed"
#   HTTP/1.1 200 OK        idempotent-replayed: true   <- the SAME order, no second order

show $API/orders/$ORDER              # the order exactly as placed
curl -s $API/products/$MOUSE | jq .stock     # 97: stock was taken once (100 - 3), not twice

show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":1}"
#   -> HTTP 409  CART_NOT_OPEN   (a checked-out cart cannot change)

EMPTY=$(curl -s -X POST $API/carts | jq -r .id)
show -X POST $API/carts/$EMPTY/checkout -H "$JSON" -d '{}'
#   -> HTTP 422  CART_EMPTY
```

**Step 5: concurrent checkouts cannot oversell** (the keycap set has only 3 in stock)

```bash
# create 5 carts, each wanting 1 keycap set
CARTS=(); for i in 1 2 3 4 5; do CARTS+=("$(cart_with $KEYCAPS 1)"); done

# check all 5 out at the same instant and count the outcomes
( for c in "${CARTS[@]}"; do
    curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/carts/$c/checkout -H "$JSON" -d '{}' &
  done; wait ) | sort | uniq -c
#   3 x 201 (orders placed)   2 x 409 (INSUFFICIENT_STOCK)

curl -s $API/products/$KEYCAPS | jq .stock    # 0, never negative
```

**Step 6: a price change after adding an item**

```bash
PCART=$(cart_with $MOUSE 2)
# change the price behind the cart's back (24.99 -> 30.00)
docker exec cart-discount-postgres psql -U postgres -d cart_discount \
  -c "UPDATE products SET price = 30.00 WHERE id = '$MOUSE'"

curl -s $API/carts/$PCART | jq '.items[0] | {unitPrice, unitPriceAtAdd, priceChanged}'
#   unitPrice "30.00", unitPriceAtAdd "24.99", priceChanged true

show -X POST $API/carts/$PCART/checkout -H "$JSON" -d '{}'
#   -> HTTP 409  PRICE_CHANGED  (details show old and new price; nothing was changed)

show -X POST $API/carts/$PCART/checkout -H "$JSON" -d '{"acceptPriceChanges":true}'
#   -> HTTP 201  charged at the live price: total 60.00

docker compose exec api bun src/db/seed.ts   # restore the mouse price and stock (with Bun: bun run db:seed)
```

**Step 7: coupons** (every 3rd placed order reaches a milestone; an admin generates the coupon)

```bash
# place orders until the total number of orders is a multiple of 3 (and not zero)
N=$(curl -s $API/admin/orders | jq length)
until [ "$N" -gt 0 ] && [ $((N % 3)) -eq 0 ]; do
  checkout "$(cart_with $CABLE 1)" > /dev/null
  N=$(curl -s $API/admin/orders | jq length)
done
echo "orders placed: $N"

# Generate coupons. Each call creates the coupon for the next reached-but-unrewarded milestone
# (HTTP 201), so repeat until none is left: the final call is the refusal (HTTP 409).
while true; do
  OUT=$(show -X POST $API/admin/coupons/generate); echo "$OUT"
  echo "$OUT" | grep -q "HTTP 409" && break
done
#   -> HTTP 201  { code: "SAVE10-XXXXXXXX", milestone: 1, discountPercent: 10, status: "AVAILABLE" }
#   ...one 201 per pending milestone (orders / 3), then finally:
#   -> HTTP 409  NO_ELIGIBLE_MILESTONE   (details: placedOrders, ordersUntilNextMilestone)

CODE=$(curl -s $API/admin/coupons | jq -r '[.[] | select(.status=="AVAILABLE")][0].code'); echo $CODE

# redeem it: 2 keyboards = 179.00, 10% off = 17.90, total 161.10
KCART=$(cart_with $KEYBOARD 2)
show -X POST $API/carts/$KCART/checkout -H "$JSON" -d "{\"couponCode\":\"$CODE\"}"
#   -> HTTP 201  subtotal 179.00, discount 17.90, total 161.10, coupon { code, discountPercent: 10 }

# retry the same request: replay of the same order
curl -si -X POST $API/carts/$KCART/checkout -H "$JSON" -d "{\"couponCode\":\"$CODE\"}" | grep -iE "^HTTP|idempotent-replayed"
#   HTTP/1.1 200 OK   idempotent-replayed: true

# same cart, no coupon this time
show -X POST $API/carts/$KCART/checkout -H "$JSON" -d '{}'
#   -> HTTP 409  CART_ALREADY_CHECKED_OUT   (the original order stands)

# a coupon can be used only once
show -X POST $API/carts/$(cart_with $CABLE 1)/checkout -H "$JSON" -d "{\"couponCode\":\"$CODE\"}"
#   -> HTTP 409  COUPON_ALREADY_REDEEMED   (nothing was changed)

# an unknown code
show -X POST $API/carts/$(cart_with $CABLE 1)/checkout -H "$JSON" -d '{"couponCode":"NOPE-12345678"}'
#   -> HTTP 422  COUPON_NOT_FOUND

show "$API/admin/coupons?status=REDEEMED"     # the coupon now shows REDEEMED with its order id
```

**Step 8: two carts racing for one coupon**

```bash
# reach the next milestone, then generate a fresh coupon
N=$(curl -s $API/admin/orders | jq length)
until [ $((N % 3)) -eq 0 ]; do
  checkout "$(cart_with $CABLE 1)" > /dev/null
  N=$(curl -s $API/admin/orders | jq length)
done
CODE=$(curl -s -X POST $API/admin/coupons/generate | jq -r .code); echo $CODE

CARTS=(); for i in 1 2 3 4 5; do CARTS+=("$(cart_with $CABLE 1)"); done
( for c in "${CARTS[@]}"; do
    curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/carts/$c/checkout -H "$JSON" \
      -d "{\"couponCode\":\"$CODE\"}" &
  done; wait ) | sort | uniq -c
#   1 x 201 (exactly one checkout redeemed the coupon)   4 x 409 (COUPON_ALREADY_REDEEMED)
```

**Step 9: the admin report reconciles with the orders**

```bash
curl -s $API/admin/report | jq
#   ordersCount, purchasedQuantityByProduct, revenue {gross, discounts, net}, coupons {generated, available, redeemed}

# the same figures recomputed from the list of orders (exact, in cents):
curl -s $API/admin/orders | jq '{
  orders: length,
  gross:     ([.[].subtotal | tonumber * 100 | round] | add / 100),
  discounts: ([.[].discount | tonumber * 100 | round] | add / 100),
  net:       ([.[].total    | tonumber * 100 | round] | add / 100)
}'
#   matches the report; gross - discounts = net. Calling the report repeatedly changes nothing.
```

### 5. Other ways to try the API

| What | How |
|---|---|
| Interactive docs (Swagger UI), with "Try it out" | http://localhost:4000/swagger |
| OpenAPI 3 document | [openapi.json](./openapi.json) (regenerate with `bun run openapi`; a test fails if it is stale) |
| The same walkthrough as ready-to-run requests | [docs/api.http](./docs/api.http) (VS Code REST Client or IntelliJ HTTP Client) |
| Concurrent checkouts fired from **your terminal** against the running API | `./scripts/demo.sh` (needs only `curl` and `jq`). Races carts for the limited stock, retries one checkout 8 times at once, races carts for one coupon, and reconciles the report. Prints outcome counts and exits non-zero if a guarantee breaks. Run `docker compose exec api bun src/db/seed.ts` first to restore the limited stock. |
| The same demo as a script run inside Docker (no `jq` needed), or with Bun | `docker compose run --rm -e API_URL=http://api:4000 tests bun scripts/demo.ts`, or `bun run demo` |

### 6. Resetting state

| Goal | Command |
|---|---|
| Restore seeded product names, prices and stock (keeps orders) | `docker compose exec api bun src/db/seed.ts`, or with Bun: `bun run db:seed` |
| Also clear carts, orders and coupons | `docker exec cart-discount-postgres psql -U postgres -d cart_discount -c "TRUNCATE order_items, orders, coupons, cart_items, carts RESTART IDENTITY CASCADE"` then restore the products as above |
| Wipe everything, including the Docker volume | `docker compose down -v`, then start again as in section 2 |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | local Docker dev DB | Used by the app and migrations |
| `TEST_DATABASE_URL` | local Docker test DB | Used by `bun test`; must end in `_test` |
| `PORT` | 4000 | HTTP port |
| `COUPON_EVERY_N_ORDERS` | 3 | n: every n-th placed order reaches a coupon milestone |
| `COUPON_DISCOUNT_PERCENT` | 10 | x: percentage off the order subtotal for each coupon |
| `DATABASE_SSL`, `DATABASE_POOL_SIZE`, `LOG_LEVEL` | off, 20, info | Optional |

Tests fix `n = 3` and `x = 10` themselves, independent of `.env`.

## API summary

All routes are under `/api`. Administrative operations are under `/admin`; authentication is not implemented. Money is always a decimal string such as `"19.99"`. Every error has the shape `{ "status": "error", "code": "...", "message": "...", "details": {...}? }`; the full list of codes is in the Swagger description.

| Method | Path | Purpose | Notable errors |
|---|---|---|---|
| GET | `/products`, `/products/{id}` | Catalog with price and available stock | 404 `PRODUCT_NOT_FOUND` |
| POST | `/carts` | Create a cart (201) | |
| GET | `/carts/{id}` | Lines, live prices, `priceChanged`, subtotal | 404 `CART_NOT_FOUND` |
| POST | `/carts/{id}/items` | Add an item (adds to an existing line) | 400, 404, 409 `INSUFFICIENT_STOCK`, 409 `CART_NOT_OPEN` |
| PATCH | `/carts/{id}/items/{productId}` | Set an absolute quantity | 404 `ITEM_NOT_IN_CART`, 409 |
| DELETE | `/carts/{id}/items/{productId}` | Remove an item | 404 `ITEM_NOT_IN_CART`, 409 `CART_NOT_OPEN` |
| POST | `/carts/{id}/checkout` | Place the order. Optional `couponCode`, `acceptPriceChanges`. Safe to retry. | 409 `PRICE_CHANGED` / `INSUFFICIENT_STOCK` / `COUPON_ALREADY_REDEEMED` / `CART_ALREADY_CHECKED_OUT`, 422 `CART_EMPTY` / `COUPON_NOT_FOUND`, 402 `PAYMENT_DECLINED` |
| GET | `/orders/{id}` | The order exactly as placed | 404 `ORDER_NOT_FOUND` |
| POST | `/admin/coupons/generate` | Create the coupon for the lowest reached, unrewarded milestone | 409 `NO_ELIGIBLE_MILESTONE` |
| GET | `/admin/coupons` | List coupons, filter by `status` | |
| GET | `/admin/orders` | List all orders (used to reconcile the report) | |
| GET | `/admin/report` | Quantity per product, gross revenue, discounts, net revenue, coupons generated / available / redeemed, order count | |

Key behaviours:

- **Checkout is retry-safe.** The cart is the idempotency key. A repeat returns the original order (`200`, `Idempotent-Replayed: true`) with no second order and no second stock deduction. A failed checkout changes nothing, including the coupon.
- **Price or stock changed after adding?** Checkout re-checks both in one transaction. A changed price returns `409 PRICE_CHANGED` with old and new prices; retry with `acceptPriceChanges: true`. Short stock returns `409 INSUFFICIENT_STOCK` listing every short line.
- **Coupons.** Every n-th placed order reaches a milestone; an admin generates one coupon per milestone. A coupon is single-use, takes a percentage off the whole subtotal (rounded half up, never below zero), and is consumed only if the checkout succeeds.

## Project layout

```
src/
  domain/         pure logic: money, discount strategy, order pricing, error classes
  repositories/   all SQL and Prisma access (row locks, compare-and-set updates)
  services/       business rules and transaction boundaries (cart, checkout, coupons, report)
  router/         thin Elysia routers with TypeBox schemas that also drive the OpenAPI docs
  payment/        PaymentGateway port and a fake implementation
  db/             pool, Prisma client, transaction runner, seed
  docs/           typed error catalog and API description
  container.ts    composition root (dependency wiring)
prisma/           schema and migrations (with hand-written CHECK constraints)
tests/            unit and integration tests against a real database
docs/api.http     executable request walkthrough
scripts/          concurrency demo (demo.sh with curl, demo.ts with Bun), openapi generator, test-database migration
```

## Known limitations

Authentication, coupon expiry and customer binding, order cancellation, pagination of admin lists and a real payment provider are intentionally out of scope. The main open question is whether a coupon should also be issued automatically to the n-th buyer. These and other weaknesses, with how I would address them, are listed in [DECISIONS.md](./DECISIONS.md).
