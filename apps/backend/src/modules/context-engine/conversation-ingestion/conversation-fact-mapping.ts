import { createHash } from "node:crypto";
import type { FactItem, ParsedSegment, SourceRef } from "../domain.js";
import type {
  ConversationFactCandidateRecord,
  ConversationIngestionRecord,
  ConversationMessageRecord
} from "./persistence.js";
import {
  conversationEvidenceTimeRange,
  conversationMessageSourceRef,
  latestConversationMessagesById,
  lowestConversationTimeConfidence
} from "./conversation-fact-temporal.js";

export interface ConversationFactMappingResult {
  candidates: ConversationFactCandidateRecord[];
  factsToSave: FactItem[];
  activeFacts: FactItem[];
}

export function mapConversationFactCandidates(input: {
  ingestion: ConversationIngestionRecord;
  candidates: readonly ConversationFactCandidateRecord[];
  existingCandidates: readonly ConversationFactCandidateRecord[];
  existingFacts: readonly FactItem[];
  messages: readonly ConversationMessageRecord[];
  parsedSegments: readonly ParsedSegment[];
  now: string;
}): ConversationFactMappingResult {
  const segmentById = new Map(input.parsedSegments.map((segment) => [segment.segmentId, segment]));
  const messageById = latestConversationMessagesById(input.messages);
  const factById = new Map(input.existingFacts.map((fact) => [fact.factId, fact]));
  const factsToSave = new Map<string, FactItem>();
  const previousEligible = input.existingCandidates.filter((candidate) =>
    candidate.validationStatus === "validated" && candidate.persistedFactId
  );

  const candidates = input.candidates.map((candidate) => {
    if (candidate.validationStatus !== "validated") return candidate;
    const dedupeKey = candidateDedupeKey(candidate);
    const previous = previousEligible.find((item) => candidateDedupeKey(item) === dedupeKey);
    const factId = previous?.persistedFactId ?? stableFactId(input.ingestion, candidate);
    const existing = factsToSave.get(factId) ?? factById.get(factId);
    const mapped = buildFact(input.ingestion, candidate, factId, messageById, segmentById, input.now);
    factsToSave.set(factId, existing ? mergeFact(existing, mapped) : mapped);
    return { ...candidate, persistedFactId: factId, updatedAt: input.now };
  });

  applyMessageRevisionsAndDeletes(
    candidates,
    previousEligible,
    input.messages,
    factById,
    factsToSave,
    input.now
  );
  applyDeterministicConflicts(candidates, previousEligible, factById, factsToSave, input.now);

  const allFacts = [...factsToSave.values()];
  return {
    candidates,
    factsToSave: allFacts,
    activeFacts: allFacts.filter((fact) => fact.status === "active")
  };
}

function buildFact(
  ingestion: ConversationIngestionRecord,
  candidate: ConversationFactCandidateRecord,
  factId: string,
  messageById: ReadonlyMap<string, ConversationMessageRecord>,
  segmentById: ReadonlyMap<string, ParsedSegment>,
  now: string
): FactItem {
  const sourceMessages = candidate.sourceMessageIds.flatMap((messageId) => {
    const message = messageById.get(messageId);
    return message ? [message] : [];
  });
  const sourceRefs = sourceMessages.map(conversationMessageSourceRef);
  const linkedEventIds = [...new Set(candidate.linkedSegmentIds.flatMap((segmentId) => {
    const eventId = segmentById.get(segmentId)?.eventId;
    return eventId ? [eventId] : [];
  }))];
  const evidence = conversationEvidenceTimeRange(sourceMessages);
  const validTimeBasis = candidate.validTimeStart
    ? candidate.validTimeBasis ?? "absolute"
    : undefined;
  const validTimeConfidence = candidate.validTimeStart
    ? lowestConversationTimeConfidence([
        candidate.validTimeConfidence ?? "medium",
        ...sourceMessages.map((message) => message.timeConfidence)
      ])
    : "low";
  const entityIds = [...new Set([
    ...candidate.entityIds,
    ...(candidate.subject ? [candidate.subject] : [])
  ])];
  return {
    factId,
    factType: candidate.factType,
    factText: candidate.factText,
    sourceClaim: candidate.evidenceQuotes.join("\n"),
    normalizedClaim: candidate.normalizedClaim,
    linkedEventIds,
    linkedSegmentIds: [...new Set(candidate.linkedSegmentIds)],
    linkedSourceRefs: uniqueSourceRefs(sourceRefs),
    entityIds,
    confidenceLevel: candidate.confidenceLevel,
    version: 1,
    status: "active",
    observedAt: now,
    ...evidence,
    sourceMessageIds: [...candidate.sourceMessageIds],
    ...(candidate.validTimeStart ? { validTimeStart: candidate.validTimeStart } : {}),
    ...(candidate.validTimeEnd ? { validTimeEnd: candidate.validTimeEnd } : {}),
    ...(validTimeBasis ? { validTimeBasis } : {}),
    validTimeConfidence,
    timeBasis: validTimeBasis ?? "source_time",
    timeConfidence: validTimeConfidence,
    schemaVersion: "conversation-fact.v2",
    accessState: "visible"
  };
}

