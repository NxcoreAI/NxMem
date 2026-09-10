import { createHash } from "node:crypto";
import type { FactItem, MemoryEvent, SourceRef } from "./domain.js";
import { getContextEngineConfig } from "../../config.js";
import { postOpenAiCompatibleJson, type OpenAiCompatibleRequestObserver } from "./llm-request.js";
import { memoryEventSummary, multimodalContentToText } from "./memory-event-fields.js";
import { isEnglishCanonicalFactText } from "./canonical-fact-language.js";

export interface TimelineAggregatedFact {
  aggregationId: string;
  factId: string;
  factType: string;
  factText: string;
  normalizedClaim: string;
  sourceEventIds: string[];
  sourceFactIds: string[];
  sourceSegmentIds: string[];
  sourceRefs: SourceRef[];
  evidenceTime?: string;
  validTime?: string;
  events?: NonNullable<FactItem["events"]>;
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  evidenceTimeConfidence?: FactItem["evidenceTimeConfidence"];
  sourceMessageIds?: string[];
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeBasis?: FactItem["validTimeBasis"];
  validTimeConfidence?: FactItem["validTimeConfidence"];
  timeBasis: FactItem["timeBasis"];
  timeConfidence: FactItem["timeConfidence"];
}

export const DEFAULT_TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface TimelineAggregationLlmOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  transport?: "fetch" | "openai-sdk-stream";
  observer?: OpenAiCompatibleRequestObserver;
  signal?: AbortSignal;
}

interface TimelineAggregationLlmPayload {
  groups?: Array<{
    factText?: unknown;
    normalizedClaim?: unknown;
    sourceFactIds?: unknown;
    confidenceLevel?: unknown;
  }>;
}

export function buildTimelineAggregatedFacts(facts: FactItem[]): TimelineAggregatedFact[] {
  const orderedFacts = [...facts].sort((left, right) => {
    const byTime = factSortTime(left).localeCompare(factSortTime(right));
    if (byTime !== 0) return byTime;
    const byType = left.factType.localeCompare(right.factType);
    return byType === 0 ? left.factId.localeCompare(right.factId) : byType;
  });
  const groups: FactItem[][] = [];

  for (const fact of orderedFacts) {
    const matchingGroup = findMatchingTimelineGroup(groups, fact);
    if (matchingGroup) {
      matchingGroup.push(fact);
      continue;
    }

    groups.push([fact]);
  }

  return groups.map((group, index) => buildAggregatedFactFromGroup(group, `timeline_agg_${index}`));
}

export async function buildTimelineAggregatedFactsWithLlm(
  facts: FactItem[],
  options: TimelineAggregationLlmOptions = {}
): Promise<TimelineAggregatedFact[]> {
  const fallbackFacts = buildOriginalTimelineAggregatedFacts(facts);
  const candidateGroups = buildTimelineLlmCandidateGroups(facts);
  if (!candidateGroups.some((group) => group.length > 1)) return fallbackFacts;

  const config = getContextEngineConfig();
  const apiKey = options.apiKey !== undefined ? options.apiKey.trim() : config.llm.apiKey;
  if (!apiKey) return fallbackFacts;

  try {
    const endpointBase = normalizeBaseUrl(options.baseUrl ?? config.llm.baseUrl);
    const endpoint = `${endpointBase}/chat/completions`;
    const model = options.model?.trim() || config.llm.model;
    const prompt = buildTimelineAggregationPrompt(candidateGroups);
    const response = await postOpenAiCompatibleJson({
      endpoint,
      apiKey,
      operation: "timeline_aggregation",
      transport: options.transport ?? "openai-sdk-stream",
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      body: {
        model,
        messages: [
          {
            role: "system",
            content: "你是 Context 引擎的时间轴聚合器。只返回严格 JSON，不要输出 Markdown、解释或推理过程。"
          },
          { role: "user", content: prompt }
        ],
        temperature: 0
      }
    });
    const payload = parseTimelineAggregationResponse(response);
    return buildTimelineAggregatedFactsFromLlmGroups(facts, payload, fallbackFacts);
  } catch {
    return fallbackFacts;
  }
}

