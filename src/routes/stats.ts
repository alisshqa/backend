import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { listAchievements } from "../services/achievements.js";
import { completeExpiredSessions } from "../services/sessions.js";
import { overview, weekChart } from "../services/stats.js";
import { achievementSchema } from "./schemas.js";

export const statsRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook("onRequest", app.authenticate);

  app.get(
    "/stats/overview",
    {
      schema: {
        tags: ["progress"],
        summary: "Progress screen: month total, weekly goal ring, nights and money kept, streak",
        response: {
          200: z.object({
            month: z.object({
              label: z.string(),
              screenFreeMinutes: z.number().int(),
              screenFreeHours: z.number(),
              changePercent: z.number().int().nullable(),
              successfulNights: z.number().int(),
              moneyKeptCents: z.number().int(),
            }),
            weeklyGoal: z.object({ completedNights: z.number().int(), scheduledNights: z.number().int() }),
            allTime: z.object({
              screenFreeMinutes: z.number().int(),
              successfulNights: z.number().int(),
              moneyKeptCents: z.number().int(),
            }),
            streak: z.object({ current: z.number().int(), longest: z.number().int() }),
            currency: z.string(),
          }),
        },
      },
    },
    async (request) => {
      await completeExpiredSessions(ctx, request.currentUser.id);
      return overview(ctx, request.currentUser);
    },
  );

  app.get(
    "/stats/week",
    {
      schema: {
        tags: ["progress"],
        summary: '"Quiet hours" chart: screen-free time per night, Monday first',
        querystring: z.object({ date: z.iso.date().optional().describe("Any date inside the wanted week") }),
        response: {
          200: z.object({
            startDate: z.string(),
            endDate: z.string(),
            label: z.string(),
            days: z.array(
              z.object({
                date: z.string(),
                letter: z.string(),
                minutes: z.number().int(),
                hours: z.number(),
                status: z.enum(["kept", "broken", "active"]).nullable(),
                isToday: z.boolean(),
              }),
            ),
            totalMinutes: z.number().int(),
            bestDate: z.string().nullable(),
            changePercent: z.number().int().nullable(),
          }),
        },
      },
    },
    async (request) => {
      await completeExpiredSessions(ctx, request.currentUser.id);
      return weekChart(ctx, request.currentUser, request.query.date);
    },
  );

  app.get(
    "/achievements",
    {
      schema: {
        tags: ["progress"],
        summary: '"Recent milestones" — the full list with unlock dates',
        response: { 200: z.object({ achievements: z.array(achievementSchema) }) },
      },
    },
    async (request) => {
      await completeExpiredSessions(ctx, request.currentUser.id);
      return { achievements: await listAchievements(ctx.db, request.currentUser.id) };
    },
  );
};
