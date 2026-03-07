import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { agentManager } from "./agent-manager.js";
import { runRetentionCleanup } from "./cleanup.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ExecManager } from "./exec-manager.js";
import { ensureExecAccess, writeExecAudit } from "./security.js";
import { eventBus } from "./sse-bus.js";

const projectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1)
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
  payload: z.record(z.unknown()).default({})
});

const ingestSchema = z.object({
  project: projectSchema,
  events: z.array(eventSchema).min(1).max(1000)
});

const upsertProjectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1)
});

const projectExecSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  threadId: z.string().min(1).optional()
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
  ingestApiKey: z.string().optional()
});

const cleanupSchema = z.object({
  retentionDays: z.coerce.number().int().min(1).max(3650).optional()
});

type IngestEvent = z.infer<typeof eventSchema>;
type IngestProject = z.infer<typeof projectSchema>;
const execManager = new ExecManager(config.execQueueSize);

const parseDate = (value: string): Date => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
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

const normalizeOriginHeader = (origin: string | string[] | undefined): string | undefined => {
  if (Array.isArray(origin)) {
    return origin[0];
  }
  return origin;
};

const resolveCorsOriginForHijack = (originHeader: string | string[] | undefined): string | null => {
  if (config.corsOrigins.includes("*")) {
    return "*";
  }
  const origin = normalizeOriginHeader(originHeader);
  if (!origin) {
    return null;
  }
  return config.corsOrigins.includes(origin) ? origin : null;
};

const buildExecArgs = (projectPath: string, prompt: string, model?: string): string[] => {
  const args = ["exec", "--cd", projectPath, "--skip-git-repo-check"];
  if (model) {
    args.push("--model", model);
  }
  args.push(prompt);
  return args;
};

