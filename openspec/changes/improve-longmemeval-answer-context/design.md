## Context

当前答题链路如下：

```text
searchContext 前 10 条
  -> assembleContext
  -> 基础 Context Pack

searchContext 前 100 条
  -> selector 只看每条前 600 字符
  -> 最多选择 8 条
  -> 每条再截成最多 1200 字符
  -> 【答题关键证据】

基础 Context Pack + 【答题关键证据】
  -> 答题模型
```

主要问题是两套召回结果可能不一致，而且额外的 selector 看不到候选的完整时间和更新关系。即使 selector 选中了正确 STM，最终的 `【答题关键证据】` 也只输出正文片段，不输出 `evidenceTimeStart`、`validTimeStart` 和关系边。

数据库中的 23465 条 STM 中，96.36% 不超过 600 字符；超过 1200 字符的 800 条 STM 主要是 segment fallback 或长 timeline 内容。因此普通 STM 没有必要截断，长 STM 则不能直接当作普通事实处理。

## Goals / Non-Goals

**Goals:**

- 每道题只生成一份候选集合和一份最终答题上下文。
- 删除单独的 LLM selector 调用，减少一次不稳定且有信息损失的模型选择。
- 所有进入候选集合的 STM 都以完整正文进入 Prompt，不做字符级截断。
- 时间、来源和新旧变化关系与正文一起进入选择阶段和答题阶段。
- 多 Session、时间计算、求和、比较和状态更新问题能够保留完整证据组合。
- 异常长的 segment fallback 或 timeline 内容仍可进入答题候选；是否进入最终 Prompt 由问题相关性、最多 6 条证据限制和总 token budget 共同决定。
- 每条失败结果都能区分为未生成、未进入前 100、未被选择、渲染丢失或答题推理错误。
- LLM 生成的事实正文和标准化主张使用英文，避免英文评测问题与中文融合摘要之间的词汇错配。
- 多 Session 问题在答题阶段保留各 Session 的独立候选，并要求答案模型先判断不同来源是否为同一事实的重复提及；计数题再枚举独立事件并计数。
- 每个评测样本使用独立 `contextScopeId`。每个 Session 独立完成抽取、Session 内聚合、STM 准入和索引，所有 Session 成功后才进入召回答题。
- LongMemEval 不创建异步跨 Session `TimelineFusionTask`，也不使用 LTM 参与答题召回。

**Non-Goals:**

- 不修改 `rankedSessionIdsForLongMemEvalAnswer`。
- 不修改事实抽取字段结构或 STM 准入规则；仅调整事实融合和时间轴融合的 canonical 文本语言。
- 不修改生产和 Agent conversation 的异步时间轴融合默认行为。
- 不把全部 100 条候选不加筛选地交给答题模型。
- 不修改 Judge 模型和评测答案标准。
- 不新增数据库业务字段；诊断信息优先写入评测结果 JSONL。
- 不为所有问题建立固定的领域事件表；答题阶段不再按 Session/Event ID 生成合并候选。

## Proposed Flow

新链路使用一套候选和一套选择结果：

```text
1. 使用当前样本 `contextScopeId`，从样本内所有 Session 产生的 STM 中找出最相关的 100 条
2. 为每条候选准备英文正文、时间、来源和新旧关系
3. 保留不同 Session 的原子事实，不做跨 Session 持久融合；把潜在重复证据一并交给回答模型判断
4. 二次重排并挑出最多 6 条回答问题最需要的候选，优先覆盖时间端点、计算 operand 和状态更新
5. 所有选中的 evidence text 原样放入，长内容额外受总 token budget 硬上限约束
6. 将最终上下文一次性交给答题模型
```

对应代码流程：

```text
searchContext(limit=100)
  -> buildAnswerEvidenceCandidates
  -> selectAnswerEvidenceWithinBudget
  -> renderAnswerContext
  -> buildLongMemEvalAnswerPrompt
```

