import type {
  ConversationDocumentFrontMatter,
  ConversationDocumentStatus,
  ConversationIngestionErrorCode,
  ConversationIngestionLastError,
  ConversationIngestionLayerCounts,
  ConversationIngestionRetryState,
  ConversationMessage,
  ConversationMessageCounts,
  ConversationProcessingMode,
  ConversationProcessingStage,
  ConversationProcessingStatus,
  ConversationTemporalMode,
  ConversationTimeConfidence,
  ConversationVisibility
} from "./domain.js";
import type { TemporalErrorCode } from "../domain.js";
import type {
  ConversationTemporalConfidence,
  ConversationValidTimeBasis
} from "./conversation-fact-temporal.js";

export interface ConversationIngestionRecord {
  ingestionId: string;
  batchIngestionId?: string;
  idempotencyKey: string;
  documentSha256: string;
  batchId: string;
  sessionId: string;
  sourceApp: string;
  tenantId: string;
  principalId: string;
  visibility: ConversationVisibility;
  timezone?: string;
  locale?: string;
  temporalMode: ConversationTemporalMode;
  previousCursor?: string;
  committedCursor: string;
  firstSequence: number;
  lastSequence: number;
  documentStatus: ConversationDocumentStatus;
  processingStatus: ConversationProcessingStatus;
  processingStage: ConversationProcessingStage;
  processingMode: ConversationProcessingMode;
  progressPercent: number;
  messageCounts: ConversationMessageCounts;
  layerCounts: ConversationIngestionLayerCounts;
  retry: ConversationIngestionRetryState;
  lastError?: ConversationIngestionLastError;
  createdAt: string;
  committedAt: string;
  updatedAt: string;
}

export interface ConversationDocumentRecord {
  documentId: string;
  batchIngestionId?: string;
  ingestionId?: string;
  schemaVersion: string;
  sha256: string;
  byteSize: number;
  rawMarkdown: string;
  createdAt: string;
}

export interface ConversationBatchIngestionRecord {
  batchIngestionId: string;
  idempotencyKey: string;
  documentSha256: string;
  batchId: string;
  sourceApp: string;
  tenantId: string;
  principalId: string;
  documentStatus: "raw_committed";
  processingStatus: "queued";
  createdAt: string;
  committedAt: string;
  updatedAt: string;
}

export interface ConversationMessageRecord extends ConversationMessage {
  conversationMessageRowId: string;
  ingestionId: string;
  documentId: string;
  sessionId: string;
  batchId: string;
  sourceApp: string;
  tenantId: string;
  principalId: string;
  branchId: string;
  revision: number;
  operation: NonNullable<ConversationMessage["operation"]>;
  contentSha256: string;
  completedAt?: string;
  timezone?: string;
  locale?: string;
  timeConfidence: ConversationTimeConfidence;
  storedAt: string;
  /** @deprecated Use storedAt. Kept for legacy repository callers during migration. */
  createdAtStored?: string;
}

export interface ConversationSessionCursorRecord {
  tenantId: string;
  sourceApp: string;
  principalId: string;
  sessionId: string;
  committedCursor: string;
  lastSequence: number;
  lastIngestionId: string;
  updatedAt: string;
}

