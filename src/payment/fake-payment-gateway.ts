import type { ChargeRequest, ChargeResult, PaymentGateway } from "./payment-gateway";

/**
 * Stand-in for a payment provider: approves every charge unless told otherwise.
 * Tests inject a `decline` rule to prove a failed payment rolls back stock and coupons.
 */
export class FakePaymentGateway implements PaymentGateway {
	constructor(private readonly decline?: (request: ChargeRequest) => string | null) {}

	async charge(request: ChargeRequest): Promise<ChargeResult> {
		const reason = this.decline?.(request) ?? null;
		if (reason) return { approved: false, reason };
		return { approved: true, reference: `fake_${request.idempotencyKey}` };
	}
}
