import { homedir } from "node:os";
import { join, resolve } from "node:path";

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const cwd = process.cwd();

export const config = {
  projectSlug: process.env.PROJECT_SLUG ?? "workspace-main",
  projectName: process.env.PROJECT_NAME ?? "Workspace Main",
  projectPath: process.env.PROJECT_PATH ?? cwd,
  hubUrl: process.env.HUB_URL ?? "http://127.0.0.1:4010",
  ingestApiKey: process.env.INGEST_API_KEY ?? "",
  sessionsRoot: process.env.SESSIONS_ROOT ?? join(homedir(), ".codex", "sessions"),
  scanIntervalMs: toNumber(process.env.SCAN_INTERVAL_MS, 5_000),
  maxFiles: toNumber(process.env.MAX_FILES, 20),
  stateFile: resolve(process.env.STATE_FILE ?? join(cwd, ".agent-state.json")),
  runOnce: process.env.RUN_ONCE === "1"
};
