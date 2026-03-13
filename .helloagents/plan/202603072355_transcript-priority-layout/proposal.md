@feature transcript-priority-layout
@created 2026-03-07 23:55
@type implementation
@status completed

## 背景

当前项目页虽然已经切到 Console First，但进入项目后首屏仍然被外层侧栏、会话头部控制区、右侧任务栏三次切分，导致 `project transcript` 实际占用的可视面积偏小，无法成为用户进入页面后的第一视觉焦点。

## 目标

- 让进入项目页后的第一屏主要呈现对话窗口
- 减少 transcript 在横向和纵向上的非必要挤压
- 保留历史线程、任务队列、调试流、会话切换等能力，但全部降级为辅助区

## 方案

1. 项目页外层由左右双栏改为单主栏优先，`ExecPanel` 全宽置顶。
2. `ExecPanel` 内部取消 transcript 与任务队列的左右并排，改成 transcript 主区 + 底部任务区。
3. 会话头部控制区压缩成紧凑工具带，历史会话选择并入主区上方而不是独占整块高度。
4. transcript 高度上调，保证桌面端首屏默认可见更多轮消息。
5. 项目导航和最近线程移到 transcript 下方次级区块，不抢首屏注意力。

## 验收标准

- 项目页桌面端首屏宽度大部分让给 transcript
- transcript 区域明显大于当前版本
- 任务队列仍可查看并取消运行中任务
- 历史会话仍可切换，且不会显著压缩 transcript 高度
