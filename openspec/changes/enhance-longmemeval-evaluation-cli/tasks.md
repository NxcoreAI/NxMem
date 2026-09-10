## 1. 数据集选择与切分模块

- [x] 1.1 抽取 LongMemEval JSON 数组读取、`question_id` 去重过滤、1-based 闭区间选择和题型统计逻辑，定义包含原始数、选中数、seed、输出路径的元数据类型。
- [x] 1.2 实现基于固定 seed 的题型分层比例抽样，校验 ratio 范围，并保持输出样本的原始顺序与结构。
- [x] 1.3 实现子集文件输出、临时文件生命周期和输出路径解析，确保原始数据集只读。
- [x] 1.4 为过滤、未找到 ID、比例边界、相同 seed 可复现、题型覆盖和文件输出补充单元测试。

## 2. CLI 命令分派与评测集成

- [x] 2.1 扩展 `longmemeval-cli.ts` 参数解析，兼容旧的直接数据集路径，并增加 `sample`、`split`、`clear-db` 子命令及共享评测选项。
- [x] 2.2 将 `sample` 选择结果和 `split` 生成结果接入现有单模型/多模型评测入口，确保 `datasetPath`、进度和 JSON 报告指向实际子集。
- [x] 2.3 实现参数冲突、缺失参数和非法值校验，统一 stderr 错误信息与非零退出码。
- [x] 2.4 统一普通文本和 `--json` 输出，补充子集元数据、命令类型和评测摘要，避免 JSON 模式混入进度文本。
- [x] 2.5 为命令分派、旧命令兼容、样本评测和比例切分跑分增加 CLI 集成测试。
- [x] 2.6 支持 `--sample-range start-end`，校验边界并拒绝与 `--question-id`/`--ratio` 混用。
- [x] 2.7 实现 `--ci` 严格模式、稳定退出码和 stderr/stdout 分流，支持 `--result` 结果文件的原子写入。
- [x] 2.8 为 CI 模式补充无 TTY、缺少 seed、结果文件、区间选择和各类退出码测试。

## 3. 数据库清理命令

- [x] 3.1 在 CLI 中接入 `clearLongMemEvalData`，实现 `--yes` 显式确认和未确认时的安全拒绝。
- [x] 3.2 输出本地存储删除文件与 Neo4j cleared/skipped 状态，并过滤敏感连接信息。
- [x] 3.3 为确认开关、JSON 输出、清理异常和本地/Neo4j 两种配置补充测试。

## 4. 验证与文档

- [x] 4.1 更新 README 或后端 CLI 使用说明，记录三种新命令、参数示例、默认 seed、临时文件和清理前置条件。
- [x] 4.2 增加 CI 调用示例，说明 `--sample-range`、固定 seed、`--ci --result`、结果归档和失败退出码处理。
- [x] 4.3 运行后端类型检查和 LongMemEval 相关测试，修复回归。
- [x] 4.4 运行 `openspec status --change enhance-longmemeval-evaluation-cli` 与 `openspec validate enhance-longmemeval-evaluation-cli`，确认变更达到可实施状态。
