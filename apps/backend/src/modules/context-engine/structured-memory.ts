import type {
  FactItem,
  LongTermMemory,
  MemoryEvent,
  MemoryTemporalMetadata,
  ShortTermMemory,
  StructuredMemoryFact,
  StructuredMemoryFacts
} from "./domain.js";
import {
  aggregateMemoryTemporalMetadata,
  copyTemporalMetadata,
  temporalMetadataFromFact
} from "./memory-temporal.js";
import { memoryEventSummary, sourceRefsFromEvent } from "./memory-event-fields.js";

const structuredMemorySchemaVersion = "memory-structured-facts.v1";

export type LongTermStructuredCandidate = Pick<
  ShortTermMemory,
  | "memoryDataId"
  | "content"
  | "structuredFacts"
  | "confidenceLevel"
  | "entityIds"
  | "sourceRefs"
  | "admissionResult"
  | "admissionReason"
  | "importanceLevel"
  | keyof MemoryTemporalMetadata
>;

export function buildShortTermMemoryPayload(
  event: MemoryEvent,
  facts: FactItem[]
): { content: string; structuredFacts: StructuredMemoryFacts } {
  const structuredFacts: StructuredMemoryFacts = {
    schemaVersion: structuredMemorySchemaVersion,
    memoryKind: "short_term",
    facts: facts.length
      ? facts.map((fact) => ({
        factId: fact.factId,
        claim: fact.factText || fact.normalizedClaim,
        explanation: buildShortTermFactExplanation(event, fact),
        factType: fact.factType,
        ...(fact.timeAnchor ? { timeAnchor: fact.timeAnchor } : {}),
        confidenceLevel: fact.confidenceLevel,
        ...structuredFactTemporalMetadata(fact),
        entityIds: fact.entityIds,
        sourceRefIds: fact.linkedSourceRefs.map((ref) => ref.sourceRefId)
      }))
      : [{
        claim: event.eventType,
        explanation: `未生成可用融合事实，保留事件类型作为候选短期记忆。事件 ${event.eventId} 仍可回查原始来源。`,
        sourceRefIds: sourceRefsFromEvent(event).map((ref) => ref.sourceRefId)
      }]
  };

  return {
    content: buildReadableClaims(structuredFacts.facts.map((fact) => fact.claim), event.eventType),
    structuredFacts
  };
}

export function buildShortTermMemoryExplanation(
  event: MemoryEvent,
  facts: FactItem[],
  admissionReason: string
) {
  return [
    `事件概要：${memoryEventSummary(event)}`,
    `STM 准入原因：${admissionReason}`,
    `事实数量：${facts.length}`,
    `来源：${event.sourceId ?? event.sourceApp ?? event.eventId}`
  ].join("\n");
}

export function buildLongTermMemoryPayload(candidates: LongTermStructuredCandidate[]): { content: string; structuredFacts: StructuredMemoryFacts } {
  const structuredFacts: StructuredMemoryFacts = {
    schemaVersion: structuredMemorySchemaVersion,
    memoryKind: "long_term",
    facts: candidates.flatMap(buildLongTermStructuredFacts)
  };

  return {
    content: buildReadableClaims(structuredFacts.facts.map((fact) => fact.claim), "长期记忆"),
    structuredFacts
  };
}

export function mergeLongTermStructuredFacts(
  candidates: LongTermStructuredCandidate[],
  generated?: StructuredMemoryFacts
): StructuredMemoryFacts {
  const canonical = buildLongTermMemoryPayload(candidates).structuredFacts;
  if (!generated?.facts.length) return canonical;

  const consumed = new Set<StructuredMemoryFact>();
  const merged = generated.facts.map((fact) => {
    const possible = canonical.facts.filter((candidate) =>
      !consumed.has(candidate) &&
      (!fact.sourceMemoryDataId || candidate.sourceMemoryDataId === fact.sourceMemoryDataId)
    );
    const normalizedClaim = normalizeClaim(fact.claim);
    const matched = possible.find((candidate) => normalizeClaim(candidate.claim) === normalizedClaim)
      ?? (possible.length === 1 ? possible[0] : undefined);
    const withoutGeneratedTemporal = stripTemporalMetadata(fact);
    if (!matched) return withoutGeneratedTemporal;
    consumed.add(matched);
    return {
      ...withoutGeneratedTemporal,
      ...(matched.factId ? { factId: matched.factId } : {}),
      ...(matched.sourceMemoryDataId ? { sourceMemoryDataId: matched.sourceMemoryDataId } : {}),
      ...(matched.timeAnchor ? { timeAnchor: matched.timeAnchor } : {}),
      ...aggregateMemoryTemporalMetadata([matched]),
      entityIds: unique([...(fact.entityIds ?? []), ...(matched.entityIds ?? [])]),
      sourceRefIds: unique([...(fact.sourceRefIds ?? []), ...(matched.sourceRefIds ?? [])])
    };
  });

  return {
    schemaVersion: structuredMemorySchemaVersion,
    memoryKind: "long_term",
    facts: [...merged, ...canonical.facts.filter((fact) => !consumed.has(fact))]
  };
}

