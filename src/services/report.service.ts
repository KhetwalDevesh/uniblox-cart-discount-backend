import type { TransactionRunner } from "../db/transaction";
import { formatMoney } from "../domain/money";
import type { ReportRepository } from "../repositories/report.repository";

export type ReportView = {
	/** Successfully placed orders. */
	ordersCount: number;
	purchasedQuantityByProduct: { productId: string; name: string; quantity: number }[];
	revenue: {
		/** Sum of order subtotals, before discounts. */
		gross: string;
		/** Sum of discounts granted through coupons. */
		discounts: string;
		/** gross - discounts, equal to the sum of order totals. */
		net: string;
	};
	coupons: { generated: number; available: number; redeemed: number };
};

export class ReportService {
	constructor(
		private readonly transactions: TransactionRunner,
		private readonly reports: ReportRepository,
	) {}

	/**
	 * Read-only. All figures come from one REPEATABLE READ snapshot, so they describe the same
	 * moment even while checkouts commit concurrently, and the read-only transaction guarantees
	 * a report can never change data.
	 */
	async summary(): Promise<ReportView> {
		return this.transactions.run(
			async (tx) => {
				const totals = await this.reports.orderTotals(tx);
				const quantities = await this.reports.quantityByProduct(tx);
				const coupons = await this.reports.couponCounts(tx);

				// Reconciliation: these must hold for any consistent snapshot. A failure means the
				// stored data (or this query) is wrong, so it is surfaced loudly, never papered over.
				if (totals.gross - totals.discounts !== totals.net) {
					throw new Error("Report invariant violated: gross - discounts != net");
				}
				if (totals.lineItemsTotal !== totals.gross) {
					throw new Error("Report invariant violated: order lines do not sum to gross revenue");
				}
				if (coupons.available + coupons.redeemed !== coupons.generated) {
					throw new Error("Report invariant violated: coupon counts do not add up");
				}

				return {
					ordersCount: totals.ordersCount,
					purchasedQuantityByProduct: quantities,
					revenue: {
						gross: formatMoney(totals.gross),
						discounts: formatMoney(totals.discounts),
						net: formatMoney(totals.net),
					},
					coupons,
				};
			},
			{ isolation: "RepeatableRead", readOnly: true },
		);
	}
}
