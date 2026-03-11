const API_BASE =
  process.env.NEXT_PUBLIC_HUB_API_BASE ?? "http://127.0.0.1:4010";

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const normalizeProjectSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[‒–—―]/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

export const validateProjectSlug = (value: string): string | null => {
  const normalized = normalizeProjectSlug(value);
  if (!normalized) {
    return "slug 不能为空。建议使用小写字母、数字和短横线，例如 `you-gi-wang`。";
  }
  if (!PROJECT_SLUG_PATTERN.test(normalized)) {
    return "slug 只能包含小写字母、数字和短横线，不能使用空格、中文或特殊横线。";
  }
  if (normalized !== value.trim()) {
    return `建议使用规范 slug：${normalized}`;
  }
  return null;
};

export const describeAppError = (message: string): string => {
  if (!message) {
    return "操作失败，请重试。";
  }

  const raw = message.trim();

  if (raw.includes("project_not_found")) {
    return "当前项目未注册到 Hub。请先在首页注册项目，或检查当前项目 slug 是否和页面地址完全一致。";
  }
  if (raw.includes("project_info_required")) {
    return "项目信息不完整。请补全项目名称和项目路径后，再启动 Agent。";
  }
  if (raw.includes("invalid_project_path")) {
    return "项目路径不可用。请确认目录存在，并且后端进程有权限访问该路径。";
  }
  if (raw.includes("project_slug_required")) {
    return "请先填写项目 slug。slug 建议只使用小写字母、数字和短横线。";
  }
  if (raw.includes("agent_exists")) {
    return "这个项目的采集 Agent 已经在运行，无需重复启动。";
  }
  if (raw.includes("cors_origin_not_allowed")) {
    return "当前前端来源未被后端允许。请检查 `CORS_ORIGIN` 配置。";
  }
  if (raw.includes("stream_reader_unavailable")) {
    return "流式连接已建立，但浏览器未能读取返回流。建议刷新页面后重试。";
  }
  if (raw.includes("exec_failed") || raw.includes("stream_failed_500")) {
    return "本轮会话未能正常启动。请检查后端日志、项目路径和本机 `codex app-server` 是否可用。";
  }
  if (raw.includes("stream_failed_404")) {
    return "当前目标不存在，通常是项目 slug 或 thread id 不正确。请刷新页面后重新选择项目或会话。";
  }
  if (raw.includes("stream_failed_403")) {
    return "当前请求被后端拒绝。请检查执行 token、IP 白名单或跨域配置。";
  }
  if (raw.includes("load_failed")) {
    return "加载数据失败。请确认前后端服务都已启动，并刷新页面重试。";
  }
  if (raw.includes("register_failed")) {
    return "项目注册失败。请检查 slug、项目路径和后端数据库连接。";
  }
  if (raw.includes("update_failed")) {
    return "项目更新失败。请稍后重试，或检查数据库连接是否正常。";
  }
  if (raw.includes("confirm_slug_mismatch")) {
    return "确认失败：请输入完整的项目 slug，避免误清空历史。";
  }
  if (raw.includes("project_retired")) {
    return "这个项目已经移出监控。若要继续使用，请先在项目管理中恢复。";
  }
  if (raw.includes("lifecycle_failed")) {
    return "项目退出管理操作失败。请稍后重试，或检查后端日志。";
  }
  if (raw.includes("validate_failed")) {
    return "路径校验失败。请确认后端服务在线，并检查项目路径是否正确。";
  }
  if (raw.includes("start_agent_failed")) {
    return "启动 Agent 失败。请检查项目路径、sessions 目录和后端日志。";
  }
  if (raw.includes("stop_agent_failed")) {
    return "停止 Agent 失败。Agent 进程可能已经退出，建议刷新列表确认状态。";
  }
  if (raw.includes("delete_agent_failed")) {
    return "删除 Agent 失败。请先停止 Agent，再尝试删除。";
  }
  if (raw.includes("load_agents_failed")) {
    return "Agent 列表加载失败。请检查后端服务是否正常。";
  }
  if (raw.includes("cancel_failed")) {
    return "取消任务失败。请稍后重试，或到任务队列确认是否已经结束。";
  }
  if (raw.includes("load_thread_history_failed")) {
    return "加载会话历史失败。请刷新页面，或检查该 thread 是否仍然存在。";
  }
  if (raw.includes("invalid_project_file_reference")) {
    return "引用的项目文件无效。请重新选择文件，或确认它仍然存在于当前项目目录中。";
  }
  if (raw.includes("load_project_files_failed")) {
    return "项目文件列表加载失败。请检查项目路径、执行 token 和后端服务状态。";
  }
  if (raw.includes("directory_picker_unavailable")) {
    return "当前系统没有可用的本地目录选择器。你仍然可以手动填写项目路径。";
  }
  if (raw.includes("directory_picker_unsupported")) {
    return "当前后端运行环境暂不支持原生目录选择。请手动填写项目路径。";
  }
  if (raw.includes("directory_picker_failed")) {
    return "打开本地文件夹选择器失败。请重试，或直接手动填写项目路径。";
  }
  return raw;
};

