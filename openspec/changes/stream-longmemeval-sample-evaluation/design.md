## Context

现有 `evaluateLongMemEvalDataset` 在共享 repository 上按全量阶段执行：先用 `ingestSampleConcurrency` 摄入全部样本，再顺序完成全部时间轴/LTM，最后分别按 `answerConcurrency` 和 `judgeConcurrency` 处理整批答案与评判。目标是保留这些并发控制，但把调度单元改成一条样本的完整闭环，而不是强制全局串行。

现有样本逻辑隔离由 `questionId` 派生的 `contextScopeId=longmemeval:<questionId>`、带 question ID 的 event/source/fact/memory ID 和检索 scope 实现；多模型通过 `storeNamespace=run_<modelRunId>` 进一步隔离 SQLite。改造复用该机制，不清空整个数据库。

`apps/backend/data/longmemeval-result.jsonl` 当前由 `diagnosticsPath` 写入，每个样本终态对应一行：成功记录包含问题、答案、hypothesis、judgment、answerContext 和 Context Pack 等字段，失败记录包含 `failureStage/status/skipped/skipReason` 等字段。后端和前端已有该格式的流式读取、分页和统计逻辑，因此它是本变更唯一要求兼容的最终结果，而不是 `LongMemEvalReport` 汇总 JSON。

现有诊断只在样本失败或 judge 完成时写入一行，prompt 和时间轴还会截断为 preview；通用 LLM observer 只暴露请求状态与耗时。完整环节回溯需要新增独立 trace JSONL，并扩展业务及 LLM 边界的观测数据。

## Goals / Non-Goals

**Goals:**

- 以单样本完整流水线作为调度、失败和恢复边界，同时保留样本/session/answer/judge 并发配置。
- 实时向现有 `longmemeval-result.jsonl` 追加兼容的唯一终态记录，并允许评测中读取。
- 完整记录所有业务环节、重试 attempt 和结果写入本身的脱敏输入输出。
- 复用 question scope、幂等资源 ID 和 model namespace，在并行样本下验证隔离且不清空数据库。
- 中断后依据结果 JSONL 从首个未完成样本恢复，未完成样本从头执行完整流水线。
- 首版打通当前前端实际调用的 HTTP job，同时保持 CLI 与多模型入口一致。

**Non-Goals:**

- 不恢复样本内部 checkpoint，不从 answer 或 judge 环节继续半个样本。
- 不改变事实抽取、聚合、检索、Context Pack、答案、judge 和指标算法。
- 不修改数据库 schema，不自动清理数据库，也不为 trace 建表。
- 不改变现有结果行的字段含义；允许加入用于运行身份、恢复和幂等提交的可选字段。
- 不提供 trace 自动压缩、轮转、上传或清理。

## Decisions

### 1. 将完整样本闭环放入有界 worker pool

抽取 `executeLongMemEvalSample`（最终名称按代码风格确定），内部顺序固定：

```text
ingest sessions
      ↓ barrier
timeline aggregation
      ↓
optional LTM
      ↓ answer limiter
answer
      ↓ judge limiter
judge
      ↓ result writer
result commit
```

外层使用大小为 `ingestSampleConcurrency` 的 worker pool。worker 一旦领取样本，就负责其完整流水线直至结果提交，不会在入库后把样本放回另一个批处理队列。这样 `N=1` 时满足全局逐样本串行；`N>1` 时允许 N 个样本闭环同时推进。

`ingestSessionConcurrency` 继续控制单个样本的 session 摄入。`answerConcurrency` 和 `judgeConcurrency` 改为两个运行级 semaphore，不再分别对一次性 answer/judge 数组做 map；多个活跃样本到达对应阶段时获取令牌，完成或失败后释放。现有前端四个并发参数均保留原含义。

选择 worker pool 而不是为每个阶段建立队列，是因为样本必须保持完整失败边界和结果提交责任；全阶段队列会重新制造“入库堆积后统一答题”的行为。

### 2. 复用 question scope 隔离，并补强并行验证

不为每个样本创建独立数据库文件，也不删除数据库。继续使用：