`assembleContext` 不再为 LongMemEval 答题阶段重新执行一次 `limit=10` 的检索。现有通用 `assembleContext` API 保持不变，LongMemEval 使用已经选好的候选构建兼容的 `ContextPack` 诊断对象。

## Candidate Model

为答题阶段增加内部候选结构，不修改持久化模型：

```ts
interface LongMemEvalAnswerEvidenceCandidate {
  item: ContextPackItem;
  evidenceText: string;
  sourceSessionIds: string[];
  sourceRoles: Array<"user" | "assistant" | "tool" | "unknown">;
  temporal: ContextPackItem["temporal"];
  relations: RelationEdge[];
  estimatedTokens: number;
}
```

候选正文规则：

- `evidenceText` 由完整 `item.content`、关联 FactItem 的 `factText` 和必要的 `sourceClaim` 去重组成。
- 候选相关性、token 估算、诊断匹配、计算 evidence 和最终 Prompt 均使用同一份 `evidenceText`。
- 进入候选集合的 STM 始终保留完整 `item.content`，不得因补入 FactItem 而覆盖来源和审计字段。
- 不再使用统一的前 600 字符 preview，也不再生成最多 1200 字符的 excerpt。
- 普通 STM 即使超过 600 或 1200 字符，也不做局部截取；能否进入最终 Prompt 只由总 token budget 决定。
- 对来源类型为 segment fallback 或 timeline aggregation 的内容不设置字符级排除规则。
- 长内容保留完整正文；若因总 token budget 未进入最终 Prompt，只记录普通 `budget` 拒绝原因。

建议默认值：

```ts
answerCandidateLimit = 100
answerContextTokenBudget = 20000
```

不再使用异常长度阈值排除候选。所有候选都使用完整正文，测试不得依赖字符截断或长文本过滤。

## Evidence Selection

证据选择由普通程序完成，不再调用额外的 LLM selector。选择分两步完成。

### 第一步：保证基础相关性

先按 `searchContext` 分数得到 100 条候选，再按问题与完整 evidence text 的相关性二次重排，最终选择最多 6 条。优先保留：

- 能直接回答问题的事实。
- 问题中明确提到的人、物品、地点、金额或事件。
- 时间问题需要的起点、终点和问题日期。
- 求和、差值、数量或比较问题需要的每个数值。
- 状态变化问题的旧值、新值和对应时间。

### 第二步：补齐证据组合

选择结果需要检查是否缺少必要条件：

- multi-session 问题不能因为某一条分数高，就丢掉其他 Session 的答案条件。
- temporal-reasoning 问题必须同时包含计算所需的两个时间点。
- 更新类问题必须同时包含旧状态和最新状态，或者明确只保留最新状态并说明替换依据。
- 当多个候选表达同一事实时只保留信息最完整、来源最直接的一条。

程序为每条选中证据记录选择原因：

```json
{
  "selected": [
    {
      "itemId": "stm_xxx",
      "reason": "提供开始日期",
      "evidenceRole": "temporal_start"
    }
  ]
}
```

`evidenceRole` 支持 `direct_answer`、`temporal_start`、`temporal_end`、`old_state`、`new_state`、`calculation_operand` 和 `disambiguation`。这些角色由问题类型、候选时间字段、数值字段和关系边确定，只用于选择说明和诊断，不产生新的事实。

建议实现顺序：

1. 按 `searchContext` 最终分数排序。
2. 去掉正文相同或来源事实相同的重复项，保留信息更完整的一条。
3. 优先加入高分候选，并在候选带有 `updates`、`conflicts_with` 等关系时补入另一端。
4. temporal-reasoning 问题优先保留不同时间点的候选，multi-session 问题在相关候选中避免只保留单一 Session。
5. 按动态相关度继续加入候选，直到达到 6 条；token budget 只在单条或最终 Prompt 异常过长时作为硬上限。

### Count Evidence

计数问题在答题阶段不再按来源 Session、Event ID 或日期拼接候选。每个召回候选保持独立，回答模型先判断不同来源的候选是否为同一事实或同一事件的重复提及，再枚举符合范围的独立事件并计数，避免把支持性事实或重复提及当作额外事件。

