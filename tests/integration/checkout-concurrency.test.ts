import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { cartWith, checkout } from "../helpers/app";
import { createProduct, resetDb } from "../helpers/db";

beforeEach(resetDb);

const stockOf = async (productId: string) =>
	(await db.product.findUniqueOrThrow({ where: { id: productId } })).stock;

describe("competing checkouts", () => {
	test("20 shoppers racing for 5 units: exactly 5 succeed, stock ends at 0, never negative", async () => {
		const product = await createProduct({ price: "10.00", stock: 5 });
		const carts = await Promise.all(
			Array.from({ length: 20 }, () => cartWith([{ productId: product.id, quantity: 1 }])),
		);

		const results = await Promise.all(carts.map((cartId) => checkout(cartId)));

		const succeeded = results.filter((r) => r.status === 201);
		const rejected = results.filter((r) => r.status === 409);
		expect(succeeded).toHaveLength(5);
		expect(rejected).toHaveLength(15);
		expect(rejected.every((r) => r.body.code === "INSUFFICIENT_STOCK")).toBe(true);
		expect(await stockOf(product.id)).toBe(0);
		expect(await db.order.count()).toBe(5);
	});

	test("a checkout that loses the race takes nothing, so leftover stock stays correct", async () => {
		// 3 carts want 2 units each of a product with 5 in stock: 2 succeed, the loser takes none.
		const product = await createProduct({ stock: 5 });
		const carts = await Promise.all(
			Array.from({ length: 3 }, () => cartWith([{ productId: product.id, quantity: 2 }])),
		);

		const results = await Promise.all(carts.map((cartId) => checkout(cartId)));

		expect(results.filter((r) => r.status === 201)).toHaveLength(2);
		expect(results.filter((r) => r.status === 409)).toHaveLength(1);
		expect(await stockOf(product.id)).toBe(1);
	});

	test("the same cart checked out 10 times at once yields one order and one stock deduction", async () => {
		const product = await createProduct({ price: "10.00", stock: 5 });
		const cartId = await cartWith([{ productId: product.id, quantity: 2 }]);

		const results = await Promise.all(Array.from({ length: 10 }, () => checkout(cartId)));

		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		expect(results.filter((r) => r.status === 200)).toHaveLength(9);
		const orderIds = new Set(results.map((r) => r.body.id));
		expect(orderIds.size).toBe(1);
		expect(await stockOf(product.id)).toBe(3);
		expect(await db.order.count()).toBe(1);
	});

	test("carts listing the same products in opposite order do not deadlock", async () => {
		const a = await createProduct({ name: "A", stock: 100 });
		const b = await createProduct({ name: "B", stock: 100 });
		const forward = await Promise.all(
			Array.from({ length: 10 }, () =>
				cartWith([
					{ productId: a.id, quantity: 1 },
					{ productId: b.id, quantity: 1 },
				]),
			),
		);
		const backward = await Promise.all(
			Array.from({ length: 10 }, () =>
				cartWith([
					{ productId: b.id, quantity: 1 },
					{ productId: a.id, quantity: 1 },
				]),
			),
		);

		const results = await Promise.all([...forward, ...backward].map((cartId) => checkout(cartId)));

		expect(results.every((r) => r.status === 201)).toBe(true);
		expect(await stockOf(a.id)).toBe(80);
		expect(await stockOf(b.id)).toBe(80);
	});

	test("multi-line carts competing for a scarce item never leave partial deductions", async () => {
		// Each cart wants 1 plentiful + 1 scarce unit. Only 3 scarce units exist.
		const plentiful = await createProduct({ name: "Plentiful", stock: 100 });
		const scarce = await createProduct({ name: "Scarce", stock: 3 });
		const carts = await Promise.all(
			Array.from({ length: 12 }, () =>
				cartWith([
					{ productId: plentiful.id, quantity: 1 },
					{ productId: scarce.id, quantity: 1 },
				]),
			),
		);

		const results = await Promise.all(carts.map((cartId) => checkout(cartId)));

		const succeeded = results.filter((r) => r.status === 201).length;
		expect(succeeded).toBe(3);
		expect(await stockOf(scarce.id)).toBe(0);
		// Losing checkouts rolled back their plentiful deduction.
		expect(await stockOf(plentiful.id)).toBe(100 - succeeded);
		expect(await db.order.count()).toBe(succeeded);
	});

	test("a checkout racing a price change charges a price that matches the stored order", async () => {
		const product = await createProduct({ price: "10.00", stock: 20 });
		const carts = await Promise.all(
			Array.from({ length: 10 }, () => cartWith([{ productId: product.id, quantity: 1 }])),
		);

		const [results] = await Promise.all([
			Promise.all(carts.map((cartId) => checkout(cartId, { acceptPriceChanges: true }))),
			db.product.update({ where: { id: product.id }, data: { price: "12.00" } }),
		]);

		for (const result of results) {
			expect(result.status).toBe(201);
			// Whatever price was used, the order is internally consistent.
			expect(result.body.total).toBe(result.body.items[0].lineTotal);
			expect(["10.00", "12.00"]).toContain(result.body.items[0].unitPrice);
		}
	});
});
