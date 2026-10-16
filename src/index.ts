import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { ensureAppCatalog } from "./services/catalog.js";
import { startWorker } from "./worker/jobs.js";

await runMigrations(config.DATABASE_URL);
const { db, pool } = createDb(config.DATABASE_URL);
await ensureAppCatalog(db);

const app = await buildApp({ db, config });
const stopWorker = config.RUN_WORKER ? startWorker(app.ctx, config.WORKER_INTERVAL_SECONDS) : () => {};

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopWorker();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`API docs: http://localhost:${config.PORT}/docs`);
