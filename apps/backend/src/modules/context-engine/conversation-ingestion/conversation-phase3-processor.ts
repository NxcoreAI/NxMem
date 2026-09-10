import type { FactItem, LlmFactFusionTrace, MemoryEvent } from "../domain.js";
import { classifyTemporalValidationReason, uniqueTemporalErrorCodes } from "../temporal-observability.js";
import type { LlmFactFusionOptions } from "../llm-fact-fusion.js";
import type { EmbeddingClient } from "../embedding.js";
import { runLlmDreaming } from "../llm-dreaming.js";
import { admitFactsToMemoryPipeline } from "../parse-event.js";
import type { ContextEngineRepository } from "../persistence/repository.js";
import {
  buildTimelineAggregatedFactsWithLlm,
  materializeTimelineAggregatedFacts
} from "../timeline-aggregation.js";
import { createFactBatchCommitted } from "../fact-batch.js";
import { enqueueFactBatchForTimelineFusion } from "../timeline-fusion-scheduler.js";
import {
  ConversationDocumentFactExtractionError,
  extractConversationDocumentFactCandidates
} from "./conversation-document-fact-extraction.js";
import {
  conversationDocumentSourceRef,
  mapConversationDocumentFacts,
  validateConversationDocumentFactCandidates,
  type ConversationDocumentFactCandidate
} from "./conversation-document-fact-processing.js";
import {
  hasConversationFactExtractionLlm,
  type ConversationFactExtractionOptions
} from "./conversation-fact-extraction.js";
import type { ConversationIngestionErrorCode } from "./domain.js";
import type {
  ConversationDocumentRecord,
  ConversationIngestionJobRecord,
  ConversationIngestionRecord,
  ConversationMessageRecord
} from "./persistence.js";
import {
  conversationEvidenceTimeRange,
  lowestConversationTimeConfidence
} from "./conversation-fact-temporal.js";

export interface ConversationPhase3ProcessingResult {
  ingestionId: string;
  candidateIds: string[];
  factIds: string[];
  admittedShortTermMemoryCount: number;
  longTermMemoryCount: number;
  processingStatus: "processing_succeeded" | "fact_pending";
}

export interface ConversationPhase3ProcessingOptions extends ConversationFactExtractionOptions {
  now?: string;
  disableStmAdmissionLlm?: boolean;
  disableLtmConsolidationLlm?: boolean;
  pendingRetryDelayMs?: number;
  embeddingClient?: EmbeddingClient;
}

