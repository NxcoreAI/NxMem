## ADDED Requirements

### Requirement: 展示摄入与处理 trace
调试前端 SHALL 展示已提交事件从摄入、解析、事实生成、STM/LTM 更新、索引、做梦到记忆变化事件的完整生命周期。

#### Scenario: 工程师打开事件 trace
- **WHEN** 工程师在调试前端打开某个 `MemoryEvent`
- **THEN** 前端展示原始事件元数据、权限快照、解析状态、关联片段、生成事实、准入 STM、巩固 LTM、任务、错误和记忆变化事件

#### Scenario: 处理失败
- **WHEN** 解析、融合、准入、索引或做梦任务失败
- **THEN** 前端展示失败阶段、错误类型、重试次数、checkpoint、受影响记录和下一次重试或终态

### Requirement: 展示批次处理进度
调试前端 SHALL 在批次摄入视图中展示 `MemoryEvent` 批次的总体进度百分比，以及每条事件的节点进度和终态。

#### Scenario: 批次进度被查看
- **WHEN** 工程师打开文件摄入批次或等价批次 trace
- **THEN** 前端展示批次总体进度百分比、已处理 / 总数、记住 / 丢弃 / 失败数量，以及每条事件在各节点的当前状态

#### Scenario: 批次内单条事件被丢弃
- **WHEN** 某条 `MemoryEvent` 在解析、准入或索引前被丢弃
- **THEN** 前端展示该事件的最后成功节点、丢弃原因和批次进度变化

### Requirement: 提供证据、事实、STM 和 LTM 浏览器
调试前端 SHALL 提供可搜索的 Data Lake 证据、Fact、STM、LTM、关系边和来源引用浏览器。

#### Scenario: 审阅者按实体搜索
- **WHEN** 审阅者按实体、来源引用、记忆 ID、事实 ID、标签、状态、时间范围或文本搜索
- **THEN** 前端返回匹配记录及其类型、状态、来源引用、权限状态、置信度、生命周期元数据和关系链接

#### Scenario: 显示敏感记录
- **WHEN** 记录敏感或查看者没有完整来源权限
- **THEN** 前端脱敏受保护内容，只显示允许的元数据和权限决策

### Requirement: 提供检索 playground
调试前端 SHALL 允许授权用户执行 `search_context` 并查看排序行为。

#### Scenario: 执行查询
- **WHEN** 用户输入任务或搜索查询及过滤条件
- **THEN** 前端展示候选项、各路分数、最终分数、排名、匹配词、图谱/实体匹配、递减因子、冲突惩罚、权限过滤和来源引用

#### Scenario: 候选项被丢弃
- **WHEN** 检索候选被过滤或丢弃
- **THEN** 前端展示 dropped 原因，例如权限失败、状态排除、敏感性策略、重复合并、低分、过旧或 token 预算压力

### Requirement: 提供 Context Pack inspector
调试前端 SHALL 展示 `assemble_context` 如何把候选转换成最终的 Agent 上下文包。

#### Scenario: 查看 pack
- **WHEN** 用户打开某个已生成的 Context Pack
- **THEN** 前端展示 profile_context、task_context、recent_context、constraints、citations、conflicts、token 预算分配、压缩步骤、选中项、丢弃项和最终序列化 payload

#### Scenario: pack 包含冲突
- **WHEN** pack 中包含冲突事实或记忆
- **THEN** 前端展示冲突参与者、来源引用、时间戳、建议处理方式以及该冲突是被包含、摘要化还是被排除

### Requirement: 提供背景上下文调试
调试前端 SHALL 展示固定背景文本、动态背景加载结果和固定文本更新建议，但不得静默应用更新。

#### Scenario: 会话背景被检查
- **WHEN** 用户打开某个会话背景 trace
- **THEN** 前端展示固定背景输入、召回的 STM/LTM 证据、按栏目更新的动态结果、引用、冲突、丢弃项和 degraded-mode 原因

#### Scenario: 存在更新建议
- **WHEN** 背景加载产生固定背景更新建议
- **THEN** 前端把建议展示为待审阅状态，且只有在有权限的用户确认后才标记为已应用

### Requirement: 提供记忆反馈和生命周期审阅工具
调试前端 SHALL 允许授权用户提交反馈并检查由此产生的生命周期变化。

#### Scenario: 用户提交纠正
- **WHEN** 授权用户从调试 UI 纠正、确认、忽略、点赞、点踩或删除某条记忆
- **THEN** 前端发送对应反馈请求，展示任务或事件结果，并在处理完成后刷新 trace

#### Scenario: 用户尝试破坏性操作
- **WHEN** 动作会删除、隐藏或永久改变记忆可见性
- **THEN** 前端要求显式确认，并在提交前展示预计受影响的记录

### Requirement: 提供可观测仪表板
调试前端 SHALL 展示 Context 引擎开发和 QA 所需的运营与质量指标。

#### Scenario: 工程师打开指标面板
- **WHEN** 工程师打开 Context 引擎仪表板
- **THEN** 前端展示摄入延迟、解析延迟、融合延迟、STM 准入计数、做梦吞吐量、检索延迟、组装延迟、token 使用、权限拒绝数、worker 失败和评测指标

#### Scenario: 查看评测结果
- **WHEN** 选择某次评测运行
- **THEN** 前端展示 Recall@K、Precision@K、MRR@K、NDCG@K、失败案例、期望证据、检索证据、pack 输出和相对上一轮的回归差异

### Requirement: 支持前端本地调试工作流
调试前端 SHALL 能在本地开发模式下使用 mock 或 fixture 数据运行，并提供验证步骤。

#### Scenario: 后端不可用时前端仍可运行
- **WHEN** 本地开发时后端 Context 引擎不可用
- **THEN** 前端可以运行在 fixture 或 mock API 上，覆盖事件 trace、检索结果、Context Pack、权限失败、冲突和记忆变化事件

#### Scenario: 开发者验证 UI 行为
- **WHEN** 开发者修改调试前端
- **THEN** 他们能够运行类型检查、lint、单测和 desktop/mobile 的关键视觉状态检查

#### Scenario: mock fixture 镜像评分与生命周期元数据
- **WHEN** 前端运行在 mock 模式
- **THEN** fixture 数据包含 route score、final score、dropped reason、生命周期状态、敏感脱敏状态、权限决策、引用、冲突、任务和记忆变化事件，并与后端 API 契约一致

#### Scenario: 检查响应式调试布局
- **WHEN** 调试前端在桌面和移动端视口打开
- **THEN** trace 时间线、表格、过滤器、inspectors、分数拆解和序列化 Agent payload 面板保持可读，且不发生控件重叠或关键标识截断

### Requirement: 提供前端调试运行手册
调试前端 SHALL 提供关于启动 UI、选择真实或 mock API、种子 fixture、重现 trace 和验证视觉状态的文档。

#### Scenario: 工程师调试检索质量
- **WHEN** 工程师按调试指南操作
- **THEN** 他们可以启动前端、加载检索 fixture、检查候选分数、比较选中项与丢弃项，并在不依赖 live worker 的情况下捕获 Context Pack 状态

#### Scenario: 工程师调试权限或敏感信息失败
- **WHEN** 工程师加载权限或敏感信息 fixture
- **THEN** 前端展示相关脱敏状态、过滤原因、来源引用和受影响的 Context Pack 区块，而不泄露受保护原文
