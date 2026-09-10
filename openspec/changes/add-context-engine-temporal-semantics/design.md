## Context

Context Engine 已有四条相关链路，但时间语义没有贯穿其中：

```text
Agent V3 Markdown
  -> 批量 ingestion
  -> document-level Phase 3 事实抽取
  -> Fact / STM / LTM
  -> graph FTS/vector search
  -> assemble_context / session background
```

当前代码中存在以下结构性问题：

- `ConversationDocumentMessage` 和 V3 validator 只接受 `role/content`。
- 批量 ingestion 只提交 document、Session ingestion、cursor 和 job，不提交消息记录。
- SQLite migration 会删除 `conversation_messages`、`conversation_document_messages` 等旧表，Phase 2 消息级证据无法从数据库恢复。
- worker 直接执行 document-level Phase 3；该路径的候选事实没有 `sourceMessageIds`，quote 只在整个 Session 中查找。
- document-level Fact 会使用 `ingestion.committedAt` 填充缺失的 `validTimeStart`。
- Fact、STM、LTM 和 Context Pack 没有完整的 evidence/valid 时间摘要。
- `search_context` 只有 STM/LTM layer，时间只是 route score 信号；STM 使用 `refreshedAt` 计算 recency，LTM 使用 lifecycle status 代替 recency。
- `create_session_background` 缺少 request reference time，动态窗口默认固定到 Session `createdAt`。

本设计将时间分为两条面向用户的时间轴和一条系统审计时间轴：

| 时间轴 | 含义 | 允许用于用户事实回答 |
| --- | --- | --- |
| evidence time | 消息、parsed segment 支撑内容的真实来源时间 | 是，回答“昨天聊了什么” |
| valid time | 事实在现实世界发生、计划发生或生效的时间 | 是，回答“什么时候去深圳” |
| observed/processing time | 摄入、抽取、写库、索引、刷新时间 | 否，只用于审计和运维 |

## Goals / Non-Goals

**Goals:**

- 保持 `context-conversation-md.v3` 版本不变，兼容旧 Agent 和旧 V3 文档。
- 对新扩展 V3 文档建立消息级、可修订、可删除、可引用的 evidence record。
- 为 Fact、STM、LTM、evidence search 和 Context Pack 建立一致的 temporal contract。
- 使用来源消息 `createdAt`、Session IANA 时区和请求 `referenceTime` 解析相对时间。
- 在权限和生命周期过滤之后、排序和分页之前执行时间硬过滤。
- 让旧数据可检索但明确标记低时间置信度，并让 backfill 幂等可审计。

**Non-Goals:**

- 不升级为 `context-conversation-md.v4`。
- 不把消息 `completedAt` 当作事实发生时间；它只作为 Assistant 完成审计字段。
- 不把 `committedAt`、`observedAt`、`extractedAt` 或 `refreshedAt` 用作高置信度内容时间。
- 不在本变更中实现新的自然语言大模型时间解析服务；先提供确定性 resolver 接口和可插拔 semantic resolver。
- 不改变敏感信息准入、权限模型、图关系类型和已有 STM/LTM 生命周期语义。

## Architecture

### End-to-end flow

```text
┌─────────────┐  V3 protocol  ┌────────────────┐  message evidence  ┌──────────────┐
│ Agent       │──────────────▶│ ingestion      │───────────────────▶│ evidence DB  │
│ createdAt   │               │ validate/map   │                    │ messages     │
└─────────────┘               └──────┬─────────┘                    └──────┬───────┘
                                     │ sourceMessageIds                     │
                                     ▼                                      │
                              ┌──────────────┐                              │
                              │ Fact extract │◀── messages + timezone        │
                              └──────┬───────┘                              │
                                     │ evidence/valid/observed              │
                                     ▼                                      ▼
                              ┌──────────────┐  temporal metadata   ┌──────────────┐
                              │ Fact         │─────────────────────▶│ STM / LTM    │
                              └──────┬───────┘                       └──────┬───────┘
                                     │                                      │
                                     └──────────────┬───────────────────────┘
                                                    ▼
                              ┌──────────────────────────────────────┐
                              │ evidence + memory retrieval          │
                              │ resolve -> materialize -> hard filter │
                              └──────────────────┬───────────────────┘
                                                 ▼
                                      ┌────────────────────┐
                                      │ Context Pack       │
                                      │ temporal + refs    │
                                      └────────────────────┘
```

### Responsibility boundaries