export async function processConversationIngestionPhase3(
  repository: ContextEngineRepository,
  ingestionId: string,
  options: ConversationPhase3ProcessingOptions = {}
): Promise<ConversationPhase3ProcessingResult> {
  const ingestion = await repository.getConversationIngestion(ingestionId);
  if (!ingestion) throw new Error(`conversation_ingestion_not_found:${ingestionId}`);
  if (ingestion.processingMode !== "async") throw new Error(`conversation_ingestion_not_async:${ingestionId}`);
  const document = await repository.getConversationDocument(ingestionId);
  if (!document) throw new Error(`conversation_document_not_found:${ingestionId}`);
  const messages = await repository.getConversationMessages(ingestionId);
  if (!messages.length) throw new Error(`conversation_messages_not_found:${ingestionId}`);
  const now = options.now ?? new Date().toISOString();
  const job = await repository.getConversationIngestionJob(ingestionId);
  const counts = { ...ingestion.layerCounts };
  const event = buildDocumentEvent(ingestion, document, messages);
  await repository.saveMemoryEvent(event);

  await updateProcessing(repository, ingestion, job, counts, {
    processingStatus: "extracting_facts",
    processingStage: "fact_extraction",
    progressPercent: 25,
    updatedAt: now
  });

  if (!hasConversationFactExtractionLlm(options)) {
    return markFactPending(
      repository,
      ingestion,
      job,
      counts,
      [],
      "FACT_EXTRACTION_UNAVAILABLE",
      "The raw document is committed, but no fact extraction LLM is configured.",
      now,
      options.pendingRetryDelayMs
    );
  }

  let extraction: Awaited<ReturnType<typeof extractConversationDocumentFactCandidates>>;
  try {
    extraction = await extractConversationDocumentFactCandidates(ingestion, document, messages, options);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Conversation document extraction failed.";
    const extractionError = caught instanceof ConversationDocumentFactExtractionError ? caught : undefined;
    const code = extractionError?.code ?? (message.startsWith("FACT_OUTPUT_INVALID")
      ? "FACT_OUTPUT_INVALID" as const
      : "FACT_EXTRACTION_UNAVAILABLE" as const);
    if (extractionError) {
      await saveDocumentExtractionFailureTrace(
        repository,
        ingestion,
        document,
        messages,
        extractionError,
        job?.attempt ?? ingestion.retry.attempt,
        now
      );
    }
    return markFactPending(
      repository,
      ingestion,
      job,
      counts,
      [],
      code,
      message,
      now,
      options.pendingRetryDelayMs
    );
  }

  const candidates = validateConversationDocumentFactCandidates(ingestion, messages, extraction.rawCandidates);
  counts.factCandidates = candidates.length;
  counts.rejected = candidates.filter((candidate) =>
    candidate.validationStatus === "rejected" || candidate.validationStatus === "invalid"
  ).length;
  counts.sensitivePendingConfirmation = candidates.filter((candidate) =>
    candidate.validationStatus === "pending_verification"
  ).length;

  await updateProcessing(repository, ingestion, job, counts, {
    processingStatus: "validating_facts",
    processingStage: "fact_validation",
    progressPercent: 45,
    updatedAt: now
  });
  if (candidates.some((candidate) => candidate.validationStatus === "invalid")) {
    await saveDocumentExtractionTrace(
      repository,
      ingestion,
      document,
      messages,
      extraction,
      [],
      candidates,
      job?.attempt ?? ingestion.retry.attempt,
      now
    );
    return markFactPending(
      repository,
      ingestion,
      job,
      counts,
      candidates,
      "FACT_OUTPUT_INVALID",
      "One or more candidates failed document-level schema or quote validation.",
      now,
      options.pendingRetryDelayMs
    );
  }

  const mapping = mapConversationDocumentFacts({
    ingestion,
    document,
    eventId: event.eventId,
    candidates,
    existingFacts: repository.getDebugSnapshot().facts,
    messages,
    now
  });
  for (const fact of mapping.factsToSave) await repository.saveFactItem(fact);
  if (mapping.activeFacts.length) {
    const batch = await repository.saveFactBatchCommitted(createFactBatchCommitted({
      triggerType: "conversation_session",
      sourceKey: ingestion.ingestionId,
      tenantId: ingestion.tenantId,
      principalId: ingestion.principalId,
      factIds: mapping.activeFacts.map((fact) => fact.factId),
      committedAt: now
    }));
    await enqueueFactBatchForTimelineFusion(repository, batch);
  }
  counts.facts = mapping.factsToSave.length;
  counts.factPending = mapping.candidates.filter((candidate) =>
    candidate.validationStatus === "pending_verification"
  ).length;

  await updateProcessing(repository, ingestion, job, counts, {
    processingStatus: "fusing_timeline",
    processingStage: "timeline_fusion",
    progressPercent: 60,
    updatedAt: now
  });
  const timelineFacts = await fuseTimelineFacts(repository, mapping.activeFacts, now, options);
  counts.timelineFacts = timelineFacts.length;
  await saveDocumentExtractionTrace(
    repository,
    ingestion,
    document,
    messages,
    extraction,
    timelineFacts,
    mapping.candidates,
    job?.attempt ?? ingestion.retry.attempt,
    now
  );

  await updateProcessing(repository, ingestion, job, counts, {
    processingStatus: "admitting_stm",
    processingStage: "stm_admission",
    progressPercent: 72,
    updatedAt: now
  });
  let admittedShortTermMemoryCount = 0;
  if (timelineFacts.length) {
    const llm = downstreamLlmOptions(options);
    const admission = await admitFactsToMemoryPipeline(repository, event, timelineFacts, {
      ...(llm ? { llm } : {}),
      ...(options.disableStmAdmissionLlm !== undefined
        ? { disableStmAdmissionLlm: options.disableStmAdmissionLlm }
        : {}),
      ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
      fallbackSourceRefs: [conversationDocumentSourceRef(document.documentId)]
    });
    admittedShortTermMemoryCount = admission.admittedCount;
  }
  counts.shortTermMemories = admittedShortTermMemoryCount;

  await updateProcessing(repository, ingestion, job, counts, {
    processingStatus: "consolidating_ltm",
    processingStage: "ltm_consolidation",
    progressPercent: 86,
    updatedAt: now
  });
  const timelineFactIds = new Set(timelineFacts.map((fact) => fact.factId));
  const memoryDataIds = repository.getDebugSnapshot().shortTermMemories
    .filter((memory) => memory.sourceFactIds.some((factId) => timelineFactIds.has(factId)))
    .map((memory) => memory.memoryDataId);
  let longTermMemoryCount = 0;
  if (memoryDataIds.length) {
    const llm = downstreamLlmOptions(options) ?? {};
    const dreaming = await runLlmDreaming(repository, {
      ...llm,
      ...(options.disableLtmConsolidationLlm ? { apiKey: "" } : {}),
      ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
      memoryDataIds
    });
    longTermMemoryCount = dreaming.longTermMemories.length;
  }
  counts.longTermMemories = longTermMemoryCount;

  await updateProcessing(repository, ingestion, job, counts, {
    processingStatus: "indexing",
    processingStage: "indexing",
    progressPercent: 95,
    updatedAt: now
  });
  await repository.updateConversationIngestionProcessing(ingestionId, {
    processingStatus: "processing_succeeded",
    processingStage: "completed",
    progressPercent: 100,
    layerCounts: counts,
    retry: {
      attempt: job?.attempt ?? ingestion.retry.attempt,
      maxAttempts: job?.maxAttempts ?? ingestion.retry.maxAttempts,
      retryable: false
    },
    updatedAt: now
  });
  if (job) {
    const { lastError: _lastError, retryAfter: _retryAfter, ...jobWithoutPendingState } = job;
    await repository.saveConversationIngestionJob({
      ...jobWithoutPendingState,
      status: "succeeded",
      stage: "completed",
      retryable: false,
      completedAt: now,
      updatedAt: now
    });
  }
  return {
    ingestionId,
    candidateIds: mapping.candidates.map((candidate) => candidate.candidateId),
    factIds: timelineFacts.map((fact) => fact.factId),
    admittedShortTermMemoryCount,
    longTermMemoryCount,
    processingStatus: "processing_succeeded"
  };
}

