import type { Tx } from "../db/transaction";

export type CouponStatus = "AVAILABLE" | "REDEEMED";

export type CouponRecord = {
	id: string;
	code: string;
	milestone: number;
	discountPercent: number;
	status: CouponStatus;
	generatedAt: Date;
	redeemedAt: Date | null;
	redeemedOrderId: string | null;
};

// Arbitrary constant identifying the "coupon generation" advisory lock.
const GENERATION_LOCK_KEY = 7_101;

export class CouponRepository {
	/**
	 * Serializes coupon generation across all app instances for the rest of the transaction.
	 * The lock is released automatically at commit or rollback.
	 */
	async lockGeneration(tx: Tx): Promise<void> {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GENERATION_LOCK_KEY}::bigint)`;
	}

	/** Highest milestone that already has a coupon (0 when none). */
	async latestMilestone(tx: Tx): Promise<number> {
		const result = await tx.coupon.aggregate({ _max: { milestone: true } });
		return result._max.milestone ?? 0;
	}

	async create(
		tx: Tx,
		coupon: { code: string; milestone: number; discountPercent: number },
	): Promise<CouponRecord> {
		return tx.coupon.create({ data: coupon });
	}

	async list(client: Tx, status?: CouponStatus): Promise<CouponRecord[]> {
		return client.coupon.findMany({
			where: status ? { status } : undefined,
			orderBy: { milestone: "asc" },
		});
	}

	async findByCode(client: Tx, code: string): Promise<CouponRecord | null> {
		return client.coupon.findUnique({ where: { code } });
	}

	/**
	 * Redeems the coupon if, and only if, it is still available. The condition and the change are
	 * one statement, so of two concurrent checkouts exactly one gets a row back; the other waits on
	 * the row lock and then sees REDEEMED. Returns null when the code is unknown or already used.
	 */
	async redeemIfAvailable(
		tx: Tx,
		code: string,
	): Promise<{ id: string; discountPercent: number } | null> {
		const rows = await tx.$queryRaw<{ id: string; discount_percent: number }[]>`
			UPDATE coupons
			SET status = 'REDEEMED', redeemed_at = now()
			WHERE code = ${code} AND status = 'AVAILABLE'
			RETURNING id::text AS id, discount_percent`;
		const row = rows[0];
		return row ? { id: row.id, discountPercent: row.discount_percent } : null;
	}

	async linkOrder(tx: Tx, couponId: string, orderId: string): Promise<void> {
		await tx.coupon.update({ where: { id: couponId }, data: { redeemedOrderId: orderId } });
	}
}