## Token Budget

选择数量固定为最多 6 条关键证据，token budget 不再驱动正常选择，只作为硬保护：

1. 对 100 条候选使用完整 evidence text 二次评分并去重。
2. 先加入直接答案和必要条件，再按相关性加入补充证据，最多 6 条。
3. 如果加入一条完整证据会超过硬预算，则记录为预算不足并跳过，不得改用局部片段。
4. 必要条件不得因为辅助内容而被挤出；达到 6 条后其余候选记录为 `lower_priority`。

每次评测记录：请求预算、固定 Prompt 占用、证据占用、最终选中数量和因预算丢弃的候选。

## Prompt Rendering

每条最终证据使用统一格式：

```text
- [1] 用户在当地烹饪学校参加了烘焙课。
  事实发生时间：2022-03-25 18:46
  消息发送时间：2022-03-26 18:46
  来源：user，Session answer_xxx
  关系：无
```

更新类事实示例：

```text
- [1] 用户原来计划乘坐火车。
  事实发生时间：2023-05-01
  来源：user，Session session_old

- [2] 用户后来改为乘坐飞机，这条信息更新了前一条计划。
  事实发生时间：2023-05-03
  来源：user，Session session_new
  关系：updates [1]
```

渲染规则：

- 正文渲染 `evidenceText`，不得只渲染比排序输入更短的 STM 摘要。
- Answer LLM 必须先比较不同来源证据的语义、实体、时间和事件属性，识别重复提及，再基于去重后的事实回答；不得因为同一事实出现多次而重复计数。
- `validTimeStart/End` 显示为“事实发生时间”。
- `evidenceTimeStart/End` 显示为“消息发送时间”。
- 两种时间不能合并为一个模糊的“时间”。
- `updates`、`supersedes`、`conflicts_with` 等关系必须显示可理解的中文说明。
- 来源角色必须区分 user 与 assistant，防止把助手建议误当作用户经历或偏好。
- 最终 Prompt 不再同时出现内容不一致的基础 Context Pack 和关键证据区。
- 计数类问题的 Prompt 额外说明：先枚举符合时间范围的独立事件，再计数；不要把配方参数、支持性事实或同一事件的重复提及当作额外事件。

## Diagnostics

评测 JSONL 为每道题增加以下诊断字段：

```ts
interface LongMemEvalAnswerEvidenceTrace {
  retrievalLimit: number;
  retrievedItemIds: string[];
  eligibleCandidateItemIds: string[];
  candidates: Array<{
    itemId: string;
    score: number;
    scoreBreakdown: ScoreBreakdown;
    sourceSessionIds: string[];
    contentChars: number;
  }>;
  selected: Array<{
    itemId: string;
    reason: string;
    evidenceRole?: string;
  }>;
  rejected: Array<{
    itemId: string;
    reason: "not_relevant" | "duplicate" | "budget" | "missing_required_metadata" | "lower_priority";
  }>;
  renderedPromptHasTemporalMetadata: boolean;
}
```

诊断应能直接回答：

- 正确 STM 是否存在。
- 正确 STM 是否进入前 100 条召回结果。
- 正确 STM 是否在召回后因相关性或预算被排除。
- 是否被答题上下文选择程序选中。
- 是否因为预算或去重被丢弃。
- 最终 Prompt 是否包含完整正文和时间。

诊断写入失败不能影响正式答题。

## Error Handling

- 候选缺少时间：仍可作为普通事实使用，但时间问题不得把缺失时间的候选标记为完整答案证据。
- 长的 segment fallback 或 timeline：仍作为完整候选参与选择，不能因为字符长度提前排除或截取。
- token 估算与实际 Prompt 超限：按辅助证据和重复证据的顺序移除完整 STM，必要证据最后移除并记录明确原因。

## Calculation Review

