## ADDED Requirements

### Requirement: 兼容扩展 V3 对话时间协议

系统 SHALL 在保持 `context-conversation-md.v3` 和 `additionalProperties: false` 的前提下，同时接受旧式 `role/content` 消息和携带真实时间的扩展消息，并 SHALL NOT 允许同一 Session 混用两种消息形态。

#### Scenario: 接收旧 V3 Session

- **WHEN** Session 只包含 `sessionId/cursor/messages`，且每条消息只包含 `role/content`
- **THEN** 系统继续接受并提交该文档，将其识别为 legacy temporal mode

#### Scenario: 接收扩展 V3 Session

- **WHEN** Session 包含合法 IANA `timezone`、合法 BCP 47 `locale`，且所有消息包含唯一 `messageId` 和带 UTC offset 的 RFC3339 `createdAt`
- **THEN** 系统接受该文档并原样保留消息标识、消息时间、可选 `completedAt`、时区和 locale

#### Scenario: 扩展字段不完整

- **WHEN** 消息只提供 `messageId` 或 `createdAt`、Session 缺少 `timezone/locale`、消息 ID 重复、时间无 offset、时间倒序或 `completedAt < createdAt`
- **THEN** 系统以可定位到 Session 和消息索引的协议错误拒绝整个文档，且不提交部分数据

### Requirement: 持久化消息级对话证据

系统 SHALL 在批量提交对话文档时原子保存文档、Session ingestion、消息证据和文档消息顺序，使事实、修订、删除和引用可以稳定关联到具体消息。

#### Scenario: 扩展消息被物化

- **WHEN** 扩展 V3 Session 提交成功
- **THEN** 每条消息按 owner、source app、Session、message ID 和 revision 生成稳定记录，`createdAt` 使用协议值，且保存 `completedAt/timezone/locale/timeConfidence=high`

#### Scenario: 旧消息兼容物化

- **WHEN** 旧 V3 Session 没有消息 ID 和真实时间
- **THEN** 系统生成仅在当前文档和 Session 内稳定的 legacy evidence ID，使用 `committedAt` 作为兼容时间并标记 `timeConfidence=low`，且不得声称该时间为精确消息时间

#### Scenario: 多 Session 文档查询消息

- **WHEN** 一个批量文档包含多个 Session
- **THEN** 文档消息关联同时保存 ingestion 或 Session 范围，按某一 ingestion 查询时只返回该 Session 的消息并保持原始顺序

#### Scenario: 重复或修订消息提交

- **WHEN** 同一消息 ID/revision 被重复摄入或相同 sequence 被不同消息占用
- **THEN** 相同内容被幂等去重，不同内容或冲突 sequence 被拒绝并保留审计错误

### Requirement: 区分证据时间事实时间和处理时间

系统 SHALL 在事实层分别保存来源消息的证据时间、事实在现实世界中的有效时间和系统观察时间，并 SHALL NOT 使用处理时间伪造证据时间或事实有效时间。

#### Scenario: 相对时间事实被抽取

- **WHEN** 2026-07-23 的来源消息在 `Asia/Shanghai` Session 中表达“明天去深圳”
- **THEN** 抽取请求携带来源 `messageId/createdAt/timezone/locale`，事实的 `validTimeStart` 解析为上海时区 2026-07-24，证据时间等于来源消息时间，`observedAt` 等于实际提取时间

#### Scenario: 事实没有语义时间

- **WHEN** 事实文本没有可确定的现实世界时间
- **THEN** `validTimeStart/End` 保持为空，系统仍保存 evidence time，且不得把 evidence、committed、observed 或 refreshed time 写入 valid time

#### Scenario: 多消息支持同一事实

- **WHEN** 一个候选事实引用多条来源消息
- **THEN** `evidenceTimeStart/End` 分别取来源消息 `createdAt` 的最小值和最大值，并为每个 `sourceMessageId` 建立具体 `conversation_message` 来源引用

#### Scenario: 候选来源或引文无效

- **WHEN** `sourceMessageIds` 不属于当前 Session，或 evidence quote 不能在声明的来源消息中逐字找到
- **THEN** 候选事实不得进入 active Fact，并记录 invalid 或 pending verification 原因

### Requirement: 将真实时间传播到 STM 和 LTM