| 边界 | Agent 提供 | Context Engine 负责 |
| --- | --- | --- |
| V3 Session | `sessionId/cursor/timezone/locale` | 兼容校验、Session 范围和 cursor 校验 |
| V3 Message | `messageId/role/content/createdAt/completedAt` | RFC3339 校验、顺序校验、持久化和 revision |
| Fact candidate | `sourceMessageIds/evidenceQuotes/validTime*` | 来源绑定、quote 精确校验、时间范围和置信度计算 |
| Search request | `task/q/referenceTime/timezone/locale/timeRange/basis` | 时间解析、时区优先级、硬过滤和 matched basis |
| Search result | 无 | temporal metadata、drop reason、具体 source refs |
| Context Pack | 无 | 压缩、去重、时间依据、serializedPrompt 和 citations |

## Temporal Contract

### Protocol types

扩展 V3 的 TypeScript 类型如下。旧字段保持兼容，新增字段全部可选于静态类型层；是否成组出现由业务 validator 决定。

```ts
interface ConversationDocumentMessage {
  role: ConversationRole;
  content: string;
  messageId?: string;
  createdAt?: string;
  completedAt?: string;
}

interface ConversationDocumentSession {
  sessionId: string;
  previousCursor?: string;
  cursor: string;
  visibility?: Exclude<ConversationVisibility, "private">;
  timezone?: string;
  locale?: string;
  messages: ConversationDocumentMessage[];
}
```

业务校验规则：

1. `messageId` 和 `createdAt` 必须同时存在或同时缺失。
2. 同一 Session 不能混用 legacy 消息和 extended 消息。
3. extended Session 的每条消息都必须有 `messageId/createdAt`，Session 必须有 `timezone/locale`。
4. `messageId` 在 Session 内唯一；消息按协议顺序单调递增，时间相同按文档顺序稳定排序。
5. `createdAt/completedAt` 必须是带 `Z` 或 UTC offset 的 RFC3339；`completedAt >= createdAt`。
6. `timezone` 使用 `Intl.DateTimeFormat` 或成熟 IANA timezone 库验证；`locale` 使用 `Intl.Locale` 验证 BCP 47。
7. 静态 JSON Schema 继续只要求 `role/content`，跨字段规则在 Schema 后执行，保证旧 V3 可解析。

### Canonical message identity

新消息的 `conversationMessageRowId` 使用稳定哈希生成：

```text
conversation_message_<sha256(tenantId | sourceApp | principalId | sessionId | messageId | revision)>
```

`messageId` 是 Agent 的逻辑 ID，`conversationMessageRowId` 是 Context Engine 的物理 evidence ID。所有跨层 source ref 使用物理 row ID，避免不同 Session 复用相同 message ID 造成引用碰撞；返回给 Agent 的引用 metadata 同时保留逻辑 `messageId/sessionId`。

旧 V3 没有稳定 message ID 时生成：

```text
legacy_message_<sha256(documentSha256 | sessionId | messageOrder)>
```

该 ID 只保证当前提交文档内稳定，消息时间取 ingestion `committedAt`，`timeConfidence=low`，不能用于跨文档 revision 去重。

### Fact temporal model

`FactItem` 增加以下字段，并将现有 `validTimeStart/timeBasis/timeConfidence` 解释为“事实有效时间”字段，不再允许处理时间回填：

```ts
interface FactTemporalMetadata {
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  evidenceTimeConfidence: "low" | "medium" | "high";
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeBasis?: "absolute" | "event_relative" | "source_time";
  validTimeConfidence: "low" | "medium" | "high";
  observedAt: string;
  sourceMessageIds: string[];
}
```

为兼容现有代码，第一阶段可以继续输出 `timeBasis/timeConfidence` 作为 `validTimeBasis/validTimeConfidence` 的别名，但新代码只读取明确的 valid/evidence 字段。没有语义事实时间时，`validTimeStart/End` 为 `null`；不能把 evidence time 当作 valid time。

`validTimeBasis` 的判定：

- 文本给出明确日期/时间，且不依赖消息时间：`absolute`。
- 文本使用“今天、明天、下周”等相对表达，依据来源消息时间和 Session 时区解析：`event_relative`。
- 文本没有现实世界时间，业务需要一个弱时间锚点时：`source_time`，置信度为 low，仅允许 evidence basis 查询，不得当作明确 valid time。

### Memory temporal metadata

STM、LTM 和 `StructuredMemoryFact` 均保留逐事实时间以及可索引摘要：

