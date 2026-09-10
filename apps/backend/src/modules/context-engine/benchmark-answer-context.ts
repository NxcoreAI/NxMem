import type { ContextPack, ContextPackItem } from "./assemble-context.js";
import type { CrossEncoderReranker } from "./cross-encoder-reranker.js";
import type { ContextPackTrace, FactItem, RelationEdge, SourceRef } from "./domain.js";
import type { EmbeddingClient } from "./embedding.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import {
  searchContext,
  type ContextSearchResponse,
  type ContextSearchResult,
  type ScoreBreakdown
} from "./search-context.js";
import { estimateContextTokens } from "./token-estimator.js";

export const BENCHMARK_ANSWER_CANDIDATE_LIMIT = 100;
export const BENCHMARK_ANSWER_EVIDENCE_LIMIT = 20;
export const BENCHMARK_ANSWER_TOKEN_BUDGET = 20_000;
const baselineCandidateCount = 12;

export type BenchmarkAnswerLayer = "fact" | "stm" | "ltm";
export type BenchmarkAnswerSourceRole = "user" | "assistant" | "tool" | "unknown";
export type BenchmarkAnswerEvidenceRole =
  | "direct_answer" | "temporal_start" | "temporal_end" | "old_state" | "new_state"
  | "calculation_operand" | "disambiguation";
export type BenchmarkAnswerRejectReason = "not_relevant" | "duplicate" | "budget" | "missing_required_metadata" | "lower_priority";

export interface BenchmarkAnswerContextInput {
  questionId: string;
  question: string;
  questionType?: string;
  tenantId: string;
  principalId: string;
  contextScopeId: string;
  referenceTime?: string;
  /** Optional unnormalized timestamp used only when rendering the answer prompt. */
  displayReferenceTime?: string;
  modelRunId?: string;
  storeNamespace?: string;
  allowedLayers: BenchmarkAnswerLayer[];
  candidateLimit?: number;
  evidenceLimit?: number;
  tokenBudget?: number;
  includeInactive?: boolean;
  factRetrieval?: boolean;
  embeddingClient?: EmbeddingClient;
  memoryReranker?: CrossEncoderReranker | false;
  factReranker?: CrossEncoderReranker | false;
  resolveSessionId?: (source: SourceRef) => string | undefined;
}

export interface BenchmarkAnswerEvidenceCandidate {
  item: ContextPackItem;
  scoreBreakdown: ScoreBreakdown;
  sourceSessionIds: string[];
  sourceRoles: BenchmarkAnswerSourceRole[];
  temporal: Pick<ContextPackItem["temporal"], "evidenceTime" | "validTime" | "events">;
  relations: RelationEdge[];
  facts: FactItem[];
  evidenceText: string;
  relevanceScore: number;
  estimatedTokens: number;
}

export interface BenchmarkAnswerEvidenceRejection {
  itemId: string;
  layer?: ContextSearchResult["layer"];
  reason: BenchmarkAnswerRejectReason;
  contentChars: number;
}

export interface BenchmarkAnswerContext {
  serializedPrompt: string;
  selectedItems: ContextPackItem[];
  dropped: ContextPack["dropped"];
  tokenBudget: ContextPack["tokenBudget"];
  candidates: ContextSearchResult[];
  evidenceCandidates: BenchmarkAnswerEvidenceCandidate[];
  selected: Array<{ itemId: string; reason: string; evidenceRole: BenchmarkAnswerEvidenceRole }>;
  rejected: BenchmarkAnswerEvidenceRejection[];
  pack: ContextPack;
}

