import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { AppContext } from "../../context.js";
import type { Executor } from "../../db/client.js";
import {
  focusSessions,
  paymentMethods,
  payments,
  users,
  type FocusSession,
  type Payment,
  type PaymentMethod,
  type User,
} from "../../db/schema.js";
import { AppError, conflict, notFound } from "../../lib/errors.js";
import { paymentMethodLabel } from "../../lib/format.js";
import { notifyUser } from "../notifications.js";
import { assertActive, completeExpiredSessions, getOwnedSession, sessionDto } from "../sessions.js";
import type { ChargeResult } from "./provider.js";

/* ───────────────────────────── Payment methods ───────────────────────────── */

export function paymentMethodDto(method: PaymentMethod) {
  return {
    id: method.id,
    brand: method.brand,
    last4: method.last4,
    wallet: method.wallet,
    label: paymentMethodLabel(method),
    isDefault: method.isDefault,
    createdAt: method.createdAt.toISOString(),
  };
}

export async function listPaymentMethods(db: Executor, userId: string) {
  return db
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.userId, userId))
    .orderBy(desc(paymentMethods.isDefault), desc(paymentMethods.createdAt));
}

export async function defaultPaymentMethod(db: Executor, userId: string) {
  const [method] = await listPaymentMethods(db, userId);
  return method ?? null;
}

async function ensureCustomer(ctx: AppContext, user: User) {
  const customerId = await ctx.payments.ensureCustomer({
    userId: user.id,
    email: user.email,
    name: user.name,
    customerId: user.stripeCustomerId,
  });
  if (customerId && customerId !== user.stripeCustomerId) {
    await ctx.db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, user.id));
  }
  return customerId;
}

export async function createSetupIntent(ctx: AppContext, user: User) {
  const customerId = await ensureCustomer(ctx, user);
  const { clientSecret } = await ctx.payments.createSetupIntent(customerId);
  return { provider: ctx.payments.name, clientSecret, customerId };
}

export async function addPaymentMethod(
  ctx: AppContext,
  user: User,
  input: { providerPaymentMethodId: string; makeDefault?: boolean },
) {
  const customerId = await ensureCustomer(ctx, user);
  const details = await ctx.payments.attachPaymentMethod(customerId, input.providerPaymentMethodId);

  return ctx.db.transaction(async (tx) => {
    // Ownership across accounts is enforced by the provider (a Stripe payment method belongs to one customer).
    const existing = await tx.query.paymentMethods.findFirst({
      where: and(
        eq(paymentMethods.userId, user.id),
        eq(paymentMethods.provider, ctx.payments.name),
        eq(paymentMethods.providerPaymentMethodId, input.providerPaymentMethodId),
      ),
    });
    const others = await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.userId, user.id));
    const makeDefault = input.makeDefault ?? true;
    const isDefault = makeDefault || others.length === 0 || (others.length === 1 && others[0]!.id === existing?.id);
    if (isDefault) await tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.userId, user.id));

    if (existing) {
      const [updated] = await tx
        .update(paymentMethods)
        .set({ ...details, isDefault: isDefault || existing.isDefault })
        .where(eq(paymentMethods.id, existing.id))
        .returning();
      return updated!;
    }
    const [created] = await tx
      .insert(paymentMethods)
      .values({
        userId: user.id,
        provider: ctx.payments.name,
        providerPaymentMethodId: input.providerPaymentMethodId,
        ...details,
        isDefault,
      })
      .returning();
    return created!;
  });
}

export async function setDefaultPaymentMethod(ctx: AppContext, userId: string, id: string) {
  return ctx.db.transaction(async (tx) => {
    const method = await tx.query.paymentMethods.findFirst({
      where: and(eq(paymentMethods.id, id), eq(paymentMethods.userId, userId)),
    });
    if (!method) throw notFound("Payment method");
    await tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.userId, userId));
    const [updated] = await tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, id)).returning();
    return updated!;
  });
}

