## Why

仓库现有 LoCoMo 能力只评测 Oracle Gold Fact 条件下的候选召回：准备阶段会把数据集 `observation` 直接转换为 Fact 写入 Store，然后计算 Recall、MRR 和 NDCG。该链路适合定位检索排序问题，但不能衡量原始长对话经过事实抽取、STM 准入、检索、Context Pack 和回答生成后的端到端效果。

LoCoMo 的数据组织也不同于 LongMemEval。LoCoMo 以一个长对话挂载多道问题；同一长对话只能摄入一次，再在隔离的记忆空间中回答该对话下的全部问题。把每道 LoCoMo 问题转换成独立 LongMemEval sample 会重复摄入对话并改变 Fact、STM 和排序结果，因此需要原生评测编排。

## What Changes

- 新增 LoCoMo-native 端到端评测链路，直接读取 `locomo10.json`，不转换成 LongMemEval 数据格式。
- 定义 LoCoMo 原始字段到评测域模型、MemoryEvent、SourceRef、隔离字段和评分输入的稳定映射。
- 按 `sample_id` 隔离长对话；按 session 时间顺序摄入一次，并执行原始消息解析、Fact 抽取、Session 内时间轴聚合、STM 准入和索引刷新。
- 首版与当前 LongMemEval 默认评测保持一致，不执行 LTM dreaming/consolidation，也不允许 LTM 进入召回或 Context Pack。
- 每个长对话的所有 session 完成后，立即针对该长对话下的每道 QA 独立执行召回、重排、证据选择、Context Pack 构造、上下文拼接和答案生成；不等待其他长对话完成准备。
- 将当前 LongMemEval 中可复用的答题候选选择和 Context Pack 逻辑抽取为数据集无关能力；LongMemEval 继续使用同一默认参数和行为。
- 实现与固定上游 LoCoMo 版本一致的官方评分器：category 1 使用多答案平均 token F1，category 2/4 使用普通 token F1，category 3 截取标准答案分号前内容后计算 token F1，category 5 使用官方拒答短语判分。
- 输出官方 QA Score、分类分数、完全正确率、Evidence Recall，以及 Fact→STM→Retrieval→Context Pack→Answer 漏斗诊断。
- 保留现有 `eval:locomo-retrieval` 作为 Oracle Fact 召回基线，新增独立 `eval:locomo` CLI。

## Capabilities

### New Capabilities

- `locomo-native-evaluation`: 定义 LoCoMo 字段映射、长对话隔离摄入、无 LTM 的端到端答题流程、官方评分和评测产物契约。

### Modified Capabilities

- `context-engine`: 将当前评测答题证据选择和 Context Pack 构造参数化为数据集无关能力，并确保 `contextScopeId` 贯穿召回与 Context Pack；不得改变 LongMemEval 默认行为。

## Impact

- 主要新增 `locomo-dataset.ts`、`locomo-evaluation.ts`、`locomo-official-scorer.ts` 和 `locomo-evaluation-cli.ts`。
- 调整 LongMemEval 答题上下文 helper 的命名和参数边界，使其接收显式 tenant、principal、context scope、question identity 和允许的记忆层。
- 在 `apps/backend/package.json` 增加 `eval:locomo`，并补充数据适配、隔离、评分、Context Pack 和 CLI 测试。
- 不修改 `eval:longmemeval`、`eval:locomo-retrieval` 的默认命令、指标和历史结果格式。
- 不新增 LTM 评测行为；后续启用 LTM 必须作为独立变更并建立新的 benchmark profile/version。
