import type { FactItem, TimelineFusionWindow } from "./domain.js";
import { normalizeTimelineFusionWindow } from "./timeline-fusion-execution.js";

export const TIMELINE_FUSION_RELATION_TYPES = [
  "same_event",
  "supports",
  "supplements",
  "updates",
  "conflicts",
  "unrelated",
  "needs_review"
] as const;

export type TimelineFusionRelationType = typeof TIMELINE_FUSION_RELATION_TYPES[number];
export type TimelineFusionRelationConfidence = "low" | "medium" | "high";

export interface TimelineFusionRelation {
  type: TimelineFusionRelationType;
  sourceFactIds: string[];
  factText?: string;
  normalizedClaim?: string;
  confidenceLevel: TimelineFusionRelationConfidence;
  reasonCode: string;
}

export interface TimelineFusionRelationResult {
  schemaVersion: "timeline-fusion-relations.v1";
  relations: TimelineFusionRelation[];
  unusedFactIds: string[];
}

export interface TimelineFusionCompatibleRelationResult {
  responseFormat: "relations" | "legacy_groups";
  result: TimelineFusionRelationResult;
}

export interface TimelineFusionRelationFactInput {
  factId: string;
  isNew: boolean;
  factType: string;
  factText: string;
  normalizedClaim: string;
  entityIds: string[];
  confidenceLevel: FactItem["confidenceLevel"];
  linkedEventIds: string[];
  linkedSegmentIds: string[];
  sourceRefIds: string[];
  sourceMessageIds: string[];
  evidenceTimeStart: string | null;
  evidenceTimeEnd: string | null;
  evidenceTimeConfidence: FactItem["evidenceTimeConfidence"] | null;
  validTimeStart: string | null;
  validTimeEnd: string | null;
  validTimeBasis: FactItem["validTimeBasis"] | null;
  validTimeConfidence: FactItem["validTimeConfidence"] | null;
}

export interface TimelineFusionRelationInput {
  schemaVersion: "timeline-fusion-relation-input.v1";
  temporalWindow: TimelineFusionWindow;
  newFactIds: string[];
  facts: TimelineFusionRelationFactInput[];
}

export class TimelineFusionRelationProtocolError extends Error {
  constructor(
    readonly code:
      | "TIMELINE_FUSION_RELATION_INPUT_INVALID"
      | "TIMELINE_FUSION_RELATION_RESPONSE_INVALID"
      | "TIMELINE_FUSION_RELATION_DETAILS_LOST",
    message: string
  ) {
    super(message);
    this.name = "TimelineFusionRelationProtocolError";
  }
}

const MATERIALIZING_RELATION_TYPES = new Set<TimelineFusionRelationType>([
  "same_event",
  "supplements",
  "updates"
]);
const RELATION_TYPES = new Set<TimelineFusionRelationType>(TIMELINE_FUSION_RELATION_TYPES);
const CONFIDENCE_LEVELS = new Set<TimelineFusionRelationConfidence>(["low", "medium", "high"]);
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/u;
const RELATION_KEYS = new Set([
  "type",
  "sourceFactIds",
  "factText",
  "normalizedClaim",
  "confidenceLevel",
  "reasonCode"
]);
const LEGACY_GROUP_KEYS = new Set([
  "factText",
  "normalizedClaim",
  "sourceFactIds",
  "confidenceLevel"
]);

export const timelineFusionRelationsJsonSchema = {
  name: "timeline_fusion_relations",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["relations"],
    properties: {
      relations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "sourceFactIds",
            "factText",
            "normalizedClaim",
            "confidenceLevel",
            "reasonCode"
          ],
          properties: {
            type: { type: "string", enum: TIMELINE_FUSION_RELATION_TYPES },
            sourceFactIds: {
              type: "array",
              minItems: 2,
              uniqueItems: true,
              items: { type: "string", minLength: 1 }
            },
            factText: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
            normalizedClaim: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
            confidenceLevel: { type: "string", enum: ["low", "medium", "high"] },
            reasonCode: { type: "string", pattern: "^[a-z][a-z0-9_]{2,63}$" }
          }
        }
      }
    }
  }
} as const;

