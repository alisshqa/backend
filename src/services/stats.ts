import { and, asc, eq, gte, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import type { AppContext } from "../context.js";
import type { Executor } from "../db/client.js";
import { focusSessions, schedules, users, type FocusSession, type User } from "../db/schema.js";
import { percentChange } from "../lib/format.js";
import { isActiveOn, localDate, nightDateOf, WEEKDAY_LETTERS, windowForDate } from "../lib/schedule-time.js";

const MINUTE = 60_000;

/** Screen-free minutes a session has accumulated so far. */
export function sessionMinutes(session: FocusSession, now: Date): number {
  return clippedMinutes(session, session.startedAt, now, now);
}

/** Minutes of the session that fall inside [from, to). */
export function clippedMinutes(session: FocusSession, from: Date, to: Date, now: Date): number {
  const end = Math.min(
    (session.endedAt ?? now).getTime(),
    session.plannedEndAt.getTime(),
    now.getTime(),
    to.getTime(),
  );
  const start = Math.max(session.startedAt.getTime(), from.getTime());
  return end > start ? (end - start) / MINUTE : 0;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

type NightStatus = "kept" | "broken" | "active";

function nightStatuses(sessions: FocusSession[]): Map<string, NightStatus> {
  const result = new Map<string, NightStatus>();
  for (const session of sessions) {
    const previous = result.get(session.nightDate);
    const status: NightStatus =
      session.status === "unlocked_early" ? "broken" : session.status === "completed" ? "kept" : "active";
    // A broken promise outweighs anything else that night; a kept one outweighs "in progress".
    if (previous === "broken") continue;
    if (status === "broken" || !previous || (previous === "active" && status === "kept")) {
      result.set(session.nightDate, status);
    }
  }
  return result;
}

/**
 * Streaks count consecutive kept nights. Nights that are not in the schedule and have no session
 * are skipped; a scheduled night that ended without a kept session, or an early unlock, resets
 * the streak. Tonight never breaks a streak while it is still running.
 */
export function computeStreaks(input: {
  sessions: FocusSession[];
  daysMask: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
  since: Date;
  now: Date;
}): { current: number; longest: number } {
  const { sessions, timezone, now } = input;
  const statuses = nightStatuses(sessions);
  const earliestSession = sessions.reduce<string | null>(
    (min, s) => (min === null || s.nightDate < min ? s.nightDate : min),
    null,
  );
  const sinceNight = nightDateOf(input.since, timezone);
  const first = earliestSession && earliestSession < sinceNight ? earliestSession : sinceNight;
  const last = nightDateOf(now, timezone);

  let run = 0;
  let longest = 0;
  let cursor = DateTime.fromISO(first, { zone: timezone });
  const end = DateTime.fromISO(last, { zone: timezone });
  // Cap the walk at ~3 years of history.
  if (end.diff(cursor, "days").days > 1100) cursor = end.minus({ days: 1100 });

  while (cursor <= end) {
    const date = cursor.toISODate()!;
    const status = statuses.get(date);
    if (status === "kept") {
      run += 1;
      longest = Math.max(longest, run);
    } else if (status === "broken") {
      run = 0;
    } else if (!status && isActiveOn(input.daysMask, cursor.weekday)) {
      const window = windowForDate(input, cursor);
      if (window.endsAt.getTime() <= now.getTime()) run = 0;
    }
    cursor = cursor.plus({ days: 1 });
  }
  return { current: run, longest };
}

async function sessionsBetween(db: Executor, userId: string, fromNight: string, toNight: string) {
  return db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        gte(focusSessions.nightDate, fromNight),
        lte(focusSessions.nightDate, toNight),
      ),
    )
    .orderBy(asc(focusSessions.startedAt));
}

async function allSessions(db: Executor, userId: string) {
  return db.select().from(focusSessions).where(eq(focusSessions.userId, userId)).orderBy(asc(focusSessions.startedAt));
}

function sumMinutes(sessions: FocusSession[], now: Date, filter?: (s: FocusSession) => boolean) {
  return sessions.filter((s) => !filter || filter(s)).reduce((acc, s) => acc + sessionMinutes(s, now), 0);
}

