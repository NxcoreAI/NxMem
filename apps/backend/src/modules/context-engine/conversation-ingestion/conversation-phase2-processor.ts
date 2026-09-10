import type { ContextEngineRepository } from "../persistence/repository.js";
import { groupConversationEvidence } from "./evidence-grouping.js";
import { segmentConversationMessages } from "./conversation-segmentation.js";
import type {
  ConversationIngestionJobRecord,
  ConversationIngestionProcessingUpdate,
  ConversationIngestionRecord
} from "./persistence.js";

export interface ConversationPhase2ProcessingResult {
  ingestionId: string;
  segmentIds: string[];
  groupIds: string[];
  windowIds: string[];
  processingStatus: "fact_pending";
}

export async function processConversationIngestionPhase2(
  repository: ContextEngineRepository,
  ingestionId: string,
  options: {
    now?: string;
    maxChunkChars?: number;
    maxWindowTokens?: number;
  } = {}
): Promise<ConversationPhase2ProcessingResult> {
  const ingestion = await repository.getConversationIngestion(ingestionId);
  if (!ingestion) throw new Error(`conversation_ingestion_not_found:${ingestionId}`);
  if (ingestion.processingMode !== "async") {
    throw new Error(`conversation_ingestion_not_async:${ingestionId}`);
  }
  const now = options.now ?? new Date().toISOString();
  const messages = await repository.getConversationMessages(ingestionId);
  const job = await repository.getConversationIngestionJob(ingestionId);
  const counts = { ...ingestion.layerCounts, messages: messages.length };

  await updateProcessing(repository, ingestion, {
    processingStatus: "parsing_messages",
    processingStage: "message_parsing",
    progressPercent: 20,
    layerCounts: counts,
    retry: retryState(ingestion, job),
    updatedAt: now
  });

  const segmentation = segmentConversationMessages(ingestion, messages, {
    now,
    ...(options.maxChunkChars !== undefined ? { maxChunkChars: options.maxChunkChars } : {})
  });
  await repository.saveMemoryEvent(segmentation.event);
  for (const segment of segmentation.segments) {
    await repository.saveParsedSegment(segment);
  }
  await repository.saveConversationMessageSegments(segmentation.messageSegments);
  counts.segments = segmentation.segments.length;

  await updateProcessing(repository, ingestion, {
    processingStatus: "grouping_evidence",
    processingStage: "evidence_grouping",
    progressPercent: 45,
    layerCounts: counts,
    retry: retryState(ingestion, job),
    updatedAt: now
  });

  const scope = {
    tenantId: ingestion.tenantId,
    sourceApp: ingestion.sourceApp,
    principalId: ingestion.principalId,
    sessionId: ingestion.sessionId
  };
  const existingGroups = await repository.getConversationEvidenceGroups(scope, { latestOnly: true });
  const allSegments = repository.getDebugSnapshot().parsedSegments;
  const grouping = groupConversationEvidence(
    ingestion,
    messages,
    segmentation.messageSegments,
    allSegments,
    existingGroups,
    {
      now,
      ...(options.maxWindowTokens !== undefined ? { maxWindowTokens: options.maxWindowTokens } : {})
    }
  );
  for (const group of grouping.groups) {
    await repository.saveConversationEvidenceGroup(group);
  }
  await repository.saveConversationExtractionWindows(grouping.windows);
  counts.evidenceGroups = grouping.groups.length;
  counts.factPending = grouping.groups.filter((group) => group.status === "sealed" || group.status === "reopened").length;

  const lastError = {
    code: "FACT_EXTRACTION_UNAVAILABLE" as const,
    message: "Conversation evidence is ready and waiting for Phase 3 fact extraction.",
    occurredAt: now
  };
  await repository.updateConversationIngestionProcessing(ingestionId, {
    processingStatus: "fact_pending",
    processingStage: "fact_extraction",
    progressPercent: 60,
    layerCounts: counts,
    retry: retryState(ingestion, job, true),
    lastError,
    updatedAt: now
  });

  if (job) {
    await repository.saveConversationIngestionJob({
      ...job,
      status: "fact_pending",
      stage: "fact_extraction",
      retryable: true,
      lastError,
      updatedAt: now
    });
  }

  return {
    ingestionId,
    segmentIds: segmentation.segments.map((segment) => segment.segmentId),
    groupIds: grouping.groups.map((group) => group.groupId),
    windowIds: grouping.windows.map((window) => window.windowId),
    processingStatus: "fact_pending"
  };
}

function retryState(
  ingestion: ConversationIngestionRecord,
  job: ConversationIngestionJobRecord | undefined,
  retryable = ingestion.retry.retryable
) {
  return {
    attempt: job?.attempt ?? ingestion.retry.attempt,
    maxAttempts: job?.maxAttempts ?? ingestion.retry.maxAttempts,
    retryable
  };
}

async function updateProcessing(
  repository: ContextEngineRepository,
  ingestion: ConversationIngestionRecord,
  update: ConversationIngestionProcessingUpdate
) {
  await repository.updateConversationIngestionProcessing(ingestion.ingestionId, update);
}