function buildLongTermStructuredFacts(candidate: LongTermStructuredCandidate): StructuredMemoryFact[] {
  const sourceFacts = candidate.structuredFacts?.facts ?? [];
  if (sourceFacts.length) {
    return sourceFacts.map((fact) => copyTemporalMetadata({
      ...fact,
      sourceMemoryDataId: candidate.memoryDataId,
      explanation: `${fact.explanation} ${buildLongTermFactExplanation(candidate)}`,
      entityIds: unique([...(fact.entityIds ?? []), ...candidate.entityIds]),
      sourceRefIds: unique([
        ...(fact.sourceRefIds ?? []),
        ...candidate.sourceRefs.map((ref) => ref.sourceRefId)
      ])
    }, fact));
  }

  return [copyTemporalMetadata({
    sourceMemoryDataId: candidate.memoryDataId,
    claim: extractPrimaryClaim(candidate.content),
    explanation: buildLongTermFactExplanation(candidate),
    confidenceLevel: candidate.confidenceLevel,
    entityIds: candidate.entityIds,
    sourceRefIds: candidate.sourceRefs.map((ref) => ref.sourceRefId)
  }, candidate)];
}

function buildShortTermFactExplanation(event: MemoryEvent, fact: FactItem) {
  const temporalExplanation = fact.validTime
    ? `事实时间：${fact.validTime}；证据时间：${fact.evidenceTime ?? "未知"}。`
    : fact.validTimeStart
      ? `事实时间：${fact.validTimeStart}${fact.validTimeEnd ? ` 至 ${fact.validTimeEnd}` : ""}，时间依据：${fact.validTimeBasis ?? fact.timeBasis}/${fact.validTimeConfidence ?? fact.timeConfidence}。`
      : `事实时间：未确定；证据时间：${fact.evidenceTime ?? fact.evidenceTimeStart ?? "未知"}${fact.evidenceTimeEnd && fact.evidenceTimeEnd !== fact.evidenceTimeStart ? ` 至 ${fact.evidenceTimeEnd}` : ""}。`;
  return [
    `由时间融合事实 ${fact.factId} 提炼为 STM 结构化事实。`,
    temporalExplanation,
    `来源事件：${event.eventId}，置信度：${fact.confidenceLevel}。`
  ].join(" ");
}

function structuredFactTemporalMetadata(fact: FactItem): MemoryTemporalMetadata {
  if (fact.evidenceTime || fact.validTime) {
    return {
      ...(fact.evidenceTime ? { evidenceTime: fact.evidenceTime } : {}),
      ...(fact.validTime ? { validTime: fact.validTime } : {}),
      ...(fact.events?.length ? { events: fact.events } : {})
    };
  }
  return temporalMetadataFromFact(fact);
}

function buildLongTermFactExplanation(candidate: LongTermStructuredCandidate) {
  return [
    `由短期记忆 ${candidate.memoryDataId} 经做梦流程巩固。`,
    `STM 准入：${candidate.admissionResult}/${candidate.admissionReason}。`,
    `重要性：${candidate.importanceLevel}，置信度：${candidate.confidenceLevel}。`
  ].join(" ");
}

function extractPrimaryClaim(content: string) {
  try {
    const parsed = JSON.parse(content) as Partial<StructuredMemoryFacts>;
    const firstClaim = parsed.facts?.find((fact) => typeof fact.claim === "string" && fact.claim.trim())?.claim;
    if (firstClaim) return firstClaim;
  } catch {
    // Legacy memory content can be plain text.
  }
  return content.replace(/\s+/g, " ").trim();
}

function buildReadableClaims(claims: string[], fallback: string) {
  const normalizedClaims = claims.map((claim) => claim.replace(/\s+/g, " ").trim()).filter(Boolean);
  return normalizedClaims.length ? normalizedClaims.join("\n") : fallback;
}

function stripTemporalMetadata(fact: StructuredMemoryFact): StructuredMemoryFact {
  const {
    timeAnchor: _timeAnchor,
    evidenceTime: _evidenceTime,
    evidenceTimeStart: _evidenceTimeStart,
    evidenceTimeEnd: _evidenceTimeEnd,
    evidenceTimeConfidence: _evidenceTimeConfidence,
    validTime: _validTime,
    events: _events,
    validTimeStart: _validTimeStart,
    validTimeEnd: _validTimeEnd,
    validTimeConfidence: _validTimeConfidence,
    ...rest
  } = fact;
  return rest;
}

function normalizeClaim(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
