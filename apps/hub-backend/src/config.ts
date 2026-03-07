import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const configDir = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(configDir, "..");
const repoRoot = resolve(configDir, "..", "..", "..");

const envFiles = [
  resolve(repoRoot, ".env"),
  resolve(backendRoot, ".env"),
  resolve(repoRoot, ".env.local"),
  resolve(backendRoot, ".env.local")
];

for (const envFile of envFiles) {
  if (existsSync(envFile)) {
    loadEnv({ path: envFile, override: true });
  }
}

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const toOrigins = (value: string | undefined): string[] => {
  const parsed = toList(value);
  return parsed.length > 0 ? parsed : ["*"];
};

export const config = {
  port: toNumber(process.env.HUB_PORT, 4010),
  pgUrl: process.env.PG_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres",
  corsOrigins: toOrigins(process.env.CORS_ORIGIN),
  ingestApiKey: process.env.INGEST_API_KEY ?? "",
  execApiToken: process.env.EXEC_API_TOKEN ?? "",
  execAllowedIps: toList(process.env.EXEC_ALLOWED_IPS),
  execQueueSize: toNumber(process.env.EXEC_QUEUE_SIZE, 5),
  execTimeoutMs: toNumber(process.env.EXEC_TIMEOUT_MS, 20 * 60 * 1000),
  dataRetentionDays: toNumber(process.env.DATA_RETENTION_DAYS, 30),
  cleanupIntervalMinutes: toNumber(process.env.CLEANUP_INTERVAL_MINUTES, 60)
};
