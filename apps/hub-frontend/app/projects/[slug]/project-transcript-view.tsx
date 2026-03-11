"use client";

import { useMemo, useState } from "react";
import type { RefObject } from "react";
import type {
  ThreadTranscript,
  TranscriptChangeFile,
  TranscriptChangeSummary,
  TranscriptEvent,
} from "../../../lib/api";

type TranscriptMessage = {
  messageId: string;
  turnId?: string | null;
  role: "user" | "assistant";
  text: string;
  status: string | null;
  eventType: string;
  timestamp: string;
};

type ThinkingPhase = {
  chip: string;
  title: string;
  detail: string;
  compact?: boolean;
};

type TurnSummaryMeta = {
  chip: string;
  label: string;
  tone: string;
};

type TranscriptViewMode = "all" | "messages" | "process" | "changes";

type Props = {
  transcript: ThreadTranscript | null;
  renderedMessages: TranscriptMessage[];
  activeAssistantMessageId: string | null;
  thinkingPhase: ThinkingPhase | null;
  showInlinePendingAssistant: boolean;
  turnSummaryMeta: TurnSummaryMeta | null;
  lastTurnSummary: {
    finishedAt: string;
    durationMs?: number;
    exitCode?: number;
    threadId: string | null;
  } | null;
  filteredThreadsCount: number;
  transcriptSubtitle: string;
  onOpenHistory: () => void;
  formatTime: (value: string) => string;
  formatDuration: (value?: number) => string;
  transcriptRef: RefObject<HTMLDivElement | null>;
};

type BaseRenderItem = {
  key: string;
  turnKey: string;
  timestamp: string;
};

type MessageRenderItem = BaseRenderItem & {
  kind: "message";
  message: TranscriptMessage;
};

type EventRenderItem = BaseRenderItem & {
  kind: "event";
  event: TranscriptEvent;
  changeSummary: TranscriptChangeSummary | null;
};

type ToolGroupRenderItem = BaseRenderItem & {
  kind: "tool_group";
  events: TranscriptEvent[];
};

type RenderItem = MessageRenderItem | EventRenderItem | ToolGroupRenderItem;

type TurnGroup = {
  turnKey: string;
  anchorTimestamp: string;
  items: RenderItem[];
};

type DiffFileGroup = {
  key: TranscriptChangeFile["status"];
  label: string;
  chip: string;
  files: TranscriptChangeFile[];
};

const VIEW_TABS: Array<{ value: TranscriptViewMode; label: string }> = [
  { value: "all", label: "全部" },
  { value: "messages", label: "消息" },
  { value: "process", label: "过程" },
  { value: "changes", label: "改动" },
];

const eventTone = (eventType: TranscriptEvent["eventType"]): string => {
  if (eventType === "error") {
    return "error";
  }
  if (eventType === "file_change_summary") {
    return "diff";
  }
  if (eventType === "command_step") {
    return "command";
  }
  if (eventType === "tool_step") {
    return "tool";
  }
  if (eventType === "reasoning_step") {
    return "reasoning";
  }
  return "state";
};

const eventLabel = (eventType: TranscriptEvent["eventType"]): string => {
  if (eventType === "reasoning_step") {
    return "Reasoning";
  }
  if (eventType === "tool_step") {
    return "Tool";
  }
  if (eventType === "command_step") {
    return "Command";
  }
  if (eventType === "file_change_summary") {
    return "Diff";
  }
  if (eventType === "turn_state") {
    return "Turn";
  }
  return "Error";
};

const itemOrder = (item: Exclude<RenderItem, ToolGroupRenderItem>): number => {
  if (item.kind === "message") {
    return item.message.role === "user" ? 0 : 4;
  }
  if (item.event.eventType === "turn_state") {
    const status = (item.event.status ?? "").toLowerCase();
    return status === "running" ? 1 : 6;
  }
  if (item.event.eventType === "reasoning_step") {
    return 2;
  }
  if (item.event.eventType === "tool_step") {
    return 3;
  }
  if (item.event.eventType === "command_step") {
    return 4;
  }
  if (item.event.eventType === "file_change_summary") {
    return 5;
  }
  return 7;
};

