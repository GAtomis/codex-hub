# 状态一致性修复方案

## 背景

监控大屏将部分项目显示为“Codex 处理中”，但进入项目后会话已经结束并可继续输入。排查发现问题来自两类状态污染：

- `threads.status` 中存在服务重启后残留的僵尸 `running` 线程。
- `events.project_slug` 可能与 `thread_id` 的真实归属不一致，导致总览事件跨项目串线。

## 目标

- 后端在读取总览和线程列表前自动纠正僵尸 `running` 线程。
- 后端在事件写入和总览查询时使用 thread 归属作为项目归属的单一事实源。
- 前端战情室把 `interrupted` / `canceled` / `stopped` 会话视为可恢复，而不是处理中。

## 实施范围

- `apps/hub-backend/src/routes.ts`
- `apps/hub-frontend/app/war-room/war-room-console.tsx`

## 验收标准

- 无运行中 exec task 时，长期未更新的 `running` thread 不再在战情室显示为“Codex 处理中”。
- `overview.recentEvents` 不再把同一个 thread 归到多个项目。
- 前端类型检查和后端构建通过。
