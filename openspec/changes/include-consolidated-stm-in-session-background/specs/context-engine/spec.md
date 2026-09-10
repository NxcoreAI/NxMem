## MODIFIED Requirements

### Requirement: 为新会话加载背景上下文
系统 SHALL 支持背景上下文加载，把固定背景文本与时间窗口内具备有效权限和来源的已生成 STM 结合起来；STM 的准入生命周期、是否已巩固为 LTM 以及遗留 `hidden` 状态不得使其失去检索或背景输入资格，且系统 SHALL NOT 再把派生 LTM 重复加入同一背景分析输入。

#### Scenario: 时间窗口包含已巩固 STM
- **WHEN** Agent 会话开始且动态窗口内存在未删除、权限有效且具备来源引用的 STM
- **THEN** 系统将这些 STM 输入背景 LLM，生成带引用和审计元数据的动态背景文本

#### Scenario: 候选或遗留隐藏 STM 可参与动态筛选
- **WHEN** 动态窗口内存在 `write_candidate`、`pending_confirm` 或遗留 `accessState=hidden` 的已生成 STM，且来源权限仍有效
- **THEN** 系统将这些 STM 输入背景 LLM，由模型进行动态内容筛选，而不在输入前按准入结果或 `hidden` 状态丢弃

#### Scenario: 已生成 STM 可被检索
- **WHEN** 调用 `search_context` 检索未删除且来源权限有效的 STM
- **THEN** 系统可以召回该 STM，而不因其准入生命周期或遗留 `hidden` 状态返回 `inactive_stm` 或 `access_hidden`

#### Scenario: 来源权限失效
- **WHEN** STM 的访问状态为 `permission-invalid`
- **THEN** `search_context` 和背景上下文加载均不得使用该 STM

#### Scenario: 已巩固 STM 具有派生 LTM
- **WHEN** 动态窗口内的 `consolidated` STM 已经产生对应 LTM
- **THEN** 系统使用来源 STM 作为背景分析输入，并 SHALL NOT 将对应 LTM 作为重复输入

#### Scenario: 动态加载不可用
- **WHEN** 检索或组装依赖不可用
- **THEN** 系统回退到固定背景文本，并记录 degraded-mode 原因
