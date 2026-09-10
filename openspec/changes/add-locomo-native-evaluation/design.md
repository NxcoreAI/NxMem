## Context

LoCoMo 固定数据集包含 10 个长对话、272 个 session、5,882 个 turn 和 1,986 道 QA。每个顶层 sample 的 `conversation` 是 Context Engine 的运行输入，同一 sample 下的全部 `qa` 共享这份记忆。

现有 `locomo-retrieval-benchmark.ts` 已能解析 session、turn、`dia_id`、时间和图片 caption，也能按 `sample_id` 生成 tenant/principal 隔离字段；但准备阶段直接将 `observation` 转为 `locomo-observation-fact.v1`，属于 Oracle Fact 召回评测。现有 LongMemEval 端到端链路包含成熟的样本隔离、Fact/STM 处理、答题证据选择、Context Pack、结果提交和恢复逻辑，但其数据模型是一题一个 haystack，评分使用二元 LLM Judge，不能直接承载 LoCoMo。

本变更新增 LoCoMo 原生 orchestration，只复用 Context Engine 的执行能力和数据集无关的答题上下文能力，不复用 LongMemEval sample 格式或 Judge。

## Goals / Non-Goals

**Goals:**

- 一个长对话只摄入一次，在隔离记忆空间中回答其全部问题。
- 运行时只接收原始对话，杜绝 answer、evidence、category 和 observation 向记忆层泄漏。
- 首版执行 Fact 抽取、时间轴聚合、STM 准入和索引，不执行或召回 LTM。
- 复用当前答题召回、证据预算选择、Context Pack 拼接和答案模型调用的核心策略。
- 精确复刻固定上游 commit 的 LoCoMo 官方评分，并输出可审计的逐题结果和阶段漏斗。
- 用隔离、fingerprint、golden fixtures 和回归测试保证现有 LongMemEval 与 Oracle LoCoMo retrieval 结果不变。

**Non-Goals:**

- 不把 LoCoMo 转换为 LongMemEval JSON。
- 不在首版运行 dreaming、生成 LTM 或评测 LTM 召回。
- 不把 Gold observation 当作 Fact 写入端到端 Store。
- 不使用 `category` 提示检索器、Context Pack selector 或回答模型。
- 不下载或视觉解析原始图片；首版只使用数据集提供的 `blip_caption`。
- 不宣称实时外部 LLM 调用能够逐字符确定性复现；精确回归使用固定响应 fixture/replay。

## Decisions

### 1. 使用 LoCoMo 原生的 Conversation/Question 两级域模型

适配层输出两类对象，而不是伪造 LongMemEval sample：

```ts
interface LocomoEvaluationConversation {
  conversationId: string;
  tenantId: string;
  principalId: string;
  contextScopeId: string;
  sessions: LocomoEvaluationSession[];
  questions: LocomoEvaluationQuestion[];
}

interface LocomoEvaluationQuestion {
  questionId: string;
  question: string;
  referenceAnswer: string;
  category: 1 | 2 | 3 | 4 | 5;
  goldDiaIds: string[];
  referenceTime?: string;
}
```

Conversation 负责一次性摄入，Question 只引用已准备好的 conversation scope。该模型直接表达 LoCoMo 的共享长对话语义，避免同一对话按题目重复摄入。

### 2. 固定原始字段映射

