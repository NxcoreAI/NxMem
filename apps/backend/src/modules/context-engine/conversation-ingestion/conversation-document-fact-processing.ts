import { createHash } from "node:crypto";
import type { FactItem, SourceRef } from "../domain.js";
import {
  CONVERSATION_FACT_EPISTEMIC_STATUSES,
  CONVERSATION_FACT_MEMORY_ELIGIBILITIES,
  type ConversationFactEpistemicStatus,
  type ConversationFactMemoryEligibility,
  type ConversationDocumentRecord,
  type ConversationIngestionRecord,
  type ConversationMessageRecord
} from "./persistence.js";
import {
  CONVERSATION_TIME_CONFIDENCES,
  CONVERSATION_VALID_TIME_BASES,
  conversationEvidenceTimeRange,
  conversationMessageSourceRef,
  latestConversationMessagesById,
  lowestConversationTimeConfidence,
  normalizeConversationCandidateMonthTemporal,
  validateConversationCandidateSources,
  type ConversationTemporalConfidence,
  type ConversationValidTimeBasis
} from "./conversation-fact-temporal.js";
import { englishCanonicalFactValidationError } from "../canonical-fact-language.js";

const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const ASSISTANT_MEMORY_FACT_TYPES = new Set([
  "assistant_knowledge",
  "assistant_recommendation",
  "assistant_response"
]);

export interface ConversationDocumentFactCandidate {
  candidateId: string;
  candidateIndex: number;
  factType: string;
  factText: string;
  normalizedClaim: string;
  subject?: string;
  epistemicStatus: ConversationFactEpistemicStatus;
  confidenceLevel: FactItem["confidenceLevel"];
  memoryEligibility: ConversationFactMemoryEligibility;
  sourceMessageIds: string[];
  evidenceQuotes: string[];
  entityIds: string[];
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeBasis?: ConversationValidTimeBasis;
  validTimeConfidence?: ConversationTemporalConfidence;
  validationStatus: "validated" | "evidence_only" | "pending_verification" | "rejected" | "invalid";
  validationReason: string;
  persistedFactId?: string;
  rawCandidate: unknown;
}

