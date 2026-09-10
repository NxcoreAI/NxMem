## ADDED Requirements

### Requirement: CLI 支持指定样本评测
系统 SHALL 支持通过 CLI 指定一个或多个 `question_id`，或指定原始数据集顺序的 1-based 闭区间，仅对匹配样本执行现有 LongMemEval 评测流程，并保留现有评测参数。

#### Scenario: 评测单个指定样本
- **WHEN** 用户执行 `sample` 子命令并传入一个有效 `question_id`
- **THEN** 系统生成仅含该样本的评测输入并返回 `totalSamples=1` 的评测结果

#### Scenario: 指定多个样本
- **WHEN** 用户重复传入 `--question-id` 或传入逗号分隔的多个 ID
- **THEN** 系统按原始数据集顺序评测去重后的匹配样本

#### Scenario: 样本 ID 不存在
- **WHEN** 任一指定 ID 不存在于数据集
- **THEN** CLI 输出明确错误并以非零退出码结束，不启动评测

#### Scenario: 评测样本区间
- **WHEN** 用户传入 `--sample-range start-end`，且 `start`、`end` 为合法整数并满足 `1 <= start <= end <= totalSamples`
- **THEN** 系统选择原始数据集中第 `start` 至第 `end` 条样本（两端包含）并返回对应数量的评测结果

#### Scenario: 评测单个样本索引
- **WHEN** 用户传入 `--sample-range index`，且 `1 <= index <= totalSamples`
- **THEN** 系统将其解释为 `index-index`，仅评测原始数据集中第 `index` 条样本

#### Scenario: 样本区间越界
- **WHEN** 区间缺少端点、起点大于终点或超出数据集范围
- **THEN** CLI 在评测启动前拒绝请求并以非零退出码报告边界错误

#### Scenario: 样本选择方式冲突
- **WHEN** 同时传入 `--question-id` 和 `--sample-range`
- **THEN** CLI 拒绝执行并提示只能选择一种样本定位方式

### Requirement: CLI 支持可复现的比例切分与跑分
系统 SHALL 从原始 LongMemEval JSON 数组按 `0 < ratio <= 1` 生成不修改原文件的子数据集，并使用子数据集完成评测。

#### Scenario: 按比例生成子集
- **WHEN** 用户执行 `split` 并传入合法 `--ratio`
- **THEN** 系统写出合法 LongMemEval JSON 数组，报告原始数量、选中数量、ratio、seed、输出路径和题型统计

#### Scenario: 相同参数可复现
- **WHEN** 对同一原始文件使用相同 ratio 和 seed 执行两次切分
- **THEN** 两次输出的 question_id 集合和顺序完全一致

#### Scenario: 切分后跑分
- **WHEN** 用户执行比例切分跑分命令并提供评测参数
- **THEN** 系统对生成的子集执行与全量评测相同的 ingestion、answer、judge、指标和 model-run 流程，结果中的 `datasetPath` 指向子集

#### Scenario: 比例非法
- **WHEN** ratio 缺失、非数字、等于 0 或大于 1
- **THEN** CLI 拒绝执行并以非零退出码报告参数错误

### Requirement: CLI 支持安全清除评测数据库
系统 SHALL 提供清除 LongMemEval 本地评测存储并按配置处理图数据库的 CLI 命令，且必须显式确认。

#### Scenario: 未确认清理
- **WHEN** 用户执行 `clear-db` 但未传入 `--yes`
- **THEN** 系统不删除任何数据，以非零退出码提示需要确认

#### Scenario: 确认后清理
- **WHEN** 用户执行 `clear-db --yes`
- **THEN** 系统调用既有清理能力，返回删除文件列表、本地存储目录和图存储清理/跳过状态

#### Scenario: JSON 清理结果
- **WHEN** 用户同时传入 `--json`
- **THEN** stdout 仅输出可解析 JSON，错误仍写入 stderr，且不包含 API key、密码或连接凭据

### Requirement: CLI 参数与结果契约稳定
系统 SHALL 保持旧的直接传入数据集路径的评测方式兼容，并为新增命令提供一致的错误码和输出模式。

#### Scenario: 旧命令兼容
- **WHEN** 用户不使用新子命令而直接传入数据集路径
- **THEN** 系统继续执行默认全量评测，行为与变更前一致

#### Scenario: 参数冲突
- **WHEN** 同时传入 `--question-id` 或 `--sample-range` 与 `--ratio`，或 split 缺少必要输出/比例参数
- **THEN** CLI 在评测启动前拒绝请求并报告冲突原因

### Requirement: CLI SHALL 提供 CI 非交互调用契约
系统 SHALL 支持 `--ci` 严格模式，使 benchmark job 能在无终端环境中稳定调用并消费结果。

#### Scenario: CI 模式输出
- **WHEN** 用户传入 `--ci`
- **THEN** CLI 关闭进度 stdout，stdout 仅输出一份可解析 JSON，所有日志和错误写入 stderr

#### Scenario: CI 模式确定性
- **WHEN** CI 执行比例切分但未显式传入 seed
- **THEN** CLI 拒绝执行并提示必须提供 seed，避免不同流水线产生不可比较的样本集

#### Scenario: CI 结果文件
- **WHEN** 用户传入 `--result <path>`
- **THEN** CLI 将最终 JSON 原子写入该路径，并在 stdout JSON 中返回结果文件路径和数据集/子集元信息

#### Scenario: 稳定退出码
- **WHEN** 命令成功、参数错误、评测失败或清理失败
- **THEN** CLI 分别返回稳定的 `0`、`2`、`3` 或 `4` 退出码
