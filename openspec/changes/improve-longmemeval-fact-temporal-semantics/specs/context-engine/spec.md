## ADDED Requirements

### Requirement: LongMemEval 事实使用单值双时间锚点

系统 SHALL 为 LongMemEval 评测事实保存必需的单值 `evidenceTime` 和可选的单值 `validTime`，并 SHALL NOT 为该评测事实使用 evidence/valid start/end 区间表达。

#### Scenario: Session 日期成为证据时间

- **WHEN** LongMemEval Session 具有合法 `haystack_dates` 日期
- **THEN** 该 Session 抽取事实的 `evidenceTime` 等于按 UTC 规范化的 Session 日期，且 Session 日期不会被无条件写为 `validTime`

#### Scenario: 事实没有时间表达

- **WHEN** 原子事实没有可确定的绝对或相对时间表达
- **THEN** 事实只保存 `evidenceTime`，`validTime` 保持为空

### Requirement: LongMemEval 相对事实时间可确定计算

系统 SHALL 使用事实所在 Session 的 `evidenceTime` 作为基准，以确定性日历规则计算可识别的相对时间，并 SHALL NOT 使用 question date、抽取时间或写入时间替代该基准。

#### Scenario: factText 是时间锚点解析来源

- **WHEN** `factText` 包含可确定的相对时间表达，但 `sourceClaim` 缺少该表达
- **THEN** 系统从 `factText` 计算 `validTime`，并且规范化后的 LongMemEval Fact 只包含 `evidenceTime/validTime`，不包含 evidence/valid start/end 字段

#### Scenario: 计算相对小时

- **WHEN** Session evidence time 为 `2023-04-10T10:00:00.000Z` 且事实表达“两小时后”
- **THEN** 事实 `validTime` 为 `2023-04-10T12:00:00.000Z`

#### Scenario: 计算相对日或周

- **WHEN** 事实表达“两天前”或“两周后”
- **THEN** 系统以 Session evidence time 和 UTC 日历分别执行负向或正向计算，并保存结果开始时刻为 `validTime`

#### Scenario: 模糊数量不计算

- **WHEN** 事实只表达“几天后”或 `a few hours later`
- **THEN** 系统保留原始表达但不写入 `validTime`

#### Scenario: Duration 不作为时间锚点

- **WHEN** 事实只表达“会议持续一小时”且没有开始时间
- **THEN** 系统将持续时长保留在事实文本中，但不写入 `validTime`

#### Scenario: 持续事实记录开始时刻

- **WHEN** 事实表达“会议时间为 14:00-15:00”且日期可由证据确定
- **THEN** `validTime` 记录会议开始时刻 14:00，持续一小时的信息保留在事实文本中

### Requirement: LongMemEval 时间轴优先使用事实时间

系统 SHALL 在 LongMemEval 评测时间轴中优先使用 `validTime` 聚合和排序，并在 `validTime` 为空时使用 `evidenceTime`。

#### Scenario: 有事实时间时按事实时间排序

- **WHEN** 两条事实的 Session evidence time 顺序与计算后的 valid time 顺序不同
- **THEN** 评测时间轴按照 valid time 顺序排列

#### Scenario: 无事实时间时按证据时间排序

- **WHEN** 事实没有 valid time
- **THEN** 评测时间轴使用 evidence time，并且不使用 observed 或当前时间伪造事实时间

#### Scenario: 主评测消费抽取事实

- **WHEN** 当前样本已经成功抽取并持久化 Fact
- **THEN** 主评测时间轴使用这些 Fact 的单值时间，而不是始终从 Session event 构造带伪 valid time 的 raw fact

### Requirement: LongMemEval 单值时间贯穿回答链路

系统 SHALL 将 LongMemEval Fact 的单值 `evidenceTime/validTime` 传播到 STM、搜索结果、Context Pack 和计算证据，并 SHALL NOT 在这些评测对象中使用 evidence/valid start/end 区间字段。

#### Scenario: STM 保留单值时间

- **WHEN** LongMemEval Fact 进入 STM
- **THEN** STM 保留该 Fact 的 `evidenceTime` 和可选 `validTime`，且不生成对应 start/end 字段

#### Scenario: 回答提示包含事实时间

