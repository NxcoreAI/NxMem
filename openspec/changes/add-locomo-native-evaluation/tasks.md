## 1. 基线与数据适配契约

- [x] 1.1 固定当前 LongMemEval characterization fixtures，记录 session identity、候选顺序、Context Pack selected IDs、serialized prompt hash 和聚合指标。
- [x] 1.2 固定当前 `eval:locomo-retrieval` 前 50/200 题 golden，记录 dataset/store fingerprint、case/gold 数量、Recall、MRR 和 NDCG。
- [x] 1.3 新增 `locomo-dataset.ts`，实现 Conversation/Question 两级域模型及 proposal 中的完整字段映射，不生成 LongMemEval sample。
- [x] 1.4 对 `sample_id`、session 顺序/时间、dia_id、speaker/text/caption、answer 类型、evidence 和 category 实现严格校验及稳定 identity。
- [x] 1.5 为固定数据集统计、数字答案、复合 evidence、图片 caption、无 evidence、非法日期、重复 dia_id 和非法 category 补充测试。

## 2. 数据集无关答题上下文能力

- [x] 2.1 将 LongMemEval 当前候选召回、证据预算选择和专用 Context Pack 构造抽取为 `buildBenchmarkAnswerContext`，显式接收 question/scope/referenceTime/allowedLayers/预算和模型依赖。
- [x] 2.2 保留 LongMemEval 兼容 wrapper 和原默认参数，确保 characterization fixtures 在抽取前后完全一致。
- [x] 2.3 补齐 `contextScopeId` 从 Context Pack 请求到 `searchContext` 的透传，并确保 tenant、principal、context scope 同时生效。
- [x] 2.4 支持显式 `allowedLayers=[fact,stm]`，候选、重排、selected items 和 serialized prompt 均不得混入未允许层。
- [x] 2.5 为跨 scope 负向查询、Fact/STM 混合选择、token budget、citations/conflicts、时间字段和 LTM 拒绝补充聚焦测试。

## 3. LoCoMo 长对话准备执行器

- [x] 3.1 新增 `locomo-evaluation.ts`，按 conversation 建立 tenant/principal/contextScopeId，并使用独立 run Store/graph namespace。
- [x] 3.2 按 session 数值顺序将原始 turn 和 caption 转成 MemoryEvent/segments，复用生产 Fact extraction、Session 时间轴聚合、STM admission 和索引刷新能力。
- [x] 3.3 确保端到端执行器不调用 `ingestLocomoObservationFacts`，不读取 qa.answer/category/evidence/observation 作为运行输入。
- [x] 3.4 实现 session stage 重试、conversation 完整性检查和失败后整组 QA skipped；成功后冻结 scope 再进入问题阶段。
- [x] 3.5 固定 `locomo-fact-stm-v1` profile：不启动 dreaming，准备后断言 LTM=0，问题候选出现 LTM 即失败。
- [x] 3.6 写入 Store manifest，包含 dataset、profile、schema、embedding、reranker、模型和 prompt fingerprint，并在只读复用时逐项校验。
- [x] 3.7 为同一 conversation 只摄入一次、两个 conversation 共库隔离、session 失败、Gold 泄漏扫描、无 LTM 和 fingerprint mismatch 补充集成测试。

## 4. 逐题召回、Context Pack 与回答

- [x] 4.1 在 conversation 全部 session 准备完成后，按原始 QA 顺序建立 question run，并仅向答题上下文 helper 传 question、scope、referenceTime 和固定 profile 参数。
- [x] 4.2 支持已冻结 scope 下的问题并发，禁止问题阶段修改 Fact/STM/索引，并保持结果幂等提交和稳定汇总顺序。
- [x] 4.3 复用当前答案生成模型调用和统一的证据不足拒答规则；不得根据 category 特判 answer prompt。
- [x] 4.4 保存最多 100 个真实候选、重排顺序、Context Pack selected/dropped、Fact/STM/source 映射、token usage、serialized prompt/hash、hypothesis 和 fallback。
- [x] 4.5 使用 gold dia IDs 计算 retrieval/pack recall、any/all、排名和 evidence retention；无 evidence 问题标记 not-evaluable。
- [x] 4.6 输出 Fact extraction evidence coverage、STM admission coverage、retrieval coverage、pack coverage 和 answer score 的逐题及聚合漏斗。
- [x] 4.7 为 category 不泄漏、跨 session 多证据、时间问题、无证据拒答、单题失败隔离和 deterministic answer replay 补充测试。
- [x] 4.8 将 full/evaluate 调度改为 conversation 级准备屏障，当前 conversation 冻结后立即答题，并验证下一 conversation 不会提前摄入且最终顺序稳定。

