import { t } from "elysia";

/** Uniform error body returned by every failing endpoint. Shared by validation and OpenAPI. */
export const ErrorResponse = t.Object(
	{
		status: t.Literal("error"),
		code: t.String({ description: "Stable machine-readable error code", examples: ["CART_EMPTY"] }),
		message: t.String({ description: "Human-readable explanation" }),
		details: t.Optional(
			t.Record(t.String(), t.Unknown(), { description: "Structured context for the error" }),
		),
	},
	{ title: "ErrorResponse" },
);

export const Uuid = t.String({
	format: "uuid",
	description: "UUID",
	examples: ["11111111-1111-4111-8111-111111111111"],
});

/** Decimal string with exactly two fraction digits. Never a JSON number, to avoid float drift. */
export const Money = t.String({
	pattern: "^\\d+\\.\\d{2}$",
	description: "Decimal amount with 2 fraction digits",
	examples: ["19.99"],
});
