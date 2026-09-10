## MODIFIED Requirements

### Requirement: LongMemEval 事实具有稳定类型和可审计时间锚点

系统 SHALL 要求 LongMemEval LLM 事实从版本化 `FactType` 枚举中选择语义类型，并 SHALL 为每条事实保存逐字 `timeAnchor` 或明确的空值。事实文本 SHALL 保留完整时间语义，模型 SHALL NOT 计算或返回 evidence/valid time。

#### Scenario: 模型选择固定事实类型

- **WHEN** LongMemEval 事实抽取返回候选事实
- **THEN** `factType` 必须属于协议枚举，未知、自定义或空类型候选被拒绝且不会回退为新的开放字符串

#### Scenario: 时间锚点保留在完整事实中

- **WHEN** 来源表达 `completed the course three days ago`
- **THEN** `factText` 保留 `three days ago`，`timeAnchor` 为来源中的逐字表达，且系统不会接受删除时间语义的 factText

#### Scenario: 多事件时间表达拆成原子事实

- **WHEN** 来源表达 `started the course two months ago and completed it three days ago`
- **THEN** 系统得到分别绑定 `two months ago` 和 `three days ago` 的两条原子事实，而不是一条无法绑定多个锚点的事实

### Requirement: LongMemEval 使用 Session evidence time 解析事实时间

系统 SHALL 使用 `haystack_dates[i]` 作为 `haystack_sessions[i]` 中所有事实的 UTC `evidenceTime`，并 SHALL 仅使用确定性规则将 `evidenceTime + timeAnchor` 解析为互斥的单点 valid time 或 valid-time 区间。

#### Scenario: 相对时间点生成单值时间

- **WHEN** evidence time 为 `2023-05-20T02:57:00.000Z` 且 timeAnchor 为 `three days ago`
- **THEN** 事实 `validTime` 为 `2023-05-17T00:00:00.000Z`，且不生成 `validTimeStart/End`

#### Scenario: 月份相对点生成单值时间

- **WHEN** evidence time 为 `2023-05-20T02:57:00.000Z` 且 timeAnchor 为 `two months ago`
- **THEN** 事实 `validTime` 为目标月份起点 `2023-03-01T00:00:00.000Z`，原始月份粒度由 timeAnchor 保留

#### Scenario: 持续状态生成区间

- **WHEN** evidence time 为 `2023-05-20T02:57:00.000Z` 且事实表达当前持续状态 `has been taking the course for two months`
- **THEN** 事实生成 `validTimeStart/End`，不生成单值 `validTime`，并保留原始 timeAnchor

#### Scenario: 模糊锚点不计算

- **WHEN** timeAnchor 为 `a few days ago`、`recently` 或其他无法确定计算的表达
- **THEN** 系统保留 timeAnchor，但不生成 `validTime` 或 `validTimeStart/End`

### Requirement: LongMemEval 时间解析覆盖由评测结果驱动

系统 SHALL 使用当前 500 条评测结果及其关联答案 Session 维护时间锚点覆盖和回归案例，并 SHALL 将锚点抽取/解析失败与召回及计算角色错误分别诊断。

#### Scenario: 新增解析语法具有真实案例

- **WHEN** 实现增加一种时间表达的确定性解析规则
- **THEN** 测试至少包含一个来自当前 LongMemEval 数据集形态的案例，并验证 point/range 输出和不确定表达拒绝行为

#### Scenario: 时间问题没有召回答案事实

- **WHEN** 时间问题失败但答案 Session 事实未进入检索上下文
- **THEN** 诊断标记 retrieval coverage 问题，而不是通过扩展时间解析器宣称修复
