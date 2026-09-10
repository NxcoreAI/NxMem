import {
  CONVERSATION_INGESTION_ERROR_CODES,
  CONVERSATION_INGESTION_RECOVERY_ACTIONS,
  CONVERSATION_PROCESSING_STAGES,
  CONVERSATION_PROCESSING_STATUSES
} from "./domain.js";

const countSchema = { type: "integer", minimum: 0 } as const;

export const ingestConversationDocumentInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    document: {
      type: "string",
      description: "Exact UTF-8 Markdown conforming to context-conversation-md.v3."
    },
    idempotencyKey: { type: "string", minLength: 1 },
    documentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    processingMode: { const: "async" }
  },
  required: ["document", "idempotencyKey", "documentSha256", "processingMode"]
} as const;

const sessionCommitSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ingestionId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    cursorCommitted: { type: "string", minLength: 1 },
    processingStatus: { enum: CONVERSATION_PROCESSING_STATUSES }
  },
  required: ["ingestionId", "sessionId", "cursorCommitted", "processingStatus"]
} as const;

export const ingestConversationDocumentResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    batchIngestionId: { type: "string", minLength: 1 },
    batchId: { type: "string", minLength: 1 },
    documentStatus: { const: "raw_committed" },
    processingStatus: { const: "queued" },
    deduplicated: { type: "boolean" },
    sessions: { type: "array", minItems: 1, maxItems: 20, items: sessionCommitSchema }
  },
  required: [
    "batchIngestionId",
    "batchId",
    "documentStatus",
    "processingStatus",
    "deduplicated",
    "sessions"
  ]
} as const;

export const getConversationIngestionStatusInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { ingestionId: { type: "string", minLength: 1 } },
  required: ["ingestionId"]
} as const;

export const getConversationIngestionStatusResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ingestionId: { type: "string", minLength: 1 },
    processingStatus: { enum: CONVERSATION_PROCESSING_STATUSES },
    stage: { enum: CONVERSATION_PROCESSING_STAGES },
    retryable: { type: "boolean" },
    lastError: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            code: { enum: CONVERSATION_INGESTION_ERROR_CODES },
            message: { type: "string", minLength: 1 },
            occurredAt: { type: "string", format: "date-time" }
          },
          required: ["code", "message", "occurredAt"]
        }
      ]
    },
    counts: {
      type: "object",
      additionalProperties: false,
      properties: { facts: countSchema, stm: countSchema, indexed: countSchema },
      required: ["facts", "stm", "indexed"]
    },
    retryCount: countSchema
  },
  required: ["ingestionId", "processingStatus", "stage", "retryable", "lastError", "counts", "retryCount"]
} as const;

export const conversationIngestionToolErrorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: { enum: ["ingest_conversation_batch_document", "get_conversation_ingestion_status"] },
    code: { enum: CONVERSATION_INGESTION_ERROR_CODES },
    message: { type: "string", minLength: 1 },
    retryable: { type: "boolean" },
    recoveryAction: { enum: CONVERSATION_INGESTION_RECOVERY_ACTIONS },
    details: { type: "object", additionalProperties: true }
  },
  required: ["tool", "code", "message", "retryable", "recoveryAction"]
} as const;

export const conversationIngestionToolContracts = [
  {
    name: "ingest_conversation_batch_document",
    endpoint: "POST /context/tools/ingest-conversation-batch-document",
    description: "Atomically commit one V3 Markdown batch and queue isolated processing for each Session.",
    inputSchema: ingestConversationDocumentInputSchema,
    successSchema: ingestConversationDocumentResponseSchema,
    errorSchema: conversationIngestionToolErrorSchema
  },
  {
    name: "get_conversation_ingestion_status",
    endpoint: "POST /context/tools/get-conversation-ingestion-status",
    description: "Get processing status for one Session ingestion from a committed batch.",
    inputSchema: getConversationIngestionStatusInputSchema,
    successSchema: getConversationIngestionStatusResponseSchema,
    errorSchema: conversationIngestionToolErrorSchema
  }
] as const;
