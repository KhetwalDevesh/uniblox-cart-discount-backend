import { db, pool } from "./index";

// Fixed ids so API examples and docs can reference the same products on every machine.
const PRODUCTS = [
	{
		id: "11111111-1111-4111-8111-111111111111",
		name: "Wireless Mouse",
		price: "24.99",
		stock: 100,
	},
	{
		id: "22222222-2222-4222-8222-222222222222",
		name: "Mechanical Keyboard",
		price: "89.50",
		stock: 50,
	},
	{ id: "33333333-3333-4333-8333-333333333333", name: "USB-C Cable", price: "9.99", stock: 200 },
	{ id: "44444444-4444-4444-8444-444444444444", name: "Laptop Stand", price: "34.00", stock: 40 },
	{
		id: "55555555-5555-4555-8555-555555555555",
		name: "Noise-Cancelling Headphones",
		price: "149.99",
		stock: 25,
	},
	// Limited inventory: handy for demonstrating oversell protection.
	{
		id: "66666666-6666-4666-8666-666666666666",
		name: "Limited Edition Keycap Set",
		price: "59.00",
		stock: 3,
	},
	{
		id: "77777777-7777-4777-8777-777777777777",
		name: "Signed Collector Poster",
		price: "19.99",
		stock: 1,
	},
];

// `--if-empty` (used by the Docker start-up) seeds only a database that has no products yet.
if (process.argv.includes("--if-empty") && (await db.product.count()) > 0) {
	console.log("Products already exist; skipping seed.");
	await db.$disconnect();
	await pool.end();
	process.exit(0);
}

// Re-running resets name, price and stock of the seeded products to these values.
for (const product of PRODUCTS) {
	await db.product.upsert({
		where: { id: product.id },
		create: product,
		update: { name: product.name, price: product.price, stock: product.stock },
	});
}

console.log(`Seeded ${PRODUCTS.length} products.`);
await db.$disconnect();
await pool.end();
