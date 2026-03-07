# Codex Hub 操作手册

Codex Hub 是一个本地多项目中枢：把各项目中的 Codex 会话、事件、线程、执行任务统一汇总到一个前端看板中管理。

## 1. 当前版本能力

- 多项目管理：注册、编辑、路径校验
- Agent 可视化管理：前端一键启动/停止/删除 `project-agent`
- 会话聚合：采集 `~/.codex/sessions/**/*.jsonl` 增量事件写入 PostgreSQL
- 项目页对话：基于 `codex app-server` 的流式对话（支持 thread 续接）
- 线程页对话：按 thread 持续对话，查看完整历史消息和事件时间线
- 任务管理：执行队列、任务取消、执行审计日志
- 实时刷新：SSE + 轮询兜底

## 2. 架构与目录

```text
apps/
  hub-backend/      # Fastify API, PostgreSQL, Agent 进程管理, Exec 队列
  hub-frontend/     # Next.js 看板
  project-agent/    # 扫描 Codex jsonl 并上报事件
scripts/
  init-db.mjs       # 初始化数据库表结构
```

核心数据表：

- `projects`
- `threads`
- `turns`
- `events`
- `exec_audit_logs`

表定义见：

- `apps/hub-backend/src/schema.sql`

## 3. 运行环境

- Node.js 20+
- npm 10+
- PostgreSQL 14+
- 本机已可用 `codex` 命令（用于后端执行 `codex app-server`）

## 4. 环境变量

推荐先复制 `.env.example` 再按需导出环境变量（当前代码按 `process.env` 读取）：

```bash
cp .env.example .env.local
```

后端变量：

- `HUB_PORT` 默认 `4010`
- `PG_URL` 默认 `postgres://postgres:postgres@127.0.0.1:5432/postgres`
- `CORS_ORIGIN` 默认 `*`（建议配置成前端地址）
- `INGEST_API_KEY` 为空时，`/v1/events` 不校验 `x-api-key`
- `EXEC_API_TOKEN` 为空时，exec 相关接口不校验 token
- `EXEC_ALLOWED_IPS` 为空时，不做 IP 白名单限制
- `EXEC_QUEUE_SIZE` 默认 `5`
- `EXEC_TIMEOUT_MS` 默认 `1200000`（20 分钟）
- `DATA_RETENTION_DAYS` 默认 `30`
- `CLEANUP_INTERVAL_MINUTES` 默认 `60`

Agent 变量：

- `PROJECT_SLUG` 默认 `workspace-main`
- `PROJECT_NAME` 默认 `Workspace Main`
- `PROJECT_PATH` 默认当前目录
- `SESSIONS_ROOT` 默认 `~/.codex/sessions`
- `HUB_URL` 默认 `http://127.0.0.1:4010`
- `INGEST_API_KEY` 与后端一致
- `SCAN_INTERVAL_MS` 默认 `5000`
- `MAX_FILES` 默认 `20`
- `STATE_FILE` 默认 `./.agent-state.json`
- `RUN_ONCE=1` 时只扫描一次

前端变量：

- `NEXT_PUBLIC_HUB_API_BASE` 默认 `http://127.0.0.1:4010`

## 5. 快速启动（本地）

在仓库根目录执行：

```bash
npm install
```

### 5.1 初始化数据库

```bash
export PG_URL="postgres://postgres:你的密码@127.0.0.1:5432/你的库"
npm run db:init
```

### 5.2 启动后端

```bash
export HUB_PORT=4010
export PG_URL="postgres://postgres:你的密码@127.0.0.1:5432/你的库"
export CORS_ORIGIN="http://127.0.0.1:3000,http://localhost:3000"
npm run dev:backend
```

健康检查：

- `http://127.0.0.1:4010/health`

### 5.3 启动前端

```bash
export NEXT_PUBLIC_HUB_API_BASE="http://127.0.0.1:4010"
npm run dev:frontend
```

打开：

- `http://127.0.0.1:3000`

### 5.4 启动采集 Agent（2 选 1）

方式 A：前端可视化启动（推荐）

- 首页或项目页 -> `Agent 可视化启动/停止`
- 填写项目参数 -> 点击“启动 Agent”

方式 B：命令行启动

```bash
PROJECT_SLUG=workspace-main \
PROJECT_NAME="Workspace Main" \
PROJECT_PATH="/Users/you/workspace/your-project" \
SESSIONS_ROOT="/Users/you/.codex/sessions" \
HUB_URL="http://127.0.0.1:4010" \
INGEST_API_KEY="" \
npm run run --workspace @codex-hub/project-agent
```

## 6. 前端使用说明

## 6.1 首页 `/`

- 项目切换：进入对应项目控制台
- 项目管理：注册/编辑项目、路径校验
- Agent 管理：启动、停止、删除 Agent
- 总览指标：项目数、线程状态分布、最近事件

## 6.2 项目控制台 `/projects/{slug}`

