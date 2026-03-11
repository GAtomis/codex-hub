import type { FastifyInstance } from "fastify";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { agentManager } from "./agent-manager.js";
import { runRetentionCleanup } from "./cleanup.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ExecManager } from "./exec-manager.js";
import { ensureExecAccess, writeExecAudit } from "./security.js";
import { eventBus } from "./sse-bus.js";
import {
  buildGitChangeSummary,
  buildTranscriptContext,
  buildTranscriptTurns,
  dedupeTranscriptChangeSummaries,
  dedupeTranscriptEvents,
  dedupeTranscriptMessages,
  toTranscriptChangeSummary,
  toTranscriptEvent,
  toTranscriptMessage,
} from "./transcript.js";

const projectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
});

const eventSchema = z.object({
  eventId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  type: z.string().min(1),
  status: z.string().optional(),
  title: z.string().optional(),
  errorMessage: z.string().optional(),
  timestamp: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
});

const ingestSchema = z.object({
  project: projectSchema,
  events: z.array(eventSchema).min(1).max(1000),
});

const upsertProjectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
});

const projectExecSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

const projectFileSearchQuerySchema = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(40).default(12),
});

const projectFileContextSchema = z.object({
  paths: z.array(z.string().min(1).max(400)).min(1).max(8),
});

const startAgentSchema = z.object({
  projectSlug: z.string().min(1),
  projectName: z.string().min(1).optional(),
  projectPath: z.string().min(1).optional(),
  sessionsRoot: z.string().min(1).optional(),
  scanIntervalMs: z.coerce.number().int().min(1000).max(600_000).optional(),
  maxFiles: z.coerce.number().int().min(1).max(1000).optional(),
  stateFile: z.string().min(1).optional(),
  hubUrl: z.string().url().optional(),
  ingestApiKey: z.string().optional(),
});

const cleanupSchema = z.object({
  retentionDays: z.coerce.number().int().min(1).max(3650).optional(),
});

const pickDirectorySchema = z.object({
  prompt: z.string().min(1).max(120).optional(),
});

const projectLifecyclePreviewParamsSchema = z.object({
  slug: z.string().min(1),
});
const projectLifecycleActionSchema = z.object({
  action: z.enum(["archive", "detach", "restore", "purge"]),
  confirmSlug: z.string().optional(),
});

type IngestEvent = z.infer<typeof eventSchema>;
type IngestProject = z.infer<typeof projectSchema>;
type RuntimeIngestEvent = Omit<IngestEvent, "eventId" | "timestamp"> &
  Partial<Pick<IngestEvent, "eventId" | "timestamp">>;
const execManager = new ExecManager(config.execQueueSize);

const parseDate = (value: string): Date => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const STALE_RUNNING_THREAD_WINDOW = "90 seconds";
const ACTIVE_EXEC_TASK_STATUSES = new Set(["queued", "running"]);
const RETIRED_PROJECT_STATUSES = new Set(["archived", "detached"]);

const resolveCanonicalProjectSlug = async (
  fallbackProjectSlug: string,
  threadId: string,
): Promise<string> => {
  const existingThread = await pool.query<{ project_slug: string }>(
    `SELECT project_slug FROM threads WHERE thread_id = $1 LIMIT 1`,
    [threadId],
  );
  return existingThread.rows[0]?.project_slug ?? fallbackProjectSlug;
};

const normalizeEventProjectOwnership = async (
  projectSlug?: string,
): Promise<void> => {
  const params: string[] = [];
  const eventScope = projectSlug ? " AND t.project_slug = $1" : "";
  const turnScope = projectSlug ? " AND thread_row.project_slug = $1" : "";
  if (projectSlug) {
    params.push(projectSlug);
  }

  await pool.query(
    `
    UPDATE events e
    SET project_slug = t.project_slug
    FROM threads t
    WHERE e.thread_id = t.thread_id
      AND e.project_slug <> t.project_slug${eventScope}
    `,
    params,
  );

  await pool.query(
    `
    UPDATE turns turn_row
    SET project_slug = thread_row.project_slug
    FROM threads thread_row
    WHERE turn_row.thread_id = thread_row.thread_id
      AND turn_row.project_slug <> thread_row.project_slug${turnScope}
    `,
    params,
  );
};

const reconcileStaleRunningThreads = async (
  projectSlug?: string,
): Promise<void> => {
  const activeProjectSlugs = Array.from(
    new Set(
      execManager
        .list(projectSlug)
        .filter((task) => ACTIVE_EXEC_TASK_STATUSES.has(task.status))
        .map((task) => task.projectSlug),
    ),
  );

  const params: unknown[] = [STALE_RUNNING_THREAD_WINDOW];
  const clauses = ["status = 'running'", "updated_at < NOW() - $1::interval"];

  if (projectSlug) {
    params.push(projectSlug);
    clauses.push("project_slug = $" + params.length);
  }

  if (activeProjectSlugs.length > 0) {
    params.push(activeProjectSlugs);
    clauses.push("NOT (project_slug = ANY($" + params.length + "::text[]))");
  }

  const staleThreads = await pool.query<{ thread_id: string }>(
    `
    UPDATE threads
    SET status = 'interrupted'
    WHERE ${clauses.join("\n      AND ")}
    RETURNING thread_id
    `,
    params,
  );

  if (staleThreads.rows.length === 0) {
    return;
  }

  await pool.query(
    `
    UPDATE turns
    SET status = 'interrupted',
        completed_at = COALESCE(completed_at, NOW()),
        updated_at = NOW()
    WHERE thread_id = ANY($1::text[])
      AND COALESCE(status, 'running') = 'running'
    `,
    [staleThreads.rows.map((row) => row.thread_id)],
  );
};

const reconcileRuntimeState = async (projectSlug?: string): Promise<void> => {
  await normalizeEventProjectOwnership(projectSlug);
  await reconcileStaleRunningThreads(projectSlug);
};

const isRetiredProjectStatus = (status?: string | null): boolean =>
  RETIRED_PROJECT_STATUSES.has((status ?? "").toLowerCase());

const listProjectAgents = (projectSlug: string) =>
  agentManager.list().filter((agent) => agent.projectSlug === projectSlug);

const listProjectExecTasks = (projectSlug: string) =>
  execManager.list(projectSlug);

const listProjectActiveExecTasks = (projectSlug: string) =>
  listProjectExecTasks(projectSlug).filter((task) =>
    ACTIVE_EXEC_TASK_STATUSES.has(task.status),
  );

const suspendProjectRuntime = async (
  projectSlug: string,
): Promise<{ removedAgents: number; canceledTasks: number }> => {
  const agents = listProjectAgents(projectSlug);
  for (const agent of agents) {
    await agentManager.remove(agent.id);
  }

  const activeTasks = listProjectActiveExecTasks(projectSlug);
  for (const task of activeTasks) {
    execManager.cancel(task.id);
  }

  return {
    removedAgents: agents.length,
    canceledTasks: activeTasks.length,
  };
};

const fetchProjectLifecyclePreview = async (
  projectSlug: string,
): Promise<{
  project: {
    slug: string;
    name: string;
    path: string;
    status: string;
    lastSeenAt: string;
    retiredAt: string | null;
    retirementMode: string | null;
  };
  impact: {
    threadCount: number;
    turnCount: number;
    eventCount: number;
    agentCount: number;
    activeTaskCount: number;
    localFilesAffected: boolean;
  };
}> => {
  const projectRes = await pool.query<{
    slug: string;
    name: string;
    path: string;
    status: string;
    last_seen_at: string;
    retired_at: string | null;
    retirement_mode: string | null;
  }>(
    `
    SELECT
      project_slug AS slug,
      project_name AS name,
      project_path AS path,
      status,
      last_seen_at,
      retired_at,
      retirement_mode
    FROM projects
    WHERE project_slug = $1
    LIMIT 1
    `,
    [projectSlug],
  );

  const project = projectRes.rows[0];
  if (!project) {
    const error = new Error("project_not_found");
    error.name = "project_not_found";
    throw error;
  }

  const [threadCountRes, turnCountRes, eventCountRes] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM threads WHERE project_slug = $1`,
      [projectSlug],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM turns WHERE project_slug = $1`,
      [projectSlug],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM events WHERE project_slug = $1`,
      [projectSlug],
    ),
  ]);

  return {
    project: {
      slug: project.slug,
      name: project.name,
      path: project.path,
      status: project.status,
      lastSeenAt: project.last_seen_at,
      retiredAt: project.retired_at,
      retirementMode: project.retirement_mode,
    },
    impact: {
      threadCount: Number(threadCountRes.rows[0]?.count ?? 0),
      turnCount: Number(turnCountRes.rows[0]?.count ?? 0),
      eventCount: Number(eventCountRes.rows[0]?.count ?? 0),
      agentCount: listProjectAgents(projectSlug).length,
      activeTaskCount: listProjectActiveExecTasks(projectSlug).length,
      localFilesAffected: false,
    },
  };
};

const validateIngestApiKey = (app: FastifyInstance): void => {
  if (!config.ingestApiKey) {
    return;
  }

  app.addHook("onRequest", async (request, reply) => {
    if (request.url !== "/v1/events") {
      return;
    }

    const apiKey = request.headers["x-api-key"];
    if (apiKey !== config.ingestApiKey) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
};

const normalizeOriginHeader = (
  origin: string | string[] | undefined,
): string | undefined => {
  if (Array.isArray(origin)) {
    return origin[0];
  }
  return origin;
};

const resolveCorsOriginForHijack = (
  originHeader: string | string[] | undefined,
): string | null => {
  if (config.corsOrigins.includes("*")) {
    return "*";
  }
  const origin = normalizeOriginHeader(originHeader);
  if (!origin) {
    return null;
  }
  return config.corsOrigins.includes(origin) ? origin : null;
};

const buildExecArgs = (
  projectPath: string,
  prompt: string,
  model?: string,
): string[] => {
  const args = ["exec", "--cd", projectPath, "--skip-git-repo-check"];
  if (model) {
    args.push("--model", model);
  }
  args.push(prompt);
  return args;
};

const runExecFile = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(
          (stderr || stdout || error.message).trim() || "exec_failed",
        );
        err.name = error.name;
        reject(err);
        return;
      }
      resolve(stdout.trim());
    });
  });

const pickLocalDirectory = async (
  promptText?: string,
): Promise<
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; reason: string }
> => {
  const prompt = (promptText?.trim() || "Select project directory").slice(
    0,
    120,
  );
  const currentPlatform = platform();

  try {
    if (currentPlatform === "darwin") {
      const macPrompt = prompt.replace(/"/g, '\"');
      const result = await runExecFile("osascript", [
        "-e",
        `POSIX path of (choose folder with prompt "${macPrompt}")`,
      ]);
      return result
        ? { ok: true, path: result.replace(/\/$/, "") }
        : { ok: false, canceled: true };
    }

    if (currentPlatform === "win32") {
      const windowsPrompt = prompt.replace(/'/g, "''");
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.Description = '${windowsPrompt}'`,
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
      ].join("; ");
      const result = await runExecFile("powershell", [
        "-NoProfile",
        "-STA",
        "-Command",
        script,
      ]);
      return result
        ? { ok: true, path: result }
        : { ok: false, canceled: true };
    }

    if (currentPlatform === "linux") {
      try {
        const result = await runExecFile("zenity", [
          "--file-selection",
          "--directory",
          `--title=${prompt}`,
        ]);
        return result
          ? { ok: true, path: result }
          : { ok: false, canceled: true };
      } catch {
        try {
          const result = await runExecFile("kdialog", [
            "--getexistingdirectory",
            homedir(),
            "--title",
            prompt,
          ]);
          return result
            ? { ok: true, path: result }
            : { ok: false, canceled: true };
        } catch {
          return { ok: false, reason: "directory_picker_unavailable" };
        }
      }
    }

    return { ok: false, reason: "directory_picker_unsupported" };
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (
      message.includes("-128") ||
      message.includes("canceled") ||
      message.includes("cancelled")
    ) {
      return { ok: false, canceled: true };
    }
    return { ok: false, reason: "directory_picker_failed" };
  }
};

