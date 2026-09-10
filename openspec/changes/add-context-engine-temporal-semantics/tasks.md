## 1. V3 协议与兼容校验

- [x] 1.1 在 `conversation-ingestion/domain.ts` 扩展 `ConversationDocumentMessage` 和 `ConversationDocumentSession`，增加 `messageId/createdAt/completedAt/timezone/locale`，保持 schema version 为 V3。
- [x] 1.2 在 `markdown-protocol.ts` 扩展 JSON Schema，并实现 legacy/extended Session 模式识别、禁止混用、ID 唯一、RFC3339 offset、IANA timezone、BCP 47 locale、时间单调和 completedAt 顺序校验。
- [x] 1.3 为协议错误增加稳定错误码、精确 JSON path 和不提交部分数据的行为。
- [x] 1.4 扩展 fixtures，覆盖旧 V3、完整扩展 V3、多 Session、相同时间稳定顺序和所有非法组合。
- [x] 1.5 更新 `contract.test.ts`、V3 协议说明和 Agent 对齐说明，删除“messageId 不属于 V3 Markdown”的旧约束并写明开关策略。

## 2. 消息证据持久

- [x] 2.1 定义统一的 extended/legacy 消息 normalization 和稳定 `conversationMessageRowId`/legacy evidence ID 生成器。
- [x] 2.2 扩展 `ConversationIngestionRecord` 保存 `timezone/locale/temporalMode`，扩展 `ConversationMessageRecord` 保存 `completedAt/timezone/locale/timeConfidence/storedAt`。
- [x] 2.3 修改 `CommitConversationBatchIngestionRequest`，使每个 Session commit 携带归属于该 ingestion 的消息和 message order。
- [x] 2.4 修改 `conversation-ingestion-service.ts`，在提交 cursor 前物化消息记录；extended 使用协议 createdAt，legacy 使用 committedAt 且标记 low confidence。
- [x] 2.5 恢复/新建 `conversation_messages` 和 `conversation_document_messages`，关联表增加 `ingestion_id`，补充 owner/session/time/identity 索引和唯一约束。
- [x] 2.6 移除或替换 `dropLegacyConversationTables()` 的破坏性逻辑，并为已有数据库提供幂等表重建 migration。
- [x] 2.7 实现 SQLite batch transaction 写入、数据库 cache 加载和按 ingestion 隔离的 `getConversationMessages()`；内存 repository 与 SQLite 行为保持一致。
- [x] 2.8 测试多 Session 隔离、幂等提交、message revision、delete、内容冲突、sequence 冲突和重启后消息可恢复。

## 3. Fact 三类时间与消息来源

- [ ] 3.1 统一 active Phase 3 与现有消息级事实管线，确保 worker 从 repository 读取当前 ingestion 消息，而不是只依赖 document-level 原文。
- [x] 3.2 修改事实抽取 Prompt，传入 `referenceTimezone/locale` 和每条消息的 `messageId/role/content/createdAt`，明确相对时间解析、覆盖检查和不可丢失信息规则。
- [ ] 3.3 扩展 strict JSON Schema，要求候选包含非空 `sourceMessageIds/evidenceQuotes`，并支持 nullable `validTimeStart/End`、valid basis 和 confidence。
- [ ] 3.4 将 quote 校验从 Session 全文查找改为逐 `sourceMessageId` 精确查找，拒绝跨 Session ID、错配 quote 和无法复算的相对时间。
- [ ] 3.5 扩展 `FactItem` 和 SQLite `fact_items`，增加 `evidenceTimeStart/End`、`evidenceTimeConfidence`、`sourceMessageIds` 和 valid time confidence，并允许 valid time 为空。
- [ ] 3.6 修改 Fact 映射：evidence time 从来源消息 min/max 计算，observedAt 使用提取时间，valid time 只接受候选语义时间，删除所有 `candidate.validTimeStart ?? ingestion.committedAt` 回退。
- [ ] 3.7 为每条来源消息生成 `conversation_message` SourceRef，以物理 row ID 防止跨 Session messageId 冲突，并保留逻辑 messageId 供引用展示。
- [ ] 3.8 修改 conversation document event，使 eventTime 使用最后一条消息 createdAt，metadata 保存 eventTimeStart/End；legacy 才允许 low-confidence committedAt。
- [ ] 3.9 测试 absolute/event-relative/source-time basis、无语义时间、多消息证据、延迟抽取、旧消息低置信度和 invalid/pending verification 路径。
- [x] 3.10 实现同 Session 无损两层事实融合：第一层保留原子事实，第二层使用已有 Fact 字段执行自然语言语义融合；数字单位、时间、实体、否定、限定词、列表顺序或新旧值丢失时逐条回退原始事实，并验证 Fact Store 与 STM admission 行为。

