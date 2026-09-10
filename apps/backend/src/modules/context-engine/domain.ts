export type Id = string;

export type LifecycleStatus =
  | "raw"
  | "parsed"
  | "indexed"
  | "archived"
  | "deleted"
  | "candidate"
  | "active"
  | "superseded"
  | "conflicted"
  | "expired"
  | "candidate_queue"
  | "consolidated"
  | "dropped"
  | "weakened"
  | "revised";

export interface SourceRef {
  sourceRefId: Id;
  sourceType: string;
  sourceId: string;
  sourceUrl?: string;
  metadata?: DataLakeCustomFields;
}

export type DataLakeCustomFieldValue =
  | string
  | number
  | boolean
  | null
  | DataLakeCustomFieldValue[]
  | { [key: string]: DataLakeCustomFieldValue };

export type DataLakeCustomFields = Record<string, DataLakeCustomFieldValue>;

export interface DataLakeSourceDescriptor {
  sourceApp: string;
  sourceId: string;
  sourceName?: string;
  sourceType?: string;
  sourceUri?: string;
  connectorId?: string;
  syncCursor?: string;
  syncVersion?: string;
}

export interface MultimodalDataItem {
  itemId: Id;
  type: "text" | "document" | "image" | "audio" | "video" | "tool_result";
  format: string;
  content?: DataLakeCustomFieldValue;
  ref?: string;
  sourceRefs?: SourceRef[];
  timeBasis?: "absolute" | "event_relative" | "media_offset" | "source_time";
  timeConfidence?: "low" | "medium" | "high";
  /** @deprecated Store structured metadata in content JSON instead. */
  customFields?: DataLakeCustomFields;
}

export interface ParsedSegment {
  segmentId: Id;
  eventId: Id;
  modality: MultimodalDataItem["type"];
  content: string;
  status: "parsed" | "unsupported" | "pending";
  confidence: "low" | "medium" | "high";
  dataSource?: DataLakeSourceDescriptor;
  customFields?: DataLakeCustomFields;
}

export interface PermissionSnapshot {
  snapshotId: Id;
  tenantId: Id;
  principalId: Id;
  sourceAclVersion: string;
  visibility: "private" | "team" | "tenant" | "public";
}

export interface MemoryEvent {
  eventId: Id;
  contextScopeId?: Id;
  eventType: string;
  eventSummary?: string;
  /** @deprecated Use eventSummary. */
  eventDescription?: string;
  eventTime: string;
  sourceApp?: string;
  sourceId?: string;
  dataSource?: DataLakeSourceDescriptor;
  /** @deprecated Store structured metadata in multimodalData.content JSON instead. */
  customFields?: DataLakeCustomFields;
  permissionSnapshot: PermissionSnapshot;
  multimodalData: MultimodalDataItem[];
  /** @deprecated Prefer multimodalData[].sourceRefs. */
  sourceRefs?: SourceRef[];
}

export interface FactItem {
  factId: Id;
  /** Conversation session that produced this fact, when applicable. */
  sessionId?: Id;
  /** One-based order of this fact within its source conversation session. */
  factSequence?: number;
  tenantId?: Id;
  principalId?: Id;
  contextScopeId?: Id;
  factType: string;
  factText: string;
  /** Verbatim temporal expression extracted for deterministic LongMemEval resolution. */
  timeAnchor?: string | null;
  sourceClaim?: string;
  normalizedClaim: string;
  linkedEventIds: Id[];
  linkedSegmentIds: Id[];
  linkedSourceRefs: SourceRef[];
  entityIds: Id[];
  confidenceLevel: "low" | "medium" | "high";
  version: number;
  status: "active" | "conflicted" | "superseded" | "rejected";
  observedAt: string;
  /** LongMemEval evidence timestamp for the source session. */
  evidenceTime?: string;
  /** LongMemEval point occurrence time; period expressions use validTimeStart/validTimeEnd. */
  validTime?: string;
  /** Event-level anchors when one fact item describes multiple temporal events. */
  events?: MemoryTemporalEvent[];
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  evidenceTimeConfidence?: "low" | "medium" | "high";
  sourceMessageIds?: Id[];
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeBasis?: "absolute" | "event_relative" | "source_time";
  validTimeConfidence?: "low" | "medium" | "high";
  /** @deprecated Use validTimeBasis. */
  timeBasis: NonNullable<MultimodalDataItem["timeBasis"]>;
  /** @deprecated Use validTimeConfidence. */
  timeConfidence: NonNullable<MultimodalDataItem["timeConfidence"]>;
  schemaVersion: string;
  accessState?: "visible" | "hidden" | "permission-invalid";
}

