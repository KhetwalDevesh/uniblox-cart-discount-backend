import { formatMoney } from "../domain/money";
import type { OrderRecord } from "../repositories";

export type OrderView = {
	id: string;
	orderNumber: number;
	cartId: string;
	items: {
		productId: string;
		name: string;
		quantity: number;
		unitPrice: string;
		lineTotal: string;
	}[];
	subtotal: string;
	discount: string;
	total: string;
	coupon: { code: string; discountPercent: number } | null;
	placedAt: string;
};

/** Everything needed to explain the purchase and its total, taken from the order's own snapshot. */
export function toOrderView(order: OrderRecord): OrderView {
	return {
		id: order.id,
		orderNumber: order.orderNumber,
		cartId: order.cartId,
		items: order.items.map((item) => ({
			productId: item.productId,
			name: item.name,
			quantity: item.quantity,
			unitPrice: formatMoney(item.unitPrice),
			lineTotal: formatMoney(item.lineTotal),
		})),
		subtotal: formatMoney(order.subtotal),
		discount: formatMoney(order.discount),
		total: formatMoney(order.total),
		coupon: order.coupon,
		placedAt: order.placedAt.toISOString(),
	};
}
