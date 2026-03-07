"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AgentControlPanel from "./agent-control-panel";
import ProjectManagerPanel from "./project-manager-panel";
import { fetchOverview, fetchProjects, type Overview, type Project } from "../lib/api";

const API_BASE = process.env.NEXT_PUBLIC_HUB_API_BASE ?? "http://127.0.0.1:4010";

const StatusBadge = ({ status }: { status: string }) => {
  const cls = status === "running" || status === "completed" || status === "failed" ? status : "";
  return <span className={`badge ${cls}`}>{status}</span>;
};

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState("");

  const refresh = async () => {
    try {
      const [nextOverview, nextProjects] = await Promise.all([fetchOverview(), fetchProjects()]);
      setOverview(nextOverview);
      setProjects(nextProjects);
      setError(null);
      if (!selectedProject && nextProjects.length > 0) {
        setSelectedProject(nextProjects[0].slug);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
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

  return (
    <main className="grid" style={{ gap: 20 }}>
      <h1 style={{ margin: 0 }}>Codex Hub</h1>
      <p style={{ marginTop: -10, color: "#334155" }}>多项目 Codex 运行状态中枢面板（自动刷新）</p>

      <section className="panel" style={{ display: "grid", gap: 10 }}>
        <h2 style={{ margin: 0 }}>项目切换</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            className="code"
            value={selectedProject}
            onChange={(event) => setSelectedProject(event.target.value)}
            style={{ minWidth: 260, padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
          >
            <option value="">请选择项目</option>
            {projects.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name} ({project.slug})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => canJumpProject && router.push(`/projects/${encodeURIComponent(selectedProject)}`)}
            disabled={!canJumpProject}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #0f172a",
              background: canJumpProject ? "#0f172a" : "#94a3b8",
              color: "#fff",
              cursor: canJumpProject ? "pointer" : "not-allowed"
            }}
          >
            进入项目控制台
          </button>

          <button
            type="button"
            onClick={() => void refresh()}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              background: "#fff"
            }}
          >
            立即刷新
          </button>
        </div>
      </section>

      <ProjectManagerPanel projects={projects} onChanged={refresh} />

      <AgentControlPanel projects={projects} defaultProjectSlug={selectedProject} onChanged={refresh} />

      {error ? (
        <section className="panel">
          <div className="code" style={{ color: "#b91c1c" }}>
            {error}
          </div>
        </section>
      ) : null}

      <section className="grid grid-3">
        <article className="panel">
          <div>项目数</div>
          <div style={{ fontSize: 30, fontWeight: 700 }}>{overview?.projectCount ?? (loading ? "..." : 0)}</div>
        </article>
        <article className="panel">
          <div>线程状态分布</div>
          <div style={{ marginTop: 8 }}>
            {(overview?.threadStatus ?? []).map((item) => (
              <div key={item.status} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <StatusBadge status={item.status} />
                <b>{item.count}</b>
              </div>
            ))}
          </div>
        </article>
        <article className="panel">
          <div>实时流入口</div>
          <div className="code" style={{ marginTop: 8 }}>
            <div>/v1/stream/events</div>
            <div style={{ color: "#64748b" }}>可用 EventSource 订阅后端事件</div>
          </div>
        </article>
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>项目列表</h2>
        <table className="table">
          <thead>
            <tr>
              <th>项目</th>
              <th>路径</th>
              <th>线程数</th>
              <th>状态</th>
              <th>最后上报</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.slug}>
                <td>
                  <Link href={`/projects/${encodeURIComponent(project.slug)}`}>{project.name}</Link>
                </td>
                <td className="code">{project.path}</td>
                <td>{project.thread_count}</td>
                <td>
                  <StatusBadge status={project.status} />
                </td>
                <td>{new Date(project.last_seen_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>最近事件（自动刷新）</h2>
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
          </tbody>
        </table>
      </section>
    </main>
  );
}
