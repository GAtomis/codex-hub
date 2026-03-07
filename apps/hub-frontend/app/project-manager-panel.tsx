"use client";

import { useMemo, useState } from "react";
import { registerProject, updateProject, validateProjectPath, type Project } from "../lib/api";

type Props = {
  projects: Project[];
  onChanged?: () => void | Promise<void>;
};

export default function ProjectManagerPanel({ projects, onChanged }: Props) {
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editName, setEditName] = useState("");
  const [editPath, setEditPath] = useState("");
  const [editStatus, setEditStatus] = useState("online");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canCreate = useMemo(() => newSlug.trim() && newName.trim() && newPath.trim(), [newSlug, newName, newPath]);
  const selectedProject = useMemo(() => projects.find((item) => item.slug === editSlug), [projects, editSlug]);

  const onCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    setLoading(true);
    try {
      await registerProject({
        slug: newSlug.trim(),
        name: newName.trim(),
        path: newPath.trim()
      });
      setMessage("项目已注册");
      setError(null);
      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "register_failed");
      setMessage(null);
    } finally {
      setLoading(false);
    }
  };

  const onSelectEditProject = (slug: string) => {
    setEditSlug(slug);
    const project = projects.find((item) => item.slug === slug);
    if (!project) {
      return;
    }
    setEditName(project.name);
    setEditPath(project.path);
    setEditStatus(project.status);
  };

  const onUpdate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editSlug.trim()) {
      return;
    }
    setLoading(true);
    try {
      await updateProject(editSlug, {
        name: editName.trim() || undefined,
        path: editPath.trim() || undefined,
        status: editStatus.trim() || undefined
      });
      setMessage("项目配置已更新");
      setError(null);
      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "update_failed");
      setMessage(null);
    } finally {
      setLoading(false);
    }
  };

  const onValidate = async () => {
    if (!editSlug.trim()) {
      return;
    }
    setLoading(true);
    try {
      const result = await validateProjectPath(editSlug, editPath.trim() || undefined);
      setMessage(result.ok ? `路径可用: ${result.path}` : `路径异常: ${result.path}`);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "validate_failed");
      setMessage(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel" style={{ display: "grid", gap: 14 }}>
      <h2 style={{ margin: 0 }}>项目管理</h2>
      <p style={{ margin: 0, color: "#475569" }}>新增/编辑项目，避免在启动 Agent 时手填路径出错。</p>

      <form onSubmit={onCreate} style={{ display: "grid", gap: 8 }}>
        <div className="code">注册新项目</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr auto", gap: 8 }}>
          <input value={newSlug} onChange={(event) => setNewSlug(event.target.value)} placeholder="slug" style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }} />
          <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="name" style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }} />
          <input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="/abs/path/to/project" style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }} />
          <button
            type="submit"
            disabled={loading || !Boolean(canCreate)}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #0f172a", background: "#0f172a", color: "#fff" }}
          >
            注册
          </button>
        </div>
      </form>

      <form onSubmit={onUpdate} style={{ display: "grid", gap: 8 }}>
        <div className="code">编辑已注册项目</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr 1fr auto auto", gap: 8 }}>
          <select value={editSlug} onChange={(event) => onSelectEditProject(event.target.value)} style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}>
            <option value="">选择项目</option>
            {projects.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name} ({item.slug})
              </option>
            ))}
          </select>
          <input value={editName} onChange={(event) => setEditName(event.target.value)} placeholder="name" style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }} />
          <input value={editPath} onChange={(event) => setEditPath(event.target.value)} placeholder="/abs/path/to/project" style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }} />
          <select value={editStatus} onChange={(event) => setEditStatus(event.target.value)} style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}>
            <option value="online">online</option>
            <option value="offline">offline</option>
            <option value="paused">paused</option>
          </select>
          <button type="button" onClick={() => void onValidate()} disabled={loading || !selectedProject} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #334155", background: "#f8fafc" }}>
            校验路径
          </button>
          <button type="submit" disabled={loading || !selectedProject} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #0f172a", background: "#0f172a", color: "#fff" }}>
            保存
          </button>
        </div>
      </form>

      {message ? <div className="code" style={{ color: "#166534" }}>{message}</div> : null}
      {error ? <div className="code" style={{ color: "#b91c1c" }}>{error}</div> : null}
    </section>
  );
}
