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
} from "../helpers/app";
import { createProduct, resetDb } from "../helpers/db";

beforeEach(resetDb);

const report = () => get("/admin/report");

/** Cents-exact decimal-string sum, for checking the report against the orders API. */
const sumDecimals = (values: string[]) =>
	(values.reduce((sum, value) => sum + Math.round(Number(value) * 100), 0) / 100).toFixed(2);

describe("an empty store", () => {
	test("reports zeros", async () => {
		const result = await report();
		expect(result.status).toBe(200);
		expect(result.body).toEqual({
			ordersCount: 0,
			purchasedQuantityByProduct: [],
			revenue: { gross: "0.00", discounts: "0.00", net: "0.00" },
			coupons: { generated: 0, available: 0, redeemed: 0 },
		});
	});
});

describe("after trading", () => {
	/**
	 * Mug 19.99, Pen 1.50.
	 *   order 1: 3 mugs + 2 pens        = 62.97
	 *   order 2: 1 mug                  = 19.99
	 *   order 3: 4 pens                 =  6.00   -> 3 orders, a coupon becomes available
	 *   order 4: 2 mugs with the coupon = 39.98 - 4.00 (10% of 39.98 = 3.998 -> 4.00) = 35.98
	 */
	async function trade() {
		const mug = await createProduct({ name: "Mug", price: "19.99", stock: 100 });
		const pen = await createProduct({ name: "Pen", price: "1.50", stock: 100 });
		await checkout(
			await cartWith([
				{ productId: mug.id, quantity: 3 },
				{ productId: pen.id, quantity: 2 },
			]),
		);
		await checkout(await cartWith([{ productId: mug.id, quantity: 1 }]));
		await checkout(await cartWith([{ productId: pen.id, quantity: 4 }]));
		const code = await generateCoupon();
		const couponOrder = await checkout(await cartWith([{ productId: mug.id, quantity: 2 }]), {
			couponCode: code,
		});
		return { mug, pen, code, couponOrder };
	}

	test("summarises quantities, revenue, discounts and coupons exactly", async () => {
		const { mug, pen } = await trade();

		const result = await report();

		expect(result.status).toBe(200);
		expect(result.body.ordersCount).toBe(4);
		expect(result.body.purchasedQuantityByProduct).toEqual([
			{ productId: mug.id, name: "Mug", quantity: 6 },
			{ productId: pen.id, name: "Pen", quantity: 6 },
		]);
		expect(result.body.revenue).toEqual({
			gross: "128.94", // 62.97 + 19.99 + 6.00 + 39.98
			discounts: "4.00",
			net: "124.94",
		});
		expect(result.body.coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });
	});

	test("reconciles with the orders and coupons the API returns", async () => {
		await trade();

		const summary = (await report()).body;
		const orders = (await get("/admin/orders")).body;
		const coupons = (await get("/admin/coupons")).body;

		expect(orders).toHaveLength(summary.ordersCount);
		expect(sumDecimals(orders.map((o: { subtotal: string }) => o.subtotal))).toBe(
			summary.revenue.gross,
		);
		expect(sumDecimals(orders.map((o: { discount: string }) => o.discount))).toBe(
			summary.revenue.discounts,
		);
		expect(sumDecimals(orders.map((o: { total: string }) => o.total))).toBe(summary.revenue.net);

		const unitsByProduct = new Map<string, number>();
		for (const order of orders) {
			for (const item of order.items) {
				unitsByProduct.set(
					item.productId,
					(unitsByProduct.get(item.productId) ?? 0) + item.quantity,
				);
			}
		}
		for (const row of summary.purchasedQuantityByProduct) {
			expect(unitsByProduct.get(row.productId)).toBe(row.quantity);
		}

		expect(coupons).toHaveLength(summary.coupons.generated);
		expect(coupons.filter((c: { status: string }) => c.status === "AVAILABLE")).toHaveLength(
			summary.coupons.available,
		);
		expect(coupons.filter((c: { status: string }) => c.status === "REDEEMED")).toHaveLength(
			summary.coupons.redeemed,
		);
		// every discount granted is explained by a redeemed coupon
		expect(orders.filter((o: { coupon: unknown }) => o.coupon !== null)).toHaveLength(
			summary.coupons.redeemed,
		);
	});

	test("an available coupon is counted as available, not redeemed", async () => {
		await placeOrders(3);
		await generateCoupon();

		expect((await report()).body.coupons).toEqual({ generated: 1, available: 1, redeemed: 0 });
	});
});