const validateProjectPath = async (
  projectPath: string,
): Promise<{
  exists: boolean;
  isDirectory: boolean;
  hasGit: boolean;
  hasPackageJson: boolean;
  entries: number;
}> => {
  try {
    const pathStat = await stat(projectPath);
    if (!pathStat.isDirectory()) {
      return {
        exists: true,
        isDirectory: false,
        hasGit: false,
        hasPackageJson: false,
        entries: 0,
      };
    }

    const names = await readdir(projectPath);
    return {
      exists: true,
      isDirectory: true,
      hasGit: names.includes(".git"),
      hasPackageJson: names.includes("package.json"),
      entries: names.length,
    };
  } catch {
    return {
      exists: false,
      isDirectory: false,
      hasGit: false,
      hasPackageJson: false,
      entries: 0,
    };
  }
};

const PROJECT_FILE_EXCLUDE_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "vendor",
  "tmp",
  "temp",
  "out",
]);
const PROJECT_FILE_CONTEXT_CHAR_LIMIT = 12_000;
const PROJECT_FILE_BINARY_SAMPLE_BYTES = 2_048;
const PROJECT_FILE_SIZE_LIMIT = 256 * 1024;

const normalizeProjectFilePath = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\.\//, "").trim();

const resolveProjectFilePath = (
  projectPath: string,
  relativePath: string,
): { absolutePath: string; normalizedPath: string } | null => {
  const normalizedInput = normalizeProjectFilePath(relativePath);
  if (!normalizedInput || isAbsolute(normalizedInput)) {
    return null;
  }
  const absolutePath = resolve(projectPath, normalizedInput);
  const relativePathFromRoot = relative(projectPath, absolutePath);
  if (
    !relativePathFromRoot ||
    relativePathFromRoot.startsWith("..") ||
    isAbsolute(relativePathFromRoot)
  ) {
    return null;
  }
  return {
    absolutePath,
    normalizedPath: relativePathFromRoot.split(sep).join("/"),
  };
};

