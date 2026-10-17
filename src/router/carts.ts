import { Elysia, t } from "elysia";
import {
	AddItemBody,
	CartItemParams,
	CartModel,
	CartParams,
	SetQuantityBody,
} from "../schemas/cart";
import { ErrorResponse } from "../schemas/common";
import { CheckoutBody, OrderModel } from "../schemas/order";
import type { CartService } from "../services/cart.service";
import type { CheckoutService } from "../services/checkout.service";

const mutationErrors = { 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const cartRouter = (carts: CartService, checkout: CheckoutService) =>
	new Elysia({ prefix: "/carts", tags: ["Carts"] })
		.post(
			"/",
			async ({ set }) => {
				set.status = 201;
				return carts.create();
			},
			{
				response: { 201: CartModel },
				detail: {
					summary: "Create a cart",
					description:
						"Creates an empty cart. A cart is single-use: once checked out it cannot be reused, " +
						"create a new cart for the next purchase. The cart id acts as the client's handle.",
				},
			},
		)
		.get("/:id", ({ params }) => carts.get(params.id), {
			params: CartParams,
			response: { 200: CartModel, 400: ErrorResponse, 404: ErrorResponse },
			detail: {
				summary: "View a cart",
				description:
					"Returns lines with current prices, a `priceChanged` flag per line, quantity and subtotal. " +
					"Read-only. Errors: `404 CART_NOT_FOUND`.",
			},
		})
		.post(
			"/:id/items",
			({ params, body }) => carts.addItem(params.id, body.productId, body.quantity),
			{
				params: CartParams,
				body: AddItemBody,
				response: { 200: CartModel, ...mutationErrors },
				detail: {
					summary: "Add an item",
					description:
						"Adds `quantity` units. Adding a product already in the cart increases its quantity. " +
						"Errors: `404 CART_NOT_FOUND` / `PRODUCT_NOT_FOUND`, `409 INSUFFICIENT_STOCK` (resulting quantity " +
						"exceeds stock), `409 CART_NOT_OPEN`, `400 VALIDATION_ERROR` (quantity not an integer 1-99, or " +
						"the line would exceed 99).",
				},
			},
		)
		.patch(
			"/:id/items/:productId",
			({ params, body }) => carts.setQuantity(params.id, params.productId, body.quantity),
			{
				params: CartItemParams,
				body: SetQuantityBody,
				response: { 200: CartModel, ...mutationErrors },
				detail: {
					summary: "Set an item's quantity",
					description:
						"Sets an absolute quantity, so it is safe to retry. Errors: `404 CART_NOT_FOUND` / " +
						"`ITEM_NOT_IN_CART`, `409 INSUFFICIENT_STOCK`, `409 CART_NOT_OPEN`, `400 VALIDATION_ERROR`.",
				},
			},
		)
		.delete(
			"/:id/items/:productId",
			({ params }) => carts.removeItem(params.id, params.productId),
			{
				params: CartItemParams,
				response: { 200: CartModel, ...mutationErrors },
				detail: {
					summary: "Remove an item",
					description:
						"Removes the line. Re-adding the product records the current price. Errors: " +
						"`404 CART_NOT_FOUND` / `ITEM_NOT_IN_CART`, `409 CART_NOT_OPEN`.",
				},
			},
		)
		.post(
			"/:id/checkout",
			async ({ params, body, set }) => {
				const result = await checkout.checkout(params.id, body ?? {});
				if (result.replayed) {
					set.headers["idempotent-replayed"] = "true";
					set.status = 200;
				} else {
					set.status = 201;
				}
				return result.order;
			},
			{
				params: CartParams,
				body: t.Optional(CheckoutBody),
				response: {
					200: OrderModel,
					201: OrderModel,
					400: ErrorResponse,
					402: ErrorResponse,
					404: ErrorResponse,
					409: ErrorResponse,
					422: ErrorResponse,
				},
				detail: {
					summary: "Check out a cart",
					description:
						"Validates the cart and places the order in one transaction: re-checks prices and stock, " +
						"takes the stock, charges payment, stores the order and closes the cart.\n\n" +
						"**Safe to retry.** The cart is the idempotency key: a repeated request for a cart that was " +
						"already checked out returns the original order with `200` and header `Idempotent-Replayed: true`. " +
						"No second order and no second stock deduction.\n\n" +
						"An optional `couponCode` takes its percentage off the whole subtotal (rounded half up, never below zero). " +
						"A coupon is single-use and is only consumed if the checkout succeeds. Retrying with the same body " +
						"replays; retrying a checked-out cart with a different coupon returns `409 CART_ALREADY_CHECKED_OUT`.\n\n" +
						"Success: `201` with the new order. Errors: `404 CART_NOT_FOUND`, `422 CART_EMPTY`, " +
						"`422 COUPON_NOT_FOUND`, `409 COUPON_ALREADY_REDEEMED`, " +
						"`409 PRICE_CHANGED` (details list old/new price per line; retry with `acceptPriceChanges: true`), " +
						"`409 INSUFFICIENT_STOCK` (details list every short line), `402 PAYMENT_DECLINED`. " +
						"A failed checkout changes nothing: stock and the cart are untouched.",
				},
			},
		);
