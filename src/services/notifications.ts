import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { devices, notificationLog, userSettings } from "../db/schema.js";

export interface NotifyOptions {
  title: string;
  body: string;
  data?: Record<string, string>;
  /** When set, the notification is sent at most once per (user, kind, key). */
  dedupe?: { kind: string; key: string };
  /** Skip the notificationsEnabled check (never used for marketing — only for payment receipts). */
  force?: boolean;
}

/** Sends a push to all of the user's devices, respecting their notification setting. */
export async function notifyUser(ctx: AppContext, userId: string, options: NotifyOptions): Promise<boolean> {
  if (!options.force) {
    const settings = await ctx.db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
    if (settings && !settings.notificationsEnabled) return false;
  }
  if (options.dedupe) {
    const inserted = await ctx.db
      .insert(notificationLog)
      .values({ userId, kind: options.dedupe.kind, key: options.dedupe.key })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) return false;
  }
  const targets = await ctx.db.select().from(devices).where(and(eq(devices.userId, userId)));
  if (!targets.length) return false;
  await ctx.push.send(
    targets.map((device) => ({ to: device.pushToken, title: options.title, body: options.body, data: options.data })),
  );
  return true;
}
