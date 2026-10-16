export interface CustomerRef {
  userId: string;
  email: string;
  name: string;
  /** Provider customer id stored on the user, if already created. */
  customerId: string | null;
}

export interface PaymentMethodDetails {
  brand: string;
  last4: string;
  wallet: "apple_pay" | "google_pay" | null;
}

export type ChargeResult =
  | { status: "succeeded"; providerPaymentId: string }
  | { status: "requires_action"; providerPaymentId: string; clientSecret: string }
  | { status: "failed"; providerPaymentId: string | null; failureReason: string };

export interface ChargeInput {
  customerId: string | null;
  providerPaymentMethodId: string;
  amountCents: number;
  currency: string;
  /** Stable key so a retried request never charges twice. */
  idempotencyKey: string;
  description: string;
  metadata: Record<string, string>;
}

export type PaymentWebhookEvent =
  | { type: "payment.succeeded"; providerPaymentId: string }
  | { type: "payment.failed"; providerPaymentId: string; failureReason: string };

export interface PaymentProvider {
  readonly name: "mock" | "stripe";
  /** Creates the provider-side customer if needed and returns its id (null when not applicable). */
  ensureCustomer(customer: CustomerRef): Promise<string | null>;
  /** Client secret the mobile SDK uses to save Apple Pay / Google Pay / a card for later. */
  createSetupIntent(customerId: string | null): Promise<{ clientSecret: string }>;
  /** Attaches a payment method to the customer and returns what the UI needs to display it. */
  attachPaymentMethod(customerId: string | null, providerPaymentMethodId: string): Promise<PaymentMethodDetails>;
  detachPaymentMethod(providerPaymentMethodId: string): Promise<void>;
  charge(input: ChargeInput): Promise<ChargeResult>;
  /** Verifies and parses a webhook. Returns null for events we do not care about. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): PaymentWebhookEvent | null;
}
