## Context

上一轮迁移已经引入 graph store 语义接口：`upsertGraphMemoryNode`、`deleteGraphMemoryNode`、`searchGraphText`、`searchGraphVector`、`getGraphRelationEdges`，并让 `search_context` 通过这些接口检索图谱内 STM/LTM。当前实现仍把 graph node、FTS、向量和关系邻域保存在本地 repository/SQLite 中，这不满足“迁移到 Neo4j”的目标。

Neo4j 提供官方 JavaScript driver、全文索引和向量索引能力。官方文档中 JS driver 使用 `neo4j-driver`；全文索引可通过 `CREATE FULLTEXT INDEX ... ON EACH [...]` 和 `db.index.fulltext.queryNodes()` 查询；向量索引可通过 `CREATE VECTOR INDEX ...` 和 `db.index.vector.queryNodes()` 查询。实现应兼容 Neo4j 5/6，因此首期使用 procedure 查询入口。

## Goals / Non-Goals

**Goals:**

- 启用 Neo4j 时，将 STM/LTM graph node 与关系边写入 Neo4j。
- Neo4j graph store 负责 graph FTS、graph vector 和关系邻域查询。
- 启动时确保 Neo4j 约束、全文索引和向量索引存在。
- `search_context` 和索引刷新继续依赖既有 graph store 端口，不感知 Neo4j 细节。
- 在没有 Neo4j 配置的本地开发和现有测试中保留本地 fallback。

**Non-Goals:**

- 不实现复杂路径搜索、社区发现、PageRank 或图算法重排。
- 不删除 SQLite text/vector index 表；它们仍可用于兼容、调试和 fallback。
- 不在本轮迁移历史数据；只保证后续索引刷新和关系维护写入 Neo4j。
- 不在没有 Neo4j 服务的 CI 中强制运行集成测试。

## Decisions

### Decision 1: 使用组合式 graph store，而不是让整个 repository 变成 Neo4j repository

新增 `GraphMemoryStore` 抽象或等价组合对象，`ContextEngineRepository` 的 graph 方法委托给该对象。默认本地 store 使用当前数组/SQLite 逻辑；配置启用时使用 `Neo4jGraphMemoryStore`。

理由：当前 repository 同时负责事件、事实、STM/LTM、trace 和调试快照。只把图谱能力委托出去，可以最小化迁移风险，并保持 `search_context` 已完成的端口化成果。

### Decision 2: Neo4j 图模型以 `MemoryNode` 为核心

Neo4j 节点：

- `(:MemoryNode:STM {ownerType, ownerId, ownerKey, content, lifecycleStatus, sourceRefsJson, entityIds, embedding, refreshedAt})`
- `(:MemoryNode:LTM {ownerType, ownerId, ownerKey, content, lifecycleStatus, sourceRefsJson, entityIds, embedding, refreshedAt})`

Neo4j 关系：

- `(:MemoryNode)-[:SAME_SOURCE|DERIVED_FROM|IS_SAME_AS|SUPPORTS|CONFLICTS_WITH|UPDATES|RELATED_TO|PART_OF {edgeId, relationType, evidence}]-(:MemoryNode)`

理由：标签区分 STM/LTM，`ownerKey` 保证幂等 upsert，关系类型使用大写 Cypher relationship type，同时保留原始 `relationType` 字段用于 API 输出。

### Decision 3: Neo4j 负责图谱内 FTS 和向量检索

- FTS：`CALL db.index.fulltext.queryNodes($indexName, $query) YIELD node, score`
- Vector：`CALL db.index.vector.queryNodes($indexName, $limit, $queryVector) YIELD node, score`
- 邻域：`MATCH (node:MemoryNode {ownerKey: $ownerKey})-[rel]-(other:MemoryNode) RETURN rel, other`

查询结果转换为现有 `GraphMemorySearchHit` 和 `RelationEdge`。`ownerTypes` 与 `ownerKeys` 过滤在 Cypher 中执行，避免从 Neo4j 拉回无关结果后在应用层过滤。

### Decision 4: 启用模式必须显式配置

新增配置：

- `CONTEXT_ENGINE_GRAPH_STORE=local|neo4j`
- `NEO4J_URI`
- `NEO4J_USERNAME`
- `NEO4J_PASSWORD`
- `NEO4J_DATABASE`
- `NEO4J_MEMORY_FULLTEXT_INDEX`
- `NEO4J_MEMORY_VECTOR_INDEX`
- `NEO4J_MEMORY_VECTOR_DIMENSIONS`

当 `CONTEXT_ENGINE_GRAPH_STORE=neo4j` 且连接或索引初始化失败时，后端启动失败；不静默降级到本地 store。`local` 模式继续保持现有测试可运行。

## Risks / Trade-offs

- [Risk] Neo4j 服务不可用会导致生产启动失败。→ 仅在显式 neo4j 模式失败；local 模式不受影响。
- [Risk] Neo4j vector index 维度必须和 embedding 维度一致。→ 默认使用 `embedding.dimensions`，只有显式配置 `NEO4J_MEMORY_VECTOR_DIMENSIONS` 时才覆盖，并在 upsert 前校验向量长度。
- [Risk] 旧数据只在 SQLite graph store 中，Neo4j 初次启用没有历史图节点。→ 本轮不迁移历史数据；后续可通过重建索引任务补齐。
- [Risk] Full-text query 语法和中文分词能力受 Neo4j analyzer 限制。→ 首期沿用当前 token expansion 和 fulltext query，后续可配置 analyzer。

## Migration Plan

1. 引入 `neo4j-driver` 和配置项，默认 `local`。
2. 实现 Neo4j graph store adapter，包含连接、索引初始化、node upsert/delete、关系 upsert/delete、FTS/vector/neighbor 查询。
3. 将 repository 的 graph 方法委托到可替换 graph store。
4. 在 `saveRelationEdge`、删除级联和清表流程中同步 Neo4j 关系。
5. 添加 contract/unit 测试，集成测试通过环境变量显式启用。
6. 部署时先使用 local，配置 Neo4j 后切换 `CONTEXT_ENGINE_GRAPH_STORE=neo4j` 并重启。

## Open Questions

- 是否需要提供一次性历史数据 backfill 命令，把 SQLite 中已有 graph node 和 relation edge 写入 Neo4j？本轮按 non-goal 暂不实现。
