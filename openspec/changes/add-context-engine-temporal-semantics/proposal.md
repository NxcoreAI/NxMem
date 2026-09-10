## Why

Context Engine 当前把对话文档提交时间、事实有效时间和索引刷新时间混在同一条召回链路中。扩展 V3 虽然已经由 Agent 侧准备好 `messageId/createdAt/completedAt/timezone/locale`，但 Context Engine 仍只接受 `role/content`，SQLite 批量摄入不保存消息证据，document-level Phase 3 还会用 `ingestion.committedAt` 填充事实时间。结果是系统无法可靠回答“昨天聊了什么”和“事情什么时候发生”，重新提取或重新索引也可能改变内容的新旧判断。

需要建立一条从真实消息时间、事实时间到 STM/LTM、检索和 Context Pack 的端到端时间契约，并保持旧 V3 文档和旧 Agent 调用兼容。

## What Changes

- 在不升级协议版本的前提下扩展 `context-conversation-md.v3`，接受 Session 的 `timezone/locale` 和消息的 `messageId/createdAt/completedAt`，并执行跨字段校验。
- 恢复并升级消息级证据持久化，使批量摄入同时保存消息、文档消息顺序、revision、删除操作和时间置信度。
- 将事实时间拆分为证据时间、事实有效时间和系统观察时间；事实抽取以来源消息时间和 Session 时区解析相对时间。
- 将证据时间与事实有效时间传播到 structured facts、STM 和 LTM，索引刷新和 LTM 重建不得重置内容时间。
- 为 `search_context` 增加 evidence 检索层、显式时间范围、reference time、时区、时间 basis 解析和排序前硬过滤。
- 在 Context Pack 中保留命中的时间轴、时区、来源消息和精确引用，压缩不得删除时间依据。
- 修复 `create_session_background` 的动态窗口终点和快照复用逻辑，使其以请求 reference time 为准并能跨本地自然日刷新。
- 提供幂等 backfill、低置信度旧数据策略、灰度开关、回滚路径和端到端验收测试。

## Capabilities

### Modified Capabilities

- `context-engine`: 增加对话真实消息时间、事实双时间轴、消息证据持久化、时间检索、Context Pack 时间依据和会话背景动态窗口能力。

## Impact

- 修改对话 V3 类型、Schema、解析器、批量提交服务和契约测试。
- 修改 SQLite schema、repository、数据加载、索引和 migration/backfill 逻辑。
- 修改 document-level 事实抽取、候选校验、Fact 映射、MemoryEvent 时间和 Phase 3 流程。
- 修改 STM admission、Dreaming、structured memory、图索引和检索排序。
- 修改 `search_context`、HTTP/MCP 输入输出、Context Pack 组装和 `create_session_background`。
- Agent 在 PR1 至 PR5 部署并通过验收前继续保持 `CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS=false`。
- 不删除旧 V3 兼容路径，不执行破坏性数据库降级，不将 `committedAt/observedAt/refreshedAt` 暴露为用户事实时间。
