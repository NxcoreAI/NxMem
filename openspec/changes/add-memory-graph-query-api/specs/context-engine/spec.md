## ADDED Requirements

### Requirement: 提供可分页的记忆图查询接口

系统 SHALL 提供只读 `POST /context/memory-graph/query`，以 JSON 分页返回当前 graph store 中的 STM/LTM 图节点和记忆关系边，不得要求调用方读取 debug snapshot 或组合多个内部接口。

#### Scenario: 默认查询完整记忆图
- **WHEN** 外部程序不提供 layer 和 relation type 过滤并请求第 1 页或从空 cursor 开始请求
- **THEN** 系统查询 STM、LTM 和所有支持的关系类型，并返回 `schemaVersion = memory-graph.v1` 的节点页与关系页

#### Scenario: graph store 为空
- **WHEN** 当前 graph store 没有节点和关系
- **THEN** 系统返回 HTTP 200、空的 `nodes.items` 与 `edges.items`，并且两个页面的 `hasMore` 均为 false

### Requirement: 记忆图 JSON 必须使用规范化节点和边

系统 SHALL 在 `nodes.items` 中以 STM/LTM 稳定 ID 表示记忆内容，并在 `edges.items` 中通过 `from`、`to` 引用节点 ID，关系不得重复嵌套到每个节点中。

#### Scenario: 返回 STM 和 LTM 节点
- **WHEN** graph store 同时包含 STM 和 LTM 节点
- **THEN** 每个节点包含 `id`、`layer`、`content`、生命周期、检索权重、来源引用、实体和刷新时间，并在存在时包含 memory type 和 fact summary

#### Scenario: 返回关系边
- **WHEN** graph store 包含 STM-STM、STM-LTM 或 LTM-LTM 关系
- **THEN** 每条边包含 `id`、`from`、`to`、`type`，并在存在时包含 evidence、strength、confidence、source 和 createdAt

### Requirement: 节点和边必须共享页码并独立限量

系统 SHALL 使用一个顶层 page 同时控制节点和关系边页码，并分别提供 node limit、edge limit、opaque cursor、nextCursor 和 hasMore；调用方 SHALL 能用统一页码直接跳页，也能在 cursor 模式下一侧完成后停止该侧查询并独立推进另一侧。

#### Scenario: 使用统一页码和独立 limit
- **WHEN** 调用方请求顶层 `page=2`、`nodePage.limit=50` 和 `edgePage.limit=100`
- **THEN** 系统返回节点与关系各自排序结果的第 2 页，在响应顶层回显 `page=2`，且两侧分别最多返回 50 和 100 条

#### Scenario: 节点多于单页限制
- **WHEN** 满足条件的节点数量大于 node limit
- **THEN** 系统最多返回 limit 个节点，并返回 node `hasMore=true` 和可用于下一页的 `nextCursor`

#### Scenario: 关系多于单页限制
- **WHEN** 满足条件的关系数量大于 edge limit
- **THEN** 系统最多返回 limit 条关系，并返回 edge `hasMore=true` 和可用于下一页的 `nextCursor`

#### Scenario: 遍历全部页面
- **WHEN** 调用方分别使用 node 和 edge nextCursor 请求，直到两个 `hasMore` 都为 false
- **THEN** 合并后的稳定 ID 集合覆盖查询条件下 graph store 中的全部节点和关系

#### Scenario: 只推进未完成的页面
- **WHEN** edge page 已完成而 node page 仍有下一页，调用方提交 node cursor 并设置 `edgePage=null`
- **THEN** 系统只查询并返回 node page，响应中的 `edges` 为 null

### Requirement: 分页游标必须绑定查询条件

系统 SHALL 在 cursor 中绑定 cursor 类型、版本、最后排序键和相关过滤摘要；node cursor 绑定 layers，edge cursor 绑定 layers 和 relationTypes，且不能将 node cursor 用于 edge page。

#### Scenario: cursor 类型错误
- **WHEN** 调用方把 node cursor 作为 edge cursor 或反向使用
- **THEN** 系统返回 HTTP 400 和 `INVALID_MEMORY_GRAPH_CURSOR`

