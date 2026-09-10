## 1. JSONL 产物与恢复基础

- [x] 1.1 定义兼容结果行扩展字段、trace event、stage/operation/status、attempt、资源关联和结构化错误类型，并设置 trace schema version。
- [x] 1.2 实现固定 `apps/backend/data` 根目录的结果/trace basename 校验、默认路径、运行 ID、文件权限和跨进程独占 lock，拒绝路径穿越及多个运行混写同一结果文件。
- [x] 1.3 实现递归凭据与 URL 参数脱敏、Error/BigInt/循环对象安全序列化，普通 prompt、会话和模型响应保持完整不截断。
- [x] 1.4 实现共享串行 JSONL writer，支持完整单行 append、flush、全局 sequence、尾部不完整行容错和中间坏行报错。
- [x] 1.5 实现稳定 `resultCommitId`、payload hash、重试前查重和提交冲突检测，保证结果写入错误后的重试不会产生重复样本终态。
- [x] 1.6 实现结果恢复扫描器，构建 `(modelRunId, sampleIdentity)` 完成集合，折叠相同 commit/payload、按最新 run 解析 retrySkipped 终态，校验 dataset path/hash/count、question ID、冲突重复行和尾部不完整行，并定位首个目标样本。
- [x] 1.7 为 JSONL 现有字段兼容、并发 append、文件锁、权限、脱敏、幂等提交、冲突重复、数据集不匹配和损坏尾行补充单元测试。

## 2. 单样本执行器与隔离

- [x] 2.1 从 `evaluateLongMemEvalDataset` 抽取完整单样本执行器，依次执行 ingestion、timeline aggregation、可选 LTM、answer、judge 和 result commit，并返回现有样本结果/诊断字段。
- [x] 2.2 复用 `questionId` context scope、带 question ID 的资源标识和多模型 store namespace，显式把 scope 元数据传入检索、Context Pack、答题和 trace。
- [x] 2.3 保持 model-only、answer-only、skip STM/LTM、fallback、入库幂等复用和取消语义，未完成的恢复样本从完整流水线入口重新开始。
- [x] 2.4 增加双样本并行隔离测试，在两个样本数据同时存在时验证 search、Context Pack、timeline、answer ranked session 和结果只包含自身 question scope，且无需清空数据库。
- [x] 2.5 增加单样本阶段顺序测试，验证 ingestion session barrier、timeline/LTM、answer、judge、result commit 的依赖关系和配置 skipped 事件。

## 3. 分层并发调度

- [x] 3.1 实现以 `ingestSampleConcurrency` 为大小的样本 worker pool，每个 worker 负责一个样本完整闭环直至结果提交后再领取新样本。
- [x] 3.2 在单样本 ingestion 中保留 `ingestSessionConcurrency`，确保 session 可并发但 timeline 只在所有 session 形成终态后启动。
- [x] 3.3 实现运行级 answer semaphore 和 judge semaphore，分别执行现有 `answerConcurrency`、`judgeConcurrency` 上限并保证异常/取消时释放令牌。
- [x] 3.4 保留多模型 `modelConcurrency`，明确总并发由 model、sample、session、answer 和 judge 各层上限共同约束。
- [x] 3.5 更新 progress/job 聚合以支持多个当前活跃样本，保留总体完成数并增加按 sample/question ID 查询活跃阶段的能力。
- [x] 3.6 为样本并发 1、样本并发 N、session 并发、answer/judge 独立限流、worker 失败继续和取消停止领取新任务补充并发测试。

## 4. 全环节重试与 Trace

- [x] 4.1 实现统一 `executeStageWithRetry`：完整保留各环节已有内部重试，并对瞬时或未知可恢复失败增加最多 3 次外层 stage attempt；确定性错误和取消不执行剩余外层尝试。
- [x] 4.2 为外层重试建立环节幂等契约：入库复用资源 ID、纯计算可重算、answer/judge 不重复持久化、result commit 使用 commit ID，并在 trace 中区分 stageAttempt 与 internalAttempt。
- [x] 4.3 在 sample normalization 与 ingestion 的 event build/save、parse、fact fusion、STM admission、finalize 子环节记录每次 attempt 的完整输入输出、状态、耗时和 event/fact/memory/session/scope ID。
- [x] 4.4 为 timeline aggregation 和 LTM batch 记录聚合事实、时间轴事件、候选 memory、LLM 输入输出、dreaming 结果、attempt 和配置跳过原因。
- [x] 4.5 为 retrieval、Context Pack 和 answer 记录查询、候选、分数、选择/丢弃、token 预算、完整 prompt、模型原始响应、解析输出和 hypothesis。
- [x] 4.6 为 judge 记录问题、标准答案、hypothesis、完整 judge prompt、模型原始响应、解析 judgment、fallback、attempt 和失败原因。
- [x] 4.7 扩展通用 LLM request 观测点，按实际 transport internal attempt 输出 request body、聚合 raw response、usage、耗时和错误，同时保持现有轻量 observer 向后兼容。
- [x] 4.8 将 result commit 纳入 trace 和两层 retry，记录待写结果、commit ID、payload hash、目标路径、stage/internal attempt、行号/字节位置和失败信息。
- [x] 4.9 业务环节 3 次外层尝试耗尽时生成现有格式 skipped 行并继续其他样本；结果提交外层尝试耗尽时触发共享 abort、停止领取样本并保留此前已 flush 产物。
- [x] 4.10 为内部重试成功、内部耗尽后外层成功、3 次外层耗尽、确定性错误不重试、skipped、结果提交幂等和凭据扫描补充测试。