## 4. STM/LTM 时间传播与持久化

- [ ] 4.1 为 `ShortTermMemory`、`LongTermMemory` 和 `StructuredMemoryFact` 增加 evidence/valid 时间与分轴 confidence。
- [ ] 4.2 修改 `structured-memory.ts` 和 STM admission，从 `sourceFactIds` 聚合 temporal metadata，并保留逐事实时间。
- [ ] 4.3 修改 Dreaming 输入、输出和 mapping，从 `sourceMemoryDataIds/structuredFacts` 聚合 LTM 时间，不使用巩固时间或创建时间重置来源时间。
- [ ] 4.4 为 STM/LTM SQLite 表增加 temporal columns、owner/time 索引和 serialization/loading 支持。
- [ ] 4.5 扩展 graph memory node/index metadata，使图检索可以用时间 envelope 预过滤，同时保留 `refreshedAt` 为纯索引审计字段。
- [ ] 4.6 实现非连续 structured facts 的精确时间匹配，顶层 min/max envelope 不得单独决定最终命中。
- [ ] 4.7 测试 Fact -> STM -> LTM 的时间不变性、重新巩固、重新索引、数据库重启和非连续范围匹配。

## 5. Evidence 检索层

- [ ] 5.1 定义 `EvidenceSearchCandidate` 和 repository evidence search contract，支持 owner、source、权限、文本和时间 envelope 过滤。
- [ ] 5.2 实现 conversation message adapter，返回消息 content、稳定 source refs、evidence time 和 time confidence。
- [ ] 5.3 实现 parsed data lake segment adapter，从 parent event/segment 传播 evidence time 和来源引用。
- [ ] 5.4 实现 Fact/STM/LTM 到原始 evidence 的回链和批量 materialize，避免 N+1 查询。
- [ ] 5.5 扩展 `ContextSearchLayer` 为 `evidence | stm | ltm | all`，保持旧 `stm/ltm/all` 行为兼容。
- [ ] 5.6 测试 evidence 权限过滤、跨来源隔离、消息/segment 引用和 layer=all 三层召回。

## 6. TemporalRangeResolver 与 search_context

- [ ] 6.1 新增 `temporal-query.ts`，定义 `TemporalSearchRange/ResolvedTemporalQuery`、时区优先级和半开区间校验。
- [x] 6.2 实现明确日期、中英文自然日与上/本/下周月年、过去/未来范围、分钟至年份相对点的确定性 IANA timezone resolver，区分 duration/模糊数量并覆盖 DST 边界。
- [ ] 6.3 定义可插拔 semantic resolver 接口；semantic 失败时降级为无时间硬过滤并记录低置信度，不猜测范围。
- [ ] 6.4 实现 evidence/valid/auto basis 判断，“聊过/说过”映射 evidence，“发生/生效/计划日期”映射 valid，auto 返回实际 matched basis。
- [ ] 6.5 扩展 `ContextQuery`、MCP tool schema、argument parser、HTTP routes 和类型守卫，增加 `referenceTime/timezone/locale/timeRange`。
- [ ] 6.6 重构 search pipeline：候选 over-fetch 或时间 envelope 下推，materialize 后执行权限、生命周期和精确 temporal filter，再排序、去重和分页。
- [ ] 6.7 增加 `outside_evidence_time_range/outside_valid_time_range/temporal_metadata_missing` dropped reason，并明确 total 为过滤去重后的数量。
- [ ] 6.8 用 evidence/valid 时间重算 STM/LTM/evidence recency，移除 `refreshedAt` 和 lifecycle status 作为内容时间的逻辑。
- [ ] 6.9 扩展 `ContextSearchResult.temporal`，返回 evidence/valid 时间、分轴 confidence 和 `matchedBasis`。
- [ ] 6.10 覆盖显式范围优先、自然日、范围外高分硬过滤、auto basis、无时间意图、DST、分页和 MCP/route 兼容测试。

