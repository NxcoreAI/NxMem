## Why

当前 LongMemEval 评测按全量阶段执行：先完成全部样本入库，再对全部样本答题，最后统一评判。该模式导致单个样本迟迟不能形成最终结果，进程中断时也难以保留已完成成果；现有 diagnostics 主要记录答题摘要或失败信息，无法完整还原每个样本各处理环节的输入输出。

## What Changes

- 将调度单位从“全数据集阶段”调整为“完整样本流水线”：每个样本依次完成入库、时间轴聚合、可选 LTM、答题、评判和结果记录，多个样本流水线仍可按现有样本并发配置同时运行。
- 保留现有 `ingestSampleConcurrency`、`ingestSessionConcurrency`、`answerConcurrency` 和 `judgeConcurrency` 能力：同一样本内 session 可并发，单个样本的业务阶段严格有序，多个样本可并行，答题和评判分别受现有全局并发上限约束。
- 复用现有基于 `questionId`、`contextScopeId=longmemeval:<questionId>`、资源 ID 和多模型 `storeNamespace` 的逻辑隔离，不清空整个数据库，并验证并行样本之间不会相互召回数据。
- 将 `apps/backend/data/longmemeval-result.jsonl` 作为唯一需要兼容的最终结果契约；每个样本成功或重试耗尽形成终态后，立即按现有字段格式追加一条 JSONL 记录。
- 新增独立 trace JSONL，默认只记录每个样本的四类回溯摘要：样本 Facts、样本 STMs、最多 100 个真实召回候选，以及最终进入 Context Pack 的 Facts 及其候选映射；不记录生命周期、LLM transport、prompt、judge、answer 或 result commit 明细。
- 将结果记录本身视为可重试的评测环节；任意环节保留项目已有内部重试，并在环节外增加最多 3 次兜底尝试。内外重试均耗尽后把样本写成 `skipped` 并继续其他样本；只有无法可靠记录该 skipped 终态时才将运行标记为错误。
- 支持样本级断点续跑：重启后扫描现有结果 JSONL，跳过已经拥有唯一终态记录的样本，从第一个未完成样本开始重新执行完整样本流水线，不恢复样本内部环节。
- 结果和摘要 trace 均保存到 `apps/backend/data`，默认使用 JSONL；落盘前对 API key、Authorization、Cookie 等凭据脱敏，摘要中的 Facts、STMs、候选和 Context Pack Facts 保持完整。
- 新运行开始前清空默认结果文件；显式 resume 时保留并扫描结果。并发样本按完成顺序实时追加，恢复时默认把成功和 skipped 都视为已完成，并支持显式 `retrySkipped` 重跑 skipped 样本。
- 首版覆盖当前前端实际使用的 HTTP job 链路和前端并发配置，同时保持 CLI 直跑可用；前端展示结果/trace 路径和结果实时刷新，但暂不实现完整 trace 浏览器。多模型运行继续使用相同的样本流水线、隔离、结果和 trace 规则。
- 每次运行使用一个独立摘要 trace 文件；产物默认永久保留，不自动清理。

## Capabilities

### New Capabilities

- `longmemeval-streaming-evaluation`: 定义 LongMemEval 完整样本流水线并发、逻辑隔离、实时逐样本结果 JSONL、完整过程 trace JSONL、统一重试和样本级断点续跑契约。

### Modified Capabilities

无。

## Impact

- 主要影响 `apps/backend/src/modules/context-engine/longmemeval.ts` 的全量阶段式编排，需要抽取单样本执行器、样本 worker pool、answer/judge 限流器和统一 stage retry wrapper。
- 需要将现有 `diagnosticsPath` 明确为最终逐样本结果 JSONL，并新增独立 trace writer；两个 writer 均需支持并发调用串行化和断点扫描。
- `longmemeval-jobs.ts`、HTTP routes、CLI 和前端评测表单需要传递并展示结果路径、trace 路径、resume 状态和各并发参数。
- 不改变 `longmemeval-result.jsonl` 已有成功/失败字段、不改变数据集格式、算法、judge 标准、指标公式或数据库 schema，也不执行数据库全量清理。