export function validateConversationDocumentFactCandidates(
  ingestion: ConversationIngestionRecord,
  messages: readonly ConversationMessageRecord[],
  rawCandidates: readonly unknown[]
): ConversationDocumentFactCandidate[] {
  return rawCandidates.map((rawCandidate, candidateIndex) => {
    const parsed = parseCandidate(rawCandidate);
    const candidateId = `cdfc_${stableId(`${ingestion.ingestionId}:${candidateIndex}`)}`;
    if (!parsed.valid) {
      return {
        ...parsed.candidate,
        candidateId,
        candidateIndex,
        memoryEligibility: "rejected",
        validationStatus: "invalid",
        validationReason: parsed.reason,
        rawCandidate
      };
    }
    const normalizedTemporal = normalizeConversationCandidateMonthTemporal({
      sourceMessageIds: parsed.candidate.sourceMessageIds,
      evidenceQuotes: parsed.candidate.evidenceQuotes,
      messages,
      ...(ingestion.timezone ? { timezone: ingestion.timezone } : {})
    });
    if (normalizedTemporal) {
      if (normalizedTemporal.validTimeStart) {
        parsed.candidate.validTimeStart = normalizedTemporal.validTimeStart;
      }
      if (normalizedTemporal.validTimeEnd) parsed.candidate.validTimeEnd = normalizedTemporal.validTimeEnd;
      else delete parsed.candidate.validTimeEnd;
      if (normalizedTemporal.validTimeBasis) {
        parsed.candidate.validTimeBasis = normalizedTemporal.validTimeBasis;
      }
      if (normalizedTemporal.validTimeConfidence) {
        parsed.candidate.validTimeConfidence = normalizedTemporal.validTimeConfidence;
      }
    }
    const sourceValidation = validateConversationCandidateSources({
      sourceMessageIds: parsed.candidate.sourceMessageIds,
      evidenceQuotes: parsed.candidate.evidenceQuotes,
      messages,
      ...(ingestion.timezone ? { timezone: ingestion.timezone } : {}),
      temporal: {
        ...(parsed.candidate.validTimeStart ? { validTimeStart: parsed.candidate.validTimeStart } : {}),
        ...(parsed.candidate.validTimeEnd ? { validTimeEnd: parsed.candidate.validTimeEnd } : {}),
        ...(parsed.candidate.validTimeBasis ? { validTimeBasis: parsed.candidate.validTimeBasis } : {}),
        ...(parsed.candidate.validTimeConfidence
          ? { validTimeConfidence: parsed.candidate.validTimeConfidence }
          : {})
      }
    });
    if (sourceValidation?.kind === "invalid") {
      return {
        ...parsed.candidate,
        candidateId,
        candidateIndex,
        memoryEligibility: "rejected",
        validationStatus: "invalid",
        validationReason: sourceValidation.reason,
        rawCandidate
      };
    }

    let memoryEligibility = parsed.candidate.memoryEligibility;
    let validationReason = "eligible_with_message_provenance";
    if (sourceValidation?.kind === "pending") {
      memoryEligibility = "pending_verification";
      validationReason = sourceValidation.reason;
    } else if (parsed.candidate.epistemicStatus === "agent_inferred" && memoryEligibility === "eligible") {
      const sourceMessages = messages.filter((message) => parsed.candidate.sourceMessageIds.includes(message.messageId));
      const isAuditableAssistantFact = sourceMessages.length > 0 &&
        sourceMessages.every((message) => message.role === "assistant") &&
        ASSISTANT_MEMORY_FACT_TYPES.has(parsed.candidate.factType);
      if (isAuditableAssistantFact) {
        validationReason = "assistant_fact_with_auditable_provenance";
      } else {
        memoryEligibility = "evidence_only";
        validationReason = "agent_inference_is_evidence_only";
      }
    }
    if (memoryEligibility === "eligible" && containsSensitiveSecret(
      `${parsed.candidate.factText}\n${parsed.candidate.normalizedClaim}`
    )) {
      memoryEligibility = "pending_verification";
      validationReason = "sensitive_secret_requires_confirmation";
    }
    const validationStatus = memoryEligibility === "eligible"
      ? "validated" as const
      : memoryEligibility === "evidence_only"
        ? "evidence_only" as const
        : memoryEligibility === "pending_verification"
          ? "pending_verification" as const
          : "rejected" as const;
    return {
      ...parsed.candidate,
      candidateId,
      candidateIndex,
      memoryEligibility,
      validationStatus,
      validationReason,
      rawCandidate
    };
  });
}

export function mapConversationDocumentFacts(input: {
  ingestion: ConversationIngestionRecord;
  document: ConversationDocumentRecord;
  eventId: string;
  candidates: readonly ConversationDocumentFactCandidate[];
  existingFacts: readonly FactItem[];
  messages: readonly ConversationMessageRecord[];
  now: string;
}) {
  const existingById = new Map(input.existingFacts.map((fact) => [fact.factId, fact]));
  const facts = new Map<string, FactItem>();
  const candidates = input.candidates.map((candidate) => {
    if (candidate.validationStatus !== "validated") return candidate;
    const factId = stableFactId(input.ingestion, candidate);
    const mapped = buildFact(input.eventId, candidate, factId, input.messages, input.now);
    const existing = facts.get(factId) ?? existingById.get(factId);
    facts.set(factId, existing ? mergeFact(existing, mapped) : mapped);
    return { ...candidate, persistedFactId: factId };
  });
  return {
    candidates,
    factsToSave: [...facts.values()],
    activeFacts: [...facts.values()].filter((fact) => fact.status === "active")
  };
}

export function conversationDocumentSourceRef(documentId: string): SourceRef {
  return {
    sourceRefId: `conversation_document_${stableId(documentId)}`,
    sourceType: "conversation_document",
    sourceId: documentId
  };
}