const execTokenFromStorage = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem("codex_hub_exec_token");
  return value && value.trim() ? value.trim() : null;
};

const buildHeaders = (args?: {
  contentType?: boolean;
  execToken?: string | null;
}): Record<string, string> => {
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

const request = async <T>(
  path: string,
  args?: { execToken?: string | null },
): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: buildHeaders({ execToken: args?.execToken }),
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
  args?: {
    execToken?: string | null;
    signal?: AbortSignal;
    method?: "POST" | "PUT";
  },
): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    method: args?.method ?? "POST",
    headers: buildHeaders({ contentType: true, execToken: args?.execToken }),
    body: JSON.stringify(body),
    signal: args?.signal,
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
  retired_at?: string | null;
  retirement_mode?: string | null;
};

export type ProjectRecord = {
  slug: string;
  name: string;
  path: string;
  status?: string;
  last_seen_at?: string;
  retired_at?: string | null;
  retirement_mode?: string | null;
};

export type ProjectLifecyclePreview = {
  project: {
    slug: string;
    name: string;
    path: string;
    status: string;
    lastSeenAt: string;
    retiredAt: string | null;
    retirementMode: string | null;
  };
  impact: {
    threadCount: number;
    turnCount: number;
    eventCount: number;
    agentCount: number;
    activeTaskCount: number;
    localFilesAffected: boolean;
  };
};

export type ProjectLifecycleAction = "archive" | "detach" | "restore" | "purge";

