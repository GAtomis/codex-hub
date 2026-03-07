import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { eventBus } from "./sse-bus.js";

export type AgentStatus = "starting" | "running" | "stopped" | "failed";

export type ManagedAgent = {
  id: string;
  status: AgentStatus;
  projectSlug: string;
  projectName: string;
  projectPath: string;
  sessionsRoot: string;
  scanIntervalMs: number;
  maxFiles: number;
  stateFile: string;
  hubUrl: string;
  autoStart: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  stdoutTail: string;
  stderrTail: string;
};

export type StartAgentInput = {
  id?: string;
  projectSlug: string;
  projectName: string;
  projectPath: string;
  sessionsRoot: string;
  scanIntervalMs: number;
  maxFiles: number;
  stateFile?: string;
  hubUrl: string;
  ingestApiKey: string;
  autoStart?: boolean;
};

type RuntimeAgent = ManagedAgent & {
  process: ChildProcessWithoutNullStreams | null;
  stopRequested: boolean;
  ingestApiKey: string;
};

type PersistedState = {
  version: 1;
  agents: ManagedAgent[];
};

type InitOptions = {
  hubUrl: string;
  ingestApiKey: string;
};

const MAX_TAIL_CHARS = 6000;
const STOP_WAIT_MS = 5000;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "..", "..", "..");
const agentWorkspaceDir = join(repoRoot, "apps", "project-agent");
const runtimeDir = join(repoRoot, ".runtime");
const runtimeStatePath = join(runtimeDir, "agents.json");

const tsxBin = process.platform === "win32" ? join(repoRoot, "node_modules", ".bin", "tsx.cmd") : join(repoRoot, "node_modules", ".bin", "tsx");
const tsxCliPath = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

const safeSlug = (slug: string): string => slug.replace(/[^a-zA-Z0-9._-]/g, "_");

const appendTail = (origin: string, chunk: string): string => {
  const merged = `${origin}${chunk}`;
  if (merged.length <= MAX_TAIL_CHARS) {
    return merged;
  }
  return merged.slice(merged.length - MAX_TAIL_CHARS);
};

const nowIso = (): string => new Date().toISOString();

const toView = (agent: RuntimeAgent): ManagedAgent => {
  const { process: _process, stopRequested: _stopRequested, ingestApiKey: _ingestApiKey, ...view } = agent;
  return view;
};

const runnerCommand = (): { command: string; args: string[] } => {
  if (existsSync(tsxBin)) {
    return { command: tsxBin, args: ["src/main.ts"] };
  }
  if (existsSync(tsxCliPath)) {
    return { command: process.execPath, args: [tsxCliPath, "src/main.ts"] };
  }
  return { command: process.execPath, args: ["dist/main.js"] };
};

export class AgentManager {
  private readonly agents = new Map<string, RuntimeAgent>();

  private readonly statePath = runtimeStatePath;

  private initialized = false;

  public async init(options: InitOptions): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    const persisted = await this.loadPersisted();
    const restoreList: ManagedAgent[] = [];

    for (const snapshot of persisted) {
      const runtime: RuntimeAgent = {
        ...snapshot,
        status: snapshot.status === "running" || snapshot.status === "starting" ? "stopped" : snapshot.status,
        process: null,
        stopRequested: false,
        ingestApiKey: options.ingestApiKey,
        updatedAt: nowIso()
      };
      this.agents.set(runtime.id, runtime);

      if (snapshot.autoStart && (snapshot.status === "running" || snapshot.status === "starting")) {
        restoreList.push(snapshot);
      }
    }

    for (const snapshot of restoreList) {
      try {
        this.start({
          id: snapshot.id,
          projectSlug: snapshot.projectSlug,
          projectName: snapshot.projectName,
          projectPath: snapshot.projectPath,
          sessionsRoot: snapshot.sessionsRoot,
          scanIntervalMs: snapshot.scanIntervalMs,
          maxFiles: snapshot.maxFiles,
          stateFile: snapshot.stateFile,
          hubUrl: snapshot.hubUrl || options.hubUrl,
          ingestApiKey: options.ingestApiKey,
          autoStart: true
        });
      } catch (error) {
        const agent = this.agents.get(snapshot.id);
        if (agent) {
          agent.status = "failed";
          agent.error = error instanceof Error ? error.message : "restore_failed";
          agent.updatedAt = nowIso();
          this.publishChange(agent, "restore_failed");
        }
      }
    }

