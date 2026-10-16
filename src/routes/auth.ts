import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { issueTokens, login, register, revokeRefreshToken, rotateRefreshToken } from "../services/auth.js";
import { userDto } from "./me.js";
import { authResponseSchema, errorSchema, timezoneString, tokensSchema } from "./schemas.js";

const credentials = {
  email: z.email().max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
};

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  // Brute-force protection for credential endpoints.
  const rateLimit = { max: 10, timeWindow: "1 minute" };

  app.post(
    "/auth/register",
    {
      config: { rateLimit },
      schema: {
        tags: ["auth"],
        summary: "Create an account",
        body: z.object({ name: z.string().trim().min(1).max(80), ...credentials, timezone: timezoneString.default("UTC") }),
        response: { 201: authResponseSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const user = await register(ctx, request.body);
      const tokens = await issueTokens(app, ctx, user.id, request.headers["user-agent"]);
      return reply.code(201).send({ user: userDto(user), tokens });
    },
  );

  app.post(
    "/auth/login",
    {
      config: { rateLimit },
      schema: {
        tags: ["auth"],
        summary: "Sign in with email and password",
        body: z.object({ email: credentials.email, password: z.string().min(1).max(128) }),
        response: { 200: authResponseSchema, 401: errorSchema },
      },
    },
    async (request) => {
      const user = await login(ctx, request.body.email, request.body.password);
      const tokens = await issueTokens(app, ctx, user.id, request.headers["user-agent"]);
      return { user: userDto(user), tokens };
    },
  );

  app.post(
    "/auth/refresh",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Exchange a refresh token for a new token pair (rotation)",
        body: z.object({ refreshToken: z.string().min(1) }),
        response: { 200: z.object({ tokens: tokensSchema }), 401: errorSchema },
      },
    },
    async (request) => ({
      tokens: await rotateRefreshToken(app, ctx, request.body.refreshToken, request.headers["user-agent"]),
    }),
  );

  app.post(
    "/auth/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Revoke a refresh token",
        body: z.object({ refreshToken: z.string().min(1) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await revokeRefreshToken(ctx, request.body.refreshToken);
      return reply.code(204).send(null);
    },
  );
};