## 5. 断点续跑

- [x] 5.1 在核心选项中增加显式 resume/retrySkipped 语义：新运行获得锁后截断默认结果并创建新 trace，恢复运行保留结果并新建带 `resumedFromRunId` 的 trace。
- [x] 5.2 恢复调度默认把 success/skipped 都视为完成；`retrySkipped=true` 时重跑 skipped。调度从原始顺序首个目标样本开始，跳过后续已有成功终态的非连续样本，并把目标样本从 ingestion/reuse preflight 完整重跑。
- [x] 5.3 对新结果行写入 run/model/dataset/sample identity、result commit ID 和完成时间等可选字段，保持现有 JSONL 读取器兼容。
- [x] 5.4 为旧结果文件提供显式 `resumeLegacy` 弱校验模式；默认拒绝缺少强 identity 的自动恢复并给出明确错误。
- [x] 5.5 增加样本中间中断、非连续完成集合、末尾坏行、重复终态、数据集变化、已入库复用和恢复后不重复结果的集成测试。

## 6. HTTP Job、前端、CLI 与多模型

- [x] 6.1 扩展 HTTP 创建评测请求和 job state，传递 result/trace 文件名、resume/retrySkipped 选项与四类并发值，返回绝对路径、恢复数、提交数和有效并发。
- [x] 6.2 更新 job 取消和错误处理，确保共享 worker/limiter/writer 一致停止，并保留已提交结果和当前 trace。
- [x] 6.3 保留当前前端样本、session、答题、评判并发控件并适配新语义；增加 resume/retrySkipped 控件、结果/trace 路径、结果自动刷新、恢复/已提交计数和多活跃样本进度展示，首版不实现完整 trace 浏览器。
- [x] 6.4 更新后端和前端 JSONL 读取器，容忍最后一个不完整行、忽略兼容扩展字段、按 sampleIndex 默认展示、按最新 run 去重 retrySkipped 结果，并为多模型结果按 `modelRunId` 分组或筛选。
- [x] 6.5 扩展 CLI 参数和帮助以支持 resume、retrySkipped、legacy resume、结果/trace 文件名及现有所有并发选项，并输出实际产物绝对路径和恢复摘要。
- [x] 6.6 在多模型入口中复用样本 worker pool和隔离规则，以 `(modelRunId, sampleIdentity)` 提交结果，并验证 `modelConcurrency` 与内部并发共同生效。
- [x] 6.7 验证 question ID、区间、比例子集、model-only、answer-only、旧 CLI 位置参数和前端 HTTP job 均使用相同执行、结果、trace 与恢复契约。
- [x] 6.8 为 HTTP job、前端请求类型、CLI、取消、并发 job 文件锁、多模型和运行中 JSONL 分页补充集成测试。

## 7. 回归验证与文档

- [x] 7.1 更新 LongMemEval 文档，解释 HTTP job、前端、CLI、多模型入口职责，以及 sample/session/answer/judge/model 五层并发语义。
- [x] 7.2 记录结果 JSONL 与摘要 trace JSONL 的职责、完成顺序、字段、命名、resume/retrySkipped/new-run 行为、永久保留、旧文件限制和敏感数据边界。
- [x] 7.3 使用多样本 fixture 执行端到端测试，验证并行闭环、question scope 隔离、实时结果、摘要 trace、失败继续和中断恢复。
- [x] 7.4 对 500 样本规模模拟 writer/恢复扫描和并发调度，记录追加耗时、trace 大小、峰值内存及锁竞争，不改变评测正确性。
- [x] 7.5 运行 backend/web typecheck、LongMemEval/LLM request/job/route/JSONL 相关测试和必要全量测试，记录未执行的真实模型与外部数据库验证项。
- [x] 7.6 运行 `openspec status --change stream-longmemeval-sample-evaluation` 与 `openspec validate stream-longmemeval-sample-evaluation --strict`，确认变更有效。

## 8. 验收补缺

- [x] 8.1 将 retrieval、Context Pack、fact fusion 和 STM admission 的 trace 从事后补记改为真实执行边界观测，确保成功与失败路径都有可关联的 started/终态、完整输入输出和真实耗时，且 observer 不参与业务决策。
- [x] 8.2 增加子环节成功/失败 trace 配对测试和确定性结果不变性测试，验证新增观测不会重复业务调用或改变 hypothesis、judgment、retrieval ranking 与指标。

## 9. 精简样本摘要 Trace

- [x] 9.1 将 Trace schema 升级为版本 2，并在统一落盘入口过滤旧生命周期、LLM、prompt、answer、judge 和 result commit 事件。
- [x] 9.2 在真实 ingestion、retrieval 和 Context Pack 边界写入四类样本摘要，精确按 context scope 汇总 Facts/STMs，并保留候选及 Fact 映射。
- [x] 9.3 更新 LongMemEval Trace 测试与文档，验证每样本最多四条摘要、候选不超过 100、Context Pack 选择不超过 6，且评测结果字段和指标不变。
