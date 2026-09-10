## Context

LongMemEval 的 `haystack_sessions[i]`、`haystack_session_ids[i]` 和 `haystack_dates[i]` 一一对应。数据集没有消息级时间，因此 Session 日期是该 Session 内事实的唯一 evidence time，评测固定按 UTC 解释。

现有评测专用时间后处理直接扫描 `factText/sourceClaim` 并生成 `evidenceTime/validTime`。这已避免把 Session 日期伪装成事实发生时间，但仍存在三个问题：`factType` 是开放字符串；模型没有显式返回时间锚点；持续事实会被压成单值开始时间。

## Goals / Non-Goals

**Goals:**

- 固定评测事实语义类型，消除类型漂移。
- 让模型只负责原子事实和原始时间锚点绑定，不负责日期计算。
- 让已生成的规范化时间具有确定性和可审计来源；不能可靠计算时保持为空。
- 用真实评测结果和答案 Session 驱动解析器覆盖。

**Non-Goals:**

- 不修改业务 conversation ingestion 的 `factType` 或时间 Schema。
- 不保证解析任意自然语言时间表达。
- 不通过扩大时间正则掩盖事实未召回或计算角色选错的问题。

## Decisions

### Decision 1: FactType 使用封闭枚举

LongMemEval LLM facts 使用 `profile/relationship/preference/goal/plan/task/decision/event/experience/transaction/state/state_change/feedback/knowledge/recommendation/answer/other`。类型只表达事实语义；用户、assistant 或 tool 来源继续由原始证据角色表达，不编码进 `factType`。

LLM 返回空值或非枚举类型时拒绝该候选，不再回退到 modality 或接受新字符串。非 LLM fallback fact 可以使用与枚举兼容的 `knowledge` 或 `other`，但不得重新引入开放类型。

### Decision 2: timeAnchor 是逐字单值字段

每条原子事实返回 `timeAnchor: string | null`。非空值必须逐字存在于已链接 evidence content/source claim，同时必须原样或语义等价地保留在 `factText` 和 `normalizedClaim` 中。

一个候选包含多个独立事件或多个分别修饰事件的时间锚点时，模型必须拆分候选。一个持续区间自身的完整表达（例如 `from March to May`）仍是一个 timeAnchor。

### Decision 3: evidenceTime 由评测程序注入

LLM 不返回 `evidenceTime`。系统使用当前 Session 对应的 `haystack_dates[i]`，按 UTC 规范化后写入所有该 Session Fact。缺失或非法 Session 日期是评测输入错误，不使用 question date、处理时间或模型输出回填。

### Decision 4: 确定性解析器只计算受支持表达

解析器输入为 `evidenceTime + timeAnchor`，不再扫描任意 factText 猜测锚点。受支持的单一绝对日期、时刻和相对分钟/小时/日/周/月/年生成 `validTime`。明确 `from/to`、`between/and`、`during` 范围，以及有当前完成时锚定的 `for N units` 持续状态生成 `validTimeStart/End`。

`recently`、`a while ago`、`a few/several units ago`、纯频率和无起止依据的 duration 保留 timeAnchor，但不生成 valid time。解析结果使用互斥约束：`validTime` 与 `validTimeStart/End` 不得同时存在，区间必须同时具有 start 和 end 且 end 晚于 start。

### Decision 5: 解析覆盖由评测证据驱动

解析器支持清单以 `longmemeval-result-500-valid.jsonl` 的时间相关问题为入口，通过 questionId 关联数据集的 `answer_session_ids`，检查真实答案 Session 中的绝对日期、相对表达、日期范围、时刻、持续时间和频率。

每个新增语法必须至少有一个来自数据集形态的测试。评测诊断将时间失败区分为：anchor extraction、anchor resolution、retrieval coverage 和 calculation role selection，避免把非解析问题错误归因于 parser。

### Decision 6: 最终 Fact 同时保留原文和规范化时间

最终评测 Fact 保留 `factText/normalizedClaim/timeAnchor/evidenceTime`，并按解析类型携带 `validTime` 或 `validTimeStart/End`。不得把规范化日期拼回 `factText`，以免把系统推导伪装成原始陈述。

## Risks / Trade-offs

- 固定枚举可能暂时把少见事实归入 `other`；通过评测分布审计后再版本化扩展。
- LLM 可能遗漏或改写 timeAnchor；本地逐字校验会拒绝不可靠锚点，Prompt 和测试覆盖典型拆分场景。
- 当前下游部分逻辑偏好单值 `validTime`；传播时保留业务已有区间兼容路径，并为评测计算明确选择 point 或 interval operand。
- LongMemEval 日期无时区；固定 UTC 保证复现，但不表示真实用户时区。

## Migration Plan

新增可选 `time_anchor` 持久化列。旧 Fact 没有 timeAnchor 时仍可读取，但只有重新运行评测 ingestion 才符合新抽取契约。回滚时停止写入和读取该列，不影响已有 evidence/valid time 列。
