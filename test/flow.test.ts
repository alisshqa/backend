import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payments } from "../src/db/schema.js";
import { runWorkerTick } from "../src/worker/jobs.js";
import { addCard, createTestEnv, registerUser, saveSchedule, type TestEnv, type TestUser } from "./helpers.js";

/**
 * Almaty is UTC+5. Monday 2026-11-02:
 *   20:12 local = 15:12Z  (Home screen: 2h 18m until focus)
 *   22:30 local = 17:30Z  (quiet hours begin)
 *   07:00 Tue   = 02:00Z  (quiet hours end)
 */
const MON_2012 = "2026-11-02T15:12:00Z";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv(MON_2012);
});
afterAll(() => env.close());

const unlock = (user: TestUser, sessionId: string, key = randomUUID()) =>
  env.app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/unlock`,
    headers: { ...user.headers, "idempotency-key": key },
    payload: { confirm: true },
  });

describe("schedule", () => {
  it("needs a payment method before a promise with a penalty", async () => {
    env.clock.set(MON_2012);
    const user = await registerUser(env.app);
    const blocked = await saveSchedule(env.app, user);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("PAYMENT_METHOD_REQUIRED");

    // A free promise is allowed without a card.
    expect((await saveSchedule(env.app, user, { penaltyCents: 0 })).statusCode).toBe(200);

    const card = await addCard(env.app, user);
    expect(card).toMatchObject({ label: "Apple Pay •••• 2084", isDefault: true });
    const saved = await saveSchedule(env.app, user, { appIds: ["tiktok", "x"] });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      isEnabled: true,
      appIds: ["tiktok", "x"],
      nextWindow: { startsAt: "2026-11-02T17:30:00.000Z", inProgress: false },
    });
  });

  it("validates times, apps and amounts", async () => {
    const user = await registerUser(env.app);
    await addCard(env.app, user);
    expect((await saveSchedule(env.app, user, { startTime: "25:00" })).statusCode).toBe(400);
    expect((await saveSchedule(env.app, user, { appIds: [] })).statusCode).toBe(400);
    expect((await saveSchedule(env.app, user, { appIds: ["myspace"] })).json().error.code).toBe("UNKNOWN_APPS");
    expect((await saveSchedule(env.app, user, { penaltyCents: 20 })).statusCode).toBe(400);
    expect((await saveSchedule(env.app, user, { startTime: "07:00", endTime: "07:00" })).statusCode).toBe(400);
  });
});

describe("a night with CLOUD", () => {
  it("home → start focus → penalty quote → stay focused → morning", async () => {
    env.clock.set(MON_2012);
    const user = await registerUser(env.app);
    await addCard(env.app, user);
    await saveSchedule(env.app, user);

    const home = (await env.app.inject({ method: "GET", url: "/api/v1/home", headers: user.headers })).json();
    expect(home).toMatchObject({
      greeting: "Good evening",
      user: { firstName: "Alisher", initials: "AZ" },
      schedule: { startTime: "22:30", endTime: "07:00", isEnabled: true },
      nextWindow: { secondsUntilStart: 2 * 3600 + 18 * 60, inProgress: false },
      activeSession: null,
      today: { screenFreeMinutes: 0 },
    });

    // "Start focus mode" at 20:12 locks until 07:00
    const started = await env.app.inject({ method: "POST", url: "/api/v1/sessions", headers: user.headers, payload: {} });
    expect(started.statusCode).toBe(201);
    const session = started.json();
    expect(session).toMatchObject({
      status: "active",
      source: "manual",
      plannedEndAt: "2026-11-03T02:00:00.000Z",
      nightDate: "2026-11-02",
      penaltyCents: 500,
    });
    const again = await env.app.inject({ method: "POST", url: "/api/v1/sessions", headers: user.headers, payload: {} });
    expect(again.json().error.code).toBe("SESSION_ALREADY_ACTIVE");

    env.clock.advance(60);
    const active = (await env.app.inject({ method: "GET", url: "/api/v1/sessions/active", headers: user.headers })).json();
    expect(active.session.screenFreeMinutes).toBe(60);
    expect(active.session.remainingSeconds).toBe(session.remainingSeconds - 3600);

    const quote = await env.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${session.id}/unlock-quote`,
      headers: user.headers,
    });
    expect(quote.json()).toMatchObject({
      amountCents: 500,
      currency: "USD",
      requiresPayment: true,
      paymentMethod: { label: "Apple Pay •••• 2084" },
    });

    // "Stay focused" → nothing happens. Morning comes:
    env.clock.set("2026-11-03T02:01:00Z");
    const morning = (await env.app.inject({ method: "GET", url: "/api/v1/home", headers: user.headers })).json();
    expect(morning.activeSession).toBeNull();
    const done = (await env.app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}`, headers: user.headers })).json();
    expect(done).toMatchObject({ status: "completed", endedAt: "2026-11-03T02:00:00.000Z" });
    expect(done.screenFreeMinutes).toBe(10 * 60 + 48);

    const achievements = (await env.app.inject({ method: "GET", url: "/api/v1/achievements", headers: user.headers })).json();
    expect(achievements.achievements.find((a: { code: string }) => a.code === "first_night").unlocked).toBe(true);

    const overview = (await env.app.inject({ method: "GET", url: "/api/v1/stats/overview", headers: user.headers })).json();
    expect(overview).toMatchObject({
      weeklyGoal: { completedNights: 1, scheduledNights: 5 },
      month: { successfulNights: 1, moneyKeptCents: 500 },
      streak: { current: 1, longest: 1 },
    });
  });

  it("unlock early charges once, even when retried", async () => {
    env.clock.set(MON_2012);
    const user = await registerUser(env.app);
    await addCard(env.app, user);
    await saveSchedule(env.app, user);
    const session = (await env.app.inject({ method: "POST", url: "/api/v1/sessions", headers: user.headers, payload: {} })).json();

    const missingConfirm = await env.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/unlock`,
      headers: { ...user.headers, "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(missingConfirm.statusCode).toBe(400);

    const key = randomUUID();
    const first = await unlock(user, session.id, key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      outcome: "unlocked",
      session: { status: "unlocked_early" },
      payment: { amountCents: 500, status: "succeeded" },
    });
    const replay = await unlock(user, session.id, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().payment.id).toBe(first.json().payment.id);

    const otherKey = await unlock(user, session.id);
    expect(otherKey.statusCode).toBe(409);
    expect(otherKey.json().error.code).toBe("SESSION_NOT_ACTIVE");

    const week = (await env.app.inject({ method: "GET", url: "/api/v1/stats/week", headers: user.headers })).json();
    expect(week.days[0]).toMatchObject({ date: "2026-11-02", letter: "M", status: "broken" });
  });

  it("declined card keeps the session locked", async () => {
    env.clock.set(MON_2012);
    const user = await registerUser(env.app);
    await addCard(env.app, user, "pm_mock_decline_0002");
    await saveSchedule(env.app, user);
    const session = (await env.app.inject({ method: "POST", url: "/api/v1/sessions", headers: user.headers, payload: {} })).json();

    const declined = await unlock(user, session.id);
    expect(declined.statusCode).toBe(402);
    expect(declined.json().error.code).toBe("PAYMENT_FAILED");
    const active = (await env.app.inject({ method: "GET", url: "/api/v1/sessions/active", headers: user.headers })).json();
    expect(active.session.id).toBe(session.id);
  });

  it("3-D Secure: 202 with client secret, then the webhook unlocks", async () => {
    env.clock.set(MON_2012);
    const user = await registerUser(env.app);
    await addCard(env.app, user, "pm_mock_3ds_3155");
    await saveSchedule(env.app, user);
    const session = (await env.app.inject({ method: "POST", url: "/api/v1/sessions", headers: user.headers, payload: {} })).json();

    const pending = await unlock(user, session.id);
    expect(pending.statusCode).toBe(202);
    const body = pending.json();
    expect(body.outcome).toBe("requires_action");
    expect(body.clientSecret).toContain("secret");

    // A second tap must not create a second charge.
    const second = await unlock(user, session.id);
    expect(second.statusCode).toBe(202);
    expect(second.json().payment.id).toBe(body.payment.id);

    const payment = (await env.app.inject({ method: "GET", url: `/api/v1/payments/${body.payment.id}`, headers: user.headers })).json();
    expect(payment.status).toBe("requires_action");

    const unknown = await env.app.inject({
      method: "POST",
      url: "/api/v1/webhooks/mock",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "payment.succeeded", providerPaymentId: "pi_unknown" }),
    });
    expect(unknown.json()).toEqual({ received: true, handled: false });

    // The device finishes 3-D Secure; the provider calls the webhook.
    const row = await env.app.ctx.db.query.payments.findFirst({ where: eq(payments.id, body.payment.id) });
    const settle = await env.app.inject({
      method: "POST",
      url: "/api/v1/webhooks/mock",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "payment.succeeded", providerPaymentId: row!.providerPaymentId }),
    });
    expect(settle.json()).toEqual({ received: true, handled: true });

    const settled = (await env.app.inject({ method: "GET", url: `/api/v1/payments/${body.payment.id}`, headers: user.headers })).json();
    expect(settled.status).toBe("succeeded");
    const after = (await env.app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}`, headers: user.headers })).json();
    expect(after.status).toBe("unlocked_early");
  });

  it("free promise unlocks without a payment", async () => {
    env.clock.set(MON_2012);
    const user = await registerUser(env.app);
    await saveSchedule(env.app, user, { penaltyCents: 0 });
    const session = (await env.app.inject({ method: "POST", url: "/api/v1/sessions", headers: user.headers, payload: {} })).json();
    const response = await unlock(user, session.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: "unlocked", payment: null });
  });
});

describe("background worker", () => {
  it("reminds, starts, completes and celebrates", async () => {
    env.clock.set("2026-11-02T10:00:00Z"); // Monday 15:00 local
    const user = await registerUser(env.app);
    await addCard(env.app, user);
    await saveSchedule(env.app, user);
    await env.app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: user.headers,
      payload: { platform: "ios", pushToken: `ExponentPushToken[${randomUUID()}]` },
    });
    const mine = () => env.push.messages.filter((m) => m.to.includes("ExponentPushToken"));
    const before = env.push.messages.length;

    // 22:20 local — wind-down reminder (15 minutes before), only once
    env.clock.set("2026-11-02T17:20:00Z");
    await runWorkerTick(env.app.ctx);
    await runWorkerTick(env.app.ctx);
    const windDown = env.push.messages.slice(before).filter((m) => m.data?.type === "wind_down");
    expect(windDown.length).toBeGreaterThanOrEqual(1);
    expect(new Set(windDown.map((m) => m.data?.nightDate))).toEqual(new Set(["2026-11-02"]));
    expect(mine().filter((m) => m.data?.type === "wind_down")).toHaveLength(1);

    // 22:30 — the scheduled session starts by itself
    env.clock.set("2026-11-02T17:30:30Z");
    await runWorkerTick(env.app.ctx);
    const active = (await env.app.inject({ method: "GET", url: "/api/v1/sessions/active", headers: user.headers })).json();
    expect(active.session).toMatchObject({ source: "scheduled", plannedEndAt: "2026-11-03T02:00:00.000Z" });
    await runWorkerTick(env.app.ctx);
    const list = (await env.app.inject({ method: "GET", url: "/api/v1/sessions", headers: user.headers })).json();
    expect(list.sessions).toHaveLength(1);

    // 07:00 Tuesday — completed, "Good morning" push, milestone push
    env.clock.set("2026-11-03T02:00:30Z");
    await runWorkerTick(env.app.ctx);
    const pushes = mine().map((m) => m.data?.type);
    expect(pushes).toEqual(expect.arrayContaining(["wind_down", "session_started", "session_completed", "achievement"]));
  });

  it("does not lock instantly when the schedule is saved mid-window", async () => {
    env.clock.set("2026-11-02T18:00:00Z"); // Monday 23:00 local — window already running
    const user = await registerUser(env.app);
    await addCard(env.app, user);
    await saveSchedule(env.app, user);
    await runWorkerTick(env.app.ctx);
    const active = (await env.app.inject({ method: "GET", url: "/api/v1/sessions/active", headers: user.headers })).json();
    expect(active.session).toBeNull();
  });
});

describe("progress over a week", () => {
  it("streak, ring, money kept and the chart", async () => {
    env.clock.set("2026-11-02T10:00:00Z");
    const user = await registerUser(env.app);
    await addCard(env.app, user);
    await saveSchedule(env.app, user);

    // Mon…Thu kept, Friday unlocked early.
    for (let day = 0; day < 5; day++) {
      const evening = new Date(Date.UTC(2026, 10, 2 + day, 17, 30, 30));
      env.clock.set(evening.toISOString());
      await runWorkerTick(env.app.ctx);
      if (day === 4) {
        env.clock.advance(90);
        const active = (await env.app.inject({ method: "GET", url: "/api/v1/sessions/active", headers: user.headers })).json();
        expect((await unlock(user, active.session.id)).statusCode).toBe(200);
      }
      env.clock.set(new Date(evening.getTime() + 9 * 3_600_000).toISOString());
      await runWorkerTick(env.app.ctx);
    }

    env.clock.set("2026-11-07T07:00:00Z"); // Saturday noon
    const overview = (await env.app.inject({ method: "GET", url: "/api/v1/stats/overview", headers: user.headers })).json();
    expect(overview).toMatchObject({
      weeklyGoal: { completedNights: 4, scheduledNights: 5 },
      month: { successfulNights: 4, moneyKeptCents: 2000 },
      streak: { current: 0, longest: 4 },
    });

    const week = (await env.app.inject({ method: "GET", url: "/api/v1/stats/week", headers: user.headers })).json();
    expect(week.label).toBe("Nov 2 – 8");
    expect(week.days.map((d: { status: string | null }) => d.status)).toEqual([
      "kept",
      "kept",
      "kept",
      "kept",
      "broken",
      null,
      null,
    ]);
    expect(week.days[0].hours).toBe(8.5);
    expect(week.days[4].minutes).toBe(90);

    const achievements = (await env.app.inject({ method: "GET", url: "/api/v1/achievements", headers: user.headers })).json();
    const unlocked = achievements.achievements.filter((a: { unlocked: boolean }) => a.unlocked).map((a: { code: string }) => a.code);
    expect(unlocked).toEqual(["first_night", "nights_3", "streak_3"]);
  });
});

describe("settings", () => {
  it("reads defaults and patches", async () => {
    const user = await registerUser(env.app);
    const defaults = (await env.app.inject({ method: "GET", url: "/api/v1/settings", headers: user.headers })).json();
    expect(defaults).toEqual({
      notificationsEnabled: true,
      windDownEnabled: true,
      windDownMinutes: 15,
      textScale: 1,
      reduceMotion: false,
      highContrast: false,
      emergencyAppIds: [],
    });
    const patched = await env.app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: user.headers,
      payload: { windDownEnabled: false, textScale: 1.2, emergencyAppIds: ["com.apple.Maps"] },
    });
    expect(patched.json()).toMatchObject({ windDownEnabled: false, textScale: 1.2, emergencyAppIds: ["com.apple.Maps"] });
  });

  it("lists the app catalog and payment methods", async () => {
    const user = await registerUser(env.app);
    const apps = (await env.app.inject({ method: "GET", url: "/api/v1/apps" })).json();
    expect(apps.apps.slice(0, 4).map((a: { name: string }) => a.name)).toEqual(["TikTok", "Instagram", "YouTube", "X"]);

    const first = await addCard(env.app, user);
    const second = await addCard(env.app, user, "pm_mock_card_4242");
    const list = (await env.app.inject({ method: "GET", url: "/api/v1/payment-methods", headers: user.headers })).json();
    expect(list.paymentMethods.map((m: { label: string }) => m.label)).toEqual(["Visa •••• 4242", "Apple Pay •••• 2084"]);

    await env.app.inject({ method: "POST", url: `/api/v1/payment-methods/${first.id}/default`, headers: user.headers });
    await env.app.inject({ method: "DELETE", url: `/api/v1/payment-methods/${first.id}`, headers: user.headers });
    const after = (await env.app.inject({ method: "GET", url: "/api/v1/payment-methods", headers: user.headers })).json();
    expect(after.paymentMethods).toEqual([expect.objectContaining({ id: second.id, isDefault: true })]);
  });
});
