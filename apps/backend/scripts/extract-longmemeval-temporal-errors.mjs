#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const analysisPath = resolve(root, process.argv[2] ?? "docs/longmemeval-result-500-3-error-analysis.json");
const datasetPath = resolve(root, "datasets/LongMemEval/longmemeval_s_cleaned.json");
const outputPath = resolve(root, process.argv[3] ?? "docs/longmemeval-result-500-3-temporal-error-analysis.md");
const outputJsonPath = outputPath.replace(/\.md$/u, ".json");

const ANSWER_DIAGNOSES = {
  gpt4_59149c77: ["无法确定（正文虽一度推导出 7 天，最终仍拒答）", "正确的两个事件日期相隔 7 天；模型已经找到 1 月 8 日和 1 月 15 日，却因一个事实缺少显式 validTime 而过度保守，最终推翻了可用的 7 天结论。"],
  af082822: ["0 周", "模型把 answer session 中的 yesterday 错误绑定到问题日期 12 月 1 日，而不是该陈述所在的 11 月 18 日；相对时间锚点错位后得到 0 周。"],
  gpt4_7f6b06db: ["Big Sur/Monterey → Dubai/Abu Dhabi → Yosemite", "模型漏掉最早的 Muir Woods 行程，同时把计划/行程表中的 Dubai/Abu Dhabi 当成已经完成的旅行，发生召回缺失与事件状态误判。"],
  "9a707b81": ["26 天", "模型把 baking class 的日期直接算到问题日期，并把朋友生日蛋糕视为另一个无关事件；没有按照标注答案要求建立两段叙事的目标事件关联。"],
  gpt4_1916e0ea: ["无法确定", "取消 FarmFresh 的事实丢失了可计算的时间语义，模型只接受显式 validTime，不使用该 session 的时间锚点，因此没有计算 54 天。"],
  gpt4_7abb270c: ["只列出 5 家，并且顺序错误", "六次参观的时间信息没有被完整保留和召回；模型还混淆了已参观、计划参观和仅被提及的博物馆，导致漏项及排序错误。"],
  "2ebe6c90": ["先称无法确定，随后又回答 21 天", "开始和结束事实均已完整召回，1 月 10 日到 1 月 31 日为 21 天；错误来自回答内部自相矛盾，正确值被错误拒答段落污染。"],
  gpt4_d6585ce8: ["Billie Eilish → 户外音乐会 → Jazz night（仅 3 项）", "模型漏掉 Brooklyn music festival 和 Queen + Adam Lambert 两项；在完整证据已经进入回答链路的情况下，没有完成五事件聚合与排序。"],
  "370a8ff4": ["12 周", "模型采用了错误或不完整的事件时间，将 1 月 19 日到 4 月 10 日作为计算区间；抽取层没有完整保存基准事件的时间语义，最终与标注的 15 周不一致。"],
  gpt4_f420262c: ["JetBlue → American Airlines", "模型把 Delta 和 United 判断为未来计划而排除；抽取/召回没有完整保留四次实际飞行的事件状态和顺序。"],
  gpt4_21adecb5: ["无法确定", "本科完成日期在抽取事实中没有被保留下来，模型因而无法与硕士论文提交日期计算 6 个月。"],
  gpt4_7bc6cf22: ["17 天", "模型使用了错误的阅读日期或问题日期锚点；正确口径为 12 天，包含末日时 13 天也可接受。"],
  "71017277": ["无法确定", "答案所需人物事实已被召回并进入 Context Pack，但模型没有把 last Saturday 的珠宝事件与 aunt 关联起来，属于生成端错误拒答。"],
  gpt4_e414231f: ["mountain bike", "模型选择了 3 月 15 日已完成的山地车维修，却忽略问题限定的 past weekend 对应 road bike 服务事件，属于时间窗和目标事件选择错误。"],
  gpt4_59149c78: ["无法确定", "Metropolitan Museum of Art 对应的关键原始事实在抽取阶段就缺失，后续召回无从命中。"],
  gpt4_d6585ce9: ["无法确定", "虽然抽取到了 Queen + Adam Lambert 与 parents，但多场音乐事件的时间关系未完整召回，模型未能把 last Saturday 定位到该场活动。"],
  gpt4_1e4a8aec: ["参加 gardening workshop", "目标日期对应 planting 12 new tomato saplings；该事实虽已抽取，但 Top100 没有完整召回，模型转而选中了更早且时间不匹配的 workshop。"],
  "4dfccbf8": ["无法确定", "模型已经看到 2 月 1 日开始与 Rachel 学 ukulele，且该日确为周三、相对问题日期约两个月；但它要求原文再次显式确认星期和相对月份，造成过度拒答。"],
  gpt4_f420262d: ["JetBlue", "模型把情人节当天记录的 JetBlue 订票行为当成当天实际乘坐；正确答案要求区分 booking 的 evidenceTime 与 American Airlines 的实际飞行事件。"],
  eac54add: ["无法确定", "签下第一个客户的事实已抽取，但其正确来源没有完整进入 Top100，因此回答端看不到关键商业里程碑。"],
  "0bc8ad93": ["无法确定", "问题询问的是两个月前那次 museum visit 是否与朋友同行；目标 session/否定信息没有被完整召回，模型无法完成与其他‘和朋友参观’事件的区分。"],
  gpt4_8279ba03: ["无法确定", "smoker 相关来源虽进入 Top100，但购买这一关键动作没有形成完整匹配事实并进入 Context Pack，导致最终拒答。"],
  gpt4_fa19884d: ["开头回答 Jinsang，结尾又回答 bluegrass band", "正确日期对应的 bluegrass band 事实已完整召回；模型被更早的 Jinsang 事实干扰，产生相互矛盾的双答案。"],
  c9f37c46: ["3 个月", "3 个月是开始规律观看到当前问题日的时长；open mic 发生在上个月，因此到 open mic 当时应为 2 个月。模型没有在目标事件时点截断时间区间。"],
  gpt4_2c50253f: ["8:15 AM", "模型错误地以旧的 usual 8:30 AM 为基准减 15 分钟；正确基准是最近开始的 7:00 AM，所以周二和周四为 6:45 AM。"],
};

