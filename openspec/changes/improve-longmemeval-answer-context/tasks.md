## 1. 统一答题候选召回

- [x] 1.1 在 `longmemeval.ts` 中将 `buildLongMemEvalAnswerContext` 改为只调用一次 `searchContext(limit=100)`，移除 LongMemEval 答题阶段独立的 `assembleContext(limit=10)` 召回。
- [x] 1.2 从统一候选集合构建最终 `ContextPack` 诊断对象和答题 Prompt，保证 selected item、dropped item 与 Prompt 内容一致。
- [x] 1.3 保留 `retrieval` 兼容模式，明确其与新 `context_pack` 模式的候选数量和回退行为。
- [x] 1.4 增加测试，断言同一道题只发生一次答题候选召回。

## 2. 建立完整的答题候选结构

- [x] 2.1 新增 `LongMemEvalAnswerEvidenceCandidate` 或等价内部类型，直接保留完整 `item.content`、时间、来源 Session、来源角色、关系边和 token 估算。
- [x] 2.2 从 `ContextPackItem.sourceRefs`、Fact provenance 和 Session 消息映射来源 Session 与 user/assistant/tool 角色。
- [x] 2.3 将 `validTime*`、`evidenceTime*`、时间置信度和 `relationEdges` 加入答题候选结构和最终渲染输入。
- [x] 2.4 将异常 fallback/timeline 长度阈值和总答题预算集中为具名配置，删除散落的 600、1200 和固定 8 条限制。

## 3. 取消所有 STM 二次截取

- [x] 3.1 所有进入答题候选的 STM/LTM 均使用完整 `item.content`，不再调用 `limitLongMemEvalPreview` 或 `buildAnswerKeyEvidenceExcerpt`。
- [x] 3.2 segment fallback 和 timeline aggregation 不再因正文长度被排除，完整内容进入答题候选。
- [x] 3.3 长候选仅在 token budget 不足时整体记录为 `budget`，不再产生 oversized 长文本排除原因。
- [x] 3.4 增加测试，覆盖普通 STM、segment fallback 和 timeline 内容超过 600/1200 字符仍全文传入。

## 4. 按预算和问题需要选择证据

- [x] 4.1 删除 `selectAnswerKeyEvidenceItemIds` 的额外 LLM 调用及其固定最多 8 条逻辑。
- [x] 4.2 实现 token budget 分配：先保留直接答案，再保留时间起止点、计算数值、新旧状态和消歧证据，最后加入辅助内容。
- [x] 4.3 实现多 Session 覆盖检查，避免只选中同一 Session 的高分候选。
- [x] 4.4 实现重复事实合并，优先保留正文、时间和来源最完整的候选。
- [x] 4.5 根据问题类型、时间字段、数值内容和关系边生成选择原因及证据角色，便于诊断必要证据是否齐全。
- [x] 4.6 增加时间计算、求和、比较、列表计数和状态更新类测试。

## 5. 统一最终 Prompt 渲染

- [x] 5.1 新增统一证据渲染函数，输出完整正文、事实发生时间、消息发送时间、来源角色和来源 Session。
- [x] 5.2 将 `updates`、`supersedes` 和 `conflicts_with` 转换为可理解的新旧关系说明。
- [x] 5.3 删除同时拼接基础 Context Pack 和 `【答题关键证据】` 的双重渲染，最终 Prompt 只使用统一证据区。
- [x] 5.4 确保时间字段只格式化展示，不修改原始 ISO 时间和 valid/evidence 含义。
- [x] 5.5 增加 user/assistant 来源区分测试，防止助手建议被当作用户事实。

## 6. 增加评测诊断

