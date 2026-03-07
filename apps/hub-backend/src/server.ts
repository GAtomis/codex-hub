import cors from "@fastify/cors";
import Fastify from "fastify";
import { agentManager } from "./agent-manager.js";
import { startCleanupScheduler } from "./cleanup.js";
import { config } from "./config.js";
import { pingDb } from "./db.js";
import { registerRoutes } from "./routes.js";

const bootstrap = async (): Promise<void> => {
  const app = Fastify({
    logger: true,
    bodyLimit: 10 * 1024 * 1024
  });

  const allowAll = config.corsOrigins.includes("*");
  await app.register(cors, {
    origin: allowAll
      ? true
      : (origin, cb) => {
          if (!origin || config.corsOrigins.includes(origin)) {
            cb(null, true);
            return;
          }
          cb(null, false);
        }
  });

  await agentManager.init({
    hubUrl: `http://127.0.0.1:${config.port}`,
    ingestApiKey: config.ingestApiKey
  });

  const cleanupJob = startCleanupScheduler({
    logger: app.log,
    retentionDays: config.dataRetentionDays,
    intervalMinutes: config.cleanupIntervalMinutes
  });

  app.addHook("onClose", async () => {
    cleanupJob.stop();
    await agentManager.stopAll();
  });

  await registerRoutes(app);
  await pingDb();

  await app.listen({
    host: "0.0.0.0",
    port: config.port
  });

  app.log.info(`hub-backend running on :${config.port}`);
};

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("failed to start hub-backend", error);
  process.exit(1);
});
