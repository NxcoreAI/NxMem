## Context

记忆 Context 引擎是极核 Agent 的认知基础设施。PRD 将它定义为“双存储层（STM/LTM）+ 三过程（存储、做梦、召回）”的系统：存储过程负责事件摄入、多模态解析、数据湖、时间融合、事实存储和短期记忆准入；做梦过程负责把高价值 STM 巩固为 LTM，并对 LTM 做强化、修订、降权和归档；召回过程负责从 STM/LTM 同时检索，并由 Context 组装层输出 Agent 可消费的 Context Pack。

实现构想进一步给出模型和工程边界：`MemoryEvent`、`MultimodalDataItem`、`FactItem`、`ShortTermMemory`、`LongTermMemory`、`SourceRef`、`PermissionSnapshot`、`RelationEdge`、`ContextPack`、`MemoryChangeEvent`。这些对象必须保留来源、权限、时间、版本、状态、置信度和可解释规则，避免把多源原始数据直接压缩成不可审计的“最终记忆”。

该设计还需要支持一个调试前端。调试前端不是最终用户的记忆图谱或 AI 日记，而是工程和产品验收工具，用于解释为什么某条数据被摄入、被拒绝、被写入 STM、被巩固为 LTM、被检索、被丢弃或被纳入 Context Pack。

## Goals / Non-Goals

**Goals:**

- 实现 text-first MVP 的 Context 引擎契约，覆盖事件摄入、数据湖元数据、事实存储、STM、LTM、关系边、检索、Context Pack、反馈和记忆变化事件。
- 保证从 Agent 可见上下文回溯到 Context Pack 条目、记忆、事实、解析片段、事件和原始来源引用。
- 在写入时捕获权限快照，在检索和组装前做实时权限校验，并在权限撤销或删除后立即停止召回。
- 支持固定背景信息文本和新会话动态背景载入，避免把未经确认的长期画像自动写回固定背景。
- 提供可解释检索排序：硬过滤、多路召回、组件打分、重排、去重、冲突处理和 token 预算裁剪均可追踪。
- 提供调试前端与 mock/fixture 模式，使后端未完整实现时也能调试前端交互和验收关键状态。
- 提供 Recall@K、Precision@K、MRR@K、NDCG@K、延迟、token 使用、来源完整性和失败类型的评测钩子。

**Non-Goals:**

- 首期不要求完整生产级 VLM、ASR、OCR、人脸或情绪解析模型；可以先实现文本、文档、工具结果路径，并保留多模态适配器边界。
- 首期不强制引入独立向量数据库、图数据库、Temporal 或 Kafka；除非仓库已有相关基础设施，否则先以现有数据库、索引和轻量 job table 起步。
- 不自动静默改写固定背景信息文本；写回需来自用户编辑、显式“记住”或确认后的更新建议。
- 调试前端不替代用户可见的记忆图谱、AI 日记或白盒 Context 管理，只提供内部诊断能力。
- 多用户设备账户切换、跨家庭共享权限和复杂组织授权不是本变更必须解决的范围，除非现有身份系统已支持。

## Decisions

### Decision 1: 采用分层存储和稳定 ID 链路

数据按 Data Lake、Fact Store、STM、LTM、RelationEdge、ContextPackTrace 和 MemoryChangeEvent 分层持久化。每一层保留稳定 ID、来源引用和反向链接，不物理合并原始证据。

理由：PRD 要求来源可追溯、关系化去重、冲突可解释、权限失效可回收。稳定链路能解释“为什么这条 Context 出现在 Agent prompt 中”，也能在删除或权限撤销后定位派生产物。

拒绝方案：只保存最终记忆摘要。该方案实现简单，但丢失证据链，无法可靠处理冲突、权限和审计。

### Decision 2: Fact Store 是 STM 的必经上游

`write_event` 和 `write_agent_memory` 都必须先创建或关联 `FactItem`，再经过 STM 准入策略。Agent 快速写入可以跳过重型多模态解析，但不能跳过事实层、权限快照、来源引用和准入解释。

理由：事实层承载版本、冲突和证据回链，是后续纠错、合并、降权和评测的稳定中间层。

