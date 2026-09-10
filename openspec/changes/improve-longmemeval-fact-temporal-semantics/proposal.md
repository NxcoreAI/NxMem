## Why

LongMemEval 当前把 Session 日期同时当作来源时间和事实发生时间，导致没有时间表达的事实也获得伪造的 `validTimeStart`，相对时间事实也可能按 Session 日期而非计算后的真实日期参与排序。评测因此无法准确验证时间推理和跨 Session 聚合能力。

## What Changes

- 为 LongMemEval 评测事实定义单值 `evidenceTime` 和可选 `validTime`，不在评测契约中使用 start/end 区间字段。
- 使用 `haystack_dates` 对应的 Session 日期作为 `evidenceTime` 和相对时间计算基准，固定按 UTC 归一化。
- 对可确定的绝对时间或相对时间表达计算 `validTime`；无法确定时保持为空。
- 对持续型事实只记录开始时间为 `validTime`，持续时长保留在事实文本中。
- 让 LongMemEval 时间轴优先按 `validTime`、缺失时按 `evidenceTime` 聚合和排序，并使用已抽取事实而非始终使用原始 Session 伪事实。
- 将单值 `evidenceTime/validTime` 贯穿 LongMemEval STM、搜索结果、Context Pack 和确定性计算器；评测对象不再混入 start/end 区间字段。
- 时间差计算按照问题语义确定起止事实，优先使用 `validTime`，为空时才回退 `evidenceTime`。
- 当一个 item 包含多个事件时保存 `events[]` 事件级时间映射，计算操作数通过 `itemId + eventKey` 选择对应事件时间，不强制拆分 item。

## Capabilities

### Modified Capabilities

- `context-engine`: 增加 LongMemEval 评测事实的单值双时间锚点和评测时间轴排序规则。

## Impact

- 主要影响 `longmemeval.ts`、评测事实抽取后的时间规范化、事实持久化和时间轴聚合。
- 业务 conversation ingestion 的 evidence/valid 时间区间契约保持不变。
- LongMemEval 存储 schema 增加可选单值时间列，旧评测数据库通过幂等列迁移兼容。
