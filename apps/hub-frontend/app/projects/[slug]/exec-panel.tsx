"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProjectTranscriptView from "./project-transcript-view";
import {
  cancelExecTask,
  describeAppError,
  fetchExecTasks,
  fetchProjectFileContexts,
  fetchProjectFileMatches,
  fetchThreads,
  fetchThreadTranscript,
  runProjectExec,
  streamProjectExec,
  type ExecStreamEvent,
  type ExecTask,
  type ProjectFileContext,
  type ProjectFileMatch,
  type Thread,
  type ThreadMessage,
  type ThreadTranscript,
} from "../../../lib/api";

type Props = {
  slug: string;
  sessionPanelMode?: "rail" | "drawer";
};

type ChatMessage = {
  messageId: string;
  turnId?: string | null;
  role: "user" | "assistant";
  text: string;
  status: string | null;
  eventType: string;
  timestamp: string;
};

type TurnSummary = {
  taskId: string | null;
  threadId: string | null;
  assistantMessageId: string | null;
  status: "completed" | "warning" | "failed" | "canceled";
  exitCode?: number;
  durationMs?: number;
  finishedAt: string;
};

type ThreadFilter = "all" | "running" | "recent";

type FileMentionState = {
  start: number;
  end: number;
  query: string;
  selectedIndex: number;
};

const MAX_CHAT_MESSAGES = 180;
const FILE_MENTION_LIMIT = 12;
const MAX_FILE_REFERENCE_COUNT = 6;

const historyKey = (slug: string): string => `codex_hub_prompt_history_${slug}`;
const threadKey = (slug: string): string => `codex_hub_active_thread_${slug}`;
const chatCacheKey = (slug: string): string => `codex_hub_chat_cache_${slug}`;
const sessionRailKey = (slug: string): string =>
  `codex_hub_session_rail_${slug}`;

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const formatDuration = (value?: number): string => {
  if (!value || value <= 0) {
    return "-";
  }
  if (value < 1000) {
    return `${value}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${(value / 60_000).toFixed(1)}m`;
};

const summarizeThreadLabel = (thread: Thread): string => {
  const source =
    thread.first_user_prompt?.trim() ||
    thread.title?.trim() ||
    thread.thread_id;
  const oneLine = source.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 42) {
    return oneLine;
  }
  return `${oneLine.slice(0, 42)}...`;
};

const shortType = (value: string): string =>
  value.replaceAll("_", " ").replaceAll(".", " ").replace(/\s+/g, " ").trim();

const appendChunk = (prev: string, chunk: string): string => {
  const next = `${prev}${chunk}`;
  if (next.length <= 16_000) {
    return next;
  }
  return next.slice(next.length - 16_000);
};

const trimMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.slice(-MAX_CHAT_MESSAGES);

const roleTextKey = (message: ChatMessage): string =>
  `${message.role}|${message.text.trim()}`;

const timeBucket = (timestamp: string): number => {
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) {
    return 0;
  }
  return Math.floor(ts / 2000);
};

const dedupeCanonicalMessages = (messages: ChatMessage[]): ChatMessage[] => {
  const sorted = [...messages].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const message of sorted) {
    const key = `${roleTextKey(message)}|${timeBucket(message.timestamp)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(message);
  }
  return trimMessages(out);
};

const mergeHydratedMessages = (
  previous: ChatMessage[],
  canonical: ChatMessage[],
): ChatMessage[] => {
  const canonicalDedupe = dedupeCanonicalMessages(canonical);
  const canonicalRoleText = new Set(
    canonicalDedupe.map((item) => roleTextKey(item)),
  );
  const keepLive = previous.filter(
    (item) =>
      (item.eventType.startsWith("live.") || item.status === "running") &&
      !canonicalRoleText.has(roleTextKey(item)),
  );
  const merged = [...canonicalDedupe, ...keepLive].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  return trimMessages(merged);
};

const toChatMessage = (item: ThreadMessage): ChatMessage | null => {
  if (item.role !== "user" && item.role !== "assistant") {
    return null;
  }
  return {
    messageId: item.messageId,
    turnId: item.turnId ?? null,
    role: item.role,
    text: item.text,
    status: item.status,
    eventType: item.eventType,
    timestamp: item.timestamp,
  };
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const collectReferencedPaths = (value: string): string[] => {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/(?:^|[\s([{])@([^\s@]+)/g)) {
    const filePath = match[1]?.trim();
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    ordered.push(filePath);
  }
  return ordered;
};

const getFileMentionAtCaret = (
  value: string,
  caret: number,
): { start: number; end: number; query: string } | null => {
  let pointer = Math.max(0, caret - 1);
  while (pointer >= 0) {
    const current = value[pointer] ?? "";
    if (current === "@") {
      break;
    }
    if (/\s/.test(current)) {
      return null;
    }
    pointer -= 1;
  }
  if (pointer < 0 || value[pointer] !== "@") {
    return null;
  }
  if (pointer > 0) {
    const previous = value[pointer - 1] ?? "";
    if (!/[\s([{]/.test(previous)) {
      return null;
    }
  }
  const query = value.slice(pointer + 1, caret);
  if (/\s/.test(query)) {
    return null;
  }
  return { start: pointer, end: caret, query };
};

const buildPromptWithReferencedFiles = (
  prompt: string,
  files: ProjectFileContext[],
): string => {
  if (files.length === 0) {
    return prompt;
  }
  const sections = [
    prompt,
    "",
    "[Referenced project files]",
    "Treat the following workspace files as authoritative context for this request.",
  ];
  for (const file of files) {
    if (file.binary) {
      sections.push(`FILE: ${file.path}
[binary file omitted from inline context]`);
      continue;
    }
    if (file.tooLarge) {
      sections.push(`FILE: ${file.path}
[file too large to inline automatically]`);
      continue;
    }
    sections.push(
      `FILE: ${file.path}${file.truncated ? " (truncated)" : ""}
\`\`\`
${file.content}
\`\`\``,
    );
  }
  return sections.join("\n\n");
};

