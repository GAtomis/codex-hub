"use client";

import { useEffect, useMemo, useState } from "react";
import {
  applyProjectLifecycle,
  describeAppError,
  fetchProjectLifecyclePreview,
  normalizeProjectSlug,
  pickLocalDirectory,
  registerProject,
  updateProject,
  validateProjectPath,
  validateProjectSlug,
  type Project,
  type ProjectLifecycleAction,
  type ProjectLifecyclePreview
} from "../lib/api";

type Props = {
  projects: Project[];
  sectionId?: string;
  onChanged?: () => void | Promise<void>;
};

type LifecycleDialogState = {
  action: ProjectLifecycleAction;
  projectSlug: string;
  projectName: string;
};

const ACTIVE_STATUSES = ["online", "offline", "paused"];

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

const isRetiredProject = (project: Project): boolean => ["archived", "detached"].includes(project.status);

const lifecycleCopy: Record<ProjectLifecycleAction, { title: string; body: string; button: string; danger: boolean }> = {
  archive: {
    title: "停用并移出监控",
    body: "项目会从首页、监控大屏和 Agent 主流程中隐藏，但历史会话和事件会全部保留，后续可以恢复。",
    button: "确认停用",
    danger: false
  },
  detach: {
    title: "移除项目但保留历史",
    body: "项目会从当前工作流中完全移除，运行中的 Agent 和任务会停止，但历史 thread / event 会保留，后续仍可恢复接入。",
    button: "确认移除",
    danger: true
  },
  restore: {
    title: "恢复到主工作流",
    body: "项目会重新回到首页、监控大屏和 Agent 启动列表中，历史记录保持不变。",
    button: "恢复项目",
    danger: false
  },
  purge: {
    title: "彻底清空项目与历史",
    body: "这会删除项目本身以及该项目下所有 thread / turn / event 历史。不会删除你本地磁盘上的代码目录。",
    button: "彻底清空",
    danger: true
  }
};

const retiredLabel = (status: string): string => {
  if (status === "archived") {
    return "已停用";
  }
  if (status === "detached") {
    return "历史保留";
  }
  return status;
};

const impactLine = (label: string, value: number): string => `${label}: ${value}`;

