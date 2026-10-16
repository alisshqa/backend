import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { Executor } from "../db/client.js";
import { apps, paymentMethods, scheduleApps, schedules, type Schedule } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import {
  currentOrNextWindow,
  daysToMask,
  formatTime,
  maskToDays,
  parseTime,
  repeatLabel,
  windowDurationMinutes,
} from "../lib/schedule-time.js";
import { DEFAULT_SCHEDULE } from "./catalog.js";

export interface ScheduleInput {
  startTime: string;
  endTime: string;
  days: boolean[];
  penaltyCents: number;
  currency?: string;
  appIds: string[];
  isEnabled?: boolean;
}

export async function createDefaultSchedule(db: Executor, userId: string, at: Date) {
  await db.insert(schedules).values({
    userId,
    createdAt: at,
    updatedAt: at,
    startMinute: DEFAULT_SCHEDULE.startMinute,
    endMinute: DEFAULT_SCHEDULE.endMinute,
    daysMask: DEFAULT_SCHEDULE.daysMask,
    penaltyCents: DEFAULT_SCHEDULE.penaltyCents,
    currency: DEFAULT_SCHEDULE.currency,
    // Off until the user presses "Save my schedule": no promise is made on their behalf.
    isEnabled: false,
  });
  await db.insert(scheduleApps).values(DEFAULT_SCHEDULE.appIds.map((appId) => ({ userId, appId })));
}

export async function loadSchedule(db: Executor, userId: string) {
  const schedule = await db.query.schedules.findFirst({ where: eq(schedules.userId, userId) });
  if (!schedule) throw notFound("Schedule");
  const appRows = await db
    .select({ id: apps.id, name: apps.name, mark: apps.mark })
    .from(scheduleApps)
    .innerJoin(apps, eq(apps.id, scheduleApps.appId))
    .where(eq(scheduleApps.userId, userId))
    .orderBy(asc(apps.sortOrder));
  return { schedule, apps: appRows };
}

export async function hasPaymentMethod(db: Executor, userId: string) {
  const row = await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.userId, userId) });
  return Boolean(row);
}

export async function saveSchedule(ctx: AppContext, userId: string, input: ScheduleInput) {
  const startMinute = parseTime(input.startTime);
  const endMinute = parseTime(input.endTime);
  if (startMinute === endMinute) throw badRequest("INVALID_SCHEDULE", "Start and end time must differ");
  if (input.days.length !== 7) throw badRequest("INVALID_SCHEDULE", "days must contain 7 values (Mon…Sun)");

  const appIds = [...new Set(input.appIds)];
  const known = await ctx.db
    .select({ id: apps.id })
    .from(apps)
    .where(and(inArray(apps.id, appIds), eq(apps.isActive, true)));
  const unknown = appIds.filter((id) => !known.some((row) => row.id === id));
  if (unknown.length) throw badRequest("UNKNOWN_APPS", "Some apps are not in the catalog", { unknown });

  const isEnabled = input.isEnabled ?? true;
  if (isEnabled && input.penaltyCents > 0 && !(await hasPaymentMethod(ctx.db, userId))) {
    throw conflict(
      "PAYMENT_METHOD_REQUIRED",
      "Add a payment method before making a promise with a penalty",
    );
  }

  await ctx.db.transaction(async (tx) => {
    const values = {
      startMinute,
      endMinute,
      daysMask: daysToMask(input.days),
      penaltyCents: input.penaltyCents,
      currency: (input.currency ?? "USD").toUpperCase(),
      isEnabled,
      updatedAt: ctx.now(),
    };
    await tx
      .insert(schedules)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: schedules.userId, set: values });
    await tx.delete(scheduleApps).where(eq(scheduleApps.userId, userId));
    if (appIds.length) await tx.insert(scheduleApps).values(appIds.map((appId) => ({ userId, appId })));
  });
  return loadSchedule(ctx.db, userId);
}

export function scheduleDto(
  schedule: Schedule,
  appRows: { id: string; name: string; mark: string }[],
  timezone: string,
  now: Date,
) {
  const next = schedule.isEnabled ? currentOrNextWindow(schedule, timezone, now) : null;
  return {
    startTime: formatTime(schedule.startMinute),
    endTime: formatTime(schedule.endMinute),
    days: maskToDays(schedule.daysMask),
    repeatLabel: repeatLabel(schedule.daysMask),
    durationMinutes: windowDurationMinutes(schedule),
    penaltyCents: schedule.penaltyCents,
    currency: schedule.currency,
    appIds: appRows.map((app) => app.id),
    apps: appRows,
    isEnabled: schedule.isEnabled,
    nextWindow: next
      ? {
          startsAt: next.startsAt.toISOString(),
          endsAt: next.endsAt.toISOString(),
          nightDate: next.nightDate,
          inProgress: next.startsAt.getTime() <= now.getTime(),
        }
      : null,
    updatedAt: schedule.updatedAt.toISOString(),
  };
}