- [x] 6.1 在 LongMemEval 结果中记录前 100 条召回结果 ID、分数明细、来源 Session 和正文长度。
- [x] 6.2 分别记录前 100 条召回结果、可用候选、选中项、证据角色、未选项和未选原因；不再记录长文本排除阶段。
- [x] 6.3 记录最终 Prompt 使用的证据 ID、时间字段完整性、token 占用和预算丢弃项。
- [x] 6.4 提供诊断 helper，将失败归类为未生成 STM、未进入前 100、未被选择、预算丢弃、渲染丢失或推理错误。
- [x] 6.5 保证诊断序列化失败不会中断正式评测。

## 7. 验证与对照评测

- [x] 7.1 运行 LongMemEval 相关单元测试和 context-engine 检索/Context Pack 回归测试。
- [ ] 7.2 使用相同数据库和相同 50 条数据分别运行旧链路与新链路，保存两份结果。
- [ ] 7.3 对比 `promptHasAnswer`、Judge accuracy、平均 Prompt token 和各失败阶段数量。
- [ ] 7.4 逐条复查原“正确 STM 未进入最终 Context Pack”的 9 条结果，确认正确 STM 是否进入最终 Prompt。
- [ ] 7.5 逐条复查原“时间/更新关系丢失”的 6 条结果，确认绝对时间和新旧顺序完整显示；长 fallback/timeline 不再因字符长度被拒绝。
- [x] 7.6 确认 `rankedSessionIdsForLongMemEvalAnswer`、事实入库和 Judge 行为未发生变化。
- [x] 7.7 记录验证命令、结果文件路径、仍失败样本和回滚方式。

### 验证记录

- 类型检查：`npm run typecheck`（workspace 全量），通过；`cd apps/backend && npm run typecheck` 也通过。
- LongMemEval 定向测试：使用 `--test-name-pattern` 运行统一召回、完整正文、长 fallback/timeline、去重、预算、时间、角色、关系和诊断用例，6/6 通过。
- 检索/Context Pack 回归：`search-context.test.ts` 与 `assemble-context.test.ts` 共 28 条，27 条通过；`assemble_context uses LLM summaries for assembly compression when enabled` 因测试 mock 未返回 embedding `data` 数组失败，与本变更代码路径无关。
- 完整 `longmemeval.test.ts` 曾启动，但仓库现有多个测试会拦截远程 embedding 请求并进入重试，未作为通过依据；本变更相关用例已单独稳定通过。
- 50 条新旧链路结果尚未生成，因此 7.2-7.5 保持未完成。
- 本轮新增验证：英文 canonical 运行时拒绝、英文 fallback 过滤、同 Session 候选保持独立、跨 Session `is_same_as` 不在答题阶段合并、单 Session/静态数量问题不注入事件计数规则，均通过。
- 回滚方式：仅回退 `longmemeval.ts`、`longmemeval.test.ts` 和本 change 的任务勾选；不要回退评测结果、fact fusion 或 SQLite WAL/SHM 的现有用户修改。

## 8. 英文 canonical facts 与独立计数证据

- [x] 8.1 将事实融合 Prompt 中的 `factText` 和 `normalizedClaim` 语言约束改为英文，并同步时间轴融合 Prompt；保留原始证据引用字段不变。
- [x] 8.2 计数类多 Session 问题保留独立候选，不在答题阶段按 Session/Event ID 合并；重复与互补关系沿用现有时间轴融合和关系边。
- [x] 8.3 在计数类答题 Prompt 中加入“先枚举独立事件，再计数”的约束，并明确忽略支持性事实和重复提及；渲染时使用真实 `questionType`，避免状态数量问题误触发。
- [x] 8.4 增加英文事实输出、运行时语言校验、计数候选独立保留和非计数状态问题不注入计数规则的测试。

## 9. 查询级确定性计算层

