# Codex Hub 方案设计（v1）

## 1. 目标

你希望在一个前端中枢里，统一查看“多个项目中的本地 Codex 运行情况”，体验接近 OpenClaw 的多会话管理。

## 2. 是否可以用 `codex serve`

结论：当前不作为实现路径。

- 本机 `codex --help` 未提供 `serve` 子命令。
- 官方文档给出的可嵌入接口是 `codex app-server`，支持 JSON-RPC 双向通信，适合做自定义前端集成。
- 如果你的目标是“统一看状态 + 后续可扩展控制”，`app-server` 更契合。

## 3. 方案总览

### 3.1 架构分层

- Project Agent（每个项目 1 个）
  - 启动 `codex app-server`（建议先用 `stdio`，需要跨进程/跨机器再切 `ws://`）。
  - 将原始 JSON-RPC 事件映射为统一事件模型（线程、回合、状态、耗时、错误）。
- Hub Backend（中枢后端）
  - 维护项目注册表（项目名、路径、在线状态）。
  - 接收并持久化事件（SQLite/PostgreSQL）。
  - 对前端提供聚合 API 和实时订阅（REST + WebSocket/SSE）。
- Hub Frontend（中枢前端）
  - 项目总览：在线/离线、运行中任务数、最近失败。
  - 线程列表：按项目查看 thread/turn 状态。
  - 线程详情：时间线 + 关键事件（开始、审批、完成、错误）。

### 3.2 核心数据模型（建议）

- `projects`
  - `id`, `name`, `path`, `status`, `last_seen_at`
- `threads`
  - `id`, `project_id`, `title`, `status`, `started_at`, `updated_at`
- `turns`
  - `id`, `thread_id`, `status`, `started_at`, `completed_at`, `error_message`
- `events`
  - `id`, `thread_id`, `turn_id`, `type`, `payload_json`, `ts`

## 4. MVP 范围（1-2 周可落地）

- 功能
  - 手工注册项目（本机路径）。
  - 中枢展示项目在线状态。
  - 展示线程/回合实时状态（running/completed/failed）。
  - 展示错误与最近 N 条事件。
- 不做
  - 暂不做远程执行控制（只读可观测优先）。
  - 暂不做复杂权限系统。

## 5. 技术选型补充（详细）

### 5.1 推荐基线（MVP，优先落地）

- 运行时：Node.js 22 LTS + TypeScript
- Project Agent：Node.js（`child_process` 启动 `codex app-server` + JSON-RPC 适配）
- Hub Backend：Fastify + Zod + WebSocket（事件推送）+ REST（查询）
- 存储：PostgreSQL（当前仓库骨架已按 PostgreSQL 落地）
- Hub Frontend：Next.js（App Router）+ Tailwind + TanStack Query
- 图表与时序：ECharts（线程吞吐、失败率、在线状态）
- 进程托管：PM2（开发/小规模）或 systemd（生产）

为什么推荐这套：

- 你当前目标是“先看全局运行态”，不是先做复杂控制面。
- Node 全栈开发速度快，MVP 迭代成本最低。
- 直接使用 PostgreSQL，减少后续迁移成本。

### 5.2 扩展型（多机器/多用户）

- Backend：NestJS（模块化更强）+ PostgreSQL + Redis
- 消息总线：NATS 或 Redis Streams（多 Agent 高并发上报）
- 实时通道：WebSocket（主）+ SSE（回退）
- 鉴权：OIDC（Keycloak/Auth0）+ RBAC（项目级权限）
- 观测：OpenTelemetry + Prometheus + Grafana + Loki

适用条件：

- 接入项目数 > 20
- 存在团队协作、权限隔离、审计追踪要求
- 需要跨机器部署和高可用

### 5.3 关键取舍（你需要先定）

- TypeScript vs Go：
  - 想要开发效率和前后端统一：TypeScript
  - 想要单二进制部署和高并发：Go
- Fastify vs NestJS：
  - 先快速上线：Fastify
  - 中长期多人协作：NestJS
- WebSocket vs SSE：
  - 需要双向控制（后续可远程触发动作）：WebSocket
  - 当前仅单向状态推送：SSE 也可先上
- SQLite vs PostgreSQL：
  - 单机中枢：SQLite
  - 多用户/高并发/长周期留存：PostgreSQL

### 5.4 建议落地顺序

- 第一步（1 周）：Fastify + PostgreSQL + SSE/WS + Next.js，看板先跑通
- 第二步（第 2 周）：接入 2-5 个项目，补告警和失败重试可视化
- 第三步（扩容时）：引入 Redis、消息总线和鉴权

### 5.5 数据是否可以直接用

- `~/.codex/sessions/*.jsonl`：可以直接用，作为最原始数据源（推荐保留原始日志，不改写）。
- 若你已有 PostgreSQL 事件表：可以直接复用，但需要做字段映射到本方案的 `projects/threads/turns/events`。
- SQLite 与 PostgreSQL：不能无成本直接共用，需要迁移脚本（表结构、字段、索引）。

迁移建议：

- 当前骨架默认 PostgreSQL，可直接接你本地 `5432` 实例。
- 若你已有 SQLite 历史数据，再按“双写 + 回放校验 + 切读”做迁移。

## 6. 关键实现点

- 事件映射
  - 对 `thread/started`, `turn/started`, `turn/completed`, `item/*`, `error/*` 做统一归类。
- 去重与顺序
  - 按 `(project_id, thread_id, turn_id, event_id)` 幂等写入。
- 健康检测
  - project-agent 心跳；超时自动标记离线。
- 可靠性
  - app-server 断连重试（指数退避）。
  - WebSocket 模式注意服务端拥塞错误 `-32001`。

## 7. 分阶段实施计划

- Phase 1（MVP）
  - 建立 project-agent 到 hub-backend 的单向事件上报。
  - 前端实现总览 + 线程详情。
- Phase 2
  - 增加审批事件视图、命令输出摘要、告警规则。
- Phase 3
  - 支持跨机器接入、多用户、权限控制。

## 8. 风险与对策

- 风险：`app-server` 某些能力仍在演进
  - 对策：通过 schema 生成锁版本；接口适配层隔离协议变化。
- 风险：项目数量上来后事件量增大
  - 对策：事件分级存储（热数据 + 历史归档），前端分页和增量加载。

## 9. 一句话建议

可做，而且建议用 `codex app-server`（不是 `codex serve`）作为底座来实现你的“Codex 运行中枢看板”。
