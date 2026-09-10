## Context

LongMemEval 以每个 haystack Session 构造一个 `MemoryEvent`。当前 Session 日期被写入 item `validTimeStart`，通用事实融合缺少语义时间时又回退到 `eventTime`；主评测时间轴还会直接从 Session event 构造 raw fact。因此来源时间和事实发生时间被混为一谈。

本变更只优化评测链路。业务链路继续支持区间时间，LongMemEval 事实采用两个单值字段：

| 字段 | 含义 |
| --- | --- |
| `evidenceTime` | 事实所在 Session 的日期，也是相对时间计算基准 |
| `validTime` | 事实在现实世界开始发生的时间；无法确定时为空 |

## Goals / Non-Goals

**Goals:**

- 消除 LongMemEval Session 日期被无条件写为事实发生时间的问题。
- 确定性计算“2 天后、2 小时前、两周后”等相对时间。
- 对无时间表达、模糊数量和纯持续时长保持 `validTime` 为空。
- 评测时间轴读取真实抽取事实，并按 `validTime ?? evidenceTime` 排序。
- 评测回答链路从 STM 到计算器始终携带单值时间，并按问题中的事件角色选择计算操作数。
- 保留 Duration、结束时间等信息在事实文本中，不增加评测 start/end 字段。

**Non-Goals:**

- 不修改 conversation ingestion 的区间时间契约。
- 不实现跨事实指代解析；无法确认参照对象的“随后、几天后”等表达不计算。
- 不把 `question_date` 当作 Session 事实时间；它只用于回答问题时的参考日期。

## Decisions

### Decision 1: 评测事实只使用单值时间

`FactItem` 增加可选 `evidenceTime/validTime`，仅 LongMemEval 事实写入。规范化时删除该事实上的 `evidenceTimeStart/End` 和 `validTimeStart/End`。会议 `14:00-15:00` 的 `validTime` 为 `14:00`，持续一小时保留在 `factText/sourceClaim`。

### Decision 2: Session 日期是 evidence，不是 valid

LongMemEval Session 保留规范化后的 `evidenceTime`。`MemoryEvent.eventTime` 继续使用该值以兼容通用事件接口，但 Session item 不再携带 `validTimeStart`。

### Decision 3: 模型抽取事实，代码从 factText 计算时间

模型继续负责原子事实和原始引文，并由抽取 prompt 强制把日期、相对时间表达、持续时长和所属事件保留在 `factText`。评测专用后处理优先且直接从 `factText` 检测确定性时间表达，使用 Session `evidenceTime`、`UTC` 和 `en-US` 调用现有 temporal resolver。`sourceClaim` 只用于来源审计，不覆盖 `factText` 的时间语义。绝对或相对表达可解析时取解析结果的开始时刻作为 `validTime`；否则不写入。

通用抽取阶段可能临时返回 `validTimeStart/validTimeEnd`，但 LongMemEval 后处理不得消费或保留这些区间字段。评测事实的 `validTime` 必须由 `factText` 和 Session `evidenceTime` 重新确定性计算，规范化结果只保留单值 `evidenceTime/validTime`。

相对分钟/小时使用精确时长运算，日/周/月/年使用日历运算。纯 duration 和模糊数量不产生 `validTime`。

### Decision 4: 主评测时间轴消费持久化事实

评测完成 Session ingestion 后，从评测 repository 读取属于当前 sample 的 Fact，使用共享聚合器聚合。排序键扩展为 `validTime ?? validTimeStart ?? evidenceTime ?? evidenceTimeStart ?? observedAt`。仅在没有可用 Fact 时回退到 Session raw timeline，且 raw timeline 只携带 `evidenceTime`。

### Decision 5: 业务字段保持兼容

单值列是新增可选列。现有业务事实、STM/LTM、查询区间和 API 不迁移、不重命名。这样可以独立验证评测效果，并避免扩大线上时间协议的变更范围。

### Decision 6: 评测回答链路只暴露单值时间

LongMemEval 事实进入 STM 时复制 `evidenceTime/validTime`。评测搜索结果、Context Pack 和计算证据只暴露这两个时间锚点，不把业务链路的 evidence/valid start/end 区间字段混入评测对象。共享类型和 SQLite 表可以为业务兼容保留区间列，但 LongMemEval 写入和渲染路径不得生成或消费这些区间字段。

