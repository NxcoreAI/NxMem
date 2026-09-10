## ADDED Requirements

### Requirement: 系统 SHALL 原生解析 LoCoMo 数据而不转换为 LongMemEval sample
系统 SHALL 将 LoCoMo 顶层 sample 解析为一个共享长对话及其问题集合，并根据固定字段映射生成稳定的 conversation、session、turn、question、scope 和评分身份。

#### Scenario: 解析完整固定数据集
- **WHEN** 系统读取仓库固定 SHA-256 的 `locomo10.json`
- **THEN** 系统报告 10 个 conversation、272 个 session、5,882 个 turn、1,986 道 QA、各 category 数量和 evidence 缺失数量，并保留原始顺序

#### Scenario: 映射问题身份和评分字段
- **WHEN** sample `sample_id=S` 的第 N 道 QA 包含 question、answer、evidence 和 category
- **THEN** 系统生成稳定 `questionId=S:qN`，将 question 作为 query/task，将 answer 无损转为 reference string，将 evidence 规范化为 gold dia IDs，并只把 category 保存到 scorer/report sidecar

#### Scenario: 映射 session 和 turn
- **WHEN** conversation 包含 `session_N`、对应日期及带 speaker、dia_id、text、blip_caption 的 turn
- **THEN** 系统按 N 数值升序生成事件，保留 dia_id/source identity、speaker、文本、ISO 时间和 caption，且不请求 img_url

#### Scenario: 输入字段非法
- **WHEN** session 时间无法解析、dia_id 重复或缺失、category 不在 1..5、answer 不能无损转换为 string
- **THEN** 系统在写入 Store 前报告具体 sample/session/question 并拒绝运行

### Requirement: 系统 SHALL 对每个长对话执行一次隔离的 Fact/STM 准备流程
系统 SHALL 为每个 conversation 使用稳定 tenant、principal 和 context scope，按 session 时间顺序执行原始消息解析、Fact 抽取、Session 时间轴聚合、STM 准入和索引刷新，并且同一 conversation 不因问题数量重复摄入。

#### Scenario: 一个长对话挂载多道问题
- **WHEN** 一个 conversation 包含多个 session 和 200 道 QA
- **THEN** 系统只摄入该 conversation 的每个 session 一次，全部准备成功后复用同一 scope 回答 200 道题

#### Scenario: 两个长对话共享 repository
- **WHEN** conversation A 与 B 被写入同一次 benchmark run 的 Store
- **THEN** A、B 使用不同 principalId 和 contextScopeId，查询 A 不返回 B 的 Fact、STM、source ref 或 Context Pack item

#### Scenario: session 准备失败
- **WHEN** conversation 任一 session 在允许的重试后仍无法完成 Fact/STM 流程
- **THEN** 系统不在半完成 Store 上回答问题，将该 conversation 下所有 QA 记录为 skipped 并继续其他 conversation

#### Scenario: Gold 数据不进入 Store
- **WHEN** 系统准备 LoCoMo conversation
- **THEN** 输入 Context Engine 的内容只来自 conversation，repository 中不存在由 qa.answer、qa.evidence、qa.category 或 observation claim 直接创建的 Fact/STM/索引

### Requirement: 首版 LoCoMo profile SHALL 不执行或召回 LTM
系统 SHALL 将首版执行配置固定为 `locomo-fact-stm-v1`，不启动 dreaming/consolidation，不生成 LTM，且答题候选和 Context Pack 只允许 Fact 与 STM。

#### Scenario: 完成 conversation 准备
- **WHEN** 一个 conversation 的全部 session 完成 Fact/STM 准备
- **THEN** 系统验证该 scope 的 LTM 数量为 0 后才进入问题评测

#### Scenario: 候选出现 LTM
- **WHEN** 召回、重排或 Context Pack 中出现 `layer=ltm`
- **THEN** 系统将该题标记为不变量失败，不使用该候选生成答案

#### Scenario: 用户尝试启用 LTM
- **WHEN** 用户向首版 `eval:locomo` 传入未定义的 LTM 开关
- **THEN** CLI 拒绝参数而不是在相同 profile 名称下静默改变执行链路

### Requirement: 系统 SHALL 在完整长对话准备后逐题构造隔离的 Context Pack
系统 SHALL 在 conversation 全部 session 准备完成后，对每道 QA 使用 question、tenant、principal、contextScopeId 和 conversation referenceTime 执行召回、可选重排、证据预算选择及 Context Pack 构造。

