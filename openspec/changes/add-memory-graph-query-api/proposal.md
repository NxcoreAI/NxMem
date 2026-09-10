## Why

Context Engine 目前分别提供 `/context/search` 和 `/context/relations/search`，前者面向相关性召回，后者面向关系筛选。外部程序无法通过一个稳定接口分页获取当前 graph store 中的全部 STM、LTM 节点和全部关系，也不应依赖包含内部 Trace 和调试状态的 `/context/debug/snapshot`。

当前阶段 Context Engine 按单用户部署，不需要在本变更中引入 LTM owner、跨用户权限隔离或关系生成范围修复。但即使是单用户，记忆图仍会持续增长，因此接口必须分页，避免一次返回整张图导致数据库、内存和网络压力失控。

## What Changes

- 新增只读 `POST /context/memory-graph/query`，以规范化 `nodes + edges` JSON 返回 STM/LTM 图节点和关系边。
- 节点和边支持共享顶层页码或独立 opaque cursor 分页，默认页码为 1、默认页大小分别为 100 和 500，并设置服务端最大值。
- 默认覆盖 STM、LTM 和所有关系类型；支持按 layer 和 relation type 缩小结果范围。
- 响应使用版本化的 `memory-graph.v1` 契约，节点和边通过稳定 ID 关联，不在节点中重复嵌套关系。
- 扩展 `GraphMemoryStore`，增加分页列出图节点和关系边的端口，并实现 local 与 Neo4j adapter。
- 默认不返回 embedding、Prompt、LLM Trace、准入 Trace 或其他调试数据。
- 增加空图、页码跳转、完整翻页、过滤、cursor 校验、稳定排序、local/Neo4j 一致性和错误响应测试，并补充外部调用文档。

## Capabilities

### Modified Capabilities

- `context-engine`: 增加单用户模式下可分页读取完整记忆图的 HTTP 查询能力。

## Impact

- HTTP：新增 `POST /context/memory-graph/query`。
- Graph store：新增 node/edge page/cursor 分页读取方法。
- 服务层：新增请求校验、page/cursor、图数据映射和 `memory-graph.v1` 响应组装。
- 无数据库 schema 迁移，不增加 LTM owner 字段，不修改关系生成逻辑。
- 现有搜索、召回、关系查询和 Context Pack API 保持不变；本变更不增加独立 Fact 图节点。
