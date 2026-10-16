import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { paymentDto, unlockEarly, unlockQuote } from "../services/payments/service.js";
import {
  completeExpiredSessions,
  getActiveSession,
  getOwnedSession,
  listSessions,
  sessionDto,
  startManualSession,
} from "../services/sessions.js";
import { errorSchema, idParam, paymentMethodSchema, paymentSchema, sessionSchema } from "./schemas.js";

export const sessionRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook("onRequest", app.authenticate);

  app.post(
    "/sessions",
    {
      schema: {
        tags: ["sessions"],
        summary: '"Start focus mode" — locks until the end of tonight\'s quiet hours',
        body: z
          .object({
            durationMinutes: z
              .number()
              .int()
              .min(5)
              .max(16 * 60)
              .optional()
              .describe("One-off length; omit to lock until the end of the current/next scheduled window"),
          })
          .default({}),
        response: { 201: sessionSchema, 400: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const session = await startManualSession(ctx, request.currentUser, request.body);
      return reply.code(201).send(sessionDto(session, ctx.now()));
    },
  );

  app.get(
    "/sessions/active",
    {
      schema: {
        tags: ["sessions"],
        summary: "The running session (Locked screen countdown), or null",
        response: { 200: z.object({ session: sessionSchema.nullable() }) },
      },
    },
    async (request) => {
      await completeExpiredSessions(ctx, request.currentUser.id);
      const session = await getActiveSession(ctx.db, request.currentUser.id);
      return { session: session ? sessionDto(session, ctx.now()) : null };
    },
  );

  app.get(
    "/sessions",
    {
      schema: {
        tags: ["sessions"],
        summary: "Session history, newest first",
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          before: z.iso.datetime({ offset: true }).optional().describe("Cursor: startedAt of the last item"),
        }),
        response: { 200: z.object({ sessions: z.array(sessionSchema), nextCursor: z.string().nullable() }) },
      },
    },
    async (request) => {
      await completeExpiredSessions(ctx, request.currentUser.id);
      const rows = await listSessions(ctx.db, request.currentUser.id, request.query);
      const now = ctx.now();
      return {
        sessions: rows.map((s) => sessionDto(s, now)),
        nextCursor: rows.length === request.query.limit ? rows[rows.length - 1]!.startedAt.toISOString() : null,
      };
    },
  );

  app.get(
    "/sessions/:id",
    { schema: { tags: ["sessions"], params: idParam, response: { 200: sessionSchema, 404: errorSchema } } },
    async (request) => {
      await completeExpiredSessions(ctx, request.currentUser.id);
      return sessionDto(await getOwnedSession(ctx.db, request.currentUser.id, request.params.id), ctx.now());
    },
  );

  app.get(
    "/sessions/:id/unlock-quote",
    {
      schema: {
        tags: ["sessions"],
        summary: "Penalty screen: agreed penalty and the payment method that will be charged",
        params: idParam,
        response: {
          200: z.object({
            session: sessionSchema,
            amountCents: z.number().int(),
            currency: z.string(),
            paymentMethod: paymentMethodSchema.nullable(),
            requiresPayment: z.boolean(),
          }),
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request) => {
      const quote = await unlockQuote(ctx, request.currentUser, request.params.id);
      return quote;
    },
  );

  app.post(
    "/sessions/:id/unlock",
    {
      schema: {
        tags: ["sessions"],
        summary: '"Unlock and pay" — charges the promise amount and ends the session',
        description:
          "Requires an `Idempotency-Key` header (any unique string per user action, e.g. a UUID). " +
          "Retrying with the same key never charges twice. Responses: 200 unlocked; 202 the card needs " +
          "3-D Secure — confirm `clientSecret` with the payment SDK, then poll GET /payments/:id; 402 declined.",
        params: idParam,
        headers: z.object({ "idempotency-key": z.string().min(8).max(255) }),
        body: z.object({ confirm: z.literal(true).describe("Explicit confirmation from the Penalty screen") }),
        response: {
          200: z.object({ outcome: z.literal("unlocked"), session: sessionSchema, payment: paymentSchema.nullable() }),
          202: z.object({
            outcome: z.literal("requires_action"),
            session: sessionSchema,
            payment: paymentSchema,
            clientSecret: z.string(),
          }),
          402: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await unlockEarly(ctx, request.currentUser, request.params.id, request.headers["idempotency-key"]);
      const now = ctx.now();
      if (result.outcome === "unlocked") {
        return reply.code(200).send({
          outcome: "unlocked" as const,
          session: sessionDto(result.session, now),
          payment: result.payment ? paymentDto(result.payment) : null,
        });
      }
      if (result.outcome === "requires_action") {
        return reply.code(202).send({
          outcome: "requires_action" as const,
          session: sessionDto(result.session, now),
          payment: paymentDto(result.payment),
          clientSecret: result.clientSecret,
        });
      }
      throw new AppError(402, "PAYMENT_FAILED", result.payment.failureReason ?? "Payment failed", {
        payment: paymentDto(result.payment),
      });
    },
  );
};