计算器根据问题语义给事实分配 start/end、minuend/subtrahend 等角色，不能仅按时间先后或证据排列顺序猜测关系。每个事实的计算时间按 `validTime ?? evidenceTime` 选择；存在 `validTime` 时不得改用 Session `evidenceTime`。`question_date` 只在问题明确要求相对当前/问题日期计算时作为独立参考值，不得替代某个事实的缺失时间。

### Decision 7: Duration 保持为事实语义，不新增时间锚点

持续时长不是时间锚点。本变更不增加 `duration`、`durationStart` 或 `durationEnd` 字段。`14:00-15:00` 只把 14:00 保存为 `validTime`，一小时持续信息保留在 `factText/sourceClaim`，计算器在问题询问持续时长时从明确文本数值和单位取值。只有未来出现按时长过滤、排序或聚合的独立需求时，才另行设计单位统一的 duration value。

### Decision 8: 规划器选择语义角色，代码补全时间

对于 `duration`、时间型 `difference` 和 `order`，规划模型只选择相关 `sourceItemIds` 并分配 `start/end`、`minuend/subtrahend` 或排序标签，不负责复制时间字符串。代码对每个已选操作数按 `validTime -> factText 中可确定的事件日期 -> evidenceTime` 补全时间，并在 trace 中记录时间来源。数值型 `difference` 保持 value/unit 计算，不因证据具有消息时间而转成日期差。

如果首次计划返回空操作数或 `insufficientReason`，但至少两条候选证据可以确定时间，系统 SHALL 仅携带这些时间候选和首次失败原因执行一次受约束修复规划。修复规划仍按问题语义选择证据和角色，不得仅按时间或证据顺序配对；修复失败后才保留原失败结果并回退普通答案模型。

### Decision 9: 多事件 item 保存事件级时间映射

当一个 Fact、timeline fused Fact 或 STM item 同时描述多个事件时，系统不强制拆分 item，而是在 item 上保存 `events[]`。每个事件至少包含稳定 `eventKey`、可读 `label` 和单值 `validTime`；`eventKey` 由规范化事件描述和稳定摘要生成，不依赖人工枚举。

`events` 含多个不同事件时，item 级 `validTime` 不得代表其中任一事件。计算规划器使用结构化 `sources: [{ itemId, eventKey }]` 绑定事件，确定性代码读取被选事件的 `validTime`。旧 `sourceItemIds` 继续兼容没有事件映射或只有单个事件的 item；多事件 item 缺少 `eventKey` 时计划无权选择某一事件，并可进入已有的一次 repair。

timeline fusion SHALL 合并来源事实的事件映射，以 `eventKey + validTime` 去重，不得只保留第一个来源事实的时间。事件映射通过 Fact SQLite JSON 列、STM structured facts、搜索结果、Context Pack 和计算证据完整传播。

## Risks / Trade-offs

- [模型改写导致时间表达丢失] → 抽取 prompt 强制在 `factText` 保留时间表达、数字和单位，并通过回归测试验证 `sourceClaim` 不完整时仍可从 `factText` 计算。
- [LongMemEval 日期无时区] → 评测固定 UTC，保证跨环境可复现。
- [一条事实包含多个时间表达] → 确定性 resolver 当前选择可识别表达；测试覆盖典型单锚点事实，多锚点留作后续增强。
- [主时间轴从 raw Session 切换到 Fact 后内容变化] → 无 Fact 时保留 raw fallback，并增加回归测试。
- [消息时间被误当成事件时间] → 在计算阶段先解析正文中的明确事件日期，只有正文没有可确定日期时才回退 `evidenceTime`，并记录实际来源。
- [修复规划把无关日期配成一对] → 修复调用仍要求按问题实体和事件关系选择 `sourceItemIds` 与角色，代码只负责时间补全，不按时间顺序自动猜测语义关系。

## Migration Plan

SQLite 初始化时幂等增加 `fact_items.evidence_time` 和 `fact_items.valid_time`。旧事实保持原样；重新运行 LongMemEval ingestion 后生成单值时间。回滚时可停止读取新列，已有业务字段不受影响。
