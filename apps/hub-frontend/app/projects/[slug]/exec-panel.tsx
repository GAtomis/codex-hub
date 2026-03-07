"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelExecTask,
  fetchExecTasks,
  fetchThreads,
  fetchThreadMessages,
  runProjectExec,
  streamProjectExec,
  type ExecStreamEvent,
  type ExecTask,
  type Thread,
  type ThreadMessage
} from "../../../lib/api";

type Props = {
  slug: string;
};

type ChatMessage = {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  status: string | null;
  eventType: string;
  timestamp: string;
};

const MAX_CHAT_MESSAGES = 180;

const historyKey = (slug: string): string => `codex_hub_prompt_history_${slug}`;
const threadKey = (slug: string): string => `codex_hub_active_thread_${slug}`;
const chatCacheKey = (slug: string): string => `codex_hub_chat_cache_${slug}`;

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const summarizeThreadLabel = (thread: Thread): string => {
  const source = thread.first_user_prompt?.trim() || thread.title?.trim() || thread.thread_id;
  const oneLine = source.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 42) {
    return oneLine;
  }
  return `${oneLine.slice(0, 42)}...`;
};

const shortType = (value: string): string =>
  value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\s+/g, " ")
    .trim();

const appendChunk = (prev: string, chunk: string): string => {
  const next = `${prev}${chunk}`;
  if (next.length <= 16_000) {
    return next;
  }
  return next.slice(next.length - 16_000);
};

const trimMessages = (messages: ChatMessage[]): ChatMessage[] => messages.slice(-MAX_CHAT_MESSAGES);

const roleTextKey = (message: ChatMessage): string => `${message.role}|${message.text.trim()}`;

const timeBucket = (timestamp: string): number => {
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) {
    return 0;
  }
  return Math.floor(ts / 2000);
};

const dedupeCanonicalMessages = (messages: ChatMessage[]): ChatMessage[] => {
  const sorted = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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

const mergeHydratedMessages = (previous: ChatMessage[], canonical: ChatMessage[]): ChatMessage[] => {
  const canonicalDedupe = dedupeCanonicalMessages(canonical);
  const canonicalRoleText = new Set(canonicalDedupe.map((item) => roleTextKey(item)));
  const keepLive = previous.filter(
    (item) =>
      (item.eventType.startsWith("live.") || item.status === "running") &&
      !canonicalRoleText.has(roleTextKey(item))
  );
  const merged = [...canonicalDedupe, ...keepLive].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return trimMessages(merged);
};

const toChatMessage = (item: ThreadMessage): ChatMessage | null => {
  if (item.role !== "user" && item.role !== "assistant") {
    return null;
  }
  return {
    messageId: item.messageId,
    role: item.role,
    text: item.text,
    status: item.status,
    eventType: item.eventType,
    timestamp: item.timestamp
  };
};

const buildPromptWithContext = (prompt: string, messages: ChatMessage[]): string => {
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

const upsertAssistantDelta = (messages: ChatMessage[], messageId: string, delta: string, timestamp: string): ChatMessage[] => {
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
        timestamp
      }
    ]);
  }

  const next = [...messages];
  const current = next[idx];
  next[idx] = {
    ...current,
    text: `${current.text}${delta}`,
    status: "running",
    eventType: "live.agent_message.delta"
  };
  return trimMessages(next);
};

const upsertAssistantMessage = (messages: ChatMessage[], messageId: string, text: string, timestamp: string): ChatMessage[] => {
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
        timestamp
      }
    ]);
  }

  const next = [...messages];
  const current = next[idx];
  next[idx] = {
    ...current,
    text,
    status: "completed",
    eventType: "live.agent_message.completed"
  };
  return trimMessages(next);
};

