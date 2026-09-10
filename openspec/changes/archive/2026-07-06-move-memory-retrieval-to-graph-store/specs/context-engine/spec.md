## ADDED Requirements

### Requirement: 图谱内记忆检索必须使用图数据库能力

系统 SHALL 通过 graph store 对 STM/LTM 图节点执行 FTS、向量检索和关系邻域查询，而不是让 `search_context` 直接扫描普通 text/vector index 存储。

#### Scenario: FTS 从 graph store 返回候选
- **WHEN** STM 或 LTM 索引刷新后调用 `search_context` 执行关键词检索
- **THEN** 系统通过 graph store 的 FTS 能力返回图节点候选，并继续按现有混合评分排序

#### Scenario: 向量检索从 graph store 返回候选
- **WHEN** 调用方提交语义查询且图节点已有向量
- **THEN** 系统通过 graph store 的向量检索能力返回候选，而不是直接遍历 repository vector index

#### Scenario: 关系邻域从 graph store 返回
- **WHEN** 检索命中带有关联边的 STM 或 LTM 图节点
- **THEN** 检索结果的 `relationEdges` 来自 graph store 邻域查询

### Requirement: 图节点必须随 STM/LTM 索引刷新同步

系统 SHALL 在 STM/LTM 刷新索引时同步对应 graph memory node，使图数据库内的 FTS、向量和生命周期状态与可召回记忆一致。

#### Scenario: STM 索引刷新同步 graph node
- **WHEN** active STM 刷新索引
- **THEN** graph store 中存在对应 STM 图节点，包含文本、向量、状态、来源和实体元数据

#### Scenario: LTM 索引刷新同步 graph node
- **WHEN** active LTM 刷新索引
- **THEN** graph store 中存在对应 LTM 图节点，包含文本、向量、状态、来源和实体元数据