async function fuseTimelineFacts(
  repository: ContextEngineRepository,
  facts: readonly FactItem[],
  now: string,
  options: ConversationPhase3ProcessingOptions
) {
  const aggregated = await buildTimelineAggregatedFactsWithLlm([...facts], options);
  const materialized = materializeTimelineAggregatedFacts(facts, aggregated, now);
  const originalFactIds = new Set(facts.map((fact) => fact.factId));
  for (const fact of materialized) {
    if (!originalFactIds.has(fact.factId)) await repository.saveFactItem(fact);
  }
  return materialized;
}

async function saveDocumentExtractionTrace(
  repository: ContextEngineRepository,
  ingestion: ConversationIngestionRecord,
  document: ConversationDocumentRecord,
  messages: readonly ConversationMessageRecord[],
  extraction: Awaited<ReturnType<typeof extractConversationDocumentFactCandidates>>,
  facts: FactItem[],
  candidates: readonly ConversationDocumentFactCandidate[],
  attempt: number,
  now: string
) {
  const invalid = candidates.filter((candidate) => candidate.validationStatus === "invalid");
  const temporalErrorCodes = uniqueTemporalErrorCodes(candidates.flatMap((candidate) => {
    const code = classifyTemporalValidationReason(candidate.validationReason);
    return code ? [code] : [];
  }));
  const candidateSourceIds = new Set(candidates.flatMap((candidate) => candidate.sourceMessageIds));
  const trace: LlmFactFusionTrace = {
    traceId: documentExtractionTraceId(ingestion.ingestionId, attempt),
    eventId: documentEventId(ingestion.ingestionId),
    provider: "openai-compatible",
    endpoint: extraction.endpoint,
    model: extraction.model,
    keySource: extraction.keySource,
    promptVersion: "conversation-document-fact-extraction.v6",
    schemaVersion: "conversation-document-fact-candidates.v3",
    prompt: `${extraction.promptTemplate} documentId=${document.documentId} sha256=${document.sha256}`,
    alignedEvidence: [],
    rawResponse: extraction.rawResponse,
    parsedFacts: facts,
    rejectedSegments: [],
    ...(invalid.length
      ? { fallbackReason: `document_candidate_validation_failed:${invalid[0]!.validationReason}` }
      : {}),
    temporal: {
      operation: "fact_extraction",
      ingestionId: ingestion.ingestionId,
      sessionId: ingestion.sessionId,
      documentId: document.documentId,
      temporalMode: ingestion.temporalMode,
      ...(ingestion.timezone ? { timezone: ingestion.timezone } : {}),
      ...(ingestion.locale ? { locale: ingestion.locale } : {}),
      ...(facts[0]?.validTimeBasis ? { timeBasis: facts[0].validTimeBasis } : {}),
      sourceMessageRowIds: [...new Set([
        ...facts.flatMap((fact) => fact.linkedSourceRefs.flatMap((ref) =>
          ref.sourceType === "conversation_message" ? [ref.sourceId] : []
        )),
        ...messages.flatMap((message) => candidateSourceIds.has(message.messageId)
          ? [message.conversationMessageRowId]
          : [])
      ])],
      errorCodes: temporalErrorCodes
    },
    createdAt: now
  };
  await repository.saveLlmFactFusionTrace(trace);
}

