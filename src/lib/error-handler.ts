import { Elysia } from "elysia";
import { AppError, ServiceUnavailableError, ValidationError } from "../domain/errors";
import { log } from "./logger";

const DB_UNAVAILABLE_PATTERNS = ["Connection terminated", "ETIMEDOUT", "ECONNREFUSED"];

function isDbUnavailable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return DB_UNAVAILABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * The single place where errors become HTTP responses, so every failure has the same shape:
 * { status: "error", code, message, details? }.
 */
export const errorHandler = new Elysia({ name: "error-handler" }).onError(
	{ as: "global" },
	({ code, error, set }) => {
		if (error instanceof AppError) {
			set.status = error.httpStatus;
			return error.toBody();
		}

		switch (code) {
			case "VALIDATION": {
				const failures = error.all.map((failure) => ({
					field: failure.path || "(body)",
					message: failure.summary ?? failure.message,
				}));
				const mapped = new ValidationError("Request validation failed", { errors: failures });
				set.status = mapped.httpStatus;
				return mapped.toBody();
			}
			case "PARSE":
				set.status = 400;
				return {
					status: "error",
					code: "INVALID_BODY",
					message: "Request body could not be parsed",
				};
			case "NOT_FOUND":
				set.status = 404;
				return { status: "error", code: "ROUTE_NOT_FOUND", message: "Route not found" };
		}

		if (isDbUnavailable(error)) {
			const unavailable = new ServiceUnavailableError("Database temporarily unavailable.");
			set.status = unavailable.httpStatus;
			return unavailable.toBody();
		}

		log.error({ code, error }, "Unhandled error");
		set.status = 500;
		return { status: "error", code: "INTERNAL_ERROR", message: "Internal server error" };
	},
);