export function buildTimelineFusionRelationInput(input: {
  newFacts: readonly FactItem[];
  candidateFacts: readonly FactItem[];
  temporalWindow: TimelineFusionWindow;
}): TimelineFusionRelationInput {
  const newFacts = uniqueFacts(input.newFacts, "newFacts");
  const candidateFacts = uniqueFacts(input.candidateFacts, "candidateFacts");
  if (!newFacts.length) throw inputInvalid("newFacts must contain at least one fact.");
  const newFactIds = new Set(newFacts.map((fact) => fact.factId));
  if (candidateFacts.some((fact) => newFactIds.has(fact.factId))) {
    throw inputInvalid("candidateFacts must not repeat a new fact ID.");
  }
  const facts = [...newFacts, ...candidateFacts];
  if (facts.length < 2) {
    throw inputInvalid("Relation judgment requires at least two facts.");
  }

  return {
    schemaVersion: "timeline-fusion-relation-input.v1",
    temporalWindow: normalizeRelationWindow(input.temporalWindow),
    newFactIds: [...newFactIds].sort(),
    facts: facts
      .map((fact) => compactRelationFact(fact, newFactIds.has(fact.factId)))
      .sort((left, right) => Number(right.isNew) - Number(left.isNew) || left.factId.localeCompare(right.factId))
  };
}

export function buildTimelineFusionRelationPrompt(input: TimelineFusionRelationInput) {
  const normalized = normalizeRelationInput(input);
  return JSON.stringify({
    instruction: "判断候选事实之间的明确关系。时间接近只用于召回，不足以证明事实相关或属于同一事件。",
    constraints: [
      "只能引用 input.facts 中存在的 factId，且每个关系必须包含至少一个 isNew=true 的事实。",
      "同一个 factId 最多出现在一个关系中；未引用事实由系统自动保留。",
      "same_event 表示同一事件，supports 表示证据支持，supplements 表示补充细节，updates 表示状态或内容更新，conflicts 表示不兼容主张。",
      "时间接近但语义无关时返回 unrelated；证据不足时返回 needs_review，不能强行融合。",
      "包含语义日期、时间、金额、数量、比例、频率、序号、时长或区间边界的事实保持原子化；可判断 supports、conflicts、unrelated 或 needs_review，但不得使用 same_event、supplements 或 updates 物化合并。",
      "实体必须按完整名称精确区分；名称包含或共享中心词不表示同一实体，例如 tennis 与 table tennis 不得判为同一实体，除非输入证据明确声明别名。",
      "same_event、supplements、updates 必须输出 factText 和 normalizedClaim；其他关系的这两个字段必须为 null。",
      "融合文本必须使用证据主要语言，并保留数字、单位、英文专名、否定词、范围和频率限定词。",
      "reasonCode 使用稳定的英文 snake_case；不要输出解释、Markdown 或输入之外的字段。"
    ],
    outputSchema: {
      relations: [{
        type: "same_event | supports | supplements | updates | conflicts | unrelated | needs_review",
        sourceFactIds: ["fact_id_1", "fact_id_2"],
        factText: "融合后的事实文本，或 null",
        normalizedClaim: "融合后的规范化主张，或 null",
        confidenceLevel: "low | medium | high",
        reasonCode: "stable_snake_case_code"
      }]
    },
    input: normalized
  }, null, 2);
}

