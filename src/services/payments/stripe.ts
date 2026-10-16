import Stripe from "stripe";
import { AppError } from "../../lib/errors.js";
import type {
  ChargeInput,
  ChargeResult,
  CustomerRef,
  PaymentMethodDetails,
  PaymentProvider,
  PaymentWebhookEvent,
} from "./provider.js";

/**
 * Real charges through Stripe. Apple Pay / Google Pay are saved on the device with the Stripe
 * mobile SDK against a SetupIntent (usage: off_session) and charged here when the user confirms
 * an early unlock.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string | undefined,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async ensureCustomer(customer: CustomerRef): Promise<string> {
    if (customer.customerId) return customer.customerId;
    const created = await this.stripe.customers.create(
      { email: customer.email, name: customer.name, metadata: { userId: customer.userId } },
      { idempotencyKey: `customer-${customer.userId}` },
    );
    return created.id;
  }

  async createSetupIntent(customerId: string | null): Promise<{ clientSecret: string }> {
    if (!customerId) throw new AppError(500, "STRIPE_CUSTOMER_MISSING", "Stripe customer is missing");
    const intent = await this.stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      automatic_payment_methods: { enabled: true },
    });
    if (!intent.client_secret) throw new AppError(502, "STRIPE_ERROR", "Stripe returned no client secret");
    return { clientSecret: intent.client_secret };
  }

  async attachPaymentMethod(customerId: string | null, id: string): Promise<PaymentMethodDetails> {
    if (!customerId) throw new AppError(500, "STRIPE_CUSTOMER_MISSING", "Stripe customer is missing");
    let method: Stripe.PaymentMethod;
    try {
      method = await this.stripe.paymentMethods.retrieve(id);
      const owner = typeof method.customer === "string" ? method.customer : method.customer?.id;
      if (owner && owner !== customerId) {
        throw new AppError(403, "PAYMENT_METHOD_FORBIDDEN", "Payment method belongs to another customer");
      }
      if (!owner) method = await this.stripe.paymentMethods.attach(id, { customer: customerId });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Stripe.errors.StripeError) {
        throw new AppError(400, "INVALID_PAYMENT_METHOD", error.message);
      }
      throw error;
    }
    if (!method.card) throw new AppError(400, "UNSUPPORTED_PAYMENT_METHOD", "Only cards and wallets are supported");
    const walletType: string | undefined = method.card.wallet?.type;
    return {
      brand: method.card.brand,
      last4: method.card.last4,
      wallet: walletType === "apple_pay" || walletType === "google_pay" ? walletType : null,
    };
  }

  async detachPaymentMethod(id: string): Promise<void> {
    try {
      await this.stripe.paymentMethods.detach(id);
    } catch (error) {
      // Already detached or deleted on Stripe's side — nothing left to do.
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;
    }
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    if (!input.customerId) throw new AppError(500, "STRIPE_CUSTOMER_MISSING", "Stripe customer is missing");
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          customer: input.customerId,
          payment_method: input.providerPaymentMethodId,
          off_session: true,
          confirm: true,
          description: input.description,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return this.fromIntent(intent);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError) {
        const intent = error.payment_intent;
        if (error.code === "authentication_required" && intent?.client_secret) {
          return { status: "requires_action", providerPaymentId: intent.id, clientSecret: intent.client_secret };
        }
        return { status: "failed", providerPaymentId: intent?.id ?? null, failureReason: error.message };
      }
      throw error;
    }
  }

  private fromIntent(intent: Stripe.PaymentIntent): ChargeResult {
    switch (intent.status) {
      case "succeeded":
        return { status: "succeeded", providerPaymentId: intent.id };
      case "requires_action":
      case "requires_confirmation":
        return { status: "requires_action", providerPaymentId: intent.id, clientSecret: intent.client_secret ?? "" };
      case "processing":
        // Card payments rarely sit here; the webhook will settle it. Treat as needing a wait.
        return { status: "requires_action", providerPaymentId: intent.id, clientSecret: intent.client_secret ?? "" };
      default:
        return {
          status: "failed",
          providerPaymentId: intent.id,
          failureReason: intent.last_payment_error?.message ?? `Payment ${intent.status}`,
        };
    }
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): PaymentWebhookEvent | null {
    if (!this.webhookSecret) throw new AppError(500, "WEBHOOK_NOT_CONFIGURED", "STRIPE_WEBHOOK_SECRET is not set");
    if (!signature) throw new AppError(400, "INVALID_SIGNATURE", "Missing Stripe-Signature header");
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new AppError(400, "INVALID_SIGNATURE", "Webhook signature verification failed");
    }
    if (event.type === "payment_intent.succeeded") {
      return { type: "payment.succeeded", providerPaymentId: event.data.object.id };
    }
    if (event.type === "payment_intent.payment_failed") {
      return {
        type: "payment.failed",
        providerPaymentId: event.data.object.id,
        failureReason: event.data.object.last_payment_error?.message ?? "Payment failed",
      };
    }
    return null;
  }
}
