import type { PrismaClient } from "@prisma/client";
import { type Config, loadConfig } from "./config/env";
import { db } from "./db";
import { PrismaTransactionRunner, type TransactionRunner } from "./db/transaction";
import { CartRepository, ProductRepository } from "./repositories";
import { CartService } from "./services/cart.service";
import { CatalogService } from "./services/catalog.service";

/**
 * Composition root: the only place that wires concrete implementations together.
 * Services depend on interfaces and receive them here, so tests can build a container with
 * fakes (for example a failing payment gateway) without touching service code.
 */
export type Container = {
	config: Config;
	db: PrismaClient;
	transactions: TransactionRunner;
	catalog: CatalogService;
	carts: CartService;
};

export function createContainer(config: Config = loadConfig()): Container {
	const transactions = new PrismaTransactionRunner(db);
	const productRepository = new ProductRepository();
	const cartRepository = new CartRepository();

	return {
		config,
		db,
		transactions,
		catalog: new CatalogService(db, productRepository),
		carts: new CartService(db, transactions, cartRepository, productRepository),
	};
}
