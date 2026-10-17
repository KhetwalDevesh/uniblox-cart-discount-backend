import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { FakePaymentGateway } from "../../src/payment/fake-payment-gateway";
import {
	cartWith,
	checkout,
	createClient,
	createTestApp,
	get,
	MISSING_ID,
	newCart,
	post,
} from "../helpers/app";
import { createProduct, resetDb } from "../helpers/db";

beforeEach(resetDb);

const stockOf = async (productId: string) =>
	(await db.product.findUniqueOrThrow({ where: { id: productId } })).stock;
const orderCount = () => db.order.count();

describe("placing an order", () => {
	test("creates an order that explains the purchase and updates stock and cart", async () => {
		const mug = await createProduct({ name: "Mug", price: "19.99", stock: 10 });
		const pen = await createProduct({ name: "Pen", price: "1.50", stock: 10 });
		const cartId = await cartWith([
			{ productId: mug.id, quantity: 3 },
			{ productId: pen.id, quantity: 2 },
		]);

		const result = await checkout(cartId);

		expect(result.status).toBe(201);
		expect(result.headers.get("idempotent-replayed")).toBeNull();
		expect(result.body).toMatchObject({
			cartId,
			subtotal: "62.97",
			discount: "0.00",
			total: "62.97",
			coupon: null,
		});
		expect(result.body.items).toEqual([
			{ productId: mug.id, name: "Mug", quantity: 3, unitPrice: "19.99", lineTotal: "59.97" },
			{ productId: pen.id, name: "Pen", quantity: 2, unitPrice: "1.50", lineTotal: "3.00" },
		]);
		expect(await stockOf(mug.id)).toBe(7);
		expect(await stockOf(pen.id)).toBe(8);

		const cart = await get(`/carts/${cartId}`);
		expect(cart.body.status).toBe("CHECKED_OUT");
	});

	test("GET /orders/:id returns the same order", async () => {
		const product = await createProduct({ price: "5.00", stock: 5 });
		const placed = await checkout(await cartWith([{ productId: product.id, quantity: 2 }]));

		const fetched = await get(`/orders/${placed.body.id}`);

		expect(fetched.status).toBe(200);
		expect(fetched.body).toEqual(placed.body);
	});

	test("an order keeps its names and prices after the product changes", async () => {
		const product = await createProduct({ name: "Mug", price: "10.00", stock: 5 });
		const placed = await checkout(await cartWith([{ productId: product.id, quantity: 2 }]));

		await db.product.update({
			where: { id: product.id },
			data: { name: "Renamed", price: "99.00" },
		});
		const fetched = await get(`/orders/${placed.body.id}`);

		expect(fetched.body.items[0]).toMatchObject({
			name: "Mug",
			unitPrice: "10.00",
			lineTotal: "20.00",
		});
		expect(fetched.body.total).toBe("20.00");
	});

	test("unknown order is 404 ORDER_NOT_FOUND and a malformed id is 400", async () => {
		const missing = await get(`/orders/${MISSING_ID}`);
		expect(missing.status).toBe(404);
		expect(missing.body.code).toBe("ORDER_NOT_FOUND");
		expect((await get("/orders/not-a-uuid")).status).toBe(400);
	});

	test("a closed cart can no longer be changed", async () => {
		const product = await createProduct({ stock: 5 });
		const cartId = await cartWith([{ productId: product.id, quantity: 1 }]);
		await checkout(cartId);

		const result = await post(`/carts/${cartId}/items`, { productId: product.id, quantity: 1 });

		expect(result.status).toBe(409);
		expect(result.body.code).toBe("CART_NOT_OPEN");
	});
});

describe("validation failures", () => {
	test("an empty cart is 422 CART_EMPTY", async () => {
		const result = await checkout(await newCart());
		expect(result.status).toBe(422);
		expect(result.body.code).toBe("CART_EMPTY");
		expect(await orderCount()).toBe(0);
	});

	test("an unknown cart is 404 and a malformed id is 400", async () => {
		const missing = await checkout(MISSING_ID);
		expect(missing.status).toBe(404);
		expect(missing.body.code).toBe("CART_NOT_FOUND");
		expect((await checkout("not-a-uuid")).status).toBe(400);
	});

	test("an invalid body is rejected; an empty body is fine", async () => {
		const product = await createProduct({ stock: 5 });
		const cartId = await cartWith([{ productId: product.id, quantity: 1 }]);
		expect((await checkout(cartId, { acceptPriceChanges: "yes" })).status).toBe(400);
		expect((await checkout(cartId, {})).status).toBe(201);
	});
});