- [x] 9.1 新增 LongMemEval 计算 plan 类型、严格 planner prompt、expected-operation 校验和证据 item 白名单校验。
- [x] 9.2 在答题阶段从 selectedItems 构建临时计算 evidence，并注入 question reference time 与 evidence group key；不修改 FactItem 持久化字段。
- [x] 9.3 使用 TypeScript 确定性执行 count、sum、difference/duration、order、age、min/max，拒绝缺失、编造数值、无效时间和不兼容单位。
- [x] 9.4 计算成功时将结果作为辅助证据交给普通回答 LLM 复核；明确不足、planner 请求/解析/校验失败时保留 Trace 并继续普通回答链路。
- [x] 9.5 将 calculation plan、公式、临时 operands、sourceFactIds、回退原因写入 LongMemEval 日志和 JSONL diagnostics。
- [x] 9.6 增加纯函数与端到端测试，覆盖求和、日期差、顺序、缺失公交费用、非法 plan 回退及 operand 来源 Trace。

## 10. Top 8、统一证据正文和计算复核

- [x] 10.1 将统一候选二次重排改为最多选择 6 条，保留去重、跨 Session、时间端点、更新关系和计算 operand 覆盖，预算只作硬上限。
- [x] 10.2 构建统一 evidence text，并让相关性评分、token 估算、诊断、计算 evidence 与最终 Prompt 使用同一正文。
- [x] 10.3 将确定性计算结果改为回答模型的辅助证据；`insufficient`、无效和语义不可信的 count plan 均不得直接终止回答。
- [x] 10.4 强化事实抽取 Prompt，要求数字、日期、时长、金额、频率、区间、单位与所属事件或对象完整保留。
- [x] 10.5 增加 Top 8、FactItem 完整渲染、计算复核、count 数值防误算和时长抽取 Prompt 测试。
- [x] 10.6 运行 LongMemEval 聚焦测试、事实融合测试和 backend typecheck，并记录验证结果。

### 10.x 验证记录

- Backend 类型检查：`pnpm --dir apps/backend typecheck`，通过。
- 计算纯函数：`longmemeval-calculation.test.ts`，9/9 通过。
- 事实融合：`llm-fact-fusion.test.ts`，15/15 通过。
- LongMemEval 聚焦测试：Top 8、统一 FactItem 渲染、计算复核、独立计数证据和时间/数值/更新覆盖共 5/5 通过；五个计算集成样本均调用普通回答模型，三个成功计算样本携带辅助计算块。
- 答题证据扩展回归：长事实、完整丢弃、去重、统一正文及覆盖选择共 5/5 通过；另两个端到端旧用例仍在进入本变更链路前因测试 fetch mock 缺少 embedding `data` 数组失败。
- `git diff --check` 通过。当前环境未安装 `openspec` CLI，无法执行 `openspec status` 与 `openspec validate`。

## 11. 样本隔离与查询驱动的跨 Session 召回

- [x] 11.1 将 LongMemEval `contextScopeId` 从每个 Session Event 传播到所有生成 Fact，并增加持久化/恢复测试。
- [x] 11.2 为通用解析管线增加默认关闭的 Timeline Fusion enqueue 跳过选项，LongMemEval 入库启用该选项且生产默认不变。
- [x] 11.3 为 `searchContext` 增加 `contextScopeId` 严格记忆范围，并让 LongMemEval 只按当前样本 scope 查询 STM，不再依赖 haystack `sourceIds` 列表或 LTM。
- [x] 11.4 将 LongMemEval 最终证据上限从 8 调整为 12，并要求 Answer LLM 在回答前识别不同来源的语义重复。
- [x] 11.5 增加无 Timeline Fusion task、跨样本不串召回、样本内跨 Session、STM-only、Top 12、重复判断提示和 Session 失败跳过样本测试。
- [x] 11.6 运行 LongMemEval 聚焦测试、检索回归、backend typecheck、`git diff --check` 与 OpenSpec 校验并记录结果。

### 11.x 验证记录

