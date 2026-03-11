import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PATCH_PREVIEW_LIMIT = 1600;
const FILE_SUMMARY_LIMIT = 12;

type EventRow = {
  event_id: string;
  thread_id: string;
  turn_id: string | null;
  event_type: string;
  status: string | null;
  title: string | null;
  error_message: string | null;
  payload_json: Record<string, unknown>;
  event_ts: string;
};

type TurnRow = {
  turn_id: string;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  error_message: string | null;
};

type ThreadContextRow = {
  thread_id: string;
  project_slug: string;
  project_name: string;
  project_status: string;
  title: string | null;
  status: string | null;
  started_at: string | null;
  updated_at: string;
  last_turn_id: string | null;
};

export type TranscriptEventType =
  | "user_message"
  | "assistant_message"
  | "reasoning_step"
  | "tool_step"
  | "command_step"
  | "file_change_summary"
  | "turn_state"
  | "error";

export type TranscriptMessage = {
  messageId: string;
  turnId: string | null;
  eventType: string;
  role: "user" | "assistant";
  text: string;
  status: string | null;
  timestamp: string;
};

export type TranscriptChangeFile = {
  path: string;
  name: string;
  status: "added" | "modified" | "deleted";
  additions: number | null;
  deletions: number | null;
  summary: string;
  patchPreview: string | null;
};

export type TranscriptChangeSummary = {
  eventId: string;
  threadId: string;
  turnId: string | null;
  timestamp: string;
  status: string | null;
  title: string;
  summary: string;
  stats: {
    added: number;
    modified: number;
    deleted: number;
  };
  files: TranscriptChangeFile[];
};

export type TranscriptEvent = {
  eventId: string;
  threadId: string;
  turnId: string | null;
  eventType: TranscriptEventType;
  title: string;
  summary: string;
  status: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
};

export type TranscriptTurn = {
  turnId: string;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  errorMessage: string | null;
  itemCount: number;
  messageCount: number;
};

export type TranscriptContext = {
  project: {
    slug: string;
    name: string;
    status: string;
  };
  thread: {
    id: string;
    title: string | null;
    status: string | null;
    startedAt: string | null;
    updatedAt: string;
    lastTurnId: string | null;
  };
  runtime: {
    turnId: string | null;
    turnStatus: string | null;
    agentStatus: "running" | "idle";
    activeAgentCount: number;
    activeTaskCount: number;
    isRunning: boolean;
    waitingForUser: boolean;
    updatedAt: string;
  };
};

export type ThreadTranscript = {
  context: TranscriptContext;
  turns: TranscriptTurn[];
  events: TranscriptEvent[];
  messages: TranscriptMessage[];
  changeSummaries: TranscriptChangeSummary[];
};

const toText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const previewText = (value: string | null, limit = 240): string => {
  if (!value) {
    return "";
  }
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
};

const firstString = (
  payload: Record<string, unknown>,
  keys: string[],
): string | null => {
  for (const key of keys) {
    const direct = toText(payload[key]);
    if (direct) {
      return direct;
    }
    const nested = payload[key];
    if (Array.isArray(nested)) {
      const joined = nested
        .map((item) => (typeof item === "string" ? item : ""))
        .join(" ")
        .trim();
      if (joined) {
        return joined;
      }
    }
  }
  return null;
};

const normalizeMessageRole = (row: EventRow): "user" | "assistant" | null => {
  const payloadRole = toText(row.payload_json.role);
  if (payloadRole === "user" || payloadRole === "assistant") {
    return payloadRole;
  }
  if (row.event_type.includes("user")) {
    return "user";
  }
  if (
    row.event_type.includes("assistant") ||
    row.event_type.includes("agent") ||
    row.event_type.includes("message")
  ) {
    return "assistant";
  }
  return null;
};

