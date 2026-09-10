## Context

Context Engine 会把可进入图检索的 STM/LTM 投影为 `GraphMemoryNode`，并通过 `RelationEdge` 表达节点之间的 `derived_from`、`supports`、`conflicts_with`、`updates` 等关系。local 模式使用本地 repository/SQLite 图存储，Neo4j 模式将节点和关系写入 Neo4j。

本次所说的“事实”是 STM/LTM 节点中的记忆内容，不是独立 `FactItem`。接口中的“完整记忆图”是指 graph store 当前实际保存的全部节点和关系；调用方通过连续请求所有页面获得完整结果。已经被删除、未建立图投影或不再存在于 graph store 的历史记录不属于返回范围。

当前部署假设只有一个用户，接口运行在可信网络边界内。本轮不增加 owner 字段、多用户认证、跨用户过滤或关系生成范围限制，但保留与用户数量无关的分页、稳定契约、过滤、错误处理和跨 graph store 一致性。

## Goals / Non-Goals

**Goals:**

- 通过一个 HTTP endpoint 分页读取当前 graph store 中的 STM/LTM 节点和关系边。
- 默认查询覆盖全部 layer 和关系类型，使调用方遍历全部页面后得到完整图。
- 节点和边共享一个查看页码，但保留独立 limit，避免任一侧的数据量拖垮单次响应。
- 使用稳定、版本化、规范化的 `nodes + edges` JSON 契约。
- 直接从当前启用的 graph store 读取数据，不依赖 debug snapshot。
- 在 local 和 Neo4j 模式下保持相同的字段、过滤、page/cursor 和排序语义。
- 保持接口只读，不改变任何记忆或关系状态。

**Non-Goals:**

- 不为 LTM 或 graph node 增加 `tenantId/principalId`。
- 不修改 STM/LTM 关系生成、候选范围或遗留关系。
- 不实现多用户认证、owner 隔离或 source visibility 过滤。
- 不实现增量 change feed、跨请求强一致快照或数据库备份。
- 不把 `FactItem`、Entity 或 SourceRef 升级为新的图节点。
- 不提供图写入、关系修改或删除能力。
- 不返回 embedding、Prompt、LLM Trace、准入 Trace 或 debug snapshot 的其他字段。

## Decisions

### Decision 1: 使用 `POST /context/memory-graph/query`

查询同时包含 node page、edge page、layer 和 relation type 等结构化参数。使用 POST 可以保持请求结构清晰，并为后续增加查询条件留出空间；该 endpoint 仍然是只读的，不产生服务端状态变更。

请求格式：

```json
{
  "layers": ["stm", "ltm"],
  "relationTypes": [
    "derived_from",
    "supports",
    "conflicts_with",
    "updates",
    "related_to"
  ],
  "page": 1,
  "nodePage": {
    "limit": 100
  },
  "edgePage": {
    "limit": 500
  }
}
```

默认和限制：

- `layers` 省略时默认为 `stm + ltm`。
- `relationTypes` 省略时返回所有支持的关系类型。
- `nodePage.limit` 默认 100，最大 200。
- `edgePage.limit` 默认 500，最大 1000。
- 顶层 `page` 同时控制 node 和 edge 页码，从 1 开始；省略 page 和 cursor 时默认为第 1 页。
- `nodePage` 和 `edgePage` 不接受 page，只分别管理 limit/cursor；顶层 page 不能与任一非空 cursor 同时使用。
- `nodePage.cursor` 和 `edgePage.cursor` 分别独立推进；首次请求传 `null` 或省略。
- `nodePage`、`edgePage` 至少一个必须是 page object；某一侧完成后可把该字段设为 `null`，只继续查询另一侧。
- 不提供 lifecycle/active 过滤，graph store 中当前存在的节点都属于分页范围。

layer 过滤同时作用于节点和边。例如只请求 `stm` 时返回 STM 节点及两个端点都是 STM 的关系；默认请求两个 layer 时覆盖 STM-STM、STM-LTM 和 LTM-LTM。

### Decision 2: 响应采用统一页码、独立数据页的 `memory-graph.v1`

响应格式：

