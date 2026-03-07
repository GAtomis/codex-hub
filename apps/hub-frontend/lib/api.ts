const API_BASE = process.env.NEXT_PUBLIC_HUB_API_BASE ?? "http://127.0.0.1:4010";

const execTokenFromStorage = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem("codex_hub_exec_token");
  return value && value.trim() ? value.trim() : null;
};

const buildHeaders = (args?: { contentType?: boolean; execToken?: string | null }): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (args?.contentType) {
    headers["content-type"] = "application/json";
  }
  const token = args?.execToken ?? execTokenFromStorage();
  if (token) {
    headers["x-exec-token"] = token;
  }
  return headers;
};

const parseError = (status: number, data: unknown): Error => {
  const message =
    typeof (data as Record<string, unknown>)?.error === "string"
      ? ((data as Record<string, unknown>).error as string)
      : `request_failed_${status}`;
  return new Error(message);
};

const request = async <T>(path: string, args?: { execToken?: string | null }): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: buildHeaders({ execToken: args?.execToken })
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    throw parseError(response.status, data);
  }
  return data as T;
};

const requestPost = async <T>(
  path: string,
  body: Record<string, unknown> = {},
  args?: { execToken?: string | null; signal?: AbortSignal; method?: "POST" | "PUT" }
): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    method: args?.method ?? "POST",
    headers: buildHeaders({ contentType: true, execToken: args?.execToken }),
    body: JSON.stringify(body),
    signal: args?.signal
  });

  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    data = { error: text || `request_failed_${response.status}` };
  }
  if (!response.ok) {
    throw parseError(response.status, data);
  }
  return data as T;
};

export type Overview = {
  projectCount: number;
  threadStatus: Array<{ status: string; count: number }>;
  recentEvents: Array<{
    event_id: string;
    project_slug: string;
    thread_id: string;
    turn_id: string | null;
    event_type: string;
    status: string | null;
    title: string | null;
    error_message: string | null;
    event_ts: string;
  }>;
};

export type Project = {
  slug: string;
  name: string;
  path: string;
  status: string;
  last_seen_at: string;
  thread_count: number;
};

export type ProjectRecord = {
  slug: string;
  name: string;
  path: string;
  status?: string;
  last_seen_at?: string;
};

export type Thread = {
  thread_id: string;
  project_slug: string;
  title: string | null;
  status: string | null;
  started_at: string | null;
  updated_at: string;
  last_turn_id: string | null;
  first_user_prompt?: string | null;
};

export type EventItem = {
  event_id: string;
  project_slug: string;
  thread_id: string;
  turn_id: string | null;
  event_type: string;
  status: string | null;
  title: string | null;
  error_message: string | null;
  payload_json: Record<string, unknown>;
  event_ts: string;
};

export type ThreadMessage = {
  messageId: string;
  eventType: string;
  role: string;
  text: string;
  status: string | null;
  timestamp: string;
};