const resolveTurnKey = (
  currentTurnKey: string | null,
  item: {
    kind: RenderItem["kind"];
    turnId?: string | null;
    message?: TranscriptMessage;
  },
  index: number,
): string => {
  if (item.turnId) {
    return item.turnId;
  }
  if (item.kind === "message" && item.message?.role === "user") {
    return `local-turn-${item.message.messageId}`;
  }
  return currentTurnKey ?? `local-turn-${index}`;
};

const buildRenderItems = (
  transcript: ThreadTranscript | null,
  renderedMessages: TranscriptMessage[],
): RenderItem[] => {
  const changeSummaryMap = new Map(
    (transcript?.changeSummaries ?? []).map((item) => [item.eventId, item]),
  );
  const items: Array<MessageRenderItem | EventRenderItem> = [
    ...renderedMessages.map((message) => ({
      kind: "message" as const,
      key: `message:${message.messageId}`,
      turnKey: message.turnId ?? `local-turn-${message.messageId}`,
      timestamp: message.timestamp,
      message,
    })),
    ...(transcript?.events ?? [])
      .filter(
        (event) =>
          event.eventType !== "user_message" &&
          event.eventType !== "assistant_message",
      )
      .map((event) => ({
        kind: "event" as const,
        key: `event:${event.eventId}`,
        turnKey: event.turnId ?? `event-turn-${event.eventId}`,
        timestamp: event.timestamp,
        event,
        changeSummary: changeSummaryMap.get(event.eventId) ?? null,
      })),
  ];

  items.sort((left, right) => {
    const timeOrder = left.timestamp.localeCompare(right.timestamp);
    if (timeOrder !== 0) {
      return timeOrder;
    }
    return itemOrder(left) - itemOrder(right);
  });

  let currentTurnKey: string | null = null;
  return items.map((item, index) => {
    if (item.kind === "message") {
      const turnKey = resolveTurnKey(
        currentTurnKey,
        {
          kind: item.kind,
          turnId: item.message.turnId,
          message: item.message,
        },
        index,
      );
      currentTurnKey = turnKey;
      return { ...item, turnKey };
    }
    const turnKey = resolveTurnKey(
      currentTurnKey,
      { kind: item.kind, turnId: item.event.turnId },
      index,
    );
    currentTurnKey = turnKey;
    return { ...item, turnKey };
  });
};

const buildTurnGroups = (items: RenderItem[]): TurnGroup[] => {
  const map = new Map<string, TurnGroup>();
  const order: string[] = [];

  for (const item of items) {
    const existing = map.get(item.turnKey);
    if (!existing) {
      order.push(item.turnKey);
      map.set(item.turnKey, {
        turnKey: item.turnKey,
        anchorTimestamp: item.timestamp,
        items: [item],
      });
      continue;
    }
    existing.items.push(item);
    if (item.timestamp.localeCompare(existing.anchorTimestamp) < 0) {
      existing.anchorTimestamp = item.timestamp;
    }
  }

  return order
    .map((turnKey) => map.get(turnKey))
    .filter((group): group is TurnGroup => group !== undefined)
    .sort((left, right) =>
      left.anchorTimestamp.localeCompare(right.anchorTimestamp),
    );
};

const collapseContinuousToolSteps = (items: RenderItem[]): RenderItem[] => {
  const out: RenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const current = items[index];
    if (current.kind !== "event" || current.event.eventType !== "tool_step") {
      out.push(current);
      index += 1;
      continue;
    }

    const buffer: TranscriptEvent[] = [current.event];
    let pointer = index + 1;
    while (pointer < items.length) {
      const next = items[pointer];
      if (next.kind === "event" && next.event.eventType === "tool_step") {
        buffer.push(next.event);
        pointer += 1;
        continue;
      }
      break;
    }

    if (buffer.length >= 2) {
      out.push({
        kind: "tool_group",
        key: `tool-group:${current.turnKey}:${current.timestamp}`,
        turnKey: current.turnKey,
        timestamp: current.timestamp,
        events: buffer,
      });
    } else {
      out.push(current);
    }
    index = pointer;
  }

  return out;
};

