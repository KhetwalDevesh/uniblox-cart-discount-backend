import type { ConflictCode, NotFoundCode, UnprocessableCode } from "../domain/errors";

/** Every `code` the API can return. Adding a code to the domain forces an entry here. */
export type ErrorCode =
	| NotFoundCode
	| ConflictCode
	| UnprocessableCode
	| "VALIDATION_ERROR"
	| "INVALID_BODY"
	| "PAYMENT_DECLINED"
	| "SERVICE_UNAVAILABLE"
	| "ROUTE_NOT_FOUND"
	| "INTERNAL_ERROR";

type ErrorEntry = {
	status: number;
	meaning: string;
	/** What a client should do about it. */
	action: string;
};

/** Single source of truth for the error documentation (rendered into the OpenAPI description). */
export const ERROR_CATALOG: Record<ErrorCode, ErrorEntry> = {
	VALIDATION_ERROR: {
		status: 400,
		meaning: "A field is missing, malformed or out of range. `details.errors` lists each field.",
		action: "Fix the request. Retrying unchanged will fail again.",
	},
	INVALID_BODY: {
		status: 400,
		meaning: "The request body is not valid JSON.",
		action: "Send well-formed JSON.",
	},
	PAYMENT_DECLINED: {
		status: 402,
		meaning: "The payment was declined. Nothing was changed: stock and coupon are untouched.",
		action: "Retry with another payment method; the cart is still open.",
	},
	PRODUCT_NOT_FOUND: {
		status: 404,
		meaning: "The product does not exist.",
		action: "Use an id from `GET /api/products`.",
	},
	CART_NOT_FOUND: {
		status: 404,
		meaning: "The cart does not exist.",
		action: "Create one with `POST /api/carts`.",
	},
	ITEM_NOT_IN_CART: {
		status: 404,
		meaning: "That product is not in the cart.",
		action: "Add it first, or refresh the cart view.",
	},
	ORDER_NOT_FOUND: {
		status: 404,
		meaning: "The order does not exist.",
		action: "Check the order id returned by checkout.",
	},
	ROUTE_NOT_FOUND: {
		status: 404,
		meaning: "No such endpoint.",
		action: "Check the path and method.",
	},
	INSUFFICIENT_STOCK: {
		status: 409,
		meaning:
			"Not enough stock. `details.lines` lists each short product with `requested` and `available`. Nothing was changed.",
		action: "Lower the quantities or remove the items, then retry.",
	},
	PRICE_CHANGED: {
		status: 409,
		meaning:
			"A price changed since the item was added. `details.lines` lists `oldUnitPrice` and `newUnitPrice`. Nothing was changed.",
		action: "Show the new prices; to accept them, retry checkout with `acceptPriceChanges: true`.",
	},
	CART_NOT_OPEN: {
		status: 409,
		meaning: "The cart was already checked out and can no longer be changed.",
		action: "Create a new cart for the next purchase.",
	},
	CART_ALREADY_CHECKED_OUT: {
		status: 409,
		meaning:
			"The cart was checked out with a different coupon than this request. `details.orderId` is the original order.",
		action: "Fetch the original order; do not retry with a different body.",
	},
	COUPON_ALREADY_REDEEMED: {
		status: 409,
		meaning: "The coupon has already been used. Nothing was changed.",
		action: "Retry without the coupon, or with a different one.",
	},
	NO_ELIGIBLE_MILESTONE: {
		status: 409,
		meaning:
			"No unrewarded order milestone has been reached. `details` shows orders placed and orders until the next milestone.",
		action: "Try again after more orders are placed.",
	},
	CART_EMPTY: {
		status: 422,
		meaning: "The cart has no items.",
		action: "Add at least one item before checkout.",
	},
	COUPON_NOT_FOUND: {
		status: 422,
		meaning: "The coupon code does not exist. Nothing was changed.",
		action: "Check the code, or retry without a coupon.",
	},
	INTERNAL_ERROR: {
		status: 500,
		meaning: "Unexpected server error. Details are logged, not returned.",
		action: "Retry; checkout is safe to retry.",
	},
	SERVICE_UNAVAILABLE: {
		status: 503,
		meaning: "The database is temporarily unreachable.",
		action: "Retry shortly; checkout is safe to retry.",
	},
};

export function renderErrorCatalog(): string {
	const rows = Object.entries(ERROR_CATALOG)
		.sort(([, a], [, b]) => a.status - b.status)
		.map(
			([code, entry]) => `| \`${code}\` | ${entry.status} | ${entry.meaning} | ${entry.action} |`,
		);
	return ["| Code | HTTP | Meaning | What to do |", "|---|---|---|---|", ...rows].join("\n");
}