describe("stock failures leave nothing behind", () => {
	test("lists every short line and changes no stock, cart state or orders", async () => {
		const plenty = await createProduct({ name: "Plenty", stock: 50 });
		const scarceA = await createProduct({ name: "ScarceA", stock: 5 });
		const scarceB = await createProduct({ name: "ScarceB", stock: 5 });
		const cartId = await cartWith([
			{ productId: plenty.id, quantity: 2 },
			{ productId: scarceA.id, quantity: 4 },
			{ productId: scarceB.id, quantity: 4 },
		]);
		// Someone else buys most of the scarce items after they were added to this cart.
		await db.product.updateMany({
			where: { id: { in: [scarceA.id, scarceB.id] } },
			data: { stock: 1 },
		});

		const result = await checkout(cartId);

		expect(result.status).toBe(409);
		expect(result.body.code).toBe("INSUFFICIENT_STOCK");
		expect(result.body.details.lines).toHaveLength(2);
		expect(result.body.details.lines).toEqual(
			expect.arrayContaining([
				{ productId: scarceA.id, requested: 4, available: 1 },
				{ productId: scarceB.id, requested: 4, available: 1 },
			]),
		);
		expect(await stockOf(plenty.id)).toBe(50); // the line that was fine was not taken
		expect(await stockOf(scarceA.id)).toBe(1);
		expect((await get(`/carts/${cartId}`)).body.status).toBe("OPEN");
		expect(await orderCount()).toBe(0);
	});
});

describe("price changes", () => {
	test("checkout is refused with the old and new price, and nothing changes", async () => {
		const product = await createProduct({ price: "20.00", stock: 10 });
		const cartId = await cartWith([{ productId: product.id, quantity: 2 }]);
		await db.product.update({ where: { id: product.id }, data: { price: "25.00" } });

		const result = await checkout(cartId);

		expect(result.status).toBe(409);
		expect(result.body.code).toBe("PRICE_CHANGED");
		expect(result.body.details.lines).toEqual([
			{ productId: product.id, oldUnitPrice: "20.00", newUnitPrice: "25.00" },
		]);
		expect(await stockOf(product.id)).toBe(10);
		expect(await orderCount()).toBe(0);
		expect((await get(`/carts/${cartId}`)).body.status).toBe("OPEN");
	});

	test("with acceptPriceChanges the order is charged at the live price", async () => {
		const product = await createProduct({ price: "20.00", stock: 10 });
		const cartId = await cartWith([{ productId: product.id, quantity: 2 }]);
		await db.product.update({ where: { id: product.id }, data: { price: "25.00" } });

		const result = await checkout(cartId, { acceptPriceChanges: true });

		expect(result.status).toBe(201);
		expect(result.body.items[0]).toMatchObject({ unitPrice: "25.00", lineTotal: "50.00" });
		expect(result.body.total).toBe("50.00");
	});

	test("an unchanged price needs no acceptance, a lower price also needs one", async () => {
		const product = await createProduct({ price: "20.00", stock: 10 });
		const cartId = await cartWith([{ productId: product.id, quantity: 1 }]);
		await db.product.update({ where: { id: product.id }, data: { price: "15.00" } });
		expect((await checkout(cartId)).status).toBe(409);
		expect((await checkout(cartId, { acceptPriceChanges: true })).body.total).toBe("15.00");
	});
});

describe("payment failure", () => {
	test("a declined payment rolls back stock and leaves the cart open", async () => {
		const decliningApp = createTestApp({
			payments: new FakePaymentGateway(() => "insufficient funds"),
		});
		const client = createClient(decliningApp);
		const product = await createProduct({ stock: 5 });
		const cartId = await cartWith([{ productId: product.id, quantity: 2 }], client);

		const result = await checkout(cartId, undefined, client);

		expect(result.status).toBe(402);
		expect(result.body.code).toBe("PAYMENT_DECLINED");
		expect(await stockOf(product.id)).toBe(5);
		expect(await orderCount()).toBe(0);
		expect((await client.get(`/carts/${cartId}`)).body.status).toBe("OPEN");

		// The cart is still usable: the same cart succeeds with a working gateway.
		expect((await checkout(cartId)).status).toBe(201);
		expect(await stockOf(product.id)).toBe(3);
	});
});

describe("retries are idempotent", () => {
	test("repeating a successful checkout returns the same order and takes stock once", async () => {
		const product = await createProduct({ price: "10.00", stock: 5 });
		const cartId = await cartWith([{ productId: product.id, quantity: 2 }]);

		const first = await checkout(cartId);
		const retry = await checkout(cartId);
		const retryAgain = await checkout(cartId);

		expect(first.status).toBe(201);
		for (const replay of [retry, retryAgain]) {
			expect(replay.status).toBe(200);
			expect(replay.headers.get("idempotent-replayed")).toBe("true");
			expect(replay.body).toEqual(first.body);
		}
		expect(await stockOf(product.id)).toBe(3);
		expect(await orderCount()).toBe(1);
	});

	test("a retry after the response was lost is a replay even if the product changed since", async () => {
		const product = await createProduct({ price: "10.00", stock: 5 });
		const cartId = await cartWith([{ productId: product.id, quantity: 1 }]);
		const first = await checkout(cartId);

		await db.product.update({ where: { id: product.id }, data: { price: "99.00", stock: 0 } });
		const retry = await checkout(cartId);

		expect(retry.status).toBe(200);
		expect(retry.body).toEqual(first.body);
	});

	test("a failed attempt can be retried and then succeeds", async () => {
		const product = await createProduct({ stock: 1 });
		const cartId = await cartWith([{ productId: product.id, quantity: 1 }]);
		await db.product.update({ where: { id: product.id }, data: { stock: 0 } });
		expect((await checkout(cartId)).status).toBe(409);

		await db.product.update({ where: { id: product.id }, data: { stock: 1 } });
		const retry = await checkout(cartId);

		expect(retry.status).toBe(201);
		expect(await stockOf(product.id)).toBe(0);
	});
});