- **WHEN** 时间问题召回具有单值时间的 LongMemEval STM 或 Fact
- **THEN** Context Pack 将 `validTime` 渲染为事实时间、将 `evidenceTime` 渲染为消息时间，计算证据也携带相同字段

### Requirement: LongMemEval 计算遵循问题时间关系

系统 SHALL 根据问题语义识别参与计算的事实及其 start/end 或 minuend/subtrahend 关系，并 SHALL 由确定性代码对每个已选事实按 `validTime`、正文明确事件日期、`evidenceTime` 的顺序补全时间。

#### Scenario: 两个事实日期求差

- **WHEN** 问题询问事件 A 和事件 B 之间经过多少天，且两者均具有 `validTime`
- **THEN** 计算器按照问题描述的 A/B 关系使用两个 `validTime` 计算，不使用 Session 时间或 question date 替代

#### Scenario: 事实时间缺失时回退证据时间

- **WHEN** 某个计算事实没有 `validTime`、正文也没有可确定的事件日期，但具有 `evidenceTime`
- **THEN** 计算器使用该事实的 `evidenceTime`，并保留另一个事实自身的优先时间选择

#### Scenario: 正文日期优先于消息时间

- **WHEN** 某个已选计算事实没有 `validTime`，正文明确表达事件发生日期，且 `evidenceTime` 是另一个日期
- **THEN** 确定性代码从正文提取事件日期作为操作数时间，并在 trace 中记录时间来自正文

#### Scenario: 规划器只分配证据和角色

- **WHEN** `duration`、时间型 `difference` 或 `order` 的规划结果包含相关 `sourceItemIds` 和语义角色但没有 `time`
- **THEN** 确定性代码从对应证据补全时间并执行计算，且不要求规划模型复制时间字符串

#### Scenario: insufficient 误报触发一次修复

- **WHEN** 首次规划返回空操作数或 `insufficientReason`，但 Context Pack 中至少两条证据具有可确定时间
- **THEN** 系统仅针对可确定时间的候选执行一次受约束修复规划，并在修复选择出完整语义角色后执行确定性计算

#### Scenario: 真正缺少时间时保持不足

- **WHEN** 首次规划返回 `insufficientReason`，且 Context Pack 中没有足够的可确定时间候选
- **THEN** 系统不执行修复规划，并保留不足结果供普通答案链路回退

#### Scenario: 数值差不转换为日期差

- **WHEN** `difference` 计划提供带 value/unit 的两个数值操作数，且其证据同时具有 `evidenceTime`
- **THEN** 计算器执行数值差，不给这些操作数补充时间

#### Scenario: Duration 不增加第三个时间字段

- **WHEN** 事实表达会议从 14:00 到 15:00 或持续一小时
- **THEN** 时间锚点仍只有 `evidenceTime/validTime`，持续信息保留在事实文本中供 duration 问题读取

### Requirement: LongMemEval 多事件 item 保存事件级时间映射

系统 SHALL 允许一个 item 保存多个带独立 `validTime` 的事件，并 SHALL 通过稳定 `eventKey` 将计算操作数绑定到具体事件，而不是强制拆分 item 或让多个事件共享一个 item 级 `validTime`。

#### Scenario: 一个 item 包含两个设备设置事件

- **WHEN** 同一 item 表达 1 月 15 日设置 router 和 2 月 10 日设置 thermostat
- **THEN** item 的 `events` 包含两个具有不同 `eventKey/validTime` 的事件，且 item 级 `validTime` 不代表其中任一事件

#### Scenario: 计算器选择同一 item 中的不同事件

- **WHEN** order 或 duration 计划的两个操作数均引用同一个 `itemId`，但分别引用不同 `eventKey`
- **THEN** 确定性代码使用两个事件各自的 `validTime` 计算，而不是使用 item 级时间

#### Scenario: 多事件 item 缺少事件绑定

- **WHEN** temporal 操作数引用具有多个事件的 item，但没有提供 `eventKey`
- **THEN** 系统不猜测目标事件，并允许已有 repair 规划补充明确事件绑定

#### Scenario: 时间轴融合保留事件映射

- **WHEN** timeline fusion 将多个带时间的来源事实融合为一个 item
- **THEN** 融合 item 保留全部来源事件映射并按 `eventKey + validTime` 去重，不把它们折叠为单个时间
