export const CONTEXT_CONVERSATION_SCHEMA_VERSION = "context-conversation-md.v3" as const;

export const CONVERSATION_ROLES = ["user", "assistant", "tool", "system"] as const;
export const CONVERSATION_MESSAGE_STATUSES = ["completed", "interrupted", "failed"] as const;
export const CONVERSATION_CONTENT_TYPES = ["text/plain", "text/markdown", "application/json"] as const;
export const CONVERSATION_MESSAGE_OPERATIONS = ["append", "replace", "delete"] as const;
export const CONVERSATION_VISIBILITIES = ["private", "team", "tenant", "public"] as const;
export const CONVERSATION_PROCESSING_MODES = ["async"] as const;
export const CONVERSATION_TEMPORAL_MODES = ["legacy", "extended"] as const;
export const CONVERSATION_TIME_CONFIDENCES = ["low", "high"] as const;

export const CONVERSATION_DOCUMENT_STATUSES = [
  "received",
  "validating",
  "raw_committed",
  "rejected",
  "quarantined"
] as const;

export const CONVERSATION_PROCESSING_STATUSES = [
  "not_scheduled",
  "queued",
  "parsing_messages",
  "grouping_evidence",
  "extracting_facts",
  "validating_facts",
  "fusing_timeline",
  "admitting_stm",
  "consolidating_ltm",
  "indexing",
  "processing_succeeded",
  "fact_pending",
  "retry_scheduled",
  "processing_failed"
] as const;

export const CONVERSATION_PROCESSING_STAGES = [
  "not_started",
  "message_parsing",
  "evidence_grouping",
  "fact_extraction",
  "fact_validation",
  "timeline_fusion",
  "stm_admission",
  "ltm_consolidation",
  "indexing",
  "completed"
] as const;

export const CONVERSATION_INGESTION_LIMITS = {
  directDocumentBytes: 128 * 1024,
  directMessageCount: 200,
  directSessionCount: 20
} as const;

export type ConversationRole = typeof CONVERSATION_ROLES[number];
export type ConversationMessageStatus = typeof CONVERSATION_MESSAGE_STATUSES[number];
export type ConversationContentType = typeof CONVERSATION_CONTENT_TYPES[number];
export type ConversationMessageOperation = typeof CONVERSATION_MESSAGE_OPERATIONS[number];
export type ConversationVisibility = typeof CONVERSATION_VISIBILITIES[number];
export type ConversationProcessingMode = typeof CONVERSATION_PROCESSING_MODES[number];
export type ConversationTemporalMode = typeof CONVERSATION_TEMPORAL_MODES[number];
export type ConversationTimeConfidence = typeof CONVERSATION_TIME_CONFIDENCES[number];
export type ConversationDocumentStatus = typeof CONVERSATION_DOCUMENT_STATUSES[number];
export type ConversationProcessingStatus = typeof CONVERSATION_PROCESSING_STATUSES[number];
export type ConversationProcessingStage = typeof CONVERSATION_PROCESSING_STAGES[number];

export interface ConversationDocumentFrontMatter {
  schema_version: typeof CONTEXT_CONVERSATION_SCHEMA_VERSION;
  batch_id: string;
}

export interface ConversationDocumentMessage {
  role: ConversationRole;
  content: string;
  messageId?: string;
  createdAt?: string;
  completedAt?: string;
}

export interface ConversationDocumentSession {
  sessionId: string;
  previousCursor?: string;
  cursor: string;
  visibility?: Exclude<ConversationVisibility, "private">;
  timezone?: string;
  locale?: string;
  messages: ConversationDocumentMessage[];
}

export interface ConversationMessage {
  messageId: string;
  sequence: number;
  role: ConversationRole;
  createdAt: string;
  status: ConversationMessageStatus;
  contentType: ConversationContentType;
  content: string;
  replyToMessageId?: string;
  parentMessageId?: string;
  branchId?: string;
  toolCallId?: string;
  toolName?: string;
  revision?: number;
  operation?: ConversationMessageOperation;
  metadata?: Record<string, unknown>;
}

export interface IngestConversationDocumentInput {
  document: string;
  idempotencyKey: string;
  documentSha256: string;
  processingMode?: ConversationProcessingMode;
}

export interface ConversationMessageCounts {
  received: number;
  inserted: number;
  deduplicated: number;
  revised: number;
  deleted: number;
}

export interface IngestConversationDocumentSessionResponse {
  ingestionId: string;
  sessionId: string;
  cursorCommitted: string;
  processingStatus: ConversationProcessingStatus;
}

export interface IngestConversationDocumentResponse {
  batchIngestionId: string;
  batchId: string;
  documentStatus: "raw_committed";
  processingStatus: "queued";
  deduplicated: boolean;
  sessions: IngestConversationDocumentSessionResponse[];
}

export interface GetConversationIngestionStatusInput {
  ingestionId: string;
}

