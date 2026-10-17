import type { Tx } from "../db/transaction";
import { formatMoney, type Minor } from "../domain/money";
import type { PricedLine } from "../domain/order-pricing";
import { decimalToMinor } from "./mappers";

export type OrderItemRecord = {
	productId: string;
	name: string;
	quantity: number;
	unitPrice: Minor;
	lineTotal: Minor;
};

export type OrderRecord = {
	id: string;
	orderNumber: number;
	cartId: string;
	subtotal: Minor;
	discount: Minor;
	total: Minor;
	coupon: { code: string; discountPercent: number } | null;
	placedAt: Date;
	items: OrderItemRecord[];
};

export type NewOrder = {
	cartId: string;
	lines: PricedLine[];
	subtotal: Minor;
	discount: Minor;
	total: Minor;
	coupon?: { id: string; code: string; discountPercent: number };
};

const withItems = { items: { orderBy: [{ productName: "asc" as const }, { id: "asc" as const }] } };

type OrderRow = NonNullable<Awaited<ReturnType<Tx["order"]["findUnique"]>>> & {
	items: {
		productId: string;
		productName: string;
		quantity: number;
		unitPrice: Parameters<typeof decimalToMinor>[0];
		lineTotal: Parameters<typeof decimalToMinor>[0];
	}[];
};

function toRecord(row: OrderRow): OrderRecord {
	return {
		id: row.id,
		orderNumber: Number(row.orderNumber),
		cartId: row.cartId,
		subtotal: decimalToMinor(row.subtotal),
		discount: decimalToMinor(row.discount),
		total: decimalToMinor(row.total),
		coupon:
			row.couponCode !== null && row.discountPercent !== null
				? { code: row.couponCode, discountPercent: row.discountPercent }
				: null,
		placedAt: row.placedAt,
		items: row.items.map((item) => ({
			productId: item.productId,
			name: item.productName,
			quantity: item.quantity,
			unitPrice: decimalToMinor(item.unitPrice),
			lineTotal: decimalToMinor(item.lineTotal),
		})),
	};
}

export class OrderRepository {
	/** Persists the order and its line snapshots. Runs inside the checkout transaction. */
	async create(tx: Tx, order: NewOrder): Promise<OrderRecord> {
		const row = await tx.order.create({
			data: {
				cartId: order.cartId,
				subtotal: formatMoney(order.subtotal),
				discount: formatMoney(order.discount),
				total: formatMoney(order.total),
				couponId: order.coupon?.id,
				couponCode: order.coupon?.code,
				discountPercent: order.coupon?.discountPercent,
				items: {
					create: order.lines.map((line) => ({
						productId: line.productId,
						productName: line.name,
						unitPrice: formatMoney(line.unitPrice),
						quantity: line.quantity,
						lineTotal: formatMoney(line.lineTotal),
					})),
				},
			},
			include: withItems,
		});
		return toRecord(row);
	}

	async findById(client: Tx, id: string): Promise<OrderRecord | null> {
		const row = await client.order.findUnique({ where: { id }, include: withItems });
		return row ? toRecord(row) : null;
	}

	async findByCartId(client: Tx, cartId: string): Promise<OrderRecord | null> {
		const row = await client.order.findUnique({ where: { cartId }, include: withItems });
		return row ? toRecord(row) : null;
	}

	/** Number of successfully placed orders: the basis for reward milestones. */
	async count(client: Tx): Promise<number> {
		return client.order.count();
	}
}
