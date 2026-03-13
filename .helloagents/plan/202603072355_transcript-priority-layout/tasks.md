@feature transcript-priority-layout
@created 2026-03-07 23:55
@status completed
@mode interactive

## 进度概览

- 完成: 4
- 失败: 0
- 跳过: 0
- 总数: 4

## 任务列表

[√] 1. 重构项目页外层布局 | depends_on: []
[√] 2. 重构 ExecPanel 为 transcript 主屏结构 | depends_on: [1]
[√] 3. 调整样式与辅助区层级 | depends_on: [1,2]
[√] 4. 类型校验并同步结果 | depends_on: [1,2,3]

## 执行日志

- 2026-03-07 23:55 创建方案包
- 2026-03-08 00:03 项目页外层改为 transcript 全宽优先布局
- 2026-03-08 00:05 ExecPanel 改为 transcript 主区 + 底部任务区
- 2026-03-08 00:06 补充响应式与类型校验，`npx tsc --noEmit` 通过

## 执行备注

- transcript 相关能力未删减，任务队列、历史线程和完整 Thread 跳转均保留。
- 本轮重点是首屏信息架构重排，而不是新增后端能力。
