# 项目退出管理机制

## 背景

Codex Hub 早期只有“注册项目”和“编辑项目”，缺少项目生命周期终点能力。项目一旦不再维护、路径失效或只是临时接入测试，用户无法把它安全地从主工作流中移出。

## 目标

把原本单一的“删除项目”诉求升级为分层退出机制：

- `archive`：停用并移出监控，保留所有历史，可恢复。
- `detach`：移除项目但保留历史，不再参与主工作流，可恢复。
- `purge`：彻底清空项目和全部 Hub 历史，不影响本地代码目录。

同时保证：

- 删除前展示影响范围。
- 危险操作有二次确认。
- 首页、项目管理、监控大屏的数据口径与主工作流一致。
- 已移出监控的项目不能继续通过旧入口发起新的 Codex 执行。

## 实施范围

- `apps/hub-backend/src/db.ts`
- `apps/hub-backend/src/schema.sql`
- `apps/hub-backend/src/routes.ts`
- `apps/hub-frontend/lib/api.ts`
- `apps/hub-frontend/app/page.tsx`
- `apps/hub-frontend/app/project-manager-panel.tsx`
- `apps/hub-frontend/app/globals.css`

## 验收标准

- 项目管理支持预览影响范围并执行 `archive / detach / restore / purge`。
- Active 项目只出现在首页主选择器、项目卡片、Agent 启动列表和监控大屏。
- Retired 项目在项目管理中可恢复，且默认不再出现在主工作流。
- Retired 项目无法继续通过项目执行接口或线程续接接口启动新的 Codex 回合。
- 前后端构建校验通过，并完成一条临时测试项目的 archive/restore/purge 烟测。
