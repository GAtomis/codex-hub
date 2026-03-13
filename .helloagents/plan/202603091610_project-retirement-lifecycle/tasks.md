@feature project-retirement-lifecycle
@created 2026-03-09 16:10
@status completed
@mode delegated

## 进度概览

- 完成: 5
- 失败: 0
- 跳过: 0
- 总数: 5

## 任务列表

[√] 1. 扩展数据库与项目状态模型，支持 retired 元数据 | depends_on: []
[√] 2. 实现项目生命周期预览与 archive/detach/restore/purge 后端接口 | depends_on: [1]
[√] 3. 重构前端项目管理面板，加入退出管理与恢复区 | depends_on: [2]
[√] 4. 首页主工作流过滤 retired 项目，并同步 Agent 启动入口 | depends_on: [2,3]
[√] 5. 运行构建验证并完成临时项目 archive/restore/purge 烟测 | depends_on: [2,3,4]

## 执行日志

- 2026-03-09 16:10 创建方案包
- 2026-03-09 16:17 后端新增 lifecycle preview/action 接口、retired 字段迁移和 active-only 总览口径
- 2026-03-09 16:24 重写项目管理面板，加入退出管理卡片、恢复列表和危险确认弹层
- 2026-03-09 16:27 首页项目选择器和 Agent 启动列表切换为 active-only
- 2026-03-09 16:31 使用临时项目 `tmp-lifecycle-check` 完成 register -> archive -> restore -> purge 烟测
- 2026-03-09 16:32 完成 `npm --prefix apps/hub-backend run build` 与 `cd apps/hub-frontend && npx tsc --noEmit`

## 执行备注

- `archive` 与 `detach` 都是软退出，历史保留；`purge` 才是硬删除，并通过外键级联清理 Hub 历史。
- `retired` 项目不会删除本地磁盘目录，危险提示中明确说明这一点。
