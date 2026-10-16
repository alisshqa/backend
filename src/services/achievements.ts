import { asc, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { Executor } from "../db/client.js";
import { achievements, users } from "../db/schema.js";
import { notifyUser } from "./notifications.js";
import { lifetimeStats } from "./stats.js";

type Lifetime = Awaited<ReturnType<typeof lifetimeStats>>;

export const ACHIEVEMENTS: { code: string; title: string; description: string; earned: (s: Lifetime) => boolean }[] = [
  { code: "first_night", title: "First peaceful night", description: "Kept your first promise", earned: (s) => s.successfulNights >= 1 },
  { code: "nights_3", title: "3 peaceful nights", description: "Three nights kept", earned: (s) => s.successfulNights >= 3 },
  { code: "streak_3", title: "3-day streak", description: "Three kept nights in a row", earned: (s) => s.streaks.longest >= 3 },
  { code: "streak_7", title: "7-day streak", description: "A full week of kept nights", earned: (s) => s.streaks.longest >= 7 },
  { code: "nights_10", title: "10 peaceful nights", description: "Ten nights kept", earned: (s) => s.successfulNights >= 10 },
  { code: "streak_14", title: "14-day streak", description: "Two weeks in a row", earned: (s) => s.streaks.longest >= 14 },
  { code: "hours_50", title: "50 screen-free hours", description: "Fifty hours given back to you", earned: (s) => s.screenFreeMinutes >= 50 * 60 },
  { code: "nights_30", title: "30 peaceful nights", description: "Thirty nights kept", earned: (s) => s.successfulNights >= 30 },
  { code: "streak_30", title: "30-day streak", description: "A month of protected evenings", earned: (s) => s.streaks.longest >= 30 },
];

/** Unlocks any newly earned achievements and notifies the user about them. */
export async function evaluateAchievements(ctx: AppContext, userId: string) {
  const user = await ctx.db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return [];
  const stats = await lifetimeStats(ctx.db, user, ctx.now());
  const earned = ACHIEVEMENTS.filter((a) => a.earned(stats));
  if (!earned.length) return [];
  const inserted = await ctx.db
    .insert(achievements)
    .values(earned.map((a) => ({ userId, code: a.code, unlockedAt: ctx.now() })))
    .onConflictDoNothing()
    .returning();
  for (const row of inserted) {
    const meta = ACHIEVEMENTS.find((a) => a.code === row.code)!;
    await notifyUser(ctx, userId, {
      title: "New milestone",
      body: `${meta.title} — keep protecting your evenings.`,
      data: { type: "achievement", code: row.code },
      dedupe: { kind: "achievement", key: row.code },
    });
  }
  return inserted;
}

export async function listAchievements(db: Executor, userId: string) {
  const rows = await db.select().from(achievements).where(eq(achievements.userId, userId)).orderBy(asc(achievements.unlockedAt));
  const unlocked = new Map(rows.map((row) => [row.code, row.unlockedAt]));
  return ACHIEVEMENTS.map((a) => ({
    code: a.code,
    title: a.title,
    description: a.description,
    unlocked: unlocked.has(a.code),
    unlockedAt: unlocked.get(a.code)?.toISOString() ?? null,
  }));
}