export async function buildBenchmarkAnswerContext(
  repository: ContextEngineRepository,
  input: BenchmarkAnswerContextInput
): Promise<BenchmarkAnswerContext> {
  validateInput(input);
  const candidateLimit = clamp(input.candidateLimit, BENCHMARK_ANSWER_CANDIDATE_LIMIT, 1, 500);
  const evidenceLimit = clamp(input.evidenceLimit, BENCHMARK_ANSWER_EVIDENCE_LIMIT, 1, 100);
  const tokenBudget = clamp(input.tokenBudget, BENCHMARK_ANSWER_TOKEN_BUDGET, 100, 100_000);
  const searchLayer = input.allowedLayers.length === 1 ? input.allowedLayers[0]! : "all";
  const search = await searchContext(repository, {
    q: input.question,
    layer: searchLayer,
    limit: candidateLimit,
    offset: 0,
    tenantId: input.tenantId,
    principalId: input.principalId,
    contextScopeId: input.contextScopeId,
    ...(input.referenceTime ? { referenceTime: input.referenceTime } : {}),
    ...(input.includeInactive !== undefined ? { includeInactive: input.includeInactive } : {})
  }, {
    recordRetrieval: false,
    factRetrieval: input.factRetrieval ?? input.allowedLayers.includes("fact"),
    ...(input.embeddingClient ? { embeddingClient: input.embeddingClient } : {}),
    ...(input.memoryReranker !== undefined ? { memoryReranker: input.memoryReranker } : {}),
    ...(input.factReranker !== undefined ? { reranker: input.factReranker } : {})
  });
  const allowed = new Set<ContextSearchResult["layer"]>(input.allowedLayers);
  const forbidden = search.results.filter((item) => !allowed.has(item.layer));
  const results = search.results
    .filter((item) => allowed.has(item.layer))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, candidateLimit);
  const built = await buildCandidates(repository, input, results);
  const selection = selectBenchmarkAnswerEvidenceWithinBudget({
    question: input.question,
    questionType: input.questionType ?? "multi-session",
    ...((input.displayReferenceTime ?? input.referenceTime) ? { referenceTime: input.displayReferenceTime ?? input.referenceTime } : {}),
    candidates: built,
    tokenBudget,
    evidenceLimit
  });
  const rejected = selection.rejected;
  const effectiveSearch: ContextSearchResponse = {
    ...search,
    results,
    dropped: [
      ...search.dropped,
      ...forbidden.map((item) => ({ id: item.id, layer: item.layer, reason: "layer_not_allowed" }))
    ]
  };
  const pack = await buildPack(repository, input, effectiveSearch, selection, tokenBudget);
  return {
    serializedPrompt: pack.serializedPrompt,
    selectedItems: selection.selectedCandidates.map(candidateContextItem),
    dropped: pack.dropped,
    tokenBudget: pack.tokenBudget,
    candidates: results,
    evidenceCandidates: built,
    selected: selection.selected,
    rejected,
    pack
  };
}

async function buildCandidates(
  repository: ContextEngineRepository,
  input: BenchmarkAnswerContextInput,
  results: ContextSearchResult[]
) {
  const facts = await repository.getFactItemsByIds(unique(results.flatMap((result) => result.factIds)));
  const factById = new Map(facts.map((fact) => [fact.factId, fact]));
  const messageIds = unique(facts.flatMap((fact) => fact.sourceMessageIds ?? []));
  const messageRoleById = new Map<string, BenchmarkAnswerSourceRole>();
  if (messageIds.length) {
    for (const message of await repository.getConversationMessagesByRowIds(messageIds)) {
      const role = sourceRole(message.role);
      messageRoleById.set(message.conversationMessageRowId, role);
      messageRoleById.set(message.messageId, role);
    }
  }
  return results.map((result): BenchmarkAnswerEvidenceCandidate => {
    const original = searchResultToItem(result);
    const itemFacts = original.factIds.map((id) => factById.get(id)).filter((fact): fact is FactItem => Boolean(fact));
    const refs = uniqueSourceRefs([...original.sourceRefs, ...itemFacts.flatMap((fact) => fact.linkedSourceRefs)]);
    const temporal = mergeTemporal(original.temporal, itemFacts);
    const item: ContextPackItem = {
      ...original,
      sourceRefs: refs,
      sourceMessageIds: unique([...original.sourceMessageIds, ...itemFacts.flatMap((fact) => fact.sourceMessageIds ?? [])]),
      temporal
    };
    const evidenceText = buildBenchmarkAnswerEvidenceText(item, itemFacts);
    const candidate: BenchmarkAnswerEvidenceCandidate = {
      item,
      scoreBreakdown: result.scoreBreakdown,
      sourceSessionIds: unique(refs.flatMap((ref) => {
        const id = input.resolveSessionId?.(ref) ?? metadataString(ref, "sessionId");
        return id ? [id] : [];
      })),
      sourceRoles: inferSourceRoles(refs, itemFacts, messageRoleById),
      temporal,
      relations: result.relationEdges.map((edge) => ({ ...edge })),
      facts: itemFacts,
      evidenceText,
      relevanceScore: relevance(input.question, evidenceText),
      estimatedTokens: 0
    };
    candidate.estimatedTokens = estimateContextTokens(renderItem(candidate, 1));
    return candidate;
  });
}

