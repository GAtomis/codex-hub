# CHANGELOG

## 开发实施

- **[backend-runtime-reconcile]**: 修复线程归属与僵尸运行态问题，新增事件归属归一化、`running` 线程自动收口与 overview canonical 查询。[apps/hub-backend/src/routes.ts](/Users/macmini/Documents/workspace/codex-hub/apps/hub-backend/src/routes.ts)
- **[war-room-status]**: 战情室将 `interrupted` / `canceled` / `stopped` 会话识别为可恢复对话，不再误标为处理中。[apps/hub-frontend/app/war-room/war-room-console.tsx](/Users/macmini/Documents/workspace/codex-hub/apps/hub-frontend/app/war-room/war-room-console.tsx)
- **[project-retirement-lifecycle]**: 新增项目退出管理机制，支持 `archive / detach / restore / purge`，并在首页与项目管理中区分 active / retired 主工作流。[apps/hub-backend/src/routes.ts](/Users/macmini/Documents/workspace/codex-hub/apps/hub-backend/src/routes.ts)
- **[project-manager-retirement-ui]**: 重构项目管理面板，加入退出管理卡片、恢复列表、影响预览和危险确认弹层。[apps/hub-frontend/app/project-manager-panel.tsx](/Users/macmini/Documents/workspace/codex-hub/apps/hub-frontend/app/project-manager-panel.tsx)