- Backend 类型检查：`pnpm --dir apps/backend typecheck`，通过。
- LongMemEval 聚焦测试：样本 scope、跨 Session 同文证据保留、无 Timeline Fusion task、Top 12、计数候选独立、STM-only Prompt、回答前语义判重和 Session 失败屏障共 7/7 通过。
- Scope 持久化：SQLite Fact → STM → `searchContext(contextScopeId)` 重启恢复用例通过；LLM 成功抽取和 fallback 抽取均验证 Fact 继承 scope。
- 检索回归：`search-context.test.ts` 29/29 通过；Timeline Fusion scheduler/task 回归 8/8 通过。
- `git diff --check` 通过。
- 完整 `longmemeval.test.ts` 启动后有 3 个既有测试因 fetch mock 未返回 embedding `data` 数组失败，后续旧用例进入真实网络重试，已终止该进程；本变更聚焦用例均稳定通过。
- 当前环境未安装 `openspec` CLI，无法执行 `openspec status`、`openspec instructions apply` 与 `openspec validate`。

## 12. Context Pack 驱动的 Planner 与扩展确定性计算器

- [x] 12.1 新增 Planner decision 联合类型与严格 JSON prompt，使所有问题基于最终 Context Pack 判断 `direct_answer`、`calculation`、`insufficient_context` 或 `unsupported_operation`，规则推断仅作为 hint。
- [x] 12.2 建立统一 operation registry，扩展基础算术、聚合、比例百分比、比较选择、时间日历与单位转换类型，并严格拒绝缺少 decision 的旧版顶层 plan。
- [x] 12.3 实现第一阶段确定性执行与校验，覆盖加减乘除、平均、去重计数、极差、比例/百分比、比较/argmin/argmax、日期加减/日期差和单位转换。
- [x] 12.4 改造 LongMemEval 答题链路，按 Planner decision 执行或跳过计算，将 decision、plan、结果和失败原因写入 Trace，并始终保留原始 Context Pack 给 Answer LLM。
- [x] 12.5 增加纯函数和集成测试，覆盖未命中规则的计算、直接答案、证据不足、未知 operation、零除、单位不兼容、复合语义及旧 plan/混合协议拒绝。
- [x] 12.6 运行计算定向测试、LongMemEval 聚焦测试、backend typecheck、`git diff --check` 和 OpenSpec 校验并记录结果与未验证项。

### 12.x 验证记录

- 计算纯函数：`node --import tsx --test src/modules/context-engine/longmemeval-calculation.test.ts`，24/24 通过。
- LongMemEval 聚焦集成：`node --import tsx --test --test-name-pattern 'deterministic calculation planning computes supported answers' src/modules/context-engine/longmemeval.test.ts`，11 个样本通过；覆盖无规则 hint、direct_answer、insufficient_context 和 unsupported_operation，并确认非计算决策不产生占位 calculation result。
- 主 Planner 已删除旧版顶层单 operation plan 兼容；纯函数测试确认裸 plan 与同时包含 `decision`/顶层 `operation` 的混合响应均被拒绝，集成 mock 已全部迁移到 decision envelope。temporal repair 继续使用其独立的受限 plan schema。
- Backend 类型检查：`./node_modules/.bin/tsc -p tsconfig.json --noEmit`，通过。
- `git diff --check`，通过。
- `pnpm` 因本地 pnpm 9 签名校验/注册表不可用，改用仓库已安装的 `tsx`/`tsc` 二进制；OpenSpec CLI 未安装，无法执行 `openspec validate`。
- 两个真实 LongMemEval 样本验证通过：`36b9f61e` 从最终 Context Pack 绑定 `$800/$1,200/$500` 并执行 `800 + 1200 + 500 = 2500`；`gpt4_d12ceb0e` 绑定 `32/55/58/75/78 years` 并执行 `average(32, 55, 58, 75, 78) = 59.6`。两题均将公式、结果和来源 item/fact ID 作为审计块交给 Answer LLM。
- 真实样本验证补齐了无 reranker 时的问题相关性回退排序，以及确定性计算器缺失的 `month/months/year/years` 时间单位归一化；启用 cross-encoder reranker 时仍保持 reranker 主排序。
- 50 条新旧链路对照评测（7.2-7.5）仍未运行，保留为后续评测工作；回滚方式沿用第 7 节记录。