export function buildBenchmarkAnswerEvidenceText(item: ContextPackItem, facts: FactItem[]) {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const raw of [item.content, ...facts.map((fact) => fact.factText || fact.normalizedClaim), ...facts.map((fact) => fact.sourceClaim)]) {
    const text = raw?.trim();
    const key = normalize(text ?? "");
    if (text && key && !seen.has(key)) { seen.add(key); sections.push(text); }
  }
  return sections.join("\n");
}

export function selectBenchmarkAnswerEvidenceWithinBudget(input: {
  question: string;
  questionType: string;
  referenceTime?: string;
  candidates: BenchmarkAnswerEvidenceCandidate[];
  tokenBudget: number;
  evidenceLimit?: number;
}) {
  const evidenceLimit = clamp(input.evidenceLimit, BENCHMARK_ANSWER_EVIDENCE_LIMIT, 1, 100);
  const rejected: BenchmarkAnswerEvidenceRejection[] = [];
  const deduped: BenchmarkAnswerEvidenceCandidate[] = [];
  const indexByKey = new Map<string, number>();
  for (const candidate of input.candidates) {
    const key = duplicateKey(candidate);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) { indexByKey.set(key, deduped.length); deduped.push(candidate); continue; }
    const existing = deduped[existingIndex]!;
    const keepCandidate = completeness(candidate) > completeness(existing);
    const duplicate = keepCandidate ? existing : candidate;
    rejected.push(rejection(duplicate, "duplicate"));
    if (keepCandidate) deduped[existingIndex] = candidate;
  }
  const ranked = deduped.slice().sort(compareCandidates);
  const baseline = Math.min(baselineCandidateCount, evidenceLimit);
  const considered = ranked.slice(0, baseline).concat(ranked.slice(baseline, evidenceLimit));
  let usedTokens = estimateContextTokens(renderHeader(input.questionType, input.question, input.referenceTime));
  const selectedCandidates: BenchmarkAnswerEvidenceCandidate[] = [];
  for (const candidate of considered) {
    const tokens = estimateContextTokens(renderItem(candidate, selectedCandidates.length + 1));
    if (usedTokens + tokens > input.tokenBudget) { rejected.push(rejection(candidate, "budget")); continue; }
    selectedCandidates.push(candidate); usedTokens += tokens;
  }
  const consideredIds = new Set([...selectedCandidates.map((item) => item.item.id), ...rejected.map((item) => item.itemId)]);
  for (const candidate of ranked) if (!consideredIds.has(candidate.item.id)) rejected.push(rejection(candidate, "lower_priority"));
  usedTokens = estimateContextTokens(renderBenchmarkAnswerContext(input.question, input.referenceTime, selectedCandidates, "pack_budget_estimate_0000000000000000", input.questionType));
  while (selectedCandidates.length && usedTokens > input.tokenBudget) {
    rejected.push(rejection(selectedCandidates.pop()!, "budget"));
    usedTokens = estimateContextTokens(renderBenchmarkAnswerContext(input.question, input.referenceTime, selectedCandidates, "pack_budget_estimate_0000000000000000", input.questionType));
  }
  return { selectedCandidates, selected: assignRoles(selectedCandidates, input.questionType, input.question), rejected, usedTokens };
}

export function renderBenchmarkAnswerContext(
  question: string,
  referenceTime: string | undefined,
  candidates: BenchmarkAnswerEvidenceCandidate[],
  packId: string,
  questionType = "multi-session"
) {
  const indexes = new Map<string, number>();
  candidates.forEach((candidate, index) => identityIds(candidate).forEach((id) => indexes.set(id, index + 1)));
  return [renderHeader(questionType, question, referenceTime, packId), ...(candidates.length
    ? candidates.map((candidate, index) => renderItem(candidate, index + 1, indexes)) : ["- 无"])].join("\n");
}