- `Codex 项目会话台`：
  - 对话窗口流式显示 assistant 输出
  - 支持 `Ctrl/Cmd+Enter` 发送
  - 支持 `Ctrl+↑ / Ctrl+↓` 调取 prompt 历史
  - 可切换“追加最近上下文”
  - 可查看并跳转当前 `threadId`
- 任务队列：
  - 查看最近任务
  - 取消运行中任务
- 线程列表：
  - 查看项目所有线程并跳转线程页

## 6.3 线程页 `/threads/{threadId}`

- 查看该线程完整消息
- 在线程内继续发送 prompt（续接会话）
- 查看事件时间线（event timeline）
- 可展开调试流（stream debug）

## 7. 会话与历史记录机制

## 7.1 新会话与续接

项目页流式接口：

- `POST /v1/projects/:slug/exec/stream`
- 请求带 `threadId` -> 后端 `thread/resume`
- 不带 `threadId` -> 后端 `thread/start`

线程页流式接口：

- `POST /v1/threads/:threadId/exec/stream`
- 固定使用该线程 `thread/resume`

## 7.2 持久化来源

两条来源会写入同一份历史：

- `project-agent` 从 jsonl 采集后调用 `/v1/events`
- `exec/stream` 与 `thread/stream` 运行时产生的会话事件

消息查询：

- `GET /v1/threads/:threadId/messages`

线程查询：

- `GET /v1/projects/:slug/threads`

## 7.3 前端本地缓存

项目页本地缓存 key：

- `codex_hub_active_thread_${slug}`
- `codex_hub_chat_cache_${slug}`
- `codex_hub_prompt_history_${slug}`
- `codex_hub_exec_token`

说明：

- 页面刷新后会自动恢复当前项目的 thread 与最近聊天缓存
- 真实历史以数据库接口返回为准

## 8. 关键 API 一览

项目管理：

- `POST /v1/projects/register`
- `PUT /v1/projects/:slug`
- `POST /v1/projects/:slug/validate-path`
- `GET /v1/projects`

Agent：

- `GET /v1/agents`
- `POST /v1/agents/start`
- `POST /v1/agents/:id/stop`
- `POST /v1/agents/:id/delete`

事件与线程：

- `POST /v1/events`
- `GET /v1/overview`
- `GET /v1/projects/:slug/threads`
- `GET /v1/threads/:threadId/events`
- `GET /v1/threads/:threadId/messages`
- `GET /v1/stream/events`（SSE）

执行：

- `POST /v1/projects/:slug/exec`
- `POST /v1/projects/:slug/exec/stream`
- `POST /v1/threads/:threadId/exec/stream`
- `GET /v1/exec/tasks`
- `POST /v1/exec/tasks/:taskId/cancel`

运维：

- `POST /v1/admin/cleanup`

## 9. 安全建议

- 生产或团队环境建议设置：
  - `INGEST_API_KEY`
  - `EXEC_API_TOKEN`
  - `EXEC_ALLOWED_IPS`
  - `CORS_ORIGIN`（不要用 `*`）
- 前端执行接口默认从 `localStorage` 读取 `codex_hub_exec_token` 并放入 `x-exec-token`

## 10. 数据清理策略

系统按 `DATA_RETENTION_DAYS` + `CLEANUP_INTERVAL_MINUTES` 自动清理：

- 过期 `events`
- 过期 `turns`
- 过期且无事件关联的 `threads`
- 过期 `exec_audit_logs`

也可手动触发：

```bash
curl -X POST "http://127.0.0.1:4010/v1/admin/cleanup" \
  -H "content-type: application/json" \
  -d '{"retentionDays":30}'
```

## 11. 常见问题

### 11.1 CORS 报错

现象：

- `No 'Access-Control-Allow-Origin' header`

处理：

- 设置后端 `CORS_ORIGIN` 包含前端地址
- 常用值：`http://127.0.0.1:3000,http://localhost:3000`
- 重启后端

### 11.2 页面有重复消息或偶发“吞回答”

当前版本已在项目页增加：

- 历史消息去重
- 流式结果与数据库历史合并（避免覆盖）
- 延迟二次同步（应对落库延迟）

如果仍复现，优先在线程页核对数据库消息是否完整，再检查 agent 重复上报配置。

### 11.3 前端 build 看到 `ENOWORKSPACES` 警告

Next.js 15 在尝试 patch swc lockfile 时可能打印 `ENOWORKSPACES`，但构建可继续并成功。若最终 `Compiled successfully`，可忽略该警告。

## 12. 构建与发布命令

```bash
# 全量构建
npm run build

# 单独构建后端
npm run build --workspace @codex-hub/hub-backend

# 单独构建前端
npm run build --workspace @codex-hub/hub-frontend

# 单独构建 agent
npm run build --workspace @codex-hub/project-agent
```

## 13. 现阶段结论（关于 codex serve）

- 当前方案已基于 `codex app-server` 实现会话流
- 当前项目未依赖 `codex serve`
- 若后续 CLI 提供稳定 `serve` 能力，可再评估替换接入层