const sumLineChanges = (files: TranscriptChangeFile[]) =>
  files.reduce(
    (acc, file) => ({
      additions: acc.additions + (file.additions ?? 0),
      deletions: acc.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );

const fileKind = (path: string): string => {
  const lower = path.toLowerCase();
  if (/\.(ts|tsx|js|jsx|go|py|rs|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|m)$/.test(lower)) {
    return "代码";
  }
  if (/\.(json|ya?ml|toml|ini|conf|env|sql|prisma|lock)$/.test(lower)) {
    return "配置";
  }
  if (/\.(md|mdx|txt|rst)$/.test(lower)) {
    return "文档";
  }
  if (/\.(png|jpe?g|gif|svg|webp|ico|mp4|mov|mp3|wav)$/.test(lower)) {
    return "资源";
  }
  return "其他";
};

const buildKindSummary = (files: TranscriptChangeFile[]): string[] => {
  const counts = new Map<string, number>();
  for (const file of files) {
    const kind = fileKind(file.path);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => `${label} ${count}`);
};

const groupDiffFiles = (files: TranscriptChangeFile[]): DiffFileGroup[] => {
  const order: TranscriptChangeFile["status"][] = ["modified", "added", "deleted"];
  const labels: Record<TranscriptChangeFile["status"], { label: string; chip: string }> = {
    modified: { label: "修改文件", chip: "M" },
    added: { label: "新增文件", chip: "+" },
    deleted: { label: "删除文件", chip: "-" },
  };
  return order
    .map((status) => ({
      key: status,
      label: labels[status].label,
      chip: labels[status].chip,
      files: files.filter((file) => file.status === status),
    }))
    .filter((group) => group.files.length > 0);
};

const eventStatusClass = (event: TranscriptEvent): string => {
  const status = (event.status ?? "").toLowerCase();
  if (status === "running") {
    return "status-running";
  }
  if (status === "completed") {
    return "status-completed";
  }
  if (status === "failed" || status === "error" || status === "canceled") {
    return "status-failed";
  }
  return "status-idle";
};

const turnStateMeta = (event: TranscriptEvent): {
  chip: string;
  title: string;
  detail: string;
} => {
  const status = (event.status ?? "").toLowerCase();
  if (status === "running") {
    return {
      chip: "进行中",
      title: "本轮已启动",
      detail: event.summary || "Codex 已开始处理这轮任务。",
    };
  }
  if (status === "completed") {
    return {
      chip: "已完成",
      title: "本轮已完成",
      detail: event.summary || "Codex 已完成这轮任务，等待你的下一步。",
    };
  }
  if (status === "failed" || status === "error") {
    return {
      chip: "失败",
      title: "本轮执行异常",
      detail: event.summary || "这轮任务执行失败，需要你查看原因。",
    };
  }
  return {
    chip: "状态",
    title: event.title,
    detail: event.summary,
  };
};

const isCompletedTurnState = (item: RenderItem): item is EventRenderItem =>
  item.kind === "event" &&
  item.event.eventType === "turn_state" &&
  (item.event.status ?? "").toLowerCase() === "completed";

const isAssistantMessageItem = (item: RenderItem): item is MessageRenderItem =>
  item.kind === "message" && item.message.role === "assistant";

const shouldIncludeItem = (item: RenderItem, viewMode: TranscriptViewMode): boolean => {
  if (viewMode === "all") {
    return true;
  }
  if (viewMode === "messages") {
    return item.kind === "message";
  }
  if (viewMode === "changes") {
    return item.kind === "event" && item.event.eventType === "file_change_summary";
  }
  return item.kind !== "message";
};

const fileStatusLabel = (status: TranscriptChangeFile["status"]): string => {
  if (status === "added") {
    return "新增";
  }
  if (status === "deleted") {
    return "删除";
  }
  return "修改";
};

const toolStepBadge = (event: TranscriptEvent): string =>
  event.title.includes("返回结果") ? "返回" : "调用";

const emptyCopy = (viewMode: TranscriptViewMode): string => {
  if (viewMode === "messages") {
    return "当前线程暂无可展示的消息。";
  }
  if (viewMode === "process") {
    return "当前线程暂无可展示的过程事件。";
  }
  if (viewMode === "changes") {
    return "当前线程暂无代码改动摘要。";
  }
  return "暂无会话消息，发送第一条 prompt 开始。";
};

export default function ProjectTranscriptView({
  transcript,
  renderedMessages,
  activeAssistantMessageId,
  thinkingPhase,
  showInlinePendingAssistant,
  turnSummaryMeta,
  lastTurnSummary,
  filteredThreadsCount,
  transcriptSubtitle,
  onOpenHistory,
  formatTime,
  formatDuration,
  transcriptRef,
}: Props) {
  const [viewMode, setViewMode] = useState<TranscriptViewMode>("all");

  const turnGroups = useMemo(() => {
    const baseItems = buildRenderItems(transcript, renderedMessages);
    const grouped = buildTurnGroups(baseItems);

    return grouped
      .map((group) => {
        const completionEvent = [...group.items]
          .reverse()
          .find(isCompletedTurnState) ?? null;
        const hasAssistantReply = group.items.some(isAssistantMessageItem);
        const visibleCoreItems = group.items.filter(
          (item) => !isCompletedTurnState(item),
        );
        const filteredItems = visibleCoreItems.filter((item) =>
          shouldIncludeItem(item, viewMode),
        );
        const collapsedItems = collapseContinuousToolSteps(filteredItems);
        const showFooter =
          completionEvent !== null && (viewMode === "all" || viewMode === "process");

        return {
          ...group,
          hasAssistantReply,
          completionEvent,
          items: collapsedItems,
          showFooter,
        };
      })
      .filter((group) => group.items.length > 0 || group.showFooter);
  }, [transcript, renderedMessages, viewMode]);

  return (
    <article
      id="project-transcript-shell"
      className="panel terminal-shell mc-transcript-stage"
    >
      <div className="terminal-head mc-transcript-head">
        <span>project transcript</span>
        <button
          type="button"
          className="mc-button ghost mc-transcript-drawer-trigger js-tour-history-entry"
          onClick={onOpenHistory}
        >
          查看会话栏
          <span className="mc-transcript-drawer-count code">
            {filteredThreadsCount}
          </span>
        </button>
      </div>
      <div className="terminal-subhead">{transcriptSubtitle}</div>
      <div className="mc-transcript-toolbar">
        <div className="mc-transcript-view-tabs">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`mc-transcript-view-tab ${viewMode === tab.value ? "active" : ""}`}
              onClick={() => setViewMode(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mc-transcript-contextbar">
        <span className="mc-transcript-context-pill">
          <span className="mc-transcript-context-label">project</span>
          <span className="mc-transcript-context-value code">
            {transcript?.context.project.slug ?? "-"}
          </span>
        </span>
        <span className="mc-transcript-context-pill">
          <span className="mc-transcript-context-label">thread</span>
          <span className="mc-transcript-context-value code">
            {transcript?.context.thread.id ?? "new"}
          </span>
        </span>
        <span className="mc-transcript-context-pill">
          <span className="mc-transcript-context-label">turn</span>
          <span className="mc-transcript-context-value">
            {transcript?.context.runtime.turnStatus ?? "idle"}
          </span>
        </span>
        <span className="mc-transcript-context-pill">
          <span className="mc-transcript-context-label">agent</span>
          <span className="mc-transcript-context-value">
            {transcript?.context.runtime.agentStatus ?? "idle"}
          </span>
        </span>
        <span className="mc-transcript-context-pill">
          <span className="mc-transcript-context-label">next</span>
          <span className="mc-transcript-context-value">
            {transcript?.context.runtime.waitingForUser
              ? "等你继续"
              : transcript?.context.runtime.isRunning
                ? "执行中"
                : "待命"}
          </span>
        </span>
        <span className="mc-transcript-context-pill">
          <span className="mc-transcript-context-label">updated</span>
          <span className="mc-transcript-context-value code">
            {transcript ? formatTime(transcript.context.runtime.updatedAt) : "-"}
          </span>
        </span>
      </div>
      <div className="terminal-transcript mc-transcript-primary" ref={transcriptRef}>
        {thinkingPhase ? (
          <div
            className={`terminal-thinking-panel ${thinkingPhase.compact ? "compact" : ""}`}
            aria-live="polite"
            aria-busy="true"
          >
            <div className="terminal-thinking-head">
              <span className="terminal-thinking-chip">{thinkingPhase.chip}</span>
              <span className="terminal-thinking-title">{thinkingPhase.title}</span>
            </div>
            <div className="terminal-thinking-detail">{thinkingPhase.detail}</div>
            {!thinkingPhase.compact ? (
              <div className="terminal-thinking-bars" aria-hidden="true">
                <span className="terminal-thinking-bar" />
                <span className="terminal-thinking-bar mid" />
                <span className="terminal-thinking-bar short" />
              </div>
            ) : null}
          </div>
        ) : null}
        {turnGroups.length === 0 ? (
          <div className="terminal-empty">{emptyCopy(viewMode)}</div>
        ) : null}
        {turnGroups.map((group, index) => (
          <div key={`${group.turnKey}:${group.anchorTimestamp}:${index}`}>
            <div className="terminal-turn-separator">
              <span className="terminal-turn-tag">
                turn {String(index + 1).padStart(2, "0")}
              </span>
              <span className="terminal-turn-rule" />
            </div>
            {group.items.map((item) => {
              if (item.kind === "message") {
                const isStreamingAssistant =
                  item.message.messageId === activeAssistantMessageId;
                return (
                  <div
                    key={item.key}
                    className={`terminal-row ${item.message.role} ${isStreamingAssistant ? "streaming" : ""}`}
                  >
                    <div className="terminal-prefix">
                      {item.message.role === "user" ? "you >" : "codex >"}
                      <span className="terminal-time">
                        {formatTime(item.message.timestamp)}
                      </span>
                    </div>
                    <pre
                      className={`terminal-bubble ${item.message.role} ${isStreamingAssistant ? "streaming" : ""}`}
                    >
                      {item.message.text}
                      {isStreamingAssistant ? <span className="terminal-cursor" /> : null}
                    </pre>
                    <div className="terminal-footnote">
                      <span>{item.message.eventType}</span>
                      <span>{item.message.status ?? "-"}</span>
                    </div>
                  </div>
                );
              }

              if (item.kind === "tool_group") {
                return (
                  <div key={item.key} className="mc-transcript-event-card tool mc-transcript-tool-group">
                    <div className="mc-transcript-event-head">
                      <span className="mc-transcript-event-chip">Tool Chain</span>
                      <span className="mc-transcript-event-title">连续工具步骤已聚合</span>
                      <span className="mc-transcript-event-time code">
                        {formatTime(item.timestamp)}
                      </span>
                    </div>
                    <div className="mc-transcript-event-summary">
                      Codex 在这一段连续执行了 {item.events.length} 个工具相关步骤，已折叠为一组展示。
                    </div>
                    <div className="mc-transcript-tool-group-head">
                      <span className="mc-transcript-tool-group-count code">
                        {item.events.length} steps
                      </span>
                      <span className="mc-transcript-state-pill">
                        {formatTime(item.events[0]?.timestamp ?? item.timestamp)} {"->"} {formatTime(item.events[item.events.length - 1]?.timestamp ?? item.timestamp)}
                      </span>
                    </div>
                    <div className="mc-transcript-tool-steps">
                      {item.events.map((event, toolIndex) => (
                        <div key={`${event.eventId}:${toolIndex}`} className="mc-transcript-tool-step-row">
                          <span className="mc-transcript-tool-step-badge">
                            {toolStepBadge(event)} {toolIndex + 1}
                          </span>
                          <div className="mc-transcript-tool-step-copy">
                            <div className="mc-transcript-tool-step-title">
                              {event.title}
                            </div>
                            <div className="mc-transcript-tool-step-summary">
                              {event.summary}
                            </div>
                          </div>
                          <span className="mc-transcript-tool-step-time code">
                            {formatTime(event.timestamp)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="terminal-footnote">
                      <span>tool_step_group</span>
                      <span>{item.events[item.events.length - 1]?.status ?? "-"}</span>
                    </div>
                  </div>
                );
              }

              const tone = eventTone(item.event.eventType);
              const stateMeta =
                item.event.eventType === "turn_state"
                  ? turnStateMeta(item.event)
                  : null;
              const diffLineStats = item.changeSummary
                ? sumLineChanges(item.changeSummary.files)
                : null;
              const diffGroups = item.changeSummary
                ? groupDiffFiles(item.changeSummary.files)
                : [];
              const diffKinds = item.changeSummary
                ? buildKindSummary(item.changeSummary.files)
                : [];

              return (
                <div
                  key={item.key}
                  className={`mc-transcript-event-card ${tone} ${eventStatusClass(item.event)}`}
                >
                  <div className="mc-transcript-event-head">
                    <span className="mc-transcript-event-chip">
                      {stateMeta ? stateMeta.chip : eventLabel(item.event.eventType)}
                    </span>
                    <span className="mc-transcript-event-title">
                      {stateMeta ? stateMeta.title : item.event.title}
                    </span>
                    <span className="mc-transcript-event-time code">
                      {formatTime(item.event.timestamp)}
                    </span>
                  </div>
                  <div className="mc-transcript-event-summary">
                    {stateMeta ? stateMeta.detail : item.event.summary}
                  </div>
                  {stateMeta ? (
                    <div className="mc-transcript-state-bar">
                      <span className="mc-transcript-state-pill">
                        status {item.event.status ?? "-"}
                      </span>
                      <span className="mc-transcript-state-pill code">
                        turn {item.event.turnId ?? "-"}
                      </span>
                    </div>
                  ) : null}
                  {item.changeSummary ? (
                    <div className="mc-transcript-diff-card">
                      <div className="mc-transcript-diff-meta">
                        <span>{item.changeSummary.summary}</span>
                        <span>
                          {item.changeSummary.stats.modified} modified / {item.changeSummary.stats.added} added / {item.changeSummary.stats.deleted} deleted
                        </span>
                      </div>
                      <div className="mc-transcript-diff-stats">
                        <div className="mc-transcript-diff-stat">
                          <strong>{item.changeSummary.files.length}</strong>
                          <span>文件</span>
                        </div>
                        <div className="mc-transcript-diff-stat positive">
                          <strong>+{diffLineStats?.additions ?? 0}</strong>
                          <span>新增行</span>
                        </div>
                        <div className="mc-transcript-diff-stat negative">
                          <strong>-{diffLineStats?.deletions ?? 0}</strong>
                          <span>删除行</span>
                        </div>
                      </div>
                      {diffKinds.length > 0 ? (
                        <div className="mc-transcript-diff-kinds">
                          {diffKinds.map((itemLabel) => (
                            <span key={itemLabel} className="mc-transcript-diff-kind-pill">
                              {itemLabel}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mc-transcript-diff-files">
                        {diffGroups.map((groupItem) => (
                          <section key={`${item.key}:${groupItem.key}`} className="mc-transcript-diff-group">
                            <div className="mc-transcript-diff-group-head">
                              <span className="mc-transcript-diff-group-chip">{groupItem.chip}</span>
                              <span className="mc-transcript-diff-group-title">{groupItem.label}</span>
                              <span className="mc-transcript-diff-group-count code">{groupItem.files.length}</span>
                            </div>
                            <div className="mc-transcript-diff-files">
                              {groupItem.files.map((file) => (
                                <details key={`${item.key}:${file.path}`} className="mc-transcript-diff-file">
                                  <summary>
                                    <div className="mc-transcript-diff-file-main">
                                      <span className={`mc-transcript-file-status ${file.status}`}>
                                        {fileStatusLabel(file.status)}
                                      </span>
                                      <span className="code">{file.path}</span>
                                    </div>
                                    <div className="mc-transcript-diff-file-side">
                                      <span className="mc-transcript-file-kind">{fileKind(file.path)}</span>
                                      <span>{file.summary}</span>
                                    </div>
                                  </summary>
                                  {file.patchPreview ? (
                                    <pre className="mc-transcript-diff-preview code">
                                      {file.patchPreview}
                                    </pre>
                                  ) : (
                                    <div className="mc-transcript-diff-empty">暂无补丁预览。</div>
                                  )}
                                </details>
                              ))}
                            </div>
                          </section>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="terminal-footnote">
                    <span>{item.event.eventType}</span>
                    <span>{item.event.status ?? "-"}</span>
                  </div>
                </div>
              );
            })}
            {group.showFooter && group.completionEvent ? (
              <div className="mc-transcript-turn-footer">
                <div className="mc-transcript-turn-footer-head">
                  <span className="mc-transcript-turn-footer-chip">完成</span>
                  <span className="mc-transcript-turn-footer-title">
                    {group.hasAssistantReply ? "回答已生成，等待你的下一步" : "本轮已结束"}
                  </span>
                  <span className="mc-transcript-turn-footer-time code">
                    {formatTime(group.completionEvent.event.timestamp)}
                  </span>
                </div>
                <div className="mc-transcript-turn-footer-copy">
                  {group.hasAssistantReply
                    ? "Codex 已完成本轮并给出回复，这一轮可以继续直接追问。"
                    : group.completionEvent.event.summary}
                </div>
              </div>
            ) : null}
          </div>
        ))}
        {showInlinePendingAssistant ? (
          <div className="terminal-row assistant pending">
            <div className="terminal-prefix">
              <span>{"codex >"}</span>
              <span className="terminal-time">等待本轮输出</span>
            </div>
            <div className="terminal-bubble assistant pending">
              <span className="terminal-pending-line long" />
              <span className="terminal-pending-line mid" />
              <span className="terminal-pending-line short" />
            </div>
            <div className="terminal-footnote">
              <span>{thinkingPhase?.title ?? "思考中"}</span>
              <span>running</span>
            </div>
          </div>
        ) : null}
        {turnSummaryMeta && !thinkingPhase ? (
          <div className={`terminal-turn-summary ${turnSummaryMeta.tone}`}>
            <div className="terminal-turn-summary-head">
              <span className="terminal-turn-summary-chip">{turnSummaryMeta.chip}</span>
              <span className="terminal-turn-summary-title">{turnSummaryMeta.label}</span>
            </div>
            <div className="terminal-turn-summary-meta">
              <span>完成于 {formatTime(lastTurnSummary?.finishedAt ?? "")}</span>
              <span>用时 {formatDuration(lastTurnSummary?.durationMs)}</span>
              <span>exit {lastTurnSummary?.exitCode ?? "-"}</span>
              <span>thread {lastTurnSummary?.threadId ?? "new"}</span>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
