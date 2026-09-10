## ADDED Requirements

### Requirement: 使用图关系维护 STM 与 LTM 关联

系统 SHALL 在 STM 写入和 LTM 巩固后维护记忆图关系边，覆盖 STM-STM、STM-LTM 和 LTM-LTM 关系，并保留原始记忆记录而不物理合并。

#### Scenario: STM 写入后建立 STM-STM 关系
- **WHEN** 新 STM 与已有 STM 共享来源、事实、实体、规范化内容或冲突信号
- **THEN** 系统创建 `same_source`、`derived_from`、`is_same_as`、`supports`、`conflicts_with`、`updates` 或 `related_to` 关系边，并保留双方 STM 记录

#### Scenario: STM 写入后建立 STM-LTM 关系
- **WHEN** 新 STM 与已有 LTM 共享来源、实体、规范化内容或表示对旧长期记忆的更新或冲突
- **THEN** 系统创建对应关系边，使后续召回可看到 STM 与 LTM 的图邻域关系

#### Scenario: LTM 巩固后建立 LTM-LTM 关系
- **WHEN** 做梦过程创建或修订 LTM
- **THEN** 系统创建 LTM 到来源 STM 的 `derived_from` 边，并与已有 LTM 建立重复、支持、冲突、更新或关联关系边

### Requirement: 记忆图关系必须幂等

系统 SHALL 使用稳定关系边 ID 维护记忆图，重复摄入、重放或做梦恢复不得为同一端点和关系类型创建重复边。

#### Scenario: 重复维护同一记忆关系
- **WHEN** 系统多次对同一 STM 或 LTM 执行图关系维护
- **THEN** 关系边数量保持稳定，同一端点和关系类型最多保留一条边

### Requirement: 召回和 Context Pack 必须消费记忆图关系

系统 SHALL 在 `search_context` 结果中返回候选记忆的图关系边，并在 `assemble_context` 中把 `conflicts_with` 关系汇总到 `conflicts`。

#### Scenario: 召回结果包含图关系邻域
- **WHEN** 调用方检索命中带有关联边的 STM 或 LTM
- **THEN** 每个候选结果包含与该记忆相连的关系边，供调试前端和 R2 组装使用

#### Scenario: 冲突关系进入 Context Pack
- **WHEN** R2 组装的候选包含 `conflicts_with` 关系边
- **THEN** Context Pack 的 `conflicts` 字段包含该冲突边、端点和证据信息