```json
{
  "ok": true,
  "schemaVersion": "memory-graph.v1",
  "generatedAt": "2026-07-22T10:00:00.000Z",
  "page": 1,
  "nodes": {
    "items": [
      {
        "id": "stm_123",
        "layer": "stm",
        "memoryType": "preference",
        "content": "用户偏好使用 TypeScript",
        "factSummary": "用户的编程语言偏好",
        "lifecycleStatus": "active",
        "retrievalWeight": 0.8,
        "sourceRefs": [],
        "entityIds": ["entity_typescript"],
        "refreshedAt": "2026-07-22T09:05:00.000Z"
      }
    ],
    "limit": 100,
    "nextCursor": "node_cursor_2",
    "hasMore": true
  },
  "edges": {
    "items": [
      {
        "id": "edge_derived_from_ltm_456_stm_123",
        "from": "ltm_456",
        "to": "stm_123",
        "type": "derived_from",
        "evidence": "ltm_dreaming_consolidation",
        "strength": 0.95,
        "confidence": "high",
        "source": "dreaming",
        "createdAt": "2026-07-22T09:10:00.000Z"
      }
    ],
    "limit": 500,
    "nextCursor": null,
    "hasMore": false
  }
}
```

页码模式下节点页和边页共享响应顶层的 `page`，但两侧 limit 和 `hasMore` 独立。调用方也可以省略顶层 page，分别使用两个 cursor。某一页中的边可以引用尚未出现在当前节点页的节点，调用方应按稳定 ID 合并各页结果，递增统一 page 或分别推进 cursor，直到两个 `hasMore` 都为 `false`。

当请求中的 `nodePage` 或 `edgePage` 为 `null` 时，响应中对应的 `nodes` 或 `edges` 也为 `null`，graph store 不执行该侧查询。例如边已经完成但节点仍有下一页时，调用方提交下一次 node cursor 并设置 `edgePage=null`。

节点字段来自现有 `GraphMemoryNode`，HTTP 输出进行以下规范化：

- 使用 `ownerId` 作为 `id`。
- 使用 `ownerType` 作为 `layer`，值为 `stm` 或 `ltm`。
- `memoryType`、`factSummary` 仅在存在时返回。
- `sourceRefs` 返回解析后的 JSON 数组，而不是 Neo4j 中的 `sourceRefsJson` 字符串。
- 不返回 `vector/embedding` 和内部 `graphNodeId`。

边字段来自现有 `RelationEdge`：

- `edgeId` 映射为 `id`。
- `fromId/toId` 映射为 `from/to`。
- `relationType` 映射为 `type`。
- 可选的 evidence、strength、confidence、source、createdAt 在存在时返回。

### Decision 3: 节点和边使用统一页码或独立稳定游标

节点按 `layer + id` 升序，边按 `id` 升序。页码模式使用同一个顶层 page，并分别按 `(page - 1) * nodeLimit` 和 `(page - 1) * edgeLimit` 计算 offset；cursor 模式中 node cursor 记录最后一个 `layer + id`，edge cursor 记录最后一个 `edgeId`。adapter 使用 `limit + 1` 判断 `hasMore`，实际响应最多返回 `limit` 条。

cursor 是带版本和过滤摘要的 opaque 字符串，包含：

- cursor 类型：node 或 edge。
- schema/cursor 版本。
- 最后排序键。
- node cursor 绑定 `layers` 的规范化摘要。
- edge cursor 绑定 `layers + relationTypes` 的规范化摘要。

cursor 类型错误、无法解析或与当前过滤条件不匹配时返回 `400 INVALID_MEMORY_GRAPH_CURSOR`，不得静默从头查询。

本轮不承诺跨多个 HTTP 请求的强一致数据库快照。并发写入时，调用方可能看到最终一致结果；需要严格快照或增量同步时另行设计 snapshot/change feed。

### Decision 4: 通过 GraphMemoryStore 分页读取，不使用 debug snapshot

扩展 `GraphMemoryStore`：

```ts
listGraphMemoryNodes(query: GraphMemoryNodePageQuery): MaybePromise<GraphMemoryNodePage>;
listGraphRelationEdges(query: GraphRelationEdgePageQuery): MaybePromise<GraphRelationEdgePage>;
```

同时由 `ContextEngineRepository` 委托这两个方法。新增 `queryMemoryGraph` application service 负责：

1. 校验和规范化请求。
2. 校验顶层 page 与所有 cursor 互斥，将统一 page 按两侧 limit 转换为各自 offset，或解码 cursor 并校验过滤摘要。
3. 并行查询节点页和边页。
4. 映射 `memory-graph.v1` 字段并返回独立分页元数据。

