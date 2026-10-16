import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/* ───────────────────────────── Users & auth ───────────────────────────── */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** IANA time zone, e.g. "Asia/Almaty". All schedule math happens in this zone. */
    timezone: text("timezone").notNull().default("UTC"),
    /** Stripe Customer that owns the saved payment methods (null until the first one is added). */
    stripeCustomerId: text("stripe_customer_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the opaque token; the raw token is only ever held by the client. */
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refresh_tokens_user_idx").on(t.userId)],
);

/* ───────────────────────────── App catalog ───────────────────────────── */

/** Apps that can be restricted (TikTok, Instagram, YouTube, X …). */
export const apps = pgTable("apps", {
  id: text("id").primaryKey(), // slug: "tiktok"
  name: text("name").notNull(),
  /** Short glyph the UI shows in the tile ("T", "◎", "▶", "X"). */
  mark: text("mark").notNull(),
  iosBundleId: text("ios_bundle_id"),
  androidPackage: text("android_package"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

/* ───────────────────────────── Schedule ───────────────────────────── */

/** One "quiet hours" schedule per user (Schedule screen). */
export const schedules = pgTable("schedules", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Minutes after local midnight, 0..1439. 22:30 → 1350. */
  startMinute: smallint("start_minute").notNull(),
  /** Minutes after local midnight, 0..1439. If < startMinute the window crosses midnight. */
  endMinute: smallint("end_minute").notNull(),
  /** Bit mask of repeat days, bit 0 = Monday … bit 6 = Sunday. Weeknights = 0b0011111 = 31. */
  daysMask: smallint("days_mask").notNull(),
  /** "Promise amount" charged on early unlock, in minor units (cents). */
  penaltyCents: integer("penalty_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  ...timestamps,
});

export const scheduleApps = pgTable(
  "schedule_apps",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => schedules.userId, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.appId] })],
);

/* ───────────────────────────── Settings ───────────────────────────── */

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
  windDownEnabled: boolean("wind_down_enabled").notNull().default(true),
  windDownMinutes: smallint("wind_down_minutes").notNull().default(15),
  /** Accessibility: text size multiplier, reduced motion, high contrast. */
  textScale: real("text_scale").notNull().default(1),
  reduceMotion: boolean("reduce_motion").notNull().default(false),
  highContrast: boolean("high_contrast").notNull().default(false),
  /** Emergency access: apps that stay available during focus (on top of calls). */
  emergencyAppIds: text("emergency_app_ids").array().notNull().default(sql`'{}'::text[]`),
  ...timestamps,
});

/* ───────────────────────────── Focus sessions ───────────────────────────── */

export const sessionStatus = pgEnum("session_status", ["active", "completed", "unlocked_early"]);
export const sessionSource = pgEnum("session_source", ["manual", "scheduled"]);

/** One night of protected time (Locked screen). */
export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: sessionStatus("status").notNull().default("active"),
    source: sessionSource("source").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Local calendar date of the evening the session belongs to (a 01:00 start belongs to the previous night). */
    nightDate: date("night_date", { mode: "string" }).notNull(),
    /** Snapshots taken at start, so later schedule edits do not change an ongoing promise. */
    penaltyCents: integer("penalty_cents").notNull(),
    currency: text("currency").notNull(),
    appIds: text("app_ids").array().notNull(),
    ...timestamps,
  },
  (t) => [
    index("focus_sessions_user_night_idx").on(t.userId, t.nightDate),
    // At most one active session per user.
    uniqueIndex("focus_sessions_one_active_uq")
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
    index("focus_sessions_active_end_idx")
      .on(t.plannedEndAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

/* ───────────────────────────── Payments ───────────────────────────── */

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // "stripe" | "mock"
    providerPaymentMethodId: text("provider_payment_method_id").notNull(),
    brand: text("brand").notNull(), // "visa", "mastercard" …
    last4: text("last4").notNull(),
    /** Wallet the card came from: "apple_pay", "google_pay" or null for a plain card. */
    wallet: text("wallet"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payment_methods_user_idx").on(t.userId),
    uniqueIndex("payment_methods_user_provider_uq").on(t.userId, t.provider, t.providerPaymentMethodId),
  ],
);

export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
]);

/** Early-unlock penalty charges (Penalty screen). */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => focusSessions.id, { onDelete: "cascade" }),
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, {
      onDelete: "set null",
    }),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id"),
    /** Client secret for completing 3-D Secure on the device; cleared once the payment settles. */
    clientSecret: text("client_secret"),
    idempotencyKey: text("idempotency_key").notNull(),
    failureReason: text("failure_reason"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("payments_idempotency_uq").on(t.userId, t.idempotencyKey),
    uniqueIndex("payments_provider_payment_uq").on(t.providerPaymentId),
    index("payments_session_idx").on(t.sessionId),
  ],
);

/* ───────────────────────────── Devices & notifications ───────────────────────────── */

export const devicePlatform = pgEnum("device_platform", ["ios", "android", "web"]);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: devicePlatform("platform").notNull(),
    pushToken: text("push_token").notNull().unique(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("devices_user_idx").on(t.userId)],
);

/** De-duplicates scheduled notifications (e.g. one wind-down reminder per night). */
export const notificationLog = pgTable(
  "notification_log",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.key] })],
);

/* ───────────────────────────── Achievements ───────────────────────────── */

/** "Recent milestones" on the Progress screen. */
export const achievements = pgTable(
  "achievements",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    unlockedAt: timestamp("unlocked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.code] })],
);

export type User = typeof users.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type FocusSession = typeof focusSessions.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
