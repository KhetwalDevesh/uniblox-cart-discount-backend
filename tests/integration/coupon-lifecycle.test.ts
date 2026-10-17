import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { FakePaymentGateway } from "../../src/payment/fake-payment-gateway";
import {
	cartWith,
	checkout,
	createClient,
	createTestApp,
	generateCoupon,
	get,
	placeOrders,
	post,
} from "../helpers/app";
import { createProduct, resetDb } from "../helpers/db";

// Test configuration: every 3rd order earns a 10% coupon (see createTestApp).

beforeEach(resetDb);

const couponByCode = (code: string) => db.coupon.findUniqueOrThrow({ where: { code } });
const generate = () => post("/admin/coupons/generate");

/** A cart holding `quantity` units of a fresh product priced `price`. */
async function cartFor(
	price: string,
	quantity = 1,
	stock = 50,
	client?: ReturnType<typeof createClient>,
) {
	const product = await createProduct({ price, stock });
	const cartId = await cartWith([{ productId: product.id, quantity }], client);
	return { product, cartId };
}

describe("generating coupons", () => {
	test("is refused before the first milestone, with a helpful explanation", async () => {
		await placeOrders(2);

		const result = await generate();

		expect(result.status).toBe(409);
		expect(result.body.code).toBe("NO_ELIGIBLE_MILESTONE");
		expect(result.body.details).toEqual({
			placedOrders: 2,
			everyNOrders: 3,
			milestonesReached: 0,
			milestonesGenerated: 0,
			ordersUntilNextMilestone: 1,
		});
		expect(await db.coupon.count()).toBe(0);
	});

	test("creates one coupon when the milestone is reached, and not a second for the same milestone", async () => {
		await placeOrders(3);

		const first = await generate();
		const second = await generate();

		expect(first.status).toBe(201);
		expect(first.body).toMatchObject({
			milestone: 1,
			discountPercent: 10,
			status: "AVAILABLE",
			redeemedAt: null,
			redeemedOrderId: null,
		});
		expect(first.body.code).toMatch(/^SAVE10-[A-Z2-9]{8}$/);
		expect(second.status).toBe(409);
		expect(await db.coupon.count()).toBe(1);
	});

	test("milestones are never lost: 7 orders allow exactly two coupons, in order", async () => {
		await placeOrders(7);

		const first = await generate();
		const second = await generate();
		const third = await generate();

		expect([first.status, second.status, third.status]).toEqual([201, 201, 409]);
		expect([first.body.milestone, second.body.milestone]).toEqual([1, 2]);
		expect(third.body.details.ordersUntilNextMilestone).toBe(2);
	});

	test("lists coupons and filters by status", async () => {
		await placeOrders(6);
		const code = await generateCoupon();
		await generateCoupon();
		const { cartId } = await cartFor("10.00");
		await checkout(cartId, { couponCode: code });

		const all = await get("/admin/coupons");
		const available = await get("/admin/coupons?status=AVAILABLE");
		const redeemed = await get("/admin/coupons?status=REDEEMED");

		expect(all.body.map((c: { milestone: number }) => c.milestone)).toEqual([1, 2]);
		expect(available.body).toHaveLength(1);
		expect(redeemed.body).toHaveLength(1);
		expect(redeemed.body[0].code).toBe(code);
		expect((await get("/admin/coupons?status=BOGUS")).status).toBe(400);
	});

	test("orders that used a coupon still count toward the next milestone", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const { cartId } = await cartFor("10.00");
		await checkout(cartId, { couponCode: code }); // order 4, uses the coupon
		expect((await generate()).status).toBe(409); // 4 orders: still only milestone 1

		await placeOrders(2); // orders 5 and 6

		const second = await generate();
		expect(second.status).toBe(201);
		expect(second.body.milestone).toBe(2);
	});

	test("failed checkouts do not count as placed orders", async () => {
		await placeOrders(2);
		const { cartId, product } = await cartFor("10.00");
		await db.product.update({ where: { id: product.id }, data: { stock: 0 } });
		expect((await checkout(cartId)).status).toBe(409); // out of stock: no order is placed

		const result = await generate();

		expect(result.status).toBe(409);
		expect(result.body.details.placedOrders).toBe(2);
	});
});