- 查询级计算 Planner 必须读取本题最终 Context Pack，并对所有问题输出 `direct_answer`、`calculation`、`insufficient_context` 或 `unsupported_operation` 决策；现有正则分类只保留为诊断 hint，不得作为是否调用 Planner 的硬门控。
- `calculation` 决策使用受限 operation registry。第一阶段支持现有操作以及基础算术、平均与去重计数、比例百分比、实体比较、日期加减和单位转换；Planner prompt、Validator 与 Executor 必须复用同一注册表，避免白名单漂移。
- Planner 引用的每个 operand 必须绑定最终 Context Pack 中的 item/event；确定性校验失败时不得执行。Context Pack 缺少必要 operand 时记录 `insufficient_context`，不得重新召回或补猜。
- 查询级计算结果是回答模型的辅助证据，不直接替代回答模型。主 Planner 必须输出以 decision 包裹的严格协议；缺少 decision 的旧版顶层单 operation plan 和同时包含两套协议字段的混合响应均视为非法输出。
- `computed` 结果以包含 operation、answer、formula 和 operand 来源的审计块加入回答 Prompt，并明确要求模型核对问题语义和证据完整性。
- `insufficient`、`invalid`、planner 请求失败或解析失败都继续走普通回答模型；只有 Trace 记录状态和原因。
- `count` operand 只能表示独立实体或事件，不得携带待读取或求和的数值；出现数值时计划视为无效并回退回答模型。

## Numeric And Temporal Fact Completeness

- 事实抽取 Prompt 必须优先检查数字、日期、时间点、持续时长、金额、频率、范围、上下界和单位。
- 数值或时间限定必须与对应事件、交易、对象或状态保存在同一条最小充分事实中，例如 Chicago 行程必须保留“停留 3 天”，不能只保留“去过 Chicago”。
- 不允许补算证据中没有的结果，但证据明确给出的数字和时间限定不得因摘要压缩而遗漏。

## Testing Strategy

### Unit tests

- 英文问题能够通过包含英文 `sourceClaim` 的中文 STM 索引召回。
- 普通 STM 即使超过 600 或 1200 字符，仍完整进入最终 Prompt。
- 所有参与答题的 STM 都不调用 excerpt 逻辑。
- 超过常规长度的 segment fallback 和 timeline 内容仍完整进入 Prompt（预算允许时）。
- Prompt 同时输出事实时间和消息时间。
- user/assistant 来源角色正确输出。
- updates/conflicts 关系正确输出。
- 选择数量不得超过 6，且不能超过 token budget 硬上限。
- 相同事实的重复候选只保留信息最完整的一条。

### Integration tests

- 两个 Session 分别提供时间起点和终点时，两条 STM 都进入 Prompt。
- 三个 Session 分别提供三个金额时，三个数值都进入 Prompt。
- 旧值和新值分别存在时，Prompt 明确显示更新顺序。
- 正确候选位于第 30 条之后时仍能被选中。
- 长候选不得以截断内容出现在最终 Prompt 中；预算不足时应整体记录为 `budget`。
- 基础 Context Pack 与关键证据不再执行两次独立召回。

### Evaluation verification

- 重新运行相同 50 条 LongMemEval。
- 对比 `promptHasAnswer`、Judge accuracy 和各失败阶段数量。
- 重点复查之前归类为“正确 STM 未进入最终 Context Pack”的 9 条。
- 重点复查之前归类为“时间/更新关系丢失”的 6 条。
- 不以单次总分提升作为唯一验收条件，必须证明正确证据在 Prompt 中完整出现。

## Rollout

1. 先通过 LongMemEval 专用配置启用新链路，保留旧链路用于同批数据对照。
2. 同一批 50 条分别运行旧链路和新链路，保存候选与 Prompt 诊断。
3. 新链路通过验收后设为 LongMemEval 默认路径。
4. 稳定后再评估是否把同一套证据选择 helper 接入通用 `assembleContext`。

回滚只需切回旧答题上下文模式；不涉及数据库迁移和已存记忆修改。
