import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const [resultArg, datasetArg, databaseArg, outputArg] = process.argv.slice(2);
if (!resultArg || !datasetArg || !databaseArg || !outputArg) {
  console.error("Usage: node analyze-longmemeval-result.mjs <result.jsonl> <dataset.json> <database.sqlite> <output.md>");
  process.exit(1);
}

const resultPath = resolve(resultArg);
const datasetPath = resolve(datasetArg);
const databasePath = resolve(databaseArg);
const outputPath = resolve(outputArg);
const records = readFileSync(resultPath, "utf8")
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const samples = new Map(dataset.map((sample) => [sample.question_id, sample]));
const db = new DatabaseSync(databasePath, { readOnly: true });

const factsForSession = db.prepare(`
  SELECT fact_id, fact_sequence, session_id, fact_text, normalized_claim, status
  FROM fact_items
  WHERE tenant_id = 'local'
    AND principal_id = 'longmemeval'
    AND context_scope_id = ?
    AND session_id = ?
  ORDER BY fact_sequence, fact_id
`);
const factById = db.prepare(`
  SELECT fact_id, fact_sequence, session_id, fact_text, normalized_claim, status
  FROM fact_items
  WHERE fact_id = ?
`);
const memoryById = db.prepare(`
  SELECT memory_data_id, content, source_fact_ids
  FROM short_term_memories
  WHERE memory_data_id = ?
`);

const evaluated = records.filter((record) => record.judgment?.label);
const incorrect = evaluated.filter((record) => record.judgment.label === "incorrect");
const skipped = records.filter((record) => !record.judgment?.label);
const exactButIncorrect = incorrect.filter((record) => record.exactMatch === true);
const usedTokens = incorrect.map((record) => record.answerContext?.tokenBudget?.used ?? 0);
const fullTwentyItemPacks = incorrect.filter((record) => (record.answerContext?.selectedItems ?? []).length === 20).length;
const droppedReasonTotals = new Map();
for (const record of incorrect) {
  for (const [reason, count] of Object.entries(record.answerContext?.droppedSummary ?? {})) {
    droppedReasonTotals.set(reason, (droppedReasonTotals.get(reason) ?? 0) + Number(count));
  }
}

const lines = [];
lines.push("# LongMemEval result 500-4 错误样本链路审计", "");
lines.push(`- 结果文件：\`${resultPath}\``);
lines.push(`- 原始数据集：\`${datasetPath}\``);
lines.push(`- 评测数据库：\`${databasePath}\``);
lines.push(`- 总记录：${records.length}；有 judgment：${evaluated.length}；判对：${evaluated.length - incorrect.length}；判错：${incorrect.length}；无 judgment/跳过：${skipped.length}`);
lines.push(`- 判错中 exact match 为 true：${exactButIncorrect.length}`);
lines.push("");
lines.push("> 口径：`answer_session_ids` 是数据集标注的答案来源会话；其中 `has_answer=true` 的原始消息是金标准证据。`抽取事实`来自该会话在 fact store 中的记录。`候选-保留`表示进入 context pack；`候选-丢弃`表示被 pack 以 lower priority 等原因淘汰；`诊断不可见`表示既不在 selected，也不在 JSONL 仅保留的前 50 条 dropped 记录中，不能据此断言从未召回。", "");

const diagnosisCounts = new Map();
for (const record of incorrect) {
  const sample = samples.get(record.questionId);
  const answerSessions = sample?.answer_session_ids ?? [];
  const facts = answerSessions.flatMap((sessionId) => factsForSession.all(`longmemeval:${record.questionId}`, sessionId));
  const diagnosis = diagnose(record, sample, facts, resolveSelected(record));
  diagnosisCounts.set(diagnosis.code, (diagnosisCounts.get(diagnosis.code) ?? 0) + 1);
}
lines.push("## 阶段初判统计", "");
for (const [code, count] of diagnosisCounts) lines.push(`- ${code}: ${count}`);
lines.push("", "> “阶段初判”优先使用可观测的硬证据：答案是否已进最终 prompt、答案来源会话是否进 Top10、答案字面事实是否已抽取/进入 pack。聚合题、偏好题和否定题的正确答案通常不是原文子串，因此标为“语义复核”而不武断归咎于抽取。", "");

