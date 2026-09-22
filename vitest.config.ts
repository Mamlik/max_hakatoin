import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      APP_ENV: "test",
      MAX_MODE: "mock",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://salon:salon_local_only@localhost:5432/salon_test",
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6380",
      MAX_BOT_TOKEN: "demo-only-synthetic-token",
      MAX_WEBHOOK_SECRET: "demo-webhook-secret",
    },
  },
});
