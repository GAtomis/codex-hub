"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  createMission,
  describeAppError,
  fetchMissions,
  fetchProjects,
  type CreateMissionInput,
  type MissionSummary,
  type Project,
} from "../../lib/api";

type DraftProjectRow = {
  id: string;
  projectSlug: string;
  projectRole: string;
  taskGoal: string;
  dependsOnProjectSlug: string;
};

const makeDraftRow = (seed: number): DraftProjectRow => ({
  id: `draft-${seed}`,
  projectSlug: "",
  projectRole: "",
  taskGoal: "",
  dependsOnProjectSlug: "",
});

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const missionStatusLabel = (status: string): string => {
  switch (status) {
    case "active":
      return "进行中";
    case "blocked":
      return "阻塞";
    case "completed":
      return "完成";
    default:
      return "草稿";
  }
};

const missionStatusClass = (status: string): string => {
  switch (status) {
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "blocked":
      return "failed";
    default:
      return "pending";
  }
};

export default function MissionListPanel() {
  const router = useRouter();
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<DraftProjectRow[]>([makeDraftRow(1), makeDraftRow(2)]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [missionList, projectList] = await Promise.all([
          fetchMissions(),
          fetchProjects(),
        ]);
        if (cancelled) {
          return;
        }
        setMissions(missionList);
        setProjects(projectList.filter((project) => !["archived", "detached"].includes(project.status)));
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(describeAppError(loadError instanceof Error ? loadError.message : String(loadError)));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const projectOptions = useMemo(
    () =>
      [...projects].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    [projects],
  );

  const canAddRow = rows.length < Math.min(projectOptions.length || 12, 12);

  const updateRow = (id: string, patch: Partial<DraftProjectRow>) => {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== id) {
          return row;
        }
        const next = { ...row, ...patch };
        if (patch.projectSlug && patch.projectSlug === next.dependsOnProjectSlug) {
          next.dependsOnProjectSlug = "";
        }
        return next;
      }),
    );
  };

  const addRow = () => {
    setRows((current) => [...current, makeDraftRow(current.length + 1)]);
  };

  const removeRow = (id: string) => {
    if (rows.length <= 1) {
      return;
    }
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const draftDependencies = useMemo(
    () =>
      rows
        .filter((row) => row.projectSlug && row.dependsOnProjectSlug)
        .map((row) => ({
          fromProjectSlug: row.dependsOnProjectSlug,
          toProjectSlug: row.projectSlug,
        })),
    [rows],
  );

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: CreateMissionInput = {
        title: title.trim(),
        goal: goal.trim(),
        description: description.trim() || undefined,
        status: "active",
        projects: rows.map((row) => ({
          projectSlug: row.projectSlug.trim(),
          projectRole: row.projectRole.trim() || undefined,
          taskGoal: row.taskGoal.trim(),
        })),
        dependencies: draftDependencies.length > 0 ? draftDependencies : undefined,
      };
      const detail = await createMission(payload);
      router.push(`/missions/${encodeURIComponent(detail.mission.missionId)}`);
    } catch (submitError) {
      setError(describeAppError(submitError instanceof Error ? submitError.message : String(submitError)));
    } finally {
      setSaving(false);
    }
  };

  const createDisabled =
    saving ||
    !title.trim() ||
    !goal.trim() ||
    rows.some((row) => !row.projectSlug.trim() || !row.taskGoal.trim());

  return (
    <main className="grid" style={{ gap: 20 }}>
      <section className="panel mc-hero">
        <div className="mc-hero-head">
          <div className="grid" style={{ gap: 10 }}>
            <div className="mc-chip-row">
              <span className="mc-chip accent">Mission MVP</span>
              <span className="mc-chip info">Cross Project Coding</span>
              <span className="mc-chip warn">Multi Workspace</span>
            </div>
            <h1 className="mc-hero-title">Codex Mission 室</h1>
            <p className="mc-hero-subtitle">
              把一个业务需求拆给多个项目同时推进。先定义目标、参与项目和依赖顺序，再进入每个项目继续用现有对话工作台编码。
            </p>
          </div>
          <div className="mc-action-row">
            <Link href="/" className="mc-button ghost">
              返回总览
            </Link>
            <button
              type="button"
              className="mc-button secondary"
              onClick={() => setRefreshNonce((value) => value + 1)}
            >
              {loading ? "刷新中..." : "刷新列表"}
            </button>
          </div>
        </div>
      </section>

      {error ? (
        <section className="panel">
          <div className="mc-inline-feedback error">{error}</div>
        </section>
      ) : null}

      <section className="mc-mission-list-layout">
        <article className="panel mc-mission-form">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">新建 Mission</h2>
              <p className="mc-section-subtitle">一条 mission 对应一个跨项目需求，下面每一行是一个参与项目的执行任务。</p>
            </div>
            <div className="mc-chip-row">
              <span className="mc-chip accent">projects {rows.length}</span>
              <span className="mc-chip info">deps {draftDependencies.length}</span>
            </div>
          </div>

          <div className="mc-mission-form-grid">
            <label className="mc-field">
              <span className="mc-field-label">mission title</span>
              <input
                className="mc-input light"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：A 项目接入 B 项目支付接口并同步控制台能力"
              />
            </label>
            <label className="mc-field">
              <span className="mc-field-label">mission goal</span>
              <textarea
                className="mc-input light mc-textarea"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="写清楚业务目标、预期结果和跨项目协作关系。"
                rows={4}
              />
            </label>
            <label className="mc-field">
              <span className="mc-field-label">mission description</span>
              <textarea
                className="mc-input light mc-textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="补充背景、限制条件、交付节奏。"
                rows={3}
              />
            </label>
          </div>

          <div className="mc-mission-project-drafts">
            {rows.map((row, index) => {
              const availableDependencies = rows.filter(
                (item) => item.id !== row.id && item.projectSlug,
              );
              return (
                <div key={row.id} className="mc-mission-project-draft">
                  <div className="mc-thread-item-head">
                    <div>
                      <div className="mc-thread-title">项目任务 {index + 1}</div>
                      <div className="mc-thread-meta">
                        <span>选择一个项目并定义该项目的职责</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="mc-button ghost"
                      onClick={() => removeRow(row.id)}
                      disabled={rows.length <= 1}
                    >
                      删除
                    </button>
                  </div>

                  <div className="mc-mission-draft-grid">
                    <label className="mc-field">
                      <span className="mc-field-label">project</span>
                      <select
                        className="mc-select light"
                        value={row.projectSlug}
                        onChange={(event) =>
                          updateRow(row.id, { projectSlug: event.target.value })
                        }
                      >
                        <option value="">选择项目</option>
                        {projectOptions.map((project) => (
                          <option key={project.slug} value={project.slug}>
                            {project.name} ({project.slug})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="mc-field">
                      <span className="mc-field-label">role</span>
                      <input
                        className="mc-input light"
                        value={row.projectRole}
                        onChange={(event) =>
                          updateRow(row.id, { projectRole: event.target.value })
                        }
                        placeholder="例如：API owner / UI shell / auth gateway"
                      />
                    </label>
                    <label className="mc-field">
                      <span className="mc-field-label">depends on</span>
                      <select
                        className="mc-select light"
                        value={row.dependsOnProjectSlug}
                        onChange={(event) =>
                          updateRow(row.id, {
                            dependsOnProjectSlug: event.target.value,
                          })
                        }
                      >
                        <option value="">无前置依赖</option>
                        {availableDependencies.map((item) => (
                          <option key={item.id} value={item.projectSlug}>
                            {item.projectSlug}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="mc-field mc-mission-draft-goal">
                      <span className="mc-field-label">task goal</span>
                      <textarea
                        className="mc-input light mc-textarea"
                        value={row.taskGoal}
                        onChange={(event) =>
                          updateRow(row.id, { taskGoal: event.target.value })
                        }
                        placeholder="这个项目在 mission 里要完成什么。"
                        rows={3}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mc-action-row">
            <button
              type="button"
              className="mc-button secondary"
              onClick={addRow}
              disabled={!canAddRow}
            >
              添加项目任务
            </button>
            <button
              type="button"
              className="mc-button"
              onClick={() => void submit()}
              disabled={createDisabled}
            >
              {saving ? "创建中..." : "创建 Mission"}
            </button>
          </div>
        </article>

        <article className="panel mc-mission-list">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">Mission 列表</h2>
              <p className="mc-section-subtitle">最近更新优先，点击后进入跨项目工作台。</p>
            </div>
            <div className="mc-chip-row">
              <span className="mc-chip accent">missions {missions.length}</span>
            </div>
          </div>

          <div className="mc-thread-list">
            {missions.map((mission) => (
              <Link
                key={mission.missionId}
                href={`/missions/${encodeURIComponent(mission.missionId)}`}
                className="mc-mission-card"
              >
                <div className="mc-thread-item-head">
                  <div>
                    <div className="mc-thread-title">{mission.title}</div>
                    <div className="mc-thread-meta">
                      <span>{mission.projectCount} 个项目</span>
                      <span>等待你处理 {mission.waitingProjectCount}</span>
                      <span>运行中 {mission.activeProjectCount}</span>
                    </div>
                  </div>
                  <span className={`badge ${missionStatusClass(mission.status)}`}>
                    {missionStatusLabel(mission.status)}
                  </span>
                </div>
                <div className="mc-thread-snippet">{mission.goal}</div>
                <div className="mc-chip-row">
                  {mission.suggestedFocusProject ? (
                    <span className="mc-chip accent">
                      focus {mission.suggestedFocusProject}
                    </span>
                  ) : null}
                  <span className="mc-chip info">updated {formatTime(mission.updatedAt)}</span>
                </div>
              </Link>
            ))}
            {!loading && missions.length === 0 ? (
              <div className="mc-empty">还没有 mission。先在左侧创建一个跨项目需求。</div>
            ) : null}
          </div>
        </article>
      </section>
    </main>
  );
}
