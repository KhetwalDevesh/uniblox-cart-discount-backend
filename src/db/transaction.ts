import { Prisma, type PrismaClient } from "@prisma/client";

/** Client handed to code running inside a transaction. Repositories take it explicitly. */
export type Tx = Prisma.TransactionClient;

export type IsolationLevel = "ReadCommitted" | "RepeatableRead" | "Serializable";

export type TransactionOptions = {
	/** Defaults to ReadCommitted; correctness relies on row locks and conditional updates. */
	isolation?: IsolationLevel;
	/** Rejects any write inside the transaction (used by reporting). */
	readOnly?: boolean;
};

/** Unit of Work: the one place that defines transaction boundaries. */
export interface TransactionRunner {
	run<T>(work: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

const MAX_ATTEMPTS = 3;
const TX_TIMEOUT_MS = 10_000;
const TX_MAX_WAIT_MS = 5_000;

// P2034: serialization failure or deadlock detected. Safe to retry the whole transaction.
function isRetryable(error: unknown): boolean {
	return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export class PrismaTransactionRunner implements TransactionRunner {
	constructor(private readonly client: PrismaClient) {}

	async run<T>(work: (tx: Tx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.client.$transaction(
					async (tx) => {
						// Must be the first statement of the transaction.
						if (options.readOnly) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
						return work(tx);
					},
					{
						isolationLevel: options.isolation ?? "ReadCommitted",
						timeout: TX_TIMEOUT_MS,
						maxWait: TX_MAX_WAIT_MS,
					},
				);
			} catch (error) {
				if (!isRetryable(error) || attempt === MAX_ATTEMPTS) throw error;
			}
		}
	}
}
