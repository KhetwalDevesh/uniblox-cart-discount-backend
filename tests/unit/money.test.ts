import { describe, expect, test } from "bun:test";
import { addMoney, clampMoney, formatMoney, parseMoney, percentOf } from "../../src/domain/money";

describe("parse / format", () => {
	test("round-trips decimal strings exactly", () => {
		for (const value of ["0.00", "0.01", "0.99", "1.00", "19.99", "1234567.89"]) {
			expect(formatMoney(parseMoney(value))).toBe(value);
		}
	});

	test("accepts missing or short fractions", () => {
		expect(parseMoney("5")).toBe(500);
		expect(parseMoney("5.5")).toBe(550);
	});

	test("rejects malformed input", () => {
		for (const value of ["", "-1.00", "1.234", "abc", "1,00", ".5", "1e3", " 1.00"]) {
			expect(() => parseMoney(value)).toThrow(RangeError);
		}
	});

	test("rejects values beyond the safe integer range", () => {
		expect(() => parseMoney("99999999999999999.99")).toThrow(RangeError);
	});
});

describe("float traps stay exact", () => {
	test("0.10 + 0.20 is exactly 0.30", () => {
		expect(0.1 + 0.2).not.toBe(0.3); // the JS float problem we avoid
		expect(formatMoney(addMoney(parseMoney("0.10"), parseMoney("0.20")))).toBe("0.30");
	});
});

describe("percentOf (half up)", () => {
	test("exact results", () => {
		expect(percentOf(10000, 10)).toBe(1000);
		expect(percentOf(0, 10)).toBe(0);
		expect(percentOf(12345, 0)).toBe(0);
		expect(percentOf(12345, 100)).toBe(12345);
	});

	test("rounds half up at the boundary", () => {
		expect(percentOf(105, 10)).toBe(11); // 10.5 -> 11
		expect(percentOf(104, 10)).toBe(10); // 10.4 -> 10
		expect(percentOf(5, 10)).toBe(1); // 0.5 -> 1
		expect(percentOf(4, 10)).toBe(0); // 0.4 -> 0
	});

	test("does not lose precision for very large amounts", () => {
		const amount = Number.MAX_SAFE_INTEGER;
		expect(percentOf(amount, 100)).toBe(amount);
		expect(percentOf(amount, 50)).toBe(Math.round(amount / 2));
	});

	test("rejects invalid percent and negative amount", () => {
		expect(() => percentOf(100, -1)).toThrow(RangeError);
		expect(() => percentOf(100, 101)).toThrow(RangeError);
		expect(() => percentOf(100, 10.5)).toThrow(RangeError);
		expect(() => percentOf(-1, 10)).toThrow(RangeError);
	});
});

test("clampMoney bounds a value", () => {
	expect(clampMoney(-5, 0, 10)).toBe(0);
	expect(clampMoney(15, 0, 10)).toBe(10);
	expect(clampMoney(7, 0, 10)).toBe(7);
});
