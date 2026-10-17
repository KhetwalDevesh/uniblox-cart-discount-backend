import type { PrismaClient } from "@prisma/client";
import { type Config, loadConfig } from "./config/env";
import { db } from "./db";
import { PrismaTransactionRunner, type TransactionRunner } from "./db/transaction";

/**
 * Composition root: the only place that wires concrete implementations together.
 * Services depend on interfaces and receive them here, so tests can build a container with
 * fakes (for example a failing payment gateway) without touching service code.
 */
export type Container = {
	config: Config;
	db: PrismaClient;
	transactions: TransactionRunner;
};

export function createContainer(config: Config = loadConfig()): Container {
	return {
		config,
		db,
		transactions: new PrismaTransactionRunner(db),
	};
}
