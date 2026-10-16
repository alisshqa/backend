import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  currentOrNextWindow,
  daysToMask,
  maskToDays,
  nightDateOf,
  repeatLabel,
  windowForDate,
} from "../src/lib/schedule-time.js";
import { computeStreaks } from "../src/services/stats.js";
import type { FocusSession } from "../src/db/schema.js";

const night = { startMinute: 22 * 60 + 30, endMinute: 7 * 60, daysMask: 0b0011111 };

describe("schedule time math", () => {
  it("round-trips the repeat days and labels them", () => {
    const days = [true, true, true, true, true, false, false];
    expect(daysToMask(days)).toBe(31);
    expect(maskToDays(31)).toEqual(days);
    expect(repeatLabel(31)).toBe("Weeknights");
    expect(repeatLabel(127)).toBe("Every night");
    expect(repeatLabel(0b0000101)).toBe("Mon, Wed");
  });

  it("finds tonight's overnight window", () => {
    // Monday 20:12 in Almaty (UTC+5)
    const now = new Date("2026-11-02T15:12:00Z");
    const window = currentOrNextWindow(night, "Asia/Almaty", now)!;
    expect(window.startsAt.toISOString()).toBe("2026-11-02T17:30:00.000Z");
    expect(window.endsAt.toISOString()).toBe("2026-11-03T02:00:00.000Z");
    expect(window.nightDate).toBe("2026-11-02");
  });

  it("returns yesterday's window while it is still running", () => {
    // Tuesday 03:00 local — Monday night is in progress
    const window = currentOrNextWindow(night, "Asia/Almaty", new Date("2026-11-02T22:00:00Z"))!;
    expect(window.nightDate).toBe("2026-11-02");
  });

  it("skips days that are not selected (Friday night → Monday)", () => {
    // Saturday 12:00 local: next weeknight window is Monday
    const window = currentOrNextWindow(night, "Asia/Almaty", new Date("2026-11-07T07:00:00Z"))!;
    expect(window.nightDate).toBe("2026-11-09");
  });

  it("keeps wall-clock times across a DST change", () => {
    // US clocks fall back on 2026-11-01 at 02:00
    const window = windowForDate(night, DateTime.fromISO("2026-10-31", { zone: "America/New_York" }));
    expect(DateTime.fromJSDate(window.endsAt, { zone: "America/New_York" }).toFormat("HH:mm")).toBe("07:00");
    expect((window.endsAt.getTime() - window.startsAt.getTime()) / 60_000).toBe(9 * 60 + 30);
  });

  it("attributes after-midnight instants to the previous night", () => {
    expect(nightDateOf(new Date("2026-11-02T20:00:00Z"), "Asia/Almaty")).toBe("2026-11-02"); // 01:00 Tue
    expect(nightDateOf(new Date("2026-11-02T17:00:00Z"), "Asia/Almaty")).toBe("2026-11-02"); // 22:00 Mon
  });
});

describe("streaks", () => {
  const session = (nightDate: string, status: FocusSession["status"]): FocusSession => ({
    id: nightDate,
    userId: "u",
    status,
    source: "scheduled",
    startedAt: new Date(`${nightDate}T17:30:00Z`),
    plannedEndAt: new Date(`${nightDate}T23:59:00Z`),
    endedAt: null,
    nightDate,
    penaltyCents: 500,
    currency: "USD",
    appIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const base = { ...night, timezone: "Asia/Almaty", since: new Date("2026-11-01T00:00:00Z") };

  it("counts kept nights and skips unscheduled weekends", () => {
    const sessions = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"].map((d) =>
      session(d, "completed"),
    );
    // Tuesday 10 Nov, 12:00 local
    const result = computeStreaks({ ...base, sessions, now: new Date("2026-11-10T07:00:00Z") });
    expect(result).toEqual({ current: 6, longest: 6 });
  });

  it("resets on an early unlock and on a missed scheduled night", () => {
    const sessions = [
      session("2026-11-02", "completed"),
      session("2026-11-03", "completed"),
      session("2026-11-04", "unlocked_early"),
      session("2026-11-05", "completed"),
      // 2026-11-06 (Fri) missed
      session("2026-11-09", "completed"),
    ];
    const result = computeStreaks({ ...base, sessions, now: new Date("2026-11-10T07:00:00Z") });
    expect(result).toEqual({ current: 1, longest: 2 });
  });
});
