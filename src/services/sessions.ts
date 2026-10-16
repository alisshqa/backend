import { and, desc, eq, gt, lt, lte, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { Executor } from "../db/client.js";
import { focusSessions, schedules, users, type FocusSession, type User } from "../db/schema.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import { activeWindow, currentOrNextWindow, nightDateOf } from "../lib/schedule-time.js";
import { evaluateAchievements } from "./achievements.js";
import { notifyUser } from "./notifications.js";
import { hasPaymentMethod, loadSchedule } from "./schedule.js";
import { sessionMinutes } from "./stats.js";

/** A manual "Start focus mode" locks until the end of tonight's window if it starts within this many hours. */
const MANUAL_START_LOOKAHEAD_HOURS = 12;

export function sessionDto(session: FocusSession, now: Date) {
  const remainingMs = session.status === "active" ? Math.max(session.plannedEndAt.getTime() - now.getTime(), 0) : 0;
  return {
    id: session.id,
    status: session.status,
    source: session.source,
    startedAt: session.startedAt.toISOString(),
    plannedEndAt: session.plannedEndAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    nightDate: session.nightDate,
    penaltyCents: session.penaltyCents,
    currency: session.currency,
    appIds: session.appIds,
    remainingSeconds: Math.floor(remainingMs / 1000),
    screenFreeMinutes: Math.round(sessionMinutes(session, now)),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const pgError = (error as { cause?: { code?: string }; code?: string }) ?? {};
  return pgError.code === "23505" || pgError.cause?.code === "23505";
}

/**
 * Marks sessions whose planned end has passed as completed (the promise was kept).
 * Called by the worker for everyone and lazily by read endpoints for the current user,
 * so the API stays correct even if the worker is not running.
 */
export async function completeExpiredSessions(ctx: AppContext, userId?: string) {
  const now = ctx.now();
  const completed = await ctx.db
    .update(focusSessions)
    .set({ status: "completed", endedAt: sql`${focusSessions.plannedEndAt}`, updatedAt: now })
    .where(
      and(
        eq(focusSessions.status, "active"),
        lte(focusSessions.plannedEndAt, now),
        userId ? eq(focusSessions.userId, userId) : undefined,
      ),
    )
    .returning();

  for (const session of completed) {
    await notifyUser(ctx, session.userId, {
      title: "Good morning",
      body: "You protected your night. Your apps are available again.",
      data: { type: "session_completed", sessionId: session.id },
      dedupe: { kind: "session_completed", key: session.id },
    });
    await evaluateAchievements(ctx, session.userId);
  }
  return completed;
}

export async function getActiveSession(db: Executor, userId: string) {
  return (
    (await db.query.focusSessions.findFirst({
      where: and(eq(focusSessions.userId, userId), eq(focusSessions.status, "active")),
    })) ?? null
  );
}

export async function getOwnedSession(db: Executor, userId: string, sessionId: string) {
  const session = await db.query.focusSessions.findFirst({
    where: and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId)),
  });
  if (!session) throw notFound("Session");
  return session;
}

/** "Start focus mode" on the Home screen. */
export async function startManualSession(ctx: AppContext, user: User, input: { durationMinutes?: number }) {
  const now = ctx.now();
  await completeExpiredSessions(ctx, user.id);
  if (await getActiveSession(ctx.db, user.id)) {
    throw conflict("SESSION_ALREADY_ACTIVE", "A focus session is already in progress");
  }
  const { schedule, apps } = await loadSchedule(ctx.db, user.id);
  if (!apps.length) throw badRequest("NO_APPS_SELECTED", "Choose at least one app to restrict");

  let plannedEndAt: Date;
  let nightDate: string;
  if (input.durationMinutes) {
    plannedEndAt = new Date(now.getTime() + input.durationMinutes * 60_000);
    nightDate = nightDateOf(now, user.timezone);
  } else {
    const window = currentOrNextWindow(schedule, user.timezone, now);
    const startsSoon =
      window && window.startsAt.getTime() - now.getTime() <= MANUAL_START_LOOKAHEAD_HOURS * 3_600_000;
    if (!window || !startsSoon) {
      throw badRequest(
        "DURATION_REQUIRED",
        "No quiet hours start soon — pass durationMinutes to start a one-off session",
      );
    }
    plannedEndAt = window.endsAt;
    nightDate = window.nightDate;
  }

  if (schedule.penaltyCents > 0 && !(await hasPaymentMethod(ctx.db, user.id))) {
    throw conflict("PAYMENT_METHOD_REQUIRED", "Add a payment method before starting a session with a penalty");
  }

  try {
    const [session] = await ctx.db
      .insert(focusSessions)
      .values({
        userId: user.id,
        source: "manual",
        status: "active",
        startedAt: now,
        plannedEndAt,
        nightDate,
        penaltyCents: schedule.penaltyCents,
        currency: schedule.currency,
        appIds: apps.map((app) => app.id),
      })
      .returning();
    return session!;
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("SESSION_ALREADY_ACTIVE", "A focus session is already in progress");
    throw error;
  }
}

/**
 * Worker job: start a session for every enabled schedule whose window is in progress.
 * Skips nights that already have a covering session (including one unlocked early) and
 * schedules edited after tonight's window began (saving at 23:00 does not lock you instantly).
 */
export async function startScheduledSessions(ctx: AppContext) {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ schedule: schedules, user: users })
    .from(schedules)
    .innerJoin(users, eq(users.id, schedules.userId))
    .where(eq(schedules.isEnabled, true));

  const started: FocusSession[] = [];
  for (const { schedule, user } of rows) {
    const window = activeWindow(schedule, user.timezone, now);
    if (!window) continue;
    if (schedule.updatedAt.getTime() > window.startsAt.getTime()) continue;

    const covering = await ctx.db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.userId, user.id),
        eq(focusSessions.nightDate, window.nightDate),
        gt(focusSessions.plannedEndAt, window.startsAt),
      ),
    });
    if (covering) continue;
    if (await getActiveSession(ctx.db, user.id)) continue;

    const { apps } = await loadSchedule(ctx.db, user.id);
    if (!apps.length) continue;
    if (schedule.penaltyCents > 0 && !(await hasPaymentMethod(ctx.db, user.id))) {
      ctx.log.warn({ userId: user.id }, "skipping scheduled session: no payment method on file");
      continue;
    }

    try {
      const [session] = await ctx.db
        .insert(focusSessions)
        .values({
          userId: user.id,
          source: "scheduled",
          status: "active",
          startedAt: now,
          plannedEndAt: window.endsAt,
          nightDate: window.nightDate,
          penaltyCents: schedule.penaltyCents,
          currency: schedule.currency,
          appIds: apps.map((app) => app.id),
        })
        .returning();
      started.push(session!);
      await notifyUser(ctx, user.id, {
        title: "The world can wait",
        body: "Your quiet hours have begun. See you in the morning.",
        data: { type: "session_started", sessionId: session!.id },
        dedupe: { kind: "session_started", key: session!.id },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return started;
}

export async function listSessions(db: Executor, userId: string, options: { limit: number; before?: string }) {
  return db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        options.before ? lt(focusSessions.startedAt, new Date(options.before)) : undefined,
      ),
    )
    .orderBy(desc(focusSessions.startedAt))
    .limit(options.limit);
}

export function assertActive(session: FocusSession) {
  if (session.status !== "active") {
    throw new AppError(409, "SESSION_NOT_ACTIVE", "This session has already ended");
  }
}
