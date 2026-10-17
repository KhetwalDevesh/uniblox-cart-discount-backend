import { type App, createApp } from "../../src/app";
import { type Config, loadConfig } from "../../src/config/env";
import { type ContainerOverrides, createContainer } from "../../src/container";
import { createProduct } from "./db";

export type ApiResult = {
	status: number;
	headers: Headers;
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
	body: any;
};

/** Coupon rule used by tests regardless of .env: every 3rd order earns a 10% coupon. */
export const TEST_COUPON_EVERY_N = 3;
export const TEST_COUPON_PERCENT = 10;

/**
 * Builds an app against the real database, optionally swapping parts such as the payment gateway
 * or the coupon rule.
 */
export function createTestApp(
	overrides: ContainerOverrides = {},
	config: Partial<Config> = {},
): App {
	return createApp(
		createContainer(
			{
				...loadConfig(),
				couponEveryNOrders: TEST_COUPON_EVERY_N,
				couponDiscountPercent: TEST_COUPON_PERCENT,
				...config,
			},
			overrides,
		),
	);
}

/** Calls an app in-process (no network) so the real pool, locks and handlers are exercised. */
export function createClient(app: App) {
	async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
		const response = await app.handle(
			new Request(`http://localhost/api${path}`, {
				method,
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			body: text ? JSON.parse(text) : undefined,
		};
	}

	return {
		api,
		get: (path: string) => api("GET", path),
		post: (path: string, body?: unknown) => api("POST", path, body),
		patch: (path: string, body?: unknown) => api("PATCH", path, body),
		del: (path: string) => api("DELETE", path),
	};
}

const defaultClient = createClient(createTestApp());

export const { api, get, post, patch, del } = defaultClient;

export async function newCart(client = defaultClient): Promise<string> {
	const result = await client.post("/carts");
	return result.body.id as string;
}

/** Creates a cart holding the given products and quantities. */
export async function cartWith(
	items: { productId: string; quantity: number }[],
	client = defaultClient,
): Promise<string> {
	const cartId = await newCart(client);
	for (const item of items) {
		const result = await client.post(`/carts/${cartId}/items`, item);
		if (result.status !== 200) throw new Error(`setup failed: ${JSON.stringify(result.body)}`);
	}
	return cartId;
}

export const checkout = (cartId: string, body?: unknown, client = defaultClient) =>
	client.post(`/carts/${cartId}/checkout`, body);

/** Places `count` successful orders (each a fresh cart with one unit of a fresh product). */
export async function placeOrders(count: number, client = defaultClient): Promise<void> {
	for (let i = 0; i < count; i++) {
		const product = await createProduct({ name: `Filler ${i}`, price: "10.00", stock: 5 });
		const cartId = await cartWith([{ productId: product.id, quantity: 1 }], client);
		const result = await checkout(cartId, undefined, client);
		if (result.status !== 201) throw new Error(`setup failed: ${JSON.stringify(result.body)}`);
	}
}

/** Generates the next coupon through the admin API and returns its code. */
export async function generateCoupon(client = defaultClient): Promise<string> {
	const result = await client.post("/admin/coupons/generate");
	if (result.status !== 201) throw new Error(`setup failed: ${JSON.stringify(result.body)}`);
	return result.body.code as string;
}

export const MISSING_ID = "99999999-9999-4999-8999-999999999999";
