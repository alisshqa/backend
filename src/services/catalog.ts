import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apps } from "../db/schema.js";

/** Apps offered on the Schedule screen. Upserted at start-up so the catalog is always present. */
export const APP_CATALOG = [
  { id: "tiktok", name: "TikTok", mark: "T", iosBundleId: "com.zhiliaoapp.musically", androidPackage: "com.zhiliaoapp.musically", sortOrder: 1 },
  { id: "instagram", name: "Instagram", mark: "◎", iosBundleId: "com.burbn.instagram", androidPackage: "com.instagram.android", sortOrder: 2 },
  { id: "youtube", name: "YouTube", mark: "▶", iosBundleId: "com.google.ios.youtube", androidPackage: "com.google.android.youtube", sortOrder: 3 },
  { id: "x", name: "X", mark: "X", iosBundleId: "com.atebits.Tweetie2", androidPackage: "com.twitter.android", sortOrder: 4 },
  { id: "facebook", name: "Facebook", mark: "f", iosBundleId: "com.facebook.Facebook", androidPackage: "com.facebook.katana", sortOrder: 5 },
  { id: "snapchat", name: "Snapchat", mark: "S", iosBundleId: "com.toyopagroup.picaboo", androidPackage: "com.snapchat.android", sortOrder: 6 },
  { id: "reddit", name: "Reddit", mark: "R", iosBundleId: "com.reddit.Reddit", androidPackage: "com.reddit.frontpage", sortOrder: 7 },
  { id: "netflix", name: "Netflix", mark: "N", iosBundleId: "com.netflix.Netflix", androidPackage: "com.netflix.mediaclient", sortOrder: 8 },
] as const;

/** Defaults shown by the Schedule screen in the design. */
export const DEFAULT_SCHEDULE = {
  startMinute: 22 * 60 + 30,
  endMinute: 7 * 60,
  daysMask: 0b0011111, // Mon–Fri
  penaltyCents: 500,
  currency: "USD",
  appIds: ["tiktok", "instagram", "youtube"],
} as const;

export async function ensureAppCatalog(db: Database) {
  await db
    .insert(apps)
    .values(APP_CATALOG.map((app) => ({ ...app })))
    .onConflictDoUpdate({
      target: apps.id,
      set: {
        name: sql`excluded.name`,
        mark: sql`excluded.mark`,
        iosBundleId: sql`excluded.ios_bundle_id`,
        androidPackage: sql`excluded.android_package`,
        sortOrder: sql`excluded.sort_order`,
      },
    });
}
