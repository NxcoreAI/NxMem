import { createHash, randomUUID } from "node:crypto";
import {
  CONVERSATION_INGESTION_ERRORS,
  CONVERSATION_INGESTION_LIMITS,
  CONVERSATION_VISIBILITIES,
  createConversationIngestionToolError,
  type ConversationCallerScope,
  type ConversationDocumentSession,
  type ConversationIngestionToolError,
  type GetConversationIngestionStatusResponse,
  type IngestConversationDocumentInput,
  type IngestConversationDocumentResponse
} from "./domain.js";
import {
  ConversationDocumentParseError,
  parseConversationMarkdownDocument
} from "./markdown-stream-parser.js";
import {
  ConversationRepositoryError,
  type ConversationBatchIngestionRecord,
  type ConversationIngestionRecord,
  type ConversationIngestionRepository
} from "./persistence.js";
import { validateDirectConversationDocumentSize } from "./markdown-protocol.js";
import {
  conversationSessionTemporalMode,
  normalizeConversationSessionMessages
} from "./message-normalization.js";
import { classifyConversationProtocolIssues } from "../temporal-observability.js";

const INGEST_TOOL = "ingest_conversation_batch_document" as const;

export class ConversationIngestionServiceError extends Error {
  constructor(readonly toolError: ConversationIngestionToolError) {
    super(toolError.message);
    this.name = "ConversationIngestionServiceError";
  }
}

export interface ConversationIngestionService {
  ingest(
    input: IngestConversationDocumentInput,
    caller: ConversationCallerScope
  ): Promise<IngestConversationDocumentResponse>;
  getStatus(
    ingestionId: string,
    caller: ConversationCallerScope
  ): Promise<GetConversationIngestionStatusResponse>;
}

export function createConversationIngestionService(
  repository: ConversationIngestionRepository
): ConversationIngestionService {
  return {
    async ingest(input, caller) {
      validateIngestInput(input);
      const sizeIssue = validateDirectConversationDocumentSize(input.document)[0];
      if (sizeIssue) {
        throw serviceError(INGEST_TOOL, sizeIssue.code, {
          limitBytes: CONVERSATION_INGESTION_LIMITS.directDocumentBytes,
          actualBytes: Buffer.byteLength(input.document, "utf8")
        }, sizeIssue.message);
      }

      const documentHash = sha256(input.document);
      if (documentHash !== input.documentSha256) {
        throw serviceError(INGEST_TOOL, "DOCUMENT_HASH_MISMATCH", {
          expectedSha256: input.documentSha256,
          actualSha256: documentHash
        });
      }

      let parsed: ReturnType<typeof parseConversationMarkdownDocument>;
      try {
        parsed = parseConversationMarkdownDocument(input.document);
      } catch (caught) {
        if (!(caught instanceof ConversationDocumentParseError)) throw caught;
        const firstIssue = caught.issues[0];
        throw serviceError(
          INGEST_TOOL,
          firstIssue?.code ?? "INVALID_SESSION_BLOCK",
          {
            issues: caught.issues,
            temporalErrorCodes: classifyConversationProtocolIssues(caught.issues)
          },
          firstIssue?.message
        );
      }
      assertCallerScope(parsed.sessions, caller);

      const now = new Date().toISOString();
      const batchIngestionId = `cbing_${randomUUID()}`;
      const documentId = `cdoc_${randomUUID()}`;
      const batch: ConversationBatchIngestionRecord = {
        batchIngestionId,
        idempotencyKey: input.idempotencyKey,
        documentSha256: documentHash,
        batchId: parsed.frontMatter.batch_id,
        sourceApp: caller.sourceApp,
        tenantId: caller.tenantId,
        principalId: caller.principalId,
        documentStatus: "raw_committed",
        processingStatus: "queued",
        createdAt: now,
        committedAt: now,
        updatedAt: now
      };

      try {
        const committed = await repository.commitConversationBatchIngestion({
          batch,
          document: {
            documentId,
            batchIngestionId,
            schemaVersion: parsed.frontMatter.schema_version,
            sha256: documentHash,
            byteSize: Buffer.byteLength(input.document, "utf8"),
            rawMarkdown: input.document,
            createdAt: now
          },
          sessions: parsed.sessions.map((session) => buildSessionCommit(
            session,
            batch,
            caller,
            input,
            documentId,
            now
          ))
        });
        return batchResponse(committed.batch, committed.ingestions, committed.deduplicated);
      } catch (caught) {
        if (caught instanceof ConversationRepositoryError) {
          throw serviceError(INGEST_TOOL, caught.code, caught.details, caught.message);
        }
        throw serviceError(INGEST_TOOL, "CONTEXT_ENGINE_UNAVAILABLE", undefined,
          caught instanceof Error ? caught.message : undefined);
      }
    },

    async getStatus(ingestionId, caller) {
      if (!ingestionId.trim()) {
        throw serviceError("get_conversation_ingestion_status", "INVALID_TOOL_ARGUMENT", {
          field: "ingestionId"
        });
      }
      const ingestion = await repository.getConversationIngestion(ingestionId);
      if (!ingestion) {
        throw serviceError("get_conversation_ingestion_status", "INGESTION_NOT_FOUND", { ingestionId });
      }
      if (
        ingestion.tenantId !== caller.tenantId ||
        ingestion.principalId !== caller.principalId ||
        ingestion.sourceApp !== caller.sourceApp
      ) {
        throw serviceError("get_conversation_ingestion_status", "PERMISSION_SCOPE_MISMATCH");
      }
      return {
        ingestionId: ingestion.ingestionId,
        processingStatus: ingestion.processingStatus,
        stage: ingestion.processingStage,
        retryable: ingestion.retry.retryable,
        lastError: ingestion.lastError ?? null,
        counts: {
          facts: ingestion.layerCounts.facts,
          stm: ingestion.layerCounts.shortTermMemories,
          indexed: ingestion.processingStage === "completed" ? ingestion.layerCounts.facts : 0
        },
        retryCount: ingestion.retry.attempt
      };
    }
  };
}