#### Scenario: cursor 过滤条件不匹配
- **WHEN** 调用方修改 node cursor 绑定的 layers，或修改 edge cursor 绑定的 layers/relationTypes
- **THEN** 系统返回 HTTP 400 和 `INVALID_MEMORY_GRAPH_CURSOR`，不得静默重新开始分页

#### Scenario: page 与 cursor 混用
- **WHEN** 调用方同时提供顶层 page 和任一非空 node/edge cursor
- **THEN** 系统返回 HTTP 400 和 `INVALID_MEMORY_GRAPH_QUERY`

### Requirement: 记忆图查询必须支持 layer 和关系类型过滤

系统 SHALL 支持选择 `stm`、`ltm` 或两个 layer，并支持选择一个或多个合法 relation type；未提供过滤时 SHALL 默认覆盖所有 layer 和关系类型。

#### Scenario: 只查询 STM 图
- **WHEN** 请求 `layers=[stm]`
- **THEN** 节点页只包含 STM，关系页只包含两个端点都是 STM 的关系

#### Scenario: 按关系类型查询
- **WHEN** 请求指定 `relationTypes=[conflicts_with,updates]`
- **THEN** 关系页只包含这两种关系，节点页仍由 layer 条件决定

### Requirement: 全量图响应必须具有确定性顺序

系统 SHALL 按 `layer + id` 对节点升序排序，并按 `id` 对关系边升序排序，使 page offset 和 cursor 都基于确定性顺序推进。

#### Scenario: graph store 返回无序结果
- **WHEN** adapter 以任意顺序读取节点和关系边
- **THEN** 每个页面仍按规定顺序输出，且相邻页面不因排序不稳定产生重复项

### Requirement: 外部图接口不得暴露内部或高体积字段

系统 SHALL 返回图节点的记忆内容和关系数据，但 SHALL NOT 返回 vector/embedding、内部 graph node ID、Prompt、LLM Trace、准入 Trace 或 debug snapshot 的其他字段。

#### Scenario: 返回图节点
- **WHEN** graph node 包含 embedding 和内部 graph node ID
- **THEN** HTTP 节点包含稳定 memory ID 和业务字段，但不包含 embedding、vector 或内部 graph node ID

#### Scenario: 转换 Neo4j source refs
- **WHEN** Neo4j 节点以 `sourceRefsJson` 字符串保存来源引用
- **THEN** HTTP 节点以 JSON 数组返回合法 source refs，不暴露内部序列化字段

### Requirement: 接口必须通过当前 graph store 查询

系统 SHALL 通过 `GraphMemoryStore` 分页端口获取节点和边，不得使用包含其他内部数据的 `getDebugSnapshot()` 组装外部响应，并在 local 与 Neo4j 模式下保持相同语义。

#### Scenario: local 模式查询
- **WHEN** `CONTEXT_ENGINE_GRAPH_STORE=local` 且调用记忆图接口
- **THEN** 系统从本地 graph node 和 relation edge 存储按 page 或 cursor 返回 `memory-graph.v1`

#### Scenario: Neo4j 模式查询
- **WHEN** `CONTEXT_ENGINE_GRAPH_STORE=neo4j` 且调用记忆图接口
- **THEN** 系统通过带 layer、relation type、page offset/cursor 和 limit 条件的 Cypher 返回与 local 模式相同的 JSON 字段和分页语义

### Requirement: 记忆图查询必须保持只读并返回稳定错误

系统 SHALL NOT 因查询创建、更新、删除、巩固或重新索引任何记忆或关系；请求或 graph store 失败时 SHALL 返回稳定错误且不得返回部分图数据。

#### Scenario: 重复查询记忆图
- **WHEN** 调用方连续查询相同 graph store 状态
- **THEN** 节点、关系和存储状态保持不变

#### Scenario: 请求参数无效
- **WHEN** layer、relation type 或 limit 不符合协议
- **THEN** 系统返回 HTTP 400、`INVALID_MEMORY_GRAPH_QUERY` 和 request ID

#### Scenario: graph store 查询失败
- **WHEN** local 或 Neo4j adapter 无法读取节点页或关系页
- **THEN** 系统返回 HTTP 500、`MEMORY_GRAPH_QUERY_FAILED` 和 request ID，且不泄露内部连接信息
