import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";

export type CleanupResult = {
  deletedEvents: number;
  deletedTurns: number;
  deletedThreads: number;
  deletedAuditLogs: number;
};

const toInterval = (days: number): string => `${days} days`;

export const runRetentionCleanup = async (retentionDays: number): Promise<CleanupResult> => {
  const intervalText = toInterval(retentionDays);
  const deletedEventsRes = await pool.query<{ count: string }>(
    `DELETE FROM events WHERE event_ts < NOW() - $1::interval RETURNING 1`,
    [intervalText]
  );

  const deletedTurnsRes = await pool.query<{ count: string }>(
    `DELETE FROM turns WHERE COALESCE(completed_at, started_at, updated_at) < NOW() - $1::interval RETURNING 1`,
    [intervalText]
  );

  const deletedThreadsRes = await pool.query<{ count: string }>(
    `
    DELETE FROM threads t
    WHERE t.updated_at < NOW() - $1::interval
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.thread_id = t.thread_id)
    RETURNING 1
    `,
    [intervalText]
  );

  const deletedAuditRes = await pool.query<{ count: string }>(
    `DELETE FROM exec_audit_logs WHERE created_at < NOW() - $1::interval RETURNING 1`,
    [intervalText]
  );

  return {
    deletedEvents: deletedEventsRes.rowCount ?? 0,
    deletedTurns: deletedTurnsRes.rowCount ?? 0,
    deletedThreads: deletedThreadsRes.rowCount ?? 0,
    deletedAuditLogs: deletedAuditRes.rowCount ?? 0
  };
};

export const startCleanupScheduler = (args: {
  logger: FastifyBaseLogger;
  retentionDays: number;
  intervalMinutes: number;
}): { stop: () => void } => {
  if (args.retentionDays <= 0 || args.intervalMinutes <= 0) {
    return { stop: () => undefined };
  }

  const intervalMs = args.intervalMinutes * 60 * 1000;
  const timer = setInterval(() => {
    void runRetentionCleanup(args.retentionDays)
      .then((result) => {
        args.logger.info({ result, retentionDays: args.retentionDays }, "retention cleanup finished");
      })
      .catch((error) => {
        args.logger.error({ error }, "retention cleanup failed");
      });
  }, intervalMs);

  return {
    stop: () => clearInterval(timer)
  };
};
