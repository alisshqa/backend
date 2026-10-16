import fastifyJwt from "@fastify/jwt";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { users, type User } from "../db/schema.js";
import { unauthorized } from "../lib/errors.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    currentUser: User;
  }
}

/** Bearer-token auth. Routes opt in with `onRequest: app.authenticate`. */
export const authPlugin = fp(async (app) => {
  await app.register(fastifyJwt, { secret: app.ctx.config.JWT_SECRET });
  app.decorateRequest("currentUser", null as unknown as User);
  app.decorate("authenticate", async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized("Invalid or expired access token");
    }
    const user = await app.ctx.db.query.users.findFirst({ where: eq(users.id, request.user.sub) });
    if (!user) throw unauthorized("Account no longer exists");
    request.currentUser = user;
  });
});