#### Scenario: 构造问题 Context Pack
- **WHEN** conversation 准备成功且系统评测其中一道 QA
- **THEN** 系统返回候选、selected/dropped items、Fact/STM 关联、时间信息、citations、conflicts、token usage 和 serialized prompt，并只包含当前 conversation scope

#### Scenario: category 不泄漏到答题链路
- **WHEN** 两道题的 question 文本和 scope 相同但 category sidecar 不同
- **THEN** 两次召回、证据选择和答案 prompt 输入相同，category 仅导致评分函数和分类汇总不同

#### Scenario: 多道问题并发执行
- **WHEN** 一个已冻结的 conversation scope 下并发评测多道 QA
- **THEN** 问题阶段不修改 Fact、STM 或索引，结果按 question identity 幂等提交并按原始顺序汇总

#### Scenario: Conversation 级准备屏障
- **WHEN** 一次 full 运行选择多个 conversation，且前一个 conversation 已完成全部 session 准备
- **THEN** 系统立即评测该 conversation 的目标 QA，再进入下一个 conversation，不等待所有选中 conversation 完成准备

### Requirement: 系统 SHALL 复用数据集无关的答题上下文策略且保持 LongMemEval 兼容
系统 SHALL 将现有 LongMemEval 答题候选选择和 Context Pack 构造抽取为显式接收 scope、层级和预算的数据集无关能力，并通过兼容 wrapper 保持 LongMemEval 默认输出。

#### Scenario: LongMemEval 兼容回归
- **WHEN** 抽取共享 helper 前后对固定 LongMemEval fixture 执行评测
- **THEN** session identity、候选顺序、selected IDs、serialized prompt hash 和纯函数指标完全一致

#### Scenario: LoCoMo 显式限制 scope 和层级
- **WHEN** LoCoMo runner 调用共享 helper
- **THEN** helper 使用传入的 LoCoMo questionId、tenantId、principalId、contextScopeId、referenceTime 和 `allowedLayers=[fact,stm]`，不自行生成 LongMemEval scope

### Requirement: 系统 SHALL 按固定上游实现计算 LoCoMo 官方分数
系统 SHALL 使用版本化 TypeScript 纯函数复刻固定 LoCoMo 上游 commit 的归一化、Porter stemming、category scorer、逐题三位小数和按题数加权汇总规则。

#### Scenario: Category 1 多答案评分
- **WHEN** reference 和 hypothesis 包含逗号分隔的多个子答案
- **THEN** scorer 对每个 reference 子答案取 hypothesis 子答案中的最大 token F1，再对 reference 子答案求平均并 round 到三位小数

#### Scenario: Category 2 或 4 普通评分
- **WHEN** category 为 2 或 4
- **THEN** scorer 对完整 reference 与 hypothesis 计算归一化 token F1

#### Scenario: Category 3 核心答案评分
- **WHEN** category 3 reference 包含分号和解释
- **THEN** scorer 只使用第一个分号前的 trimmed reference 与完整 hypothesis 计算 token F1

#### Scenario: Category 5 正确拒答
- **WHEN** category 5 hypothesis 不区分大小写地包含 `no information available` 或 `not mentioned`
- **THEN** scorer 返回 1，否则返回 0

#### Scenario: 与上游评分交叉验证
- **WHEN** 固定 prediction fixture 同时通过上游 Python scorer 和 TypeScript scorer
- **THEN** 每道题三位小数分数、category average 和 overall average 完全一致

#### Scenario: 汇总官方得分
- **WHEN** 全部可评分问题完成
- **THEN** overall official QA score 等于所有逐题 rounded score 的算术平均，category score 等于该类题目的平均，并额外报告 score=1 的 perfectScoreRate

### Requirement: Gold evidence SHALL 只用于执行后的评估与漏斗诊断
系统 SHALL 在召回和 Context Pack 完成后使用 gold dia IDs 计算证据覆盖，不得让 evidence 或 observation 影响摄入、查询、排序、选择或回答。

#### Scenario: 计算 Retrieval Evidence Recall
- **WHEN** 候选 source refs 包含当前问题部分 gold dia IDs
- **THEN** 系统报告 recall、recallAny 和 recallAll，并保留逐个 gold dia ID 的命中位置