const listProjectFilesFallback = async (
  projectPath: string,
  currentRelativePath = "",
): Promise<string[]> => {
  const targetPath = currentRelativePath
    ? join(projectPath, currentRelativePath)
    : projectPath;
  const entries = await readdir(targetPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const nextRelativePath = currentRelativePath
        ? `${currentRelativePath}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (PROJECT_FILE_EXCLUDE_NAMES.has(entry.name)) {
          return [] as string[];
        }
        return listProjectFilesFallback(projectPath, nextRelativePath);
      }
      if (!entry.isFile()) {
        return [] as string[];
      }
      return [nextRelativePath.replaceAll("\\", "/")];
    }),
  );
  return nested.flat();
};

const listProjectFiles = async (projectPath: string): Promise<string[]> => {
  try {
    const output = await new Promise<string>((resolveOutput, reject) => {
      execFile(
        "rg",
        [
          "--files",
          "--hidden",
          "-g",
          "!.git",
          "-g",
          "!node_modules",
          "-g",
          "!.next",
          "-g",
          "!dist",
          "-g",
          "!build",
          "-g",
          "!coverage",
          "-g",
          "!vendor",
          "-g",
          "!tmp",
          "-g",
          "!temp",
          "-g",
          "!out",
        ],
        { cwd: projectPath, timeout: 20_000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                (stderr || stdout || error.message).trim() ||
                  "project_file_search_failed",
              ),
            );
            return;
          }
          resolveOutput(stdout);
        },
      );
    });
    return output
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replaceAll("\\", "/"));
  } catch {
    return listProjectFilesFallback(projectPath);
  }
};

const scoreProjectFileMatch = (filePath: string, query: string): number => {
  const normalizedPath = filePath.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  const fileName = basename(normalizedPath);
  if (!normalizedQuery) {
    return 10_000 - normalizedPath.length;
  }
  let score = 0;
  if (fileName === normalizedQuery) {
    score += 10_000;
  }
  if (fileName.startsWith(normalizedQuery)) {
    score += 4_000;
  }
  if (fileName.includes(normalizedQuery)) {
    score += 2_000;
  }
  if (normalizedPath.includes(normalizedQuery)) {
    score += 1_000;
  }
  const tokens = normalizedQuery.split(/[\s/_.-]+/).filter(Boolean);
  for (const token of tokens) {
    if (fileName.startsWith(token)) {
      score += 250;
    }
    if (fileName.includes(token)) {
      score += 120;
    }
    if (normalizedPath.includes(token)) {
      score += 40;
    }
  }
  return score - normalizedPath.length;
};

const readProjectFileContext = async (
  projectPath: string,
  requestedPath: string,
): Promise<{
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}> => {
  const resolvedPath = resolveProjectFilePath(projectPath, requestedPath);
  if (!resolvedPath) {
    throw new Error("invalid_project_file_reference");
  }
  const fileStat = await stat(resolvedPath.absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("invalid_project_file_reference");
  }
  if (fileStat.size > PROJECT_FILE_SIZE_LIMIT) {
    return {
      path: resolvedPath.normalizedPath,
      content: "",
      truncated: false,
      binary: false,
      tooLarge: true,
      size: fileStat.size,
    };
  }

  const buffer = await readFile(resolvedPath.absolutePath);
  const binary = buffer
    .subarray(0, PROJECT_FILE_BINARY_SAMPLE_BYTES)
    .includes(0);
  if (binary) {
    return {
      path: resolvedPath.normalizedPath,
      content: "",
      truncated: false,
      binary: true,
      tooLarge: false,
      size: buffer.length,
    };
  }

  const text = buffer.toString("utf8");
  return {
    path: resolvedPath.normalizedPath,
    content: text.slice(0, PROJECT_FILE_CONTEXT_CHAR_LIMIT),
    truncated: text.length > PROJECT_FILE_CONTEXT_CHAR_LIMIT,
    binary: false,
    tooLarge: false,
    size: buffer.length,
  };
};

const upsertProject = async (project: IngestProject): Promise<void> => {
  await pool.query(
    `
    INSERT INTO projects (project_slug, project_name, project_path, status, last_seen_at)
    VALUES ($1, $2, $3, 'online', NOW())
    ON CONFLICT (project_slug)
    DO UPDATE SET
      project_name = EXCLUDED.project_name,
      project_path = EXCLUDED.project_path,
      status = 'online',
      retired_at = NULL,
      retirement_mode = NULL,
      last_seen_at = NOW()
    `,
    [project.slug, project.name, project.path],
  );
};

const applyEvent = async (
  project: IngestProject,
  event: IngestEvent,
): Promise<boolean> => {
  const eventTs = parseDate(event.timestamp);
  const canonicalProjectSlug = await resolveCanonicalProjectSlug(
    project.slug,
    event.threadId,
  );

  const inserted = await pool.query(
    `
    INSERT INTO events (
      event_id, project_slug, thread_id, turn_id, event_type,
      status, title, error_message, payload_json, event_ts
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
    `,
    [
      event.eventId,
      canonicalProjectSlug,
      event.threadId,
      event.turnId ?? null,
      event.type,
      event.status ?? null,
      event.title ?? null,
      event.errorMessage ?? null,
      JSON.stringify(event.payload),
      eventTs.toISOString(),
    ],
  );

  if (inserted.rowCount === 0) {
    return false;
  }

  await pool.query(
    `
    INSERT INTO threads (thread_id, project_slug, title, status, started_at, updated_at, last_turn_id)
    VALUES ($1, $2, $3, $4, $5, NOW(), $6)
    ON CONFLICT (thread_id)
    DO UPDATE SET
      title = COALESCE(EXCLUDED.title, threads.title),
      status = COALESCE(EXCLUDED.status, threads.status),
      started_at = COALESCE(threads.started_at, EXCLUDED.started_at),
      updated_at = NOW(),
      last_turn_id = COALESCE(EXCLUDED.last_turn_id, threads.last_turn_id)
    `,
    [
      event.threadId,
      canonicalProjectSlug,
      event.title ?? null,
      event.status ?? null,
      eventTs.toISOString(),
      event.turnId ?? null,
    ],
  );

  if (event.turnId) {
    await pool.query(
      `
      INSERT INTO turns (turn_id, thread_id, project_slug, status, started_at, completed_at, error_message, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (turn_id)
      DO UPDATE SET
        status = COALESCE(EXCLUDED.status, turns.status),
        completed_at = COALESCE(EXCLUDED.completed_at, turns.completed_at),
        error_message = COALESCE(EXCLUDED.error_message, turns.error_message),
        updated_at = NOW()
      `,
      [
        event.turnId,
        event.threadId,
        canonicalProjectSlug,
        event.status ?? null,
        eventTs.toISOString(),
        event.status === "completed" || event.status === "failed"
          ? eventTs.toISOString()
          : null,
        event.errorMessage ?? null,
      ],
    );
  }

  return true;
};

const persistRuntimeEvent = async (
  project: IngestProject,
  event: RuntimeIngestEvent,
): Promise<boolean> => {
  const normalizedEvent: IngestEvent = {
    ...event,
    eventId: event.eventId ?? randomUUID(),
    timestamp: event.timestamp ?? new Date().toISOString(),
    payload: event.payload ?? {},
  };
  const canonicalProjectSlug = await resolveCanonicalProjectSlug(
    project.slug,
    normalizedEvent.threadId,
  );
  const inserted = await applyEvent(project, normalizedEvent);
  if (inserted) {
    eventBus.publish({ project: canonicalProjectSlug, ...normalizedEvent });
  }
  return inserted;
};

const runtimeText = (
  value: unknown,
): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const runtimeFirstString = (
  payload: Record<string, unknown>,
  keys: string[],
): string | null => {
  for (const key of keys) {
    const direct = runtimeText(payload[key]);
    if (direct) {
      return direct;
    }
    const value = payload[key];
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => (typeof item === "string" ? item : ""))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (joined) {
        return joined;
      }
    }
  }
  return null;
};

const buildRuntimeCommandText = (
  payload: Record<string, unknown>,
): string | null => {
  const direct = runtimeFirstString(payload, [
    "command",
    "cmd",
    "shellCommand",
    "input",
  ]);
  if (direct) {
    return direct;
  }
  if (Array.isArray(payload.command)) {
    const joined = payload.command
      .map((item) => (typeof item === "string" ? item : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    return joined || null;
  }
  return null;
};

const buildRuntimeStepEvent = (
  method: string,
  paramsObj: Record<string, unknown>,
): Omit<RuntimeIngestEvent, "threadId" | "turnId"> | null => {
  if (method !== "item/started" && method !== "item/completed") {
    return null;
  }
  const item =
    paramsObj.item && typeof paramsObj.item === "object"
      ? (paramsObj.item as Record<string, unknown>)
      : {};
  const itemType = runtimeText(item.type)?.toLowerCase();
  if (!itemType || itemType === "agentmessage") {
    return null;
  }

  const status = method === "item/started" ? "running" : "completed";
  const timestamp = new Date().toISOString();

  if (itemType.includes("reasoning")) {
    return {
      type: "event_msg.reasoning_step",
      status,
      title: method === "item/started" ? "模型正在分析" : "模型完成本步分析",
      timestamp,
      payload: {
        itemType,
        summary:
          runtimeFirstString(item, [
            "summary",
            "text",
            "content",
            "reasoning",
            "detail",
          ]) ?? "Codex 正在推理当前任务。",
      },
    };
  }

  if (itemType.includes("command")) {
    const command = buildRuntimeCommandText(item);
    return {
      type: "event_msg.command_step",
      status,
      title: command ? `执行命令 ${command}` : "执行命令",
      timestamp,
      payload: {
        itemType,
        command,
        summary:
          runtimeFirstString(item, [
            "summary",
            "output",
            "detail",
            "text",
          ]) ??
          (command
            ? `Codex ${status === "running" ? "正在" : "已"}执行命令 ${command}`
            : "Codex 正在执行命令。"),
      },
    };
  }

  const toolName = runtimeFirstString(item, [
    "tool",
    "tool_name",
    "name",
    "function_name",
  ]);
  return {
    type: "event_msg.tool_step",
    status,
    title: toolName ? `调用工具 ${toolName}` : "工具步骤",
    timestamp,
    payload: {
      itemType,
      toolName,
      summary:
        runtimeFirstString(item, [
          "summary",
          "detail",
          "text",
          "output",
        ]) ??
        (toolName
          ? `Codex ${status === "running" ? "正在" : "已"}执行工具 ${toolName}`
          : "Codex 正在执行工具步骤。"),
    },
  };
};

const persistChangeSummaryForTurn = async (
  project: IngestProject,
  threadId: string,
  turnId?: string | null,
): Promise<void> => {
  const summary = await buildGitChangeSummary(project.path, threadId, turnId);
  if (!summary) {
    return;
  }
  await persistRuntimeEvent(project, {
    eventId: summary.eventId,
    threadId,
    turnId: turnId ?? undefined,
    type: "event_msg.change_summary",
    status: summary.status ?? undefined,
    title: summary.title,
    timestamp: summary.timestamp,
    payload: {
      summary: summary.summary,
      stats: summary.stats,
      files: summary.files,
    },
  });
};

export const registerRoutes = async (app: FastifyInstance): Promise<void> => {
  validateIngestApiKey(app);
  await reconcileRuntimeState();

  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/admin/cleanup", async (request, reply) => {
    const body = cleanupSchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.code(400);
      return { error: "invalid_body", detail: body.error.flatten() };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/admin/cleanup",
      action: "retention_cleanup",
    });
    if (!allowed) {
      return;
    }

    const retentionDays = body.data.retentionDays ?? config.dataRetentionDays;
    const result = await runRetentionCleanup(retentionDays);
    return { ok: true, retentionDays, result };
  });

  app.post("/v1/projects/register", async (request, reply) => {
    const body = upsertProjectSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "invalid_body", detail: body.error.flatten() };
    }

    const pathCheck = await validateProjectPath(body.data.path);
    if (!pathCheck.exists || !pathCheck.isDirectory) {
      reply.code(400);
      return {
        error: "invalid_project_path",
        detail: pathCheck,
      };
    }

    await upsertProject({
      slug: body.data.slug,
      name: body.data.name,
      path: body.data.path,
    });

    return {
      ok: true,
      project: body.data,
      validation: pathCheck,
    };
  });

  app.put("/v1/projects/:slug", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        status: z.string().min(1).optional(),
      })
      .safeParse(request.body);

    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const currentRes = await pool.query<{
      project_name: string;
      project_path: string;
      status: string;
    }>(
      `SELECT project_name, project_path, status FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug],
    );
    const current = currentRes.rows[0];
    if (!current) {
      reply.code(404);
      return { error: "project_not_found" };
    }

    const nextPath = body.data.path ?? current.project_path;
    if (body.data.path) {
      const pathCheck = await validateProjectPath(nextPath);
      if (!pathCheck.exists || !pathCheck.isDirectory) {
        reply.code(400);
        return { error: "invalid_project_path", detail: pathCheck };
      }
    }

    const result = await pool.query<{
      slug: string;
      name: string;
      path: string;
      status: string;
      last_seen_at: string;
    }>(
      `
      UPDATE projects
      SET
        project_name = COALESCE($2, project_name),
        project_path = COALESCE($3, project_path),
        status = COALESCE($4, status),
        last_seen_at = NOW()
      WHERE project_slug = $1
      RETURNING project_slug AS slug, project_name AS name, project_path AS path, status, last_seen_at
      `,
      [
        params.data.slug,
        body.data.name ?? null,
        body.data.path ?? null,
        body.data.status ?? null,
      ],
    );

    return { ok: true, project: result.rows[0] };
  });

  app.post("/v1/projects/:slug/validate-path", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const bodySchema = z.object({ path: z.string().min(1).optional() });
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const projectRes = await pool.query<{ project_path: string }>(
      `SELECT project_path FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug],
    );
    const path = body.data.path ?? projectRes.rows[0]?.project_path;
    if (!path) {
      reply.code(404);
      return { error: "project_not_found" };
    }

    const detail = await validateProjectPath(path);
    return {
      ok: detail.exists && detail.isDirectory,
      path,
      detail,
    };
  });

  app.post("/v1/system/pick-directory", async (request, reply) => {
    const body = pickDirectorySchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const result = await pickLocalDirectory(body.data.prompt);
    if (!result.ok && "reason" in result) {
      reply.code(501);
      return { error: result.reason };
    }

    return result;
  });

  app.get("/v1/agents", async () => {
    const agents = agentManager.list();
    return {
      total: agents.length,
      agents,
    };
  });

  app.post("/v1/agents/start", async (request, reply) => {
    const body = startAgentSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "invalid_body", detail: body.error.flatten() };
    }

    const projectResult = await pool.query<{
      project_name: string;
      project_path: string;
    }>(
      `
      SELECT project_name, project_path
      FROM projects
      WHERE project_slug = $1
      LIMIT 1
      `,
      [body.data.projectSlug],
    );

    const projectName =
      body.data.projectName ?? projectResult.rows[0]?.project_name;
    const projectPath =
      body.data.projectPath ?? projectResult.rows[0]?.project_path;

    if (!projectName || !projectPath) {
      reply.code(400);
      return {
        error: "project_info_required",
        message: "projectName/projectPath missing and project not found in db",
      };
    }

    const pathCheck = await validateProjectPath(projectPath);
    if (!pathCheck.exists || !pathCheck.isDirectory) {
      reply.code(400);
      return { error: "invalid_project_path", detail: pathCheck };
    }

    await upsertProject({
      slug: body.data.projectSlug,
      name: projectName,
      path: projectPath,
    });

    try {
      const agent = agentManager.start({
        projectSlug: body.data.projectSlug,
        projectName,
        projectPath,
        sessionsRoot:
          body.data.sessionsRoot ?? join(homedir(), ".codex", "sessions"),
        scanIntervalMs: body.data.scanIntervalMs ?? 5000,
        maxFiles: body.data.maxFiles ?? 20,
        stateFile: body.data.stateFile,
        hubUrl: body.data.hubUrl ?? `http://127.0.0.1:${config.port}`,
        ingestApiKey: body.data.ingestApiKey ?? config.ingestApiKey,
        autoStart: true,
      });

      return {
        ok: true,
        agent,
        validation: pathCheck,
      };
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === "agent_exists") {
        reply.code(409);
        return { error: "agent_exists", message: err.message };
      }

      reply.code(500);
      return { error: "start_agent_failed", message: err.message };
    }
  });

  app.post("/v1/agents/:id/stop", async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    const agent = await agentManager.stop(params.data.id);
    if (!agent) {
      reply.code(404);
      return { error: "agent_not_found" };
    }

    return {
      ok: true,
      agent,
    };
  });

  app.post("/v1/agents/:id/delete", async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    const removed = await agentManager.remove(params.data.id);
    if (!removed) {
      reply.code(404);
      return { error: "agent_not_found" };
    }

    return { ok: true };
  });

  app.post("/v1/events", async (request, reply) => {
    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_body", detail: parsed.error.flatten() };
    }

    const { project, events } = parsed.data;
    await upsertProject(project);

    let insertedCount = 0;
    for (const event of events) {
      const canonicalProjectSlug = await resolveCanonicalProjectSlug(
        project.slug,
        event.threadId,
      );
      const inserted = await applyEvent(project, event);
      if (inserted) {
        insertedCount += 1;
        eventBus.publish({ project: canonicalProjectSlug, ...event });
      }
    }

    return {
      accepted: events.length,
      inserted: insertedCount,
      duplicated: events.length - insertedCount,
    };
  });

  app.get("/v1/overview", async () => {
    await reconcileRuntimeState();
    const [projectCountRes, threadStatusRes, recentRes] = await Promise.all([
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM projects WHERE COALESCE(status, 'online') NOT IN ('archived', 'detached')",
      ),
      pool.query<{ status: string | null; count: string }>(
        `
        SELECT COALESCE(t.status, 'unknown') AS status, COUNT(*)::text AS count
        FROM threads t
        JOIN projects p ON p.project_slug = t.project_slug
        WHERE COALESCE(p.status, 'online') NOT IN ('archived', 'detached')
        GROUP BY t.status
        `,
      ),
      pool.query<{
        event_id: string;
        project_slug: string;
        thread_id: string;
        turn_id: string | null;
        event_type: string;
        status: string | null;
        title: string | null;
        error_message: string | null;
        event_ts: string;
      }>(
        `
        SELECT
          e.event_id,
          COALESCE(t.project_slug, e.project_slug) AS project_slug,
          e.thread_id,
          e.turn_id,
          e.event_type,
          e.status,
          e.title,
          e.error_message,
          e.event_ts
        FROM events e
        LEFT JOIN threads t ON t.thread_id = e.thread_id
        JOIN projects p ON p.project_slug = COALESCE(t.project_slug, e.project_slug)
        WHERE COALESCE(p.status, 'online') NOT IN ('archived', 'detached')
        ORDER BY e.event_ts DESC
        LIMIT 50
        `,
      ),
    ]);

    return {
      projectCount: Number(projectCountRes.rows[0]?.count ?? 0),
      threadStatus: threadStatusRes.rows.map((item) => ({
        status: item.status ?? "unknown",
        count: Number(item.count),
      })),
      recentEvents: recentRes.rows,
    };
  });

  app.get("/v1/projects", async (request, reply) => {
    const querySchema = z.object({
      includeRetired: z.coerce.boolean().default(false),
    });
    const query = querySchema.safeParse(request.query ?? {});
    if (!query.success) {
      reply.code(400);
      return { error: "invalid_query" };
    }

    const result = await pool.query<{
      slug: string;
      name: string;
      path: string;
      status: string;
      last_seen_at: string;
      thread_count: string;
      retired_at: string | null;
      retirement_mode: string | null;
    }>(
      `
      SELECT
        p.project_slug AS slug,
        p.project_name AS name,
        p.project_path AS path,
        p.status,
        p.last_seen_at,
        p.retired_at,
        p.retirement_mode,
        COUNT(t.thread_id)::text AS thread_count
      FROM projects p
      LEFT JOIN threads t ON t.project_slug = p.project_slug
      WHERE ($1::boolean OR COALESCE(p.status, 'online') NOT IN ('archived', 'detached'))
      GROUP BY p.project_slug, p.project_name, p.project_path, p.status, p.last_seen_at, p.retired_at, p.retirement_mode
      ORDER BY
        CASE WHEN COALESCE(p.status, 'online') IN ('archived', 'detached') THEN 1 ELSE 0 END ASC,
        p.last_seen_at DESC
      `,
      [query.data.includeRetired],
    );

    return result.rows.map((row) => ({
      ...row,
      thread_count: Number(row.thread_count ?? 0),
      retired_at: row.retired_at ?? null,
      retirement_mode: row.retirement_mode ?? null,
    }));
  });

  app.get("/v1/projects/:slug/lifecycle-preview", async (request, reply) => {
    const params = projectLifecyclePreviewParamsSchema.safeParse(
      request.params,
    );
    if (!params.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    try {
      return await fetchProjectLifecyclePreview(params.data.slug);
    } catch (error) {
      if (error instanceof Error && error.name === "project_not_found") {
        reply.code(404);
        return { error: "project_not_found" };
      }
      throw error;
    }
  });

  app.post("/v1/projects/:slug/lifecycle", async (request, reply) => {
    const params = projectLifecyclePreviewParamsSchema.safeParse(
      request.params,
    );
    const body = projectLifecycleActionSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    try {
      const preview = await fetchProjectLifecyclePreview(params.data.slug);

      if (
        body.data.action === "purge" &&
        body.data.confirmSlug !== params.data.slug
      ) {
        reply.code(400);
        return { error: "confirm_slug_mismatch" };
      }

      if (body.data.action === "restore") {
        const restored = await pool.query<{
          slug: string;
          name: string;
          path: string;
          status: string;
          last_seen_at: string;
          retired_at: string | null;
          retirement_mode: string | null;
        }>(
          `
          UPDATE projects
          SET status = 'online',
              retired_at = NULL,
              retirement_mode = NULL,
              last_seen_at = NOW()
          WHERE project_slug = $1
          RETURNING project_slug AS slug, project_name AS name, project_path AS path, status, last_seen_at, retired_at, retirement_mode
          `,
          [params.data.slug],
        );

        return {
          ok: true,
          action: body.data.action,
          project: restored.rows[0],
          impact: preview.impact,
          runtimeChange: { removedAgents: 0, canceledTasks: 0 },
        };
      }

      const runtimeChange = await suspendProjectRuntime(params.data.slug);

      if (body.data.action === "purge") {
        await pool.query(`DELETE FROM projects WHERE project_slug = $1`, [
          params.data.slug,
        ]);
        return {
          ok: true,
          action: body.data.action,
          project: preview.project,
          impact: preview.impact,
          runtimeChange,
        };
      }

      const nextStatus =
        body.data.action === "archive" ? "archived" : "detached";
      const updated = await pool.query<{
        slug: string;
        name: string;
        path: string;
        status: string;
        last_seen_at: string;
        retired_at: string | null;
        retirement_mode: string | null;
      }>(
        `
        UPDATE projects
        SET status = $2,
            retired_at = NOW(),
            retirement_mode = $2,
            last_seen_at = NOW()
        WHERE project_slug = $1
        RETURNING project_slug AS slug, project_name AS name, project_path AS path, status, last_seen_at, retired_at, retirement_mode
        `,
        [params.data.slug, nextStatus],
      );

      return {
        ok: true,
        action: body.data.action,
        project: updated.rows[0],
        impact: preview.impact,
        runtimeChange,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "project_not_found") {
        reply.code(404);
        return { error: "project_not_found" };
      }
      throw error;
    }
  });

  app.get("/v1/projects/:slug/threads", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
    });

    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query ?? {});

    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    await reconcileRuntimeState(params.data.slug);

    const result = await pool.query(
      `
      SELECT
        t.thread_id,
        t.project_slug,
        t.title,
        t.status,
        t.started_at,
        t.updated_at,
        t.last_turn_id,
        first_user.first_user_prompt
      FROM threads
      t
      LEFT JOIN LATERAL (
        SELECT COALESCE(NULLIF(TRIM(e.payload_json->>'message_text'), ''), NULLIF(TRIM(e.title), ''), NULLIF(TRIM(e.error_message), '')) AS first_user_prompt
        FROM events e
        WHERE e.thread_id = t.thread_id
          AND ((e.payload_json->>'role') = 'user' OR e.event_type LIKE '%user%')
          AND COALESCE(e.payload_json->>'message_text', '') NOT LIKE '%AGENTS.md instructions for%'
          AND COALESCE(e.payload_json->>'message_text', '') NOT LIKE '%<INSTRUCTIONS>%'
        ORDER BY e.event_ts ASC
        LIMIT 1
      ) AS first_user ON TRUE
      WHERE t.project_slug = $1
      ORDER BY t.updated_at DESC
      LIMIT $2
      `,
      [params.data.slug, query.data.limit],
    );

    return result.rows;
  });

  app.get("/v1/projects/:slug/files/search", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    const query = projectFileSearchQuerySchema.safeParse(request.query ?? {});

    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/projects/:slug/files/search",
      action: "search_project_files",
      projectSlug: params.data.slug,
    });
    if (!allowed) {
      return;
    }

    const projectRes = await pool.query<{
      project_path: string;
      status: string;
    }>(
      `SELECT project_path, status FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug],
    );
    const project = projectRes.rows[0];
    if (!project) {
      reply.code(404);
      return { error: "project_not_found" };
    }
    if (isRetiredProjectStatus(project.status)) {
      reply.code(409);
      return { error: "project_retired" };
    }

    const files = await listProjectFiles(project.project_path);
    const keyword = query.data.q.trim();
    const sorted = files
      .map((filePath) => ({
        path: filePath,
        name: basename(filePath),
        score: scoreProjectFileMatch(filePath, keyword),
      }))
      .filter((item) => (keyword ? item.score > 0 : true))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, query.data.limit)
      .map(({ path, name }) => ({ path, name }));

    return { files: sorted };
  });

  app.post("/v1/projects/:slug/files/context", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    const body = projectFileContextSchema.safeParse(request.body ?? {});

    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/projects/:slug/files/context",
      action: "read_project_files",
      projectSlug: params.data.slug,
    });
    if (!allowed) {
      return;
    }

    const projectRes = await pool.query<{
      project_path: string;
      status: string;
    }>(
      `SELECT project_path, status FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug],
    );
    const project = projectRes.rows[0];
    if (!project) {
      reply.code(404);
      return { error: "project_not_found" };
    }
    if (isRetiredProjectStatus(project.status)) {
      reply.code(409);
      return { error: "project_retired" };
    }

    try {
      const uniquePaths = Array.from(
        new Set(
          body.data.paths
            .map((item) => normalizeProjectFilePath(item))
            .filter(Boolean),
        ),
      ).slice(0, 8);
      const files = await Promise.all(
        uniquePaths.map((filePath) =>
          readProjectFileContext(project.project_path, filePath),
        ),
      );
      return { files };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "invalid_project_file_reference"
      ) {
        reply.code(400);
        return { error: "invalid_project_file_reference" };
      }
      throw error;
    }
  });

  app.get("/v1/exec/tasks", async (request, reply) => {
    const querySchema = z.object({ projectSlug: z.string().optional() });
    const query = querySchema.safeParse(request.query ?? {});
    if (!query.success) {
      reply.code(400);
      return { error: "invalid_query" };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/exec/tasks",
      action: "list_tasks",
      projectSlug: query.data.projectSlug,
    });
    if (!allowed) {
      return;
    }

    return { tasks: execManager.list(query.data.projectSlug) };
  });

  app.post("/v1/exec/tasks/:taskId/cancel", async (request, reply) => {
    const paramsSchema = z.object({ taskId: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/exec/tasks/:taskId/cancel",
      action: "cancel_task",
    });
    if (!allowed) {
      return;
    }

    const task = execManager.cancel(params.data.taskId);
    if (!task) {
      reply.code(404);
      return { error: "task_not_found" };
    }

    await writeExecAudit({
      request,
      projectSlug: task.projectSlug,
      route: "/v1/exec/tasks/:taskId/cancel",
      action: "cancel_task",
      status: "ok",
      detail: { taskId: task.id, taskStatus: task.status },
    });

    return { ok: true, task };
  });

  app.post("/v1/projects/:slug/exec", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    const body = projectExecSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/projects/:slug/exec",
      action: "exec_once",
      projectSlug: params.data.slug,
    });
    if (!allowed) {
      return;
    }

    const projectRes = await pool.query<{
      project_path: string;
      project_name: string;
      status: string;
    }>(
      `SELECT project_path, project_name, status FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug],
    );
    const project = projectRes.rows[0];
    if (!project) {
      reply.code(404);
      return { error: "project_not_found" };
    }
    if (isRetiredProjectStatus(project.status)) {
      reply.code(409);
      return { error: "project_retired" };
    }

    const args = buildExecArgs(
      project.project_path,
      body.data.prompt,
      body.data.model,
    );
    let queuedTask;
    try {
      queuedTask = execManager.enqueue({
        projectSlug: params.data.slug,
        projectName: project.project_name,
        projectPath: project.project_path,
        prompt: body.data.prompt,
        model: body.data.model,
        command: ["codex", ...args],
        run: async (context) => {
          const startedAt = Date.now();
          return await new Promise((resolveRun) => {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            let timedOut = false;

            const child = spawn("codex", args, {
              cwd: project.project_path,
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            });

            context.registerCancel(() => {
              if (!child.killed) {
                child.kill("SIGTERM");
              }
            });

            const timeout = setTimeout(() => {
              timedOut = true;
              if (!child.killed) {
                child.kill("SIGTERM");
              }
            }, config.execTimeoutMs);

            child.stdout.on("data", async (chunk: Buffer) => {
              stdoutChunks.push(chunk.toString("utf8"));
            });

            child.stderr.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString("utf8"));
            });

            child.on("error", (error) => {
              clearTimeout(timeout);
              resolveRun({
                exitCode: -1,
                signal: null,
                durationMs: Date.now() - startedAt,
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                error: error.message,
              });
            });

            child.on("close", (code, signal) => {
              clearTimeout(timeout);
              resolveRun({
                exitCode: code ?? -1,
                signal: signal ?? null,
                durationMs: Date.now() - startedAt,
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                error: timedOut ? "exec_timeout" : undefined,
              });
            });
          });
        },
      });
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === "exec_queue_full") {
        reply.code(429);
        return { error: "exec_queue_full", message: err.message };
      }
      reply.code(500);
      return { error: "exec_enqueue_failed", message: err.message };
    }

    await writeExecAudit({
      request,
      projectSlug: params.data.slug,
      route: "/v1/projects/:slug/exec",
      action: "exec_once",
      status: "accepted",
      detail: {
        taskId: queuedTask.task.id,
        queuePosition: queuedTask.task.queuePosition,
      },
    });

    let finalTask;
    try {
      finalTask = await queuedTask.done;
    } catch (error) {
      const message = error instanceof Error ? error.message : "exec_failed";
      reply.code(500);
      return {
        taskId: queuedTask.task.id,
        status: "failed",
        projectSlug: params.data.slug,
        projectName: project.project_name,
        command: ["codex", ...args],
        durationMs: 0,
        exitCode: -1,
        signal: null,
        stdout: "",
        stderr: "",
        error: message,
      };
    }

    await writeExecAudit({
      request,
      projectSlug: params.data.slug,
      route: "/v1/projects/:slug/exec",
      action: "exec_once",
      status: finalTask.status,
      detail: {
        taskId: finalTask.id,
        exitCode: finalTask.exitCode,
        signal: finalTask.signal,
      },
    });

    if (finalTask.status === "failed") {
      reply.code(500);
    }

    return {
      taskId: finalTask.id,
      status: finalTask.status,
      queuePosition: finalTask.queuePosition,
      projectSlug: params.data.slug,
      projectName: project.project_name,
      command: ["codex", ...args],
      durationMs:
        finalTask.startedAt && finalTask.finishedAt
          ? new Date(finalTask.finishedAt).getTime() -
            new Date(finalTask.startedAt).getTime()
          : 0,
      exitCode: finalTask.exitCode ?? -1,
      signal: finalTask.signal,
      stdout: finalTask.stdout,
      stderr: finalTask.stderr,
      error: finalTask.error ?? undefined,
    };
  });

  app.post("/v1/projects/:slug/exec/stream", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    const body = projectExecSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/projects/:slug/exec/stream",
      action: "exec_stream",
      projectSlug: params.data.slug,
    });
    if (!allowed) {
      return;
    }

    const projectRes = await pool.query<{
      project_path: string;
      project_name: string;
      status: string;
    }>(
      `SELECT project_path, project_name, status FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug],
    );
    const project = projectRes.rows[0];
    if (!project) {
      reply.code(404);
      return { error: "project_not_found" };
    }
    if (isRetiredProjectStatus(project.status)) {
      reply.code(409);
      return { error: "project_retired" };
    }

    const requestedThreadId = body.data.threadId?.trim() || null;
    let resumeThreadId: string | null = null;
    if (requestedThreadId) {
      const threadCheck = await pool.query<{ thread_id: string }>(
        `SELECT thread_id FROM threads WHERE thread_id = $1 AND project_slug = $2 LIMIT 1`,
        [requestedThreadId, params.data.slug],
      );
      if (threadCheck.rows[0]?.thread_id) {
        resumeThreadId = threadCheck.rows[0].thread_id;
      }
    }

    const requestOrigin = normalizeOriginHeader(request.headers.origin);
    const corsOrigin = resolveCorsOriginForHijack(request.headers.origin);
    if (requestOrigin && !corsOrigin) {
      reply.code(403);
      return { error: "cors_origin_not_allowed" };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(corsOrigin
        ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" }
        : {}),
    });

    let finished = false;
    const send = (payload: Record<string, unknown>): void => {
      if (!finished) {
        reply.raw.write(`${JSON.stringify(payload)}\n`);
      }
    };
    const finish = (): void => {
      if (!finished) {
        finished = true;
        reply.raw.end();
      }
    };

    let queuedTask;
    try {
      queuedTask = execManager.enqueue({
        projectSlug: params.data.slug,
        projectName: project.project_name,
        projectPath: project.project_path,
        prompt: body.data.prompt,
        model: body.data.model,
        command: ["codex", "app-server", "--listen", "stdio://"],
        run: async (context) => {
          const startedAt = Date.now();
          return await new Promise((resolveRun) => {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            const assistantTextChunks: string[] = [];
            let timedOut = false;
            let resolved = false;
            let endSent = false;
            let appServerReady = false;
            let turnStarted = false;
            let outputBuffer = "";
            let reqId = 1;
            let timeout: NodeJS.Timeout | null = null;
            let runtimeThreadId = resumeThreadId;
            let runtimeTurnId: string | null = null;
            const runtimeProject: IngestProject = {
              slug: params.data.slug,
              name: project.project_name,
              path: project.project_path,
            };
            const persistStreamEvent = (event: RuntimeIngestEvent): void => {
              void persistRuntimeEvent(runtimeProject, event).catch((error) => {
                app.log.warn(
                  {
                    err: error,
                    route: "/v1/projects/:slug/exec/stream",
                    projectSlug: params.data.slug,
                    threadId: event.threadId,
                    turnId: event.turnId ?? null,
                    eventType: event.type,
                  },
                  "failed to persist runtime exec stream event",
                );
              });
            };
            const pendingMethods = new Map<string, string>();

            const resolveRunResult = (
              code: number | null,
              signal: NodeJS.Signals | null,
              error?: string,
            ) => {
              if (resolved) {
                return;
              }
              resolved = true;
              if (timeout) {
                clearTimeout(timeout);
                timeout = null;
              }
              const duration = Date.now() - startedAt;
              if (!endSent) {
                endSent = true;
                send({
                  type: "end",
                  taskId: context.task.id,
                  exitCode: code ?? -1,
                  signal: signal ?? null,
                  durationMs: duration,
                });
              }
              resolveRun({
                exitCode: code ?? -1,
                signal: signal ?? null,
                durationMs: duration,
                stdout: assistantTextChunks.join(""),
                stderr: stderrChunks.join(""),
                error: error ?? (timedOut ? "exec_timeout" : undefined),
              });
            };

            const sendRpcRequest = (
              childProcess: ReturnType<typeof spawn>,
              method: string,
              rpcParams: Record<string, unknown>,
            ): void => {
              if (!childProcess.stdin) {
                return;
              }
              const requestId = reqId;
              reqId += 1;
              pendingMethods.set(String(requestId), method);
              childProcess.stdin.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: requestId,
                  method,
                  params: rpcParams,
                })}\n`,
              );
            };

            const syncRuntimeIds = (
              paramsObj: Record<string, unknown>,
            ): { threadId: string | null; turnId: string | null } => {
              const nextThreadId =
                typeof paramsObj.threadId === "string" && paramsObj.threadId
                  ? paramsObj.threadId
                  : null;
              const nextTurnId =
                typeof paramsObj.turnId === "string" && paramsObj.turnId
                  ? paramsObj.turnId
                  : null;
              if (nextThreadId) {
                runtimeThreadId = nextThreadId;
              }
              if (nextTurnId) {
                runtimeTurnId = nextTurnId;
              }
              return {
                threadId: nextThreadId ?? runtimeThreadId,
                turnId: nextTurnId ?? runtimeTurnId,
              };
            };

            const startTurn = (
              childProcess: ReturnType<typeof spawn>,
              threadId: string,
            ): void => {
              if (turnStarted) {
                return;
              }
              turnStarted = true;
              const startTimestamp = new Date().toISOString();
              send({
                type: "start",
                taskId: context.task.id,
                projectSlug: params.data.slug,
                projectName: project.project_name,
                command: context.task.command,
                timestamp: startTimestamp,
                threadId,
              });
              persistStreamEvent({
                threadId,
                turnId: runtimeTurnId ?? undefined,
                type: "event_msg.user_prompt",
                status: "running",
                timestamp: startTimestamp,
                payload: {
                  role: "user",
                  message_text: body.data.prompt,
                },
              });
              persistStreamEvent({
                threadId,
                turnId: runtimeTurnId ?? undefined,
                type: "event_msg.turn_started",
                status: "running",
                timestamp: startTimestamp,
                payload: {
                  phase: "started",
                },
              });
              sendRpcRequest(childProcess, "turn/start", {
                threadId,
                ...(body.data.model ? { model: body.data.model } : {}),
                input: [
                  {
                    type: "text",
                    text: body.data.prompt,
                  },
                ],
              });
            };

            const child = spawn(
              "codex",
              ["app-server", "--listen", "stdio://"],
              {
                cwd: project.project_path,
                env: process.env,
                stdio: ["pipe", "pipe", "pipe"],
              },
            );

            context.registerCancel(() => {
              if (!child.killed) {
                child.kill("SIGTERM");
              }
            });

            timeout = setTimeout(() => {
              timedOut = true;
              if (!child.killed) {
                child.kill("SIGTERM");
              }
            }, config.execTimeoutMs);

            sendRpcRequest(child, "initialize", {
              clientInfo: {
                name: "codex-hub",
                version: "0.1.0",
              },
              capabilities: {
                experimentalApi: true,
              },
            });

            if (resumeThreadId) {
              sendRpcRequest(child, "thread/resume", {
                threadId: resumeThreadId,
                cwd: project.project_path,
                approvalPolicy: "never",
                sandbox: "workspace-write",
                ...(body.data.model ? { model: body.data.model } : {}),
              });
            } else {
              sendRpcRequest(child, "thread/start", {
                cwd: project.project_path,
                approvalPolicy: "never",
                sandbox: "workspace-write",
                ...(body.data.model ? { model: body.data.model } : {}),
              });
            }

            child.stdout.on("data", async (chunk: Buffer) => {
              const text = chunk.toString("utf8");
              stdoutChunks.push(text);
              outputBuffer += text;

              const lines = outputBuffer.split("\n");
              outputBuffer = lines.pop() ?? "";

              for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) {
                  continue;
                }
                let rpcMessage: Record<string, unknown>;
                try {
                  rpcMessage = JSON.parse(line) as Record<string, unknown>;
                } catch {
                  send({
                    type: "stdout",
                    taskId: context.task.id,
                    data: `${line}\n`,
                  });
                  continue;
                }

                if ("id" in rpcMessage) {
                  const responseId = String(rpcMessage.id);
                  const responseForMethod =
                    pendingMethods.get(responseId) ?? "";
                  pendingMethods.delete(responseId);

                  const errorObj = rpcMessage.error;
                  if (errorObj && typeof errorObj === "object") {
                    const message =
                      typeof (errorObj as Record<string, unknown>).message ===
                      "string"
                        ? ((errorObj as Record<string, unknown>)
                            .message as string)
                        : "app_server_rpc_error";
                    if (responseForMethod === "thread/resume") {
                      sendRpcRequest(child, "thread/start", {
                        cwd: project.project_path,
                        approvalPolicy: "never",
                        sandbox: "workspace-write",
                        ...(body.data.model ? { model: body.data.model } : {}),
                      });
                    } else {
                      send({ type: "error", taskId: context.task.id, message });
                      if (!child.killed) {
                        child.kill("SIGTERM");
                      }
                      resolveRunResult(-1, null, message);
                    }
                    continue;
                  }

                  const resultObj = rpcMessage.result;
                  if (
                    resultObj &&
                    typeof resultObj === "object" &&
                    "thread" in (resultObj as Record<string, unknown>) &&
                    (resultObj as Record<string, unknown>).thread &&
                    typeof (resultObj as Record<string, unknown>).thread ===
                      "object"
                  ) {
                    const threadObj = (resultObj as Record<string, unknown>)
                      .thread as Record<string, unknown>;
                    if (typeof threadObj.id === "string" && threadObj.id) {
                      runtimeThreadId = threadObj.id;
                      send({
                        type: "thread",
                        taskId: context.task.id,
                        threadId: runtimeThreadId,
                      });
                    }
                  }

                  if (!appServerReady && runtimeThreadId) {
                    appServerReady = true;
                    startTurn(child, runtimeThreadId);
                  }

                  continue;
                }

                const method =
                  typeof rpcMessage.method === "string"
                    ? rpcMessage.method
                    : "";
                const notifParams =
                  rpcMessage.params && typeof rpcMessage.params === "object"
                    ? (rpcMessage.params as Record<string, unknown>)
                    : {};
                const runtimeStepEvent = buildRuntimeStepEvent(
                  method,
                  notifParams,
                );
                if (runtimeStepEvent) {
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  if (threadId) {
                    persistStreamEvent({
                      ...runtimeStepEvent,
                      threadId,
                      turnId: turnId ?? undefined,
                    });
                  }
                  continue;
                }

                if (method === "item/agentMessage/delta") {
                  const delta =
                    typeof notifParams.delta === "string"
                      ? notifParams.delta
                      : "";
                  if (!delta) {
                    continue;
                  }
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  assistantTextChunks.push(delta);
                  send({
                    type: "assistant_delta",
                    taskId: context.task.id,
                    data: delta,
                    itemId:
                      typeof notifParams.itemId === "string"
                        ? notifParams.itemId
                        : null,
                    threadId,
                    turnId,
                  });
                  continue;
                }

                if (method === "item/completed") {
                  const itemObj =
                    notifParams.item && typeof notifParams.item === "object"
                      ? (notifParams.item as Record<string, unknown>)
                      : {};
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  if (
                    itemObj.type === "agentMessage" &&
                    typeof itemObj.text === "string"
                  ) {
                    send({
                      type: "assistant_message",
                      taskId: context.task.id,
                      text: itemObj.text,
                      itemId:
                        typeof itemObj.id === "string" ? itemObj.id : null,
                      threadId,
                      turnId,
                    });
                    if (threadId) {
                      persistStreamEvent({
                        threadId,
                        turnId: turnId ?? undefined,
                        type: "event_msg.agent_message",
                        timestamp: new Date().toISOString(),
                        payload: {
                          role: "assistant",
                          message_text: itemObj.text,
                        },
                      });
                    }
                  }
                  continue;
                }

                if (method === "item/commandExecution/outputDelta") {
                  const delta =
                    typeof notifParams.delta === "string"
                      ? notifParams.delta
                      : "";
                  if (delta) {
                    send({
                      type: "stdout",
                      taskId: context.task.id,
                      data: delta,
                    });
                  }
                  continue;
                }

                if (method === "error") {
                  const errorObj =
                    notifParams.error && typeof notifParams.error === "object"
                      ? (notifParams.error as Record<string, unknown>)
                      : {};
                  const message =
                    (typeof errorObj.message === "string"
                      ? errorObj.message
                      : null) ??
                    (typeof notifParams.message === "string"
                      ? notifParams.message
                      : null) ??
                    "app_server_turn_error";
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  send({ type: "error", taskId: context.task.id, message });
                  if (threadId) {
                    persistStreamEvent({
                      threadId,
                      turnId: turnId ?? undefined,
                      type: "event_msg.turn_error",
                      status: "failed",
                      errorMessage: message,
                      timestamp: new Date().toISOString(),
                      payload: { message },
                    });
                  }
                  continue;
                }

                if (method === "turn/completed") {
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  if (threadId) {
                    try {
                      await persistChangeSummaryForTurn(
                        runtimeProject,
                        threadId,
                        turnId,
                      );
                    } catch (error) {
                      app.log.warn(
                        {
                          err: error,
                          threadId,
                          turnId: turnId ?? null,
                          projectSlug: runtimeProject.slug,
                        },
                        "failed to persist change summary for completed turn",
                      );
                    }
                    persistStreamEvent({
                      threadId,
                      turnId: turnId ?? undefined,
                      type: "event_msg.turn_completed",
                      status: "completed",
                      timestamp: new Date().toISOString(),
                      payload: {},
                    });
                  }
                  if (!endSent) {
                    endSent = true;
                    const duration = Date.now() - startedAt;
                    send({
                      type: "end",
                      taskId: context.task.id,
                      exitCode: 0,
                      signal: null,
                      durationMs: duration,
                    });
                  }
                  if (!child.killed) {
                    child.kill("SIGTERM");
                  }
                  resolveRunResult(0, null);
                  continue;
                }
              }
            });

            child.stderr.on("data", (chunk: Buffer) => {
              const text = chunk.toString("utf8");
              stderrChunks.push(text);
              send({ type: "stderr", taskId: context.task.id, data: text });
            });

            child.on("error", (error) => {
              send({
                type: "error",
                taskId: context.task.id,
                message: error.message,
              });
              if (runtimeThreadId) {
                persistStreamEvent({
                  threadId: runtimeThreadId,
                  turnId: runtimeTurnId ?? undefined,
                  type: "event_msg.turn_error",
                  status: "failed",
                  errorMessage: error.message,
                  timestamp: new Date().toISOString(),
                  payload: { message: error.message },
                });
              }
              resolveRunResult(-1, null, error.message);
            });

            child.on("close", (code, signal) => {
              if (
                !resolved &&
                runtimeThreadId &&
                ((code ?? 0) !== 0 || signal)
              ) {
                const closeMessage = signal
                  ? `terminated:${signal}`
                  : `exit_${code ?? -1}`;
                persistStreamEvent({
                  threadId: runtimeThreadId,
                  turnId: runtimeTurnId ?? undefined,
                  type: "event_msg.turn_error",
                  status: "failed",
                  errorMessage: closeMessage,
                  timestamp: new Date().toISOString(),
                  payload: {
                    exitCode: code ?? null,
                    signal: signal ?? null,
                  },
                });
              }
              resolveRunResult(code, signal);
            });
          });
        },
      });
    } catch (error) {
      const err = error as Error & { code?: string };
      send({
        type: "error",
        message:
          err.code === "exec_queue_full" ? "exec_queue_full" : err.message,
      });
      finish();
      return;
    }

    if (queuedTask.task.queuePosition > 0) {
      send({
        type: "queued",
        taskId: queuedTask.task.id,
        queuePosition: queuedTask.task.queuePosition,
      });
    }

    await writeExecAudit({
      request,
      projectSlug: params.data.slug,
      route: "/v1/projects/:slug/exec/stream",
      action: "exec_stream",
      status: "accepted",
      detail: {
        taskId: queuedTask.task.id,
        queuePosition: queuedTask.task.queuePosition,
      },
    });

    request.raw.on("close", () => {
      execManager.cancel(queuedTask.task.id);
      finish();
    });

    void queuedTask.done
      .then(async (task) => {
        await writeExecAudit({
          request,
          projectSlug: params.data.slug,
          route: "/v1/projects/:slug/exec/stream",
          action: "exec_stream",
          status: task.status,
          detail: {
            taskId: task.id,
            exitCode: task.exitCode,
            signal: task.signal,
          },
        });
        finish();
      })
      .catch(() => {
        finish();
      });
  });

  app.post("/v1/threads/:threadId/exec/stream", async (request, reply) => {
    const paramsSchema = z.object({ threadId: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    const body = projectExecSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const threadRes = await pool.query<{
      project_slug: string;
      project_name: string;
      project_path: string;
      project_status: string;
    }>(
      `
      SELECT t.project_slug, p.project_name, p.project_path, p.status AS project_status
      FROM threads t
      JOIN projects p ON p.project_slug = t.project_slug
      WHERE t.thread_id = $1
      LIMIT 1
      `,
      [params.data.threadId],
    );
    const thread = threadRes.rows[0];
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }
    if (isRetiredProjectStatus(thread.project_status)) {
      reply.code(409);
      return { error: "project_retired" };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/threads/:threadId/exec/stream",
      action: "exec_stream_resume",
      projectSlug: thread.project_slug,
    });
    if (!allowed) {
      return;
    }

    const requestOrigin = normalizeOriginHeader(request.headers.origin);
    const corsOrigin = resolveCorsOriginForHijack(request.headers.origin);
    if (requestOrigin && !corsOrigin) {
      reply.code(403);
      return { error: "cors_origin_not_allowed" };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(corsOrigin
        ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" }
        : {}),
    });

    let finished = false;
    const send = (payload: Record<string, unknown>): void => {
      if (!finished) {
        reply.raw.write(`${JSON.stringify(payload)}\n`);
      }
    };
    const finish = (): void => {
      if (!finished) {
        finished = true;
        reply.raw.end();
      }
    };

    let queuedTask;
    try {
      queuedTask = execManager.enqueue({
        projectSlug: thread.project_slug,
        projectName: thread.project_name,
        projectPath: thread.project_path,
        prompt: body.data.prompt,
        model: body.data.model,
        command: ["codex", "app-server", "--listen", "stdio://"],
        run: async (context) => {
          const startedAt = Date.now();
          return await new Promise((resolveRun) => {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            const assistantTextChunks: string[] = [];
            let timedOut = false;
            let resolved = false;
            let endSent = false;
            let appServerReady = false;
            let turnStarted = false;
            let outputBuffer = "";
            let reqId = 1;
            let timeout: NodeJS.Timeout | null = null;
            let runtimeThreadId: string | null = params.data.threadId;
            let runtimeTurnId: string | null = null;
            const runtimeProject: IngestProject = {
              slug: thread.project_slug,
              name: thread.project_name,
              path: thread.project_path,
            };
            const persistStreamEvent = (event: RuntimeIngestEvent): void => {
              void persistRuntimeEvent(runtimeProject, event).catch((error) => {
                app.log.warn(
                  {
                    err: error,
                    route: "/v1/threads/:threadId/exec/stream",
                    projectSlug: thread.project_slug,
                    threadId: event.threadId,
                    turnId: event.turnId ?? null,
                    eventType: event.type,
                  },
                  "failed to persist runtime thread stream event",
                );
              });
            };

            const resolveRunResult = (
              code: number | null,
              signal: NodeJS.Signals | null,
              error?: string,
            ) => {
              if (resolved) {
                return;
              }
              resolved = true;
              if (timeout) {
                clearTimeout(timeout);
                timeout = null;
              }
              const duration = Date.now() - startedAt;
              if (!endSent) {
                endSent = true;
                send({
                  type: "end",
                  taskId: context.task.id,
                  exitCode: code ?? -1,
                  signal: signal ?? null,
                  durationMs: duration,
                });
              }
              resolveRun({
                exitCode: code ?? -1,
                signal: signal ?? null,
                durationMs: duration,
                stdout: assistantTextChunks.join(""),
                stderr: stderrChunks.join(""),
                error: error ?? (timedOut ? "exec_timeout" : undefined),
              });
            };

            const sendRpcRequest = (
              childProcess: ReturnType<typeof spawn>,
              method: string,
              rpcParams: Record<string, unknown>,
            ): void => {
              if (!childProcess.stdin) {
                return;
              }
              const req = {
                jsonrpc: "2.0",
                id: reqId,
                method,
                params: rpcParams,
              };
              reqId += 1;
              childProcess.stdin.write(`${JSON.stringify(req)}\n`);
            };

            const syncRuntimeIds = (
              paramsObj: Record<string, unknown>,
            ): { threadId: string | null; turnId: string | null } => {
              const nextThreadId =
                typeof paramsObj.threadId === "string" && paramsObj.threadId
                  ? paramsObj.threadId
                  : null;
              const nextTurnId =
                typeof paramsObj.turnId === "string" && paramsObj.turnId
                  ? paramsObj.turnId
                  : null;
              if (nextThreadId) {
                runtimeThreadId = nextThreadId;
              }
              if (nextTurnId) {
                runtimeTurnId = nextTurnId;
              }
              return {
                threadId: nextThreadId ?? runtimeThreadId,
                turnId: nextTurnId ?? runtimeTurnId,
              };
            };

            send({
              type: "start",
              taskId: context.task.id,
              projectSlug: thread.project_slug,
              projectName: thread.project_name,
              command: context.task.command,
              timestamp: new Date().toISOString(),
              threadId: params.data.threadId,
            });

            const child = spawn(
              "codex",
              ["app-server", "--listen", "stdio://"],
              {
                cwd: thread.project_path,
                env: process.env,
                stdio: ["pipe", "pipe", "pipe"],
              },
            );

            context.registerCancel(() => {
              if (!child.killed) {
                child.kill("SIGTERM");
              }
            });

            timeout = setTimeout(() => {
              timedOut = true;
              if (!child.killed) {
                child.kill("SIGTERM");
              }
            }, config.execTimeoutMs);

            sendRpcRequest(child, "initialize", {
              clientInfo: {
                name: "codex-hub",
                version: "0.1.0",
              },
              capabilities: {
                experimentalApi: true,
              },
            });

            sendRpcRequest(child, "thread/resume", {
              threadId: params.data.threadId,
              cwd: thread.project_path,
              approvalPolicy: "never",
              sandbox: "workspace-write",
              ...(body.data.model ? { model: body.data.model } : {}),
            });

            child.stdout.on("data", async (chunk: Buffer) => {
              const text = chunk.toString("utf8");
              stdoutChunks.push(text);
              outputBuffer += text;

              const lines = outputBuffer.split("\n");
              outputBuffer = lines.pop() ?? "";

              for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) {
                  continue;
                }

                let rpcMessage: Record<string, unknown>;
                try {
                  rpcMessage = JSON.parse(line) as Record<string, unknown>;
                } catch {
                  send({
                    type: "stdout",
                    taskId: context.task.id,
                    data: `${line}\n`,
                  });
                  continue;
                }

                if ("id" in rpcMessage) {
                  const resultObj = rpcMessage.result;
                  const errorObj = rpcMessage.error;
                  if (errorObj && typeof errorObj === "object") {
                    const msg =
                      typeof (errorObj as Record<string, unknown>).message ===
                      "string"
                        ? ((errorObj as Record<string, unknown>)
                            .message as string)
                        : "app_server_rpc_error";
                    send({
                      type: "error",
                      taskId: context.task.id,
                      message: msg,
                    });
                    continue;
                  }

                  if (
                    !appServerReady &&
                    resultObj &&
                    typeof resultObj === "object" &&
                    "thread" in (resultObj as Record<string, unknown>)
                  ) {
                    appServerReady = true;
                    const threadObj = (resultObj as Record<string, unknown>)
                      .thread;
                    if (threadObj && typeof threadObj === "object") {
                      const threadId = (threadObj as Record<string, unknown>)
                        .id;
                      if (typeof threadId === "string" && threadId) {
                        runtimeThreadId = threadId;
                      }
                    }
                    if (!turnStarted) {
                      turnStarted = true;
                      const startTimestamp = new Date().toISOString();
                      persistStreamEvent({
                        threadId: runtimeThreadId ?? params.data.threadId,
                        turnId: runtimeTurnId ?? undefined,
                        type: "event_msg.user_prompt",
                        status: "running",
                        timestamp: startTimestamp,
                        payload: {
                          role: "user",
                          message_text: body.data.prompt,
                        },
                      });
                      persistStreamEvent({
                        threadId: runtimeThreadId ?? params.data.threadId,
                        turnId: runtimeTurnId ?? undefined,
                        type: "event_msg.turn_started",
                        status: "running",
                        timestamp: startTimestamp,
                        payload: {
                          phase: "started",
                        },
                      });
                      sendRpcRequest(child, "turn/start", {
                        threadId: params.data.threadId,
                        ...(body.data.model ? { model: body.data.model } : {}),
                        input: [
                          {
                            type: "text",
                            text: body.data.prompt,
                          },
                        ],
                      });
                    }
                  }
                  continue;
                }

                const method =
                  typeof rpcMessage.method === "string"
                    ? rpcMessage.method
                    : "";
                const notifParams =
                  rpcMessage.params && typeof rpcMessage.params === "object"
                    ? (rpcMessage.params as Record<string, unknown>)
                    : {};
                const runtimeStepEvent = buildRuntimeStepEvent(
                  method,
                  notifParams,
                );
                if (runtimeStepEvent) {
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  if (threadId) {
                    persistStreamEvent({
                      ...runtimeStepEvent,
                      threadId,
                      turnId: turnId ?? undefined,
                    });
                  }
                  continue;
                }

                if (method === "item/agentMessage/delta") {
                  const delta =
                    typeof notifParams.delta === "string"
                      ? notifParams.delta
                      : "";
                  if (!delta) {
                    continue;
                  }
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  assistantTextChunks.push(delta);
                  send({
                    type: "assistant_delta",
                    taskId: context.task.id,
                    data: delta,
                    itemId:
                      typeof notifParams.itemId === "string"
                        ? notifParams.itemId
                        : null,
                    threadId,
                    turnId,
                  });
                  continue;
                }

                if (method === "item/completed") {
                  const itemObj =
                    notifParams.item && typeof notifParams.item === "object"
                      ? (notifParams.item as Record<string, unknown>)
                      : {};
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  if (
                    itemObj.type === "agentMessage" &&
                    typeof itemObj.text === "string"
                  ) {
                    send({
                      type: "assistant_message",
                      taskId: context.task.id,
                      text: itemObj.text,
                      itemId:
                        typeof itemObj.id === "string" ? itemObj.id : null,
                      threadId,
                      turnId,
                    });
                    if (threadId) {
                      persistStreamEvent({
                        threadId,
                        turnId: turnId ?? undefined,
                        type: "event_msg.agent_message",
                        timestamp: new Date().toISOString(),
                        payload: {
                          role: "assistant",
                          message_text: itemObj.text,
                        },
                      });
                    }
                  }
                  continue;
                }

                if (method === "item/commandExecution/outputDelta") {
                  const delta =
                    typeof notifParams.delta === "string"
                      ? notifParams.delta
                      : "";
                  if (delta) {
                    send({
                      type: "stdout",
                      taskId: context.task.id,
                      data: delta,
                    });
                  }
                  continue;
                }

                if (method === "error") {
                  const errorObj =
                    notifParams.error && typeof notifParams.error === "object"
                      ? (notifParams.error as Record<string, unknown>)
                      : {};
                  const message =
                    (typeof errorObj.message === "string"
                      ? errorObj.message
                      : null) ??
                    (typeof notifParams.message === "string"
                      ? notifParams.message
                      : null) ??
                    "app_server_turn_error";
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  send({ type: "error", taskId: context.task.id, message });
                  if (threadId) {
                    persistStreamEvent({
                      threadId,
                      turnId: turnId ?? undefined,
                      type: "event_msg.turn_error",
                      status: "failed",
                      errorMessage: message,
                      timestamp: new Date().toISOString(),
                      payload: { message },
                    });
                  }
                  continue;
                }

                if (method === "turn/completed") {
                  const { threadId, turnId } = syncRuntimeIds(notifParams);
                  if (threadId) {
                    try {
                      await persistChangeSummaryForTurn(
                        runtimeProject,
                        threadId,
                        turnId,
                      );
                    } catch (error) {
                      app.log.warn(
                        {
                          err: error,
                          threadId,
                          turnId: turnId ?? null,
                          projectSlug: runtimeProject.slug,
                        },
                        "failed to persist change summary for completed turn",
                      );
                    }
                    persistStreamEvent({
                      threadId,
                      turnId: turnId ?? undefined,
                      type: "event_msg.turn_completed",
                      status: "completed",
                      timestamp: new Date().toISOString(),
                      payload: {},
                    });
                  }
                  if (!endSent) {
                    endSent = true;
                    const duration = Date.now() - startedAt;
                    send({
                      type: "end",
                      taskId: context.task.id,
                      exitCode: 0,
                      signal: null,
                      durationMs: duration,
                    });
                  }
                  if (!child.killed) {
                    child.kill("SIGTERM");
                  }
                  resolveRunResult(0, null);
                }
              }
            });

            child.stderr.on("data", (chunk: Buffer) => {
              const text = chunk.toString("utf8");
              stderrChunks.push(text);
              send({ type: "stderr", taskId: context.task.id, data: text });
            });

            child.on("error", (error) => {
              send({
                type: "error",
                taskId: context.task.id,
                message: error.message,
              });
              if (runtimeThreadId) {
                persistStreamEvent({
                  threadId: runtimeThreadId,
                  turnId: runtimeTurnId ?? undefined,
                  type: "event_msg.turn_error",
                  status: "failed",
                  errorMessage: error.message,
                  timestamp: new Date().toISOString(),
                  payload: { message: error.message },
                });
              }
              resolveRunResult(-1, null, error.message);
            });

            child.on("close", (code, signal) => {
              if (
                !resolved &&
                runtimeThreadId &&
                ((code ?? 0) !== 0 || signal)
              ) {
                const closeMessage = signal
                  ? `terminated:${signal}`
                  : `exit_${code ?? -1}`;
                persistStreamEvent({
                  threadId: runtimeThreadId,
                  turnId: runtimeTurnId ?? undefined,
                  type: "event_msg.turn_error",
                  status: "failed",
                  errorMessage: closeMessage,
                  timestamp: new Date().toISOString(),
                  payload: {
                    exitCode: code ?? null,
                    signal: signal ?? null,
                  },
                });
              }
              resolveRunResult(code, signal);
            });
          });
        },
      });
    } catch (error) {
      const err = error as Error & { code?: string };
      send({
        type: "error",
        message:
          err.code === "exec_queue_full" ? "exec_queue_full" : err.message,
      });
      finish();
      return;
    }

    if (queuedTask.task.queuePosition > 0) {
      send({
        type: "queued",
        taskId: queuedTask.task.id,
        queuePosition: queuedTask.task.queuePosition,
      });
    }

    await writeExecAudit({
      request,
      projectSlug: thread.project_slug,
      route: "/v1/threads/:threadId/exec/stream",
      action: "exec_stream_resume",
      status: "accepted",
      detail: {
        taskId: queuedTask.task.id,
        queuePosition: queuedTask.task.queuePosition,
        threadId: params.data.threadId,
      },
    });

    request.raw.on("close", () => {
      execManager.cancel(queuedTask.task.id);
      finish();
    });

    void queuedTask.done
      .then(async (task) => {
        await writeExecAudit({
          request,
          projectSlug: thread.project_slug,
          route: "/v1/threads/:threadId/exec/stream",
          action: "exec_stream_resume",
          status: task.status,
          detail: {
            taskId: task.id,
            exitCode: task.exitCode,
            signal: task.signal,
            threadId: params.data.threadId,
          },
        });
        finish();
      })
      .catch(() => {
        finish();
      });
  });

  app.get("/v1/threads/:threadId/transcript", async (request, reply) => {
    const paramsSchema = z.object({ threadId: z.string().min(1) });
    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(600),
    });

    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query ?? {});

    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    const threadProjectRes = await pool.query<{ project_slug: string }>(
      `SELECT project_slug FROM threads WHERE thread_id = $1 LIMIT 1`,
      [params.data.threadId],
    );
    const threadProject = threadProjectRes.rows[0];
    if (!threadProject) {
      reply.code(404);
      return { error: "thread_not_found" };
    }

    await reconcileRuntimeState(threadProject.project_slug);

    const [threadRes, eventsRes, turnsRes] = await Promise.all([
      pool.query<{
        thread_id: string;
        project_slug: string;
        project_name: string;
        project_status: string;
        title: string | null;
        status: string | null;
        started_at: string | null;
        updated_at: string;
        last_turn_id: string | null;
      }>(
        `
        SELECT
          t.thread_id,
          t.project_slug,
          p.project_name,
          p.status AS project_status,
          t.title,
          t.status,
          t.started_at,
          t.updated_at,
          t.last_turn_id
        FROM threads t
        INNER JOIN projects p ON p.project_slug = t.project_slug
        WHERE t.thread_id = $1
        LIMIT 1
        `,
        [params.data.threadId],
      ),
      pool.query<{
        event_id: string;
        thread_id: string;
        turn_id: string | null;
        event_type: string;
        status: string | null;
        title: string | null;
        error_message: string | null;
        payload_json: Record<string, unknown>;
        event_ts: string;
      }>(
        `
        SELECT *
        FROM (
          SELECT event_id, thread_id, turn_id, event_type, status, title, error_message, payload_json, event_ts
          FROM events
          WHERE thread_id = $1
          ORDER BY event_ts DESC
          LIMIT $2
        ) recent_events
        ORDER BY event_ts ASC
        `,
        [params.data.threadId, query.data.limit],
      ),
      pool.query<{
        turn_id: string;
        status: string | null;
        started_at: string | null;
        completed_at: string | null;
        updated_at: string;
        error_message: string | null;
      }>(
        `
        SELECT *
        FROM (
          SELECT turn_id, status, started_at, completed_at, updated_at, error_message
          FROM turns
          WHERE thread_id = $1
          ORDER BY updated_at DESC
          LIMIT $2
        ) recent_turns
        ORDER BY started_at ASC NULLS LAST, updated_at ASC
        `,
        [params.data.threadId, query.data.limit],
      ),
    ]);

    const thread = threadRes.rows[0];
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }

    const messages = dedupeTranscriptMessages(
      eventsRes.rows
        .map((row) => toTranscriptMessage(row))
        .filter((row): row is NonNullable<ReturnType<typeof toTranscriptMessage>> => row !== null),
    );
    const events = dedupeTranscriptEvents(
      eventsRes.rows
        .map((row) => toTranscriptEvent(row))
        .filter((row): row is NonNullable<ReturnType<typeof toTranscriptEvent>> => row !== null),
    );
    const changeSummaries = dedupeTranscriptChangeSummaries(
      eventsRes.rows
        .map((row) => toTranscriptChangeSummary(row))
        .filter(
          (row): row is NonNullable<ReturnType<typeof toTranscriptChangeSummary>> =>
            row !== null,
        ),
    );

    const latestTurn = turnsRes.rows.length > 0 ? turnsRes.rows[turnsRes.rows.length - 1] : null;
    const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    const activeAgentCount = listProjectAgents(thread.project_slug).filter(
      (agent) => agent.status === "running" || agent.status === "starting",
    ).length;
    const activeTaskCount = listProjectActiveExecTasks(thread.project_slug).length;

    return {
      context: buildTranscriptContext({
        thread,
        latestTurn,
        latestMessage,
        activeAgentCount,
        activeTaskCount,
      }),
      turns: buildTranscriptTurns(turnsRes.rows, messages, events),
      events,
      messages,
      changeSummaries,
    };
  });

  app.get("/v1/threads/:threadId/events", async (request, reply) => {
    const paramsSchema = z.object({ threadId: z.string().min(1) });
    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    });

    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query ?? {});

    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    const result = await pool.query(
      `
      SELECT event_id, COALESCE(t.project_slug, e.project_slug) AS project_slug, e.thread_id, e.turn_id, e.event_type, e.status, e.title, e.error_message, e.payload_json, e.event_ts
      FROM events e
      LEFT JOIN threads t ON t.thread_id = e.thread_id
      WHERE e.thread_id = $1
      ORDER BY event_ts DESC
      LIMIT $2
      `,
      [params.data.threadId, query.data.limit],
    );

    return result.rows;
  });

  app.get("/v1/threads/:threadId/messages", async (request, reply) => {
    const paramsSchema = z.object({ threadId: z.string().min(1) });
    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(300),
    });

    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query ?? {});

    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    const result = await pool.query<{
      event_id: string;
      event_type: string;
      status: string | null;
      event_ts: string;
      payload_json: Record<string, unknown>;
      title: string | null;
      error_message: string | null;
    }>(
      `
      SELECT event_id, event_type, status, event_ts, payload_json, title, error_message
      FROM events
      WHERE thread_id = $1
      ORDER BY event_ts ASC
      LIMIT $2
      `,
      [params.data.threadId, query.data.limit],
    );

    const messages = result.rows
      .map((item) => {
        const payload = item.payload_json ?? {};
        const roleFromPayload =
          typeof payload.role === "string" ? payload.role : null;
        const textFromPayload =
          typeof payload.message_text === "string"
            ? payload.message_text
            : null;
        const fallbackText = item.title ?? item.error_message ?? null;
        const text = textFromPayload ?? fallbackText;
        if (!text) {
          return null;
        }

        const role =
          roleFromPayload ??
          (item.event_type.includes("user")
            ? "user"
            : item.event_type.includes("agent") ||
                item.event_type.includes("assistant")
              ? "assistant"
              : "system");
        if (role !== "user" && role !== "assistant") {
          return null;
        }
        if (
          role === "user" &&
          (text.includes("AGENTS.md instructions for") ||
            text.includes("<INSTRUCTIONS>"))
        ) {
          return null;
        }

        return {
          messageId: item.event_id,
          eventType: item.event_type,
          role,
          text,
          status: item.status,
          timestamp: item.event_ts,
        };
      })
      .filter(
        (
          item,
        ): item is {
          messageId: string;
          eventType: string;
          role: "user" | "assistant";
          text: string;
          status: string | null;
          timestamp: string;
        } => item !== null,
      );

    return messages;
  });

  app.get("/v1/stream/events", async (request, reply) => {
    const querySchema = z.object({ projectSlug: z.string().optional() });
    const query = querySchema.safeParse(request.query ?? {});
    if (!query.success) {
      reply.code(400);
      return { error: "invalid_query" };
    }

    const requestOrigin = normalizeOriginHeader(request.headers.origin);
    const corsOrigin = resolveCorsOriginForHijack(request.headers.origin);
    if (requestOrigin && !corsOrigin) {
      reply.code(403);
      return { error: "cors_origin_not_allowed" };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(corsOrigin
        ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" }
        : {}),
    });

    const filterSlug = query.data.projectSlug;
    const push = (message: Record<string, unknown>): void => {
      if (filterSlug && message.project !== filterSlug) {
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
    };

    const unsubscribe = eventBus.subscribe(push);
    const keepAlive = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
};