function buildSessionCommit(
  session: ConversationDocumentSession,
  batch: ConversationBatchIngestionRecord,
  caller: ConversationCallerScope,
  input: IngestConversationDocumentInput,
  documentId: string,
  now: string
) {
  const ingestionId = `cing_${randomUUID()}`;
  const messageCount = session.messages.length;
  const temporalMode = conversationSessionTemporalMode(session);
  const ingestion: ConversationIngestionRecord = {
    ingestionId,
    batchIngestionId: batch.batchIngestionId,
    idempotencyKey: `${input.idempotencyKey}:${session.sessionId}`,
    documentSha256: batch.documentSha256,
    batchId: batch.batchId,
    sessionId: session.sessionId,
    sourceApp: caller.sourceApp,
    tenantId: caller.tenantId,
    principalId: caller.principalId,
    visibility: session.visibility ?? "private",
    ...(session.timezone ? { timezone: session.timezone } : {}),
    ...(session.locale ? { locale: session.locale } : {}),
    temporalMode,
    ...(session.previousCursor ? { previousCursor: session.previousCursor } : {}),
    committedCursor: session.cursor,
    firstSequence: 1,
    lastSequence: messageCount,
    documentStatus: "raw_committed",
    processingStatus: "queued",
    processingStage: "not_started",
    processingMode: "async",
    progressPercent: 0,
    messageCounts: {
      received: messageCount,
      inserted: 0,
      deduplicated: 0,
      revised: 0,
      deleted: 0
    },
    layerCounts: { ...emptyLayerCounts(), messages: messageCount },
    retry: { attempt: 0, maxAttempts: 3, retryable: true },
    createdAt: now,
    committedAt: now,
    updatedAt: now
  };
  const messages = normalizeConversationSessionMessages({
    session,
    ingestionId,
    documentId,
    documentSha256: batch.documentSha256,
    batchId: batch.batchId,
    sourceApp: caller.sourceApp,
    tenantId: caller.tenantId,
    principalId: caller.principalId,
    committedAt: now,
    storedAt: now
  });
  return {
    ingestion,
    messages,
    cursor: {
      tenantId: caller.tenantId,
      sourceApp: caller.sourceApp,
      principalId: caller.principalId,
      sessionId: session.sessionId,
      committedCursor: session.cursor,
      lastSequence: messageCount,
      lastIngestionId: ingestionId,
      updatedAt: now
    },
    job: {
      jobId: `cjob_${randomUUID()}`,
      ingestionId,
      status: "queued" as const,
      stage: "not_started" as const,
      attempt: 0,
      maxAttempts: 3,
      retryable: true,
      createdAt: now,
      updatedAt: now
    }
  };
}