不直接使用 `repository.getDebugSnapshot()`，原因是 debug snapshot 同时包含事件、Fact、Trace、任务、反馈等内部数据，外部接口不应与其结构耦合。

### Decision 5: local 和 Neo4j 实现相同分页语义

local graph store 从现有 `graph_memory_nodes` 和 `relation_edges` 读取，按稳定键执行 page offset 或 cursor 条件、过滤、排序和 `limit + 1` 查询。

SQLite 关系分页通过 `from_id/to_id` 分别连接 `graph_memory_nodes.owner_id`，据此校验两个端点存在并执行 layer 过滤；内存实现使用相同的 endpoint node map 语义。

Neo4j 节点查询在 Cypher 中完成 layer、page offset/cursor 和 limit 约束：

```cypher
MATCH (node:MemoryNode)
WHERE node.ownerType IN $layers
  AND ($afterLayer IS NULL OR node.ownerType > $afterLayer
    OR (node.ownerType = $afterLayer AND node.ownerId > $afterId))
RETURN node
ORDER BY node.ownerType, node.ownerId
SKIP $offset
LIMIT $limitPlusOne
```

Neo4j 关系查询在 Cypher 中限制两个端点 layer、关系类型、page offset/edge cursor 和 limit：

```cypher
MATCH (from:MemoryNode)-[rel]->(to:MemoryNode)
WHERE from.ownerType IN $layers
  AND to.ownerType IN $layers
  AND (rel.relationType IN $relationTypes OR type(rel) IN $neo4jRelationTypes)
  AND ($afterEdgeId IS NULL OR rel.edgeId > $afterEdgeId)
RETURN rel,
       from.ownerId AS fromId,
       to.ownerId AS toId
ORDER BY rel.edgeId
SKIP $offset
LIMIT $limitPlusOne
```

Neo4j adapter 将 `sourceRefsJson` 解析为 `SourceRef[]`，将 relationship type 或 `rel.relationType` 转换为业务关系类型，并复用现有节点/关系转换校验。内存、SQLite 和 Neo4j adapter 必须通过同一分页 contract test。

### Decision 6: 标准化查询错误

主要错误：

- `400 INVALID_MEMORY_GRAPH_QUERY`：layer、relation type 或 limit 非法。
- `400 INVALID_MEMORY_GRAPH_CURSOR`：cursor 损坏、类型错误或过滤摘要不匹配。
- `500 MEMORY_GRAPH_QUERY_FAILED`：graph store 读取或映射失败。

错误响应包含稳定 code、用户可理解 message 和 request ID，不得返回部分图数据，也不得暴露 Neo4j 连接信息、SQL 或内部堆栈。日志记录 request ID、graph store mode、过滤摘要、返回数量、耗时和错误码，不记录完整记忆正文或 embedding。

## Risks / Trade-offs

- 分页避免了单次响应过大；统一页码方便同时查看节点和关系，但两侧 limit 不同时，同一页代表各自数据集中的不同 offset 区间。并发写入可能导致页面位移，稳定遍历时应分别维护 node cursor 和 edge cursor，并按 ID 合并结果。
- 分页是最终一致的，不适合作为审计级数据库备份；并发写入期间需要允许重试或重新遍历。
- 无 owner 隔离意味着接口不能直接用于多租户部署；切换多用户前必须新增身份和数据边界设计。
- 返回的是 graph store 当前状态，不是关系型主存储的全部历史 STM/LTM。
- `sourceRefs` 可能包含来源标识或 URL，因此接口应只部署在当前约定的可信网络边界内。

## Migration Plan

1. 增加分页请求、响应、page 和 cursor 类型，不修改现有数据 schema。
2. 增加 GraphMemoryStore node/edge 分页端口和内存/SQLite 实现。
3. 实现 Neo4j 的 layer、relation type、page/cursor 和 limit 查询。
4. 实现 `queryMemoryGraph` 和 `POST /context/memory-graph/query`。
5. 添加 local/Neo4j contract、页码跳转、完整翻页、过滤、cursor、排序和错误测试。
6. 更新 README，说明如何使用统一页码、独立 limit 或遍历两个 cursor，以及单用户和最终一致语义。