function buildFact(
  eventId: string,
  candidate: ConversationDocumentFactCandidate,
  factId: string,
  messages: readonly ConversationMessageRecord[],
  now: string
): FactItem {
  const messageById = latestConversationMessagesById(messages);
  const sourceMessages = candidate.sourceMessageIds.flatMap((messageId) => {
    const message = messageById.get(messageId);
    return message ? [message] : [];
  });
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
  return {
    factId,
    factType: candidate.factType,
    factText: candidate.factText,
    sourceClaim: candidate.evidenceQuotes.join("\n"),
    normalizedClaim: candidate.normalizedClaim,
    linkedEventIds: [eventId],
    linkedSegmentIds: [],
    linkedSourceRefs: uniqueSourceRefs(sourceMessages.map(conversationMessageSourceRef)),
    entityIds: [...new Set([...candidate.entityIds, ...(candidate.subject ? [candidate.subject] : [])])],
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
    schemaVersion: "conversation-document-fact.v2",
    accessState: "visible"
  };
}

function mergeFact(existing: FactItem, incoming: FactItem): FactItem {
  const validTimeStart = earliestOptionalTime(existing.validTimeStart, incoming.validTimeStart);
  const validTimeEnd = latestOptionalTime(existing.validTimeEnd, incoming.validTimeEnd);
  const evidenceTimeStart = earliestOptionalTime(existing.evidenceTimeStart, incoming.evidenceTimeStart);
  const evidenceTimeEnd = latestOptionalTime(existing.evidenceTimeEnd, incoming.evidenceTimeEnd);
  const validTimeBasis = incoming.validTimeBasis ?? existing.validTimeBasis;
  const sourceClaim = incoming.sourceClaim ?? existing.sourceClaim;
  return {
    ...existing,
    factText: incoming.factText,
    ...(sourceClaim ? { sourceClaim } : {}),
    normalizedClaim: incoming.normalizedClaim,
    linkedEventIds: [...new Set([...existing.linkedEventIds, ...incoming.linkedEventIds])],
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
    ...(validTimeBasis ? { validTimeBasis } : {}),
    validTimeConfidence: lowestConversationTimeConfidence([
      existing.validTimeConfidence ?? existing.timeConfidence,
      incoming.validTimeConfidence ?? incoming.timeConfidence
    ]),
    timeBasis: incoming.validTimeBasis ?? existing.validTimeBasis ?? incoming.timeBasis,
    timeConfidence: lowestConversationTimeConfidence([
      existing.validTimeConfidence ?? existing.timeConfidence,
      incoming.validTimeConfidence ?? incoming.timeConfidence
    ]),
    observedAt: incoming.observedAt,
    status: "active",
    ...(incoming.accessState ? { accessState: incoming.accessState } : {})
  };
}