## 7. Context Pack 时间依据与引用

- [ ] 7.1 修改 `assembleContext()`，统一执行 evidence/STM/LTM 三层检索并传递同一 resolved temporal query。
- [ ] 7.2 为 `ContextPackItem` 和 pack-level metadata 增加 temporal fields，压缩器只修改文本内容，不删除时间、basis、confidence 和 source IDs。
- [ ] 7.3 实现跨层去重，合并时间和来源，优先保留 `conversation_message/parsed_segment` 引用。
- [ ] 7.4 修改 bucket 和排序逻辑，使 `recentContext` 按 evidence time 排序，不按 index refresh 或 lifecycle 排序。
- [ ] 7.5 修改 `serializedPrompt`，输出查询时间范围、时区、命中 basis、事实时间、消息时间和具体来源。
- [ ] 7.6 测试 token 压缩、跨层去重、引用优先级、时间说明、structuredContent.serializedPrompt 和权限二次校验。

## 8. create_session_background 动态窗口

- [ ] 8.1 扩展 `CreateSessionBackgroundRequest`、MCP Schema 和 parser，增加可选 `referenceTime/timezone/locale`。
- [ ] 8.2 将缺省 window end 修改为 `referenceTime ?? now()`，移除 Session createdAt 对后续动态窗口的上限约束。
- [ ] 8.3 扩展快照/cache key，纳入本地自然日、timezone、fixed revision 和 latest STM cursor；跨午夜或 watermark 推进时刷新 dynamic section。
- [ ] 8.4 保持旧 Agent 兼容：缺 referenceTime 时使用请求接收时间和配置时区优先级。
- [ ] 8.5 测试同 Session 重试复用、跨午夜刷新、force refresh、STM watermark 推进和 stale/degraded fallback 的窗口时区保留。

## 9. Backfill、灰度与可观测性

- [ ] 9.1 增加 migration version 记录和幂等 backfill runner，输出扫描、更新、跳过、失败和重试数量。
- [ ] 9.2 对可重新解析的扩展 V3 原文重建真实消息 evidence、Fact evidence time、STM/LTM temporal metadata 和索引。
- [ ] 9.3 对旧 V3 仅生成 low-confidence evidence fallback，不生成虚假的 valid time 或 high-confidence message time。
- [ ] 9.4 增加 temporal protocol、source、quote、range、metadata missing 和 backfill 错误分类及 trace 字段。
- [ ] 9.5 增加 temporal read、evidence layer、hard filter 影子模式和 Agent timestamp 输出 feature flags，记录新旧搜索差异。
- [ ] 9.6 更新运行手册，写明部署顺序、Agent 开关条件、监控指标、回滚步骤和新增列保留策略。

## 10. 验证与发布门禁

- [ ] 10.1 运行 `pnpm --filter @nexcore/backend typecheck` 和全部 conversation ingestion、search、Context Pack、session background 定向测试。
- [ ] 10.2 运行 `pnpm --filter @nexcore/backend test`，修复 temporal schema 变更引起的所有 fixture 和序列化回归。
- [ ] 10.3 使用 SQLite 文件 repository 执行 migration、重启恢复、重复 backfill 和回滚开关验证，不只测试内存 repository。
- [ ] 10.4 使用“7 月 23 日消息、8 月 1 日去深圳”完成真实扩展 V3 端到端验收，验证 evidence/valid/observed、两种查询和具体 message citation。
- [ ] 10.5 在 PR1 至 PR5 部署并通过生产影子结果检查前保持 Agent 时间字段开关关闭；确认门禁后灰度开启并观察 drop reason、召回差异和 backfill 失败率。
- [ ] 10.6 运行 `openspec status --change add-context-engine-temporal-semantics` 和 `openspec validate add-context-engine-temporal-semantics`，记录验证输出与当前环境未执行项。
