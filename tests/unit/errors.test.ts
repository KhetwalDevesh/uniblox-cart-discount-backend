import { expect, test } from "bun:test";
import {
	ConflictError,
	NotFoundError,
	PaymentDeclinedError,
	ServiceUnavailableError,
	UnprocessableError,
	ValidationError,
} from "../../src/domain/errors";

test("each error class maps to a distinct HTTP status and a stable code", () => {
	const cases = [
		[new ValidationError("bad"), 400, "VALIDATION_ERROR"],
		[new PaymentDeclinedError(), 402, "PAYMENT_DECLINED"],
		[new NotFoundError("CART_NOT_FOUND", "no cart"), 404, "CART_NOT_FOUND"],
		[new ConflictError("INSUFFICIENT_STOCK", "short"), 409, "INSUFFICIENT_STOCK"],
		[new UnprocessableError("CART_EMPTY", "empty"), 422, "CART_EMPTY"],
	] as const;
	for (const [error, status, code] of cases) {
		expect(error.httpStatus).toBe(status);
		expect(error.code).toBe(code);
	}
});

test("toBody gives the uniform error shape and omits absent details", () => {
	expect(new ConflictError("CART_NOT_OPEN", "closed").toBody()).toEqual({
		status: "error",
		code: "CART_NOT_OPEN",
		message: "closed",
	});
	const withDetails = new ConflictError("INSUFFICIENT_STOCK", "short", {
		lines: [{ productId: "a", requested: 5, available: 2 }],
	}).toBody();
	expect(withDetails.details).toEqual({ lines: [{ productId: "a", requested: 5, available: 2 }] });
});

test("ServiceUnavailableError is a retryable 503", () => {
	const error = new ServiceUnavailableError();
	expect(error.httpStatus).toBe(503);
	expect(error.code).toBe("SERVICE_UNAVAILABLE");
});
