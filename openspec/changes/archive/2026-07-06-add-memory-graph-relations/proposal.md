## Why

PRD 明确要求 STM、LTM 之间通过关系边表达来源、重复、支持、冲突、更新和关联，而当前实现只有 `relation_edges` 存储与 LTM derived_from STM 的单一路径。需要补齐记忆图关系机制，使 STM-STM、STM-LTM、LTM-LTM 的关系能够在写入、做梦、检索和 Context Pack 组装中被实际使用。

## What Changes

- 新增 memory graph relation 服务，在记忆写入和做梦巩固后自动维护 STM/LTM 关系边。
- 扩展 `RelationEdge` 类型，覆盖 PRD 中的 `updates`、`related_to`、`part_of`、`same_source` 等关系。
- 在 STM 准入后基于来源、事实、实体、内容规范化和冲突信号建立 STM-STM、STM-LTM 关系。
- 在 LTM 巩固后建立 LTM derived_from STM、LTM-LTM 重复/支持/冲突/更新关系，并保留来源链路。
- 让检索结果和 Context Pack 使用图关系：关系边随候选返回，冲突进入 `conflicts`，重复/派生关系可用于去重解释。
- 不引入新的外部数据库依赖；以 `MemoryGraphStore` 端口封装图操作，首期使用现有 `relation_edges` 表作为图边存储，后续可替换为 Neo4j 或 PG 图查询实现。

## Capabilities

### New Capabilities

### Modified Capabilities

- `context-engine`: 增加 STM/LTM 关系图谱维护、图边类型、图关系查询、检索与 Context Pack 消费关系边的行为要求。

## Impact

- 后端领域模型：`RelationEdge` 类型与关系边生成逻辑。
- 后端持久化：现有 `relation_edges` 表继续承载图边，repository 增加图邻域查询端口。
- 后端流程：`parseAndAdmitEvent`、`runLlmDreaming` 在写入 STM/LTM 后调用图关系维护。
- 检索与组装：`search_context`、`assemble_context` 继续返回和消费关系边，并覆盖更多关系来源。
- 测试：新增 STM-STM、STM-LTM、LTM-LTM 图关系单元/集成测试，以及冲突进入 Context Pack 的回归测试。
