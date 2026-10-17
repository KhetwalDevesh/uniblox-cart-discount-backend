import { NoDiscount } from "../domain/discount";
import { formatMoney } from "../domain/money";
import { detectPriceChanges, priceOrder } from "../domain/order-pricing";
import type { CartRecord } from "../repositories";

export type CartLineView = {
	productId: string;
	name: string;
	quantity: number;
	/** Current catalog price, the one checkout would charge. */
	unitPrice: string;
	/** Price recorded when the line was added. */
	unitPriceAtAdd: string;
	priceChanged: boolean;
	lineTotal: string;
};

export type CartView = {
	id: string;
	status: "OPEN" | "CHECKED_OUT";
	items: CartLineView[];
	totalQuantity: number;
	/** Sum of line totals at current prices. Discounts apply only at checkout. */
	subtotal: string;
};

/** Single builder used by every cart endpoint, so totals can never differ between them. */
export function buildCartView(cart: CartRecord): CartView {
	const priced = priceOrder(
		cart.lines.map((line) => ({
			productId: line.productId,
			name: line.name,
			unitPrice: line.livePrice,
			quantity: line.quantity,
		})),
		new NoDiscount(),
	);
	const changedIds = new Set(detectPriceChanges(cart.lines).map((change) => change.productId));

	return {
		id: cart.id,
		status: cart.status,
		items: cart.lines.map((line, index) => ({
			productId: line.productId,
			name: line.name,
			quantity: line.quantity,
			unitPrice: formatMoney(line.livePrice),
			unitPriceAtAdd: formatMoney(line.unitPriceAtAdd),
			priceChanged: changedIds.has(line.productId),
			lineTotal: formatMoney(priced.lines[index]?.lineTotal ?? 0),
		})),
		totalQuantity: cart.lines.reduce((sum, line) => sum + line.quantity, 0),
		subtotal: formatMoney(priced.subtotal),
	};
}
