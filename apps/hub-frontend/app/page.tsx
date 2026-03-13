"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AgentControlPanel from "./agent-control-panel";
import ProjectManagerPanel from "./project-manager-panel";
import SpotlightTour, { type SpotlightStep } from "./spotlight-tour";
import { describeAppError, fetchOverview, fetchProjects, type Overview, type Project } from "../lib/api";

const API_BASE = process.env.NEXT_PUBLIC_HUB_API_BASE ?? "http://127.0.0.1:4010";

const PIXEL_FONT: Record<string, string[]> = {
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"]
};

type PixelRect = {
  x: number;
  y: number;
};

const toPixelRects = (source: Set<string>): PixelRect[] =>
  Array.from(source, (key) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y };
  }).filter((item) => item.x >= 0 && item.y >= 0);

const buildWordmark = (text: string) => {
  const pixel = 10;
  const letterGap = 1;
  const fill = new Set<string>();
  let cursor = 0;

  for (const char of text) {
    const glyph = PIXEL_FONT[char];
    const width = glyph?.[0]?.length ?? 0;

    for (let y = 0; y < (glyph?.length ?? 0); y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (glyph[y][x] === "1") {
          fill.add([cursor + x, y].join(","));
        }
      }
    }

    cursor += width + letterGap;
  }

  const outline = new Set<string>();
  const highlight = new Set<string>();
  const shade = new Set<string>();

  for (const key of fill) {
    const [x, y] = key.split(",").map(Number);

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nextKey = [x + dx, y + dy].join(",");
        if (!fill.has(nextKey)) {
          outline.add(nextKey);
        }
      }
    }

    const hasTop = fill.has([x, y - 1].join(","));
    const hasLeft = fill.has([x - 1, y].join(","));
    const hasTopLeft = fill.has([x - 1, y - 1].join(","));
    const hasBottom = fill.has([x, y + 1].join(","));
    const hasRight = fill.has([x + 1, y].join(","));
    const hasBottomRight = fill.has([x + 1, y + 1].join(","));

    if (!hasTop || !hasLeft || !hasTopLeft) {
      highlight.add(key);
    }

    if (!hasBottom || !hasRight || !hasBottomRight) {
      shade.add(key);
    }
  }

  return {
    pixel,
    width: Math.max(1, (cursor - letterGap) * pixel),
    height: 7 * pixel,
    outline: toPixelRects(outline),
    fill: toPixelRects(fill),
    highlight: toPixelRects(highlight),
    shade: toPixelRects(shade)
  };
};

const PixelLayer = ({ pixels, size, fill }: { pixels: PixelRect[]; size: number; fill: string }) => (
  <g fill={fill}>
    {pixels.map((pixelRect, index) => (
      <rect key={`${fill}-${index}`} x={pixelRect.x * size} y={pixelRect.y * size} width={size} height={size} />
    ))}
  </g>
);

const PixelWordmark = ({ text, className }: { text: string; className?: string }) => {
  const wordmark = buildWordmark(text);

  return (
    <svg
      aria-hidden="true"
      className={className ?? "mc-logo-svg"}
      viewBox={`0 0 ${wordmark.width} ${wordmark.height}`}
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
    >
      <PixelLayer pixels={wordmark.outline} size={wordmark.pixel} fill="transparent" />
      <PixelLayer pixels={wordmark.fill} size={wordmark.pixel} fill="#866848" />
      <PixelLayer pixels={wordmark.shade} size={wordmark.pixel} fill="#5f4631" />
      <PixelLayer pixels={wordmark.highlight} size={wordmark.pixel} fill="#b3916f" />
    </svg>
  );
};

const PixelGrassConnector = () => {
  const size = 8;
  const outline = new Set(["0,0", "1,0", "2,0", "3,0", "4,0", "5,0", "0,1", "5,1", "0,2", "5,2", "0,3", "5,3", "0,4", "1,4", "2,4", "3,4", "4,4", "5,4"]);
  const grass = new Set(["1,1", "2,1", "3,1", "4,1", "1,2", "2,2", "3,2", "4,2"]);
  const grassShade = new Set(["3,1", "4,1", "4,2"]);
  const grassLight = new Set(["1,1", "2,1", "2,2"]);
  const dirt = new Set(["1,3", "2,3", "3,3", "4,3", "1,2"]);
  const dirtShade = new Set(["3,3", "4,3", "4,2"]);
  const dirtLight = new Set(["1,2", "2,3"]);

  return (
    <svg aria-hidden="true" className="mc-logo-connector" viewBox="0 0 48 40" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
      <PixelLayer pixels={toPixelRects(outline)} size={size} fill="transparent" />
      <PixelLayer pixels={toPixelRects(dirt)} size={size} fill="#81522d" />
      <PixelLayer pixels={toPixelRects(dirtShade)} size={size} fill="#60361b" />
      <PixelLayer pixels={toPixelRects(dirtLight)} size={size} fill="#9a673a" />
      <PixelLayer pixels={toPixelRects(grass)} size={size} fill="#6dc94d" />
      <PixelLayer pixels={toPixelRects(grassShade)} size={size} fill="#3f8c26" />
      <PixelLayer pixels={toPixelRects(grassLight)} size={size} fill="#a3ef79" />
    </svg>
  );
};

