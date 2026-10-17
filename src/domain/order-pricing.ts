import type { DiscountStrategy } from "./discount";
import { addMoney, assertSafe, type Minor } from "./money";

export type PricingLine = {
	productId: string;
	name: string;
	unitPrice: Minor;
	quantity: number;
};

export type PricedLine = PricingLine & { lineTotal: Minor };

export type PricedOrder = {
	lines: PricedLine[];
	subtotal: Minor;
	discount: Minor;
	total: Minor;
};

/** Line total = unit price x whole quantity. */
export function calculateLineTotal(unitPrice: Minor, quantity: number): Minor {
	if (!Number.isInteger(quantity) || quantity < 0) {
		throw new RangeError(`Quantity must be a non-negative integer: ${quantity}`);
	}
	return assertSafe(unitPrice * quantity, "line total");
}

/** Subtotal = sum of all line totals. */
export function calculateSubtotal(lineTotals: readonly Minor[]): Minor {
	return lineTotals.reduce(addMoney, 0);
}

/**
 * Pure pricing function shared by checkout and cart view (one source of truth for totals).
 * total = subtotal - discount, and the strategy guarantees 0 <= discount <= subtotal.
 */
export function priceOrder(lines: readonly PricingLine[], discount: DiscountStrategy): PricedOrder {
	const priced = lines.map((line) => ({
		...line,
		lineTotal: calculateLineTotal(line.unitPrice, line.quantity),
	}));
	const subtotal = calculateSubtotal(priced.map((line) => line.lineTotal));
	const discountAmount = discount.compute(subtotal);
	return { lines: priced, subtotal, discount: discountAmount, total: subtotal - discountAmount };
}

export type PriceChange = {
	productId: string;
	oldUnitPrice: Minor;
	newUnitPrice: Minor;
};

/** Lines whose live price differs from the price recorded when they were added to the cart. */
export function detectPriceChanges(
	lines: readonly { productId: string; unitPriceAtAdd: Minor; livePrice: Minor }[],
): PriceChange[] {
	return lines
		.filter((line) => line.unitPriceAtAdd !== line.livePrice)
		.map((line) => ({
			productId: line.productId,
			oldUnitPrice: line.unitPriceAtAdd,
			newUnitPrice: line.livePrice,
		}));
}
