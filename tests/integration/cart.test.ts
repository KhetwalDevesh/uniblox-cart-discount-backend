import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { del, get, MISSING_ID, newCart, patch, post } from "../helpers/app";
import { createProduct, resetDb } from "../helpers/db";

beforeEach(resetDb);

const addItem = (cartId: string, productId: string, quantity: number) =>
	post(`/carts/${cartId}/items`, { productId, quantity });

async function lineCount(cartId: string): Promise<number> {
	return db.cartItem.count({ where: { cartId } });
}

describe("create and view", () => {
	test("a new cart is open and empty with zero totals", async () => {
		const result = await post("/carts");
		expect(result.status).toBe(201);
		expect(result.body).toMatchObject({
			status: "OPEN",
			items: [],
			totalQuantity: 0,
			subtotal: "0.00",
		});
	});

	test("viewing returns lines, prices and exact totals", async () => {
		const mug = await createProduct({ name: "Mug", price: "19.99", stock: 10 });
		const pen = await createProduct({ name: "Pen", price: "1.50", stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, mug.id, 3);
		await addItem(cartId, pen.id, 2);

		const result = await get(`/carts/${cartId}`);

		expect(result.status).toBe(200);
		expect(result.body.items).toHaveLength(2);
		expect(result.body.items[0]).toMatchObject({
			name: "Mug",
			quantity: 3,
			unitPrice: "19.99",
			lineTotal: "59.97", // 19.99 x 3, exact
			priceChanged: false,
		});
		expect(result.body.totalQuantity).toBe(5);
		expect(result.body.subtotal).toBe("62.97");
	});

	test("an unknown cart is 404 CART_NOT_FOUND on every operation", async () => {
		const product = await createProduct();
		const results = [
			await get(`/carts/${MISSING_ID}`),
			await addItem(MISSING_ID, product.id, 1),
			await patch(`/carts/${MISSING_ID}/items/${product.id}`, { quantity: 1 }),
			await del(`/carts/${MISSING_ID}/items/${product.id}`),
		];
		for (const result of results) {
			expect(result.status).toBe(404);
			expect(result.body.code).toBe("CART_NOT_FOUND");
		}
	});
});

describe("adding items", () => {
	test("adding the same product again increments the quantity", async () => {
		const product = await createProduct({ stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 2);
		const result = await addItem(cartId, product.id, 3);
		expect(result.status).toBe(200);
		expect(result.body.items).toHaveLength(1);
		expect(result.body.items[0].quantity).toBe(5);
	});

	test("an unknown product is 404 and never enters the cart", async () => {
		const cartId = await newCart();
		const result = await addItem(cartId, MISSING_ID, 1);
		expect(result.status).toBe(404);
		expect(result.body.code).toBe("PRODUCT_NOT_FOUND");
		expect(await lineCount(cartId)).toBe(0);
	});

	test("invalid quantities are rejected with 400 and never enter the cart", async () => {
		const product = await createProduct({ stock: 500 });
		const cartId = await newCart();
		for (const quantity of [0, -1, 1.5, 100, "2", null]) {
			const result = await addItem(cartId, product.id, quantity as number);
			expect(result.status).toBe(400);
			expect(result.body.code).toBe("VALIDATION_ERROR");
		}
		expect((await post(`/carts/${cartId}/items`, { productId: "nope", quantity: 1 })).status).toBe(
			400,
		);
		expect((await post(`/carts/${cartId}/items`, { quantity: 1 })).status).toBe(400);
		expect(await lineCount(cartId)).toBe(0);
	});

	test("a line cannot grow past 99 units even through repeated adds", async () => {
		const product = await createProduct({ stock: 500 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 60);
		const result = await addItem(cartId, product.id, 60);
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("VALIDATION_ERROR");
		expect((await get(`/carts/${cartId}`)).body.items[0].quantity).toBe(60);
	});

	test("quantity above stock is 409 INSUFFICIENT_STOCK with details", async () => {
		const product = await createProduct({ stock: 3 });
		const cartId = await newCart();
		const result = await addItem(cartId, product.id, 4);
		expect(result.status).toBe(409);
		expect(result.body.code).toBe("INSUFFICIENT_STOCK");
		expect(result.body.details.lines).toEqual([
			{ productId: product.id, requested: 4, available: 3 },
		]);
		expect(await lineCount(cartId)).toBe(0);
	});

	test("incremental adds are also checked against stock", async () => {
		const product = await createProduct({ stock: 3 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 2);
		const result = await addItem(cartId, product.id, 2);
		expect(result.status).toBe(409);
		expect(result.body.details.lines[0]).toMatchObject({ requested: 4, available: 3 });
		expect((await get(`/carts/${cartId}`)).body.items[0].quantity).toBe(2);
	});
});

describe("updating and removing", () => {
	test("PATCH sets an absolute quantity and is idempotent", async () => {
		const product = await createProduct({ stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 2);

		const first = await patch(`/carts/${cartId}/items/${product.id}`, { quantity: 5 });
		const second = await patch(`/carts/${cartId}/items/${product.id}`, { quantity: 5 });

		expect(first.status).toBe(200);
		expect(second.body.items[0].quantity).toBe(5);
	});

	test("PATCH on a product not in the cart is 404 ITEM_NOT_IN_CART", async () => {
		const product = await createProduct();
		const cartId = await newCart();
		const result = await patch(`/carts/${cartId}/items/${product.id}`, { quantity: 1 });
		expect(result.status).toBe(404);
		expect(result.body.code).toBe("ITEM_NOT_IN_CART");
	});

	test("PATCH above stock is 409 and leaves the line unchanged", async () => {
		const product = await createProduct({ stock: 3 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 1);
		const result = await patch(`/carts/${cartId}/items/${product.id}`, { quantity: 9 });
		expect(result.status).toBe(409);
		expect((await get(`/carts/${cartId}`)).body.items[0].quantity).toBe(1);
	});

	test("PATCH rejects invalid quantities", async () => {
		const product = await createProduct({ stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 1);
		for (const quantity of [0, -3, 2.5, 100]) {
			const result = await patch(`/carts/${cartId}/items/${product.id}`, { quantity });
			expect(result.status).toBe(400);
		}
	});

	test("DELETE removes the line; removing again is 404", async () => {
		const product = await createProduct({ stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 1);

		const removed = await del(`/carts/${cartId}/items/${product.id}`);
		expect(removed.status).toBe(200);
		expect(removed.body.items).toEqual([]);
		expect(removed.body.subtotal).toBe("0.00");

		const again = await del(`/carts/${cartId}/items/${product.id}`);
		expect(again.status).toBe(404);
		expect(again.body.code).toBe("ITEM_NOT_IN_CART");
	});
});

describe("price changes after adding", () => {
	test("the view shows the live price and flags the change", async () => {
		const product = await createProduct({ price: "20.00", stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 2);

		await db.product.update({ where: { id: product.id }, data: { price: "25.00" } });
		const result = await get(`/carts/${cartId}`);

		expect(result.body.items[0]).toMatchObject({
			unitPrice: "25.00",
			unitPriceAtAdd: "20.00",
			priceChanged: true,
			lineTotal: "50.00",
		});
		expect(result.body.subtotal).toBe("50.00");
	});

	test("changing a quantity does not silently accept a new price", async () => {
		const product = await createProduct({ price: "20.00", stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 1);
		await db.product.update({ where: { id: product.id }, data: { price: "25.00" } });

		await addItem(cartId, product.id, 1);
		const patched = await patch(`/carts/${cartId}/items/${product.id}`, { quantity: 3 });

		expect(patched.body.items[0]).toMatchObject({ unitPriceAtAdd: "20.00", priceChanged: true });
	});

	test("removing and re-adding records the current price", async () => {
		const product = await createProduct({ price: "20.00", stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 1);
		await db.product.update({ where: { id: product.id }, data: { price: "25.00" } });

		await del(`/carts/${cartId}/items/${product.id}`);
		const result = await addItem(cartId, product.id, 1);

		expect(result.body.items[0]).toMatchObject({ unitPriceAtAdd: "25.00", priceChanged: false });
	});
});

describe("closed carts", () => {
	test("a checked-out cart rejects changes with 409 CART_NOT_OPEN but can still be viewed", async () => {
		const product = await createProduct({ stock: 10 });
		const cartId = await newCart();
		await addItem(cartId, product.id, 1);
		await db.cart.update({
			where: { id: cartId },
			data: { status: "CHECKED_OUT", checkedOutAt: new Date() },
		});

		const results = [
			await addItem(cartId, product.id, 1),
			await patch(`/carts/${cartId}/items/${product.id}`, { quantity: 2 }),
			await del(`/carts/${cartId}/items/${product.id}`),
		];
		for (const result of results) {
			expect(result.status).toBe(409);
			expect(result.body.code).toBe("CART_NOT_OPEN");
		}

		const view = await get(`/carts/${cartId}`);
		expect(view.status).toBe(200);
		expect(view.body.status).toBe("CHECKED_OUT");
		expect(view.body.items[0].quantity).toBe(1);
	});
});

describe("concurrent edits to one cart", () => {
	test("20 parallel adds of the same product lose no updates", async () => {
		const product = await createProduct({ stock: 100 });
		const cartId = await newCart();

		const results = await Promise.all(
			Array.from({ length: 20 }, () => addItem(cartId, product.id, 1)),
		);

		expect(results.every((r) => r.status === 200)).toBe(true);
		const view = await get(`/carts/${cartId}`);
		expect(view.body.items).toHaveLength(1);
		expect(view.body.items[0].quantity).toBe(20);
	});

	test("parallel adds that would exceed stock never overshoot it", async () => {
		const product = await createProduct({ stock: 5 });
		const cartId = await newCart();

		const results = await Promise.all(
			Array.from({ length: 12 }, () => addItem(cartId, product.id, 1)),
		);

		expect(results.filter((r) => r.status === 200)).toHaveLength(5);
		expect(results.filter((r) => r.status === 409)).toHaveLength(7);
		expect((await get(`/carts/${cartId}`)).body.items[0].quantity).toBe(5);
	});

	test("parallel adds of different products all land in the cart", async () => {
		const products = await Promise.all(
			Array.from({ length: 8 }, (_, i) => createProduct({ name: `P${i}`, stock: 5 })),
		);
		const cartId = await newCart();

		const results = await Promise.all(products.map((p) => addItem(cartId, p.id, 1)));

		expect(results.every((r) => r.status === 200)).toBe(true);
		expect((await get(`/carts/${cartId}`)).body.items).toHaveLength(8);
	});
});