export function parseTimelineFusionRelationResponse(
  rawResponse: unknown,
  input: TimelineFusionRelationInput
): TimelineFusionRelationResult {
  const normalizedInput = normalizeRelationInput(input);
  const payload = parseResponsePayload(rawResponse);
  assertExactKeys(payload, new Set(["relations"]), "response");
  if (!Array.isArray(payload.relations)) {
    throw responseInvalid("response.relations must be an array.");
  }

  const allowedFactIds = new Set(normalizedInput.facts.map((fact) => fact.factId));
  const newFactIds = new Set(normalizedInput.newFactIds);
  const consumedFactIds = new Set<string>();
  const relations = payload.relations.map((value, index) => {
    const field = `response.relations[${index}]`;
    if (!isRecord(value)) throw responseInvalid(`${field} must be an object.`);
    assertExactKeys(value, RELATION_KEYS, field);
    const type = relationType(value.type, `${field}.type`);
    const sourceFactIds = relationFactIds(value.sourceFactIds, `${field}.sourceFactIds`);
    if (sourceFactIds.some((factId) => !allowedFactIds.has(factId))) {
      throw responseInvalid(`${field}.sourceFactIds contains an unknown fact ID.`);
    }
    if (!sourceFactIds.some((factId) => newFactIds.has(factId))) {
      throw responseInvalid(`${field} must reference at least one new fact.`);
    }
    if (sourceFactIds.some((factId) => consumedFactIds.has(factId))) {
      throw responseInvalid(`${field}.sourceFactIds reuses a fact consumed by another relation.`);
    }
    const confidenceLevel = relationConfidence(value.confidenceLevel, `${field}.confidenceLevel`);
    const reasonCode = requiredString(value.reasonCode, `${field}.reasonCode`);
    if (!REASON_CODE_PATTERN.test(reasonCode)) {
      throw responseInvalid(`${field}.reasonCode must be stable snake_case.`);
    }
    const materializing = MATERIALIZING_RELATION_TYPES.has(type);
    const factText = nullableString(value.factText, `${field}.factText`);
    const normalizedClaim = nullableString(value.normalizedClaim, `${field}.normalizedClaim`);
    if (materializing && (!factText || !normalizedClaim)) {
      throw responseInvalid(`${field} requires factText and normalizedClaim for ${type}.`);
    }
    if (!materializing && (factText !== undefined || normalizedClaim !== undefined)) {
      throw responseInvalid(`${field} must use null factText and normalizedClaim for ${type}.`);
    }
    for (const factId of sourceFactIds) consumedFactIds.add(factId);
    return {
      type,
      sourceFactIds,
      ...(factText ? { factText } : {}),
      ...(normalizedClaim ? { normalizedClaim } : {}),
      confidenceLevel,
      reasonCode
    };
  });

  return {
    schemaVersion: "timeline-fusion-relations.v1",
    relations,
    unusedFactIds: [...allowedFactIds].filter((factId) => !consumedFactIds.has(factId)).sort()
  };
}

export function parseTimelineFusionRelationResponseCompatible(
  rawResponse: unknown,
  input: TimelineFusionRelationInput
): TimelineFusionCompatibleRelationResult {
  const payload = parseResponsePayload(rawResponse);
  if ("relations" in payload) {
    const result = parseTimelineFusionRelationResponse(payload, input);
    assertRelationsPreserveProtectedDetails(result, input);
    return { responseFormat: "relations", result };
  }

  assertExactKeys(payload, new Set(["groups"]), "response");
  if (!Array.isArray(payload.groups)) {
    throw responseInvalid("response.groups must be an array.");
  }
  const relations = payload.groups.map((value, index) => {
    const field = `response.groups[${index}]`;
    if (!isRecord(value)) throw responseInvalid(`${field} must be an object.`);
    assertExactKeys(value, LEGACY_GROUP_KEYS, field);
    return {
      type: "same_event",
      sourceFactIds: value.sourceFactIds,
      factText: value.factText,
      normalizedClaim: value.normalizedClaim,
      confidenceLevel: value.confidenceLevel,
      reasonCode: "legacy_group_same_event"
    };
  });
  const result = parseTimelineFusionRelationResponse({ relations }, input);
  assertRelationsPreserveProtectedDetails(result, input);
  return { responseFormat: "legacy_groups", result };
}

export function buildTimelineFusionRelationFallback(input: TimelineFusionRelationInput): TimelineFusionRelationResult {
  const normalized = normalizeRelationInput(input);
  return {
    schemaVersion: "timeline-fusion-relations.v1",
    relations: [],
    unusedFactIds: normalized.facts.map((fact) => fact.factId).sort()
  };
}

function assertRelationsPreserveProtectedDetails(
  result: TimelineFusionRelationResult,
  input: TimelineFusionRelationInput
) {
  const factById = new Map(input.facts.map((fact) => [fact.factId, fact]));
  for (const [index, relation] of result.relations.entries()) {
    if (!MATERIALIZING_RELATION_TYPES.has(relation.type)) continue;
    const sourceFacts = relation.sourceFactIds.map((factId) => factById.get(factId)!);
    if (sourceFacts.some(hasProtectedQuantitativeDetail)) {
      throw detailsLost(`response.relations[${index}] attempted to merge an atomic quantitative or temporal fact.`);
    }
    if (hasNestedDistinctEntityPair(sourceFacts)) {
      throw detailsLost(`response.relations[${index}] attempted to merge distinct nested entity names.`);
    }
    const protectedFacts = relation.type === "updates"
      ? sourceFacts.filter((fact) => fact.isNew)
      : sourceFacts;
    const output = `${relation.factText ?? ""}\n${relation.normalizedClaim ?? ""}`
      .normalize("NFKC")
      .toLocaleLowerCase();
    const missing = protectedDetailTokens(protectedFacts).filter((token) =>
      !output.includes(token.toLocaleLowerCase())
    );
    if (missing.length) {
      throw detailsLost(`response.relations[${index}] omitted protected details: ${missing.join(",")}.`);
    }
  }
}

