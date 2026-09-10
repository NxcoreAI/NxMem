import type {
  DataLakeCustomFields,
  FactItem,
  LongTermMemory,
  MemoryEvent,
  ParsedSegment,
  ShortTermMemory,
  SourceRef,
  TemporalConfidence
} from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import type { ConversationMessageRecord } from "./conversation-ingestion/persistence.js";
import { conversationMessageSourceRef } from "./conversation-ingestion/conversation-fact-temporal.js";
import { sourceRefsFromEvent } from "./memory-event-fields.js";

export type EvidenceType = "conversation_message" | "parsed_segment";
export type EvidenceVisibility = MemoryEvent["permissionSnapshot"]["visibility"];

export interface EvidenceSearchCandidate {
  id: string;
  evidenceType: EvidenceType;
  content: string;
  sourceRefs: SourceRef[];
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  evidenceTimeConfidence: TemporalConfidence;
  permissionStatus: "allowed" | "filtered";
  score: number;
  tenantId: string;
  principalId: string;
  sourceApp?: string;
  sourceId?: string;
  visibility: EvidenceVisibility;
  metadata?: DataLakeCustomFields;
}

export interface EvidenceSearchQuery {
  tenantId?: string;
  principalId?: string;
  sourceIds?: string[];
  allowedVisibilities?: EvidenceVisibility[];
  text?: string;
  tokens?: string[];
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  limit?: number;
}

export type EvidenceOwnerInput =
  | { layer: "fact"; owner: FactItem }
  | { layer: "stm"; owner: ShortTermMemory }
  | { layer: "ltm"; owner: LongTermMemory };

export function adaptConversationMessageEvidence(
  message: ConversationMessageRecord,
  visibility: EvidenceVisibility = "private"
): EvidenceSearchCandidate {
  const sourceRef = conversationMessageSourceRef(message);
  return {
    id: message.conversationMessageRowId,
    evidenceType: "conversation_message",
    content: message.content,
    sourceRefs: [sourceRef],
    evidenceTimeStart: message.createdAt,
    evidenceTimeEnd: message.createdAt,
    evidenceTimeConfidence: message.timeConfidence,
    permissionStatus: "allowed",
    score: 0,
    tenantId: message.tenantId,
    principalId: message.principalId,
    sourceApp: message.sourceApp,
    sourceId: message.conversationMessageRowId,
    visibility,
    metadata: {
      messageId: message.messageId,
      conversationMessageRowId: message.conversationMessageRowId,
      sessionId: message.sessionId,
      ingestionId: message.ingestionId,
      revision: message.revision,
      role: message.role,
      operation: message.operation
    }
  };
}

export function adaptParsedSegmentEvidence(
  segment: ParsedSegment,
  event: MemoryEvent
): EvidenceSearchCandidate {
  const temporal = parsedSegmentTemporalMetadata(segment, event);
  const segmentRef: SourceRef = {
    sourceRefId: segment.segmentId,
    sourceType: "parsed_segment",
    sourceId: segment.segmentId,
    metadata: {
      eventId: segment.eventId,
      ...(segment.dataSource?.sourceApp ? { sourceApp: segment.dataSource.sourceApp } : {}),
      ...(segment.dataSource?.sourceId ? { parentSourceId: segment.dataSource.sourceId } : {}),
      ...(segment.dataSource?.sourceType ? { parentSourceType: segment.dataSource.sourceType } : {})
    }
  };
  return {
    id: segment.segmentId,
    evidenceType: "parsed_segment",
    content: segment.content,
    sourceRefs: uniqueSourceRefs([segmentRef, ...sourceRefsFromEvent(event)]),
    ...temporal,
    permissionStatus: "allowed",
    score: 0,
    tenantId: event.permissionSnapshot.tenantId,
    principalId: event.permissionSnapshot.principalId,
    ...(segment.dataSource?.sourceApp || event.dataSource?.sourceApp || event.sourceApp
      ? { sourceApp: segment.dataSource?.sourceApp ?? event.dataSource?.sourceApp ?? event.sourceApp }
      : {}),
    sourceId: segment.segmentId,
    visibility: event.permissionSnapshot.visibility,
    metadata: {
      eventId: segment.eventId,
      modality: segment.modality,
      parseConfidence: segment.confidence,
      ...(segment.dataSource?.sourceId ? { parentSourceId: segment.dataSource.sourceId } : {}),
      ...(segment.dataSource?.sourceType ? { parentSourceType: segment.dataSource.sourceType } : {})
    }
  };
}

