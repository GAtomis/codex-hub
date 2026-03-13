"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import AgentControlPanel from "../../agent-control-panel";
import SpotlightTour, { type SpotlightStep } from "../../spotlight-tour";
import { describeAppError, fetchAgents, fetchProjects, fetchThreads, type ManagedAgent, type Project, type Thread } from "../../../lib/api";
import ExecPanel from "./exec-panel";

const API_BASE = process.env.NEXT_PUBLIC_HUB_API_BASE ?? "http://127.0.0.1:4010";

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

const truncate = (value?: string | null, size = 90): string => {
  if (!value) {
    return "还没有用户提问，先发送第一条 prompt。";
  }
  return value.length > size ? `${value.slice(0, size)}...` : value;
};

const statusClass = (status?: string | null): string => {
  const value = (status ?? "unknown").toLowerCase();
  if (["running", "online"].includes(value)) {
    return "running";
  }
  if (["completed", "success", "done"].includes(value)) {
    return "completed";
  }
  if (["starting", "queued", "paused", "idle", "stopped"].includes(value)) {
    return "starting";
  }
  if (["failed", "error", "offline", "canceled"].includes(value)) {
    return "failed";
  }
  return "neutral";
};

type Props = {
  slug: string;
};

type WorkflowCheckpoint = {
  label: string;
  detail: string;
  done: boolean;
};

const PROJECT_TOUR_STEPS: SpotlightStep[] = [
  {
    selector: "#project-workflow-card",
    title: "先看当前工作流",
    description: "这里把项目、collector 和 thread 的关系写清楚了。第一次进入项目时，先确认自己缺的是 Agent、thread，还是只是继续当前会话。",
    placement: "bottom"
  },
  {
    selector: "#project-session-topbar",
    title: "这里是项目主控台",
    description: "新会话、更多设置、任务队列和打开完整 thread 都在这里。真正的日常操作应该围绕这块区域展开，而不是频繁跳回首页。",
    placement: "bottom"
  },
  {
    selector: ".js-tour-history-entry",
    title: "从这里切换历史会话",
    description: "桌面端可以展开会话栏，移动端会打开历史抽屉。thread 多起来后，优先用这里做切换和续接。",
    placement: "bottom"
  },
  {
    selector: "#project-transcript-composer",
    title: "在这里直接和 Codex 对话",
    description: "像 codex app 一样输入 prompt 并持续追问。开始一个新方向前先点新会话，避免把不同任务混进同一个 thread。",
    placement: "top"
  }
];

