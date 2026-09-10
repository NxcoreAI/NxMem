## 1. 评测事实契约

- [x] 1.1 定义 LongMemEval `FactType` 枚举并在 LLM Prompt、响应解析和 fallback 中强制使用。
- [x] 1.2 增加 `timeAnchor` 候选字段及逐字来源、factText 保留和原子事实拆分校验。
- [x] 1.3 将 `timeAnchor` 传播并持久化到最终 Fact，同时保持旧数据库兼容。

## 2. 时间锚点覆盖与解析

- [x] 2.1 从 500 条评测结果关联答案 Session，整理绝对、相对、区间、持续、频率和模糊时间案例。
- [x] 2.2 重构 LongMemEval resolver 只消费 `evidenceTime + timeAnchor`，单点生成 `validTime`，持续/区间生成 `validTimeStart/End`。
- [x] 2.3 对不支持、模糊或无法验证的表达保留锚点但不生成规范化时间。

## 3. 下游与验证

- [x] 3.1 更新时间轴、STM/搜索/Context Pack 和计算证据，确保 point/range 时间互斥且不丢失 timeAnchor。
- [x] 3.2 增加固定 factType、锚点逐字校验、多事件拆分、真实评测锚点和区间解析测试。
- [x] 3.3 运行后端类型检查与 LongMemEval 聚焦测试，并记录 OpenSpec CLI 验证状态。

## Verification

- `pnpm --filter @nexcore/backend typecheck`: passed.
- LongMemEval contract/temporal/calculation, structured-memory and repository focused tests: 83 passed, 0 failed.
- `openspec status` / `openspec validate`: not run because the OpenSpec CLI is not installed in this workspace.
- The full `longmemeval.test.ts` suite still has unrelated failures from remote-embedding mock consumption and pre-existing calculation-chain edits; no failures were observed in the focused scope above.