| LoCoMo 字段 | 评测/运行时字段 | 规则 |
| --- | --- | --- |
| `sample_id` | `conversationId` | 缺失时沿用现有稳定回退 `sample-<index>`；结果中记录是否回退 |
| `sample_id` | `principalId` | `locomo:<safe-sample-id>` |
| 数据集 hash + `sample_id` | `contextScopeId` | `locomo:<dataset-hash-prefix>:<safe-sample-id>`，同一数据集内稳定 |
| `conversation.session_N` | `sessionId` | 保留 `session_N`，按 N 数值升序摄入 |
| `conversation.session_N_date_time` | `eventTime/evidenceTime` | 使用现有 LoCoMo 日期解析器转 ISO；解析失败即输入错误，不回退 1970 |
| turn `dia_id` | `sourceId/sourceMessageId` | 作为 gold evidence 对齐的唯一稳定键 |
| turn `speaker` | source metadata + transcript label | 原样保留人名，不强制映射为 user/assistant |
| turn `text` | segment content | 以 `<speaker>: <text>` 进入解析链路 |
| turn `blip_caption` | segment image description | 非空时追加 `Image description: ...` |
| turn `img_url` | audit metadata | 首版不请求 URL，不将 URL 文本当作语义证据 |
| `qa[index]` | `questionId` | `<sample_id>:q<1-based-index>` |
| `qa.question` | query/task | 原样传给召回和答案生成 |
| `qa.answer` | `referenceAnswer` | string 原样保留；number/boolean 使用无损字符串化；其他类型输入失败 |
| `qa.evidence` | `goldDiaIds` | 去括号、拆分复合引用、去重；只用于评测 sidecar |
| `qa.category` | scorer route/report dimension | 只允许 1..5；不得进入检索、selector 或 answer prompt |
| `observation` | evaluator sidecar | 可用于离线抽取覆盖诊断，但绝不进入 Context Engine Store |
| 最后一个合法 session 时间 | `referenceTime` | 同一 conversation 下全部问题默认使用；原始问题未提供独立提问时间 |

适配器 SHALL 校验数据集不变量，并在运行前报告 conversation/session/turn/question/category/evidence 数量及 dataset SHA-256。

### 3. 使用同一 Store 的逻辑隔离和不同运行的物理隔离

一次 run 使用独立 SQLite 路径和独立 graph namespace。run 内可以让多个 conversation 共用 repository，但所有 MemoryEvent、Fact、STM、索引项、检索和 Context Pack 必须同时受到以下范围约束：

```text
tenantId       = locomo
principalId    = locomo:<sample_id>
contextScopeId = locomo:<dataset-hash>:<sample_id>
```

`searchContext` 和答题 Context Pack builder 必须显式传递三个字段。Store 打开时记录 dataset hash、pipeline profile、embedding fingerprint、reranker、模型、prompt 和 schema fingerprint；`evaluate` 复用 Store 时任何 fingerprint 不匹配都必须失败，不允许静默复用。

### 4. 每个长对话按时间顺序完成无 LTM 的准备阶段

每个 conversation 的准备顺序为：

```text
session_1 raw turns
  -> MemoryEvent / segments
  -> Fact extraction
  -> session timeline aggregation
  -> STM admission
  -> Fact/STM text and vector index refresh
session_2 ...
...
all sessions completed
  -> assert no pending ingestion task
  -> assert LTM count == 0
  -> freeze conversation for question evaluation
```

复用当前 LongMemEval 已验证的 session 处理 primitive，但由 LoCoMo runner 直接构造原生事件和 source refs。不得调用 `ingestLocomoObservationFacts`。某 session 失败时按现有内部重试和 stage 外层重试执行；最终失败则该 conversation 下全部问题记录为 skipped，不允许在半完成 Store 上评分。

首版 profile 固定为 `locomo-fact-stm-v1`：

- dreaming/LTM scheduler 不启动；
- repository 中选中 conversation 的 LTM 数必须为 0；
- 召回结果和 Context Pack 出现 `layer=ltm` 时视为不变量失败；
- CLI 不提供 `--enable-ltm`，避免同一 profile 下出现不可比较结果。

### 5. 使用 conversation 级屏障，完整准备一个长对话后立即回答

LoCoMo 官方 QA 基于完整长对话，因此同一 conversation 的问题不会穿插到其 session 摄入过程中。conversation 准备成功后，问题立即在只读语义下并发执行，不需要等待本次 run 中其他 conversation 完成准备。首版按原始 conversation 顺序执行“准备当前 conversation → 回答当前 conversation 全部目标问题 → 进入下一 conversation”，避免下一 scope 的写入与当前 scope 的答题检索交错：

