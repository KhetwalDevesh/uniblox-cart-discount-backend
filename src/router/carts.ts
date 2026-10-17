import { Elysia } from "elysia";
import {
	AddItemBody,
	CartItemParams,
	CartModel,
	CartParams,
	SetQuantityBody,
} from "../schemas/cart";
import { ErrorResponse } from "../schemas/common";
import type { CartService } from "../services/cart.service";

const mutationErrors = { 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const cartRouter = (carts: CartService) =>
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
		);