function validateIngestInput(input: IngestConversationDocumentInput) {
  const unknownField = Object.keys(input).find((field) =>
    !["document", "idempotencyKey", "documentSha256", "processingMode"].includes(field)
  );
  const invalidField = unknownField
    ?? (typeof input.document !== "string" || !input.document ? "document" : undefined)
    ?? (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() ? "idempotencyKey" : undefined)
    ?? (typeof input.documentSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(input.documentSha256)
      ? "documentSha256" : undefined)
    ?? (input.processingMode !== "async" ? "processingMode" : undefined);
  if (invalidField) {
    throw serviceError(INGEST_TOOL, "INVALID_TOOL_ARGUMENT", { field: invalidField });
  }
}

function assertCallerScope(sessions: readonly ConversationDocumentSession[], caller: ConversationCallerScope) {
  for (const session of sessions) {
    const visibility = session.visibility ?? "private";
    if (!caller.allowedVisibilities.includes(visibility)) {
      throw serviceError(INGEST_TOOL, "PERMISSION_SCOPE_MISMATCH", {
        field: "visibility",
        sessionId: session.sessionId
      });
    }
  }
}

function batchResponse(
  batch: ConversationBatchIngestionRecord,
  ingestions: readonly ConversationIngestionRecord[],
  deduplicated: boolean
): IngestConversationDocumentResponse {
  return {
    batchIngestionId: batch.batchIngestionId,
    batchId: batch.batchId,
    documentStatus: "raw_committed",
    processingStatus: "queued",
    deduplicated,
    sessions: ingestions.map((ingestion) => ({
      ingestionId: ingestion.ingestionId,
      sessionId: ingestion.sessionId,
      cursorCommitted: ingestion.committedCursor,
      processingStatus: ingestion.processingStatus
    }))
  };
}

function emptyLayerCounts() {
  return {
    messages: 0,
    segments: 0,
    evidenceGroups: 0,
    factCandidates: 0,
    facts: 0,
    shortTermMemories: 0,
    timelineFacts: 0,
    longTermMemories: 0,
    factPending: 0,
    rejected: 0,
    sensitivePendingConfirmation: 0
  };
}

function serviceError(
  tool: ConversationIngestionToolError["tool"],
  code: keyof typeof CONVERSATION_INGESTION_ERRORS,
  details?: Record<string, unknown>,
  message?: string
) {
  return new ConversationIngestionServiceError(createConversationIngestionToolError(tool, code, {
    ...(message ? { message } : {}),
    ...(details ? { details } : {})
  }));
}

export function parseConversationCallerScope(input: {
  tenantId?: unknown;
  principalId?: unknown;
  sourceApp?: unknown;
  allowedVisibilities?: unknown;
}, tool: ConversationIngestionToolError["tool"] = INGEST_TOOL): ConversationCallerScope {
  const tenantId = typeof input.tenantId === "string" ? input.tenantId.trim() : "";
  const principalId = typeof input.principalId === "string" ? input.principalId.trim() : "";
  const sourceApp = typeof input.sourceApp === "string" ? input.sourceApp.trim() : "";
  const allowedVisibilities: ConversationCallerScope["allowedVisibilities"] = Array.isArray(input.allowedVisibilities)
    ? input.allowedVisibilities.filter((item): item is typeof CONVERSATION_VISIBILITIES[number] =>
        typeof item === "string" && CONVERSATION_VISIBILITIES.includes(item as typeof CONVERSATION_VISIBILITIES[number])
      )
    : ["private"] as const;
  if (!tenantId || !principalId || !sourceApp || allowedVisibilities.length === 0) {
    throw serviceError(tool, "PERMISSION_SCOPE_MISMATCH", {
      reason: "authenticated caller scope is required"
    });
  }
  return { tenantId, principalId, sourceApp, allowedVisibilities };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
