import { z } from "zod";
import { isValidTimezone } from "../lib/schedule-time.js";

/* Shared request pieces */

export const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Use 24-hour HH:MM")
  .describe("Local time, 24-hour HH:MM");

export const timezoneString = z
  .string()
  .refine(isValidTimezone, "Unknown IANA time zone")
  .describe("IANA time zone, e.g. Asia/Almaty");

export const idParam = z.object({ id: z.uuid() });

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

/* DTOs */

export const userSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  firstName: z.string(),
  initials: z.string(),
  email: z.string(),
  timezone: z.string(),
  createdAt: z.string(),
});

export const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.string(),
});

export const authResponseSchema = z.object({ user: userSchema, tokens: tokensSchema });

export const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  mark: z.string(),
  iosBundleId: z.string().nullable(),
  androidPackage: z.string().nullable(),
});

export const windowSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  nightDate: z.string(),
  inProgress: z.boolean(),
});

export const scheduleSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  days: z.array(z.boolean()).length(7).describe("Mon … Sun"),
  repeatLabel: z.string(),
  durationMinutes: z.number().int(),
  penaltyCents: z.number().int(),
  currency: z.string(),
  appIds: z.array(z.string()),
  apps: z.array(z.object({ id: z.string(), name: z.string(), mark: z.string() })),
  isEnabled: z.boolean(),
  nextWindow: windowSchema.nullable(),
  updatedAt: z.string(),
});

export const sessionSchema = z.object({
  id: z.uuid(),
  status: z.enum(["active", "completed", "unlocked_early"]),
  source: z.enum(["manual", "scheduled"]),
  startedAt: z.string(),
  plannedEndAt: z.string(),
  endedAt: z.string().nullable(),
  nightDate: z.string(),
  penaltyCents: z.number().int(),
  currency: z.string(),
  appIds: z.array(z.string()),
  remainingSeconds: z.number().int(),
  screenFreeMinutes: z.number().int(),
});

export const paymentMethodSchema = z.object({
  id: z.uuid(),
  brand: z.string(),
  last4: z.string(),
  wallet: z.string().nullable(),
  label: z.string(),
  isDefault: z.boolean(),
  createdAt: z.string(),
});

export const paymentSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  amountCents: z.number().int(),
  currency: z.string(),
  status: z.enum(["pending", "requires_action", "succeeded", "failed"]),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
});

export const settingsSchema = z.object({
  notificationsEnabled: z.boolean(),
  windDownEnabled: z.boolean(),
  windDownMinutes: z.number().int(),
  textScale: z.number(),
  reduceMotion: z.boolean(),
  highContrast: z.boolean(),
  emergencyAppIds: z.array(z.string()),
});

export const achievementSchema = z.object({
  code: z.string(),
  title: z.string(),
  description: z.string(),
  unlocked: z.boolean(),
  unlockedAt: z.string().nullable(),
});
