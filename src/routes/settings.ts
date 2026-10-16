import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userSettings, type UserSettings } from "../db/schema.js";
import { errorSchema, settingsSchema } from "./schemas.js";

function settingsDto(s: UserSettings) {
  return {
    notificationsEnabled: s.notificationsEnabled,
    windDownEnabled: s.windDownEnabled,
    windDownMinutes: s.windDownMinutes,
    textScale: s.textScale,
    reduceMotion: s.reduceMotion,
    highContrast: s.highContrast,
    emergencyAppIds: s.emergencyAppIds,
  };
}

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;
  app.addHook("onRequest", app.authenticate);

  async function load(userId: string) {
    const existing = await ctx.db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
    if (existing) return existing;
    const [created] = await ctx.db.insert(userSettings).values({ userId }).onConflictDoNothing().returning();
    return created ?? (await ctx.db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) }))!;
  }

  app.get(
    "/settings",
    { schema: { tags: ["settings"], summary: "Reminders, accessibility and emergency access", response: { 200: settingsSchema } } },
    async (request) => settingsDto(await load(request.currentUser.id)),
  );

  app.patch(
    "/settings",
    {
      schema: {
        tags: ["settings"],
        summary: "Update any subset of settings",
        body: z.object({
          notificationsEnabled: z.boolean().optional(),
          windDownEnabled: z.boolean().optional(),
          windDownMinutes: z.number().int().min(5).max(120).optional(),
          textScale: z.number().min(0.8).max(2).optional(),
          reduceMotion: z.boolean().optional(),
          highContrast: z.boolean().optional(),
          emergencyAppIds: z
            .array(z.string().min(1).max(200))
            .max(20)
            .optional()
            .describe("Apps that stay available during focus (catalog ids or device bundle ids)"),
        }),
        response: { 200: settingsSchema, 400: errorSchema },
      },
    },
    async (request) => {
      const userId = request.currentUser.id;
      await load(userId);
      const patch = request.body;
      if (patch.emergencyAppIds) patch.emergencyAppIds = [...new Set(patch.emergencyAppIds)];
      if (!Object.keys(patch).length) return settingsDto(await load(userId));
      const [updated] = await ctx.db.update(userSettings).set(patch).where(eq(userSettings.userId, userId)).returning();
      return settingsDto(updated!);
    },
  );
};
