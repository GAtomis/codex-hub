@feature console-first-ui-refresh
@created 2026-03-07 21:20
@status completed
@mode interactive

## 进度概览

- 完成: 5
- 失败: 0
- 跳过: 0
- 总数: 5

## 任务列表

[√] 1. 重构首页信息架构 | depends_on: []
[√] 2. 重构项目控制台布局 | depends_on: [1]
[√] 3. 优化线程页阅读与操作节奏 | depends_on: [1]
[√] 4. 统一 Minecraft 视觉系统 | depends_on: [1,2,3]
[√] 5. 构建验证并更新文档 | depends_on: [1,2,3,4]

## 执行日志

- 2026-03-07 21:20 创建方案包
- 2026-03-07 21:27 完成首页、项目台、线程页、项目管理与 Agent 控制台的 Console First 重构
- 2026-03-07 21:28 使用 `npx tsc --noEmit` 完成前端类型校验
- 2026-03-07 21:29 更新 README 的前端使用说明

## 执行备注

- 保持现有会话流、线程续接、历史记录与 Agent 管理功能不减配。
- `next build` 仍被当前环境中的 `ENOWORKSPACES` 阻断，因此以 TypeScript 类型校验作为本轮可执行验证。
