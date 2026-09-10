## MODIFIED Requirements

### Requirement: 以硬过滤和混合排序检索上下文
系统 SHALL 提供 `search_context`，在授权 STM、LTM、事实和索引上执行硬过滤与混合排序检索；当调用方提供 `contextScopeId` 或允许的记忆层集合时，系统 SHALL 将它们作为候选进入排序前的硬过滤条件，并与 tenant、principal、权限、状态和时间边界共同生效。

#### Scenario: 返回排序结果
- **WHEN** 调用方提交 `ContextQuery`
- **THEN** 系统按 tenant、principal、context scope（如提供）、允许层级（如提供）、权限、状态、敏感性和时间边界过滤，并返回带分数、原因、来源引用、记忆 ID、事实 ID 和权限状态的结果

#### Scenario: 权限校验失败
- **WHEN** 候选项未通过权限过滤
- **THEN** 系统将其排除，并记录 dropped 或 filtered 原因以供调试

#### Scenario: 检查打分原因
- **WHEN** `search_context` 返回排序候选
- **THEN** 每个候选都包含 semantic、keyword、graph、recency、importance、source reliability、feedback、diversity、conflict penalty、permission risk penalty 和 staleness penalty 的组件分数元数据（在这些组件被评估时）

#### Scenario: Context Scope 硬隔离
- **WHEN** 同一 repository 存在多个 principal 或多个 context scope 的相似 Fact/STM，且查询显式提供 tenantId、principalId 和 contextScopeId
- **THEN** 系统只允许三个范围字段均匹配的候选进入全文、向量、图召回和最终排序，不得依赖应用层结果后过滤实现隔离

#### Scenario: 限制可召回层级
- **WHEN** 调用方将允许层级限制为 Fact 与 STM
- **THEN** 全文、向量、图召回、重排和返回结果均不包含 LTM，即使 repository 中存在满足其他过滤条件的 LTM

### Requirement: 组装面向 Agent 的 Context Pack
系统 SHALL 提供 `assemble_context`，把检索候选转成结构化 `ContextPack`；评测调用方 SHALL 能显式提供 question identity、tenant、principal、context scope、reference time、允许层级和 token/evidence 预算，且这些范围和预算 SHALL 贯穿候选召回、选择、序列化和 trace。

#### Scenario: Context Pack 被组装
- **WHEN** 调用方请求某个任务的上下文
- **THEN** 系统返回 profile_context、task_context、recent_context、constraints、citations、conflicts、token_budget 元数据和 dropped item 原因

#### Scenario: Token 预算受限
- **WHEN** 候选内容超过请求预算
- **THEN** 系统去重、排序、压缩并丢弃低优先级内容，同时保留硬约束、相关冲突和关键主张的引用

#### Scenario: 组装期间实时权限失败
- **WHEN** 某条内容通过初次检索，但在最终权限校验时失败
- **THEN** 系统将其排除、记录原因，并 SHALL NOT 在 pack 中包含未经授权的原文或摘要

#### Scenario: 显式 Scope 贯穿 Context Pack
- **WHEN** 调用方提供 tenantId、principalId 和 contextScopeId
- **THEN** Context Pack 的 selected items、citations、conflicts、dropped 诊断、serialized prompt 和 trace 只引用当前 scope 的候选

#### Scenario: 数据集无关的评测答题上下文
- **WHEN** LongMemEval 或 LoCoMo 通过共享 benchmark answer context helper 构造 Context Pack
- **THEN** helper 使用调用方显式传入的 question identity、scope、reference time、允许层级和预算，不推导或读取其他数据集的字段约定

#### Scenario: LongMemEval 兼容调用
- **WHEN** LongMemEval 通过兼容 wrapper 使用共享 helper 且未指定新参数
- **THEN** 系统沿用变更前的候选限制、证据上限、token budget、排序、序列化和 trace 行为
