"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import ExecPanel from "../projects/[slug]/exec-panel";
import {
  describeAppError,
  fetchAgents,
  fetchOverview,
  fetchProjects,
  fetchThreads,
  type ManagedAgent,
  type Overview,
  type Project,
  type Thread,
} from "../../lib/api";

type GridMode = "auto" | 4 | 6 | 9;
type WarRoomStatus =
  | "waiting_me"
  | "blocked"
  | "error"
  | "thinking"
  | "working"
  | "done"
  | "idle";
type WarRoomFilter = "all" | "attention" | "working" | "error" | "idle";
type WorkspaceTab = "project" | "transcript";

type ProjectRuntime = {
  project: Project;
  threads: Thread[];
  latestThread: Thread | null;
  latestEvent: Overview["recentEvents"][number] | null;
  agentCount: number;
  runningAgentCount: number;
  status: WarRoomStatus;
  statusLabel: string;
  actionLabel: string;
  summary: string;
  updatedAt: string | null;
  attention: boolean;
};

const API_BASE =
  process.env.NEXT_PUBLIC_HUB_API_BASE ?? "http://127.0.0.1:4010";

const formatTime = (value?: string | null): string => {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const truncate = (value: string, size = 88): string =>
  value.length > size ? `${value.slice(0, size)}...` : value;

const statusOrder: Record<WarRoomStatus, number> = {
  waiting_me: 0,
  blocked: 1,
  error: 2,
  thinking: 3,
  working: 4,
  done: 5,
  idle: 6,
};

const statusTone = (status: WarRoomStatus): string => status;

const deriveGridColumns = (mode: GridMode, count: number): number => {
  if (mode === 4 || mode === 6 || mode === 9) {
    return mode;
  }
  if (count <= 4) {
    return 4;
  }
  if (count <= 12) {
    return 6;
  }
  return 9;
};

const paged = <T,>(items: T[], pageSize: number, pageIndex: number): T[] => {
  const start = pageIndex * pageSize;
  return items.slice(start, start + pageSize);
};

const latestTimestamp = (
  thread: Thread | null,
  eventTs?: string | null,
  projectTs?: string | null,
): string | null => eventTs ?? thread?.updated_at ?? projectTs ?? null;

const buildProjectSummary = (
  latestThread: Thread | null,
  latestEvent: Overview["recentEvents"][number] | null,
  fallback: string,
): string => {
  const candidates = [
    latestEvent?.title,
    latestEvent?.error_message,
    latestThread?.first_user_prompt,
    latestThread?.title,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.trim());
  return candidates[0] ?? fallback;
};

const deriveProjectRuntime = (
  project: Project,
  threads: Thread[],
  agents: ManagedAgent[],
  overview: Overview | null,
): ProjectRuntime => {
  const sortedThreads = [...threads].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  const latestThread = sortedThreads[0] ?? null;
  const projectEvents = (overview?.recentEvents ?? []).filter(
    (event) => event.project_slug === project.slug,
  );
  const latestEvent = latestThread
    ? (projectEvents.find(
        (event) => event.thread_id === latestThread.thread_id,
      ) ??
      projectEvents[0] ??
      null)
    : (projectEvents[0] ?? null);
  const projectAgents = agents.filter(
    (agent) => agent.projectSlug === project.slug,
  );
  const runningAgentCount = projectAgents.filter(
    (agent) => agent.status === "running" || agent.status === "starting",
  ).length;
  const latestEventType = latestEvent?.event_type?.toLowerCase() ?? "";
  const latestEventStatus = (latestEvent?.status ?? "").toLowerCase();
  const latestThreadStatus = (latestThread?.status ?? "").toLowerCase();
  const resolvedStatus =
    latestThreadStatus ||
    latestEventStatus ||
    (project.status ?? "").toLowerCase();
  const latestEventError = latestEvent?.error_message ?? null;
  const threadCount = threads.length;
  const latestActorIsAssistant =
    latestEventType.includes("assistant") || latestEventType.includes("agent");
  const latestActorIsUser = latestEventType.includes("user");
  const latestThreadCompleted = resolvedStatus === "completed";
  const latestThreadRunning = resolvedStatus === "running";
  const latestThreadRecoverable = [
    "interrupted",
    "canceled",
    "stopped",
  ].includes(resolvedStatus);
  const latestThreadFailed = resolvedStatus === "failed";
  const latestThreadBlocked =
    resolvedStatus === "blocked" ||
    resolvedStatus === "paused" ||
    latestEventType.includes("confirm") ||
    latestEventType.includes("approval");

  if (latestEventError || latestThreadFailed) {
    return {
      project,
      threads,
      latestThread,
      latestEvent,
      agentCount: projectAgents.length,
      runningAgentCount,
      status: "error",
      statusLabel: "执行异常",
      actionLabel: "优先排障",
      summary: buildProjectSummary(
        latestThread,
        latestEvent,
        "最近一轮对话或任务出现异常，建议先查看日志和 thread。",
      ),
      updatedAt: latestTimestamp(
        latestThread,
        latestEvent?.event_ts,
        project.last_seen_at,
      ),
      attention: true,
    };
  }

  if (latestThreadBlocked) {
    return {
      project,
      threads,
      latestThread,
      latestEvent,
      agentCount: projectAgents.length,
      runningAgentCount,
      status: "blocked",
      statusLabel: "等待确认",
      actionLabel: "需要决策",
      summary: buildProjectSummary(
        latestThread,
        latestEvent,
        "当前项目等待人工确认或补充信息。",
      ),
      updatedAt: latestTimestamp(
        latestThread,
        latestEvent?.event_ts,
        project.last_seen_at,
      ),
      attention: true,
    };
  }

  if (
    threadCount > 0 &&
    (latestThreadCompleted ||
      latestThreadRecoverable ||
      (latestActorIsAssistant &&
        !latestThreadRunning &&
        latestEventStatus !== "running"))
  ) {
    return {
      project,
      threads,
      latestThread,
      latestEvent,
      agentCount: projectAgents.length,
      runningAgentCount,
      status: "waiting_me",
      statusLabel: "等你回复",
      actionLabel: "切回继续对话",
      summary: buildProjectSummary(
        latestThread,
        latestEvent,
        latestThreadRecoverable
          ? "上一轮执行已中断，现在可以直接回到会话继续推进。"
          : "Codex 已输出新内容，轮到你继续推动这条对话。",
      ),
      updatedAt: latestTimestamp(
        latestThread,
        latestEvent?.event_ts,
        project.last_seen_at,
      ),
      attention: true,
    };
  }

  if (threadCount > 0 && latestThreadRunning) {
    return {
      project,
      threads,
      latestThread,
      latestEvent,
      agentCount: projectAgents.length,
      runningAgentCount,
      status: "thinking",
      statusLabel: "Codex 处理中",
      actionLabel: "观察进展",
      summary: buildProjectSummary(
        latestThread,
        latestEvent,
        "当前项目的最新一轮 thread 仍在处理中或持续输出。",
      ),
      updatedAt: latestTimestamp(
        latestThread,
        latestEvent?.event_ts,
        project.last_seen_at,
      ),
      attention: false,
    };
  }

  if (threadCount > 0 && latestActorIsUser) {
    return {
      project,
      threads,
      latestThread,
      latestEvent,
      agentCount: projectAgents.length,
      runningAgentCount,
      status: "working",
      statusLabel: "等待下一轮",
      actionLabel: "继续推进",
      summary: buildProjectSummary(
        latestThread,
        latestEvent,
        "你已经推进了这条对话，可以继续关注下一轮输出。",
      ),
      updatedAt: latestTimestamp(
        latestThread,
        latestEvent?.event_ts,
        project.last_seen_at,
      ),
      attention: false,
    };
  }

  if (threadCount > 0) {
    return {
      project,
      threads,
      latestThread,
      latestEvent,
      agentCount: projectAgents.length,
      runningAgentCount,
      status: "done",
      statusLabel: "刚刚完成",
      actionLabel: "可继续追问",
      summary: buildProjectSummary(
        latestThread,
        latestEvent,
        "当前项目已经开始工作，可以随时继续。",
      ),
      updatedAt: latestTimestamp(
        latestThread,
        latestEvent?.event_ts,
        project.last_seen_at,
      ),
      attention: false,
    };
  }

  return {
    project,
    threads,
    latestThread,
    latestEvent,
    agentCount: projectAgents.length,
    runningAgentCount,
    status: "idle",
    statusLabel: "未开始",
    actionLabel: "等待首条 prompt",
    summary: "这个项目还没有开始对话，适合从监控室直接点进去启动工作。",
    updatedAt: latestTimestamp(
      latestThread,
      latestEvent?.event_ts,
      project.last_seen_at,
    ),
    attention: false,
  };
};

const matchesFilter = (
  runtime: ProjectRuntime,
  filter: WarRoomFilter,
): boolean => {
  if (filter === "all") {
    return true;
  }
  if (filter === "attention") {
    return runtime.status === "waiting_me" || runtime.status === "blocked";
  }
  if (filter === "working") {
    return (
      runtime.status === "thinking" ||
      runtime.status === "working" ||
      runtime.status === "done"
    );
  }
  if (filter === "error") {
    return runtime.status === "error" || runtime.status === "blocked";
  }
  if (filter === "idle") {
    return runtime.status === "idle";
  }
  return true;
};

export default function WarRoomConsole() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [threadsMap, setThreadsMap] = useState<Record<string, Thread[]>>({});
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gridMode, setGridMode] = useState<GridMode>("auto");
  const [filter, setFilter] = useState<WarRoomFilter>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [activeProjectSlug, setActiveProjectSlug] = useState<string | null>(
    null,
  );
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("project");

  useEffect(() => {
    const refresh = async () => {
      try {
        const [nextProjects, nextOverview, nextAgents] = await Promise.all([
          fetchProjects(),
          fetchOverview(),
          fetchAgents(),
        ]);
        const threadEntries = await Promise.all(
          nextProjects.map(
            async (project) =>
              [project.slug, await fetchThreads(project.slug)] as const,
          ),
        );
        setProjects(nextProjects);
        setOverview(nextOverview);
        setAgents(nextAgents.agents);
        setThreadsMap(Object.fromEntries(threadEntries));
        setError(null);
      } catch (err) {
        setError(
          describeAppError(err instanceof Error ? err.message : "load_failed"),
        );
      } finally {
        setLoading(false);
      }
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 10_000);
    const source = new EventSource(`${API_BASE}/v1/stream/events`);
    source.onmessage = () => {
      void refresh();
    };

    return () => {
      window.clearInterval(timer);
      source.close();
    };
  }, []);

  const runtimes = useMemo(
    () =>
      projects
        .map((project) =>
          deriveProjectRuntime(
            project,
            threadsMap[project.slug] ?? [],
            agents,
            overview,
          ),
        )
        .sort((a, b) => {
          const priority = statusOrder[a.status] - statusOrder[b.status];
          if (priority !== 0) {
            return priority;
          }
          return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
        }),
    [agents, overview, projects, threadsMap],
  );

  const filteredRuntimes = useMemo(
    () => runtimes.filter((item) => matchesFilter(item, filter)),
    [filter, runtimes],
  );
  const visibleGrid = deriveGridColumns(gridMode, filteredRuntimes.length);
  const pageSize = visibleGrid;
  const pageCount = Math.max(1, Math.ceil(filteredRuntimes.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const gridItems = paged(filteredRuntimes, pageSize, currentPage);
  const activeRuntime =
    runtimes.find((item) => item.project.slug === activeProjectSlug) ?? null;
  const asideProjects = filteredRuntimes.filter(
    (item) => item.project.slug !== activeProjectSlug,
  );
  const waitingCount = runtimes.filter(
    (item) => item.status === "waiting_me",
  ).length;
  const thinkingCount = runtimes.filter(
    (item) => item.status === "thinking",
  ).length;
  const errorCount = runtimes.filter(
    (item) => item.status === "error" || item.status === "blocked",
  ).length;
  const idleCount = runtimes.filter((item) => item.status === "idle").length;

  useEffect(() => {
    setPageIndex((prev) => Math.min(prev, pageCount - 1));
  }, [pageCount]);

  useEffect(() => {
    setPageIndex(0);
  }, [filter, gridMode]);

  useEffect(() => {
    if (!activeProjectSlug) {
      setWorkspaceTab("project");
    }
  }, [activeProjectSlug]);

  return (
    <main className="mc-war-room-shell">
      <section className="panel mc-war-room-hero">
        <div className="mc-war-room-hero-head">
          <div className="grid" style={{ gap: 8 }}>
            <div className="mc-chip-row">
              <span className="mc-chip accent">War Room</span>
              <span className="mc-chip info">Multi Project Ops</span>
              <span className="mc-chip warn">Attention First</span>
            </div>
            <h1 className="mc-hero-title" style={{ margin: 0 }}>
              Codex 监控室
            </h1>
            <p className="mc-hero-subtitle">
              {activeRuntime
                ? "已进入单项目工作模式。顶部只保留必要导航，把主视觉让给会话台和对话区。"
                : "先看全局，再切入单项目工作。默认把需要你查看、回复或排障的项目排在最前，避免项目多起来以后只能靠记忆来回切。"}
            </p>
          </div>
          <div className="mc-action-row">
            <Link href="/" className="mc-button ghost">
              返回首页
            </Link>
            <button
              type="button"
              className="mc-button secondary"
              onClick={() => setActiveProjectSlug(null)}
              disabled={!activeRuntime}
            >
              返回大屏模式
            </button>
          </div>
        </div>
        {!activeRuntime ? (
          <div className="mc-war-room-summary-grid">
            <article className="mc-war-room-summary-card waiting_me">
              <span className="mc-war-room-summary-label">等你回复</span>
              <span className="mc-war-room-summary-value">{waitingCount}</span>
            </article>
            <article className="mc-war-room-summary-card thinking">
              <span className="mc-war-room-summary-label">Codex 处理中</span>
              <span className="mc-war-room-summary-value">{thinkingCount}</span>
            </article>
            <article className="mc-war-room-summary-card error">
              <span className="mc-war-room-summary-label">异常 / 阻塞</span>
              <span className="mc-war-room-summary-value">{errorCount}</span>
            </article>
            <article className="mc-war-room-summary-card idle">
              <span className="mc-war-room-summary-label">未开始</span>
              <span className="mc-war-room-summary-value">{idleCount}</span>
            </article>
          </div>
        ) : null}
      </section>

      {error ? (
        <section className="panel">
          <div className="mc-inline-feedback error">{error}</div>
        </section>
      ) : null}

      {activeRuntime ? (
        <section className="mc-war-room-workspace">
          <section className="mc-war-room-main">
            <section className="panel mc-war-room-tab-shell">
              <div
                className="mc-war-room-tab-row"
                role="tablist"
                aria-label="监控室工作区切换"
              >
                <button
                  type="button"
                  className={`mc-thread-filter ${workspaceTab === "project" ? "active" : ""}`}
                  onClick={() => setWorkspaceTab("project")}
                >
                  当前工作项目
                </button>
                <button
                  type="button"
                  className={`mc-thread-filter ${workspaceTab === "transcript" ? "active" : ""}`}
                  onClick={() => setWorkspaceTab("transcript")}
                >
                  Project Transcript
                </button>
              </div>

              {workspaceTab === "project" ? (
                <section className="mc-war-room-tab-panel mc-war-room-active-project">
                  <div className="mc-section-head">
                    <div>
                      <h3 className="mc-section-title">当前工作项目</h3>
                      <p className="mc-section-subtitle">
                        这里集中展示当前项目的关键状态、最近 thread
                        和下一步动作；对话则放到下一个 tab。
                      </p>
                    </div>
                    <div className="mc-chip-row">
                      <span className="mc-chip accent">
                        {activeRuntime.project.name}
                      </span>
                      <span
                        className={`mc-war-room-status-chip ${statusTone(activeRuntime.status)}`}
                      >
                        {activeRuntime.statusLabel}
                      </span>
                      <span className="mc-chip info">
                        {activeRuntime.actionLabel}
                      </span>
                    </div>
                  </div>
                  <div className="mc-war-room-active-meta compact">
                    <div className="mc-stat-pill">
                      <span className="mc-stat-label">slug</span>
                      <span className="mc-stat-value code">
                        {activeRuntime.project.slug}
                      </span>
                    </div>
                    <div className="mc-stat-pill">
                      <span className="mc-stat-label">threads</span>
                      <span className="mc-stat-value">
                        {activeRuntime.threads.length}
                      </span>
                    </div>
                    <div className="mc-stat-pill">
                      <span className="mc-stat-label">agents</span>
                      <span className="mc-stat-value">
                        {activeRuntime.runningAgentCount}
                      </span>
                    </div>
                    <div className="mc-stat-pill">
                      <span className="mc-stat-label">updated</span>
                      <span className="mc-stat-value code">
                        {formatTime(activeRuntime.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <div className="mc-war-room-active-meta">
                    <div className="mc-stat-pill">
                      <span className="mc-stat-label">状态</span>
                      <span className="mc-stat-value">
                        {activeRuntime.statusLabel}
                      </span>
                    </div>
                    <div className="mc-stat-pill">
                      <span className="mc-stat-label">动作</span>
                      <span className="mc-stat-value">
                        {activeRuntime.actionLabel}
                      </span>
                    </div>
                    <div className="mc-stat-pill">
                      <span className="mc-stat-label">最新 thread</span>
                      <span className="mc-stat-value code">
                        {activeRuntime.latestThread?.thread_id ?? "new"}
                      </span>
                    </div>
                  </div>
                  <div className="mc-inline-feedback success">
                    {activeRuntime.summary}
                  </div>
                  <div className="mc-war-room-project-ops">
                    <button
                      type="button"
                      className="mc-button"
                      onClick={() => setWorkspaceTab("transcript")}
                    >
                      进入 Project Transcript
                    </button>
                    <Link
                      href={`/projects/${encodeURIComponent(activeRuntime.project.slug)}`}
                      className="mc-button ghost"
                    >
                      打开项目页
                    </Link>
                  </div>
                </section>
              ) : (
                <section className="mc-war-room-tab-panel">
                  <ExecPanel
                    slug={activeRuntime.project.slug}
                    sessionPanelMode="drawer"
                  />
                </section>
              )}
            </section>
          </section>
          <aside className="panel mc-war-room-aside">
            <div className="mc-section-head">
              <div>
                <h2 className="mc-section-title">切换项目</h2>
                <p className="mc-section-subtitle">
                  优先把需要你处理的项目放在侧栏最上方。
                </p>
              </div>
              <span className="mc-chip info">
                {filter === "all" ? "全部项目" : `筛选 ${filter}`}
              </span>
            </div>
            <div
              className="mc-war-room-filter-row"
              role="tablist"
              aria-label="监控室筛选"
            >
              <button
                type="button"
                className={`mc-thread-filter ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                全部
              </button>
              <button
                type="button"
                className={`mc-thread-filter ${filter === "attention" ? "active" : ""}`}
                onClick={() => setFilter("attention")}
              >
                等我
              </button>
              <button
                type="button"
                className={`mc-thread-filter ${filter === "working" ? "active" : ""}`}
                onClick={() => setFilter("working")}
              >
                工作中
              </button>
              <button
                type="button"
                className={`mc-thread-filter ${filter === "error" ? "active" : ""}`}
                onClick={() => setFilter("error")}
              >
                异常
              </button>
              <button
                type="button"
                className={`mc-thread-filter ${filter === "idle" ? "active" : ""}`}
                onClick={() => setFilter("idle")}
              >
                空闲
              </button>
            </div>
            <div className="mc-war-room-side-list">
              {asideProjects.map((item) => (
                <button
                  key={item.project.slug}
                  type="button"
                  className={`mc-war-room-side-card ${statusTone(item.status)} ${item.attention ? "attention" : ""}`}
                  onClick={() => setActiveProjectSlug(item.project.slug)}
                >
                  <div className="mc-thread-item-head">
                    <span className="mc-thread-title">{item.project.name}</span>
                    <span
                      className={`mc-war-room-status-chip ${statusTone(item.status)}`}
                    >
                      {item.statusLabel}
                    </span>
                  </div>
                  <div className="mc-thread-snippet">
                    {truncate(item.summary, 72)}
                  </div>
                  <div className="mc-thread-meta">
                    <span className="code">{item.project.slug}</span>
                    <span>{formatTime(item.updatedAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          </aside>
        </section>
      ) : (
        <section className="panel mc-war-room-grid-panel">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">监控大屏</h2>
              <p className="mc-section-subtitle">
                固定分页，不滚动。先巡检全局，再点击某个项目切入工作模式。
              </p>
            </div>
            <div className="mc-war-room-toolbar">
              {(["auto", 4, 6, 9] as const).map((mode) => (
                <button
                  key={String(mode)}
                  type="button"
                  className={`mc-thread-filter ${gridMode === mode ? "active" : ""}`}
                  onClick={() => setGridMode(mode)}
                >
                  {mode === "auto" ? "Auto" : `${mode} 宫`}
                </button>
              ))}
            </div>
          </div>
          <div
            className="mc-war-room-filter-row"
            role="tablist"
            aria-label="监控室筛选"
          >
            <button
              type="button"
              className={`mc-thread-filter ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              全部 {runtimes.length}
            </button>
            <button
              type="button"
              className={`mc-thread-filter ${filter === "attention" ? "active" : ""}`}
              onClick={() => setFilter("attention")}
            >
              等我 {waitingCount}
            </button>
            <button
              type="button"
              className={`mc-thread-filter ${filter === "working" ? "active" : ""}`}
              onClick={() => setFilter("working")}
            >
              工作中{" "}
              {runtimes.filter((item) => matchesFilter(item, "working")).length}
            </button>
            <button
              type="button"
              className={`mc-thread-filter ${filter === "error" ? "active" : ""}`}
              onClick={() => setFilter("error")}
            >
              异常 {errorCount}
            </button>
            <button
              type="button"
              className={`mc-thread-filter ${filter === "idle" ? "active" : ""}`}
              onClick={() => setFilter("idle")}
            >
              空闲 {idleCount}
            </button>
          </div>
          <div className={`mc-war-room-grid grid-${visibleGrid}`}>
            {gridItems.map((item) => (
              <button
                key={item.project.slug}
                type="button"
                className={`mc-war-room-card ${statusTone(item.status)} ${item.attention ? "attention" : ""}`}
                onClick={() => setActiveProjectSlug(item.project.slug)}
              >
                <div className="mc-war-room-card-head">
                  <div className="grid" style={{ gap: 4 }}>
                    <div className="mc-war-room-card-title">
                      {item.project.name}
                    </div>
                    <div className="mc-project-path code">
                      {item.project.slug}
                    </div>
                  </div>
                  <span
                    className={`mc-war-room-status-chip ${statusTone(item.status)}`}
                  >
                    {item.statusLabel}
                  </span>
                </div>
                <div className="mc-war-room-card-action">
                  {item.actionLabel}
                </div>
                <div className="mc-war-room-card-summary">
                  {visibleGrid === 9
                    ? truncate(item.summary, 52)
                    : truncate(item.summary, 120)}
                </div>
                <div className="mc-war-room-card-metrics">
                  <span>threads {item.threads.length}</span>
                  <span>agents {item.runningAgentCount}</span>
                  <span>{formatTime(item.updatedAt)}</span>
                </div>
              </button>
            ))}
            {!gridItems.length && !loading ? (
              <div className="mc-empty">当前筛选下暂无项目。</div>
            ) : null}
          </div>
          <div className="mc-war-room-pagination">
            <button
              type="button"
              className="mc-button ghost"
              disabled={currentPage <= 0}
              onClick={() => setPageIndex((page) => Math.max(0, page - 1))}
            >
              上一页
            </button>
            <div className="mc-war-room-page-indicator code">
              {currentPage + 1} / {pageCount}
            </div>
            <button
              type="button"
              className="mc-button ghost"
              disabled={currentPage >= pageCount - 1}
              onClick={() =>
                setPageIndex((page) => Math.min(pageCount - 1, page + 1))
              }
            >
              下一页
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
