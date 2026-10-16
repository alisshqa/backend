import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import type { ChargeResult, PaymentMethodDetails, PaymentProvider } from "./provider.js";

/**
 * Development provider: no money moves. The payment method id controls the outcome so every
 * branch of the unlock flow can be exercised from a client or a test:
 *   pm_mock_apple_2084   → Apple Pay •••• 2084, charge succeeds
 *   pm_mock_card_4242    → Visa •••• 4242, charge succeeds
 *   pm_mock_decline_0002 → charge is declined
 *   pm_mock_3ds_3155     → charge requires customer action (3-D Secure); confirm via POST /webhooks/mock
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;

  async ensureCustomer(): Promise<string | null> {
    return null;
  }

  async createSetupIntent(): Promise<{ clientSecret: string }> {
    return { clientSecret: `seti_mock_${randomUUID()}_secret_mock` };
  }

  async attachPaymentMethod(_customerId: string | null, id: string): Promise<PaymentMethodDetails> {
    if (!id.startsWith("pm_mock_")) {
      throw new AppError(400, "INVALID_PAYMENT_METHOD", "Mock provider accepts ids like pm_mock_apple_2084");
    }
    const last4 = /(\d{4})$/.exec(id)?.[1] ?? "4242";
    const wallet = id.includes("apple") ? "apple_pay" : id.includes("google") ? "google_pay" : null;
    return { brand: "visa", last4, wallet };
  }

  async detachPaymentMethod(): Promise<void> {}

  async charge(input: { providerPaymentMethodId: string; idempotencyKey: string }): Promise<ChargeResult> {
    const providerPaymentId = `pi_mock_${input.idempotencyKey}`;
    if (input.providerPaymentMethodId.includes("decline")) {
      return { status: "failed", providerPaymentId, failureReason: "Your card was declined." };
    }
    if (input.providerPaymentMethodId.includes("3ds")) {
      return { status: "requires_action", providerPaymentId, clientSecret: `${providerPaymentId}_secret_mock` };
    }
    return { status: "succeeded", providerPaymentId };
  }

  parseWebhook(rawBody: Buffer): ReturnType<PaymentProvider["parseWebhook"]> {
    const body = JSON.parse(rawBody.toString("utf8")) as { type?: string; providerPaymentId?: string };
    if (!body.providerPaymentId) return null;
    if (body.type === "payment.succeeded") return { type: "payment.succeeded", providerPaymentId: body.providerPaymentId };
    if (body.type === "payment.failed") {
      return { type: "payment.failed", providerPaymentId: body.providerPaymentId, failureReason: "Authentication failed" };
    }
    return null;
  }
}
