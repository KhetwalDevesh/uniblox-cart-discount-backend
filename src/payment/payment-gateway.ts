import type { Minor } from "../domain/money";

export type ChargeRequest = {
	/** Stable per purchase (the cart id), so a real provider could de-duplicate retries. */
	idempotencyKey: string;
	amount: Minor;
};

export type ChargeResult =
	| { approved: true; reference: string }
	| { approved: false; reason: string };

/** Port for taking payment. Checkout depends on this interface, never on a provider. */
export interface PaymentGateway {
	charge(request: ChargeRequest): Promise<ChargeResult>;
}
