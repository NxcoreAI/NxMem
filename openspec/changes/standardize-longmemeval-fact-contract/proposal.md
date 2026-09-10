## Why

LongMemEval 评测事实当前允许 LLM 自由生成 `factType`，同类事实会产生不稳定的类型标签。评测时间后处理还需要从 `factText/sourceClaim` 重新发现时间表达，无法审计模型是否完整保留了原始时间锚点，并且旧评测设计会把持续区间压缩成单个开始时间。

500 条评测结果显示，时间问题同时受到时间锚点解析、事实召回和计算角色选择影响。需要先建立稳定的事实输出契约，再根据真实评测答案 Session 中出现的时间表达扩展确定性解析器，避免用少量手写示例替代数据覆盖。

## What Changes

- 为 LongMemEval 评测事实定义固定 `FactType` 枚举，LLM 只能选择协议值。
- 在 LLM 事实候选中增加逐字 `timeAnchor`；`factText` 和 `normalizedClaim` 仍必须保留完整时间语义。
- 由评测程序从 `haystack_dates[sessionIndex]` 注入单值 `evidenceTime`，LLM 不输出 evidence 或 valid time。
- 由确定性解析器使用 `evidenceTime + timeAnchor` 生成时间：单一锚点写入 `validTime`，持续状态或明确区间写入 `validTimeStart/End`，不确定表达不计算。
- 使用 500 条评测基线和关联答案 Session 建立时间锚点覆盖清单与回归案例，并区分解析失败、召回失败和计算角色错误。

## Capabilities

### Modified Capabilities

- `context-engine`: 收敛 LongMemEval 评测事实类型和时间抽取、解析及传播契约。

## Impact

- 影响 LongMemEval 使用的 LLM fact fusion Prompt、响应解析、Fact 时间后处理、SQLite Fact 持久化和聚焦测试。
- 不改变 conversation ingestion 的事实候选协议和业务双时间轴契约。
- 重新运行评测 ingestion 后生成新契约事实；历史评测数据库保持可读取。
