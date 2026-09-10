## MODIFIED Requirements

### Requirement: 校验 LLM 生成的记忆产物

系统 SHALL 在持久化或 Agent 输出前使用严格结构化契约校验 LLM 生成的事实、实体关系、准入决策、做梦输出和压缩摘要，并保留失败尝试的原始响应和校验原因。

#### Scenario: 对话事实提取返回候选事实

- **WHEN** 对话事实提取模型返回满足 JSON Schema 的非空 `candidates` 数组
- **THEN** 系统继续执行候选字段、证据引文和准入校验，并记录本次提取 Trace

#### Scenario: 对话中没有候选事实

- **WHEN** 对话事实提取模型返回 `{"candidates":[]}`
- **THEN** 系统将本次提取视为正常成功结果，以零候选完成处理且不进入 `fact_pending`

#### Scenario: 对话事实输出格式错误

- **WHEN** 模型响应不是合法 JSON、缺少顶层 `candidates` 数组或违反候选 JSON Schema
- **THEN** 系统不创建事实，保存该次尝试的原始响应、模型、请求端点、尝试次数和具体校验原因，并按重试策略进入 `fact_pending` 或失败终态

### Requirement: 保留数字事实与精确实体

系统 SHALL 将对话中的日期、时间、金额、数量、比例、频率、序号和区间边界作为原子事实完整抽取，并在聚合和回答阶段保留其来源、时间戳与完整实体名称。

#### Scenario: 同一对话包含多个数字事实

- **WHEN** 一条或多条消息包含属于不同实体、事件或时间点的日期、时间、金额或其他数字
- **THEN** 系统为每个独立数字主张生成事实候选，不得用只覆盖部分数字的摘要候选替代

#### Scenario: 时间轴处理数字或时间事实

- **WHEN** 时间轴关系判断收到包含语义日期、时间、金额或其他数字细节的事实
- **THEN** 系统保留原子事实及其各自时间戳，不通过 `same_event`、`supplements` 或 `updates` 物化合并这些事实

#### Scenario: 名称相近的实体

- **WHEN** 两个实体名称存在包含或修饰关系但证据没有声明别名，例如 `tennis` 与 `table tennis`
- **THEN** 系统将其视为不同实体，不得合并事实或使用一个实体的证据回答另一个实体的问题

#### Scenario: 月份粒度的相对时间点

- **WHEN** 来源消息包含 `last month`、`3 months ago`、`三个月前` 等月份粒度的相对时间点
- **THEN** 系统以该消息的 evidence time 为锚点，先归一化到当月月初，再按日历月偏移并保存目标月份的 valid time

#### Scenario: 可由当前消息锚定的月份持续时间

- **WHEN** 来源事实明确表达截至当前消息已持续 `N months`，例如 `has been watching for 3 months`
- **THEN** 系统保存以目标月份月初为起点、以消息 evidence time 为终点的 valid-time 区间，不得将该 duration 改写成 `N months ago` 的单点事件