export function isConversationDerivedSegment(segment: ParsedSegment) {
  return segment.dataSource?.sourceType === "conversation_message" ||
    typeof segment.customFields?.conversationMessageRowId === "string";
}

export function filterAndScoreEvidenceCandidates(
  candidates: readonly EvidenceSearchCandidate[],
  query: EvidenceSearchQuery
) {
  const tokens = normalizeEvidenceTokens(query.tokens ?? tokenizeEvidenceText(query.text ?? ""));
  const normalizedText = normalizeEvidenceText(query.text ?? "");
  const allowedSources = new Set((query.sourceIds ?? []).map((item) => item.trim()).filter(Boolean));
  const allowedVisibilities = query.allowedVisibilities?.length
    ? new Set(query.allowedVisibilities)
    : undefined;

  return candidates
    .filter((candidate) => !query.tenantId || candidate.tenantId === query.tenantId)
    .filter((candidate) => !query.principalId || candidate.principalId === query.principalId)
    .filter((candidate) => !allowedVisibilities || allowedVisibilities.has(candidate.visibility))
    .filter((candidate) => !allowedSources.size || evidenceMatchesSource(candidate, allowedSources))
    .filter((candidate) => evidenceEnvelopeIntersects(candidate, query))
    .map((candidate) => ({
      ...candidate,
      score: evidenceTextScore(candidate.content, normalizedText, tokens)
    }))
    .filter((candidate) => !normalizedText || candidate.score > 0)
    .sort(compareEvidenceCandidates)
    .slice(0, normalizeEvidenceLimit(query.limit));
}

export async function materializeEvidenceForOwners(
  repository: ContextEngineRepository,
  owners: readonly EvidenceOwnerInput[],
  query: EvidenceSearchQuery = {}
): Promise<Map<string, EvidenceSearchCandidate[]>> {
  const plans = new Map<string, EvidenceMaterializationPlan>();
  const sourceMemoryIds = new Set<string>();

  for (const input of owners) {
    const plan = createOwnerPlan(input);
    plans.set(plan.ownerKey, plan);
    for (const memoryId of plan.sourceMemoryIds) sourceMemoryIds.add(memoryId);
  }

  const sourceMemories = await repository.getShortTermMemoriesByIds([...sourceMemoryIds]);
  const sourceMemoryById = new Map(sourceMemories.map((memory) => [memory.memoryDataId, memory]));
  for (const plan of plans.values()) {
    for (const memoryId of plan.sourceMemoryIds) {
      const memory = sourceMemoryById.get(memoryId);
      if (!memory) continue;
      addSourceRefs(plan, memory.sourceRefs);
      addValues(plan.factIds, memory.sourceFactIds);
    }
  }

  const factIds = new Set<string>();
  for (const plan of plans.values()) addValues(factIds, plan.factIds);
  const facts = await repository.getFactItemsByIds([...factIds]);
  const factById = new Map(facts.map((fact) => [fact.factId, fact]));
  for (const plan of plans.values()) {
    for (const factId of plan.factIds) {
      const fact = factById.get(factId);
      if (!fact) continue;
      addFactEvidence(plan, fact);
    }
  }

  const messageRowIds = new Set<string>();
  const segmentIds = new Set<string>();
  for (const plan of plans.values()) {
    addValues(messageRowIds, plan.messageRowIds);
    addValues(segmentIds, plan.segmentIds);
  }

  const [messages, segments] = await Promise.all([
    repository.getConversationMessagesByRowIds([...messageRowIds]),
    repository.getParsedSegmentsByIds([...segmentIds])
  ]);
  const events = await repository.getMemoryEventsByIds([...new Set(segments.map((segment) => segment.eventId))]);
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const candidates = [
    ...messages
      .filter((message) => message.operation !== "delete")
      .map((message) => adaptConversationMessageEvidence(message)),
    ...segments.flatMap((segment) => {
      const event = eventById.get(segment.eventId);
      return event ? [adaptParsedSegmentEvidence(segment, event)] : [];
    })
  ];
  const { limit, ...filterQuery } = query;
  const filtered = filterAndScoreEvidenceCandidates(candidates, filterQuery);
  const candidateById = new Map(filtered.map((candidate) => [candidate.id, candidate]));
  const result = new Map<string, EvidenceSearchCandidate[]>();

  for (const plan of plans.values()) {
    const evidenceIds = new Set([...plan.messageRowIds, ...plan.segmentIds]);
    const ownerEvidence = [...evidenceIds].flatMap((id) => {
      const candidate = candidateById.get(id);
      return candidate ? [candidate] : [];
    });
    result.set(plan.ownerKey, limit === undefined ? ownerEvidence : ownerEvidence.slice(0, limit));
  }
  return result;
}

