import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config/env";
import { createContainer } from "../../src/container";

export const app = createApp(createContainer(loadConfig()));

export type ApiResult = {
	status: number;
	headers: Headers;
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
	body: any;
};

/** Calls the app in-process (no network) so the real pool, locks and handlers are exercised. */
export async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
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

export const get = (path: string) => api("GET", path);
export const post = (path: string, body?: unknown) => api("POST", path, body);
export const patch = (path: string, body?: unknown) => api("PATCH", path, body);
export const del = (path: string) => api("DELETE", path);

export async function newCart(): Promise<string> {
	const result = await post("/carts");
	return result.body.id as string;
}

export const MISSING_ID = "99999999-9999-4999-8999-999999999999";