function hasProtectedQuantitativeDetail(fact: TimelineFusionRelationFactInput) {
  if (fact.validTimeStart || fact.validTimeEnd) return true;
  const text = `${fact.factText}\n${fact.normalizedClaim}`.normalize("NFKC");
  return /\d|[$€£¥￥]|\b(?:usd|eur|gbp|cny|rmb|percent|percentage)\b|%|％/iu.test(text) ||
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand|million|billion|first|second|third|once|twice|daily|weekly|monthly|yearly|seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/iu.test(text) ||
    /(?:日期|时间|金额|数量|比例|百分比|分钟|小时|天|周|月|年|元|美元|人民币|磅|公斤|千克|公里)/u.test(text);
}

function hasNestedDistinctEntityPair(facts: readonly TimelineFusionRelationFactInput[]) {
  for (let leftIndex = 0; leftIndex < facts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < facts.length; rightIndex += 1) {
      for (const left of facts[leftIndex]!.entityIds) {
        for (const right of facts[rightIndex]!.entityIds) {
          const leftName = canonicalEntityName(left);
          const rightName = canonicalEntityName(right);
          if (leftName && rightName && leftName !== rightName &&
              (leftName.endsWith(` ${rightName}`) || rightName.endsWith(` ${leftName}`))) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function canonicalEntityName(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/gu, " ").trim();
}

function protectedDetailTokens(facts: readonly TimelineFusionRelationFactInput[]) {
  const text = facts.map((fact) => `${fact.factText}\n${fact.normalizedClaim}`).join("\n").normalize("NFKC");
  return normalizedIds([
    ...(text.match(/\d+(?:[.:：]\d+)?(?:\.\d+)?/gu) ?? []),
    ...(text.match(/[A-Za-z][A-Za-z0-9._+-]*/gu) ?? []),
    ...(text.match(/每天|每日|每周|每月|每年|单程|往返|至少|至多|最多|最少|超过|不足|之前|之后|以前|以后|不|未|没有|无需|禁止|不能/gu) ?? []),
    ...(text.match(/分钟|小时|公里|千米|公斤|美元|人民币|元|天|周|月|年/gu) ?? []),
    ...(text.match(/\b(?:not|never|no)\b/giu) ?? [])
  ]);
}

function normalizeRelationInput(input: TimelineFusionRelationInput) {
  if (input.schemaVersion !== "timeline-fusion-relation-input.v1") {
    throw inputInvalid("Unsupported relation input schemaVersion.");
  }
  const factsById = new Map(input.facts.map((fact) => [fact.factId, fact]));
  if (factsById.size !== input.facts.length || factsById.size < 2) {
    throw inputInvalid("Relation input facts must contain at least two unique fact IDs.");
  }
  const newFactIds = uniqueStrings(input.newFactIds, "newFactIds");
  if (!newFactIds.length || newFactIds.some((factId) => !factsById.get(factId)?.isNew)) {
    throw inputInvalid("newFactIds must reference facts marked isNew=true.");
  }
  if (input.facts.some((fact) => fact.isNew !== newFactIds.includes(fact.factId))) {
    throw inputInvalid("Fact isNew flags must exactly match newFactIds.");
  }
  return {
    ...input,
    temporalWindow: normalizeRelationWindow(input.temporalWindow),
    newFactIds,
    facts: [...input.facts]
  };
}

function compactRelationFact(fact: FactItem, isNew: boolean): TimelineFusionRelationFactInput {
  return {
    factId: requiredInputString(fact.factId, "fact.factId"),
    isNew,
    factType: requiredInputString(fact.factType, `${fact.factId}.factType`),
    factText: requiredInputString(fact.factText, `${fact.factId}.factText`),
    normalizedClaim: requiredInputString(fact.normalizedClaim, `${fact.factId}.normalizedClaim`),
    entityIds: normalizedIds(fact.entityIds),
    confidenceLevel: fact.confidenceLevel,
    linkedEventIds: normalizedIds(fact.linkedEventIds),
    linkedSegmentIds: normalizedIds(fact.linkedSegmentIds),
    sourceRefIds: normalizedIds(fact.linkedSourceRefs.map((ref) => ref.sourceRefId)),
    sourceMessageIds: normalizedIds(fact.sourceMessageIds ?? []),
    evidenceTimeStart: fact.evidenceTimeStart ?? null,
    evidenceTimeEnd: fact.evidenceTimeEnd ?? null,
    evidenceTimeConfidence: fact.evidenceTimeConfidence ?? null,
    validTimeStart: fact.validTimeStart ?? null,
    validTimeEnd: fact.validTimeEnd ?? null,
    validTimeBasis: fact.validTimeBasis ?? (
      fact.validTimeStart && fact.timeBasis !== "media_offset" ? fact.timeBasis : null
    ),
    validTimeConfidence: fact.validTimeConfidence ?? (fact.validTimeStart ? fact.timeConfidence : null)
  };
}

function uniqueFacts(facts: readonly FactItem[], field: string) {
  const byId = new Map<string, FactItem>();
  for (const fact of facts) {
    const factId = requiredInputString(fact.factId, `${field}.factId`);
    if (byId.has(factId)) throw inputInvalid(`${field} contains duplicate fact ID: ${factId}.`);
    byId.set(factId, fact);
  }
  return [...byId.values()];
}

function parseResponsePayload(rawResponse: unknown): Record<string, unknown> {
  const content = extractResponseContent(rawResponse);
  let payload: unknown;
  try {
    payload = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    throw responseInvalid("Response content must be valid JSON.");
  }
  if (!isRecord(payload)) throw responseInvalid("Response payload must be an object.");
  return payload;
}

function extractResponseContent(rawResponse: unknown): unknown {
  if (!isRecord(rawResponse)) return rawResponse;
  if (typeof rawResponse.output_text === "string") return rawResponse.output_text;
  const choices = rawResponse.choices;
  if (Array.isArray(choices) && choices.length && isRecord(choices[0])) {
    const message = choices[0].message;
    if (isRecord(message) && "content" in message) return message.content;
  }
  const output = rawResponse.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isRecord(content) && typeof content.text === "string") return content.text;
      }
    }
  }
  return rawResponse;
}

