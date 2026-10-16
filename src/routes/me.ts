import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { users, type User } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { firstName, initials } from "../lib/format.js";
import { verifyPassword } from "../lib/password.js";
import { changePassword } from "../services/auth.js";
import { errorSchema, timezoneString, userSchema } from "./schemas.js";

export function userDto(user: User) {
  return {
    id: user.id,
    name: user.name,
    firstName: firstName(user.name),
    initials: initials(user.name),
    email: user.email,
    timezone: user.timezone,
    createdAt: user.createdAt.toISOString(),
  };
}

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook("onRequest", app.authenticate);

  app.get(
    "/me",
    { schema: { tags: ["profile"], summary: "Current user (avatar initials, greeting name)", response: { 200: userSchema } } },
    async (request) => userDto(request.currentUser),
  );

  app.patch(
    "/me",
    {
      schema: {
        tags: ["profile"],
        summary: "Update name or time zone",
        body: z.object({ name: z.string().trim().min(1).max(80).optional(), timezone: timezoneString.optional() }),
        response: { 200: userSchema },
      },
    },
    async (request) => {
      const [user] = await ctx.db.update(users).set(request.body).where(eq(users.id, request.currentUser.id)).returning();
      return userDto(user!);
    },
  );

  app.post(
    "/me/password",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["profile"],
        summary: "Change password (signs out other devices)",
        body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }),
        response: { 204: z.null(), 401: errorSchema },
      },
    },
    async (request, reply) => {
      await changePassword(ctx, request.currentUser, request.body.currentPassword, request.body.newPassword);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/me",
    {
      schema: {
        tags: ["profile"],
        summary: "Delete the account and all its data",
        body: z.object({ password: z.string().min(1) }),
        response: { 204: z.null(), 401: errorSchema },
      },
    },
    async (request, reply) => {
      const user = request.currentUser;
      if (!(await verifyPassword(request.body.password, user.passwordHash))) {
        throw new AppError(401, "INVALID_CREDENTIALS", "Password is incorrect");
      }
      const methods = await ctx.db.query.paymentMethods.findMany({ where: (pm, { eq }) => eq(pm.userId, user.id) });
      for (const method of methods) await ctx.payments.detachPaymentMethod(method.providerPaymentMethodId);
      await ctx.db.delete(users).where(eq(users.id, user.id));
      return reply.code(204).send(null);
    },
  );
};
