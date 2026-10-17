import { clampMoney, type Minor, percentOf } from "./money";

/** Strategy: how a discount is computed from an order subtotal. */
export interface DiscountStrategy {
	/** Returns the discount amount, always within [0, subtotal]. */
	compute(subtotal: Minor): Minor;
}

export class NoDiscount implements DiscountStrategy {
	compute(_subtotal: Minor): Minor {
		return 0;
	}
}

/** percent% off the whole subtotal, rounded half up, never exceeding the subtotal. */
export class PercentageDiscount implements DiscountStrategy {
	constructor(private readonly percent: number) {
		if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
			throw new RangeError(`Percent must be an integer between 0 and 100: ${percent}`);
		}
	}

	compute(subtotal: Minor): Minor {
		return clampMoney(percentOf(subtotal, this.percent), 0, subtotal);
	}
}
