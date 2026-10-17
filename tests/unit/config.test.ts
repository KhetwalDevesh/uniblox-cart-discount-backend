import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config/env";

const valid = {
	DATABASE_URL: "postgresql://localhost/db",
	COUPON_EVERY_N_ORDERS: "5",
	COUPON_DISCOUNT_PERCENT: "10",
};

describe("loadConfig", () => {
	test("parses a valid environment and defaults the port", () => {
		expect(loadConfig(valid)).toEqual({
			port: 4000,
			databaseUrl: "postgresql://localhost/db",
			couponEveryNOrders: 5,
			couponDiscountPercent: 10,
		});
	});

	test("reports every problem at once", () => {
		try {
			loadConfig({ COUPON_DISCOUNT_PERCENT: "150" });
			throw new Error("expected loadConfig to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			const { problems } = error as ConfigError;
			expect(problems).toHaveLength(3);
			expect(problems.join("\n")).toContain("DATABASE_URL");
			expect(problems.join("\n")).toContain("COUPON_EVERY_N_ORDERS");
			expect(problems.join("\n")).toContain("COUPON_DISCOUNT_PERCENT");
		}
	});

	test("rejects non-integer and out-of-range numbers", () => {
		for (const bad of ["0", "-1", "2.5", "abc"]) {
			expect(() => loadConfig({ ...valid, COUPON_EVERY_N_ORDERS: bad })).toThrow(ConfigError);
		}
		for (const bad of ["0", "101"]) {
			expect(() => loadConfig({ ...valid, COUPON_DISCOUNT_PERCENT: bad })).toThrow(ConfigError);
		}
	});
});
