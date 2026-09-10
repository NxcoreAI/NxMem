import { isDeepStrictEqual } from "node:util";
import type {
  FactItem,
  LongTermMemory,
  ShortTermMemory,
  SourceRef,
  StructuredMemoryFacts,
  TemporalErrorCode
} from "./domain.js";
import {
  conversationEvidenceTimeRange,
  conversationMessageSourceRef
} from "./conversation-ingestion/conversation-fact-temporal.js";
import {
  ConversationDocumentParseError,
  parseConversationMarkdownDocument
} from "./conversation-ingestion/markdown-stream-parser.js";
import {
  conversationSessionTemporalMode,
  normalizeConversationSessionMessages
} from "./conversation-ingestion/message-normalization.js";
import type {
  ConversationIngestionRecord,
  ConversationMessageRecord,
  ConversationTemporalBackfillCounts,
  ConversationTemporalBackfillMigrationRecord
} from "./conversation-ingestion/persistence.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { temporalMetadataFromFact } from "./memory-temporal.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import {
  classifyConversationProtocolIssues,
  temporalErrorMessage
} from "./temporal-observability.js";

export const CONTEXT_ENGINE_TEMPORAL_BACKFILL_VERSION = "context-engine-temporal-v1";

export interface RunTemporalBackfillOptions {
  version?: string;
  now?: () => Date;
}

interface BackfillItemResult {
  changed: boolean;
  messagesRestored: number;
  factsUpdated: number;
  shortTermMemoriesUpdated: number;
  longTermMemoriesUpdated: number;
  indexesRefreshed: number;
}

export async function runTemporalBackfill(
  repository: ContextEngineRepository,
  options: RunTemporalBackfillOptions = {}
): Promise<ConversationTemporalBackfillMigrationRecord> {
  const version = options.version ?? CONTEXT_ENGINE_TEMPORAL_BACKFILL_VERSION;
  const existing = await repository.getConversationTemporalBackfillMigration(version);
  if (existing?.status === "completed") return existing;

  const clock = options.now ?? (() => new Date());
  const started = clock();
  const counts = emptyBackfillCounts();
  counts.retried = existing?.errors.length ?? 0;
  const running: ConversationTemporalBackfillMigrationRecord = {
    version,
    status: "running",
    attempt: (existing?.attempt ?? 0) + 1,
    counts,
    errors: [],
    startedAt: started.toISOString(),
    updatedAt: started.toISOString()
  };
  await repository.saveConversationTemporalBackfillMigration(running);

  const ingestions = await repository.listConversationIngestions();
  for (const ingestion of ingestions) {
    counts.scanned += 1;
    try {
      const result = await backfillIngestion(repository, ingestion, clock().toISOString());
      if (result.changed) counts.updated += 1;
      else counts.skipped += 1;
      counts.messagesRestored += result.messagesRestored;
      counts.factsUpdated += result.factsUpdated;
      counts.shortTermMemoriesUpdated += result.shortTermMemoriesUpdated;
      counts.longTermMemoriesUpdated += result.longTermMemoriesUpdated;
      counts.indexesRefreshed += result.indexesRefreshed;
    } catch (caught) {
      counts.failed += 1;
      const document = await repository.getConversationDocument(ingestion.ingestionId);
      running.errors.push({
        ingestionId: ingestion.ingestionId,
        sessionId: ingestion.sessionId,
        ...(document ? { documentId: document.documentId } : {}),
        code: backfillErrorCode(caught),
        message: temporalErrorMessage(caught)
      });
    }
  }

  const completed = clock();
  const record: ConversationTemporalBackfillMigrationRecord = {
    ...running,
    status: counts.failed > 0 ? "failed" : "completed",
    counts: { ...counts },
    errors: [...running.errors],
    completedAt: completed.toISOString(),
    updatedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - started.getTime())
  };
  await repository.saveConversationTemporalBackfillMigration(record);
  return record;
}

