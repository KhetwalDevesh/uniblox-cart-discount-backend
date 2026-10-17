import { renderErrorCatalog } from "./error-catalog";

/** Markdown shown at the top of the Swagger UI page and in `openapi.json`. */
export const API_DESCRIPTION = `
Carts, idempotent checkout, orders, and a coupon made available after every n-th placed order.

## Conventions

- **Money** is always a decimal string with two digits, such as \`"19.99"\`, never a JSON number.
- **Errors** always have one shape: \`{ "status": "error", "code": "...", "message": "...", "details": {...}? }\`.
  Branch on \`code\`, not on \`message\`. All codes are listed below.
- **Administrative operations** live under \`/api/admin\`. Authentication is not implemented.

## A typical purchase

1. \`GET /api/products\`, then \`POST /api/carts\`.
2. \`POST /api/carts/{id}/items\` for each product (repeat adds increase the quantity).
3. \`POST /api/carts/{id}/checkout\`. A cart is single-use: create a new one for the next purchase.
4. \`GET /api/orders/{id}\` returns the order exactly as placed.

## Retrying checkout

The cart is the idempotency key. If a checkout request times out or its response is lost, send the same
request again: the original order is returned with \`200\` and header \`Idempotent-Replayed: true\`, and no second
order or stock deduction happens. A failed checkout (stock, price, coupon or payment) changes nothing.

## Prices and stock

Adding to a cart does not reserve stock. Checkout is the authority: it re-checks stock and prices in one
transaction. If a price changed since the item was added, checkout returns \`409 PRICE_CHANGED\` with the old and
new prices; retry with \`acceptPriceChanges: true\` to be charged the current prices.

## Coupons

Every n-th successfully placed order reaches a milestone (n is configured). An administrator calls
\`POST /api/admin/coupons/generate\` to create the coupon for the lowest unrewarded milestone. A coupon takes a
percentage off the whole order subtotal (rounded half up, never below zero), is single-use, and is consumed only
if the checkout succeeds.

## Error codes

${renderErrorCatalog()}
`.trim();