export async function removePaymentMethod(ctx: AppContext, userId: string, id: string) {
  const method = await ctx.db.query.paymentMethods.findFirst({
    where: and(eq(paymentMethods.id, id), eq(paymentMethods.userId, userId)),
  });
  if (!method) throw notFound("Payment method");
  await ctx.payments.detachPaymentMethod(method.providerPaymentMethodId);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, id));
    if (method.isDefault) {
      const [next] = await tx
        .select()
        .from(paymentMethods)
        .where(and(eq(paymentMethods.userId, userId), ne(paymentMethods.id, id)))
        .orderBy(desc(paymentMethods.createdAt))
        .limit(1);
      if (next) await tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, next.id));
    }
  });
}

/* ───────────────────────────── Early unlock ───────────────────────────── */

export function paymentDto(payment: Payment) {
  return {
    id: payment.id,
    sessionId: payment.sessionId,
    amountCents: payment.amountCents,
    currency: payment.currency,
    status: payment.status,
    failureReason: payment.failureReason,
    createdAt: payment.createdAt.toISOString(),
  };
}

/** What the Penalty screen shows before the user confirms. */
export async function unlockQuote(ctx: AppContext, user: User, sessionId: string) {
  await completeExpiredSessions(ctx, user.id);
  const session = await getOwnedSession(ctx.db, user.id, sessionId);
  assertActive(session);
  const method = await defaultPaymentMethod(ctx.db, user.id);
  return {
    session: sessionDto(session, ctx.now()),
    amountCents: session.penaltyCents,
    currency: session.currency,
    paymentMethod: method ? paymentMethodDto(method) : null,
    requiresPayment: session.penaltyCents > 0,
  };
}

export type UnlockOutcome =
  | { outcome: "unlocked"; session: FocusSession; payment: Payment | null }
  | { outcome: "requires_action"; session: FocusSession; payment: Payment; clientSecret: string }
  | { outcome: "failed"; session: FocusSession; payment: Payment };

async function markUnlocked(db: Executor, sessionId: string, at: Date) {
  const [session] = await db
    .update(focusSessions)
    .set({ status: "unlocked_early", endedAt: at, updatedAt: at })
    .where(and(eq(focusSessions.id, sessionId), eq(focusSessions.status, "active")))
    .returning();
  return session ?? null;
}

async function reload(db: Executor, sessionId: string) {
  return (await db.query.focusSessions.findFirst({ where: eq(focusSessions.id, sessionId) }))!;
}

function outcomeFromPayment(session: FocusSession, payment: Payment): UnlockOutcome {
  if (payment.status === "succeeded") return { outcome: "unlocked", session, payment };
  if (payment.status === "requires_action") {
    return { outcome: "requires_action", session, payment, clientSecret: payment.clientSecret ?? "" };
  }
  return { outcome: "failed", session, payment };
}

/**
 * "Unlock and pay $5". Safe to retry with the same Idempotency-Key: a key always maps to a single
 * payment, and the provider receives a key derived from that payment, so nothing is charged twice.
 */