function keptNights(sessions: FocusSession[]) {
  return [...nightStatuses(sessions).values()].filter((status) => status === "kept").length;
}

function moneyKept(sessions: FocusSession[]) {
  // One promise per night: count the largest kept penalty of each kept night.
  const statuses = nightStatuses(sessions);
  const perNight = new Map<string, number>();
  for (const s of sessions) {
    if (s.status !== "completed" || statuses.get(s.nightDate) !== "kept") continue;
    perNight.set(s.nightDate, Math.max(perNight.get(s.nightDate) ?? 0, s.penaltyCents));
  }
  return [...perNight.values()].reduce((a, b) => a + b, 0);
}

/** Lifetime numbers used by achievements. */
export async function lifetimeStats(db: Executor, user: User, now: Date) {
  const sessions = await allSessions(db, user.id);
  const schedule = await db.query.schedules.findFirst({ where: eq(schedules.userId, user.id) });
  const streaks = computeStreaks({
    sessions,
    daysMask: schedule?.isEnabled ? schedule.daysMask : 0,
    startMinute: schedule?.startMinute ?? 0,
    endMinute: schedule?.endMinute ?? 0,
    timezone: user.timezone,
    since: user.createdAt,
    now,
  });
  return {
    sessions,
    schedule,
    successfulNights: keptNights(sessions),
    screenFreeMinutes: sumMinutes(sessions, now),
    moneyKeptCents: moneyKept(sessions),
    streaks,
  };
}

/** Today's screen-free time (clipped to the local calendar day) and this week's total vs last week. */
export async function homeStats(ctx: AppContext, user: User) {
  const now = ctx.now();
  const zone = user.timezone;
  const local = DateTime.fromJSDate(now, { zone });
  const dayStart = local.startOf("day");
  const weekStart = local.startOf("week"); // Monday
  const elapsedDays = Math.floor(local.diff(weekStart, "days").days);
  const prevWeekStart = weekStart.minus({ weeks: 1 });

  const sessions = await sessionsBetween(
    ctx.db,
    user.id,
    prevWeekStart.minus({ days: 1 }).toISODate()!,
    local.toISODate()!,
  );
  const today = sessions.reduce(
    (acc, s) => acc + clippedMinutes(s, dayStart.toJSDate(), dayStart.plus({ days: 1 }).toJSDate(), now),
    0,
  );
  const inRange = (from: DateTime, to: DateTime) => (s: FocusSession) =>
    s.nightDate >= from.toISODate()! && s.nightDate <= to.toISODate()!;
  const thisWeek = sumMinutes(sessions, now, inRange(weekStart, local));
  // Same span of last week, so Wednesday is compared with last Monday–Wednesday.
  const lastWeekSamePeriod = sumMinutes(sessions, now, inRange(prevWeekStart, prevWeekStart.plus({ days: elapsedDays })));

  return {
    today: { screenFreeMinutes: Math.round(today) },
    week: {
      screenFreeMinutes: Math.round(thisWeek),
      screenFreeHours: round1(thisWeek / 60),
      changePercent: percentChange(thisWeek, lastWeekSamePeriod),
    },
  };
}

