import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { MockPaymentProvider } from "./services/payments/mock.js";
import type { PaymentProvider } from "./services/payments/provider.js";
import { StripePaymentProvider } from "./services/payments/stripe.js";
import { ExpoPushSender, LogPushSender, type PushSender } from "./services/push.js";

/** Everything services need, passed explicitly so they work in routes, the worker and tests. */
export interface AppContext {
  db: Database;
  config: Config;
  log: FastifyBaseLogger;
  payments: PaymentProvider;
  push: PushSender;
  /** Injectable clock — tests move time forward without sleeping. */
  now: () => Date;
}

export function createContext(
  db: Database,
  config: Config,
  log: FastifyBaseLogger,
  overrides: Partial<Pick<AppContext, "payments" | "push" | "now">> = {},
): AppContext {
  const payments =
    overrides.payments ??
    (config.PAYMENT_PROVIDER === "stripe"
      ? new StripePaymentProvider(config.STRIPE_SECRET_KEY!, config.STRIPE_WEBHOOK_SECRET)
      : new MockPaymentProvider());
  const push =
    overrides.push ??
    (config.PUSH_PROVIDER === "expo" ? new ExpoPushSender(log, config.EXPO_ACCESS_TOKEN) : new LogPushSender(log));
  return { db, config, log, payments, push, now: overrides.now ?? (() => new Date()) };
}