```ts
interface MemoryTemporalMetadata {
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  evidenceTimeConfidence: "low" | "medium" | "high";
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeConfidence: "low" | "medium" | "high";
}
```

聚合规则：

- evidence 摘要取来源时间的 min/max。
- valid 摘要只作为候选预过滤的 envelope；若来源事实不连续，最终匹配必须检查 `structuredFacts` 中的每个事实范围。
- LTM 不得用巩固时间、created time 或 index refreshed time 覆盖来源时间。
- structured fact 的时间字段保留在 Context Pack 中，压缩只处理文字，不删除时间和 source refs。

## Persistence Design

### Canonical tables

SQLite 保留或恢复以下表。迁移必须先创建新表/新列，再回填和切换读取路径，不能继续调用会删除证据表的 `dropLegacyConversationTables()`。

```sql
CREATE TABLE IF NOT EXISTS conversation_messages (
  conversation_message_row_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  timezone TEXT,
  locale TEXT,
  time_confidence TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  operation TEXT NOT NULL DEFAULT 'append',
  stored_at TEXT NOT NULL,
  UNIQUE (tenant_id, principal_id, source_app, session_id, message_id, revision)
);

CREATE TABLE IF NOT EXISTS conversation_document_messages (
  document_id TEXT NOT NULL,
  ingestion_id TEXT NOT NULL,
  conversation_message_row_id TEXT NOT NULL,
  message_order INTEGER NOT NULL,
  PRIMARY KEY (document_id, ingestion_id, conversation_message_row_id),
  UNIQUE (document_id, ingestion_id, message_order)
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_owner_time
  ON conversation_messages (tenant_id, principal_id, created_at, message_id);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_time
  ON conversation_messages (tenant_id, principal_id, source_app, session_id, created_at);
```

事实表增加：

```sql
ALTER TABLE fact_items ADD COLUMN evidence_time_start TEXT;
ALTER TABLE fact_items ADD COLUMN evidence_time_end TEXT;
ALTER TABLE fact_items ADD COLUMN evidence_time_confidence TEXT NOT NULL DEFAULT 'low';
ALTER TABLE fact_items ADD COLUMN source_message_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fact_items ADD COLUMN valid_time_confidence TEXT NOT NULL DEFAULT 'low';
```

STM/LTM 表增加同名 evidence/valid 摘要和分轴 confidence。若现有 SQLite 版本不允许为 `valid_time_start` 改成 nullable，则使用表重建迁移；新 Fact 没有 semantic valid time 时保留 NULL，不写入 `committedAt`。

### Repository contract

`ConversationIngestionRepository` 和 `ContextEngineRepository` 必须提供：

- `commitConversationBatchIngestion()` 在同一事务中提交 batch、document、ingestions、messages、document-message rows、cursor 和 jobs。
- `getConversationMessages(ingestionId)` 只返回该 ingestion/session 的消息，不返回同一 document 的其他 Session。
- `getConversationMessagesByRowIds()` 返回稳定顺序和 revision 信息。
- `findEvidenceCandidates()` 支持 owner、source、文本、时间 envelope 和权限初筛。
- `getFactTemporalMetadata()` 或等价批量读取，避免 search 阶段逐条 N+1 查询 Fact。
- `saveShortTermMemory/saveLongTermMemory` 原子保存 temporal metadata 和 structured facts。

内存 repository 与 SQLite repository 使用相同的 normalization 逻辑和 ID 生成器，测试 fixture 不允许只覆盖内存实现。

## Ingestion and Fact Processing

### Batch ingestion

1. 解析 Markdown、校验 front matter、Session 和消息跨字段规则。
2. 为每个 Session 生成 ingestion record，并保存 `timezone/locale/temporalMode`。
3. 将协议消息转换为 `ConversationMessageRecord`：extended 直接使用 Agent 时间；legacy 使用 deterministic legacy ID 和低置信度 committed time。
4. 在一个 repository transaction 中写入文档、消息和顺序关联。
5. cursor 只在所有写入成功后提交；重复 idempotency key 返回原有 batch，不重复消息。
6. Phase 3 读取 `getConversationMessages(ingestionId)`，不再只从原始 Markdown 做 document-level quote 查找。

### Extraction input and output

事实抽取 Prompt 必须整体提供：

```json
{
  "referenceTimezone": "Asia/Shanghai",
  "locale": "zh-CN",
  "messages": [
    {
      "messageId": "msg_user",
      "role": "user",
      "content": "我计划明天去深圳",
      "createdAt": "2026-07-23T07:30:00.000Z"
    }
  ]
}
```

