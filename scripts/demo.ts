/**
 * Executable proof of the concurrency guarantees, against a running server (bun run dev).
 *   bun run demo                      # API_URL defaults to http://localhost:4000
 * Re-run `bun run db:seed` to restore the limited stock between runs.
 */
const BASE = `${process.env.API_URL ?? "http://localhost:4000"}/api`;
const KEYCAPS = "66666666-6666-4666-8666-666666666666"; // seeded with very limited stock
const CABLE = "33333333-3333-4333-8333-333333333333";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in this script
type Result = { status: number; body: any; headers: Headers };

async function call(method: string, path: string, body?: unknown): Promise<Result> {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	return {
		status: response.status,
		body: text ? JSON.parse(text) : undefined,
		headers: response.headers,
	};
}

const tally = (results: Result[]) => {
	const counts = new Map<string, number>();
	for (const r of results) {
		const label = `${r.status}${r.body?.code ? ` ${r.body.code}` : r.headers.get("idempotent-replayed") ? " (replay)" : ""}`;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts].map(([label, n]) => `${n} x ${label}`).join(", ");
};

let failures = 0;
function expect(condition: boolean, message: string) {
	console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
	if (!condition) failures++;
}

async function cartWith(productId: string, quantity: number): Promise<string> {
	const cart = await call("POST", "/carts");
	const added = await call("POST", `/carts/${cart.body.id}/items`, { productId, quantity });
	if (added.status !== 200) throw new Error(`could not fill cart: ${JSON.stringify(added.body)}`);
	return cart.body.id;
}

const health = await fetch(`${BASE.replace("/api", "")}/health`).catch(() => null);
if (!health?.ok) {
	console.error(`API is not reachable at ${BASE}. Start it with: bun run dev`);
	process.exit(1);
}

// 1. Oversell: more shoppers than units, all at the same instant
const stock = (await call("GET", `/products/${KEYCAPS}`)).body.stock as number;
const shoppers = stock + 6;
console.log(`\n1. ${shoppers} shoppers race for ${stock} limited keycap sets`);
const racers = await Promise.all(Array.from({ length: shoppers }, () => cartWith(KEYCAPS, 1)));
const raceResults = await Promise.all(
	racers.map((id) => call("POST", `/carts/${id}/checkout`, {})),
);
console.log(`   outcomes: ${tally(raceResults)}`);
const stockAfter = (await call("GET", `/products/${KEYCAPS}`)).body.stock as number;
expect(
	raceResults.filter((r) => r.status === 201).length === stock,
	`exactly ${stock} orders placed`,
);
expect(stockAfter === 0, `stock ends at 0 (was ${stock}), never negative`);

// 2. Retry storm: the same checkout sent many times at once
console.log("\n2. One cart checked out 8 times at once (a client retrying aggressively)");
const retryCart = await cartWith(CABLE, 2);
const cableBefore = (await call("GET", `/products/${CABLE}`)).body.stock as number;
const storm = await Promise.all(
	Array.from({ length: 8 }, () => call("POST", `/carts/${retryCart}/checkout`, {})),
);
console.log(`   outcomes: ${tally(storm)}`);
const cableAfter = (await call("GET", `/products/${CABLE}`)).body.stock as number;
expect(storm.filter((r) => r.status === 201).length === 1, "exactly one order created");
expect(new Set(storm.map((r) => r.body.id)).size === 1, "every response carries the same order id");
expect(cableBefore - cableAfter === 2, "stock deducted once (2 units), not 8 times");

// 3. Coupon: several carts race for one coupon
console.log("\n3. Several carts race for one coupon");
const coupon = await call("POST", "/admin/coupons/generate");
if (coupon.status !== 201) {
	console.log(`   skipped: ${coupon.body.code} (${coupon.body.message})`);
} else {
	const code = coupon.body.code as string;
	const couponCarts = await Promise.all(Array.from({ length: 6 }, () => cartWith(CABLE, 1)));
	const couponResults = await Promise.all(
		couponCarts.map((id) => call("POST", `/carts/${id}/checkout`, { couponCode: code })),
	);
	console.log(`   coupon ${code}; outcomes: ${tally(couponResults)}`);
	expect(
		couponResults.filter((r) => r.status === 201).length === 1,
		"exactly one checkout redeemed the coupon",
	);
	expect(
		couponResults.filter((r) => r.status === 409 && r.body.code === "COUPON_ALREADY_REDEEMED")
			.length === 5,
		"the others were refused with COUPON_ALREADY_REDEEMED",
	);
}

// 4. The report agrees with the orders and coupons the API returns
console.log("\n4. Report reconciles with the orders and coupons endpoints");
const report = (await call("GET", "/admin/report")).body;
const orders = (await call("GET", "/admin/orders")).body as {
	subtotal: string;
	discount: string;
	total: string;
}[];
const cents = (values: string[]) => values.reduce((sum, v) => sum + Math.round(Number(v) * 100), 0);
expect(orders.length === report.ordersCount, `order count matches (${report.ordersCount})`);
expect(
	cents(orders.map((o) => o.subtotal)) === Math.round(Number(report.revenue.gross) * 100),
	`gross ${report.revenue.gross}`,
);
expect(
	cents(orders.map((o) => o.discount)) === Math.round(Number(report.revenue.discounts) * 100),
	`discounts ${report.revenue.discounts}`,
);
expect(
	cents(orders.map((o) => o.total)) === Math.round(Number(report.revenue.net) * 100),
	`net ${report.revenue.net}`,
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
