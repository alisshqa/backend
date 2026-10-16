import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  addPaymentMethod,
  createSetupIntent,
  getOwnedPayment,
  listPaymentMethods,
  paymentDto,
  paymentMethodDto,
  removePaymentMethod,
  setDefaultPaymentMethod,
} from "../services/payments/service.js";
import { errorSchema, idParam, paymentMethodSchema, paymentSchema } from "./schemas.js";

export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook("onRequest", app.authenticate);

  app.get(
    "/payment-methods",
    {
      schema: {
        tags: ["payments"],
        summary: "Saved payment methods, default first",
        response: { 200: z.object({ paymentMethods: z.array(paymentMethodSchema) }) },
      },
    },
    async (request) => ({
      paymentMethods: (await listPaymentMethods(ctx.db, request.currentUser.id)).map(paymentMethodDto),
    }),
  );

  app.post(
    "/payment-methods/setup-intent",
    {
      schema: {
        tags: ["payments"],
        summary: "Start saving Apple Pay / Google Pay / a card with the payment SDK on the device",
        response: {
          200: z.object({ provider: z.enum(["mock", "stripe"]), clientSecret: z.string(), customerId: z.string().nullable() }),
        },
      },
    },
    async (request) => createSetupIntent(ctx, request.currentUser),
  );

  app.post(
    "/payment-methods",
    {
      schema: {
        tags: ["payments"],
        summary: "Register a payment method saved through the SetupIntent",
        body: z.object({
          providerPaymentMethodId: z.string().min(3).max(255).describe("Stripe pm_… id (or pm_mock_apple_2084 in mock mode)"),
          makeDefault: z.boolean().optional(),
        }),
        response: { 201: paymentMethodSchema, 400: errorSchema, 403: errorSchema },
      },
    },
    async (request, reply) => {
      const method = await addPaymentMethod(ctx, request.currentUser, request.body);
      return reply.code(201).send(paymentMethodDto(method));
    },
  );

  app.post(
    "/payment-methods/:id/default",
    { schema: { tags: ["payments"], params: idParam, response: { 200: paymentMethodSchema, 404: errorSchema } } },
    async (request) => paymentMethodDto(await setDefaultPaymentMethod(ctx, request.currentUser.id, request.params.id)),
  );

  app.delete(
    "/payment-methods/:id",
    { schema: { tags: ["payments"], params: idParam, response: { 204: z.null(), 404: errorSchema } } },
    async (request, reply) => {
      await removePaymentMethod(ctx, request.currentUser.id, request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/payments/:id",
    {
      schema: {
        tags: ["payments"],
        summary: "Poll a penalty payment after 3-D Secure",
        params: idParam,
        response: { 200: paymentSchema, 404: errorSchema },
      },
    },
    async (request) => paymentDto(await getOwnedPayment(ctx.db, request.currentUser.id, request.params.id)),
  );
};
