"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import AgentControlPanel from "../../agent-control-panel";
import { fetchProjects, fetchThreads, type Project, type Thread } from "../../../lib/api";
import ExecPanel from "./exec-panel";

const API_BASE = process.env.NEXT_PUBLIC_HUB_API_BASE ?? "http://127.0.0.1:4010";

type Props = {
  slug: string;
};

export default function ProjectConsole({ slug }: Props) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedProject, setSelectedProject] = useState(slug);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const [nextProjects, nextThreads] = await Promise.all([fetchProjects(), fetchThreads(slug)]);
      setProjects(nextProjects);
      setThreads(nextThreads);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedProject(slug);
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10000);

    const source = new EventSource(`${API_BASE}/v1/stream/events?projectSlug=${encodeURIComponent(slug)}`);
    source.onmessage = () => {
      void refresh();
    };

    return () => {
      clearInterval(timer);
      source.close();
    };
  }, [slug]);

  const canSwitch = useMemo(() => selectedProject.trim().length > 0, [selectedProject]);

  return (
    <main className="grid" style={{ gap: 20 }}>
      <div>
        <Link href="/">返回总览</Link>
      </div>

      <section className="panel" style={{ display: "grid", gap: 10 }}>
        <h1 style={{ margin: 0 }}>项目控制台：{slug}</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            className="code"
            value={selectedProject}
            onChange={(event) => setSelectedProject(event.target.value)}
            style={{ minWidth: 260, padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
          >
            {projects.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name} ({project.slug})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!canSwitch}
            onClick={() => canSwitch && router.push(`/projects/${encodeURIComponent(selectedProject)}`)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #0f172a",
              background: canSwitch ? "#0f172a" : "#94a3b8",
              color: "#fff",
              cursor: canSwitch ? "pointer" : "not-allowed"
            }}
          >
            切换项目
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

      <AgentControlPanel projects={projects} defaultProjectSlug={slug} onChanged={refresh} />

      <ExecPanel slug={slug} />

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>线程列表（自动刷新）</h2>
        {error ? <div className="code" style={{ color: "#b91c1c" }}>{error}</div> : null}
        {loading ? <div style={{ color: "#64748b" }}>加载中...</div> : null}
        <table className="table">
          <thead>
            <tr>
              <th>线程 ID</th>
              <th>标题</th>
              <th>状态</th>
              <th>最后更新时间</th>
            </tr>
          </thead>
          <tbody>
            {threads.map((thread) => (
              <tr key={thread.thread_id}>
                <td className="code">
                  <Link href={`/threads/${encodeURIComponent(thread.thread_id)}`}>{thread.thread_id}</Link>
                </td>
                <td>{thread.title ?? "-"}</td>
                <td>{thread.status ?? "-"}</td>
                <td>{new Date(thread.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