describe("redeeming at checkout", () => {
	test("takes the percentage off the subtotal and records the coupon on the order", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const { cartId } = await cartFor("50.00", 2); // subtotal 100.00

		const result = await checkout(cartId, { couponCode: code });

		expect(result.status).toBe(201);
		expect(result.body).toMatchObject({
			subtotal: "100.00",
			discount: "10.00",
			total: "90.00",
			coupon: { code, discountPercent: 10 },
		});
		const coupon = await couponByCode(code);
		expect(coupon.status).toBe("REDEEMED");
		expect(coupon.redeemedAt).not.toBeNull();
		expect(coupon.redeemedOrderId).toBe(result.body.id);

		const fetched = await get(`/orders/${result.body.id}`);
		expect(fetched.body.coupon).toEqual({ code, discountPercent: 10 });
		expect(fetched.body.total).toBe("90.00");
	});

	test("rounds the discount half up", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const { cartId } = await cartFor("1.05"); // 10% of 1.05 = 0.105 -> 0.11

		const result = await checkout(cartId, { couponCode: code });

		expect(result.body).toMatchObject({ subtotal: "1.05", discount: "0.11", total: "0.94" });
	});

	test("the code is case-insensitive", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const { cartId } = await cartFor("10.00");

		const result = await checkout(cartId, { couponCode: `  ${code.toLowerCase()} ` });

		expect(result.status).toBe(201);
		expect(result.body.coupon.code).toBe(code);
	});

	test("a coupon can be redeemed only once", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const first = await cartFor("10.00");
		const second = await cartFor("10.00");
		await checkout(first.cartId, { couponCode: code });

		const result = await checkout(second.cartId, { couponCode: code });

		expect(result.status).toBe(409);
		expect(result.body.code).toBe("COUPON_ALREADY_REDEEMED");
		// the rejected checkout changed nothing
		expect((await db.product.findUniqueOrThrow({ where: { id: second.product.id } })).stock).toBe(
			50,
		);
		expect((await get(`/carts/${second.cartId}`)).body.status).toBe("OPEN");
	});

	test("an unknown code is 422 COUPON_NOT_FOUND and the cart stays open", async () => {
		const { cartId, product } = await cartFor("10.00");

		const result = await checkout(cartId, { couponCode: "NOPE-12345678" });

		expect(result.status).toBe(422);
		expect(result.body.code).toBe("COUPON_NOT_FOUND");
		expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(50);
		expect(await db.order.count()).toBe(0);
	});

	test("an empty or oversized code is rejected as invalid input", async () => {
		const { cartId } = await cartFor("10.00");
		expect((await checkout(cartId, { couponCode: "" })).status).toBe(400);
		expect((await checkout(cartId, { couponCode: "X".repeat(65) })).status).toBe(400);
	});

	test("a 100% coupon makes the total zero, never negative", async () => {
		const client = createClient(createTestApp({}, { couponDiscountPercent: 100 }));
		await placeOrders(3, client);
		const code = await generateCoupon(client);
		const { cartId } = await cartFor("19.99", 3, 50, client);

		const result = await checkout(cartId, { couponCode: code }, client);

		expect(result.status).toBe(201);
		expect(result.body).toMatchObject({ subtotal: "59.97", discount: "59.97", total: "0.00" });
	});
});

describe("a failed checkout never consumes a coupon", () => {
	test("insufficient stock", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const { cartId, product } = await cartFor("10.00", 1);
		await db.product.update({ where: { id: product.id }, data: { stock: 0 } });

		const failed = await checkout(cartId, { couponCode: code });

		expect(failed.status).toBe(409);
		expect((await couponByCode(code)).status).toBe("AVAILABLE");
	});

	test("changed price", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const { cartId, product } = await cartFor("10.00", 1);
		await db.product.update({ where: { id: product.id }, data: { price: "12.00" } });

		expect((await checkout(cartId, { couponCode: code })).status).toBe(409);
		expect((await couponByCode(code)).status).toBe("AVAILABLE");
	});

	test("a declined payment releases the coupon, which then works for another checkout", async () => {
		const decliningClient = createClient(
			createTestApp({ payments: new FakePaymentGateway(() => "card declined") }),
		);
		await placeOrders(3);
		const code = await generateCoupon();
		const declined = await cartFor("10.00", 1, 50, decliningClient);

		const failed = await checkout(declined.cartId, { couponCode: code }, decliningClient);

		expect(failed.status).toBe(402);
		const coupon = await couponByCode(code);
		expect(coupon.status).toBe("AVAILABLE");
		expect(coupon.redeemedAt).toBeNull();
		expect(coupon.redeemedOrderId).toBeNull();

		const retry = await cartFor("10.00");
		expect((await checkout(retry.cartId, { couponCode: code })).status).toBe(201);
	});
});

describe("retrying a checkout that used a coupon", () => {
	test("the same request replays the original order and does not redeem twice", async () => {
		await placeOrders(3);
		const code = await generateCoupon();
		const { cartId } = await cartFor("100.00");
		const first = await checkout(cartId, { couponCode: code });

		const retry = await checkout(cartId, { couponCode: code.toLowerCase() });

		expect(retry.status).toBe(200);
		expect(retry.headers.get("idempotent-replayed")).toBe("true");
		expect(retry.body).toEqual(first.body);
		expect(await db.order.count({ where: { couponCode: code } })).toBe(1);
	});

	test("a different coupon, or none, is refused with CART_ALREADY_CHECKED_OUT", async () => {
		await placeOrders(6);
		const used = await generateCoupon();
		const other = await generateCoupon();
		const { cartId } = await cartFor("100.00");
		const first = await checkout(cartId, { couponCode: used });

		const withOther = await checkout(cartId, { couponCode: other });
		const withNone = await checkout(cartId);

		for (const result of [withOther, withNone]) {
			expect(result.status).toBe(409);
			expect(result.body.code).toBe("CART_ALREADY_CHECKED_OUT");
			expect(result.body.details.orderId).toBe(first.body.id);
		}
		expect((await couponByCode(other)).status).toBe("AVAILABLE"); // not consumed by the refused retry
	});

	test("a retry without coupon after a no-coupon checkout is a plain replay", async () => {
		const { cartId } = await cartFor("10.00");
		const first = await checkout(cartId);
		const retry = await checkout(cartId);
		expect(retry.status).toBe(200);
		expect(retry.body).toEqual(first.body);
	});
});
