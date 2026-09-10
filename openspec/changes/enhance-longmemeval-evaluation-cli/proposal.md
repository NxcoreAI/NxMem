## Why

当前 LongMemEval CLI 只能对整个数据集执行评测，无法快速复现单个问题，也无法从原始数据集生成可控规模的跑分子集；清除评测数据库虽然已有底层能力和 HTTP 接口，但命令行操作不完整。补齐这些能力可以降低单样本调试成本，支持稳定的抽样回归，并让本地评测环境能够安全复位。

## What Changes

- 增加按 `question_id`（可重复指定多个）或按原始顺序闭区间的单样本/多样本评测入口，复用现有 ingestion、answer、judge 和 model-run 流程。
- 增加按比例生成 LongMemEval 子数据集并立即对该子集跑分的 CLI 能力；支持固定随机种子、输出文件和切分结果元信息，保证结果可复现。
- 增加清除 LongMemEval 评测存储及配置的 Neo4j 图数据的 CLI 子命令，并要求显式确认，输出删除和跳过信息。
- 统一参数校验、错误退出码和 JSON 输出，便于脚本化调用。
- 增加 CI 调用契约：支持非交互执行、稳定退出码、确定性 seed、机器可读结果文件和不污染 stdout 的进度输出。

## Capabilities

### New Capabilities

- `longmemeval-evaluation-cli`: 定义 LongMemEval CLI 的样本选择、比例切分跑分、数据库清理、参数校验和输出契约。

### Modified Capabilities

无。

## Impact

- 主要影响 `apps/backend/src/modules/context-engine/longmemeval-cli.ts` 及 `longmemeval.ts` 的数据集加载/选择边界。
- 补充 CLI 单元测试和端到端评测夹具测试；可能新增数据集切分工具模块。
- 不改变现有 HTTP 评测接口和默认全量评测行为；新增输出文件属于用户显式指定的路径。
- CI 通过 `--ci` 进入严格模式：等价于 JSON/无进度输出，并拒绝依赖临时交互确认的行为。
