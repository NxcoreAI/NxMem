## ADDED Requirements

### Requirement: 摄入记忆事件并捕获权限快照
系统 SHALL 接收 `MemoryEvent` 写入请求，校验必填字段，保存原始事件，捕获 `PermissionSnapshot`，并创建幂等的摄入任务。

#### Scenario: 新事件被接受
- **WHEN** Agent 或连接器使用幂等键提交合法的 `MemoryEvent`
- **THEN** 系统保存事件、来源引用和权限快照，并返回已接受的资源或任务标识

#### Scenario: 重复事件被提交
- **WHEN** 相同调用方使用相同幂等键再次提交
- **THEN** 系统返回既有资源或任务结果，不创建重复事实或记忆

#### Scenario: 无效事件被拒绝
- **WHEN** 事件缺少事件类型、事件时间、多模态数据、来源身份或权限上下文
- **THEN** 系统返回校验错误，并且 SHALL NOT 调度下游处理

### Requirement: 返回批次记忆事件处理进度
系统 SHALL 在批次摄入场景中返回每个 `MemoryEvent` 的节点轨迹、终态和批次整体进度百分比。

#### Scenario: 文件批次被处理
- **WHEN** 文件摄入一次生成多个可写入的 `MemoryEvent`
- **THEN** 系统返回批次总进度、已处理数量、记住数量、丢弃数量，以及每条事件在 event、data_lake、fact、stm、index 节点上的处理轨迹

#### Scenario: 批次中存在失败项
- **WHEN** 某条事件在摄入过程中失败
- **THEN** 系统仍然保留该条事件的失败节点、错误原因和已完成节点，并继续返回批次整体进度

### Requirement: 在数据湖中保存原始与解析证据
系统 SHALL 在记忆准入前保存原始来源元数据、解析后的模态记录、来源引用、时间元信息、解析置信度、索引和关系链接。

#### Scenario: 解析器生成模态片段
- **WHEN** 解析器从事件中提取文本、文档、图片、音频、视频、人脸或情绪片段
- **THEN** 系统保存每个片段的事件 ID、模态类型、来源引用、时间元信息、置信度和处理状态

#### Scenario: 收到不支持的模态
- **WHEN** 事件包含当前没有解析器的模态
- **THEN** 系统保留原始来源引用，将解析状态标记为 pending 或 unsupported，并保留审计和未来重处理能力

### Requirement: 事实必须先于 STM 准入
系统 SHALL 先把解析或 Agent 提供的证据转成 `FactItem`，再创建短期记忆。

#### Scenario: 证据融合成事实
- **WHEN** 解析片段通过时间融合和事实抽取
- **THEN** 系统创建 `FactItem`，并写入事实类型、可读文本、标准化主张、关联事件、关联片段、来源引用、实体、置信度、版本、状态和时间戳

#### Scenario: Agent 快速写入记忆
- **WHEN** Agent 通过快速写入接口提交已确认的记忆内容
- **THEN** 系统先创建或关联 `FactItem`，再使用与正常摄入相同的准入策略和 provenance 规则评估 STM

### Requirement: 使用可解释规则准入 STM
系统 SHALL 根据重要性、置信度、新鲜度、敏感性、用户或 Agent 权重、冲突和权限状态评估事实是否进入 STM，并保留命中规则。

#### Scenario: 事实被准入到 STM
- **WHEN** 事实满足准入策略
- **THEN** 系统创建 `ShortTermMemory`，并保存来源事实 ID、来源引用、实体 ID、标签、时间范围、重要性、置信度、准入结果、准入原因、命中规则、关系边、向量引用和生命周期元数据

#### Scenario: 事实被拒绝或待确认
- **WHEN** 事实不满足准入策略，或因敏感性/低置信度需要确认
- **THEN** 系统记录拒绝或 pending-confirm 结果及原因，并 SHALL NOT 将其暴露为 active STM

### Requirement: 通过 Dreaming worker 维护 LTM
系统 SHALL 将高价值 STM 巩固为 `LongTermMemory`，并通过强化、修订、降权、归档、删除和冲突处理维护既有 LTM。

