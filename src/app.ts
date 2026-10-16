import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import type { Database } from "./db/client.js";
import { AppError } from "./lib/errors.js";
import { authPlugin } from "./plugins/auth.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { deviceRoutes } from "./routes/devices.js";
import { homeRoutes } from "./routes/home.js";
import { meRoutes } from "./routes/me.js";
import { paymentRoutes } from "./routes/payments.js";
import { scheduleRoutes } from "./routes/schedule.js";
import { sessionRoutes } from "./routes/sessions.js";
import { settingsRoutes } from "./routes/settings.js";
import { statsRoutes } from "./routes/stats.js";
import { webhookRoutes } from "./routes/webhooks.js";

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface BuildOptions {
  db: Database;
  config: Config;
  overrides?: Parameters<typeof createContext>[3];
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp({ db, config, overrides, logger }: BuildOptions) {
  const app = Fastify({
    logger: logger ?? {
      level: config.LOG_LEVEL ?? (config.NODE_ENV === "test" ? "silent" : "info"),
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("ctx", createContext(db, config, app.log, overrides));

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: {
            issues: error.validation.map((issue) => ({
              path: issue.instancePath.replace(/^\//, "").replaceAll("/", ".") || null,
              message: issue.message,
            })),
          },
        },
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, issues: error.cause.issues }, "response does not match schema");
      return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, "unhandled error");
    return reply.code(status).send({
      error: {
        code: status === 429 ? "RATE_LIMITED" : status >= 500 ? "INTERNAL" : "BAD_REQUEST",
        message: status >= 500 ? "Internal server error" : (error as Error).message,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: `Route ${request.method} ${request.url} not found` } }),
  );

  await app.register(cors, { origin: config.CORS_ORIGINS, credentials: true });
  await app.register(rateLimit, {
    global: false,
    // Tests fire hundreds of logins from one address.
    allowList: () => config.NODE_ENV === "test",
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "CLOUD API",
        description: "Backend for CLOUD — quiet hours, focus sessions, promise penalties and progress.",
        version: "1.0.0",
      },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(authPlugin);

  app.get("/health", { schema: { hide: true } }, async () => {
    await db.execute("select 1");
    return { status: "ok" };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(catalogRoutes);
      await api.register(meRoutes);
      await api.register(scheduleRoutes);
      await api.register(homeRoutes);
      await api.register(sessionRoutes);
      await api.register(statsRoutes);
      await api.register(settingsRoutes);
      await api.register(paymentRoutes);
      await api.register(deviceRoutes);
      await api.register(webhookRoutes);
    },
    { prefix: "/api/v1" },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