describe("what does not count", () => {
	test("failed checkouts (stock, payment) are not in the report", async () => {
		const decliningClient = createClient(
			createTestApp({ payments: new FakePaymentGateway(() => "declined") }),
		);
		const product = await createProduct({ price: "10.00", stock: 5 });
		const outOfStock = await cartWith([{ productId: product.id, quantity: 3 }]);
		await db.product.update({ where: { id: product.id }, data: { stock: 1 } });
		expect((await checkout(outOfStock)).status).toBe(409);
		const declined = await cartWith([{ productId: product.id, quantity: 1 }], decliningClient);
		expect((await checkout(declined, undefined, decliningClient)).status).toBe(402);

		const result = await report();

		expect(result.body.ordersCount).toBe(0);
		expect(result.body.purchasedQuantityByProduct).toEqual([]);
		expect(result.body.revenue.gross).toBe("0.00");
	});

	test("history survives product edits: quantities merge under the latest name", async () => {
		const product = await createProduct({ name: "Old Name", price: "10.00", stock: 10 });
		await checkout(await cartWith([{ productId: product.id, quantity: 2 }]));
		await db.product.update({
			where: { id: product.id },
			data: { name: "New Name", price: "12.00" },
		});
		await checkout(await cartWith([{ productId: product.id, quantity: 3 }]));

		const result = await report();

		expect(result.body.purchasedQuantityByProduct).toEqual([
			{ productId: product.id, name: "New Name", quantity: 5 },
		]);
		expect(result.body.revenue.gross).toBe("56.00"); // 2 x 10.00 + 3 x 12.00
	});
});

describe("reports never change state", () => {
	test("repeated requests return identical output and leave every table untouched", async () => {
		const product = await createProduct({ price: "10.00", stock: 20 });
		await checkout(await cartWith([{ productId: product.id, quantity: 2 }]));
		await placeOrders(3);
		await generateCoupon();

		const snapshotState = async () => ({
			products: await db.product.findMany({ orderBy: { id: "asc" } }),
			carts: await db.cart.findMany({ orderBy: { id: "asc" } }),
			orders: await db.order.findMany({ orderBy: { id: "asc" } }),
			orderItems: await db.orderItem.findMany({ orderBy: { id: "asc" } }),
			coupons: await db.coupon.findMany({ orderBy: { id: "asc" } }),
		});
		const before = await snapshotState();

		const responses = [];
		for (let i = 0; i < 5; i++) responses.push((await report()).body);

		expect(await snapshotState()).toEqual(before);
		for (const response of responses.slice(1)) expect(response).toEqual(responses[0]);
	});
});

describe("consistency while orders are being placed", () => {
	test("every report taken during a burst of checkouts is internally consistent", async () => {
		// 40 orders of exactly 1 unit at 10.00. In any consistent snapshot:
		//   gross == orders * 10.00, units sold == orders, net == gross.
		// A report stitched together from different moments would break these.
		const product = await createProduct({ price: "10.00", stock: 100 });
		const carts = await Promise.all(
			Array.from({ length: 40 }, () => cartWith([{ productId: product.id, quantity: 1 }])),
		);

		let running = true;
		const snapshots: Awaited<ReturnType<typeof report>>[] = [];
		const poller = (async () => {
			while (running) snapshots.push(await report());
		})();
		await Promise.all(carts.map((cartId) => checkout(cartId)));
		running = false;
		await poller;
		snapshots.push(await report());

		expect(snapshots.length).toBeGreaterThan(3);
		for (const snapshot of snapshots) {
			expect(snapshot.status).toBe(200);
			const { ordersCount, purchasedQuantityByProduct, revenue } = snapshot.body;
			const units = purchasedQuantityByProduct.reduce(
				(sum: number, row: { quantity: number }) => sum + row.quantity,
				0,
			);
			expect(units).toBe(ordersCount);
			expect(revenue.gross).toBe((ordersCount * 10).toFixed(2));
			expect(revenue.net).toBe(revenue.gross);
		}
		expect(snapshots.at(-1)?.body.ordersCount).toBe(40);
	});
});