- `longmemeval:<questionId>` context scope；
- `longmemeval_event_<questionId>_<sessionId>` 等资源 ID；
- search/Context Pack 的 question scope 过滤；
- 多模型 `run_<modelRunId>` store namespace。

单样本执行器显式携带 `questionId/contextScopeId/modelRunId`，trace 每条事件也记录这些值。并行测试将把两个样本放入同一 repository，同时在彼此数据均已入库的情况下断言各自检索和答案上下文只包含自身 scope。

### 3. 最终结果和过程 trace 都使用 JSONL，但承担不同职责

JSON 是一个完整对象或数组，修改中间内容通常需要重写整个文件；JSONL 是“一行一个独立 JSON 对象”，适合长任务追加、并发串行写入和中断恢复。两个产物都使用 JSONL：

- `longmemeval-result.jsonl`：每个样本只有一条最终成功或 skipped 记录，严格兼容现有字段和前端读取器；
- `longmemeval-<runId>-trace.jsonl`：每个样本最多四条摘要事件，保存 Facts、STMs、召回候选和 Context Pack Facts。

结果文件不混入 run-start、run-end 或 stage 事件，以免现有前端把元事件误算为样本。运行元数据放在 trace 和 HTTP job snapshot 中；结果行只增加可选 `runId`、`datasetIdentity`、`sampleIdentity`、`resultCommitId`、`completedAt`，现有读取器会忽略未知字段。

### 4. 使用共享串行 writer 保证并发 append 完整

结果和摘要 trace 分别使用运行级 writer，内部用 Promise queue 串行执行 append。一次 append 先序列化并脱敏对象，再执行单次行写入并 flush；一个样本的结果不会与另一个样本发生字节交错。摘要 trace 使用全局单调 `sequence`，并通过 writer 的 once key 保证每个样本每类摘要最多一条。

JSONL 不能像完整 JSON 那样用 rename 让所有历史行原子替换；这里的可靠性单位是单行。读取器和恢复扫描器容忍且只忽略文件末尾的一个不完整行，文件中间出现无效行则报错。

### 5. 结果提交使用 commit ID 实现重试幂等

结果写入也是评测环节，必须使用现有 retry policy。但 append 可能出现“数据已写入，调用方却收到错误”的不确定状态。为避免重试产生重复终态，每个样本预先生成稳定 `resultCommitId = hash(runId + modelRunId + datasetIdentity + questionId)`：

1. 首次提交按现有格式附加 commit ID；
2. append/flush 报错时，下一 attempt 先扫描文件尾部或已维护索引；
3. 若同一 commit ID 已存在且 payload hash 一致，视为成功；
4. 若不存在则重试 append；若存在但 payload 不同，视为冲突并终止运行。

结果 writer 在内存中维护已提交 commit ID，并在 resume 初始化时从文件重建。这样并行提交、I/O 重试和断点恢复共享同一唯一性规则。

### 6. 保留内部重试，并增加 3 次外层 stage 兜底

新增 `executeStageWithRetry` 包裹完整业务环节，外层最大尝试次数固定为 3。`llm-request.ts` 的默认最大尝试次数、间隔、取消语义，以及 answer context 等业务层已有专门重试完全保持不变；一次外层 stage attempt 对应一次完整环节调用，内部可以包含原有多次请求 attempt。trace 同时记录 `stageAttempt` 和 `internalAttempt`，避免把两层重试混为一体。

第一次完整环节在内部重试耗尽后，如果错误仍属于超时、网络、429/5xx、临时存储锁、可识别 I/O 或未知可恢复错误，外层从该环节入口重新调用，最多共 3 次。参数错误、数据校验、数据不变量破坏、取消和其他明确不可重试错误不消耗剩余外层尝试，直接进入 skipped 或取消处理。

外层重启必须遵守环节幂等要求：入库复用现有幂等资源 ID；纯计算环节重新计算；answer/judge 不持久化重复业务对象；结果提交使用 commit ID 查重。不能证明幂等的环节在实现前必须补齐幂等键，不能直接开启外层重试。