function mergeFact(existing: FactItem, incoming: FactItem): FactItem {
  const validTimeStart = earliestOptionalTime(existing.validTimeStart, incoming.validTimeStart);
  const validTimeEnd = latestOptionalTime(existing.validTimeEnd, incoming.validTimeEnd);
  const evidenceTimeStart = earliestOptionalTime(existing.evidenceTimeStart, incoming.evidenceTimeStart);
  const evidenceTimeEnd = latestOptionalTime(existing.evidenceTimeEnd, incoming.evidenceTimeEnd);
  const validTimeConfidence = lowestConversationTimeConfidence([
    existing.validTimeConfidence ?? existing.timeConfidence,
    incoming.validTimeConfidence ?? incoming.timeConfidence
  ]);
  const sourceClaim = incoming.sourceClaim ?? existing.sourceClaim;
  return {
    ...existing,
    factText: incoming.factText,
    ...(sourceClaim ? { sourceClaim } : {}),
    normalizedClaim: incoming.normalizedClaim,
    linkedEventIds: [...new Set([...existing.linkedEventIds, ...incoming.linkedEventIds])],
    linkedSegmentIds: [...new Set([...existing.linkedSegmentIds, ...incoming.linkedSegmentIds])],
    linkedSourceRefs: uniqueSourceRefs([...existing.linkedSourceRefs, ...incoming.linkedSourceRefs]),
    sourceMessageIds: [...new Set([...(existing.sourceMessageIds ?? []), ...(incoming.sourceMessageIds ?? [])])],
    entityIds: [...new Set([...existing.entityIds, ...incoming.entityIds])],
    confidenceLevel: strongerConfidence(existing.confidenceLevel, incoming.confidenceLevel),
    ...(evidenceTimeStart ? { evidenceTimeStart } : {}),
    ...(evidenceTimeEnd ? { evidenceTimeEnd } : {}),
    evidenceTimeConfidence: lowestConversationTimeConfidence([
      existing.evidenceTimeConfidence ?? "low",
      incoming.evidenceTimeConfidence ?? "low"
    ]),
    ...(validTimeStart ? { validTimeStart } : {}),
    ...(validTimeEnd ? { validTimeEnd } : {}),
    ...((incoming.validTimeBasis ?? existing.validTimeBasis)
      ? { validTimeBasis: incoming.validTimeBasis ?? existing.validTimeBasis }
      : {}),
    validTimeConfidence,
    timeBasis: incoming.validTimeBasis ?? existing.validTimeBasis ?? incoming.timeBasis,
    timeConfidence: validTimeConfidence,
    observedAt: incoming.observedAt,
    ...(incoming.accessState ? { accessState: incoming.accessState } : {})
  };
}

function applyMessageRevisionsAndDeletes(
  candidates: readonly ConversationFactCandidateRecord[],
  previousCandidates: readonly ConversationFactCandidateRecord[],
  messages: readonly ConversationMessageRecord[],
  factById: ReadonlyMap<string, FactItem>,
  factsToSave: Map<string, FactItem>,
  now: string
) {
  const deletedMessageIds = new Set(messages
    .filter((message) => message.operation === "delete")
    .map((message) => message.messageId));
  const revisedMessageIds = new Set(messages
    .filter((message) => message.operation === "replace" || message.revision > 1)
    .map((message) => message.messageId));

  for (const previous of previousCandidates) {
    if (!previous.persistedFactId) continue;
    const sharesDeletedMessage = previous.sourceMessageIds.some((messageId) => deletedMessageIds.has(messageId));
    const replacement = candidates.find((candidate) =>
      candidate.validationStatus === "validated" &&
      candidate.persistedFactId !== previous.persistedFactId &&
      sameSubjectAndType(candidate, previous) &&
      candidate.sourceMessageIds.some((messageId) =>
        revisedMessageIds.has(messageId) && previous.sourceMessageIds.includes(messageId)
      )
    );
    if (!sharesDeletedMessage && !replacement) continue;
    const oldFact = factsToSave.get(previous.persistedFactId) ?? factById.get(previous.persistedFactId);
    if (!oldFact) continue;
    factsToSave.set(oldFact.factId, {
      ...oldFact,
      status: "superseded",
      version: oldFact.version + 1,
      observedAt: now
    });
  }
}