export type ProjectExecResult = {
  taskId: string;
  status: string;
  queuePosition: number;
  projectSlug: string;
  projectName: string;
  command: string[];
  durationMs: number;
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type AgentStatus = "starting" | "running" | "stopped" | "failed";

export type ManagedAgent = {
  id: string;
  status: AgentStatus;
  projectSlug: string;
  projectName: string;
  projectPath: string;
  sessionsRoot: string;
  scanIntervalMs: number;
  maxFiles: number;
  stateFile: string;
  hubUrl: string;
  autoStart: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  stdoutTail: string;
  stderrTail: string;
};

export type AgentListResponse = {
  total: number;
  agents: ManagedAgent[];
};

export type ExecTask = {
  id: string;
  projectSlug: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  model: string | null;
  command: string[];
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  canceled: boolean;
  queuePosition: number;
  stdout: string;
  stderr: string;
};

export type ExecStreamEvent =
  | { type: "queued"; taskId: string; queuePosition: number }
  | { type: "start"; taskId: string; projectSlug: string; projectName: string; command: string[]; timestamp: string; threadId?: string | null }
  | { type: "thread"; taskId: string; threadId: string }
  | { type: "stdout"; taskId: string; data: string }
  | { type: "stderr"; taskId: string; data: string }
  | { type: "assistant_delta"; taskId: string; data: string; itemId?: string | null; threadId?: string | null; turnId?: string | null }
  | { type: "assistant_message"; taskId: string; text: string; itemId?: string | null; threadId?: string | null; turnId?: string | null }
  | { type: "error"; taskId?: string; message: string }
  | { type: "end"; taskId: string; exitCode: number; signal: string | null; durationMs: number };

export type ThreadExecStreamEvent = ExecStreamEvent;

export const fetchOverview = (): Promise<Overview> => request<Overview>("/v1/overview");
export const fetchProjects = (): Promise<Project[]> => request<Project[]>("/v1/projects");
export const fetchThreads = (slug: string): Promise<Thread[]> =>
  request<Thread[]>(`/v1/projects/${encodeURIComponent(slug)}/threads?limit=200`);
export const fetchThreadEvents = (threadId: string): Promise<EventItem[]> =>
  request<EventItem[]>(`/v1/threads/${encodeURIComponent(threadId)}/events?limit=300`);
export const fetchThreadMessages = (threadId: string): Promise<ThreadMessage[]> =>
  request<ThreadMessage[]>(`/v1/threads/${encodeURIComponent(threadId)}/messages?limit=400`);

export const registerProject = (
  input: { slug: string; name: string; path: string }
): Promise<{ ok: boolean; project: ProjectRecord; validation: Record<string, unknown> }> =>
  requestPost<{ ok: boolean; project: ProjectRecord; validation: Record<string, unknown> }>("/v1/projects/register", input);
export const updateProject = (
  slug: string,
  input: { name?: string; path?: string; status?: string }
): Promise<{ ok: boolean; project: ProjectRecord }> =>
  requestPost<{ ok: boolean; project: ProjectRecord }>(`/v1/projects/${encodeURIComponent(slug)}`, input, { method: "PUT" });
export const validateProjectPath = (slug: string, path?: string): Promise<{ ok: boolean; path: string; detail: Record<string, unknown> }> =>
  requestPost<{ ok: boolean; path: string; detail: Record<string, unknown> }>(`/v1/projects/${encodeURIComponent(slug)}/validate-path`, {
    path
  });

export const fetchAgents = (): Promise<AgentListResponse> => request<AgentListResponse>("/v1/agents");
export const startAgent = (input: {
  projectSlug: string;
  projectName?: string;
  projectPath?: string;
  sessionsRoot?: string;
  scanIntervalMs?: number;
  maxFiles?: number;
  stateFile?: string;
  hubUrl?: string;
  ingestApiKey?: string;
}): Promise<{ ok: boolean; agent: ManagedAgent }> => requestPost<{ ok: boolean; agent: ManagedAgent }>("/v1/agents/start", input);
export const stopAgent = (agentId: string): Promise<{ ok: boolean; agent: ManagedAgent }> =>
  requestPost<{ ok: boolean; agent: ManagedAgent }>(`/v1/agents/${encodeURIComponent(agentId)}/stop`);
export const deleteAgent = (agentId: string): Promise<{ ok: boolean }> =>
  requestPost<{ ok: boolean }>(`/v1/agents/${encodeURIComponent(agentId)}/delete`);

export const fetchExecTasks = (args?: { projectSlug?: string; execToken?: string | null }): Promise<{ tasks: ExecTask[] }> => {
  const query = args?.projectSlug ? `?projectSlug=${encodeURIComponent(args.projectSlug)}` : "";
  return request<{ tasks: ExecTask[] }>(`/v1/exec/tasks${query}`, { execToken: args?.execToken });
};
export const cancelExecTask = (taskId: string, args?: { execToken?: string | null }): Promise<{ ok: boolean; task: ExecTask }> =>
  requestPost<{ ok: boolean; task: ExecTask }>(`/v1/exec/tasks/${encodeURIComponent(taskId)}/cancel`, {}, { execToken: args?.execToken });

export const runProjectExec = async (
  slug: string,
  prompt: string,
  model?: string,
  execToken?: string | null
): Promise<ProjectExecResult> => {
  return requestPost<ProjectExecResult>(
    `/v1/projects/${encodeURIComponent(slug)}/exec`,
    {
      prompt,
      model: model?.trim() ? model.trim() : undefined
    },
    { execToken }
  );
};

export const streamProjectExec = async (args: {
  slug: string;
  prompt: string;
  model?: string;
  threadId?: string;
  execToken?: string | null;
  signal?: AbortSignal;
  onEvent: (event: ExecStreamEvent) => void;
}): Promise<void> => {
  const response = await fetch(`${API_BASE}/v1/projects/${encodeURIComponent(args.slug)}/exec/stream`, {
    method: "POST",
    headers: buildHeaders({ contentType: true, execToken: args.execToken }),
    body: JSON.stringify({
      prompt: args.prompt,
      model: args.model?.trim() ? args.model.trim() : undefined,
      threadId: args.threadId?.trim() ? args.threadId.trim() : undefined
    }),
    signal: args.signal
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`stream_failed_${response.status}: ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("stream_reader_unavailable");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        args.onEvent(JSON.parse(line) as ExecStreamEvent);
      } catch {
        // ignore malformed chunk
      }
    }
  }
};

export const streamThreadExec = async (args: {
  threadId: string;
  prompt: string;
  model?: string;
  execToken?: string | null;
  signal?: AbortSignal;
  onEvent: (event: ThreadExecStreamEvent) => void;
}): Promise<void> => {
  const response = await fetch(`${API_BASE}/v1/threads/${encodeURIComponent(args.threadId)}/exec/stream`, {
    method: "POST",
    headers: buildHeaders({ contentType: true, execToken: args.execToken }),
    body: JSON.stringify({
      prompt: args.prompt,
      model: args.model?.trim() ? args.model.trim() : undefined
    }),
    signal: args.signal
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`stream_failed_${response.status}: ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("stream_reader_unavailable");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        args.onEvent(JSON.parse(line) as ThreadExecStreamEvent);
      } catch {
        // ignore malformed chunk
      }
    }
  }
};