业务环节的 3 次外层尝试耗尽后构造当前兼容 skipped 行，并进入 `result_commit`。结果提交保留 writer 内部行为并同样最多执行 3 次外层尝试；自身耗尽时无法可靠证明样本终态已记录，因此停止所有 worker 领取新样本、abort 在途请求并将 job 标记为 error；此前已 flush 的行保留。

### 7. 断点续跑由结果行定义完成集合

HTTP 和 CLI 增加显式 `resume`。行为区分如下：

- `resume=false`：沿用当前新运行语义，在启动 worker 前截断结果文件，并创建新的 trace；
- `resume=true`：不截断结果文件，扫描所有完整行并校验后恢复；trace 新建新的 resume-attempt 文件并记录 `resumedFromRunId`，避免把两次进程生命周期混在一个可能损坏的尾部文件中。

新运行截断前必须先获得结果路径的跨进程独占锁；锁被其他运行持有时直接拒绝，避免清空正在写入的文件。恢复默认把 success 和 skipped 都加入完成集合；`retrySkipped=true` 时只把 success 视为完成，已有 skipped 行保留用于审计，但读取器按相同 sample identity 的最新本次终态计算展示和恢复状态。

数据集 identity 由规范化绝对路径、文件内容 hash 和样本总数构成；样本 identity 使用原始顺序 index 和 question ID。恢复扫描要求：

- 忽略末尾唯一不完整行；
- 相同 run/model/sample 原则上只有一个终态；多个完全相同 commit ID/payload 的幂等行可折叠，`retrySkipped` 新 run 产生的新终态可覆盖旧 run 作为当前展示值，其他冲突重复拒绝恢复；
- 结果行必须匹配当前 dataset identity；对历史无新增 identity 字段的旧结果，只允许在用户显式指定 `resumeLegacy=true` 时按 datasetPath、sampleIndex、questionId 做较弱校验，否则拒绝自动恢复；
- 调度从原始顺序的第一个未完成样本开始遍历，但跳过其后已经完成的非连续样本。

未完成样本从 ingestion/reuse preflight 重新开始。现有 question-scoped 幂等 ID 负责复用已成功入库的数据，不要求清库。

### 8. 样本摘要 Trace 契约

Trace schema 使用版本 2，并且每个样本最多写四条成功摘要事件：

```json
{
  "schemaVersion": 1,
  "sequence": 42,
  "runId": "longmemeval_...",
  "modelRunId": "default",
  "sample": {
    "index": 3,
    "count": 500,
    "questionId": "...",
    "questionType": "...",
    "contextScopeId": "longmemeval:..."
  },
  "stage": "sample_summary",
  "operation": "retrieval_candidates",
  "stageExecutionId": "summary_retrieval_candidates_3",
  "status": "succeeded",
  "startedAt": "...",
  "finishedAt": "...",
  "elapsedMs": 1234,
  "output": {},
  "sample": { "index": 3, "questionId": "...", "contextScopeId": "longmemeval:..." }
}
```

允许的 operation 只有 `sample_facts`、`sample_stms`、`retrieval_candidates` 和 `context_pack_facts`。Facts/STMs 按样本 `contextScopeId` 精确筛选；召回摘要保存实际排序后的 `ContextSearchResult`（最多 100 个，含内容、分数、score breakdown、Fact/Memory/source 关联）；Context Pack 摘要保存最终选择候选、其中的完整 Facts 以及候选到 Fact 的映射。旧 observer、重试和业务边界仍执行但不落盘，因此不改变评测逻辑或指标。

每个进程生命周期生成一个独立 trace 文件；一次普通运行只有一个 trace，resume 会创建新的 trace 并通过 `resumedFromRunId` 关联上次运行。结果仍累积在同一个结果 JSONL。产物完成后永久保留，本变更不增加自动清理策略。

### 9. 统一脱敏但不截断普通正文

writer 序列化前递归替换 `apiKey`、Authorization、Cookie、proxy authorization、access/refresh token、secret 及等价命名，URL query 中的敏感参数也替换为 `[REDACTED]`。Error 转为 name/message/code/stack，循环引用和 BigInt 做安全序列化。

prompt、会话、Context Pack、hypothesis、judge request/response 是用户要求的回溯数据，完整保存，不沿用 500/1000 字符 preview 限制。新文件以 `0o600` 创建。完整 I/O 会显著增加磁盘占用，这是满足回溯要求的明确取舍。

