## Purpose

定义 LongMemEval 以完整样本流水线为并发和恢复边界、实时追加兼容结果，并记录可安全回溯的全环节输入输出，使长时间评测在并发执行和中断恢复后仍具有可靠结果与诊断证据。

## ADDED Requirements

### Requirement: 以完整样本流水线组织评测
系统 SHALL 对每个样本按入库、时间轴聚合、配置允许的 LTM、答题、评判和结果记录顺序执行完整流水线；同一样本的后置环节 SHALL NOT 在前置环节成功或形成可处理终态前启动。

#### Scenario: 单个样本完成完整评测
- **WHEN** 样本进入评测 worker
- **THEN** 系统依次完成该样本的入库、时间轴聚合、LTM、答题、评判和结果记录，并在结果记录成功后将样本标记为已完成

#### Scenario: 单个样本包含多个会话
- **WHEN** 当前样本包含多个 haystack session 且 `ingestSessionConcurrency` 大于 1
- **THEN** 系统在该样本内部按并发上限摄入 session，并在所有 session 成功或形成失败终态后才启动该样本的时间轴环节

#### Scenario: 配置跳过某个环节
- **WHEN** 用户通过既有选项禁用 LTM、STM 或入库相关能力
- **THEN** 系统在 trace 中为对应环节记录 skipped 状态，并继续执行该样本其余允许的环节

### Requirement: 保留分层并发能力
系统 SHALL 保留样本、session、答题和评判并发配置，并以完整样本流水线作为样本并发单元；多个样本可以同时处于不同阶段，但每个样本内部 SHALL 保持阶段依赖顺序。

#### Scenario: 多个样本并行执行
- **WHEN** `ingestSampleConcurrency=N` 且存在至少 N 个待处理样本
- **THEN** 系统最多同时运行 N 个完整样本流水线，并允许不同样本分别处于入库、答题或评判阶段

#### Scenario: 样本并发为一
- **WHEN** `ingestSampleConcurrency=1`
- **THEN** 系统在当前样本结果记录成功后才开始下一个样本，实现全局严格串行

#### Scenario: 限制答题并发
- **WHEN** 多个活跃样本同时到达答题环节且 `answerConcurrency=M`
- **THEN** 系统通过全局限流器确保同时执行的答题请求不超过 M，等待中的样本不回退或重做已完成环节

#### Scenario: 限制评判并发
- **WHEN** 多个活跃样本同时到达评判环节且 `judgeConcurrency=K`
- **THEN** 系统通过独立全局限流器确保同时执行的评判请求不超过 K

### Requirement: 复用现有样本逻辑隔离
系统 SHALL 复用基于 `questionId` 的 context scope 和资源标识隔离样本数据，并在多模型运行时继续使用 model run store namespace；系统 SHALL NOT 为逐样本评测清空整个数据库。

#### Scenario: 并行样本执行答题
- **WHEN** 两个不同 question ID 的样本并行运行且其中一个样本进入检索或答题环节
- **THEN** 检索、Context Pack 和答案上下文只包含该 question ID 对应 scope 的数据，不包含另一个样本的数据

#### Scenario: 重复运行同一样本
- **WHEN** 同一数据集的同一 question ID 因断点续跑或显式复跑再次入库
- **THEN** 系统沿用现有幂等资源标识和入库复用策略，不要求清空数据库且不创建语义重复的跨 scope 数据

#### Scenario: 多模型运行相同样本
- **WHEN** 多个 model run 同时评测相同 question ID
- **THEN** 系统同时使用 model run namespace 和 question scope 隔离各模型运行的数据与 trace 归属

### Requirement: 实时追加兼容的最终结果 JSONL
系统 SHALL 将 `apps/backend/data/longmemeval-result.jsonl` 的现有逐样本记录结构作为最终结果契约，并在每个样本成功或形成 skipped 终态后立即追加且 flush 一条 JSON object；结果文件中的每个完整非空行 SHALL 可独立解析。

#### Scenario: 样本成功完成评判
- **WHEN** 当前样本完成评判
- **THEN** 系统追加一条包含现有 `datasetPath`、样本元数据、`hypothesis`、`judgment`、`exactMatch`、答案上下文和 Context Pack 诊断字段的兼容记录

#### Scenario: 样本重试耗尽
- **WHEN** 当前样本任一业务环节重试耗尽
- **THEN** 系统追加一条包含现有样本字段以及 `status=skipped`、`skipped=true`、`failureStage`、`skipReason`、`failureReason` 和 `error` 的兼容记录

#### Scenario: 多个样本同时提交结果
- **WHEN** 多个并行样本几乎同时形成终态
- **THEN** 系统按实际完成并获得 writer 的顺序串行化 append，确保每个样本结果占据完整单行且不会发生字节交错，并通过 `sampleIndex` 保留原始数据集顺序信息