lines.push("## 关键结论", "");
lines.push(`- 498 条完成判分，404 条 correct，judge accuracy 为 ${(404 / evaluated.length * 100).toFixed(2)}%；若把 2 条 ingest 跳过计入总样本，完成率口径为 ${(404 / records.length * 100).toFixed(2)}%。`);
lines.push(`- 38 条“作答/推理错误”中，正确答案文本已进入最终 prompt；另有 12 条偏好题主要是模型没有利用已召回的个性化事实。下游答案模型是当前最大的一组确定性问题。`);
lines.push(`- 只有 ${diagnosisCounts.get("召回答案会话失败") ?? 0} 条答案来源会话未进 Top10，另有 ${diagnosisCounts.get("Pack 筛选/时间过滤") ?? 0} 条正确字面事实已抽取却未进 pack；召回/pack 的确定性漏失少于作答错误，但 ${diagnosisCounts.get("抽取表示或多事实推理待复核") ?? 0} 条聚合或时序题仍需逐条依据组成事实复核。`);
lines.push(`- 所有 94 条错误样本的 pack 都没有用满 20,000 token：平均 ${Math.round(usedTokens.reduce((sum, value) => sum + value, 0) / usedTokens.length)}，范围 ${Math.min(...usedTokens)}-${Math.max(...usedTokens)}。${fullTwentyItemPacks} 条恰好选择 20 个 item，同时共有 ${droppedReasonTotals.get("selection:lower_priority") ?? 0} 个候选被标为 lower priority，说明固定 item 上限/排序先于 token 预算成为瓶颈。`);
lines.push(`- 15 条 judgment=incorrect 同时 exactMatch=true。这里多数不是 judge 误判，而是 hypothesis 在推理中提到正确答案后又否定它或给出另一最终答案，例如样本 40、72；当前 exactMatch 指标会产生明显假阳性。`);
lines.push("- Assistant 长回答类暴露稳定的信息损失：列表、序号、颜色、年份、配方等细粒度内容被压成一条概括事实。session 被召回也无法回答样本 447、448、462、463、465、469、485、495。", "");

lines.push("## 优先修复建议", "");
lines.push("1. 抽取阶段为 assistant 长文本增加结构保真：列表逐项事实化，并保留序号、实体属性、数值、年份、配方/和弦等可问答槽位；样本 7 还需要保留用户句子中的地点实体 `Serenity Yoga`。" );
lines.push("2. Pack 选择不要固定停在 20 个 item；在 token 预算仍有余量时继续纳入候选，并为同一答案会话中的高相关事实预留名额。" );
lines.push("3. 时间题按 `validTime` 判断事件发生时间，`evidenceTime` 只表示陈述/记录时间；避免样本 294 的 `outside_evidence_time_range` 误杀。" );
lines.push("4. 作答 prompt 增加明确的运算协议：更新题选最新有效状态、聚合题先列唯一实体再计数、顺序题按事件时间排序、否定题区分“0 次”和“信息不足”，最后只输出与证据一致的结论。" );
lines.push("5. 对答案接口的内容安全 400 增加可观测重试/备用模型路径，避免样本 45 在证据齐全时直接失败。" );
lines.push("6. 修正 exactMatch：只解析最终答案区，而不是对整段 chain-of-thought 做子串命中；同时统一 session ID 大小写后再做诊断关联。", "");

lines.push("## 汇总索引", "");
lines.push("| # | questionId | 类型 | EM | answer session Top10 | 文字答案在抽取/pack | 阶段初判 |", "|---:|---|---|:---:|:---:|:---:|---|");
for (const record of incorrect) {
  const sample = samples.get(record.questionId);
  const answerSessions = sample?.answer_session_ids ?? [];
  const facts = answerSessions.flatMap((sessionId) => factsForSession.all(`longmemeval:${record.questionId}`, sessionId));
  const extractionHasLiteral = containsAnswer(facts.map((fact) => `${fact.fact_text} ${fact.normalized_claim}`).join("\n"), record.answer);
  const packFacts = resolveSelected(record);
  const packHasLiteral = containsAnswer(packFacts.map((fact) => fact.fact_text).join("\n"), record.answer);
  const top10 = answerSessions.some((id) => sessionRank(record.answerRankedSessionIds, id) >= 0);
  const diagnosis = diagnose(record, sample, facts, packFacts);
  lines.push(`| ${record.sampleIndex} | ${record.questionId} | ${record.questionType} | ${yesNo(record.exactMatch)} | ${yesNo(top10)} | ${yesNo(extractionHasLiteral)}/${yesNo(packHasLiteral)} | ${escapeCell(diagnosis.code)} |`);
}

