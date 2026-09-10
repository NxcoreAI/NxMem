## ADDED Requirements

### Requirement: Neo4j 必须作为可启用的记忆图数据库

系统 SHALL 支持通过显式配置启用 Neo4j graph store，并在启用后把 STM/LTM graph node 与记忆关系边写入 Neo4j。

#### Scenario: Neo4j 模式启动成功
- **WHEN** `CONTEXT_ENGINE_GRAPH_STORE=neo4j` 且 Neo4j 连接配置有效
- **THEN** 系统连接 Neo4j，初始化记忆图约束、全文索引和向量索引，并使用 Neo4j graph store 处理后续 graph node 与 relation edge 写入

#### Scenario: Neo4j 模式配置无效
- **WHEN** `CONTEXT_ENGINE_GRAPH_STORE=neo4j` 但 Neo4j 连接、认证或索引初始化失败
- **THEN** 系统 SHALL 启动失败并暴露明确错误，且 MUST NOT 静默降级为本地 graph store

#### Scenario: 本地模式保持可用
- **WHEN** `CONTEXT_ENGINE_GRAPH_STORE` 未设置或设置为 `local`
- **THEN** 系统继续使用本地 graph store fallback，使本地开发和无需 Neo4j 的测试保持可运行

### Requirement: Neo4j 必须维护记忆图节点

系统 SHALL 在 STM/LTM 索引刷新时把对应 graph memory node upsert 到 Neo4j，节点必须包含 owner 类型、owner ID、稳定 owner key、内容、生命周期状态、来源引用、实体 ID、向量和刷新时间。

#### Scenario: STM 节点写入 Neo4j
- **WHEN** active STM 刷新索引且 graph store 为 Neo4j
- **THEN** Neo4j 中存在对应 `MemoryNode`/`STM` 节点，并且节点属性包含文本、向量、状态、来源和实体元数据

#### Scenario: LTM 节点写入 Neo4j
- **WHEN** active LTM 刷新索引且 graph store 为 Neo4j
- **THEN** Neo4j 中存在对应 `MemoryNode`/`LTM` 节点，并且节点属性包含文本、向量、状态、来源和实体元数据

#### Scenario: 图节点删除同步 Neo4j
- **WHEN** STM 或 LTM 失去召回资格、被删除或 index bundle 被删除
- **THEN** Neo4j 中对应 graph node 不再参与全文、向量或邻域召回

### Requirement: Neo4j 必须维护记忆图关系边

系统 SHALL 在保存、重放或删除关系边时同步 Neo4j 关系，并保持关系边幂等。

#### Scenario: 关系边写入 Neo4j
- **WHEN** 系统保存 `RelationEdge`
- **THEN** Neo4j 在对应两个 `MemoryNode` 之间 upsert 一条同语义关系，包含稳定 `edgeId`、原始 `relationType` 和证据信息

#### Scenario: 重复写入关系边
- **WHEN** 系统多次保存相同 `edgeId` 的关系边
- **THEN** Neo4j 中该 `edgeId` 关系保持一条，并更新证据信息而不产生重复边

#### Scenario: 级联删除关系边
- **WHEN** 记忆或事件被删除导致关系边失效
- **THEN** Neo4j 中对应关系边被删除或不再被邻域查询返回

### Requirement: 图谱内 FTS 必须使用 Neo4j 全文索引

系统 SHALL 在 Neo4j graph store 启用时，通过 Neo4j full-text index 查询 STM/LTM 图节点的文本候选。

#### Scenario: search_context 使用 Neo4j FTS
- **WHEN** 调用 `search_context` 执行关键词检索且 graph store 为 Neo4j
- **THEN** 系统通过 Neo4j full-text index 返回 graph text hits，并继续按现有混合评分排序

#### Scenario: FTS 查询执行 graph scope 过滤
- **WHEN** 查询指定 layer 或 source-scoped owner keys
- **THEN** Neo4j FTS 查询 MUST 在 Cypher 查询中限制候选 owner type 或 owner key，避免应用层扫描全部图节点

### Requirement: 图谱内向量检索必须使用 Neo4j 向量索引

系统 SHALL 在 Neo4j graph store 启用时，通过 Neo4j vector index 查询 STM/LTM 图节点的语义候选。

#### Scenario: search_context 使用 Neo4j vector index
- **WHEN** 调用方提交语义查询且 graph store 为 Neo4j
- **THEN** 系统通过 Neo4j vector index 返回 graph vector hits，而不是遍历本地 vector index 或本地 graph node 向量

#### Scenario: 向量查询执行 graph scope 过滤
- **WHEN** 查询指定 layer 或 source-scoped owner keys
- **THEN** Neo4j vector 查询 MUST 在 Cypher 查询中限制候选 owner type 或 owner key，并返回 Neo4j 相似度分数

### Requirement: 关系邻域必须使用 Neo4j 图遍历

系统 SHALL 在 Neo4j graph store 启用时，通过 Cypher 图遍历返回候选 STM/LTM 的关系邻域。

#### Scenario: 检索结果关系边来自 Neo4j
- **WHEN** `search_context` 命中带有关联边的 STM 或 LTM
- **THEN** 检索结果的 `relationEdges` 来自 Neo4j 邻域查询，并保留 `edgeId`、端点、关系类型和证据信息

#### Scenario: Context Pack 冲突汇总使用 Neo4j 邻域
- **WHEN** R2 组装候选包含 Neo4j 返回的 `conflicts_with` 关系边
- **THEN** Context Pack 的 `conflicts` 字段包含这些冲突边
