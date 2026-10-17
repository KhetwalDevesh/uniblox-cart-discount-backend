import type { Prisma } from "@prisma/client";
import { type Minor, parseMoney } from "../domain/money";

/** NUMERIC(12,2) -> integer minor units. The only place a Prisma Decimal is read as money. */
export function decimalToMinor(value: Prisma.Decimal): Minor {
	return parseMoney(value.toFixed(2));
}
