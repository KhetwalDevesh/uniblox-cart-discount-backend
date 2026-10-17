import type { PrismaClient } from "@prisma/client";
import { type Config, loadConfig } from "./config/env";
import { db } from "./db";
import { PrismaTransactionRunner, type TransactionRunner } from "./db/transaction";
import { FakePaymentGateway } from "./payment/fake-payment-gateway";
import type { PaymentGateway } from "./payment/payment-gateway";
import { CartRepository, OrderRepository, ProductRepository } from "./repositories";
import { CartService } from "./services/cart.service";
import { CatalogService } from "./services/catalog.service";
import { CheckoutService } from "./services/checkout.service";
import { OrderService } from "./services/order.service";

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
	checkout: CheckoutService;
	orders: OrderService;
};

/** Parts that tests may swap, for example a payment gateway that declines. */
export type ContainerOverrides = { payments?: PaymentGateway };

export function createContainer(
	config: Config = loadConfig(),
	overrides: ContainerOverrides = {},
): Container {
	const transactions = new PrismaTransactionRunner(db);
	const productRepository = new ProductRepository();
	const cartRepository = new CartRepository();
	const orderRepository = new OrderRepository();
	const payments = overrides.payments ?? new FakePaymentGateway();

	return {
		config,
		db,
		transactions,
		catalog: new CatalogService(db, productRepository),
		carts: new CartService(db, transactions, cartRepository, productRepository),
		checkout: new CheckoutService(
			transactions,
			cartRepository,
			productRepository,
			orderRepository,
			payments,
		),
		orders: new OrderService(db, orderRepository),
	};
}
