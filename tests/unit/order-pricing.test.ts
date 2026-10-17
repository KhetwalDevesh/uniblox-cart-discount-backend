import { describe, expect, test } from "bun:test";
import { PercentageDiscount } from "../../src/domain/discount";
import { formatMoney, parseMoney } from "../../src/domain/money";
import {
	calculateLineTotal,
	calculateSubtotal,
	detectPriceChanges,
	priceOrder,
} from "../../src/domain/order-pricing";

const lines = [
	{ productId: "a", name: "Mug", unitPrice: 1999, quantity: 3 },
	{ productId: "b", name: "Pen", unitPrice: 150, quantity: 2 },
];

describe("calculateLineTotal / calculateSubtotal", () => {
	test("19.99 x 3 is exactly 59.97", () => {
		expect(formatMoney(calculateLineTotal(parseMoney("19.99"), 3))).toBe("59.97");
	});

	test("summing many small line totals does not drift", () => {
		const subtotal = calculateSubtotal(Array.from({ length: 1000 }, () => parseMoney("0.10")));
		expect(formatMoney(subtotal)).toBe("100.00");
	});

	test("an empty list has a zero subtotal", () => {
		expect(calculateSubtotal([])).toBe(0);
	});

	test("calculateLineTotal rejects invalid quantity", () => {
		expect(() => calculateLineTotal(100, 1.5)).toThrow(RangeError);
		expect(() => calculateLineTotal(100, -1)).toThrow(RangeError);
	});

	test("calculateLineTotal rejects results beyond the safe integer range", () => {
		expect(() => calculateLineTotal(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
	});
});

describe("priceOrder", () => {
	test("computes line totals, subtotal and total without a discount", () => {
		const order = priceOrder(lines, { compute: () => 0 });
		expect(order.lines.map((l) => l.lineTotal)).toEqual([5997, 300]);
		expect(order.subtotal).toBe(6297);
		expect(order.discount).toBe(0);
		expect(order.total).toBe(6297);
	});

	test("applies a percentage discount to the whole subtotal", () => {
		const order = priceOrder(lines, new PercentageDiscount(10));
		expect(order.subtotal).toBe(6297);
		expect(order.discount).toBe(630); // 629.7 -> 630 half up
		expect(order.total).toBe(5667);
		expect(order.total).toBe(order.subtotal - order.discount);
	});

	test("total is never negative at 100%", () => {
		const order = priceOrder(lines, new PercentageDiscount(100));
		expect(order.total).toBe(0);
	});

	test("empty lines price to zero", () => {
		const order = priceOrder([], new PercentageDiscount(10));
		expect(order).toEqual({ lines: [], subtotal: 0, discount: 0, total: 0 });
	});
});

describe("detectPriceChanges", () => {
	test("returns only lines whose live price differs", () => {
		const changes = detectPriceChanges([
			{ productId: "a", unitPriceAtAdd: 1999, livePrice: 2499 },
			{ productId: "b", unitPriceAtAdd: 150, livePrice: 150 },
		]);
		expect(changes).toEqual([{ productId: "a", oldUnitPrice: 1999, newUnitPrice: 2499 }]);
	});

	test("returns nothing when no price changed", () => {
		expect(detectPriceChanges([{ productId: "a", unitPriceAtAdd: 100, livePrice: 100 }])).toEqual(
			[],
		);
	});
});