#### Scenario: STM 被巩固
- **WHEN** Dreaming job 选中高价值 STM 候选
- **THEN** 系统创建或修订 LTM，并保存理论分类、记忆类型、内容、摘要、来源引用、来源 STM ID、实体、置信度、召回权重、巩固原因、命中规则、关系边、版本信息、状态和有效期

#### Scenario: Dreaming job 中断
- **WHEN** Dreaming job 在部分完成后停止
- **THEN** 系统从最近 checkpoint 恢复，并 SHALL NOT 为同一候选集重复生成 LTM

#### Scenario: 既有 LTM 被降权
- **WHEN** 反馈、冲突、时间衰减或低使用率表明 LTM 应该降级
- **THEN** 系统更新召回权重或状态，记录原因，并发出记忆变化事件

### Requirement: 支持关系化去重与冲突跟踪
系统 SHALL 使用关系边表达重复、派生、支持、别名和冲突关系，而不销毁原始来源记录。

#### Scenario: 发现重复证据
- **WHEN** 新证据与既有事实或记忆在语义或结构上等价
- **THEN** 系统创建 `is_same_as`、`derived_from`、`alias_of` 或等价关系边，并保留双方来源记录以供审计

#### Scenario: 发现冲突记忆
- **WHEN** 新事实或记忆与同一实体、属性和时间范围内的既有记录冲突
- **THEN** 系统记录冲突引用，向 Context 组装暴露冲突元数据，并避免静默合并不兼容主张

### Requirement: 以硬过滤和混合排序检索上下文
系统 SHALL 提供 `search_context`，在授权 STM、LTM、事实和索引上执行硬过滤与混合排序检索。

#### Scenario: 返回排序结果
- **WHEN** 调用方提交 `ContextQuery`
- **THEN** 系统按 tenant、principal、权限、状态、敏感性和时间边界过滤，并返回带分数、原因、来源引用、记忆 ID、事实 ID 和权限状态的结果

#### Scenario: 权限校验失败
- **WHEN** 候选项未通过权限过滤
- **THEN** 系统将其排除，并记录 dropped 或 filtered 原因以供调试

#### Scenario: 检查打分原因
- **WHEN** `search_context` 返回排序候选
- **THEN** 每个候选都包含 semantic、keyword、graph、recency、importance、source reliability、feedback、diversity、conflict penalty、permission risk penalty 和 staleness penalty 的组件分数元数据（在这些组件被评估时）

### Requirement: 组装面向 Agent 的 Context Pack
系统 SHALL 提供 `assemble_context`，把检索候选转成结构化 `ContextPack`。

#### Scenario: Context Pack 被组装
- **WHEN** 调用方请求某个任务的上下文
- **THEN** 系统返回 profile_context、task_context、recent_context、constraints、citations、conflicts、token_budget 元数据和 dropped item 原因

#### Scenario: Token 预算受限
- **WHEN** 候选内容超过请求预算
- **THEN** 系统去重、排序、压缩并丢弃低优先级内容，同时保留硬约束、相关冲突和关键主张的引用

#### Scenario: 组装期间实时权限失败
- **WHEN** 某条内容通过初次检索，但在最终权限校验时失败
- **THEN** 系统将其排除、记录原因，并 SHALL NOT 在 pack 中包含未经授权的原文或摘要

### Requirement: 为新会话加载背景上下文
系统 SHALL 支持背景上下文加载，把固定背景文本与动态 STM/LTM 召回结合起来。

#### Scenario: 新会话开始
- **WHEN** Agent 会话开始且启用动态加载
- **THEN** 系统读取固定背景文本，检索相关 STM/LTM，检查冲突和权限，并生成带引用和审计元数据的当前会话背景文本

#### Scenario: 动态加载不可用
- **WHEN** 检索或组装依赖不可用
- **THEN** 系统回退到固定背景文本，并记录 degraded-mode 原因

### Requirement: 记录记忆变化事件和反馈
系统 SHALL 为记忆生命周期变化发出 `MemoryChangeEvent`，并接受用户或 Agent 的记忆反馈。

