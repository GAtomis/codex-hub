"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { deleteAgent, fetchAgents, startAgent, stopAgent, type ManagedAgent, type Project } from "../lib/api";

type Props = {
  projects: Project[];
  defaultProjectSlug?: string;
  onChanged?: () => void | Promise<void>;
};

const statusStyle = (status: ManagedAgent["status"]): CSSProperties => {
  if (status === "running") {
    return { background: "#dcfce7", color: "#166534" };
  }
  if (status === "failed") {
    return { background: "#fee2e2", color: "#991b1b" };
  }
  if (status === "starting") {
    return { background: "#fef3c7", color: "#92400e" };
  }
  return { background: "#e2e8f0", color: "#334155" };
};

export default function AgentControlPanel({ projects, defaultProjectSlug, onChanged }: Props) {
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [projectSlug, setProjectSlug] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [sessionsRoot, setSessionsRoot] = useState("");
  const [scanIntervalMs, setScanIntervalMs] = useState("5000");
  const [maxFiles, setMaxFiles] = useState("20");
  const [stateFile, setStateFile] = useState("");

  const loadAgents = async () => {
    try {
      const data = await fetchAgents();
      setAgents(data.agents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_agents_failed");
    }
  };

  useEffect(() => {
    void loadAgents();
    const timer = setInterval(() => {
      void loadAgents();
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (projects.length === 0) {
      return;
    }
    const selected = projects.find((item) => item.slug === defaultProjectSlug) ?? projects[0];
    if (!selected) {
      return;
    }
    if (!projectSlug) {
      setProjectSlug(selected.slug);
    }
    if (!projectName) {
      setProjectName(selected.name);
    }
    if (!projectPath) {
      setProjectPath(selected.path);
    }
  }, [projects, defaultProjectSlug, projectSlug, projectName, projectPath]);

  const projectOptions = useMemo(
    () =>
      projects.map((item) => ({
        value: item.slug,
        label: `${item.name} (${item.slug})`,
        name: item.name,
        path: item.path
      })),
    [projects]
  );

  const onSelectProject = (slug: string) => {
    const selected = projects.find((item) => item.slug === slug);
    if (!selected) {
      return;
    }
    setProjectSlug(selected.slug);
    setProjectName(selected.name);
    setProjectPath(selected.path);
  };

  const onSubmitStart = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectSlug.trim()) {
      setError("project_slug_required");
      return;
    }

    setLoading(true);
    try {
      await startAgent({
        projectSlug: projectSlug.trim(),
        projectName: projectName.trim() || undefined,
        projectPath: projectPath.trim() || undefined,
        sessionsRoot: sessionsRoot.trim() || undefined,
        scanIntervalMs: Number(scanIntervalMs),
        maxFiles: Number(maxFiles),
        stateFile: stateFile.trim() || undefined
      });
      setError(null);
      await loadAgents();
      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "start_agent_failed");
    } finally {
      setLoading(false);
    }
  };

  const onStop = async (id: string) => {
    setActionLoadingId(id);
    try {
      await stopAgent(id);
      setError(null);
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "stop_agent_failed");
    } finally {
      setActionLoadingId(null);
    }
  };

  const onDelete = async (id: string) => {
    setActionLoadingId(id);
    try {
      await deleteAgent(id);
      setError(null);
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete_agent_failed");
    } finally {
      setActionLoadingId(null);
    }
  };

  return (
    <section className="panel" style={{ display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0 }}>Agent 可视化启动/停止</h2>
      <p style={{ margin: 0, color: "#475569" }}>
        在前端直接拉起 <span className="code">project-agent</span>，开始扫描会话并写入 Hub。
      </p>

      <form onSubmit={onSubmitStart} style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <select
            value={projectSlug}
            onChange={(event) => onSelectProject(event.target.value)}
            style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
          >
            <option value="">选择已注册项目（可选）</option>
            {projectOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <input
            className="code"
            value={projectSlug}
            onChange={(event) => setProjectSlug(event.target.value)}
            placeholder="project slug（必填）"
            style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
          />
        </div>

        <input
          className="code"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          placeholder="project name（建议）"
          style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
        />
        <input
          className="code"
          value={projectPath}
          onChange={(event) => setProjectPath(event.target.value)}
          placeholder="project path（建议）"
          style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
        />
        <input
          className="code"
          value={sessionsRoot}
          onChange={(event) => setSessionsRoot(event.target.value)}
          placeholder="sessions root（可空，默认 ~/.codex/sessions）"
          style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <input
            className="code"
            value={scanIntervalMs}
            onChange={(event) => setScanIntervalMs(event.target.value)}
            placeholder="scan_interval_ms"
            style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
          />
          <input
            className="code"
            value={maxFiles}
            onChange={(event) => setMaxFiles(event.target.value)}
            placeholder="max_files"
            style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
          />
          <input
            className="code"
            value={stateFile}
            onChange={(event) => setStateFile(event.target.value)}
            placeholder="state_file（可空）"
            style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          style={{
            width: 180,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #0f172a",
            background: "#0f172a",
            color: "#fff",
            cursor: loading ? "not-allowed" : "pointer"
          }}
        >
          {loading ? "启动中..." : "启动 Agent"}
        </button>
      </form>

      {error ? <div className="code" style={{ color: "#b91c1c" }}>{error}</div> : null}

      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>项目</th>
              <th>状态</th>
              <th>PID</th>
              <th>启动时间</th>
              <th>输出摘要</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const canStop = agent.status === "running" || agent.status === "starting";
              const output = (agent.stderrTail || agent.stdoutTail || "").trim();
              return (
                <tr key={agent.id}>
                  <td>
                    <div>{agent.projectName}</div>
                    <div className="code">{agent.projectSlug}</div>
                  </td>
                  <td>
                    <span className="badge" style={statusStyle(agent.status)}>
                      {agent.status}
                    </span>
                  </td>
                  <td className="code">{agent.pid ?? "-"}</td>
                  <td>{new Date(agent.startedAt).toLocaleString()}</td>
                  <td>
                    <pre
                      className="code"
                      style={{
                        margin: 0,
                        maxWidth: 360,
                        maxHeight: 110,
                        overflow: "auto",
                        whiteSpace: "pre-wrap"
                      }}
                    >
                      {output || "(empty)"}
                    </pre>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        disabled={!canStop || actionLoadingId === agent.id}
                        onClick={() => void onStop(agent.id)}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid #991b1b",
                          background: canStop ? "#fee2e2" : "#e2e8f0",
                          color: canStop ? "#991b1b" : "#64748b",
                          cursor: canStop ? "pointer" : "not-allowed"
                        }}
                      >
                        {actionLoadingId === agent.id ? "停止中..." : "停止"}
                      </button>
                      <button
                        type="button"
                        disabled={canStop || actionLoadingId === agent.id}
                        onClick={() => void onDelete(agent.id)}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid #334155",
                          background: canStop ? "#e2e8f0" : "#f8fafc",
                          color: "#334155",
                          cursor: canStop ? "not-allowed" : "pointer"
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {agents.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ color: "#64748b" }}>
                  暂无运行记录，先用上方表单启动一个 agent。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