候选 Schema 要求：

- `sourceMessageIds` 为非空数组；
- `evidenceQuotes` 为非空数组；
- `validTimeStart/End` 可为 string 或 null；
- 可选 `validTimeBasis` 和 `validTimeConfidence` 用于明确区分绝对时间、相对时间和 source fallback。

本地校验按以下顺序执行：

1. ID 必须属于当前 ingestion Session。
2. 每条 quote 必须在对应来源消息 content 中逐字出现。
3. `validTimeStart/End` 必须是 RFC3339；明确日期必须可用来源 timezone 复算。
4. 来源消息无真实时间时，候选不得生成 high valid confidence。
5. 异常时间、无法复算或跨越证据逻辑边界的候选进入 `pending_verification`。

Fact 映射：

```ts
const sourceMessages = candidate.sourceMessageIds
  .map((id) => messageById.get(id))
  .filter(isDefined);

const evidenceTimeStart = min(sourceMessages.map((m) => m.createdAt));
const evidenceTimeEnd = max(sourceMessages.map((m) => m.createdAt));
const validTimeStart = candidate.validTimeStart ?? null;
const evidenceConfidence = minConfidence(sourceMessages.map((m) => m.timeConfidence));
const validConfidence = candidate.validTimeStart
  ? candidate.validTimeConfidence ?? "medium"
  : "low";
```

`observedAt` 由 Phase 3 的 `now` 产生；它只写入 Fact 审计字段，不参与 valid/evidence 查询。

### Conversation event

document event 的 `eventTime` 使用该 ingestion 最后一条真实消息 `createdAt`；事件 metadata 保存 `eventTimeStart/eventTimeEnd`。只有 legacy ingestion 才允许使用 committed time，并标记低置信度。

### Same-session fact fusion

事实处理复用现有两层机制，但职责严格分离：

1. 第一层只抽取并持久化原子事实。除语义完全等价的重复表述外，不按事实类型、时间邻近或代表文本折叠不同事实。
2. 第二层以共同 `linkedEventId` 作为同 Session 候选边界，由 LLM 将互补且不冲突的事实改写为一条或多条自然语言事实；不要求 `factType` 相同。
3. 成功的多事实融合生成基于有序 `sourceFactIds` 的稳定新 Fact ID，合并来源、实体和时间元数据；原始 Fact 保持 active，供审计和重新融合使用。
4. 未参与融合的事实原样进入 STM admission。缺 API key、请求或重试失败、无效 JSON、重复/越界 ID、跨 Session 分组、空文本或关键信息丢失时，受影响事实逐条回退为原始 Fact。
5. 融合判断只读取已有 `factType/normalizedClaim/entityIds/validTime*/linkedEventIds/linkedSegmentIds/linkedSourceRefs/sourceMessageIds/status/version`；不为融合新增持久化 Fact 字段。`factType` 是语义提示而非硬边界，实体、时间、状态和版本用于识别互补事实、冲突以及旧值到新值的变化。
6. 融合文本必须保留数字及单位/币种、日期和相对时间、英文专名、否定和排除项、条件、不确定性、频率和范围限定词、有序列表条目及顺序、旧值和新值。覆盖校验只产生接受/回退决策和 Trace 诊断，不写回 Fact；第二层只决定进入 STM 的表示，不删除或 supersede 第一层原始事实。

## Temporal Search

### Request contract

```ts
interface TemporalSearchRange {
  startTime: string;
  endTime: string;
  basis?: "evidence" | "valid" | "auto";
}

interface ContextQuery {
  q: string;
  layer?: "all" | "evidence" | "stm" | "ltm";
  referenceTime?: string;
  timezone?: string;
  locale?: string;
  timeRange?: TemporalSearchRange;
  // existing tenant/principal/source/page fields remain
}
```

时区优先级：`request.timezone > principal profile timezone > tenant timezone > Asia/Shanghai`。`referenceTime` 缺省使用搜索请求接收时的 now，绝不使用 Session `createdAt`。

### Resolver

```ts
interface ResolvedTemporalQuery {
  range?: { startTime: string; endTime: string };
  basis: "evidence" | "valid" | "auto";
  referenceTime: string;
  timezone: string;
  confidence: "low" | "medium" | "high";
  source: "explicit" | "deterministic" | "semantic" | "none";
}
```

解析顺序：

