#!/usr/bin/env bash
# Concurrency demo using only curl and jq, run from your own terminal against a running API
# (for example the Docker stack: docker compose up -d --build --wait).
#
#   ./scripts/demo.sh                          # API_URL defaults to http://localhost:4000
#   API_URL=http://localhost:4000 ./scripts/demo.sh
#
# It fires real parallel checkouts (background curl jobs) and checks the outcomes. Exits non-zero
# if a guarantee is broken. Restore the limited stock between runs with:
#   docker compose exec api bun src/db/seed.ts      (or: bun run db:seed)
set -u

ROOT="${API_URL:-http://localhost:4000}"
API="$ROOT/api"
KEYCAPS=66666666-6666-4666-8666-666666666666   # seeded with very limited stock
CABLE=33333333-3333-4333-8333-333333333333
JSON='content-type: application/json'
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

for tool in curl jq; do
  command -v "$tool" > /dev/null || { echo "This script needs '$tool' installed."; exit 1; }
done
curl -sf "$ROOT/health" > /dev/null || {
  echo "API is not reachable at $ROOT. Start it with: docker compose up -d --build --wait"
  exit 1
}

check() { # check DESCRIPTION CONDITION_EXIT_CODE
  if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); fi
}

cart_with() { # cart_with PRODUCT_ID QUANTITY -> prints the new cart id
  local cart
  cart=$(curl -s -X POST "$API/carts" | jq -r .id)
  curl -s -o /dev/null -X POST "$API/carts/$cart/items" -H "$JSON" \
    -d "{\"productId\":\"$1\",\"quantity\":$2}"
  echo "$cart"
}

stock_of() { curl -s "$API/products/$1" | jq -r .stock; }

# fire_checkouts BODY CART_ID...: check every cart out at the same instant.
# Leaves $WORK/status.N and $WORK/body.N for each request.
fire_checkouts() {
  local body="$1" i=0 cart
  shift
  rm -f "$WORK"/status.* "$WORK"/body.*
  for cart in "$@"; do
    i=$((i + 1))
    curl -s -o "$WORK/body.$i" -w "%{http_code}\n" -X POST "$API/carts/$cart/checkout" \
      -H "$JSON" -d "$body" > "$WORK/status.$i" &
  done
  wait
}

count_status() { cat "$WORK"/status.* | grep -c "^$1$" || true; }
summary() { cat "$WORK"/status.* | sort | uniq -c | awk '{printf "%s x %s  ", $1, $2}'; echo; }

# ------------------------------------------------------------------------------------------------
echo
STOCK=$(stock_of $KEYCAPS)
if [ "$STOCK" -lt 1 ]; then
  echo "1. Oversell race: skipped, the keycap set is already sold out."
  echo "   Restore the stock first: docker compose exec api bun src/db/seed.ts   (or: bun run db:seed)"
else
  SHOPPERS=$((STOCK + 6))
  echo "1. $SHOPPERS shoppers race for $STOCK limited keycap sets"
  CARTS=(); for _ in $(seq 1 "$SHOPPERS"); do CARTS+=("$(cart_with $KEYCAPS 1)"); done
  fire_checkouts '{}' "${CARTS[@]}"
  echo "   outcomes: $(summary)"
  [ "$(count_status 201)" -eq "$STOCK" ]; check "exactly $STOCK orders placed" $?
  [ "$(stock_of $KEYCAPS)" -eq 0 ]; check "stock ends at 0 (was $STOCK), never negative" $?
fi

# ------------------------------------------------------------------------------------------------
echo
echo "2. One cart checked out 8 times at once (a client retrying aggressively)"
CART=$(cart_with $CABLE 2)
BEFORE=$(stock_of $CABLE)
fire_checkouts '{}' "$CART" "$CART" "$CART" "$CART" "$CART" "$CART" "$CART" "$CART"
echo "   outcomes: $(summary)"
[ "$(count_status 201)" -eq 1 ]; check "exactly one order created (the rest are replays)" $?
[ "$(cat "$WORK"/body.* | jq -r .id | sort -u | wc -l | tr -d ' ')" -eq 1 ]
check "every response carries the same order id" $?
[ $((BEFORE - $(stock_of $CABLE))) -eq 2 ]; check "stock deducted once (2 units), not 8 times" $?

# ------------------------------------------------------------------------------------------------
echo
echo "3. Several carts race for one coupon"
COUPON=$(curl -s -o "$WORK/coupon" -w "%{http_code}" -X POST "$API/admin/coupons/generate")
if [ "$COUPON" != "201" ]; then
  echo "   skipped: $(jq -r '.code + " (" + .message + ")"' "$WORK/coupon")"
else
  CODE=$(jq -r .code "$WORK/coupon")
  CARTS=(); for _ in 1 2 3 4 5 6; do CARTS+=("$(cart_with $CABLE 1)"); done
  fire_checkouts "{\"couponCode\":\"$CODE\"}" "${CARTS[@]}"
  echo "   coupon $CODE; outcomes: $(summary)"
  [ "$(count_status 201)" -eq 1 ]; check "exactly one checkout redeemed the coupon" $?
  [ "$(cat "$WORK"/body.* | jq -r .code | grep -c COUPON_ALREADY_REDEEMED)" -eq 5 ]
  check "the others were refused with COUPON_ALREADY_REDEEMED" $?
fi

# ------------------------------------------------------------------------------------------------
echo
echo "4. Report reconciles with the orders endpoint"
REPORT=$(curl -s "$API/admin/report")
ORDERS=$(curl -s "$API/admin/orders")
cents() { echo "$ORDERS" | jq "[.[].$1 | tonumber * 100 | round] | add // 0"; }
report_cents() { echo "$REPORT" | jq ".revenue.$1 | tonumber * 100 | round"; }
[ "$(echo "$ORDERS" | jq length)" -eq "$(echo "$REPORT" | jq .ordersCount)" ]
check "order count matches ($(echo "$REPORT" | jq .ordersCount))" $?
[ "$(cents subtotal)" -eq "$(report_cents gross)" ]; check "gross $(echo "$REPORT" | jq -r .revenue.gross)" $?
[ "$(cents discount)" -eq "$(report_cents discounts)" ]
check "discounts $(echo "$REPORT" | jq -r .revenue.discounts)" $?
[ "$(cents total)" -eq "$(report_cents net)" ]; check "net $(echo "$REPORT" | jq -r .revenue.net)" $?

echo
if [ "$FAILURES" -eq 0 ]; then echo "All checks passed."; else echo "$FAILURES check(s) FAILED."; fi
exit $((FAILURES > 0))