export interface MemoryTemporalEvent {
  /** Stable identifier used to bind downstream reasoning to this event. */
  eventKey: string;
  /** Human-readable event description exposed to answer prompts and diagnostics. */
  label: string;
  validTime: string;
  evidenceTime?: string;
  sourceFactIds?: Id[];
}

export interface FactVersion {
  factVersionId: Id;
  factId: Id;
  tenantId: Id;
  principalId: Id;
  version: number;
  previousVersionId?: Id;
  factText: string;
  normalizedClaim: string;
  factType: string;
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  validTimeStart?: string;
  validTimeEnd?: string;
  confidenceLevel: FactItem["confidenceLevel"];
  sourceFactIds: Id[];
  linkedEventIds: Id[];
  linkedSegmentIds: Id[];
  linkedSourceRefs: SourceRef[];
  updateReason: string;
  conflictRefs: Id[];
  sourceFingerprint: string;
  createdAt: string;
}

export interface FactBatchCommitted {
  batchId: Id;
  triggerType: "event" | "conversation_session" | "ingestion_job" | "manual_correction" | "backfill";
  tenantId: Id;
  principalId: Id;
  contextScopeId?: Id;
  newFactIds: Id[];
  committedAt: string;
}

export interface TimelineFusionTask {
  taskId: Id;
  tenantId: Id;
  principalId: Id;
  contextScopeId?: Id;
  batchIds: Id[];
  newFactIds: Id[];
  status: "pending" | "ready" | "running" | "succeeded" | "failed";
  scheduledAt: string;
  deadlineAt: string;
  readyAt?: string;
  executionFingerprints?: string[];
  completionReason?: "no_candidate" | "no_temporal_window";
  completedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineFusionWindow {
  basis: "evidence" | "valid" | "weak_anchor";
  startAt: string;
  endAt: string;
}

export interface TimelineFusionExecution {
  executionId: Id;
  fingerprint: string;
  tenantId: Id;
  principalId: Id;
  contextScopeId?: Id;
  taskIds: Id[];
  batchIds: Id[];
  newFactIds: Id[];
  temporalWindow: TimelineFusionWindow;
  fusionPolicyVersion: string;
  status: "pending" | "running" | "succeeded" | "failed";
  resultFactIds: Id[];
  attempt: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  completionReason?: "no_candidate";
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type TemporalConfidence = "low" | "medium" | "high";

export const TEMPORAL_ERROR_CODES = [
  "TEMPORAL_PROTOCOL_INVALID",
  "TEMPORAL_SOURCE_NOT_FOUND",
  "TEMPORAL_QUOTE_MISMATCH",
  "TEMPORAL_RANGE_INVALID",
  "TEMPORAL_METADATA_MISSING",
  "TEMPORAL_BACKFILL_FAILED"
] as const;

export type TemporalErrorCode = typeof TEMPORAL_ERROR_CODES[number];

export interface TemporalTraceMetadata {
  operation: "protocol" | "fact_extraction" | "search" | "backfill";
  ingestionId?: Id;
  sessionId?: Id;
  documentId?: Id;
  temporalMode?: "legacy" | "extended";
  timezone?: string;
  locale?: string;
  resolverSource?: "explicit" | "deterministic" | "semantic" | "none";
  resolverConfidence?: TemporalConfidence;
  timeBasis?: "evidence" | "valid" | "auto" | "absolute" | "event_relative" | "source_time";
  sourceMessageRowIds?: Id[];
  filterBeforeCount?: number;
  filterAfterCount?: number;
  dropReasonCounts?: Record<string, number>;
  featureFlags?: Record<string, boolean>;
  shadow?: {
    enabled: boolean;
    resultCount: number;
    addedResultIds: Id[];
    removedResultIds: Id[];
  };
  errorCodes?: TemporalErrorCode[];
  backfillVersion?: string;
  durationMs?: number;
}

export interface MemoryTemporalMetadata {
  /** Single-value evidence anchor used by LongMemEval memories. */
  evidenceTime?: string;
  /** Single-value fact occurrence/start anchor used by LongMemEval memories. */
  validTime?: string;
  /** Event-level anchors take precedence when an item contains multiple events. */
  events?: MemoryTemporalEvent[];
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  evidenceTimeConfidence?: TemporalConfidence;
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeConfidence?: TemporalConfidence;
}

export interface StructuredMemoryFact extends MemoryTemporalMetadata {
  factId?: Id;
  sourceMemoryDataId?: Id;
  claim: string;
  explanation: string;
  factType?: string;
  timeAnchor?: string;
  confidenceLevel?: "low" | "medium" | "high";
  validTimeStart?: string;
  validTimeEnd?: string;
  entityIds?: Id[];
  sourceRefIds?: Id[];
}

export interface StructuredMemoryFacts {
  schemaVersion: "memory-structured-facts.v1";
  memoryKind: "short_term" | "long_term";
  facts: StructuredMemoryFact[];
}

export interface LlmFactFusionTrace {
  traceId: Id;
  eventId: Id;
  provider: "openai-compatible";
  endpoint: string;
  model: string;
  keySource: "request" | "env" | "missing";
  promptVersion: string;
  schemaVersion: string;
  prompt: string;
  alignedEvidence: Array<{
    segmentId: Id;
    itemId?: Id;
    modality: MultimodalDataItem["type"];
    content: string;
    eventTime: string;
    validTimeStart: string;
    timeBasis: NonNullable<MultimodalDataItem["timeBasis"]>;
    timeConfidence: NonNullable<MultimodalDataItem["timeConfidence"]>;
    confidence: ParsedSegment["confidence"];
  }>;
  rawResponse?: unknown;
  parsedFacts: FactItem[];
  rejectedSegments: Array<{
    segmentId: Id;
    reason: string;
  }>;
  fallbackReason?: string;
  temporal?: TemporalTraceMetadata;
  createdAt: string;
}

export interface LlmStmAdmissionTrace {
  traceId: Id;
  eventId: Id;
  provider: "openai-compatible";
  endpoint: string;
  model: string;
  keySource: "request" | "env" | "missing";
  promptVersion: string;
  schemaVersion: string;
  prompt: string;
  factInputs: Array<{
    factId: Id;
    factType: string;
    factText: string;
    sourceClaim?: string;
    normalizedClaim: string;
    confidenceLevel: FactItem["confidenceLevel"];
    evidenceTime?: string;
    validTime?: string;
    evidenceTimeStart?: string;
    evidenceTimeEnd?: string;
    evidenceTimeConfidence?: TemporalConfidence;
    validTimeStart?: string;
    validTimeEnd?: string;
    validTimeConfidence?: TemporalConfidence;
    sourceRefIds: Id[];
  }>;
  rawResponse?: unknown;
  parsedDecision?: {
    result: ShortTermMemory["admissionResult"];
    memoryDataType?: string;
    importanceLevel?: ShortTermMemory["importanceLevel"];
    confidenceLevel?: ShortTermMemory["confidenceLevel"];
    ttl?: number;
    needUserConfirm?: boolean;
    reason: string;
    matchedRules: string[];
    sourceFactIds: Id[];
    factDecisions?: Array<{
      result: ShortTermMemory["admissionResult"];
      memoryDataType?: string;
      importanceLevel?: ShortTermMemory["importanceLevel"];
      confidenceLevel?: ShortTermMemory["confidenceLevel"];
      ttl?: number;
      needUserConfirm?: boolean;
      reason: string;
      matchedRules: string[];
      sourceFactIds: Id[];
    }>;
  };
  fallbackReason?: string;
  overrideReason?: string;
  createdAt: string;
}

export interface LlmDreamingTrace {
  traceId: Id;
  sourceMemoryDataIds: Id[];
  provider: "openai-compatible";
  endpoint: string;
  model: string;
  keySource: "request" | "env" | "missing";
  promptVersion: string;
  schemaVersion: string;
  prompt: string;
  candidateMemories: Array<{
    memoryDataId: Id;
    memoryDataType: string;
    memoryType?: string;
    content: string;
    summary?: string;
    importanceLevel: ShortTermMemory["importanceLevel"];
    confidenceLevel: ShortTermMemory["confidenceLevel"];
    lifecycleStatus: ShortTermMemory["lifecycleStatus"];
    matchedRules: string[];
    sourceFactIds: Id[];
    entityIds: Id[];
    structuredFacts?: StructuredMemoryFacts;
    evidenceTimeStart?: string;
    evidenceTimeEnd?: string;
    evidenceTimeConfidence?: TemporalConfidence;
    validTimeStart?: string;
    validTimeEnd?: string;
    validTimeConfidence?: TemporalConfidence;
  }>;
  rawResponse?: unknown;
  stmEvaluations?: DreamingStmEvaluation[];
  ltmOperations?: DreamingLtmOperation[];
  parsedMemories: LongTermMemory[];
  parsedRelationEdges?: RelationEdge[];
  rejectedCandidates: Array<{
    memoryDataId: Id;
    reason: string;
  }>;
  fallbackReason?: string;
  retryAfter?: string;
  createdAt: string;
}

export interface LlmDreamingStmScore {
  memoryDataId: Id;
  semanticScores?: Partial<DreamingScoreFactors>;
  scoreReasons?: Partial<Record<keyof DreamingScoreFactors, string>>;
}

export interface DreamingScoreFactors {
  stability: number;
  reuseValue: number;
  identityRelationValue: number;
  actionCommitmentValue: number;
  informationEntropy: number;
  explicitWeight: number;
  preferenceConsistency: number;
}

export type DreamingStmDecision = "consolidate" | "observe" | "drop";

export type DreamingReevaluationTier = "NEXT_DAY" | "THREE_DAYS" | "SEVEN_DAYS";

export type DreamingRunTriggerType = "scheduled" | "manual";

export type DreamingRunStatus =
  | "queued"
  | "waiting_for_idle"
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface DreamingRun {
  runId: Id;
  tenantId: Id;
  principalId: Id;
  triggerType: DreamingRunTriggerType;
  scheduleKey?: string;
  status: DreamingRunStatus;
  requestedAt: string;
  candidateWindowStartAt: string;
  candidateCutoffAt: string;
  actualStartedAt?: string;
  pausedAt?: string;
  pauseReason?: "foreground_activity" | "manual";
  completedAt?: string;
  checkpoint?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  policyVersion: string;
  promptVersion: string;
  model?: string;
  candidateCount: number;
  processedCount: number;
  consolidatedCount: number;
  observingCount: number;
  droppedCount: number;
  retryWaitCount: number;
  skippedCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type DreamingRunCandidateSourceType = "new" | "observing_due" | "retry_due" | "carryover";

export type DreamingRunCandidateStatus =
  | "pending"
  | "processing"
  | "consolidated"
  | "observing"
  | "dropped"
  | "retry_wait"
  | "skipped";

export interface DreamingRunCandidate {
  runCandidateId: Id;
  runId: Id;
  memoryDataId: Id;
  stmVersion: string;
  candidateFingerprint: string;
  sourceType: DreamingRunCandidateSourceType;
  status: DreamingRunCandidateStatus;
  cycleAttemptCount: number;
  totalAttemptCount: number;
  reevaluationTier?: DreamingReevaluationTier;
  nextEvaluateAt?: string;
  decisionId?: Id;
  traceId?: Id;
  resultLtmId?: Id;
  lastError?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DreamingStmEvaluation {
  memoryDataId: Id;
  factorScores: DreamingScoreFactors;
  factorReasons: Partial<Record<keyof DreamingScoreFactors, string>>;
  totalScore: number;
  decision: DreamingStmDecision;
  decisionReason: string;
  nextEvaluateAt?: string;
  evaluatedAt: string;
}

export type DreamingLtmOperationType = "create" | "revise" | "conflict";

export interface DreamingLtmOperation {
  memoryDataId: Id;
  operation: DreamingLtmOperationType;
  targetLtmId?: Id;
  resultLtmId: Id;
  relationType?: "is_same_as" | "supports" | "updates" | "conflicts_with" | "related_to";
  reason: string;
}

export interface ShortTermMemory extends MemoryTemporalMetadata {
  memoryDataId: Id;
  tenantId: Id;
  principalId: Id;
  createdAt: string;
  updatedAt: string;
  memoryDataType: string;
  memoryType?: string;
  content: string;
  structuredFacts?: StructuredMemoryFacts;
  factSummary?: string;
  summary?: string;
  sourceFactIds: Id[];
  sourceRefs: SourceRef[];
  entityIds: Id[];
  importanceLevel: "low" | "medium" | "high" | "critical";
  retrievalWeight?: number;
  userRetrievalWeight?: number;
  confidenceLevel: "low" | "medium" | "high";
  admissionResult: "write_short_term" | "write_candidate" | "write_high_priority" | "pending_confirm" | "reject";
  admissionReason: string;
  matchedRules: string[];
  admissionSignals: {
    importance: "low" | "medium" | "high" | "critical";
    confidence: "low" | "medium" | "high";
    freshness: "stale" | "recent" | "fresh";
    sensitivity: "low" | "medium" | "high";
    actorWeight: "low" | "medium" | "high";
    conflict: "none" | "possible" | "known";
    permission: "private" | "shared" | "public";
  };
  lifecycleStatus: "active" | "pending_confirm" | "rejected" | "expired" | "candidate_queue" | "consolidated" | "dropped" | "archived" | "deleted";
  accessState?: "visible" | "hidden" | "permission-invalid";
  consolidationStatus?: DreamingConsolidationStatus;
  nextEvaluateAt?: string;
  lastEvaluatedAt?: string;
  observeCount?: number;
  reevaluationReason?: string;
  expiresAt?: string;
  dreamingPolicyVersion?: string;
  latestDecisionId?: string;
  reevaluationTier?: DreamingReevaluationTier;
  cycleAttemptCount?: number;
  totalAttemptCount?: number;
  lastDreamingError?: string;
  latestDreamingRunId?: string;
}

export type DreamingConsolidationStatus =
  | "unseen"
  | "evaluating"
  | "observing"
  | "consolidated"
  | "dropped"
  | "pending_confirm"
  | "retryable_failure"
  | "retry_wait";

export type DreamingCandidateDecisionType = "accepted" | "observe" | "drop" | "retryable_failure";

export type DreamingCandidateReasonCode =
  | "OWNER_MISMATCH"
  | "LIFECYCLE_INVALID"
  | "CONSOLIDATION_ALREADY_COMPLETE"
  | "NOT_DUE_FOR_REEVALUATION"
  | "ACCESS_HIDDEN"
  | "SOURCE_MISSING"
  | "SOURCE_UNRESOLVED"
  | "SENSITIVE_AUTHORIZATION_REQUIRED"
  | "LOW_CONFIDENCE"
  | "RETRY_NOT_DUE";

export interface DreamingCandidateDecision {
  decisionId: Id;
  runId: Id;
  candidateFingerprint: string;
  memoryDataId: Id;
  tenantId: Id;
  principalId: Id;
  decision: DreamingCandidateDecisionType;
  reasonCodes: DreamingCandidateReasonCode[];
  sourceFactIds?: Id[];
  sourceRefs: SourceRef[];
  permissionSnapshotIds: Id[];
  policyVersion: string;
  traceId: Id;
  evaluatedAt: string;
  nextEvaluateAt?: string;
  createdAt: string;
}

export interface LongTermMemory extends MemoryTemporalMetadata {
  memoryId: Id;
  tenantId?: Id;
  principalId?: Id;
  consolidationKey?: Id;
  version?: number;
  previousVersionId?: Id;
  consolidationScore?: number;
  consolidationFactors?: Partial<DreamingScoreFactors>;
  policyVersion?: string;
  promptVersion?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  lastMaintainedAt?: string;
  theoryClass: "episodic" | "semantic" | "procedural" | "prospective";
  memoryType: string;
  content: string;
  structuredFacts?: StructuredMemoryFacts;
  factSummary?: string;
  summary?: string;
  sourceRefs: SourceRef[];
  sourceMemoryDataIds: Id[];
  sourceFactIds?: Id[];
  entityIds: Id[];
  confidenceLevel: "low" | "medium" | "high";
  recallWeight: "low" | "medium" | "high";
  retrievalWeight?: number;
  userRetrievalWeight?: number;
  solidifyReason: string;
  matchedRules: string[];
  lifecycleStatus: "active" | "weakened" | "archived" | "rejected" | "deleted" | "revised";
  accessState?: "visible" | "hidden" | "permission-invalid";
}

export interface RelationEdge {
  edgeId: Id;
  fromId: Id;
  toId: Id;
  relationType:
    | "is_same_as"
    | "alias_of"
    | "derived_from"
    | "supports"
    | "conflicts_with"
    | "same_source"
    | "updates"
    | "related_to"
    | "part_of";
  evidence?: string;
  strength?: number;
  confidence?: "low" | "medium" | "high";
  source?: "rule" | "llm" | "dreaming" | "user" | "system";
  createdAt?: string;
}

export interface ContextPackTrace {
  traceId: Id;
  packId: Id;
  task: string;
  finalScore: number;
  tokenBudget: number;
  tokenUsage: {
    profile: number;
    task: number;
    recent: number;
    constraints: number;
    citations: number;
    conflicts: number;
    total: number;
  };
  selectedItemIds: Id[];
  droppedReasons: string[];
  compressionSteps?: Array<{
    id: Id;
    layer?: "fact" | "evidence" | "stm" | "ltm";
    action: "keep" | "compress" | "drop";
    beforeTokens: number;
    afterTokens: number;
    reason: string;
  }>;
  temporal?: TemporalTraceMetadata;
  createdAt: string;
}

export interface ContextPipelineTask {
  taskId: Id;
  eventId: Id;
  taskType: "ingest" | "parse" | "fusion" | "admission" | "index" | "dreaming" | "revision";
  status: "pending" | "running" | "succeeded" | "failed" | "retry_scheduled";
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  stage: string;
  error?: string;
  retryAfter?: string;
  checkpoint?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  stats?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export interface DreamingOutboxRecord {
  outboxId: Id;
  operation: "refresh_ltm_index" | "refresh_stm_index";
  ownerId: Id;
  payload?: Record<string, unknown>;
  status: "pending" | "processing" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextIndexEntry {
  indexId: Id;
  ownerId: Id;
  ownerType: "fact" | "stm" | "ltm";
  content: string;
  lifecycleStatus: string;
  refreshedAt: string;
  tokenCount: number;
}

export interface ContextTextIndexEntry {
  indexId: Id;
  ownerId: Id;
  ownerType: "fact" | "stm" | "ltm";
  term: string;
  documentFrequency: number;
  termFrequency: number;
  documentLength: number;
  lifecycleStatus: string;
  refreshedAt: string;
}

export interface ContextVectorIndexEntry {
  indexId: Id;
  ownerId: Id;
  ownerType: "fact" | "stm" | "ltm";
  content: string;
  vector: number[];
  lifecycleStatus: string;
  refreshedAt: string;
}

export type GraphMemoryOwnerType = "stm" | "ltm";

export interface GraphMemoryNode extends MemoryTemporalMetadata {
  graphNodeId: Id;
  ownerId: Id;
  ownerType: GraphMemoryOwnerType;
  memoryType?: string;
  content: string;
  factSummary?: string;
  vector: number[];
  lifecycleStatus: string;
  retrievalWeight: number;
  sourceRefs: SourceRef[];
  entityIds: Id[];
  refreshedAt: string;
}

export interface GraphMemorySearchOptions {
  ownerTypes?: GraphMemoryOwnerType[];
  ownerKeys?: string[];
  temporalRange?: {
    startTime: string;
    endTime: string;
    basis: "evidence" | "valid";
  };
}

export interface GraphMemorySearchHit {
  ownerType: GraphMemoryOwnerType;
  ownerId: Id;
  score: number;
  matchedTerms?: number;
}

export interface MemoryChangeEvent {
  eventId: Id;
  memoryId?: Id;
  memoryDataId?: Id;
  changeType:
    | "created"
    | "updated"
    | "reinforced"
    | "weakened"
    | "revised"
    | "archived"
    | "deleted"
    | "relation_changed"
    | "feedback_received"
    | "revision_requested"
    | "permission_invalidated";
  storageLayer: "stm" | "ltm" | "fact";
  reason: string;
  createdAt: string;
}

export interface MemoryFeedbackItem {
  feedbackId: Id;
  targetId: Id;
  targetType: "fact" | "stm" | "ltm";
  action: "like" | "dislike" | "correct" | "confirm" | "ignore" | "delete";
  note?: string;
  tenantId?: string;
  principalId?: string;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
  createdAt: string;
}

export type MemoryRetrievalEventType =
  | "search_hit"
  | "context_pack_selected"
  | "agent_cited"
  | "user_feedback";

export interface MemoryRetrievalEvent {
  retrievalEventId: Id;
  ownerType: "fact" | "stm" | "ltm";
  ownerId: Id;
  tenantId?: string;
  principalId?: string;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
  eventType: MemoryRetrievalEventType;
  query?: string;
  feedbackAction?: MemoryFeedbackItem["action"];
  createdAt: string;
}

export type BackgroundSectionKey =
  | "identity"
  | "relationships"
  | "recentTasks"
  | "aiSoul";

export interface BackgroundStmCursor {
  updatedAt: string;
  memoryDataId: Id;
}

export interface BackgroundStmRange {
  afterExclusive?: BackgroundStmCursor;
  throughInclusive: BackgroundStmCursor;
  estimatedCount: number;
}

export type BackgroundWatermark = BackgroundStmCursor;

export const INITIAL_BACKGROUND_CURSOR: BackgroundStmCursor = {
  updatedAt: "1970-01-01T00:00:00.000Z",
  memoryDataId: ""
};

export interface BackgroundContextDocument {
  backgroundId: Id;
  tenantId: Id;
  principalId: Id;
  fixedText: string;
  dynamicText: string;
  fixedRevision: number;
  fixedTextUpdatedAt: string;
  fixedWatermark: BackgroundWatermark;
  dynamicWindowStart: string;
  dynamicWindowEnd: string;
  dynamicSourceMemoryIds: Id[];
  latestStmCursor: BackgroundStmCursor;
  dynamicCacheKey?: string;
  sourceRefIds: Id[];
  conflictIds: Id[];
  degradedModeReason?: string;
  updateSuggestion?: {
    status: "pending" | "applied" | "rejected";
    summary: string;
    targetSections: BackgroundSectionKey[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundAnalysisSection {
  text: string;
  sourceMemoryIds: Id[];
  confidence: "low" | "medium" | "high";
  changed: boolean;
}

export interface BackgroundAnalysisConflict {
  memoryDataIds: Id[];
  section: BackgroundSectionKey;
  description: string;
}

export interface BackgroundAnalysisOutput {
  sections: Record<BackgroundSectionKey, BackgroundAnalysisSection>;
  ignoredMemoryIds: Id[];
  conflicts: BackgroundAnalysisConflict[];
  summary: string;
}

export interface MaintainFixedBackgroundRequest {
  tenantId: string;
  principalId: string;
  runId: string;
  scheduledAt: string;
  baseBackgroundId?: Id;
  expectedFixedRevision?: number;
  stmPageSize?: number;
  maxInputTokens?: number;
  sectionLimits?: Partial<Record<BackgroundSectionKey, number>>;
  llm?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
}

export interface MaintainFixedBackgroundResponse {
  runId: string;
  backgroundId: Id;
  previousRevision: number;
  fixedRevision: number;
  fixedText: string;
  executionStrategy: "single_request" | "hierarchical_batch";
  processedMemoryCount: number;
  processedMemoryIds: Id[];
  ignoredMemoryCount: number;
  ignoredMemoryIds: Id[];
  deferredMemoryCount: number;
  deferredMemoryIds: Id[];
  scannedPageCount: number;
  llmAnalysisCallCount: number;
  inputTokenUsage: number;
  sourceRefIds: Id[];
  conflictIds: Id[];
  status: "updated" | "unchanged" | "degraded";
  degradedModeReason?: string;
}

export interface BackgroundMaintenanceTask {
  taskId: Id;
  runId: string;
  tenantId: Id;
  principalId: Id;
  status: "queued" | "running" | "succeeded" | "failed" | "retry_scheduled";
  executionStrategy: "single_request" | "hierarchical_batch";
  baseBackgroundId?: Id;
  baseRevision: number;
  windowStart: string;
  windowEnd: string;
  throughCursor?: BackgroundStmCursor;
  checkpointCursor?: BackgroundStmCursor;
  sectionAccumulator?: Partial<Record<BackgroundSectionKey, {
    summary: string;
    sourceMemoryIds: Id[];
  }>>;
  scannedPageCount: number;
  llmAnalysisCallCount: number;
  processedMemoryCount: number;
  ignoredMemoryCount: number;
  deferredRanges: BackgroundStmRange[];
  deferredMemoryCount: number;
  inputTokenUsage: number;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  error?: string;
  result?: MaintainFixedBackgroundResponse;
  claimedBy?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundMaintenanceBatch {
  taskId: Id;
  batchIndex: number;
  throughCursor: BackgroundStmCursor;
  memoryIds: Id[];
  memorySourceRefs: Record<Id, SourceRef[]>;
  memoryCount: number;
  analysisOutput: BackgroundAnalysisOutput;
  estimatedInputTokens: number;
  createdAt: string;
}

export interface BackgroundCitation {
  sourceRefId: Id;
  memoryDataId: Id;
  layer: "stm";
}

export interface CreateSessionBackgroundRequest {
  sessionId: string;
  tenantId: Id;
  principalId: Id;
  createdAt: string;
  referenceTime?: string;
  timezone?: string;
  locale?: string;
  fixedBackgroundId?: Id;
  dynamicWindowStart?: string;
  dynamicWindowEnd?: string;
  tokenBudget?: number;
  maxInputTokens?: number;
  maxDynamicCandidates?: number;
  latestStmCursor?: BackgroundStmCursor;
  forceRefresh?: boolean;
}

export interface BackgroundDynamicCacheRecord {
  cacheKey: string;
  tenantId: Id;
  principalId: Id;
  fixedBackgroundId: Id;
  fixedRevision: number;
  latestStmCursor: BackgroundStmCursor;
  referenceTime: string;
  timezone: string;
  locale: string;
  localDate: string;
  windowStart: string;
  windowEnd: string;
  dynamicText: string;
  sourceMemoryIds: Id[];
  sourceRefIds: Id[];
  citations: BackgroundCitation[];
  conflictIds: Id[];
  processedMemoryCount: number;
  pendingStmCount: number;
  deferredMemoryCount: number;
  deferredRanges: BackgroundStmRange[];
  watermarkLagSeconds: number;
  executionStrategy: "single_request" | "hierarchical_batch";
  status: "ready" | "degraded";
  degradedModeReason?: string;
  generatedAt: string;
  expiresAt: string;
}

export interface SessionBackgroundSnapshot {
  snapshotId: Id;
  sessionId: string;
  tenantId: Id;
  principalId: Id;
  backgroundId: Id;
  fixedRevision: number;
  fixedText: string;
  dynamicText: string;
  dynamicWindowStart: string;
  dynamicWindowEnd: string;
  referenceTime: string;
  timezone: string;
  locale: string;
  localDate: string;
  fixedSourceRefIds: Id[];
  dynamicSourceRefIds: Id[];
  sourceMemoryIds: Id[];
  citations: BackgroundCitation[];
  conflictIds: Id[];
  latestStmCursor: BackgroundStmCursor;
  dynamicCacheKey: string;
  cacheHit: boolean;
  executionStrategy: "single_request" | "hierarchical_batch";
  processedMemoryCount: number;
  pendingStmCount: number;
  deferredMemoryCount: number;
  watermarkLagSeconds: number;
  generatedAt: string;
  status: "ready" | "stale" | "degraded";
  degradedModeReason?: string;
  serializedPrompt: string;
  createdAt: string;
}

export interface MainAgentBackgroundHandoff {
  sessionId: string;
  background: {
    fixedText: string;
    dynamicText: string;
    fixedRevision: number;
    dynamicWindowStart: string;
    dynamicWindowEnd: string;
    referenceTime: string;
    timezone: string;
    locale: string;
    localDate: string;
  };
  citations: BackgroundCitation[];
  conflicts: Array<{
    conflictId: Id;
    description?: string;
  }>;
  status: SessionBackgroundSnapshot["status"];
  serializedPrompt: string;
}
