import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { schedules, users, userSettings } from "../db/schema.js";
import { currentOrNextWindow, formatTime } from "../lib/schedule-time.js";
import { notifyUser } from "../services/notifications.js";
import { completeExpiredSessions, startScheduledSessions } from "../services/sessions.js";

/** "Wind-down reminder — 15 minutes before focus". Sent once per night. */
export async function sendWindDownReminders(ctx: AppContext) {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ schedule: schedules, user: users, settings: userSettings })
    .from(schedules)
    .innerJoin(users, eq(users.id, schedules.userId))
    .innerJoin(userSettings, eq(userSettings.userId, schedules.userId))
    .where(eq(schedules.isEnabled, true));

  let sent = 0;
  for (const { schedule, user, settings } of rows) {
    if (!settings.notificationsEnabled || !settings.windDownEnabled) continue;
    const window = currentOrNextWindow(schedule, user.timezone, now);
    if (!window) continue;
    const msUntil = window.startsAt.getTime() - now.getTime();
    if (msUntil <= 0 || msUntil > settings.windDownMinutes * 60_000) continue;
    const delivered = await notifyUser(ctx, user.id, {
      title: "Time to wind down",
      body: `Your quiet hours begin at ${formatTime(schedule.startMinute)}. Start settling in.`,
      data: { type: "wind_down", nightDate: window.nightDate },
      dedupe: { kind: "wind_down", key: window.nightDate },
    });
    if (delivered) sent++;
  }
  return sent;
}

export async function runWorkerTick(ctx: AppContext) {
  const completed = await completeExpiredSessions(ctx);
  const started = await startScheduledSessions(ctx);
  const reminders = await sendWindDownReminders(ctx);
  return { completed: completed.length, started: started.length, reminders };
}

/** Simple in-process scheduler. For several API replicas run it in one place only (RUN_WORKER). */
export function startWorker(ctx: AppContext, intervalSeconds: number) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runWorkerTick(ctx);
      if (result.completed || result.started || result.reminders) ctx.log.info({ worker: result }, "worker tick");
    } catch (error) {
      ctx.log.error({ err: error }, "worker tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalSeconds * 1000);
  void tick();
  return () => clearInterval(timer);
}
