import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/cloud_test",
      JWT_SECRET: "test-secret-test-secret-test-secret-test-secret",
      PAYMENT_PROVIDER: "mock",
      PUSH_PROVIDER: "log",
      RUN_WORKER: "false",
    },
    // Test files share one database.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
