import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { devices } from "../db/schema.js";

export const deviceRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook("onRequest", app.authenticate);

  app.post(
    "/devices",
    {
      schema: {
        tags: ["notifications"],
        summary: "Register a push token (call on every app launch)",
        body: z.object({ platform: z.enum(["ios", "android", "web"]), pushToken: z.string().min(10).max(4096) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { platform, pushToken } = request.body;
      // A token moves to whoever is signed in on that phone now.
      await ctx.db
        .insert(devices)
        .values({ userId: request.currentUser.id, platform, pushToken })
        .onConflictDoUpdate({
          target: devices.pushToken,
          set: { userId: request.currentUser.id, platform, lastSeenAt: ctx.now() },
        });
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/devices",
    {
      schema: {
        tags: ["notifications"],
        summary: "Unregister a push token (on sign-out)",
        body: z.object({ pushToken: z.string().min(1) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await ctx.db
        .delete(devices)
        .where(and(eq(devices.userId, request.currentUser.id), eq(devices.pushToken, request.body.pushToken)));
      return reply.code(204).send(null);
    },
  );
};