function relationFactIds(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length < 2) {
    throw responseInvalid(`${field} must contain at least two fact IDs.`);
  }
  if (value.some((item) => typeof item !== "string" || !item || item !== item.trim())) {
    throw responseInvalid(`${field} must contain non-empty, trimmed strings.`);
  }
  if (new Set(value).size !== value.length) throw responseInvalid(`${field} must not contain duplicates.`);
  return [...value] as string[];
}

function relationType(value: unknown, field: string): TimelineFusionRelationType {
  if (typeof value !== "string" || !RELATION_TYPES.has(value as TimelineFusionRelationType)) {
    throw responseInvalid(`${field} is unsupported.`);
  }
  return value as TimelineFusionRelationType;
}

function relationConfidence(value: unknown, field: string): TimelineFusionRelationConfidence {
  if (typeof value !== "string" || !CONFIDENCE_LEVELS.has(value as TimelineFusionRelationConfidence)) {
    throw responseInvalid(`${field} is unsupported.`);
  }
  return value as TimelineFusionRelationConfidence;
}

function nullableString(value: unknown, field: string) {
  if (value === null) return undefined;
  return requiredString(value, field);
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw responseInvalid(`${field} must be a non-empty string.`);
  return value.trim();
}

function requiredInputString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw inputInvalid(`${field} must be a non-empty string.`);
  return value.trim();
}

function uniqueStrings(values: readonly string[], field: string) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw inputInvalid(`${field} must contain non-empty strings.`);
  }
  const normalized = normalizedIds(values);
  if (normalized.length !== values.length) throw inputInvalid(`${field} must not contain duplicates.`);
  return normalized;
}

function normalizedIds(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeRelationWindow(window: TimelineFusionWindow) {
  try {
    return normalizeTimelineFusionWindow(window);
  } catch (error) {
    throw inputInvalid(error instanceof Error ? error.message : "Invalid temporalWindow.");
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw responseInvalid(`${field} contains unsupported fields: ${extra.join(",")}.`);
  const missing = [...allowed].filter((key) => !(key in value));
  if (missing.length) throw responseInvalid(`${field} is missing required fields: ${missing.join(",")}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inputInvalid(message: string) {
  return new TimelineFusionRelationProtocolError("TIMELINE_FUSION_RELATION_INPUT_INVALID", message);
}

function responseInvalid(message: string) {
  return new TimelineFusionRelationProtocolError("TIMELINE_FUSION_RELATION_RESPONSE_INVALID", message);
}

function detailsLost(message: string) {
  return new TimelineFusionRelationProtocolError("TIMELINE_FUSION_RELATION_DETAILS_LOST", message);
}
