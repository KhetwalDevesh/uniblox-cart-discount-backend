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