export default function ProjectConsole({ slug }: Props) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [selectedProject, setSelectedProject] = useState(slug);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const [nextProjects, nextThreads, nextAgents] = await Promise.all([fetchProjects(), fetchThreads(slug), fetchAgents()]);
      setProjects(nextProjects);
      setThreads(nextThreads);
      setAgents(nextAgents.agents);
      setError(null);
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "load_failed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedProject(slug);
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 10_000);

    const source = new EventSource(`${API_BASE}/v1/stream/events?projectSlug=${encodeURIComponent(slug)}`);
    source.onmessage = () => {
      void refresh();
    };

    return () => {
      window.clearInterval(timer);
      source.close();
    };
  }, [slug]);

  const canSwitch = useMemo(() => selectedProject.trim().length > 0, [selectedProject]);
  const activeProject = useMemo(() => projects.find((project) => project.slug === slug) ?? null, [projects, slug]);
  const runningThreads = useMemo(() => threads.filter((thread) => thread.status === "running").length, [threads]);
  const recentThreads = useMemo(
    () => [...threads].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6),
    [threads]
  );
  const projectAgents = useMemo(() => agents.filter((agent) => agent.projectSlug === slug), [agents, slug]);
  const runningAgents = useMemo(
    () => projectAgents.filter((agent) => agent.status === "running" || agent.status === "starting").length,
    [projectAgents]
  );

  const workflowCheckpoints = useMemo<WorkflowCheckpoint[]>(() => {
    const registered = Boolean(activeProject);
    const agentReady = runningAgents > 0;
    const startedConversation = threads.length > 0;
    return [
      {
        label: "项目已接入",
        detail: registered ? `已注册 slug ${slug}` : "当前 slug 还没有在 Hub 中注册。",
        done: registered
      },
      {
        label: "采集 Agent 在线",
        detail: agentReady ? `当前有 ${runningAgents} 个 Agent 在采集中。` : "当前项目还没有运行中的采集 Agent。",
        done: agentReady
      },
      {
        label: "可继续对话",
        detail: startedConversation ? `当前已有 ${threads.length} 个历史 thread。` : "还没有 thread，进入上方会话台发送第一条 prompt。",
        done: startedConversation
      }
    ];
  }, [activeProject, runningAgents, slug, threads.length]);

  return (
    <main className="grid" style={{ gap: 20 }}>
      <SpotlightTour storageKey={`codex_hub_tour_project_${slug}_v1`} steps={PROJECT_TOUR_STEPS} />
      <div className="mc-action-row">
        <Link href="/" className="mc-button ghost">
          返回总览
        </Link>
      </div>

      <section className="panel mc-hero thread-header-panel">
        <div className="mc-hero-head">
          <div className="grid" style={{ gap: 10 }}>
            <div className="mc-chip-row">
              <span className="mc-chip accent">Transcript First</span>
              <span className="mc-chip info">项目工作台</span>
              <span className={`badge ${statusClass(activeProject?.status)}`}>{activeProject?.status ?? "unknown"}</span>
            </div>
            <h1 className="mc-hero-title">{activeProject?.name ?? slug}</h1>
            <p className="mc-hero-subtitle">
              这里的主视觉现在只服务两件事: 持续对话和持续切换 thread。项目管理、采集 Agent 和次级导航全部退到下面，避免打断 codex app 式的使用节奏。
            </p>
          </div>

          <div className="mc-stat-strip">
            <div className="mc-stat-pill">
              <span className="mc-stat-label">slug</span>
              <span className="mc-stat-value code">{slug}</span>
            </div>
            <div className="mc-stat-pill">
              <span className="mc-stat-label">threads</span>
              <span className="mc-stat-value">{threads.length}</span>
            </div>
            <div className="mc-stat-pill">
              <span className="mc-stat-label">agents</span>
              <span className="mc-stat-value">{runningAgents}</span>
            </div>
          </div>
        </div>

        <div className="mc-action-row">
          <select className="mc-select light code" value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
            {projects.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name} ({project.slug})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="mc-button"
            disabled={!canSwitch}
            onClick={() => canSwitch && router.push(`/projects/${encodeURIComponent(selectedProject)}`)}
          >
            切换项目
          </button>
          <button type="button" className="mc-button secondary" onClick={() => void refresh()}>
            {loading ? "刷新中..." : "立即刷新"}
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel">
          <div className="mc-inline-feedback error">{error}</div>
        </section>
      ) : null}

      <section className="mc-project-console-grid">
        <article id="project-workflow-card" className="panel mc-sidebar-card mc-workflow-card">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">当前工作流</h2>
              <p className="mc-section-subtitle">把项目、Agent、thread 的关系直接讲清楚，减少第一次使用的理解成本。</p>
            </div>
            <div className="mc-chip-row">
              <span className="mc-chip accent">1 项目</span>
              <span className="mc-chip info">1 Collector + N Threads</span>
            </div>
          </div>
          <div className="mc-checklist">
            {workflowCheckpoints.map((item) => (
              <div key={item.label} className={`mc-checklist-item ${item.done ? "done" : "pending"}`}>
                <div className="mc-checklist-icon">{item.done ? "OK" : ".."}</div>
                <div className="grid" style={{ gap: 4 }}>
                  <div className="mc-checklist-title">{item.label}</div>
                  <div className="mc-checklist-detail">{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mc-inline-feedback success">
            如果你要在同一个项目里并行两个 Codex，正确方式是保留一个采集 Agent，然后在上方会话台创建两个独立 thread 分开协作。
          </div>
        </article>

        <article className="panel mc-sidebar-card">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">项目速览</h2>
              <p className="mc-section-subtitle">把当前项目是否可用、最近是否活跃，压缩成一个可扫读的角落。</p>
            </div>
          </div>
          <div className="mc-thread-list">
            <div className="mc-thread-item">
              <div className="mc-thread-item-head">
                <span className="mc-thread-title">当前项目状态</span>
                <span className={`badge ${statusClass(activeProject?.status)}`}>{activeProject?.status ?? "unknown"}</span>
              </div>
              <div className="mc-thread-meta">
                <span>最近更新 {formatTime(activeProject?.last_seen_at)}</span>
                <span>运行中 thread {runningThreads}</span>
              </div>
              <div className="mc-note">
                项目路径: <span className="code">{activeProject?.path ?? "未注册路径"}</span>
              </div>
              <div className="mc-note">
                当前 Collector: <span className="code">{runningAgents > 0 ? `${runningAgents} online` : "none"}</span>
              </div>
            </div>
          </div>
        </article>
      </section>

      <ExecPanel slug={slug} />

      <section className="mc-two-col">
        <section className="panel mc-sidebar-card">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">项目导航</h2>
              <p className="mc-section-subtitle">保留状态入口，但不再和主会话区抢第一屏宽度。</p>
            </div>
          </div>
          <div className="mc-thread-list">
            <div className="mc-thread-item">
              <div className="mc-thread-item-head">
                <span className="mc-thread-title">工作建议</span>
                <span className="badge neutral">Guide</span>
              </div>
              <div className="mc-thread-snippet">先确认 Agent 在线，再在上方创建 thread。对话跑起来以后，优先在会话栏里切换而不是频繁返回首页。</div>
              <div className="mc-thread-meta">
                <span>collector {runningAgents}</span>
                <span>threads {threads.length}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="panel mc-sidebar-card">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">最近线程</h2>
              <p className="mc-section-subtitle">需要回看历史时在这里切，不再占用主会话台的可视区域。</p>
            </div>
          </div>
          <div className="mc-thread-list">
            {recentThreads.map((thread) => (
              <Link key={thread.thread_id} href={`/threads/${encodeURIComponent(thread.thread_id)}`} className="mc-thread-item">
                <div className="mc-thread-item-head">
                  <span className="mc-thread-title">{thread.title ?? thread.thread_id}</span>
                  <span className={`badge ${statusClass(thread.status)}`}>{thread.status ?? "unknown"}</span>
                </div>
                <div className="mc-thread-snippet">{truncate(thread.first_user_prompt ?? thread.title)}</div>
                <div className="mc-thread-meta">
                  <span className="code">{thread.thread_id}</span>
                  <span>{formatTime(thread.updated_at)}</span>
                </div>
              </Link>
            ))}
            {!recentThreads.length ? <div className="mc-empty">暂无线程，先在上方会话台发送第一条 prompt。</div> : null}
          </div>
        </section>
      </section>

      <AgentControlPanel projects={projects} defaultProjectSlug={slug} onChanged={refresh} />
    </main>
  );
}