#### Scenario: 记忆生命周期变化
- **WHEN** STM 或 LTM 被创建、更新、强化、降权、修订、归档、删除、建立关系或收到反馈
- **THEN** 系统发出记忆变化事件，包含可用时的 before/after、原因、命中规则、来源引用、存储层和时间戳

#### Scenario: 用户纠正记忆
- **WHEN** 用户提交记忆纠正反馈
- **THEN** 系统记录反馈，创建修订或待修订任务，发出记忆变化事件，并更新检索或做梦信号

### Requirement: 执行删除和权限失效
系统 SHALL 在用户删除或来源权限撤销时立即停止相关记录的召回。

#### Scenario: 来源权限被撤销
- **WHEN** 权限服务报告某个来源引用不再对当前 principal 可见
- **THEN** 相关事实、STM、LTM 和 Context Pack 条目标记为 hidden 或 permission-invalid，且不再被召回

#### Scenario: 用户删除记忆
- **WHEN** 用户请求删除某条记忆
- **THEN** 系统立即停止召回，发出删除事件，并按保留策略异步清理索引、缓存和派生产物

### Requirement: 使用显式状态机管理生命周期
系统 SHALL 显式表示 Data Lake、Fact、STM 和 LTM 生命周期状态，并用这些状态决定召回资格、可见性、维护和清理。

#### Scenario: STM 过期
- **WHEN** active STM 达到 TTL
- **THEN** 系统将其标记为 expired 或移动到 candidate queue，以便做梦评估，并按生命周期策略降低或关闭普通召回

#### Scenario: Fact 被替代
- **WHEN** 新证据或用户纠正替换了一个 active fact
- **THEN** 系统将旧事实标记为 superseded，链接替代版本，更新依赖记忆或召回资格，并在影响记忆变化时发出事件

#### Scenario: LTM 被修订
- **WHEN** 做梦或用户反馈修订 active LTM
- **THEN** 系统记录版本历史，保留之前的来源引用，刷新索引，并让召回行为与修订状态保持一致

### Requirement: 在索引和召回前执行敏感信息策略
系统 SHALL 在记忆准入、索引、检索和 Context Pack 组装前对敏感信息分类，并默认采取最小暴露策略。

#### Scenario: 高敏内容被摄入
- **WHEN** 事件包含凭证、受监管个人数据、企业机密、未成年人数据或精确位置轨迹
- **THEN** 系统拒绝记忆准入或将其标记为 pending-confirm，除非策略明确允许，并 SHALL NOT 默认向量化原始敏感内容

#### Scenario: 敏感项进入上下文
- **WHEN** 授权调用方请求引用敏感内容的 Context Pack
- **THEN** 系统只包含允许的脱敏摘要和来源引用，除非调用方对原文有明确权限

### Requirement: 校验 LLM 生成的记忆产物
系统 SHALL 在持久化或 Agent 输出前校验 LLM 生成的事实、实体关系、准入决策、做梦输出和压缩摘要。

#### Scenario: LLM 事实输出通过校验
- **WHEN** 事实融合返回带有必需来源引用、置信度、标准化主张和实体的结构化输出
- **THEN** 系统持久化该事实，并记录 prompt version、model、schema version、confidence inputs 和审计元数据

#### Scenario: LLM 输出校验失败
- **WHEN** LLM 输出格式错误、缺少来源引用、置信度过低或违反敏感性策略
- **THEN** 系统在配置的重试次数内重试，或回退为 pending-confirm、rejected 或规则输出，而不创建不可追溯的 active memory

### Requirement: 提供评测和可观测指标
系统 SHALL 暴露摄入延迟、检索质量、Context Pack 组装、来源保留、权限过滤、token 使用和 worker 可靠性的指标与 trace。

#### Scenario: 评测运行完成
- **WHEN** 对检索或组装数据集执行评测
- **THEN** 系统记录 Recall@K、Precision@K、MRR@K、NDCG@K、延迟、token 使用和失败分类

#### Scenario: Context Pack 被检查
- **WHEN** 生成某个 pack
- **THEN** 系统保存足够的 trace 元数据，以解释被选中的项目、被丢弃的项目、分数、权限决策、引用、冲突和压缩步骤
