import { describe, expect, test } from "bun:test";
import { NoDiscount, PercentageDiscount } from "../../src/domain/discount";

describe("PercentageDiscount", () => {
	test("applies percent to the subtotal", () => {
		expect(new PercentageDiscount(10).compute(20000)).toBe(2000);
	});

	test("is deterministic", () => {
		const discount = new PercentageDiscount(15);
		const results = new Set(Array.from({ length: 50 }, () => discount.compute(1999)));
		expect(results.size).toBe(1);
	});

	test("100% discount makes the total zero, never negative", () => {
		const subtotal = 1999;
		expect(new PercentageDiscount(100).compute(subtotal)).toBe(subtotal);
	});

	test("discount never exceeds the subtotal for any percent", () => {
		for (let percent = 0; percent <= 100; percent++) {
			for (const subtotal of [0, 1, 2, 3, 5, 99, 101, 1999]) {
				const discount = new PercentageDiscount(percent).compute(subtotal);
				expect(discount).toBeGreaterThanOrEqual(0);
				expect(discount).toBeLessThanOrEqual(subtotal);
			}
		}
	});

	test("rejects invalid percent", () => {
		expect(() => new PercentageDiscount(-1)).toThrow(RangeError);
		expect(() => new PercentageDiscount(101)).toThrow(RangeError);
		expect(() => new PercentageDiscount(2.5)).toThrow(RangeError);
	});
});

test("NoDiscount is zero", () => {
	expect(new NoDiscount().compute(12345)).toBe(0);
});