## 5. LoCoMo 官方评分器

- [x] 5.1 新增 `locomo-official-scorer.ts`，实现官方小写、逗号/标点/articles/空白归一化和与 NLTK 对齐的 Porter stemming。
- [x] 5.2 实现 category 1 多答案最大匹配平均 token F1、category 2/4 普通 token F1、category 3 reference 分号截断及 category 5 官方拒答短语评分。
- [x] 5.3 实现逐题三位小数、按 category 平均、全部问题自然加权 overall，以及 `perfectScoreRate`，避免把平均 F1 标为二元正确率。
- [x] 5.4 从固定上游 commit 构建跨语言 prediction fixtures，要求 TypeScript 与官方 Python scorer 每题和聚合结果完全一致。
- [x] 5.5 覆盖重复 token、词序变化、词干、标点、articles、多答案缺失/冗余、分号解释、大小写拒答和语义正确但非官方短语拒答测试。

## 6. CLI、结果与恢复

- [x] 6.1 新增 `locomo-evaluation-cli.ts` 和 `eval:locomo` package script，实现 `full`、`prepare`、`evaluate`。
- [x] 6.2 支持 dataset、sample ID/range、Store、result、trace、resume/retry-skipped、并发、模型和 CI 参数，拒绝未定义的 LTM 开关和冲突参数。
- [x] 6.3 实现逐题 JSONL 幂等 commit、尾部损坏容错、dataset/config/store identity 校验和 conversation-aware resume。
- [x] 6.4 输出版本化汇总 JSON：数据量、profile/fingerprint、category scores、overall official QA score、perfect score rate、Evidence Recall 和 pipeline funnel。
- [x] 6.5 为 full、prepare/evaluate 等价性、只读 Store、resume、fingerprint mismatch、原子输出、stdout/stderr 分流和退出码补充 CLI 测试。
- [x] 6.6 将 LoCoMo 与 LongMemEval 收敛到同一前端评测面板，通过独立的数据集类型字段显式选择专用链路，并保留共享的数据集路径字段及各自配置和结果视图。
- [x] 6.7 LoCoMo 复用统一面板的模型配置与连通性测试，将提取模型覆盖传入事实抽取和答案生成，同时保持官方 token F1 评分不调用 Judge。

## 7. 回归验证与文档

- [ ] 7.1 运行后端 typecheck、Context Engine 聚焦测试、LongMemEval 全套相关测试和 LoCoMo 新增测试。
- [x] 7.2 重跑 LongMemEval characterization 和 Oracle LoCoMo retrieval golden，确认现有入口、候选、Context Pack 和指标不变。
- [x] 7.3 使用 deterministic extraction/answer fixtures 完成至少两个 conversation 的端到端测试，验证无 Gold 泄漏、无跨 scope 召回和无 LTM。
- [ ] 7.4 使用真实服务运行小样本 smoke test，确认无 fallback、Store manifest 完整、逐题结果和汇总可审计；不将实时模型输出作为精确 golden。
- [x] 7.5 更新 README/benchmark runbook，说明三条评测命令的不同语义、字段映射、官方分数含义、首版无 LTM、复现条件和结果解读。
- [x] 7.6 安装可用的 OpenSpec CLI 后运行 `openspec status --change add-locomo-native-evaluation` 和 `openspec validate add-locomo-native-evaluation`，修复全部格式或依赖问题。