#### Scenario: 计算 Context Pack Evidence Recall
- **WHEN** 最终 Context Pack 只保留部分已召回 gold evidence
- **THEN** 系统分别报告 retrieval recall、pack recall 和从 retrieval 到 pack 的 evidence retention rate

#### Scenario: 无 evidence 的问题
- **WHEN** QA 没有 evidence，包含官方 adversarial case
- **THEN** 系统仍执行回答和官方评分，但将 evidence metrics 标记为 not-evaluable，不把它按 0 计入 evidence recall 分母

### Requirement: CLI SHALL 提供独立、可恢复和可审计的 LoCoMo 评测入口
系统 SHALL 新增 `eval:locomo` 的 full、prepare、evaluate 命令，使用独立 Store 和版本 fingerprint，并输出逐题 JSONL 与汇总 JSON。

#### Scenario: Full 运行
- **WHEN** 用户执行 full 并指定合法 dataset、Store 和结果路径
- **THEN** 系统依次准备选中 conversation、评测其 QA、原子提交逐题结果，并输出官方分数和阶段漏斗汇总

#### Scenario: Prepare 后 Evaluate
- **WHEN** 用户先 prepare 再对同一 fingerprint Store 执行 evaluate
- **THEN** evaluate 以只读方式复用 Fact/STM，不重新摄入 conversation，结果与同配置 full 的 deterministic fixture 一致

#### Scenario: Store fingerprint 不匹配
- **WHEN** dataset hash、profile、embedding、reranker、模型、prompt 或 schema fingerprint 与准备 Store 不一致
- **THEN** evaluate 在回答问题前拒绝复用并报告具体不匹配字段

#### Scenario: 恢复中断运行
- **WHEN** result JSONL 已包含部分 question 的合法终态且用户启用 resume
- **THEN** 系统校验 dataset/config/store identity，跳过已有终态并从第一个目标 question 继续，且不重复摄入已完成 conversation

#### Scenario: CI 输出
- **WHEN** 用户传入 `--ci`
- **THEN** stdout 只包含最终机器可读 JSON，进度写入 stderr，结果文件使用临时文件和 rename 原子提交

### Requirement: 前端 SHALL 通过统一评测面板选择原生数据集链路
系统 SHALL 在同一个前端评测面板中提供独立的数据集类型字段和共享的数据集路径字段，并根据用户显式选择的类型进入 LoCoMo 或 LongMemEval 专用链路，不得根据路径内容隐式判断或在两种格式之间转换数据。

#### Scenario: 选择 LoCoMo 链路
- **WHEN** 用户在数据集类型字段选择 LoCoMo 并提供数据集路径
- **THEN** 面板复用 LongMemEval 的模型配置和连通性测试，附加展示 LoCoMo 的 conversation、题数、Store 和官方 F1 结果，并向 LoCoMo 专用接口提交任务

#### Scenario: LoCoMo 使用共享模型配置
- **WHEN** 用户为 LoCoMo 设置提取模型端点、模型名或 Key 并运行评测
- **THEN** LoCoMo 专用链路将该配置同时用于长对话事实抽取和问题答案生成，官方 token F1 评分不调用 Judge 模型

#### Scenario: 选择 LongMemEval 链路
- **WHEN** 用户在数据集类型字段选择 LongMemEval 并提供数据集路径
- **THEN** 面板展示现有 LongMemEval 模型、Context Pack、Judge、JSONL 和调试视图，并保持原提交参数不变

#### Scenario: 选择类型不匹配数据集格式
- **WHEN** 用户选择的数据集类型与路径对应的原生 JSON 格式不匹配
- **THEN** 对应专用后端链路拒绝输入并返回该格式的校验错误

### Requirement: 新增链路 SHALL 保持现有评测入口与基线不变
系统 SHALL 保留现有 `eval:longmemeval` 和 `eval:locomo-retrieval` 的默认命令、profile、结果契约和基线指标。

#### Scenario: Oracle LoCoMo retrieval 回归
- **WHEN** 变更前后使用固定 Store 和前 50/200 题运行 `eval:locomo-retrieval`
- **THEN** case/gold 数量以及 Recall、MRR、NDCG 与保存的 golden 完全一致

#### Scenario: LongMemEval 回归
- **WHEN** 变更前后使用 deterministic fixture 运行 LongMemEval
- **THEN** ingestion、候选、Context Pack、prompt、judge 输入和聚合指标保持一致