function markdown(value) {
  return String(value ?? "").replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

function shorten(value, limit = 1200) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function uniqueFacts(flows, layer) {
  const seen = new Set();
  const facts = [];
  for (const flow of flows) {
    for (const fact of flow.matches[layer] ?? []) {
      if (!fact.factId || seen.has(fact.factId)) continue;
      seen.add(fact.factId);
      facts.push(fact);
    }
  }
  return facts;
}

const source = JSON.parse(readFileSync(analysisPath, "utf8"));
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const datasetById = new Map(dataset.map((sample) => [sample.question_id, sample]));
const temporal = source.analyses.filter((item) => item.questionType === "temporal-reasoning").map((item) => {
  const diagnosis = ANSWER_DIAGNOSES[item.questionId];
  if (!diagnosis) throw new Error(`Missing answer diagnosis: ${item.questionId}`);
  const extractedFacts = uniqueFacts(item.evidenceFlow, "extraction");
  const recalledFacts = uniqueFacts(item.evidenceFlow, "top100");
  const recallComplete = item.top100.covered === item.top100.total && item.top100.strong === item.top100.total;
  return {
    ...item,
    questionDate: datasetById.get(item.questionId)?.question_date ?? "unknown",
    conciseWrongAnswer: diagnosis[0],
    errorReason: diagnosis[1],
    extractedFacts,
    recalledFacts,
    recallComplete,
    recallConclusion: recallComplete
      ? "完整召回：全部标注正确来源均进入 Top100，且每个正确证据片段均存在达到阈值的对应事实。"
      : `未完整召回：正确来源覆盖 ${item.top100.covered}/${item.top100.total}，关键证据覆盖 ${item.top100.strong}/${item.top100.total}。`
  };
});

const completeCount = temporal.filter((item) => item.recallComplete).length;
const lines = [
  "# LongMemEval 时间推理错题专项分析",
  "",
  `- 来源分析：\`${analysisPath.replace(`${root}/`, "")}\``,
  `- 时间推理错题：**${temporal.length}**`,
  `- Top100 完整召回：**${completeCount}/${temporal.length}**；未完整召回：**${temporal.length - completeCount}/${temporal.length}**。`,
  "- 召回范围以 `answerContext.evidenceTrace.retrievedItemIds`（Top100）为准，不以 Context Pack 为准。",
  "- “关键证据覆盖”沿用主报告的词项 F1≥0.24 启发式；“正确来源覆盖”则是精确 sessionId 匹配。所有原句和事实均在下文展示，便于人工复核。",
  "",
  "## 索引",
  "",
  "| 样本 | questionId | 正确答案 | 模型错误答案 | Top100 是否完整召回 |",
  "|---:|---|---|---|---|"
];

for (const item of temporal) {
  lines.push(`| ${item.datasetIndex} | \`${item.questionId}\` | ${markdown(shorten(item.referenceAnswer, 100))} | ${markdown(shorten(item.conciseWrongAnswer, 100))} | ${item.recallComplete ? "是" : "否"}（来源 ${item.top100.covered}/${item.top100.total}，关键证据 ${item.top100.strong}/${item.top100.total}） |`);
}

lines.push("", "## 逐题分析", "");
for (const item of temporal) {
  lines.push(`### ${item.datasetIndex}. ${item.questionId}`, "");
  lines.push(`- **问题日期**：${item.questionDate}`);
  lines.push(`- **问题**：${markdown(item.question)}`);
  lines.push(`- **正确答案**：${markdown(item.referenceAnswer)}`);
  lines.push(`- **模型错误答案**：${markdown(item.conciseWrongAnswer)}`);
  lines.push(`- **回答错误理由**：${markdown(item.errorReason)}`);
  lines.push(`- **主失效阶段**：${item.primaryFailure}`);
  lines.push(`- **Top100 召回结论**：${item.recallConclusion}`, "");

  lines.push("**正确答案相关的原始数据**", "");
  for (const session of item.goldSessions) {
    lines.push(`- \`${session.sessionId}\`，${session.date}`);
    for (const excerpt of session.excerpts) lines.push(`  - ${excerpt.role}: ${markdown(excerpt.text)}`);
  }
  lines.push("", "**逐条原始证据 → 抽取事实 → Top100 召回**", "");
  lines.push("| 原始正确证据 | 抽取出的相关事实 | Top100 召回到的对应事实 | 该证据首次漏失 |", "|---|---|---|---|");
  const renderFacts = (facts) => facts.length
    ? facts.filter((fact) => fact.score >= 0.24).map((fact) => `${markdown(shorten(fact.factText, 260))}<br><code>${fact.factId}</code>（F1=${fact.score.toFixed(2)}）`).join("<br><br>") || "无达到匹配阈值的事实"
    : "无匹配事实";
  for (const flow of item.evidenceFlow) {
    lines.push(`| \`${flow.sessionId}\` ${flow.date}<br>${markdown(shorten(flow.excerpt.text, 320))} | ${renderFacts(flow.matches.extraction)} | ${renderFacts(flow.matches.top100)} | ${flow.firstLoss} |`);
  }
  lines.push("");
}

writeFileSync(outputPath, `${lines.join("\n")}\n`);
writeFileSync(outputJsonPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceAnalysisPath: analysisPath,
  total: temporal.length,
  recallComplete: completeCount,
  recallIncomplete: temporal.length - completeCount,
  analyses: temporal
}, null, 2)}\n`);

console.log(JSON.stringify({ outputPath, outputJsonPath, total: temporal.length, completeCount }, null, 2));