async function saveDocumentExtractionFailureTrace(
  repository: ContextEngineRepository,
  ingestion: ConversationIngestionRecord,
  document: ConversationDocumentRecord,
  messages: readonly ConversationMessageRecord[],
  error: ConversationDocumentFactExtractionError,
  attempt: number,
  now: string
) {
  await repository.saveLlmFactFusionTrace({
    traceId: documentExtractionTraceId(ingestion.ingestionId, attempt),
    eventId: documentEventId(ingestion.ingestionId),
    provider: "openai-compatible",
    endpoint: error.endpoint,
    model: error.model,
    keySource: error.keySource,
    promptVersion: "conversation-document-fact-extraction.v6",
    schemaVersion: "conversation-document-fact-candidates.v3",
    prompt: `${error.promptTemplate} documentId=${document.documentId} sha256=${document.sha256}`,
    alignedEvidence: [],
    ...(error.rawResponse === undefined ? {} : { rawResponse: error.rawResponse }),
    parsedFacts: [],
    rejectedSegments: [],
    fallbackReason: `document_extraction_failed:${error.message}`,
    temporal: {
      operation: "fact_extraction",
      ingestionId: ingestion.ingestionId,
      sessionId: ingestion.sessionId,
      documentId: document.documentId,
      temporalMode: ingestion.temporalMode,
      ...(ingestion.timezone ? { timezone: ingestion.timezone } : {}),
      ...(ingestion.locale ? { locale: ingestion.locale } : {}),
      sourceMessageRowIds: messages.map((message) => message.conversationMessageRowId),
      errorCodes: []
    },
    createdAt: now
  });
}

async function markFactPending(
  repository: ContextEngineRepository,
  ingestion: ConversationIngestionRecord,
  job: ConversationIngestionJobRecord | undefined,
  counts: ConversationIngestionRecord["layerCounts"],
  candidates: readonly ConversationDocumentFactCandidate[],
  code: ConversationIngestionErrorCode,
  message: string,
  now: string,
  pendingRetryDelayMs = 60_000
): Promise<ConversationPhase3ProcessingResult> {
  counts.factCandidates = candidates.length;
  counts.facts = 0;
  counts.timelineFacts = 0;
  counts.shortTermMemories = 0;
  counts.longTermMemories = 0;
  counts.factPending = Math.max(1, candidates.filter((candidate) =>
    candidate.validationStatus === "pending_verification" || candidate.validationStatus === "invalid"
  ).length);
  counts.rejected = candidates.filter((candidate) =>
    candidate.validationStatus === "rejected" || candidate.validationStatus === "invalid"
  ).length;
  counts.sensitivePendingConfirmation = candidates.filter((candidate) =>
    candidate.validationStatus === "pending_verification"
  ).length;
  const lastError = { code, message, occurredAt: now };
  const retryAfter = new Date(Date.parse(now) + Math.max(1_000, pendingRetryDelayMs)).toISOString();
  await repository.updateConversationIngestionProcessing(ingestion.ingestionId, {
    processingStatus: "fact_pending",
    processingStage: "fact_extraction",
    progressPercent: 25,
    layerCounts: counts,
    retry: {
      attempt: job?.attempt ?? ingestion.retry.attempt,
      maxAttempts: job?.maxAttempts ?? ingestion.retry.maxAttempts,
      retryable: true,
      retryAfter
    },
    lastError,
    updatedAt: now
  });
  if (job) {
    await repository.saveConversationIngestionJob({
      ...job,
      status: "fact_pending",
      stage: "fact_extraction",
      retryable: true,
      retryAfter,
      lastError,
      updatedAt: now
    });
  }
  return {
    ingestionId: ingestion.ingestionId,
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    factIds: [],
    admittedShortTermMemoryCount: 0,
    longTermMemoryCount: 0,
    processingStatus: "fact_pending"
  };
}