export interface ConversationIngestionLayerCounts {
  messages: number;
  segments: number;
  evidenceGroups: number;
  factCandidates: number;
  facts: number;
  shortTermMemories: number;
  timelineFacts: number;
  longTermMemories: number;
  factPending: number;
  rejected: number;
  sensitivePendingConfirmation: number;
}

export interface ConversationIngestionRetryState {
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  retryAfter?: string;
}

export interface ConversationIngestionLastError {
  code: ConversationIngestionErrorCode;
  message: string;
  occurredAt: string;
}

export interface GetConversationIngestionStatusResponse {
  ingestionId: string;
  processingStatus: ConversationProcessingStatus;
  stage: ConversationProcessingStage;
  retryable: boolean;
  lastError: ConversationIngestionLastError | null;
  counts: {
    facts: number;
    stm: number;
    indexed: number;
  };
  retryCount: number;
}

export interface ConversationCallerScope {
  tenantId: string;
  principalId: string;
  sourceApp: string;
  allowedVisibilities: readonly ConversationVisibility[];
}

export const CONVERSATION_INGESTION_ERROR_CODES = [
  "INVALID_TOOL_ARGUMENT",
  "INGESTION_NOT_FOUND",
  "IDEMPOTENCY_KEY_CONFLICT",
  "BATCH_ID_CONFLICT",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_HASH_MISMATCH",
  "UNSUPPORTED_SCHEMA_VERSION",
  "INVALID_FRONT_MATTER",
  "INVALID_SESSION_BLOCK",
  "INVALID_MESSAGE_BLOCK",
  "MESSAGE_COUNT_MISMATCH",
  "MESSAGE_CONTENT_CONFLICT",
  "CURSOR_MISMATCH",
  "SEQUENCE_GAP",
  "PERMISSION_SCOPE_MISMATCH",
  "UPLOAD_PART_MISSING",
  "FACT_EXTRACTION_UNAVAILABLE",
  "FACT_OUTPUT_INVALID",
  "CONTEXT_ENGINE_UNAVAILABLE"
] as const;

export type ConversationIngestionErrorCode = typeof CONVERSATION_INGESTION_ERROR_CODES[number];

export const CONVERSATION_INGESTION_RECOVERY_ACTIONS = [
  "fix_tool_arguments",
  "check_ingestion_id",
  "use_new_idempotency_key",
  "reconcile_batch_submission",
  "use_chunked_upload",
  "resubmit_exact_document",
  "upgrade_schema",
  "fix_document",
  "submit_new_revision",
  "reconcile_cursor",
  "fill_sequence_gap",
  "request_authorized_scope",
  "upload_missing_parts",
  "wait_for_server_retry",
  "inspect_or_retry_processing"
] as const;

export type ConversationIngestionRecoveryAction = typeof CONVERSATION_INGESTION_RECOVERY_ACTIONS[number];

export interface ConversationIngestionErrorDefinition {
  message: string;
  retryable: boolean;
  recoveryAction: ConversationIngestionRecoveryAction;
}

export interface ConversationIngestionToolError {
  tool: "ingest_conversation_batch_document" | "get_conversation_ingestion_status";
  code: ConversationIngestionErrorCode;
  message: string;
  retryable: boolean;
  recoveryAction: ConversationIngestionRecoveryAction;
  details?: Record<string, unknown>;
}

export const CONVERSATION_INGESTION_ERRORS: Readonly<
  Record<ConversationIngestionErrorCode, ConversationIngestionErrorDefinition>