function applyDeterministicConflicts(
  candidates: readonly ConversationFactCandidateRecord[],
  previousCandidates: readonly ConversationFactCandidateRecord[],
  factById: ReadonlyMap<string, FactItem>,
  factsToSave: Map<string, FactItem>,
  now: string
) {
  for (const candidate of candidates) {
    if (candidate.validationStatus !== "validated" || !candidate.persistedFactId) continue;
    const opposing = previousCandidates.find((previous) =>
      previous.persistedFactId &&
      previous.persistedFactId !== candidate.persistedFactId &&
      sameSubjectAndType(candidate, previous) &&
      areExplicitNegationPair(candidate.normalizedClaim, previous.normalizedClaim)
    );
    if (!opposing?.persistedFactId) continue;
    for (const factId of [candidate.persistedFactId, opposing.persistedFactId]) {
      const fact = factsToSave.get(factId) ?? factById.get(factId);
      if (!fact || fact.status === "superseded") continue;
      factsToSave.set(factId, {
        ...fact,
        status: "conflicted",
        version: fact.version + 1,
        observedAt: now
      });
    }
  }
}

function candidateDedupeKey(candidate: ConversationFactCandidateRecord) {
  return [
    normalizeForKey(candidate.subject ?? ""),
    normalizeForKey(candidate.factType),
    normalizeForKey(candidate.normalizedClaim)
  ].join("|");
}

function stableFactId(ingestion: ConversationIngestionRecord, candidate: ConversationFactCandidateRecord) {
  return `cfact_${stableId([
    ingestion.tenantId,
    ingestion.principalId,
    ingestion.sessionId,
    candidateDedupeKey(candidate)
  ].join(":"))}`;
}

function sameSubjectAndType(left: ConversationFactCandidateRecord, right: ConversationFactCandidateRecord) {
  return normalizeForKey(left.subject ?? "") === normalizeForKey(right.subject ?? "") &&
    normalizeForKey(left.factType) === normalizeForKey(right.factType);
}

function areExplicitNegationPair(left: string, right: string) {
  const normalizedLeft = normalizeForKey(left);
  const normalizedRight = normalizeForKey(right);
  const leftBase = removeOneExplicitNegation(normalizedLeft);
  const rightBase = removeOneExplicitNegation(normalizedRight);
  return Boolean(
    (leftBase.negated !== rightBase.negated) &&
    leftBase.claim.length >= 4 &&
    leftBase.claim === rightBase.claim
  );
}

function removeOneExplicitNegation(value: string) {
  if (/^not\s+/u.test(value)) return { negated: true, claim: value.replace(/^not\s+/u, "") };
  if (/\b(?:is|are|do|does|did|can|will)\s+not\b/u.test(value)) {
    return { negated: true, claim: value.replace(/\s+not\b/u, "") };
  }
  const chineseNegation = value.match(/[不没未无]/u);
  if (chineseNegation?.index !== undefined) {
    return {
      negated: true,
      claim: `${value.slice(0, chineseNegation.index)}${value.slice(chineseNegation.index + 1)}`
    };
  }
  return { negated: false, claim: value };
}

function uniqueSourceRefs(sourceRefs: readonly SourceRef[]) {
  const seen = new Set<string>();
  return sourceRefs.filter((sourceRef) => {
    if (seen.has(sourceRef.sourceRefId)) return false;
    seen.add(sourceRef.sourceRefId);
    return true;
  });
}

function strongerConfidence(
  left: FactItem["confidenceLevel"],
  right: FactItem["confidenceLevel"]
): FactItem["confidenceLevel"] {
  const weight = { low: 0, medium: 1, high: 2 } as const;
  return weight[left] >= weight[right] ? left : right;
}

function normalizeForKey(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ").replace(/[。！？.!?]+$/gu, "");
}

function stableId(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function earliestOptionalTime(left: string | undefined, right: string | undefined) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function latestOptionalTime(left: string | undefined, right: string | undefined) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