    await this.persist();
  }

  public list(): ManagedAgent[] {
    return Array.from(this.agents.values())
      .map((agent) => toView(agent))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public get(agentId: string): ManagedAgent | null {
    const agent = this.agents.get(agentId);
    return agent ? toView(agent) : null;
  }

  public start(input: StartAgentInput): ManagedAgent {
    const duplicated = Array.from(this.agents.values()).find(
      (agent) =>
        agent.projectSlug === input.projectSlug &&
        (agent.status === "starting" || agent.status === "running") &&
        agent.id !== input.id
    );
    if (duplicated) {
      const error = new Error(`agent already running for project ${input.projectSlug}`);
      (error as Error & { code?: string }).code = "agent_exists";
      throw error;
    }

    const id = input.id ?? randomUUID();
    const defaultStateFile = join(repoRoot, `.agent-state.${safeSlug(input.projectSlug)}.json`);
    const stateFile = input.stateFile?.trim() ? input.stateFile : defaultStateFile;
    const startedAt = nowIso();
    const existing = this.agents.get(id);

    const env = {
      ...process.env,
      PROJECT_SLUG: input.projectSlug,
      PROJECT_NAME: input.projectName,
      PROJECT_PATH: input.projectPath,
      SESSIONS_ROOT: input.sessionsRoot,
      SCAN_INTERVAL_MS: String(input.scanIntervalMs),
      MAX_FILES: String(input.maxFiles),
      STATE_FILE: stateFile,
      HUB_URL: input.hubUrl,
      INGEST_API_KEY: input.ingestApiKey
    };

    const runner = runnerCommand();
    const child = spawn(runner.command, runner.args, {
      cwd: agentWorkspaceDir,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const createdAt = existing?.createdAt ?? startedAt;
    const agent: RuntimeAgent = {
      id,
      status: "starting",
      projectSlug: input.projectSlug,
      projectName: input.projectName,
      projectPath: input.projectPath,
      sessionsRoot: input.sessionsRoot,
      scanIntervalMs: input.scanIntervalMs,
      maxFiles: input.maxFiles,
      stateFile,
      hubUrl: input.hubUrl,
      autoStart: input.autoStart ?? existing?.autoStart ?? true,
      createdAt,
      updatedAt: startedAt,
      startedAt,
      stoppedAt: null,
      pid: child.pid ?? null,
      exitCode: null,
      signal: null,
      error: null,
      stdoutTail: existing?.stdoutTail ?? "",
      stderrTail: existing?.stderrTail ?? "",
      process: child,
      stopRequested: false,
      ingestApiKey: input.ingestApiKey
    };

    this.agents.set(id, agent);
    this.publishChange(agent, "starting");
    void this.persist();

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      agent.stdoutTail = appendTail(agent.stdoutTail, text);
      if (agent.status === "starting") {
        agent.status = "running";
        agent.updatedAt = nowIso();
        this.publishChange(agent, "running");
      } else {
        agent.updatedAt = nowIso();
      }
      void this.persist();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      agent.stderrTail = appendTail(agent.stderrTail, text);
      if (agent.status === "starting") {
        agent.status = "running";
        agent.updatedAt = nowIso();
        this.publishChange(agent, "running");
      } else {
        agent.updatedAt = nowIso();
      }
      void this.persist();
    });

    child.on("error", (error) => {
      agent.status = "failed";
      agent.error = error.message;
      agent.stoppedAt = nowIso();
      agent.updatedAt = nowIso();
      this.publishChange(agent, "failed");
      void this.persist();
    });

    child.on("spawn", () => {
      agent.pid = child.pid ?? null;
      if (agent.status === "starting") {
        agent.status = "running";
        agent.updatedAt = nowIso();
        this.publishChange(agent, "running");
        void this.persist();
      }
    });

    child.on("close", (code, signal) => {
      agent.exitCode = code ?? null;
      agent.signal = signal ?? null;
      agent.stoppedAt = nowIso();
      const gracefulStop = agent.stopRequested || code === 0 || code === 143 || signal === "SIGTERM";
      agent.status = gracefulStop ? "stopped" : "failed";
      if (!gracefulStop && !agent.error) {
        agent.error = `agent exited with code=${code ?? "null"} signal=${signal ?? "null"}`;
      }
      agent.process = null;
      agent.updatedAt = nowIso();
      this.publishChange(agent, agent.status);
      void this.persist();
    });

    return toView(agent);
  }

  public async stop(agentId: string): Promise<ManagedAgent | null> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    if (agent.status === "stopped" || agent.status === "failed" || !agent.process) {
      return toView(agent);
    }

    const child = agent.process;
    agent.stopRequested = true;
    if (!child.killed) {
      child.kill("SIGTERM");
    }

    await Promise.race([
      new Promise<void>((resolveWait) => {
        child.once("close", () => resolveWait());
      }),
      new Promise<void>((resolveWait) => {
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
          resolveWait();
        }, STOP_WAIT_MS);
      })
    ]);

    return toView(agent);
  }

  public async remove(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }
    if (agent.status === "running" || agent.status === "starting") {
      await this.stop(agentId);
    }
    this.agents.delete(agentId);
    await this.persist();
    eventBus.publish({
      type: "agent.deleted",
      project: agent.projectSlug,
      projectSlug: agent.projectSlug,
      agentId: agent.id,
      updatedAt: nowIso()
    });
    return true;
  }

  public async stopAll(): Promise<void> {
    const active = Array.from(this.agents.values()).filter((agent) => agent.status === "starting" || agent.status === "running");
    await Promise.all(active.map((agent) => this.stop(agent.id)));
  }

  private publishChange(agent: RuntimeAgent, reason: string): void {
    eventBus.publish({
      type: "agent.status",
      reason,
      project: agent.projectSlug,
      projectSlug: agent.projectSlug,
      agentId: agent.id,
      status: agent.status,
      updatedAt: agent.updatedAt
    });
  }

  private async loadPersisted(): Promise<ManagedAgent[]> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        return [];
      }
      return parsed.agents;
    } catch {
      return [];
    }
  }

  private async persist(): Promise<void> {
    const state: PersistedState = {
      version: 1,
      agents: this.list()
    };
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }
}

export const agentManager = new AgentManager();
