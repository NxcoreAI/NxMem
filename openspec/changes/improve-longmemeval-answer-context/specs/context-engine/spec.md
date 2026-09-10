## ADDED Requirements

### Requirement: 答题上下文必须使用统一的候选集合

系统 SHALL 为同一道评测问题只执行一次答题候选召回，并基于同一批候选完成证据选择、Context Pack 诊断和最终 Prompt 渲染。

#### Scenario: 构建 LongMemEval 答题上下文

- **WHEN** 系统为一道 LongMemEval 问题构建答题上下文
- **THEN** 系统从当前样本 `contextScopeId` 允许访问的 STM 中召回最多 100 条候选，并 SHALL NOT 查询 LTM，也 SHALL NOT 再为基础 Context Pack 执行一条独立的前 10 条召回支路

#### Scenario: 组装答题证据

- **WHEN** 系统从统一候选集合组装最终答题证据
- **THEN** 系统按召回分数、重复情况、跨 Session 覆盖、时间与更新关系和 token budget 执行确定性选择，并 SHALL NOT 调用额外的 LLM selector

### Requirement: STM 必须以完整正文进入答题证据

系统 SHALL 对所有进入候选集合的 STM 使用完整正文，不得在候选选择前截取前 600 字符，也不得在选中后再次生成 1200 字符或其他长度的局部片段。

#### Scenario: STM 进入最终答题证据

- **WHEN** STM 通过候选过滤并被最终答题上下文选中
- **THEN** 最终答题 Prompt 包含完整 `item.content`

#### Scenario: 召回结果是异常长文本

- **WHEN** 前 100 条召回结果中的 STM 来自 segment fallback 或 timeline aggregation 且正文较长
- **THEN** 系统仍将其作为完整候选参与相关性和 token budget 选择，不因字符长度提前排除或截取正文

### Requirement: 候选排序与渲染必须使用同一证据正文

系统 SHALL 使用由完整 `item.content`、关联 `factText` 和必要 `sourceClaim` 组成的统一 evidence text 完成二次排序、token 估算、计算和最终 Prompt 渲染，不得让排序器看到而回答模型看不到关键事实。

#### Scenario: FactItem 比 STM 摘要更完整

- **WHEN** 关联 FactItem 包含 STM 摘要省略的实体、数字、日期或限定条件
- **THEN** 统一 evidence text 和最终 Prompt SHALL 包含该完整 FactItem 内容

### Requirement: 答题证据必须保留时间、来源和更新关系

系统 SHALL 在候选选择输入和最终答题 Prompt 中同时传递正文、事实时间、消息时间、来源角色、来源 Session 和可用的更新或冲突关系。

#### Scenario: 时间问题使用 STM

- **WHEN** 候选 STM 包含 `validTimeStart`、`validTimeEnd`、`evidenceTimeStart` 或 `evidenceTimeEnd`
- **THEN** 答题上下文选择程序使用这些字段，最终 Prompt 分别显示事实发生时间和消息发送时间

#### Scenario: 新事实更新旧事实

- **WHEN** 两条候选通过 `updates`、`supersedes` 或等价关系表示新旧状态
- **THEN** 最终 Prompt 同时显示必要的新旧内容、对应时间和可理解的更新顺序

#### Scenario: 证据来自助手消息

- **WHEN** 候选事实的直接来源角色为 assistant
- **THEN** 最终 Prompt 明确标记 assistant 来源，答题阶段不得将该证据默认解释为用户已经经历、确认或偏好的事实

### Requirement: 证据数量必须由问题需要和上下文预算决定

系统 SHALL 从最多 100 条召回候选中按完整 evidence text 二次重排，并在必要条件覆盖后选择最多 6 条关键证据；token budget 仅作为异常硬上限。

#### Scenario: 多 Session 问题需要多条证据

- **WHEN** 回答问题需要来自多个 Session 的日期、数值、事件或状态
- **THEN** 系统在 6 条上限和预算允许时优先保留必要条件，并优先丢弃仅共享主题词的辅助内容

#### Scenario: 候选超过上下文预算

- **WHEN** 全部相关候选超过答题上下文 token budget
- **THEN** 系统先保留直接答案和计算、时间或更新所需条件，再丢弃重复和低相关候选，并记录每条丢弃原因

#### Scenario: 候选超过六条