export function materializeTimelineAggregatedFacts(
  originalFacts: readonly FactItem[],
  aggregatedFacts: readonly TimelineAggregatedFact[],
  observedAt: string
): FactItem[] {
  const factsById = new Map(originalFacts.map((fact) => [fact.factId, fact]));
  return aggregatedFacts.flatMap((item) => {
    const sourceFacts = item.sourceFactIds.flatMap((factId) => {
      const fact = factsById.get(factId);
      return fact ? [fact] : [];
    });
    if (sourceFacts.length !== item.sourceFactIds.length || !sourceFacts.length) return [];
    if (sourceFacts.length === 1) return [sourceFacts[0]!];

    const representative = selectTimelineRepresentativeFact(sourceFacts);
    const {
      evidenceTime: _evidenceTime,
      validTime: _validTime,
      events: _events,
      evidenceTimeStart: _evidenceTimeStart,
      evidenceTimeEnd: _evidenceTimeEnd,
      evidenceTimeConfidence: _evidenceTimeConfidence,
      sourceMessageIds: _sourceMessageIds,
      validTimeStart: _validTimeStart,
      validTimeEnd: _validTimeEnd,
      validTimeBasis: _validTimeBasis,
      validTimeConfidence: _validTimeConfidence,
      ...representativeBase
    } = representative;
    return [{
      ...representativeBase,
      factId: item.factId,
      factType: item.factType,
      factText: item.factText,
      sourceClaim: uniqueStrings(sourceFacts.map((fact) => fact.sourceClaim ?? fact.factText)).join("\n"),
      normalizedClaim: item.normalizedClaim,
      linkedEventIds: item.sourceEventIds,
      linkedSegmentIds: item.sourceSegmentIds,
      linkedSourceRefs: item.sourceRefs,
      entityIds: uniqueStrings(sourceFacts.flatMap((fact) => fact.entityIds)),
      confidenceLevel: lowestConfidence(sourceFacts.map((fact) => fact.confidenceLevel)),
      version: 1,
      status: "active",
      observedAt,
      ...(item.evidenceTime ? { evidenceTime: item.evidenceTime } : {}),
      ...(item.validTime ? { validTime: item.validTime } : {}),
      ...(item.events?.length ? { events: item.events } : {}),
      ...(item.evidenceTimeStart ? { evidenceTimeStart: item.evidenceTimeStart } : {}),
      ...(item.evidenceTimeEnd ? { evidenceTimeEnd: item.evidenceTimeEnd } : {}),
      ...(item.evidenceTimeConfidence ? { evidenceTimeConfidence: item.evidenceTimeConfidence } : {}),
      sourceMessageIds: item.sourceMessageIds ?? [],
      ...(item.validTimeStart ? { validTimeStart: item.validTimeStart } : {}),
      ...(item.validTimeEnd ? { validTimeEnd: item.validTimeEnd } : {}),
      ...(item.validTimeBasis ? { validTimeBasis: item.validTimeBasis } : {}),
      ...(item.validTimeConfidence ? { validTimeConfidence: item.validTimeConfidence } : {}),
      timeBasis: item.validTimeBasis ?? item.timeBasis,
      timeConfidence: item.validTimeConfidence ?? item.timeConfidence,
      schemaVersion: "timeline-fused-fact.v1"
    }];
  });
}

function buildOriginalTimelineAggregatedFacts(facts: FactItem[]) {
  return [...facts]
    .sort(compareFacts)
    .map((fact) => buildAggregatedFactFromGroup([fact], `timeline_original_${fact.factId}`));
}

function buildTimelineLlmCandidateGroups(facts: FactItem[]) {
  const orderedFacts = [...facts].sort((left, right) => {
    const byTime = factSortTime(left).localeCompare(factSortTime(right));
    return byTime === 0 ? left.factId.localeCompare(right.factId) : byTime;
  });
  const groups: FactItem[][] = [];

  for (const fact of orderedFacts) {
    const matchingGroup = groups.find((group) => group.some((candidate) => shareLinkedEvent(candidate, fact)));
    if (matchingGroup) {
      matchingGroup.push(fact);
      continue;
    }
    groups.push([fact]);
  }

  return groups;
}