export const toTranscriptMessage = (row: EventRow): TranscriptMessage | null => {
  const role = normalizeMessageRole(row);
  if (!role) {
    return null;
  }
  const text =
    firstString(row.payload_json, ["message_text", "text", "content"]) ??
    toText(row.title) ??
    toText(row.error_message);
  if (!text) {
    return null;
  }
  if (
    role === "user" &&
    (text.includes("AGENTS.md instructions for") || text.includes("<INSTRUCTIONS>"))
  ) {
    return null;
  }
  return {
    messageId: row.event_id,
    turnId: row.turn_id,
    eventType: row.event_type,
    role,
    text,
    status: row.status,
    timestamp: row.event_ts,
  };
};

const normalizeCommand = (payload: Record<string, unknown>): string | null => {
  const direct = firstString(payload, ["command", "cmd", "shellCommand", "input"]);
  if (direct) {
    return direct;
  }
  if (Array.isArray(payload.command)) {
    const joined = payload.command
      .map((item) => (typeof item === "string" ? item : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    return joined || null;
  }
  return null;
};

const normalizeToolName = (payload: Record<string, unknown>): string | null =>
  firstString(payload, ["tool", "tool_name", "name", "function_name"]);

const normalizeStepSummary = (
  row: EventRow,
  fallback: string,
): string => {
  return (
    firstString(row.payload_json, [
      "summary",
      "detail",
      "message_text",
      "message",
      "text",
      "output_preview",
      "output",
      "reasoning",
      "content",
    ]) ??
    toText(row.title) ??
    toText(row.error_message) ??
    fallback
  );
};

export const toTranscriptEvent = (row: EventRow): TranscriptEvent | null => {
  const payload = row.payload_json ?? {};
  const type = row.event_type.toLowerCase();

  if (type.includes("token_count")) {
    return null;
  }

  if (
    type === "event_msg.user_prompt" ||
    (type.includes("user") && !type.includes("error"))
  ) {
    const text = normalizeStepSummary(row, "用户发起了一条新指令。");
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "user_message",
      title: "你发起了新一轮指令",
      summary: text,
      status: row.status,
      timestamp: row.event_ts,
      payload,
    };
  }

  if (
    type === "event_msg.agent_message" ||
    type === "response_item.message" ||
    type.includes("assistant")
  ) {
    const text = normalizeStepSummary(row, "Codex 产出了一条回复。");
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "assistant_message",
      title: "Codex 回复",
      summary: text,
      status: row.status,
      timestamp: row.event_ts,
      payload,
    };
  }

  if (type.includes("reasoning")) {
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "reasoning_step",
      title: toText(row.title) ?? "模型正在分析",
      summary: normalizeStepSummary(row, "Codex 正在推理当前任务。"),
      status: row.status,
      timestamp: row.event_ts,
      payload,
    };
  }

  if (type.includes("command")) {
    const command = normalizeCommand(payload);
    const status = row.status ?? (type.includes("completed") ? "completed" : "running");
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "command_step",
      title: command ? `执行命令 ${command}` : toText(row.title) ?? "执行命令",
      summary: normalizeStepSummary(
        row,
        command ? `Codex 正在执行命令 ${command}` : "Codex 正在执行命令。",
      ),
      status,
      timestamp: row.event_ts,
      payload,
    };
  }

  if (type.includes("function_call") || type.includes("tool_step") || type.includes("tool")) {
    const toolName = normalizeToolName(payload);
    const payloadType = toText(payload.payload_type) ?? toText(payload.type);
    const isToolOutput = payloadType === "function_call_output" || type.includes("function_call_output");
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "tool_step",
      title: isToolOutput
        ? toolName
          ? `工具 ${toolName} 返回结果`
          : toText(row.title) ?? "工具返回结果"
        : toolName
          ? `调用工具 ${toolName}`
          : toText(row.title) ?? "工具步骤",
      summary: normalizeStepSummary(
        row,
        isToolOutput
          ? toolName
            ? `工具 ${toolName} 已返回结果。`
            : "工具步骤已返回结果。"
          : toolName
            ? `Codex 正在执行工具 ${toolName}`
            : "Codex 正在执行工具步骤。",
      ),
      status: row.status,
      timestamp: row.event_ts,
      payload,
    };
  }

  if (type.includes("change_summary")) {
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "file_change_summary",
      title: toText(row.title) ?? "本轮改动摘要",
      summary: normalizeStepSummary(row, "Codex 产生了文件改动。"),
      status: row.status,
      timestamp: row.event_ts,
      payload,
    };
  }

  if (type.includes("turn_started")) {
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "turn_state",
      title: toText(row.title) ?? "本轮执行已开始",
      summary: normalizeStepSummary(row, "Codex 已接管这一轮任务，开始分析并执行。"),
      status: row.status ?? "running",
      timestamp: row.event_ts,
      payload,
    };
  }

  if (type.includes("turn_completed") || type.includes("task_complete")) {
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "turn_state",
      title: toText(row.title) ?? "本轮执行完成",
      summary: normalizeStepSummary(row, "Codex 已完成这一轮执行，等待你的下一步指令。"),
      status: row.status ?? "completed",
      timestamp: row.event_ts,
      payload,
    };
  }

  if (type.includes("error") || type.includes("failed")) {
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventType: "error",
      title: toText(row.title) ?? "本轮执行异常",
      summary: normalizeStepSummary(row, "Codex 在本轮执行中遇到了异常。"),
      status: row.status ?? "failed",
      timestamp: row.event_ts,
      payload,
    };
  }

  return null;
};