- **WHEN** 二次重排后仍有超过 6 条可用候选
- **THEN** 系统只选择动态优先级最高且覆盖必要条件的 6 条，其余候选记录为 `lower_priority`

### Requirement: 评测结果必须记录答题证据选择过程

系统 SHALL 在 LongMemEval 结果诊断中记录前 100 条召回结果、候选分数、来源 Session、最终选中项、未选原因、预算丢弃信息和时间字段是否进入最终 Prompt。

#### Scenario: 分析一条错误答案

- **WHEN** 开发者检查一条 LongMemEval 评测结果
- **THEN** 诊断信息能够区分正确 STM 未生成、未进入前 100 条召回结果、未被选择、因预算被丢弃、渲染时丢失和答题模型推理错误

#### Scenario: 诊断写入失败

- **WHEN** 候选或选择诊断无法完整序列化
- **THEN** 系统记录诊断错误但继续生成正式答案，且不得改变候选选择结果

### Requirement: Canonical fact text uses English for answer retrieval

系统 SHALL 将 LLM 事实融合、时间轴融合和 conversation ingestion 生成的 `factText` 与 `normalizedClaim` 使用英文表达，并在入库前拒绝包含汉字的 canonical text，以便英文问题直接匹配事实正文；原始证据引用仍用于审计，但不作为 canonical fact text。

#### Scenario: English LongMemEval evidence

- **WHEN** LLM 从英文会话证据生成 FactItem 或时间轴聚合事实
- **THEN** `factText` 和 `normalizedClaim` 使用英文，并保留原始事实含义、时间、数字和限定条件

### Requirement: Count questions preserve independent answer evidence

系统 SHALL 对计数类问题保留召回候选的独立事实，不得在答题阶段按来源 Session、Event ID 或日期拼接或持久融合候选；回答模型先判断不同来源是否为同一事实或事件的重复提及，再枚举独立事件。

#### Scenario: Count events across sessions

- **WHEN** 问题要求统计多个 Session 中某类事件的次数
- **THEN** 系统保留每条独立候选，并在 Prompt 中要求先枚举符合时间范围的独立事件，再进行计数

#### Scenario: Non-count state question

- **WHEN** 问题询问年龄、偏好或其他状态事实而不是事件次数
- **THEN** 系统继续使用普通事实证据选择，不引入答题阶段的 Session/Event 合并

### Requirement: LongMemEval 样本必须通过 contextScopeId 逻辑隔离

系统 SHALL 为每个 LongMemEval 样本分配稳定的 `contextScopeId`，并将它从 Session Event 传播到所有生成 Fact；答题召回必须使用该字段限定当前样本，不得依赖完整 haystack `sourceIds` 列表实现隔离。

#### Scenario: 两个样本包含相同 Session ID

- **WHEN** 两个 LongMemEval 样本包含相同 Session ID 或相似事实文本
- **THEN** 每个样本的召回结果只包含与本题 `contextScopeId` 相同的 STM，不得召回另一题的事实

#### Scenario: 样本内跨 Session 召回

- **WHEN** 当前样本有多个 Session 且答案需要其中多条事实
- **THEN** 相同 `contextScopeId` 下不同 Session 产生的 STM 均可参与本题召回

### Requirement: LongMemEval 不得执行持久化跨 Session 事实融合

系统 SHALL 让每个 Session 独立完成事实抽取、Session 内时间轴聚合、STM 准入和索引刷新，并 SHALL NOT 为 LongMemEval Fact batch 创建异步 `TimelineFusionTask`。生产和 Agent conversation 入库的默认行为保持不变。

#### Scenario: 样本全部 Session 入库成功

- **WHEN** 当前样本的全部 Session 已完成 STM 索引刷新
- **THEN** 系统直接按问题执行样本内跨 Session 召回，不等待跨 Session 事实聚类或融合

#### Scenario: 任一 Session 入库失败

- **WHEN** 当前样本任一 Session 的抽取、聚合、准入或索引失败
- **THEN** 系统跳过该样本的回答与判题，并记录失败阶段和原因

### Requirement: Answer LLM 必须处理跨 Session 语义重复

系统 SHALL 将不同来源但语义可能重复的已选证据交给 Answer LLM，并要求模型在回答前比较实体、事件、时间和来源以识别重复提及。

#### Scenario: 同一事实在多个 Session 重复出现

- **WHEN** 最终证据中不同 Session 的候选描述同一事实或事件
- **THEN** Answer LLM 将其视为重复支持，不得重复计数或当作多个独立答案条件