```text
qa.question
  -> searchContext(tenantId, principalId, contextScopeId, referenceTime)
  -> optional configured reranker
  -> dataset-neutral evidence selection within fixed token budget
  -> Context Pack + citations/conflicts/temporal metadata
  -> serialized prompt
  -> answer model
  -> official scorer
  -> atomic result row
```

问题并发不得修改 Fact/STM。每道题失败只跳过该题，不影响同 conversation 的其他问题；结果按原始 conversation 顺序和 QA 顺序稳定汇总。

### 6. 抽取数据集无关的 Benchmark Answer Context 能力

当前 LongMemEval 的 evidence selection 和专用 Context Pack builder 已针对最多 100 个候选、事实正文、跨 session 覆盖、时间关系、token budget 和最多若干关键证据进行优化。将该能力抽取为数据集无关 helper：

```ts
buildBenchmarkAnswerContext(repository, {
  questionId,
  question,
  tenantId,
  principalId,
  contextScopeId,
  referenceTime,
  allowedLayers: ["fact", "stm"],
  candidateLimit,
  evidenceLimit,
  tokenBudget,
  embeddingClient,
  memoryReranker
})
```

LongMemEval 继续通过兼容 wrapper 使用原有默认参数，输出候选顺序、选择结果、serialized prompt 和 trace 必须保持不变。LoCoMo 调用显式 scope 和 `allowedLayers=[fact, stm]`。helper 不接收 category、reference answer 或 gold evidence。

`assembleContext`/`searchContext` 中缺失的可选 `contextScopeId` 透传必须补齐，并用跨 conversation 混合 Store 测试证明隔离有效。

### 7. 官方评分器采用 TypeScript 纯函数并与上游逐题对齐

评分器输入仅为 `{ category, referenceAnswer, hypothesis }`，输出 `{ score, normalizedReference, normalizedHypothesis, scorerVersion }`。实现固定上游 commit `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376` 的行为：

- 归一化：小写、删除逗号、删除英文标点、删除独立词 `a/an/the/and`、压缩空白；
- token F1：使用与 NLTK `PorterStemmer` 对齐的英文词干，按 multiset overlap 计算 precision/recall/F1；
- category 1：reference 与 hypothesis 按逗号拆分；对每个 reference 子答案取所有 hypothesis 子答案中的最大 token F1，再求平均；
- category 2/4：对完整 hypothesis 和完整 reference 计算 token F1；
- category 3：reference 先按第一个分号截断并 trim，再计算普通 token F1；
- category 5：hypothesis 小写后包含 `no information available` 或 `not mentioned` 得 1，否则得 0；
- 每题官方分数先 round 到 3 位小数，再参与 category 和 overall 汇总。

类别分数为该类问题分数平均值；overall 为全部问题按题数自然加权的平均值，不是五类 macro average。额外输出 `perfectScoreRate`，避免把平均 F1 误称为完全答对率。

通过固定 prediction fixtures 同时运行上游 Python scorer 和 TypeScript scorer，要求每题及聚合结果一致。生产 CLI 不依赖 Python。

### 8. Gold 数据只用于评分和漏斗诊断

每道题在系统执行完成后，evaluator 使用 `goldDiaIds` 计算：

- retrieval evidence recall：候选 `sourceRefs.metadata.diaId` 对 gold 的覆盖；
- Context Pack evidence recall：最终选中项对 gold 的覆盖；
- recall any/all；
- evidence 从 retrieval 到 pack 的保留率。

`observation` 可在 Store 外与抽取 Fact 的 source refs 对齐，计算 `factExtractionEvidenceCoverage`，但 observation claim 不参与摄入、embedding、查询、候选选择或回答。

