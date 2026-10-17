/**
 * Money helpers. All arithmetic uses integer minor units (1999 = 19.99), never floats.
 * Storage is NUMERIC(12,2); the repository layer converts with parseMoney/formatMoney at the
 * boundary so no JS float ever touches an amount.
 */

export type Minor = number;

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;

export function assertSafe(value: number, what: string): Minor {
	if (!Number.isSafeInteger(value)) {
		throw new RangeError(`${what} is not a safe integer amount: ${value}`);
	}
	return value;
}

/** "19.99" -> 1999. Accepts non-negative decimals with at most 2 fraction digits. */
export function parseMoney(value: string): Minor {
	if (!DECIMAL_PATTERN.test(value)) {
		throw new RangeError(`Invalid money value: "${value}"`);
	}
	const [whole = "0", fraction = ""] = value.split(".");
	return assertSafe(Number(whole) * 100 + Number(fraction.padEnd(2, "0")), "money value");
}

/** 1999 -> "19.99". Always renders exactly 2 fraction digits. */
export function formatMoney(minor: Minor): string {
	assertSafe(minor, "money value");
	if (minor < 0) throw new RangeError(`Negative money value: ${minor}`);
	const whole = Math.floor(minor / 100);
	const fraction = String(minor % 100).padStart(2, "0");
	return `${whole}.${fraction}`;
}

export function addMoney(a: Minor, b: Minor): Minor {
	return assertSafe(a + b, "sum");
}

export function clampMoney(value: Minor, min: Minor, max: Minor): Minor {
	return Math.min(Math.max(value, min), max);
}

/**
 * percent% of amount, rounded half up: floor((amount * percent + 50) / 100).
 * Computed in BigInt so the intermediate product cannot lose precision.
 */
export function percentOf(amount: Minor, percent: number): Minor {
	assertSafe(amount, "amount");
	if (amount < 0) throw new RangeError(`Negative amount: ${amount}`);
	if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
		throw new RangeError(`Percent must be an integer between 0 and 100: ${percent}`);
	}
	return Number((BigInt(amount) * BigInt(percent) + 50n) / 100n);
}
