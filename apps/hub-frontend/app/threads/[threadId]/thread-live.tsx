"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchThreadEvents,
  fetchThreadMessages,
  streamThreadExec,
  type EventItem,
  type ThreadExecStreamEvent,
  type ThreadMessage
} from "../../../lib/api";

const API_BASE = process.env.NEXT_PUBLIC_HUB_API_BASE ?? "http://127.0.0.1:4010";

type Props = {
  threadId: string;
};

type DisplayLengthMap = Record<string, number>;
type HubLiveEvent = {
  eventId?: unknown;
  threadId?: unknown;
  type?: unknown;
  status?: unknown;
  title?: unknown;
  errorMessage?: unknown;
  timestamp?: unknown;
  payload?: unknown;
};

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const normalizeDisplayLengths = (messages: ThreadMessage[], prev: DisplayLengthMap): DisplayLengthMap => {
  const next: DisplayLengthMap = {};
  for (const message of messages) {
    const existing = prev[message.messageId];
    if (typeof existing === "number") {
      next[message.messageId] = Math.min(existing, message.text.length);
      continue;
    }
    next[message.messageId] = message.role === "assistant" ? 0 : message.text.length;
  }
  return next;
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

const upsertMessage = (list: ThreadMessage[], incoming: ThreadMessage): ThreadMessage[] => {
  const idx = list.findIndex((item) => item.messageId === incoming.messageId);
  if (idx < 0) {
    return [...list, incoming].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  const next = [...list];
  next[idx] = incoming;
  return next;
};

const toMessageFromLiveEvent = (event: HubLiveEvent): ThreadMessage | null => {
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  const roleFromPayload = typeof payload.role === "string" ? payload.role : null;
  const textFromPayload = typeof payload.message_text === "string" ? payload.message_text : null;
  const type = typeof event.type === "string" ? event.type : "";
  const role =
    roleFromPayload ??
    (type.includes("user") ? "user" : null) ??
    (type.includes("assistant") || type.includes("agent") ? "assistant" : null);
  const fallbackText =
    (typeof event.title === "string" && event.title) ||
    (typeof event.errorMessage === "string" && event.errorMessage) ||
    null;
  const text = textFromPayload ?? fallbackText;
  if (!text || (role !== "user" && role !== "assistant")) {
    return null;
  }
  if (role === "user" && (text.includes("AGENTS.md instructions for") || text.includes("<INSTRUCTIONS>"))) {
    return null;
  }

  const messageId = typeof event.eventId === "string" ? event.eventId : null;
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
  if (!messageId) {
    return null;
  }
  return {
    messageId,
    eventType: type || "live.event",
    role,
    text,
    status: typeof event.status === "string" ? event.status : null,
    timestamp
  };
};

export default function ThreadLive({ threadId }: Props) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [displayLengths, setDisplayLengths] = useState<DisplayLengthMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followTail, setFollowTail] = useState(true);
  const [showTimeline, setShowTimeline] = useState(true);
  const [liveConnected, setLiveConnected] = useState(false);
  const [promptInput, setPromptInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamLog, setStreamLog] = useState("");
  const [showStreamLog, setShowStreamLog] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [optimisticUser, setOptimisticUser] = useState<ThreadMessage | null>(null);
  const [liveAssistant, setLiveAssistant] = useState<ThreadMessage | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const codexJsonBufferRef = useRef("");

  const refresh = useCallback(async () => {
    try {
      const [nextMessages, nextEvents] = await Promise.all([fetchThreadMessages(threadId), fetchThreadEvents(threadId)]);
      setMessages(nextMessages);
      setEvents(nextEvents);
      setDisplayLengths((prev) => normalizeDisplayLengths(nextMessages, prev));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const combined = [
        ...messages,
        ...(optimisticUser ? [optimisticUser] : []),
        ...(liveAssistant ? [liveAssistant] : [])
      ];
      setDisplayLengths((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const message of combined) {
          if (message.role !== "assistant") {
            continue;
          }
          const current = next[message.messageId] ?? 0;
          if (current < message.text.length) {
            next[message.messageId] = Math.min(message.text.length, current + 3);
            changed = true;
            break;
          }
        }
        return changed ? next : prev;
      });
    }, 18);

    return () => {
      window.clearInterval(timer);
    };
  }, [liveAssistant, messages, optimisticUser]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => {
      void refresh();
    }, 30000);

    const source = new EventSource(`${API_BASE}/v1/stream/events`);
    source.onopen = () => {
      setLiveConnected(true);
    };
    source.onerror = () => {
      setLiveConnected(false);
    };
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as HubLiveEvent;
        if (typeof payload.threadId !== "string" || payload.threadId !== threadId) {
          return;
        }

        const incoming = toMessageFromLiveEvent(payload);
        if (incoming) {
          setMessages((prev) => upsertMessage(prev, incoming));
          setDisplayLengths((prev) => ({
            ...prev,
            [incoming.messageId]:
              incoming.role === "assistant" ? Math.min(prev[incoming.messageId] ?? 0, incoming.text.length) : incoming.text.length
          }));
        }

        setEvents((prev) => {
          const eventId = typeof payload.eventId === "string" ? payload.eventId : null;
          const eventType = typeof payload.type === "string" ? payload.type : null;
          const eventTs = typeof payload.timestamp === "string" ? payload.timestamp : null;
          if (!eventId || !eventType || !eventTs) {
            return prev;
          }
          if (prev.some((item) => item.event_id === eventId)) {
            return prev;
          }
          const eventRecord: EventItem = {
            event_id: eventId,
            project_slug: "",
            thread_id: threadId,
            turn_id: null,
            event_type: eventType,
            status: typeof payload.status === "string" ? payload.status : null,
            title: typeof payload.title === "string" ? payload.title : null,
            error_message: typeof payload.errorMessage === "string" ? payload.errorMessage : null,
            payload_json: payload.payload && typeof payload.payload === "object" ? (payload.payload as Record<string, unknown>) : {},
            event_ts: eventTs
          };
          return [eventRecord, ...prev].slice(0, 300);
        });

        if (sending && incoming?.role === "user") {
          setOptimisticUser((prev) => (prev?.text === incoming.text ? null : prev));
        }
      } catch {
        // ignore malformed events
      }
    };

    return () => {
      window.clearInterval(poll);
      source.close();
    };
  }, [refresh, sending, threadId]);

  const renderedMessages = useMemo(() => {
    const list = [...messages];
    if (optimisticUser) {
      list.push(optimisticUser);
    }
    if (liveAssistant) {
      list.push(liveAssistant);
    }
    return list;
  }, [messages, optimisticUser, liveAssistant]);

  useEffect(() => {
    if (!followTail || !transcriptRef.current) {
      return;
    }
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [displayLengths, followTail, renderedMessages, streamLog]);

  const messageSummary = useMemo(
    () => ({
      total: messages.length,
      user: messages.filter((item) => item.role === "user").length,
      assistant: messages.filter((item) => item.role === "assistant").length
    }),
    [messages]
  );

  const onStreamEvent = useCallback(
    (event: ThreadExecStreamEvent): void => {
      if (event.type === "queued") {
        setStreamLog((prev) => appendChunk(prev, `[queued] position=${event.queuePosition}\n`));
        return;
      }
      if (event.type === "start") {
        setStreamLog((prev) => appendChunk(prev, `[start] ${event.command.join(" ")}\n`));
        return;
      }
      if (event.type === "error") {
        setStreamLog((prev) => appendChunk(prev, `[error] ${event.message}\n`));
        return;
      }
      if (event.type === "end") {
        setStreamLog((prev) => appendChunk(prev, `[end] exit=${event.exitCode} duration=${event.durationMs}ms\n`));
        return;
      }
      if (event.type === "stderr") {
        setStreamLog((prev) => appendChunk(prev, event.data));
        return;
      }
      if (event.type === "assistant_delta") {
        setStreamLog((prev) => appendChunk(prev, event.data));
        setLiveAssistant((prev) => {
          const message: ThreadMessage =
            prev ?? {
              messageId: `live-assistant-${event.itemId ?? Date.now()}`,
              eventType: "live.agent_message.delta",
              role: "assistant",
              text: "",
              status: "running",
              timestamp: new Date().toISOString()
            };
          const nextMessage = {
            ...message,
            text: `${message.text}${event.data}`
          };
          setDisplayLengths((displayPrev) => ({
            ...displayPrev,
            [nextMessage.messageId]: nextMessage.text.length
          }));
          return nextMessage;
        });
        return;
      }
      if (event.type === "assistant_message") {
        setLiveAssistant((prev) => {
          const message: ThreadMessage =
            prev ?? {
              messageId: `live-assistant-${event.itemId ?? Date.now()}`,
              eventType: "live.agent_message.completed",
              role: "assistant",
              text: "",
              status: "completed",
              timestamp: new Date().toISOString()
            };
          const nextMessage = {
            ...message,
            text: event.text,
            status: "completed"
          };
          setDisplayLengths((displayPrev) => ({
            ...displayPrev,
            [nextMessage.messageId]: nextMessage.text.length
          }));
          return nextMessage;
        });
        return;
      }
      if (event.type !== "stdout") {
        return;
      }

      setStreamLog((prev) => appendChunk(prev, event.data));
      if (!event.data.trimStart().startsWith("{")) {
        return;
      }
      codexJsonBufferRef.current += event.data;
      const lines = codexJsonBufferRef.current.split("\n");
      codexJsonBufferRef.current = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
          };
          if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
            const assistantText = parsed.item.text;
            setLiveAssistant((prev) => {
              const message: ThreadMessage =
                prev ?? {
                  messageId: `live-assistant-${Date.now()}`,
                  eventType: "live.agent_message",
                  role: "assistant",
                  text: "",
                  status: "running",
                  timestamp: new Date().toISOString()
                };
              const nextMessage = {
                ...message,
                text: message.text ? `${message.text}\n${assistantText}` : assistantText
              };
              setDisplayLengths((displayPrev) => ({
                ...displayPrev,
                [nextMessage.messageId]: Math.min(displayPrev[nextMessage.messageId] ?? 0, nextMessage.text.length)
              }));
              return nextMessage;
            });
          }
          if (parsed.type === "turn.completed") {
            setOptimisticUser(null);
            setLiveAssistant(null);
            void refresh();
          }
        } catch {
          // ignore malformed json lines in stream
        }
      }
    },
    [refresh]
  );

  const handleSend = useCallback(async () => {
    const prompt = promptInput.trim();
    if (!prompt || sending) {
      return;
    }

    const nowIso = new Date().toISOString();
    setSending(true);
    setRunError(null);
    setStreamLog("");
    setOptimisticUser({
      messageId: `pending-user-${Date.now()}`,
      eventType: "live.user_prompt",
      role: "user",
      text: prompt,
      status: "running",
      timestamp: nowIso
    });
    setLiveAssistant(null);
    setShowStreamLog(false);
    codexJsonBufferRef.current = "";
    setPromptInput("");

    try {
      await streamThreadExec({
        threadId,
        prompt,
        model: modelInput.trim() || undefined,
        onEvent: onStreamEvent
      });
      setOptimisticUser(null);
      setLiveAssistant(null);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "stream_failed";
      setRunError(message);
      setStreamLog((prev) => appendChunk(prev, `\n[request_failed] ${message}\n`));
    } finally {
      setSending(false);
    }
  }, [modelInput, onStreamEvent, promptInput, refresh, sending, threadId]);

  const onPromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSend();
    }
  };

  return (
    <main className="grid" style={{ gap: 20 }}>
      <div>
        <Link href="/">返回总览</Link>
      </div>

      <section className="panel thread-header-panel">
        <div className="thread-title-row">
          <h1 style={{ margin: 0 }}>Thread: {threadId}</h1>
          <span className={`live-dot ${liveConnected ? "online" : "offline"}`}>{liveConnected ? "LIVE" : "RECONNECTING"}</span>
        </div>
        <div className="thread-meta-row">
          <span>消息 {messageSummary.total}</span>
          <span>用户 {messageSummary.user}</span>
          <span>助手 {messageSummary.assistant}</span>
          <span>事件 {events.length}</span>
        </div>
        <div className="thread-action-row">
          <button type="button" className="thread-btn" onClick={() => void refresh()}>
            刷新
          </button>
          <button type="button" className="thread-btn" onClick={() => setFollowTail((prev) => !prev)}>
            {followTail ? "关闭自动滚动" : "开启自动滚动"}
          </button>
          <button type="button" className="thread-btn" onClick={() => setShowTimeline((prev) => !prev)}>
            {showTimeline ? "隐藏事件时间线" : "显示事件时间线"}
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel">
          <div className="code" style={{ color: "#dc2626" }}>
            {error}
          </div>
        </section>
      ) : null}

      <section className="thread-layout">
        <article className="panel terminal-shell">
          <div className="terminal-head">codex-cli transcript</div>
          <div className="terminal-transcript" ref={transcriptRef}>
            {loading ? <div className="terminal-empty">加载中...</div> : null}
            {!loading && renderedMessages.length === 0 ? <div className="terminal-empty">暂无可展示的对话消息</div> : null}
            {renderedMessages.map((message) => {
              const shownLength = displayLengths[message.messageId] ?? message.text.length;
              const shownText = message.text.slice(0, shownLength);
              const typing = message.role === "assistant" && shownLength < message.text.length;
              return (
                <div key={message.messageId} className={`terminal-row ${message.role}`}>
                  <div className="terminal-prefix">
                    {message.role === "user" ? "you >" : "codex >"}
                    <span className="terminal-time">{formatTime(message.timestamp)}</span>
                  </div>
                  <pre className={`terminal-bubble ${message.role}`}>
                    {shownText}
                    {typing ? <span className="terminal-cursor" aria-hidden="true" /> : null}
                  </pre>
                  <div className="terminal-footnote">
                    <span>{shortType(message.eventType)}</span>
                    <span>{message.status ?? "-"}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="thread-composer">
            <div className="thread-composer-row">
              <input
                className="thread-input"
                value={modelInput}
                onChange={(event) => setModelInput(event.target.value)}
                placeholder="可选模型，如 gpt-5-codex"
                disabled={sending}
              />
            </div>
            <div className="thread-composer-row">
              <textarea
                className="thread-textarea"
                value={promptInput}
                onChange={(event) => setPromptInput(event.target.value)}
                onKeyDown={onPromptKeyDown}
                placeholder="在当前 thread 中继续和 Codex 对话..."
                rows={3}
                disabled={sending}
              />
              <button type="button" className="thread-btn" onClick={() => void handleSend()} disabled={sending || !promptInput.trim()}>
                {sending ? "发送中..." : "发送"}
              </button>
            </div>
            <div className="thread-composer-row">
              <button type="button" className="thread-btn" onClick={() => setShowStreamLog((prev) => !prev)}>
                {showStreamLog ? "隐藏调试流" : "显示调试流"}
              </button>
            </div>
            {runError ? <div className="thread-run-error code">{runError}</div> : null}
          </div>

          {showStreamLog ? (
            <div className="stream-shell">
              <div className="stream-head">live stream debug</div>
              <pre className="stream-log">{streamLog || "等待输出..."}</pre>
            </div>
          ) : null}
        </article>

        {showTimeline ? (
          <aside className="panel timeline-shell">
            <div className="timeline-head">event timeline</div>
            <div className="timeline-list">
              {events.map((event) => (
                <div key={event.event_id} className="timeline-item">
                  <div className="timeline-type">{event.event_type}</div>
                  <div className="timeline-time">{formatTime(event.event_ts)}</div>
                  <div className="timeline-meta">
                    <span>{event.status ?? "-"}</span>
                    {event.turn_id ? <span className="code">{event.turn_id}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        ) : null}
      </section>
    </main>
  );
}