### 10. 首版入口范围和职责

当前入口含义：

- **HTTP job**：前端实际调用 `POST /context/evaluations/longmemeval` 创建后台运行，随后轮询 job 状态；这是首要产品入口。
- **前端**：负责配置数据集、模型和四类并发，展示进度并读取 JSONL；它不直接执行评测。
- **CLI**：通过终端直接启动评测，主要用于本地调试、CI、样本选择和批量跑分。
- **多模型入口**：一次配置多个 model run，外层受 `modelConcurrency` 控制，每个模型运行内部再执行样本 worker pool。

首版覆盖 HTTP job + 前端 + CLI。前端保留现有结果 JSONL 摘要/分页能力，增加运行中自动刷新、结果与 trace 路径、resume/retrySkipped 开关和多活跃样本进度；结果文件按完成顺序追加，但前端默认按 `sampleIndex` 展示，并对 retrySkipped 产生的多运行记录采用最新终态。暂不实现完整 trace 浏览器，工程师通过路径直接读取 trace 文件。多模型继续可用，但结果不能让同一 question ID 在同一文件中语义冲突：每行加入 `modelRunId`，完成键为 `(modelRunId, sampleIdentity)`；前端读取器的汇总需支持按模型筛选或分组。job snapshot 增加 `resultPath`、`tracePath`、`resume`、`retrySkipped`、`resumedSamples`、`committedSamples` 和有效并发值。

## Risks / Trade-offs

- [用户第 8 点同时提到“样本严格串行”和“多个样本同时运行”] → 采用可配置语义：单个样本阶段严格串行；样本 worker pool 可并行；`ingestSampleConcurrency=1` 时才全局串行。
- [并行样本共享 repository 可能泄漏上下文] → 不假设现有隔离天然正确，增加双样本交错入库、检索、Context Pack 和答题回归测试，发现缺口时只补 scope 过滤，不清库。
- [JSONL append 后返回错误导致重复结果] → 使用稳定 resultCommitId、payload hash 和重试前查重；恢复时拒绝冲突重复。
- [历史结果行没有 dataset identity，无法强校验恢复] → 默认只对新格式自动恢复；旧格式需要显式弱校验开关，避免跳错样本。
- [摘要中保留完整 Facts、STMs 和候选仍可能较大] → 不截断用户明确需要的摘要正文，文档说明产物路径；压缩和轮转另行设计。
- [多层重试最多把一个环节的请求数量放大到原来的 3 倍] → 这是确认采用的保底策略；只对瞬时或未知可恢复错误执行外层尝试，确定性错误立即停止，trace 分别记录 stage/internal attempt，并用幂等键防止重复副作用。
- [一个结果 writer 故障影响所有并行 worker] → writer 失败耗尽后触发共享 abort 并停止领取新样本，避免继续产生没有最终记录的评测工作。
- [多个进程同时写默认结果文件] → 创建运行时文件锁或独占 lock file；第二个非 resume 运行必须拒绝共享同一结果路径，不能依赖进程内 Promise queue。

## Migration Plan

1. 先实现结果/trace writer、commit ID、文件锁、脱敏和恢复扫描器，并用现有 JSONL 读取测试验证兼容性。
2. 抽取单样本执行器和 stage retry wrapper，用 `ingestSampleConcurrency=1` 验证完整阶段顺序与现有最终结果字段。
3. 引入样本 worker pool、session 并发和 answer/judge semaphore，增加并发上限、writer 顺序和 question scope 隔离测试。
4. 接入完整业务/LLM trace，覆盖每次 attempt、失败、skipped 和 result commit。
5. 接入 HTTP job、当前前端、CLI 和多模型结果分组，再验证中断恢复与取消。
6. 使用新运行生成带 identity/commit ID 的结果文件；旧 `longmemeval-result.jsonl` 仍可读取，但默认不直接作为强校验 resume 输入。

回滚可以恢复原全量阶段编排和 diagnostics 写入，不涉及数据库迁移，也不删除已生成的 JSONL。新加的可选结果字段不会破坏现有读取器。
