import { DateTime } from "luxon";

/**
 * Time math for quiet-hours schedules.
 *
 * A schedule is a daily window [start, end) in the user's local time zone, repeated on selected
 * weekdays. When end <= start the window crosses midnight (22:30 → 07:00). The weekday that
 * matters is the day the window *starts* ("Monday night" = Mon 22:30 → Tue 07:00).
 */

export const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;
const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface ScheduleWindowRule {
  startMinute: number;
  endMinute: number;
  daysMask: number;
}

export interface Window {
  startsAt: Date;
  endsAt: Date;
  /** Local date (YYYY-MM-DD) of the evening the window belongs to. */
  nightDate: string;
}

export function parseTime(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid time "${value}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTime(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function daysToMask(days: boolean[]): number {
  return days.reduce((mask, on, index) => (on ? mask | (1 << index) : mask), 0);
}

export function maskToDays(mask: number): boolean[] {
  return Array.from({ length: 7 }, (_, index) => (mask & (1 << index)) !== 0);
}

/** Luxon weekday: 1 = Monday … 7 = Sunday. */
export function isActiveOn(mask: number, weekday: number): boolean {
  return (mask & (1 << (weekday - 1))) !== 0;
}

/** Human label used on the Schedule and Settings screens. */
export function repeatLabel(mask: number): string {
  if (mask === 0b1111111) return "Every night";
  if (mask === 0b0011111) return "Weeknights";
  if (mask === 0b1100000) return "Weekends";
  if (mask === 0) return "Never";
  return maskToDays(mask)
    .map((on, index) => (on ? WEEKDAY_SHORT[index] : null))
    .filter(Boolean)
    .join(", ");
}

export function windowDurationMinutes(rule: Pick<ScheduleWindowRule, "startMinute" | "endMinute">): number {
  const diff = rule.endMinute - rule.startMinute;
  return diff > 0 ? diff : diff + 24 * 60;
}

/** The window that starts on the given local date (ignores the weekday mask). */
export function windowForDate(rule: ScheduleWindowRule, localDate: DateTime): Window {
  const day = localDate.startOf("day");
  // Wall-clock arithmetic (set hour/minute) keeps 22:30 → 07:00 correct across DST changes.
  const at = (date: DateTime, minute: number) => date.set({ hour: Math.floor(minute / 60), minute: minute % 60 });
  const start = at(day, rule.startMinute);
  const end = at(rule.endMinute > rule.startMinute ? day : day.plus({ days: 1 }), rule.endMinute);
  return { startsAt: start.toJSDate(), endsAt: end.toJSDate(), nightDate: day.toISODate()! };
}

/**
 * The window that is in progress at `now`, or else the next one to start.
 * Returns null when no weekday is selected.
 */
export function currentOrNextWindow(rule: ScheduleWindowRule, timezone: string, now: Date): Window | null {
  if (rule.daysMask === 0) return null;
  const localNow = DateTime.fromJSDate(now, { zone: timezone });
  // Start from yesterday: yesterday's overnight window may still be running.
  for (let offset = -1; offset <= 8; offset++) {
    const date = localNow.plus({ days: offset });
    if (!isActiveOn(rule.daysMask, date.weekday)) continue;
    const window = windowForDate(rule, date);
    if (window.endsAt.getTime() > now.getTime()) return window;
  }
  return null;
}

/** The window in progress at `now`, if any. */
export function activeWindow(rule: ScheduleWindowRule, timezone: string, now: Date): Window | null {
  const window = currentOrNextWindow(rule, timezone, now);
  return window && window.startsAt.getTime() <= now.getTime() ? window : null;
}

/**
 * Which "night" an instant belongs to. Nights are anchored at local noon: anything from 12:00
 * until 11:59 the next day belongs to the evening that started it, so a 01:00 session counts
 * for the previous night.
 */
export function nightDateOf(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).minus({ hours: 12 }).toISODate()!;
}

/** Local "today" as YYYY-MM-DD. */
export function localDate(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate()!;
}

export function isValidTimezone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

export function greetingFor(instant: Date, timezone: string): string {
  const hour = DateTime.fromJSDate(instant, { zone: timezone }).hour;
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 23) return "Good evening";
  return "Good night";
}
