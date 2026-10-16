import { randomUUID } from "node:crypto";
import { buildApp, type App } from "../src/app.js";
import { config } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { ensureAppCatalog } from "../src/services/catalog.js";
import type { PushMessage, PushSender } from "../src/services/push.js";

export class FakeClock {
  constructor(public current: Date) {}
  now = () => new Date(this.current);
  set(iso: string) {
    this.current = new Date(iso);
  }
  advance(minutes: number) {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export class RecordingPush implements PushSender {
  messages: PushMessage[] = [];
  async send(messages: PushMessage[]) {
    this.messages.push(...messages);
  }
  ofType(type: string) {
    return this.messages.filter((m) => m.data?.type === type);
  }
}

export interface TestEnv {
  app: App;
  clock: FakeClock;
  push: RecordingPush;
  close: () => Promise<void>;
}

export async function createTestEnv(startIso: string): Promise<TestEnv> {
  const { db, pool } = createDb(config.DATABASE_URL);
  await ensureAppCatalog(db);
  const clock = new FakeClock(new Date(startIso));
  const push = new RecordingPush();
  const app = await buildApp({ db, config, overrides: { now: clock.now, push } });
  await app.ready();
  return {
    app,
    clock,
    push,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export interface TestUser {
  id: string;
  token: string;
  refreshToken: string;
  headers: { authorization: string };
}

export async function registerUser(app: App, overrides: Partial<{ name: string; timezone: string }> = {}): Promise<TestUser> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name: overrides.name ?? "Alisher Zhumabekov",
      email: `user-${randomUUID()}@example.com`,
      password: "correct-horse-battery",
      timezone: overrides.timezone ?? "Asia/Almaty",
    },
  });
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`);
  const body = response.json();
  return {
    id: body.user.id,
    token: body.tokens.accessToken,
    refreshToken: body.tokens.refreshToken,
    headers: { authorization: `Bearer ${body.tokens.accessToken}` },
  };
}

export async function addCard(app: App, user: TestUser, id = "pm_mock_apple_2084") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/payment-methods",
    headers: user.headers,
    payload: { providerPaymentMethodId: id },
  });
  if (response.statusCode !== 201) throw new Error(`add card failed: ${response.body}`);
  return response.json();
}

export const weeknights = [true, true, true, true, true, false, false];

export async function saveSchedule(app: App, user: TestUser, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/schedule",
    headers: user.headers,
    payload: {
      startTime: "22:30",
      endTime: "07:00",
      days: weeknights,
      penaltyCents: 500,
      appIds: ["tiktok", "instagram", "youtube"],
      ...overrides,
    },
  });
}
