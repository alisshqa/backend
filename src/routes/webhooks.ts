import type { FastifyPluginAsync } from "fastify";
import { handlePaymentWebhook } from "../services/payments/service.js";

/** Provider webhooks. Bodies are kept raw so signatures can be verified. */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  const handler = (expected: "stripe" | "mock") => async (request: { body: unknown; headers: Record<string, unknown> }) => {
    if (ctx.payments.name !== expected) return { received: false };
    const signature = request.headers["stripe-signature"];
    const event = ctx.payments.parseWebhook(request.body as Buffer, typeof signature === "string" ? signature : undefined);
    if (!event) return { received: true };
    const result = await handlePaymentWebhook(ctx, event);
    return { received: true, handled: result.handled };
  };

  app.post("/webhooks/stripe", { schema: { hide: true } }, handler("stripe"));
  // Lets you finish a "3-D Secure" mock payment during development:
  //   POST /webhooks/mock {"type":"payment.succeeded","providerPaymentId":"pi_mock_…"}
  app.post("/webhooks/mock", { schema: { hide: true } }, handler("mock"));
};
