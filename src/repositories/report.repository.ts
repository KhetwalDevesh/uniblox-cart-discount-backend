import type { Tx } from "../db/transaction";
import { type Minor, parseMoney } from "../domain/money";

export type OrderTotalsRecord = {
	ordersCount: number;
	gross: Minor;
	discounts: Minor;
	net: Minor;
	/** Sum of order line totals; must equal `gross` (cross-check, not reported). */
	lineItemsTotal: Minor;
};

export type ProductQuantityRecord = {
	productId: string;
	name: string;
	quantity: number;
};

export type CouponCountsRecord = {
	generated: number;
	available: number;
	redeemed: number;
};

/**
 * Aggregate queries only. Money is summed in SQL on NUMERIC and cast to text, then parsed into
 * integer minor units, so no JS float ever touches a total.
 */
export class ReportRepository {
	async orderTotals(client: Tx): Promise<OrderTotalsRecord> {
		const [row] = await client.$queryRaw<
			{ orders: number; gross: string; discounts: string; net: string }[]
		>`
			SELECT count(*)::int AS orders,
			       COALESCE(SUM(subtotal), 0)::numeric(14,2)::text AS gross,
			       COALESCE(SUM(discount), 0)::numeric(14,2)::text AS discounts,
			       COALESCE(SUM(total), 0)::numeric(14,2)::text AS net
			FROM orders`;
		const [lines] = await client.$queryRaw<{ total: string }[]>`
			SELECT COALESCE(SUM(line_total), 0)::numeric(14,2)::text AS total FROM order_items`;
		if (!row || !lines) throw new Error("Aggregate query returned no row");
		return {
			ordersCount: row.orders,
			gross: parseMoney(row.gross),
			discounts: parseMoney(row.discounts),
			net: parseMoney(row.net),
			lineItemsTotal: parseMoney(lines.total),
		};
	}

	/** Units sold per product, from the order snapshots. The name is the one on the latest order. */
	async quantityByProduct(client: Tx): Promise<ProductQuantityRecord[]> {
		return client.$queryRaw<ProductQuantityRecord[]>`
			SELECT oi.product_id::text AS "productId",
			       (array_agg(oi.product_name ORDER BY o.placed_at DESC, oi.id))[1] AS name,
			       SUM(oi.quantity)::int AS quantity
			FROM order_items oi
			JOIN orders o ON o.id = oi.order_id
			GROUP BY oi.product_id
			ORDER BY name, "productId"`;
	}

	async couponCounts(client: Tx): Promise<CouponCountsRecord> {
		const [row] = await client.$queryRaw<CouponCountsRecord[]>`
			SELECT count(*)::int AS generated,
			       (count(*) FILTER (WHERE status = 'AVAILABLE'))::int AS available,
			       (count(*) FILTER (WHERE status = 'REDEEMED'))::int AS redeemed
			FROM coupons`;
		if (!row) throw new Error("Aggregate query returned no row");
		return row;
	}
}