#### Scenario: 评测过程中读取结果
- **WHEN** 前端或 API 在评测执行期间读取最终结果 JSONL
- **THEN** 读取方可以解析所有已 flush 的完整行并获得当前已完成样本集合，无需等待全部样本结束

### Requirement: 使用独立 JSONL 记录样本摘要 Trace
系统 SHALL 为每次评测使用独立 trace JSONL；每个样本最多写入四条 `sample_summary` 成功事件：该样本全部 Facts、全部 STMs、最多 100 个真实召回候选，以及最终进入 Context Pack 的 Facts 与候选映射。Trace SHALL NOT 写入生命周期、session 子环节、LLM transport、prompt、answer、judge 或 result commit 明细。

#### Scenario: 样本摘要成功写入
- **WHEN** 当前样本完成入库并成功构造检索/Context Pack
- **THEN** trace 为允许的四类摘要各写至多一条 `status=succeeded` 事件，并包含样本身份与完整摘要输出

#### Scenario: Facts 与 STMs 按样本隔离
- **WHEN** 多个样本共享 repository 且一个样本完成入库
- **THEN** `sample_facts` 按 `contextScopeId` 精确筛选该样本全部 Fact，`sample_stms` 只包含这些 Fact 关联的 STM

#### Scenario: 召回候选摘要
- **WHEN** 答题上下文完成一次真实检索
- **THEN** `retrieval_candidates` 保存实际排序后的最多 100 个 `ContextSearchResult`，包括内容、score、score breakdown、Fact/Memory/source 关联

#### Scenario: Context Pack Facts 摘要
- **WHEN** Context Pack 选择完成
- **THEN** `context_pack_facts` 保存最终选择的约 6 个候选、每个候选关联的 Facts，以及去重后的最终 Fact 列表

#### Scenario: 进程在写入期间中断
- **WHEN** 结果或 trace 的最后一行因进程异常退出而不完整
- **THEN** 读取与恢复逻辑忽略最后一个不完整行并保留此前所有可解析事件或结果

### Requirement: 所有评测环节应用统一重试和跳过策略
系统 SHALL 将入库、时间轴聚合、LTM、检索与 Context Pack、答题、评判和结果记录都视为可观测评测环节；每个环节 SHALL 保留项目已有内部重试机制，并在完整环节调用外增加最多 3 次兜底尝试。某个业务环节的内部重试及 3 次外层尝试均耗尽后 SHALL 记录该样本为 skipped 并继续其他样本。该观测过程不要求把重试明细写入样本摘要 Trace。

#### Scenario: 环节发生瞬时错误
- **WHEN** 任一环节返回项目现有策略判定为可重试的超时、传输、限流、临时存储或等价错误
- **THEN** 该环节先按现有内部最大尝试次数与退避规则执行；完整环节仍失败时，外层从环节入口最多重新执行 3 次，且不改变样本最终结果逻辑

#### Scenario: 内部重试耗尽后外层兜底成功
- **WHEN** 某环节第一次完整调用耗尽既有内部重试，但第二次外层 stage attempt 成功
- **THEN** 系统使用第二次调用的输出继续样本流水线，不把该样本标记为 skipped

#### Scenario: 确定性错误
- **WHEN** 环节失败原因为参数错误、数据校验错误、不变量破坏或其他明确不可重试错误
- **THEN** 系统不执行剩余外层兜底尝试，直接进入该样本 skipped 结果记录

#### Scenario: 业务环节重试耗尽
- **WHEN** 入库、时间轴、LTM、检索、答题或评判环节达到最大尝试次数仍失败
- **THEN** 系统停止该样本的后续业务处理，补记依赖环节 skipped，进入结果记录环节写入该样本 skipped 终态，并让 worker 继续领取其他待处理样本

#### Scenario: skipped 结果首次写入失败
- **WHEN** 结果记录环节遇到可重试 I/O 错误
- **THEN** 系统在保留 writer 内部机制的基础上最多执行 3 次外层提交尝试，且 SHALL NOT 在幂等写入成功前把该样本视为完成

#### Scenario: 结果记录重试耗尽
- **WHEN** 成功结果或 skipped 结果在最大尝试次数后仍无法写入
- **THEN** 系统停止领取新样本，将运行标记为 error，并保留此前已经 flush 的结果和 trace

### Requirement: 支持样本级断点续跑
系统 SHALL 能够使用相同数据集和结果文件恢复运行：启动时逐行扫描结果 JSONL，识别每个样本在各运行中的终态记录，按恢复选项计算完成集合，并从第一个目标样本开始重新执行完整样本流水线；系统不需要恢复样本内部环节。

#### Scenario: 中断发生在样本中间
- **WHEN** 进程在样本 10 的答题环节中断，结果文件已包含样本 1 至 9 的终态但不包含样本 10
- **THEN** 恢复运行跳过样本 1 至 9，并从样本 10 的入库或已入库复用检查开始重新执行完整样本流水线

