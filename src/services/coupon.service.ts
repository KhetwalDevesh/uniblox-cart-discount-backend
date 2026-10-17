import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config/env";
import type { TransactionRunner } from "../db/transaction";
import { ConflictError } from "../domain/errors";
import type {
	CouponRecord,
	CouponRepository,
	CouponStatus,
	OrderRepository,
} from "../repositories";

export type CouponView = {
	id: string;
	code: string;
	milestone: number;
	discountPercent: number;
	status: CouponStatus;
	generatedAt: string;
	redeemedAt: string | null;
	redeemedOrderId: string | null;
};

export type CouponCodeGenerator = (discountPercent: number) => string;

// No 0/O/1/I so codes survive being read aloud or typed from a screenshot.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** e.g. SAVE10-K7Q2XM4P. Unguessable enough for a bearer coupon; uniqueness is also a DB constraint. */
export const randomCouponCode: CouponCodeGenerator = (discountPercent) => {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	const suffix = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
	return `SAVE${discountPercent}-${suffix}`;
};

/** Codes are stored and compared in upper case so customers can type them in any case. */
export function normalizeCouponCode(code: string): string {
	return code.trim().toUpperCase();
}

export function toCouponView(coupon: CouponRecord): CouponView {
	return {
		id: coupon.id,
		code: coupon.code,
		milestone: coupon.milestone,
		discountPercent: coupon.discountPercent,
		status: coupon.status,
		generatedAt: coupon.generatedAt.toISOString(),
		redeemedAt: coupon.redeemedAt?.toISOString() ?? null,
		redeemedOrderId: coupon.redeemedOrderId,
	};
}

export class CouponService {
	constructor(
		private readonly db: PrismaClient,
		private readonly transactions: TransactionRunner,
		private readonly coupons: CouponRepository,
		private readonly orders: OrderRepository,
		private readonly config: Pick<Config, "couponEveryNOrders" | "couponDiscountPercent">,
		private readonly generateCode: CouponCodeGenerator = randomCouponCode,
	) {}

	/**
	 * Generates the coupon for the lowest milestone that has been reached but not yet rewarded.
	 *
	 * Milestone k is reached once k * n orders have been placed. Orders are counted from committed
	 * rows (never from a sequence, which skips values on rollback). The advisory lock makes
	 * concurrent requests take turns, and UNIQUE(milestone) is the final guard against duplicates.
	 */
	async generate(): Promise<CouponView> {
		const { couponEveryNOrders: n, couponDiscountPercent: percent } = this.config;

		return this.transactions.run(async (tx) => {
			await this.coupons.lockGeneration(tx);

			const placedOrders = await this.orders.count(tx);
			const milestonesReached = Math.floor(placedOrders / n);
			const milestonesGenerated = await this.coupons.latestMilestone(tx);

			if (milestonesGenerated >= milestonesReached) {
				throw new ConflictError(
					"NO_ELIGIBLE_MILESTONE",
					"No unrewarded order milestone has been reached",
					{
						placedOrders,
						everyNOrders: n,
						milestonesReached,
						milestonesGenerated,
						ordersUntilNextMilestone: (milestonesGenerated + 1) * n - placedOrders,
					},
				);
			}

			const coupon = await this.coupons.create(tx, {
				code: normalizeCouponCode(this.generateCode(percent)),
				milestone: milestonesGenerated + 1,
				discountPercent: percent,
			});
			return toCouponView(coupon);
		});
	}

	async list(status?: CouponStatus): Promise<CouponView[]> {
		return (await this.coupons.list(this.db, status)).map(toCouponView);
	}
}
