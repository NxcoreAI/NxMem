import { createHash } from "node:crypto";
import type {
  ConversationEvidenceGroupRecord,
  ConversationExtractionWindowRecord,
  ConversationFactCandidateRecord,
  ConversationFactEpistemicStatus,
  ConversationFactMemoryEligibility,
  ConversationMessageRecord
} from "./persistence.js";
import {
  CONVERSATION_FACT_EPISTEMIC_STATUSES,
  CONVERSATION_FACT_MEMORY_ELIGIBILITIES
} from "./persistence.js";
import {
  CONVERSATION_TIME_CONFIDENCES,
  CONVERSATION_VALID_TIME_BASES,
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

export function validateConversationFactCandidate(input: {
  ingestionId: string;
  group: ConversationEvidenceGroupRecord;
  window: ConversationExtractionWindowRecord;
  messages: readonly ConversationMessageRecord[];
  rawCandidate: unknown;
  candidateIndex: number;
  now: string;
}): ConversationFactCandidateRecord {
  const candidateId = `cfc_${stableId(`${input.window.windowId}:${input.candidateIndex}`)}`;
  const base = parseCandidate(input.rawCandidate);
  if (!base.valid) {
    return {
      candidateId,
      ingestionId: input.ingestionId,
      groupId: input.group.groupId,
      groupVersion: input.group.version,
      windowId: input.window.windowId,
      candidateIndex: input.candidateIndex,
      factType: base.factType,
      factText: base.factText,
      normalizedClaim: base.normalizedClaim,
      epistemicStatus: base.epistemicStatus,
      confidenceLevel: base.confidenceLevel,
      memoryEligibility: "rejected",
      linkedSegmentIds: base.linkedSegmentIds,
      sourceMessageIds: base.sourceMessageIds,
      evidenceQuotes: base.evidenceQuotes,
      entityIds: base.entityIds,
      ...(base.validTimeStart ? { validTimeStart: base.validTimeStart } : {}),
      ...(base.validTimeEnd ? { validTimeEnd: base.validTimeEnd } : {}),
      ...(base.validTimeBasis ? { validTimeBasis: base.validTimeBasis } : {}),
      ...(base.validTimeConfidence ? { validTimeConfidence: base.validTimeConfidence } : {}),
      validationStatus: "invalid",
      validationReason: base.reason,
      rawCandidate: input.rawCandidate,
      createdAt: input.now,
      updatedAt: input.now
    };
  }

  const memberBySegmentId = new Map(input.group.members.map((member) => [member.segmentId, member]));
  const allowedSegmentIds = new Set(input.window.segmentIds);
  const linkedMembers = base.linkedSegmentIds.map((segmentId) => memberBySegmentId.get(segmentId));
  if (base.linkedSegmentIds.some((segmentId) => !allowedSegmentIds.has(segmentId) || !memberBySegmentId.has(segmentId))) {
    return invalidCandidate(input, candidateId, base, "linked_segment_outside_evidence_window");
  }
  const mappedMessageIds = [...new Set(linkedMembers.flatMap((member) => member ? [member.messageId] : []))].sort();
  if (!sameStringSet(mappedMessageIds, base.sourceMessageIds)) {
    return invalidCandidate(input, candidateId, base, "source_message_ids_do_not_match_linked_segments");
  }

  const linkedRowIds = new Set(linkedMembers.flatMap((member) => member ? [member.conversationMessageRowId] : []));
  const sourceMessages = input.messages.filter((message) => linkedRowIds.has(message.conversationMessageRowId));
  if (sourceMessages.length !== linkedRowIds.size) {
    return invalidCandidate(input, candidateId, base, "source_message_record_missing");
  }
  const normalizedTemporal = normalizeConversationCandidateMonthTemporal({
    sourceMessageIds: base.sourceMessageIds,
    evidenceQuotes: base.evidenceQuotes,
    messages: sourceMessages,
    ...(sourceMessages.find((message) => message.timezone)?.timezone
      ? { timezone: sourceMessages.find((message) => message.timezone)!.timezone }
      : {})
  });
  if (normalizedTemporal) {
    if (normalizedTemporal.validTimeStart) base.validTimeStart = normalizedTemporal.validTimeStart;
    if (normalizedTemporal.validTimeEnd) base.validTimeEnd = normalizedTemporal.validTimeEnd;
    else delete base.validTimeEnd;
    if (normalizedTemporal.validTimeBasis) base.validTimeBasis = normalizedTemporal.validTimeBasis;
    if (normalizedTemporal.validTimeConfidence) {
      base.validTimeConfidence = normalizedTemporal.validTimeConfidence;
    }
  }
  const sourceValidation = validateConversationCandidateSources({
    sourceMessageIds: base.sourceMessageIds,
    evidenceQuotes: base.evidenceQuotes,
    messages: sourceMessages,
    ...(sourceMessages.find((message) => message.timezone)?.timezone
      ? { timezone: sourceMessages.find((message) => message.timezone)!.timezone }
      : {}),
    temporal: {
      ...(base.validTimeStart ? { validTimeStart: base.validTimeStart } : {}),
      ...(base.validTimeEnd ? { validTimeEnd: base.validTimeEnd } : {}),
      ...(base.validTimeBasis ? { validTimeBasis: base.validTimeBasis } : {}),
      ...(base.validTimeConfidence ? { validTimeConfidence: base.validTimeConfidence } : {})
    }
  });
  if (sourceValidation?.kind === "invalid") {
    return invalidCandidate(input, candidateId, base, sourceValidation.reason);
  }

  let epistemicStatus = base.epistemicStatus;
  let memoryEligibility = base.memoryEligibility;
  let validationReason = "eligible_with_valid_provenance";
  const roles = new Set(sourceMessages.map((message) => message.role));

  if (sourceValidation?.kind === "pending") {
    memoryEligibility = "pending_verification";
    validationReason = sourceValidation.reason;
  } else if (roles.has("system")) {
    memoryEligibility = "rejected";
    validationReason = "system_message_cannot_be_memory_fact";
  } else if (sourceMessages.some((message) => message.operation === "delete")) {
    memoryEligibility = "rejected";
    validationReason = "deleted_message_cannot_create_fact";
  } else if (sourceMessages.some((message) => message.status === "failed")) {
    memoryEligibility = "rejected";
    validationReason = "failed_message_or_tool_result";
  } else if (roles.has("user") && userEvidenceIsOnlyQuestion(sourceMessages)) {
    memoryEligibility = "rejected";
    validationReason = "user_question_is_not_a_fact";
  } else if (roles.has("user") && userEvidenceIsHypothetical(sourceMessages)) {
    memoryEligibility = "evidence_only";
    validationReason = "hypothetical_or_example_is_evidence_only";
  } else if (isAssistantOnly(roles)) {
    epistemicStatus = "agent_inferred";
    if (memoryEligibility === "eligible" && ASSISTANT_MEMORY_FACT_TYPES.has(base.factType)) {
      validationReason = "assistant_fact_with_auditable_provenance";
    } else {
      memoryEligibility = memoryEligibility === "rejected" ? "rejected" : "evidence_only";
      validationReason = "assistant_only_user_fact_inference_is_evidence_only";
    }
  } else if (epistemicStatus === "tool_observed") {
    const toolMessages = sourceMessages.filter((message) => message.role === "tool");
    if (!toolMessages.length || toolMessages.some((message) => message.status !== "completed")) {
      memoryEligibility = "rejected";
      validationReason = "tool_observation_requires_completed_tool_evidence";
    }
  } else if (isToolOnly(roles)) {
    memoryEligibility = "evidence_only";
    validationReason = "tool_evidence_requires_tool_observed_epistemic_status";
  } else if (
    (epistemicStatus === "user_asserted" || epistemicStatus === "user_confirmed") &&
    !roles.has("user")
  ) {
    memoryEligibility = "rejected";
    validationReason = "user_epistemic_status_requires_user_evidence";
  }

  if (memoryEligibility === "eligible" && containsSensitiveSecret(`${base.factText}\n${base.normalizedClaim}`)) {
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
    candidateId,
    ingestionId: input.ingestionId,
    groupId: input.group.groupId,
    groupVersion: input.group.version,
    windowId: input.window.windowId,
    candidateIndex: input.candidateIndex,
    factType: base.factType,
    factText: base.factText,
    normalizedClaim: base.normalizedClaim,
    ...(base.subject ? { subject: base.subject } : {}),
    epistemicStatus,
    confidenceLevel: base.confidenceLevel,
    memoryEligibility,
    linkedSegmentIds: base.linkedSegmentIds,
    sourceMessageIds: base.sourceMessageIds,
    evidenceQuotes: base.evidenceQuotes,
    entityIds: base.entityIds,
    ...(base.validTimeStart ? { validTimeStart: base.validTimeStart } : {}),
    ...(base.validTimeEnd ? { validTimeEnd: base.validTimeEnd } : {}),
    ...(base.validTimeBasis ? { validTimeBasis: base.validTimeBasis } : {}),
    ...(base.validTimeConfidence ? { validTimeConfidence: base.validTimeConfidence } : {}),
    validationStatus,
    validationReason,
    rawCandidate: input.rawCandidate,
    createdAt: input.now,
    updatedAt: input.now
  };
}

interface ParsedCandidate {
  valid: boolean;
  reason: string;
  factType: string;
  factText: string;
  normalizedClaim: string;
  subject?: string;
  epistemicStatus: ConversationFactEpistemicStatus;
  confidenceLevel: ConversationFactCandidateRecord["confidenceLevel"];
  memoryEligibility: ConversationFactMemoryEligibility;
  linkedSegmentIds: string[];
  sourceMessageIds: string[];
  evidenceQuotes: string[];
  entityIds: string[];
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeBasis?: ConversationValidTimeBasis;
  validTimeConfidence?: ConversationTemporalConfidence;
}

function parseCandidate(value: unknown): ParsedCandidate {
  const record = isRecord(value) ? value : {};
  const factType = stringValue(record.factType);
  const factText = stringValue(record.factText);
  const normalizedClaim = stringValue(record.normalizedClaim);
  const epistemicStatus = enumValue(
    record.epistemicStatus,
    CONVERSATION_FACT_EPISTEMIC_STATUSES,
    "agent_inferred"
  );
  const confidenceLevel = enumValue(record.confidenceLevel, CONFIDENCE_LEVELS, "low");
  const memoryEligibility = enumValue(
    record.memoryEligibility,
    CONVERSATION_FACT_MEMORY_ELIGIBILITIES,
    "rejected"
  );
  const linkedSegmentIds = stringArray(record.linkedSegmentIds);
  const sourceMessageIds = stringArray(record.sourceMessageIds);
  const evidenceQuotes = evidenceQuoteArray(record.evidenceQuotes);
  const entityIds = record.entityIds === undefined ? [] : stringArray(record.entityIds);
  const subject = optionalString(record.subject);
  const validTimeStart = optionalString(record.validTimeStart);
  const validTimeEnd = optionalString(record.validTimeEnd);
  const validTimeBasis = enumOptionalValue(record.validTimeBasis, CONVERSATION_VALID_TIME_BASES);
  const validTimeConfidence = enumOptionalValue(record.validTimeConfidence, CONVERSATION_TIME_CONFIDENCES);
  const canonicalLanguageError = englishCanonicalFactValidationError(factText, normalizedClaim);
  const reason = !isRecord(value)
    ? "candidate_must_be_an_object"
    : !factType
      ? "fact_type_required"
      : !factText
        ? "fact_text_required"
      : !normalizedClaim
          ? "normalized_claim_required"
          : canonicalLanguageError
            ? canonicalLanguageError
          : !CONVERSATION_FACT_EPISTEMIC_STATUSES.includes(record.epistemicStatus as ConversationFactEpistemicStatus)
            ? "invalid_epistemic_status"
            : !CONFIDENCE_LEVELS.includes(record.confidenceLevel as typeof CONFIDENCE_LEVELS[number])
              ? "invalid_confidence_level"
              : !CONVERSATION_FACT_MEMORY_ELIGIBILITIES.includes(record.memoryEligibility as ConversationFactMemoryEligibility)
                ? "invalid_memory_eligibility"
                : !validStringArray(record.linkedSegmentIds)
                  ? "linked_segment_ids_required"
                  : !validStringArray(record.sourceMessageIds)
                    ? "source_message_ids_required"
                    : !validStringArray(record.evidenceQuotes)
                      ? "evidence_quotes_required"
                    : record.entityIds !== undefined && !validOptionalStringArray(record.entityIds)
                      ? "invalid_entity_ids"
                      : validTimeStart && !isIsoDate(validTimeStart)
                        ? "invalid_valid_time_start"
                        : validTimeEnd && !isIsoDate(validTimeEnd)
                          ? "invalid_valid_time_end"
                          : record.validTimeBasis !== undefined && record.validTimeBasis !== null && !validTimeBasis
                            ? "invalid_valid_time_basis"
                            : record.validTimeConfidence !== undefined && record.validTimeConfidence !== null && !validTimeConfidence
                              ? "invalid_valid_time_confidence"
                              : "valid";
  return {
    valid: reason === "valid",
    reason,
    factType,
    factText,
    normalizedClaim,
    ...(subject ? { subject } : {}),
    epistemicStatus,
    confidenceLevel,
    memoryEligibility,
    linkedSegmentIds,
    sourceMessageIds,
    evidenceQuotes,
    entityIds,
    ...(validTimeStart ? { validTimeStart } : {}),
    ...(validTimeEnd ? { validTimeEnd } : {}),
    ...(validTimeBasis ? { validTimeBasis } : {}),
    ...(validTimeConfidence ? { validTimeConfidence } : {})
  };
}

function invalidCandidate(
  input: Parameters<typeof validateConversationFactCandidate>[0],
  candidateId: string,
  base: ParsedCandidate,
  reason: string
): ConversationFactCandidateRecord {
  return {
    candidateId,
    ingestionId: input.ingestionId,
    groupId: input.group.groupId,
    groupVersion: input.group.version,
    windowId: input.window.windowId,
    candidateIndex: input.candidateIndex,
    factType: base.factType,
    factText: base.factText,
    normalizedClaim: base.normalizedClaim,
    ...(base.subject ? { subject: base.subject } : {}),
    epistemicStatus: base.epistemicStatus,
    confidenceLevel: base.confidenceLevel,
    memoryEligibility: "rejected",
    linkedSegmentIds: base.linkedSegmentIds,
    sourceMessageIds: base.sourceMessageIds,
    evidenceQuotes: base.evidenceQuotes,
    entityIds: base.entityIds,
    ...(base.validTimeStart ? { validTimeStart: base.validTimeStart } : {}),
    ...(base.validTimeEnd ? { validTimeEnd: base.validTimeEnd } : {}),
    ...(base.validTimeBasis ? { validTimeBasis: base.validTimeBasis } : {}),
    ...(base.validTimeConfidence ? { validTimeConfidence: base.validTimeConfidence } : {}),
    validationStatus: "invalid",
    validationReason: reason,
    rawCandidate: input.rawCandidate,
    createdAt: input.now,
    updatedAt: input.now
  };
}

function userEvidenceIsOnlyQuestion(messages: readonly ConversationMessageRecord[]) {
  const userMessages = messages.filter((message) => message.role === "user");
  return userMessages.length > 0 && userMessages.every((message) => isQuestion(message.content));
}

function isQuestion(content: string) {
  const normalized = content.trim();
  return /[?？]\s*$/u.test(normalized) ||
    /^(?:who|what|when|where|why|how|can|could|would|should|is|are|do|does|did|请问|是否|能否|可否|为什么|为何|怎么|如何|哪|什么|谁)/iu.test(normalized);
}

function userEvidenceIsHypothetical(messages: readonly ConversationMessageRecord[]) {
  return messages
    .filter((message) => message.role === "user")
    .every((message) => /^(?:例如|比如|举例|假设|假如|如果|example\b|for example\b|suppose\b|hypothetically\b|if\b)/iu.test(message.content.trim()));
}

function containsSensitiveSecret(value: string) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/u.test(value) ||
    /(?:password|passwd|密码|口令)\s*(?:is|是|=|:)\s*\S{4,}/iu.test(value);
}

function isAssistantOnly(roles: ReadonlySet<string>) {
  return roles.size === 1 && roles.has("assistant");
}

function isToolOnly(roles: ReadonlySet<string>) {
  return roles.size === 1 && roles.has("tool");
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === new Set(right).size && left.every((value) => right.includes(value));
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
  const normalized = stringValue(value);
  return normalized || undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableId(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}