export async function unlockEarly(
  ctx: AppContext,
  user: User,
  sessionId: string,
  idempotencyKey: string,
): Promise<UnlockOutcome> {
  await completeExpiredSessions(ctx, user.id);
  const session = await getOwnedSession(ctx.db, user.id, sessionId);

  // 1. Replay of an earlier request with the same key.
  let payment = await ctx.db.query.payments.findFirst({
    where: and(eq(payments.userId, user.id), eq(payments.idempotencyKey, idempotencyKey)),
  });
  if (payment && payment.sessionId !== sessionId) {
    throw conflict("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used for another session");
  }
  if (payment && payment.status !== "pending") {
    return outcomeFromPayment(await reload(ctx.db, sessionId), payment);
  }
  // A pending payment is only re-driven while the night is still running.
  if (payment) assertActive(session);

  if (!payment) {
    assertActive(session);

    // 2. Free promise: nothing to charge.
    if (session.penaltyCents === 0) {
      const unlocked = await markUnlocked(ctx.db, sessionId, ctx.now());
      if (!unlocked) assertActive(await reload(ctx.db, sessionId));
      return { outcome: "unlocked", session: unlocked!, payment: null };
    }

    // 3. A charge for this session is already waiting on the user (3-D Secure) — reuse it.
    const open = await ctx.db.query.payments.findFirst({
      where: and(eq(payments.sessionId, sessionId), inArray(payments.status, ["requires_action", "pending"])),
    });
    if (open?.status === "requires_action") return outcomeFromPayment(session, open);
    if (open) throw conflict("PAYMENT_IN_PROGRESS", "A payment for this session is already being processed");

    const method = await defaultPaymentMethod(ctx.db, user.id);
    if (!method) throw conflict("PAYMENT_METHOD_REQUIRED", "Add a payment method to unlock early");

    const [created] = await ctx.db
      .insert(payments)
      .values({
        userId: user.id,
        sessionId,
        paymentMethodId: method.id,
        amountCents: session.penaltyCents,
        currency: session.currency,
        status: "pending",
        provider: ctx.payments.name,
        idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      // A concurrent request with the same key won the race.
      return unlockEarly(ctx, user, sessionId, idempotencyKey);
    }
    payment = created;
  }

  // 4. Charge (or re-drive a pending charge — the provider key makes this idempotent).
  const method = payment.paymentMethodId
    ? await ctx.db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, payment.paymentMethodId) })
    : await defaultPaymentMethod(ctx.db, user.id);
  if (!method) throw conflict("PAYMENT_METHOD_REQUIRED", "Add a payment method to unlock early");

  const freshUser = (await ctx.db.query.users.findFirst({ where: eq(users.id, user.id) }))!;
  let result: ChargeResult;
  try {
    result = await ctx.payments.charge({
      customerId: freshUser.stripeCustomerId,
      providerPaymentMethodId: method.providerPaymentMethodId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      idempotencyKey: `unlock-${payment.id}`,
      description: "CLOUD — early unlock",
      metadata: { userId: user.id, sessionId, paymentId: payment.id },
    });
  } catch (error) {
    ctx.log.error({ err: error, paymentId: payment.id }, "payment provider error");
    throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "Payment provider is unavailable, please retry");
  }

  return applyChargeResult(ctx, payment.id, result);
}

async function applyChargeResult(ctx: AppContext, paymentId: string, result: ChargeResult): Promise<UnlockOutcome> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [payment] = await tx
      .update(payments)
      .set({
        status: result.status,
        providerPaymentId: result.providerPaymentId,
        clientSecret: result.status === "requires_action" ? result.clientSecret : null,
        failureReason: result.status === "failed" ? result.failureReason : null,
        updatedAt: now,
      })
      .where(eq(payments.id, paymentId))
      .returning();
    let session = await reload(tx, payment!.sessionId);
    if (result.status === "succeeded") {
      const unlocked = await markUnlocked(tx, session.id, now);
      if (unlocked) session = unlocked;
      else ctx.log.warn({ paymentId }, "payment succeeded but session had already ended");
    }
    return outcomeFromPayment(session, payment!);
  });
}

/** Settles payments that needed 3-D Secure, from the provider's webhook. */
export async function handlePaymentWebhook(
  ctx: AppContext,
  event: { type: "payment.succeeded" | "payment.failed"; providerPaymentId: string; failureReason?: string },
) {
  const payment = await ctx.db.query.payments.findFirst({
    where: eq(payments.providerPaymentId, event.providerPaymentId),
  });
  if (!payment) return { handled: false as const };
  if (payment.status === "succeeded") return { handled: true as const, payment };

  const now = ctx.now();
  if (event.type === "payment.succeeded") {
    const result = await ctx.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(payments)
        .set({ status: "succeeded", clientSecret: null, failureReason: null, updatedAt: now })
        .where(eq(payments.id, payment.id))
        .returning();
      await markUnlocked(tx, payment.sessionId, now);
      return updated!;
    });
    await notifyUser(ctx, payment.userId, {
      title: "Apps unlocked",
      body: "Your payment went through. Rest well when you are ready.",
      data: { type: "unlocked", sessionId: payment.sessionId },
      force: true,
    });
    return { handled: true as const, payment: result };
  }

  const [updated] = await ctx.db
    .update(payments)
    .set({ status: "failed", clientSecret: null, failureReason: event.failureReason ?? "Payment failed", updatedAt: now })
    .where(eq(payments.id, payment.id))
    .returning();
  return { handled: true as const, payment: updated! };
}

export async function getOwnedPayment(db: Executor, userId: string, paymentId: string) {
  const payment = await db.query.payments.findFirst({ where: and(eq(payments.id, paymentId), eq(payments.userId, userId)) });
  if (!payment) throw notFound("Payment");
  return payment;
}
