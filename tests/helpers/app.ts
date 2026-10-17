import { type App, createApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { type ContainerOverrides, createContainer } from "../../src/container";

export type ApiResult = {
	status: number;
	headers: Headers;
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
	body: any;
};

/** Builds an app against the real database, optionally swapping parts such as the payment gateway. */
export function createTestApp(overrides: ContainerOverrides = {}): App {
	return createApp(createContainer(loadConfig(), overrides));
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

export const MISSING_ID = "99999999-9999-4999-8999-999999999999";
