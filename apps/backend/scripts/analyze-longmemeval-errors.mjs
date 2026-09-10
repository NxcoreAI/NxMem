#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const resultPath = resolve(root, process.argv[2] ?? "apps/backend/data/longmemeval-result-500-valid.jsonl");
const datasetPath = resolve(root, "datasets/LongMemEval/longmemeval_s_cleaned.json");
const databasePath = resolve(root, "data/longmemeval/9b6954375d3c.sqlite");
const resultStem = basename(resultPath).replace(/\.jsonl$/u, "");
const reportPath = resolve(root, process.argv[3] ?? `docs/${resultStem}-error-analysis.md`);
const jsonPath = reportPath.replace(/\.md$/u, ".json");

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "before", "but", "by", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "i", "in", "into", "is", "it", "me", "my", "of",
  "on", "or", "that", "the", "this", "to", "was", "were", "what", "when", "where", "which", "who",
  "with", "would", "you", "your"
]);

function readJsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function normalizeSessionId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9$%]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokens(value) {
  return new Set(normalizeText(value).split(" ").filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

function overlapScore(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return (2 * common) / (a.size + b.size);
}

function splitSentences(content) {
  return String(content ?? "")
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((value) => value.trim())
    .filter((value) => value.length >= 8);
}

function shorten(value, limit = 420) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function markdown(value) {
  return String(value ?? "")
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/\r?\n/gu, "<br>");
}

function sourceSessionIds(row) {
  if (!row) return [];
  try {
    return JSON.parse(row.linked_source_refs ?? "[]")
      .map((ref) => ref?.metadata?.sessionId)
      .filter(Boolean)
      .map(normalizeSessionId);
  } catch {
    return [];
  }
}

function factMatches(excerpts, facts) {
  return excerpts.map((excerpt) => {
    let best = null;
    for (const fact of facts) {
      const score = overlapScore(excerpt.text, fact.fact_text);
      if (!best || score > best.score) best = { excerpt: excerpt.text, factId: fact.fact_id, factText: fact.fact_text, score };
    }
    return best;
  });
}

function selectEvidenceExcerpts(session, question, answer, questionType) {
  const queryTokens = tokens(question);
  const answerTokens = tokens(answer);
  const normalizedAnswer = normalizeText(answer);
  const candidates = [];
  for (const message of session.messages) {
    for (const sentence of splitSentences(message.content)) {
      const sentenceTokens = tokens(sentence);
      let questionHits = 0;
      let answerHits = 0;
      for (const token of sentenceTokens) {
        if (queryTokens.has(token)) questionHits += 1;
        if (answerTokens.has(token)) answerHits += 1;
      }
      const containsReferenceAnswer = normalizedAnswer.length >= 4 && normalizeText(sentence).includes(normalizedAnswer);
      if (containsReferenceAnswer) answerHits = Math.max(answerHits, 1);
      const score = questionHits * 2 + answerHits * 3 + (containsReferenceAnswer ? 20 : 0) + (message.role === "user" ? 0.25 : 0);
      candidates.push({ role: message.role, text: sentence, score, questionHits, answerHits, containsReferenceAnswer });
    }
  }
  const roleCandidates = questionType === "single-session-assistant"
    ? candidates.filter((candidate) => candidate.role === "assistant")
    : candidates.filter((candidate) => candidate.role === "user");
  const ranked = roleCandidates.length ? roleCandidates : candidates;
  ranked.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  const selected = [];
  const addCandidate = (candidate) => {
    if (!candidate) return;
    if (selected.some((item) => normalizeText(item.text) === normalizeText(candidate.text) || overlapScore(item.text, candidate.text) > 0.85)) return;
    selected.push(candidate);
  };
  const questionAnchor = [...ranked].sort((a, b) => b.questionHits - a.questionHits || b.score - a.score)[0];
  const answerAnchor = [...ranked]
    .filter((candidate) => candidate.containsReferenceAnswer || candidate.answerHits > 0)
    .sort((a, b) => Number(b.containsReferenceAnswer) - Number(a.containsReferenceAnswer) || b.answerHits - a.answerHits || b.score - a.score)[0];
  addCandidate(questionAnchor);
  addCandidate(answerAnchor);
  for (const candidate of ranked) {
    if (selected.length === 2) break;
    addCandidate(candidate);
  }
  return selected.slice(0, 2);
}

function layerStatus(goldSessions, facts, evidenceBySession) {
  let covered = 0;
  let strong = 0;
  const details = [];
  for (const session of goldSessions) {
    const id = normalizeSessionId(session.id);
    const sessionFacts = facts.filter((fact) => sourceSessionIds(fact).includes(id));
    const matches = factMatches(evidenceBySession.get(id) ?? [], sessionFacts);
    const best = matches.filter(Boolean).sort((a, b) => b.score - a.score)[0] ?? null;
    if (sessionFacts.length) covered += 1;
    if (matches.length && matches.every((match) => match && match.score >= 0.24)) strong += 1;
    details.push({ sessionId: session.id, factCount: sessionFacts.length, matches, bestMatch: best });
  }
  const total = goldSessions.length;
  const status = covered === total && strong === total ? "完整" : covered === 0 ? "缺失" : "部分";
  return { status, covered, strong, total, details };
}

function evidenceFlow(goldSessions, evidenceBySession, extractionFacts, top100Facts, contextFacts) {
  return goldSessions.flatMap((session) => {
    const id = normalizeSessionId(session.id);
    const excerpts = evidenceBySession.get(id) ?? [];
    const layers = [
      ["extraction", extractionFacts],
      ["top100", top100Facts],
      ["context", contextFacts]
    ];
    return excerpts.map((excerpt) => {
      const matches = Object.fromEntries(layers.map(([name, facts]) => {
        const ranked = facts
          .map((fact) => ({ factId: fact.fact_id, factText: fact.fact_text, score: overlapScore(excerpt.text, fact.fact_text) }))
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        return [name, ranked];
      }));
      const strong = Object.fromEntries(Object.entries(matches).map(([name, ranked]) => [name, (ranked[0]?.score ?? 0) >= 0.24]));
      const firstLoss = !strong.extraction
        ? "事实抽取"
        : !strong.top100
          ? "Top100 召回"
          : !strong.context
            ? "context pack 选择"
            : "未丢失（回答/推理阶段）";
      return { sessionId: session.id, date: session.date, excerpt, matches, strong, firstLoss };
    });
  });
}

function primaryFailure(extraction, top100, context) {
  if (extraction.covered < extraction.total) return "事实抽取缺失";
  if (top100.covered < top100.total) return "Top100 召回缺失";
  if (context.covered < context.total) return "context pack 选择缺失";
  if (extraction.strong < extraction.total) return "事实抽取语义不完整/粒度不佳";
  if (top100.strong < top100.total) return "Top100 虽覆盖来源但关键事实不完整";
  if (context.strong < context.total) return "context pack 虽覆盖来源但关键事实不完整";
  return "回答生成/聚合推理错误";
}

function answerIssue(result) {
  const response = normalizeText(result.hypothesis);
  if (result.exactMatch) return "回答含标准答案字面，但最终结论矛盾、范围错误或夹杂错误答案";
  if (/no information|not enough|not mentioned|cannot (?:answer|determine|calculate)|can t (?:answer|determine)|not specified|there is no evidence/u.test(response)) {
    return "错误拒答：回答声称证据不足或信息未出现";
  }
  if (result.questionType === "single-session-preference") return "偏好约束未满足或推荐方向错误";
  if (result.questionType === "temporal-reasoning") return "时间定位、先后顺序或时间差推理错误";
  if (/\bhow many\b|\bhow much\b|\btotal\b/u.test(normalizeText(result.question))) return "跨 session 聚合、去重或数值计算错误";
  return "关键实体、属性或具体值选择错误";
}

const results = readJsonl(resultPath);
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const datasetById = new Map(dataset.map((sample) => [sample.question_id, sample]));
const datasetIndexById = new Map(dataset.map((sample, index) => [sample.question_id, index + 1]));
const incorrect = results.filter((row) => row.judgment?.label !== "correct");
const db = new DatabaseSync(databasePath, { readOnly: true });
const rawFactQuery = db.prepare("SELECT fact_id, fact_text, linked_source_refs FROM fact_items WHERE fact_id GLOB ? ORDER BY fact_id");
const factByIdQuery = db.prepare("SELECT fact_id, fact_text, linked_source_refs FROM fact_items WHERE fact_id = ?");
const factCache = new Map();

function factForItemId(itemId) {
  const factId = String(itemId).replace(/^(?:stm|ltm)_/u, "");
  if (factCache.has(factId)) return factCache.get(factId);
  const row = factByIdQuery.get(factId) ?? null;
  factCache.set(factId, row);
  return row;
}

const analyses = [];
for (const result of incorrect) {
  const sample = datasetById.get(result.questionId);
  if (!sample) throw new Error(`Dataset sample not found: ${result.questionId}`);
  const haystackIdMap = new Map(sample.haystack_session_ids.map((id, index) => [normalizeSessionId(id), { id, index }]));
  const goldSessions = sample.answer_session_ids.map((goldId) => {
    const found = haystackIdMap.get(normalizeSessionId(goldId));
    if (!found) return { id: goldId, date: "unknown", messages: [] };
    return {
      id: found.id,
      date: sample.haystack_dates[found.index],
      messages: sample.haystack_sessions[found.index]
    };
  });
  const evidenceBySession = new Map(goldSessions.map((session) => [
    normalizeSessionId(session.id),
    selectEvidenceExcerpts(session, sample.question, sample.answer, sample.question_type)
  ]));

  const extractionFacts = [];
  for (const session of goldSessions) {
    const prefix = `fact_llm_longmemeval_event_${sample.question_id}_${session.id}_*`;
    extractionFacts.push(...rawFactQuery.all(prefix));
  }
  const top100Ids = result.answerContext?.evidenceTrace?.retrievedItemIds ?? [];
  const top100Facts = top100Ids.map(factForItemId).filter(Boolean);
  const contextIds = result.contextPack?.selectedItemIds ?? result.answerContext?.selectedItemIds ?? [];
  const contextFacts = contextIds.map(factForItemId).filter(Boolean);
  const extraction = layerStatus(goldSessions, extractionFacts, evidenceBySession);
  const top100 = layerStatus(goldSessions, top100Facts, evidenceBySession);
  const context = layerStatus(goldSessions, contextFacts, evidenceBySession);
  const failure = primaryFailure(extraction, top100, context);
  const flow = evidenceFlow(goldSessions, evidenceBySession, extractionFacts, top100Facts, contextFacts);

  analyses.push({
    sampleIndex: result.sampleIndex,
    datasetIndex: datasetIndexById.get(result.questionId),
    questionId: result.questionId,
    questionType: result.questionType,
    question: result.question,
    referenceAnswer: result.answer,
    evaluatedAnswer: result.hypothesis,
    judgeReason: result.judgment?.reason ?? null,
    exactMatch: result.exactMatch,
    answerIssue: answerIssue(result),
    goldSessions: goldSessions.map((session) => ({
      sessionId: session.id,
      date: session.date,
      excerpts: evidenceBySession.get(normalizeSessionId(session.id)) ?? []
    })),
    extraction,
    top100: { ...top100, retrievalLimit: result.answerContext?.evidenceTrace?.retrievalLimit, retrievedCount: top100Ids.length },
    context: { ...context, selectedCount: contextIds.length },
    evidenceFlow: flow,
    primaryFailure: failure
  });
}
db.close();

const failureCounts = new Map();
const answerIssueCounts = new Map();
const typeCounts = new Map();
for (const item of analyses) {
  failureCounts.set(item.primaryFailure, (failureCounts.get(item.primaryFailure) ?? 0) + 1);
  answerIssueCounts.set(item.answerIssue, (answerIssueCounts.get(item.answerIssue) ?? 0) + 1);
  const current = typeCounts.get(item.questionType) ?? { total: 0, failures: new Map() };
  current.total += 1;
  current.failures.set(item.primaryFailure, (current.failures.get(item.primaryFailure) ?? 0) + 1);
  typeCounts.set(item.questionType, current);
}

const coverageSummary = {
  extractionSources: analyses.filter((item) => item.extraction.covered === item.extraction.total).length,
  extractionFacts: analyses.filter((item) => item.extraction.strong === item.extraction.total).length,
  top100Sources: analyses.filter((item) => item.top100.covered === item.top100.total).length,
  top100Facts: analyses.filter((item) => item.top100.strong === item.top100.total).length,
  contextSources: analyses.filter((item) => item.context.covered === item.context.total).length,
  contextFacts: analyses.filter((item) => item.context.strong === item.context.total).length
};

const TYPE_LABELS = {
  "single-session-user": "单 Session 事实问答",
  "multi-session": "多 Session 聚合",
  "single-session-preference": "单 Session 偏好推荐",
  "temporal-reasoning": "时间推理"
};

const TYPE_DIAGNOSES = {
  "single-session-user": {
    conclusion: "基础事实定位整体稳定；错误主要来自跨句属性关联没有保留，以及答案模型在已有直接证据时过度消歧或错误拒答。",
    actions: [
      "抽取时保留同一 Session 内的实体—属性跨句关系，不要只生成互相孤立的原子事实。",
      "对人物、地点、数值等直接问答优先输出最高置信度的短答案；只有存在真实冲突证据时才进入消歧。",
      "增加“答案已由直接事实支持”约束，抑制先写出正确值、随后又推翻它的长链自我修正。"
    ]
  },
  "multi-session": {
    conclusion: "主要瓶颈在抽取完整性、集合构造和 Context Pack 证据配额；计数、求和、去重、状态过滤经常缺少某个成员或错误纳入计划/历史项。",
    actions: [
      "为计数题构建显式候选集合，记录每个成员的来源、动作、状态和去重键，再执行计数或求和。",
      "Context Pack 按正确主题的不同 Session 分配证据配额，避免多个近重复事实挤掉集合中的唯一成员。",
      "回答阶段区分 bought/planned/current/previous 等状态，并输出参与计算的中间清单用于校验。"
    ]
  },
  "single-session-preference": {
    conclusion: "这类题不是寻找一个字面答案，而是把用户历史转成推荐约束；失败集中在偏好、已有资源和负向约束没有被完整抽取或没有落实到建议中。",
    actions: [
      "将偏好记忆结构化为 must-use、prefer、avoid、already-have 四类约束，而不是普通事实列表。",
      "召回和 Context Pack 选择应按约束覆盖度排序，确保至少保留一个正向偏好、一个已有资源及相关负向限制。",
      "生成后执行个性化检查：建议是否明确使用了用户历史，是否退化成任何用户都适用的通用答案。"
    ]
  },
  "temporal-reasoning": {
    conclusion: "错误分布跨越全链路；核心问题是 validTime 与 evidenceTime 混用、相对日期未锚定、事件状态混淆，以及排序或时间差计算缺少完整事件链。",
    actions: [
      "抽取阶段把 today/last Friday/two months ago 归一化为 validTime，同时保留原始时间表达和推导依据。",
      "时间召回增加目标时间窗路由，不能只依靠问题与事实正文的语义相似度。",
      "回答前先生成事件—validTime 表，再执行排序、日期差或星期换算；禁止用 evidenceTime 代替事件发生时间。"
    ]
  }
};

const resultTypeTotals = new Map();
for (const row of results) {
  const current = resultTypeTotals.get(row.questionType) ?? { total: 0, correct: 0, incorrect: 0 };
  current.total += 1;
  if (row.judgment?.label === "correct") current.correct += 1;
  else current.incorrect += 1;
  resultTypeTotals.set(row.questionType, current);
}

function countsBy(items, field) {
  const counts = new Map();
  for (const item of items) counts.set(item[field], (counts.get(item[field]) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

const typeAnalysis = Object.fromEntries([...resultTypeTotals.entries()].map(([type, totals]) => {
  const items = analyses.filter((item) => item.questionType === type);
  const fullyCovered = (layer) => items.filter((item) => item[layer].covered === item[layer].total).length;
  const semanticallyCovered = (layer) => items.filter((item) => item[layer].strong === item[layer].total).length;
  return [type, {
    label: TYPE_LABELS[type] ?? type,
    ...totals,
    accuracy: totals.total ? totals.correct / totals.total : 0,
    pipeline: {
      extraction: { sourceComplete: fullyCovered("extraction"), factComplete: semanticallyCovered("extraction") },
      top100: { sourceComplete: fullyCovered("top100"), factComplete: semanticallyCovered("top100") },
      context: { sourceComplete: fullyCovered("context"), factComplete: semanticallyCovered("context") }
    },
    failureCounts: countsBy(items, "primaryFailure"),
    answerIssueCounts: countsBy(items, "answerIssue"),
    diagnosis: TYPE_DIAGNOSES[type],
    questionIds: items.map((item) => item.questionId)
  }];
}));

const lines = [];
lines.push("# LongMemEval 错误样本逐层分析", "");
lines.push(`- 结果文件：\`${resultPath.replace(`${root}/`, "")}\``);
lines.push(`- 错误样本：**${analyses.length} / ${results.length}**，评测正确率 **${((results.length - analyses.length) / results.length * 100).toFixed(1)}%**`);
lines.push(`- 分析数据库：\`data/longmemeval/9b6954375d3c.sqlite\``);
lines.push("- Top100 以 `answerContext.evidenceTrace.retrievedItemIds` 为准；`answerContext.dropped` 仅保留了其中一部分，不能用它推算 Top100。");
const fullTop100Count = analyses.filter((item) => item.top100.retrievedCount === 100).length;
const fullContextCount = analyses.filter((item) => item.context.selectedCount === 20).length;
lines.push(`- 实际返回完整 100 条候选的错误样本：**${fullTop100Count}/${analyses.length}**；其余 ${analyses.length - fullTop100Count} 条返回少于 100 条。context pack 选满 20 条的样本：**${fullContextCount}/${analyses.length}**。`, "");
lines.push("## 判定口径", "");
lines.push("1. 正确信息来源以数据集 `answer_session_ids` 为准，不能用结果中的 `answerRankedSessionIds` 代替。", "2. “来源覆盖”是精确判定：该层事实的 `linked_source_refs.metadata.sessionId` 是否覆盖全部标注 session。", "3. “关键事实匹配”是可复核的词项 F1 启发式（阈值 0.24），用于发现事实虽然来自正确 session、但没有保留问题所需信息的情况；它不是人工语义裁决。", "4. “正确回答需要的信息”由标准答案、标注 session 日期以及与问题最相关的原始句共同表示。多 session 计数和时间推理必须组合所有列出的证据。", "");
lines.push("## 总体结论", "");
lines.push("| 流水线层级 | 全部正确来源 session 均覆盖 | 所有抽取关键句均有匹配事实* |", "|---|---:|---:|");
lines.push(`| 初始事实抽取 | ${coverageSummary.extractionSources}/${analyses.length} | ${coverageSummary.extractionFacts}/${analyses.length} |`);
lines.push(`| Top100 召回 | ${coverageSummary.top100Sources}/${analyses.length} | ${coverageSummary.top100Facts}/${analyses.length} |`);
lines.push(`| context pack | ${coverageSummary.contextSources}/${analyses.length} | ${coverageSummary.contextFacts}/${analyses.length} |`);
lines.push("", "\\* 关键句匹配是词项 F1 启发式，逐样本表中保留原句和事实，便于人工复核。", "");
lines.push("### 回答错误表现", "", "| 回答问题 | 样本数 |", "|---|---:|");
for (const [issue, count] of [...answerIssueCounts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${issue} | ${count} |`);
}
lines.push("");
lines.push("| 主要失效阶段 | 样本数 | 占全部错误样本 |", "|---|---:|---:|");
for (const [failure, count] of [...failureCounts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${failure} | ${count} | ${(count / analyses.length * 100).toFixed(1)}% |`);
}
lines.push("", "### 按问题类型", "", "| 问题类型 | 错误数 | 最常见失效阶段 |", "|---|---:|---|");
for (const [type, data] of [...typeCounts.entries()].sort((a, b) => b[1].total - a[1].total)) {
  const topFailure = [...data.failures.entries()].sort((a, b) => b[1] - a[1])[0];
  lines.push(`| ${type} | ${data.total} | ${topFailure[0]}（${topFailure[1]}） |`);
}
lines.push("", "## 分题型深度分析", "");
lines.push("| 题型 | 总样本 | 正确 | 错误 | 正确率 | 错误占全部错误 |", "|---|---:|---:|---:|---:|---:|");
for (const [type, summary] of Object.entries(typeAnalysis).sort((a, b) => b[1].incorrect - a[1].incorrect)) {
  lines.push(`| ${summary.label}<br><code>${type}</code> | ${summary.total} | ${summary.correct} | ${summary.incorrect} | ${(summary.accuracy * 100).toFixed(1)}% | ${(summary.incorrect / analyses.length * 100).toFixed(1)}% |`);
}
lines.push("");

for (const [type, summary] of Object.entries(typeAnalysis).sort((a, b) => b[1].incorrect - a[1].incorrect)) {
  const items = analyses.filter((item) => item.questionType === type);
  lines.push(`### ${summary.label}（${type}）`, "");
  lines.push(`- **结果**：${summary.correct}/${summary.total} 正确，${summary.incorrect} 个错误，正确率 **${(summary.accuracy * 100).toFixed(1)}%**。`);
  lines.push(`- **题型诊断**：${summary.diagnosis.conclusion}`, "");
  lines.push("**四层覆盖**", "");
  lines.push("| 层级 | 正确来源完整 | 关键事实完整* | 从上一层新增关键事实损失 |", "|---|---:|---:|---:|");
  const newlyLost = (fromLayer, toLayer) => items.filter((item) =>
    item[fromLayer].strong === item[fromLayer].total && item[toLayer].strong < item[toLayer].total
  ).length;
  const pipelineRows = [
    ["初始事实抽取", summary.pipeline.extraction, null],
    ["Top100 召回", summary.pipeline.top100, newlyLost("extraction", "top100")],
    ["context pack", summary.pipeline.context, newlyLost("top100", "context")]
  ];
  for (const [label, layer, loss] of pipelineRows) {
    lines.push(`| ${label} | ${layer.sourceComplete}/${summary.incorrect}（${(layer.sourceComplete / summary.incorrect * 100).toFixed(1)}%） | ${layer.factComplete}/${summary.incorrect}（${(layer.factComplete / summary.incorrect * 100).toFixed(1)}%） | ${loss === null ? "—" : loss} |`);
  }
  lines.push("", "\* “关键事实完整”为词项 F1 启发式结果；来源完整是精确 session 覆盖。", "");
  lines.push("**主要失效环节**", "", "| 失效环节 | 样本数 | 题型内占比 |", "|---|---:|---:|");
  for (const [failure, count] of Object.entries(summary.failureCounts)) {
    lines.push(`| ${failure} | ${count} | ${(count / summary.incorrect * 100).toFixed(1)}% |`);
  }
  lines.push("", "**最终回答错误表现**", "", "| 表现 | 样本数 |", "|---|---:|");
  for (const [issue, count] of Object.entries(summary.answerIssueCounts)) lines.push(`| ${issue} | ${count} |`);
  lines.push("", "**针对性改进**", "");
  for (const action of summary.diagnosis.actions) lines.push(`- ${action}`);
  lines.push("", "**该题型错误样本**", "");
  lines.push("| 样本 | questionId | 标准答案 | 主要失效阶段 |", "|---:|---|---|---|");
  for (const item of items) {
    lines.push(`| ${item.datasetIndex} | \`${item.questionId}\` | ${markdown(shorten(item.referenceAnswer, 120))} | ${item.primaryFailure} |`);
  }
  lines.push("");
}
lines.push("", "### 样本索引", "", "| 样本 | questionId | 问题类型 | 主要失效阶段 | 回答表现 |", "|---:|---|---|---|---|");
for (const item of analyses) {
  lines.push(`| ${item.sampleIndex} | \`${item.questionId}\` | ${item.questionType} | ${item.primaryFailure} | ${item.answerIssue} |`);
}
lines.push("", "## 逐样本分析", "");

for (const item of analyses) {
  lines.push(`### ${item.datasetIndex}. ${item.questionId}（${item.questionType}）`, "");
  lines.push(`- **问题**：${markdown(item.question)}`);
  lines.push(`- **标准答案**：${markdown(item.referenceAnswer)}`);
  lines.push(`- **评测回答**：${markdown(item.evaluatedAnswer)}`);
  lines.push(`- **评判信息**：\`${item.judgeReason}\`；exactMatch=${item.exactMatch}`);
  lines.push(`- **回答问题**：${item.answerIssue}`);
  lines.push(`- **主要失效阶段**：${item.primaryFailure}`);
  lines.push(`- **逐层结论**：事实抽取 ${item.extraction.status}（来源 ${item.extraction.covered}/${item.extraction.total}，关键事实 ${item.extraction.strong}/${item.extraction.total}）；Top100 ${item.top100.status}（来源 ${item.top100.covered}/${item.top100.total}，关键事实 ${item.top100.strong}/${item.top100.total}，实际返回 ${item.top100.retrievedCount}）；context pack ${item.context.status}（来源 ${item.context.covered}/${item.context.total}，关键事实 ${item.context.strong}/${item.context.total}，选中 ${item.context.selectedCount}）。`, "");
  lines.push("**正确回答需要的信息**", "");
  for (const session of item.goldSessions) {
    lines.push(`- \`${session.sessionId}\`，${session.date}`);
    for (const excerpt of session.excerpts) lines.push(`  - ${excerpt.role}: ${markdown(shorten(excerpt.text))}`);
  }
  lines.push("", "**各正确来源的流水线去向**", "");
  lines.push("| 正确来源 session | 抽取 | Top100 | context pack | 最接近的抽取事实 |", "|---|---|---|---|---|");
  for (const session of item.goldSessions) {
    const id = normalizeSessionId(session.sessionId);
    const extractionDetail = item.extraction.details.find((detail) => normalizeSessionId(detail.sessionId) === id);
    const topDetail = item.top100.details.find((detail) => normalizeSessionId(detail.sessionId) === id);
    const contextDetail = item.context.details.find((detail) => normalizeSessionId(detail.sessionId) === id);
    const matchedFacts = extractionDetail?.matches?.filter(Boolean) ?? [];
    const closest = matchedFacts.length
      ? matchedFacts.map((match) => `${markdown(shorten(match.factText, 180))}（F1=${match.score.toFixed(2)}）`).join("<br>")
      : "无";
    lines.push(`| \`${session.sessionId}\` | ${extractionDetail?.factCount ? `有（${extractionDetail.factCount}）` : "无"} | ${topDetail?.factCount ? "有" : "无"} | ${contextDetail?.factCount ? "有" : "无"} | ${closest} |`);
  }
  lines.push("", "**逐条正确证据流**", "");
  lines.push("| 原始正确事实 | 抽取出的相关事实 | Top100 召回的相关事实 | context pack 中的相关事实 | 首次漏失 |", "|---|---|---|---|---|");
  const renderMatches = (matches) => matches.length
    ? matches.map((match) => `${markdown(shorten(match.factText, 220))}<br><code>${match.factId}</code>（F1=${match.score.toFixed(2)}）`).join("<br><br>")
    : "无匹配事实";
  for (const flow of item.evidenceFlow) {
    lines.push(`| \`${flow.sessionId}\` ${flow.date}<br>${markdown(shorten(flow.excerpt.text, 260))} | ${renderMatches(flow.matches.extraction)} | ${renderMatches(flow.matches.top100)} | ${renderMatches(flow.matches.context)} | ${flow.firstLoss} |`);
  }
  lines.push("");
}

writeFileSync(reportPath, `${lines.join("\n")}\n`);
writeFileSync(jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), resultPath, datasetPath, databasePath, coverageSummary, typeAnalysis, analyses }, null, 2)}\n`);
console.log(JSON.stringify({ reportPath, jsonPath, total: results.length, incorrect: analyses.length, coverageSummary, failureCounts: Object.fromEntries(failureCounts) }, null, 2));