系统 SHALL 将来源事实的 evidence time 和 valid time 传播到 structured facts、STM 和 LTM，并在重新准入、巩固、刷新索引或重建图节点时保留原始内容时间。

#### Scenario: Fact 被准入 STM

- **WHEN** 一个或多个 Fact 被准入为 STM
- **THEN** STM 保存来源 Fact ID、逐事实 structured temporal metadata、可索引的 evidence/valid 时间摘要和分轴时间置信度

#### Scenario: STM 被巩固为 LTM

- **WHEN** Dreaming 将多个 STM 巩固为 LTM
- **THEN** LTM 从来源 STM 和 structured facts 聚合时间，不使用 LTM 创建时间或巩固时间替换来源时间

#### Scenario: 时间摘要跨越不连续事实

- **WHEN** 一个 memory 包含多个不连续的事实时间范围
- **THEN** 顶层时间摘要仅用于候选预过滤，最终时间匹配以任一 structured fact 的真实区间为准，避免把区间空档误判为命中

### Requirement: 同 Session 事实采用无损两层融合

系统 SHALL 先完整保留同 Session 抽取出的不同原子事实，再由第二层 LLM 对互补且不冲突的事实执行自然语言语义融合，并 SHALL 在任何融合失败或信息丢失时使用对应原始事实。

#### Scenario: 第一层保留不同原子事实

- **WHEN** 同一 Session 抽取出“用户使用 Audible”和“用户每天通勤单程 45 分钟”等相关但不等价的事实
- **THEN** 第一层分别持久化这些 active Fact，不选择代表事实、不将其他事实标记为 superseded

#### Scenario: 第二层融合并保留未使用事实

- **WHEN** LLM 将四条通勤和有声书事实完整融合，并未使用“用户正在阅读《消失的爱人》”和“助理介绍了《夜莺》”
- **THEN** 系统物化一个具有稳定新 ID 和完整来源的融合 Fact，STM admission 接收该融合 Fact 以及两条未使用原始 Fact，Fact Store 仍保留全部原始 Fact

#### Scenario: 融合失败回退原始事实

- **WHEN** 第二层缺少 API key、请求重试耗尽、响应不是合法 JSON、输出组越界，或融合文本遗漏数字与单位、日期、专名、否定、限定词、列表顺序、旧值或新值
- **THEN** 系统拒绝受影响融合组，并将组内每条原始 Fact 原样送入 STM admission

#### Scenario: 使用现有字段判断是否融合

- **WHEN** 同 Session 候选事实具有 `factType/normalizedClaim/entityIds/validTime*/status/version` 以及已有来源字段
- **THEN** 系统使用这些字段识别实体一致性、互补语义、冲突和状态变化，不新增持久化 Fact 字段；覆盖校验失败只记录诊断并回退原子事实

#### Scenario: 不执行跨 Session 融合

- **WHEN** 两条 Fact 不共享同一个 `linkedEventId`
- **THEN** 系统不把它们放入同一个第二层融合候选组

### Requirement: 按证据时间和事实时间检索上下文

系统 SHALL 支持在 evidence、STM 和 LTM 三层按 evidence time、valid time 或自动 basis 检索，并在权限与生命周期过滤后、最终排序和分页前执行时间硬过滤。

#### Scenario: 显式时间范围优先

- **WHEN** 调用方提供合法 `timeRange.startTime/endTime/basis`
- **THEN** 系统按半开区间 `[startTime,endTime)` 执行过滤，不再从查询文本推导另一个范围

#### Scenario: 解析本地自然日

- **WHEN** 调用方查询“昨天聊了什么”并提供 `referenceTime` 和 `Asia/Shanghai`
- **THEN** 系统把昨天解析为上海本地自然日的 UTC 对应半开区间，使用 evidence basis，并只返回证据时间相交的候选

#### Scenario: 解析中英文相对范围和相对点

- **WHEN** 查询包含“过去两周”“接下来五天”“一年前”“两周后”“after 2 hours”或等价的确定数量中英文表达
- **THEN** 系统区分范围和相对点，以 reference time 和 IANA timezone 计算半开区间，月和年使用日历运算而不是固定天数

#### Scenario: 不猜测时长或模糊数量