### 9. 结果、Trace 与恢复契约

新增 `eval:locomo`，支持：

```text
full      准备全部选中 conversation 并回答问题
prepare   只准备 Fact/STM Store
evaluate  校验 fingerprint 后只读回答问题
```

关键参数包括 `--dataset`、`--sample-id`、`--sample-range`、`--store-path`、`--result`、`--trace`、`--resume`、`--retry-skipped`、`--ci`、固定的并发和模型配置。结果 JSONL 每题一行，至少包含：

- run/dataset/config/scorer/store fingerprint；
- conversation/question identity 和 category；
- reference answer、hypothesis 和官方 score；
- retrieval candidates、Context Pack selected/dropped、serialized prompt hash；
- evidence metrics、token usage、fallback/skipped 状态和耗时。

汇总 JSON 包含数据量校验、各 category 分数、overall official QA score、perfect score rate、Evidence Recall 和 pipeline funnel。Result commit 使用 run/model/question identity 保证幂等；恢复时拒绝 dataset/config/store fingerprint 不一致。

### 10. 兼容性通过双基线保护

实现前固定两组 characterization/golden：

1. 当前 LongMemEval 小样本的 session identity、候选顺序、Context Pack selected IDs、serialized prompt hash 和纯函数指标；抽取共享 helper 后必须完全一致。
2. 当前 `eval:locomo-retrieval` 固定前 50/200 题的 case/gold 数量及 Recall、MRR、NDCG；新增链路不得改变该命令默认结果。

外部 LLM 实时输出不作为逐字符回归依据。答案链路精确回归使用录制响应或 deterministic fake；真实模型 smoke run 只验证无 fallback、无跨 scope 数据和报告完整性。

## Risks / Trade-offs

- [共享 helper 导致 LongMemEval 分数漂移] → 先写 characterization tests，再做只改边界不改算法的机械抽取；兼容 wrapper 固定旧默认参数。
- [Gold observation 泄漏] → 端到端 repository 快照测试拒绝 `locomo-observation-fact.v1`，并扫描 Store 内容不得包含 evaluator-only claim 注入。
- [逻辑隔离不完整] → 使用两个 conversation 共库的负向测试，查询 A 时任何 B 的 Fact/STM/source ref 都不得出现。
- [LTM 意外进入首版] → profile、Store fingerprint、准备后断言和每题候选断言四层防护。
- [官方 scorer 端口偏差] → 使用固定上游 commit 的交叉语言 fixtures，覆盖标点、articles、词干、重复 token、多答案、分号和拒答短语。
- [图片信息缺失] → 首版使用官方数据提供的 caption，结果记录 caption 覆盖率；真实视觉编码作为后续独立 profile。
- [外部模型非确定性] → 记录完整 fingerprint，精确回归使用 replay，真实运行报告模型与 prompt 版本而不承诺逐次相同。
- [同一长对话 QA 并发产生写竞争] → 问题阶段只读 Fact/STM；Context Pack trace 和结果 writer 使用独立 ID 和原子提交。

## Migration Plan

无需迁移现有 Store 或结果。先加入共享 helper characterization tests，再新增 LoCoMo adapter/scorer/runner/CLI。现有 `eval:longmemeval` 和 `eval:locomo-retrieval` 保持原入口。回滚时移除 `eval:locomo` 和新增模块；共享 helper 保留兼容 wrapper 或恢复原内联位置，不影响既有数据。

## Open Questions

- 首版正式基线是否固定启用当前 memory reranker；设计建议将其纳入 profile fingerprint，并分别命名 `locomo-fact-stm-v1-rerank` 与 `locomo-fact-stm-v1-no-rerank`，避免同名分数混用。
- 正式基线使用当前 LongMemEval 专用的证据上限和 token budget，还是单独固定 LoCoMo 数值；无论选择哪组，都必须进入 profile version 和结果 fingerprint。