export function evidenceOwnerKey(input: EvidenceOwnerInput) {
  if (input.layer === "fact") return `fact:${input.owner.factId}`;
  if (input.layer === "stm") return `stm:${input.owner.memoryDataId}`;
  return `ltm:${input.owner.memoryId}`;
}

interface EvidenceMaterializationPlan {
  ownerKey: string;
  sourceRefs: SourceRef[];
  factIds: Set<string>;
  sourceMemoryIds: Set<string>;
  messageRowIds: Set<string>;
  segmentIds: Set<string>;
}

function createOwnerPlan(input: EvidenceOwnerInput): EvidenceMaterializationPlan {
  const plan: EvidenceMaterializationPlan = {
    ownerKey: evidenceOwnerKey(input),
    sourceRefs: [],
    factIds: new Set<string>(),
    sourceMemoryIds: new Set<string>(),
    messageRowIds: new Set<string>(),
    segmentIds: new Set<string>()
  };
  if (input.layer === "fact") {
    addFactEvidence(plan, input.owner);
  } else if (input.layer === "stm") {
    addSourceRefs(plan, input.owner.sourceRefs);
    addValues(plan.factIds, input.owner.sourceFactIds);
  } else {
    addSourceRefs(plan, input.owner.sourceRefs);
    addValues(plan.sourceMemoryIds, input.owner.sourceMemoryDataIds);
  }
  return plan;
}

function addFactEvidence(plan: EvidenceMaterializationPlan, fact: FactItem) {
  addSourceRefs(plan, fact.linkedSourceRefs);
  addValues(plan.segmentIds, fact.linkedSegmentIds);
}

function addSourceRefs(plan: EvidenceMaterializationPlan, refs: readonly SourceRef[]) {
  plan.sourceRefs = uniqueSourceRefs([...plan.sourceRefs, ...refs]);
  for (const ref of refs) {
    if (ref.sourceType === "conversation_message") {
      plan.messageRowIds.add(ref.sourceId || ref.sourceRefId);
    } else if (ref.sourceType === "parsed_segment") {
      plan.segmentIds.add(ref.sourceId || ref.sourceRefId);
    }
  }
}