function buildTimelineAggregationPrompt(candidateGroups: FactItem[][]) {
  const payload = {
    instruction: "判断哪些事实描述同一时间轴事件，并在事实互相补充且不冲突时合成为一条完整事实。",
    constraints: [
      "When merging facts, write factText and normalizedClaim in concise English with a clear subject, predicate, and object. Preserve all important qualifiers and the original meaning.",
      "只能使用 inputGroups 中存在的 factId。",
      "只能合并同一个 inputGroup 内的事实；每个输出组至少包含两个 sourceFactIds。",
      "不要把只是时间接近但语义无关的事实合并。",
      "使用 factType 和 normalizedClaim 判断语义角色，使用 entityIds 判断实体一致性，使用 validTimeStart/End、status 和 version 判断是否为旧值、新值、纠正或撤回；factType 不同本身不阻止互补事实融合。",
      "linkedEventIds 是同 Session 边界；sourceMessageIds、sourceSegmentIds 和 sourceRefs 是来源依据，融合只能改写文本，不能缩小来源覆盖。",
      "第一人称我/本人/自己与用户指代相同；现在/正在等时态词不应阻止合并。",
      "当事实互相补充且不冲突时，factText 必须整合全部关键信息。",
      "必须保留数字及其单位/币种、日期和时间表达、英文专有名词、否定/排除项、条件、不确定性以及每天、单程、往返、至少、最多等范围和频率限定词。",
      "factText 和 normalizedClaim 必须各自独立保留所有金额、日期、时间、数量、比例、频率、时长、区间值及单位；不能只在其中一个字段保留。",
      "普通有序列表必须保留全部条目及原始顺序/名次；旧值和新值同时存在时必须明确表达变化并保留两者，不能只输出最终值。",
      "无法可靠融合的事实不要输出；系统会保留未使用的原始事实。",
      "factText and normalizedClaim must be written in concise English, regardless of the input language, while preserving the evidence meaning, dates, numbers, names, qualifiers, and uncertainty.",
      "不要输出推理过程。"
    ],
    outputSchema: {
      groups: [
        {
          factText: "融合后的用户可读事实文本",
          normalizedClaim: "融合后的标准化主张",
          sourceFactIds: ["fact_id"],
          confidenceLevel: "low | medium | high"
        }
      ]
    },
    inputGroups: candidateGroups.map((group, index) => ({
      groupId: `candidate_${index}`,
      facts: group.map((fact) => ({
        factId: fact.factId,
        factType: fact.factType,
        factText: fact.factText,
        normalizedClaim: fact.normalizedClaim,
        entityIds: fact.entityIds,
        validTimeStart: fact.validTimeStart ?? null,
        validTimeEnd: fact.validTimeEnd ?? null,
        validTimeBasis: fact.validTimeBasis ?? null,
        timeBasis: fact.timeBasis,
        timeConfidence: fact.timeConfidence,
        confidenceLevel: fact.confidenceLevel,
        status: fact.status,
        version: fact.version,
        sourceEventIds: fact.linkedEventIds,
        sourceSegmentIds: fact.linkedSegmentIds,
        sourceMessageIds: fact.sourceMessageIds ?? [],
        sourceRefs: fact.linkedSourceRefs
      }))
    }))
  };

  return JSON.stringify(payload, null, 2);
}

function parseTimelineAggregationResponse(rawResponse: unknown): TimelineAggregationLlmPayload {
  const content = extractMessageContent(rawResponse);
  const payload = typeof content === "string" ? JSON.parse(content) : content;
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid_timeline_aggregation_payload");
  }
  return payload as TimelineAggregationLlmPayload;
}

