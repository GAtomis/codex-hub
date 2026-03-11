"use client";

import { useEffect, useMemo, useState } from "react";
import {
  deleteAgent,
  describeAppError,
  fetchAgents,
  normalizeProjectSlug,
  pickLocalDirectory,
  startAgent,
  stopAgent,
  validateProjectSlug,
  type ManagedAgent,
  type Project
} from "../lib/api";

type Props = {
  projects: Project[];
  sectionId?: string;
  defaultProjectSlug?: string;
  onChanged?: () => void | Promise<void>;
};

const deriveProjectMetaFromPath = (projectPath: string): { slug: string; name: string } => {
  const baseName = projectPath
    .trim()
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ?? "";

  const slug = normalizeProjectSlug(baseName);
  const humanized = baseName
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const name = /^[a-z0-9\s]+$/i.test(humanized)
    ? humanized.replace(/\b\w/g, (char) => char.toUpperCase())
    : humanized;

  return {
    slug,
    name: name || baseName
  };
};

const agentBadgeClass = (status: ManagedAgent["status"]): string => {
  if (status === "running") {
    return "running";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "starting") {
    return "starting";
  }
  return "neutral";
};

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

export default function AgentControlPanel({ projects, sectionId, defaultProjectSlug, onChanged }: Props) {
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
  const [pickerLoading, setPickerLoading] = useState(false);

  const loadAgents = async () => {
    try {
      const data = await fetchAgents();
      setAgents(data.agents);
      setError(null);
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "load_agents_failed"));
    }
  };

  useEffect(() => {
    void loadAgents();
    const timer = window.setInterval(() => {
      void loadAgents();
    }, 4_000);
    return () => window.clearInterval(timer);
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

  const runningCount = useMemo(() => agents.filter((agent) => agent.status === "running").length, [agents]);
  const normalizedProjectSlug = useMemo(() => normalizeProjectSlug(projectSlug), [projectSlug]);
  const projectSlugError = useMemo(() => validateProjectSlug(projectSlug), [projectSlug]);
  const canStart = useMemo(
    () => Boolean(normalizedProjectSlug && projectPath.trim() && !projectSlugError),
    [normalizedProjectSlug, projectPath, projectSlugError]
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

  const onPickProjectPath = async () => {
    setPickerLoading(true);
    try {
      const result = await pickLocalDirectory("Choose project folder for agent startup");
      if (!result.ok) {
        return;
      }

      const derived = deriveProjectMetaFromPath(result.path);
      const matchedProject = projects.find((item) => item.path === result.path);
      setProjectPath(result.path);

      if (matchedProject) {
        setProjectSlug(matchedProject.slug);
        setProjectName(matchedProject.name);
      } else {
        if (!projectSlug.trim() && derived.slug) {
          setProjectSlug(derived.slug);
        }
        if (!projectName.trim() && derived.name) {
          setProjectName(derived.name);
        }
      }

      setError(null);
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "directory_picker_failed"));
    } finally {
      setPickerLoading(false);
    }
  };

  const onSubmitStart = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectSlug.trim()) {
      setError(describeAppError("project_slug_required"));
      return;
    }

    if (projectSlugError) {
      setError(projectSlugError);
      return;
    }

    setLoading(true);
    try {
      await startAgent({
        projectSlug: normalizedProjectSlug,
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
      setError(describeAppError(err instanceof Error ? err.message : "start_agent_failed"));
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
      setError(describeAppError(err instanceof Error ? err.message : "stop_agent_failed"));
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
      setError(describeAppError(err instanceof Error ? err.message : "delete_agent_failed"));
    } finally {
      setActionLoadingId(null);
    }
  };

  return (
    <section id={sectionId} className="panel grid" style={{ gap: 14 }}>
      <div className="mc-section-head">
        <div>
          <h2 className="mc-section-title">Agent 控制台</h2>
          <p className="mc-section-subtitle">前端可视化拉起 `project-agent`，把本地 Codex 会话扫描进 Hub，再统一在页面上继续对话和查看历史。</p>
        </div>
        <div className="mc-chip-row">
          <span className="mc-chip accent">running {runningCount}</span>
          <span className="mc-chip info">agents {agents.length}</span>
        </div>
      </div>

      <form onSubmit={onSubmitStart} className="mc-form-shell">
        <div className="mc-form-title-row">
          <div className="mc-form-title">启动新的 Agent</div>
          <div className="mc-note">通常只需要选择项目并保持默认参数。高级参数仅在采集目录或轮询频率特殊时调整。</div>
        </div>
        <div className="mc-note">启动 Agent 只是在 Hub 中为这个项目拉起会话采集器，不等于开启一个新的对话线程。通常一个项目只需要一个采集 Agent。</div>
        {projectSlug ? (
          <div className={`mc-inline-feedback ${projectSlugError ? "error" : "success"}`}>
            {projectSlugError ?? `当前采集 slug：${normalizedProjectSlug}`}
          </div>
        ) : null}
        <div className="mc-form-grid-2">
          <label className="mc-field">
            <span className="mc-field-label">选择项目</span>
            <select className="mc-select light" value={projectSlug} onChange={(event) => onSelectProject(event.target.value)}>
              <option value="">选择已注册项目</option>
              {projectOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mc-field">
            <span className="mc-field-label">project slug</span>
            <input
              className="mc-input light code"
              value={projectSlug}
              onChange={(event) => setProjectSlug(normalizeProjectSlug(event.target.value))}
              placeholder="workspace-main"
            />
          </label>
        </div>
        <div className="mc-form-grid-2">
          <label className="mc-field">
            <span className="mc-field-label">project name</span>
            <input className="mc-input light" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="主工作区" />
          </label>
          <label className="mc-field">
            <span className="mc-field-label">project path</span>
            <div className="mc-path-picker-row">
              <input className="mc-input light code" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/abs/path/to/project" />
              <button type="button" className="mc-button secondary" onClick={() => void onPickProjectPath()} disabled={loading || pickerLoading}>
                {pickerLoading ? "选择中..." : "选择文件夹"}
              </button>
            </div>
          </label>
        </div>
        <div className="mc-note">你可以手动填写路径，也可以直接点“选择文件夹”让本地 Hub 打开系统目录选择器。若当前还没选已有项目，系统会根据目录名自动带出 slug 和 name。</div>
        <div className="mc-form-grid-4">
          <label className="mc-field" style={{ gridColumn: "span 2" }}>
            <span className="mc-field-label">sessions root</span>
            <input className="mc-input light code" value={sessionsRoot} onChange={(event) => setSessionsRoot(event.target.value)} placeholder="~/.codex/sessions" />
          </label>
          <label className="mc-field">
            <span className="mc-field-label">scan interval ms</span>
            <input className="mc-input light code" value={scanIntervalMs} onChange={(event) => setScanIntervalMs(event.target.value)} placeholder="5000" />
          </label>
          <label className="mc-field">
            <span className="mc-field-label">max files</span>
            <input className="mc-input light code" value={maxFiles} onChange={(event) => setMaxFiles(event.target.value)} placeholder="20" />
          </label>
        </div>
        <div className="mc-form-grid-2">
          <label className="mc-field">
            <span className="mc-field-label">state file</span>
            <input className="mc-input light code" value={stateFile} onChange={(event) => setStateFile(event.target.value)} placeholder="可留空" />
          </label>
          <div className="mc-field">
            <span className="mc-field-label">执行</span>
            <div className="mc-inline-actions">
              <button type="submit" className="mc-button" disabled={loading || !canStart}>
                {loading ? "启动中..." : "启动 Agent"}
              </button>
            </div>
          </div>
        </div>
      </form>

      {error ? (
        <div className="code" style={{ color: "#b91c1c", whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}

      <div className="mc-thread-list">
        {agents.map((agent) => {
          const canStop = agent.status === "running" || agent.status === "starting";
          const output = (agent.stderrTail || agent.stdoutTail || "").trim();
          return (
            <article key={agent.id} className="mc-thread-item">
              <div className="mc-thread-item-head">
                <div className="grid" style={{ gap: 4 }}>
                  <span className="mc-thread-title">{agent.projectName}</span>
                  <span className="code">{agent.projectSlug}</span>
                </div>
                <span className={`badge ${agentBadgeClass(agent.status)}`}>{agent.status}</span>
              </div>
              <div className="mc-thread-meta">
                <span>PID {agent.pid ?? "-"}</span>
                <span>启动时间 {formatTime(agent.startedAt)}</span>
              </div>
              <div className="mc-note">
                扫描目录: <span className="code">{agent.sessionsRoot}</span>
              </div>
              <pre className="mc-log-preview code">{output || "(empty)"}</pre>
              <div className="mc-inline-actions">
                <button
                  type="button"
                  className="mc-button danger"
                  disabled={!canStop || actionLoadingId === agent.id}
                  onClick={() => void onStop(agent.id)}
                >
                  {actionLoadingId === agent.id ? "停止中..." : "停止"}
                </button>
                <button
                  type="button"
                  className="mc-button secondary"
                  disabled={canStop || actionLoadingId === agent.id}
                  onClick={() => void onDelete(agent.id)}
                >
                  删除
                </button>
              </div>
            </article>
          );
        })}
        {agents.length === 0 ? <div className="mc-empty">暂无运行记录，先在上方启动一个 Agent。</div> : null}
      </div>
    </section>
  );
}