async function backfillIngestion(
  repository: ContextEngineRepository,
  ingestion: ConversationIngestionRecord,
  updatedAt: string
): Promise<BackfillItemResult> {
  const document = await repository.getConversationDocument(ingestion.ingestionId);
  if (!document) throw new Error("Conversation document is unavailable for temporal backfill.");
  const parsed = parseConversationMarkdownDocument(document.rawMarkdown);
  const session = parsed.sessions.find((item) => item.sessionId === ingestion.sessionId);
  if (!session) throw new Error("Conversation session is unavailable in the committed document.");
  const temporalMode = conversationSessionTemporalMode(session);
  const normalizedMessages = normalizeConversationSessionMessages({
    session,
    ingestionId: ingestion.ingestionId,
    documentId: document.documentId,
    documentSha256: document.sha256,
    batchId: ingestion.batchId,
    sourceApp: ingestion.sourceApp,
    tenantId: ingestion.tenantId,
    principalId: ingestion.principalId,
    committedAt: ingestion.committedAt,
    storedAt: ingestion.committedAt
  });
  const messageWrite = await repository.backfillConversationMessages({
    ingestionId: ingestion.ingestionId,
    documentId: document.documentId,
    temporalMode,
    ...(session.timezone ? { timezone: session.timezone } : {}),
    ...(session.locale ? { locale: session.locale } : {}),
    messages: normalizedMessages,
    updatedAt
  });
  const messages = await repository.getConversationMessages(ingestion.ingestionId);
  const factResult = await backfillFacts(repository, ingestion, messages);
  const memoryResult = await backfillMemories(repository, factResult.factsForMemory);
  const messagesRestored = messageWrite.inserted + messageWrite.updated;
  return {
    changed: messagesRestored > 0 || factResult.updatedFacts.length > 0 || memoryResult.memoriesUpdated > 0,
    messagesRestored,
    factsUpdated: factResult.updatedFacts.length,
    shortTermMemoriesUpdated: memoryResult.shortTermMemoriesUpdated,
    longTermMemoriesUpdated: memoryResult.longTermMemoriesUpdated,
    indexesRefreshed: memoryResult.indexesRefreshed
  };
}

async function backfillFacts(
  repository: ContextEngineRepository,
  ingestion: ConversationIngestionRecord,
  messages: ConversationMessageRecord[]
) {
  const eventId = `conversation_document_${ingestion.ingestionId}`;
  const rowIds = new Set(messages.map((message) => message.conversationMessageRowId));
  const messageById = new Map(messages.map((message) => [message.messageId, message]));
  const updatedFacts: FactItem[] = [];
  const factsForMemory: FactItem[] = [];
  for (const fact of repository.getDebugSnapshot().facts) {
    const belongsToIngestion = fact.linkedEventIds.includes(eventId) || fact.linkedSourceRefs.some((ref) =>
      ref.sourceType === "conversation_message" && (
        ref.metadata?.ingestionId === ingestion.ingestionId || rowIds.has(ref.sourceId)
      )
    );
    if (!belongsToIngestion) continue;
    const sourceMessageIds = fact.sourceMessageIds?.length
      ? fact.sourceMessageIds
      : inferSourceMessageIds(fact.linkedSourceRefs, ingestion.ingestionId);
    const sourceMessages = sourceMessageIds.flatMap((messageId) => {
      const message = messageById.get(messageId);
      return message ? [message] : [];
    });
    if (!sourceMessages.length && messages.length === 1) sourceMessages.push(messages[0]!);
    if (!sourceMessages.length) continue;

    const replacementRefs = sourceMessages.map(conversationMessageSourceRef);
    const next: FactItem = {
      ...fact,
      ...conversationEvidenceTimeRange(sourceMessages),
      sourceMessageIds: [...new Set([...sourceMessageIds, ...sourceMessages.map((message) => message.messageId)])],
      linkedSourceRefs: mergeBackfilledSourceRefs(
        fact.linkedSourceRefs,
        replacementRefs,
        ingestion.ingestionId,
        rowIds
      )
    };
    factsForMemory.push(next);
    if (!isDeepStrictEqual(fact, next)) {
      await repository.saveFactItem(next);
      updatedFacts.push(next);
    }
  }
  return { updatedFacts, factsForMemory };
}

