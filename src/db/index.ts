import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

// Local Docker Postgres has no TLS; enable it for managed databases with DATABASE_SSL=true.
const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined;

export const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	max: Number(process.env.DATABASE_POOL_SIZE ?? 20),
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 10_000,
	ssl,
});

// Deliberately a plain client (no retry-on-every-query extension): transient retries inside an
// open transaction are unsafe, so the only retry lives in the TransactionRunner.
export const db = new PrismaClient({ adapter: new PrismaPg(pool), log: ["error", "warn"] });