export type ProjectLifecycleResult = {
  ok: boolean;
  action: ProjectLifecycleAction;
  project: {
    slug: string;
    name: string;
    path: string;
    status: string;
    last_seen_at?: string;
    lastSeenAt?: string;
    retired_at?: string | null;
    retiredAt?: string | null;
    retirement_mode?: string | null;
    retirementMode?: string | null;
  };
  impact: ProjectLifecyclePreview["impact"];
  runtimeChange: { removedAgents: number; canceledTasks: number };
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

export type ProjectFileMatch = {
  path: string;
  name: string;
};

export type ProjectFileContext = {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  tooLarge: boolean;
  size: number;
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
  turnId?: string | null;
  eventType: string;
  role: string;
  text: string;
  status: string | null;
  timestamp: string;
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

export type ThreadTranscript = {
  context: TranscriptContext;
  turns: TranscriptTurn[];
  events: TranscriptEvent[];
  messages: ThreadMessage[];
  changeSummaries: TranscriptChangeSummary[];
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
  | {
      type: "start";
      taskId: string;
      projectSlug: string;
      projectName: string;
      command: string[];
      timestamp: string;
      threadId?: string | null;
    }
  | { type: "thread"; taskId: string; threadId: string }
  | { type: "stdout"; taskId: string; data: string }
  | { type: "stderr"; taskId: string; data: string }
  | {
      type: "assistant_delta";
      taskId: string;
      data: string;
      itemId?: string | null;
      threadId?: string | null;
      turnId?: string | null;
    }
  | {
      type: "assistant_message";
      taskId: string;
      text: string;
      itemId?: string | null;
      threadId?: string | null;
      turnId?: string | null;
    }
  | { type: "error"; taskId?: string; message: string }
  | {
      type: "end";
      taskId: string;
      exitCode: number;
      signal: string | null;
      durationMs: number;
    };

export type ThreadExecStreamEvent = ExecStreamEvent;

export const fetchOverview = (): Promise<Overview> =>
  request<Overview>("/v1/overview");
export const fetchProjects = (args?: {
  includeRetired?: boolean;
}): Promise<Project[]> => {
  const query = args?.includeRetired ? "?includeRetired=true" : "";
  return request<Project[]>("/v1/projects" + query);
};
export const fetchThreads = (slug: string): Promise<Thread[]> =>
  request<Thread[]>(
    `/v1/projects/${encodeURIComponent(slug)}/threads?limit=200`,
  );
export const fetchProjectFileMatches = (
  slug: string,
  query: string,
  args?: { limit?: number; execToken?: string | null },
): Promise<{ files: ProjectFileMatch[] }> =>
  request<{ files: ProjectFileMatch[] }>(
    `/v1/projects/${encodeURIComponent(slug)}/files/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(args?.limit ?? 12))}`,
    { execToken: args?.execToken },
  );
export const fetchProjectFileContexts = (
  slug: string,
  paths: string[],
  args?: { execToken?: string | null; signal?: AbortSignal },
): Promise<{ files: ProjectFileContext[] }> =>
  requestPost<{ files: ProjectFileContext[] }>(
    `/v1/projects/${encodeURIComponent(slug)}/files/context`,
    { paths },
    { execToken: args?.execToken, signal: args?.signal },
  );
export const fetchThreadEvents = (threadId: string): Promise<EventItem[]> =>
  request<EventItem[]>(
    `/v1/threads/${encodeURIComponent(threadId)}/events?limit=300`,
  );
export const fetchThreadMessages = (
  threadId: string,
): Promise<ThreadMessage[]> =>
  request<ThreadMessage[]>(
    `/v1/threads/${encodeURIComponent(threadId)}/messages?limit=400`,
  );
export const fetchThreadTranscript = (
  threadId: string,
  args?: { limit?: number },
): Promise<ThreadTranscript> =>
  request<ThreadTranscript>(
    `/v1/threads/${encodeURIComponent(threadId)}/transcript?limit=${encodeURIComponent(String(args?.limit ?? 600))}`,
  );

export const registerProject = (input: {
  slug: string;
  name: string;
  path: string;
}): Promise<{
  ok: boolean;
  project: ProjectRecord;
  validation: Record<string, unknown>;
}> =>
  requestPost<{
    ok: boolean;
    project: ProjectRecord;
    validation: Record<string, unknown>;
  }>("/v1/projects/register", input);
export const updateProject = (
  slug: string,
  input: { name?: string; path?: string; status?: string },
): Promise<{ ok: boolean; project: ProjectRecord }> =>
  requestPost<{ ok: boolean; project: ProjectRecord }>(
    `/v1/projects/${encodeURIComponent(slug)}`,
    input,
    { method: "PUT" },
  );
export const validateProjectPath = (
  slug: string,
  path?: string,
): Promise<{ ok: boolean; path: string; detail: Record<string, unknown> }> =>
  requestPost<{ ok: boolean; path: string; detail: Record<string, unknown> }>(
    `/v1/projects/${encodeURIComponent(slug)}/validate-path`,
    {
      path,
    },
  );
export const fetchProjectLifecyclePreview = (
  slug: string,
): Promise<ProjectLifecyclePreview> =>
  request<ProjectLifecyclePreview>(
    `/v1/projects/${encodeURIComponent(slug)}/lifecycle-preview`,
  );
export const applyProjectLifecycle = (
  slug: string,
  input: { action: ProjectLifecycleAction; confirmSlug?: string },
): Promise<ProjectLifecycleResult> =>
  requestPost<ProjectLifecycleResult>(
    `/v1/projects/${encodeURIComponent(slug)}/lifecycle`,
    input,
  );

export const fetchAgents = (): Promise<AgentListResponse> =>
  request<AgentListResponse>("/v1/agents");
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
}): Promise<{ ok: boolean; agent: ManagedAgent }> =>
  requestPost<{ ok: boolean; agent: ManagedAgent }>("/v1/agents/start", input);
export const stopAgent = (
  agentId: string,
): Promise<{ ok: boolean; agent: ManagedAgent }> =>
  requestPost<{ ok: boolean; agent: ManagedAgent }>(
    `/v1/agents/${encodeURIComponent(agentId)}/stop`,
  );
export const deleteAgent = (agentId: string): Promise<{ ok: boolean }> =>
  requestPost<{ ok: boolean }>(
    `/v1/agents/${encodeURIComponent(agentId)}/delete`,
  );

export const fetchExecTasks = (args?: {
  projectSlug?: string;
  execToken?: string | null;
}): Promise<{ tasks: ExecTask[] }> => {
  const query = args?.projectSlug
    ? `?projectSlug=${encodeURIComponent(args.projectSlug)}`
    : "";
  return request<{ tasks: ExecTask[] }>(`/v1/exec/tasks${query}`, {
    execToken: args?.execToken,
  });
};
export const cancelExecTask = (
  taskId: string,
  args?: { execToken?: string | null },
): Promise<{ ok: boolean; task: ExecTask }> =>
  requestPost<{ ok: boolean; task: ExecTask }>(
    `/v1/exec/tasks/${encodeURIComponent(taskId)}/cancel`,
    {},
    { execToken: args?.execToken },
  );

export const runProjectExec = async (
  slug: string,
  prompt: string,
  model?: string,
  execToken?: string | null,
): Promise<ProjectExecResult> => {
  return requestPost<ProjectExecResult>(
    `/v1/projects/${encodeURIComponent(slug)}/exec`,
    {
      prompt,
      model: model?.trim() ? model.trim() : undefined,
    },
    { execToken },
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
  const response = await fetch(
    `${API_BASE}/v1/projects/${encodeURIComponent(args.slug)}/exec/stream`,
    {
      method: "POST",
      headers: buildHeaders({ contentType: true, execToken: args.execToken }),
      body: JSON.stringify({
        prompt: args.prompt,
        model: args.model?.trim() ? args.model.trim() : undefined,
        threadId: args.threadId?.trim() ? args.threadId.trim() : undefined,
      }),
      signal: args.signal,
    },
  );

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
  const response = await fetch(
    `${API_BASE}/v1/threads/${encodeURIComponent(args.threadId)}/exec/stream`,
    {
      method: "POST",
      headers: buildHeaders({ contentType: true, execToken: args.execToken }),
      body: JSON.stringify({
        prompt: args.prompt,
        model: args.model?.trim() ? args.model.trim() : undefined,
      }),
      signal: args.signal,
    },
  );

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

export type DirectoryPickResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true };

export const pickLocalDirectory = (
  prompt?: string,
): Promise<DirectoryPickResult> =>
  requestPost<DirectoryPickResult>(
    "/v1/system/pick-directory",
    prompt?.trim() ? { prompt: prompt.trim() } : {},
  );
