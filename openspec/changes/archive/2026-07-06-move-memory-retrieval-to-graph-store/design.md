## Context

当前 Context Engine 已有 STM/LTM、关系边、文本索引和向量索引，但 `search_context` 直接从 repository 的 text/vector index 取候选，图关系只在结果上附带。用户要求把现有图机制迁移到图数据库，并且检索算法中涉及图谱内数据 FTS 和向量检索的部分使用图数据库能力。

仓库当前没有外部图数据库依赖或连接配置。为避免引入未确认服务，首期实现 `GraphMemoryStore` 端口，并在 repository 内提供本地图数据库适配器。业务代码只依赖图数据库语义接口；后续替换为 Neo4j、PG 图扩展或专用 graph service 时不需要改检索算法。

## Goals / Non-Goals

**Goals:**

- 将图谱内 STM/LTM 节点的 FTS 检索和向量检索迁移到 graph store 接口。
- 让索引刷新同步 graph node，graph node 包含 owner type、owner id、content、lifecycle status、source refs、entity ids 和向量。
- 让 `search_context` 的 keyword/vector candidate ranking 使用 graph store 返回的 hit。
- 让关系邻域查询使用 graph store，而不是直接扫描 snapshot relation edges。
- 保留现有测试环境可运行，不依赖外部图数据库服务。

**Non-Goals:**

- 不引入 Neo4j driver、PG 扩展或网络图数据库服务。
- 不删除现有 text/vector index 表；它们作为兼容和本地图存储底座继续存在。
- 不改变 scoring 公式和 Context Pack 输出结构。
- 不实现图算法重排、路径搜索或社区发现。

## Decisions

### Decision 1: Graph DB 是端口，不是本轮外部依赖

新增 `GraphMemoryStore` 方法到 repository：

- `upsertGraphMemoryNode`
- `deleteGraphMemoryNode`
- `searchGraphText`
- `searchGraphVector`
- `getGraphRelationEdges`

本地 repository 用已有 text/vector index 和 relation_edges 提供实现。

理由：用户要求“走图数据库”，但当前环境没有外部图数据库配置。端口化能让检索算法真正改为调用图数据库能力，同时避免新增不可运行依赖。

### Decision 2: 索引刷新是 graph node 同步入口

`refreshShortTermMemoryIndex` 和 `refreshLongTermMemoryIndex` 在保存普通 index bundle 后调用 `upsertGraphMemoryNode`。graph node 保存向量、文本和基础元数据。

理由：现有所有可召回 STM/LTM 都经过刷新索引路径，复用该入口能保证图内 FTS/vector 数据与召回资格一致。

### Decision 3: searchContext 只通过 graph store 排名图谱内节点

`rankByTextIndex` 改为 `rankByGraphText`，`rankByVectorIndex` 改为 `rankByGraphVector`。source scope 场景也用 graph hit 过滤 owner keys。

理由：检索算法不应知道底层 text/vector index 表；它只应请求 graph store 对图谱节点做 FTS 和向量检索。

## Risks / Trade-offs

- [Risk] 本地 graph store 仍复用现有 index 表，和真实外部图数据库能力不同。→ 通过接口隔离，后续替换 adapter。
- [Risk] 图节点同步遗漏会导致检索缺失。→ 保持旧 index bundle 写入，同时新增 targeted 测试覆盖 graph FTS/vector 命中。
- [Risk] source-scoped 检索仍需要 snapshot 过滤。→ 首期保留 source scope 构造逻辑，只把图内文本/向量排名交给 graph store。
