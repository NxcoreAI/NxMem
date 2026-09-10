## Why

当前 memory 关系边已经有图语义，但 FTS 和向量检索仍直接依赖 repository 的普通索引数组/表，导致图谱内数据、文本索引和向量索引分裂。需要把检索路径迁移到图数据库能力入口，使图节点、关系、FTS 和向量检索成为同一个 graph store 的职责。

## What Changes

- 新增 `GraphMemoryStore` 端口，承载记忆图节点、关系边、图内 FTS、图内向量检索和图邻域查询。
- STM/LTM 刷新索引时同步 upsert 图节点，并由 graph store 维护节点文本、向量和状态。
- `search_context` 中涉及图谱内数据 FTS 和向量检索的排序入口改为调用 graph store，不再直接扫描 repository text/vector index。
- `relationEdgesFor` 改为通过 graph store 查询图邻域，保持 Context Pack 冲突汇总沿用图关系。
- 首期不新增外部图数据库依赖；使用 repository 内置本地图存储适配器模拟图数据库能力，后续可替换为 Neo4j 或 PG 图扩展。

## Capabilities

### New Capabilities

### Modified Capabilities

- `context-engine`: 检索路径改为使用图数据库提供的图节点 FTS、向量检索和邻域关系能力。

## Impact

- 后端领域模型：新增图节点/图检索 hit 类型。
- 后端持久化：repository 增加 graph store 方法，本地实现复用现有索引存储并提供图数据库语义入口。
- 后端索引：`refreshShortTermMemoryIndex`、`refreshLongTermMemoryIndex` 同步 graph node。
- 后端检索：`search_context` 的 FTS、vector、relation edges 查询改用 graph store。
- 测试：新增图存储检索测试，验证 searchContext 通过图 FTS/vector 命中，且关系邻域来自 graph store。