> = {
  INVALID_TOOL_ARGUMENT: {
    message: "The conversation ingestion Tool arguments are invalid.",
    retryable: false,
    recoveryAction: "fix_tool_arguments"
  },
  INGESTION_NOT_FOUND: {
    message: "The conversation ingestion was not found.",
    retryable: false,
    recoveryAction: "check_ingestion_id"
  },
  IDEMPOTENCY_KEY_CONFLICT: {
    message: "The idempotency key is already associated with different document content.",
    retryable: false,
    recoveryAction: "use_new_idempotency_key"
  },
  BATCH_ID_CONFLICT: {
    message: "The batch ID is already associated with another ingestion.",
    retryable: false,
    recoveryAction: "reconcile_batch_submission"
  },
  DOCUMENT_TOO_LARGE: {
    message: "The conversation document exceeds the direct ingestion limit.",
    retryable: false,
    recoveryAction: "use_chunked_upload"
  },
  DOCUMENT_HASH_MISMATCH: {
    message: "The document SHA-256 does not match the exact UTF-8 document bytes.",
    retryable: false,
    recoveryAction: "resubmit_exact_document"
  },
  UNSUPPORTED_SCHEMA_VERSION: {
    message: "The conversation document schema version is not supported.",
    retryable: false,
    recoveryAction: "upgrade_schema"
  },
  INVALID_FRONT_MATTER: {
    message: "The conversation document Front Matter is invalid.",
    retryable: false,
    recoveryAction: "fix_document"
  },
  INVALID_SESSION_BLOCK: {
    message: "A context-session block is malformed or violates the V3 session contract.",
    retryable: false,
    recoveryAction: "fix_document"
  },
  INVALID_MESSAGE_BLOCK: {
    message: "A message inside a context-session block contains invalid fields.",
    retryable: false,
    recoveryAction: "fix_document"
  },
  MESSAGE_COUNT_MISMATCH: {
    message: "The declared message_count does not match the context-message block count.",
    retryable: false,
    recoveryAction: "fix_document"
  },
  MESSAGE_CONTENT_CONFLICT: {
    message: "The same message ID and revision already exist with different content.",
    retryable: false,
    recoveryAction: "submit_new_revision"
  },
  CURSOR_MISMATCH: {
    message: "A Session previousCursor does not match the committed server cursor.",
    retryable: false,
    recoveryAction: "reconcile_cursor"
  },
  SEQUENCE_GAP: {
    message: "The document message sequence has a gap.",
    retryable: true,
    recoveryAction: "fill_sequence_gap"
  },
  PERMISSION_SCOPE_MISMATCH: {
    message: "The document permission scope exceeds the authenticated caller scope.",
    retryable: false,
    recoveryAction: "request_authorized_scope"
  },
  UPLOAD_PART_MISSING: {
    message: "One or more upload parts are missing.",
    retryable: true,
    recoveryAction: "upload_missing_parts"
  },
  FACT_EXTRACTION_UNAVAILABLE: {
    message: "Fact extraction is temporarily unavailable.",
    retryable: true,
    recoveryAction: "wait_for_server_retry"
  },
  FACT_OUTPUT_INVALID: {
    message: "Fact extraction output failed deterministic validation.",
    retryable: true,
    recoveryAction: "inspect_or_retry_processing"
  },
  CONTEXT_ENGINE_UNAVAILABLE: {
    message: "The Context Engine is temporarily unavailable.",
    retryable: true,
    recoveryAction: "wait_for_server_retry"
  }
};

const DOCUMENT_STATUS_TRANSITIONS: Readonly<Record<ConversationDocumentStatus, readonly ConversationDocumentStatus[]>> = {
  received: ["validating"],
  validating: ["raw_committed", "rejected", "quarantined"],
  raw_committed: ["quarantined"],
  rejected: [],
  quarantined: []
};

const ACTIVE_PROCESSING_STATUSES = [
  "parsing_messages",
  "grouping_evidence",
  "extracting_facts",
  "validating_facts",
  "fusing_timeline",
  "admitting_stm",
  "consolidating_ltm",
  "indexing"
] as const satisfies readonly ConversationProcessingStatus[];

const PROCESSING_STATUS_TRANSITIONS: Readonly<Record<ConversationProcessingStatus, readonly ConversationProcessingStatus[]>> = {
  not_scheduled: ["queued"],
  queued: ["parsing_messages", "extracting_facts", "fact_pending", "retry_scheduled", "processing_failed"],
  parsing_messages: ["grouping_evidence", "fact_pending", "retry_scheduled", "processing_failed"],
  grouping_evidence: ["extracting_facts", "fact_pending", "retry_scheduled", "processing_failed"],
  extracting_facts: ["validating_facts", "fact_pending", "retry_scheduled", "processing_failed"],
  validating_facts: ["fusing_timeline", "admitting_stm", "fact_pending", "retry_scheduled", "processing_failed"],
  fusing_timeline: ["admitting_stm", "fact_pending", "retry_scheduled", "processing_failed"],
  admitting_stm: ["consolidating_ltm", "indexing", "fact_pending", "retry_scheduled", "processing_failed"],
  consolidating_ltm: ["indexing", "fact_pending", "retry_scheduled", "processing_failed"],
  indexing: ["processing_succeeded", "fact_pending", "retry_scheduled", "processing_failed"],
  processing_succeeded: [],
  fact_pending: ["extracting_facts", "retry_scheduled", "processing_failed"],
  retry_scheduled: [...ACTIVE_PROCESSING_STATUSES, "fact_pending", "processing_failed"],
  processing_failed: []
};

export function isConversationDocumentStatusTransitionAllowed(
  from: ConversationDocumentStatus,
  to: ConversationDocumentStatus
) {
  return DOCUMENT_STATUS_TRANSITIONS[from].includes(to);
}

export function isConversationProcessingStatusTransitionAllowed(
  from: ConversationProcessingStatus,
  to: ConversationProcessingStatus
) {
  return PROCESSING_STATUS_TRANSITIONS[from].includes(to);
}

export function createConversationIngestionToolError(
  tool: ConversationIngestionToolError["tool"],
  code: ConversationIngestionErrorCode,
  options: { message?: string; details?: Record<string, unknown> } = {}
): ConversationIngestionToolError {
  const definition = CONVERSATION_INGESTION_ERRORS[code];
  return {
    tool,
    code,
    message: options.message ?? definition.message,
    retryable: definition.retryable,
    recoveryAction: definition.recoveryAction,
    ...(options.details ? { details: options.details } : {})
  };
}