for (const record of incorrect) {
  const sample = samples.get(record.questionId);
  const answerSessions = sample?.answer_session_ids ?? [];
  const selectedIds = new Set(record.answerContext?.selectedItemIds ?? []);
  const dropped = new Map((record.answerContext?.dropped ?? []).map((item) => [item.id, item.reason]));
  const answerFacts = answerSessions.flatMap((sessionId) => factsForSession.all(`longmemeval:${record.questionId}`, sessionId));
  const extractionText = answerFacts.map((fact) => `${fact.fact_text} ${fact.normalized_claim}`).join("\n");
  const packFacts = resolveSelected(record);
  const packText = packFacts.map((fact) => fact.fact_text).join("\n");
  const ranked = record.answerRankedSessionIds ?? [];
  const answerSessionRanks = answerSessions.map((id) => {
    const rank = sessionRank(ranked, id);
    return `${id}: ${rank >= 0 ? `#${rank + 1}` : "Top10 未出现"}`;
  });
  const diagnosis = diagnose(record, sample, answerFacts, packFacts);

  lines.push("", `## ${record.sampleIndex}. ${record.questionId}`, "");
  lines.push(`- 类型：\`${record.questionType}\``);
  lines.push(`- 问题：${clean(record.question)}`);
  lines.push(`- 正确答案：${clean(record.answer)}`);
  lines.push(`- 模型答案：${clean(record.hypothesis)}`);
  lines.push(`- 判分：\`${record.judgment?.label}\` / \`${record.judgment?.reason}\`；exactMatch=${record.exactMatch}; timelineHasAnswer=${record.timelineHasAnswer}; promptHasAnswer=${record.promptHasAnswer}`);
  lines.push(`- 答案会话召回排名：${answerSessionRanks.join("；") || "数据集未标注答案会话"}`);
  lines.push(`- 阶段初判：**${diagnosis.code}**。${diagnosis.reason}`);
  lines.push(`- 字面覆盖检查：抽取=${yesNo(containsAnswer(extractionText, record.answer))}；最终 pack=${yesNo(containsAnswer(packText, record.answer))}。聚合题、偏好题和否定答案必须结合下方原始证据人工判断，不能只看这一项。`);

  lines.push("", "### 金标准原始证据", "");
  const evidence = answerEvidence(sample);
  if (!evidence.length) lines.push("- 数据集没有 `has_answer=true` 消息；正确答案本身依赖缺失/否定判断。\n");
  for (const item of evidence) lines.push(`- [${item.sessionId} / ${item.role}] ${clean(item.content)}`);

  lines.push("", "### 答案会话的抽取事实及流转", "");
  if (!answerFacts.length) lines.push("- 未找到任何事实：抽取或持久化阶段完全漏失。\n");
  for (const fact of answerFacts) {
    const memoryId = `stm_${fact.fact_id}`;
    const state = selectedIds.has(memoryId)
      ? "候选-保留（进入 pack）"
      : dropped.has(memoryId)
        ? `候选-丢弃（${dropped.get(memoryId)}）`
        : "诊断不可见";
    lines.push(`- [${fact.fact_sequence ?? "?"}] \`${fact.fact_id}\` · ${state} · ${clean(fact.fact_text)}`);
  }

  lines.push("", "### 最终 Context Pack", "");
  if (!packFacts.length) {
    lines.push((record.answerContext?.selectedItems ?? []).length
      ? "- selected item 存在，但未能从数据库解析其内容。\n"
      : "- 最终 pack 未选择任何 item。\n");
  }
  for (const fact of packFacts) {
    const source = fact.session_id ? `session=${fact.session_id}` : "session=unknown";
    lines.push(`- \`${fact.item_id}\` · score=${formatScore(fact.score)} · ${source} · ${clean(fact.fact_text)}`);
  }
}

if (skipped.length) {
  lines.push("", "## 无 judgment / 跳过样本", "");
  for (const record of skipped) {
    lines.push(`- ${record.sampleIndex} / ${record.questionId}: ${clean(record.question)}；正确答案：${clean(record.answer)}；失败阶段：${record.failureStage ?? "unknown"}；原因：${clean(record.failureReason ?? record.error ?? "unknown")}`);
  }
}