const normalizeFileStatus = (code: string): "added" | "modified" | "deleted" => {
  if (code === "??" || code.includes("A")) {
    return "added";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  return "modified";
};

const extractPathFromStatusLine = (rawPath: string): string => {
  if (rawPath.includes("->")) {
    return rawPath.split("->").pop()?.trim() ?? rawPath.trim();
  }
  return rawPath.trim();
};

const parsePatchSections = (patchText: string): Map<string, string> => {
  const sections = new Map<string, string>();
  const matches = patchText.matchAll(/diff --git a\/(.*?) b\/.*?\n([\s\S]*?)(?=^diff --git a\/|\Z)/gm);
  for (const match of matches) {
    const path = match[1]?.trim();
    const body = match[0]?.trim() ?? "";
    if (!path || !body) {
      continue;
    }
    sections.set(path, previewText(body, PATCH_PREVIEW_LIMIT));
  }
  return sections;
};

export const buildGitChangeSummary = async (
  projectPath: string,
  threadId: string,
  turnId?: string | null,
): Promise<TranscriptChangeSummary | null> => {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectPath,
      encoding: "utf8",
    });
  } catch {
    return null;
  }

  const [statusResult, numstatResult, patchResult] = await Promise.all([
    execFileAsync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: projectPath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4,
    }).catch(() => ({ stdout: "" })),
    execFileAsync("git", ["diff", "--numstat", "--no-ext-diff", "--", "."], {
      cwd: projectPath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4,
    }).catch(() => ({ stdout: "" })),
    execFileAsync("git", ["diff", "--patch", "--unified=1", "--no-ext-diff", "--", "."], {
      cwd: projectPath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
    }).catch(() => ({ stdout: "" })),
  ]);

  const statusLines = statusResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (statusLines.length === 0) {
    return null;
  }

  const numstatMap = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of numstatResult.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").trim();
    if (!path) {
      continue;
    }
    numstatMap.set(path, {
      additions: addedRaw === "-" ? null : Number(addedRaw),
      deletions: deletedRaw === "-" ? null : Number(deletedRaw),
    });
  }

  const patchSections = parsePatchSections(patchResult.stdout);
  const files: TranscriptChangeFile[] = [];
  const stats = { added: 0, modified: 0, deleted: 0 };

  for (const line of statusLines.slice(0, FILE_SUMMARY_LIMIT)) {
    const code = line.slice(0, 2);
    const path = extractPathFromStatusLine(line.slice(3));
    const status = normalizeFileStatus(code);
    const counts = numstatMap.get(path) ?? { additions: null, deletions: null };
    stats[status] += 1;
    files.push({
      path,
      name: basename(path),
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      summary: `${status} · ${basename(path)}`,
      patchPreview:
        patchSections.get(path) ??
        (status === "added" && code === "??" ? "未跟踪的新文件。" : null),
    });
  }

  for (const line of statusLines.slice(FILE_SUMMARY_LIMIT)) {
    const status = normalizeFileStatus(line.slice(0, 2));
    stats[status] += 1;
  }

  const totalFiles = stats.added + stats.modified + stats.deleted;
  if (totalFiles === 0) {
    return null;
  }

  const summaryParts = [
    stats.modified > 0 ? `${stats.modified} modified` : null,
    stats.added > 0 ? `${stats.added} added` : null,
    stats.deleted > 0 ? `${stats.deleted} deleted` : null,
  ].filter((part): part is string => Boolean(part));

  const timestamp = new Date().toISOString();
  return {
    eventId: `${turnId ?? threadId}:change-summary`,
    threadId,
    turnId: turnId ?? null,
    timestamp,
    status: "completed",
    title: `本轮改动 ${totalFiles} 个文件`,
    summary: summaryParts.join(" · "),
    stats,
    files,
  };
};

