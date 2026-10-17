# Cart, Checkout and Rewards Service

Backend for an ecommerce store: carts, idempotent checkout, orders, and a discount coupon made available after every n-th successfully placed order. Built to behave predictably under retries, concurrent checkouts, changing inventory and competing coupon use.

**Stack:** Bun, Elysia, Prisma, PostgreSQL 16 (Docker), Swagger UI. 141 automated tests run against a real database.

- **Design rationale, invariants, trade-offs, deferred work, AI usage:** [DECISIONS.md](./DECISIONS.md)
- **Original phased plan:** [plan.md](./plan.md)

**Approximate time spent:** _TODO (author): fill in before submitting._

## How to run and test the application

The API and database run in Docker. You drive them from your own terminal with the scripts and `curl` commands below.

**Prerequisites:** [Docker](https://www.docker.com) with Compose (running; check with `docker info`), plus `curl` and [`jq`](https://jqlang.github.io/jq/) for the manual steps and the demo script. Nothing else needs installing, and no credentials or external services are needed. Ports **4000** (API) and **5433** (Postgres) must be free.

### 1. Start everything (Docker only)

```bash
docker compose up -d --build --wait     # API + database; migrates and seeds automatically
curl -s localhost:4000/health           # {"status":"ok",...}
```

The first build takes a minute or two. The API container applies the database migrations and seeds the 7 products when the database is empty, so restarting it never resets your data. Swagger UI: http://localhost:4000/swagger. Logs: `docker compose logs -f api`.

**Seeded products** (fixed ids, so every command below works on any machine):

| Product | Price | Stock | Id |
|---|---|---|---|
| Wireless Mouse | 24.99 | 100 | `11111111-1111-4111-8111-111111111111` |
| Mechanical Keyboard | 89.50 | 50 | `22222222-2222-4222-8222-222222222222` |
| USB-C Cable | 9.99 | 200 | `33333333-3333-4333-8333-333333333333` |
| Laptop Stand | 34.00 | 40 | `44444444-4444-4444-8444-444444444444` |
| Noise-Cancelling Headphones | 149.99 | 25 | `55555555-5555-4555-8555-555555555555` |
| Limited Edition Keycap Set | 59.00 | **3** | `66666666-6666-4666-8666-666666666666` |
| Signed Collector Poster | 19.99 | **1** | `77777777-7777-4777-8777-777777777777` |

### 2. Script testing

**a. Automated tests** (141 are expected to pass). They use a separate `cart_discount_test` database that is migrated automatically, and refuse to run against any database not named `*_test`, so your data is safe:

```bash
docker compose run --rm tests
```

**b. Concurrent checkouts from your terminal** (needs `curl` and `jq`). Run it last, after the manual steps and a reset (section 4), because it needs the limited stock:

```bash
./scripts/demo.sh
```

Expected: 3 x 201 and 6 x 409 for the oversell race; 1 x 201 and 7 x 200 (replays) for the retry storm; 1 x 201 and 5 x 409 for the coupon race; the report reconciles with the orders; all checks PASS and "All checks passed." The script exits non-zero if any guarantee is broken.

### 3. Manual testing with curl

**Setup (once per terminal):**

```bash
BASE=http://localhost:4000; API=$BASE/api
MOUSE=11111111-1111-4111-8111-111111111111
KEYBOARD=22222222-2222-4222-8222-222222222222
CABLE=33333333-3333-4333-8333-333333333333
KEYCAPS=66666666-6666-4666-8666-666666666666
JSON='content-type: application/json'
show() { curl -s -w "\n-> HTTP %{http_code}\n" "$@"; }
cart_with() { local c; c=$(curl -s -X POST $API/carts | jq -r .id)
  curl -s -o /dev/null -X POST $API/carts/$c/items -H "$JSON" -d "{\"productId\":\"$1\",\"quantity\":$2}"; echo "$c"; }
checkout() { curl -s -X POST $API/carts/$1/checkout -H "$JSON" -d "${2:-{\}}"; }
```

**Cart basics:**

```bash
curl -s $API/products | jq                                   # 7 products
CART=$(curl -s -X POST $API/carts | jq -r .id)
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":2}"   # subtotal 49.98
show -X PATCH $API/carts/$CART/items/$MOUSE -H "$JSON" -d '{"quantity":3}'                      # subtotal 74.97
```

**Invalid input** (rejected, and never enters the cart):

```bash
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":0}"       # 400
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":\"2\"}"   # 400
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$KEYCAPS\",\"quantity\":4}"     # 409 INSUFFICIENT_STOCK
```

**Checkout and safe retry:**

```bash
show -X POST $API/carts/$CART/checkout -H "$JSON" -d '{}'                                   # 201, total 74.97
curl -si -X POST $API/carts/$CART/checkout -H "$JSON" -d '{}' | grep -iE "^HTTP|idempotent"  # 200, idempotent-replayed: true
curl -s $API/products/$MOUSE | jq .stock                                                     # 97 (taken once)
show -X POST $API/carts/$CART/items -H "$JSON" -d "{\"productId\":\"$MOUSE\",\"quantity\":1}"  # 409 CART_NOT_OPEN
```

**Oversell race** (the keycap set has stock 3):

```bash
CARTS=(); for i in 1 2 3 4 5; do CARTS+=("$(cart_with $KEYCAPS 1)"); done
( for c in "${CARTS[@]}"; do curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/carts/$c/checkout -H "$JSON" -d '{}' & done; wait ) | sort | uniq -c
# 3 x 201, 2 x 409;  then: curl -s $API/products/$KEYCAPS | jq .stock   -> 0
```

**Price change:**

```bash
PCART=$(cart_with $MOUSE 2)
docker exec cart-discount-postgres psql -U postgres -d cart_discount -c "UPDATE products SET price = 30.00 WHERE id = '$MOUSE'"
show -X POST $API/carts/$PCART/checkout -H "$JSON" -d '{}'                                  # 409 PRICE_CHANGED
show -X POST $API/carts/$PCART/checkout -H "$JSON" -d '{"acceptPriceChanges":true}'         # 201, total 60.00
docker compose exec api bun src/db/seed.ts                                                  # restore price and stock
```

**Coupons** (every 3rd order reaches a milestone; place orders until the count is a multiple of 3, then generate):

```bash
N=$(curl -s $API/admin/orders | jq length)
until [ "$N" -gt 0 ] && [ $((N % 3)) -eq 0 ]; do checkout "$(cart_with $CABLE 1)" > /dev/null; N=$(curl -s $API/admin/orders | jq length); done
while true; do OUT=$(show -X POST $API/admin/coupons/generate); echo "$OUT"; echo "$OUT" | grep -q "HTTP 409" && break; done   # 201s, then 409 NO_ELIGIBLE_MILESTONE
CODE=$(curl -s $API/admin/coupons | jq -r '[.[] | select(.status=="AVAILABLE")][0].code')
KCART=$(cart_with $KEYBOARD 2)
show -X POST $API/carts/$KCART/checkout -H "$JSON" -d "{\"couponCode\":\"$CODE\"}"          # 201: 179.00 - 17.90 = 161.10
show -X POST $API/carts/$KCART/checkout -H "$JSON" -d '{}'                                  # 409 CART_ALREADY_CHECKED_OUT
show -X POST $API/carts/$(cart_with $CABLE 1)/checkout -H "$JSON" -d "{\"couponCode\":\"$CODE\"}"   # 409 COUPON_ALREADY_REDEEMED
show -X POST $API/carts/$(cart_with $CABLE 1)/checkout -H "$JSON" -d '{"couponCode":"NOPE-12345678"}' # 422 COUPON_NOT_FOUND
```

The race for a single coupon between several carts is covered by `./scripts/demo.sh` (section 2b).

**Report:**

```bash
curl -s $API/admin/report | jq
curl -s $API/admin/orders | jq '{orders: length, gross: ([.[].subtotal|tonumber*100|round]|add/100), discounts: ([.[].discount|tonumber*100|round]|add/100), net: ([.[].total|tonumber*100|round]|add/100)}'
# the two should match: gross - discounts = net
```

### 4. Reset between runs

```bash
docker compose exec -T postgres psql -U postgres -d cart_discount \
  -c "TRUNCATE order_items, orders, coupons, cart_items, carts RESTART IDENTITY CASCADE"
docker compose exec api bun src/db/seed.ts      # restore stock and prices
```

Do this after the manual testing and before `./scripts/demo.sh`, because the manual oversell step uses up the keycap stock.

### 5. Stop

```bash
docker compose down        # keeps data; add -v to wipe it
```

### Other ways to try the API

| What | Where |
|---|---|
| Interactive docs (Swagger UI), with "Try it out" | http://localhost:4000/swagger |
| OpenAPI 3 document | [openapi.json](./openapi.json) (a test fails if it is stale) |
| The walkthrough as ready-to-run requests | [docs/api.http](./docs/api.http) (VS Code REST Client or IntelliJ HTTP Client) |

## Configuration

The API reads its settings from environment variables, set for the Docker stack under `api: environment:` in [docker-compose.yml](./docker-compose.yml). Change a value there and run `docker compose up -d` to apply it.

| Variable | Docker default | Meaning |
|---|---|---|
| `DATABASE_URL` | the compose Postgres | Database connection |
| `PORT` | 4000 | HTTP port |
| `COUPON_EVERY_N_ORDERS` | 3 | n: every n-th placed order reaches a coupon milestone |
| `COUPON_DISCOUNT_PERCENT` | 10 | x: percentage off the order subtotal for each coupon |
| `SEED_ON_START` | true | Seed the demo products when the database is empty |

The automated tests fix `n = 3` and `x = 10` themselves.

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