async function buildPack(
  repository: ContextEngineRepository,
  input: BenchmarkAnswerContextInput,
  search: ContextSearchResponse,
  selection: ReturnType<typeof selectBenchmarkAnswerEvidenceWithinBudget>,
  tokenBudget: number
): Promise<ContextPack> {
  const packId = `pack_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const traceId = `trace_${packId}`;
  const serializedPrompt = renderBenchmarkAnswerContext(input.question, input.displayReferenceTime ?? input.referenceTime, selection.selectedCandidates, packId, input.questionType);
  const used = estimateContextTokens(serializedPrompt);
  const taskContext = selection.selectedCandidates.map(candidateContextItem);
  const dropped: ContextPack["dropped"] = [
    ...search.dropped.map((item) => ({ id: item.id, layer: item.layer, reason: `search:${item.reason}` })),
    ...selection.rejected.map((item) => ({ id: item.itemId, ...(item.layer ? { layer: item.layer } : {}), reason: `selection:${item.reason}` }))
  ];
  const compressionSteps: ContextPack["compressionSteps"] = [
    ...selection.selectedCandidates.map((candidate) => ({ id: candidate.item.id, layer: candidate.item.layer, action: "keep" as const, beforeTokens: estimateContextTokens(candidate.evidenceText), afterTokens: estimateContextTokens(candidate.evidenceText), reason: "selected_complete_evidence" })),
    ...selection.rejected.map((item) => ({ id: item.itemId, ...(item.layer ? { layer: item.layer } : {}), action: "drop" as const, beforeTokens: 0, afterTokens: 0, reason: item.reason }))
  ];
  const allocations: ContextPackTrace["tokenUsage"] = { profile: 0, task: used, recent: 0, constraints: 0, citations: 0, conflicts: 0, total: used };
  const pack: ContextPack = {
    packId, task: input.question,
    scope: { questionId: input.questionId, contextScopeId: input.contextScopeId, modelRunId: input.modelRunId ?? "default", storeNamespace: input.storeNamespace ?? "default" },
    temporal: search.temporal, serializedPrompt, profileContext: [], taskContext, recentContext: [], constraints: [],
    citations: citations(taskContext), conflicts: conflicts(selection.selectedCandidates),
    tokenBudget: { requested: tokenBudget, used, allocations, plan: { profileContext: 0, taskContext: tokenBudget, recentContext: 0, constraints: 0, citations: 0, conflicts: 0, reservedForCritical: 0 } },
    compressionSteps, dropped, traceId
  };
  try {
    await repository.saveContextPackTrace({ traceId, packId, task: input.question, finalScore: taskContext.length ? taskContext.reduce((sum, item) => sum + item.score, 0) / taskContext.length : 0, tokenBudget, tokenUsage: allocations, selectedItemIds: taskContext.map((item) => item.id), droppedReasons: dropped.map((item) => `${item.id}:${item.reason}`), compressionSteps, temporal: search.trace, createdAt: new Date().toISOString() });
  } catch { /* Diagnostics must not fail an evaluation. */ }
  return pack;
}

function renderHeader(type: string, question: string, referenceTime?: string, packId = "pending") {
  return [`【Context Pack】${packId}`, `【任务】${question}`, ...(referenceTime?.trim() ? [`【问题时间】${referenceTime.trim()}`] : []), "【答题证据】", ...(needsCount(type, question) ? ["【计数规则】先枚举符合问题时间范围的独立事件，再计数；不要把支持性事实、参数或同一事件的重复提及当作额外事件。"] : [])].join("\n");
}

function renderItem(candidate: BenchmarkAnswerEvidenceCandidate, index: number, indexes?: Map<string, number>) {
  const refs = unique(candidate.item.sourceRefs.map((source) => `${source.sourceType}:${source.sourceId}`));
  const relations = unique(candidate.relations.map((edge) => renderRelation(candidate, edge, indexes)));
  const sequences = candidate.facts.filter((fact) => fact.factSequence !== undefined).map((fact) => `  - Session ${fact.sessionId ?? candidate.sourceSessionIds[0] ?? "未知"}, factSequence ${fact.factSequence}: ${fact.factText || fact.normalizedClaim}`);
  return [`- [${index}] item:${candidate.item.id}`, candidate.evidenceText, ...(sequences.length ? ["  事实抽取顺序：", ...sequences] : []), `  事实发生时间：${candidate.temporal.validTime ?? "未提供"}`, ...(candidate.temporal.events?.length ? [`  事件时间映射：${candidate.temporal.events.map((event) => `${event.eventKey} | ${event.label} | ${event.validTime}`).join("；")}`] : []), `  消息发送时间：${candidate.temporal.evidenceTime ?? "未提供"}`, `  来源角色：${candidate.sourceRoles.join(", ") || "unknown"}`, `  来源 Session：${candidate.sourceSessionIds.join(", ") || "未知"}`, `  来源引用：${refs.join(", ") || "无"}`, `  关系：${relations.join("；") || "无"}`].join("\n");
}

function renderRelation(candidate: BenchmarkAnswerEvidenceCandidate, edge: RelationEdge, indexes?: Map<string, number>) {
  const isFrom = ownsId(candidate, edge.fromId);
  const otherId = isFrom ? edge.toId : edge.fromId;
  const other = indexes?.get(otherId) ? `[${indexes.get(otherId)}]` : otherId;
  if (edge.relationType === "updates") return isFrom ? `更新了 ${other}` : `被 ${other} 更新`;
  if (edge.relationType === "conflicts_with") return `与 ${other} 冲突`;
  if (edge.relationType === "is_same_as" || edge.relationType === "alias_of") return `与 ${other} 表达同一事实`;
  if (edge.relationType === "supports") return isFrom ? `支持 ${other}` : `被 ${other} 支持`;
  if (edge.relationType === "derived_from") return isFrom ? `来源于 ${other}` : `${other} 来源于本条`;
  return `${edge.relationType} ${other}`;
}

function assignRoles(candidates: BenchmarkAnswerEvidenceCandidate[], type: string, question: string) {
  const temporal = needsTemporal(type, question);
  const calculation = needsCalculation(type, question);
  const times = candidates.filter(hasTemporal).slice().sort((a, b) => candidateTime(a).localeCompare(candidateTime(b)));
  return candidates.map((candidate): { itemId: string; reason: string; evidenceRole: BenchmarkAnswerEvidenceRole } => {
    const update = candidate.relations.find((edge) => edge.relationType === "updates");
    if (update && ownsId(candidate, update.fromId)) return { itemId: candidate.item.id, reason: "提供更新后的状态", evidenceRole: "new_state" };
    if (update && ownsId(candidate, update.toId)) return { itemId: candidate.item.id, reason: "提供更新前的状态", evidenceRole: "old_state" };
    if (temporal && candidate.item.id === times[0]?.item.id) return { itemId: candidate.item.id, reason: "提供时间起点", evidenceRole: "temporal_start" };
    if (temporal && times.length > 1 && candidate.item.id === times.at(-1)?.item.id) return { itemId: candidate.item.id, reason: "提供时间终点", evidenceRole: "temporal_end" };
    if (calculation && /(?:\d[\d,.]*|[$€£¥]\s*\d)/u.test(candidate.evidenceText)) return { itemId: candidate.item.id, reason: "提供计算所需数值", evidenceRole: "calculation_operand" };
    if (candidate.relevanceScore > 0) return { itemId: candidate.item.id, reason: "与问题中的关键内容直接匹配", evidenceRole: "direct_answer" };
    return { itemId: candidate.item.id, reason: "用于补充上下文或消除歧义", evidenceRole: "disambiguation" };
  });
}

function citations(items: ContextPackItem[]): ContextPack["citations"] {
  const byId = new Map<string, ContextPack["citations"][number]>();
  for (const item of items) for (const ref of item.sourceRefs) {
    const existing = byId.get(ref.sourceRefId);
    if (existing) { if (!existing.itemIds.includes(item.id)) existing.itemIds.push(item.id); }
    else byId.set(ref.sourceRefId, { sourceRefId: ref.sourceRefId, sourceType: ref.sourceType, sourceId: ref.sourceId, itemIds: [item.id] });
  }
  return [...byId.values()];
}

function conflicts(candidates: BenchmarkAnswerEvidenceCandidate[]): ContextPack["conflicts"] {
  const byId = new Map<string, ContextPack["conflicts"][number]>();
  for (const candidate of candidates) for (const edge of candidate.relations.filter((item) => item.relationType === "conflicts_with")) {
    const existing = byId.get(edge.edgeId);
    if (existing) { if (!existing.itemIds.includes(candidate.item.id)) existing.itemIds.push(candidate.item.id); }
    else byId.set(edge.edgeId, { kind: "graph", edgeId: edge.edgeId, fromId: edge.fromId, toId: edge.toId, ...(edge.evidence ? { evidence: edge.evidence } : {}), factIds: [...candidate.item.factIds], sourceRefs: [...candidate.item.sourceRefs], itemIds: [candidate.item.id] });
  }
  return [...byId.values()];
}

function searchResultToItem(result: ContextSearchResult): ContextPackItem {
  return { id: result.id, layer: result.layer, content: result.content, compressedContent: result.content, score: result.score, sourceRefs: result.sourceRefs, sourceMessageIds: result.sourceRefs.flatMap((source) => source.sourceType === "conversation_message" && typeof source.metadata?.messageId === "string" ? [source.metadata.messageId] : []), factIds: result.factIds, memoryIds: result.memoryIds, factContext: result.factContext, temporal: result.temporal };
}
function candidateContextItem(candidate: BenchmarkAnswerEvidenceCandidate): ContextPackItem { return { ...candidate.item, content: candidate.evidenceText, compressedContent: candidate.evidenceText }; }
function rejection(candidate: BenchmarkAnswerEvidenceCandidate, reason: BenchmarkAnswerRejectReason): BenchmarkAnswerEvidenceRejection { return { itemId: candidate.item.id, layer: candidate.item.layer, reason, contentChars: candidate.evidenceText.length }; }
function duplicateKey(candidate: BenchmarkAnswerEvidenceCandidate) { return candidate.item.factIds.length ? `facts:${[...candidate.item.factIds].sort().join("|")}` : `content:${normalize(candidate.evidenceText)}`; }
function identityIds(candidate: BenchmarkAnswerEvidenceCandidate) { return unique([candidate.item.id, ...candidate.item.memoryIds, ...candidate.item.factIds]); }
function ownsId(candidate: BenchmarkAnswerEvidenceCandidate, id: string) { return identityIds(candidate).includes(id); }
function completeness(candidate: BenchmarkAnswerEvidenceCandidate) { return [candidate.temporal.validTime, candidate.temporal.evidenceTime].filter(Boolean).length * 20 + candidate.relations.length * 10 + candidate.sourceRoles.filter((role) => role !== "unknown").length * 8 + candidate.sourceSessionIds.length * 5 + candidate.item.sourceRefs.length * 3 + Math.min(10, candidate.evidenceText.length / 200); }
function compareCandidates(a: BenchmarkAnswerEvidenceCandidate, b: BenchmarkAnswerEvidenceCandidate) { const ar = a.scoreBreakdown.reranker; const br = b.scoreBreakdown.reranker; if (ar !== undefined && br !== undefined && br !== ar) return br - ar; return b.relevanceScore - a.relevanceScore || (br ?? b.item.score) - (ar ?? a.item.score) || b.item.score - a.item.score || a.item.id.localeCompare(b.item.id); }
function candidateTime(candidate: BenchmarkAnswerEvidenceCandidate) { return candidate.temporal.validTime ?? candidate.temporal.evidenceTime ?? "9999"; }
function hasTemporal(candidate: BenchmarkAnswerEvidenceCandidate) { return Boolean(candidate.temporal.validTime || candidate.temporal.evidenceTime || candidate.temporal.events?.length); }
function needsTemporal(type: string, question: string) { return type.includes("temporal") || /\b(?:when|date|time|before|after|earlier|later|first|last|how long|ago|year|month|week|day)\b/iu.test(question); }
function needsCalculation(type: string, question: string) { return type.includes("multi-session") && /\b(?:how many|how much|total|sum|difference|cost|spent|amount|count|number|combined|altogether)\b/iu.test(question) || /\b(?:how many|how much|total|sum|difference|combined|altogether)\b/iu.test(question); }
function needsCount(type: string, question: string) { return type.includes("multi-session") && (/\b(?:how often|times?|occasions?|instances?)\b/iu.test(question) || /\bhow many\b.{0,80}\b(?:did|have|was|were)\s+i\b/iu.test(question) || /\bnumber of\b.{0,40}\b(?:events?|visits?|trips?|purchases?|appointments?)\b/iu.test(question)); }
const queryStopwords = new Set(["the", "and", "for", "with", "where", "what", "when", "which", "who", "whom", "whose", "why", "how", "long", "did", "does", "was", "were", "have", "has", "had", "much", "many", "from", "that", "this", "there", "their", "your", "you", "about", "after", "before", "into", "onto", "over", "under"]);
function relevance(question: string, text: string) { const terms = unique(question.toLowerCase().match(/[a-z0-9$]+/g)?.filter((term) => (term.length >= 3 || term.startsWith("$")) && !queryStopwords.has(term)) ?? []); const normalizedQuestion = normalize(question); const normalized = normalize(text); let entityOperandScore = 0; if (/\bage\b/u.test(normalizedQuestion)) { if (/\b(?:me|myself)\b/u.test(normalizedQuestion) && /\bi\b.{0,40}\b(?:am|turned)\b.{0,12}\b\d{1,3}\b/u.test(normalized)) entityOperandScore += 12; if (/\bparents?\b/u.test(normalizedQuestion) && /\b(?:mom|mother|dad|father)\b.{0,16}\b(?:is|was|aged?)\b.{0,8}\b\d{1,3}\b/u.test(normalized)) entityOperandScore += 12; if (/\bgrandparents?\b/u.test(normalizedQuestion) && /\b(?:grandma|grandmother|grandpa|grandfather)\b.{0,16}\b(?:is|was|aged?)\b.{0,8}\b\d{1,3}\b/u.test(normalized)) entityOperandScore += 12; } return terms.filter((term) => normalized.includes(term)).length * 2 + terms.slice(0, -1).filter((term, index) => normalized.includes(`${term} ${terms[index + 1]}`)).length * 5 + terms.filter((term) => /\d/u.test(term) && normalized.includes(term)).length * 3 + entityOperandScore; }
function inferSourceRoles(refs: SourceRef[], facts: FactItem[], roles: Map<string, BenchmarkAnswerSourceRole>): BenchmarkAnswerSourceRole[] { const direct = unique(facts.flatMap((fact) => (fact.sourceMessageIds ?? []).flatMap((id) => { const role = roles.get(id); return role && role !== "unknown" ? [role] : []; }))) as BenchmarkAnswerSourceRole[]; if (direct.length) return direct; const metadata = unique(refs.flatMap((ref) => { const role = sourceRole(ref.metadata?.role); return role === "unknown" ? [] : [role]; })) as BenchmarkAnswerSourceRole[]; if (metadata.length) return metadata; const inferred = unique(facts.flatMap((fact) => { const type = fact.factType.trim().toLowerCase(); const text = `${fact.factText}\n${fact.sourceClaim ?? ""}`.trim().toLowerCase(); if (type.startsWith("assistant_") || type === "assistant_response" || type.includes("recommendation") || /^(?:assistant|助手|助理)\s*[:：]/u.test(text)) return ["assistant"]; if (type.startsWith("user_") || /^(?:user|用户)\s*[:：]/u.test(text)) return ["user"]; return []; })) as BenchmarkAnswerSourceRole[]; return inferred.length ? inferred : ["unknown"]; }
function sourceRole(value: unknown): BenchmarkAnswerSourceRole { return value === "user" || value === "assistant" || value === "tool" ? value : "unknown"; }
function mergeTemporal(temporal: ContextPackItem["temporal"], facts: FactItem[]) { const evidenceTime = temporal.evidenceTime ?? facts.find((fact) => fact.evidenceTime)?.evidenceTime; const validTime = temporal.validTime ?? facts.find((fact) => fact.validTime)?.validTime; const events = [...new Map([...(temporal.events ?? []), ...facts.flatMap((fact) => fact.events ?? [])].map((event) => [`${event.eventKey}\0${event.validTime}`, event])).values()].sort((a, b) => a.validTime.localeCompare(b.validTime) || a.eventKey.localeCompare(b.eventKey)); return { ...(evidenceTime ? { evidenceTime } : {}), ...(validTime && events.length <= 1 ? { validTime } : {}), ...(events.length ? { events } : {}) }; }
function uniqueSourceRefs(refs: SourceRef[]) { const byId = new Map<string, SourceRef>(); for (const ref of refs) { const key = ref.sourceRefId || `${ref.sourceType}:${ref.sourceId}`; if (!byId.has(key)) byId.set(key, ref); } return [...byId.values()]; }
function metadataString(ref: SourceRef, key: string) { const value = ref.metadata?.[key]; return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function unique(values: string[]) { return [...new Set(values.filter(Boolean))]; }
function normalize(value: string) { return value.toLowerCase().replace(/\s+/g, " ").trim(); }
function clamp(value: number | undefined, fallback: number, min: number, max: number) { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value))); }
function validateInput(input: BenchmarkAnswerContextInput) { if (!input.question.trim()) throw new Error("benchmark question is required"); if (!input.questionId.trim()) throw new Error("benchmark questionId is required"); if (!input.contextScopeId.trim()) throw new Error("benchmark contextScopeId is required"); if (!input.allowedLayers.length) throw new Error("benchmark allowedLayers must not be empty"); }