### Requirement: Calculation questions use query-scoped deterministic execution

系统 SHALL 对每个 LongMemEval 问题让 Planner LLM 基于最终 Context Pack 输出严格 JSON 决策，并区分 `direct_answer`、`calculation`、`insufficient_context` 与 `unsupported_operation`。`calculation` 分支由 TypeScript 使用统一 operation registry 和证据白名单确定性执行；现有规则推断不得作为 Planner 的调用门槛。计算 plan 的临时 operands、公式、来源 fact ID 和失败原因只能写入本题 Trace，不得新增持久化 FactItem 字段。

#### Scenario: Context already contains the answer

- **WHEN** 最终 Context Pack 已明确包含问题答案且无需额外运算
- **THEN** Planner 返回 `direct_answer` 并引用对应 evidence，系统跳过确定性执行器后继续让 Answer LLM 基于原始 Context Pack 回答

#### Scenario: Calculation intent is not matched by rules

- **WHEN** 问题需要确定性计算但未命中任何正则或启发式 operation 推断
- **THEN** 系统仍调用 Planner，允许其返回受支持的 `calculation` plan，并不得因规则未命中而跳过计算链路

#### Scenario: Context pack is insufficient

- **WHEN** Planner 能识别所需计算但最终 Context Pack 缺少必要 operand 或存在无法消除的歧义
- **THEN** Planner 返回 `insufficient_context`，系统不得重新召回或猜测 operand，并将原因写入 Trace 后继续普通回答链路

#### Scenario: Expanded deterministic operation

- **WHEN** Planner 请求基础算术、平均或去重计数、比例百分比、实体比较、日期加减或兼容单位转换
- **THEN** Validator 使用 operation registry 校验 operand 数量、来源、类型、单位及零分母等约束，只有通过验证的 plan 才由 Executor 执行

#### Scenario: Evidence-backed sum

- **WHEN** 问题要求合计多个事实中的数值，且 plan 中每个数值和单位都能在已选证据中找到
- **THEN** 系统按兼容单位归一化后确定性求和，将结果、公式和 operand 来源作为辅助证据交给普通回答模型复核，并在 Trace 中记录每个 operand 的 item ID 和 fact ID

#### Scenario: Temporal difference with reference date

- **WHEN** 问题要求计算两个事实日期的间隔，或要求解析“几天前/几周后/一年前”等相对时间，且起点、终点和问题参考日期存在
- **THEN** 系统使用事实 temporal metadata 和 query-scoped `question_reference_time` 计算，不让 LLM 自行估算日期，并在答案中保留日历差值的首尾计数说明（适用时）

#### Scenario: Missing or incompatible operands

- **WHEN** plan 缺少必要 operand、引用未进入上下文的 item、使用证据中不存在的数值，或多个单位不兼容
- **THEN** 系统不得猜测或继续计算，记录确定性的 insufficient/invalid 状态，并继续调用普通回答模型基于原始证据回答，Trace 记录具体原因

#### Scenario: Invalid planner output

- **WHEN** planner 请求失败、返回非法 JSON、未知 decision、未注册的 operation、缺少 decision 的旧版顶层 plan 或同时包含新旧协议字段的混合响应
- **THEN** 系统保留 request/parse/validation Trace，并回退现有 LongMemEval 回答模型，不改变原有答案链路

#### Scenario: Count plan contains numeric values

- **WHEN** `count` plan 的 operand 携带待读取或求和的数值
- **THEN** 系统将该 plan 判为语义不可信，不得把 operand 数量当作答案，并回退普通回答模型

### Requirement: 事实抽取必须保留计算相关限定

系统 SHALL 在事实抽取时重点保留数字、日期、时间点、持续时长、金额、频率、范围、上下界、单位及其对应的事件、交易、对象或状态，避免只保留泛化事件摘要。

#### Scenario: 事件包含持续时长

- **WHEN** 证据明确表示用户在 Chicago 停留 3 天或等价的事件时长
- **THEN** 抽取事实 SHALL 在同一条最小充分事实中同时包含 Chicago 行程和 3 天时长

#### Scenario: 证据包含多个可计算数值

- **WHEN** 证据明确给出多个独立交易、数量或日期且未来求和、比较或时间推理需要分别使用
- **THEN** 抽取结果 SHALL 保留每个数值、单位、所属对象和必要时间，不得因摘要压缩而遗漏
