import { asc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { apps } from "../db/schema.js";
import { appSchema } from "./schemas.js";

export const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/apps",
    {
      schema: {
        tags: ["schedule"],
        summary: "Apps that can be restricted",
        response: { 200: z.object({ apps: z.array(appSchema) }) },
      },
    },
    async () => ({
      apps: await app.ctx.db
        .select({
          id: apps.id,
          name: apps.name,
          mark: apps.mark,
          iosBundleId: apps.iosBundleId,
          androidPackage: apps.androidPackage,
        })
        .from(apps)
        .where(eq(apps.isActive, true))
        .orderBy(asc(apps.sortOrder)),
    }),
  );
};