const validateProjectPath = async (projectPath: string): Promise<{
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
        entries: 0
      };
    }

    const names = await readdir(projectPath);
    return {
      exists: true,
      isDirectory: true,
      hasGit: names.includes(".git"),
      hasPackageJson: names.includes("package.json"),
      entries: names.length
    };
  } catch {
    return {
      exists: false,
      isDirectory: false,
      hasGit: false,
      hasPackageJson: false,
      entries: 0
    };
  }
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
      last_seen_at = NOW()
    `,
    [project.slug, project.name, project.path]
  );
};

const applyEvent = async (project: IngestProject, event: IngestEvent): Promise<boolean> => {
  const eventTs = parseDate(event.timestamp);

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
      project.slug,
      event.threadId,
      event.turnId ?? null,
      event.type,
      event.status ?? null,
      event.title ?? null,
      event.errorMessage ?? null,
      JSON.stringify(event.payload),
      eventTs.toISOString()
    ]
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
      project.slug,
      event.title ?? null,
      event.status ?? null,
      eventTs.toISOString(),
      event.turnId ?? null
    ]
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
        project.slug,
        event.status ?? null,
        eventTs.toISOString(),
        event.status === "completed" || event.status === "failed" ? eventTs.toISOString() : null,
        event.errorMessage ?? null
      ]
    );
  }

  return true;
};

export const registerRoutes = async (app: FastifyInstance): Promise<void> => {
  validateIngestApiKey(app);

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
      action: "retention_cleanup"
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
        detail: pathCheck
      };
    }

    await upsertProject({
      slug: body.data.slug,
      name: body.data.name,
      path: body.data.path
    });

    return {
      ok: true,
      project: body.data,
      validation: pathCheck
    };
  });

  app.put("/v1/projects/:slug", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const params = paramsSchema.safeParse(request.params);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        status: z.string().min(1).optional()
      })
      .safeParse(request.body);

    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "invalid_request" };
    }

    const currentRes = await pool.query<{ project_name: string; project_path: string; status: string }>(
      `SELECT project_name, project_path, status FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug]
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

    const result = await pool.query<{ slug: string; name: string; path: string; status: string; last_seen_at: string }>(
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
      [params.data.slug, body.data.name ?? null, body.data.path ?? null, body.data.status ?? null]
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
      [params.data.slug]
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
      detail
    };
  });

  app.get("/v1/agents", async () => {
    const agents = agentManager.list();
    return {
      total: agents.length,
      agents
    };
  });

  app.post("/v1/agents/start", async (request, reply) => {
    const body = startAgentSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: "invalid_body", detail: body.error.flatten() };
    }

    const projectResult = await pool.query<{ project_name: string; project_path: string }>(
      `
      SELECT project_name, project_path
      FROM projects
      WHERE project_slug = $1
      LIMIT 1
      `,
      [body.data.projectSlug]
    );

    const projectName = body.data.projectName ?? projectResult.rows[0]?.project_name;
    const projectPath = body.data.projectPath ?? projectResult.rows[0]?.project_path;

    if (!projectName || !projectPath) {
      reply.code(400);
      return {
        error: "project_info_required",
        message: "projectName/projectPath missing and project not found in db"
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
      path: projectPath
    });

    try {
      const agent = agentManager.start({
        projectSlug: body.data.projectSlug,
        projectName,
        projectPath,
        sessionsRoot: body.data.sessionsRoot ?? join(homedir(), ".codex", "sessions"),
        scanIntervalMs: body.data.scanIntervalMs ?? 5000,
        maxFiles: body.data.maxFiles ?? 20,
        stateFile: body.data.stateFile,
        hubUrl: body.data.hubUrl ?? `http://127.0.0.1:${config.port}`,
        ingestApiKey: body.data.ingestApiKey ?? config.ingestApiKey,
        autoStart: true
      });

      return {
        ok: true,
        agent,
        validation: pathCheck
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
      agent
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
      const inserted = await applyEvent(project, event);
      if (inserted) {
        insertedCount += 1;
        eventBus.publish({ project: project.slug, ...event });
      }
    }

    return {
      accepted: events.length,
      inserted: insertedCount,
      duplicated: events.length - insertedCount
    };
  });

  app.get("/v1/overview", async () => {
    const [projectCountRes, threadStatusRes, recentRes] = await Promise.all([
      pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM projects"),
      pool.query<{ status: string | null; count: string }>(
        "SELECT COALESCE(status, 'unknown') AS status, COUNT(*)::text AS count FROM threads GROUP BY status"
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
        SELECT event_id, project_slug, thread_id, turn_id, event_type, status, title, error_message, event_ts
        FROM events
        ORDER BY event_ts DESC
        LIMIT 20
        `
      )
    ]);

    return {
      projectCount: Number(projectCountRes.rows[0]?.count ?? 0),
      threadStatus: threadStatusRes.rows.map((item) => ({
        status: item.status ?? "unknown",
        count: Number(item.count)
      })),
      recentEvents: recentRes.rows
    };
  });

  app.get("/v1/projects", async () => {
    const result = await pool.query<{
      slug: string;
      name: string;
      path: string;
      status: string;
      last_seen_at: string;
      thread_count: string;
    }>(
      `
      SELECT
        p.project_slug AS slug,
        p.project_name AS name,
        p.project_path AS path,
        p.status,
        p.last_seen_at,
        COUNT(t.thread_id)::text AS thread_count
      FROM projects p
      LEFT JOIN threads t ON t.project_slug = p.project_slug
      GROUP BY p.project_slug, p.project_name, p.project_path, p.status, p.last_seen_at
      ORDER BY p.last_seen_at DESC
      `
    );

    return result.rows.map((row) => ({
      ...row,
      thread_count: Number(row.thread_count ?? 0)
    }));
  });

  app.get("/v1/projects/:slug/threads", async (request, reply) => {
    const paramsSchema = z.object({ slug: z.string().min(1) });
    const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query ?? {});

    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

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
      [params.data.slug, query.data.limit]
    );

    return result.rows;
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
      projectSlug: query.data.projectSlug
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
      action: "cancel_task"
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
      detail: { taskId: task.id, taskStatus: task.status }
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
      projectSlug: params.data.slug
    });
    if (!allowed) {
      return;
    }

    const projectRes = await pool.query<{ project_path: string; project_name: string }>(
      `SELECT project_path, project_name FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug]
    );
    const project = projectRes.rows[0];
    if (!project) {
      reply.code(404);
      return { error: "project_not_found" };
    }

    const args = buildExecArgs(project.project_path, body.data.prompt, body.data.model);
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
              stdio: ["ignore", "pipe", "pipe"]
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

            child.stdout.on("data", (chunk: Buffer) => {
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
                error: error.message
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
                error: timedOut ? "exec_timeout" : undefined
              });
            });
          });
        }
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
      detail: { taskId: queuedTask.task.id, queuePosition: queuedTask.task.queuePosition }
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
        error: message
      };
    }

    await writeExecAudit({
      request,
      projectSlug: params.data.slug,
      route: "/v1/projects/:slug/exec",
      action: "exec_once",
      status: finalTask.status,
      detail: { taskId: finalTask.id, exitCode: finalTask.exitCode, signal: finalTask.signal }
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
          ? new Date(finalTask.finishedAt).getTime() - new Date(finalTask.startedAt).getTime()
          : 0,
      exitCode: finalTask.exitCode ?? -1,
      signal: finalTask.signal,
      stdout: finalTask.stdout,
      stderr: finalTask.stderr,
      error: finalTask.error ?? undefined
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
      projectSlug: params.data.slug
    });
    if (!allowed) {
      return;
    }

    const projectRes = await pool.query<{ project_path: string; project_name: string }>(
      `SELECT project_path, project_name FROM projects WHERE project_slug = $1 LIMIT 1`,
      [params.data.slug]
    );
    const project = projectRes.rows[0];
    if (!project) {
      reply.code(404);
      return { error: "project_not_found" };
    }

    const requestedThreadId = body.data.threadId?.trim() || null;
    let resumeThreadId: string | null = null;
    if (requestedThreadId) {
      const threadCheck = await pool.query<{ thread_id: string }>(
        `SELECT thread_id FROM threads WHERE thread_id = $1 AND project_slug = $2 LIMIT 1`,
        [requestedThreadId, params.data.slug]
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
      ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" } : {})
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
            const pendingMethods = new Map<string, string>();

            const resolveRunResult = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
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
                  durationMs: duration
                });
              }
              resolveRun({
                exitCode: code ?? -1,
                signal: signal ?? null,
                durationMs: duration,
                stdout: assistantTextChunks.join(""),
                stderr: stderrChunks.join(""),
                error: error ?? (timedOut ? "exec_timeout" : undefined)
              });
            };

            const sendRpcRequest = (
              childProcess: ReturnType<typeof spawn>,
              method: string,
              rpcParams: Record<string, unknown>
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
                  params: rpcParams
                })}\n`
              );
            };

            const startTurn = (childProcess: ReturnType<typeof spawn>, threadId: string): void => {
              if (turnStarted) {
                return;
              }
              turnStarted = true;
              send({
                type: "start",
                taskId: context.task.id,
                projectSlug: params.data.slug,
                projectName: project.project_name,
                command: context.task.command,
                timestamp: new Date().toISOString(),
                threadId
              });
              sendRpcRequest(childProcess, "turn/start", {
                threadId,
                ...(body.data.model ? { model: body.data.model } : {}),
                input: [
                  {
                    type: "text",
                    text: body.data.prompt
                  }
                ]
              });
            };

            const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
              cwd: project.project_path,
              env: process.env,
              stdio: ["pipe", "pipe", "pipe"]
            });

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
                version: "0.1.0"
              },
              capabilities: {
                experimentalApi: true
              }
            });

            if (resumeThreadId) {
              sendRpcRequest(child, "thread/resume", {
                threadId: resumeThreadId,
                cwd: project.project_path,
                approvalPolicy: "never",
                sandbox: "workspace-write",
                ...(body.data.model ? { model: body.data.model } : {})
              });
            } else {
              sendRpcRequest(child, "thread/start", {
                cwd: project.project_path,
                approvalPolicy: "never",
                sandbox: "workspace-write",
                ...(body.data.model ? { model: body.data.model } : {})
              });
            }

            child.stdout.on("data", (chunk: Buffer) => {
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
                  send({ type: "stdout", taskId: context.task.id, data: `${line}\n` });
                  continue;
                }

                if ("id" in rpcMessage) {
                  const responseId = String(rpcMessage.id);
                  const responseForMethod = pendingMethods.get(responseId) ?? "";
                  pendingMethods.delete(responseId);

                  const errorObj = rpcMessage.error;
                  if (errorObj && typeof errorObj === "object") {
                    const message =
                      typeof (errorObj as Record<string, unknown>).message === "string"
                        ? ((errorObj as Record<string, unknown>).message as string)
                        : "app_server_rpc_error";
                    if (responseForMethod === "thread/resume") {
                      sendRpcRequest(child, "thread/start", {
                        cwd: project.project_path,
                        approvalPolicy: "never",
                        sandbox: "workspace-write",
                        ...(body.data.model ? { model: body.data.model } : {})
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
                    typeof (resultObj as Record<string, unknown>).thread === "object"
                  ) {
                    const threadObj = (resultObj as Record<string, unknown>).thread as Record<string, unknown>;
                    if (typeof threadObj.id === "string" && threadObj.id) {
                      runtimeThreadId = threadObj.id;
                      send({
                        type: "thread",
                        taskId: context.task.id,
                        threadId: runtimeThreadId
                      });
                    }
                  }

                  if (!appServerReady && runtimeThreadId) {
                    appServerReady = true;
                    startTurn(child, runtimeThreadId);
                  }

                  continue;
                }

                const method = typeof rpcMessage.method === "string" ? rpcMessage.method : "";
                const notifParams =
                  rpcMessage.params && typeof rpcMessage.params === "object"
                    ? (rpcMessage.params as Record<string, unknown>)
                    : {};

                if (method === "item/agentMessage/delta") {
                  const delta = typeof notifParams.delta === "string" ? notifParams.delta : "";
                  if (!delta) {
                    continue;
                  }
                  assistantTextChunks.push(delta);
                  send({
                    type: "assistant_delta",
                    taskId: context.task.id,
                    data: delta,
                    itemId: typeof notifParams.itemId === "string" ? notifParams.itemId : null,
                    threadId: typeof notifParams.threadId === "string" ? notifParams.threadId : runtimeThreadId,
                    turnId: typeof notifParams.turnId === "string" ? notifParams.turnId : null
                  });
                  continue;
                }

                if (method === "item/completed") {
                  const itemObj =
                    notifParams.item && typeof notifParams.item === "object"
                      ? (notifParams.item as Record<string, unknown>)
                      : {};
                  if (itemObj.type === "agentMessage" && typeof itemObj.text === "string") {
                    send({
                      type: "assistant_message",
                      taskId: context.task.id,
                      text: itemObj.text,
                      itemId: typeof itemObj.id === "string" ? itemObj.id : null,
                      threadId: typeof notifParams.threadId === "string" ? notifParams.threadId : runtimeThreadId,
                      turnId: typeof notifParams.turnId === "string" ? notifParams.turnId : null
                    });
                  }
                  continue;
                }

                if (method === "item/commandExecution/outputDelta") {
                  const delta = typeof notifParams.delta === "string" ? notifParams.delta : "";
                  if (delta) {
                    send({ type: "stdout", taskId: context.task.id, data: delta });
                  }
                  continue;
                }

                if (method === "error") {
                  const errorObj =
                    notifParams.error && typeof notifParams.error === "object"
                      ? (notifParams.error as Record<string, unknown>)
                      : {};
                  const message =
                    (typeof errorObj.message === "string" ? errorObj.message : null) ??
                    (typeof notifParams.message === "string" ? notifParams.message : null) ??
                    "app_server_turn_error";
                  send({ type: "error", taskId: context.task.id, message });
                  continue;
                }

                if (method === "turn/completed") {
                  if (!endSent) {
                    endSent = true;
                    const duration = Date.now() - startedAt;
                    send({
                      type: "end",
                      taskId: context.task.id,
                      exitCode: 0,
                      signal: null,
                      durationMs: duration
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
              send({ type: "error", taskId: context.task.id, message: error.message });
              resolveRunResult(-1, null, error.message);
            });

            child.on("close", (code, signal) => {
              resolveRunResult(code, signal);
            });
          });
        }
      });
    } catch (error) {
      const err = error as Error & { code?: string };
      send({ type: "error", message: err.code === "exec_queue_full" ? "exec_queue_full" : err.message });
      finish();
      return;
    }

    if (queuedTask.task.queuePosition > 0) {
      send({
        type: "queued",
        taskId: queuedTask.task.id,
        queuePosition: queuedTask.task.queuePosition
      });
    }

    await writeExecAudit({
      request,
      projectSlug: params.data.slug,
      route: "/v1/projects/:slug/exec/stream",
      action: "exec_stream",
      status: "accepted",
      detail: { taskId: queuedTask.task.id, queuePosition: queuedTask.task.queuePosition }
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
          detail: { taskId: task.id, exitCode: task.exitCode, signal: task.signal }
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

    const threadRes = await pool.query<{ project_slug: string; project_name: string; project_path: string }>(
      `
      SELECT t.project_slug, p.project_name, p.project_path
      FROM threads t
      JOIN projects p ON p.project_slug = t.project_slug
      WHERE t.thread_id = $1
      LIMIT 1
      `,
      [params.data.threadId]
    );
    const thread = threadRes.rows[0];
    if (!thread) {
      reply.code(404);
      return { error: "thread_not_found" };
    }

    const allowed = await ensureExecAccess({
      request,
      reply,
      execApiToken: config.execApiToken,
      execAllowedIps: config.execAllowedIps,
      route: "/v1/threads/:threadId/exec/stream",
      action: "exec_stream_resume",
      projectSlug: thread.project_slug
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
      ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" } : {})
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

            const resolveRunResult = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
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
                  durationMs: duration
                });
              }
              resolveRun({
                exitCode: code ?? -1,
                signal: signal ?? null,
                durationMs: duration,
                stdout: assistantTextChunks.join(""),
                stderr: stderrChunks.join(""),
                error: error ?? (timedOut ? "exec_timeout" : undefined)
              });
            };

            const sendRpcRequest = (
              childProcess: ReturnType<typeof spawn>,
              method: string,
              rpcParams: Record<string, unknown>
            ): void => {
              if (!childProcess.stdin) {
                return;
              }
              const req = {
                jsonrpc: "2.0",
                id: reqId,
                method,
                params: rpcParams
              };
              reqId += 1;
              childProcess.stdin.write(`${JSON.stringify(req)}\n`);
            };

            send({
              type: "start",
              taskId: context.task.id,
              projectSlug: thread.project_slug,
              projectName: thread.project_name,
              command: context.task.command,
              timestamp: new Date().toISOString()
            });

            const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
              cwd: thread.project_path,
              env: process.env,
              stdio: ["pipe", "pipe", "pipe"]
            });

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
                version: "0.1.0"
              },
              capabilities: {
                experimentalApi: true
              }
            });

            sendRpcRequest(child, "thread/resume", {
              threadId: params.data.threadId,
              cwd: thread.project_path,
              approvalPolicy: "never",
              sandbox: "workspace-write",
              ...(body.data.model ? { model: body.data.model } : {})
            });

            child.stdout.on("data", (chunk: Buffer) => {
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
                  send({ type: "stdout", taskId: context.task.id, data: `${line}\n` });
                  continue;
                }

                if ("id" in rpcMessage) {
                  const resultObj = rpcMessage.result;
                  const errorObj = rpcMessage.error;
                  if (errorObj && typeof errorObj === "object") {
                    const msg =
                      typeof (errorObj as Record<string, unknown>).message === "string"
                        ? ((errorObj as Record<string, unknown>).message as string)
                        : "app_server_rpc_error";
                    send({ type: "error", taskId: context.task.id, message: msg });
                    continue;
                  }

                  if (!appServerReady && resultObj && typeof resultObj === "object" && "thread" in (resultObj as Record<string, unknown>)) {
                    appServerReady = true;
                    if (!turnStarted) {
                      turnStarted = true;
                      sendRpcRequest(child, "turn/start", {
                        threadId: params.data.threadId,
                        ...(body.data.model ? { model: body.data.model } : {}),
                        input: [
                          {
                            type: "text",
                            text: body.data.prompt
                          }
                        ]
                      });
                    }
                  }
                  continue;
                }

                const method = typeof rpcMessage.method === "string" ? rpcMessage.method : "";
                const notifParams =
                  rpcMessage.params && typeof rpcMessage.params === "object"
                    ? (rpcMessage.params as Record<string, unknown>)
                    : {};

                if (method === "item/agentMessage/delta") {
                  const delta = typeof notifParams.delta === "string" ? notifParams.delta : "";
                  if (!delta) {
                    continue;
                  }
                  assistantTextChunks.push(delta);
                  send({
                    type: "assistant_delta",
                    taskId: context.task.id,
                    data: delta,
                    itemId: typeof notifParams.itemId === "string" ? notifParams.itemId : null,
                    threadId: typeof notifParams.threadId === "string" ? notifParams.threadId : null,
                    turnId: typeof notifParams.turnId === "string" ? notifParams.turnId : null
                  });
                  continue;
                }

                if (method === "item/completed") {
                  const itemObj =
                    notifParams.item && typeof notifParams.item === "object"
                      ? (notifParams.item as Record<string, unknown>)
                      : {};
                  if (itemObj.type === "agentMessage" && typeof itemObj.text === "string") {
                    send({
                      type: "assistant_message",
                      taskId: context.task.id,
                      text: itemObj.text,
                      itemId: typeof itemObj.id === "string" ? itemObj.id : null,
                      threadId: typeof notifParams.threadId === "string" ? notifParams.threadId : null,
                      turnId: typeof notifParams.turnId === "string" ? notifParams.turnId : null
                    });
                  }
                  continue;
                }

                if (method === "item/commandExecution/outputDelta") {
                  const delta = typeof notifParams.delta === "string" ? notifParams.delta : "";
                  if (delta) {
                    send({ type: "stdout", taskId: context.task.id, data: delta });
                  }
                  continue;
                }

                if (method === "error") {
                  const errorObj =
                    notifParams.error && typeof notifParams.error === "object"
                      ? (notifParams.error as Record<string, unknown>)
                      : {};
                  const message =
                    (typeof errorObj.message === "string" ? errorObj.message : null) ??
                    (typeof notifParams.message === "string" ? notifParams.message : null) ??
                    "app_server_turn_error";
                  send({ type: "error", taskId: context.task.id, message });
                  continue;
                }

                if (method === "turn/completed") {
                  if (!endSent) {
                    endSent = true;
                    const duration = Date.now() - startedAt;
                    send({
                      type: "end",
                      taskId: context.task.id,
                      exitCode: 0,
                      signal: null,
                      durationMs: duration
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
              send({ type: "error", taskId: context.task.id, message: error.message });
              resolveRunResult(-1, null, error.message);
            });

            child.on("close", (code, signal) => {
              resolveRunResult(code, signal);
            });
          });
        }
      });
    } catch (error) {
      const err = error as Error & { code?: string };
      send({ type: "error", message: err.code === "exec_queue_full" ? "exec_queue_full" : err.message });
      finish();
      return;
    }

    if (queuedTask.task.queuePosition > 0) {
      send({
        type: "queued",
        taskId: queuedTask.task.id,
        queuePosition: queuedTask.task.queuePosition
      });
    }

    await writeExecAudit({
      request,
      projectSlug: thread.project_slug,
      route: "/v1/threads/:threadId/exec/stream",
      action: "exec_stream_resume",
      status: "accepted",
      detail: { taskId: queuedTask.task.id, queuePosition: queuedTask.task.queuePosition, threadId: params.data.threadId }
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
          detail: { taskId: task.id, exitCode: task.exitCode, signal: task.signal, threadId: params.data.threadId }
        });
        finish();
      })
      .catch(() => {
        finish();
      });
  });

  app.get("/v1/threads/:threadId/events", async (request, reply) => {
    const paramsSchema = z.object({ threadId: z.string().min(1) });
    const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) });

    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query ?? {});

    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    const result = await pool.query(
      `
      SELECT event_id, project_slug, thread_id, turn_id, event_type, status, title, error_message, payload_json, event_ts
      FROM events
      WHERE thread_id = $1
      ORDER BY event_ts DESC
      LIMIT $2
      `,
      [params.data.threadId, query.data.limit]
    );

    return result.rows;
  });

  app.get("/v1/threads/:threadId/messages", async (request, reply) => {
    const paramsSchema = z.object({ threadId: z.string().min(1) });
    const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(300) });

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
      [params.data.threadId, query.data.limit]
    );

    const messages = result.rows
      .map((item) => {
        const payload = item.payload_json ?? {};
        const roleFromPayload = typeof payload.role === "string" ? payload.role : null;
        const textFromPayload = typeof payload.message_text === "string" ? payload.message_text : null;
        const fallbackText = item.title ?? item.error_message ?? null;
        const text = textFromPayload ?? fallbackText;
        if (!text) {
          return null;
        }

        const role =
          roleFromPayload ??
          (item.event_type.includes("user")
            ? "user"
            : item.event_type.includes("agent") || item.event_type.includes("assistant")
              ? "assistant"
              : "system");
        if (role !== "user" && role !== "assistant") {
          return null;
        }
        if (role === "user" && (text.includes("AGENTS.md instructions for") || text.includes("<INSTRUCTIONS>"))) {
          return null;
        }

        return {
          messageId: item.event_id,
          eventType: item.event_type,
          role,
          text,
          status: item.status,
          timestamp: item.event_ts
        };
      })
      .filter(
        (item): item is { messageId: string; eventType: string; role: "user" | "assistant"; text: string; status: string | null; timestamp: string } =>
          item !== null
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
      ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" } : {})
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