async function backfillMemories(repository: ContextEngineRepository, factsForMemory: FactItem[]) {
  if (!factsForMemory.length) {
    return {
      memoriesUpdated: 0,
      shortTermMemoriesUpdated: 0,
      longTermMemoriesUpdated: 0,
      indexesRefreshed: 0
    };
  }
  const updatedFactById = new Map(factsForMemory.map((fact) => [fact.factId, fact]));
  const affectedStmIds = new Set<string>();
  let indexesRefreshed = 0;
  for (const memory of repository.getDebugSnapshot().shortTermMemories) {
    if (!memory.sourceFactIds.some((factId) => updatedFactById.has(factId))) continue;
    const next = withBackfilledStructuredFacts(memory, updatedFactById);
    await repository.replaceShortTermMemory(next);
    const persisted = await repository.getShortTermMemory(memory.memoryDataId);
    if (persisted) {
      await refreshShortTermMemoryIndex(repository, persisted);
      indexesRefreshed += 1;
    }
    affectedStmIds.add(memory.memoryDataId);
  }

  let longTermMemoriesUpdated = 0;
  for (const memory of repository.getDebugSnapshot().longTermMemories) {
    if (!memory.sourceMemoryDataIds.some((memoryDataId) => affectedStmIds.has(memoryDataId))) continue;
    const next = withBackfilledStructuredFacts(memory, updatedFactById);
    await repository.replaceLongTermMemory(next);
    const persisted = await repository.getLongTermMemory(memory.memoryId);
    if (persisted) {
      await refreshLongTermMemoryIndex(repository, persisted);
      indexesRefreshed += 1;
    }
    longTermMemoriesUpdated += 1;
  }
  return {
    memoriesUpdated: affectedStmIds.size + longTermMemoriesUpdated,
    shortTermMemoriesUpdated: affectedStmIds.size,
    longTermMemoriesUpdated,
    indexesRefreshed
  };
}

function withBackfilledStructuredFacts<T extends ShortTermMemory | LongTermMemory>(
  memory: T,
  updatedFactById: Map<string, FactItem>
): T {
  if (!memory.structuredFacts) return { ...memory };
  const structuredFacts: StructuredMemoryFacts = {
    ...memory.structuredFacts,
    facts: memory.structuredFacts.facts.map((fact) => {
      const source = fact.factId ? updatedFactById.get(fact.factId) : undefined;
      return source ? { ...fact, ...temporalMetadataFromFact(source) } : fact;
    })
  };
  return { ...memory, structuredFacts };
}

function inferSourceMessageIds(sourceRefs: SourceRef[], ingestionId: string) {
  return sourceRefs.flatMap((ref) =>
    ref.sourceType === "conversation_message" &&
    ref.metadata?.ingestionId === ingestionId &&
    typeof ref.metadata.messageId === "string"
      ? [ref.metadata.messageId]
      : []
  );
}

function mergeBackfilledSourceRefs(
  existing: SourceRef[],
  replacement: SourceRef[],
  ingestionId: string,
  rowIds: Set<string>
) {
  const retained = existing.filter((ref) => !(
    ref.sourceType === "conversation_message" && (
      ref.metadata?.ingestionId === ingestionId || rowIds.has(ref.sourceId)
    )
  ));
  return [...new Map([...retained, ...replacement].map((ref) => [ref.sourceRefId, ref])).values()];
}

function emptyBackfillCounts(): ConversationTemporalBackfillCounts {
  return {
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    messagesRestored: 0,
    factsUpdated: 0,
    shortTermMemoriesUpdated: 0,
    longTermMemoriesUpdated: 0,
    indexesRefreshed: 0
  };
}

function backfillErrorCode(error: unknown): TemporalErrorCode {
  if (error instanceof ConversationDocumentParseError) {
    return classifyConversationProtocolIssues(error.issues)[0] ?? "TEMPORAL_BACKFILL_FAILED";
  }
  return "TEMPORAL_BACKFILL_FAILED";
}