/** Progress screen header: month total, weekly goal ring, nights kept, money kept, streak. */
export async function overview(ctx: AppContext, user: User) {
  const now = ctx.now();
  const zone = user.timezone;
  const local = DateTime.fromJSDate(now, { zone });
  const lifetime = await lifetimeStats(ctx.db, user, now);
  const { sessions, schedule } = lifetime;

  const monthStart = local.startOf("month");
  const prevMonthStart = monthStart.minus({ months: 1 });
  const prevMonthSameDay = DateTime.min(prevMonthStart.plus({ days: local.day - 1 }), prevMonthStart.endOf("month"));
  const between = (from: DateTime, to: DateTime) => (s: FocusSession) =>
    s.nightDate >= from.toISODate()! && s.nightDate <= to.toISODate()!;

  const monthSessions = sessions.filter(between(monthStart, local));
  const monthMinutes = sumMinutes(monthSessions, now);
  const prevMonthMinutes = sumMinutes(sessions.filter(between(prevMonthStart, prevMonthSameDay)), now);

  const weekStart = local.startOf("week");
  const weekEnd = weekStart.plus({ days: 6 });
  const weekSessions = sessions.filter(between(weekStart, weekEnd));
  const mask = schedule?.isEnabled ? schedule.daysMask : 0;
  const scheduledNights = Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i })).filter((d) =>
    isActiveOn(mask, d.weekday),
  ).length;

  return {
    month: {
      label: local.setLocale("en").toFormat("LLLL yyyy"),
      screenFreeMinutes: Math.round(monthMinutes),
      screenFreeHours: round1(monthMinutes / 60),
      changePercent: percentChange(monthMinutes, prevMonthMinutes),
      successfulNights: keptNights(monthSessions),
      moneyKeptCents: moneyKept(monthSessions),
    },
    weeklyGoal: {
      completedNights: keptNights(weekSessions),
      scheduledNights,
    },
    allTime: {
      screenFreeMinutes: Math.round(lifetime.screenFreeMinutes),
      successfulNights: lifetime.successfulNights,
      moneyKeptCents: lifetime.moneyKeptCents,
    },
    streak: lifetime.streaks,
    currency: schedule?.currency ?? "USD",
  };
}

/** "Quiet hours" bar chart: seven nights, Monday first, for the week containing `date`. */
export async function weekChart(ctx: AppContext, user: User, date?: string) {
  const now = ctx.now();
  const zone = user.timezone;
  const anchor = date ? DateTime.fromISO(date, { zone }) : DateTime.fromJSDate(now, { zone });
  const weekStart = anchor.startOf("week");
  const weekEnd = weekStart.plus({ days: 6 });
  const prevStart = weekStart.minus({ weeks: 1 });

  const sessions = await sessionsBetween(ctx.db, user.id, prevStart.toISODate()!, weekEnd.toISODate()!);
  const statuses = nightStatuses(sessions);
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = weekStart.plus({ days: i });
    const iso = day.toISODate()!;
    const minutes = sumMinutes(sessions, now, (s) => s.nightDate === iso);
    return {
      date: iso,
      letter: WEEKDAY_LETTERS[i]!,
      minutes: Math.round(minutes),
      hours: round1(minutes / 60),
      status: statuses.get(iso) ?? null,
      isToday: iso === localDate(now, zone),
    };
  });
  const total = days.reduce((acc, d) => acc + d.minutes, 0);
  // For the running week compare with the same span of last week (Mon…today), like the Home screen.
  const todayLocal = DateTime.fromJSDate(now, { zone });
  const isCurrentWeek = todayLocal >= weekStart && todayLocal <= weekEnd.endOf("day");
  const span = isCurrentWeek ? Math.floor(todayLocal.diff(weekStart, "days").days) : 6;
  const prevEnd = prevStart.plus({ days: span }).toISODate()!;
  const prevTotal = sumMinutes(sessions, now, (s) => s.nightDate >= prevStart.toISODate()! && s.nightDate <= prevEnd);
  const best = days.reduce<(typeof days)[number] | null>((top, d) => (d.minutes > (top?.minutes ?? 0) ? d : top), null);

  return {
    startDate: weekStart.toISODate()!,
    endDate: weekEnd.toISODate()!,
    /** "May 13 – 19" style label (English, like the design). */
    label:
      weekStart.month === weekEnd.month
        ? `${weekStart.setLocale("en").toFormat("LLL d")} – ${weekEnd.toFormat("d")}`
        : `${weekStart.setLocale("en").toFormat("LLL d")} – ${weekEnd.setLocale("en").toFormat("LLL d")}`,
    days,
    totalMinutes: total,
    bestDate: best?.date ?? null,
    changePercent: percentChange(total, prevTotal),
  };
}

export async function getUser(db: Executor, userId: string) {
  return db.query.users.findFirst({ where: eq(users.id, userId) });
}
