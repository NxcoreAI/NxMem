## Why

当前 graph store 端口已经把 `search_context` 从直接扫描本地索引中解耦，但图谱节点、关系、FTS 和向量检索仍由本地 repository 模拟。用户明确要求把现有图机制迁移到 Neo4j，并让检索算法中涉及图谱内数据的 FTS 和向量检索使用图数据库能力。

## What Changes

- 新增 Neo4j graph store 实现，使用官方 `neo4j-driver` 连接外部 Neo4j。
- 将 STM/LTM graph node、关系边、全文索引和向量索引写入 Neo4j。
- Neo4j 启用时，`search_context` 的 graph FTS 使用 Neo4j full-text index 查询，graph vector 使用 Neo4j vector index 查询，关系邻域使用 Cypher 图遍历查询。
- 新增 Neo4j 配置、连接健康检查、索引初始化和降级策略。
- 保留当前本地 graph store 作为开发/测试 fallback；生产启用 Neo4j 时不得回退到本地索引完成图谱内 FTS/vector 检索。

## Capabilities

### New Capabilities

### Modified Capabilities

- `context-engine`: 图谱存储和检索要求从本地 graph store 适配器升级为 Neo4j graph store；图谱内 FTS、向量和关系邻域查询必须使用 Neo4j 能力。

## Impact

- 后端依赖：新增 `neo4j-driver`。
- 后端配置：新增 Neo4j URI、用户名、密码、database、启用开关、索引名、向量维度等配置。
- 后端持久化：新增 Neo4j graph store adapter，并在 repository/bootstrap 中按配置选择 Neo4j 或本地实现。
- 后端图模型：Neo4j 中新增 `:MemoryNode` 节点、STM/LTM 标签、稳定 owner key、source/entity 元数据和记忆关系边。
- 后端检索：graph FTS、graph vector、relation neighborhood 由 Neo4j Cypher 查询提供。
- 测试：新增 Neo4j adapter 的 Cypher/driver contract 单元测试；Neo4j 集成测试需要外部服务时默认跳过。
