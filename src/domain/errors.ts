/**
 * Error model. Every expected failure is an AppError subclass carrying a stable `code`,
 * an HTTP status and optional structured `details`. A single global handler turns them into
 * the uniform response body, so routes and services never build error responses by hand.
 */

export type ErrorBody = {
	status: "error";
	code: string;
	message: string;
	details?: Record<string, unknown>;
};

export abstract class AppError extends Error {
	abstract readonly httpStatus: number;

	constructor(
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = new.target.name;
	}

	toBody(): ErrorBody {
		return {
			status: "error",
			code: this.code,
			message: this.message,
			...(this.details ? { details: this.details } : {}),
		};
	}
}

/** 400: the request itself is malformed or out of range. */
export class ValidationError extends AppError {
	readonly httpStatus = 400;
	constructor(message: string, details?: Record<string, unknown>) {
		super("VALIDATION_ERROR", message, details);
	}
}

/** 402: payment was declined. */
export class PaymentDeclinedError extends AppError {
	readonly httpStatus = 402;
	constructor(message = "Payment was declined", details?: Record<string, unknown>) {
		super("PAYMENT_DECLINED", message, details);
	}
}

export type NotFoundCode =
	| "PRODUCT_NOT_FOUND"
	| "CART_NOT_FOUND"
	| "ITEM_NOT_IN_CART"
	| "ORDER_NOT_FOUND";

/** 404: a referenced resource does not exist. */
export class NotFoundError extends AppError {
	readonly httpStatus = 404;
	constructor(code: NotFoundCode, message: string, details?: Record<string, unknown>) {
		super(code, message, details);
	}
}

export type ConflictCode =
	| "INSUFFICIENT_STOCK"
	| "PRICE_CHANGED"
	| "CART_NOT_OPEN"
	| "CART_ALREADY_CHECKED_OUT"
	| "COUPON_ALREADY_REDEEMED"
	| "NO_ELIGIBLE_MILESTONE";

/** 409: valid request, but it conflicts with the current state of the resource. */
export class ConflictError extends AppError {
	readonly httpStatus = 409;
	constructor(code: ConflictCode, message: string, details?: Record<string, unknown>) {
		super(code, message, details);
	}
}

export type UnprocessableCode = "CART_EMPTY" | "COUPON_NOT_FOUND";

/** 422: well-formed request that cannot be processed as given. */
export class UnprocessableError extends AppError {
	readonly httpStatus = 422;
	constructor(code: UnprocessableCode, message: string, details?: Record<string, unknown>) {
		super(code, message, details);
	}
}

/** 503: a dependency (the database) is temporarily unavailable. Safe for clients to retry. */
export class ServiceUnavailableError extends AppError {
	readonly httpStatus = 503;
	constructor(message = "Service temporarily unavailable. Please try again.") {
		super("SERVICE_UNAVAILABLE", message);
	}
}
