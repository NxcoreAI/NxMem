## Context

当前实现向 OpenAI-compatible `chat/completions` 发送 `response_format: { type: "json_object" }`，再从 `choices[0].message.content` 解析 JSON，并要求 `payload.candidates` 为数组。`json_object` 不能保证字段结构；同时，解析异常在 Trace 保存前抛出，只在 ingestion/job 中留下通用错误。

## Goals / Non-Goals

**Goals:**

- 在提供方支持的 OpenAI-compatible 接口上使用严格 JSON Schema 约束候选事实输出。
- 将合法空候选与格式错误明确区分。
- 保留每次失败尝试的原始响应和具体解析原因。
- 保持现有事实候选校验、准入和下游流程不变。

**Non-Goals:**

- 本变更不调整 `agent_inferred` 或 `evidence_only` 的准入规则。
- 本变更不实现前端按批次过滤。
- 本变更不自动接受 `facts`、`result.candidates` 等非协议字段。

## Decisions

### Decision 1: 使用顶层必需 `candidates` 的严格 JSON Schema

请求使用 `response_format.type = json_schema`，Schema 要求顶层对象不得包含未声明字段且必须包含 `candidates`。`candidates` 允许为空数组，每个非空元素要求事实提取协议中的核心字段。

### Decision 2: 空候选是成功终态

Prompt 明确要求没有候选时返回 `{"candidates":[]}`。该响应通过 Schema 和本地校验后继续 Phase 3，并以 `processing_succeeded`、`factCandidates = 0` 完成，不进入 `fact_pending`。

### Decision 3: 使用携带上下文的提取错误

事实提取层抛出包含错误码、原始响应、endpoint、model、key source 和 prompt template 的错误对象。Phase 3 在标记 `fact_pending` 前先保存失败 Trace。

### Decision 4: 每次尝试使用独立 Trace ID

Trace ID 加入 job attempt。失败原因写入 `fallbackReason`，原始响应写入 `rawResponse`；成功 Trace 同样使用尝试编号，确保同一 ingestion 的多次请求均可审计。

### Decision 5: 数字事实采用原子覆盖并禁止时间轴物化合并

抽取模型必须逐消息、逐分句枚举日期、时间、金额、数量、比例、频率、序号和区间边界；不同实体、事件或时间点分别生成候选。时间轴关系判断可将这类事实标记为支持、冲突或待确认，但不得通过 `same_event`、`supplements` 或 `updates` 生成替代原子事实的聚合表示。协议层在模型误判时拒绝该物化结果并回退到原子事实。

### Decision 6: 实体修饰词属于实体身份

实体匹配使用完整规范名称；不能因为一个名称包含另一个名称就视为别名或同一实体。`tennis` 与 `table tennis` 等修饰后名称必须分别保留、检索和回答，除非证据显式声明别名关系。

### Decision 7: 月份相对点使用规范月份，持续状态使用区间

`last month`、`N months ago` 等月份粒度的相对点以来源消息的 evidence time 为锚，先归一化到当月月初，再执行日历月偏移。可由当前消息锚定的 `has/have been ... for N months` 保存为从目标月份月初到 evidence time 的 valid-time 区间。确定性修复优先读取逐字 evidence quote 或 source claim，避免规范化事实文本丢失原始相对时间语义。

## Risks / Trade-offs

- 部分 OpenAI-compatible 服务可能不支持 `json_schema`。这种情况会作为 `FACT_EXTRACTION_UNAVAILABLE` 留痕，而不是静默退回弱约束模式。
- 严格 Schema 会增加请求体积，但可显著减少不可审计的格式漂移。
- 现有 Trace 查询可能看到同一 ingestion 的多条尝试记录，这是预期的审计行为。
