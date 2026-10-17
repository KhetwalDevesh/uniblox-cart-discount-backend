import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import {
	createCart,
	createCoupon,
	createOrder,
	createProduct,
	expectDbRejection,
	resetDb,
} from "../helpers/db";

// These tests bypass the application layer on purpose: they prove the database itself rejects
// states that would violate the invariants, even if application code were wrong.

beforeEach(resetDb);

describe("I1: inventory", () => {
	test("stock cannot go negative", async () => {
		const product = await createProduct({ stock: 1 });
		await expectDbRejection(
			db.$executeRaw`UPDATE products SET stock = stock - 2 WHERE id = ${product.id}::uuid`,
		);
	});

	test("a cart line must have a quantity between 1 and 99", async () => {
		const product = await createProduct();
		const cart = await createCart();
		for (const quantity of [0, -1, 100]) {
			await expectDbRejection(
				db.cartItem.create({
					data: { cartId: cart.id, productId: product.id, quantity, unitPriceAtAdd: "10.00" },
				}),
			);
		}
	});

	test("the same product cannot appear twice in one cart", async () => {
		const product = await createProduct();
		const cart = await createCart();
		const line = { cartId: cart.id, productId: product.id, quantity: 1, unitPriceAtAdd: "10.00" };
		await db.cartItem.create({ data: line });
		await expectDbRejection(db.cartItem.create({ data: line }));
	});
});

describe("I2: one order per cart", () => {
	test("a second order for the same cart is rejected", async () => {
		const cart = await createCart();
		await createOrder(cart.id);
		await expectDbRejection(createOrder(cart.id));
	});
});

describe("I4: one redemption per coupon", () => {
	test("two orders cannot reference the same coupon", async () => {
		const coupon = await createCoupon(1);
		const [cartA, cartB] = await Promise.all([createCart(), createCart()]);
		const withCoupon = {
			subtotal: "100.00",
			discount: "10.00",
			total: "90.00",
			couponId: coupon.id,
			couponCode: coupon.code,
			discountPercent: 10,
		};
		await db.order.create({ data: { cartId: cartA.id, ...withCoupon } });
		await expectDbRejection(db.order.create({ data: { cartId: cartB.id, ...withCoupon } }));
	});
});

describe("I6: one coupon per milestone", () => {
	test("a milestone cannot be generated twice", async () => {
		await createCoupon(1, "A");
		await expectDbRejection(createCoupon(1, "B"));
	});

	test("coupon codes are unique", async () => {
		await createCoupon(1, "SAME");
		await expectDbRejection(createCoupon(2, "SAME"));
	});
});

describe("I8: order amounts", () => {
	test("total must equal subtotal minus discount", async () => {
		const cart = await createCart();
		await expectDbRejection(createOrder(cart.id, { total: "99.00" }));
	});

	test("discount cannot exceed subtotal", async () => {
		const cart = await createCart();
		await expectDbRejection(
			createOrder(cart.id, { subtotal: "10.00", discount: "20.00", total: "-10.00" }),
		);
	});

	test("a discount requires a coupon on the order", async () => {
		const cart = await createCart();
		await expectDbRejection(
			createOrder(cart.id, { subtotal: "100.00", discount: "10.00", total: "90.00" }),
		);
	});
});

describe("I7: orders are self-contained snapshots", () => {
	test("order lines must balance", async () => {
		const cart = await createCart();
		const order = await createOrder(cart.id);
		await expectDbRejection(
			db.orderItem.create({
				data: {
					orderId: order.id,
					productId: crypto.randomUUID(),
					productName: "Mug",
					unitPrice: "10.00",
					quantity: 3,
					lineTotal: "25.00",
				},
			}),
		);
	});

	test("order lines survive deletion of the product", async () => {
		const product = await createProduct({ name: "Mug", price: "10.00" });
		const cart = await createCart();
		const order = await createOrder(cart.id, { subtotal: "30.00", total: "30.00" });
		await db.orderItem.create({
			data: {
				orderId: order.id,
				productId: product.id,
				productName: "Mug",
				unitPrice: "10.00",
				quantity: 3,
				lineTotal: "30.00",
			},
		});

		await db.product.delete({ where: { id: product.id } });

		const items = await db.orderItem.findMany({ where: { orderId: order.id } });
		expect(items).toHaveLength(1);
		expect(items[0]?.productName).toBe("Mug");
	});
});