1. 显式 `timeRange`，优先级最高；
2. 确定性表达：明确日期；中英文今天/昨天/前后天；上/本/下周、月、年；过去/最近/接下来 N 分钟、小时、天、周、月、年；以及 N 个单位前后、`ago/later/from now/after N units`；
3. 注入的 semantic resolver 处理“之前那次、月底前、春节后”等表达；
4. 无法确定时返回 `source=none`，不执行硬时间过滤。

所有本地自然日转换为半开区间 `[startTime,endTime)`。候选时间匹配使用区间相交；单点时间按 `startTime` 处理。对 `validTimeEnd=null` 的事实按单点 valid time 处理，除非 structured fact 明确提供范围。

确定性解析区分三种语义：`过去两周` 是范围，`两周前` 是相对点，`持续两周` 是 duration 而不是发生时间。分钟/小时使用 reference instant，天/周使用本地自然日，月/年使用带月末截断的日历运算，不按固定 30/365 天换算。`几小时后`、`a few days later` 等数量不确定表达不得猜测；保留为未解析并交给可选 semantic resolver，semantic 失败时不生成时间范围。

### Search pipeline

```text
resolve temporal query
  -> retrieve/over-fetch graph + evidence candidates
  -> materialize memory/fact/source metadata
  -> permission + lifecycle filter
  -> exact temporal filter (structured fact first)
  -> dedupe evidence/STM/LTM
  -> calculate recency from evidence/valid time
  -> sort
  -> paginate
```

时间过滤不能仅放在 `routeSignals.time`。为避免高语义但范围外的结果占满候选集，检索层必须支持时间 envelope 下推或至少 over-fetch（默认请求页大小的 4 倍，设置上限），materialize 后再执行精确过滤。

`recency` 计算：

- evidence layer 使用消息/segment evidence time；
- STM 使用 temporal metadata 中的 evidence end 或相关 valid end；
- LTM 使用 temporal metadata，不读取 lifecycle status 作为内容新鲜度；
- `refreshedAt` 只保留在索引审计字段和 staleness 诊断中。

### Result contract

```ts
interface ContextSearchTemporalResult {
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  validTimeStart?: string;
  validTimeEnd?: string;
  matchedBasis?: "evidence" | "valid";
  evidenceTimeConfidence?: "low" | "medium" | "high";
  validTimeConfidence?: "low" | "medium" | "high";
}
```

`dropped` 增加 `outside_evidence_time_range`、`outside_valid_time_range`、`temporal_metadata_missing` 等原因。返回的 `total` 是时间过滤、权限过滤和去重后的总数。

## Evidence Retrieval and Context Pack

### Evidence adapter

```ts
interface EvidenceSearchCandidate {
  id: string;
  content: string;
  sourceRefs: SourceRef[];
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  permissionStatus: "allowed" | "filtered";
  score: number;
}
```

首批 adapter：

- `conversation_messages`：引用 `conversation_message` row ID 和逻辑 message ID metadata；
- parsed data lake segments：继承 parent event/segment evidence time；
- Fact/STM/LTM 关联的原始 evidence：通过 source refs 回链。

`layer=all` 查询三层。为兼容旧 MCP，`layer=stm/ltm/all` 继续有效，`evidence` 作为新增可选值。被权限过滤的 candidate 不得带出正文或摘要，只能在内部 dropped/trace 中记录。

### Context Pack

`ContextPackItem` 增加 temporal object，`ContextPack` 增加解析后的 query temporal metadata。压缩器只能改变 `content/compressedContent`，不能删除：

- query range、timezone、basis；
- evidence/valid 时间和 confidence；
- `sourceMessageIds`、source refs、matched basis。

同一事实的 raw evidence、STM、LTM 去重时合并来源和时间信息，优先保留最具体的 `conversation_message`/`parsed_segment` ref。`recentContext` 按 evidence time 降序排序；事实时间只影响 valid basis 的匹配，不替代最近消息排序。

serialized prompt 示例：

```text
【时间范围】2026-07-22 00:00 至 2026-07-23 00:00（Asia/Shanghai，按消息证据时间）
- 用户计划于 8 月 1 日去深圳（事实时间：2026-08-01；消息时间：2026-07-23 15:30；来源：msg_user）
```

## Session Background

`CreateSessionBackgroundRequest` 新增可选 `referenceTime/timezone/locale`。窗口计算：

```ts
const referenceTime = normalized.referenceTime ?? normalized.now();
const windowEnd = normalized.dynamicWindowEnd ?? referenceTime;
```