function parsedSegmentTemporalMetadata(segment: ParsedSegment, event: MemoryEvent) {
  const evidenceTimeStart = firstIsoTimestamp(
    segment.customFields?.evidenceTimeStart,
    segment.customFields?.eventTimeStart,
    event.customFields?.evidenceTimeStart,
    event.customFields?.eventTimeStart,
    event.eventTime
  );
  const evidenceTimeEnd = firstIsoTimestamp(
    segment.customFields?.evidenceTimeEnd,
    segment.customFields?.eventTimeEnd,
    event.customFields?.evidenceTimeEnd,
    event.customFields?.eventTimeEnd,
    evidenceTimeStart
  );
  const confidence = firstTemporalConfidence(
    segment.customFields?.evidenceTimeConfidence,
    segment.customFields?.eventTimeConfidence,
    event.customFields?.evidenceTimeConfidence,
    event.customFields?.eventTimeConfidence,
    ...event.multimodalData.map((item) => item.timeConfidence)
  ) ?? "medium";
  return {
    ...(evidenceTimeStart ? { evidenceTimeStart } : {}),
    ...(evidenceTimeEnd ? { evidenceTimeEnd } : {}),
    evidenceTimeConfidence: confidence
  };
}

function evidenceMatchesSource(candidate: EvidenceSearchCandidate, allowed: ReadonlySet<string>) {
  if (candidate.sourceId && allowed.has(candidate.sourceId)) return true;
  if (candidate.sourceApp && allowed.has(candidate.sourceApp)) return true;
  if (candidate.sourceRefs.some((ref) => allowed.has(ref.sourceId) || allowed.has(ref.sourceRefId))) return true;
  return Object.values(candidate.metadata ?? {}).some((value) => typeof value === "string" && allowed.has(value));
}

function evidenceEnvelopeIntersects(candidate: EvidenceSearchCandidate, query: EvidenceSearchQuery) {
  if (!query.evidenceTimeStart && !query.evidenceTimeEnd) return true;
  const candidateStart = parseTime(candidate.evidenceTimeStart ?? candidate.evidenceTimeEnd);
  const candidateEnd = parseTime(candidate.evidenceTimeEnd ?? candidate.evidenceTimeStart);
  if (candidateStart === undefined || candidateEnd === undefined) return false;
  const queryStart = parseTime(query.evidenceTimeStart);
  const queryEnd = parseTime(query.evidenceTimeEnd);
  if (queryStart !== undefined && candidateEnd < queryStart) return false;
  if (queryEnd !== undefined && candidateStart >= queryEnd) return false;
  return true;
}

function evidenceTextScore(content: string, normalizedQuery: string, tokens: readonly string[]) {
  if (!normalizedQuery) return 1;
  const normalizedContent = normalizeEvidenceText(content);
  if (normalizedContent.includes(normalizedQuery)) return 1;
  if (!tokens.length) return 0;
  const matched = tokens.filter((token) => normalizedContent.includes(token)).length;
  return matched / tokens.length;
}

function compareEvidenceCandidates(left: EvidenceSearchCandidate, right: EvidenceSearchCandidate) {
  if (right.score !== left.score) return right.score - left.score;
  const rightTime = parseTime(right.evidenceTimeEnd ?? right.evidenceTimeStart) ?? 0;
  const leftTime = parseTime(left.evidenceTimeEnd ?? left.evidenceTimeStart) ?? 0;
  return rightTime - leftTime || left.id.localeCompare(right.id);
}

function normalizeEvidenceLimit(limit: number | undefined) {
  if (limit === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(1, Math.floor(limit)), 500);
}

function tokenizeEvidenceText(text: string) {
  return text.split(/[^a-z0-9\u4e00-\u9fa5]+/u).map((item) => item.trim()).filter(Boolean);
}

function normalizeEvidenceTokens(tokens: readonly string[]) {
  return [...new Set(tokens.map(normalizeEvidenceText).filter(Boolean))];
}

function normalizeEvidenceText(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function uniqueSourceRefs(refs: readonly SourceRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = ref.sourceRefId || `${ref.sourceType}:${ref.sourceId}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstIsoTimestamp(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function firstTemporalConfidence(...values: unknown[]): TemporalConfidence | undefined {
  return values.find((value): value is TemporalConfidence => value === "low" || value === "medium" || value === "high");
}

function parseTime(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function addValues(target: Set<string>, values: Iterable<string>) {
  for (const value of values) {
    if (value) target.add(value);
  }
}
