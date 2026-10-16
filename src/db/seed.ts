/**
 * Demo data: the user from the design (Alisher) with ~6 weeks of nights, so every screen has
 * something to show. Idempotent — re-running replaces the demo user.
 *
 *   email:    demo@cloud.app
 *   password: cloud-demo-2026
 */
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Config } from "../config.js";
import type { AppContext } from "../context.js";
import { hashPassword } from "../lib/password.js";
import { evaluateAchievements } from "../services/achievements.js";
import { MockPaymentProvider } from "../services/payments/mock.js";
import { isActiveOn, windowForDate } from "../lib/schedule-time.js";
import { ensureAppCatalog, DEFAULT_SCHEDULE } from "../services/catalog.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import { focusSessions, paymentMethods, payments, scheduleApps, schedules, users, userSettings } from "./schema.js";

const EMAIL = "demo@cloud.app";
const PASSWORD = "cloud-demo-2026";
const TIMEZONE = "Asia/Almaty";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
await runMigrations(url);
const { db, pool } = createDb(url);
await ensureAppCatalog(db);

await db.delete(users).where(eq(users.email, EMAIL));

const now = DateTime.now().setZone(TIMEZONE);
const createdAt = now.minus({ days: 45 }).startOf("day");

const [user] = await db
  .insert(users)
  .values({
    email: EMAIL,
    name: "Alisher Zhumabekov",
    passwordHash: await hashPassword(PASSWORD),
    timezone: TIMEZONE,
    createdAt: createdAt.toJSDate(),
  })
  .returning();
const userId = user!.id;

await db.insert(userSettings).values({ userId });
await db.insert(schedules).values({
  userId,
  startMinute: DEFAULT_SCHEDULE.startMinute,
  endMinute: DEFAULT_SCHEDULE.endMinute,
  daysMask: DEFAULT_SCHEDULE.daysMask,
  penaltyCents: DEFAULT_SCHEDULE.penaltyCents,
  currency: DEFAULT_SCHEDULE.currency,
  isEnabled: true,
  createdAt: createdAt.toJSDate(),
  updatedAt: createdAt.toJSDate(),
});
await db.insert(scheduleApps).values(DEFAULT_SCHEDULE.appIds.map((appId) => ({ userId, appId })));
const [method] = await db
  .insert(paymentMethods)
  .values({
    userId,
    provider: "mock",
    providerPaymentMethodId: "pm_mock_apple_2084",
    brand: "visa",
    last4: "2084",
    wallet: "apple_pay",
    isDefault: true,
  })
  .returning();

// Deterministic pseudo-random so the demo looks the same every time.
let seed = 42;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const rule = { startMinute: DEFAULT_SCHEDULE.startMinute, endMinute: DEFAULT_SCHEDULE.endMinute, daysMask: DEFAULT_SCHEDULE.daysMask };
let count = 0;
for (let day = createdAt.plus({ days: 1 }); day < now.startOf("day"); day = day.plus({ days: 1 })) {
  const daysAgo = Math.floor(now.diff(day, "days").days);
  const scheduled = isActiveOn(rule.daysMask, day.weekday);
  // Weekends: an occasional manual evening session.
  if (!scheduled && random() > 0.35) continue;

  const window = windowForDate(rule, day);
  const startShift = Math.round((random() - 0.6) * 90); // sometimes start early
  const startedAt = new Date(window.startsAt.getTime() + startShift * 60_000);
  const plannedEndAt = scheduled ? window.endsAt : new Date(startedAt.getTime() + (2 + random() * 3) * 3_600_000);
  // One broken promise ~2 weeks ago, one missed night ~3 weeks ago; the last 7+ nights kept.
  if (scheduled && daysAgo === 22) continue;
  const broken = scheduled && daysAgo === 15;
  const endedAt = broken ? new Date(startedAt.getTime() + 95 * 60_000) : plannedEndAt;

  const [session] = await db
    .insert(focusSessions)
    .values({
      userId,
      status: broken ? "unlocked_early" : "completed",
      source: scheduled && startShift >= 0 ? "scheduled" : "manual",
      startedAt,
      plannedEndAt,
      endedAt,
      nightDate: window.nightDate,
      penaltyCents: DEFAULT_SCHEDULE.penaltyCents,
      currency: DEFAULT_SCHEDULE.currency,
      appIds: [...DEFAULT_SCHEDULE.appIds],
      createdAt: startedAt,
    })
    .returning();
  if (broken) {
    await db.insert(payments).values({
      userId,
      sessionId: session!.id,
      paymentMethodId: method!.id,
      amountCents: DEFAULT_SCHEDULE.penaltyCents,
      currency: DEFAULT_SCHEDULE.currency,
      status: "succeeded",
      provider: "mock",
      providerPaymentId: `pi_mock_seed_${session!.id}`,
      idempotencyKey: `seed-${session!.id}`,
      createdAt: endedAt,
    });
  }
  count++;
}

// Unlock the milestones the history has earned (no pushes: the demo user has no devices).
const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return silent; }, level: "silent" };
await evaluateAchievements(
  {
    db,
    config: {} as Config,
    log: silent as unknown as AppContext["log"],
    payments: new MockPaymentProvider(),
    push: { send: async () => {} },
    now: () => new Date(),
  },
  userId,
);

console.log(`Seeded ${EMAIL} / ${PASSWORD} with ${count} sessions`);
await pool.end();