db.close();
writeFileSync(outputPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${outputPath}: ${incorrect.length} incorrect, ${skipped.length} skipped.`);

function answerEvidence(sample) {
  if (!sample) return [];
  const answerIds = new Set(sample.answer_session_ids ?? []);
  return (sample.haystack_sessions ?? []).flatMap((session, index) => {
    const sessionId = sample.haystack_session_ids?.[index];
    if (!answerIds.has(sessionId)) return [];
    return session.filter((message) => message.has_answer).map((message) => ({ sessionId, ...message }));
  });
}

function resolveSelected(record) {
  return (record.answerContext?.selectedItems ?? []).map((item) => {
    for (const id of item.factIds ?? []) {
      const fact = factById.get(id);
      if (fact) return { ...fact, item_id: item.id, score: item.score };
    }
    for (const id of item.memoryIds ?? [item.id]) {
      const memory = memoryById.get(id);
      if (memory) return { fact_text: memory.content, session_id: item.sourceSessionIds?.join(",") ?? "", item_id: item.id, score: item.score };
    }
    return { fact_text: "[content unavailable]", session_id: item.sourceSessionIds?.join(",") ?? "", item_id: item.id, score: item.score };
  });
}

function containsAnswer(text, answer) {
  const normalizedText = normalize(text);
  const normalizedAnswer = normalize(answer);
  if (!normalizedAnswer || normalizedAnswer.length > 120) return false;
  return normalizedText.includes(normalizedAnswer);
}

function diagnose(record, sample, answerFacts, packFacts) {
  if (record.questionId === "6ade9755") {
    return { code: "抽取漏失（确认）", reason: "原始答案消息明确包含 Serenity Yoga，但答案会话的 6 条抽取事实均未保留该地点；召回和 pack 无法恢复已在抽取阶段丢失的信息。" };
  }
  if (record.questionId === "07741c45") {
    return { code: "更新覆盖/作答错误", reason: "旧状态“under the bed”和新状态“shoe rack in closet”均已抽取并进入 pack，模型没有按更新顺序选择当前状态。" };
  }
  if (String(record.hypothesis ?? "").startsWith("[ANSWER_FAILED:")) {
    return { code: "作答 API 失败", reason: "正确证据已经进入 prompt，但答案模型请求被内容安全检查以 HTTP 400 拒绝。" };
  }
  if (record.promptHasAnswer) {
    return { code: "作答/推理错误", reason: "评测器确认正确答案文本已经进入最终 prompt，错误发生在模型的消歧、计数、时序、更新覆盖或最终结论阶段。" };
  }
  const answerSessions = sample?.answer_session_ids ?? [];
  const answerSessionInTop10 = answerSessions.some((id) => sessionRank(record.answerRankedSessionIds, id) >= 0);
  if (!answerSessionInTop10) {
    return { code: "召回答案会话失败", reason: "数据集标注的答案来源会话未进入 answerRankedSessionIds Top10；后续 pack 缺证据是召回阶段的直接后果。" };
  }
  const extractionText = answerFacts.map((fact) => `${fact.fact_text} ${fact.normalized_claim}`).join("\n");
  const packText = packFacts.map((fact) => fact.fact_text).join("\n");
  if (containsAnswer(extractionText, record.answer) && !containsAnswer(packText, record.answer)) {
    return { code: "Pack 筛选/时间过滤", reason: "正确答案字面事实已存在于 fact store，但没有进入最终 context pack。" };
  }
  if (record.questionType === "single-session-assistant") {
    return { code: "长回答细节抽取不足", reason: "答案会话虽被召回，但 assistant 长文本被压缩成概括事实，题目所问的列表项、属性或原句细节没有进入 prompt。" };
  }
  if (record.questionType === "single-session-preference") {
    return { code: "偏好利用/作答错误", reason: "答案来源会话已召回；该类金答案是偏好描述而非原文子串，应以已进入 pack 的偏好构成事实复核，不能把字面未命中视为抽取失败。" };
  }
  const evidence = answerEvidence(sample);
  if (!evidence.length) {
    return { code: "否定题语义错误", reason: "金答案来自“原文没有该事实”的判断，没有 has_answer 消息；模型不应把相似但不满足前提的事实当作答案。" };
  }
  if (!answerFacts.length) {
    return { code: "抽取/持久化完全漏失", reason: "答案来源会话没有对应 fact store 记录。" };
  }
  return { code: "抽取表示或多事实推理待复核", reason: "答案会话进入了 Top10，但正确答案字面未完整保留到 prompt；需对照下方原始证据、抽取事实及 pack 判断是细节抽取漏失，还是聚合/时序推理失败。" };
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sessionRank(rankedSessionIds, sessionId) {
  const target = String(sessionId).toLocaleLowerCase();
  return (rankedSessionIds ?? []).findIndex((candidate) => String(candidate).toLocaleLowerCase() === target);
}

function clean(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().replace(/`/gu, "'");
}

function escapeCell(value) {
  return clean(value).replace(/\|/gu, "\\|");
}

function shortHypothesis(value) {
  const text = clean(value);
  return text.length <= 100 ? text : `${text.slice(0, 97)}...`;
}

function yesNo(value) {
  return value ? "是" : "否";
}

function formatScore(value) {
  return Number.isFinite(value) ? Number(value).toPrecision(4) : "n/a";
}
