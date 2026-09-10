## 1. 分页查询契约

- [x] 1.1 定义 `memory-graph.v1` 请求、节点、关系、节点页、关系页和错误响应类型。
- [x] 1.2 实现 layers、relationTypes、node/edge page、page null 停止语义和 limit 的严格校验与默认值。
- [x] 1.3 实现带类型、版本、最后排序键和相关过滤摘要的 opaque node/edge cursor 编解码。

## 2. Graph store 分页能力

- [x] 2.1 在 `GraphMemoryStore` 和 repository 端口中增加 node page 与 edge page 查询方法。
- [x] 2.2 实现内存/local graph store 的 layer、relation type、cursor、稳定排序和 `limit + 1` 查询。
- [x] 2.3 实现 SQLite `graph_memory_nodes` 与 `relation_edges` 的 cursor pagination。
- [x] 2.4 实现 Neo4j 带 layer、relation type、cursor 和 limit 条件的 node/relationship Cypher 查询。
- [x] 2.5 添加内存、SQLite 和 Neo4j contract tests，确保字段、过滤、排序和分页语义一致。

## 3. Application service 与 HTTP 路由

- [x] 3.1 实现 `queryMemoryGraph`，并行查询节点页和关系页，完成规范化映射和分页元数据组装。
- [x] 3.2 实现只读 `POST /context/memory-graph/query` 路由和严格请求解析。
- [x] 3.3 从响应中排除 embedding、内部 graph node ID、Prompt 和调试 Trace。
- [x] 3.4 实现 `INVALID_MEMORY_GRAPH_QUERY`、`INVALID_MEMORY_GRAPH_CURSOR`、`MEMORY_GRAPH_QUERY_FAILED` 和 request ID。

## 4. 测试与文档

- [x] 4.1 添加路由测试，覆盖空图、STM/LTM、全部关系、默认值和可选字段。
- [x] 4.2 添加节点/边独立翻页、单侧停止、页大小上限、完整遍历和稳定排序测试。
- [x] 4.3 添加 layer/relation type 过滤和 cursor 类型/过滤摘要不匹配测试。
- [x] 4.4 添加重复查询只读、graph store 失败时不返回部分数据的测试。
- [x] 4.5 更新 README，提供请求/响应与统一 page/独立 cursor 翻页示例，并说明单用户、最终一致和非备份语义。
- [ ] 4.6 运行后端定向测试、类型检查、`openspec status --change add-memory-graph-query-api` 和 `openspec validate add-memory-graph-query-api`。

## 5. 页码查询

- [x] 5.1 扩展 HTTP 契约，使用顶层统一 page、独立 node/edge limit、默认第 1 页、正整数校验和 page/cursor 互斥。
- [x] 5.2 在内存、SQLite 和 Neo4j graph store 中实现稳定排序后的 offset 分页。
- [x] 5.3 增加契约、service、route 和跨 store 测试，并更新 README 与 OpenSpec 调用说明。
