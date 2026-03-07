import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AgentState, NormalizedEvent } from "./types.js";

const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const inferStatus = (type: string, payload: Record<string, unknown>): string | undefined => {
  if (type.includes("error")) {
    return "failed";
  }
  if (type.includes("completed")) {
    return "completed";
  }
  if (type.includes("started")) {
    return "running";
  }

  const payloadStatus = payload.status;
  return typeof payloadStatus === "string" ? payloadStatus : undefined;
};

const getSessionIdFromPath = (filePath: string): string => {
  const base = basename(filePath, ".jsonl");
  const matched = base.match(SESSION_ID_PATTERN)?.[1];
  return matched ?? base;
};

const buildEventId = (filePath: string, lineNo: number, rawType: string, timestamp: string): string => {
  return createHash("sha1")
    .update(`${filePath}:${lineNo}:${rawType}:${timestamp}`)
    .digest("hex");
};

const extractMessageText = (payloadObj: Record<string, unknown>): string | undefined => {
  const textParts: string[] = [];

  const append = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) {
      textParts.push(value.trim());
    }
  };

  append(payloadObj.text);
  append(payloadObj.input_text);
  append(payloadObj.output_text);
  append(payloadObj.message);
  append(payloadObj.summary);

  const content = payloadObj.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") {
        append(item);
        continue;
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        append(obj.text);
        append(obj.input_text);
        append(obj.output_text);
      }
    }
  }

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("\n").slice(0, 4000);
};

const normalizeLine = (
  filePath: string,
  lineNo: number,
  line: string
): NormalizedEvent | null => {
  if (!line.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const raw = parsed as Record<string, unknown>;
  const rawType = typeof raw.type === "string" ? raw.type : "unknown";
  const payload = raw.payload;
  const payloadObj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const item = raw.item;
  const itemObj = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const sourceObj = Object.keys(payloadObj).length > 0 ? payloadObj : itemObj;
  const payloadType = typeof sourceObj.type === "string" ? sourceObj.type : undefined;
  const type = payloadType ? `${rawType}.${payloadType}` : rawType;
  const timestampRaw =
    (typeof raw.timestamp === "string" && raw.timestamp) ||
    (typeof raw.event_ts === "string" && raw.event_ts) ||
    new Date().toISOString();

  const threadId =
    (typeof sourceObj.thread_id === "string" && sourceObj.thread_id) ||
    (typeof sourceObj.threadId === "string" && sourceObj.threadId) ||
    (typeof sourceObj.id === "string" && sourceObj.id) ||
    (typeof raw.thread_id === "string" && raw.thread_id) ||
    (typeof raw.threadId === "string" && raw.threadId) ||
    getSessionIdFromPath(filePath);

  const turnId =
    (typeof sourceObj.turn_id === "string" && sourceObj.turn_id) ||
    (typeof sourceObj.turnId === "string" && sourceObj.turnId) ||
    (typeof raw.turn_id === "string" && raw.turn_id) ||
    (typeof raw.turnId === "string" && raw.turnId) ||
    undefined;

  const title =
    (typeof sourceObj.title === "string" && sourceObj.title) ||
    (typeof sourceObj.summary === "string" && sourceObj.summary) ||
    (typeof raw.title === "string" && raw.title) ||
    undefined;

  const role =
    (typeof sourceObj.role === "string" && sourceObj.role) ||
    (payloadType === "user_message" ? "user" : undefined) ||
    (type.includes("agent_message") ? "assistant" : undefined);
  const messageText = extractMessageText(sourceObj);

  const errorMessage =
    (typeof sourceObj.errorMessage === "string" && sourceObj.errorMessage) ||
    (typeof (sourceObj.error as Record<string, unknown> | undefined)?.message === "string" &&
      ((sourceObj.error as Record<string, unknown>).message as string)) ||
    (typeof (raw.error as Record<string, unknown> | undefined)?.message === "string" &&
      ((raw.error as Record<string, unknown>).message as string)) ||
    undefined;

  return {
    eventId: buildEventId(filePath, lineNo, rawType, timestampRaw),
    threadId,
    turnId,
    type,
    status: inferStatus(type, payloadObj),
    title,
    errorMessage,
    timestamp: timestampRaw,
    payload: {
      source_file: filePath,
      source_line: lineNo,
      raw_type: rawType,
      payload_type: payloadType ?? null,
      payload_keys: Object.keys(sourceObj).slice(0, 20),
      role: role ?? null,
      message_text: messageText ?? null
    }
  };
};

export const listRecentJsonlFiles = async (rootPath: string, maxFiles: number): Promise<string[]> => {
  const queue: string[] = [rootPath];
  const files: Array<{ path: string; mtime: number }> = [];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      break;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile() && extname(entry.name) === ".jsonl") {
        const info = await stat(fullPath);
        files.push({ path: fullPath, mtime: info.mtimeMs });
      }
    }
  }

  return files
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, maxFiles)
    .map((item) => item.path);
};

export const collectIncrementalEvents = async (
  files: string[],
  state: AgentState
): Promise<{ nextState: AgentState; events: NormalizedEvent[] }> => {
  const nextOffsets: Record<string, number> = {};
  const events: NormalizedEvent[] = [];

  for (const filePath of files) {
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const previous = state.offsets[filePath] ?? 0;
    const start = previous > lines.length ? 0 : previous;

    for (let index = start; index < lines.length; index += 1) {
      const event = normalizeLine(filePath, index + 1, lines[index] ?? "");
      if (event) {
        events.push(event);
      }
    }

    nextOffsets[filePath] = lines.length;
  }

  return {
    nextState: { offsets: nextOffsets },
    events
  };
};
