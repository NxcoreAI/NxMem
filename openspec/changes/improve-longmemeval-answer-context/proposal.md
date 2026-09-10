## Why

LongMemEval 当前会为同一道题分别构建基础 Context Pack 和答题关键证据。基础 Context Pack 只使用前 10 条召回结果，另一条支路从前 100 条候选中让 LLM 最多选择 8 条，但 selector 只能看到每条内容的前 600 字符，选中后又会把内容截成最多 1200 字符。

这套流程会让已经存在且已经召回的正确 STM 在最后进入答题 Prompt 时丢失正文、时间或新旧变化关系。最新 50 条测评中，“正确 STM 没有进入最终 Context Pack”和“STM 已选中但证据、时间或更新关系丢失”是最主要的失败来源。因此需要简化答题上下文链路，让短事实完整进入 Prompt，并保证时间、来源和更新关系始终与事实一起传递。

## What Changes

- LongMemEval 答题阶段只执行一次候选召回，避免基础 Context Pack 与关键证据使用两套候选结果。
- 将 LLM 生成的 `factText` 和 `normalizedClaim` 统一为英文，继续保留原始证据引用用于审计和回溯。
- 删除额外的 LLM selector 调用，由普通程序按照召回分数、去重、跨 Session 覆盖、时间与更新关系以及 token budget 组装答题证据。
- LongMemEval 以样本级 `contextScopeId` 进行逻辑隔离，每个 Session 独立完成事实抽取、Session 内时间轴聚合、STM 准入和索引刷新；样本内全部 Session 成功后再开始答题召回。
- LongMemEval 入库不创建异步 `TimelineFusionTask`，不再等待或依赖跨 Session 持久事实融合；生产和 Agent conversation 入库默认行为保持不变。
- 答题召回必须按 `contextScopeId` 限定到当前样本，只查询 STM，不依赖 haystack `sourceIds` 白名单，也不使用 LTM。
- 从候选中按问题相关性二次重排并选择最多 6 条关键证据；时间端点、计算 operand、状态更新和跨 Session 覆盖优先于原始召回顺序，token budget 仅作为异常硬上限。
- 候选排序、诊断和最终 Prompt 使用同一份 evidence text；当关联 FactItem 比 STM/LTM 摘要更完整时，将 `factText` 和必要的 `sourceClaim` 一并渲染。
- 对所有的 STM 传递完整内容，取消 600 字符 preview 和 1200 字符二次 excerpt。
- 保留异常长的 segment fallback 或 timeline 内容参与候选，不因字符长度丢失完整事实。
- 在候选选择输入和最终答题 Prompt 中携带事实时间、消息时间、来源角色、来源 Session，以及更新、替换和冲突关系。
- 对需要多条证据的问题保留不同 Session、不同时间点和计算所需的全部条件，避免只选中其中一条。
- 对多 Session 问题保留不同 Session 的独立事实候选，不在答题阶段按 Session/Event ID 拼接或持久融合；回答模型先判断不同来源是否为同一事实的重复提及，再基于去重后的证据回答。
- 记录前 100 条候选、最终选中项、未选原因和实际 Prompt 内容，支持逐条判断失败发生在哪一步。
- 保留查询级确定性计算，但计算结果只作为可审计的辅助证据交给回答模型复核；`insufficient` 和低置信度计划不得直接终止回答。
- 强化事实抽取完整性约束，要求数字、日期、时间点、持续时长、金额、频率、区间、单位及其所属事件或对象成组保留。
- 不修改 `rankedSessionIdsForLongMemEvalAnswer`，因为该支路不影响最终答案。

## Capabilities

### Modified Capabilities

- `context-engine`: 改进评测答题上下文的候选选择、完整证据传递、时间与更新关系保留以及诊断记录。

## Impact

- 主要修改 `apps/backend/src/modules/context-engine/longmemeval.ts` 的答题上下文构建流程，以及 `llm-fact-fusion.ts` 的事实抽取 Prompt。
- 为 `searchContext` 增加 `contextScopeId` 记忆范围，并复用已有双语索引召回和时间字段。
- 抽取一个可复用的答题证据选择与渲染 helper，避免 LongMemEval 内部重复组装 Prompt。
- 更新 LongMemEval 单元测试、集成测试和 50 条评测诊断输出。
- 不修改事实抽取字段结构、STM 准入、LTM Dreaming、Session 排名指标和 Judge 判定逻辑；仅强化事实抽取 Prompt 的完整性要求。