function parseCandidate(value: unknown): {
  valid: boolean;
  reason: string;
  candidate: Omit<
    ConversationDocumentFactCandidate,
    "candidateId" | "candidateIndex" | "validationStatus" | "validationReason" | "persistedFactId" | "rawCandidate"
  >;
} {
  const record = isRecord(value) ? value : {};
  const subject = optionalString(record.subject);
  const validTimeStart = optionalString(record.validTimeStart);
  const validTimeEnd = optionalString(record.validTimeEnd);
  const validTimeBasis = enumOptionalValue(record.validTimeBasis, CONVERSATION_VALID_TIME_BASES);
  const validTimeConfidence = enumOptionalValue(record.validTimeConfidence, CONVERSATION_TIME_CONFIDENCES);
  const candidate = {
    factType: stringValue(record.factType),
    factText: stringValue(record.factText),
    normalizedClaim: stringValue(record.normalizedClaim),
    ...(subject ? { subject } : {}),
    epistemicStatus: enumValue(record.epistemicStatus, CONVERSATION_FACT_EPISTEMIC_STATUSES, "agent_inferred"),
    confidenceLevel: enumValue(record.confidenceLevel, CONFIDENCE_LEVELS, "low"),
    memoryEligibility: enumValue(record.memoryEligibility, CONVERSATION_FACT_MEMORY_ELIGIBILITIES, "rejected"),
    sourceMessageIds: stringArray(record.sourceMessageIds),
    evidenceQuotes: evidenceQuoteArray(record.evidenceQuotes),
    entityIds: record.entityIds === undefined ? [] : stringArray(record.entityIds),
    ...(validTimeStart ? { validTimeStart } : {}),
    ...(validTimeEnd ? { validTimeEnd } : {}),
    ...(validTimeBasis ? { validTimeBasis } : {}),
    ...(validTimeConfidence ? { validTimeConfidence } : {})
  };
  const canonicalLanguageError = englishCanonicalFactValidationError(candidate.factText, candidate.normalizedClaim);
  const reason = !isRecord(value)
    ? "candidate_must_be_an_object"
    : !candidate.factType
      ? "fact_type_required"
      : !candidate.factText
        ? "fact_text_required"
        : !candidate.normalizedClaim
          ? "normalized_claim_required"
          : canonicalLanguageError
            ? canonicalLanguageError
          : !CONVERSATION_FACT_EPISTEMIC_STATUSES.includes(record.epistemicStatus as ConversationFactEpistemicStatus)
            ? "invalid_epistemic_status"
            : !CONFIDENCE_LEVELS.includes(record.confidenceLevel as typeof CONFIDENCE_LEVELS[number])
              ? "invalid_confidence_level"
              : !CONVERSATION_FACT_MEMORY_ELIGIBILITIES.includes(record.memoryEligibility as ConversationFactMemoryEligibility)
              ? "invalid_memory_eligibility"
                : !validStringArray(record.sourceMessageIds)
                  ? "source_message_ids_required"
                : !validStringArray(record.evidenceQuotes)
                  ? "evidence_quotes_required"
                  : record.entityIds !== undefined && !validOptionalStringArray(record.entityIds)
                    ? "invalid_entity_ids"
                    : candidate.validTimeStart && !isIsoDate(candidate.validTimeStart)
                      ? "invalid_valid_time_start"
                      : candidate.validTimeEnd && !isIsoDate(candidate.validTimeEnd)
                        ? "invalid_valid_time_end"
                        : record.validTimeBasis !== undefined && record.validTimeBasis !== null && !validTimeBasis
                          ? "invalid_valid_time_basis"
                          : record.validTimeConfidence !== undefined && record.validTimeConfidence !== null && !validTimeConfidence
                            ? "invalid_valid_time_confidence"
                            : "valid";
  return { valid: reason === "valid", reason, candidate };
}

function stableFactId(ingestion: ConversationIngestionRecord, candidate: ConversationDocumentFactCandidate) {
  return `cdfact_${stableId([
    ingestion.tenantId,
    ingestion.principalId,
    ingestion.sessionId,
    normalizeForKey(candidate.subject ?? ""),
    normalizeForKey(candidate.factType),
    normalizeForKey(candidate.normalizedClaim)
  ].join(":"))}`;
}

function containsSensitiveSecret(value: string) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/u.test(value) ||
    /(?:password|passwd|密码|口令)\s*(?:is|是|=|:)\s*\S{4,}/iu.test(value);
}

function strongerConfidence(left: FactItem["confidenceLevel"], right: FactItem["confidenceLevel"]) {
  const weight = { low: 0, medium: 1, high: 2 } as const;
  return weight[left] >= weight[right] ? left : right;
}

function uniqueSourceRefs(sourceRefs: readonly SourceRef[]) {
  return sourceRefs.filter((sourceRef, index) =>
    sourceRefs.findIndex((candidate) => candidate.sourceRefId === sourceRef.sourceRefId) === index
  );
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim());
}

function validOptionalStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

function stringArray(value: unknown) {
  return validOptionalStringArray(value) ? [...new Set(value.map((item) => item.trim()))] : [];
}

function evidenceQuoteArray(value: unknown) {
  return validOptionalStringArray(value) ? [...new Set(value)] : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown) {
  return stringValue(value) || undefined;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return values.includes(value as T[number]) ? value as T[number] : fallback;
}

function enumOptionalValue<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return values.includes(value as T[number]) ? value as T[number] : undefined;
}

function isIsoDate(value: string) {
  return !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/u.test(value);
}

function normalizeForKey(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ").replace(/[。！？.!?]+$/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
