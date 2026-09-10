## 1. 方案落位与边界确认

- [x] 1.1 对照 PRD 和方案，确认 Context 引擎与调试前端的能力边界、术语和主流程。
- [x] 1.2 盘点仓库现有后端、前端、数据库、任务队列、日志、鉴权和测试约定，标记可复用模块。
- [x] 1.3 确认 feature flag、配置名和调试前端路由的落地位置。
- [x] 1.4 明确首期 MVP 仅支持的模态、存储抽象、检索路径和 mock/fixture 策略。

## 2. 数据模型与持久化

- [x] 2.1 为 `MemoryEvent`、`MultimodalDataItem`、`SourceRef`、`PermissionSnapshot` 建立迁移和 repository。
- [x] 2.2 为 `FactItem`、事实版本、冲突引用、关联事件、关联片段和来源引用建立迁移和 repository。
- [x] 2.3 为 `ShortTermMemory`、生命周期元数据、准入结果、命中规则和向量引用建立迁移和 repository。
- [x] 2.4 为 `LongTermMemory`、版本信息、召回权重、有效期和维护时间建立迁移和 repository。
- [x] 2.5 为 `RelationEdge`、别名、重复、支持和冲突关系建立迁移和 repository。
- [x] 2.6 为任务、checkpoint、审计 trace、`ContextPack` trace 和 `MemoryChangeEvent` 建立迁移和 repository。
- [x] 2.7 为来源引用、实体、时间范围、生命周期状态、tenant/principal、记忆 ID、事实 ID 和检索字段建立索引。

## 3. 写入 API 与摄入管线

- [x] 3.1 实现 `write_event` 的校验、幂等、权限快照捕获、原始事件保存和摄入任务创建。
- [x] 3.2 实现解析适配器接口，以及文本/文档/工具结果解析路径，写入数据湖解析片段。
- [x] 3.3 实现不支持模态的 pending/unsupported 持久化和来源审计元数据。
- [x] 3.3a 实现固定目录文件摄入 MVP，默认扫描 `data/inbox`，文本文件进入文本解析路径，图片和 Office 文件进入 unsupported 路径。
- [x] 3.3b 实现 `.docx` 文档正文提取解析，避免无正文文档把文件路径误写为事实。
- [x] 3.4 实现时间融合与事实创建，输出带来源引用和 schema 校验的 `FactItem`。
- [x] 3.5 实现 `write_agent_memory` 快速写入流程，确保先落事实再进入 STM。
- [x] 3.6 实现摄入、解析、融合和索引任务的错误处理与重试状态。

## 4. 准入、做梦与生命周期

- [x] 4.1 实现 STM 准入策略输入：重要性、置信度、新鲜度、敏感性、用户/Agent 权重、冲突和权限状态。
- [x] 4.2 实现 STM 创建、拒绝、pending-confirm、生命周期元数据、命中规则解释和记忆变化事件。
- [x] 4.3 实现 active STM 的索引刷新，并复用既有搜索/索引基础设施。
- [x] 4.4 实现 Dreaming 候选选择：过期 STM、高价值候选、重复召回、用户反馈和冲突关系。
- [x] 4.5 实现 Dreaming 的 LTM 巩固，包含幂等 hash、checkpoint、来源引用、版本信息和关系边。
- [x] 4.6 实现 LTM 的强化、修订、降权、归档、删除和记忆变化事件。
- [x] 4.7 实现显式生命周期状态机，并把 recall eligibility 绑定到状态。

## 5. 检索与 Context Pack

- [x] 5.1 实现 `search_context` 的请求/响应契约、过滤器、分页、分数原因和权限状态。
- [x] 5.2 实现 tenant、principal、权限快照、实时权限、生命周期、敏感性和时间范围的硬过滤。
- [x] 5.3 实现 STM、LTM、事实、关键词、向量、实体、图谱邻域、时间、重要性和反馈的混合检索。
- [x] 5.4 实现 semantic、keyword、graph、recency、importance、source reliability、feedback、diversity、conflict、permission risk 和 staleness 的组件打分 trace。
- [x] 5.5 实现关系化去重和冲突元数据传播。
- [x] 5.6 实现 `assemble_context`，输出 profile/task/recent/constraints/citations/conflicts/token_budget/dropped reasons。
- [x] 5.7 实现压缩和 token 预算分配，保证硬约束、冲突和引用优先保留。
- [x] 5.8 实现 `read_context`、`search_data_lake` 和 pack trace 检索端点。
- [x] 5.9 实现固定背景文本读取/写入、动态背景载入和更新建议的 pending review 流程。

