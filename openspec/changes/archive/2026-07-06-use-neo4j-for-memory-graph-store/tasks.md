## 1. 契约与配置

- [x] 1.1 添加 Neo4j graph store 配置、默认 local 模式和无效配置失败路径。
- [x] 1.2 添加 Neo4j graph store driver/Cypher contract 测试，覆盖索引初始化、节点 upsert、关系 upsert、FTS、vector 和邻域查询。

## 2. Graph Store 抽象

- [x] 2.1 抽出 `GraphMemoryStore` 接口，并让本地 repository graph 方法委托到本地 graph store。
- [x] 2.2 新增 `Neo4jGraphMemoryStore`，封装连接生命周期、约束/索引初始化和 Cypher 执行。

## 3. Neo4j 图节点与关系同步

- [x] 3.1 将 STM/LTM graph node upsert/delete 同步到 Neo4j `MemoryNode`。
- [x] 3.2 将 `saveRelationEdge`、级联删除和清表同步到 Neo4j 关系边。

## 4. Neo4j 检索迁移

- [x] 4.1 将 graph FTS 查询实现为 Neo4j full-text index 查询，并在 Cypher 中执行 layer/source scope 过滤。
- [x] 4.2 将 graph vector 查询实现为 Neo4j vector index 查询，并在 Cypher 中执行 layer/source scope 过滤。
- [x] 4.3 将 graph relation neighbor 查询实现为 Neo4j 图邻域查询。

## 5. 验证

- [x] 5.1 运行 OpenSpec 校验和后端 typecheck。
- [x] 5.2 按用户要求不运行可能卡死的完整后端测试；如需 Neo4j 集成测试，必须显式配置外部服务后单独运行。