export interface ConversationIngestionJobRecord {
  jobId: string;
  ingestionId: string;
  status: "queued" | "running" | "fact_pending" | "succeeded" | "failed";
  stage: ConversationProcessingStage;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  retryAfter?: string;
  claimedBy?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  lastError?: ConversationIngestionLastError;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageSegmentRecord {
  segmentId: string;
  ingestionId: string;
  conversationMessageRowId: string;
  messageId: string;
  sequence: number;
  role: ConversationMessage["role"];
  branchId: string;
  chunkIndex: number;
  chunkCount: number;
  startOffset: number;
  endOffset: number;
  createdAt: string;
}

export const CONVERSATION_EVIDENCE_GROUP_STATUSES = [
  "open",
  "sealed",
  "reopened",
  "processed",
  "failed"
] as const;

export type ConversationEvidenceGroupStatus = typeof CONVERSATION_EVIDENCE_GROUP_STATUSES[number];

export interface ConversationEvidenceGroupMemberRecord {
  ingestionId: string;
  conversationMessageRowId: string;
  messageId: string;
  segmentId: string;
  sequence: number;
  role: ConversationMessage["role"];
  branchId: string;
  toolCallId?: string;
  memberOrder: number;
}

export interface ConversationEvidenceGroupRecord {
  groupId: string;
  tenantId: string;
  sourceApp: string;
  principalId: string;
  sessionId: string;
  branchId: string;
  version: number;
  status: ConversationEvidenceGroupStatus;
  boundaryReason: string;
  firstSequence: number;
  lastSequence: number;
  tokenCount: number;
  members: ConversationEvidenceGroupMemberRecord[];
  createdAt: string;
  updatedAt: string;
  sealedAt?: string;
}

export interface ConversationExtractionWindowRecord {
  windowId: string;
  groupId: string;
  groupVersion: number;
  windowIndex: number;
  tokenCount: number;
  messageIds: string[];
  segmentIds: string[];
  createdAt: string;
}

export const CONVERSATION_FACT_EPISTEMIC_STATUSES = [
  "user_asserted",
  "user_confirmed",
  "tool_observed",
  "agent_inferred",
  "externally_verified"
] as const;

export const CONVERSATION_FACT_MEMORY_ELIGIBILITIES = [
  "eligible",
  "evidence_only",
  "pending_verification",
  "rejected"
] as const;

export const CONVERSATION_FACT_VALIDATION_STATUSES = [
  "validated",
  "evidence_only",
  "pending_verification",
  "rejected",
  "invalid"
] as const;

export type ConversationFactEpistemicStatus = typeof CONVERSATION_FACT_EPISTEMIC_STATUSES[number];
export type ConversationFactMemoryEligibility = typeof CONVERSATION_FACT_MEMORY_ELIGIBILITIES[number];
export type ConversationFactValidationStatus = typeof CONVERSATION_FACT_VALIDATION_STATUSES[number];

export interface ConversationFactCandidateRecord {
  candidateId: string;
  ingestionId: string;
  groupId: string;
  groupVersion: number;
  windowId: string;
  candidateIndex: number;
  factType: string;
  factText: string;
  normalizedClaim: string;
  subject?: string;
  epistemicStatus: ConversationFactEpistemicStatus;
  confidenceLevel: "low" | "medium" | "high";
  memoryEligibility: ConversationFactMemoryEligibility;
  linkedSegmentIds: string[];
  sourceMessageIds: string[];
  evidenceQuotes: string[];
  entityIds: string[];
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeBasis?: ConversationValidTimeBasis;
  validTimeConfidence?: ConversationTemporalConfidence;
  validationStatus: ConversationFactValidationStatus;
  validationReason: string;
  rawCandidate: unknown;
  persistedFactId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationIngestionProcessingUpdate {
  processingStatus: ConversationProcessingStatus;
  processingStage: ConversationProcessingStage;
  progressPercent: number;
  layerCounts: ConversationIngestionLayerCounts;
  retry: ConversationIngestionRetryState;
  lastError?: ConversationIngestionLastError;
  updatedAt: string;
}

export interface CommitConversationIngestionRequest {
  ingestion: ConversationIngestionRecord;
  document: ConversationDocumentRecord;
  messages: ConversationMessageRecord[];
  cursor: ConversationSessionCursorRecord;
  job?: ConversationIngestionJobRecord;
}

export interface CommitConversationBatchIngestionRequest {
  batch: ConversationBatchIngestionRecord;
  document: ConversationDocumentRecord;
  sessions: Array<{
    ingestion: ConversationIngestionRecord;
    messages: ConversationMessageRecord[];
    cursor: ConversationSessionCursorRecord;
    job: ConversationIngestionJobRecord;
  }>;
}

export interface CommitConversationBatchIngestionResult {
  batch: ConversationBatchIngestionRecord;
  ingestions: ConversationIngestionRecord[];
  deduplicated: boolean;
}

export interface CommitConversationIngestionResult {
  ingestion: ConversationIngestionRecord;
  messageCounts: ConversationMessageCounts;
  deduplicated: boolean;
}

export interface ConversationTemporalBackfillCounts {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  retried: number;
  messagesRestored: number;
  factsUpdated: number;
  shortTermMemoriesUpdated: number;
  longTermMemoriesUpdated: number;
  indexesRefreshed: number;
}

export interface ConversationTemporalBackfillError {
  ingestionId: string;
  sessionId?: string;
  documentId?: string;
  code: TemporalErrorCode;
  message: string;
}

export interface ConversationTemporalBackfillMigrationRecord {
  version: string;
  status: "running" | "completed" | "failed";
  attempt: number;
  counts: ConversationTemporalBackfillCounts;
  errors: ConversationTemporalBackfillError[];
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
  durationMs?: number;
}

export interface BackfillConversationMessagesRequest {
  ingestionId: string;
  documentId: string;
  temporalMode: ConversationTemporalMode;
  timezone?: string;
  locale?: string;
  messages: ConversationMessageRecord[];
  updatedAt: string;
}

export interface BackfillConversationMessagesResult {
  inserted: number;
  updated: number;
  skipped: number;
}

export interface ConversationIngestionRepository {
  commitConversationBatchIngestion(
    request: CommitConversationBatchIngestionRequest
  ): Promise<CommitConversationBatchIngestionResult>;
  getConversationBatchIngestion(batchIngestionId: string): Promise<ConversationBatchIngestionRecord | undefined>;
  commitConversationIngestion(request: CommitConversationIngestionRequest): Promise<CommitConversationIngestionResult>;
  getConversationIngestion(ingestionId: string): Promise<ConversationIngestionRecord | undefined>;
  listConversationIngestions(): Promise<ConversationIngestionRecord[]>;
  getConversationDocument(ingestionId: string): Promise<ConversationDocumentRecord | undefined>;
  getConversationMessages(ingestionId: string): Promise<ConversationMessageRecord[]>;
  getConversationMessagesByRowIds(conversationMessageRowIds: string[]): Promise<ConversationMessageRecord[]>;
  backfillConversationMessages(
    request: BackfillConversationMessagesRequest
  ): Promise<BackfillConversationMessagesResult>;
  getConversationTemporalBackfillMigration(
    version: string
  ): Promise<ConversationTemporalBackfillMigrationRecord | undefined>;
  saveConversationTemporalBackfillMigration(
    record: ConversationTemporalBackfillMigrationRecord
  ): Promise<void>;
  getConversationSessionCursor(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }): Promise<ConversationSessionCursorRecord | undefined>;
  updateConversationIngestionProcessing(
    ingestionId: string,
    update: ConversationIngestionProcessingUpdate
  ): Promise<void>;
  getConversationIngestionJob(ingestionId: string): Promise<ConversationIngestionJobRecord | undefined>;
  claimNextConversationIngestionJob(
    workerId: string,
    claimedAt: string,
    options?: { includeFactPending?: boolean }
  ): Promise<ConversationIngestionJobRecord | undefined>;
  saveConversationIngestionJob(job: ConversationIngestionJobRecord): Promise<void>;
  saveConversationMessageSegments(records: ConversationMessageSegmentRecord[]): Promise<void>;
  getConversationMessageSegments(ingestionId: string): Promise<ConversationMessageSegmentRecord[]>;
  saveConversationEvidenceGroup(group: ConversationEvidenceGroupRecord): Promise<void>;
  getConversationEvidenceGroups(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }, options?: { latestOnly?: boolean }): Promise<ConversationEvidenceGroupRecord[]>;
  saveConversationExtractionWindows(windows: ConversationExtractionWindowRecord[]): Promise<void>;
  getConversationExtractionWindows(groupId: string, groupVersion?: number): Promise<ConversationExtractionWindowRecord[]>;
  saveConversationFactCandidates(records: ConversationFactCandidateRecord[]): Promise<void>;
  getConversationFactCandidates(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }): Promise<ConversationFactCandidateRecord[]>;
}

export class ConversationRepositoryError extends Error {
  constructor(
    readonly code: ConversationIngestionErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ConversationRepositoryError";
  }
}