export default function ExecPanel({ slug }: Props) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [execToken, setExecToken] = useState("");
  const [useStream, setUseStream] = useState(true);
  const [includeContext, setIncludeContext] = useState(false);
  const [followTail, setFollowTail] = useState(true);
  const [showDebugLog, setShowDebugLog] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStdout, setLiveStdout] = useState("");
  const [liveStderr, setLiveStderr] = useState("");
  const [streamMeta, setStreamMeta] = useState<{ exitCode?: number; durationMs?: number }>({});
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ExecTask[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedHistoryThreadId, setSelectedHistoryThreadId] = useState("");
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const currentThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    currentThreadIdRef.current = currentThreadId;
  }, [currentThreadId]);

  const loadTasks = useCallback(async () => {
    try {
      const data = await fetchExecTasks({ projectSlug: slug, execToken: execToken.trim() || undefined });
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

  const hydrateThreadMessages = useCallback(async (threadId: string, mode: "replace" | "merge" = "merge") => {
    const data = await fetchThreadMessages(threadId);
    const normalized = data.map(toChatMessage).filter((item): item is ChatMessage => item !== null);
    if (mode === "replace") {
      setMessages(dedupeCanonicalMessages(normalized));
      return;
    }
    setMessages((prev) => mergeHydratedMessages(prev, normalized));
  }, []);

  useEffect(() => {
    const rawHistory = window.localStorage.getItem(historyKey(slug));
    if (rawHistory) {
      try {
        const parsed = JSON.parse(rawHistory) as string[];
        if (Array.isArray(parsed)) {
          setPromptHistory(parsed.slice(0, 50));
        }
      } catch {
        // ignore
      }
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
      return;
    }
    window.localStorage.setItem(threadKey(slug), currentThreadId);
    setSelectedHistoryThreadId(currentThreadId);
    void hydrateThreadMessages(currentThreadId, "merge").catch(() => {
      // ignore hydrate failure in project console
    });
  }, [currentThreadId, hydrateThreadMessages, slug]);

  useEffect(() => {
    window.localStorage.setItem(chatCacheKey(slug), JSON.stringify(trimMessages(messages)));
  }, [messages, slug]);

  useEffect(() => {
    if (!followTail || !transcriptRef.current) {
      return;
    }
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [followTail, liveStdout, liveStderr, messages]);

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
        setCurrentThreadId(chunk.threadId);
      }

      const timestamp = new Date().toISOString();
      const messageId = chunk.itemId ? `assistant-${chunk.itemId}` : activeAssistantIdRef.current ?? `assistant-live-${Date.now()}`;
      activeAssistantIdRef.current = messageId;
      setMessages((prev) => upsertAssistantDelta(prev, messageId, chunk.data, timestamp));
      return;
    }

    if (chunk.type === "assistant_message") {
      setLiveStdout((prev) => appendChunk(prev, `${chunk.text}\n`));
      if (chunk.threadId) {
        setCurrentThreadId(chunk.threadId);
      }

      const timestamp = new Date().toISOString();
      const messageId = chunk.itemId ? `assistant-${chunk.itemId}` : activeAssistantIdRef.current ?? `assistant-live-${Date.now()}`;
      activeAssistantIdRef.current = messageId;
      setMessages((prev) => upsertAssistantMessage(prev, messageId, chunk.text, timestamp));
      return;
    }

    if (chunk.type === "end") {
      activeAssistantIdRef.current = null;
      setStreamMeta({
        exitCode: chunk.exitCode,
        durationMs: chunk.durationMs
      });
      return;
    }

    if (chunk.type === "error") {
      setError(chunk.message);
    }
  }, []);

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
      timestamp: nowIso
    };

    setLoading(true);
    setError(null);
    setLiveStdout("");
    setLiveStderr("");
    setStreamMeta({});
    setCurrentTaskId(null);
    setPrompt("");
    setShowDebugLog(false);
    activeAssistantIdRef.current = null;
    setMessages((prev) => trimMessages([...prev, pendingUserMessage]));

    const promptToSend = includeContext ? buildPromptWithContext(trimmed, [...messages, pendingUserMessage]) : trimmed;

    try {
      const nextHistory = [trimmed, ...promptHistory.filter((item) => item !== trimmed)].slice(0, 50);
      setPromptHistory(nextHistory);
      window.localStorage.setItem(historyKey(slug), JSON.stringify(nextHistory));
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
          onEvent: onStreamEvent
        });
      } else {
        const output = await runProjectExec(slug, promptToSend, model, execToken.trim() || undefined);
        setCurrentTaskId(output.taskId);
        setLiveStdout(output.stdout);
        setLiveStderr(output.stderr);
        setStreamMeta({ exitCode: output.exitCode, durationMs: output.durationMs });
        setMessages((prev) =>
          trimMessages([
            ...prev,
            {
              messageId: `assistant-non-stream-${Date.now()}`,
              role: "assistant",
              text: output.stdout || "(empty)",
              status: output.status,
              eventType: "exec.once",
              timestamp: new Date().toISOString()
            }
          ])
        );
      }

      setMessages((prev) =>
        prev.map((item) => (item.messageId === pendingUserMessage.messageId ? { ...item, status: "completed" } : item))
      );

      const runtimeThreadId = currentThreadIdRef.current;
      if (runtimeThreadId) {
        await hydrateThreadMessages(runtimeThreadId, "merge");
        window.setTimeout(() => {
          void hydrateThreadMessages(runtimeThreadId, "merge").catch(() => {
            // ignore delayed hydrate failure
          });
        }, 1200);
      } else {
        // no thread yet, keep local chat state
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "exec_failed");
      setMessages((prev) =>
        prev.map((item) => (item.messageId === pendingUserMessage.messageId ? { ...item, status: "failed" } : item))
      );
    } finally {
      setLoading(false);
      abortRef.current = null;
      void loadTasks();
      void loadThreads();
    }
  };

  const onCancel = async () => {
    if (!currentTaskId) {
      return;
    }
    try {
      await cancelExecTask(currentTaskId, { execToken: execToken.trim() || undefined });
      abortRef.current?.abort();
      setError("任务已取消");
      setLoading(false);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "cancel_failed");
    }
  };

  const onStartNewSession = () => {
    if (loading) {
      return;
    }
    setCurrentThreadId(null);
    currentThreadIdRef.current = null;
    setSelectedHistoryThreadId("");
    setCurrentTaskId(null);
    setMessages([]);
    setLiveStdout("");
    setLiveStderr("");
    setStreamMeta({});
    setError(null);
    activeAssistantIdRef.current = null;
    window.localStorage.removeItem(threadKey(slug));
    window.localStorage.removeItem(chatCacheKey(slug));
  };

  const onLoadHistoryThread = async () => {
    const threadId = selectedHistoryThreadId.trim();
    if (!threadId || loading) {
      return;
    }
    setError(null);
    setCurrentThreadId(threadId);
    currentThreadIdRef.current = threadId;
    try {
      await hydrateThreadMessages(threadId, "replace");
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_thread_history_failed");
    }
  };

  const onClearLocalHistory = () => {
    if (loading) {
      return;
    }
    setMessages([]);
    setPromptHistory([]);
    setHistoryCursor(-1);
    setError(null);
    window.localStorage.removeItem(chatCacheKey(slug));
    window.localStorage.removeItem(historyKey(slug));
  };

  const onKeyDownPrompt = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      setPrompt(next >= 0 ? promptHistory[next] ?? "" : "");
    }
  };

  const recentTasks = useMemo(() => tasks.slice(0, 8), [tasks]);
  const renderedMessages = useMemo(() => trimMessages(messages), [messages]);
  const summary = useMemo(
    () => ({
      total: renderedMessages.length,
      user: renderedMessages.filter((item) => item.role === "user").length,
      assistant: renderedMessages.filter((item) => item.role === "assistant").length
    }),
    [renderedMessages]
  );

  return (
    <section className="grid" style={{ gap: 12 }}>
      <section className="panel thread-header-panel">
        <div className="thread-title-row">
          <h2 style={{ margin: 0 }}>Codex 项目会话台</h2>
          <span className={`live-dot ${loading ? "online" : "offline"}`}>{loading ? "RUNNING" : "IDLE"}</span>
        </div>
        <div className="thread-meta-row">
          <span>消息 {summary.total}</span>
          <span>用户 {summary.user}</span>
          <span>助手 {summary.assistant}</span>
          <span>task {currentTaskId ?? "-"}</span>
          <span>
            {streamMeta.exitCode !== undefined ? `exit=${streamMeta.exitCode} ${streamMeta.durationMs ?? 0}ms` : loading ? "running..." : "idle"}
          </span>
          <span>thread {currentThreadId ?? "-"}</span>
        </div>
        <div className="thread-action-row">
          <button type="button" className="thread-btn" onClick={onStartNewSession} disabled={loading}>
            新会话
          </button>
          <button type="button" className="thread-btn" onClick={onClearLocalHistory} disabled={loading}>
            清空本地历史
          </button>
          <button type="button" className="thread-btn" onClick={() => setFollowTail((prev) => !prev)}>
            {followTail ? "关闭自动滚动" : "开启自动滚动"}
          </button>
          <button type="button" className="thread-btn" onClick={() => setShowDebugLog((prev) => !prev)}>
            {showDebugLog ? "隐藏调试流" : "显示调试流"}
          </button>
          <button type="button" className="thread-btn" onClick={() => void loadTasks()}>
            刷新任务
          </button>
          {currentThreadId ? (
            <Link className="thread-btn" href={`/threads/${encodeURIComponent(currentThreadId)}`}>
              打开完整 Thread
            </Link>
          ) : null}
        </div>
        <div className="thread-action-row">
          <select
            className="thread-input code"
            value={selectedHistoryThreadId}
            onChange={(event) => setSelectedHistoryThreadId(event.target.value)}
            disabled={loading}
            style={{ minWidth: 280 }}
          >
            <option value="">选择历史会话</option>
            {threads.map((thread) => (
              <option key={thread.thread_id} value={thread.thread_id}>
                {summarizeThreadLabel(thread)} | {new Date(thread.updated_at).toLocaleString()}
              </option>
            ))}
          </select>
          <button type="button" className="thread-btn" onClick={() => void onLoadHistoryThread()} disabled={!selectedHistoryThreadId || loading}>
            加载历史
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel">
          <div className="code" style={{ color: "#dc2626", whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        </section>
      ) : null}

      <section className="thread-layout">
        <article className="panel terminal-shell">
          <div className="terminal-head">project transcript</div>
          <div className="terminal-transcript" ref={transcriptRef}>
            {renderedMessages.length === 0 ? <div className="terminal-empty">暂无会话消息，发送第一条 prompt 开始。</div> : null}
            {renderedMessages.map((message) => (
              <div key={message.messageId} className={`terminal-row ${message.role}`}>
                <div className="terminal-prefix">
                  {message.role === "user" ? "you >" : "codex >"}
                  <span className="terminal-time">{formatTime(message.timestamp)}</span>
                </div>
                <pre className={`terminal-bubble ${message.role}`}>{message.text}</pre>
                <div className="terminal-footnote">
                  <span>{shortType(message.eventType)}</span>
                  <span>{message.status ?? "-"}</span>
                </div>
              </div>
            ))}
          </div>

          <form className="thread-composer" onSubmit={onSubmit}>
            <div className="thread-composer-row">
              <input
                className="thread-input code"
                value={execToken}
                onChange={(event) => setExecToken(event.target.value)}
                placeholder="可选：exec token（启用 EXEC_API_TOKEN 时必填）"
                disabled={loading}
              />
              <input
                className="thread-input code"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="可选模型，如 gpt-5-codex"
                disabled={loading}
              />
            </div>

            <div className="thread-composer-row code" style={{ color: "#d1d5db", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={useStream} onChange={(event) => setUseStream(event.target.checked)} disabled={loading} />
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
            </div>

            <div className="thread-composer-row">
              <textarea
                className="thread-textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={onKeyDownPrompt}
                placeholder="在当前项目中和 Codex 对话（Ctrl/Cmd+Enter 发送，Ctrl+↑/↓ 历史）"
                rows={4}
                disabled={loading}
              />
            </div>

            <div className="thread-composer-row">
              <button type="submit" className="thread-btn" disabled={loading || !prompt.trim()}>
                {loading ? "发送中..." : "发送"}
              </button>
              <button type="button" className="thread-btn" disabled={!loading || !currentTaskId} onClick={() => void onCancel()}>
                取消任务
              </button>
            </div>
          </form>

          {showDebugLog ? (
            <div className="stream-shell">
              <div className="stream-head">live stream debug</div>
              <pre className="stream-log">
                {liveStdout || liveStderr ? `${liveStdout}${liveStderr ? `\n[stderr]\n${liveStderr}` : ""}` : "等待输出..."}
              </pre>
            </div>
          ) : null}
        </article>

        <aside className="panel" style={{ display: "grid", gap: 10, alignContent: "start" }}>
          <div className="code">最近任务队列（自动刷新）</div>
          <div style={{ overflowX: "auto" }}>
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
                        disabled={!(task.status === "queued" || task.status === "running")}
                        onClick={() => void cancelExecTask(task.id, { execToken: execToken.trim() || undefined }).then(loadTasks)}
                        style={{ padding: "4px 8px", borderRadius: 0, border: "2px solid #7f1d1d", background: "#fee2e2", color: "#7f1d1d" }}
                      >
                        取消
                      </button>
                    </td>
                  </tr>
                ))}
                {recentTasks.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ color: "#64748b" }}>
                      暂无任务
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </aside>
      </section>
    </section>
  );
}