const StatusBadge = ({ status }: { status: string }) => {
  const cls = status === "running" || status === "completed" || status === "failed" ? status : "";
  return <span className={`badge ${cls}`}>{status}</span>;
};

const HOME_TOUR_STEPS: SpotlightStep[] = [
  {
    selector: "#home-project-manager",
    title: "先注册项目",
    description: "第一步先把你的工作区注册进 Hub。这里填写项目名称、项目路径和规范 slug，后续所有对话和采集都会围绕这个项目展开。",
    placement: "top"
  },
  {
    selector: "#home-agent-control",
    title: "再启动采集 Agent",
    description: "Agent 是这个项目的会话采集器，不是对话本身。通常一个项目保留一个 collector 就够了，它负责把本地 Codex 会话持续同步进 Hub。",
    placement: "top"
  },
  {
    selector: "#home-hero-actions",
    title: "从这里进入项目工作台",
    description: "项目接入后，在首页顶部选择项目并进入工作台。真正像 codex app 一样持续对话、切换 thread，都在项目页完成。",
    placement: "bottom"
  },
  {
    selector: "#home-project-list",
    title: "已接入项目从这里继续",
    description: "当项目越来越多时，这里就是你的中枢入口。直接打开最近项目，而不是每次都重新配置。",
    placement: "top"
  }
];

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState("");

  const refresh = async () => {
    try {
      const [nextOverview, nextProjects] = await Promise.all([fetchOverview(), fetchProjects({ includeRetired: true })]);
      setOverview(nextOverview);
      setProjects(nextProjects);
      setError(null);
      if (!selectedProject && nextProjects.length > 0) {
        setSelectedProject(nextProjects.find((project) => !["archived", "detached"].includes(project.status))?.slug ?? nextProjects[0].slug);
      }
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "load_failed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10000);

    const source = new EventSource(`${API_BASE}/v1/stream/events`);
    source.onmessage = () => {
      void refresh();
    };

    return () => {
      clearInterval(timer);
      source.close();
    };
  }, []);


  const canJumpProject = useMemo(() => selectedProject.trim().length > 0, [selectedProject]);
  const runningCount = useMemo(
    () => overview?.threadStatus.find((item) => item.status === "running")?.count ?? 0,
    [overview]
  );
  const failedCount = useMemo(
    () => overview?.threadStatus.find((item) => item.status === "failed")?.count ?? 0,
    [overview]
  );
  const completedCount = useMemo(
    () => overview?.threadStatus.find((item) => item.status === "completed")?.count ?? 0,
    [overview]
  );
  const activeProjects = useMemo(() => projects.filter((project) => !["archived", "detached"].includes(project.status)), [projects]);
  const featuredProjects = useMemo(() => activeProjects.slice(0, 6), [activeProjects]);

  useEffect(() => {
    if (selectedProject && activeProjects.some((project) => project.slug === selectedProject)) {
      return;
    }
    setSelectedProject(activeProjects[0]?.slug ?? "");
  }, [activeProjects, selectedProject]);

  return (
    <main className="grid" style={{ gap: 20 }}>
      <SpotlightTour storageKey="codex_hub_tour_home_v2" steps={HOME_TOUR_STEPS} />
      <section className="panel mc-hero">
        <div className="mc-hero-head">
          <div className="grid" style={{ gap: 10 }}>
            <h1 className="mc-logo mc-logo-wordmark" aria-label="Codex Hub">
              <span className="mc-logo-lockup">
                <PixelWordmark text="CODEX" className="mc-logo-svg mc-logo-svg--codex" />
                <PixelGrassConnector />
                <PixelWordmark text="HUB" className="mc-logo-svg mc-logo-svg--hub" />
              </span>
            </h1>
            <p className="mc-hero-subtitle">
              以项目会话为中心的本地 Codex 中枢。直接进入项目继续对话、查看线程历史、管理 agent，而不是先理解一堆底层模块。
            </p>
          </div>
          <div className="mc-chip-row">
            <span className="mc-chip accent">Console First</span>
            <span className="mc-chip info">Minecraft UI</span>
            <span className="mc-chip warn">Live Events</span>
          </div>
        </div>

        <div id="home-hero-actions" className="mc-action-row">
          <select className="mc-select light code" value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
            <option value="">选择一个项目继续工作</option>
            {activeProjects.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name} ({project.slug})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="mc-button"
            onClick={() => canJumpProject && router.push(`/projects/${encodeURIComponent(selectedProject)}`)}
            disabled={!canJumpProject}
          >
            进入项目工作台
          </button>
          <Link href="/war-room" className="mc-button secondary">
            进入监控室
          </Link>
          <Link href="/missions" className="mc-button secondary">
            进入 Mission 室
          </Link>
          <button type="button" className="mc-button secondary" onClick={() => void refresh()}>
            立即刷新
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel">
          <div className="code" style={{ color: "#b91c1c" }}>
            {error}
          </div>
        </section>
      ) : null}
      <section className="mc-kpi-grid">
        <article className="panel mc-kpi-card">
          <div className="mc-kpi-label">项目数</div>
          <div className="mc-kpi-value">{overview?.projectCount ?? (loading ? "..." : 0)}</div>
          <div className="mc-kpi-meta">已接入的工作区总数</div>
        </article>
        <article className="panel mc-kpi-card">
          <div className="mc-kpi-label">运行中线程</div>
          <div className="mc-kpi-value">{runningCount}</div>
          <div className="mc-kpi-meta">正在持续执行或交互</div>
        </article>
        <article className="panel mc-kpi-card">
          <div className="mc-kpi-label">已完成线程</div>
          <div className="mc-kpi-value">{completedCount}</div>
          <div className="mc-kpi-meta">可继续加载历史的会话</div>
        </article>
        <article className="panel mc-kpi-card">
          <div className="mc-kpi-label">异常线程</div>
          <div className="mc-kpi-value">{failedCount}</div>
          <div className="mc-kpi-meta">建议优先检查日志和 thread</div>
        </article>
      </section>

      <section id="home-project-list" className="panel grid" style={{ gap: 14 }}>
        <div className="mc-section-head">
          <div>
            <h2 className="mc-section-title">继续工作</h2>
            <p className="mc-section-subtitle">优先展示项目入口，而不是把表格和接口放在第一屏。</p>
          </div>
        </div>
        <div className="mc-project-grid">
          {featuredProjects.map((project) => (
            <article key={project.slug} className="panel mc-project-card">
              <div className="mc-project-card-head">
                <div className="grid" style={{ gap: 6 }}>
                  <h3 className="mc-project-name">{project.name}</h3>
                  <div className="mc-project-path code">{project.path}</div>
                </div>
                <StatusBadge status={project.status} />
              </div>
              <div className="mc-chip-row">
                <span className="mc-chip info">slug {project.slug}</span>
                <span className="mc-chip accent">threads {project.thread_count}</span>
              </div>
              <div className="mc-project-actions">
                <Link className="mc-button" href={`/projects/${encodeURIComponent(project.slug)}`}>
                  打开会话台
                </Link>
              </div>
            </article>
          ))}
          {featuredProjects.length === 0 ? <div className="mc-empty">暂无项目，先在下方注册一个项目。</div> : null}
        </div>
      </section>

      <section className="mc-two-col">
        <ProjectManagerPanel sectionId="home-project-manager" projects={projects} onChanged={refresh} />
        <AgentControlPanel sectionId="home-agent-control" projects={activeProjects} defaultProjectSlug={selectedProject} onChanged={refresh} />
      </section>

      <section className="panel grid" style={{ gap: 12 }}>
        <div className="mc-section-head">
          <div>
            <h2 className="mc-section-title">最近事件</h2>
            <p className="mc-section-subtitle">保留运维视角，但放到第二层，避免干扰主路径。</p>
          </div>
          <div className="mc-chip-row">
            <span className="mc-chip info code">/v1/stream/events</span>
          </div>
        </div>
        <div className="mc-table-shell">
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>项目</th>
                <th>线程</th>
                <th>类型</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {(overview?.recentEvents ?? []).map((event) => (
                <tr key={event.event_id}>
                  <td>{new Date(event.event_ts).toLocaleString()}</td>
                  <td>{event.project_slug}</td>
                  <td>
                    <Link href={`/threads/${encodeURIComponent(event.thread_id)}`} className="code">
                      {event.thread_id}
                    </Link>
                  </td>
                  <td className="code">{event.event_type}</td>
                  <td>{event.status ? <StatusBadge status={event.status} /> : "-"}</td>
                </tr>
              ))}
              {!overview?.recentEvents?.length ? (
                <tr>
                  <td colSpan={5} className="mc-muted">
                    暂无事件
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
