## Context

PRD 要求 STM、LTM 之间通过关系边表达来源、重复、支持、冲突、更新和关联，并在召回、Context Pack 和做梦维护中使用这些关系。当前代码已有 `RelationEdge` 类型、`relation_edges` 表、repository 持久化、检索返回关系边和 Context Pack 冲突汇总，但实际自动建边只覆盖 LTM derived_from STM。

项目当前没有 Neo4j 等外部图数据库依赖，且工作协议要求不新增依赖。首期应把现有 `relation_edges` 表作为图数据库边存储，通过明确的图存储端口封装图操作，避免业务流程直接依赖表实现。

## Goals / Non-Goals

**Goals:**

- 补齐 STM-STM、STM-LTM、LTM-LTM 的自动关系边生成。
- 用图关系表达 PRD 中的来源同一、重复、支持、冲突、更新和关联，不物理合并原始记忆。
- 让 STM 写入后立即建立与已有 STM/LTM 的关系，让 LTM 巩固后建立来源边和 LTM 邻域关系。
- 保持关系边幂等，重复处理同一记忆不会生成重复边。
- 保持现有检索和 Context Pack 能消费关系边，尤其是 `conflicts_with` 进入 `conflicts`。

**Non-Goals:**

- 不引入 Neo4j、PG 图扩展或新运行时服务。
- 不实现复杂 LLM 图谱推理；首期使用确定性规则建边。
- 不物理合并重复 STM/LTM，也不自动删除旧记忆。
- 不改变现有权限模型，关系边只在关联记忆可被召回时随候选暴露。

## Decisions

### Decision 1: 用 `MemoryGraphStore` 端口封装图边操作

新增内聚的图关系模块，业务流程调用 `reconcileMemoryGraphForShortTermMemory` 和 `reconcileMemoryGraphForLongTermMemory`。模块通过 repository 的 `getDebugSnapshot`、`saveRelationEdge` 读写图边，首期不扩展数据库依赖。

理由：PRD 说“走图数据库”，而当前仓库只有关系边表。把关系边表作为图边存储端口的首个实现，可以在不新增依赖的前提下提供图语义，并为后续 Neo4j/PG 图查询替换保留边界。

拒绝方案：直接在 `parse-event.ts` 和 `llm-dreaming.ts` 内散落建边逻辑。这样会让图规则难测试，也难替换外部图数据库。

### Decision 2: 首期使用确定性关系规则

建边规则：

- `derived_from`: LTM 来源于 STM；或记忆共享具体 `sourceFactIds` / `sourceMemoryDataIds`。
- `same_source`: 记忆共享 `sourceRef.sourceRefId`。
- `is_same_as`: 规范化内容完全一致。
- `supports`: 共享实体、来源或事实，且内容不冲突。
- `conflicts_with`: 两条记忆的冲突信号为 known，或同实体/来源下出现明显文本冲突标记。
- `updates`: 新记忆与旧记忆共享实体/来源且时间更新，并出现“更新/修订/加入/变更/changed/updated”等更新信号。
- `related_to`: 共享实体但不满足更强关系。

理由：这些规则能覆盖 PRD 的首期可验收行为，且可解释、可测试。更复杂的语义关系可后续由 LLM 或图算法补充。

### Decision 3: 图边幂等且规范化排序

除 `derived_from` 保留方向外，重复、支持、冲突、关联类边使用稳定端点排序生成 `edgeId`。同一关系重复生成时覆盖同一边。

理由：摄入、重放、做梦恢复都可能重复执行。幂等边避免图污染，也能让测试稳定。

### Decision 4: 扩展关系类型但不破坏旧数据

`RelationEdge.relationType` 增加 `same_source`、`updates`、`related_to`、`part_of`。现有存储以 TEXT 保存关系类型，无需迁移旧记录。`part_of` 先作为类型保留，不在首期规则中主动生成。

理由：PRD 已明确这些关系语义；类型扩展是向后兼容的。

## Risks / Trade-offs

- [Risk] 确定性规则可能产生过宽的 `supports` 或 `related_to`。→ 将强关系优先级排序，只有不满足更强关系时才生成弱关系。
- [Risk] 缺少实体抽取时关系发现不足。→ 首期同时使用 source refs、source facts、内容规范化和 sourceMemoryDataIds，后续随实体抽取增强自动提升。
- [Risk] `conflicts_with` 规则过于保守。→ 保留 admission conflict known 和显式冲突词作为首期触发，避免误报冲突。
- [Risk] 当前表结构没有节点表。→ 首期只需要边关系；节点来自 STM/LTM 主表，图邻域通过边端点回查。

## Migration Plan

1. 扩展领域类型和测试 fixture。
2. 新增 memory graph relation 模块与单元测试。
3. 在 STM 准入后调用 STM 图关系维护。
4. 在 LTM 做梦巩固后调用 LTM 图关系维护，替代单一 derived_from 循环。
5. 验证检索结果携带关系边，Context Pack 汇总冲突关系。

回滚策略：图关系维护是附加写入。若出现误建边，可关闭调用点或清空 `relation_edges` 后重放记忆数据；STM/LTM 主数据不受影响。
