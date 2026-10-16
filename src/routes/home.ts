import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { firstName, initials } from "../lib/format.js";
import { currentOrNextWindow, formatTime, greetingFor } from "../lib/schedule-time.js";
import { loadSchedule } from "../services/schedule.js";
import { completeExpiredSessions, getActiveSession, sessionDto } from "../services/sessions.js";
import { homeStats } from "../services/stats.js";
import { sessionSchema, windowSchema } from "./schemas.js";

export const homeRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook("onRequest", app.authenticate);

  app.get(
    "/home",
    {
      schema: {
        tags: ["home"],
        summary: "Everything the Home screen needs in one call",
        response: {
          200: z.object({
            greeting: z.string(),
            user: z.object({ firstName: z.string(), initials: z.string() }),
            schedule: z.object({ startTime: z.string(), endTime: z.string(), isEnabled: z.boolean() }),
            nextWindow: windowSchema.extend({ secondsUntilStart: z.number().int() }).nullable(),
            activeSession: sessionSchema.nullable(),
            today: z.object({ screenFreeMinutes: z.number().int() }),
            week: z.object({
              screenFreeMinutes: z.number().int(),
              screenFreeHours: z.number(),
              changePercent: z.number().int().nullable(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const user = request.currentUser;
      const now = ctx.now();
      await completeExpiredSessions(ctx, user.id);
      const [{ schedule }, active, stats] = await Promise.all([
        loadSchedule(ctx.db, user.id),
        getActiveSession(ctx.db, user.id),
        homeStats(ctx, user),
      ]);
      const window = currentOrNextWindow(schedule, user.timezone, now);
      return {
        greeting: greetingFor(now, user.timezone),
        user: { firstName: firstName(user.name), initials: initials(user.name) },
        schedule: {
          startTime: formatTime(schedule.startMinute),
          endTime: formatTime(schedule.endMinute),
          isEnabled: schedule.isEnabled,
        },
        nextWindow: window
          ? {
              startsAt: window.startsAt.toISOString(),
              endsAt: window.endsAt.toISOString(),
              nightDate: window.nightDate,
              inProgress: window.startsAt <= now,
              secondsUntilStart: Math.max(0, Math.floor((window.startsAt.getTime() - now.getTime()) / 1000)),
            }
          : null,
        activeSession: active ? sessionDto(active, now) : null,
        ...stats,
      };
    },
  );
};