`createdAt` 仅用于校验 Session 创建时间，不得限制 window end。快照复用 key 包含固定背景 revision、latest STM cursor、解析后的本地自然日和 temporal timezone；force refresh 始终重新计算 dynamic section。

## Migration and Rollout

### Migration order

1. 创建/恢复 conversation message 和 document-message 表及 owner/session/time 索引。
2. 增加 Fact、STM、LTM temporal columns 和 JSON structured fact fields。
3. 增加 `context_engine_migrations` 记录表或等价版本记录，迁移每个版本只成功提交一次。
4. 旧表回填：`committedAt` 只作为 low-confidence evidence fallback，`validTime` 保持 NULL。
5. 从可重新解析的原始 Markdown 回填真实消息 ID、时间、Fact evidence time 和 memory temporal metadata。
6. 双读校验新旧路径，确认 batch message isolation、Fact 数量和 source refs 一致后切换写路径。

### Feature flags

- `CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS=false`：Agent 扩展输出开关，默认关闭。
- `CONTEXT_ENGINE_TEMPORAL_READ=false`：后端双读/影子比较开关。
- `CONTEXT_ENGINE_EVIDENCE_LAYER=false`：evidence layer 灰度开关。
- `CONTEXT_ENGINE_TEMPORAL_HARD_FILTER=false`：硬过滤灰度开关，开启前仅记录影子结果。

上线顺序：migration 和双读 -> V3 parser/persistence -> Fact temporal -> STM/LTM -> search/Pack -> background -> Agent 开关。回滚只关闭 read/Agent flags，保留新增列和数据，不执行 destructive downgrade。

## Error and Observability

新增错误/trace 分类：

- `TEMPORAL_PROTOCOL_INVALID`：时区、locale、RFC3339、消息时间关系或混用格式错误；
- `TEMPORAL_SOURCE_NOT_FOUND`：候选 sourceMessageId 不属于当前 Session；
- `TEMPORAL_QUOTE_MISMATCH`：quote 不在声明来源消息中；
- `TEMPORAL_RANGE_INVALID`：显式查询区间非法或 end 不晚于 start；
- `TEMPORAL_METADATA_MISSING`：候选缺 temporal metadata；
- `TEMPORAL_BACKFILL_FAILED`：单项 backfill 失败，可重试且不影响已完成项。

Trace 必须记录：ingestion/session/document、temporal mode、timezone、resolver source/confidence、time basis、source row IDs、过滤前后数量、drop reasons、backfill version 和耗时。日志和 prompt trace 不输出未授权消息正文。

## Verification Strategy

### Unit and contract tests

- 旧 V3 仍可解析；扩展 V3 全字段可解析；混用、重复 ID、非法时区、非法 RFC3339、倒序 completedAt 会失败。
- 扩展 batch 写入后能按 Session 隔离读取消息；重复摄入幂等；replace/delete revision 可审计。
- “2026-07-23 消息 + 明天”解析到正确本地日期；延迟抽取不改变 evidence/valid time。
- quote 必须命中指定消息；sourceMessageIds 缺失或越界不能成为 active Fact。
- 多消息 evidence min/max 正确；旧数据 confidence 为 low；observedAt 不污染 valid/evidence。
- STM/LTM 重建保留 temporal metadata，非连续事实不因 envelope 产生错误精确命中。

### Search and Pack tests

- “昨天聊了什么”只命中本地自然日 evidence；“什么时候去深圳”按 valid time 命中。
- 时间范围外的高语义候选在排序前被 dropped；auto 返回实际 matched basis。
- `layer=all` 可召回 evidence、STM、LTM 并按具体 source ref 去重。
- recency 不受 `refreshedAt`、LTM lifecycle 或重新索引影响。
- Context Pack 压缩后仍保留 range、timezone、matched basis、confidence 和 source IDs。

### End-to-end acceptance

使用扩展 V3 上传：

```text
2026-07-23 15:30 Asia/Shanghai
用户：我计划 8 月 1 日从郑州去深圳。
```

验收：

1. 消息 `createdAt` 未被 committed/extracted time 覆盖；
2. Fact `validTimeStart` 表示 8 月 1 日，`evidenceTimeStart` 表示 7 月 23 日 15:30；
3. `observedAt` 是实际抽取时间；
4. 查询“我什么时候去深圳”命中 valid basis；
5. 查询“7 月 23 日我们聊了什么”命中 evidence basis；
6. Context Pack 引用具体 message row 和逻辑 message ID；
7. Session 跨午夜后背景 dynamic section 使用新的 reference time。