const removeReferencedPath = (value: string, filePath: string): string =>
  value
    .replace(
      new RegExp(`(^|[\\s([{])@${escapeRegExp(filePath)}(?=$|\\s)`, "g"),
      (_match, prefix: string) => prefix,
    )
    .replace(/[ 	]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();

const buildPromptWithContext = (
  prompt: string,
  messages: ChatMessage[],
): string => {
  const tail = messages.slice(-8);
  if (tail.length === 0) {
    return prompt;
  }
  const lines: string[] = [];
  for (const item of tail) {
    const prefix = item.role === "user" ? "User" : "Assistant";
    const compactText = item.text.trim().slice(0, 1000);
    lines.push(`${prefix}: ${compactText}`);
  }
  lines.push(`Current User: ${prompt}`);
  lines.push("请基于以上历史上下文继续。");
  return lines.join("\n");
};

const upsertAssistantDelta = (
  messages: ChatMessage[],
  messageId: string,
  delta: string,
  timestamp: string,
  turnId?: string | null,
): ChatMessage[] => {
  const idx = messages.findIndex((item) => item.messageId === messageId);
  if (idx < 0) {
    return trimMessages([
      ...messages,
      {
        messageId,
        role: "assistant",
        text: delta,
        status: "running",
        eventType: "live.agent_message.delta",
        timestamp,
        turnId: turnId ?? null,
      },
    ]);
  }

  const next = [...messages];
  const current = next[idx];
  next[idx] = {
    ...current,
    text: `${current.text}${delta}`,
    status: "running",
    eventType: "live.agent_message.delta",
    turnId: turnId ?? current.turnId ?? null,
  };
  return trimMessages(next);
};

const upsertAssistantMessage = (
  messages: ChatMessage[],
  messageId: string,
  text: string,
  timestamp: string,
  turnId?: string | null,
): ChatMessage[] => {
  const idx = messages.findIndex((item) => item.messageId === messageId);
  if (idx < 0) {
    return trimMessages([
      ...messages,
      {
        messageId,
        role: "assistant",
        text,
        status: "completed",
        eventType: "live.agent_message.completed",
        timestamp,
        turnId: turnId ?? null,
      },
    ]);
  }

  const next = [...messages];
  const current = next[idx];
  next[idx] = {
    ...current,
    text,
    status: "completed",
    eventType: "live.agent_message.completed",
    turnId: turnId ?? current.turnId ?? null,
  };
  return trimMessages(next);
};

export default function ExecPanel({
  slug,
  sessionPanelMode = "drawer",
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [execToken, setExecToken] = useState("");
  const [useStream, setUseStream] = useState(true);
  const [includeContext, setIncludeContext] = useState(false);
  const [followTail, setFollowTail] = useState(true);
  const [showDebugLog, setShowDebugLog] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [sessionRailCollapsed, setSessionRailCollapsed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTaskDock, setShowTaskDock] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileMatches, setFileMatches] = useState<ProjectFileMatch[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [mentionState, setMentionState] = useState<FileMentionState | null>(
    null,
  );
  const [liveStdout, setLiveStdout] = useState("");
  const [liveStderr, setLiveStderr] = useState("");
  const [streamMeta, setStreamMeta] = useState<{
    exitCode?: number;
    durationMs?: number;
  }>({});
  const [lastTurnSummary, setLastTurnSummary] = useState<TurnSummary | null>(
    null,
  );
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ExecTask[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedHistoryThreadId, setSelectedHistoryThreadId] = useState("");
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>("all");
  const [threadSearch, setThreadSearch] = useState("");
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [transcript, setTranscript] = useState<ThreadTranscript | null>(null);
  const useSessionDrawer = sessionPanelMode === "drawer";

  const abortRef = useRef<AbortController | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);
  const currentThreadIdRef = useRef<string | null>(null);
  const preserveBlankSessionRef = useRef(false);

  useEffect(() => {
    currentThreadIdRef.current = currentThreadId;
  }, [currentThreadId]);

  const loadTasks = useCallback(async () => {
    try {
      const data = await fetchExecTasks({
        projectSlug: slug,
        execToken: execToken.trim() || undefined,
      });
      setTasks(data.tasks);
    } catch {
      // ignore task polling error
    }
  }, [execToken, slug]);

  const loadThreads = useCallback(async () => {
    try {
      const data = await fetchThreads(slug);
      setThreads(data);
    } catch {
      // ignore thread polling error
    }
  }, [slug]);

  const hydrateThreadTranscript = useCallback(
    async (threadId: string, mode: "replace" | "merge" = "merge") => {
      const data = await fetchThreadTranscript(threadId);
      setTranscript(data);
      const normalized = data.messages
        .map(toChatMessage)
        .filter((item): item is ChatMessage => item !== null);
      if (mode === "replace") {
        setMessages(dedupeCanonicalMessages(normalized));
        return;
      }
      setMessages((prev) => mergeHydratedMessages(prev, normalized));
    },
    [],
  );

  useEffect(() => {
    // Reset project-scoped state first so switching projects never flashes the previous console.
    setLoading(false);
    setError(null);
    setCurrentTaskId(null);
    setCurrentThreadId(null);
    currentThreadIdRef.current = null;
    setThreads([]);
    setTasks([]);
    setSelectedHistoryThreadId("");
    setMessages([]);
    setTranscript(null);
    setLastTurnSummary(null);
    setLiveStdout("");
    setLiveStderr("");
    setStreamMeta({});
    setMentionState(null);
    setFileMatches([]);
    activeAssistantIdRef.current = null;
    abortRef.current = null;
    preserveBlankSessionRef.current = false;

    const rawHistory = window.localStorage.getItem(historyKey(slug));
    if (rawHistory) {
      try {
        const parsed = JSON.parse(rawHistory) as string[];
        if (Array.isArray(parsed)) {
          setPromptHistory(parsed.slice(0, 50));
        } else {
          setPromptHistory([]);
        }
      } catch {
        setPromptHistory([]);
      }
    } else {
      setPromptHistory([]);
    }

    const rawToken = window.localStorage.getItem("codex_hub_exec_token");
    if (rawToken) {
      setExecToken(rawToken);
    }

    const rawThreadId = window.localStorage.getItem(threadKey(slug));
    if (rawThreadId) {
      setCurrentThreadId(rawThreadId);
    }

    const rawMessages = window.localStorage.getItem(chatCacheKey(slug));
    if (rawMessages) {
      try {
        const parsed = JSON.parse(rawMessages) as ChatMessage[];
        if (Array.isArray(parsed)) {
          setMessages(trimMessages(parsed));
        }
      } catch {
        // ignore
      }
    }

    const rawSessionRail = window.localStorage.getItem(sessionRailKey(slug));
    setSessionRailCollapsed(rawSessionRail === "collapsed");

    void loadTasks();
    void loadThreads();
  }, [loadTasks, loadThreads, slug]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadTasks();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [loadTasks]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadThreads();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadThreads]);

  useEffect(() => {
    if (!currentThreadId) {
      window.localStorage.removeItem(threadKey(slug));
      setTranscript(null);
      return;
    }
    window.localStorage.setItem(threadKey(slug), currentThreadId);
    setSelectedHistoryThreadId(currentThreadId);
    void hydrateThreadTranscript(currentThreadId, "merge").catch(() => {
      // ignore hydrate failure in project console
    });
  }, [currentThreadId, hydrateThreadTranscript, slug]);

  useEffect(() => {
    window.localStorage.setItem(
      chatCacheKey(slug),
      JSON.stringify(trimMessages(messages)),
    );
  }, [messages, slug]);

  useEffect(() => {
    if (!currentThreadId || !loading) {
      return;
    }
    const timer = window.setInterval(() => {
      void hydrateThreadTranscript(currentThreadId, "merge").catch(() => {
        // ignore live transcript polling failures
      });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [currentThreadId, hydrateThreadTranscript, loading]);

  useEffect(() => {
    window.localStorage.setItem(
      sessionRailKey(slug),
      sessionRailCollapsed ? "collapsed" : "expanded",
    );
  }, [sessionRailCollapsed, slug]);

  useEffect(() => {
    if (!mentionState) {
      setFileMatches([]);
      setFileSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        setFileSearchLoading(true);
        const result = await fetchProjectFileMatches(slug, mentionState.query, {
          limit: FILE_MENTION_LIMIT,
          execToken: execToken.trim() || undefined,
        });
        setFileMatches(result.files);
        setMentionState((prev) =>
          prev
            ? {
                ...prev,
                selectedIndex: Math.min(
                  prev.selectedIndex,
                  Math.max(result.files.length - 1, 0),
                ),
              }
            : prev,
        );
      } catch {
        setFileMatches([]);
      } finally {
        setFileSearchLoading(false);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [execToken, mentionState?.query, mentionState?.start, slug]);

  useEffect(() => {
    if (!followTail || !transcriptRef.current) {
      return;
    }
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [followTail, liveStdout, liveStderr, messages, transcript]);

  const onStreamEvent = useCallback((chunk: ExecStreamEvent): void => {
    if (chunk.type === "thread") {
      setCurrentThreadId(chunk.threadId);
      return;
    }

    if (chunk.type === "queued") {
      setCurrentTaskId(chunk.taskId);
      return;
    }

    if (chunk.type === "start") {
      setCurrentTaskId(chunk.taskId);
      if (chunk.threadId) {
        preserveBlankSessionRef.current = false;
        setCurrentThreadId(chunk.threadId);
      }
      return;
    }

    if (chunk.type === "stdout") {
      setLiveStdout((prev) => appendChunk(prev, chunk.data));
      return;
    }

    if (chunk.type === "stderr") {
      setLiveStderr((prev) => appendChunk(prev, chunk.data));
      return;
    }

    if (chunk.type === "assistant_delta") {
      setLiveStdout((prev) => appendChunk(prev, chunk.data));
      if (chunk.threadId) {
        preserveBlankSessionRef.current = false;
        setCurrentThreadId(chunk.threadId);
      }

      const timestamp = new Date().toISOString();
      const messageId = chunk.itemId
        ? `assistant-${chunk.itemId}`
        : (activeAssistantIdRef.current ?? `assistant-live-${Date.now()}`);
      activeAssistantIdRef.current = messageId;
      setMessages((prev) =>
        upsertAssistantDelta(prev, messageId, chunk.data, timestamp, chunk.turnId),
      );
      return;
    }

    if (chunk.type === "assistant_message") {
      setLiveStdout((prev) => appendChunk(prev, `${chunk.text}\n`));
      if (chunk.threadId) {
        setCurrentThreadId(chunk.threadId);
      }

      const timestamp = new Date().toISOString();
      const messageId = chunk.itemId
        ? `assistant-${chunk.itemId}`
        : (activeAssistantIdRef.current ?? `assistant-live-${Date.now()}`);
      activeAssistantIdRef.current = messageId;
      setMessages((prev) =>
        upsertAssistantMessage(prev, messageId, chunk.text, timestamp, chunk.turnId),
      );
      return;
    }

    if (chunk.type === "end") {
      const assistantMessageId = activeAssistantIdRef.current;
      activeAssistantIdRef.current = null;
      setStreamMeta({
        exitCode: chunk.exitCode,
        durationMs: chunk.durationMs,
      });
      setLastTurnSummary({
        taskId: chunk.taskId,
        threadId: currentThreadIdRef.current,
        assistantMessageId,
        status: chunk.exitCode === 0 ? "completed" : "warning",
        exitCode: chunk.exitCode,
        durationMs: chunk.durationMs,
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    if (chunk.type === "error") {
      setError(describeAppError(chunk.message));
    }
  }, []);

  const syncMentionState = useCallback((value: string, caret: number) => {
    const nextMention = getFileMentionAtCaret(value, caret);
    setMentionState((prev) =>
      nextMention
        ? {
            ...nextMention,
            selectedIndex:
              prev &&
              prev.start === nextMention.start &&
              prev.query === nextMention.query
                ? prev.selectedIndex
                : 0,
          }
        : null,
    );
  }, []);

  const applyFileMention = useCallback(
    (file: ProjectFileMatch) => {
      if (!mentionState) {
        return;
      }
      const nextPrompt = `${prompt.slice(0, mentionState.start)}@${file.path} ${prompt.slice(mentionState.end)}`;
      const nextCaret = mentionState.start + file.path.length + 2;
      setPrompt(nextPrompt);
      setMentionState(null);
      setFileMatches([]);
      requestAnimationFrame(() => {
        const textarea = promptTextareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [mentionState, prompt],
  );

  const onPromptChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setPrompt(value);
    setHistoryCursor(-1);
    syncMentionState(value, event.target.selectionStart ?? value.length);
  };

  const onPromptSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    syncMentionState(
      target.value,
      target.selectionStart ?? target.value.length,
    );
  };

  const onRemoveReferencedPath = (filePath: string) => {
    setPrompt((prev) => removeReferencedPath(prev, filePath));
    setMentionState(null);
    setFileMatches([]);
    requestAnimationFrame(() => {
      promptTextareaRef.current?.focus();
    });
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    const nowIso = new Date().toISOString();
    const pendingUserMessage: ChatMessage = {
      messageId: `user-${Date.now()}`,
      role: "user",
      text: trimmed,
      status: "running",
      eventType: "live.user_prompt",
      timestamp: nowIso,
    };

    const referencedPaths = collectReferencedPaths(trimmed).slice(
      0,
      MAX_FILE_REFERENCE_COUNT,
    );
    const promptWithReferences = referencedPaths.length
      ? buildPromptWithReferencedFiles(
          trimmed,
          (
            await fetchProjectFileContexts(slug, referencedPaths, {
              execToken: execToken.trim() || undefined,
            })
          ).files,
        )
      : trimmed;
    const promptToSend = includeContext
      ? buildPromptWithContext(promptWithReferences, [
          ...messages,
          pendingUserMessage,
        ])
      : promptWithReferences;

    setLoading(true);
    setError(null);
    setLastTurnSummary(null);
    cancelRequestedRef.current = false;
    setLiveStdout("");
    setLiveStderr("");
    setStreamMeta({});
    setLastTurnSummary(null);
    setCurrentTaskId(null);
    setPrompt("");
    setMentionState(null);
    setFileMatches([]);
    setShowDebugLog(false);
    activeAssistantIdRef.current = null;
    setMessages((prev) => trimMessages([...prev, pendingUserMessage]));

    try {
      const nextHistory = [
        trimmed,
        ...promptHistory.filter((item) => item !== trimmed),
      ].slice(0, 50);
      setPromptHistory(nextHistory);
      window.localStorage.setItem(
        historyKey(slug),
        JSON.stringify(nextHistory),
      );
      window.localStorage.setItem("codex_hub_exec_token", execToken.trim());

      if (useStream) {
        const controller = new AbortController();
        abortRef.current = controller;
        await streamProjectExec({
          slug,
          prompt: promptToSend,
          model,
          threadId: currentThreadIdRef.current ?? undefined,
          execToken: execToken.trim() || undefined,
          signal: controller.signal,
          onEvent: onStreamEvent,
        });
      } else {
        const output = await runProjectExec(
          slug,
          promptToSend,
          model,
          execToken.trim() || undefined,
        );
        setCurrentTaskId(output.taskId);
        setLiveStdout(output.stdout);
        setLiveStderr(output.stderr);
        setStreamMeta({
          exitCode: output.exitCode,
          durationMs: output.durationMs,
        });
        const assistantMessageId = `assistant-non-stream-${Date.now()}`;
        setMessages((prev) =>
          trimMessages([
            ...prev,
            {
              messageId: assistantMessageId,
              role: "assistant",
              text: output.stdout || "(empty)",
              status: output.status,
              eventType: "exec.once",
              timestamp: new Date().toISOString(),
            },
          ]),
        );
        setLastTurnSummary({
          taskId: output.taskId,
          threadId: currentThreadIdRef.current,
          assistantMessageId,
          status: output.exitCode === 0 ? "completed" : "warning",
          exitCode: output.exitCode,
          durationMs: output.durationMs,
          finishedAt: new Date().toISOString(),
        });
      }

      setMessages((prev) =>
        prev.map((item) =>
          item.messageId === pendingUserMessage.messageId
            ? { ...item, status: "completed" }
            : item,
        ),
      );

      const runtimeThreadId = currentThreadIdRef.current;
      if (runtimeThreadId) {
        await hydrateThreadTranscript(runtimeThreadId, "merge");
        window.setTimeout(() => {
          void hydrateThreadTranscript(runtimeThreadId, "merge").catch(() => {
            // ignore delayed hydrate failure
          });
        }, 1200);
      } else {
        // no thread yet, keep local chat state
      }
    } catch (err) {
      const canceled =
        cancelRequestedRef.current ||
        (err instanceof DOMException && err.name === "AbortError");
      if (!canceled) {
        setError(
          describeAppError(err instanceof Error ? err.message : "exec_failed"),
        );
        setLastTurnSummary({
          taskId: currentTaskId,
          threadId: currentThreadIdRef.current,
          assistantMessageId: activeAssistantIdRef.current,
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
      }
      setMessages((prev) =>
        prev.map((item) =>
          item.messageId === pendingUserMessage.messageId
            ? { ...item, status: canceled ? "canceled" : "failed" }
            : item,
        ),
      );
    } finally {
      setLoading(false);
      abortRef.current = null;
      cancelRequestedRef.current = false;
      void loadTasks();
      void loadThreads();
    }
  };

  const onCancel = async () => {
    if (!currentTaskId) {
      return;
    }
    try {
      cancelRequestedRef.current = true;
      await cancelExecTask(currentTaskId, {
        execToken: execToken.trim() || undefined,
      });
      abortRef.current?.abort();
      setError("任务已取消");
      setLastTurnSummary({
        taskId: currentTaskId,
        threadId: currentThreadIdRef.current,
        assistantMessageId: activeAssistantIdRef.current,
        status: "canceled",
        finishedAt: new Date().toISOString(),
      });
      setLoading(false);
      await loadTasks();
    } catch (err) {
      setError(
        describeAppError(err instanceof Error ? err.message : "cancel_failed"),
      );
    }
  };

  const onStartNewSession = () => {
    if (loading) {
      return;
    }
    preserveBlankSessionRef.current = true;
    setCurrentThreadId(null);
    currentThreadIdRef.current = null;
    setSelectedHistoryThreadId("");
    setCurrentTaskId(null);
    setMessages([]);
    setTranscript(null);
    setShowHistoryDrawer(false);
    setMentionState(null);
    setFileMatches([]);
    setLiveStdout("");
    setLiveStderr("");
    setStreamMeta({});
    setError(null);
    activeAssistantIdRef.current = null;
    window.localStorage.removeItem(threadKey(slug));
    window.localStorage.removeItem(chatCacheKey(slug));
  };

  const openHistoryThread = useCallback(
    async (threadId: string, options?: { closeDrawer?: boolean }) => {
      const nextThreadId = threadId.trim();
      if (!nextThreadId || loading) {
        return;
      }
      setError(null);
      setLastTurnSummary(null);
      preserveBlankSessionRef.current = false;
      setSelectedHistoryThreadId(nextThreadId);
      setCurrentThreadId(nextThreadId);
      currentThreadIdRef.current = nextThreadId;
      try {
        await hydrateThreadTranscript(nextThreadId, "replace");
        if (options?.closeDrawer) {
          setShowHistoryDrawer(false);
        }
      } catch (err) {
        setError(
          describeAppError(
            err instanceof Error ? err.message : "load_thread_history_failed",
          ),
        );
      }
    },
    [hydrateThreadTranscript, loading],
  );

  const onLoadHistoryThread = async () => {
    await openHistoryThread(selectedHistoryThreadId, { closeDrawer: true });
  };

  const onClearLocalHistory = () => {
    if (loading) {
      return;
    }
    setMessages([]);
    setPromptHistory([]);
    setHistoryCursor(-1);
    setError(null);
    setLastTurnSummary(null);
    window.localStorage.removeItem(chatCacheKey(slug));
    window.localStorage.removeItem(historyKey(slug));
  };

  const onKeyDownPrompt = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionState((prev) =>
          prev
            ? {
                ...prev,
                selectedIndex:
                  fileMatches.length > 0
                    ? Math.min(prev.selectedIndex + 1, fileMatches.length - 1)
                    : 0,
              }
            : prev,
        );
        return;
      }
      if (event.key === "ArrowUp" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        setMentionState((prev) =>
          prev
            ? {
                ...prev,
                selectedIndex: Math.max(prev.selectedIndex - 1, 0),
              }
            : prev,
        );
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        fileMatches.length > 0
      ) {
        event.preventDefault();
        applyFileMention(
          fileMatches[mentionState.selectedIndex] ?? fileMatches[0],
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionState(null);
        setFileMatches([]);
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (event.key === "ArrowUp" && event.ctrlKey) {
      event.preventDefault();
      const next = Math.min(historyCursor + 1, promptHistory.length - 1);
      if (next >= 0) {
        setHistoryCursor(next);
        setPrompt(promptHistory[next] ?? "");
      }
      return;
    }
    if (event.key === "ArrowDown" && event.ctrlKey) {
      event.preventDefault();
      const next = Math.max(historyCursor - 1, -1);
      setHistoryCursor(next);
      setPrompt(next >= 0 ? (promptHistory[next] ?? "") : "");
    }
  };

  const recentTasks = useMemo(() => tasks.slice(0, 8), [tasks]);
  const referencedPaths = useMemo(
    () => collectReferencedPaths(prompt),
    [prompt],
  );
  const orderedThreads = useMemo(
    () => [...threads].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [threads],
  );
  useEffect(() => {
    if (preserveBlankSessionRef.current) {
      return;
    }
    if (
      currentThreadId &&
      orderedThreads.some((thread) => thread.thread_id === currentThreadId)
    ) {
      return;
    }
    const fallbackThreadId = orderedThreads[0]?.thread_id ?? null;
    if (!fallbackThreadId) {
      return;
    }
    setCurrentThreadId(fallbackThreadId);
    currentThreadIdRef.current = fallbackThreadId;
  }, [currentThreadId, orderedThreads]);
  const runningThreadCount = useMemo(
    () => orderedThreads.filter((thread) => thread.status === "running").length,
    [orderedThreads],
  );
  const recentThreadCount = useMemo(
    () => Math.min(orderedThreads.length, 8),
    [orderedThreads],
  );
  const searchedThreads = useMemo(() => {
    const keyword = threadSearch.trim().toLowerCase();
    if (!keyword) {
      return orderedThreads;
    }
    return orderedThreads.filter((thread) => {
      const haystack = [
        thread.thread_id,
        thread.title ?? "",
        thread.first_user_prompt ?? "",
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [orderedThreads, threadSearch]);
  const filteredThreads = useMemo(() => {
    if (threadFilter === "running") {
      return searchedThreads.filter((thread) => thread.status === "running");
    }
    if (threadFilter === "recent") {
      return searchedThreads.slice(0, 8);
    }
    return searchedThreads;
  }, [searchedThreads, threadFilter]);
  const currentThreadMeta = useMemo(
    () =>
      orderedThreads.find((thread) => thread.thread_id === currentThreadId) ??
      null,
    [currentThreadId, orderedThreads],
  );
  const currentThreadLabel = currentThreadMeta
    ? summarizeThreadLabel(currentThreadMeta)
    : "新会话";
  const currentThreadUpdatedText = currentThreadMeta
    ? formatTime(currentThreadMeta.updated_at)
    : "等待第一条消息";
  const currentThreadSnippet =
    currentThreadMeta?.first_user_prompt?.trim() ||
    "当前是一个还没发送首条 prompt 的新会话。";
  const renderedMessages = useMemo(() => trimMessages(messages), [messages]);
  const summary = useMemo(
    () => ({
      total: renderedMessages.length,
      user: renderedMessages.filter((item) => item.role === "user").length,
      assistant: renderedMessages.filter((item) => item.role === "assistant")
        .length,
    }),
    [renderedMessages],
  );
  const activeAssistantMessage = useMemo(
    () =>
      [...renderedMessages]
        .reverse()
        .find(
          (item) => item.role === "assistant" && item.status === "running",
        ) ?? null,
    [renderedMessages],
  );
  const thinkingPhase = useMemo(() => {
    if (!loading) {
      return null;
    }

    const hasAssistantText = Boolean(activeAssistantMessage?.text.trim());
    const hasRuntimeOutput =
      liveStdout.trim().length > 0 || liveStderr.trim().length > 0;

    if (hasAssistantText) {
      return {
        chip: "answering",
        title: "正在生成回答",
        detail: "Codex 已进入输出阶段，会继续把当前轮回复逐步打印到对话窗口。",
        compact: true,
      };
    }

    if (hasRuntimeOutput) {
      return {
        chip: "context",
        title: "正在整理上下文",
        detail: "Codex 正在读取项目输出、线程状态和上下文，再组织这一轮回复。",
        compact: false,
      };
    }

    if (currentTaskId) {
      return {
        chip: "session",
        title: "正在建立会话",
        detail: "任务已提交，正在连接当前项目的事件流和这一次对话 thread。",
        compact: false,
      };
    }

    return {
      chip: "boot",
      title: "正在准备执行",
      detail: "Prompt 已发出，正在初始化本轮任务并准备进入流式会话。",
      compact: false,
    };
  }, [activeAssistantMessage, currentTaskId, liveStderr, liveStdout, loading]);
  const showInlinePendingAssistant =
    loading && !activeAssistantMessage?.text.trim();
  const turnSummaryMeta = useMemo(() => {
    if (!lastTurnSummary) {
      return null;
    }

    if (lastTurnSummary.status === "completed") {
      return {
        label: "本轮回答已完成",
        chip: "completed",
        tone: "completed",
      };
    }

    if (lastTurnSummary.status === "warning") {
      return {
        label: "本轮执行已结束",
        chip: "exit",
        tone: "warning",
      };
    }

    if (lastTurnSummary.status === "canceled") {
      return {
        label: "本轮任务已取消",
        chip: "canceled",
        tone: "canceled",
      };
    }

    return {
      label: "本轮执行失败",
      chip: "failed",
      tone: "failed",
    };
  }, [lastTurnSummary]);
  const thinkingStatusText = loading
    ? `${thinkingPhase?.title ?? "模型正在思考中"}...`
    : currentThreadId
      ? "可继续在当前 thread 中追问"
      : "等待第一条指令";
  const transcriptSubtitle = useSessionDrawer
    ? "会话列表收进右上角抽屉，主视觉优先留给 transcript 和输入区。"
    : "默认让 transcript 和会话栏共同构成第一视觉。任务与设置继续下沉到次级区。";
  return (
    <section className="grid" style={{ gap: 12 }}>
      <section
        id="project-session-topbar"
        className="panel mc-immersive-topbar"
      >
        <div className="mc-immersive-titlebar">
          <div className="grid" style={{ gap: 4 }}>
            <h2 className="mc-section-title" style={{ margin: 0 }}>
              Codex 项目会话台
            </h2>
            <div className="thread-meta-row">
              <span>thread {currentThreadId ?? "new"}</span>
              <span>消息 {summary.total}</span>
              <span>助手 {summary.assistant}</span>
            </div>
          </div>
          <div className="mc-chip-row">
            <span className={`live-dot ${loading ? "online" : "offline"}`}>
              {loading ? "RUNNING" : "IDLE"}
            </span>
            <span className="mc-chip info">
              {streamMeta.exitCode !== undefined
                ? `exit=${streamMeta.exitCode}`
                : loading
                  ? "thinking"
                  : "ready"}
            </span>
          </div>
        </div>

        <div className="mc-thinking-copy code">{thinkingStatusText}</div>

        <div className="mc-action-row">
          <button
            type="button"
            className="mc-button"
            onClick={onStartNewSession}
            disabled={loading}
          >
            新会话
          </button>
          {!useSessionDrawer ? (
            <>
              <button
                type="button"
                className="mc-button secondary mc-mobile-only js-tour-history-entry"
                onClick={() => setShowHistoryDrawer(true)}
              >
                历史会话
              </button>
              <button
                type="button"
                className="mc-button ghost mc-desktop-only js-tour-history-entry"
                onClick={() => setSessionRailCollapsed((prev) => !prev)}
              >
                {sessionRailCollapsed ? ">> 会话栏" : "<< 会话栏"}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="mc-button ghost"
            onClick={() => setShowSettings((prev) => !prev)}
          >
            {showSettings ? "收起设置" : "更多设置"}
          </button>
          <button
            type="button"
            className="mc-button ghost"
            onClick={() => setShowTaskDock((prev) => !prev)}
          >
            {showTaskDock ? "收起任务" : "任务队列"}
          </button>
          {currentThreadId ? (
            <Link
              className="mc-button ghost"
              href={`/threads/${encodeURIComponent(currentThreadId)}`}
            >
              打开完整 Thread
            </Link>
          ) : null}
        </div>
      </section>

      {showSettings ? (
        <section className="panel mc-settings-panel">
          <div className="mc-section-head">
            <div>
              <h3 className="mc-section-title">运行设置</h3>
              <p className="mc-section-subtitle">
                默认收起，避免设置项抢占对话首屏。
              </p>
            </div>
          </div>
          <div className="mc-form-grid-2">
            <label className="mc-field">
              <span className="mc-field-label">exec token</span>
              <input
                className="thread-input code"
                value={execToken}
                onChange={(event) => setExecToken(event.target.value)}
                placeholder="可选：exec token（启用 EXEC_API_TOKEN 时必填）"
                disabled={loading}
              />
            </label>
            <label className="mc-field">
              <span className="mc-field-label">model</span>
              <input
                className="thread-input code"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="可选模型，如 gpt-5-codex"
                disabled={loading}
              />
            </label>
          </div>
          <div className="mc-chip-row code">
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={useStream}
                onChange={(event) => setUseStream(event.target.checked)}
                disabled={loading}
              />
              流式输出
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={includeContext}
                onChange={(event) => setIncludeContext(event.target.checked)}
                disabled={loading}
              />
              追加最近上下文
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={followTail}
                onChange={() => setFollowTail((prev) => !prev)}
              />
              自动滚动
            </label>
            <button
              type="button"
              className="mc-button secondary"
              onClick={() => setShowDebugLog((prev) => !prev)}
            >
              {showDebugLog ? "隐藏调试流" : "显示调试流"}
            </button>
            <button
              type="button"
              className="mc-button ghost"
              onClick={onClearLocalHistory}
              disabled={loading}
            >
              清空本地历史
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="panel">
          <div className="mc-inline-feedback error">
            <strong>当前会话执行异常。</strong> {error}
          </div>
        </section>
      ) : null}

      <div
        className={`mc-chat-workspace ${sessionRailCollapsed ? "collapsed" : ""} ${useSessionDrawer ? "drawer-mode" : ""}`}
      >
        {!useSessionDrawer ? (
          <aside
            id="project-session-rail"
            className={`panel mc-session-rail ${sessionRailCollapsed ? "collapsed" : ""}`}
          >
            <div className="mc-session-rail-toggle-row">
              <button
                type="button"
                className="mc-button ghost mc-session-rail-toggle"
                onClick={() => setSessionRailCollapsed((prev) => !prev)}
                aria-label={sessionRailCollapsed ? "展开会话栏" : "收起会话栏"}
              >
                <span
                  className="mc-session-rail-toggle-icon"
                  aria-hidden="true"
                >
                  {sessionRailCollapsed ? ">>" : "<<"}
                </span>
                <span className="mc-session-rail-toggle-text">
                  {sessionRailCollapsed ? "展开" : "收起"}
                </span>
              </button>
            </div>

            <div
              className={`mc-session-rail-expanded ${sessionRailCollapsed ? "hidden" : ""}`}
            >
              <div className="mc-session-rail-head">
                <div className="mc-section-head">
                  <div>
                    <h3 className="mc-section-title">会话栏</h3>
                    <p className="mc-section-subtitle">
                      像 codex app 一样直接切换最近会话。
                    </p>
                  </div>
                  <span className="mc-chip info">
                    threads {filteredThreads.length}
                  </span>
                </div>
                <div className="mc-session-rail-actions">
                  <button
                    type="button"
                    className="mc-button"
                    onClick={onStartNewSession}
                    disabled={loading}
                  >
                    新会话
                  </button>
                  <button
                    type="button"
                    className="mc-button ghost"
                    onClick={() => void loadThreads()}
                  >
                    刷新列表
                  </button>
                </div>
                <label className="mc-field">
                  <span className="mc-field-label">搜索会话</span>
                  <input
                    className="mc-input light code mc-thread-search-input"
                    value={threadSearch}
                    onChange={(event) => setThreadSearch(event.target.value)}
                    placeholder="按首句、标题或 thread id 搜索"
                  />
                </label>
                <div
                  className="mc-thread-filter-row"
                  role="tablist"
                  aria-label="会话筛选"
                >
                  <button
                    type="button"
                    className={`mc-thread-filter ${threadFilter === "all" ? "active" : ""}`}
                    onClick={() => setThreadFilter("all")}
                  >
                    全部 {orderedThreads.length}
                  </button>
                  <button
                    type="button"
                    className={`mc-thread-filter ${threadFilter === "running" ? "active" : ""}`}
                    onClick={() => setThreadFilter("running")}
                  >
                    运行中 {runningThreadCount}
                  </button>
                  <button
                    type="button"
                    className={`mc-thread-filter ${threadFilter === "recent" ? "active" : ""}`}
                    onClick={() => setThreadFilter("recent")}
                  >
                    最近更新 {recentThreadCount}
                  </button>
                </div>
                <div className="mc-session-focus">
                  <span className="mc-session-focus-label">当前会话</span>
                  <div className="mc-session-focus-value code">
                    {currentThreadId ?? "new"}
                  </div>
                </div>
              </div>

              <div className="mc-session-rail-list">
                {filteredThreads.map((thread) => {
                  const isActive =
                    thread.thread_id === currentThreadId ||
                    thread.thread_id === selectedHistoryThreadId;
                  return (
                    <button
                      key={thread.thread_id}
                      type="button"
                      className={`mc-thread-item ${isActive ? "active" : ""}`}
                      onClick={() => void openHistoryThread(thread.thread_id)}
                    >
                      <div className="mc-thread-item-head">
                        <span className="mc-thread-title">
                          {summarizeThreadLabel(thread)}
                        </span>
                        <span
                          className={`badge ${thread.thread_id === currentThreadId ? "completed" : "neutral"}`}
                        >
                          {thread.status ?? "-"}
                        </span>
                      </div>
                      <div className="mc-thread-snippet">
                        {thread.first_user_prompt?.trim() ||
                          "还没有首条提问，通常是刚初始化的新 thread。"}
                      </div>
                      <div className="mc-thread-meta">
                        <span className="code">{thread.thread_id}</span>
                        <span>
                          {new Date(thread.updated_at).toLocaleString()}
                        </span>
                      </div>
                    </button>
                  );
                })}
                {filteredThreads.length === 0 ? (
                  <div className="mc-empty">
                    当前筛选和搜索条件下暂无历史会话
                  </div>
                ) : null}
              </div>
            </div>

            <div
              className={`mc-session-rail-collapsed ${sessionRailCollapsed ? "visible" : ""}`}
            >
              <button
                type="button"
                className="mc-session-mini-card current"
                onClick={() => setSessionRailCollapsed(false)}
                aria-label="展开会话栏查看当前会话详情"
              >
                <span className="mc-session-mini-label">当前</span>
                <span className="mc-session-mini-value code">
                  {currentThreadId ? currentThreadId.slice(0, 8) : "new"}
                </span>
                <span className="mc-session-mini-caption">
                  {currentThreadLabel.slice(0, 10)}
                </span>
              </button>
              <div className="mc-session-mini-stack" aria-hidden="true">
                <span className="mc-session-mini-block grass" />
                <span className="mc-session-mini-block dirt" />
                <span className="mc-session-mini-block stone" />
              </div>
              <div className="mc-session-mini-stats">
                <div className="mc-session-mini-stat">
                  <span className="mc-session-mini-stat-value code">
                    {orderedThreads.length}
                  </span>
                  <span className="mc-session-mini-stat-label">会话</span>
                </div>
                <div className="mc-session-mini-stat online">
                  <span className="mc-session-mini-stat-value code">
                    {runningThreadCount}
                  </span>
                  <span className="mc-session-mini-stat-label">运行</span>
                </div>
              </div>
              <div className="mc-session-mini-preview" aria-hidden="true">
                <div className="mc-session-mini-preview-head">
                  <span className="mc-session-mini-preview-chip">
                    {currentThreadMeta?.status ?? "new"}
                  </span>
                  <span className="mc-session-mini-preview-title">
                    {currentThreadLabel}
                  </span>
                </div>
                <div className="mc-session-mini-preview-meta">
                  <span className="code">
                    thread {currentThreadId ?? "new"}
                  </span>
                  <span>更新 {currentThreadUpdatedText}</span>
                </div>
                <div className="mc-session-mini-preview-note">
                  {currentThreadSnippet}
                </div>
              </div>
            </div>
          </aside>
        ) : null}

        <ProjectTranscriptView
          transcript={transcript}
          renderedMessages={renderedMessages}
          activeAssistantMessageId={activeAssistantMessage?.messageId ?? null}
          thinkingPhase={thinkingPhase}
          showInlinePendingAssistant={showInlinePendingAssistant}
          turnSummaryMeta={turnSummaryMeta}
          lastTurnSummary={lastTurnSummary}
          filteredThreadsCount={filteredThreads.length}
          transcriptSubtitle={transcriptSubtitle}
          waitingForUser={transcript?.context.runtime.waitingForUser ?? false}
          onOpenHistory={() => setShowHistoryDrawer(true)}
          formatTime={formatTime}
          formatDuration={formatDuration}
          transcriptRef={transcriptRef}
        />

          <form
            id="project-transcript-composer"
            className="thread-composer mc-transcript-composer"
            onSubmit={onSubmit}
          >
            <div className="thread-composer-row">
              <div className="mc-composer-shell">
                <textarea
                  ref={promptTextareaRef}
                  className="thread-textarea"
                  value={prompt}
                  onChange={onPromptChange}
                  onKeyDown={onKeyDownPrompt}
                  onSelect={onPromptSelect}
                  onClick={onPromptSelect}
                  placeholder="在当前项目中和 Codex 对话（输入 @ 搜索项目文件，Ctrl/Cmd+Enter 发送，Ctrl+↑/↓ 历史）"
                  rows={4}
                  disabled={loading}
                />
                {mentionState ? (
                  <div className="mc-file-mention-panel">
                    <div
                      className="mc-file-mention-searchbar"
                      aria-hidden="true"
                    >
                      <span className="mc-file-mention-search-icon">@</span>
                      <span
                        className={`mc-file-mention-search-text ${mentionState.query ? "filled" : "placeholder"}`}
                      >
                        {mentionState.query || "输入相关内容以搜索文件"}
                      </span>
                      <span className="mc-file-mention-meta">
                        {fileSearchLoading
                          ? "搜索中..."
                          : `${fileMatches.length} 个候选`}
                      </span>
                    </div>
                    <div className="mc-file-mention-head">
                      <span className="mc-file-mention-title">
                        项目文件引用
                      </span>
                      <span className="mc-file-mention-shortcut">
                        ↑ ↓ 选择 · Enter 插入
                      </span>
                    </div>
                    <div className="mc-file-mention-list">
                      {fileMatches.map((file, index) => (
                        <button
                          key={file.path}
                          type="button"
                          className={`mc-file-mention-item ${mentionState.selectedIndex === index ? "active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => applyFileMention(file)}
                        >
                          <span className="mc-file-mention-name">
                            {file.name}
                          </span>
                          <span className="mc-file-mention-path code">
                            {file.path}
                          </span>
                        </button>
                      ))}
                      {!fileSearchLoading && fileMatches.length === 0 ? (
                        <div className="mc-file-mention-empty">
                          没有匹配文件，继续输入可缩小范围。
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {referencedPaths.length > 0 ? (
              <div className="mc-file-ref-row">
                {referencedPaths.map((filePath) => (
                  <button
                    key={filePath}
                    type="button"
                    className="mc-file-ref-chip"
                    onClick={() => onRemoveReferencedPath(filePath)}
                    title={`移除引用 ${filePath}`}
                  >
                    <span className="mc-file-ref-at">@</span>
                    <span className="mc-file-ref-path code">{filePath}</span>
                    <span className="mc-file-ref-remove">x</span>
                  </button>
                ))}
                {referencedPaths.length > MAX_FILE_REFERENCE_COUNT ? (
                  <span className="mc-file-ref-note">
                    发送时仅附带前 {MAX_FILE_REFERENCE_COUNT} 个引用文件。
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="thread-composer-row">
              <button
                type="submit"
                className="thread-btn"
                disabled={loading || !prompt.trim()}
              >
                {loading ? "发送中..." : "发送"}
              </button>
              <button
                type="button"
                className="thread-btn"
                disabled={!loading || !currentTaskId}
                onClick={() => void onCancel()}
              >
                取消任务
              </button>
            </div>
          </form>

          {showDebugLog ? (
            <div className="stream-shell">
              <div className="stream-head">live stream debug</div>
              <pre className="stream-log">
                {liveStdout || liveStderr
                  ? `${liveStdout}${
                      liveStderr
                        ? `
[stderr]
${liveStderr}`
                        : ""
                    }`
                  : "等待输出..."}
              </pre>
            </div>
          ) : null}
      </div>
      {showHistoryDrawer ? (
        <>
          <button
            type="button"
            className="mc-drawer-backdrop"
            onClick={() => setShowHistoryDrawer(false)}
            aria-label="关闭历史会话抽屉"
          />
          <aside className="panel mc-history-drawer">
            <div className="mc-section-head">
              <div>
                <h3 className="mc-section-title">项目会话栏</h3>
                <p className="mc-section-subtitle">
                  默认收进抽屉，需要切换 thread 时再展开，不挤占主对话区。
                </p>
              </div>
              <button
                type="button"
                className="mc-button ghost"
                onClick={() => setShowHistoryDrawer(false)}
              >
                关闭
              </button>
            </div>
            <label className="mc-field">
              <span className="mc-field-label">搜索会话</span>
              <input
                className="mc-input light code mc-thread-search-input"
                value={threadSearch}
                onChange={(event) => setThreadSearch(event.target.value)}
                placeholder="按首句、标题或 thread id 搜索"
              />
            </label>
            <div
              className="mc-thread-filter-row"
              role="tablist"
              aria-label="移动端会话筛选"
            >
              <button
                type="button"
                className={`mc-thread-filter ${threadFilter === "all" ? "active" : ""}`}
                onClick={() => setThreadFilter("all")}
              >
                全部 {orderedThreads.length}
              </button>
              <button
                type="button"
                className={`mc-thread-filter ${threadFilter === "running" ? "active" : ""}`}
                onClick={() => setThreadFilter("running")}
              >
                运行中 {runningThreadCount}
              </button>
              <button
                type="button"
                className={`mc-thread-filter ${threadFilter === "recent" ? "active" : ""}`}
                onClick={() => setThreadFilter("recent")}
              >
                最近更新 {recentThreadCount}
              </button>
            </div>
            <div className="mc-thread-list">
              {filteredThreads.map((thread) => {
                const isActive =
                  thread.thread_id === currentThreadId ||
                  thread.thread_id === selectedHistoryThreadId;
                return (
                  <button
                    key={thread.thread_id}
                    type="button"
                    className={`mc-thread-item ${isActive ? "active" : ""}`}
                    onClick={() =>
                      void openHistoryThread(thread.thread_id, {
                        closeDrawer: true,
                      })
                    }
                  >
                    <div className="mc-thread-item-head">
                      <span className="mc-thread-title">
                        {summarizeThreadLabel(thread)}
                      </span>
                      <span
                        className={`badge ${thread.thread_id === currentThreadId ? "completed" : "neutral"}`}
                      >
                        {thread.status ?? "-"}
                      </span>
                    </div>
                    <div className="mc-thread-snippet">
                      {thread.first_user_prompt?.trim() ||
                        "还没有首条提问，通常是刚初始化的新 thread。"}
                    </div>
                    <div className="mc-thread-meta">
                      <span className="code">{thread.thread_id}</span>
                      <span>
                        {new Date(thread.updated_at).toLocaleString()}
                      </span>
                    </div>
                  </button>
                );
              })}
              {filteredThreads.length === 0 ? (
                <div className="mc-empty">当前筛选和搜索条件下暂无历史会话</div>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}

      {showTaskDock ? (
        <section className="panel mc-task-dock">
          <div className="mc-section-head">
            <div>
              <h2 className="mc-section-title">最近任务队列</h2>
              <p className="mc-section-subtitle">默认折叠，需要时再展开。</p>
            </div>
            <div className="mc-action-row">
              <span className="mc-chip info">tasks {recentTasks.length}</span>
              <button
                type="button"
                className="mc-button ghost"
                onClick={() => void loadTasks()}
              >
                刷新任务
              </button>
            </div>
          </div>
          <div className="mc-table-shell">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>状态</th>
                  <th>排队位</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {recentTasks.map((task) => (
                  <tr key={task.id}>
                    <td className="code">{task.id.slice(0, 8)}</td>
                    <td>{task.status}</td>
                    <td>{task.queuePosition}</td>
                    <td>{new Date(task.createdAt).toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        className="mc-button danger"
                        disabled={
                          !(
                            task.status === "queued" ||
                            task.status === "running"
                          )
                        }
                        onClick={() =>
                          void cancelExecTask(task.id, {
                            execToken: execToken.trim() || undefined,
                          }).then(loadTasks)
                        }
                      >
                        取消
                      </button>
                    </td>
                  </tr>
                ))}
                {recentTasks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="mc-muted">
                      暂无任务
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </section>
  );
}
