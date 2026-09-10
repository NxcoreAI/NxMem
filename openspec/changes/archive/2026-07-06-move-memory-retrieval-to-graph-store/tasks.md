## 1. 契约与测试

- [x] 1.1 添加 graph store FTS、向量检索和关系邻域的失败测试。
- [x] 1.2 添加索引刷新同步 graph node 的失败测试。

## 2. Graph Store 端口

- [x] 2.1 新增 graph memory node 与 graph search hit 类型。
- [x] 2.2 在 repository 接口和本地实现中增加 graph node upsert、delete、FTS、vector、relation neighbor 方法。

## 3. 索引与检索迁移

- [x] 3.1 在 STM/LTM 索引刷新时同步 graph node。
- [x] 3.2 将 `search_context` 的 FTS、向量和 relation edge 查询迁移到 graph store 方法。

## 4. 验证

- [x] 4.1 添加 targeted graph/search/index 测试覆盖；按用户要求未运行 node:test，避免卡死。
- [x] 4.2 运行 OpenSpec 校验和后端 typecheck；按用户要求跳过完整后端测试。
