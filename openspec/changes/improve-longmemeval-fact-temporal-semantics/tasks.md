## 1. 评测时间契约

- [x] 1.1 为 LongMemEval 事实增加单值 `evidenceTime/validTime` 类型、SQLite 列和幂等读取写入。
- [x] 1.2 将 LongMemEval Session 日期建模为 `evidenceTime`，移除评测 Session item 的 `validTimeStart`。

## 2. 事实时间计算

- [x] 2.1 增加评测专用事实时间 resolver，以 Session evidence time 为基准计算确定性绝对/相对时间。
- [x] 2.2 在 LongMemEval 事实抽取后应用单值时间规范化，无时间表达或不可计算时保持 `validTime` 为空。
- [x] 2.3 将 LongMemEval 时间锚点解析改为优先使用 `factText`，且不消费或保留抽取阶段的 start/end 字段。

## 3. 时间轴聚合

- [x] 3.1 扩展共享事实排序兼容评测单值字段，并保持业务区间字段行为不变。
- [x] 3.2 让主评测时间轴优先消费 repository 中的抽取事实，raw fallback 只使用 `evidenceTime`。

## 4. 验证

- [x] 4.1 增加无时间、小时前后、天/周前后、绝对日期、模糊时间和 duration 的单元测试。
- [x] 4.2 增加评测 timeline 按 `validTime ?? evidenceTime` 排序及数据库恢复测试。
- [x] 4.3 运行后端类型检查和 LongMemEval 聚焦测试。
- [x] 4.4 运行 OpenSpec status/validate；CLI 不可用时记录未验证原因。
- [x] 4.5 增加 `sourceClaim` 缺少锚点但 `factText` 包含相对时间的真实形态回归测试。

验证说明：当前环境未安装 OpenSpec CLI，`openspec status` 和 `openspec validate` 无法执行；已完成 Markdown 结构检查、后端类型检查和聚焦测试。

## 5. 回答链路单值时间传播

- [x] 5.1 将 LongMemEval Fact 的 `evidenceTime/validTime` 传播到 STM 并持久化，评测 STM 不生成 start/end 字段。
- [x] 5.2 扩展搜索结果和 Context Pack 支持单值时间，LongMemEval 候选只渲染 `evidenceTime/validTime`。

## 6. 计算与真实评测回归

- [x] 6.1 将 LongMemEval 计算证据收敛为单值时间，并按问题语义使用 `validTime ?? evidenceTime` 选择操作数。
- [x] 6.2 增加 Fact→STM→搜索→Context Pack→计算的聚焦测试，并复跑真实 temporal 样本。
- [x] 6.3 将 duration、时间型 difference 和 order 的规划收敛为 LLM 选择证据/角色、代码按 `validTime -> factText -> evidenceTime` 补全时间。
- [x] 6.4 对有足够时间候选的空操作数或 insufficient 计划增加一次受约束修复，并记录修复 trace。
- [x] 6.5 增加时间补全优先级、数值差隔离和规划修复的单元及集成测试。

真实回归说明：`gpt4_fa19884c` 使用 `2023-03-25` 和 `2023-03-31` 两个 `validTime` 计算得到 6 天，Judge accuracy 为 1，Recall@5 同时命中两个答案 Session。最终 diagnostics 中评测 `temporal` 对象只包含 `evidenceTime/validTime`。`longmemeval.test.ts` 的宽泛名称筛选会命中一个既有 fetch mock 隔离问题；计算规划和时间证据目标用例单独运行通过。

规划修复验证说明：计算、LongMemEval 时间语义和共享 temporal query 共 33 个聚焦测试通过；Nightingale 集成用例验证首次 `insufficient` 后修复规划得到 21 天；后端类型检查通过。全量后端测试触发既有 health/MCP/embedding mock 隔离失败，并进入 `http://example.com` 网络重试，已在第 6 次重试后中止。当前环境仍未安装 OpenSpec CLI。

## 7. 多事件 item 时间映射

- [x] 7.1 为 Fact/Memory/Search/Context Pack 增加 `events[]` 事件级时间映射并提供 SQLite JSON 持久化。
- [x] 7.2 从 LongMemEval 多日期事实生成稳定 `eventKey`，timeline fusion 合并并去重来源事件映射。
- [x] 7.3 让计算计划使用 `sources: [{ itemId, eventKey }]`，按事件 `validTime` 补全时间，同时兼容旧 `sourceItemIds`。
- [x] 7.4 增加 router/thermostat、Rachel/house、timeline fusion 和 SQLite round-trip 聚焦测试。
