## Why

现有 PRD 和实现构想已经明确“记忆 Context 引擎”是 Agent 理解用户、跨会话延续任务和安全使用多源数据的基础设施，但还缺少可执行的工程契约。该变更把 PRD 中的存储、做梦、召回、背景信息和白盒调试要求转化为可实现、可测试、可验收的 OpenSpec 规格。

## What Changes

- 新增 Context 引擎能力，支持 `MemoryEvent` 摄入、权限快照、数据湖归档、时间融合、事实存储、STM 准入、LTM 做梦巩固、关系边、冲突处理和记忆变化事件。
- 新增 Agent 面向接口：`get_context_files`、`search_context`、`read_context`、`assemble_context`、`write_event`、`write_agent_memory`、`feedback_memory`、`search_data_lake`、`get_memory_change_events`。
- 新增 R1/R2 分层召回契约：R1 负责硬过滤和混合检索，R2 负责去重、排序、压缩、冲突摘要、权限裁剪、引用保留和 Context Pack 输出。
- 新增背景信息双模式注入：固定背景信息文本由用户或确认规则维护，新会话由 Background Sub Agent 动态召回 STM/LTM 并生成本轮背景信息文本。
- 新增敏感信息、权限失效、生命周期状态机、LLM 结构化输出校验、幂等写入、异步任务和审计追踪要求。
- 新增调试前端能力，用于查看摄入链路、事实与记忆浏览、检索打分、Context Pack 组装、背景信息动态载入、权限/敏感信息裁剪和记忆变化事件。
- 新增前端本地调试工作流，要求在后端不可用时用 mock/fixture 覆盖事件追踪、检索候选、Context Pack、权限失败、冲突、生命周期和响应式布局状态。
- 新增评测和可观测要求，覆盖 Recall@K、Precision@K、MRR@K、NDCG@K、LoCoMo/LongMemEval 类长期记忆数据集、延迟、token 预算、来源完整性和 worker 可靠性。

## Capabilities

### New Capabilities

- `context-engine`: 覆盖摄入、数据湖、事实存储、STM/LTM、做梦、混合检索、Context Pack 组装、背景信息动态载入、反馈、权限失效、敏感信息策略、评测和可观测。
- `context-debug-frontend`: 覆盖内部调试前端，用于可视化事件到 Context Pack 的全链路、检索/组装解释、权限与敏感信息诊断、记忆生命周期审阅和本地 mock 调试。

### Modified Capabilities

- 无。

## Impact

- 新增后端领域模块：摄入服务、解析适配器、数据湖元数据、事实存储、STM/LTM 存储、关系边、做梦 worker、检索服务、Context Assembler、权限校验、敏感信息分类、审计/事件服务和评测任务。
- 新增存储对象或表：`MemoryEvent`、`MultimodalDataItem`、`SourceRef`、`PermissionSnapshot`、`FactItem`、`ShortTermMemory`、`LongTermMemory`、`RelationEdge`、`ContextPack`、`ContextPackTrace`、`MemoryChangeEvent`、任务/检查点/索引表。
- 新增 API 和错误码契约，供 Agent Runtime、NexOS 应用、调试前端和评测任务调用。
- 新增异步 worker：解析、时间融合、事实抽取、索引刷新、STM 准入、做梦巩固、LTM 维护、权限同步、删除清理和评测。
- 新增内部调试前端路由、mock 数据、fixture、响应式检查和调试文档。
- 不在本提案中强制新增第三方依赖；实现阶段应优先复用仓库现有后端、前端、数据库、队列、日志和测试栈，新增依赖需单独确认。
