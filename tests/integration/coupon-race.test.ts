import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { FakePaymentGateway } from "../../src/payment/fake-payment-gateway";
import {
	cartWith,
	checkout,
	createClient,
	createTestApp,
	generateCoupon,
	placeOrders,
	post,
} from "../helpers/app";
import { createProduct, resetDb } from "../helpers/db";

beforeEach(resetDb);

describe("two checkouts competing for one coupon", () => {
	test("exactly one wins; the losers fail cleanly and take no stock", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const product = await createProduct({ price: "10.00", stock: 100 });
		const carts = await Promise.all(
			Array.from({ length: 10 }, () => cartWith([{ productId: product.id, quantity: 1 }])),
		);

		const results = await Promise.all(
			carts.map((cartId) => checkout(cartId, { couponCode: code })),
		);

		const winners = results.filter((r) => r.status === 201);
		const losers = results.filter((r) => r.status === 409);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(9);
		expect(losers.every((r) => r.body.code === "COUPON_ALREADY_REDEEMED")).toBe(true);

		const coupon = await db.coupon.findUniqueOrThrow({ where: { code } });
		expect(coupon.status).toBe("REDEEMED");
		expect(coupon.redeemedOrderId).toBe(winners[0]?.body.id);
		// only the winner took stock; the losers rolled back
		expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(99);
		expect(await db.order.count({ where: { couponCode: code } })).toBe(1);
	});

	test("a coupon held by a checkout that later fails is not lost to the competitor", async () => {
		// Cart A claims the coupon and then has its payment declined; cart B uses the same coupon.
		// Whatever the interleaving, B must end up with the coupon and it must be redeemed once.
		const product = await createProduct({ price: "10.00", stock: 10 });
		await placeOrders(3);
		const code = await generateCoupon();
		const cartA = await cartWith([{ productId: product.id, quantity: 1 }]);
		const cartB = await cartWith([{ productId: product.id, quantity: 1 }]);
		const flakyClient = createClient(
			createTestApp({
				payments: new FakePaymentGateway((request) =>
					request.idempotencyKey === cartA ? "declined" : null,
				),
			}),
		);

		const [a, b] = await Promise.all([
			checkout(cartA, { couponCode: code }, flakyClient),
			checkout(cartB, { couponCode: code }, flakyClient),
		]);

		expect(b.status).toBe(201);
		expect([402, 409]).toContain(a.status); // declined, or lost the coupon to B first
		const coupon = await db.coupon.findUniqueOrThrow({ where: { code } });
		expect(coupon.status).toBe("REDEEMED");
		expect(coupon.redeemedOrderId).toBe(b.body.id);
		expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(9);
	});
});

describe("concurrent coupon generation", () => {
	test("10 simultaneous requests for one milestone create exactly one coupon", async () => {
		await placeOrders(3);

		const results = await Promise.all(
			Array.from({ length: 10 }, () => post("/admin/coupons/generate")),
		);

		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		const rejected = results.filter((r) => r.status === 409);
		expect(rejected).toHaveLength(9);
		expect(rejected.every((r) => r.body.code === "NO_ELIGIBLE_MILESTONE")).toBe(true);
		expect(await db.coupon.count()).toBe(1);
	});

	test("with two milestones reached, 10 simultaneous requests create exactly milestones 1 and 2", async () => {
		await placeOrders(6);

		const results = await Promise.all(
			Array.from({ length: 10 }, () => post("/admin/coupons/generate")),
		);

		const created = results.filter((r) => r.status === 201);
		expect(created).toHaveLength(2);
		expect(created.map((r) => r.body.milestone).sort()).toEqual([1, 2]);
		expect(await db.coupon.count()).toBe(2);
	});
});