export const toTranscriptChangeSummary = (
  row: EventRow,
): TranscriptChangeSummary | null => {
  if (!row.event_type.toLowerCase().includes("change_summary")) {
    return null;
  }
  const payload = row.payload_json ?? {};
  const statsRaw = payload.stats && typeof payload.stats === "object" ? (payload.stats as Record<string, unknown>) : {};
  const filesRaw = Array.isArray(payload.files) ? payload.files : [];
  const files: TranscriptChangeFile[] = filesRaw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const path = toText(record.path);
      if (!path) {
        return null;
      }
      const statusRaw = toText(record.status) ?? "modified";
      const status = ["added", "modified", "deleted"].includes(statusRaw)
        ? (statusRaw as TranscriptChangeFile["status"])
        : "modified";
      return {
        path,
        name: toText(record.name) ?? basename(path),
        status,
        additions: typeof record.additions === "number" ? record.additions : null,
        deletions: typeof record.deletions === "number" ? record.deletions : null,
        summary: toText(record.summary) ?? `${status} · ${basename(path)}`,
        patchPreview: toText(record.patchPreview),
      };
    })
    .filter((item): item is TranscriptChangeFile => item !== null);
  return {
    eventId: row.event_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    timestamp: row.event_ts,
    status: row.status,
    title: toText(row.title) ?? "本轮改动摘要",
    summary: firstString(payload, ["summary"]) ?? "Codex 产生了代码改动。",
    stats: {
      added: typeof statsRaw.added === "number" ? statsRaw.added : 0,
      modified: typeof statsRaw.modified === "number" ? statsRaw.modified : 0,
      deleted: typeof statsRaw.deleted === "number" ? statsRaw.deleted : 0,
    },
    files,
  };
};

const normalizeComparableText = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

const timeBucket = (timestamp: string, bucketMs = 2000): number => {
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) {
    return 0;
  }
  return Math.floor(ts / bucketMs);
};

const transcriptMessagePreference = (message: TranscriptMessage): number => {
  if (message.eventType === "response_item.message") {
    return 3;
  }
  if (message.eventType === "event_msg.agent_message") {
    return 2;
  }
  return 1;
};

const transcriptEventPreference = (event: TranscriptEvent): number => {
  const payloadType = toText(event.payload.payload_type);
  const rawType = toText(event.payload.raw_type);
  if (event.eventType === "assistant_message") {
    if (payloadType === "message" || rawType === "response_item") {
      return 4;
    }
    return 2;
  }
  if (event.eventType === "turn_state") {
    if (payloadType === "turn_completed") {
      return 4;
    }
    if (payloadType === "task_complete") {
      return 2;
    }
    if ((event.status ?? "").toLowerCase() === "running") {
      return 3;
    }
  }
  if (event.eventType === "tool_step") {
    if (payloadType === "function_call_output") {
      return 3;
    }
    if (payloadType === "function_call") {
      return 2;
    }
  }
  return 1;
};