function extractMessageContent(rawResponse: unknown): unknown {
  if (!rawResponse || typeof rawResponse !== "object") return rawResponse;
  const choices = (rawResponse as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return rawResponse;
  const first = choices[0] as { message?: { content?: unknown } };
  return first.message?.content ?? rawResponse;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function buildTimelineAggregatedFactsFromLlmGroups(
  facts: FactItem[],
  payload: TimelineAggregationLlmPayload,
  fallbackFacts: TimelineAggregatedFact[]
) {
  if (!Array.isArray(payload.groups)) return fallbackFacts;

  const factsById = new Map(facts.map((fact) => [fact.factId, fact]));
  const usedFactIds = new Set<string>();
  const output: TimelineAggregatedFact[] = [];

  for (const item of payload.groups) {
    const sourceFactIds = [...new Set(parseStringArray(item.sourceFactIds))];
    if (sourceFactIds.length < 2 || sourceFactIds.some((factId) => !factsById.has(factId) || usedFactIds.has(factId))) continue;
    const groupFacts = sourceFactIds.map((factId) => factsById.get(factId)!).sort((left, right) => {
      const byTime = factSortTime(left).localeCompare(factSortTime(right));
      return byTime === 0 ? left.factId.localeCompare(right.factId) : byTime;
    });
    const factText = typeof item.factText === "string" ? item.factText.trim() : "";
    const normalizedClaim = typeof item.normalizedClaim === "string" ? item.normalizedClaim.trim() : "";
    if (!factText || !normalizedClaim || !isValidLlmTimelineGroup(groupFacts)) continue;
    if (!isEnglishCanonicalFactText(factText, normalizedClaim)) continue;
    if (!preservesProtectedDetails(groupFacts, factText)) continue;
    if (!preservesProtectedDetails(groupFacts, normalizedClaim)) continue;
    const fallback = buildAggregatedFactFromGroup(groupFacts, `timeline_llm_agg_${output.length}`);
    const fusedFactId = stableTimelineFusedFactId(groupFacts);

    for (const factId of sourceFactIds) usedFactIds.add(factId);
    output.push({
      ...fallback,
      aggregationId: `timeline_llm_agg_${fusedFactId}`,
      factId: fusedFactId,
      factText,
      normalizedClaim,
      sourceFactIds: groupFacts.map((fact) => fact.factId)
    });
  }

  for (const fallback of fallbackFacts) {
    if (fallback.sourceFactIds.some((factId) => usedFactIds.has(factId))) continue;
    output.push(fallback);
  }

  return output.sort((left, right) => timelineSortTime(left).localeCompare(timelineSortTime(right)));
}

function buildAggregatedFactFromGroup(group: FactItem[], aggregationPrefix: string): TimelineAggregatedFact {
  const ordered = [...group].sort((left, right) => {
    const byTime = factSortTime(left).localeCompare(factSortTime(right));
    return byTime === 0 ? left.factId.localeCompare(right.factId) : byTime;
  });
  const sourceEventIds = [...new Set(ordered.flatMap((fact) => arrayOrEmpty(fact.linkedEventIds)))];
  const sourceSegmentIds = [...new Set(ordered.flatMap((fact) => arrayOrEmpty(fact.linkedSegmentIds)))];
  const sourceRefs = mergeSourceRefs(ordered.flatMap((fact) => arrayOrEmpty(fact.linkedSourceRefs)));
  const first = ordered[0]!;
  const representative = selectTimelineRepresentativeFact(ordered);
  const displayFact = buildTimelineDisplayFact(ordered, representative);
  const evidenceTime = firstDefined(ordered.map((fact) => fact.evidenceTime).sort(compareOptionalTimes));
  const validTime = firstDefined(ordered.map((fact) => fact.validTime).sort(compareOptionalTimes));
  const events = mergeTimelineTemporalEvents(ordered);
  const evidenceTimeStart = firstDefined(ordered.map((fact) => fact.evidenceTimeStart).sort(compareOptionalTimes));
  const evidenceTimeEnd = firstDefined(
    ordered.map((fact) => fact.evidenceTimeEnd).sort(compareOptionalTimes).reverse()
  );
  const validFacts = ordered.filter((fact) => fact.validTimeStart);
  const validFirst = validFacts[0];
  const validLast = validFacts.at(-1);

  return {
    aggregationId: `${aggregationPrefix}_${first.factId}`,
    factId: first.factId,
    factType: first.factType,
    factText: displayFact.factText,
    normalizedClaim: displayFact.normalizedClaim,
    sourceEventIds,
    sourceFactIds: ordered.map((fact) => fact.factId),
    sourceSegmentIds,
    sourceRefs,
    ...(evidenceTime ? { evidenceTime } : {}),
    ...(validTime && events.length <= 1 ? { validTime } : {}),
    ...(events.length ? { events } : {}),
    ...(evidenceTimeStart ? { evidenceTimeStart } : {}),
    ...(evidenceTimeEnd ? { evidenceTimeEnd } : {}),
    evidenceTimeConfidence: lowestFactTimeConfidence(ordered.map((fact) => fact.evidenceTimeConfidence ?? "low")),
    sourceMessageIds: [...new Set(ordered.flatMap((fact) => fact.sourceMessageIds ?? []))],
    ...(validFirst?.validTimeStart ? { validTimeStart: validFirst.validTimeStart } : {}),
    ...(validLast?.validTimeEnd ? { validTimeEnd: validLast.validTimeEnd } : {}),
    ...(validFirst?.validTimeBasis ? { validTimeBasis: validFirst.validTimeBasis } : {}),
    validTimeConfidence: lowestFactTimeConfidence(
      validFacts.map((fact) => fact.validTimeConfidence ?? fact.timeConfidence)
    ),
    timeBasis: validFirst?.validTimeBasis ?? first.timeBasis,
    timeConfidence: validFacts.length
      ? lowestFactTimeConfidence(validFacts.map((fact) => fact.validTimeConfidence ?? fact.timeConfidence))
      : first.timeConfidence
  };
}

function mergeTimelineTemporalEvents(facts: FactItem[]) {
  const byIdentity = new Map<string, NonNullable<FactItem["events"]>[number]>();
  for (const fact of facts) {
    const sourceEvents = fact.events?.length
      ? fact.events
      : fact.validTime
        ? [{
            eventKey: `fact_${createHash("sha256").update(fact.normalizedClaim).digest("hex").slice(0, 12)}`,
            label: fact.factText,
            validTime: fact.validTime,
            ...(fact.evidenceTime ? { evidenceTime: fact.evidenceTime } : {}),
            sourceFactIds: [fact.factId]
          }]
        : [];
    for (const event of sourceEvents) {
      const sourceFactIds = [...new Set([...(event.sourceFactIds ?? []), fact.factId])];
      byIdentity.set(`${event.eventKey}\u0000${event.validTime}`, { ...event, sourceFactIds });
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.validTime.localeCompare(right.validTime) || left.eventKey.localeCompare(right.eventKey)
  );
}

function isValidLlmTimelineGroup(facts: FactItem[]) {
  if (facts.length < 2) return false;
  const sharedEventIds = new Set(facts[0]!.linkedEventIds);
  for (const fact of facts.slice(1)) {
    for (const eventId of [...sharedEventIds]) {
      if (!fact.linkedEventIds.includes(eventId)) sharedEventIds.delete(eventId);
    }
  }
  return sharedEventIds.size > 0;
}

function shareLinkedEvent(left: FactItem, right: FactItem) {
  return left.linkedEventIds.some((eventId) => right.linkedEventIds.includes(eventId));
}

function preservesProtectedDetails(facts: readonly FactItem[], fusedText: string) {
  const normalizedFusedText = fusedText.normalize("NFKC").toLocaleLowerCase();
  if (!protectedDetailTokens(facts).every((token) => normalizedFusedText.includes(token.toLocaleLowerCase()))) {
    return false;
  }
  if (!preservesTranslatedQualifiers(facts, normalizedFusedText)) return false;
  if (!preservesExplicitListOrder(facts, normalizedFusedText)) return false;
  const sourceText = facts.map((fact) => `${fact.factText}\n${fact.normalizedClaim}`).join("\n");
  if (/\p{Script=Han}/u.test(sourceText) && !/\p{Script=Han}/u.test(normalizedFusedText)) return true;
  if (!/\p{Script=Han}/u.test(sourceText) && !/\p{Script=Han}/u.test(normalizedFusedText)) return true;
  const canonicalFusedText = canonicalizeTimelineClaim(normalizedFusedText);
  return facts.every((fact) => {
    const sourceClaim = canonicalizeTimelineClaim(fact.normalizedClaim || fact.factText).replace(/^用户/gu, "");
    if (!sourceClaim) return false;
    if (canonicalFusedText.includes(sourceClaim)) return true;
    const requiredSubstringLength = Math.min(4, sourceClaim.length);
    return longestCommonSubstringLength(sourceClaim, canonicalFusedText) >= requiredSubstringLength &&
      characterContainment(sourceClaim, canonicalFusedText) >= 0.45;
  });
}

function protectedDetailTokens(facts: readonly FactItem[]) {
  const text = facts.map((fact) => `${fact.factText}\n${fact.normalizedClaim}`).join("\n").normalize("NFKC");
  return uniqueStrings([
    ...(text.match(/\d+(?:[.:：]\d+)?(?:\.\d+)?/gu) ?? []),
    ...(text.match(/\b(?=[A-Za-z0-9._+-]*(?:\d|[A-Z]))[A-Za-z][A-Za-z0-9._+-]*\b/gu) ?? []),
    ...(text.match(/\b(?:percent|percentage|pounds?|lbs?|ounces?|oz|kilograms?|kgs?|grams?|miles?|kilometers?|kilometres?|meters?|metres?|minutes?|hours?|days?|weeks?|months?|years?)\b/giu) ?? []),
    ...(text.match(/\b(?:last|next|this)\s+(?:minute|hour|day|week|month|year|morning|afternoon|evening|night|weekend)\b/giu) ?? [])
  ]);
}

function preservesTranslatedQualifiers(facts: readonly FactItem[], fusedText: string) {
  const sourceText = facts.map((fact) => `${fact.factText}\n${fact.normalizedClaim}`).join("\n").normalize("NFKC");
  const qualifiers: Array<{ source: RegExp; targets: RegExp }> = [
    { source: /每天|每日/gu, targets: /\b(?:daily|every day)\b/iu },
    { source: /每周/gu, targets: /\b(?:weekly|every week)\b/iu },
    { source: /每月/gu, targets: /\b(?:monthly|every month)\b/iu },
    { source: /每年/gu, targets: /\b(?:yearly|annually|every year)\b/iu },
    { source: /单程/gu, targets: /\bone-way\b/iu },
    { source: /往返/gu, targets: /\bround-trip\b/iu },
    { source: /至少/gu, targets: /\bat least\b/iu },
    { source: /至多|最多/gu, targets: /\bat most\b/iu },
    { source: /最少/gu, targets: /\bminimum\b/iu },
    { source: /超过/gu, targets: /\b(?:more than|over)\b/iu },
    { source: /不足/gu, targets: /\b(?:less than|under)\b/iu },
    { source: /之前|以前/gu, targets: /\bbefore\b/iu },
    { source: /之后|以后/gu, targets: /\bafter\b/iu },
    { source: /(?:分钟|分种|\bminutes?\b)/giu, targets: /\bminutes?\b/iu },
    { source: /(?:小时|\bhours?\b)/giu, targets: /\bhours?\b/iu },
    { source: /(?:公里|千米|\bkilometers?\b|\bkilometres?\b|\bkm\b)/giu, targets: /\b(?:kilometers?|kilometres?|km)\b/iu },
    { source: /(?:英里|\bmiles?\b|\bmi\b)/giu, targets: /\b(?:miles?|mi)\b/iu },
    { source: /(?:美元|美金|\$|\bUSD\b|\bdollars?\b)/giu, targets: /(?:\$|\b(?:usd|dollars?)\b)/iu },
    { source: /(?:人民币|\d\s*元|¥|￥|\bCNY\b|\bRMB\b|\byuan\b)/giu, targets: /(?:¥|￥|\b(?:cny|rmb|yuan)\b)/iu },
    { source: /(?:不(?:喜欢|使用|需要|接受|允许|计划|会|能|是|有)|\bnot\b|\bnever\b|\bwithout\b|\bno longer\b|\bdoesn't\b|\bdoes not\b|\bdo not\b)/giu, targets: /\b(?:not|never|without|no longer|doesn't|does not|do not|isn't|is not|has no)\b/iu }
  ];
  if (!qualifiers.every(({ source, targets }) => !source.test(sourceText) || targets.test(fusedText))) {
    return false;
  }
  const hasOldAndNewState = /(?:以前|之前|过去|原来).*(?:现在|目前|如今)|(?:现在|目前|如今).*(?:以前|之前|过去|原来)/su.test(sourceText) ||
    /\b(?:previously|formerly|before|used to)\b[\s\S]*\b(?:now|currently)\b|\b(?:now|currently)\b[\s\S]*\b(?:previously|formerly|before|used to)\b/iu.test(sourceText);
  return !hasOldAndNewState || (
    /\b(?:previously|formerly|before|used to)\b/iu.test(fusedText) &&
    /\b(?:now|currently)\b/iu.test(fusedText)
  );
}

function preservesExplicitListOrder(facts: readonly FactItem[], fusedText: string) {
  const sourceText = facts.map((fact) => `${fact.factText}\n${fact.normalizedClaim}`).join("\n");
  const anchors = [...sourceText.matchAll(
    /(?:\b(?:first|second|third|fourth|fifth)\b|(?<!\d)[1-5][.)、])\s+(?:the\s+)?([A-Z][A-Za-z0-9._+-]*)/gu
  )].map((match) => match[1]!).filter(Boolean);
  if (anchors.length < 2) return true;
  let previousIndex = -1;
  for (const anchor of anchors) {
    const index = fusedText.indexOf(anchor.toLocaleLowerCase());
    if (index < 0 || index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

function stableTimelineFusedFactId(facts: readonly FactItem[]) {
  const sourceFactIds = facts.map((fact) => fact.factId).sort().join("|");
  const digest = createHash("sha256").update(sourceFactIds, "utf8").digest("hex").slice(0, 24);
  return `fact_timeline_fused_${digest}`;
}

function findMatchingTimelineGroup(groups: FactItem[][], fact: FactItem) {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    if (group.some((candidate) => shouldMergeTimelineFacts(candidate, fact))) {
      return group;
    }
  }
  return undefined;
}

export function shouldMergeTimelineFacts(left: FactItem, right: FactItem) {
  if (!hasCompatibleMergeKind(left, right)) return false;
  if (!areFactsWithinTimelineWindow(left, right)) return false;
  return areTimelineClaimsOverlapping(left, right);
}

function areFactsWithinTimelineWindow(left: FactItem, right: FactItem) {
  const leftTime = Date.parse(factSortTime(left));
  const rightTime = Date.parse(factSortTime(right));
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return false;
  return Math.abs(rightTime - leftTime) <= DEFAULT_TIMELINE_WINDOW_MS;
}

function factSortTime(fact: FactItem) {
  return fact.validTime ?? fact.validTimeStart ?? fact.evidenceTime ?? fact.evidenceTimeStart ?? fact.observedAt;
}

function compareFacts(left: FactItem, right: FactItem) {
  const byTime = factSortTime(left).localeCompare(factSortTime(right));
  return byTime === 0 ? left.factId.localeCompare(right.factId) : byTime;
}

function timelineSortTime(fact: TimelineAggregatedFact) {
  return fact.validTime ?? fact.validTimeStart ?? fact.evidenceTime ?? fact.evidenceTimeStart ?? "";
}

function compareOptionalTimes(left: string | undefined, right: string | undefined) {
  if (!left) return 1;
  if (!right) return -1;
  return Date.parse(left) - Date.parse(right);
}

function firstDefined<T>(values: readonly (T | undefined)[]) {
  return values.find((value): value is T => value !== undefined);
}

function lowestFactTimeConfidence(values: readonly ("low" | "medium" | "high")[]) {
  const ranks = { low: 0, medium: 1, high: 2 } as const;
  return [...values].sort((left, right) => ranks[left] - ranks[right])[0] ?? "low";
}

function lowestConfidence(values: readonly FactItem["confidenceLevel"][]) {
  return lowestFactTimeConfidence(values);
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))];
}

function hasCompatibleMergeKind(left: FactItem, right: FactItem) {
  const leftKind = getTimelineMergeKind(left);
  const rightKind = getTimelineMergeKind(right);
  if (leftKind !== rightKind) return false;
  if (leftKind === "episodic") return true;
  return left.factType === right.factType;
}

function getTimelineMergeKind(fact: FactItem) {
  return isBroadEpisodicFactType(fact.factType) ? "episodic" : `typed:${fact.factType}`;
}

function isBroadEpisodicFactType(factType: string) {
  return factType === "timeline" || factType === "text" || factType === "document" || factType === "tool_result";
}

function areTimelineClaimsOverlapping(left: FactItem, right: FactItem) {
  const leftClaims = timelineClaimCandidates(left);
  const rightClaims = timelineClaimCandidates(right);
  return leftClaims.some((leftClaim) =>
    rightClaims.some((rightClaim) => areCanonicalTimelineClaimsOverlapping(leftClaim, rightClaim))
  );
}

function timelineClaimCandidates(fact: FactItem) {
  return [...new Set([fact.normalizedClaim, fact.factText].map(canonicalizeTimelineClaim).filter(Boolean))];
}

function areCanonicalTimelineClaimsOverlapping(leftClaim: string, rightClaim: string) {
  if (!leftClaim || !rightClaim) return false;
  if (leftClaim === rightClaim) return true;

  const overlap = characterContainment(leftClaim, rightClaim);
  const commonSubstringLength = longestCommonSubstringLength(leftClaim, rightClaim);
  const sharesEventVerb = hasSharedEventVerb(leftClaim, rightClaim);

  if (sharesEventVerb && overlap >= 0.72) return true;
  if (sharesEventVerb && commonSubstringLength >= 3) return true;
  return commonSubstringLength >= 4 && overlap >= 0.62;
}

export function canonicalizeTimelineClaim(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”"‘’'`·,，。.!！?？:：;；、（）()[\]{}<>《》\s]/g, "")
    .replace(/本人|自己|我/g, "用户")
    .replace(/现在|正在|此刻|此时|目前|当前|刚刚|刚才|今天|当时|已经|仍在|正/g, "")
    .replace(/[了过着]/g, "")
    .trim();
}

function characterContainment(left: string, right: string) {
  const leftChars = new Set([...left]);
  const rightChars = new Set([...right]);
  const smallerSize = Math.min(leftChars.size, rightChars.size);
  if (!smallerSize) return 0;
  let shared = 0;
  for (const char of leftChars) {
    if (rightChars.has(char)) shared += 1;
  }
  return shared / smallerSize;
}

function longestCommonSubstringLength(left: string, right: string) {
  let longest = 0;
  const previous = new Array(right.length + 1).fill(0);
  const current = new Array(right.length + 1).fill(0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        current[rightIndex] = previous[rightIndex - 1] + 1;
        longest = Math.max(longest, current[rightIndex]);
      } else {
        current[rightIndex] = 0;
      }
    }
    for (let index = 0; index < current.length; index += 1) {
      previous[index] = current[index];
      current[index] = 0;
    }
  }

  return longest;
}

function hasSharedEventVerb(left: string, right: string) {
  const leftPredicate = stripTimelineActorPronouns(left);
  const rightPredicate = stripTimelineActorPronouns(right);
  const eventVerbs = [
    "吃",
    "喝",
    "买",
    "卖",
    "看",
    "读",
    "写",
    "做",
    "用",
    "聊",
    "说",
    "问",
    "答",
    "开会",
    "参加",
    "到达",
    "离开",
    "完成",
    "进入",
    "处理",
    "讨论",
    "搜索",
    "创建",
    "删除",
    "更新"
  ];
  return eventVerbs.some((verb) => leftPredicate.includes(verb) && rightPredicate.includes(verb));
}

function stripTimelineActorPronouns(value: string) {
  return value.replace(/用户|本人|自己|我/gu, "");
}

export function selectTimelineRepresentativeFact(facts: FactItem[]) {
  return [...facts].sort((left, right) => {
    const byScore = representativeScore(right) - representativeScore(left);
    return byScore === 0 ? left.factId.localeCompare(right.factId) : byScore;
  })[0]!;
}

function buildTimelineDisplayFact(facts: FactItem[], representative: FactItem) {
  if (facts.length === 1 || factCoversMergedEvidence(representative, facts)) {
    return {
      factText: representative.factText,
      normalizedClaim: representative.normalizedClaim
    };
  }

  const factText = selectInformativeTexts([representative.factText, ...facts.map((fact) => fact.factText)]).join("；");
  const normalizedClaim = uniqueTexts([
    representative.normalizedClaim,
    ...facts.map((fact) => fact.normalizedClaim || fact.factText)
  ]).join("；");
  return { factText, normalizedClaim };
}

function factCoversMergedEvidence(fact: FactItem, facts: FactItem[]) {
  const allEventIds = new Set(facts.flatMap((item) => arrayOrEmpty(item.linkedEventIds)));
  const allSegmentIds = new Set(facts.flatMap((item) => arrayOrEmpty(item.linkedSegmentIds)));
  const factEventIds = new Set(arrayOrEmpty(fact.linkedEventIds));
  const factSegmentIds = new Set(arrayOrEmpty(fact.linkedSegmentIds));

  return isSuperset(factEventIds, allEventIds) || isSuperset(factSegmentIds, allSegmentIds);
}

function isSuperset<T>(candidate: Set<T>, required: Set<T>) {
  if (!required.size) return false;
  for (const item of required) {
    if (!candidate.has(item)) return false;
  }
  return true;
}

function uniqueTexts(texts: string[]) {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const text of texts) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

function selectInformativeTexts(texts: string[]) {
  const values = uniqueTexts(texts);
  const selected: string[] = [];
  for (const value of values) {
    if (selected.some((existing) => coversTimelineDetails(existing, value))) continue;
    selected.push(value);
  }
  return selected;
}

function coversTimelineDetails(existing: string, candidate: string) {
  const existingClaim = canonicalizeTimelineClaim(existing);
  const candidateClaim = canonicalizeTimelineClaim(candidate);
  if (!existingClaim || !candidateClaim) return false;
  if (existingClaim.includes(candidateClaim)) return true;

  const existingChars = new Set([...existingClaim]);
  const candidateChars = new Set([...candidateClaim]);
  if (!candidateChars.size) return false;
  for (const char of candidateChars) {
    if (!existingChars.has(char)) return false;
  }
  return true;
}

function representativeScore(fact: FactItem) {
  const claim = canonicalizeTimelineClaim(fact.normalizedClaim || fact.factText);
  const sourceCoverage =
    arrayOrEmpty(fact.linkedEventIds).length +
    arrayOrEmpty(fact.linkedSegmentIds).length +
    arrayOrEmpty(fact.linkedSourceRefs).length;
  const confidenceScore = fact.confidenceLevel === "high" ? 12 : fact.confidenceLevel === "medium" ? 6 : 0;
  const firstPersonPenalty = /(^|[，。,\s])(我|本人|自己)/.test(fact.factText) ? 4 : 0;
  return confidenceScore + sourceCoverage * 3 + claim.length - firstPersonPenalty;
}

function mergeSourceRefs(sourceRefs: SourceRef[]) {
  const seen = new Set<string>();
  const merged: SourceRef[] = [];
  for (const ref of sourceRefs) {
    if (!ref?.sourceRefId) continue;
    if (seen.has(ref.sourceRefId)) continue;
    seen.add(ref.sourceRefId);
    merged.push(ref);
  }
  return merged;
}

function arrayOrEmpty<T>(items: T[] | undefined): T[] {
  return Array.isArray(items) ? items : [];
}

export function summarizeAggregatedFacts(aggregatedFacts: TimelineAggregatedFact[], event: MemoryEvent) {
  const evidence = aggregatedFacts.length
    ? aggregatedFacts.map((fact) => fact.factText).join("\n")
    : event.multimodalData
      .map((item) => multimodalContentToText(item.content))
      .filter(Boolean)
      .join("\n");

  return [
    `时间轴聚合事件：${memoryEventSummary(event)}`,
    `事件时间：${event.eventTime}`,
    `来源：${event.sourceId ?? event.sourceApp ?? event.eventId}`,
    `聚合证据：${evidence}`
  ].join("\n");
}
