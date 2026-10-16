import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { loadSchedule, saveSchedule, scheduleDto } from "../services/schedule.js";
import { errorSchema, scheduleSchema, timeString } from "./schemas.js";

export const scheduleRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook("onRequest", app.authenticate);

  app.get(
    "/schedule",
    { schema: { tags: ["schedule"], summary: "Quiet hours, repeat days, restricted apps and promise amount", response: { 200: scheduleSchema } } },
    async (request) => {
      const { schedule, apps } = await loadSchedule(ctx.db, request.currentUser.id);
      return scheduleDto(schedule, apps, request.currentUser.timezone, ctx.now());
    },
  );

  app.put(
    "/schedule",
    {
      schema: {
        tags: ["schedule"],
        summary: '"Save my schedule"',
        body: z.object({
          startTime: timeString,
          endTime: timeString,
          days: z.array(z.boolean()).length(7).describe("Mon … Sun"),
          penaltyCents: z
            .number()
            .int()
            .min(0)
            .max(10_000)
            .refine((v) => v === 0 || v >= 50, "Penalty must be 0 or at least 50 cents")
            .describe("Promise amount in cents: 100, 300, 500 or a custom value"),
          currency: z.string().length(3).optional(),
          appIds: z.array(z.string()).min(1, "Choose at least one app"),
          isEnabled: z.boolean().optional(),
        }),
        response: { 200: scheduleSchema, 400: errorSchema, 409: errorSchema },
      },
    },
    async (request) => {
      const { schedule, apps } = await saveSchedule(ctx, request.currentUser.id, request.body);
      return scheduleDto(schedule, apps, request.currentUser.timezone, ctx.now());
    },
  );
};