export const dedupeTranscriptMessages = (
  messages: TranscriptMessage[],
): TranscriptMessage[] => {
  const best = new Map<string, TranscriptMessage>();
  for (const message of messages) {
    const key = [
      message.turnId ?? "-",
      message.role,
      normalizeComparableText(message.text),
      timeBucket(message.timestamp),
    ].join("|");
    const current = best.get(key);
    if (!current || transcriptMessagePreference(message) > transcriptMessagePreference(current)) {
      best.set(key, message);
    }
  }
  return [...best.values()].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
};

export const dedupeTranscriptEvents = (
  events: TranscriptEvent[],
): TranscriptEvent[] => {
  const best = new Map<string, TranscriptEvent>();
  for (const event of events) {
    const key = [
      event.turnId ?? "-",
      event.eventType,
      (event.status ?? "").toLowerCase(),
      normalizeComparableText(event.title),
      normalizeComparableText(event.summary),
      timeBucket(event.timestamp),
    ].join("|");
    const current = best.get(key);
    if (!current || transcriptEventPreference(event) > transcriptEventPreference(current)) {
      best.set(key, event);
    }
  }
  return [...best.values()].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
};

export const dedupeTranscriptChangeSummaries = (
  summaries: TranscriptChangeSummary[],
): TranscriptChangeSummary[] => {
  const best = new Map<string, TranscriptChangeSummary>();
  for (const summary of summaries) {
    const key = [
      summary.turnId ?? "-",
      normalizeComparableText(summary.summary),
      summary.files.length,
      timeBucket(summary.timestamp),
    ].join("|");
    const current = best.get(key);
    if (!current || summary.files.length > current.files.length) {
      best.set(key, summary);
    }
  }
  return [...best.values()].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
};

export const buildTranscriptTurns = (
  turns: TurnRow[],
  messages: TranscriptMessage[],
  events: TranscriptEvent[],
): TranscriptTurn[] => {
  return turns.map((turn) => ({
    turnId: turn.turn_id,
    status: turn.status,
    startedAt: turn.started_at,
    completedAt: turn.completed_at,
    updatedAt: turn.updated_at,
    errorMessage: turn.error_message,
    itemCount: events.filter((item) => item.turnId === turn.turn_id).length,
    messageCount: messages.filter((item) => item.turnId === turn.turn_id).length,
  }));
};

export const buildTranscriptContext = (args: {
  thread: ThreadContextRow;
  latestTurn: TurnRow | null;
  latestMessage: TranscriptMessage | null;
  activeAgentCount: number;
  activeTaskCount: number;
}): TranscriptContext => {
  const isRunning =
    (args.thread.status ?? "").toLowerCase() === "running" ||
    (args.latestTurn?.status ?? "").toLowerCase() === "running" ||
    args.activeTaskCount > 0;
  const waitingForUser =
    !isRunning &&
    args.latestMessage?.role === "assistant" &&
    Boolean(args.latestMessage.text.trim());
  return {
    project: {
      slug: args.thread.project_slug,
      name: args.thread.project_name,
      status: args.thread.project_status,
    },
    thread: {
      id: args.thread.thread_id,
      title: args.thread.title,
      status: args.thread.status,
      startedAt: args.thread.started_at,
      updatedAt: args.thread.updated_at,
      lastTurnId: args.thread.last_turn_id,
    },
    runtime: {
      turnId: args.latestTurn?.turn_id ?? args.thread.last_turn_id,
      turnStatus: args.latestTurn?.status ?? null,
      agentStatus: args.activeAgentCount > 0 ? "running" : "idle",
      activeAgentCount: args.activeAgentCount,
      activeTaskCount: args.activeTaskCount,
      isRunning,
      waitingForUser,
      updatedAt: args.latestTurn?.updated_at ?? args.thread.updated_at,
    },
  };
};