#### Scenario: 并发运行中断导致完成顺序不连续
- **WHEN** 结果文件包含样本 1、2、4、5 的终态但样本 3 尚未完成
- **THEN** 恢复运行从原始顺序中第一个未完成的样本 3 开始，并在后续调度时跳过已有终态的样本 4、5

#### Scenario: 结果文件最后一行不完整
- **WHEN** 恢复扫描遇到末尾不完整 JSONL 行
- **THEN** 系统忽略该行并把对应样本视为未完成，从该样本完整重跑

#### Scenario: 结果文件存在重复终态
- **WHEN** 恢复扫描发现相同 run、model、sample 和 result commit ID 存在多条 payload 不一致的终态，或存在无法解释为幂等提交或 retrySkipped 新运行的重复终态
- **THEN** 系统在启动新 worker 前拒绝自动恢复并报告冲突行，避免不明确地计算完成集合

#### Scenario: 幂等提交产生相同行
- **WHEN** 相同 result commit ID 存在多条 payload hash 一致的结果行
- **THEN** 系统将其折叠为一次完成提交，不重复计数且不拒绝恢复

#### Scenario: 数据集与结果文件不匹配
- **WHEN** 结果行的 dataset identity、样本总数或 question ID 无法与当前数据集对应
- **THEN** 系统拒绝恢复并报告不匹配，不使用旧结果跳过当前样本

#### Scenario: 恢复时遇到 skipped 样本
- **WHEN** 用户启用 resume 且未启用 `retrySkipped`
- **THEN** 系统把结果文件中的成功与 skipped 终态都视为已完成并跳过

#### Scenario: 恢复时重跑 skipped 样本
- **WHEN** 用户同时启用 resume 和 `retrySkipped`
- **THEN** 系统保留成功样本并从原始顺序中第一个 skipped 或未完成样本开始调度，已有 skipped 行不作为该样本本次恢复的完成终态；新终态使用新的 run ID 追加，汇总和前端展示采用该样本最新运行的终态且不重复计数

### Requirement: 固定评测产物路径并保护敏感信息
系统 SHALL 将结果和摘要 trace 保存到 `/Users/nxcore/Desktop/context-egine/apps/backend/data`，默认结果文件为 `longmemeval-result.jsonl`，trace 使用与本次运行关联的 JSONL 文件；系统 SHALL 在落盘前递归脱敏凭据，并以仅当前用户可读写的权限创建新文件。

#### Scenario: 使用默认路径启动新评测
- **WHEN** 用户未指定结果和 trace 文件名且不是恢复运行
- **THEN** 系统在获得独占锁后清空 `longmemeval-result.jsonl`，并生成包含运行 ID 的 `longmemeval-<runId>-trace.jsonl`

#### Scenario: 指定文件名
- **WHEN** 用户为结果或 trace 指定文件名
- **THEN** 系统只接受解析后仍位于目标 data 目录内且扩展名为 `.jsonl` 的 basename，否则在评测启动前拒绝请求

#### Scenario: 请求包含鉴权信息
- **WHEN** 模型或外部服务请求包含 API key、Authorization、Cookie、代理认证、token 或等价秘密
- **THEN** 结果和摘要 trace 使用固定脱敏标记替换秘密值，不保存可恢复原值；摘要中的普通 Fact、STM、候选内容保持完整

#### Scenario: 运行结束后保留产物
- **WHEN** 评测完成、失败或取消
- **THEN** 系统永久保留本次结果与 trace，不执行自动删除、轮转或过期清理

### Requirement: 当前产品入口遵守统一契约
HTTP job、当前前端评测界面、CLI 和多模型运行 SHALL 复用相同的样本流水线并发、隔离、结果、trace、重试和恢复语义。

#### Scenario: 前端启动 HTTP job
- **WHEN** 用户通过当前前端配置样本、session、答题或评判并发并启动评测
- **THEN** HTTP job 使用这些并发值运行完整样本流水线，job 快照返回结果路径、trace 路径、恢复状态和已完成样本数量

#### Scenario: 前端查看运行产物
- **WHEN** 用户在首版前端查看运行中的评测
- **THEN** 前端展示结果路径、trace 路径和实时刷新的结果 JSONL 摘要，但不要求在前端展开浏览完整 trace 环节输入输出

#### Scenario: 用户取消并行评测
- **WHEN** 用户取消仍有多个样本在途的评测
- **THEN** 系统停止领取新样本并取消可取消的在途请求，只有已经成功提交结果行的样本计为完成；其他在途样本在恢复时从完整流水线入口重跑

#### Scenario: CLI 直接运行
- **WHEN** 用户通过 CLI 启动或恢复评测
- **THEN** CLI 使用同一执行器和 writer，并在输出中返回结果与 trace 的绝对路径

#### Scenario: 多模型评测
- **WHEN** 用户配置多个模型运行
- **THEN** 每个 model run 使用独立模型 namespace 和可识别的结果归属，并保留模型并发和样本流水线并发限制