拒绝方案：允许 Agent 直接写 STM。该方案延迟低，但容易产生无来源、不可修订、不可解释的记忆。

### Decision 3: 检索采用“硬过滤 + 多路召回 + 组件打分”

检索先按 tenant、principal、权限、生命周期、敏感等级和时间边界做硬过滤，再结合 BM25/关键词、向量、图谱邻域、时间窗口、最近会话、用户确认、重要性和反馈信号排序。

默认排序公式来自方案，可配置但必须可解释：

```plain
final_score =
  0.25 * semantic_score
+ 0.20 * keyword_score
+ 0.15 * graph_score
+ 0.15 * recency_score
+ 0.10 * importance_score
+ 0.05 * source_reliability
+ 0.05 * user_feedback_score
+ 0.05 * diversity_score
- 0.20 * conflict_penalty
- 0.30 * permission_risk_penalty
- 0.10 * staleness_penalty
```

理由：向量召回不能可靠覆盖精确标识、近期事件、权限边界和实体关系。组件打分能让调试前端解释排名。

拒绝方案：只做 vector-only retrieval。它会漏掉关键词、时间和图谱强相关项，也难以解释授权和冲突。

### Decision 4: R1 检索和 R2 Context 组装分离

R1 返回候选、分数、来源和过滤原因；R2 根据任务、预算和权限把候选组装成 `ContextPack`，输出 `profile_context`、`task_context`、`recent_context`、`constraints`、`citations`、`conflicts`、`token_budget` 和 dropped items。

理由：Agent 消费的是压缩、去重、带来源和冲突提示的上下文包，不应直接消费裸检索列表。

拒绝方案：把检索结果直接传给 Agent。这样会让 token 预算、引用保留、冲突处理和权限裁剪分散到各个 Agent。

### Decision 5: 用异步任务处理解析、融合、索引、做梦和清理

写接口同步完成校验、幂等、权限快照、原始事件保存和 job 创建；解析、时间融合、事实抽取、索引刷新、STM 准入、做梦、权限同步、删除清理由 worker 执行。任务必须有 lease、checkpoint、retry、idempotency hash 和 terminal state。

理由：PRD 中“数据湖写入 < 1 分钟、事实写入 < 2 分钟、STM 写入 < 5 分钟、Agent 快速写入 < 5 秒”的目标需要把长耗时工作异步化，同时保持故障可恢复。

拒绝方案：写 API 内同步完成全链路处理。该方案容易超时，也难以恢复部分失败。

### Decision 6: 调试前端围绕 trace，而不是 CRUD 表格

调试前端主视角为 event -> parsed segment -> fact -> STM/LTM -> retrieval candidate -> Context Pack item -> MemoryChangeEvent。它包含摄入 trace、证据/事实/记忆浏览器、检索 playground、Context Pack inspector、背景信息 inspector、权限/敏感信息诊断、生命周期审阅和指标面板。

理由：核心风险不是“能不能建表”，而是“为什么这条上下文被使用或被丢弃”。trace 视角能直接定位产品和工程问题。

拒绝方案：只做数据库表浏览器。原始表对排查有用，但无法解释 R1/R2 的决策过程。

### Decision 7: 生命周期用显式状态机表达

Data Lake、Fact、STM、LTM 都使用显式状态决定可见性、召回资格、索引行为和清理义务：

- Data Lake: `raw -> parsed -> indexed -> archived -> deleted`
- Fact: `candidate -> active -> superseded/conflicted -> archived/deleted`
- STM: `active -> expired -> candidate_queue -> consolidated/dropped/deleted`
- LTM: `active -> weakened -> archived -> deleted`，以及 `active -> revised`

理由：权限撤销、用户删除、事实纠错、做梦巩固和索引清理都需要明确状态，而不只是时间戳。

拒绝方案：只用 nullable timestamp 表示生命周期。它不能清楚表达召回资格和维护动作。

### Decision 8: 敏感信息策略优先于模型判断

凭证密钥、身份标识、财务/医疗/法律信息、私密关系、企业机密、未成年人信息和位置轨迹等敏感内容在索引和准入前分类。高敏默认 rejected 或 pending_confirm，中敏可进入 Data Lake 但默认不向量化，Context Pack 默认只输出脱敏摘要和 SourceRef。