## 6. 反馈、权限失效与删除

- [x] 6.1 实现 `feedback_memory` 的 like、dislike、correct、confirm、ignore 和 delete 动作。
- [x] 6.2 实现纠错和修订任务，避免静默覆盖用户确认记录。
- [x] 6.3 实现来源权限失效，使相关事实、STM、LTM 和 pack 项停止被召回。
- [x] 6.4 实现删除流程：立即停止召回，并异步清理索引、缓存和派生产物。
- [x] 6.5 实现 `get_memory_change_events` 的过滤、分页和权限安全脱敏。
- [x] 6.6 实现敏感信息分类策略在 admission、indexing、retrieval、redaction 和 pending-confirm 中的落地。
- [x] 6.7 实现 LLM 产物校验与审计元数据记录。

## 7. 调试前端

- [x] 7.1 盘点现有前端框架、路由、状态管理、API 客户端、测试和样式规范，确定新增页面方式。
- [x] 7.2 在内部 feature flag 或权限门禁后增加调试前端路由。
- [x] 7.3 构建摄入 trace 视图，显示原始事件、权限快照、解析状态、片段、事实、记忆、任务、错误和记忆变化事件。
- [x] 7.3a 升级调试前端为记忆测试台，支持 PRD/方案事件写入、时间轴融合、STM/LTM 管理、检索和更新调试。
- [x] 7.4 构建证据/事实/STM/LTM 浏览器，支持搜索、过滤、关系导航、引用、生命周期和脱敏状态。
- [x] 7.5 构建检索 playground，展示候选排名、route score、最终分数、匹配词、图谱/实体匹配、惩罚项、权限过滤和 dropped 原因。
- [x] 7.6 构建 Context Pack inspector，显示 pack 区块、引用、冲突、token 分配、压缩步骤、选中项、丢弃项和最终 Agent payload。
- [x] 7.7 构建背景上下文 inspector，显示固定文本、动态更新、召回证据、冲突、引用、更新建议和 degraded-mode 原因。
- [x] 7.8 构建记忆反馈和生命周期审阅动作，并对删除/隐藏类操作要求显式确认。
- [x] 7.9 构建指标与评测面板，展示延迟、吞吐、token、权限拒绝、worker 失败和检索/组装指标。
- [x] 7.10 增加本地 mock/fixture 模式，覆盖事件 trace、检索结果、Context Pack、权限失败、冲突和记忆变化事件。
- [x] 7.11 增加桌面调试检查，覆盖时间线、表格、过滤器、inspectors、分数拆解和序列化 payload 面板。

## 8. 测试、评测与文档

- [x] 8.1 为事件校验、幂等、权限快照捕获、解析输出、事实创建和 STM 准入添加单元测试。
- [x] 8.2 为 Dreaming 候选选择、幂等、checkpoint 恢复、LTM 创建、修订、降权和记忆变化事件添加单元测试。
- [x] 8.3 为检索硬过滤、混合打分、关系去重、冲突传播和权限过滤添加单元测试。
- [x] 8.4 为 Context Pack token 预算、引用保留、压缩、dropped reasons 和 degraded-mode 行为添加单元测试。
- [x] 8.5 为 `write_event`、`write_agent_memory`、`search_context`、`read_context`、`assemble_context`、`feedback_memory`、`search_data_lake` 和 `get_memory_change_events` 添加 API 集成测试。
- [x] 8.6 为调试前端的 trace、playground、pack inspector、background inspector、脱敏状态、破坏性确认和 mock 模式添加前端测试。
- [x] 8.7 增加评测 fixture 和任务，覆盖 Recall@K、Precision@K、MRR@K、NDCG@K、延迟、token 使用、来源完整性，以及 LoCoMo/LongMemEval 类长期记忆数据集。
- [x] 8.8 补齐本地启动、mock 数据、调试流程、评测回放和常见故障排查文档。
- [x] 8.9 在完成前运行 lint、typecheck、后端测试、前端测试和迁移检查。
- [x] 8.10 为批次摄入增加总体进度百分比与逐事件节点轨迹展示，并补齐对应测试。
