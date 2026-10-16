import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:8443,http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  PAYMENT_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  PUSH_PROVIDER: z.enum(["log", "expo"]).default("log"),
  EXPO_ACCESS_TOKEN: z.string().optional(),

  RUN_WORKER: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  WORKER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  // Treat empty strings from .env files as "not set".
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
  }
  const config = parsed.data;
  if (config.PAYMENT_PROVIDER === "stripe" && !config.STRIPE_SECRET_KEY) {
    throw new Error("PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY");
  }
  if (config.NODE_ENV === "production" && config.PAYMENT_PROVIDER === "mock") {
    console.warn("[config] PAYMENT_PROVIDER=mock in production: early-unlock penalties will NOT be charged.");
  }
  return config;
}

export const config = load();
