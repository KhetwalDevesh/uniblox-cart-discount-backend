import { expect } from "bun:test";
import { db } from "../../src/db";

/** Empties every table. Call in beforeEach; tests run serially against one database. */
export async function resetDb(): Promise<void> {
	await db.$executeRawUnsafe(
		`TRUNCATE TABLE order_items, orders, coupons, cart_items, carts, products RESTART IDENTITY CASCADE`,
	);
}

export function createProduct(overrides: { name?: string; price?: string; stock?: number } = {}) {
	return db.product.create({
		data: { name: "Test Product", price: "10.00", stock: 10, ...overrides },
	});
}

export function createCart() {
	return db.cart.create({ data: {} });
}

/** Inserts a bare order for a cart. Amounts are decimal strings; defaults form a valid order. */
export function createOrder(
	cartId: string,
	overrides: { subtotal?: string; discount?: string; total?: string } = {},
) {
	return db.order.create({
		data: { cartId, subtotal: "100.00", discount: "0.00", total: "100.00", ...overrides },
	});
}

export function createCoupon(milestone: number, code = `CODE-${milestone}`) {
	return db.coupon.create({ data: { code, milestone, discountPercent: 10 } });
}

/**
 * Asserts that a database operation is rejected. Prisma queries are lazy thenables rather than
 * real Promises, so they are awaited inside an async function before `expect(...).rejects`.
 */
export async function expectDbRejection(operation: PromiseLike<unknown>): Promise<void> {
	await expect(
		(async () => {
			await operation;
		})(),
	).rejects.toThrow();
}
