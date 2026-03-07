import { randomUUID } from "node:crypto";
import { eventBus } from "./sse-bus.js";

export type ExecTaskStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type ExecTask = {
  id: string;
  projectSlug: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  model: string | null;
  command: string[];
  status: ExecTaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  canceled: boolean;
  queuePosition: number;
  stdout: string;
  stderr: string;
};

type RunResult = {
  exitCode: number;
  signal: string | null;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

type RunContext = {
  task: ExecTask;
  registerCancel: (fn: () => void) => void;
  isCanceled: () => boolean;
};

type EnqueueArgs = {
  projectSlug: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  model?: string;
  command: string[];
  run: (context: RunContext) => Promise<RunResult>;
};

type RuntimeTask = ExecTask & {
  startedAtMs: number | null;
  result: RunResult | null;
  cancelFn: (() => void) | null;
  run: (context: RunContext) => Promise<RunResult>;
  resolve: (value: ExecTask) => void;
  reject: (error: Error) => void;
};

type EnqueueResult = {
  task: ExecTask;
  done: Promise<ExecTask>;
};

const nowIso = (): string => new Date().toISOString();
const MAX_HISTORY = 200;

export class ExecManager {
  private readonly tasks = new Map<string, RuntimeTask>();

  private readonly queueByProject = new Map<string, string[]>();

  private readonly runningByProject = new Map<string, string | null>();

  constructor(
    private readonly maxQueueSize: number
  ) {}

  public enqueue(args: EnqueueArgs): EnqueueResult {
    const queue = this.queueByProject.get(args.projectSlug) ?? [];
    const running = this.runningByProject.get(args.projectSlug);
    if (queue.length >= this.maxQueueSize) {
      const error = new Error(`exec_queue_full:${args.projectSlug}`);
      (error as Error & { code?: string }).code = "exec_queue_full";
      throw error;
    }

    const id = randomUUID();
    let resolveDone: (value: ExecTask) => void = () => undefined;
    let rejectDone: (error: Error) => void = () => undefined;
    const done = new Promise<ExecTask>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const task: RuntimeTask = {
      id,
      projectSlug: args.projectSlug,
      projectName: args.projectName,
      projectPath: args.projectPath,
      prompt: args.prompt,
      model: args.model ?? null,
      command: args.command,
      status: running ? "queued" : "running",
      createdAt: nowIso(),
      startedAt: running ? null : nowIso(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      canceled: false,
      queuePosition: running ? queue.length + 1 : 0,
      stdout: "",
      stderr: "",
      startedAtMs: running ? null : Date.now(),
      result: null,
      cancelFn: null,
      run: args.run,
      resolve: resolveDone,
      reject: rejectDone
    };

    this.tasks.set(task.id, task);

    if (running) {
      queue.push(task.id);
      this.queueByProject.set(args.projectSlug, queue);
      this.publish(task, "queued");
    } else {
      this.runningByProject.set(args.projectSlug, task.id);
      this.publish(task, "running");
      void this.execute(task);
    }

    return { task: this.toPublic(task), done };
  }

  public list(projectSlug?: string): ExecTask[] {
    const items = Array.from(this.tasks.values())
      .filter((task) => (projectSlug ? task.projectSlug === projectSlug : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return items.map((task) => this.toPublic(task));
  }

  public cancel(taskId: string): ExecTask | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    if (task.status === "queued") {
      const queue = this.queueByProject.get(task.projectSlug) ?? [];
      this.queueByProject.set(
        task.projectSlug,
        queue.filter((item) => item !== task.id)
      );
      task.status = "canceled";
      task.canceled = true;
      task.finishedAt = nowIso();
      task.error = "canceled_by_user";
      this.publish(task, "canceled");
      task.resolve(this.toPublic(task));
      this.compact();
      this.recalculateQueuePositions(task.projectSlug);
      return this.toPublic(task);
    }

    if (task.status === "running") {
      task.canceled = true;
      if (task.cancelFn) {
        task.cancelFn();
      }
      return this.toPublic(task);
    }

    return this.toPublic(task);
  }

  private async execute(task: RuntimeTask): Promise<void> {
    try {
      const result = await task.run({
        task: this.toPublic(task),
        registerCancel: (fn) => {
          task.cancelFn = fn;
        },
        isCanceled: () => task.canceled
      });

      task.result = result;
      task.exitCode = result.exitCode;
      task.signal = result.signal;
      task.finishedAt = nowIso();
      task.status = task.canceled ? "canceled" : result.exitCode === 0 ? "completed" : "failed";
      task.error = result.error ?? null;
      task.stdout = result.stdout ?? "";
      task.stderr = result.stderr ?? "";
      this.publish(task, task.status);
      task.resolve(this.toPublic(task));
    } catch (error) {
      task.finishedAt = nowIso();
      task.status = task.canceled ? "canceled" : "failed";
      task.error = error instanceof Error ? error.message : "exec_failed";
      this.publish(task, task.status);
      task.reject(error instanceof Error ? error : new Error("exec_failed"));
    } finally {
      this.runningByProject.set(task.projectSlug, null);
      this.scheduleNext(task.projectSlug);
      this.compact();
    }
  }

  private scheduleNext(projectSlug: string): void {
    const queue = this.queueByProject.get(projectSlug) ?? [];
    const nextId = queue.shift();
    this.queueByProject.set(projectSlug, queue);
    this.recalculateQueuePositions(projectSlug);

    if (!nextId) {
      return;
    }

    const next = this.tasks.get(nextId);
    if (!next) {
      this.scheduleNext(projectSlug);
      return;
    }

    next.status = "running";
    next.startedAt = nowIso();
    next.startedAtMs = Date.now();
    this.runningByProject.set(projectSlug, next.id);
    this.publish(next, "running");
    void this.execute(next);
  }

  private recalculateQueuePositions(projectSlug: string): void {
    const queue = this.queueByProject.get(projectSlug) ?? [];
    for (let index = 0; index < queue.length; index += 1) {
      const task = this.tasks.get(queue[index] ?? "");
      if (task && task.status === "queued") {
        task.queuePosition = index + 1;
      }
    }
  }

  private publish(task: RuntimeTask, reason: string): void {
    eventBus.publish({
      type: "exec.task",
      project: task.projectSlug,
      projectSlug: task.projectSlug,
      taskId: task.id,
      status: task.status,
      reason,
      queuePosition: task.queuePosition,
      updatedAt: nowIso()
    });
  }

  private compact(): void {
    const ordered = Array.from(this.tasks.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (ordered.length <= MAX_HISTORY) {
      return;
    }

    const keepIds = new Set(ordered.slice(0, MAX_HISTORY).map((task) => task.id));
    for (const [taskId, task] of this.tasks.entries()) {
      if (!keepIds.has(taskId) && task.status !== "running" && task.status !== "queued") {
        this.tasks.delete(taskId);
      }
    }
  }

  private toPublic(task: RuntimeTask): ExecTask {
    const { startedAtMs: _startedAtMs, result: _result, cancelFn: _cancelFn, run: _run, resolve: _resolve, reject: _reject, ...view } = task;
    return view;
  }
}
