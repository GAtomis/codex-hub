"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  createMissionHandoff,
  describeAppError,
  fetchMission,
  fetchMissionProjectHandoffs,
  updateMissionProject,
  type MissionDetail,
  type MissionHandoff,
  type MissionProject,
} from "../../../lib/api";
import ExecPanel from "../../projects/[slug]/exec-panel";

type Props = {
  missionId: string;
};

type HandoffForm = {
  toProjectSlug: string;
  title: string;
  summary: string;
};

const POLL_INTERVAL_MS = 15_000;

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

const projectStatusLabel = (status: string): string => {
  switch (status) {
    case "ready":
      return "可开始";
    case "running":
      return "Codex 处理中";
    case "waiting_user":
      return "等你回复";
    case "blocked":
      return "阻塞";
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    default:
      return "待排期";
  }
};

const projectStatusClass = (status: string): string => {
  switch (status) {
    case "running":
    case "ready":
    case "waiting_user":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return "pending";
  }
};

const sortProjects = (projects: MissionProject[]): MissionProject[] =>
  [...projects].sort((a, b) => {
    const priority = (value: string): number => {
      switch (value) {
        case "waiting_user":
          return 0;
        case "running":
          return 1;
        case "ready":
          return 2;
        case "blocked":
          return 3;
        case "failed":
          return 4;
        case "completed":
          return 5;
        default:
          return 6;
      }
    };
    const byPriority = priority(a.status) - priority(b.status);
    if (byPriority !== 0) {
      return byPriority;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });

export default function MissionShell({ missionId }: Props) {
  const [detail, setDetail] = useState<MissionDetail | null>(null);
  const [selectedProjectSlug, setSelectedProjectSlug] = useState("");
  const [handoffs, setHandoffs] = useState<MissionHandoff[]>([]);
  const [handoffForm, setHandoffForm] = useState<HandoffForm>({
    toProjectSlug: "",
    title: "",
    summary: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [handoffSaving, setHandoffSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMission = async (args?: { silent?: boolean }) => {
    if (!args?.silent) {
      setLoading(true);
    }
    try {
      const next = await fetchMission(missionId);
      setDetail(next);
      setSelectedProjectSlug((current) => {
        if (current && next.projects.some((item) => item.projectSlug === current)) {
          return current;
        }
        return next.suggestedFocusProject ?? next.projects[0]?.projectSlug ?? "";
      });
    } catch (loadError) {
      setError(describeAppError(loadError instanceof Error ? loadError.message : String(loadError)));
    } finally {
      if (!args?.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadMission();
    const timer = window.setInterval(() => {
      void loadMission({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [missionId]);

  useEffect(() => {
    if (!selectedProjectSlug) {
      setHandoffs([]);
      return;
    }
    let cancelled = false;
    const loadHandoffs = async () => {
      try {
        const next = await fetchMissionProjectHandoffs(missionId, selectedProjectSlug);
        if (!cancelled) {
          setHandoffs(next);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(describeAppError(loadError instanceof Error ? loadError.message : String(loadError)));
        }
      }
    };
    void loadHandoffs();
    return () => {
      cancelled = true;
    };
  }, [missionId, selectedProjectSlug]);

  const orderedProjects = useMemo(
    () => sortProjects(detail?.projects ?? []),
    [detail?.projects],
  );

  const selectedProject = useMemo(
    () => orderedProjects.find((item) => item.projectSlug === selectedProjectSlug) ?? null,
    [orderedProjects, selectedProjectSlug],
  );

  const inboundDependencies = useMemo(
    () =>
      (detail?.dependencies ?? []).filter(
        (item) => item.toProjectSlug === selectedProjectSlug,
      ),
    [detail?.dependencies, selectedProjectSlug],
  );

  const outboundDependencies = useMemo(
    () =>
      (detail?.dependencies ?? []).filter(
        (item) => item.fromProjectSlug === selectedProjectSlug,
      ),
    [detail?.dependencies, selectedProjectSlug],
  );

  const recentMissionHandoffs = useMemo(
    () =>
      [...(detail?.handoffs ?? [])]
        .filter((item) =>
          selectedProjectSlug
            ? item.fromProjectSlug === selectedProjectSlug || item.toProjectSlug === selectedProjectSlug
            : true,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 6),
    [detail?.handoffs, selectedProjectSlug],
  );

  const targetProjectOptions = useMemo(
    () => orderedProjects.filter((item) => item.projectSlug !== selectedProjectSlug),
    [orderedProjects, selectedProjectSlug],
  );

  useEffect(() => {
    setHandoffForm((current) => ({
      ...current,
      toProjectSlug:
        current.toProjectSlug &&
        targetProjectOptions.some((item) => item.projectSlug === current.toProjectSlug)
          ? current.toProjectSlug
          : targetProjectOptions[0]?.projectSlug ?? "",
    }));
  }, [targetProjectOptions]);

  const patchSelectedProject = async (
    patch: {
      projectRole?: string;
      taskGoal?: string;
      threadId?: string;
      latestSummary?: string;
      status?: "pending" | "ready" | "running" | "waiting_user" | "blocked" | "completed" | "failed";
      latestChangeCount?: number;
      waitingForUser?: boolean;
    },
  ) => {
    if (!selectedProjectSlug) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await updateMissionProject(missionId, selectedProjectSlug, patch);
      setDetail(next);
    } catch (saveError) {
      setError(describeAppError(saveError instanceof Error ? saveError.message : String(saveError)));
    } finally {
      setSaving(false);
    }
  };

  const submitHandoff = async () => {
    if (!selectedProject || !handoffForm.toProjectSlug || !handoffForm.title.trim() || !handoffForm.summary.trim()) {
      return;
    }
    setHandoffSaving(true);
    setError(null);
    try {
      await createMissionHandoff(missionId, {
        fromProjectSlug: selectedProject.projectSlug,
        toProjectSlug: handoffForm.toProjectSlug,
        title: handoffForm.title.trim(),
        summary: handoffForm.summary.trim(),
        sourceThreadId: selectedProject.threadId ?? undefined,
      });
      setHandoffForm((current) => ({
        ...current,
        title: "",
        summary: "",
      }));
      await Promise.all([
        loadMission({ silent: true }),
        fetchMissionProjectHandoffs(missionId, selectedProject.projectSlug).then(setHandoffs),
      ]);
    } catch (handoffError) {
      setError(describeAppError(handoffError instanceof Error ? handoffError.message : String(handoffError)));
    } finally {
      setHandoffSaving(false);
    }
  };

  if (loading && !detail) {
    return (
      <main className="grid" style={{ gap: 20 }}>
        <section className="panel">
          <div className="mc-empty">Mission 加载中...</div>
        </section>
      </main>
    );
  }

  return (
    <main className="grid" style={{ gap: 20 }}>
      <section className="panel mc-hero">
        <div className="mc-hero-head">
          <div className="grid" style={{ gap: 10 }}>
            <div className="mc-chip-row">
              <span className="mc-chip accent">Mission Workspace</span>
              <span className="mc-chip info">{detail?.projects.length ?? 0} projects</span>
              <span className="mc-chip warn">{detail?.suggestedFocusProject ?? "manual focus"}</span>
            </div>
            <h1 className="mc-hero-title">{detail?.mission.title ?? missionId}</h1>
            <p className="mc-hero-subtitle">{detail?.mission.goal ?? ""}</p>
          </div>
          <div className="mc-action-row">
            <Link href="/missions" className="mc-button ghost">
              返回 Mission 列表
            </Link>
            <button
              type="button"
              className="mc-button secondary"
              onClick={() => void loadMission()}
            >
              {loading ? "刷新中..." : "刷新 Mission"}
            </button>
          </div>
        </div>
        {detail?.mission.description ? (
          <div className="mc-note">{detail.mission.description}</div>
        ) : null}
      </section>

      {error ? (
        <section className="panel">
          <div className="mc-inline-feedback error">{error}</div>
        </section>
      ) : null}

      <section className="mc-mission-shell">
        <aside className="panel mc-mission-rail">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">Mission 项目</h2>
              <p className="mc-section-subtitle">优先把等待你处理和正在运行的项目放在前面。</p>
            </div>
          </div>
          <div className="mc-session-rail-list">
            {orderedProjects.map((project) => (
              <button
                key={project.projectSlug}
                type="button"
                className={`mc-mission-project-card${project.projectSlug === selectedProjectSlug ? " active" : ""}`}
                onClick={() => setSelectedProjectSlug(project.projectSlug)}
              >
                <div className="mc-thread-item-head">
                  <span className="mc-thread-title">{project.projectName}</span>
                  <span className={`badge ${projectStatusClass(project.status)}`}>
                    {projectStatusLabel(project.status)}
                  </span>
                </div>
                <div className="mc-thread-meta">
                  <span>{project.projectSlug}</span>
                  <span>updated {formatTime(project.updatedAt)}</span>
                </div>
                {project.projectRole ? <div className="mc-note">角色: {project.projectRole}</div> : null}
                <div className="mc-thread-snippet">{project.taskGoal}</div>
                <div className="mc-chip-row">
                  {project.waitingForUser ? <span className="mc-chip accent">需要你回复</span> : null}
                  {project.threadId ? <span className="mc-chip info">thread 已绑定</span> : null}
                  {project.latestChangeCount > 0 ? <span className="mc-chip warn">changes {project.latestChangeCount}</span> : null}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="mc-mission-main">
          {selectedProjectSlug ? (
            <ExecPanel key={selectedProjectSlug} slug={selectedProjectSlug} sessionPanelMode="drawer" />
          ) : (
            <div className="panel">
              <div className="mc-empty">当前 mission 还没有可用项目。</div>
            </div>
          )}
        </section>

        <aside className="panel mc-mission-aside">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">当前工作项目</h2>
              <p className="mc-section-subtitle">这里处理项目任务说明、依赖关系和 handoff 交接。</p>
            </div>
            {selectedProject ? (
              <span className={`badge ${projectStatusClass(selectedProject.status)}`}>
                {projectStatusLabel(selectedProject.status)}
              </span>
            ) : null}
          </div>

          {selectedProject ? (
            <div className="grid" style={{ gap: 14 }}>
              <div className="mc-thread-item active">
                <div className="mc-thread-title">{selectedProject.projectName}</div>
                <div className="mc-thread-meta">
                  <span>{selectedProject.projectSlug}</span>
                  <span>updated {formatTime(selectedProject.updatedAt)}</span>
                </div>
                {selectedProject.projectRole ? <div className="mc-note">角色: {selectedProject.projectRole}</div> : null}
                <div className="mc-thread-snippet">{selectedProject.taskGoal}</div>
                {selectedProject.latestSummary ? (
                  <div className="mc-note">最近摘要: {selectedProject.latestSummary}</div>
                ) : null}
                <div className="mc-chip-row">
                  {selectedProject.threadId ? (
                    <span className="mc-chip info">thread {selectedProject.threadId.slice(0, 8)}</span>
                  ) : (
                    <span className="mc-chip warn">尚未绑定 thread</span>
                  )}
                  {selectedProject.waitingForUser ? (
                    <span className="mc-chip accent">已到你接力</span>
                  ) : null}
                </div>
              </div>

              <div className="mc-mission-status-actions">
                <button type="button" className="mc-button secondary" disabled={saving} onClick={() => void patchSelectedProject({ status: "ready", waitingForUser: false })}>
                  标记可开始
                </button>
                <button type="button" className="mc-button secondary" disabled={saving} onClick={() => void patchSelectedProject({ status: "running", waitingForUser: false })}>
                  标记处理中
                </button>
                <button type="button" className="mc-button secondary" disabled={saving} onClick={() => void patchSelectedProject({ status: "waiting_user", waitingForUser: true })}>
                  标记等我回复
                </button>
                <button type="button" className="mc-button secondary" disabled={saving} onClick={() => void patchSelectedProject({ status: "completed", waitingForUser: false })}>
                  标记完成
                </button>
                <button type="button" className="mc-button danger" disabled={saving} onClick={() => void patchSelectedProject({ status: "blocked" })}>
                  标记阻塞
                </button>
              </div>

              <div className="mc-mission-note-grid">
                <div className="mc-mission-note-card">
                  <div className="mc-field-label">inbound dependencies</div>
                  <div className="mc-chip-row">
                    {inboundDependencies.length > 0 ? (
                      inboundDependencies.map((item) => (
                        <span key={`${item.fromProjectSlug}-${item.toProjectSlug}`} className="mc-chip warn">
                          {item.fromProjectSlug} {" -> "} {item.toProjectSlug}
                        </span>
                      ))
                    ) : (
                      <span className="mc-note">无前置项目依赖</span>
                    )}
                  </div>
                </div>
                <div className="mc-mission-note-card">
                  <div className="mc-field-label">outbound dependencies</div>
                  <div className="mc-chip-row">
                    {outboundDependencies.length > 0 ? (
                      outboundDependencies.map((item) => (
                        <span key={`${item.fromProjectSlug}-${item.toProjectSlug}`} className="mc-chip info">
                          {item.fromProjectSlug} {" -> "} {item.toProjectSlug}
                        </span>
                      ))
                    ) : (
                      <span className="mc-note">当前项目不阻塞其他项目</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="mc-mission-note-card">
                <div className="mc-section-head">
                  <div>
                    <h3 className="mc-section-title">发送 Handoff</h3>
                    <p className="mc-section-subtitle">把当前项目结论同步给另一个项目，方便切换编程上下文。</p>
                  </div>
                </div>
                <div className="mc-mission-form-grid">
                  <label className="mc-field">
                    <span className="mc-field-label">to project</span>
                    <select
                      className="mc-select light"
                      value={handoffForm.toProjectSlug}
                      onChange={(event) =>
                        setHandoffForm((current) => ({
                          ...current,
                          toProjectSlug: event.target.value,
                        }))
                      }
                    >
                      {targetProjectOptions.map((project) => (
                        <option key={project.projectSlug} value={project.projectSlug}>
                          {project.projectName} ({project.projectSlug})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mc-field">
                    <span className="mc-field-label">title</span>
                    <input
                      className="mc-input light"
                      value={handoffForm.title}
                      onChange={(event) =>
                        setHandoffForm((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                      placeholder="例如：B 接口字段已确认，A 可以开始串接"
                    />
                  </label>
                  <label className="mc-field">
                    <span className="mc-field-label">summary</span>
                    <textarea
                      className="mc-input light mc-textarea"
                      value={handoffForm.summary}
                      onChange={(event) =>
                        setHandoffForm((current) => ({
                          ...current,
                          summary: event.target.value,
                        }))
                      }
                      rows={4}
                      placeholder="写清楚已完成内容、接口约束、下一步建议。"
                    />
                  </label>
                </div>
                <div className="mc-action-row">
                  <button
                    type="button"
                    className="mc-button"
                    disabled={handoffSaving || targetProjectOptions.length === 0}
                    onClick={() => void submitHandoff()}
                  >
                    {handoffSaving ? "发送中..." : "发送 Handoff"}
                  </button>
                </div>
              </div>

              <div className="mc-mission-note-card">
                <div className="mc-section-head">
                  <div>
                    <h3 className="mc-section-title">发给当前项目的 Handoffs</h3>
                    <p className="mc-section-subtitle">切到这个项目时，先看别人交接了什么。</p>
                  </div>
                </div>
                <div className="mc-thread-list">
                  {handoffs.map((handoff) => (
                    <div key={handoff.handoffId} className="mc-thread-item">
                      <div className="mc-thread-item-head">
                        <span className="mc-thread-title">{handoff.title}</span>
                        <span className="mc-chip info">from {handoff.fromProjectSlug}</span>
                      </div>
                      <div className="mc-thread-snippet">{handoff.summary}</div>
                      <div className="mc-thread-meta">
                        <span>{formatTime(handoff.createdAt)}</span>
                        {handoff.sourceThreadId ? <span>thread {handoff.sourceThreadId.slice(0, 8)}</span> : null}
                      </div>
                    </div>
                  ))}
                  {handoffs.length === 0 ? <div className="mc-empty">当前项目还没有收到 handoff。</div> : null}
                </div>
              </div>

              <div className="mc-mission-note-card">
                <div className="mc-section-head">
                  <div>
                    <h3 className="mc-section-title">最近相关交接</h3>
                    <p className="mc-section-subtitle">包含当前项目发出和收到的最新 handoff。</p>
                  </div>
                </div>
                <div className="mc-thread-list">
                  {recentMissionHandoffs.map((handoff) => (
                    <div key={handoff.handoffId} className="mc-thread-item">
                      <div className="mc-thread-item-head">
                        <span className="mc-thread-title">{handoff.title}</span>
                        <span className="mc-chip warn">
                          {handoff.fromProjectSlug} {" -> "} {handoff.toProjectSlug}
                        </span>
                      </div>
                      <div className="mc-thread-snippet">{handoff.summary}</div>
                    </div>
                  ))}
                  {recentMissionHandoffs.length === 0 ? <div className="mc-empty">还没有跨项目交接记录。</div> : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="mc-empty">请选择一个项目开始工作。</div>
          )}
        </aside>
      </section>
    </main>
  );
}