- **WHEN** 查询表达“持续两周”“几小时后”或 `a few days later`
- **THEN** 系统不把 duration 当作发生时间，也不猜测缺失数量；确定性 resolver 返回无范围并允许 semantic resolver 接管

#### Scenario: 查询事实发生时间

- **WHEN** 调用方查询“我什么时候去深圳”
- **THEN** 系统使用 valid basis 匹配事实有效时间，并在结果中返回 `matchedBasis=valid`

#### Scenario: 自动 basis 匹配

- **WHEN** 查询时间语义无法确定为 evidence 或 valid
- **THEN** 系统以 auto basis 检查两条时间轴，任一命中即可保留，但必须返回实际命中的 basis

#### Scenario: 高分候选位于范围外

- **WHEN** 一个候选语义分数高但不与解析后的时间范围相交
- **THEN** 系统在排序和分页前丢弃该候选，并记录 `outside_evidence_time_range` 或 `outside_valid_time_range`

#### Scenario: 时间查询召回原始证据

- **WHEN** `layer=evidence` 或 `layer=all` 且原始消息或 parsed segment 满足权限、文本和时间条件
- **THEN** 系统返回 evidence 结果并引用具体消息或 segment，不得仅返回“来自记忆”的泛化引用

### Requirement: Context Pack 保留时间依据和精确引用

系统 SHALL 在 Context Pack 的结构化结果和 `serializedPrompt` 中保留查询时间范围、时区、命中时间轴、时间置信度和最具体来源引用，压缩不得删除这些字段。

#### Scenario: 时间结果进入 Context Pack

- **WHEN** `search_context` 使用时间约束组装 Context Pack
- **THEN** Pack item 包含 evidence/valid 时间、`matchedBasis` 和分轴置信度，`serializedPrompt` 包含时间范围、时区和按消息时间或事实时间的说明

#### Scenario: 多层结果表示同一事实

- **WHEN** 原始 evidence、STM 和 LTM 命中同一来源事实
- **THEN** 系统去重内容、合并必要的时间信息，并优先保留 `conversation_message` 或 `parsed_segment` 引用

#### Scenario: 最近上下文排序

- **WHEN** 多个候选进入 `recentContext`
- **THEN** 系统按真实 evidence time 排序，而不是按索引 `refreshedAt` 或 memory lifecycle status 排序

### Requirement: 会话背景使用实时 reference time

系统 SHALL 使用请求 reference time 或请求接收时间计算动态背景窗口，并在本地自然日、固定背景版本或 STM watermark 发生有效变化时刷新动态 section。

#### Scenario: 创建新会话背景

- **WHEN** 调用方提供 `referenceTime/timezone/locale`
- **THEN** `dynamicWindowEnd` 缺省使用 `referenceTime`，而 `createdAt` 仅表示 Session 创建时间

#### Scenario: Session 跨本地午夜

- **WHEN** 同一 Session 的后续背景请求跨过指定时区的本地自然日边界
- **THEN** 系统不得永久复用首次快照，应刷新动态 section 并保留新的窗口和时区信息

#### Scenario: reference time 缺失

- **WHEN** 旧 Agent 未提供 `referenceTime/timezone/locale`
- **THEN** 系统使用请求接收时间和配置的时区优先级完成兼容处理，不使用 Session `createdAt` 作为长期动态窗口终点

### Requirement: 幂等迁移和回填历史时间数据

系统 SHALL 通过有版本记录的幂等 migration/backfill 恢复消息证据表、增加 temporal 字段并重算可恢复数据，同时明确区分真实时间和兼容回填时间。

#### Scenario: 扩展 V3 原文可重新解析

- **WHEN** 已提交的原始 Markdown 包含扩展 V3 消息时间
- **THEN** backfill 重建消息证据、Fact evidence time、STM/LTM temporal metadata 和索引，并保持原始消息时间不变

#### Scenario: 旧文档没有真实时间

- **WHEN** 历史文档只有旧 V3 `role/content`
- **THEN** backfill 可以使用 committed time 生成低置信度兼容 evidence，但不得生成高置信度消息时间或事实有效时间

#### Scenario: 重复执行 backfill

- **WHEN** 同一 migration version 被再次执行
- **THEN** 系统不创建重复消息、Fact、memory 或索引记录，并保留可审计的处理数量和失败项