function buildDocumentEvent(
  ingestion: ConversationIngestionRecord,
  document: ConversationDocumentRecord,
  messages: readonly ConversationMessageRecord[]
): MemoryEvent {
  const evidence = conversationEvidenceTimeRange(messages);
  const eventTime = evidence.evidenceTimeEnd ?? ingestion.committedAt;
  const eventTimeConfidence = ingestion.temporalMode === "legacy"
    ? "low"
    : lowestConversationTimeConfidence(messages.map((message) => message.timeConfidence));
  return {
    eventId: documentEventId(ingestion.ingestionId),
    eventType: "conversation_document_captured",
    eventSummary: `Conversation document ${ingestion.batchId} captured for session ${ingestion.sessionId}.`,
    eventTime,
    sourceApp: ingestion.sourceApp,
    sourceId: ingestion.sessionId,
    dataSource: {
      sourceApp: ingestion.sourceApp,
      sourceId: document.documentId,
      sourceName: ingestion.batchId,
      sourceType: "conversation_document",
      syncCursor: ingestion.committedCursor,
      syncVersion: document.sha256
    },
    customFields: {
      eventTimeStart: evidence.evidenceTimeStart ?? eventTime,
      eventTimeEnd: evidence.evidenceTimeEnd ?? eventTime,
      eventTimeConfidence,
      temporalMode: ingestion.temporalMode,
      ...(ingestion.timezone ? { timezone: ingestion.timezone } : {}),
      ...(ingestion.locale ? { locale: ingestion.locale } : {})
    },
    permissionSnapshot: {
      snapshotId: `conversation_document_permission_${ingestion.ingestionId}`,
      tenantId: ingestion.tenantId,
      principalId: ingestion.principalId,
      sourceAclVersion: `conversation_ingestion:${ingestion.ingestionId}`,
      visibility: ingestion.visibility
    },
    multimodalData: [],
    sourceRefs: [conversationDocumentSourceRef(document.documentId)]
  };
}

function documentEventId(ingestionId: string) {
  return `conversation_document_${ingestionId}`;
}

function documentExtractionTraceId(ingestionId: string, attempt: number) {
  return `llm_document_fusion_${ingestionId}_attempt_${Math.max(1, attempt)}`;
}

async function updateProcessing(
  repository: ContextEngineRepository,
  ingestion: ConversationIngestionRecord,
  job: ConversationIngestionJobRecord | undefined,
  counts: ConversationIngestionRecord["layerCounts"],
  update: {
    processingStatus: ConversationIngestionRecord["processingStatus"];
    processingStage: ConversationIngestionRecord["processingStage"];
    progressPercent: number;
    updatedAt: string;
  }
) {
  await repository.updateConversationIngestionProcessing(ingestion.ingestionId, {
    ...update,
    layerCounts: counts,
    retry: {
      attempt: job?.attempt ?? ingestion.retry.attempt,
      maxAttempts: job?.maxAttempts ?? ingestion.retry.maxAttempts,
      retryable: true
    }
  });
}

function downstreamLlmOptions(options: ConversationPhase3ProcessingOptions): LlmFactFusionOptions | undefined {
  const hasOverrides = options.apiKey !== undefined || options.baseUrl !== undefined || options.model !== undefined ||
    options.fetchImpl !== undefined || options.transport !== undefined || options.observer !== undefined || options.signal !== undefined;
  if (!hasOverrides) return undefined;
  return {
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.observer !== undefined ? { observer: options.observer } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  };
}