export default function ProjectManagerPanel({ projects, sectionId, onChanged }: Props) {
  const activeProjects = useMemo(() => projects.filter((project) => !isRetiredProject(project)), [projects]);
  const archivedProjects = useMemo(() => projects.filter((project) => project.status === "archived"), [projects]);
  const detachedProjects = useMemo(() => projects.filter((project) => project.status === "detached"), [projects]);

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
  const [pickerLoadingTarget, setPickerLoadingTarget] = useState<"create" | "edit" | null>(null);
  const [dialog, setDialog] = useState<LifecycleDialogState | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);
  const [dialogPreview, setDialogPreview] = useState<ProjectLifecyclePreview | null>(null);
  const [confirmSlug, setConfirmSlug] = useState("");

  const normalizedNewSlug = useMemo(() => normalizeProjectSlug(newSlug), [newSlug]);
  const newSlugError = useMemo(() => validateProjectSlug(newSlug), [newSlug]);
  const canCreate = useMemo(() => Boolean(normalizedNewSlug && newName.trim() && newPath.trim() && !newSlugError), [normalizedNewSlug, newName, newPath, newSlugError]);
  const selectedProject = useMemo(() => activeProjects.find((item) => item.slug === editSlug) ?? null, [activeProjects, editSlug]);

  useEffect(() => {
    if (selectedProject) {
      return;
    }
    const fallback = activeProjects[0] ?? null;
    if (!fallback) {
      setEditSlug("");
      setEditName("");
      setEditPath("");
      setEditStatus("online");
      return;
    }
    setEditSlug(fallback.slug);
    setEditName(fallback.name);
    setEditPath(fallback.path);
    setEditStatus(fallback.status);
  }, [activeProjects, selectedProject]);

  const onPickPath = async (target: "create" | "edit") => {
    setPickerLoadingTarget(target);
    try {
      const result = await pickLocalDirectory(target === "create" ? "Choose project folder for registration" : "Choose project folder to update path");
      if (!result.ok) {
        return;
      }

      const derived = deriveProjectMetaFromPath(result.path);
      if (target === "create") {
        setNewPath(result.path);
        if (derived.slug) {
          setNewSlug(derived.slug);
        }
        if (derived.name) {
          setNewName(derived.name);
        }
        setMessage(`已选择项目目录，并根据目录名回填 slug/name: ${result.path}`);
      } else {
        setEditPath(result.path);
        if (!editName.trim() && derived.name) {
          setEditName(derived.name);
        }
        setMessage(`已更新项目目录: ${result.path}`);
      }
      setError(null);
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "directory_picker_failed"));
      setMessage(null);
    } finally {
      setPickerLoadingTarget(null);
    }
  };

  const onCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    setLoading(true);
    try {
      await registerProject({
        slug: normalizedNewSlug,
        name: newName.trim(),
        path: newPath.trim()
      });
      setMessage("项目已注册并进入主工作流。");
      setError(null);
      setNewSlug("");
      setNewName("");
      setNewPath("");
      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "register_failed"));
      setMessage(null);
    } finally {
      setLoading(false);
    }
  };

  const onSelectEditProject = (slug: string) => {
    setEditSlug(slug);
    const project = activeProjects.find((item) => item.slug === slug);
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
      setMessage("项目配置已更新。");
      setError(null);
      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "update_failed"));
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
      setError(describeAppError(err instanceof Error ? err.message : "validate_failed"));
      setMessage(null);
    } finally {
      setLoading(false);
    }
  };

  const openLifecycleDialog = async (action: ProjectLifecycleAction, project: Project) => {
    setDialog({ action, projectSlug: project.slug, projectName: project.name });
    setDialogPreview(null);
    setConfirmSlug("");
    setDialogLoading(true);
    setError(null);
    try {
      const preview = await fetchProjectLifecyclePreview(project.slug);
      setDialogPreview(preview);
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "lifecycle_failed"));
      setDialog(null);
    } finally {
      setDialogLoading(false);
    }
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogPreview(null);
    setConfirmSlug("");
    setDialogLoading(false);
  };

  const onApplyLifecycle = async () => {
    if (!dialog) {
      return;
    }
    setDialogLoading(true);
    try {
      const result = await applyProjectLifecycle(dialog.projectSlug, {
        action: dialog.action,
        confirmSlug: dialog.action === "purge" ? confirmSlug.trim() : undefined
      });
      const actionCopy = lifecycleCopy[dialog.action];
      setMessage(
        `${actionCopy.title}已完成。agents ${result.runtimeChange.removedAgents}，tasks ${result.runtimeChange.canceledTasks}，threads ${result.impact.threadCount}，events ${result.impact.eventCount}。`
      );
      setError(null);
      closeDialog();
      if (dialog.action !== "restore" && editSlug === dialog.projectSlug) {
        const next = activeProjects.find((project) => project.slug !== dialog.projectSlug) ?? null;
        setEditSlug(next?.slug ?? "");
      }
      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      setError(describeAppError(err instanceof Error ? err.message : "lifecycle_failed"));
    } finally {
      setDialogLoading(false);
    }
  };

  return (
    <section id={sectionId} className="panel grid" style={{ gap: 14 }}>
      <div className="mc-section-head">
        <div>
          <h2 className="mc-section-title">项目管理</h2>
          <p className="mc-section-subtitle">现在不只接入项目，也支持停用、移除、恢复和彻底清空，保证你的中枢始终干净。</p>
        </div>
        <div className="mc-chip-row">
          <span className="mc-chip accent">active {activeProjects.length}</span>
          <span className="mc-chip info">archived {archivedProjects.length}</span>
          <span className="mc-chip danger">detached {detachedProjects.length}</span>
        </div>
      </div>

      <form onSubmit={onCreate} className="mc-form-shell">
        <div className="mc-form-title-row">
          <div className="mc-form-title">注册新项目</div>
          <div className="mc-note">支持手动填写或直接选择本地目录，目录名会自动生成 slug 和 name。</div>
        </div>
        <div className="mc-form-grid-4">
          <label className="mc-field">
            <span className="mc-field-label">slug</span>
            <input className="mc-input light code" value={newSlug} onChange={(event) => setNewSlug(normalizeProjectSlug(event.target.value))} placeholder="workspace-main" />
          </label>
          <label className="mc-field">
            <span className="mc-field-label">name</span>
            <input className="mc-input light" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="主工作区" />
          </label>
          <label className="mc-field" style={{ gridColumn: "span 2" }}>
            <span className="mc-field-label">project path</span>
            <div className="mc-path-picker-row">
              <input className="mc-input light code" value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="/abs/path/to/project" />
              <button type="button" className="mc-button secondary" onClick={() => void onPickPath("create")} disabled={loading || pickerLoadingTarget === "create"}>
                {pickerLoadingTarget === "create" ? "选择中..." : "选择文件夹"}
              </button>
            </div>
          </label>
        </div>
        {newSlug ? <div className={`mc-inline-feedback ${newSlugError ? "error" : "success"}`}>{newSlugError ?? `当前 slug：${normalizedNewSlug}`}</div> : null}
        <div className="mc-inline-actions">
          <button type="submit" className="mc-button" disabled={loading || !canCreate}>
            {loading ? "注册中..." : "注册项目"}
          </button>
        </div>
      </form>

      <div className="mc-divider" />

      <form onSubmit={onUpdate} className="mc-form-shell">
        <div className="mc-form-title-row">
          <div className="mc-form-title">编辑主工作流项目</div>
          <div className="mc-note">只展示当前仍在主工作流中的项目。已移出监控的项目请到下方恢复区处理。</div>
        </div>
        <div className="mc-form-grid-4">
          <label className="mc-field">
            <span className="mc-field-label">选择项目</span>
            <select className="mc-select light" value={editSlug} onChange={(event) => onSelectEditProject(event.target.value)}>
              <option value="">选择项目</option>
              {activeProjects.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.name} ({item.slug})
                </option>
              ))}
            </select>
          </label>
          <label className="mc-field">
            <span className="mc-field-label">name</span>
            <input className="mc-input light" value={editName} onChange={(event) => setEditName(event.target.value)} placeholder="主工作区" />
          </label>
          <label className="mc-field" style={{ gridColumn: "span 2" }}>
            <span className="mc-field-label">project path</span>
            <div className="mc-path-picker-row">
              <input className="mc-input light code" value={editPath} onChange={(event) => setEditPath(event.target.value)} placeholder="/abs/path/to/project" />
              <button type="button" className="mc-button secondary" onClick={() => void onPickPath("edit")} disabled={loading || pickerLoadingTarget === "edit"}>
                {pickerLoadingTarget === "edit" ? "选择中..." : "选择文件夹"}
              </button>
            </div>
          </label>
        </div>
        <div className="mc-form-grid-2">
          <label className="mc-field">
            <span className="mc-field-label">status</span>
            <select className="mc-select light" value={editStatus} onChange={(event) => setEditStatus(event.target.value)}>
              {ACTIVE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <div className="mc-field">
            <span className="mc-field-label">操作</span>
            <div className="mc-inline-actions">
              <button type="button" className="mc-button secondary" onClick={() => void onValidate()} disabled={loading || !selectedProject}>
                校验路径
              </button>
              <button type="submit" className="mc-button" disabled={loading || !selectedProject}>
                {loading ? "保存中..." : "保存修改"}
              </button>
            </div>
          </div>
        </div>
      </form>

      {selectedProject ? (
        <>
          <div className="mc-divider" />
          <section className="mc-form-shell">
            <div className="mc-form-title-row">
              <div className="mc-form-title">退出管理</div>
              <div className="mc-note">本地代码目录不会被删除。真正的危险动作只会作用在 Hub 的注册关系、Agent 运行态和历史数据。</div>
            </div>
            <div className="mc-lifecycle-grid">
              {(["archive", "detach", "purge"] as ProjectLifecycleAction[]).map((action) => (
                <article key={action} className={`mc-lifecycle-card ${lifecycleCopy[action].danger ? "danger" : ""}`}>
                  <div className="mc-lifecycle-title">{lifecycleCopy[action].title}</div>
                  <div className="mc-lifecycle-body">{lifecycleCopy[action].body}</div>
                  <button type="button" className={`mc-button ${lifecycleCopy[action].danger ? "danger" : "secondary"}`} onClick={() => void openLifecycleDialog(action, selectedProject)}>
                    {lifecycleCopy[action].button}
                  </button>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {(archivedProjects.length > 0 || detachedProjects.length > 0) ? (
        <>
          <div className="mc-divider" />
          <section className="mc-form-shell">
            <div className="mc-form-title-row">
              <div className="mc-form-title">已移出主工作流</div>
              <div className="mc-note">这里保留你停用或移除监控的项目。可以恢复，也可以在确认后彻底清空。</div>
            </div>
            <div className="mc-retired-list">
              {[...archivedProjects, ...detachedProjects].map((project) => (
                <article key={project.slug} className="mc-retired-card">
                  <div className="mc-retired-card-head">
                    <div className="grid" style={{ gap: 4 }}>
                      <strong>{project.name}</strong>
                      <span className="code">{project.slug}</span>
                    </div>
                    <span className={`mc-chip ${project.status === "detached" ? "danger" : "info"}`}>{retiredLabel(project.status)}</span>
                  </div>
                  <div className="mc-retired-card-meta">{project.path}</div>
                  <div className="mc-chip-row">
                    <span className="mc-chip accent">threads {project.thread_count}</span>
                    {project.retired_at ? <span className="mc-chip info">retired {new Date(project.retired_at).toLocaleString()}</span> : null}
                  </div>
                  <div className="mc-inline-actions">
                    <button type="button" className="mc-button secondary" onClick={() => void openLifecycleDialog("restore", project)}>
                      恢复到主工作流
                    </button>
                    <button type="button" className="mc-button danger" onClick={() => void openLifecycleDialog("purge", project)}>
                      彻底清空
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {message ? <div className="mc-inline-feedback success">{message}</div> : null}
      {error ? <div className="mc-inline-feedback error">{error}</div> : null}

      {dialog ? (
        <div className="mc-modal-backdrop" role="presentation" onClick={closeDialog}>
          <div className="panel mc-modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="mc-form-title-row">
              <div className="mc-form-title">{lifecycleCopy[dialog.action].title}</div>
              <div className="mc-note">目标项目：{dialog.projectName} ({dialog.projectSlug})</div>
            </div>
            <div className="mc-inline-feedback">{lifecycleCopy[dialog.action].body}</div>
            {dialogLoading && !dialogPreview ? <div className="mc-inline-feedback">正在计算影响范围...</div> : null}
            {dialogPreview ? (
              <div className="mc-modal-grid">
                <div className="mc-inline-feedback success">
                  {[
                    impactLine("threads", dialogPreview.impact.threadCount),
                    impactLine("turns", dialogPreview.impact.turnCount),
                    impactLine("events", dialogPreview.impact.eventCount),
                    impactLine("agents", dialogPreview.impact.agentCount),
                    impactLine("active tasks", dialogPreview.impact.activeTaskCount)
                  ].join(" | ")}
                </div>
                <div className="mc-note">本地磁盘目录不会被删除，影响范围仅限 Hub 中的项目注册、Agent 运行态和历史数据。</div>
                {dialog.action === "purge" ? (
                  <label className="mc-field">
                    <span className="mc-field-label">输入 slug 确认彻底清空</span>
                    <input className="mc-input light code" value={confirmSlug} onChange={(event) => setConfirmSlug(event.target.value)} placeholder={dialog.projectSlug} />
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="mc-inline-actions">
              <button type="button" className="mc-button ghost" onClick={closeDialog} disabled={dialogLoading}>
                取消
              </button>
              <button
                type="button"
                className={`mc-button ${lifecycleCopy[dialog.action].danger ? "danger" : "secondary"}`}
                onClick={() => void onApplyLifecycle()}
                disabled={dialogLoading || (dialog.action === "purge" && confirmSlug.trim() !== dialog.projectSlug)}
              >
                {dialogLoading ? "处理中..." : lifecycleCopy[dialog.action].button}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
