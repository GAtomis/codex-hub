@feature state-reconciliation
@created 2026-03-09 14:52
@status completed
@mode delegated

## 进度概览

- 完成: 4
- 失败: 0
- 跳过: 0
- 总数: 4

## 任务列表

[√] 1. 修复后端事件归属校验，避免 thread 跨项目串线 | depends_on: []
[√] 2. 增加僵尸 running thread 自动收口逻辑 | depends_on: [1]
[√] 3. 调整战情室状态映射，支持可恢复会话 | depends_on: [1,2]
[√] 4. 运行前后端构建验证并记录结果 | depends_on: [2,3]

## 执行日志

- 2026-03-09 14:52 创建方案包
- 2026-03-09 14:56 后端新增运行态对账逻辑，修复事件归属和 overview 查询口径
- 2026-03-09 14:58 战情室把 interrupted/canceled/stopped 会话归类为“等你回复”
- 2026-03-09 14:59 完成 `npm --prefix apps/hub-backend run build` 与 `cd apps/hub-frontend && npx tsc --noEmit`

## 执行备注

- `running` 线程在 90 秒未更新且项目无活跃 exec task 时自动收口为 `interrupted`。
- 总览事件对外展示时优先使用 threads 表中的 canonical `project_slug`。