理由：记忆系统会放大敏感内容的长期暴露风险，不能只依赖来源权限。

拒绝方案：只按 source permission 控制。派生事实和摘要仍可能泄露敏感原文。

### Decision 9: LLM 产物必须校验后持久化

事实融合、实体规范化、STM 准入、做梦巩固、冲突判断和摘要压缩的 LLM 输出必须通过 schema 校验，并记录 prompt_version、model、schema_version、confidence inputs、retry count 和 fallback。缺少来源、低置信或高风险内容不得生成 active memory。

理由：LLM 是抽取和压缩工具，不应成为不可审计的持久真相来源。

拒绝方案：直接持久化模型输出。该方案会把抽取错误变成长期记忆污染。

## Risks / Trade-offs

- [Risk] 首期多模态解析覆盖不足。 -> 通过 parser adapter 接口先支持文本、文档和工具结果，不支持的模态保留 raw/pending 状态。
- [Risk] 实时权限校验增加检索和组装延迟。 -> 先用权限快照粗过滤，再在 R2 前批量实时校验，并记录被过滤原因。
- [Risk] LLM 抽取或压缩质量不稳定。 -> 强制 schema 校验、来源引用、置信度、重试上限和 pending_confirm/rejected fallback。
- [Risk] Context Pack 压缩丢掉关键约束。 -> 预算分类预留 constraints、citations、conflicts、safety，并记录 dropped reasons。
- [Risk] 关系化去重会让存储中存在多个相似记录。 -> 存储层保留原始记录，展示和 R2 阶段通过 relation edge 合并。
- [Risk] 调试前端可能暴露敏感信息。 -> 调试 API 复用同一权限和敏感信息裁剪逻辑，默认展示脱敏摘要。
- [Risk] 前端开发被后端进度阻塞。 -> 首期提供 mock/fixture 模式，覆盖检索分数、Context Pack、权限失败、冲突和生命周期。

## Migration Plan

1. 盘点现有仓库后端、前端、数据库、任务队列、鉴权、日志、测试和配置模式，确定模块位置和 feature flag。
2. 添加数据模型、迁移和 repository：事件、数据湖、来源引用、权限快照、事实、STM、LTM、关系边、任务、检查点、ContextPackTrace、MemoryChangeEvent。
3. 实现写 API、幂等、校验、权限快照、job 创建和错误码契约。
4. 实现 text-first parser、时间融合、事实抽取、STM 准入、索引刷新和失败重试。
5. 实现 R1 检索、硬过滤、组件打分、去重、冲突传播、R2 Context Pack 组装和背景信息动态载入。
6. 实现 Dreaming MVP：候选选择、LTM 创建/修订/降权、检查点、记忆变化事件和索引刷新。
7. 实现反馈、权限失效、删除和敏感信息策略。
8. 实现调试前端 read-only trace，再增加受控反馈/生命周期操作和本地 mock 调试模式。
9. 增加评测 fixture、LoCoMo/LongMemEval 类数据集适配、延迟/来源完整性测试和前端响应式检查。

回滚策略：所有 Agent 消费、worker 和调试前端都 behind feature flag。出现问题时先关闭 Agent 读取和 R2 注入，再暂停 worker；已写入的 raw event、fact 和 audit 保留用于重放或清理。

## Open Questions

- 首期持久化应使用 SQLite、PostgreSQL、pgvector 还是仓库已有抽象？
- 实时权限校验由哪个身份/授权服务提供？权限撤销事件是否有 webhook？
- STM TTL、容量、准入阈值和超限清理策略如何设置？
- 向量、rerank、事实融合和摘要压缩允许使用哪些本地或云端模型？
- 不同 Agent 类型的 Context Pack token 预算如何设定？
- 首期必须支持哪些模态解析器？图片、音频、视频是否只做 pending 状态？
- 固定背景信息各栏目 token 预算、更新建议确认规则和版本历史如何呈现？
- LoCoMo/LongMemEval 类评测数据集如何落到本仓库测试环境？
