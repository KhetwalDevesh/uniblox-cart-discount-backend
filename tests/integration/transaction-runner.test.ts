import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { PrismaTransactionRunner } from "../../src/db/transaction";
import { createProduct, resetDb } from "../helpers/db";

const runner = new PrismaTransactionRunner(db);

beforeEach(resetDb);

describe("PrismaTransactionRunner", () => {
	test("commits all writes when the work succeeds", async () => {
		await runner.run(async (tx) => {
			await tx.product.create({ data: { name: "A", price: "1.00", stock: 1 } });
			await tx.product.create({ data: { name: "B", price: "2.00", stock: 1 } });
		});
		expect(await db.product.count()).toBe(2);
	});

	test("rolls back every write when the work throws", async () => {
		await expect(
			runner.run(async (tx) => {
				await tx.product.create({ data: { name: "A", price: "1.00", stock: 1 } });
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await db.product.count()).toBe(0);
	});

	test("a failing constraint rolls back earlier statements in the same transaction", async () => {
		const product = await createProduct({ stock: 5 });
		await expect(
			runner.run(async (tx) => {
				await tx.$executeRaw`UPDATE products SET stock = stock - 1 WHERE id = ${product.id}::uuid`;
				await tx.$executeRaw`UPDATE products SET stock = stock - 100 WHERE id = ${product.id}::uuid`;
			}),
		).rejects.toThrow();
		const after = await db.product.findUniqueOrThrow({ where: { id: product.id } });
		expect(after.stock).toBe(5);
	});

	test("read-only transactions reject writes", async () => {
		await expect(
			runner.run(
				async (tx) => {
					await tx.product.create({ data: { name: "A", price: "1.00", stock: 1 } });
				},
				{ readOnly: true },
			),
		).rejects.toThrow();
		expect(await db.product.count()).toBe(0);
	});
});
