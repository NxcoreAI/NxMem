import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { getContextEngineConfig } from "../../../config.js";
import { INITIAL_BACKGROUND_CURSOR } from "../domain.js";
import type {
  BackgroundDynamicCacheRecord,
  BackgroundMaintenanceBatch,
  BackgroundMaintenanceTask,
  BackgroundContextDocument,
  ContextIndexEntry,
  ContextPackTrace,
  ContextPipelineTask,
  ContextTextIndexEntry,
  ContextVectorIndexEntry,
  DataLakeCustomFields,
  FactBatchCommitted,
  FactItem,
  FactVersion,
  GraphMemoryNode,
  GraphMemoryOwnerType,
  GraphMemorySearchOptions,
  GraphMemorySearchHit,
  LlmDreamingTrace,
  LlmFactFusionTrace,
  LlmStmAdmissionTrace,
  LongTermMemory,
  MemoryChangeEvent,
  MemoryEvent,
  ParsedSegment,
  RelationEdge,
  MemoryFeedbackItem,
  MemoryRetrievalEvent,
  SessionBackgroundSnapshot,
  ShortTermMemory,
  SourceRef,
  TimelineFusionExecution,
  TimelineFusionTask,
  DreamingCandidateDecision,
  DreamingOutboxRecord,
  DreamingRun,
  DreamingRunCandidate
} from "../domain.js";
import {
  memoryEventSummary,
  multimodalContentToStorage,
  normalizeMemoryEventSourceRefs,
  sourceRefsFromEvent
} from "../memory-event-fields.js";
import { normalizeFactSummary, normalizePrdMemoryType } from "../memory-types.js";
import {
  aggregateMemoryTemporalMetadata,
  memoryTemporalEnvelopeIntersects,
  normalizeMemoryTemporalMetadata,
  temporalMetadataFromFact
} from "../memory-temporal.js";
import {
  FactBatchCommitError,
  normalizeFactBatchCommitted,
  sameFactBatchCommit
} from "../fact-batch.js";
import { normalizeTimelineFusionTask } from "../timeline-fusion-task.js";
import {
  normalizeTimelineFusionExecution,
  sameTimelineFusionReservation,
  TimelineFusionExecutionError
} from "../timeline-fusion-execution.js";
import {
  filterTimelineFusionFactCandidates,
  type TimelineFusionCandidateQuery
} from "../timeline-fusion-window.js";
import {
  normalizeFactVersion,
  sameFactVersion,
  TimelineFusionFactStoreError
} from "../timeline-fusion-fact-store.js";
import { longTermRetrievalWeight, shortTermRetrievalWeight } from "../retrieval-weight.js";
import {
  adaptConversationMessageEvidence,
  adaptParsedSegmentEvidence,
  filterAndScoreEvidenceCandidates,
  isConversationDerivedSegment,
  type EvidenceSearchCandidate,
  type EvidenceSearchQuery
} from "../evidence-retrieval.js";
import type {
  ContextClearResult,
  ContextDebugSnapshot,
  ContextDeleteResult,
  ContextEngineRepository,
  CommitBackgroundMaintenanceCheckpointRequest,
  CommitFixedBackgroundMaintenanceRequest,
  BackgroundStmPage,
  BackgroundStmPageQuery,
  BackgroundStmWindowStats,
  BackgroundStmWindowStatsQuery,
  FactIndexSearchHit,
  FactIndexSearchQuery,
  MemoryOwnerBySourceHit,
  TextIndexSearchHit
} from "./repository.js";
import {
  memoryOwnerTypeForId,
  type GraphMemoryNodePage,
  type GraphMemoryNodePageQuery,
  type GraphMemoryStore,
  type GraphRelationEdgePage,
  type GraphRelationEdgePageQuery,
  type GraphRelationSearchQuery,
  type MaybePromise
} from "./graph-store.js";
import {
  ConversationRepositoryError,
  type BackfillConversationMessagesRequest,
  type BackfillConversationMessagesResult,
  type CommitConversationBatchIngestionRequest,
  type CommitConversationBatchIngestionResult,
  type CommitConversationIngestionRequest,
  type CommitConversationIngestionResult,
  type ConversationBatchIngestionRecord,
  type ConversationDocumentRecord,
  type ConversationEvidenceGroupRecord,
  type ConversationExtractionWindowRecord,
  type ConversationFactCandidateRecord,
  type ConversationIngestionJobRecord,
  type ConversationIngestionProcessingUpdate,
  type ConversationIngestionRecord,
  type ConversationMessageRecord,
  type ConversationMessageSegmentRecord,
  type ConversationSessionCursorRecord,
  type ConversationTemporalBackfillMigrationRecord
} from "../conversation-ingestion/persistence.js";

const schemaSql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const backgroundDocumentSelectColumns = `
  background_id AS backgroundId,
  tenant_id AS tenantId,
  principal_id AS principalId,
  fixed_text AS fixedText,
  dynamic_text AS dynamicText,
  fixed_revision AS fixedRevision,
  fixed_text_updated_at AS fixedTextUpdatedAt,
  fixed_watermark_json AS fixedWatermark,
  dynamic_window_start AS dynamicWindowStart,
  dynamic_window_end AS dynamicWindowEnd,
  dynamic_source_memory_ids_json AS dynamicSourceMemoryIds,
  latest_stm_cursor_json AS latestStmCursor,
  dynamic_cache_key AS dynamicCacheKey,
  source_ref_ids AS sourceRefIds,
  conflict_ids AS conflictIds,
  degraded_mode_reason AS degradedModeReason,
  update_suggestion_status AS updateSuggestionStatus,
  update_suggestion_summary AS updateSuggestionSummary,
  update_suggestion_target_sections AS updateSuggestionTargetSections,
  created_at AS createdAt,
  updated_at AS updatedAt
`;
const backgroundMaintenanceTaskSelectColumns = `
  task_id AS taskId,
  run_id AS runId,
  tenant_id AS tenantId,
  principal_id AS principalId,
  status,
  execution_strategy AS executionStrategy,
  base_background_id AS baseBackgroundId,
  base_revision AS baseRevision,
  window_start AS windowStart,
  window_end AS windowEnd,
  through_cursor_json AS throughCursor,
  checkpoint_cursor_json AS checkpointCursor,
  section_accumulator_json AS sectionAccumulator,
  scanned_page_count AS scannedPageCount,
  llm_analysis_call_count AS llmAnalysisCallCount,
  processed_memory_count AS processedMemoryCount,
  ignored_memory_count AS ignoredMemoryCount,
  deferred_ranges_json AS deferredRanges,
  deferred_memory_count AS deferredMemoryCount,
  input_token_usage AS inputTokenUsage,
  attempt,
  max_attempts AS maxAttempts,
  retryable,
  error,
  result_json AS result,
  claimed_by AS claimedBy,
  lease_expires_at AS leaseExpiresAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;
const backgroundMaintenanceTaskUpsertSql = `
  INSERT INTO background_maintenance_tasks (
    task_id, run_id, tenant_id, principal_id, status, execution_strategy,
    base_background_id, base_revision, window_start, window_end,
    through_cursor_json, checkpoint_cursor_json, section_accumulator_json,
    scanned_page_count, llm_analysis_call_count, processed_memory_count,
    ignored_memory_count, deferred_ranges_json, deferred_memory_count,
    input_token_usage, attempt, max_attempts, retryable, error, result_json,
    claimed_by, lease_expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(task_id) DO UPDATE SET
    status=excluded.status,
    execution_strategy=excluded.execution_strategy,
    base_background_id=excluded.base_background_id,
    base_revision=excluded.base_revision,
    window_start=excluded.window_start,
    window_end=excluded.window_end,
    through_cursor_json=excluded.through_cursor_json,
    checkpoint_cursor_json=excluded.checkpoint_cursor_json,
    section_accumulator_json=excluded.section_accumulator_json,
    scanned_page_count=excluded.scanned_page_count,
    llm_analysis_call_count=excluded.llm_analysis_call_count,
    processed_memory_count=excluded.processed_memory_count,
    ignored_memory_count=excluded.ignored_memory_count,
    deferred_ranges_json=excluded.deferred_ranges_json,
    deferred_memory_count=excluded.deferred_memory_count,
    input_token_usage=excluded.input_token_usage,
    attempt=excluded.attempt,
    max_attempts=excluded.max_attempts,
    retryable=excluded.retryable,
    error=excluded.error,
    result_json=excluded.result_json,
    claimed_by=excluded.claimed_by,
    lease_expires_at=excluded.lease_expires_at,
    updated_at=excluded.updated_at
`;
const backgroundDynamicCacheSelectColumns = `
  cache_key AS cacheKey,
  tenant_id AS tenantId,
  principal_id AS principalId,
  fixed_background_id AS fixedBackgroundId,
  fixed_revision AS fixedRevision,
  latest_stm_cursor_json AS latestStmCursor,
  reference_time AS referenceTime,
  timezone,
  locale,
  local_date AS localDate,
  window_start AS windowStart,
  window_end AS windowEnd,
  dynamic_text AS dynamicText,
  source_memory_ids_json AS sourceMemoryIds,
  source_ref_ids_json AS sourceRefIds,
  citations_json AS citations,
  conflict_ids_json AS conflictIds,
  processed_memory_count AS processedMemoryCount,
  pending_stm_count AS pendingStmCount,
  deferred_memory_count AS deferredMemoryCount,
  deferred_ranges_json AS deferredRanges,
  watermark_lag_seconds AS watermarkLagSeconds,
  execution_strategy AS executionStrategy,
  status,
  degraded_mode_reason AS degradedModeReason,
  generated_at AS generatedAt,
  expires_at AS expiresAt
`;
const sessionBackgroundSnapshotSelectColumns = `
  snapshot_id AS snapshotId,
  session_id AS sessionId,
  tenant_id AS tenantId,
  principal_id AS principalId,
  background_id AS backgroundId,
  fixed_revision AS fixedRevision,
  fixed_text AS fixedText,
  dynamic_text AS dynamicText,
  dynamic_window_start AS dynamicWindowStart,
  dynamic_window_end AS dynamicWindowEnd,
  reference_time AS referenceTime,
  timezone,
  locale,
  local_date AS localDate,
  fixed_source_ref_ids_json AS fixedSourceRefIds,
  dynamic_source_ref_ids_json AS dynamicSourceRefIds,
  source_memory_ids_json AS sourceMemoryIds,
  citations_json AS citations,
  conflict_ids_json AS conflictIds,
  latest_stm_cursor_json AS latestStmCursor,
  dynamic_cache_key AS dynamicCacheKey,
  cache_hit AS cacheHit,
  execution_strategy AS executionStrategy,
  processed_memory_count AS processedMemoryCount,
  pending_stm_count AS pendingStmCount,
  deferred_memory_count AS deferredMemoryCount,
  watermark_lag_seconds AS watermarkLagSeconds,
  generated_at AS generatedAt,
  status,
  degraded_mode_reason AS degradedModeReason,
  serialized_prompt AS serializedPrompt,
  created_at AS createdAt
`;

interface BackgroundMigrationRow {
  backgroundId: string;
  tenantId: string | null;
  principalId: string | null;
  fixedRevision: number | null;
  fixedTextUpdatedAt: string | null;
  fixedWatermark: unknown;
  dynamicWindowStart: string | null;
  dynamicWindowEnd: string | null;
  dynamicSourceMemoryIds: unknown;
  latestStmCursor: unknown;
  dynamicCacheKey: string | null;
  updateSuggestionTargetSections: unknown;
  createdAt: string | null;
  updatedAt: string | null;
  ownerCount: number;
  sourceTenantId: string | null;
  sourcePrincipalId: string | null;
}

interface ConversationDocumentsMigrationPreflight {
  documentCount: number;
  ingestionCount: number;
  batchIngestionCount: number;
}

export class InMemoryContextEngineRepository implements ContextEngineRepository {
  protected readonly graphStore: GraphMemoryStore | undefined;
  readonly memoryEvents: MemoryEvent[] = [];
  readonly parsedSegments: ParsedSegment[] = [];
  readonly facts: FactItem[] = [];
  readonly factVersions: FactVersion[] = [];
  readonly factBatches: FactBatchCommitted[] = [];
  readonly timelineFusionTasks: TimelineFusionTask[] = [];
  readonly timelineFusionExecutions: TimelineFusionExecution[] = [];
  readonly shortTermMemories: ShortTermMemory[] = [];
  readonly longTermMemories: LongTermMemory[] = [];
  readonly relationEdges: RelationEdge[] = [];
  readonly packTraces: ContextPackTrace[] = [];
  readonly llmFactFusionTraces: LlmFactFusionTrace[] = [];
  readonly llmStmAdmissionTraces: LlmStmAdmissionTrace[] = [];
  readonly llmDreamingTraces: LlmDreamingTrace[] = [];
  readonly pipelineTasks: ContextPipelineTask[] = [];
  readonly indexEntries: ContextIndexEntry[] = [];
  readonly textIndexEntries: ContextTextIndexEntry[] = [];
  readonly vectorIndexEntries: ContextVectorIndexEntry[] = [];
  readonly graphMemoryNodes: GraphMemoryNode[] = [];
  readonly changeEvents: MemoryChangeEvent[] = [];
  readonly feedbackItems: MemoryFeedbackItem[] = [];
  readonly retrievalEvents: MemoryRetrievalEvent[] = [];
  readonly dreamingCandidateDecisions: DreamingCandidateDecision[] = [];
  readonly dreamingOutbox: DreamingOutboxRecord[] = [];
  readonly dreamingRuns: DreamingRun[] = [];
  readonly dreamingRunCandidates: DreamingRunCandidate[] = [];
  readonly backgroundDocuments: BackgroundContextDocument[] = [];
  readonly backgroundMaintenanceTasks: BackgroundMaintenanceTask[] = [];
  readonly backgroundMaintenanceBatches: BackgroundMaintenanceBatch[] = [];
  readonly backgroundDynamicCaches: BackgroundDynamicCacheRecord[] = [];
  readonly sessionBackgroundSnapshots: SessionBackgroundSnapshot[] = [];
  readonly conversationIngestions: ConversationIngestionRecord[] = [];
  readonly conversationBatchIngestions: ConversationBatchIngestionRecord[] = [];
  readonly conversationDocuments: ConversationDocumentRecord[] = [];
  readonly conversationMessages: ConversationMessageRecord[] = [];
  readonly conversationSessionCursors: ConversationSessionCursorRecord[] = [];
  readonly conversationIngestionJobs: ConversationIngestionJobRecord[] = [];
  readonly conversationMessageSegments: ConversationMessageSegmentRecord[] = [];
  readonly conversationEvidenceGroups: ConversationEvidenceGroupRecord[] = [];
  readonly conversationExtractionWindows: ConversationExtractionWindowRecord[] = [];
  readonly conversationFactCandidates: ConversationFactCandidateRecord[] = [];
  readonly conversationDocumentMessageRows: Array<{
    documentId: string;
    ingestionId: string;
    conversationMessageRowId: string;
    messageOrder: number;
  }> = [];
  readonly conversationTemporalBackfillMigrations: ConversationTemporalBackfillMigrationRecord[] = [];

  constructor(graphStore?: GraphMemoryStore) {
    this.graphStore = graphStore;
  }

  protected get cache() {
    return this;
  }

  protected exec(_sql: string, _params: Array<unknown> = []) {}

  async commitConversationBatchIngestion(
    request: CommitConversationBatchIngestionRequest
  ): Promise<CommitConversationBatchIngestionResult> {
    const existing = this.conversationBatchIngestions.find((item) =>
      item.tenantId === request.batch.tenantId &&
      item.sourceApp === request.batch.sourceApp &&
      item.principalId === request.batch.principalId &&
      item.idempotencyKey === request.batch.idempotencyKey
    );
    if (existing) {
      if (existing.documentSha256 !== request.batch.documentSha256) {
        throw new ConversationRepositoryError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "The idempotency key is already associated with a different document hash.",
          { batchIngestionId: existing.batchIngestionId }
        );
      }
      return {
        batch: existing,
        ingestions: this.conversationIngestions.filter((item) =>
          item.batchIngestionId === existing.batchIngestionId
        ),
        deduplicated: true
      };
    }

    const existingBatch = this.conversationBatchIngestions.find((item) =>
      item.tenantId === request.batch.tenantId &&
      item.sourceApp === request.batch.sourceApp &&
      item.principalId === request.batch.principalId &&
      item.batchId === request.batch.batchId
    );
    if (existingBatch) {
      throw new ConversationRepositoryError(
        "BATCH_ID_CONFLICT",
        "The batch ID is already associated with another ingestion.",
        { batchIngestionId: existingBatch.batchIngestionId, batchId: existingBatch.batchId }
      );
    }

    for (const session of request.sessions) {
      const currentCursor = this.conversationSessionCursors.find((item) =>
        sameConversationScope(item, session.cursor)
      );
      assertConversationCursorValueMatches(currentCursor, session.ingestion);
    }

    const plannedMessages = [...this.conversationMessages];
    const sessionPlans = request.sessions.map((session) => {
      const resolvedMessages = resolveConversationMessages(plannedMessages, session.messages);
      const messageCounts = conversationMessageCounts(session.messages, resolvedMessages);
      const ingestion = withCommittedConversationMessageCounts(session.ingestion, messageCounts);
      for (const resolved of resolvedMessages) {
        if (!resolved.stored) plannedMessages.push(resolved.incoming);
      }
      return { session, ingestion, resolvedMessages };
    });

    this.conversationBatchIngestions.push(request.batch);
    this.conversationDocuments.push(request.document);
    for (const plan of sessionPlans) {
      this.conversationIngestions.push(plan.ingestion);
      plan.resolvedMessages.forEach(({ incoming, stored }, messageOrder) => {
        const persisted = stored ?? incoming;
        if (!stored) this.conversationMessages.push(incoming);
        this.conversationDocumentMessageRows.push({
          documentId: request.document.documentId,
          ingestionId: plan.ingestion.ingestionId,
          conversationMessageRowId: persisted.conversationMessageRowId,
          messageOrder
        });
      });
      replaceConversationCursor(this.conversationSessionCursors, plan.session.cursor);
      this.conversationIngestionJobs.push(plan.session.job);
    }
    return {
      batch: request.batch,
      ingestions: sessionPlans.map((item) => item.ingestion),
      deduplicated: false
    };
  }

  async getConversationBatchIngestion(batchIngestionId: string) {
    return this.conversationBatchIngestions.find((item) => item.batchIngestionId === batchIngestionId);
  }

  async commitConversationIngestion(
    request: CommitConversationIngestionRequest
  ): Promise<CommitConversationIngestionResult> {
    const existing = this.conversationIngestions.find((item) =>
      item.tenantId === request.ingestion.tenantId &&
      item.sourceApp === request.ingestion.sourceApp &&
      item.idempotencyKey === request.ingestion.idempotencyKey
    );
    if (existing) {
      if (existing.documentSha256 !== request.ingestion.documentSha256) {
        throw new ConversationRepositoryError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "The idempotency key is already associated with a different document hash.",
          { ingestionId: existing.ingestionId }
        );
      }
      return {
        ingestion: existing,
        messageCounts: {
          received: request.messages.length,
          inserted: 0,
          deduplicated: request.messages.length,
          revised: 0,
          deleted: 0
        },
        deduplicated: true
      };
    }
    const existingBatch = this.conversationIngestions.find((item) =>
      item.tenantId === request.ingestion.tenantId &&
      item.sourceApp === request.ingestion.sourceApp &&
      item.principalId === request.ingestion.principalId &&
      item.sessionId === request.ingestion.sessionId &&
      item.batchId === request.ingestion.batchId
    );
    if (existingBatch) {
      throw new ConversationRepositoryError(
        "BATCH_ID_CONFLICT",
        "The batch ID is already associated with another ingestion.",
        { ingestionId: existingBatch.ingestionId, batchId: existingBatch.batchId }
      );
    }

    const currentCursor = this.conversationSessionCursors.find((item) => sameConversationScope(item, request.cursor));
    assertConversationCursorMatches(currentCursor, request);
    const resolvedMessages = resolveConversationMessages(this.conversationMessages, request.messages);
    const messageCounts = conversationMessageCounts(request.messages, resolvedMessages);
    const ingestion = withCommittedConversationMessageCounts(request.ingestion, messageCounts);

    this.conversationIngestions.push(ingestion);
    this.conversationDocuments.push(request.document);
    resolvedMessages.forEach(({ incoming, stored }, messageOrder) => {
      const persisted = stored ?? incoming;
      if (!stored) this.conversationMessages.push(incoming);
      this.conversationDocumentMessageRows.push({
        documentId: request.document.documentId,
        ingestionId: ingestion.ingestionId,
        conversationMessageRowId: persisted.conversationMessageRowId,
        messageOrder
      });
    });
    replaceConversationCursor(this.conversationSessionCursors, request.cursor);
    if (request.job) this.conversationIngestionJobs.push(request.job);

    return { ingestion, messageCounts, deduplicated: false };
  }

  async getConversationIngestion(ingestionId: string) {
    return this.conversationIngestions.find((item) => item.ingestionId === ingestionId);
  }

  async listConversationIngestions() {
    return [...this.conversationIngestions];
  }

  async getConversationDocument(ingestionId: string) {
    const ingestion = await this.getConversationIngestion(ingestionId);
    return this.conversationDocuments.find((item) =>
      item.ingestionId === ingestionId ||
      Boolean(ingestion?.batchIngestionId && item.batchIngestionId === ingestion.batchIngestionId)
    );
  }

  async getConversationMessages(ingestionId: string) {
    const rows = this.conversationDocumentMessageRows
      .filter((item) => item.ingestionId === ingestionId)
      .sort((left, right) => left.messageOrder - right.messageOrder);
    return rows.flatMap((row) => {
      const message = this.conversationMessages.find((item) =>
        item.conversationMessageRowId === row.conversationMessageRowId
      );
      return message ? [message] : [];
    });
  }

  async getConversationMessagesByRowIds(conversationMessageRowIds: string[]) {
    const rowIds = new Set(conversationMessageRowIds);
    return this.conversationMessages
      .filter((message) => rowIds.has(message.conversationMessageRowId))
      .sort((left, right) => left.sequence - right.sequence || left.revision - right.revision);
  }

  async backfillConversationMessages(
    request: BackfillConversationMessagesRequest
  ): Promise<BackfillConversationMessagesResult> {
    const ingestionIndex = this.conversationIngestions.findIndex((item) => item.ingestionId === request.ingestionId);
    if (ingestionIndex < 0) {
      throw new ConversationRepositoryError(
        "INGESTION_NOT_FOUND",
        "The conversation ingestion was not found.",
        { ingestionId: request.ingestionId }
      );
    }
    const ingestion = this.conversationIngestions[ingestionIndex]!;
    for (const message of request.messages) {
      if (
        message.sessionId !== ingestion.sessionId ||
        message.tenantId !== ingestion.tenantId ||
        message.principalId !== ingestion.principalId ||
        message.sourceApp !== ingestion.sourceApp
      ) {
        throw new ConversationRepositoryError(
          "PERMISSION_SCOPE_MISMATCH",
          "A backfill message does not belong to the ingestion scope.",
          { ingestionId: request.ingestionId, messageId: message.messageId }
        );
      }
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const persistedMessages: ConversationMessageRecord[] = [];
    for (const incoming of request.messages) {
      const existing = this.conversationMessages.find((item) =>
        item.conversationMessageRowId === incoming.conversationMessageRowId || (
          item.tenantId === incoming.tenantId &&
          item.principalId === incoming.principalId &&
          item.sourceApp === incoming.sourceApp &&
          item.sessionId === incoming.sessionId &&
          item.sequence === incoming.sequence &&
          item.branchId === incoming.branchId &&
          item.revision === incoming.revision
        )
      );
      if (existing && existing.contentSha256 !== incoming.contentSha256) {
        throw new ConversationRepositoryError(
          "MESSAGE_CONTENT_CONFLICT",
          "The existing message sequence has different content.",
          { ingestionId: request.ingestionId, messageId: incoming.messageId, sequence: incoming.sequence }
        );
      }
      if (!existing) {
        this.conversationMessages.push(incoming);
        persistedMessages.push(incoming);
        inserted += 1;
        continue;
      }
      const restored: ConversationMessageRecord = {
        ...incoming,
        conversationMessageRowId: existing.conversationMessageRowId,
        ingestionId: existing.ingestionId,
        documentId: request.documentId,
        storedAt: existing.storedAt,
        createdAtStored: existing.storedAt
      };
      if (isDeepStrictEqual(existing, restored)) {
        persistedMessages.push(existing);
        skipped += 1;
        continue;
      }
      replaceById(this.conversationMessages, restored, "conversationMessageRowId");
      persistedMessages.push(restored);
      updated += 1;
    }

    removeWhere(this.conversationDocumentMessageRows, (item) => item.ingestionId === request.ingestionId);
    persistedMessages.forEach((message, messageOrder) => {
      this.conversationDocumentMessageRows.push({
        documentId: request.documentId,
        ingestionId: request.ingestionId,
        conversationMessageRowId: message.conversationMessageRowId,
        messageOrder
      });
    });
    const nextIngestion: ConversationIngestionRecord = {
      ...ingestion,
      temporalMode: request.temporalMode,
      ...(request.timezone ? { timezone: request.timezone } : {}),
      ...(request.locale ? { locale: request.locale } : {}),
      lastSequence: Math.max(ingestion.lastSequence, request.messages.length),
      messageCounts: {
        ...ingestion.messageCounts,
        received: request.messages.length,
        inserted: Math.max(ingestion.messageCounts.inserted, request.messages.length)
      },
      layerCounts: { ...ingestion.layerCounts, messages: request.messages.length },
      updatedAt: request.updatedAt
    };
    this.conversationIngestions[ingestionIndex] = nextIngestion;
    return { inserted, updated, skipped };
  }

  async getConversationTemporalBackfillMigration(version: string) {
    return this.conversationTemporalBackfillMigrations.find((item) => item.version === version);
  }

  async saveConversationTemporalBackfillMigration(record: ConversationTemporalBackfillMigrationRecord) {
    replaceById(this.conversationTemporalBackfillMigrations, record, "version");
    this.exec(
      `INSERT INTO context_engine_migrations (
         version, migration_type, status, attempt, counts_json, errors_json,
         started_at, completed_at, updated_at, duration_ms
       ) VALUES (?, 'temporal_backfill', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET
         migration_type=excluded.migration_type,
         status=excluded.status,
         attempt=excluded.attempt,
         counts_json=excluded.counts_json,
         errors_json=excluded.errors_json,
         started_at=excluded.started_at,
         completed_at=excluded.completed_at,
         updated_at=excluded.updated_at,
         duration_ms=excluded.duration_ms`,
      [
        record.version,
        record.status,
        record.attempt,
        JSON.stringify(record.counts),
        JSON.stringify(record.errors),
        record.startedAt,
        record.completedAt ?? null,
        record.updatedAt,
        record.durationMs ?? null
      ]
    );
  }

  async getConversationSessionCursor(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }) {
    return this.conversationSessionCursors.find((item) => sameConversationScope(item, scope));
  }

  async updateConversationIngestionProcessing(
    ingestionId: string,
    update: ConversationIngestionProcessingUpdate
  ) {
    const index = this.conversationIngestions.findIndex((item) => item.ingestionId === ingestionId);
    if (index < 0) return;
    const current = this.conversationIngestions[index] as ConversationIngestionRecord;
    const next: ConversationIngestionRecord = {
      ...current,
      processingStatus: update.processingStatus,
      processingStage: update.processingStage,
      progressPercent: update.progressPercent,
      layerCounts: update.layerCounts,
      retry: update.retry,
      updatedAt: update.updatedAt
    };
    if (update.lastError) next.lastError = update.lastError;
    else delete next.lastError;
    this.conversationIngestions[index] = next;
  }

  async getConversationIngestionJob(ingestionId: string) {
    return this.conversationIngestionJobs.find((item) => item.ingestionId === ingestionId);
  }

  async claimNextConversationIngestionJob(
    workerId: string,
    claimedAt: string,
    options: { includeFactPending?: boolean } = {}
  ) {
    const index = this.conversationIngestionJobs.findIndex((item) =>
      item.status === "queued" ||
      (options.includeFactPending === true &&
        item.status === "fact_pending" &&
        item.attempt < item.maxAttempts &&
        (!item.retryAfter || item.retryAfter <= claimedAt))
    );
    if (index < 0) return undefined;
    const current = this.conversationIngestionJobs[index] as ConversationIngestionJobRecord;
    const claimed: ConversationIngestionJobRecord = {
      ...current,
      status: "running",
      attempt: current.attempt + 1,
      claimedBy: workerId,
      claimedAt,
      heartbeatAt: claimedAt,
      updatedAt: claimedAt
    };
    this.conversationIngestionJobs[index] = claimed;
    return claimed;
  }

  async saveConversationIngestionJob(job: ConversationIngestionJobRecord) {
    replaceById(this.conversationIngestionJobs, job, "jobId");
  }

  async saveConversationMessageSegments(records: ConversationMessageSegmentRecord[]) {
    for (const record of records) {
      replaceById(this.conversationMessageSegments, record, "segmentId");
    }
  }

  async getConversationMessageSegments(ingestionId: string) {
    return this.conversationMessageSegments
      .filter((item) => item.ingestionId === ingestionId)
      .sort((left, right) => left.sequence - right.sequence || left.chunkIndex - right.chunkIndex);
  }

  async saveConversationEvidenceGroup(group: ConversationEvidenceGroupRecord) {
    const index = this.conversationEvidenceGroups.findIndex((item) =>
      item.groupId === group.groupId && item.version === group.version
    );
    if (index < 0) this.conversationEvidenceGroups.push(group);
    else this.conversationEvidenceGroups[index] = group;
  }

  async getConversationEvidenceGroups(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }, options: { latestOnly?: boolean } = {}) {
    const matches = this.conversationEvidenceGroups.filter((item) => sameConversationScope(item, scope));
    if (!options.latestOnly) {
      return matches.sort((left, right) => left.groupId.localeCompare(right.groupId) || left.version - right.version);
    }
    const latest = new Map<string, ConversationEvidenceGroupRecord>();
    for (const item of matches) {
      const current = latest.get(item.groupId);
      if (!current || item.version > current.version) latest.set(item.groupId, item);
    }
    return [...latest.values()].sort((left, right) => left.firstSequence - right.firstSequence);
  }

  async saveConversationExtractionWindows(windows: ConversationExtractionWindowRecord[]) {
    const replacedVersions = new Set(windows.map((window) => `${window.groupId}:${window.groupVersion}`));
    for (let index = this.conversationExtractionWindows.length - 1; index >= 0; index -= 1) {
      const current = this.conversationExtractionWindows[index] as ConversationExtractionWindowRecord;
      if (replacedVersions.has(`${current.groupId}:${current.groupVersion}`)) {
        this.conversationExtractionWindows.splice(index, 1);
      }
    }
    for (const window of windows) {
      replaceById(this.conversationExtractionWindows, window, "windowId");
    }
  }

  async getConversationExtractionWindows(groupId: string, groupVersion?: number) {
    return this.conversationExtractionWindows
      .filter((item) => item.groupId === groupId && (groupVersion === undefined || item.groupVersion === groupVersion))
      .sort((left, right) => left.groupVersion - right.groupVersion || left.windowIndex - right.windowIndex);
  }

  async saveConversationFactCandidates(records: ConversationFactCandidateRecord[]) {
    for (const record of records) replaceById(this.conversationFactCandidates, record, "candidateId");
  }

  async getConversationFactCandidates(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }) {
    const groupIds = new Set(this.conversationEvidenceGroups
      .filter((group) => sameConversationScope(group, scope))
      .map((group) => group.groupId));
    return this.conversationFactCandidates
      .filter((candidate) => groupIds.has(candidate.groupId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.candidateId.localeCompare(right.candidateId));
  }

  async hasMemoryEvent(eventId: string) {
    return this.cache.memoryEvents.some((event) => event.eventId === eventId);
  }

  async saveMemoryEvent(event: MemoryEvent) {
    const normalizedEvent: MemoryEvent = {
      ...normalizeMemoryEventSourceRefs(event),
      eventSummary: memoryEventSummary(event),
      sourceRefs: sourceRefsFromEvent(event)
    };
    replaceById(this.cache.memoryEvents, normalizedEvent, "eventId");
    this.exec(
      `INSERT INTO memory_events (event_id, context_scope_id, event_type, event_summary, event_description, event_time, source_app, source_id, data_source, custom_fields, tenant_id, principal_id, source_acl_version, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         context_scope_id=excluded.context_scope_id,
         event_type=excluded.event_type,
         event_summary=excluded.event_summary,
         event_description=excluded.event_description,
         event_time=excluded.event_time,
         source_app=excluded.source_app,
         source_id=excluded.source_id,
         data_source=excluded.data_source,
         custom_fields=excluded.custom_fields,
         tenant_id=excluded.tenant_id,
         principal_id=excluded.principal_id,
         source_acl_version=excluded.source_acl_version,
         visibility=excluded.visibility`,
      [
        normalizedEvent.eventId,
        normalizedEvent.contextScopeId ?? null,
        normalizedEvent.eventType,
        normalizedEvent.eventSummary ?? null,
        normalizedEvent.eventDescription ?? null,
        normalizedEvent.eventTime,
        normalizedEvent.sourceApp ?? null,
        normalizedEvent.sourceId ?? null,
        normalizedEvent.dataSource ? JSON.stringify(normalizedEvent.dataSource) : null,
        JSON.stringify(normalizedEvent.customFields ?? {}),
        normalizedEvent.permissionSnapshot.tenantId,
        normalizedEvent.permissionSnapshot.principalId,
        normalizedEvent.permissionSnapshot.sourceAclVersion,
        normalizedEvent.permissionSnapshot.visibility
      ]
    );
    this.exec(`DELETE FROM multimodal_data_items WHERE event_id = ?`, [normalizedEvent.eventId]);
    for (const item of normalizedEvent.multimodalData) {
      const storageItemId = `${normalizedEvent.eventId}:${item.itemId}`;
      this.exec(
        `INSERT INTO multimodal_data_items (item_id, event_id, source_item_id, type, format, content, ref, source_ref, source_refs, time_basis, time_confidence, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           event_id=excluded.event_id,
           source_item_id=excluded.source_item_id,
           type=excluded.type,
           format=excluded.format,
           content=excluded.content,
           ref=excluded.ref,
           source_ref=excluded.source_ref,
           source_refs=excluded.source_refs,
           time_basis=excluded.time_basis,
           time_confidence=excluded.time_confidence,
           custom_fields=excluded.custom_fields`,
        [
          storageItemId,
          normalizedEvent.eventId,
          item.itemId,
          item.type,
          item.format,
          multimodalContentToStorage(item.content),
          item.ref ?? null,
          null,
          item.sourceRefs?.length ? JSON.stringify(item.sourceRefs) : null,
          item.timeBasis ?? null,
          item.timeConfidence ?? null,
          JSON.stringify(item.customFields ?? {})
        ]
      );
    }
    this.exec(`DELETE FROM event_source_refs WHERE event_id = ?`, [normalizedEvent.eventId]);
    for (const ref of normalizedEvent.sourceRefs ?? []) {
      this.exec(
        `INSERT INTO source_refs (source_ref_id, source_type, source_id, source_url)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_ref_id) DO UPDATE SET
           source_type=excluded.source_type,
           source_id=excluded.source_id,
           source_url=excluded.source_url`,
        [ref.sourceRefId, ref.sourceType, ref.sourceId, ref.sourceUrl ?? null]
      );
      this.exec(
        `INSERT INTO event_source_refs (event_id, source_ref_id)
         VALUES (?, ?)`,
        [normalizedEvent.eventId, ref.sourceRefId]
      );
    }
  }

  async saveParsedSegment(segment: ParsedSegment) {
    replaceById(this.cache.parsedSegments, segment, "segmentId");
    this.exec(
      `INSERT INTO parsed_segments (segment_id, event_id, modality, content, status, confidence, data_source, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(segment_id) DO UPDATE SET
         event_id=excluded.event_id,
         modality=excluded.modality,
         content=excluded.content,
         status=excluded.status,
         confidence=excluded.confidence,
         data_source=excluded.data_source,
         custom_fields=excluded.custom_fields`,
      [
        segment.segmentId,
        segment.eventId,
        segment.modality,
        segment.content,
        segment.status,
        segment.confidence,
        segment.dataSource ? JSON.stringify(segment.dataSource) : null,
        JSON.stringify(segment.customFields ?? {})
      ]
    );
  }

  async saveFactItem(fact: FactItem) {
    const normalizedFact = resolveFactOwner(
      fact,
      this.cache.facts.find((item) => item.factId === fact.factId),
      this.cache.memoryEvents
    );
    replaceById(this.cache.facts, normalizedFact, "factId");
    this.exec(
      `INSERT INTO fact_items (fact_id, session_id, fact_sequence, tenant_id, principal_id, context_scope_id, fact_type, fact_text, time_anchor, source_claim, normalized_claim, linked_event_ids, linked_segment_ids, linked_source_refs, entity_ids, confidence_level, version, status, observed_at, evidence_time, valid_time, temporal_events, evidence_time_start, evidence_time_end, evidence_time_confidence, source_message_ids, valid_time_start, valid_time_end, valid_time_basis, valid_time_confidence, time_basis, time_confidence, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_id) DO UPDATE SET
         session_id=excluded.session_id,
         fact_sequence=excluded.fact_sequence,
         tenant_id=COALESCE(excluded.tenant_id, fact_items.tenant_id),
         principal_id=COALESCE(excluded.principal_id, fact_items.principal_id),
         context_scope_id=COALESCE(excluded.context_scope_id, fact_items.context_scope_id),
         fact_type=excluded.fact_type,
         fact_text=excluded.fact_text,
         time_anchor=excluded.time_anchor,
         source_claim=excluded.source_claim,
         normalized_claim=excluded.normalized_claim,
         linked_event_ids=excluded.linked_event_ids,
         linked_segment_ids=excluded.linked_segment_ids,
         linked_source_refs=excluded.linked_source_refs,
         entity_ids=excluded.entity_ids,
         confidence_level=excluded.confidence_level,
         version=excluded.version,
         status=excluded.status,
         observed_at=excluded.observed_at,
         evidence_time=excluded.evidence_time,
         valid_time=excluded.valid_time,
         temporal_events=excluded.temporal_events,
         evidence_time_start=excluded.evidence_time_start,
         evidence_time_end=excluded.evidence_time_end,
         evidence_time_confidence=excluded.evidence_time_confidence,
         source_message_ids=excluded.source_message_ids,
         valid_time_start=excluded.valid_time_start,
         valid_time_end=excluded.valid_time_end,
         valid_time_basis=excluded.valid_time_basis,
         valid_time_confidence=excluded.valid_time_confidence,
         time_basis=excluded.time_basis,
         time_confidence=excluded.time_confidence,
         schema_version=excluded.schema_version`,
      [
        normalizedFact.factId,
        normalizedFact.sessionId ?? null,
        normalizedFact.factSequence ?? null,
        normalizedFact.tenantId ?? null,
        normalizedFact.principalId ?? null,
        normalizedFact.contextScopeId ?? null,
        normalizedFact.factType,
        normalizedFact.factText,
        normalizedFact.timeAnchor ?? null,
        normalizedFact.sourceClaim ?? null,
        normalizedFact.normalizedClaim,
        JSON.stringify(normalizedFact.linkedEventIds),
        JSON.stringify(normalizedFact.linkedSegmentIds),
        JSON.stringify(normalizedFact.linkedSourceRefs),
        JSON.stringify(normalizedFact.entityIds),
        normalizedFact.confidenceLevel,
        normalizedFact.version,
        normalizedFact.status,
        normalizedFact.observedAt,
        normalizedFact.evidenceTime ?? null,
        normalizedFact.validTime ?? null,
        JSON.stringify(normalizedFact.events ?? []),
        normalizedFact.evidenceTimeStart ?? null,
        normalizedFact.evidenceTimeEnd ?? null,
        normalizedFact.evidenceTimeConfidence ?? "low",
        JSON.stringify(normalizedFact.sourceMessageIds ?? []),
        normalizedFact.validTimeStart ?? null,
        normalizedFact.validTimeEnd ?? null,
        normalizedFact.validTimeBasis ?? null,
        normalizedFact.validTimeConfidence ?? normalizedFact.timeConfidence,
        normalizedFact.timeBasis,
        normalizedFact.timeConfidence,
        normalizedFact.schemaVersion
      ]
    );
  }

  async saveFactBatchCommitted(batch: FactBatchCommitted): Promise<FactBatchCommitted> {
    const normalized = normalizeFactBatchCommitted(batch);
    const existing = await this.getFactBatchCommitted(normalized.batchId);
    if (existing) {
      if (!sameFactBatchCommit(existing, normalized)) {
        throw new FactBatchCommitError(
          "FACT_BATCH_CONFLICT",
          `Fact batch ${normalized.batchId} was already committed with different facts or scope.`
        );
      }
      return existing;
    }

    const persistedFacts = await this.getFactItemsByIds(normalized.newFactIds);
    const persistedFactIds = new Set(persistedFacts.map((fact) => fact.factId));
    const missingFactIds = normalized.newFactIds.filter((factId) => !persistedFactIds.has(factId));
    if (missingFactIds.length) {
      throw new FactBatchCommitError(
        "FACT_BATCH_FACTS_MISSING",
        `Fact batch ${normalized.batchId} references facts that are not persisted: ${missingFactIds.join(", ")}`
      );
    }

    for (const fact of persistedFacts) {
      if (
        (fact.tenantId && fact.tenantId !== normalized.tenantId) ||
        (fact.principalId && fact.principalId !== normalized.principalId) ||
        (fact.contextScopeId !== undefined && fact.contextScopeId !== normalized.contextScopeId)
      ) {
        throw new FactBatchCommitError(
          "FACT_BATCH_CONFLICT",
          `Fact ${fact.factId} belongs to a different owner scope.`
        );
      }
      if (
        fact.tenantId !== normalized.tenantId ||
        fact.principalId !== normalized.principalId ||
        fact.contextScopeId !== normalized.contextScopeId
      ) {
        await this.saveFactItem({
          ...fact,
          tenantId: normalized.tenantId,
          principalId: normalized.principalId,
          ...(normalized.contextScopeId ? { contextScopeId: normalized.contextScopeId } : {})
        });
      }
    }

    this.cache.factBatches.push(normalized);
    this.exec(
      `INSERT INTO fact_batches (batch_id, trigger_type, tenant_id, principal_id, context_scope_id, new_fact_ids, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.batchId,
        normalized.triggerType,
        normalized.tenantId,
        normalized.principalId,
        normalized.contextScopeId ?? null,
        JSON.stringify(normalized.newFactIds),
        normalized.committedAt
      ]
    );
    return normalized;
  }

  getFactBatchCommitted(batchId: string): FactBatchCommitted | undefined {
    return this.cache.factBatches.find((batch) => batch.batchId === batchId);
  }

  async saveTimelineFusionTask(task: TimelineFusionTask): Promise<void> {
    const normalized = normalizeTimelineFusionTask(task);
    replaceById(this.cache.timelineFusionTasks, normalized, "taskId");
    this.exec(
      `INSERT INTO timeline_fusion_tasks (task_id, tenant_id, principal_id, context_scope_id, batch_ids, new_fact_ids, status, scheduled_at, deadline_at, ready_at, execution_fingerprints, completion_reason, completed_at, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         tenant_id=excluded.tenant_id,
         principal_id=excluded.principal_id,
         context_scope_id=excluded.context_scope_id,
         batch_ids=excluded.batch_ids,
         new_fact_ids=excluded.new_fact_ids,
         status=excluded.status,
         scheduled_at=excluded.scheduled_at,
         deadline_at=excluded.deadline_at,
         ready_at=excluded.ready_at,
         execution_fingerprints=excluded.execution_fingerprints,
         completion_reason=excluded.completion_reason,
         completed_at=excluded.completed_at,
         error=excluded.error,
         created_at=excluded.created_at,
         updated_at=excluded.updated_at`,
      [
        normalized.taskId,
        normalized.tenantId,
        normalized.principalId,
        normalized.contextScopeId ?? null,
        JSON.stringify(normalized.batchIds),
        JSON.stringify(normalized.newFactIds),
        normalized.status,
        normalized.scheduledAt,
        normalized.deadlineAt,
        normalized.readyAt ?? null,
        JSON.stringify(normalized.executionFingerprints ?? []),
        normalized.completionReason ?? null,
        normalized.completedAt ?? null,
        normalized.error ?? null,
        normalized.createdAt,
        normalized.updatedAt
      ]
    );
  }

  getTimelineFusionTask(taskId: string): TimelineFusionTask | undefined {
    return this.cache.timelineFusionTasks.find((task) => task.taskId === taskId);
  }

  listTimelineFusionTasks(query: {
    tenantId?: string;
    principalId?: string;
    contextScopeId?: string;
    statuses?: TimelineFusionTask["status"][];
  } = {}): TimelineFusionTask[] {
    const statuses = query.statuses?.length ? new Set(query.statuses) : undefined;
    return this.cache.timelineFusionTasks.filter((task) =>
      (!query.tenantId || task.tenantId === query.tenantId) &&
      (!query.principalId || task.principalId === query.principalId) &&
      (!query.contextScopeId || task.contextScopeId === query.contextScopeId) &&
      (!statuses || statuses.has(task.status))
    );
  }

  async reserveTimelineFusionExecution(
    execution: TimelineFusionExecution
  ): Promise<TimelineFusionExecution> {
    const normalized = normalizeTimelineFusionExecution(execution);
    const existingValue = this.getTimelineFusionExecutionByFingerprint(normalized.fingerprint);
    const existing = existingValue instanceof Promise ? await existingValue : existingValue;
    if (existing) {
      if (!sameTimelineFusionReservation(existing, normalized)) {
        throw timelineFusionExecutionConflict(normalized.fingerprint);
      }
      return existing;
    }
    this.cache.timelineFusionExecutions.push(normalized);
    this.exec(
      `INSERT INTO timeline_fusion_executions (
         fingerprint, execution_id, tenant_id, principal_id, context_scope_id, task_ids, batch_ids, new_fact_ids,
         temporal_basis, temporal_start_at, temporal_end_at, fusion_policy_version, status,
         result_fact_ids, attempt, lease_owner, lease_expires_at, completion_reason, error,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO NOTHING`,
      timelineFusionExecutionParams(normalized)
    );
    return normalized;
  }

  async saveTimelineFusionExecution(execution: TimelineFusionExecution): Promise<void> {
    const normalized = normalizeTimelineFusionExecution(execution);
    const existingValue = this.getTimelineFusionExecutionByFingerprint(normalized.fingerprint);
    const existing = existingValue instanceof Promise ? await existingValue : existingValue;
    if (!existing) {
      throw new TimelineFusionExecutionError(
        "TIMELINE_FUSION_EXECUTION_NOT_FOUND",
        `Timeline fusion fingerprint ${normalized.fingerprint} must be reserved before it can be updated.`
      );
    }
    if (!sameTimelineFusionReservation(existing, normalized)) {
      throw timelineFusionExecutionConflict(normalized.fingerprint);
    }
    replaceById(this.cache.timelineFusionExecutions, normalized, "fingerprint");
    this.exec(
      `UPDATE timeline_fusion_executions
       SET status = ?, result_fact_ids = ?, attempt = ?, lease_owner = ?, lease_expires_at = ?,
           completion_reason = ?, error = ?, updated_at = ?, completed_at = ?
       WHERE fingerprint = ?`,
      [
        normalized.status,
        JSON.stringify(normalized.resultFactIds),
        normalized.attempt,
        normalized.leaseOwner ?? null,
        normalized.leaseExpiresAt ?? null,
        normalized.completionReason ?? null,
        normalized.error ?? null,
        normalized.updatedAt,
        normalized.completedAt ?? null,
        normalized.fingerprint
      ]
    );
  }

  getTimelineFusionExecutionByFingerprint(
    fingerprint: string
  ): TimelineFusionExecution | undefined {
    return this.cache.timelineFusionExecutions.find((execution) => execution.fingerprint === fingerprint);
  }

  findFactCandidatesForFusion(query: TimelineFusionCandidateQuery): FactItem[] {
    const facts = this.cache.facts.filter((fact) =>
      fact.tenantId === query.tenantId &&
      fact.principalId === query.principalId &&
      (!query.contextScopeId || fact.contextScopeId === query.contextScopeId)
    );
    const eventIds = [...new Set(facts.flatMap((fact) => fact.linkedEventIds))];
    const eventIdSet = new Set(eventIds);
    const events = this.cache.memoryEvents.filter((event) => eventIdSet.has(event.eventId));
    return filterTimelineFusionFactCandidates(facts, events, query);
  }

  findTimelineFusionFactCandidates(query: TimelineFusionCandidateQuery): FactItem[] {
    return this.findFactCandidatesForFusion(query);
  }

  async saveFactVersion(version: FactVersion): Promise<FactVersion> {
    const normalized = normalizeFactVersion(version);
    const storedVersions = await this.getFactVersions({
      tenantId: normalized.tenantId,
      principalId: normalized.principalId
    });
    const existingById = storedVersions.find((item) =>
      item.factVersionId === normalized.factVersionId
    );
    if (existingById) {
      if (!sameFactVersion(existingById, normalized)) throw factVersionConflict(normalized.factVersionId);
      return existingById;
    }
    const existingByFingerprint = storedVersions.find((item) =>
      item.tenantId === normalized.tenantId &&
      item.principalId === normalized.principalId &&
      item.sourceFingerprint === normalized.sourceFingerprint
    );
    if (existingByFingerprint) {
      if (!sameFactVersion(existingByFingerprint, normalized)) {
        throw factVersionConflict(normalized.sourceFingerprint);
      }
      return existingByFingerprint;
    }
    const duplicateVersion = storedVersions.find((item) =>
      item.tenantId === normalized.tenantId &&
      item.principalId === normalized.principalId &&
      item.factId === normalized.factId &&
      item.version === normalized.version
    );
    if (duplicateVersion) throw factVersionConflict(`${normalized.factId}:${normalized.version}`);
    if (normalized.previousVersionId) {
      const previous = storedVersions.find((item) =>
        item.factVersionId === normalized.previousVersionId
      );
      if (!previous || previous.factId !== normalized.factId || previous.version >= normalized.version) {
        throw factVersionConflict(normalized.previousVersionId);
      }
    }
    this.cache.factVersions.push(normalized);
    this.exec(
      `INSERT INTO fact_versions (
         fact_version_id, fact_id, tenant_id, principal_id, version,
         previous_version_id, fact_text, normalized_claim, fact_type,
         evidence_time_start, evidence_time_end, valid_time_start, valid_time_end,
         confidence_level, source_fact_ids, linked_event_ids, linked_segment_ids,
         linked_source_refs, update_reason, conflict_refs, source_fingerprint, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      factVersionParams(normalized)
    );
    return normalized;
  }

  getFactVersions(query: {
    tenantId: string;
    principalId: string;
    factId?: string;
    sourceFingerprint?: string;
  }): FactVersion[] {
    return this.cache.factVersions
      .filter((version) =>
        version.tenantId === query.tenantId &&
        version.principalId === query.principalId &&
        (!query.factId || version.factId === query.factId) &&
        (!query.sourceFingerprint || version.sourceFingerprint === query.sourceFingerprint)
      )
      .sort(compareFactVersions);
  }

  getFactVersionsByFactIds(query: {
    tenantId: string;
    principalId: string;
    factIds: string[];
  }): FactVersion[] {
    const factIds = new Set(uniqueStrings(query.factIds));
    if (!factIds.size) return [];
    return this.cache.factVersions
      .filter((version) =>
        version.tenantId === query.tenantId &&
        version.principalId === query.principalId &&
        factIds.has(version.factId)
      )
      .sort(compareFactVersions);
  }

  async commitTimelineFusionFactStore(input: {
    execution: TimelineFusionExecution;
    facts: FactItem[];
    versions: FactVersion[];
    resultFactIds: string[];
    completedAt: string;
  }) {
    const stored = await this.getTimelineFusionExecutionByFingerprint(input.execution.fingerprint);
    if (!stored || stored.tenantId !== input.execution.tenantId || stored.principalId !== input.execution.principalId) {
      throw new TimelineFusionFactStoreError(
        "TIMELINE_FUSION_FACT_STORE_CONFLICT",
        `Timeline fusion execution is missing or has a different owner: ${input.execution.fingerprint}.`
      );
    }
    if (stored.status === "succeeded") {
      const resultFactIds = new Set(stored.resultFactIds);
      return {
        execution: stored,
        facts: await this.getFactItemsByIds(stored.resultFactIds),
        versions: this.getFactVersions({
          tenantId: stored.tenantId,
          principalId: stored.principalId
        }).filter((version) => resultFactIds.has(version.factId))
      };
    }
    if (!sameTimelineFusionReservation(stored, input.execution)) {
      throw new TimelineFusionFactStoreError(
        "TIMELINE_FUSION_FACT_STORE_CONFLICT",
        `Timeline fusion execution input changed after reservation: ${stored.fingerprint}.`
      );
    }
    for (const fact of input.facts) {
      if (
        fact.tenantId !== stored.tenantId ||
        fact.principalId !== stored.principalId ||
        fact.contextScopeId !== stored.contextScopeId
      ) {
        throw factVersionConflict(`fact_owner:${fact.factId}`);
      }
    }
    const factsBefore = structuredClone(this.cache.facts);
    const versionsBefore = structuredClone(this.cache.factVersions);
    const executionsBefore = structuredClone(this.cache.timelineFusionExecutions);
    try {
      for (const fact of input.facts) await this.saveFactItem(fact);
      const savedVersions: FactVersion[] = [];
      for (const version of [...input.versions].sort(compareFactVersions)) {
        savedVersions.push(await this.saveFactVersion(version));
      }
      const completed: TimelineFusionExecution = {
        ...stored,
        status: "succeeded",
        resultFactIds: uniqueStrings(input.resultFactIds),
        attempt: Math.max(stored.attempt, input.execution.attempt),
        updatedAt: input.completedAt,
        completedAt: input.completedAt
      };
      await this.saveTimelineFusionExecution(completed);
      return { execution: completed, facts: input.facts, versions: savedVersions };
    } catch (error) {
      replaceArray(this.cache.facts, factsBefore);
      replaceArray(this.cache.factVersions, versionsBefore);
      replaceArray(this.cache.timelineFusionExecutions, executionsBefore);
      throw error;
    }
  }

  async saveShortTermMemory(memory: ShortTermMemory) {
    await this.replaceShortTermMemory(memory);
  }

  async saveLongTermMemory(memory: LongTermMemory) {
    await this.replaceLongTermMemory(memory);
  }

  async replaceShortTermMemory(memory: ShortTermMemory) {
    assertShortTermMemoryScope(memory);
    const existing = this.cache.shortTermMemories.find((item) => item.memoryDataId === memory.memoryDataId);
    const { factSummary, ...memoryWithoutFactSummary } = memory;
    const normalizedFactSummary = normalizeFactSummary(factSummary);
    const sourceFacts = this.cache.facts.filter((fact) => memory.sourceFactIds.includes(fact.factId));
    const temporalMetadata = aggregateMemoryTemporalMetadata(sourceFacts.length
      ? [
        ...sourceFacts.map(temporalMetadataFromFact),
        ...(memory.structuredFacts?.facts ?? [])
      ]
      : [
        ...(memory.structuredFacts?.facts ?? []),
        memory
      ]);
    const normalizedMemory: ShortTermMemory = {
      ...memoryWithoutFactSummary,
      ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {}),
      ...temporalMetadata,
      memoryType: normalizePrdMemoryType(memory.memoryType, "fact"),
      retrievalWeight: memory.retrievalWeight ?? shortTermRetrievalWeight(memory.importanceLevel)
    };

    if (existing) {
      if (existing.tenantId !== normalizedMemory.tenantId || existing.principalId !== normalizedMemory.principalId) {
        throw new Error(`STM_OWNER_CONFLICT:${memory.memoryDataId}`);
      }
      normalizedMemory.createdAt = existing.createdAt;
      if (sameShortTermMemoryState(existing, normalizedMemory)) return;
      normalizedMemory.updatedAt = nextShortTermMemoryTimestamp(existing.updatedAt, normalizedMemory.updatedAt);
    }

    replaceById(this.cache.shortTermMemories, normalizedMemory, "memoryDataId");
    this.exec(
      `INSERT INTO short_term_memories (memory_data_id, tenant_id, principal_id, memory_data_type, memory_type, content, structured_facts, fact_summary, summary, evidence_time, valid_time, evidence_time_start, evidence_time_end, evidence_time_confidence, valid_time_start, valid_time_end, valid_time_confidence, importance_level, retrieval_weight, user_retrieval_weight, confidence_level, admission_result, admission_reason, source_fact_ids, source_refs, entity_ids, matched_rules, admission_signals, access_state, lifecycle_status, consolidation_status, next_evaluate_at, last_evaluated_at, observe_count, reevaluation_reason, expires_at, dreaming_policy_version, latest_decision_id, reevaluation_tier, cycle_attempt_count, total_attempt_count, last_dreaming_error, latest_dreaming_run_id, created_at, updated_at)
       VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       )
       ON CONFLICT(memory_data_id) DO UPDATE SET
         memory_data_type=excluded.memory_data_type,
         memory_type=excluded.memory_type,
         content=excluded.content,
         structured_facts=excluded.structured_facts,
         fact_summary=excluded.fact_summary,
         summary=excluded.summary,
         evidence_time=excluded.evidence_time,
         valid_time=excluded.valid_time,
         evidence_time_start=excluded.evidence_time_start,
         evidence_time_end=excluded.evidence_time_end,
         evidence_time_confidence=excluded.evidence_time_confidence,
         valid_time_start=excluded.valid_time_start,
         valid_time_end=excluded.valid_time_end,
         valid_time_confidence=excluded.valid_time_confidence,
         importance_level=excluded.importance_level,
         retrieval_weight=excluded.retrieval_weight,
         user_retrieval_weight=excluded.user_retrieval_weight,
         confidence_level=excluded.confidence_level,
         admission_result=excluded.admission_result,
         admission_reason=excluded.admission_reason,
         source_fact_ids=excluded.source_fact_ids,
         source_refs=excluded.source_refs,
         entity_ids=excluded.entity_ids,
         matched_rules=excluded.matched_rules,
         admission_signals=excluded.admission_signals,
         access_state=excluded.access_state,
         lifecycle_status=excluded.lifecycle_status,
         consolidation_status=excluded.consolidation_status,
         next_evaluate_at=excluded.next_evaluate_at,
         last_evaluated_at=excluded.last_evaluated_at,
         observe_count=excluded.observe_count,
         reevaluation_reason=excluded.reevaluation_reason,
         expires_at=excluded.expires_at,
         dreaming_policy_version=excluded.dreaming_policy_version,
         latest_decision_id=excluded.latest_decision_id,
         reevaluation_tier=excluded.reevaluation_tier,
         cycle_attempt_count=excluded.cycle_attempt_count,
         total_attempt_count=excluded.total_attempt_count,
         last_dreaming_error=excluded.last_dreaming_error,
         latest_dreaming_run_id=excluded.latest_dreaming_run_id,
         updated_at=excluded.updated_at`,
      [
        normalizedMemory.memoryDataId,
        normalizedMemory.tenantId,
        normalizedMemory.principalId,
        normalizedMemory.memoryDataType,
        normalizedMemory.memoryType,
        normalizedMemory.content,
        normalizedMemory.structuredFacts ? JSON.stringify(normalizedMemory.structuredFacts) : null,
        normalizedMemory.factSummary ?? null,
        normalizedMemory.summary ?? null,
        normalizedMemory.evidenceTime ?? null,
        normalizedMemory.validTime ?? null,
        normalizedMemory.evidenceTimeStart ?? null,
        normalizedMemory.evidenceTimeEnd ?? null,
        normalizedMemory.evidenceTimeConfidence ?? "low",
        normalizedMemory.validTimeStart ?? null,
        normalizedMemory.validTimeEnd ?? null,
        normalizedMemory.validTimeConfidence ?? "low",
        normalizedMemory.importanceLevel,
        normalizedMemory.retrievalWeight,
        normalizedMemory.userRetrievalWeight ?? null,
        normalizedMemory.confidenceLevel,
        normalizedMemory.admissionResult,
        normalizedMemory.admissionReason,
        JSON.stringify(normalizedMemory.sourceFactIds ?? []),
        JSON.stringify(normalizedMemory.sourceRefs),
        JSON.stringify(normalizedMemory.entityIds),
        JSON.stringify(normalizedMemory.matchedRules),
        JSON.stringify(normalizedMemory.admissionSignals),
        normalizedMemory.accessState ?? null,
        normalizedMemory.lifecycleStatus,
        normalizedMemory.consolidationStatus ?? "unseen",
        normalizedMemory.nextEvaluateAt ?? null,
        normalizedMemory.lastEvaluatedAt ?? null,
        normalizedMemory.observeCount ?? 0,
        normalizedMemory.reevaluationReason ?? null,
        normalizedMemory.expiresAt ?? null,
        normalizedMemory.dreamingPolicyVersion ?? null,
        normalizedMemory.latestDecisionId ?? null,
        normalizedMemory.reevaluationTier ?? null,
        normalizedMemory.cycleAttemptCount ?? 0,
        normalizedMemory.totalAttemptCount ?? 0,
        normalizedMemory.lastDreamingError ?? null,
        normalizedMemory.latestDreamingRunId ?? null,
        normalizedMemory.createdAt,
        normalizedMemory.updatedAt
      ]
    );
  }

  async replaceLongTermMemory(memory: LongTermMemory) {
    const { factSummary, ...memoryWithoutFactSummary } = memory;
    const normalizedFactSummary = normalizeFactSummary(factSummary);
    const sourceMemories = this.cache.shortTermMemories.filter((item) =>
      memory.sourceMemoryDataIds.includes(item.memoryDataId)
    );
    const temporalMetadata = aggregateMemoryTemporalMetadata(sourceMemories.length
      ? [
        ...sourceMemories,
        ...(memory.structuredFacts?.facts ?? [])
      ]
      : [
        ...(memory.structuredFacts?.facts ?? []),
        memory
      ]);
    const normalizedMemory: LongTermMemory = {
      ...memoryWithoutFactSummary,
      ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {}),
      ...temporalMetadata,
      memoryType: normalizePrdMemoryType(memory.memoryType, "knowledge"),
      retrievalWeight: memory.retrievalWeight ?? longTermRetrievalWeight(memory.recallWeight)
    };
    replaceById(this.cache.longTermMemories, normalizedMemory, "memoryId");
    this.exec(
      `INSERT INTO long_term_memories (memory_id, tenant_id, principal_id, consolidation_key, version, previous_version_id, consolidation_score, consolidation_factors, policy_version, prompt_version, model, created_at, updated_at, last_maintained_at, theory_class, memory_type, content, structured_facts, fact_summary, summary, evidence_time_start, evidence_time_end, evidence_time_confidence, valid_time_start, valid_time_end, valid_time_confidence, confidence_level, recall_weight, retrieval_weight, user_retrieval_weight, solidify_reason, source_refs, source_memory_data_ids, source_fact_ids, entity_ids, matched_rules, access_state, lifecycle_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         tenant_id=excluded.tenant_id,
         principal_id=excluded.principal_id,
         consolidation_key=excluded.consolidation_key,
         version=excluded.version,
         previous_version_id=excluded.previous_version_id,
         consolidation_score=excluded.consolidation_score,
         consolidation_factors=excluded.consolidation_factors,
         policy_version=excluded.policy_version,
         prompt_version=excluded.prompt_version,
         model=excluded.model,
         created_at=COALESCE(long_term_memories.created_at, excluded.created_at),
         updated_at=excluded.updated_at,
         last_maintained_at=excluded.last_maintained_at,
         theory_class=excluded.theory_class,
         memory_type=excluded.memory_type,
         content=excluded.content,
         structured_facts=excluded.structured_facts,
         fact_summary=excluded.fact_summary,
         summary=excluded.summary,
         evidence_time_start=excluded.evidence_time_start,
         evidence_time_end=excluded.evidence_time_end,
         evidence_time_confidence=excluded.evidence_time_confidence,
         valid_time_start=excluded.valid_time_start,
         valid_time_end=excluded.valid_time_end,
         valid_time_confidence=excluded.valid_time_confidence,
         confidence_level=excluded.confidence_level,
         recall_weight=excluded.recall_weight,
         retrieval_weight=excluded.retrieval_weight,
         user_retrieval_weight=excluded.user_retrieval_weight,
         solidify_reason=excluded.solidify_reason,
         source_refs=excluded.source_refs,
         source_memory_data_ids=excluded.source_memory_data_ids,
         source_fact_ids=excluded.source_fact_ids,
         entity_ids=excluded.entity_ids,
         matched_rules=excluded.matched_rules,
         access_state=excluded.access_state,
         lifecycle_status=excluded.lifecycle_status`,
      [
        normalizedMemory.memoryId,
        normalizedMemory.tenantId ?? null,
        normalizedMemory.principalId ?? null,
        normalizedMemory.consolidationKey ?? null,
        normalizedMemory.version ?? 1,
        normalizedMemory.previousVersionId ?? null,
        normalizedMemory.consolidationScore ?? null,
        normalizedMemory.consolidationFactors ? JSON.stringify(normalizedMemory.consolidationFactors) : null,
        normalizedMemory.policyVersion ?? null,
        normalizedMemory.promptVersion ?? null,
        normalizedMemory.model ?? null,
        normalizedMemory.createdAt ?? null,
        normalizedMemory.updatedAt ?? null,
        normalizedMemory.lastMaintainedAt ?? null,
        normalizedMemory.theoryClass,
        normalizedMemory.memoryType,
        normalizedMemory.content,
        normalizedMemory.structuredFacts ? JSON.stringify(normalizedMemory.structuredFacts) : null,
        normalizedMemory.factSummary ?? null,
        normalizedMemory.summary ?? null,
        normalizedMemory.evidenceTimeStart ?? null,
        normalizedMemory.evidenceTimeEnd ?? null,
        normalizedMemory.evidenceTimeConfidence ?? "low",
        normalizedMemory.validTimeStart ?? null,
        normalizedMemory.validTimeEnd ?? null,
        normalizedMemory.validTimeConfidence ?? "low",
        normalizedMemory.confidenceLevel,
        normalizedMemory.recallWeight,
        normalizedMemory.retrievalWeight,
        normalizedMemory.userRetrievalWeight ?? null,
        normalizedMemory.solidifyReason,
        JSON.stringify(normalizedMemory.sourceRefs),
        JSON.stringify(normalizedMemory.sourceMemoryDataIds),
        JSON.stringify(normalizedMemory.sourceFactIds ?? []),
        JSON.stringify(normalizedMemory.entityIds),
        JSON.stringify(normalizedMemory.matchedRules),
        normalizedMemory.accessState ?? null,
        normalizedMemory.lifecycleStatus
      ]
    );
  }

  async saveRelationEdge(edge: RelationEdge) {
    replaceById(this.cache.relationEdges, edge, "edgeId");
    this.exec(
      `INSERT INTO relation_edges (edge_id, from_id, to_id, relation_type, evidence, strength, confidence, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(edge_id) DO UPDATE SET
         from_id=excluded.from_id,
         to_id=excluded.to_id,
         relation_type=excluded.relation_type,
         evidence=excluded.evidence,
         strength=excluded.strength,
         confidence=excluded.confidence,
         source=excluded.source,
         created_at=excluded.created_at`,
      [
        edge.edgeId,
        edge.fromId,
        edge.toId,
        edge.relationType,
        edge.evidence ?? null,
        edge.strength ?? null,
        edge.confidence ?? null,
        edge.source ?? null,
        edge.createdAt ?? null
      ]
    );
    await this.graphStore?.upsertGraphRelationEdge(edge);
  }

  async saveContextPackTrace(trace: ContextPackTrace) {
    replaceById(this.cache.packTraces, trace, "traceId");
    this.exec(
      `INSERT INTO context_pack_traces (trace_id, pack_id, final_score, token_budget, temporal_trace)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(trace_id) DO UPDATE SET
         pack_id=excluded.pack_id,
         final_score=excluded.final_score,
         token_budget=excluded.token_budget,
         temporal_trace=excluded.temporal_trace`,
      [
        trace.traceId,
        trace.packId,
        trace.finalScore,
        trace.tokenBudget,
        trace.temporal ? JSON.stringify(trace.temporal) : null
      ]
    );
  }

  async saveLlmFactFusionTrace(trace: LlmFactFusionTrace) {
    replaceById(this.cache.llmFactFusionTraces, trace, "traceId");
    this.exec(
      `INSERT INTO llm_fact_fusion_traces (trace_id, event_id, provider, endpoint, model, key_source, prompt_version, schema_version, prompt, aligned_evidence, raw_response, parsed_facts, rejected_segments, fallback_reason, temporal_trace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trace_id) DO UPDATE SET
         event_id=excluded.event_id,
         provider=excluded.provider,
         endpoint=excluded.endpoint,
         model=excluded.model,
         key_source=excluded.key_source,
         prompt_version=excluded.prompt_version,
         schema_version=excluded.schema_version,
         prompt=excluded.prompt,
         aligned_evidence=excluded.aligned_evidence,
         raw_response=excluded.raw_response,
         parsed_facts=excluded.parsed_facts,
         rejected_segments=excluded.rejected_segments,
         fallback_reason=excluded.fallback_reason,
         temporal_trace=excluded.temporal_trace,
         created_at=excluded.created_at`,
      [trace.traceId, trace.eventId, trace.provider, trace.endpoint, trace.model, trace.keySource, trace.promptVersion, trace.schemaVersion, trace.prompt, JSON.stringify(trace.alignedEvidence), trace.rawResponse === undefined ? null : JSON.stringify(trace.rawResponse), JSON.stringify(trace.parsedFacts), JSON.stringify(trace.rejectedSegments), trace.fallbackReason ?? null, trace.temporal ? JSON.stringify(trace.temporal) : null, trace.createdAt]
    );
  }

  async saveLlmStmAdmissionTrace(trace: LlmStmAdmissionTrace) {
    replaceById(this.cache.llmStmAdmissionTraces, trace, "traceId");
    this.exec(
      `INSERT INTO llm_stm_admission_traces (trace_id, event_id, provider, endpoint, model, key_source, prompt_version, schema_version, prompt, fact_inputs, raw_response, parsed_decision, fallback_reason, override_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trace_id) DO UPDATE SET
         event_id=excluded.event_id,
         provider=excluded.provider,
         endpoint=excluded.endpoint,
         model=excluded.model,
         key_source=excluded.key_source,
         prompt_version=excluded.prompt_version,
         schema_version=excluded.schema_version,
         prompt=excluded.prompt,
         fact_inputs=excluded.fact_inputs,
         raw_response=excluded.raw_response,
         parsed_decision=excluded.parsed_decision,
         fallback_reason=excluded.fallback_reason,
         override_reason=excluded.override_reason,
         created_at=excluded.created_at`,
      [
        trace.traceId,
        trace.eventId,
        trace.provider,
        trace.endpoint,
        trace.model,
        trace.keySource,
        trace.promptVersion,
        trace.schemaVersion,
        trace.prompt,
        JSON.stringify(trace.factInputs),
        trace.rawResponse === undefined ? null : JSON.stringify(trace.rawResponse),
        trace.parsedDecision === undefined ? null : JSON.stringify(trace.parsedDecision),
        trace.fallbackReason ?? null,
        trace.overrideReason ?? null,
        trace.createdAt
      ]
    );
  }

  async saveLlmDreamingTrace(trace: LlmDreamingTrace) {
    replaceById(this.cache.llmDreamingTraces, trace, "traceId");
    this.exec(
      `INSERT INTO llm_dreaming_traces (trace_id, source_memory_data_ids, provider, endpoint, model, key_source, prompt_version, schema_version, prompt, candidate_memories, raw_response, parsed_memories, stm_evaluations, ltm_operations, rejected_candidates, fallback_reason, retry_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trace_id) DO UPDATE SET
         source_memory_data_ids=excluded.source_memory_data_ids,
         provider=excluded.provider,
         endpoint=excluded.endpoint,
         model=excluded.model,
         key_source=excluded.key_source,
         prompt_version=excluded.prompt_version,
         schema_version=excluded.schema_version,
         prompt=excluded.prompt,
         candidate_memories=excluded.candidate_memories,
         raw_response=excluded.raw_response,
         parsed_memories=excluded.parsed_memories,
         stm_evaluations=excluded.stm_evaluations,
         ltm_operations=excluded.ltm_operations,
         rejected_candidates=excluded.rejected_candidates,
         fallback_reason=excluded.fallback_reason,
         retry_after=excluded.retry_after,
         created_at=excluded.created_at`,
      [trace.traceId, JSON.stringify(trace.sourceMemoryDataIds), trace.provider, trace.endpoint, trace.model, trace.keySource, trace.promptVersion, trace.schemaVersion, trace.prompt, JSON.stringify(trace.candidateMemories), trace.rawResponse === undefined ? null : JSON.stringify(trace.rawResponse), JSON.stringify(trace.parsedMemories), JSON.stringify(trace.stmEvaluations ?? []), JSON.stringify(trace.ltmOperations ?? []), JSON.stringify(trace.rejectedCandidates), trace.fallbackReason ?? null, trace.retryAfter ?? null, trace.createdAt]
    );
  }

  async savePipelineTask(task: ContextPipelineTask) {
    replaceById(this.cache.pipelineTasks, task, "taskId");
    this.exec(
      `INSERT INTO context_pipeline_tasks (task_id, event_id, task_type, status, attempt, max_attempts, retryable, stage, error, retry_after, checkpoint, lease_owner, lease_expires_at, stats, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         event_id=excluded.event_id,
         task_type=excluded.task_type,
         status=excluded.status,
         attempt=excluded.attempt,
         max_attempts=excluded.max_attempts,
         retryable=excluded.retryable,
         stage=excluded.stage,
         error=excluded.error,
         retry_after=excluded.retry_after,
         checkpoint=excluded.checkpoint,
         lease_owner=excluded.lease_owner,
         lease_expires_at=excluded.lease_expires_at,
         stats=excluded.stats,
         created_at=excluded.created_at,
         updated_at=excluded.updated_at`,
      [task.taskId, task.eventId, task.taskType, task.status, task.attempt, task.maxAttempts, task.retryable ? 1 : 0, task.stage, task.error ?? null, task.retryAfter ?? null, task.checkpoint ?? null, task.leaseOwner ?? null, task.leaseExpiresAt ?? null, task.stats ? JSON.stringify(task.stats) : null, task.createdAt, task.updatedAt]
    );
  }

  getPipelineTaskByEventId(eventId: string) {
    return [...this.cache.pipelineTasks].reverse().find((task) => task.eventId === eventId);
  }

  async saveDreamingCandidateDecision(decision: DreamingCandidateDecision) {
    replaceById(this.cache.dreamingCandidateDecisions, decision, "decisionId");
    this.exec(
      `INSERT INTO dreaming_candidate_decisions (decision_id, run_id, candidate_fingerprint, memory_data_id, tenant_id, principal_id, decision, reason_codes, source_fact_ids, source_refs, permission_snapshot_ids, policy_version, trace_id, evaluated_at, next_evaluate_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(decision_id) DO UPDATE SET
         decision=excluded.decision,
         reason_codes=excluded.reason_codes,
         next_evaluate_at=excluded.next_evaluate_at,
         evaluated_at=excluded.evaluated_at`,
      [
        decision.decisionId,
        decision.runId,
        decision.candidateFingerprint,
        decision.memoryDataId,
        decision.tenantId,
        decision.principalId,
        decision.decision,
        JSON.stringify(decision.reasonCodes),
        JSON.stringify(decision.sourceFactIds),
        JSON.stringify(decision.sourceRefs),
        JSON.stringify(decision.permissionSnapshotIds),
        decision.policyVersion,
        decision.traceId,
        decision.evaluatedAt,
        decision.nextEvaluateAt ?? null,
        decision.createdAt
      ]
    );
  }

  async saveDreamingRun(run: DreamingRun) {
    const scheduledConflict = run.triggerType === "scheduled" && run.scheduleKey
      ? this.dreamingRuns.find((item) =>
          item.runId !== run.runId &&
          item.tenantId === run.tenantId &&
          item.principalId === run.principalId &&
          item.triggerType === "scheduled" &&
          item.scheduleKey === run.scheduleKey
        )
      : undefined;
    if (scheduledConflict) {
      throw new Error(`DREAMING_RUN_SCHEDULE_CONFLICT:${run.tenantId}:${run.principalId}:${run.scheduleKey}`);
    }
    replaceById(this.dreamingRuns, run, "runId");
    this.exec(
      `INSERT INTO dreaming_runs (
        run_id, tenant_id, principal_id, trigger_type, schedule_key, status,
        requested_at, candidate_window_start_at, candidate_cutoff_at, actual_started_at,
        paused_at, pause_reason, completed_at, checkpoint, lease_owner, lease_expires_at,
        policy_version, prompt_version, model, candidate_count, processed_count,
        consolidated_count, observing_count, dropped_count, retry_wait_count,
        skipped_count, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        tenant_id=excluded.tenant_id,
        principal_id=excluded.principal_id,
        trigger_type=excluded.trigger_type,
        schedule_key=excluded.schedule_key,
        status=excluded.status,
        requested_at=excluded.requested_at,
        candidate_window_start_at=excluded.candidate_window_start_at,
        candidate_cutoff_at=excluded.candidate_cutoff_at,
        actual_started_at=excluded.actual_started_at,
        paused_at=excluded.paused_at,
        pause_reason=excluded.pause_reason,
        completed_at=excluded.completed_at,
        checkpoint=excluded.checkpoint,
        lease_owner=excluded.lease_owner,
        lease_expires_at=excluded.lease_expires_at,
        policy_version=excluded.policy_version,
        prompt_version=excluded.prompt_version,
        model=excluded.model,
        candidate_count=excluded.candidate_count,
        processed_count=excluded.processed_count,
        consolidated_count=excluded.consolidated_count,
        observing_count=excluded.observing_count,
        dropped_count=excluded.dropped_count,
        retry_wait_count=excluded.retry_wait_count,
        skipped_count=excluded.skipped_count,
        last_error=excluded.last_error,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at`,
      [
        run.runId,
        run.tenantId,
        run.principalId,
        run.triggerType,
        run.scheduleKey ?? null,
        run.status,
        run.requestedAt,
        run.candidateWindowStartAt,
        run.candidateCutoffAt,
        run.actualStartedAt ?? null,
        run.pausedAt ?? null,
        run.pauseReason ?? null,
        run.completedAt ?? null,
        run.checkpoint ?? null,
        run.leaseOwner ?? null,
        run.leaseExpiresAt ?? null,
        run.policyVersion,
        run.promptVersion,
        run.model ?? null,
        run.candidateCount,
        run.processedCount,
        run.consolidatedCount,
        run.observingCount,
        run.droppedCount,
        run.retryWaitCount,
        run.skippedCount,
        run.lastError ?? null,
        run.createdAt,
        run.updatedAt
      ]
    );
  }

  getDreamingRun(runId: string) {
    return this.dreamingRuns.find((run) => run.runId === runId);
  }

  listDreamingRuns(query: {
    tenantId?: string;
    principalId?: string;
    statuses?: DreamingRun["status"][];
  } = {}) {
    const statuses = query.statuses ? new Set(query.statuses) : undefined;
    return this.dreamingRuns
      .filter((run) =>
        (!query.tenantId || run.tenantId === query.tenantId) &&
        (!query.principalId || run.principalId === query.principalId) &&
        (!statuses || statuses.has(run.status))
      )
      .sort((left, right) => left.candidateCutoffAt.localeCompare(right.candidateCutoffAt));
  }

  async claimNextDreamingRun(input: {
    tenantId: string;
    principalId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }) {
    const hasActiveLease = this.dreamingRuns.some((item) =>
      item.tenantId === input.tenantId &&
      item.principalId === input.principalId &&
      item.status === "running" &&
      Boolean(item.leaseExpiresAt && item.leaseExpiresAt > input.claimedAt)
    );
    if (hasActiveLease) return undefined;
    const run = this.dreamingRuns
      .filter((item) =>
        item.tenantId === input.tenantId &&
        item.principalId === input.principalId &&
        (item.status === "queued" || (
          item.status === "running" &&
          Boolean(item.leaseExpiresAt && item.leaseExpiresAt <= input.claimedAt)
        ))
      )
      .sort((left, right) => left.candidateCutoffAt.localeCompare(right.candidateCutoffAt))[0];
    if (!run) return undefined;
    const claimed: DreamingRun = {
      ...run,
      status: "running",
      actualStartedAt: run.actualStartedAt ?? input.claimedAt,
      leaseOwner: input.claimedBy,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.claimedAt
    };
    await this.saveDreamingRun(claimed);
    return claimed;
  }

  async saveDreamingRunCandidate(candidate: DreamingRunCandidate) {
    const duplicate = this.dreamingRunCandidates.find((item) =>
      item.runCandidateId !== candidate.runCandidateId &&
      item.runId === candidate.runId &&
      item.memoryDataId === candidate.memoryDataId &&
      item.candidateFingerprint === candidate.candidateFingerprint
    );
    if (duplicate) {
      throw new Error(`DREAMING_RUN_CANDIDATE_CONFLICT:${candidate.runId}:${candidate.memoryDataId}:${candidate.candidateFingerprint}`);
    }
    replaceById(this.dreamingRunCandidates, candidate, "runCandidateId");
    this.exec(
      `INSERT INTO dreaming_run_candidates (
        run_candidate_id, run_id, memory_data_id, stm_version, candidate_fingerprint,
        source_type, status, cycle_attempt_count, total_attempt_count,
        reevaluation_tier, next_evaluate_at, decision_id, trace_id, result_ltm_id,
        last_error, lease_owner, lease_expires_at, started_at, completed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_candidate_id) DO UPDATE SET
        run_id=excluded.run_id,
        memory_data_id=excluded.memory_data_id,
        stm_version=excluded.stm_version,
        candidate_fingerprint=excluded.candidate_fingerprint,
        source_type=excluded.source_type,
        status=excluded.status,
        cycle_attempt_count=excluded.cycle_attempt_count,
        total_attempt_count=excluded.total_attempt_count,
        reevaluation_tier=excluded.reevaluation_tier,
        next_evaluate_at=excluded.next_evaluate_at,
        decision_id=excluded.decision_id,
        trace_id=excluded.trace_id,
        result_ltm_id=excluded.result_ltm_id,
        last_error=excluded.last_error,
        lease_owner=excluded.lease_owner,
        lease_expires_at=excluded.lease_expires_at,
        started_at=excluded.started_at,
        completed_at=excluded.completed_at,
        updated_at=excluded.updated_at`,
      [
        candidate.runCandidateId,
        candidate.runId,
        candidate.memoryDataId,
        candidate.stmVersion,
        candidate.candidateFingerprint,
        candidate.sourceType,
        candidate.status,
        candidate.cycleAttemptCount,
        candidate.totalAttemptCount,
        candidate.reevaluationTier ?? null,
        candidate.nextEvaluateAt ?? null,
        candidate.decisionId ?? null,
        candidate.traceId ?? null,
        candidate.resultLtmId ?? null,
        candidate.lastError ?? null,
        candidate.leaseOwner ?? null,
        candidate.leaseExpiresAt ?? null,
        candidate.startedAt ?? null,
        candidate.completedAt ?? null,
        candidate.createdAt,
        candidate.updatedAt
      ]
    );
  }

  getDreamingRunCandidate(runCandidateId: string) {
    return this.dreamingRunCandidates.find((candidate) => candidate.runCandidateId === runCandidateId);
  }

  listDreamingRunCandidates(runId: string) {
    return this.dreamingRunCandidates
      .filter((candidate) => candidate.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.memoryDataId.localeCompare(right.memoryDataId));
  }

  async claimNextDreamingRunCandidate(input: {
    runId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }) {
    const candidate = this.dreamingRunCandidates
      .filter((item) =>
        item.runId === input.runId &&
        (item.status === "pending" || (
          item.status === "processing" &&
          Boolean(item.leaseExpiresAt && item.leaseExpiresAt <= input.claimedAt)
        ))
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.memoryDataId.localeCompare(right.memoryDataId))[0];
    if (!candidate) return undefined;
    const claimed: DreamingRunCandidate = {
      ...candidate,
      status: "processing",
      leaseOwner: input.claimedBy,
      leaseExpiresAt: input.leaseExpiresAt,
      startedAt: candidate.startedAt ?? input.claimedAt,
      updatedAt: input.claimedAt
    };
    await this.saveDreamingRunCandidate(claimed);
    return claimed;
  }

  async deleteShortTermMemory(memoryDataId: string) {
    const index = this.shortTermMemories.findIndex((memory) => memory.memoryDataId === memoryDataId);
    if (index >= 0) this.shortTermMemories.splice(index, 1);
    this.exec(`DELETE FROM short_term_memories WHERE memory_data_id = ?`, [memoryDataId]);
  }

  async deleteShortTermMemoryArtifacts(memoryDataId: string) {
    const relationEdgeIds = this.cache.relationEdges
      .filter((edge) => edge.fromId === memoryDataId || edge.toId === memoryDataId)
      .map((edge) => edge.edgeId);
    removeWhere(this.cache.relationEdges, (edge) => edge.fromId === memoryDataId || edge.toId === memoryDataId);
    for (const edgeId of relationEdgeIds) {
      this.exec(`DELETE FROM relation_edges WHERE edge_id = ?`, [edgeId]);
    }
    await this.deleteIndexBundle("stm", memoryDataId);
  }

  listDueDreamingShortTermMemories(query: {
    tenantId: string;
    principalId: string;
    cutoffAt: string;
    policyVersion: string;
  }) {
    return this.shortTermMemories
      .filter((memory) =>
        memory.tenantId === query.tenantId &&
        memory.principalId === query.principalId &&
        (isDueDreamingRetry(memory, query.cutoffAt) ||
          isTerminalDreamingDecisionFromOlderPolicy(memory, query.policyVersion)) &&
        memory.lifecycleStatus !== "deleted" &&
        memory.accessState !== "permission-invalid"
      )
      .sort((left, right) =>
        (left.nextEvaluateAt ?? left.updatedAt).localeCompare(right.nextEvaluateAt ?? right.updatedAt) ||
        left.memoryDataId.localeCompare(right.memoryDataId));
  }

  listDreamingShortTermMemoriesInWindow(query: {
    tenantId: string;
    principalId: string;
    windowStart: string;
    cutoffAt: string;
    policyVersion: string;
  }) {
    return this.shortTermMemories
      .filter((memory) =>
        memory.tenantId === query.tenantId &&
        memory.principalId === query.principalId &&
        memory.createdAt >= query.windowStart &&
        memory.createdAt < query.cutoffAt &&
        isDreamingNewShortTermMemory(memory, query.policyVersion) &&
        memory.lifecycleStatus !== "deleted" &&
        memory.accessState !== "permission-invalid"
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.memoryDataId.localeCompare(right.memoryDataId));
  }

  async withDreamingTransaction<T>(callback: () => Promise<T>): Promise<T> {
    const snapshot = {
      longTermMemories: this.longTermMemories.slice(),
      shortTermMemories: this.shortTermMemories.slice(),
      relationEdges: this.relationEdges.slice(),
      graphMemoryNodes: this.graphMemoryNodes.slice(),
      indexEntries: this.indexEntries.slice(),
      textIndexEntries: this.textIndexEntries.slice(),
      vectorIndexEntries: this.vectorIndexEntries.slice(),
      changeEvents: this.changeEvents.slice(),
      llmDreamingTraces: this.llmDreamingTraces.slice(),
      pipelineTasks: this.pipelineTasks.slice(),
      dreamingOutbox: this.dreamingOutbox.slice(),
      dreamingRuns: this.dreamingRuns.slice(),
      dreamingRunCandidates: this.dreamingRunCandidates.slice(),
      dreamingCandidateDecisions: this.dreamingCandidateDecisions.slice()
    };
    try {
      return await callback();
    } catch (error) {
      replaceArray(this.longTermMemories, snapshot.longTermMemories);
      replaceArray(this.shortTermMemories, snapshot.shortTermMemories);
      replaceArray(this.relationEdges, snapshot.relationEdges);
      replaceArray(this.graphMemoryNodes, snapshot.graphMemoryNodes);
      replaceArray(this.indexEntries, snapshot.indexEntries);
      replaceArray(this.textIndexEntries, snapshot.textIndexEntries);
      replaceArray(this.vectorIndexEntries, snapshot.vectorIndexEntries);
      replaceArray(this.changeEvents, snapshot.changeEvents);
      replaceArray(this.llmDreamingTraces, snapshot.llmDreamingTraces);
      replaceArray(this.pipelineTasks, snapshot.pipelineTasks);
      replaceArray(this.dreamingOutbox, snapshot.dreamingOutbox);
      replaceArray(this.dreamingRuns, snapshot.dreamingRuns);
      replaceArray(this.dreamingRunCandidates, snapshot.dreamingRunCandidates);
      replaceArray(this.dreamingCandidateDecisions, snapshot.dreamingCandidateDecisions);
      throw error;
    }
  }

  async saveDreamingOutbox(record: DreamingOutboxRecord) {
    replaceById(this.dreamingOutbox, record, "outboxId");
    this.exec(`INSERT INTO dreaming_outbox (outbox_id, operation, owner_id, payload, status, attempts, next_attempt_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(outbox_id) DO UPDATE SET operation=excluded.operation, owner_id=excluded.owner_id, payload=excluded.payload, status=excluded.status, attempts=excluded.attempts, next_attempt_at=excluded.next_attempt_at, last_error=excluded.last_error, updated_at=excluded.updated_at`,
      [record.outboxId, record.operation, record.ownerId, record.payload ? JSON.stringify(record.payload) : null, record.status, record.attempts, record.nextAttemptAt ?? null, record.lastError ?? null, record.createdAt, record.updatedAt]);
  }

  listPendingDreamingOutbox(now = new Date().toISOString()) {
    return this.dreamingOutbox.filter((record) =>
      (record.status === "pending" || record.status === "failed") && (!record.nextAttemptAt || record.nextAttemptAt <= now)
    );
  }

  async markDreamingOutbox(record: DreamingOutboxRecord) { await this.saveDreamingOutbox(record); }

  async saveIndexEntry(entry: ContextIndexEntry) {
    replaceById(this.cache.indexEntries, entry, "indexId");
    this.exec(
      `INSERT INTO context_index_entries (index_id, owner_id, owner_type, content, lifecycle_status, refreshed_at, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(index_id) DO UPDATE SET
         owner_id=excluded.owner_id,
         owner_type=excluded.owner_type,
         content=excluded.content,
         lifecycle_status=excluded.lifecycle_status,
         refreshed_at=excluded.refreshed_at,
         token_count=excluded.token_count`,
      [entry.indexId, entry.ownerId, entry.ownerType, entry.content, entry.lifecycleStatus, entry.refreshedAt, entry.tokenCount]
    );
  }

  async saveTextIndexEntry(entry: ContextTextIndexEntry) {
    replaceById(this.cache.textIndexEntries, entry, "indexId");
  }

  async saveVectorIndexEntry(entry: ContextVectorIndexEntry) {
    replaceById(this.cache.vectorIndexEntries, entry, "indexId");
    this.exec(
      `INSERT INTO context_vector_index_entries (index_id, owner_id, owner_type, content, vector, lifecycle_status, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(index_id) DO UPDATE SET
         owner_id=excluded.owner_id,
         owner_type=excluded.owner_type,
         content=excluded.content,
         vector=excluded.vector,
         lifecycle_status=excluded.lifecycle_status,
         refreshed_at=excluded.refreshed_at`,
      [entry.indexId, entry.ownerId, entry.ownerType, entry.content, JSON.stringify(entry.vector), entry.lifecycleStatus, entry.refreshedAt]
    );
  }

  searchTextIndex(queryTokens: string[]): TextIndexSearchHit[] {
    const normalizedTokens = expandSearchTokens(queryTokens);
    if (!normalizedTokens.length) return [];
    return this.textIndexEntries
      .filter((entry) => normalizedTokens.some((token) => entry.term.includes(token)))
      .map((entry) => ({
        ownerType: entry.ownerType,
        ownerId: entry.ownerId,
        score: 1,
        matchedTerms: 1
      }))
      .sort((left, right) => right.score - left.score);
  }

  searchFactText(queryTokens: string[], query: FactIndexSearchQuery = {}): FactIndexSearchHit[] {
    const tokens = [...new Set(queryTokens.map((token) => token.normalize("NFKC").toLowerCase().trim()).filter(Boolean))];
    const indexed = new Set(this.cache.indexEntries.filter((entry) => entry.ownerType === "fact").map((entry) => entry.ownerId));
    return this.cache.facts
      .filter((fact) => indexed.has(fact.factId) && factMatchesIndexQuery(fact, query))
      .map((fact) => ({
        factId: fact.factId,
        score: tokens.filter((token) => buildFactIndexContent(fact).includes(token)).length
      }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.factId.localeCompare(right.factId))
      .slice(0, query.limit ?? 100);
  }

  searchFactVector(queryVector: number[], query: FactIndexSearchQuery = {}): FactIndexSearchHit[] {
    if (!queryVector.length) return [];
    const factById = new Map(this.cache.facts.map((fact) => [fact.factId, fact]));
    return this.cache.vectorIndexEntries
      .filter((entry) => entry.ownerType === "fact")
      .flatMap((entry) => {
        const fact = factById.get(entry.ownerId);
        return fact && factMatchesIndexQuery(fact, query)
          ? [{ factId: fact.factId, score: cosine(queryVector, entry.vector) }]
          : [];
      })
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.factId.localeCompare(right.factId))
      .slice(0, query.limit ?? 100);
  }

  listKeywordCorpusContents(): string[] {
    return this.cache.indexEntries
      .filter((entry) => entry.ownerType === "stm" || entry.ownerType === "ltm")
      .map((entry) => entry.content)
      .filter(Boolean);
  }

  selectShortTermMemoriesForBackground(query: BackgroundStmPageQuery): BackgroundStmPage {
    const rows = this.cache.shortTermMemories
      .filter((memory) =>
        memory.tenantId === query.tenantId &&
        memory.principalId === query.principalId &&
        memory.updatedAt >= query.windowStart &&
        memory.updatedAt < query.windowEnd &&
        (!query.cursor ||
          memory.updatedAt > query.cursor.updatedAt ||
          (memory.updatedAt === query.cursor.updatedAt && memory.memoryDataId > query.cursor.memoryDataId))
      )
      .sort(compareShortTermMemoryCursor);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      memories: page,
      ...(last
        ? { nextCursor: { updatedAt: last.updatedAt, memoryDataId: last.memoryDataId } }
        : {}),
      hasMore: rows.length > query.limit
    };
  }

  getBackgroundStmWindowStats(query: BackgroundStmWindowStatsQuery): BackgroundStmWindowStats {
    const rows = this.cache.shortTermMemories
      .filter((memory) => backgroundMemoryMatchesStats(memory, query))
      .sort(compareShortTermMemoryCursor);
    const latest = rows.at(-1);
    return {
      ...(latest ? { latestCursor: { updatedAt: latest.updatedAt, memoryDataId: latest.memoryDataId } } : {}),
      pendingCount: Math.min(rows.length, query.countLimit),
      countCapped: rows.length > query.countLimit
    };
  }

  getShortTermMemory(memoryDataId: string): ShortTermMemory | undefined {
    return this.cache.shortTermMemories.find((memory) => memory.memoryDataId === memoryDataId);
  }

  getShortTermMemoriesByIds(memoryDataIds: string[]): ShortTermMemory[] {
    const allowed = new Set(memoryDataIds.map((item) => item.trim()).filter(Boolean));
    if (!allowed.size) return [];
    return this.cache.shortTermMemories.filter((memory) => allowed.has(memory.memoryDataId));
  }

  getLongTermMemory(memoryId: string): LongTermMemory | undefined {
    return this.cache.longTermMemories.find((memory) => memory.memoryId === memoryId);
  }

  getParsedSegmentsByIds(segmentIds: string[]): ParsedSegment[] {
    const allowed = new Set(segmentIds.map((item) => item.trim()).filter(Boolean));
    if (!allowed.size) return [];
    return this.cache.parsedSegments.filter((segment) => allowed.has(segment.segmentId));
  }

  getMemoryEventsByIds(eventIds: string[]): MemoryEvent[] {
    const allowed = new Set(eventIds.map((item) => item.trim()).filter(Boolean));
    if (!allowed.size) return [];
    return this.cache.memoryEvents.filter((event) => allowed.has(event.eventId));
  }

  findEvidenceCandidates(query: EvidenceSearchQuery): EvidenceSearchCandidate[] {
    const visibilityByIngestionId = new Map(this.cache.conversationIngestions.map((ingestion) => [
      ingestion.ingestionId,
      ingestion.visibility
    ]));
    const messages = latestConversationEvidenceMessages(this.cache.conversationMessages)
      .filter((message) => message.operation !== "delete")
      .map((message) => adaptConversationMessageEvidence(
        message,
        visibilityByIngestionId.get(message.ingestionId) ?? "private"
      ));
    const eventById = new Map(this.cache.memoryEvents.map((event) => [event.eventId, event]));
    const segments = this.cache.parsedSegments
      .filter((segment) => segment.status === "parsed" && !isConversationDerivedSegment(segment))
      .flatMap((segment) => {
        const event = eventById.get(segment.eventId);
        return event ? [adaptParsedSegmentEvidence(segment, event)] : [];
      });
    return filterAndScoreEvidenceCandidates([...messages, ...segments], query);
  }

  getGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string): GraphMemoryNode | undefined {
    return this.cache.graphMemoryNodes.find((node) => node.ownerType === ownerType && node.ownerId === ownerId);
  }

  getIndexEntryByOwnerId(ownerId: string): ContextIndexEntry | undefined {
    return this.cache.indexEntries.find((entry) => entry.ownerId === ownerId);
  }

  findMemoryOwnersBySourceIds(sourceIds: string[], ownerTypes: GraphMemoryOwnerType[] = ["stm", "ltm"]): MemoryOwnerBySourceHit[] {
    const allowed = new Set(sourceIds.map((item) => item.trim()).filter(Boolean));
    if (!allowed.size) return [];
    const hits: MemoryOwnerBySourceHit[] = [];
    if (ownerTypes.includes("stm")) {
      for (const memory of this.cache.shortTermMemories) {
        if (memory.sourceRefs.some((source) => allowed.has(source.sourceId))) {
          hits.push({ ownerType: "stm", ownerId: memory.memoryDataId, score: 1 });
        }
      }
    }
    if (ownerTypes.includes("ltm")) {
      for (const memory of this.cache.longTermMemories) {
        if (memory.sourceRefs.some((source) => allowed.has(source.sourceId))) {
          hits.push({ ownerType: "ltm", ownerId: memory.memoryId, score: 1 });
        }
      }
    }
    return hits;
  }

  findMemoryOwnersByContextScopeId(
    contextScopeId: string,
    ownerTypes: GraphMemoryOwnerType[] = ["stm", "ltm"]
  ): MemoryOwnerBySourceHit[] {
    const scopeId = contextScopeId.trim();
    if (!scopeId) return [];
    const scopedFactIds = new Set(this.cache.facts
      .filter((fact) => fact.contextScopeId === scopeId)
      .map((fact) => fact.factId));
    const scopedStmIds = new Set(this.cache.shortTermMemories
      .filter((memory) => memory.sourceFactIds.some((factId) => scopedFactIds.has(factId)))
      .map((memory) => memory.memoryDataId));
    const hits: MemoryOwnerBySourceHit[] = [];
    if (ownerTypes.includes("stm")) {
      for (const ownerId of scopedStmIds) hits.push({ ownerType: "stm", ownerId, score: 1 });
    }
    if (ownerTypes.includes("ltm")) {
      for (const memory of this.cache.longTermMemories) {
        const hasScopedFact = (memory.sourceFactIds ?? []).some((factId) => scopedFactIds.has(factId));
        const hasScopedStm = memory.sourceMemoryDataIds.some((memoryDataId) => scopedStmIds.has(memoryDataId));
        if (hasScopedFact || hasScopedStm) hits.push({ ownerType: "ltm", ownerId: memory.memoryId, score: 1 });
      }
    }
    return hits;
  }

  getFactItemsByIds(factIds: string[]): FactItem[] {
    const allowed = new Set(factIds);
    if (!allowed.size) return [];
    return this.cache.facts.filter((fact) => allowed.has(fact.factId));
  }

  findFactItemsByEventIds(eventIds: string[]): FactItem[] {
    const allowed = new Set(eventIds.map((item) => item.trim()).filter(Boolean));
    if (!allowed.size) return [];
    return this.cache.facts.filter((fact) => fact.linkedEventIds.some((eventId) => allowed.has(eventId)));
  }

  async upsertGraphMemoryNode(node: GraphMemoryNode) {
    replaceById(this.cache.graphMemoryNodes, node, "graphNodeId");
    await this.graphStore?.upsertGraphMemoryNode(node);
    await this.syncGraphRelationEdgesForOwner(node.ownerId);
  }

  async deleteGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string) {
    removeWhere(this.cache.graphMemoryNodes, (node) => node.ownerType === ownerType && node.ownerId === ownerId);
    await this.graphStore?.deleteGraphMemoryNode(ownerType, ownerId);
  }

  searchGraphText(queryTokens: string[], options: GraphMemorySearchOptions = {}): MaybePromise<GraphMemorySearchHit[]> {
    if (this.graphStore) return this.graphStore.searchGraphText(queryTokens, options);
    const normalizedTokens = expandSearchTokens(queryTokens.map((token) => token.toLowerCase()));
    if (!normalizedTokens.length) return [];
    return this.filterGraphNodes(options)
      .map((node) => {
        const normalizedContent = node.content.toLowerCase();
        const matchedTerms = normalizedTokens.filter((token) => normalizedContent.includes(token)).length;
        return {
          ownerType: node.ownerType,
          ownerId: node.ownerId,
          score: matchedTerms,
          matchedTerms
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.ownerType.localeCompare(right.ownerType) || left.ownerId.localeCompare(right.ownerId));
  }

  searchGraphVector(queryVector: number[], options: GraphMemorySearchOptions = {}): MaybePromise<GraphMemorySearchHit[]> {
    if (this.graphStore) return this.graphStore.searchGraphVector(queryVector, options);
    if (!queryVector.length) return [];
    return this.filterGraphNodes(options)
      .map((node) => ({
        ownerType: node.ownerType,
        ownerId: node.ownerId,
        score: cosine(queryVector, node.vector)
      }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.ownerType.localeCompare(right.ownerType) || left.ownerId.localeCompare(right.ownerId));
  }

  getGraphRelationEdges(ownerId: string): MaybePromise<RelationEdge[]> {
    if (this.graphStore) return this.graphStore.getGraphRelationEdges(ownerId);
    return this.cache.relationEdges.filter((edge) => edge.fromId === ownerId || edge.toId === ownerId);
  }

  searchGraphRelationEdges(query: GraphRelationSearchQuery): MaybePromise<RelationEdge[]> {
    if (this.graphStore) return this.graphStore.searchGraphRelationEdges(query);
    const relationTypes = query.relationTypes?.filter(Boolean);
    const ownerTypes = query.ownerTypes?.filter(Boolean);
    const evidenceQuery = query.q?.trim().toLowerCase();
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(0, query.limit ?? 50);
    const matches = this.cache.relationEdges
      .filter((edge) => !query.fromId || edge.fromId === query.fromId)
      .filter((edge) => !query.toId || edge.toId === query.toId)
      .filter((edge) => !relationTypes?.length || relationTypes.includes(edge.relationType))
      .filter((edge) => {
        if (!ownerTypes?.length) return true;
        const fromOwnerType = memoryOwnerTypeForId(edge.fromId);
        const toOwnerType = memoryOwnerTypeForId(edge.toId);
        return Boolean((fromOwnerType && ownerTypes.includes(fromOwnerType)) || (toOwnerType && ownerTypes.includes(toOwnerType)));
      })
      .filter((edge) => !evidenceQuery || (edge.evidence ?? "").toLowerCase().includes(evidenceQuery))
      .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.edgeId.localeCompare(right.edgeId));
    return matches.slice(offset, offset + limit);
  }

  listGraphMemoryNodes(query: GraphMemoryNodePageQuery): MaybePromise<GraphMemoryNodePage> {
    if (this.graphStore) return this.graphStore.listGraphMemoryNodes(query);
    const offset = Math.max(0, query.offset ?? 0);
    const rows = this.cache.graphMemoryNodes
      .filter((node) => query.ownerTypes.includes(node.ownerType))
      .filter((node) => !query.after || graphMemoryNodeIsAfter(node, query.after))
      .sort(compareGraphMemoryNodes)
      .slice(offset, offset + query.limit + 1);
    return {
      nodes: rows.slice(0, query.limit).map(cloneGraphMemoryNode),
      hasMore: rows.length > query.limit
    };
  }

  listGraphRelationEdges(query: GraphRelationEdgePageQuery): MaybePromise<GraphRelationEdgePage> {
    if (this.graphStore) return this.graphStore.listGraphRelationEdges(query);
    const offset = Math.max(0, query.offset ?? 0);
    const nodeOwnerTypes = new Map<string, Set<GraphMemoryOwnerType>>();
    for (const node of this.cache.graphMemoryNodes) {
      const ownerTypes = nodeOwnerTypes.get(node.ownerId) ?? new Set<GraphMemoryOwnerType>();
      ownerTypes.add(node.ownerType);
      nodeOwnerTypes.set(node.ownerId, ownerTypes);
    }
    const endpointIsIncluded = (ownerId: string) =>
      [...(nodeOwnerTypes.get(ownerId) ?? [])].some((ownerType) => query.ownerTypes.includes(ownerType));
    const rows = this.cache.relationEdges
      .filter((edge) => endpointIsIncluded(edge.fromId) && endpointIsIncluded(edge.toId))
      .filter((edge) => query.relationTypes.includes(edge.relationType))
      .filter((edge) => !query.after || edge.edgeId > query.after.id)
      .sort((left, right) => compareText(left.edgeId, right.edgeId))
      .slice(offset, offset + query.limit + 1);
    return {
      edges: rows.slice(0, query.limit).map(cloneRelationEdge),
      hasMore: rows.length > query.limit
    };
  }

  private async syncGraphRelationEdgesForOwner(ownerId: string) {
    if (!this.graphStore) return;
    const edges = this.cache.relationEdges.filter((edge) => edge.fromId === ownerId || edge.toId === ownerId);
    for (const edge of edges) {
      await this.graphStore.upsertGraphRelationEdge(edge);
    }
  }

  async deleteIndexEntry(indexId: string) {
    removeWhere(this.indexEntries, (item) => item.indexId === indexId);
  }

  async deleteTextIndexEntry(indexId: string) {
    removeWhere(this.textIndexEntries, (item) => item.indexId === indexId);
  }

  async deleteVectorIndexEntry(indexId: string) {
    removeWhere(this.vectorIndexEntries, (item) => item.indexId === indexId);
  }

  async deleteIndexBundle(ownerType: "fact" | "stm" | "ltm", ownerId: string) {
    const baseIndexId = ownerType === "fact" ? `idx_fact_${ownerId}` : `idx_${ownerType}_${ownerId}`;
    await this.deleteIndexEntry(baseIndexId);
    await this.deleteVectorIndexEntry(baseIndexId);
    removeWhere(this.textIndexEntries, (entry) => entry.ownerType === ownerType && entry.ownerId === ownerId);
    if (ownerType === "stm" || ownerType === "ltm") {
      await this.deleteGraphMemoryNode(ownerType, ownerId);
    }
  }

  async saveMemoryChangeEvent(event: MemoryChangeEvent) {
    replaceById(this.cache.changeEvents, event, "eventId");
    this.exec(
      `INSERT INTO memory_change_events (event_id, memory_id, memory_data_id, change_type, storage_layer, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         memory_id=excluded.memory_id,
         memory_data_id=excluded.memory_data_id,
         change_type=excluded.change_type,
         storage_layer=excluded.storage_layer,
         reason=excluded.reason,
         created_at=excluded.created_at`,
      [event.eventId, event.memoryId ?? null, event.memoryDataId ?? null, event.changeType, event.storageLayer, event.reason, event.createdAt]
    );
  }

  async saveMemoryFeedback(item: MemoryFeedbackItem) {
    replaceById(this.cache.feedbackItems, item, "feedbackId");
    this.exec(
      `INSERT INTO memory_feedback_items (feedback_id, target_id, target_type, action, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(feedback_id) DO UPDATE SET
         target_id=excluded.target_id,
         target_type=excluded.target_type,
         action=excluded.action,
         note=excluded.note,
         created_at=excluded.created_at`,
      [item.feedbackId, item.targetId, item.targetType, item.action, item.note ?? null, item.createdAt]
    );
    await this.saveMemoryRetrievalEvent({
      retrievalEventId: `retrieval_feedback_${item.feedbackId}`,
      ownerType: item.targetType,
      ownerId: item.targetId,
      ...(item.tenantId ? { tenantId: item.tenantId } : {}),
      ...(item.principalId ? { principalId: item.principalId } : {}),
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      ...(item.taskId ? { taskId: item.taskId } : {}),
      requestId: item.requestId ?? item.feedbackId,
      eventType: "user_feedback",
      feedbackAction: item.action,
      createdAt: item.createdAt
    });
  }

  async saveMemoryRetrievalEvent(event: MemoryRetrievalEvent) {
    const duplicate = this.cache.retrievalEvents.some((item) =>
      item.retrievalEventId === event.retrievalEventId || Boolean(
        event.requestId && item.requestId === event.requestId &&
        item.ownerType === event.ownerType && item.ownerId === event.ownerId &&
        item.eventType === event.eventType
      )
    );
    if (duplicate) return;
    replaceById(this.cache.retrievalEvents, event, "retrievalEventId");
    this.exec(
      `INSERT OR IGNORE INTO memory_retrieval_events (
         retrieval_event_id, owner_type, owner_id, tenant_id, principal_id,
         session_id, task_id, request_id, event_type, query, feedback_action, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.retrievalEventId,
        event.ownerType,
        event.ownerId,
        event.tenantId ?? null,
        event.principalId ?? null,
        event.sessionId ?? null,
        event.taskId ?? null,
        event.requestId ?? null,
        event.eventType,
        event.query ?? null,
        event.feedbackAction ?? null,
        event.createdAt
      ]
    );
  }

  getMemoryReuseSignals(ownerIds?: string[], now = new Date().toISOString()) {
    return buildMemoryReuseSignals(this.cache.retrievalEvents, ownerIds, now);
  }

  async saveBackgroundDocument(item: BackgroundContextDocument) {
    assertBackgroundDocument(item);
    const existing = this.cache.backgroundDocuments.find((document) => document.backgroundId === item.backgroundId);
    if (existing && (existing.tenantId !== item.tenantId || existing.principalId !== item.principalId)) {
      throw new Error(`BACKGROUND_OWNER_CONFLICT:${item.backgroundId}`);
    }
    const revisionConflict = this.cache.backgroundDocuments.find((document) =>
      document.backgroundId !== item.backgroundId &&
      document.tenantId === item.tenantId &&
      document.principalId === item.principalId &&
      document.fixedRevision === item.fixedRevision
    );
    if (revisionConflict) {
      throw new Error(`BACKGROUND_REVISION_CONFLICT:${item.tenantId}:${item.principalId}:${item.fixedRevision}`);
    }

    this.exec(
      `INSERT INTO background_context_documents (
         background_id, tenant_id, principal_id, fixed_text, dynamic_text,
         fixed_revision, fixed_text_updated_at, fixed_watermark_json,
         dynamic_window_start, dynamic_window_end, dynamic_source_memory_ids_json,
         latest_stm_cursor_json, dynamic_cache_key, source_ref_ids, conflict_ids,
         degraded_mode_reason, update_suggestion_status, update_suggestion_summary,
         update_suggestion_target_sections, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(background_id) DO UPDATE SET
         fixed_text=excluded.fixed_text,
         dynamic_text=excluded.dynamic_text,
         fixed_revision=excluded.fixed_revision,
         fixed_text_updated_at=excluded.fixed_text_updated_at,
         fixed_watermark_json=excluded.fixed_watermark_json,
         dynamic_window_start=excluded.dynamic_window_start,
         dynamic_window_end=excluded.dynamic_window_end,
         dynamic_source_memory_ids_json=excluded.dynamic_source_memory_ids_json,
         latest_stm_cursor_json=excluded.latest_stm_cursor_json,
         dynamic_cache_key=excluded.dynamic_cache_key,
         source_ref_ids=excluded.source_ref_ids,
         conflict_ids=excluded.conflict_ids,
         degraded_mode_reason=excluded.degraded_mode_reason,
         update_suggestion_status=excluded.update_suggestion_status,
         update_suggestion_summary=excluded.update_suggestion_summary,
         update_suggestion_target_sections=excluded.update_suggestion_target_sections,
         updated_at=excluded.updated_at`,
      [
        item.backgroundId,
        item.tenantId,
        item.principalId,
        item.fixedText,
        item.dynamicText,
        item.fixedRevision,
        item.fixedTextUpdatedAt,
        JSON.stringify(item.fixedWatermark),
        item.dynamicWindowStart,
        item.dynamicWindowEnd,
        JSON.stringify(item.dynamicSourceMemoryIds),
        JSON.stringify(item.latestStmCursor),
        item.dynamicCacheKey ?? null,
        JSON.stringify(item.sourceRefIds),
        JSON.stringify(item.conflictIds),
        item.degradedModeReason ?? null,
        item.updateSuggestion?.status ?? null,
        item.updateSuggestion?.summary ?? null,
        item.updateSuggestion ? JSON.stringify(item.updateSuggestion.targetSections) : null,
        item.createdAt,
        item.updatedAt
      ]
    );
    replaceById(this.cache.backgroundDocuments, item, "backgroundId");
  }

  getLatestBackgroundDocument(tenantId: string, principalId: string): BackgroundContextDocument | undefined {
    return this.cache.backgroundDocuments
      .filter((document) => document.tenantId === tenantId && document.principalId === principalId)
      .sort(compareBackgroundDocumentsNewestFirst)[0];
  }

  getBackgroundMaintenanceTask(
    tenantId: string,
    principalId: string,
    runId: string
  ): BackgroundMaintenanceTask | undefined {
    return this.cache.backgroundMaintenanceTasks.find((task) =>
      task.tenantId === tenantId && task.principalId === principalId && task.runId === runId
    );
  }

  async createBackgroundMaintenanceTask(task: BackgroundMaintenanceTask) {
    const existing = this.getBackgroundMaintenanceTask(task.tenantId, task.principalId, task.runId);
    if (existing) return existing;
    assertBackgroundMaintenanceTask(task);
    this.cache.backgroundMaintenanceTasks.push(task);
    this.exec(backgroundMaintenanceTaskUpsertSql, backgroundMaintenanceTaskParams(task));
    return task;
  }

  async claimBackgroundMaintenanceTask(input: {
    taskId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }) {
    const task = this.cache.backgroundMaintenanceTasks.find((item) => item.taskId === input.taskId);
    if (!task || task.status === "succeeded") return undefined;
    const competing = this.cache.backgroundMaintenanceTasks.find((item) =>
      item.taskId !== task.taskId &&
      item.tenantId === task.tenantId &&
      item.principalId === task.principalId &&
      item.status === "running" &&
      Boolean(item.leaseExpiresAt && item.leaseExpiresAt > input.claimedAt)
    );
    if (
      competing ||
      task.status === "running" &&
      task.leaseExpiresAt &&
      task.leaseExpiresAt > input.claimedAt &&
      task.claimedBy !== input.claimedBy
    ) {
      return undefined;
    }
    const claimed: BackgroundMaintenanceTask = {
      ...task,
      status: "running",
      attempt: task.attempt + 1,
      retryable: task.attempt + 1 < task.maxAttempts,
      claimedBy: input.claimedBy,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.claimedAt
    };
    replaceById(this.cache.backgroundMaintenanceTasks, claimed, "taskId");
    this.exec(backgroundMaintenanceTaskUpsertSql, backgroundMaintenanceTaskParams(claimed));
    return claimed;
  }

  async saveBackgroundMaintenanceTask(task: BackgroundMaintenanceTask) {
    assertBackgroundMaintenanceTask(task);
    const existing = this.cache.backgroundMaintenanceTasks.find((item) => item.taskId === task.taskId);
    if (existing && (
      existing.tenantId !== task.tenantId ||
      existing.principalId !== task.principalId ||
      existing.runId !== task.runId
    )) {
      throw new Error(`BACKGROUND_MAINTENANCE_TASK_SCOPE_CONFLICT:${task.taskId}`);
    }
    replaceById(this.cache.backgroundMaintenanceTasks, task, "taskId");
    this.exec(backgroundMaintenanceTaskUpsertSql, backgroundMaintenanceTaskParams(task));
  }

  getBackgroundMaintenanceBatches(taskId: string) {
    return this.cache.backgroundMaintenanceBatches
      .filter((batch) => batch.taskId === taskId)
      .sort((left, right) => left.batchIndex - right.batchIndex);
  }

  async saveBackgroundMaintenanceBatch(batch: BackgroundMaintenanceBatch) {
    assertBackgroundMaintenanceBatch(batch);
    const duplicate = this.cache.backgroundMaintenanceBatches.find((item) =>
      item.taskId === batch.taskId && item.batchIndex === batch.batchIndex
    );
    if (duplicate && !isDeepStrictEqual(duplicate, batch)) {
      throw new Error(`BACKGROUND_MAINTENANCE_BATCH_CONFLICT:${batch.taskId}:${batch.batchIndex}`);
    }
    if (!duplicate) this.cache.backgroundMaintenanceBatches.push(batch);
    this.exec(
      `INSERT INTO background_maintenance_batches (
         task_id, batch_index, through_cursor_json, memory_ids_json,
         memory_source_refs_json, memory_count, analysis_output_json,
         estimated_input_tokens, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, batch_index) DO NOTHING`,
      [
        batch.taskId,
        batch.batchIndex,
        JSON.stringify(batch.throughCursor),
        JSON.stringify(batch.memoryIds),
        JSON.stringify(batch.memorySourceRefs),
        batch.memoryCount,
        JSON.stringify(batch.analysisOutput),
        batch.estimatedInputTokens,
        batch.createdAt
      ]
    );
  }

  async commitBackgroundMaintenanceCheckpoint(input: CommitBackgroundMaintenanceCheckpointRequest) {
    const taskSnapshot = [...this.cache.backgroundMaintenanceTasks];
    const batchSnapshot = [...this.cache.backgroundMaintenanceBatches];
    try {
      assertBackgroundMaintenanceLease(
        this.cache.backgroundMaintenanceTasks.find((task) => task.taskId === input.task.taskId),
        input.claimedBy,
        input.task.updatedAt
      );
      if (input.batch.taskId !== input.task.taskId) {
        throw new Error(`BACKGROUND_MAINTENANCE_CHECKPOINT_TASK_CONFLICT:${input.task.taskId}`);
      }
      await InMemoryContextEngineRepository.prototype.saveBackgroundMaintenanceBatch.call(this, input.batch);
      await InMemoryContextEngineRepository.prototype.saveBackgroundMaintenanceTask.call(this, input.task);
    } catch (caught) {
      replaceArray(this.cache.backgroundMaintenanceTasks, taskSnapshot);
      replaceArray(this.cache.backgroundMaintenanceBatches, batchSnapshot);
      throw caught;
    }
  }

  async commitFixedBackgroundMaintenance(input: CommitFixedBackgroundMaintenanceRequest) {
    const documentSnapshot = [...this.cache.backgroundDocuments];
    const taskSnapshot = [...this.cache.backgroundMaintenanceTasks];
    try {
      assertBackgroundMaintenanceCommitScope(input);
      assertBackgroundMaintenanceLease(
        this.cache.backgroundMaintenanceTasks.find((task) => task.taskId === input.task.taskId),
        input.claimedBy,
        input.task.updatedAt
      );
      const current = this.getLatestBackgroundDocument(input.document.tenantId, input.document.principalId);
      const currentRevision = current?.fixedRevision ?? 0;
      if (currentRevision !== input.expectedFixedRevision) {
        throw new Error(`REVISION_CONFLICT:${input.expectedFixedRevision}:${current?.fixedRevision ?? "missing"}`);
      }
      await InMemoryContextEngineRepository.prototype.saveBackgroundDocument.call(this, input.document);
      await InMemoryContextEngineRepository.prototype.saveBackgroundMaintenanceTask.call(this, input.task);
    } catch (caught) {
      replaceArray(this.cache.backgroundDocuments, documentSnapshot);
      replaceArray(this.cache.backgroundMaintenanceTasks, taskSnapshot);
      throw caught;
    }
  }

  getBackgroundDynamicCache(cacheKey: string) {
    return this.cache.backgroundDynamicCaches.find((record) => record.cacheKey === cacheKey);
  }

  getLatestBackgroundDynamicCache(
    tenantId: string,
    principalId: string,
    fixedRevision?: number
  ) {
    return this.cache.backgroundDynamicCaches
      .filter((record) =>
        record.tenantId === tenantId &&
        record.principalId === principalId &&
        (fixedRevision === undefined || record.fixedRevision === fixedRevision)
      )
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];
  }

  async saveBackgroundDynamicCache(record: BackgroundDynamicCacheRecord) {
    assertBackgroundDynamicCache(record);
    const existing = this.getBackgroundDynamicCache(record.cacheKey);
    if (existing && (
      existing.tenantId !== record.tenantId ||
      existing.principalId !== record.principalId ||
      existing.fixedRevision !== record.fixedRevision
    )) {
      throw new Error(`BACKGROUND_DYNAMIC_CACHE_SCOPE_CONFLICT:${record.cacheKey}`);
    }
    replaceById(this.cache.backgroundDynamicCaches, record, "cacheKey");
    this.exec(`INSERT INTO background_dynamic_cache (
      cache_key, tenant_id, principal_id, fixed_background_id, fixed_revision,
      latest_stm_cursor_json, reference_time, timezone, locale, local_date,
      window_start, window_end, dynamic_text,
      source_memory_ids_json, source_ref_ids_json, citations_json, conflict_ids_json,
      processed_memory_count, pending_stm_count, deferred_memory_count,
      deferred_ranges_json, watermark_lag_seconds, execution_strategy, status,
      degraded_mode_reason, generated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      latest_stm_cursor_json=excluded.latest_stm_cursor_json,
      reference_time=excluded.reference_time,
      timezone=excluded.timezone,
      locale=excluded.locale,
      local_date=excluded.local_date,
      window_start=excluded.window_start,
      window_end=excluded.window_end,
      dynamic_text=excluded.dynamic_text,
      source_memory_ids_json=excluded.source_memory_ids_json,
      source_ref_ids_json=excluded.source_ref_ids_json,
      citations_json=excluded.citations_json,
      conflict_ids_json=excluded.conflict_ids_json,
      processed_memory_count=excluded.processed_memory_count,
      pending_stm_count=excluded.pending_stm_count,
      deferred_memory_count=excluded.deferred_memory_count,
      deferred_ranges_json=excluded.deferred_ranges_json,
      watermark_lag_seconds=excluded.watermark_lag_seconds,
      execution_strategy=excluded.execution_strategy,
      status=excluded.status,
      degraded_mode_reason=excluded.degraded_mode_reason,
      generated_at=excluded.generated_at,
      expires_at=excluded.expires_at`, [
      record.cacheKey,
      record.tenantId,
      record.principalId,
      record.fixedBackgroundId,
      record.fixedRevision,
      JSON.stringify(record.latestStmCursor),
      record.referenceTime,
      record.timezone,
      record.locale,
      record.localDate,
      record.windowStart,
      record.windowEnd,
      record.dynamicText,
      JSON.stringify(record.sourceMemoryIds),
      JSON.stringify(record.sourceRefIds),
      JSON.stringify(record.citations),
      JSON.stringify(record.conflictIds),
      record.processedMemoryCount,
      record.pendingStmCount,
      record.deferredMemoryCount,
      JSON.stringify(record.deferredRanges),
      record.watermarkLagSeconds,
      record.executionStrategy,
      record.status,
      record.degradedModeReason ?? null,
      record.generatedAt,
      record.expiresAt
    ]);
  }

  async deleteExpiredBackgroundDynamicCaches(expiredAt: string) {
    const before = this.cache.backgroundDynamicCaches.length;
    removeWhere(this.cache.backgroundDynamicCaches, (record) => record.expiresAt <= expiredAt);
    this.exec(`DELETE FROM background_dynamic_cache WHERE expires_at <= ?`, [expiredAt]);
    return before - this.cache.backgroundDynamicCaches.length;
  }

  getSessionBackgroundSnapshot(tenantId: string, principalId: string, sessionId: string) {
    return this.cache.sessionBackgroundSnapshots
      .filter((snapshot) =>
        snapshot.tenantId === tenantId &&
        snapshot.principalId === principalId &&
        snapshot.sessionId === sessionId
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async createSessionBackgroundSnapshot(snapshot: SessionBackgroundSnapshot) {
    assertSessionBackgroundSnapshot(snapshot);
    const existing = this.cache.sessionBackgroundSnapshots.find((item) => item.snapshotId === snapshot.snapshotId);
    if (existing) {
      if (
        existing.tenantId !== snapshot.tenantId ||
        existing.principalId !== snapshot.principalId ||
        existing.sessionId !== snapshot.sessionId
      ) {
        throw new Error(`SESSION_BACKGROUND_SCOPE_CONFLICT:${snapshot.snapshotId}`);
      }
      return existing;
    }
    this.cache.sessionBackgroundSnapshots.push(snapshot);
    this.exec(`INSERT INTO session_background_snapshots (
      snapshot_id, session_id, tenant_id, principal_id, background_id, fixed_revision,
      fixed_text, dynamic_text, dynamic_window_start, dynamic_window_end,
      reference_time, timezone, locale, local_date,
      fixed_source_ref_ids_json, dynamic_source_ref_ids_json, source_memory_ids_json,
      citations_json, conflict_ids_json, latest_stm_cursor_json, dynamic_cache_key,
      cache_hit, execution_strategy, processed_memory_count, pending_stm_count,
      deferred_memory_count, watermark_lag_seconds, generated_at, status,
      degraded_mode_reason, serialized_prompt, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_id) DO NOTHING`, [
      snapshot.snapshotId,
      snapshot.sessionId,
      snapshot.tenantId,
      snapshot.principalId,
      snapshot.backgroundId,
      snapshot.fixedRevision,
      snapshot.fixedText,
      snapshot.dynamicText,
      snapshot.dynamicWindowStart,
      snapshot.dynamicWindowEnd,
      snapshot.referenceTime,
      snapshot.timezone,
      snapshot.locale,
      snapshot.localDate,
      JSON.stringify(snapshot.fixedSourceRefIds),
      JSON.stringify(snapshot.dynamicSourceRefIds),
      JSON.stringify(snapshot.sourceMemoryIds),
      JSON.stringify(snapshot.citations),
      JSON.stringify(snapshot.conflictIds),
      JSON.stringify(snapshot.latestStmCursor),
      snapshot.dynamicCacheKey,
      snapshot.cacheHit ? 1 : 0,
      snapshot.executionStrategy,
      snapshot.processedMemoryCount,
      snapshot.pendingStmCount,
      snapshot.deferredMemoryCount,
      snapshot.watermarkLagSeconds,
      snapshot.generatedAt,
      snapshot.status,
      snapshot.degradedModeReason ?? null,
      snapshot.serializedPrompt,
      snapshot.createdAt
    ]);
    return snapshot;
  }

  async markPermissionInvalidated(sourceRefIds: string[], reason = "permission_revoked") {
    const sourceRefSet = new Set(sourceRefIds);
    const affectedFacts = this.cache.facts.filter((fact) => fact.linkedSourceRefs.some((ref) => sourceRefSet.has(ref.sourceRefId)));
    const affectedShortTermMemories = this.cache.shortTermMemories.filter((memory) => memory.sourceRefs.some((ref) => sourceRefSet.has(ref.sourceRefId)));
    const affectedLongTermMemories = this.cache.longTermMemories.filter((memory) => memory.sourceRefs.some((ref) => sourceRefSet.has(ref.sourceRefId)));
    const affectedIndexEntries = this.cache.indexEntries.filter((entry) =>
      affectedFacts.some((fact) => fact.factId === entry.ownerId) ||
      affectedShortTermMemories.some((memory) => memory.memoryDataId === entry.ownerId) ||
      affectedLongTermMemories.some((memory) => memory.memoryId === entry.ownerId)
    );
    const affectedPackTraces = this.cache.packTraces.filter((trace) =>
      trace.selectedItemIds.some((itemId) =>
        affectedFacts.some((fact) => fact.factId === itemId) ||
        affectedShortTermMemories.some((memory) => memory.memoryDataId === itemId) ||
        affectedLongTermMemories.some((memory) => memory.memoryId === itemId)
      )
    );

    for (const fact of affectedFacts) fact.accessState = "permission-invalid";
    for (const memory of affectedLongTermMemories) memory.accessState = "permission-invalid";

    for (const fact of affectedFacts) {
      await this.saveMemoryChangeEvent({
        eventId: `mce_perm_fact_${fact.factId}_${Date.now()}`,
        memoryDataId: fact.factId,
        changeType: "permission_invalidated",
        storageLayer: "fact",
        reason,
        createdAt: new Date().toISOString()
      });
    }
    for (const memory of affectedShortTermMemories) {
      const updatedAt = new Date().toISOString();
      await this.replaceShortTermMemory({
        ...memory,
        accessState: "permission-invalid",
        updatedAt
      });
      await this.saveMemoryChangeEvent({
        eventId: `mce_perm_stm_${memory.memoryDataId}_${Date.now()}`,
        memoryDataId: memory.memoryDataId,
        changeType: "permission_invalidated",
        storageLayer: "stm",
        reason,
        createdAt: updatedAt
      });
    }
    for (const memory of affectedLongTermMemories) {
      await this.saveMemoryChangeEvent({
        eventId: `mce_perm_ltm_${memory.memoryId}_${Date.now()}`,
        memoryId: memory.memoryId,
        changeType: "permission_invalidated",
        storageLayer: "ltm",
        reason,
        createdAt: new Date().toISOString()
      });
    }

    return {
      affectedFacts: affectedFacts.length,
      affectedShortTermMemories: affectedShortTermMemories.length,
      affectedLongTermMemories: affectedLongTermMemories.length,
      affectedPackTraces: affectedPackTraces.length,
      affectedIndexEntries: affectedIndexEntries.length
    };
  }

  async deleteMemoryEventCascade(
    eventId: string,
    options: { recordChangeEvent?: boolean } = {}
  ): Promise<ContextDeleteResult | undefined> {
    const event = this.memoryEvents.find((item) => item.eventId === eventId);
    if (!event) return undefined;

    const deletedParsedSegmentIds = this.cache.parsedSegments.filter((segment) => segment.eventId === eventId).map((segment) => segment.segmentId);
    const deletedFactIds = this.cache.facts.filter((fact) => fact.linkedEventIds.includes(eventId)).map((fact) => fact.factId);
    const deletedShortTermIds = this.cache.shortTermMemories
      .filter((memory) => memory.memoryDataId === `stm_${eventId}` || memory.sourceFactIds.some((factId) => deletedFactIds.includes(factId)))
      .map((memory) => memory.memoryDataId);
    const deletedLongTermIds = this.cache.longTermMemories
      .filter((memory) => memory.sourceMemoryDataIds.some((memoryDataId) => deletedShortTermIds.includes(memoryDataId)) || memory.entityIds.some((entityId) => deletedFactIds.includes(entityId)))
      .map((memory) => memory.memoryId);
    const deletedRelationEdgeIds = this.cache.relationEdges
      .filter((edge) =>
        deletedFactIds.includes(edge.fromId) ||
        deletedFactIds.includes(edge.toId) ||
        deletedShortTermIds.includes(edge.fromId) ||
        deletedShortTermIds.includes(edge.toId) ||
        deletedLongTermIds.includes(edge.fromId) ||
        deletedLongTermIds.includes(edge.toId)
      )
      .map((edge) => edge.edgeId);
    const deletedPackTraceIds = this.cache.packTraces
      .filter((trace) => trace.selectedItemIds.some((itemId) => deletedFactIds.includes(itemId) || deletedShortTermIds.includes(itemId) || deletedLongTermIds.includes(itemId)))
      .map((trace) => trace.traceId);
    const deletedLlmTraceIds = this.cache.llmFactFusionTraces.filter((trace) => trace.eventId === eventId).map((trace) => trace.traceId);
    const deletedLlmStmAdmissionTraceIds = this.cache.llmStmAdmissionTraces.filter((trace) => trace.eventId === eventId).map((trace) => trace.traceId);
    const deletedLlmDreamingTraceIds = this.cache.llmDreamingTraces
      .filter((trace) => trace.sourceMemoryDataIds.some((memoryDataId) => deletedShortTermIds.includes(memoryDataId)) || trace.parsedMemories.some((memory) => deletedLongTermIds.includes(memory.memoryId)))
      .map((trace) => trace.traceId);
    const deletedTaskIds = this.cache.pipelineTasks.filter((task) => task.eventId === eventId).map((task) => task.taskId);
    const deletedIndexIds = this.cache.indexEntries
      .filter((entry) => deletedFactIds.includes(entry.ownerId) || deletedShortTermIds.includes(entry.ownerId) || deletedLongTermIds.includes(entry.ownerId))
      .map((entry) => entry.indexId);
    const deletedOwnerIds = new Set<string>([
      ...deletedFactIds,
      ...deletedShortTermIds,
      ...deletedLongTermIds
    ]);
    const deletedChangeEventIds = this.cache.changeEvents
      .filter((entry) =>
        entry.memoryDataId === eventId ||
        entry.memoryId === eventId ||
        Boolean(entry.memoryDataId && deletedOwnerIds.has(entry.memoryDataId)) ||
        Boolean(entry.memoryId && deletedOwnerIds.has(entry.memoryId))
      )
      .map((entry) => entry.eventId);

    removeWhere(this.cache.memoryEvents, (item) => item.eventId === eventId);
    this.exec(`DELETE FROM multimodal_data_items WHERE event_id = ?`, [eventId]);
    this.exec(`DELETE FROM event_source_refs WHERE event_id = ?`, [eventId]);
    removeWhere(this.cache.conversationMessageSegments, (record) => deletedParsedSegmentIds.includes(record.segmentId));
    for (const group of this.cache.conversationEvidenceGroups) {
      group.members = group.members.filter((member) => !deletedParsedSegmentIds.includes(member.segmentId));
    }
    for (const candidate of this.cache.conversationFactCandidates) {
      if (candidate.persistedFactId && deletedFactIds.includes(candidate.persistedFactId)) {
        delete candidate.persistedFactId;
      }
    }
    removeWhere(this.cache.parsedSegments, (segment) => segment.eventId === eventId);
    removeWhere(this.cache.facts, (fact) => fact.linkedEventIds.includes(eventId));
    removeWhere(this.cache.factVersions, (version) => deletedFactIds.includes(version.factId));
    const deletedFactBatchIds = this.cache.factBatches
      .filter((batch) => batch.newFactIds.some((factId) => deletedFactIds.includes(factId)))
      .map((batch) => batch.batchId);
    removeWhere(this.cache.factBatches, (batch) => deletedFactBatchIds.includes(batch.batchId));
    const deletedTimelineFusionTaskIds = this.cache.timelineFusionTasks
      .filter((task) => task.batchIds.some((batchId) => deletedFactBatchIds.includes(batchId)))
      .map((task) => task.taskId);
    removeWhere(this.cache.timelineFusionTasks, (task) => deletedTimelineFusionTaskIds.includes(task.taskId));
    const deletedTimelineFusionExecutionFingerprints = this.cache.timelineFusionExecutions
      .filter((execution) =>
        execution.batchIds.some((batchId) => deletedFactBatchIds.includes(batchId)) ||
        execution.newFactIds.some((factId) => deletedFactIds.includes(factId))
      )
      .map((execution) => execution.fingerprint);
    removeWhere(
      this.cache.timelineFusionExecutions,
      (execution) => deletedTimelineFusionExecutionFingerprints.includes(execution.fingerprint)
    );
    removeWhere(this.cache.shortTermMemories, (memory) => memory.memoryDataId === `stm_${eventId}` || memory.sourceFactIds.some((factId) => deletedFactIds.includes(factId)));
    removeWhere(this.cache.longTermMemories, (memory) => memory.sourceMemoryDataIds.some((memoryDataId) => deletedShortTermIds.includes(memoryDataId)) || memory.entityIds.some((entityId) => deletedFactIds.includes(entityId)));
    removeWhere(this.cache.relationEdges, (edge) =>
      deletedFactIds.includes(edge.fromId) ||
      deletedFactIds.includes(edge.toId) ||
      deletedShortTermIds.includes(edge.fromId) ||
      deletedShortTermIds.includes(edge.toId) ||
      deletedLongTermIds.includes(edge.fromId) ||
      deletedLongTermIds.includes(edge.toId)
    );
    removeWhere(this.cache.packTraces, (trace) => trace.selectedItemIds.some((itemId) => deletedFactIds.includes(itemId) || deletedShortTermIds.includes(itemId) || deletedLongTermIds.includes(itemId)));
    removeWhere(this.cache.llmFactFusionTraces, (trace) => trace.eventId === eventId);
    removeWhere(this.cache.llmStmAdmissionTraces, (trace) => trace.eventId === eventId);
    removeWhere(this.cache.llmDreamingTraces, (trace) => trace.sourceMemoryDataIds.some((memoryDataId) => deletedShortTermIds.includes(memoryDataId)) || trace.parsedMemories.some((memory) => deletedLongTermIds.includes(memory.memoryId)));
    removeWhere(this.cache.pipelineTasks, (task) => task.eventId === eventId);
    removeWhere(this.cache.indexEntries, (entry) => deletedFactIds.includes(entry.ownerId) || deletedShortTermIds.includes(entry.ownerId) || deletedLongTermIds.includes(entry.ownerId));
    removeWhere(this.cache.textIndexEntries, (entry) => deletedFactIds.includes(entry.ownerId) || deletedShortTermIds.includes(entry.ownerId) || deletedLongTermIds.includes(entry.ownerId));
    removeWhere(this.cache.vectorIndexEntries, (entry) => deletedFactIds.includes(entry.ownerId) || deletedShortTermIds.includes(entry.ownerId) || deletedLongTermIds.includes(entry.ownerId));
    removeWhere(this.cache.graphMemoryNodes, (node) => deletedShortTermIds.includes(node.ownerId) || deletedLongTermIds.includes(node.ownerId));
    removeWhere(this.cache.changeEvents, (entry) => deletedChangeEventIds.includes(entry.eventId));
    removeWhere(this.cache.retrievalEvents, (entry) => deletedOwnerIds.has(entry.ownerId));
    this.exec(`DELETE FROM memory_events WHERE event_id = ?`, [eventId]);
    for (const ownerId of deletedOwnerIds) {
      this.exec(`DELETE FROM memory_retrieval_events WHERE owner_id = ?`, [ownerId]);
    }
    this.exec(`DELETE FROM parsed_segments WHERE event_id = ?`, [eventId]);
    for (const factId of deletedFactIds) {
      this.exec(`DELETE FROM fact_items WHERE fact_id = ?`, [factId]);
      await this.deleteIndexBundle("fact", factId);
    }
    for (const batchId of deletedFactBatchIds) {
      this.exec(`DELETE FROM fact_batches WHERE batch_id = ?`, [batchId]);
    }
    for (const taskId of deletedTimelineFusionTaskIds) {
      this.exec(`DELETE FROM timeline_fusion_tasks WHERE task_id = ?`, [taskId]);
    }
    for (const fingerprint of deletedTimelineFusionExecutionFingerprints) {
      this.exec(`DELETE FROM timeline_fusion_executions WHERE fingerprint = ?`, [fingerprint]);
    }
    for (const memoryDataId of deletedShortTermIds) {
      this.exec(`DELETE FROM short_term_memories WHERE memory_data_id = ?`, [memoryDataId]);
      await this.deleteIndexBundle("stm", memoryDataId);
    }
    for (const memoryId of deletedLongTermIds) {
      this.exec(`DELETE FROM long_term_memories WHERE memory_id = ?`, [memoryId]);
      await this.deleteIndexBundle("ltm", memoryId);
    }
    for (const edgeId of deletedRelationEdgeIds) {
      this.exec(`DELETE FROM relation_edges WHERE edge_id = ?`, [edgeId]);
    }
    for (const traceId of deletedPackTraceIds) {
      this.exec(`DELETE FROM context_pack_traces WHERE trace_id = ?`, [traceId]);
    }
    for (const traceId of deletedLlmTraceIds) {
      this.exec(`DELETE FROM llm_fact_fusion_traces WHERE trace_id = ?`, [traceId]);
    }
    for (const traceId of deletedLlmStmAdmissionTraceIds) {
      this.exec(`DELETE FROM llm_stm_admission_traces WHERE trace_id = ?`, [traceId]);
    }
    for (const traceId of deletedLlmDreamingTraceIds) {
      this.exec(`DELETE FROM llm_dreaming_traces WHERE trace_id = ?`, [traceId]);
    }
    for (const taskId of deletedTaskIds) {
      this.exec(`DELETE FROM context_pipeline_tasks WHERE task_id = ?`, [taskId]);
    }
    for (const changeEventId of deletedChangeEventIds) {
      this.exec(`DELETE FROM memory_change_events WHERE event_id = ?`, [changeEventId]);
    }
    await this.graphStore?.deleteGraphRelationEdges(deletedRelationEdgeIds);

    if (options.recordChangeEvent !== false) {
      await this.saveMemoryChangeEvent({
        eventId: `mce_delete_${eventId}_${Date.now()}`,
        memoryDataId: eventId,
        changeType: "deleted",
        storageLayer: "fact",
        reason: "context_data_deleted",
        createdAt: new Date().toISOString()
      });
    }

    return {
      eventId,
      deleted: {
        memoryEvents: 1,
        parsedSegments: deletedParsedSegmentIds.length,
        facts: deletedFactIds.length,
        shortTermMemories: deletedShortTermIds.length,
        longTermMemories: deletedLongTermIds.length,
        relationEdges: deletedRelationEdgeIds.length,
        packTraces: deletedPackTraceIds.length,
        llmFactFusionTraces: deletedLlmTraceIds.length,
        llmStmAdmissionTraces: deletedLlmStmAdmissionTraceIds.length,
        llmDreamingTraces: deletedLlmDreamingTraceIds.length,
        pipelineTasks: deletedTaskIds.length,
        indexEntries: deletedIndexIds.length
      }
    };
  }

  async clearAllContextData(): Promise<ContextClearResult> {
    const deleted: ContextClearResult["deleted"] = {
      memoryEvents: this.memoryEvents.length,
      parsedSegments: this.parsedSegments.length,
      facts: this.facts.length,
      shortTermMemories: this.shortTermMemories.length,
      longTermMemories: this.longTermMemories.length,
      relationEdges: this.relationEdges.length,
      packTraces: this.packTraces.length,
      llmFactFusionTraces: this.llmFactFusionTraces.length,
      llmStmAdmissionTraces: this.llmStmAdmissionTraces.length,
      llmDreamingTraces: this.llmDreamingTraces.length,
      pipelineTasks: this.pipelineTasks.length,
      indexEntries: this.indexEntries.length,
      changeEvents: this.changeEvents.length
    };
    this.cache.memoryEvents.length = 0;
    this.cache.parsedSegments.length = 0;
    this.cache.facts.length = 0;
    this.cache.factVersions.length = 0;
    this.cache.factBatches.length = 0;
    this.cache.timelineFusionTasks.length = 0;
    this.cache.timelineFusionExecutions.length = 0;
    this.cache.shortTermMemories.length = 0;
    this.cache.longTermMemories.length = 0;
    this.cache.relationEdges.length = 0;
    this.cache.packTraces.length = 0;
    this.cache.llmFactFusionTraces.length = 0;
    this.cache.llmStmAdmissionTraces.length = 0;
    this.cache.llmDreamingTraces.length = 0;
    this.cache.pipelineTasks.length = 0;
    this.cache.indexEntries.length = 0;
    this.cache.textIndexEntries.length = 0;
    this.cache.vectorIndexEntries.length = 0;
    this.cache.graphMemoryNodes.length = 0;
    this.cache.changeEvents.length = 0;
    this.cache.feedbackItems.length = 0;
    this.cache.retrievalEvents.length = 0;
    this.cache.dreamingCandidateDecisions.length = 0;
    this.cache.dreamingOutbox.length = 0;
    this.cache.dreamingRuns.length = 0;
    this.cache.dreamingRunCandidates.length = 0;
    this.cache.backgroundDocuments.length = 0;
    this.cache.backgroundMaintenanceTasks.length = 0;
    this.cache.backgroundMaintenanceBatches.length = 0;
    this.cache.backgroundDynamicCaches.length = 0;
    this.cache.sessionBackgroundSnapshots.length = 0;
    this.cache.conversationIngestions.length = 0;
    this.cache.conversationBatchIngestions.length = 0;
    this.cache.conversationDocuments.length = 0;
    this.cache.conversationMessages.length = 0;
    this.cache.conversationSessionCursors.length = 0;
    this.cache.conversationIngestionJobs.length = 0;
    this.cache.conversationMessageSegments.length = 0;
    this.cache.conversationEvidenceGroups.length = 0;
    this.cache.conversationExtractionWindows.length = 0;
    this.cache.conversationFactCandidates.length = 0;
    this.cache.conversationDocumentMessageRows.length = 0;
    await this.graphStore?.clearGraph();
    return { deleted };
  }

  clearLoadedCache() {
    this.cache.memoryEvents.length = 0;
    this.cache.parsedSegments.length = 0;
    this.cache.facts.length = 0;
    this.cache.factVersions.length = 0;
    this.cache.factBatches.length = 0;
    this.cache.timelineFusionTasks.length = 0;
    this.cache.timelineFusionExecutions.length = 0;
    this.cache.shortTermMemories.length = 0;
    this.cache.longTermMemories.length = 0;
    this.cache.relationEdges.length = 0;
    this.cache.packTraces.length = 0;
    this.cache.llmFactFusionTraces.length = 0;
    this.cache.llmStmAdmissionTraces.length = 0;
    this.cache.llmDreamingTraces.length = 0;
    this.cache.pipelineTasks.length = 0;
    this.cache.indexEntries.length = 0;
    this.cache.textIndexEntries.length = 0;
    this.cache.vectorIndexEntries.length = 0;
    this.cache.graphMemoryNodes.length = 0;
    this.cache.changeEvents.length = 0;
    this.cache.feedbackItems.length = 0;
    this.cache.retrievalEvents.length = 0;
    this.cache.dreamingCandidateDecisions.length = 0;
    this.cache.dreamingOutbox.length = 0;
    this.cache.dreamingRuns.length = 0;
    this.cache.dreamingRunCandidates.length = 0;
    this.cache.backgroundDocuments.length = 0;
    this.cache.backgroundMaintenanceTasks.length = 0;
    this.cache.backgroundMaintenanceBatches.length = 0;
    this.cache.backgroundDynamicCaches.length = 0;
    this.cache.sessionBackgroundSnapshots.length = 0;
    this.cache.conversationIngestions.length = 0;
    this.cache.conversationBatchIngestions.length = 0;
    this.cache.conversationDocuments.length = 0;
    this.cache.conversationMessages.length = 0;
    this.cache.conversationSessionCursors.length = 0;
    this.cache.conversationIngestionJobs.length = 0;
    this.cache.conversationMessageSegments.length = 0;
    this.cache.conversationEvidenceGroups.length = 0;
    this.cache.conversationExtractionWindows.length = 0;
    this.cache.conversationFactCandidates.length = 0;
    this.cache.conversationDocumentMessageRows.length = 0;
  }

  evictLoadedCacheByContextScopeId(contextScopeId: string) {
    const eventIds = new Set(
      this.cache.memoryEvents
        .filter((event) => event.contextScopeId === contextScopeId)
        .map((event) => event.eventId)
    );
    const segmentIds = new Set(
      this.cache.parsedSegments
        .filter((segment) => eventIds.has(segment.eventId))
        .map((segment) => segment.segmentId)
    );
    const factIds = new Set(
      this.cache.facts
        .filter((fact) =>
          fact.contextScopeId === contextScopeId ||
          fact.linkedEventIds.some((eventId) => eventIds.has(eventId)) ||
          fact.linkedSegmentIds.some((segmentId) => segmentIds.has(segmentId))
        )
        .map((fact) => fact.factId)
    );
    const factBatchIds = new Set(
      this.cache.factBatches
        .filter((batch) =>
          batch.contextScopeId === contextScopeId ||
          batch.newFactIds.some((factId) => factIds.has(factId))
        )
        .map((batch) => batch.batchId)
    );
    const timelineTaskIds = new Set(
      this.cache.timelineFusionTasks
        .filter((task) =>
          task.contextScopeId === contextScopeId ||
          task.batchIds.some((batchId) => factBatchIds.has(batchId)) ||
          task.newFactIds.some((factId) => factIds.has(factId))
        )
        .map((task) => task.taskId)
    );
    const shortTermMemoryIds = new Set(
      this.cache.shortTermMemories
        .filter((memory) => memory.sourceFactIds.some((factId) => factIds.has(factId)))
        .map((memory) => memory.memoryDataId)
    );
    const longTermMemoryIds = new Set(
      this.cache.longTermMemories
        .filter((memory) =>
          memory.sourceMemoryDataIds.some((memoryDataId) => shortTermMemoryIds.has(memoryDataId)) ||
          memory.sourceFactIds?.some((factId) => factIds.has(factId)) ||
          memory.entityIds.some((entityId) => factIds.has(entityId))
        )
        .map((memory) => memory.memoryId)
    );
    const ownerIds = new Set([...factIds, ...shortTermMemoryIds, ...longTermMemoryIds]);
    const graphNodeIds = new Set(
      this.cache.graphMemoryNodes
        .filter((node) => ownerIds.has(node.ownerId))
        .map((node) => node.graphNodeId)
    );
    const relatedIds = new Set([...ownerIds, ...graphNodeIds]);
    const dreamingTraceIds = new Set(
      this.cache.llmDreamingTraces
        .filter((trace) =>
          trace.sourceMemoryDataIds.some((memoryDataId) => shortTermMemoryIds.has(memoryDataId)) ||
          trace.parsedMemories.some((memory) => longTermMemoryIds.has(memory.memoryId))
        )
        .map((trace) => trace.traceId)
    );
    const dreamingDecisionIds = new Set(
      this.cache.dreamingCandidateDecisions
        .filter((decision) => shortTermMemoryIds.has(decision.memoryDataId))
        .map((decision) => decision.decisionId)
    );

    removeWhere(this.cache.memoryEvents, (event) => eventIds.has(event.eventId));
    removeWhere(this.cache.parsedSegments, (segment) => eventIds.has(segment.eventId));
    removeWhere(this.cache.facts, (fact) => factIds.has(fact.factId));
    removeWhere(this.cache.factVersions, (version) => factIds.has(version.factId));
    removeWhere(this.cache.factBatches, (batch) => factBatchIds.has(batch.batchId));
    removeWhere(this.cache.timelineFusionTasks, (task) => timelineTaskIds.has(task.taskId));
    removeWhere(this.cache.timelineFusionExecutions, (execution) =>
      execution.contextScopeId === contextScopeId ||
      execution.taskIds.some((taskId) => timelineTaskIds.has(taskId)) ||
      execution.batchIds.some((batchId) => factBatchIds.has(batchId)) ||
      execution.newFactIds.some((factId) => factIds.has(factId)) ||
      execution.resultFactIds.some((factId) => factIds.has(factId))
    );
    removeWhere(this.cache.shortTermMemories, (memory) => shortTermMemoryIds.has(memory.memoryDataId));
    removeWhere(this.cache.longTermMemories, (memory) => longTermMemoryIds.has(memory.memoryId));
    removeWhere(this.cache.relationEdges, (edge) => relatedIds.has(edge.fromId) || relatedIds.has(edge.toId));
    removeWhere(this.cache.packTraces, (trace) => trace.selectedItemIds.some((itemId) => ownerIds.has(itemId)));
    removeWhere(this.cache.llmFactFusionTraces, (trace) => eventIds.has(trace.eventId));
    removeWhere(this.cache.llmStmAdmissionTraces, (trace) => eventIds.has(trace.eventId));
    removeWhere(this.cache.llmDreamingTraces, (trace) => dreamingTraceIds.has(trace.traceId));
    removeWhere(this.cache.pipelineTasks, (task) => eventIds.has(task.eventId));
    removeWhere(this.cache.indexEntries, (entry) => ownerIds.has(entry.ownerId));
    removeWhere(this.cache.textIndexEntries, (entry) => ownerIds.has(entry.ownerId));
    removeWhere(this.cache.vectorIndexEntries, (entry) => ownerIds.has(entry.ownerId));
    removeWhere(this.cache.graphMemoryNodes, (node) => ownerIds.has(node.ownerId));
    removeWhere(this.cache.changeEvents, (event) =>
      Boolean(event.memoryId && relatedIds.has(event.memoryId)) ||
      Boolean(event.memoryDataId && relatedIds.has(event.memoryDataId))
    );
    removeWhere(this.cache.feedbackItems, (feedback) => ownerIds.has(feedback.targetId));
    removeWhere(this.cache.retrievalEvents, (event) => ownerIds.has(event.ownerId));
    removeWhere(this.cache.dreamingCandidateDecisions, (decision) => shortTermMemoryIds.has(decision.memoryDataId));
    removeWhere(this.cache.dreamingOutbox, (record) => ownerIds.has(record.ownerId));
    removeWhere(this.cache.dreamingRunCandidates, (candidate) =>
      shortTermMemoryIds.has(candidate.memoryDataId) ||
      Boolean(candidate.resultLtmId && longTermMemoryIds.has(candidate.resultLtmId)) ||
      Boolean(candidate.decisionId && dreamingDecisionIds.has(candidate.decisionId)) ||
      Boolean(candidate.traceId && dreamingTraceIds.has(candidate.traceId))
    );
  }

  getDebugSnapshot(): ContextDebugSnapshot {
    return {
      memoryEvents: this.memoryEvents,
      parsedSegments: this.parsedSegments,
      facts: this.facts,
      factVersions: this.factVersions,
      factBatches: this.factBatches,
      timelineFusionTasks: this.timelineFusionTasks,
      timelineFusionExecutions: this.timelineFusionExecutions,
      shortTermMemories: this.shortTermMemories,
      longTermMemories: this.longTermMemories,
      graphMemoryNodes: this.graphMemoryNodes,
      relationEdges: this.relationEdges,
      packTraces: this.packTraces,
      llmFactFusionTraces: this.llmFactFusionTraces,
      llmStmAdmissionTraces: this.llmStmAdmissionTraces,
      llmDreamingTraces: this.llmDreamingTraces,
      pipelineTasks: this.pipelineTasks,
      indexEntries: this.indexEntries,
      textIndexEntries: this.textIndexEntries,
      vectorIndexEntries: this.vectorIndexEntries,
      changeEvents: this.changeEvents,
      feedbackItems: this.feedbackItems,
      retrievalEvents: this.retrievalEvents,
      dreamingCandidateDecisions: this.dreamingCandidateDecisions,
      dreamingOutbox: this.dreamingOutbox,
      dreamingRuns: this.dreamingRuns,
      dreamingRunCandidates: this.dreamingRunCandidates,
      backgroundDocuments: this.backgroundDocuments,
      backgroundMaintenanceTasks: this.backgroundMaintenanceTasks,
      backgroundMaintenanceBatches: this.backgroundMaintenanceBatches,
      backgroundDynamicCaches: this.backgroundDynamicCaches,
      sessionBackgroundSnapshots: this.sessionBackgroundSnapshots,
      conversationBatchIngestions: this.conversationBatchIngestions,
      conversationIngestions: this.conversationIngestions,
      conversationDocuments: this.conversationDocuments,
      conversationMessages: this.conversationMessages,
      conversationSessionCursors: this.conversationSessionCursors,
      conversationIngestionJobs: this.conversationIngestionJobs,
      conversationMessageSegments: this.conversationMessageSegments,
      conversationEvidenceGroups: this.conversationEvidenceGroups,
      conversationExtractionWindows: this.conversationExtractionWindows,
      conversationFactCandidates: this.conversationFactCandidates,
      conversationDocumentMessageRows: this.conversationDocumentMessageRows,
      conversationTemporalBackfillMigrations: this.conversationTemporalBackfillMigrations
    };
  }

  private filterGraphNodes(options: GraphMemorySearchOptions): GraphMemoryNode[] {
    const ownerTypes = new Set(options.ownerTypes ?? ["stm", "ltm"]);
    const ownerKeys = options.ownerKeys ? new Set(options.ownerKeys) : undefined;
    return this.cache.graphMemoryNodes.filter((node) =>
      ownerTypes.has(node.ownerType) &&
      this.hasGraphNodeOwner(node) &&
      (!ownerKeys || ownerKeys.has(`${node.ownerType}:${node.ownerId}`)) &&
      (!options.temporalRange || memoryTemporalEnvelopeIntersects(node, options.temporalRange))
    );
  }

  private hasGraphNodeOwner(node: GraphMemoryNode) {
    if (node.ownerType === "stm") {
      return this.cache.shortTermMemories.some((memory) => memory.memoryDataId === node.ownerId);
    }
    return this.cache.longTermMemories.some((memory) => memory.memoryId === node.ownerId);
  }
}

export class FileBackedContextEngineRepository extends InMemoryContextEngineRepository {
  private readonly storePath: string;

  constructor(storePath = getContextEngineConfig().storage.storePath, graphStore?: GraphMemoryStore) {
    super(graphStore);
    this.storePath = resolve(storePath);
    this.loadFromDisk();
  }

  override async saveMemoryEvent(event: MemoryEvent) {
    await super.saveMemoryEvent(event);
    this.persist();
  }

  override async saveParsedSegment(segment: ParsedSegment) {
    await super.saveParsedSegment(segment);
    this.persist();
  }

  override async saveFactItem(fact: FactItem) {
    await super.saveFactItem(fact);
    this.persist();
  }

  override async saveFactVersion(version: FactVersion) {
    const saved = await super.saveFactVersion(version);
    this.persist();
    return saved;
  }

  override async commitTimelineFusionFactStore(
    input: Parameters<InMemoryContextEngineRepository["commitTimelineFusionFactStore"]>[0]
  ) {
    try {
      const result = await super.commitTimelineFusionFactStore(input);
      this.persist();
      return result;
    } catch (error) {
      this.persist();
      throw error;
    }
  }

  override async saveFactBatchCommitted(batch: FactBatchCommitted) {
    const committed = await super.saveFactBatchCommitted(batch);
    this.persist();
    return committed;
  }

  override async saveTimelineFusionTask(task: TimelineFusionTask) {
    await super.saveTimelineFusionTask(task);
    this.persist();
  }

  override async reserveTimelineFusionExecution(execution: TimelineFusionExecution) {
    const reserved = await super.reserveTimelineFusionExecution(execution);
    this.persist();
    return reserved;
  }

  override async saveTimelineFusionExecution(execution: TimelineFusionExecution) {
    await super.saveTimelineFusionExecution(execution);
    this.persist();
  }

  override async replaceShortTermMemory(memory: ShortTermMemory) {
    await super.replaceShortTermMemory(memory);
    this.persist();
  }

  override async replaceLongTermMemory(memory: LongTermMemory) {
    await super.replaceLongTermMemory(memory);
    this.persist();
  }

  override async backfillConversationMessages(request: BackfillConversationMessagesRequest) {
    const result = await super.backfillConversationMessages(request);
    this.persist();
    return result;
  }

  override async saveConversationTemporalBackfillMigration(record: ConversationTemporalBackfillMigrationRecord) {
    await super.saveConversationTemporalBackfillMigration(record);
    this.persist();
  }

  override async saveRelationEdge(edge: RelationEdge) {
    await super.saveRelationEdge(edge);
    this.persist();
  }

  override async saveContextPackTrace(trace: ContextPackTrace) {
    await super.saveContextPackTrace(trace);
    this.persist();
  }

  override async saveLlmFactFusionTrace(trace: LlmFactFusionTrace) {
    await super.saveLlmFactFusionTrace(trace);
    this.persist();
  }

  override async saveLlmStmAdmissionTrace(trace: LlmStmAdmissionTrace) {
    await super.saveLlmStmAdmissionTrace(trace);
    this.persist();
  }

  override async saveLlmDreamingTrace(trace: LlmDreamingTrace) {
    await super.saveLlmDreamingTrace(trace);
    this.persist();
  }

  override async savePipelineTask(task: ContextPipelineTask) {
    await super.savePipelineTask(task);
    this.persist();
  }

  override async saveDreamingCandidateDecision(decision: DreamingCandidateDecision) {
    await super.saveDreamingCandidateDecision(decision);
    this.persist();
  }

  override async saveDreamingRun(run: DreamingRun) {
    await super.saveDreamingRun(run);
    this.persist();
  }

  override async saveDreamingRunCandidate(candidate: DreamingRunCandidate) {
    await super.saveDreamingRunCandidate(candidate);
    this.persist();
  }

  override async deleteShortTermMemory(memoryDataId: string) {
    await super.deleteShortTermMemory(memoryDataId);
    this.persist();
  }

  override async deleteShortTermMemoryArtifacts(memoryDataId: string) {
    await super.deleteShortTermMemoryArtifacts(memoryDataId);
    this.persist();
  }

  override async saveDreamingOutbox(record: DreamingOutboxRecord) {
    await super.saveDreamingOutbox(record);
    this.persist();
  }

  override async withDreamingTransaction<T>(callback: () => Promise<T>): Promise<T> {
    try {
      return await super.withDreamingTransaction(callback);
    } catch (error) {
      // Persist the restored in-memory snapshot after a failed transaction.
      this.persist();
      throw error;
    }
  }

  override async saveIndexEntry(entry: ContextIndexEntry) {
    await super.saveIndexEntry(entry);
    this.persist();
  }

  override async saveTextIndexEntry(entry: ContextTextIndexEntry) {
    await super.saveTextIndexEntry(entry);
    this.persist();
  }

  override async saveVectorIndexEntry(entry: ContextVectorIndexEntry) {
    await super.saveVectorIndexEntry(entry);
    this.persist();
  }

  override async upsertGraphMemoryNode(node: GraphMemoryNode) {
    await super.upsertGraphMemoryNode(node);
    this.persist();
  }

  override async deleteGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string) {
    await super.deleteGraphMemoryNode(ownerType, ownerId);
    this.persist();
  }

  override async deleteIndexEntry(indexId: string) {
    await super.deleteIndexEntry(indexId);
    this.persist();
  }

  override async deleteTextIndexEntry(indexId: string) {
    await super.deleteTextIndexEntry(indexId);
    this.persist();
  }

  override async deleteVectorIndexEntry(indexId: string) {
    await super.deleteVectorIndexEntry(indexId);
    this.persist();
  }

  override async deleteIndexBundle(ownerType: "fact" | "stm" | "ltm", ownerId: string) {
    await super.deleteIndexBundle(ownerType, ownerId);
    this.persist();
  }

  override async saveMemoryChangeEvent(event: MemoryChangeEvent) {
    await super.saveMemoryChangeEvent(event);
    this.persist();
  }

  override async saveMemoryFeedback(item: MemoryFeedbackItem) {
    await super.saveMemoryFeedback(item);
    this.persist();
  }

  override async saveMemoryRetrievalEvent(event: MemoryRetrievalEvent) {
    await super.saveMemoryRetrievalEvent(event);
    this.persist();
  }

  override async saveBackgroundDocument(item: BackgroundContextDocument) {
    await super.saveBackgroundDocument(item);
    this.persist();
  }

  override async createBackgroundMaintenanceTask(task: BackgroundMaintenanceTask) {
    const result = await super.createBackgroundMaintenanceTask(task);
    this.persist();
    return result;
  }

  override async claimBackgroundMaintenanceTask(input: {
    taskId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }) {
    const result = await super.claimBackgroundMaintenanceTask(input);
    this.persist();
    return result;
  }

  override async saveBackgroundMaintenanceTask(task: BackgroundMaintenanceTask) {
    await super.saveBackgroundMaintenanceTask(task);
    this.persist();
  }

  override async saveBackgroundMaintenanceBatch(batch: BackgroundMaintenanceBatch) {
    await super.saveBackgroundMaintenanceBatch(batch);
    this.persist();
  }

  override async commitBackgroundMaintenanceCheckpoint(input: CommitBackgroundMaintenanceCheckpointRequest) {
    await super.commitBackgroundMaintenanceCheckpoint(input);
    this.persist();
  }

  override async commitFixedBackgroundMaintenance(input: CommitFixedBackgroundMaintenanceRequest) {
    await super.commitFixedBackgroundMaintenance(input);
    this.persist();
  }

  override async saveBackgroundDynamicCache(record: BackgroundDynamicCacheRecord) {
    await super.saveBackgroundDynamicCache(record);
    this.persist();
  }

  override async deleteExpiredBackgroundDynamicCaches(expiredAt: string) {
    const deleted = await super.deleteExpiredBackgroundDynamicCaches(expiredAt);
    if (deleted) this.persist();
    return deleted;
  }

  override async createSessionBackgroundSnapshot(snapshot: SessionBackgroundSnapshot) {
    const result = await super.createSessionBackgroundSnapshot(snapshot);
    this.persist();
    return result;
  }

  override async markPermissionInvalidated(sourceRefIds: string[], reason?: string) {
    const result = await super.markPermissionInvalidated(sourceRefIds, reason);
    this.persist();
    return result;
  }

  override async deleteMemoryEventCascade(eventId: string, options: { recordChangeEvent?: boolean } = {}) {
    const result = await super.deleteMemoryEventCascade(eventId, options);
    this.persist();
    return result;
  }

  override async clearAllContextData() {
    const result = await super.clearAllContextData();
    this.persist();
    return result;
  }

  private loadFromDisk() {
    if (!existsSync(this.storePath)) return;
    const raw = readFileSync(this.storePath, "utf8");
    if (!raw.trim()) return;
    const snapshot = JSON.parse(raw) as Partial<ContextDebugSnapshot>;
    appendAll(this.memoryEvents, snapshot.memoryEvents ?? []);
    appendAll(this.parsedSegments, snapshot.parsedSegments ?? []);
    appendAll(this.facts, snapshot.facts ?? []);
    appendAll(this.factVersions, snapshot.factVersions ?? []);
    appendAll(this.factBatches, snapshot.factBatches ?? []);
    appendAll(
      this.timelineFusionTasks,
      (snapshot.timelineFusionTasks ?? []).map(normalizeTimelineFusionTask)
    );
    appendAll(
      this.timelineFusionExecutions,
      (snapshot.timelineFusionExecutions ?? []).map(normalizeTimelineFusionExecution)
    );
    appendAll(this.shortTermMemories, (snapshot.shortTermMemories ?? []).map((memory) => ({
      ...memory,
      memoryType: normalizePrdMemoryType(memory.memoryType, "fact"),
      retrievalWeight: memory.retrievalWeight ?? shortTermRetrievalWeight(memory.importanceLevel)
    })));
    appendAll(this.longTermMemories, (snapshot.longTermMemories ?? []).map((memory) => ({
      ...memory,
      memoryType: normalizePrdMemoryType(memory.memoryType, "knowledge"),
      retrievalWeight: memory.retrievalWeight ?? longTermRetrievalWeight(memory.recallWeight)
    })));
    appendAll(this.relationEdges, snapshot.relationEdges ?? []);
    appendAll(this.packTraces, snapshot.packTraces ?? []);
    appendAll(this.llmFactFusionTraces, snapshot.llmFactFusionTraces ?? []);
    appendAll(this.llmStmAdmissionTraces, snapshot.llmStmAdmissionTraces ?? []);
    appendAll(this.llmDreamingTraces, snapshot.llmDreamingTraces ?? []);
    appendAll(this.pipelineTasks, snapshot.pipelineTasks ?? []);
    appendAll(this.indexEntries, snapshot.indexEntries ?? []);
    appendAll(this.textIndexEntries, snapshot.textIndexEntries ?? []);
    appendAll(this.vectorIndexEntries, snapshot.vectorIndexEntries ?? []);
    appendAll(this.graphMemoryNodes, (snapshot.graphMemoryNodes ?? []).map((node) => ({
      ...node,
      retrievalWeight: node.retrievalWeight ?? 0.3
    })));
    appendAll(this.changeEvents, snapshot.changeEvents ?? []);
    appendAll(this.feedbackItems, snapshot.feedbackItems ?? []);
    appendAll(this.retrievalEvents, snapshot.retrievalEvents ?? []);
    appendAll(this.dreamingCandidateDecisions, snapshot.dreamingCandidateDecisions ?? []);
    appendAll(this.dreamingOutbox, snapshot.dreamingOutbox ?? []);
    appendAll(this.dreamingRuns, snapshot.dreamingRuns ?? []);
    appendAll(this.dreamingRunCandidates, snapshot.dreamingRunCandidates ?? []);
    appendAll(this.backgroundDocuments, snapshot.backgroundDocuments ?? []);
    appendAll(this.backgroundMaintenanceTasks, snapshot.backgroundMaintenanceTasks ?? []);
    appendAll(this.backgroundMaintenanceBatches, snapshot.backgroundMaintenanceBatches ?? []);
    appendAll(this.backgroundDynamicCaches, snapshot.backgroundDynamicCaches ?? []);
    appendAll(this.sessionBackgroundSnapshots, snapshot.sessionBackgroundSnapshots ?? []);
    appendAll(this.conversationBatchIngestions, snapshot.conversationBatchIngestions ?? []);
    appendAll(this.conversationIngestions, snapshot.conversationIngestions ?? []);
    appendAll(this.conversationDocuments, snapshot.conversationDocuments ?? []);
    appendAll(this.conversationMessages, snapshot.conversationMessages ?? []);
    appendAll(this.conversationSessionCursors, snapshot.conversationSessionCursors ?? []);
    appendAll(this.conversationIngestionJobs, snapshot.conversationIngestionJobs ?? []);
    appendAll(this.conversationMessageSegments, snapshot.conversationMessageSegments ?? []);
    appendAll(this.conversationEvidenceGroups, snapshot.conversationEvidenceGroups ?? []);
    appendAll(this.conversationExtractionWindows, snapshot.conversationExtractionWindows ?? []);
    appendAll(this.conversationFactCandidates, snapshot.conversationFactCandidates ?? []);
    appendAll(this.conversationDocumentMessageRows, snapshot.conversationDocumentMessageRows ?? []);
    appendAll(this.conversationTemporalBackfillMigrations, snapshot.conversationTemporalBackfillMigrations ?? []);
  }

  private persist() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.getDebugSnapshot(), null, 2));
  }
}

export interface SqliteContextEngineRepositoryOptions {
  loadCache?: boolean;
  readOnly?: boolean;
}

export class SqliteContextEngineRepository extends InMemoryContextEngineRepository {
  private readonly db: DatabaseSync;

  constructor(
    storePath = getContextEngineConfig().storage.storePath,
    graphStore?: GraphMemoryStore,
    options: SqliteContextEngineRepositoryOptions = {}
  ) {
    const sqlitePath = resolve(storePath.replace(/\.json$/u, ".sqlite"));
    if (!options.readOnly) mkdirSync(dirname(sqlitePath), { recursive: true });
    super(graphStore);
    this.db = options.readOnly
      ? new DatabaseSync(sqlitePath, { readOnly: true })
      : new DatabaseSync(sqlitePath);
    this.db.exec("PRAGMA busy_timeout=5000;");
    if (!options.readOnly) {
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA foreign_keys=ON;");
      this.db.exec(schemaSql);
      this.applyMigrations();
    }
    if (options.loadCache !== false) {
      this.loadFromDatabase();
    }
  }
  protected override exec(sql: string, params: Array<unknown> = []) {
    this.db.prepare(sql).run(...(params as never[]));
    super.exec(sql, params);
  }

  close() {
    this.db.close();
  }

  override getFactBatchCommitted(batchId: string): FactBatchCommitted | undefined {
    const row = this.db.prepare(`
      SELECT
        batch_id AS batchId,
        trigger_type AS triggerType,
        tenant_id AS tenantId,
        principal_id AS principalId,
        context_scope_id AS contextScopeId,
        new_fact_ids AS newFactIds,
        committed_at AS committedAt
      FROM fact_batches
      WHERE batch_id = ?
      LIMIT 1
    `).get(batchId) as Record<string, unknown> | undefined;
    return row ? normalizeFactBatchRow(normalizeRow(row)) : undefined;
  }

  override getTimelineFusionTask(taskId: string): TimelineFusionTask | undefined {
    const row = this.db.prepare(`
      SELECT
        task_id AS taskId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        context_scope_id AS contextScopeId,
        batch_ids AS batchIds,
        new_fact_ids AS newFactIds,
        status,
        scheduled_at AS scheduledAt,
        deadline_at AS deadlineAt,
        ready_at AS readyAt,
        execution_fingerprints AS executionFingerprints,
        completion_reason AS completionReason,
        completed_at AS completedAt,
        error,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM timeline_fusion_tasks
      WHERE task_id = ?
      LIMIT 1
    `).get(taskId) as Record<string, unknown> | undefined;
    return row ? normalizeTimelineFusionTaskRow(normalizeRow(row)) : undefined;
  }

  override listTimelineFusionTasks(query: {
    tenantId?: string;
    principalId?: string;
    contextScopeId?: string;
    statuses?: TimelineFusionTask["status"][];
  } = {}): TimelineFusionTask[] {
    const clauses = ["1 = 1"];
    const params: unknown[] = [];
    if (query.tenantId) {
      clauses.push("tenant_id = ?");
      params.push(query.tenantId);
    }
    if (query.principalId) {
      clauses.push("principal_id = ?");
      params.push(query.principalId);
    }
    if (query.contextScopeId) {
      clauses.push("context_scope_id = ?");
      params.push(query.contextScopeId);
    }
    if (query.statuses?.length) {
      clauses.push(`status IN (${sqlPlaceholders(query.statuses.length)})`);
      params.push(...query.statuses);
    }
    return this.db.prepare(`
      SELECT
        task_id AS taskId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        context_scope_id AS contextScopeId,
        batch_ids AS batchIds,
        new_fact_ids AS newFactIds,
        status,
        scheduled_at AS scheduledAt,
        deadline_at AS deadlineAt,
        ready_at AS readyAt,
        execution_fingerprints AS executionFingerprints,
        completion_reason AS completionReason,
        completed_at AS completedAt,
        error,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM timeline_fusion_tasks
      WHERE ${clauses.join(" AND ")}
      ORDER BY scheduled_at, task_id
    `).all(...(params as never[])).map((row) =>
      normalizeTimelineFusionTaskRow(normalizeRow(row as Record<string, unknown>))
    );
  }

  override async reserveTimelineFusionExecution(
    execution: TimelineFusionExecution
  ): Promise<TimelineFusionExecution> {
    const normalized = normalizeTimelineFusionExecution(execution);
    this.db.prepare(
      `INSERT INTO timeline_fusion_executions (
         fingerprint, execution_id, tenant_id, principal_id, context_scope_id, task_ids, batch_ids, new_fact_ids,
         temporal_basis, temporal_start_at, temporal_end_at, fusion_policy_version, status,
         result_fact_ids, attempt, lease_owner, lease_expires_at, completion_reason, error,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO NOTHING`
    ).run(...(timelineFusionExecutionParams(normalized) as never[]));
    const stored = this.getTimelineFusionExecutionByFingerprint(normalized.fingerprint);
    if (!stored) {
      throw new Error(`timeline_fusion_execution_reservation_missing:${normalized.fingerprint}`);
    }
    if (!sameTimelineFusionReservation(stored, normalized)) {
      throw timelineFusionExecutionConflict(normalized.fingerprint);
    }
    replaceById(this.cache.timelineFusionExecutions, stored, "fingerprint");
    return stored;
  }

  override getTimelineFusionExecutionByFingerprint(
    fingerprint: string
  ): TimelineFusionExecution | undefined {
    const row = this.db.prepare(`
      SELECT
        fingerprint,
        execution_id AS executionId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        context_scope_id AS contextScopeId,
        task_ids AS taskIds,
        batch_ids AS batchIds,
        new_fact_ids AS newFactIds,
        temporal_basis AS temporalBasis,
        temporal_start_at AS temporalStartAt,
        temporal_end_at AS temporalEndAt,
        fusion_policy_version AS fusionPolicyVersion,
        status,
        result_fact_ids AS resultFactIds,
        attempt,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        completion_reason AS completionReason,
        error,
        created_at AS createdAt,
        updated_at AS updatedAt,
        completed_at AS completedAt
      FROM timeline_fusion_executions
      WHERE fingerprint = ?
      LIMIT 1
    `).get(fingerprint) as Record<string, unknown> | undefined;
    return row ? normalizeTimelineFusionExecutionRow(normalizeRow(row)) : undefined;
  }

  override findFactCandidatesForFusion(query: TimelineFusionCandidateQuery): FactItem[] {
    const excluded = uniqueStrings(query.excludeFactIds ?? []);
    const params: unknown[] = [query.tenantId, query.principalId];
    const scopeClause = query.contextScopeId ? "AND context_scope_id = ?" : "";
    if (query.contextScopeId) params.push(query.contextScopeId);
    let temporalClause: string;
    if (query.temporalWindow.basis === "evidence") {
      temporalClause = `
        evidence_time_start IS NOT NULL
        AND julianday(evidence_time_start) < julianday(?)
        AND julianday(COALESCE(evidence_time_end, evidence_time_start)) >= julianday(?)
      `;
      params.push(query.temporalWindow.endAt, query.temporalWindow.startAt);
    } else if (query.temporalWindow.basis === "valid") {
      temporalClause = `
        valid_time_start IS NOT NULL
        AND COALESCE(valid_time_basis, time_basis) <> 'source_time'
        AND julianday(valid_time_start) < julianday(?)
        AND julianday(COALESCE(valid_time_end, valid_time_start)) >= julianday(?)
      `;
      params.push(query.temporalWindow.endAt, query.temporalWindow.startAt);
    } else {
      temporalClause = `EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(fact_items.linked_event_ids)
          THEN fact_items.linked_event_ids ELSE '[]' END) AS linked_event
        JOIN memory_events AS event ON event.event_id = linked_event.value
        WHERE event.tenant_id = fact_items.tenant_id
          AND event.principal_id = fact_items.principal_id
          AND julianday(event.event_time) >= julianday(?)
          AND julianday(event.event_time) < julianday(?)
      )`;
      params.push(query.temporalWindow.startAt, query.temporalWindow.endAt);
    }
    const exclusionClause = excluded.length
      ? `AND fact_id NOT IN (${sqlPlaceholders(excluded.length)})`
      : "";
    params.push(...excluded, Math.max(1, query.limit ?? 50));
    const factIds = this.db.prepare(`
      SELECT fact_id AS factId
      FROM fact_items
      WHERE tenant_id = ? AND principal_id = ?
        ${scopeClause}
        AND status IN ('active', 'conflicted')
        AND (${temporalClause})
        ${exclusionClause}
      ORDER BY fact_id
      LIMIT ?
    `).all(...(params as never[])).map((row) =>
      String((normalizeRow(row as Record<string, unknown>) as { factId?: unknown }).factId ?? "")
    ).filter(Boolean);
    const facts = this.getFactItemsByIds(factIds);
    const eventIds = [...new Set(facts.flatMap((fact) => fact.linkedEventIds))];
    const events = this.getMemoryEventsByIds(eventIds);
    return filterTimelineFusionFactCandidates(facts, events, query);
  }

  override findTimelineFusionFactCandidates(query: TimelineFusionCandidateQuery): FactItem[] {
    return this.findFactCandidatesForFusion(query);
  }

  override getFactVersions(query: {
    tenantId: string;
    principalId: string;
    factId?: string;
    sourceFingerprint?: string;
  }): FactVersion[] {
    const clauses = ["tenant_id = ?", "principal_id = ?"];
    const params: unknown[] = [query.tenantId, query.principalId];
    if (query.factId) {
      clauses.push("fact_id = ?");
      params.push(query.factId);
    }
    if (query.sourceFingerprint) {
      clauses.push("source_fingerprint = ?");
      params.push(query.sourceFingerprint);
    }
    return this.selectFactVersions(clauses, params);
  }

  override getFactVersionsByFactIds(query: {
    tenantId: string;
    principalId: string;
    factIds: string[];
  }): FactVersion[] {
    const factIds = uniqueStrings(query.factIds);
    return chunkSqlValues(factIds).flatMap((batch) => this.selectFactVersions(
      ["tenant_id = ?", "principal_id = ?", `fact_id IN (${sqlPlaceholders(batch.length)})`],
      [query.tenantId, query.principalId, ...batch]
    )).sort(compareFactVersions);
  }

  private selectFactVersions(clauses: string[], params: unknown[]): FactVersion[] {
    return this.db.prepare(`
      SELECT
        fact_version_id AS factVersionId,
        fact_id AS factId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        version,
        previous_version_id AS previousVersionId,
        fact_text AS factText,
        normalized_claim AS normalizedClaim,
        fact_type AS factType,
        evidence_time_start AS evidenceTimeStart,
        evidence_time_end AS evidenceTimeEnd,
        valid_time_start AS validTimeStart,
        valid_time_end AS validTimeEnd,
        confidence_level AS confidenceLevel,
        source_fact_ids AS sourceFactIds,
        linked_event_ids AS linkedEventIds,
        linked_segment_ids AS linkedSegmentIds,
        linked_source_refs AS linkedSourceRefs,
        update_reason AS updateReason,
        conflict_refs AS conflictRefs,
        source_fingerprint AS sourceFingerprint,
        created_at AS createdAt
      FROM fact_versions
      WHERE ${clauses.join(" AND ")}
      ORDER BY fact_id, version, fact_version_id
    `).all(...(params as never[])).map((row) =>
      normalizeFactVersionRow(normalizeRow(row as Record<string, unknown>))
    );
  }

  override async commitTimelineFusionFactStore(
    input: Parameters<InMemoryContextEngineRepository["commitTimelineFusionFactStore"]>[0]
  ) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = await super.commitTimelineFusionFactStore(input);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      this.clearLoadedCache();
      this.loadFromDatabase();
      throw error;
    }
  }

  override getDreamingRun(runId: string) {
    const row = this.db.prepare(`
      SELECT
        run_id AS runId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        trigger_type AS triggerType,
        schedule_key AS scheduleKey,
        status,
        requested_at AS requestedAt,
        candidate_window_start_at AS candidateWindowStartAt,
        candidate_cutoff_at AS candidateCutoffAt,
        actual_started_at AS actualStartedAt,
        paused_at AS pausedAt,
        pause_reason AS pauseReason,
        completed_at AS completedAt,
        checkpoint,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        policy_version AS policyVersion,
        prompt_version AS promptVersion,
        model,
        candidate_count AS candidateCount,
        processed_count AS processedCount,
        consolidated_count AS consolidatedCount,
        observing_count AS observingCount,
        dropped_count AS droppedCount,
        retry_wait_count AS retryWaitCount,
        skipped_count AS skippedCount,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM dreaming_runs
      WHERE run_id = ?
      LIMIT 1
    `).get(runId) as Record<string, unknown> | undefined;
    return row ? normalizeDreamingRunRow(normalizeRow(row)) : undefined;
  }

  override listDreamingRuns(query: {
    tenantId?: string;
    principalId?: string;
    statuses?: DreamingRun["status"][];
  } = {}) {
    const clauses = ["1 = 1"];
    const params: unknown[] = [];
    if (query.tenantId) {
      clauses.push("tenant_id = ?");
      params.push(query.tenantId);
    }
    if (query.principalId) {
      clauses.push("principal_id = ?");
      params.push(query.principalId);
    }
    if (query.statuses?.length) {
      clauses.push(`status IN (${sqlPlaceholders(query.statuses.length)})`);
      params.push(...query.statuses);
    }
    return this.db.prepare(`
      SELECT
        run_id AS runId, tenant_id AS tenantId, principal_id AS principalId,
        trigger_type AS triggerType, schedule_key AS scheduleKey, status,
        requested_at AS requestedAt, candidate_window_start_at AS candidateWindowStartAt,
        candidate_cutoff_at AS candidateCutoffAt, actual_started_at AS actualStartedAt,
        paused_at AS pausedAt, pause_reason AS pauseReason, completed_at AS completedAt, checkpoint,
        lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
        policy_version AS policyVersion, prompt_version AS promptVersion, model,
        candidate_count AS candidateCount, processed_count AS processedCount,
        consolidated_count AS consolidatedCount, observing_count AS observingCount,
        dropped_count AS droppedCount, retry_wait_count AS retryWaitCount,
        skipped_count AS skippedCount, last_error AS lastError,
        created_at AS createdAt, updated_at AS updatedAt
      FROM dreaming_runs
      WHERE ${clauses.join(" AND ")}
      ORDER BY candidate_cutoff_at ASC
    `).all(...(params as never[])).map((row) => normalizeDreamingRunRow(normalizeRow(row as Record<string, unknown>)));
  }

  override async claimNextDreamingRun(input: {
    tenantId: string;
    principalId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }) {
    const row = this.db.prepare(`
      SELECT run_id AS runId
      FROM dreaming_runs
      WHERE tenant_id = ?
        AND principal_id = ?
        AND (
          status = 'queued' OR
          (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM dreaming_runs AS active_run
          WHERE active_run.tenant_id = dreaming_runs.tenant_id
            AND active_run.principal_id = dreaming_runs.principal_id
            AND active_run.status = 'running'
            AND active_run.lease_expires_at IS NOT NULL
            AND active_run.lease_expires_at > ?
        )
      ORDER BY candidate_cutoff_at ASC
      LIMIT 1
    `).get(input.tenantId, input.principalId, input.claimedAt, input.claimedAt) as { runId?: string } | undefined;
    if (!row?.runId) return undefined;
    const result = this.db.prepare(`
      UPDATE dreaming_runs
      SET status = 'running',
          actual_started_at = COALESCE(actual_started_at, ?),
          lease_owner = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE run_id = ?
        AND (
          status = 'queued' OR
          (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
    `).run(input.claimedAt, input.claimedBy, input.leaseExpiresAt, input.claimedAt, row.runId, input.claimedAt);
    if (Number(result.changes ?? 0) !== 1) return undefined;
    const claimed = this.getDreamingRun(row.runId);
    if (claimed) replaceById(this.dreamingRuns, claimed, "runId");
    return claimed;
  }

  override getDreamingRunCandidate(runCandidateId: string) {
    const row = this.db.prepare(`
      SELECT
        run_candidate_id AS runCandidateId, run_id AS runId,
        memory_data_id AS memoryDataId, stm_version AS stmVersion,
        candidate_fingerprint AS candidateFingerprint, source_type AS sourceType,
        status, cycle_attempt_count AS cycleAttemptCount,
        total_attempt_count AS totalAttemptCount, reevaluation_tier AS reevaluationTier,
        next_evaluate_at AS nextEvaluateAt, decision_id AS decisionId,
        trace_id AS traceId, result_ltm_id AS resultLtmId, last_error AS lastError,
        lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
        started_at AS startedAt, completed_at AS completedAt,
        created_at AS createdAt, updated_at AS updatedAt
      FROM dreaming_run_candidates
      WHERE run_candidate_id = ?
      LIMIT 1
    `).get(runCandidateId) as Record<string, unknown> | undefined;
    return row ? normalizeDreamingRunCandidateRow(normalizeRow(row)) : undefined;
  }

  override listDreamingRunCandidates(runId: string) {
    return this.db.prepare(`
      SELECT
        run_candidate_id AS runCandidateId, run_id AS runId,
        memory_data_id AS memoryDataId, stm_version AS stmVersion,
        candidate_fingerprint AS candidateFingerprint, source_type AS sourceType,
        status, cycle_attempt_count AS cycleAttemptCount,
        total_attempt_count AS totalAttemptCount, reevaluation_tier AS reevaluationTier,
        next_evaluate_at AS nextEvaluateAt, decision_id AS decisionId,
        trace_id AS traceId, result_ltm_id AS resultLtmId, last_error AS lastError,
        lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
        started_at AS startedAt, completed_at AS completedAt,
        created_at AS createdAt, updated_at AS updatedAt
      FROM dreaming_run_candidates
      WHERE run_id = ?
      ORDER BY created_at ASC, memory_data_id ASC
    `).all(runId).map((row) => normalizeDreamingRunCandidateRow(normalizeRow(row as Record<string, unknown>)));
  }

  override async claimNextDreamingRunCandidate(input: {
    runId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }) {
    const row = this.db.prepare(`
      SELECT run_candidate_id AS runCandidateId
      FROM dreaming_run_candidates
      WHERE run_id = ?
        AND (
          status = 'pending' OR
          (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
      ORDER BY created_at ASC, memory_data_id ASC
      LIMIT 1
    `).get(input.runId, input.claimedAt) as { runCandidateId?: string } | undefined;
    if (!row?.runCandidateId) return undefined;
    const result = this.db.prepare(`
      UPDATE dreaming_run_candidates
      SET status = 'processing',
          lease_owner = ?,
          lease_expires_at = ?,
          started_at = COALESCE(started_at, ?),
          updated_at = ?
      WHERE run_candidate_id = ?
        AND (
          status = 'pending' OR
          (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
    `).run(input.claimedBy, input.leaseExpiresAt, input.claimedAt, input.claimedAt, row.runCandidateId, input.claimedAt);
    if (Number(result.changes ?? 0) !== 1) return undefined;
    const claimed = this.getDreamingRunCandidate(row.runCandidateId);
    if (claimed) replaceById(this.dreamingRunCandidates, claimed, "runCandidateId");
    return claimed;
  }

  override listDueDreamingShortTermMemories(query: {
    tenantId: string;
    principalId: string;
    cutoffAt: string;
    policyVersion: string;
  }) {
    const rows = this.db.prepare(`
      SELECT memory_data_id AS memoryDataId
      FROM short_term_memories
      WHERE tenant_id = ?
        AND principal_id = ?
        AND (
          (
            consolidation_status IN ('observing', 'retry_wait', 'retryable_failure')
            AND next_evaluate_at IS NOT NULL
            AND next_evaluate_at <= ?
          )
          OR (
            consolidation_status IN ('consolidated', 'dropped')
            AND (
              dreaming_policy_version IS NULL
              OR dreaming_policy_version != ?
              OR reevaluation_reason IS NOT NULL
            )
          )
        )
        AND lifecycle_status != 'deleted'
        AND (access_state IS NULL OR access_state != 'permission-invalid')
      ORDER BY COALESCE(next_evaluate_at, updated_at) ASC, memory_data_id ASC
    `).all(query.tenantId, query.principalId, query.cutoffAt, query.policyVersion) as Array<{ memoryDataId?: string }>;
    return orderShortTermMemoriesByIds(
      this.getShortTermMemoriesByIds(rows.flatMap((row) => row.memoryDataId ? [row.memoryDataId] : [])),
      rows.flatMap((row) => row.memoryDataId ? [row.memoryDataId] : [])
    );
  }

  override listDreamingShortTermMemoriesInWindow(query: {
    tenantId: string;
    principalId: string;
    windowStart: string;
    cutoffAt: string;
    policyVersion: string;
  }) {
    const rows = this.db.prepare(`
      SELECT memory_data_id AS memoryDataId
      FROM short_term_memories
      WHERE tenant_id = ?
        AND principal_id = ?
        AND created_at >= ?
        AND created_at < ?
        AND (
          consolidation_status IS NULL
          OR consolidation_status IN ('unseen', 'evaluating', 'pending_confirm')
          OR (
            consolidation_status IN ('consolidated', 'dropped')
            AND (
              dreaming_policy_version IS NULL
              OR dreaming_policy_version != ?
              OR reevaluation_reason IS NOT NULL
            )
          )
        )
        AND lifecycle_status != 'deleted'
        AND (access_state IS NULL OR access_state != 'permission-invalid')
      ORDER BY created_at ASC, memory_data_id ASC
    `).all(query.tenantId, query.principalId, query.windowStart, query.cutoffAt, query.policyVersion) as Array<{ memoryDataId?: string }>;
    const ids = rows.flatMap((row) => row.memoryDataId ? [row.memoryDataId] : []);
    return orderShortTermMemoriesByIds(this.getShortTermMemoriesByIds(ids), ids);
  }

  override async withDreamingTransaction<T>(callback: () => Promise<T>): Promise<T> {
    const snapshot = {
      longTermMemories: this.longTermMemories.slice(),
      shortTermMemories: this.shortTermMemories.slice(),
      relationEdges: this.relationEdges.slice(),
      graphMemoryNodes: this.graphMemoryNodes.slice(),
      indexEntries: this.indexEntries.slice(),
      textIndexEntries: this.textIndexEntries.slice(),
      vectorIndexEntries: this.vectorIndexEntries.slice(),
      changeEvents: this.changeEvents.slice(),
      llmDreamingTraces: this.llmDreamingTraces.slice(),
      pipelineTasks: this.pipelineTasks.slice(),
      dreamingOutbox: this.dreamingOutbox.slice(),
      dreamingRuns: this.dreamingRuns.slice(),
      dreamingRunCandidates: this.dreamingRunCandidates.slice(),
      dreamingCandidateDecisions: this.dreamingCandidateDecisions.slice()
    };
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = await callback();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.longTermMemories, snapshot.longTermMemories);
      replaceArray(this.shortTermMemories, snapshot.shortTermMemories);
      replaceArray(this.relationEdges, snapshot.relationEdges);
      replaceArray(this.graphMemoryNodes, snapshot.graphMemoryNodes);
      replaceArray(this.indexEntries, snapshot.indexEntries);
      replaceArray(this.textIndexEntries, snapshot.textIndexEntries);
      replaceArray(this.vectorIndexEntries, snapshot.vectorIndexEntries);
      replaceArray(this.changeEvents, snapshot.changeEvents);
      replaceArray(this.llmDreamingTraces, snapshot.llmDreamingTraces);
      replaceArray(this.pipelineTasks, snapshot.pipelineTasks);
      replaceArray(this.dreamingOutbox, snapshot.dreamingOutbox);
      replaceArray(this.dreamingRuns, snapshot.dreamingRuns);
      replaceArray(this.dreamingRunCandidates, snapshot.dreamingRunCandidates);
      replaceArray(this.dreamingCandidateDecisions, snapshot.dreamingCandidateDecisions);
      throw error;
    }
  }

  override async hasMemoryEvent(eventId: string) {
    const row = this.db
      .prepare(`SELECT 1 AS present FROM memory_events WHERE event_id = ? LIMIT 1`)
      .get(eventId) as { present?: number } | undefined;
    return Boolean(row?.present);
  }

  override getPipelineTaskByEventId(eventId: string) {
    const row = this.db.prepare(`
      SELECT
        task_id AS taskId,
        event_id AS eventId,
        task_type AS taskType,
        status,
        attempt,
        max_attempts AS maxAttempts,
        retryable,
        stage,
        error,
        retry_after AS retryAfter,
        checkpoint,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        stats,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM context_pipeline_tasks
      WHERE event_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(eventId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const task = normalizeRow(row);
    return {
      ...task,
      retryable: Boolean(task.retryable)
    } as unknown as ContextPipelineTask;
  }

  override async saveMemoryRetrievalEvent(event: MemoryRetrievalEvent) {
    const existing = event.requestId
      ? this.db.prepare(`
          SELECT 1 AS present FROM memory_retrieval_events
          WHERE request_id = ? AND owner_type = ? AND owner_id = ? AND event_type = ?
          LIMIT 1
        `).get(event.requestId, event.ownerType, event.ownerId, event.eventType)
      : this.db.prepare(`
          SELECT 1 AS present FROM memory_retrieval_events
          WHERE retrieval_event_id = ? LIMIT 1
        `).get(event.retrievalEventId);
    if (existing) return;
    await super.saveMemoryRetrievalEvent(event);
  }

  override getMemoryReuseSignals(ownerIds?: string[], now = new Date().toISOString()) {
    const events = this.queryAll<MemoryRetrievalEvent>(`
      SELECT
        retrieval_event_id AS retrievalEventId,
        owner_type AS ownerType,
        owner_id AS ownerId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        session_id AS sessionId,
        task_id AS taskId,
        request_id AS requestId,
        event_type AS eventType,
        query,
        feedback_action AS feedbackAction,
        created_at AS createdAt
      FROM memory_retrieval_events
    `);
    return buildMemoryReuseSignals(events, ownerIds, now);
  }

  override async commitConversationBatchIngestion(
    request: CommitConversationBatchIngestionRequest
  ): Promise<CommitConversationBatchIngestionResult> {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existingRow = this.db.prepare(`
        SELECT * FROM conversation_batch_ingestions
        WHERE tenant_id = ? AND source_app = ? AND principal_id = ? AND idempotency_key = ?
        LIMIT 1
      `).get(
        request.batch.tenantId,
        request.batch.sourceApp,
        request.batch.principalId,
        request.batch.idempotencyKey
      ) as Record<string, unknown> | undefined;
      if (existingRow) {
        const existing = normalizeConversationBatchIngestionRow(existingRow);
        if (existing.documentSha256 !== request.batch.documentSha256) {
          throw new ConversationRepositoryError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "The idempotency key is already associated with a different document hash.",
            { batchIngestionId: existing.batchIngestionId }
          );
        }
        const ingestions = this.db.prepare(`
          SELECT * FROM conversation_ingestions
          WHERE batch_ingestion_id = ?
          ORDER BY rowid
        `).all(existing.batchIngestionId).map((row) =>
          normalizeConversationIngestionRow(row as Record<string, unknown>)
        );
        this.db.exec("COMMIT;");
        return { batch: existing, ingestions, deduplicated: true };
      }

      const existingBatch = this.db.prepare(`
        SELECT batch_ingestion_id AS batchIngestionId, batch_id AS batchId
        FROM conversation_batch_ingestions
        WHERE tenant_id = ? AND source_app = ? AND principal_id = ? AND batch_id = ?
        LIMIT 1
      `).get(
        request.batch.tenantId,
        request.batch.sourceApp,
        request.batch.principalId,
        request.batch.batchId
      ) as { batchIngestionId: string; batchId: string } | undefined;
      if (existingBatch) {
        throw new ConversationRepositoryError(
          "BATCH_ID_CONFLICT",
          "The batch ID is already associated with another ingestion.",
          existingBatch
        );
      }

      for (const session of request.sessions) {
        assertConversationCursorValueMatches(this.readConversationCursor(session.cursor), session.ingestion);
      }

      const plannedMessages: ConversationMessageRecord[] = [];
      const sessionPlans = request.sessions.map((session) => {
        const resolvedMessages = this.resolveDatabaseConversationMessages(session.messages, plannedMessages);
        const messageCounts = conversationMessageCounts(session.messages, resolvedMessages);
        const ingestion = withCommittedConversationMessageCounts(session.ingestion, messageCounts);
        for (const resolved of resolvedMessages) {
          if (!resolved.stored) plannedMessages.push(resolved.incoming);
        }
        return { session, ingestion, resolvedMessages };
      });

      this.db.prepare(`
        INSERT INTO conversation_batch_ingestions (
          batch_ingestion_id, idempotency_key, document_sha256, batch_id,
          source_app, tenant_id, principal_id, document_status, processing_status,
          created_at, committed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.batch.batchIngestionId,
        request.batch.idempotencyKey,
        request.batch.documentSha256,
        request.batch.batchId,
        request.batch.sourceApp,
        request.batch.tenantId,
        request.batch.principalId,
        request.batch.documentStatus,
        request.batch.processingStatus,
        request.batch.createdAt,
        request.batch.committedAt,
        request.batch.updatedAt
      );

      if (!sessionPlans.length) throw new Error("A conversation batch requires at least one session.");
      for (const plan of sessionPlans) {
        this.insertConversationIngestion(plan.ingestion);
      }
      this.db.prepare(`
        INSERT INTO conversation_documents (
          document_id, batch_ingestion_id, ingestion_id, schema_version,
          sha256, byte_size, raw_markdown, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.document.documentId,
        request.batch.batchIngestionId,
        null,
        request.document.schemaVersion,
        request.document.sha256,
        request.document.byteSize,
        request.document.rawMarkdown,
        request.document.createdAt
      );

      for (const plan of sessionPlans) {
        plan.resolvedMessages.forEach(({ incoming, stored }, messageOrder) => {
          const persisted = stored ?? incoming;
          if (!stored) this.insertConversationMessage(incoming);
          this.db.prepare(`
            INSERT INTO conversation_document_messages (
              document_id, ingestion_id, conversation_message_row_id, message_order
            ) VALUES (?, ?, ?, ?)
          `).run(
            request.document.documentId,
            plan.ingestion.ingestionId,
            persisted.conversationMessageRowId,
            messageOrder
          );
        });
        this.upsertConversationCursor(plan.session.cursor);
        this.insertConversationIngestionJob(plan.session.job);
      }

      this.db.exec("COMMIT;");
      if (!this.conversationBatchIngestions.some((item) =>
        item.batchIngestionId === request.batch.batchIngestionId
      )) {
        this.conversationBatchIngestions.push(request.batch);
      }
      if (!this.conversationDocuments.some((item) => item.documentId === request.document.documentId)) {
        this.conversationDocuments.push(request.document);
      }
      for (const plan of sessionPlans) {
        if (!this.conversationIngestions.some((item) => item.ingestionId === plan.ingestion.ingestionId)) {
          this.conversationIngestions.push(plan.ingestion);
        }
        plan.resolvedMessages.forEach(({ incoming, stored }, messageOrder) => {
          const persisted = stored ?? incoming;
          if (!stored && !this.conversationMessages.some((item) =>
            item.conversationMessageRowId === incoming.conversationMessageRowId
          )) {
            this.conversationMessages.push(incoming);
          }
          if (!this.conversationDocumentMessageRows.some((item) =>
            item.documentId === request.document.documentId &&
            item.ingestionId === plan.ingestion.ingestionId &&
            item.messageOrder === messageOrder
          )) {
            this.conversationDocumentMessageRows.push({
              documentId: request.document.documentId,
              ingestionId: plan.ingestion.ingestionId,
              conversationMessageRowId: persisted.conversationMessageRowId,
              messageOrder
            });
          }
        });
        replaceConversationCursor(this.conversationSessionCursors, plan.session.cursor);
        if (!this.conversationIngestionJobs.some((item) => item.jobId === plan.session.job.jobId)) {
          this.conversationIngestionJobs.push(plan.session.job);
        }
      }
      return {
        batch: request.batch,
        ingestions: sessionPlans.map((item) => item.ingestion),
        deduplicated: false
      };
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      throw caught;
    }
  }

  override async getConversationBatchIngestion(batchIngestionId: string) {
    const row = this.db.prepare(`
      SELECT * FROM conversation_batch_ingestions WHERE batch_ingestion_id = ? LIMIT 1
    `).get(batchIngestionId) as Record<string, unknown> | undefined;
    return row ? normalizeConversationBatchIngestionRow(row) : undefined;
  }

  override async commitConversationIngestion(
    request: CommitConversationIngestionRequest
  ): Promise<CommitConversationIngestionResult> {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existingRow = this.db.prepare(`
        SELECT * FROM conversation_ingestions
        WHERE tenant_id = ? AND source_app = ? AND idempotency_key = ?
        LIMIT 1
      `).get(
        request.ingestion.tenantId,
        request.ingestion.sourceApp,
        request.ingestion.idempotencyKey
      ) as Record<string, unknown> | undefined;
      if (existingRow) {
        const existing = normalizeConversationIngestionRow(existingRow);
        if (existing.documentSha256 !== request.ingestion.documentSha256) {
          throw new ConversationRepositoryError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "The idempotency key is already associated with a different document hash.",
            { ingestionId: existing.ingestionId }
          );
        }
        this.db.exec("COMMIT;");
        return {
          ingestion: existing,
          messageCounts: {
            received: request.messages.length,
            inserted: 0,
            deduplicated: request.messages.length,
            revised: 0,
            deleted: 0
          },
          deduplicated: true
        };
      }

      const existingBatch = this.db.prepare(`
        SELECT ingestion_id AS ingestionId, batch_id AS batchId
        FROM conversation_ingestions
        WHERE tenant_id = ? AND source_app = ? AND principal_id = ?
          AND session_id = ? AND batch_id = ?
        LIMIT 1
      `).get(
        request.ingestion.tenantId,
        request.ingestion.sourceApp,
        request.ingestion.principalId,
        request.ingestion.sessionId,
        request.ingestion.batchId
      ) as { ingestionId: string; batchId: string } | undefined;
      if (existingBatch) {
        throw new ConversationRepositoryError(
          "BATCH_ID_CONFLICT",
          "The batch ID is already associated with another ingestion.",
          existingBatch
        );
      }

      assertConversationCursorMatches(this.readConversationCursor(request.cursor), request);
      const resolvedMessages = this.resolveDatabaseConversationMessages(request.messages, []);
      const messageCounts = conversationMessageCounts(request.messages, resolvedMessages);
      const ingestion = withCommittedConversationMessageCounts(request.ingestion, messageCounts);

      this.insertConversationIngestion(ingestion);
      this.db.prepare(`
        INSERT INTO conversation_documents (
          document_id, batch_ingestion_id, ingestion_id, schema_version,
          sha256, byte_size, raw_markdown, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.document.documentId,
        null,
        ingestion.ingestionId,
        request.document.schemaVersion,
        request.document.sha256,
        request.document.byteSize,
        request.document.rawMarkdown,
        request.document.createdAt
      );
      resolvedMessages.forEach(({ incoming, stored }, messageOrder) => {
        const persisted = stored ?? incoming;
        if (!stored) this.insertConversationMessage(incoming);
        this.db.prepare(`
          INSERT INTO conversation_document_messages (
            document_id, ingestion_id, conversation_message_row_id, message_order
          ) VALUES (?, ?, ?, ?)
        `).run(
          request.document.documentId,
          ingestion.ingestionId,
          persisted.conversationMessageRowId,
          messageOrder
        );
      });
      this.upsertConversationCursor(request.cursor);
      if (request.job) this.insertConversationIngestionJob(request.job);
      this.db.exec("COMMIT;");

      this.conversationIngestions.push(ingestion);
      this.conversationDocuments.push(request.document);
      resolvedMessages.forEach(({ incoming, stored }, messageOrder) => {
        const persisted = stored ?? incoming;
        if (!stored) this.conversationMessages.push(incoming);
        this.conversationDocumentMessageRows.push({
          documentId: request.document.documentId,
          ingestionId: ingestion.ingestionId,
          conversationMessageRowId: persisted.conversationMessageRowId,
          messageOrder
        });
      });
      replaceConversationCursor(this.conversationSessionCursors, request.cursor);
      if (request.job) this.conversationIngestionJobs.push(request.job);
      return { ingestion, messageCounts, deduplicated: false };
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      throw caught;
    }
  }

  override async getConversationIngestion(ingestionId: string) {
    const row = this.db.prepare(`
      SELECT * FROM conversation_ingestions WHERE ingestion_id = ? LIMIT 1
    `).get(ingestionId) as Record<string, unknown> | undefined;
    return row ? normalizeConversationIngestionRow(row) : undefined;
  }

  override async listConversationIngestions() {
    return this.db.prepare(`
      SELECT * FROM conversation_ingestions ORDER BY rowid
    `).all().map((row) => normalizeConversationIngestionRow(row as Record<string, unknown>));
  }

  override async getConversationDocument(ingestionId: string) {
    const row = this.db.prepare(`
      SELECT
        document_id AS documentId,
        batch_ingestion_id AS batchIngestionId,
        ingestion_id AS ingestionId,
        schema_version AS schemaVersion,
        sha256,
        byte_size AS byteSize,
        raw_markdown AS rawMarkdown,
        created_at AS createdAt
      FROM conversation_documents
      WHERE ingestion_id = ? OR batch_ingestion_id = (
        SELECT batch_ingestion_id FROM conversation_ingestions WHERE ingestion_id = ?
      )
      LIMIT 1
    `).get(ingestionId, ingestionId) as Record<string, unknown> | undefined;
    return row ? normalizeRow(row) as unknown as ConversationDocumentRecord : undefined;
  }

  override async getConversationMessages(ingestionId: string) {
    return this.db.prepare(`
      SELECT ${conversationMessageSelectColumns("cm", {
        ingestionIdExpression: "cdm.ingestion_id",
        documentIdExpression: "cdm.document_id"
      })}
      FROM conversation_document_messages AS cdm
      JOIN conversation_messages AS cm
        ON cm.conversation_message_row_id = cdm.conversation_message_row_id
      WHERE cdm.ingestion_id = ?
      ORDER BY cdm.message_order
    `).all(ingestionId).map((row) =>
      normalizeConversationMessageRow(row as Record<string, unknown>)
    );
  }

  override async getConversationMessagesByRowIds(conversationMessageRowIds: string[]) {
    const allowed = [...new Set(conversationMessageRowIds)];
    if (!allowed.length) return [];
    return chunkSqlValues(allowed).flatMap((batch) => {
      const placeholders = sqlPlaceholders(batch.length);
      return this.db.prepare(`
        SELECT ${conversationMessageSelectColumns("cm", {
          documentIdExpression: `(SELECT cdm.document_id
            FROM conversation_document_messages AS cdm
            WHERE cdm.conversation_message_row_id = cm.conversation_message_row_id
              AND cdm.ingestion_id = cm.first_ingestion_id
            ORDER BY cdm.message_order LIMIT 1)`
        })}
        FROM conversation_messages AS cm
        WHERE cm.conversation_message_row_id IN (${placeholders})
        ORDER BY cm.sequence, cm.revision, cm.message_id
      `).all(...batch).map((row) =>
        normalizeConversationMessageRow(row as Record<string, unknown>)
      );
    }).sort((left, right) =>
      left.sequence - right.sequence ||
      left.revision - right.revision ||
      left.messageId.localeCompare(right.messageId)
    );
  }

  override async backfillConversationMessages(
    request: BackfillConversationMessagesRequest
  ): Promise<BackfillConversationMessagesResult> {
    const cachedMessages = [...this.conversationMessages];
    const cachedDocumentMessageRows = [...this.conversationDocumentMessageRows];
    const cachedIngestions = [...this.conversationIngestions];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = await super.backfillConversationMessages(request);
      const persistedMessages = await super.getConversationMessages(request.ingestionId);
      this.db.prepare("DELETE FROM conversation_document_messages WHERE ingestion_id = ?").run(request.ingestionId);
      for (const message of persistedMessages) this.upsertConversationMessage(message);
      for (const [messageOrder, message] of persistedMessages.entries()) {
        this.db.prepare(`
          INSERT INTO conversation_document_messages (
            document_id, ingestion_id, conversation_message_row_id, message_order
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(document_id, ingestion_id, conversation_message_row_id) DO UPDATE SET
            message_order=excluded.message_order
        `).run(request.documentId, request.ingestionId, message.conversationMessageRowId, messageOrder);
      }
      const ingestion = this.conversationIngestions.find((item) => item.ingestionId === request.ingestionId);
      if (ingestion) {
        this.db.prepare(`
          UPDATE conversation_ingestions
          SET timezone = ?, locale = ?, temporal_mode = ?, last_sequence = ?,
              message_counts = ?, layer_counts = ?, updated_at = ?
          WHERE ingestion_id = ?
        `).run(
          ingestion.timezone ?? null,
          ingestion.locale ?? null,
          ingestion.temporalMode,
          ingestion.lastSequence,
          JSON.stringify(ingestion.messageCounts),
          JSON.stringify(ingestion.layerCounts),
          ingestion.updatedAt,
          request.ingestionId
        );
      }
      this.db.exec("COMMIT;");
      return result;
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.conversationMessages, cachedMessages);
      replaceArray(this.conversationDocumentMessageRows, cachedDocumentMessageRows);
      replaceArray(this.conversationIngestions, cachedIngestions);
      throw caught;
    }
  }

  override async getConversationTemporalBackfillMigration(version: string) {
    const row = this.db.prepare(`
      SELECT version, status, attempt, counts_json AS countsJson, errors_json AS errorsJson,
             started_at AS startedAt, completed_at AS completedAt, updated_at AS updatedAt,
             duration_ms AS durationMs
      FROM context_engine_migrations
      WHERE version = ? AND migration_type = 'temporal_backfill'
      LIMIT 1
    `).get(version) as Record<string, unknown> | undefined;
    return row ? normalizeTemporalBackfillMigrationRow(row) : undefined;
  }

  override async saveConversationTemporalBackfillMigration(
    record: ConversationTemporalBackfillMigrationRecord
  ) {
    await super.saveConversationTemporalBackfillMigration(record);
  }

  override getParsedSegmentsByIds(segmentIds: string[]): ParsedSegment[] {
    const allowed = [...new Set(segmentIds.map((item) => item.trim()).filter(Boolean))];
    if (!allowed.length) return [];
    return chunkSqlValues(allowed).flatMap((batch) => {
      const placeholders = sqlPlaceholders(batch.length);
      return this.db.prepare(`
        SELECT
          segment_id AS segmentId,
          event_id AS eventId,
          modality,
          content,
          status,
          confidence,
          data_source AS dataSource,
          custom_fields AS customFields
        FROM parsed_segments
        WHERE segment_id IN (${placeholders})
        ORDER BY segment_id
      `).all(...batch).map((row) => {
        const normalized = normalizeRow(row as Record<string, unknown>);
        const customFields = normalizeCustomFields(normalized.customFields);
        return {
          segmentId: String(normalized.segmentId ?? ""),
          eventId: String(normalized.eventId ?? ""),
          modality: normalized.modality as ParsedSegment["modality"],
          content: String(normalized.content ?? ""),
          status: normalized.status as ParsedSegment["status"],
          confidence: normalized.confidence as ParsedSegment["confidence"],
          ...(normalized.dataSource && typeof normalized.dataSource === "object"
            ? { dataSource: normalized.dataSource as NonNullable<ParsedSegment["dataSource"]> }
            : {}),
          ...(Object.keys(customFields).length ? { customFields } : {})
        };
      });
    }).sort((left, right) => left.segmentId.localeCompare(right.segmentId));
  }

  override getMemoryEventsByIds(eventIds: string[]): MemoryEvent[] {
    const allowed = [...new Set(eventIds.map((item) => item.trim()).filter(Boolean))];
    if (!allowed.length) return [];
    const batches = chunkSqlValues(allowed);
    const itemRows = batches.flatMap((batch) => {
      const placeholders = sqlPlaceholders(batch.length);
      return this.db.prepare(`
        SELECT
          event_id AS eventId,
          item_id AS itemId,
          source_item_id AS sourceItemId,
          type,
          format,
          content,
          ref,
          source_ref AS sourceRef,
          source_refs AS sourceRefs,
          time_basis AS timeBasis,
          time_confidence AS timeConfidence,
          custom_fields AS customFields
        FROM multimodal_data_items
        WHERE event_id IN (${placeholders})
      `).all(...batch).map((row) => normalizeRow(row as Record<string, unknown>));
    });
    const sourceRows = batches.flatMap((batch) => {
      const placeholders = sqlPlaceholders(batch.length);
      return this.db.prepare(`
        SELECT
          esr.event_id AS eventId,
          sr.source_ref_id AS sourceRefId,
          sr.source_type AS sourceType,
          sr.source_id AS sourceId,
          sr.source_url AS sourceUrl
        FROM event_source_refs esr
        JOIN source_refs sr ON sr.source_ref_id = esr.source_ref_id
        WHERE esr.event_id IN (${placeholders})
      `).all(...batch).map((row) => normalizeRow(row as Record<string, unknown>));
    });
    const itemsByEvent = groupBy(itemRows, (row) => String(row.eventId ?? ""));
    const refsByEvent = groupBy(sourceRows, (row) => String(row.eventId ?? ""));
    return batches.flatMap((batch) => {
      const placeholders = sqlPlaceholders(batch.length);
      return this.db.prepare(`
        SELECT
          event_id AS eventId,
          context_scope_id AS contextScopeId,
          event_type AS eventType,
          event_summary AS eventSummary,
          event_description AS eventDescription,
          event_time AS eventTime,
          source_app AS sourceApp,
          source_id AS sourceId,
          data_source AS dataSource,
          custom_fields AS customFields,
          tenant_id AS tenantId,
          principal_id AS principalId,
          source_acl_version AS sourceAclVersion,
          visibility
        FROM memory_events
        WHERE event_id IN (${placeholders})
        ORDER BY event_id
      `).all(...batch).map((row) => {
        const normalized = normalizeRow(row as Record<string, unknown>);
        const eventId = String(normalized.eventId ?? "");
        return normalizeMemoryEventSourceRefs({
          eventId,
          ...(typeof normalized.contextScopeId === "string" && normalized.contextScopeId
            ? { contextScopeId: normalized.contextScopeId }
            : {}),
          eventType: String(normalized.eventType ?? ""),
          eventSummary: String(normalized.eventSummary ?? normalized.eventDescription ?? normalized.eventType ?? ""),
          ...(typeof normalized.eventDescription === "string" ? { eventDescription: normalized.eventDescription } : {}),
          eventTime: String(normalized.eventTime ?? ""),
          ...(typeof normalized.sourceApp === "string" ? { sourceApp: normalized.sourceApp } : {}),
          ...(typeof normalized.sourceId === "string" ? { sourceId: normalized.sourceId } : {}),
          ...(normalized.dataSource && typeof normalized.dataSource === "object"
            ? { dataSource: normalized.dataSource as NonNullable<MemoryEvent["dataSource"]> }
            : {}),
          customFields: normalizeCustomFields(normalized.customFields),
          permissionSnapshot: {
            snapshotId: `ps_${eventId}`,
            tenantId: String(normalized.tenantId ?? "local"),
            principalId: String(normalized.principalId ?? "local"),
            sourceAclVersion: String(normalized.sourceAclVersion ?? "default"),
            visibility: (normalized.visibility ?? "private") as MemoryEvent["permissionSnapshot"]["visibility"]
          },
          multimodalData: (itemsByEvent.get(eventId) ?? []).map((item) => {
            const customFields = normalizeCustomFields(item.customFields);
            const content = item.content;
            return {
              itemId: typeof item.sourceItemId === "string" && item.sourceItemId
                ? item.sourceItemId
                : String(item.itemId ?? ""),
              type: item.type as MemoryEvent["multimodalData"][number]["type"],
              format: String(item.format ?? ""),
              ...(content !== undefined && content !== null
                ? { content: content as NonNullable<MemoryEvent["multimodalData"][number]["content"]> }
                : {}),
              ...(typeof item.ref === "string" ? { ref: item.ref } : {}),
              ...(Array.isArray(item.sourceRefs) ? { sourceRefs: item.sourceRefs as SourceRef[] } : {}),
              ...(typeof item.timeBasis === "string"
                ? { timeBasis: item.timeBasis as NonNullable<MemoryEvent["multimodalData"][number]["timeBasis"]> }
                : {}),
              ...(typeof item.timeConfidence === "string"
                ? { timeConfidence: item.timeConfidence as NonNullable<MemoryEvent["multimodalData"][number]["timeConfidence"]> }
                : {}),
              ...(Object.keys(customFields).length ? { customFields } : {})
            };
          }),
          sourceRefs: (refsByEvent.get(eventId) ?? []).map((ref) => ({
            sourceRefId: String(ref.sourceRefId ?? ""),
            sourceType: String(ref.sourceType ?? ""),
            sourceId: String(ref.sourceId ?? ""),
            ...(typeof ref.sourceUrl === "string" ? { sourceUrl: ref.sourceUrl } : {})
          }))
        });
      });
    }).sort((left, right) => left.eventId.localeCompare(right.eventId));
  }

  override findEvidenceCandidates(query: EvidenceSearchQuery): EvidenceSearchCandidate[] {
    const messageRows = this.db.prepare(`
      SELECT ${conversationMessageSelectColumns("cm")}
      FROM conversation_messages AS cm
      ORDER BY cm.created_at, cm.sequence, cm.conversation_message_row_id
    `).all().map((row) => normalizeConversationMessageRow(row as Record<string, unknown>));
    const visibilityRows = this.db.prepare(`
      SELECT ingestion_id AS ingestionId, visibility FROM conversation_ingestions
    `).all().map((row) => normalizeRow(row as Record<string, unknown>));
    const visibilityByIngestionId = new Map(visibilityRows.map((row) => [
      String(row.ingestionId ?? ""),
      (row.visibility ?? "private") as MemoryEvent["permissionSnapshot"]["visibility"]
    ]));
    const messages = latestConversationEvidenceMessages(messageRows)
      .filter((message) => message.operation !== "delete")
      .map((message) => adaptConversationMessageEvidence(
        message,
        visibilityByIngestionId.get(message.ingestionId) ?? "private"
      ));
    const segmentRows = this.db.prepare(`SELECT segment_id AS segmentId FROM parsed_segments`).all()
      .map((row) => String((row as { segmentId?: string }).segmentId ?? ""));
    const segments = this.getParsedSegmentsByIds(segmentRows);
    const events = this.getMemoryEventsByIds([...new Set(segments.map((segment) => segment.eventId))]);
    const eventById = new Map(events.map((event) => [event.eventId, event]));
    const parsed = segments
      .filter((segment) => segment.status === "parsed" && !isConversationDerivedSegment(segment))
      .flatMap((segment) => {
        const event = eventById.get(segment.eventId);
        return event ? [adaptParsedSegmentEvidence(segment, event)] : [];
      });
    return filterAndScoreEvidenceCandidates([...messages, ...parsed], query);
  }

  override async getConversationSessionCursor(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }) {
    return this.readConversationCursor(scope);
  }

  override async updateConversationIngestionProcessing(
    ingestionId: string,
    update: ConversationIngestionProcessingUpdate
  ) {
    this.db.prepare(`
      UPDATE conversation_ingestions
      SET processing_status = ?, processing_stage = ?, progress_percent = ?,
          layer_counts = ?, retry_state = ?, last_error = ?, updated_at = ?
      WHERE ingestion_id = ?
    `).run(
      update.processingStatus,
      update.processingStage,
      update.progressPercent,
      JSON.stringify(update.layerCounts),
      JSON.stringify(update.retry),
      update.lastError ? JSON.stringify(update.lastError) : null,
      update.updatedAt,
      ingestionId
    );
  }

  override async getConversationIngestionJob(ingestionId: string) {
    const row = this.db.prepare(`
      SELECT * FROM conversation_ingestion_jobs WHERE ingestion_id = ? LIMIT 1
    `).get(ingestionId) as Record<string, unknown> | undefined;
    return row ? normalizeConversationIngestionJobRow(row) : undefined;
  }

  override async claimNextConversationIngestionJob(
    workerId: string,
    claimedAt: string,
    options: { includeFactPending?: boolean } = {}
  ) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db.prepare(`
        SELECT job_id, status FROM conversation_ingestion_jobs
        WHERE status = 'queued' OR (
          ? = 1 AND status = 'fact_pending' AND attempt < max_attempts AND
          (retry_after IS NULL OR retry_after <= ?)
        )
        ORDER BY created_at, job_id
        LIMIT 1
      `).get(options.includeFactPending === true ? 1 : 0, claimedAt) as {
        job_id?: string;
        status?: ConversationIngestionJobRecord["status"];
      } | undefined;
      if (!row?.job_id) {
        this.db.exec("COMMIT;");
        return undefined;
      }
      const changed = this.db.prepare(`
        UPDATE conversation_ingestion_jobs
        SET status = 'running', attempt = attempt + 1, claimed_by = ?, claimed_at = ?,
            heartbeat_at = ?, updated_at = ?
        WHERE job_id = ? AND status = ?
      `).run(workerId, claimedAt, claimedAt, claimedAt, row.job_id, row.status ?? "queued");
      if (changed.changes !== 1) {
        this.db.exec("COMMIT;");
        return undefined;
      }
      const claimed = this.db.prepare(`
        SELECT * FROM conversation_ingestion_jobs WHERE job_id = ? LIMIT 1
      `).get(row.job_id) as Record<string, unknown> | undefined;
      this.db.exec("COMMIT;");
      return claimed ? normalizeConversationIngestionJobRow(claimed) : undefined;
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      throw caught;
    }
  }

  override async saveConversationIngestionJob(job: ConversationIngestionJobRecord) {
    this.db.prepare(`
      INSERT INTO conversation_ingestion_jobs (
        job_id, ingestion_id, status, stage, attempt, max_attempts, retryable,
        retry_after, claimed_by, claimed_at, heartbeat_at, last_error,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status=excluded.status,
        stage=excluded.stage,
        attempt=excluded.attempt,
        max_attempts=excluded.max_attempts,
        retryable=excluded.retryable,
        retry_after=excluded.retry_after,
        claimed_by=excluded.claimed_by,
        claimed_at=excluded.claimed_at,
        heartbeat_at=excluded.heartbeat_at,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at,
        completed_at=excluded.completed_at
    `).run(
      job.jobId,
      job.ingestionId,
      job.status,
      job.stage,
      job.attempt,
      job.maxAttempts,
      job.retryable ? 1 : 0,
      job.retryAfter ?? null,
      job.claimedBy ?? null,
      job.claimedAt ?? null,
      job.heartbeatAt ?? null,
      job.lastError ? JSON.stringify(job.lastError) : null,
      job.createdAt,
      job.updatedAt,
      job.completedAt ?? null
    );
  }

  override async saveConversationMessageSegments(_records: ConversationMessageSegmentRecord[]) {
    throw legacyConversationPersistenceRemoved();
  }

  override async getConversationMessageSegments(ingestionId: string) {
    return super.getConversationMessageSegments(ingestionId);
  }

  override async saveConversationEvidenceGroup(_group: ConversationEvidenceGroupRecord) {
    throw legacyConversationPersistenceRemoved();
  }

  override async getConversationEvidenceGroups(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }, options: { latestOnly?: boolean } = {}) {
    return super.getConversationEvidenceGroups(scope, options);
  }

  override async saveConversationExtractionWindows(_windows: ConversationExtractionWindowRecord[]) {
    throw legacyConversationPersistenceRemoved();
  }

  override async getConversationExtractionWindows(groupId: string, groupVersion?: number) {
    return super.getConversationExtractionWindows(groupId, groupVersion);
  }

  override async saveConversationFactCandidates(_records: ConversationFactCandidateRecord[]) {
    throw legacyConversationPersistenceRemoved();
  }

  override async getConversationFactCandidates(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }) {
    return super.getConversationFactCandidates(scope);
  }

  override async clearAllContextData() {
    const result = await super.clearAllContextData();
    this.clearDatabaseTables();
    return result;
  }

  private clearDatabaseTables() {
    this.db.exec(`
      DELETE FROM conversation_ingestion_jobs;
      DELETE FROM conversation_session_cursors;
      DELETE FROM conversation_document_messages;
      DELETE FROM conversation_messages;
      DELETE FROM conversation_documents;
      DELETE FROM conversation_ingestions;
      DELETE FROM conversation_batch_ingestions;
      DELETE FROM context_text_index_fts;
      DELETE FROM graph_memory_nodes;
      DELETE FROM session_background_snapshots;
      DELETE FROM background_dynamic_cache;
      DELETE FROM background_maintenance_batches;
      DELETE FROM background_maintenance_tasks;
      DELETE FROM background_context_documents;
      DELETE FROM memory_feedback_items;
      DELETE FROM memory_retrieval_events;
      DELETE FROM dreaming_run_candidates;
      DELETE FROM dreaming_runs;
      DELETE FROM dreaming_candidate_decisions;
      DELETE FROM memory_change_events;
      DELETE FROM context_index_entries;
      DELETE FROM context_vector_index_entries;
      DELETE FROM context_pipeline_tasks;
      DELETE FROM llm_dreaming_traces;
      DELETE FROM llm_stm_admission_traces;
      DELETE FROM llm_fact_fusion_traces;
      DELETE FROM context_pack_traces;
      DELETE FROM relation_edges;
      DELETE FROM long_term_memories;
      DELETE FROM short_term_memories;
      DELETE FROM timeline_fusion_executions;
      DELETE FROM timeline_fusion_tasks;
      DELETE FROM fact_batches;
      DELETE FROM fact_versions;
      DELETE FROM fact_items;
      DELETE FROM parsed_segments;
      DELETE FROM event_source_refs;
      DELETE FROM source_refs;
      DELETE FROM permission_snapshots;
      DELETE FROM multimodal_data_items;
      DELETE FROM memory_events;
    `);
  }

  private queryAll<T>(sql: string): T[] {
    return this.db.prepare(sql).all().map((row) => normalizeRow(row)) as T[];
  }

  private readConversationCursor(scope: {
    tenantId: string;
    sourceApp: string;
    principalId: string;
    sessionId: string;
  }) {
    const row = this.db.prepare(`
      SELECT
        tenant_id AS tenantId,
        source_app AS sourceApp,
        principal_id AS principalId,
        session_id AS sessionId,
        committed_cursor AS committedCursor,
        last_sequence AS lastSequence,
        last_ingestion_id AS lastIngestionId,
        updated_at AS updatedAt
      FROM conversation_session_cursors
      WHERE tenant_id = ? AND source_app = ? AND principal_id = ? AND session_id = ?
      LIMIT 1
    `).get(
      scope.tenantId,
      scope.sourceApp,
      scope.principalId,
      scope.sessionId
    ) as Record<string, unknown> | undefined;
    return row ? normalizeRow(row) as unknown as ConversationSessionCursorRecord : undefined;
  }

  private resolveDatabaseConversationMessages(
    incomingMessages: readonly ConversationMessageRecord[],
    plannedMessages: readonly ConversationMessageRecord[]
  ) {
    const candidates = new Map<string, ConversationMessageRecord>();
    for (const message of plannedMessages) {
      candidates.set(message.conversationMessageRowId, message);
    }
    for (const message of incomingMessages) {
      for (const candidate of [
        this.findConversationMessage(message),
        this.findConversationMessageBySequence(message),
        this.findConversationMessageByRowId(message.conversationMessageRowId)
      ]) {
        if (candidate) candidates.set(candidate.conversationMessageRowId, candidate);
      }
    }
    return resolveConversationMessages([...candidates.values()], incomingMessages);
  }

  private findConversationMessage(message: ConversationMessageRecord) {
    const row = this.db.prepare(`
      SELECT ${conversationMessageSelectColumns("cm")}
      FROM conversation_messages AS cm
      WHERE cm.tenant_id = ? AND cm.principal_id = ? AND cm.source_app = ?
        AND cm.session_id = ? AND cm.message_id = ? AND cm.revision = ?
      LIMIT 1
    `).get(
      message.tenantId,
      message.principalId,
      message.sourceApp,
      message.sessionId,
      message.messageId,
      message.revision
    ) as Record<string, unknown> | undefined;
    return row ? normalizeConversationMessageRow(row) : undefined;
  }

  private findConversationMessageBySequence(message: ConversationMessageRecord) {
    const row = this.db.prepare(`
      SELECT ${conversationMessageSelectColumns("cm")}
      FROM conversation_messages AS cm
      WHERE cm.tenant_id = ? AND cm.principal_id = ? AND cm.source_app = ?
        AND cm.session_id = ? AND cm.sequence = ? AND cm.branch_id = ? AND cm.revision = ?
      LIMIT 1
    `).get(
      message.tenantId,
      message.principalId,
      message.sourceApp,
      message.sessionId,
      message.sequence,
      message.branchId,
      message.revision
    ) as Record<string, unknown> | undefined;
    return row ? normalizeConversationMessageRow(row) : undefined;
  }

  private findConversationMessageByRowId(conversationMessageRowId: string) {
    const row = this.db.prepare(`
      SELECT ${conversationMessageSelectColumns("cm")}
      FROM conversation_messages AS cm
      WHERE cm.conversation_message_row_id = ?
      LIMIT 1
    `).get(conversationMessageRowId) as Record<string, unknown> | undefined;
    return row ? normalizeConversationMessageRow(row) : undefined;
  }

  private insertConversationIngestion(ingestion: ConversationIngestionRecord) {
    this.db.prepare(`
      INSERT INTO conversation_ingestions (
        ingestion_id, batch_ingestion_id, idempotency_key, document_sha256, batch_id, session_id,
        source_app, tenant_id, principal_id, visibility, timezone, locale, temporal_mode, previous_cursor,
        committed_cursor, first_sequence, last_sequence, document_status,
        processing_status, processing_stage, processing_mode, progress_percent,
        message_counts, layer_counts, retry_state, last_error,
        created_at, committed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ingestion.ingestionId,
      ingestion.batchIngestionId ?? null,
      ingestion.idempotencyKey,
      ingestion.documentSha256,
      ingestion.batchId,
      ingestion.sessionId,
      ingestion.sourceApp,
      ingestion.tenantId,
      ingestion.principalId,
      ingestion.visibility,
      ingestion.timezone ?? null,
      ingestion.locale ?? null,
      ingestion.temporalMode,
      ingestion.previousCursor ?? null,
      ingestion.committedCursor,
      ingestion.firstSequence,
      ingestion.lastSequence,
      ingestion.documentStatus,
      ingestion.processingStatus,
      ingestion.processingStage,
      ingestion.processingMode,
      ingestion.progressPercent,
      JSON.stringify(ingestion.messageCounts),
      JSON.stringify(ingestion.layerCounts),
      JSON.stringify(ingestion.retry),
      ingestion.lastError ? JSON.stringify(ingestion.lastError) : null,
      ingestion.createdAt,
      ingestion.committedAt,
      ingestion.updatedAt
    );
  }

  private insertConversationMessage(message: ConversationMessageRecord) {
    this.db.prepare(`
      INSERT INTO conversation_messages (
        conversation_message_row_id, first_ingestion_id, tenant_id, principal_id,
        source_app, session_id, batch_id, message_id, sequence, role, status,
        content_type, content, content_sha256, reply_to_message_id,
        parent_message_id, branch_id, tool_call_id, tool_name, revision,
        operation, metadata, created_at, completed_at, timezone, locale,
        time_confidence, stored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.conversationMessageRowId,
      message.ingestionId,
      message.tenantId,
      message.principalId,
      message.sourceApp,
      message.sessionId,
      message.batchId,
      message.messageId,
      message.sequence,
      message.role,
      message.status,
      message.contentType,
      message.content,
      message.contentSha256,
      message.replyToMessageId ?? null,
      message.parentMessageId ?? null,
      message.branchId,
      message.toolCallId ?? null,
      message.toolName ?? null,
      message.revision,
      message.operation,
      message.metadata ? JSON.stringify(message.metadata) : null,
      message.createdAt,
      message.completedAt ?? null,
      message.timezone ?? null,
      message.locale ?? null,
      message.timeConfidence,
      message.storedAt
    );
  }

  private upsertConversationMessage(message: ConversationMessageRecord) {
    this.db.prepare(`
      INSERT INTO conversation_messages (
        conversation_message_row_id, first_ingestion_id, tenant_id, principal_id,
        source_app, session_id, batch_id, message_id, sequence, role, status,
        content_type, content, content_sha256, reply_to_message_id,
        parent_message_id, branch_id, tool_call_id, tool_name, revision,
        operation, metadata, created_at, completed_at, timezone, locale,
        time_confidence, stored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_message_row_id) DO UPDATE SET
        first_ingestion_id=excluded.first_ingestion_id,
        tenant_id=excluded.tenant_id,
        principal_id=excluded.principal_id,
        source_app=excluded.source_app,
        session_id=excluded.session_id,
        batch_id=excluded.batch_id,
        message_id=excluded.message_id,
        sequence=excluded.sequence,
        role=excluded.role,
        status=excluded.status,
        content_type=excluded.content_type,
        content=excluded.content,
        content_sha256=excluded.content_sha256,
        reply_to_message_id=excluded.reply_to_message_id,
        parent_message_id=excluded.parent_message_id,
        branch_id=excluded.branch_id,
        tool_call_id=excluded.tool_call_id,
        tool_name=excluded.tool_name,
        revision=excluded.revision,
        metadata=excluded.metadata,
        created_at=excluded.created_at,
        completed_at=excluded.completed_at,
        timezone=excluded.timezone,
        locale=excluded.locale,
        time_confidence=excluded.time_confidence,
        stored_at=excluded.stored_at,
        operation=excluded.operation
    `).run(
      message.conversationMessageRowId,
      message.ingestionId,
      message.tenantId,
      message.principalId,
      message.sourceApp,
      message.sessionId,
      message.batchId,
      message.messageId,
      message.sequence,
      message.role,
      message.status,
      message.contentType,
      message.content,
      message.contentSha256,
      message.replyToMessageId ?? null,
      message.parentMessageId ?? null,
      message.branchId,
      message.toolCallId ?? null,
      message.toolName ?? null,
      message.revision,
      message.operation,
      message.metadata ? JSON.stringify(message.metadata) : null,
      message.createdAt,
      message.completedAt ?? null,
      message.timezone ?? null,
      message.locale ?? null,
      message.timeConfidence,
      message.storedAt
    );
  }

  private upsertConversationCursor(cursor: ConversationSessionCursorRecord) {
    this.db.prepare(`
      INSERT INTO conversation_session_cursors (
        tenant_id, source_app, principal_id, session_id, committed_cursor,
        last_sequence, last_ingestion_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, source_app, principal_id, session_id) DO UPDATE SET
        committed_cursor=excluded.committed_cursor,
        last_sequence=MAX(conversation_session_cursors.last_sequence, excluded.last_sequence),
        last_ingestion_id=excluded.last_ingestion_id,
        updated_at=excluded.updated_at
    `).run(
      cursor.tenantId,
      cursor.sourceApp,
      cursor.principalId,
      cursor.sessionId,
      cursor.committedCursor,
      cursor.lastSequence,
      cursor.lastIngestionId,
      cursor.updatedAt
    );
  }

  private insertConversationIngestionJob(job: ConversationIngestionJobRecord) {
    this.db.prepare(`
      INSERT INTO conversation_ingestion_jobs (
        job_id, ingestion_id, status, stage, attempt, max_attempts,
        retryable, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.jobId,
      job.ingestionId,
      job.status,
      job.stage,
      job.attempt,
      job.maxAttempts,
      job.retryable ? 1 : 0,
      job.createdAt,
      job.updatedAt
    );
  }

  private applyMigrations() {
    this.addColumnIfMissing("memory_events", "context_scope_id", "TEXT");
    this.addColumnIfMissing("fact_items", "tenant_id", "TEXT");
    this.addColumnIfMissing("fact_items", "principal_id", "TEXT");
    this.addColumnIfMissing("fact_items", "context_scope_id", "TEXT");
    this.addColumnIfMissing("fact_items", "session_id", "TEXT");
    this.addColumnIfMissing("fact_items", "fact_sequence", "INTEGER");
    this.addColumnIfMissing("fact_items", "source_claim", "TEXT");
    this.addColumnIfMissing("fact_batches", "context_scope_id", "TEXT");
    this.addColumnIfMissing("timeline_fusion_tasks", "context_scope_id", "TEXT");
    this.addColumnIfMissing("timeline_fusion_executions", "context_scope_id", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fact_items_owner_scope_status
        ON fact_items(tenant_id, principal_id, context_scope_id, status, fact_id);
      CREATE INDEX IF NOT EXISTS idx_timeline_fusion_tasks_owner_scope_status
        ON timeline_fusion_tasks(tenant_id, principal_id, context_scope_id, status, scheduled_at, task_id);
    `);
    this.addColumnIfMissing(
      "timeline_fusion_tasks",
      "execution_fingerprints",
      "TEXT NOT NULL DEFAULT '[]'"
    );
    this.addColumnIfMissing("timeline_fusion_tasks", "completion_reason", "TEXT");
    this.addColumnIfMissing("timeline_fusion_executions", "completion_reason", "TEXT");
    this.addColumnIfMissing("context_pack_traces", "temporal_trace", "TEXT");
    this.addColumnIfMissing("llm_fact_fusion_traces", "temporal_trace", "TEXT");
    this.addColumnIfMissing("conversation_ingestions", "batch_ingestion_id", "TEXT");
    this.addColumnIfMissing("conversation_ingestions", "timezone", "TEXT");
    this.addColumnIfMissing("conversation_ingestions", "locale", "TEXT");
    this.addColumnIfMissing("conversation_ingestions", "temporal_mode", "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumnIfMissing("conversation_documents", "batch_ingestion_id", "TEXT");
    this.migrateConversationEvidenceTables();
    this.addColumnIfMissing("fact_items", "linked_event_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("fact_items", "linked_segment_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("fact_items", "linked_source_refs", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("fact_items", "entity_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("fact_items", "evidence_time", "TEXT");
    this.addColumnIfMissing("fact_items", "valid_time", "TEXT");
    this.migrateFactTemporalColumns();
    this.migrateFactOwnershipColumns();
    this.migrateFactVersionSourceFingerprints();
    this.addColumnIfMissing("memory_events", "data_source", "TEXT");
    this.addColumnIfMissing("memory_events", "event_summary", "TEXT");
    this.addColumnIfMissing("memory_events", "custom_fields", "TEXT NOT NULL DEFAULT '{}'");
    this.addColumnIfMissing("multimodal_data_items", "source_item_id", "TEXT");
    this.addColumnIfMissing("multimodal_data_items", "source_ref", "TEXT");
    this.addColumnIfMissing("multimodal_data_items", "source_refs", "TEXT");
    this.addColumnIfMissing("multimodal_data_items", "custom_fields", "TEXT NOT NULL DEFAULT '{}'");
    this.addColumnIfMissing("parsed_segments", "data_source", "TEXT");
    this.addColumnIfMissing("parsed_segments", "custom_fields", "TEXT NOT NULL DEFAULT '{}'");
    this.addColumnIfMissing("long_term_memories", "source_refs", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("long_term_memories", "tenant_id", "TEXT");
    this.addColumnIfMissing("long_term_memories", "principal_id", "TEXT");
    this.addColumnIfMissing("long_term_memories", "source_memory_data_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("long_term_memories", "source_fact_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("long_term_memories", "entity_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("long_term_memories", "matched_rules", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("long_term_memories", "access_state", "TEXT");
    this.addColumnIfMissing("short_term_memories", "memory_type", "TEXT NOT NULL DEFAULT 'fact'");
    this.addColumnIfMissing("short_term_memories", "fact_summary", "TEXT");
    this.addColumnIfMissing("long_term_memories", "fact_summary", "TEXT");
    this.addColumnIfMissing("graph_memory_nodes", "memory_type", "TEXT");
    this.addColumnIfMissing("graph_memory_nodes", "fact_summary", "TEXT");
    this.addColumnIfMissing("short_term_memories", "structured_facts", "TEXT");
    this.addColumnIfMissing("long_term_memories", "structured_facts", "TEXT");
    this.addColumnIfMissing("long_term_memories", "consolidation_key", "TEXT");
    this.addColumnIfMissing("long_term_memories", "version", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("long_term_memories", "previous_version_id", "TEXT");
    this.addColumnIfMissing("long_term_memories", "consolidation_score", "REAL");
    this.addColumnIfMissing("long_term_memories", "consolidation_factors", "TEXT");
    this.addColumnIfMissing("long_term_memories", "policy_version", "TEXT");
    this.addColumnIfMissing("long_term_memories", "prompt_version", "TEXT");
    this.addColumnIfMissing("long_term_memories", "model", "TEXT");
    this.addColumnIfMissing("long_term_memories", "created_at", "TEXT");
    this.addColumnIfMissing("long_term_memories", "updated_at", "TEXT");
    this.addColumnIfMissing("long_term_memories", "last_maintained_at", "TEXT");
    this.addColumnIfMissing("short_term_memories", "retrieval_weight", "REAL NOT NULL DEFAULT 0.2");
    this.addColumnIfMissing("short_term_memories", "user_retrieval_weight", "REAL");
    this.addColumnIfMissing("short_term_memories", "source_fact_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("short_term_memories", "source_refs", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("short_term_memories", "entity_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("short_term_memories", "matched_rules", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("short_term_memories", "access_state", "TEXT");
    this.addColumnIfMissing("short_term_memories", "consolidation_status", "TEXT NOT NULL DEFAULT 'unseen'");
    this.addColumnIfMissing("short_term_memories", "next_evaluate_at", "TEXT");
    this.addColumnIfMissing("short_term_memories", "last_evaluated_at", "TEXT");
    this.addColumnIfMissing("short_term_memories", "observe_count", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("short_term_memories", "reevaluation_reason", "TEXT");
    this.addColumnIfMissing("short_term_memories", "expires_at", "TEXT");
    this.addColumnIfMissing("short_term_memories", "dreaming_policy_version", "TEXT");
    this.addColumnIfMissing("short_term_memories", "latest_decision_id", "TEXT");
    this.addColumnIfMissing("short_term_memories", "reevaluation_tier", "TEXT");
    this.addColumnIfMissing("short_term_memories", "cycle_attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("short_term_memories", "total_attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("short_term_memories", "last_dreaming_error", "TEXT");
    this.addColumnIfMissing("short_term_memories", "latest_dreaming_run_id", "TEXT");
    this.addColumnIfMissing("dreaming_runs", "pause_reason", "TEXT");
    this.migrateLegacyDreamingStatuses();
    this.addColumnIfMissing("llm_dreaming_traces", "retry_after", "TEXT");
    this.addColumnIfMissing("llm_dreaming_traces", "stm_evaluations", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("llm_dreaming_traces", "ltm_operations", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("context_pipeline_tasks", "checkpoint", "TEXT");
    this.addColumnIfMissing("context_pipeline_tasks", "lease_owner", "TEXT");
    this.addColumnIfMissing("context_pipeline_tasks", "lease_expires_at", "TEXT");
    this.addColumnIfMissing("context_pipeline_tasks", "stats", "TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS dreaming_outbox (
      outbox_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dreaming_candidate_decisions (
      decision_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_fingerprint TEXT NOT NULL,
      memory_data_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason_codes TEXT NOT NULL DEFAULT '[]',
      source_fact_ids TEXT NOT NULL DEFAULT '[]',
      source_refs TEXT NOT NULL DEFAULT '[]',
      permission_snapshot_ids TEXT NOT NULL DEFAULT '[]',
      policy_version TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      next_evaluate_at TEXT,
      created_at TEXT NOT NULL
    )`);
    this.migrateShortTermMemoryOwnerAndTime();
    this.migrateMemoryTemporalColumns();
    this.normalizeLegacyHiddenShortTermMemories();
    this.migrateBackgroundContextDocuments();
    this.addColumnIfMissing(
      "background_dynamic_cache",
      "reference_time",
      "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"
    );
    this.addColumnIfMissing(
      "background_dynamic_cache",
      "timezone",
      "TEXT NOT NULL DEFAULT 'Asia/Shanghai'"
    );
    this.addColumnIfMissing(
      "background_dynamic_cache",
      "locale",
      "TEXT NOT NULL DEFAULT 'zh-CN'"
    );
    this.addColumnIfMissing(
      "background_dynamic_cache",
      "local_date",
      "TEXT NOT NULL DEFAULT '1970-01-01'"
    );
    this.addColumnIfMissing(
      "session_background_snapshots",
      "reference_time",
      "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"
    );
    this.addColumnIfMissing(
      "session_background_snapshots",
      "timezone",
      "TEXT NOT NULL DEFAULT 'Asia/Shanghai'"
    );
    this.addColumnIfMissing(
      "session_background_snapshots",
      "locale",
      "TEXT NOT NULL DEFAULT 'zh-CN'"
    );
    this.addColumnIfMissing(
      "session_background_snapshots",
      "local_date",
      "TEXT NOT NULL DEFAULT '1970-01-01'"
    );
    this.addColumnIfMissing("long_term_memories", "retrieval_weight", "REAL NOT NULL DEFAULT 0.3");
    this.addColumnIfMissing("long_term_memories", "user_retrieval_weight", "REAL");
    this.addColumnIfMissing("graph_memory_nodes", "retrieval_weight", "REAL NOT NULL DEFAULT 0.3");
    this.addColumnIfMissing("relation_edges", "strength", "REAL");
    this.addColumnIfMissing("relation_edges", "confidence", "TEXT");
    this.addColumnIfMissing("relation_edges", "source", "TEXT");
    this.addColumnIfMissing("relation_edges", "created_at", "TEXT");
    this.ensureTextIndexFts();
    this.backfillLegacyTextIndexTable();
    this.dropLegacyTextIndexTable();
  }

  private migrateLegacyDreamingStatuses() {
    // The old retryable_failure state represents a candidate waiting for the
    // next evaluation cycle. Keep its existing deadline while adopting the
    // durable retry_wait contract used by Dreaming Runs.
    this.db.exec(`
      UPDATE short_term_memories
      SET consolidation_status = 'retry_wait'
      WHERE consolidation_status = 'retryable_failure'
    `);
  }

  private migrateMemoryTemporalColumns() {
    for (const table of ["short_term_memories", "long_term_memories", "graph_memory_nodes"]) {
      this.addColumnIfMissing(table, "evidence_time_start", "TEXT");
      this.addColumnIfMissing(table, "evidence_time_end", "TEXT");
      this.addColumnIfMissing(table, "evidence_time_confidence", "TEXT NOT NULL DEFAULT 'low'");
      this.addColumnIfMissing(table, "valid_time_start", "TEXT");
      this.addColumnIfMissing(table, "valid_time_end", "TEXT");
      this.addColumnIfMissing(table, "valid_time_confidence", "TEXT NOT NULL DEFAULT 'low'");
    }
    this.addColumnIfMissing("short_term_memories", "evidence_time", "TEXT");
    this.addColumnIfMissing("short_term_memories", "valid_time", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_stm_owner_evidence_time
        ON short_term_memories(tenant_id, principal_id, evidence_time_start, evidence_time_end, memory_data_id);
      CREATE INDEX IF NOT EXISTS idx_stm_owner_valid_time
        ON short_term_memories(tenant_id, principal_id, valid_time_start, valid_time_end, memory_data_id);
      CREATE INDEX IF NOT EXISTS idx_ltm_evidence_time
        ON long_term_memories(evidence_time_start, evidence_time_end, memory_id);
      CREATE INDEX IF NOT EXISTS idx_ltm_valid_time
        ON long_term_memories(valid_time_start, valid_time_end, memory_id);
      CREATE INDEX IF NOT EXISTS idx_graph_memory_nodes_evidence_time
        ON graph_memory_nodes(owner_type, evidence_time_start, evidence_time_end, owner_id);
      CREATE INDEX IF NOT EXISTS idx_graph_memory_nodes_valid_time
        ON graph_memory_nodes(owner_type, valid_time_start, valid_time_end, owner_id);
    `);
  }

  private migrateFactTemporalColumns() {
    this.addColumnIfMissing("fact_items", "time_anchor", "TEXT");
    this.addColumnIfMissing("fact_items", "temporal_events", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("fact_items", "evidence_time_start", "TEXT");
    this.addColumnIfMissing("fact_items", "evidence_time_end", "TEXT");
    this.addColumnIfMissing("fact_items", "evidence_time_confidence", "TEXT NOT NULL DEFAULT 'low'");
    this.addColumnIfMissing("fact_items", "source_message_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("fact_items", "valid_time_basis", "TEXT");
    this.addColumnIfMissing("fact_items", "valid_time_confidence", "TEXT NOT NULL DEFAULT 'low'");

    const validTimeColumn = (this.db.prepare("PRAGMA table_info(fact_items)").all() as Array<{
      name?: string;
      notnull?: number;
    }>).find((column) => column.name === "valid_time_start");
    if (validTimeColumn?.notnull !== 1) {
      this.createFactTemporalIndexes();
      return;
    }

    this.db.exec("PRAGMA foreign_keys=OFF;");
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.exec(`
        CREATE TABLE fact_items__temporal_v1 (
          fact_id TEXT PRIMARY KEY,
          session_id TEXT,
          fact_sequence INTEGER,
          tenant_id TEXT,
          principal_id TEXT,
          context_scope_id TEXT,
          fact_type TEXT NOT NULL,
          fact_text TEXT NOT NULL,
          time_anchor TEXT,
          source_claim TEXT,
          normalized_claim TEXT NOT NULL,
          linked_event_ids TEXT NOT NULL DEFAULT '[]',
          linked_segment_ids TEXT NOT NULL DEFAULT '[]',
          linked_source_refs TEXT NOT NULL DEFAULT '[]',
          entity_ids TEXT NOT NULL DEFAULT '[]',
          confidence_level TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'active',
          observed_at TEXT NOT NULL,
          evidence_time TEXT,
          valid_time TEXT,
          temporal_events TEXT NOT NULL DEFAULT '[]',
          evidence_time_start TEXT,
          evidence_time_end TEXT,
          evidence_time_confidence TEXT NOT NULL DEFAULT 'low',
          source_message_ids TEXT NOT NULL DEFAULT '[]',
          valid_time_start TEXT,
          valid_time_end TEXT,
          valid_time_basis TEXT,
          valid_time_confidence TEXT NOT NULL DEFAULT 'low',
          time_basis TEXT NOT NULL,
          time_confidence TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        INSERT INTO fact_items__temporal_v1 (
          fact_id, session_id, fact_sequence, tenant_id, principal_id, context_scope_id, fact_type, fact_text,
          time_anchor, source_claim, normalized_claim, linked_event_ids,
          linked_segment_ids, linked_source_refs, entity_ids, confidence_level,
          version, status, observed_at, evidence_time, valid_time, temporal_events,
          evidence_time_start, evidence_time_end,
          evidence_time_confidence, source_message_ids, valid_time_start,
          valid_time_end, valid_time_basis, valid_time_confidence, time_basis,
          time_confidence, schema_version
        )
        SELECT
          fact_id, session_id, fact_sequence, tenant_id, principal_id, context_scope_id, fact_type, fact_text,
          time_anchor, source_claim, normalized_claim, linked_event_ids,
          linked_segment_ids, linked_source_refs, entity_ids, confidence_level,
          version, status, observed_at, evidence_time, valid_time, temporal_events,
          evidence_time_start, evidence_time_end,
          evidence_time_confidence, source_message_ids, valid_time_start,
          valid_time_end, COALESCE(valid_time_basis, time_basis),
          COALESCE(time_confidence, valid_time_confidence, 'low'), time_basis,
          time_confidence, schema_version
        FROM fact_items;

        DROP TABLE fact_items;
        ALTER TABLE fact_items__temporal_v1 RENAME TO fact_items;
      `);
      this.createFactTemporalIndexes();
      this.db.exec("COMMIT;");
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      throw caught;
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON;");
    }
  }

  private createFactTemporalIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fact_items_status_version
        ON fact_items(status, version);
      CREATE INDEX IF NOT EXISTS idx_fact_items_evidence_time
        ON fact_items(evidence_time_start, evidence_time_end);
      CREATE INDEX IF NOT EXISTS idx_fact_items_valid_time
        ON fact_items(valid_time_start, valid_time_end);
    `);
  }

  private migrateFactOwnershipColumns() {
    this.addColumnIfMissing("fact_items", "tenant_id", "TEXT");
    this.addColumnIfMissing("fact_items", "principal_id", "TEXT");
    const facts = this.db.prepare(`
      SELECT fact_id AS factId, tenant_id AS tenantId, principal_id AS principalId,
             linked_event_ids AS linkedEventIds
      FROM fact_items
      WHERE tenant_id IS NULL OR principal_id IS NULL
    `).all().map((row) => normalizeRow(row as Record<string, unknown>)) as Array<{
      factId: string;
      tenantId?: string;
      principalId?: string;
      linkedEventIds?: unknown;
    }>;
    const ownerKeysByFactId = new Map<string, Set<string>>();
    const addOwner = (factId: string, tenantId: string, principalId: string) => {
      const keys = ownerKeysByFactId.get(factId) ?? new Set<string>();
      keys.add(`${tenantId}\u001f${principalId}`);
      ownerKeysByFactId.set(factId, keys);
    };
    const batchRows = this.db.prepare(`
      SELECT tenant_id AS tenantId, principal_id AS principalId, new_fact_ids AS newFactIds
      FROM fact_batches
    `).all().map((row) => normalizeRow(row as Record<string, unknown>)) as Array<{
      tenantId: string;
      principalId: string;
      newFactIds?: unknown;
    }>;
    for (const batch of batchRows) {
      for (const factId of Array.isArray(batch.newFactIds) ? batch.newFactIds : []) {
        if (typeof factId === "string") addOwner(factId, batch.tenantId, batch.principalId);
      }
    }
    const eventRows = this.db.prepare(`
      SELECT event_id AS eventId, tenant_id AS tenantId, principal_id AS principalId
      FROM memory_events
    `).all().map((row) => normalizeRow(row as Record<string, unknown>)) as Array<{
      eventId: string;
      tenantId: string;
      principalId: string;
    }>;
    const eventOwner = new Map(eventRows.map((event) => [event.eventId, event]));
    for (const fact of facts) {
      for (const eventId of Array.isArray(fact.linkedEventIds) ? fact.linkedEventIds : []) {
        if (typeof eventId !== "string") continue;
        const owner = eventOwner.get(eventId);
        if (owner) addOwner(fact.factId, owner.tenantId, owner.principalId);
      }
      const ownerKeys = ownerKeysByFactId.get(fact.factId);
      if (ownerKeys?.size !== 1) continue;
      const [tenantId, principalId] = [...ownerKeys][0]!.split("\u001f");
      if (!tenantId || !principalId) continue;
      if (
        (fact.tenantId && fact.tenantId !== tenantId) ||
        (fact.principalId && fact.principalId !== principalId)
      ) continue;
      this.db.prepare(`
        UPDATE fact_items SET tenant_id = ?, principal_id = ? WHERE fact_id = ?
      `).run(tenantId, principalId, fact.factId);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fact_items_owner_evidence_time
        ON fact_items(tenant_id, principal_id, status, evidence_time_start, evidence_time_end, fact_id)
        WHERE tenant_id IS NOT NULL AND principal_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_fact_items_owner_valid_time
        ON fact_items(tenant_id, principal_id, status, valid_time_start, valid_time_end, fact_id)
        WHERE tenant_id IS NOT NULL AND principal_id IS NOT NULL;
    `);
  }

  private migrateFactVersionSourceFingerprints() {
    this.addColumnIfMissing("fact_versions", "source_fingerprint", "TEXT");
    this.db.exec(`
      UPDATE fact_versions
      SET source_fingerprint = 'legacy_fact_version_' || fact_version_id
      WHERE source_fingerprint IS NULL OR trim(source_fingerprint) = '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_versions_owner_source_fingerprint
        ON fact_versions(tenant_id, principal_id, source_fingerprint)
        WHERE source_fingerprint IS NOT NULL;
    `);
  }

  private normalizeLegacyHiddenShortTermMemories() {
    this.db.prepare(`
      UPDATE short_term_memories
      SET access_state = 'visible'
      WHERE access_state = 'hidden'
    `).run();
  }

  private migrateShortTermMemoryOwnerAndTime() {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.addColumnIfMissing("short_term_memories", "tenant_id", "TEXT");
      this.addColumnIfMissing("short_term_memories", "principal_id", "TEXT");
      this.addColumnIfMissing("short_term_memories", "created_at", "TEXT");
      this.addColumnIfMissing("short_term_memories", "updated_at", "TEXT");
      this.addColumnIfMissing("short_term_memories", "evidence_time", "TEXT");
      this.addColumnIfMissing("short_term_memories", "valid_time", "TEXT");
      this.addColumnIfMissing("short_term_memories", "evidence_time_start", "TEXT");
      this.addColumnIfMissing("short_term_memories", "evidence_time_end", "TEXT");
      this.addColumnIfMissing("short_term_memories", "evidence_time_confidence", "TEXT NOT NULL DEFAULT 'low'");
      this.addColumnIfMissing("short_term_memories", "valid_time_start", "TEXT");
      this.addColumnIfMissing("short_term_memories", "valid_time_end", "TEXT");
      this.addColumnIfMissing("short_term_memories", "valid_time_confidence", "TEXT NOT NULL DEFAULT 'low'");

      const migrationTimestamp = new Date().toISOString();
      const rows = this.db.prepare(`
        SELECT
          stm.memory_data_id AS memoryDataId,
          stm.tenant_id AS tenantId,
          stm.principal_id AS principalId,
          stm.created_at AS createdAt,
          stm.updated_at AS updatedAt,
          COUNT(DISTINCT event.tenant_id || char(31) || event.principal_id) AS ownerCount,
          MIN(event.tenant_id) AS sourceTenantId,
          MIN(event.principal_id) AS sourcePrincipalId,
          MAX(fact.observed_at) AS factObservedAt,
          MAX(event.event_time) AS eventTime,
          (
            SELECT MAX(change.created_at)
            FROM memory_change_events AS change
            WHERE change.memory_data_id = stm.memory_data_id
          ) AS latestChangeAt
        FROM short_term_memories AS stm
        LEFT JOIN json_each(
          CASE WHEN json_valid(stm.source_fact_ids) THEN stm.source_fact_ids ELSE '[]' END
        ) AS source_fact
        LEFT JOIN fact_items AS fact ON fact.fact_id = source_fact.value
        LEFT JOIN json_each(
          CASE WHEN json_valid(fact.linked_event_ids) THEN fact.linked_event_ids ELSE '[]' END
        ) AS source_event
        LEFT JOIN memory_events AS event ON event.event_id = source_event.value
        GROUP BY stm.memory_data_id
      `).all() as Array<{
        memoryDataId: string;
        tenantId: string | null;
        principalId: string | null;
        createdAt: string | null;
        updatedAt: string | null;
        ownerCount: number;
        sourceTenantId: string | null;
        sourcePrincipalId: string | null;
        factObservedAt: string | null;
        eventTime: string | null;
        latestChangeAt: string | null;
      }>;

      const update = this.db.prepare(`
        UPDATE short_term_memories
        SET tenant_id = ?, principal_id = ?, created_at = ?, updated_at = ?
        WHERE memory_data_id = ?
      `);

      for (const row of rows) {
        if (row.ownerCount > 1) {
          throw new Error(`STM_OWNER_MIGRATION_CONFLICT:${row.memoryDataId}`);
        }
        if (row.tenantId && row.sourceTenantId && row.tenantId !== row.sourceTenantId) {
          throw new Error(`STM_OWNER_MIGRATION_CONFLICT:${row.memoryDataId}`);
        }
        if (row.principalId && row.sourcePrincipalId && row.principalId !== row.sourcePrincipalId) {
          throw new Error(`STM_OWNER_MIGRATION_CONFLICT:${row.memoryDataId}`);
        }

        const tenantId = row.tenantId || row.sourceTenantId;
        const principalId = row.principalId || row.sourcePrincipalId;
        if (!tenantId || !principalId) {
          throw new Error(`STM_OWNER_MIGRATION_UNRESOLVED:${row.memoryDataId}`);
        }

        const createdAt = validIsoTimestampOrUndefined(row.createdAt)
          ?? validIsoTimestampOrUndefined(row.factObservedAt)
          ?? validIsoTimestampOrUndefined(row.eventTime)
          ?? migrationTimestamp;
        const updatedAt = latestIsoTimestamp(
          createdAt,
          validIsoTimestampOrUndefined(row.updatedAt),
          validIsoTimestampOrUndefined(row.latestChangeAt)
        );
        update.run(tenantId, principalId, createdAt, updatedAt, row.memoryDataId);
      }

      const invalid = this.db.prepare(`
        SELECT memory_data_id AS memoryDataId
        FROM short_term_memories
        WHERE tenant_id IS NULL OR trim(tenant_id) = ''
           OR principal_id IS NULL OR trim(principal_id) = ''
           OR created_at IS NULL OR trim(created_at) = ''
           OR updated_at IS NULL OR trim(updated_at) = ''
        LIMIT 1
      `).get() as { memoryDataId?: string } | undefined;
      if (invalid?.memoryDataId) {
        throw new Error(`STM_OWNER_TIME_MIGRATION_INCOMPLETE:${invalid.memoryDataId}`);
      }

      if (this.shortTermMemoryOwnerColumnsNeedRebuild()) {
        this.rebuildShortTermMemoryTable();
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_stm_lifecycle
          ON short_term_memories(lifecycle_status);
        CREATE INDEX IF NOT EXISTS idx_stm_owner_created
          ON short_term_memories(tenant_id, principal_id, created_at, memory_data_id);
        CREATE INDEX IF NOT EXISTS idx_stm_owner_updated
          ON short_term_memories(tenant_id, principal_id, updated_at, memory_data_id);
      `);
      this.db.exec("COMMIT;");
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      throw caught;
    }
  }

  private shortTermMemoryOwnerColumnsNeedRebuild() {
    const columns = this.db.prepare("PRAGMA table_info(short_term_memories)").all() as Array<{
      name?: string;
      notnull?: number;
    }>;
    return ["tenant_id", "principal_id", "created_at", "updated_at"].some((name) =>
      columns.find((column) => column.name === name)?.notnull !== 1
    );
  }

  private rebuildShortTermMemoryTable() {
    this.db.exec(`
      CREATE TABLE short_term_memories__owner_time_v1 (
        memory_data_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        memory_data_type TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'fact',
        content TEXT NOT NULL,
        structured_facts TEXT,
        fact_summary TEXT,
        summary TEXT,
        evidence_time TEXT,
        valid_time TEXT,
        evidence_time_start TEXT,
        evidence_time_end TEXT,
        evidence_time_confidence TEXT NOT NULL DEFAULT 'low',
        valid_time_start TEXT,
        valid_time_end TEXT,
        valid_time_confidence TEXT NOT NULL DEFAULT 'low',
        importance_level TEXT NOT NULL,
        retrieval_weight REAL NOT NULL DEFAULT 0.2,
        user_retrieval_weight REAL,
        confidence_level TEXT NOT NULL,
        admission_result TEXT NOT NULL,
        admission_reason TEXT NOT NULL,
        source_fact_ids TEXT NOT NULL DEFAULT '[]',
        source_refs TEXT NOT NULL DEFAULT '[]',
        entity_ids TEXT NOT NULL DEFAULT '[]',
        matched_rules TEXT NOT NULL DEFAULT '[]',
        admission_signals TEXT NOT NULL DEFAULT '{}',
        access_state TEXT,
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO short_term_memories__owner_time_v1 (
        memory_data_id, tenant_id, principal_id, memory_data_type, memory_type,
        content, structured_facts, fact_summary, summary,
        evidence_time, valid_time, evidence_time_start, evidence_time_end,
        evidence_time_confidence, valid_time_start, valid_time_end, valid_time_confidence,
        importance_level,
        retrieval_weight, user_retrieval_weight, confidence_level,
        admission_result, admission_reason, source_fact_ids, source_refs,
        entity_ids, matched_rules, admission_signals, access_state,
        lifecycle_status, created_at, updated_at
      )
      SELECT
        memory_data_id, tenant_id, principal_id, memory_data_type, memory_type,
        content, structured_facts, fact_summary, summary,
        evidence_time, valid_time, evidence_time_start, evidence_time_end,
        evidence_time_confidence, valid_time_start, valid_time_end, valid_time_confidence,
        importance_level,
        retrieval_weight, user_retrieval_weight, confidence_level,
        admission_result, admission_reason, source_fact_ids, source_refs,
        entity_ids, matched_rules, admission_signals, access_state,
        lifecycle_status, created_at, updated_at
      FROM short_term_memories;

      DROP TABLE short_term_memories;
      ALTER TABLE short_term_memories__owner_time_v1 RENAME TO short_term_memories;
    `);
  }

  private migrateBackgroundContextDocuments() {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.addColumnIfMissing("background_context_documents", "tenant_id", "TEXT");
      this.addColumnIfMissing("background_context_documents", "principal_id", "TEXT");
      this.addColumnIfMissing("background_context_documents", "fixed_revision", "INTEGER");
      this.addColumnIfMissing("background_context_documents", "fixed_text_updated_at", "TEXT");
      this.addColumnIfMissing("background_context_documents", "fixed_watermark_json", "TEXT");
      this.addColumnIfMissing("background_context_documents", "dynamic_window_start", "TEXT");
      this.addColumnIfMissing("background_context_documents", "dynamic_window_end", "TEXT");
      this.addColumnIfMissing("background_context_documents", "dynamic_source_memory_ids_json", "TEXT");
      this.addColumnIfMissing("background_context_documents", "latest_stm_cursor_json", "TEXT");
      this.addColumnIfMissing("background_context_documents", "dynamic_cache_key", "TEXT");
      this.addColumnIfMissing("background_context_documents", "update_suggestion_target_sections", "TEXT");

      const rows = this.db.prepare(`
        SELECT
          background.background_id AS backgroundId,
          background.tenant_id AS tenantId,
          background.principal_id AS principalId,
          background.fixed_revision AS fixedRevision,
          background.fixed_text_updated_at AS fixedTextUpdatedAt,
          background.fixed_watermark_json AS fixedWatermark,
          background.dynamic_window_start AS dynamicWindowStart,
          background.dynamic_window_end AS dynamicWindowEnd,
          background.dynamic_source_memory_ids_json AS dynamicSourceMemoryIds,
          background.latest_stm_cursor_json AS latestStmCursor,
          background.dynamic_cache_key AS dynamicCacheKey,
          background.update_suggestion_target_sections AS updateSuggestionTargetSections,
          background.created_at AS createdAt,
          background.updated_at AS updatedAt,
          COUNT(DISTINCT CASE
            WHEN event.tenant_id IS NOT NULL AND event.principal_id IS NOT NULL
            THEN event.tenant_id || char(31) || event.principal_id
          END) AS ownerCount,
          MIN(event.tenant_id) AS sourceTenantId,
          MIN(event.principal_id) AS sourcePrincipalId
        FROM background_context_documents AS background
        LEFT JOIN json_each(
          CASE WHEN json_valid(background.source_ref_ids) THEN background.source_ref_ids ELSE '[]' END
        ) AS source_ref
        LEFT JOIN event_source_refs AS event_source
          ON event_source.source_ref_id = source_ref.value
        LEFT JOIN memory_events AS event
          ON event.event_id = event_source.event_id
        GROUP BY background.background_id
      `).all() as unknown as BackgroundMigrationRow[];

      const migrationTimestamp = new Date().toISOString();
      const normalizedRows = rows.map((row) => {
        if (row.ownerCount > 1) {
          throw new Error(`BACKGROUND_OWNER_MIGRATION_CONFLICT:${row.backgroundId}`);
        }
        if (row.tenantId && row.sourceTenantId && row.tenantId !== row.sourceTenantId) {
          throw new Error(`BACKGROUND_OWNER_MIGRATION_CONFLICT:${row.backgroundId}`);
        }
        if (row.principalId && row.sourcePrincipalId && row.principalId !== row.sourcePrincipalId) {
          throw new Error(`BACKGROUND_OWNER_MIGRATION_CONFLICT:${row.backgroundId}`);
        }

        const tenantId = row.tenantId || row.sourceTenantId;
        const principalId = row.principalId || row.sourcePrincipalId;
        if (!tenantId || !principalId) {
          throw new Error(`BACKGROUND_OWNER_MIGRATION_UNRESOLVED:${row.backgroundId}`);
        }

        const createdAt = validIsoTimestampOrUndefined(row.createdAt) ?? migrationTimestamp;
        const updatedAt = validIsoTimestampOrUndefined(row.updatedAt) ?? createdAt;
        return { ...row, tenantId, principalId, createdAt, updatedAt };
      });

      const rowsByOwner = groupBy(
        normalizedRows,
        (row) => `${row.tenantId}${String.fromCharCode(31)}${row.principalId}`
      );
      const update = this.db.prepare(`
        UPDATE background_context_documents
        SET tenant_id = ?, principal_id = ?, fixed_revision = ?,
            fixed_text_updated_at = ?, fixed_watermark_json = ?,
            dynamic_window_start = ?, dynamic_window_end = ?,
            dynamic_source_memory_ids_json = ?, latest_stm_cursor_json = ?,
            dynamic_cache_key = ?, update_suggestion_target_sections = ?,
            created_at = ?, updated_at = ?
        WHERE background_id = ?
      `);

      for (const ownerRows of rowsByOwner.values()) {
        ownerRows.sort((left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.backgroundId.localeCompare(right.backgroundId)
        );
        const usedRevisions = new Set<number>();
        for (const row of ownerRows) {
          if (!isPositiveInteger(row.fixedRevision)) continue;
          if (usedRevisions.has(row.fixedRevision)) {
            throw new Error(`BACKGROUND_REVISION_MIGRATION_CONFLICT:${row.tenantId}:${row.principalId}:${row.fixedRevision}`);
          }
          usedRevisions.add(row.fixedRevision);
        }

        let nextRevision = 1;
        for (const row of ownerRows) {
          while (usedRevisions.has(nextRevision)) nextRevision += 1;
          const fixedRevision = isPositiveInteger(row.fixedRevision) ? row.fixedRevision : nextRevision;
          usedRevisions.add(fixedRevision);

          const fixedTextUpdatedAt = validIsoTimestampOrUndefined(row.fixedTextUpdatedAt) ?? row.updatedAt;
          const dynamicWindowStart = validIsoTimestampOrUndefined(row.dynamicWindowStart) ?? row.updatedAt;
          const dynamicWindowEnd = validIsoTimestampOrUndefined(row.dynamicWindowEnd) ?? row.updatedAt;
          if (dynamicWindowStart > dynamicWindowEnd) {
            throw new Error(`BACKGROUND_WINDOW_MIGRATION_INVALID:${row.backgroundId}`);
          }

          update.run(
            row.tenantId,
            row.principalId,
            fixedRevision,
            fixedTextUpdatedAt,
            backgroundCursorJsonOrInitial(row.fixedWatermark),
            dynamicWindowStart,
            dynamicWindowEnd,
            stringArrayJsonOrEmpty(row.dynamicSourceMemoryIds),
            backgroundCursorJsonOrInitial(row.latestStmCursor),
            typeof row.dynamicCacheKey === "string" && row.dynamicCacheKey.trim()
              ? row.dynamicCacheKey.trim()
              : null,
            backgroundSectionArrayJsonOrEmpty(row.updateSuggestionTargetSections),
            row.createdAt,
            row.updatedAt,
            row.backgroundId
          );
        }
      }

      const invalid = this.db.prepare(`
        SELECT background_id AS backgroundId
        FROM background_context_documents
        WHERE tenant_id IS NULL OR trim(tenant_id) = ''
           OR principal_id IS NULL OR trim(principal_id) = ''
           OR fixed_revision IS NULL OR fixed_revision < 1
           OR fixed_text_updated_at IS NULL OR trim(fixed_text_updated_at) = ''
           OR fixed_watermark_json IS NULL OR trim(fixed_watermark_json) = ''
           OR dynamic_window_start IS NULL OR trim(dynamic_window_start) = ''
           OR dynamic_window_end IS NULL OR trim(dynamic_window_end) = ''
           OR dynamic_source_memory_ids_json IS NULL
           OR latest_stm_cursor_json IS NULL OR trim(latest_stm_cursor_json) = ''
        LIMIT 1
      `).get() as { backgroundId?: string } | undefined;
      if (invalid?.backgroundId) {
        throw new Error(`BACKGROUND_MIGRATION_INCOMPLETE:${invalid.backgroundId}`);
      }

      if (this.backgroundDocumentColumnsNeedRebuild()) {
        this.rebuildBackgroundContextDocumentTable();
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_background_owner
          ON background_context_documents(tenant_id, principal_id, updated_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_background_owner_revision
          ON background_context_documents(tenant_id, principal_id, fixed_revision);
      `);
      this.db.exec("COMMIT;");
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      throw caught;
    }
  }

  private backgroundDocumentColumnsNeedRebuild() {
    const columns = this.db.prepare("PRAGMA table_info(background_context_documents)").all() as Array<{
      name?: string;
      notnull?: number;
    }>;
    return [
      "tenant_id",
      "principal_id",
      "fixed_revision",
      "fixed_text_updated_at",
      "fixed_watermark_json",
      "dynamic_window_start",
      "dynamic_window_end",
      "dynamic_source_memory_ids_json",
      "latest_stm_cursor_json"
    ].some((name) => columns.find((column) => column.name === name)?.notnull !== 1);
  }

  private rebuildBackgroundContextDocumentTable() {
    this.db.exec(`
      CREATE TABLE background_context_documents__owner_revision_v1 (
        background_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        fixed_text TEXT NOT NULL,
        dynamic_text TEXT NOT NULL,
        fixed_revision INTEGER NOT NULL CHECK (fixed_revision > 0),
        fixed_text_updated_at TEXT NOT NULL,
        fixed_watermark_json TEXT NOT NULL,
        dynamic_window_start TEXT NOT NULL,
        dynamic_window_end TEXT NOT NULL,
        dynamic_source_memory_ids_json TEXT NOT NULL,
        latest_stm_cursor_json TEXT NOT NULL,
        dynamic_cache_key TEXT,
        source_ref_ids TEXT NOT NULL,
        conflict_ids TEXT NOT NULL,
        degraded_mode_reason TEXT,
        update_suggestion_status TEXT,
        update_suggestion_summary TEXT,
        update_suggestion_target_sections TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO background_context_documents__owner_revision_v1 (
        background_id, tenant_id, principal_id, fixed_text, dynamic_text,
        fixed_revision, fixed_text_updated_at, fixed_watermark_json,
        dynamic_window_start, dynamic_window_end, dynamic_source_memory_ids_json,
        latest_stm_cursor_json, dynamic_cache_key, source_ref_ids, conflict_ids,
        degraded_mode_reason, update_suggestion_status, update_suggestion_summary,
        update_suggestion_target_sections, created_at, updated_at
      )
      SELECT
        background_id, tenant_id, principal_id, fixed_text, dynamic_text,
        fixed_revision, fixed_text_updated_at, fixed_watermark_json,
        dynamic_window_start, dynamic_window_end, dynamic_source_memory_ids_json,
        latest_stm_cursor_json, dynamic_cache_key, source_ref_ids, conflict_ids,
        degraded_mode_reason, update_suggestion_status, update_suggestion_summary,
        update_suggestion_target_sections, created_at, updated_at
      FROM background_context_documents;

      DROP TABLE background_context_documents;
      ALTER TABLE background_context_documents__owner_revision_v1
        RENAME TO background_context_documents;
    `);
  }

  private migrateConversationEvidenceTables() {
    this.db.exec("PRAGMA foreign_keys=OFF;");
    this.db.exec("PRAGMA legacy_alter_table=ON;");
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const documentsPreflight = this.preflightConversationDocumentsMigration();
      if (documentsPreflight) {
        this.rebuildConversationDocuments(documentsPreflight);
      }
      this.rebuildConversationMessagesIfNeeded();
      this.rebuildConversationDocumentMessagesIfNeeded();
      this.db.exec(`
        DROP INDEX IF EXISTS idx_conversation_messages_owner_time;
        DROP INDEX IF EXISTS idx_conversation_messages_session_time;
        DROP INDEX IF EXISTS idx_conversation_messages_identity;
        DROP INDEX IF EXISTS idx_conversation_document_messages_ingestion;
        CREATE INDEX IF NOT EXISTS idx_conversation_messages_owner_time
          ON conversation_messages(tenant_id, principal_id, created_at, message_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_time
          ON conversation_messages(tenant_id, principal_id, source_app, session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_conversation_messages_identity
          ON conversation_messages(tenant_id, principal_id, source_app, session_id, message_id, revision);
        CREATE INDEX IF NOT EXISTS idx_conversation_document_messages_ingestion
          ON conversation_document_messages(ingestion_id, message_order);
        CREATE INDEX IF NOT EXISTS idx_memory_events_owner_time
          ON memory_events(tenant_id, principal_id, event_time, event_id);
        CREATE INDEX IF NOT EXISTS idx_parsed_segments_event
          ON parsed_segments(event_id, segment_id);
      `);
      this.db.exec("COMMIT;");
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      throw caught;
    } finally {
      this.db.exec("PRAGMA legacy_alter_table=OFF;");
      this.db.exec("PRAGMA foreign_keys=ON;");
    }
  }

  private preflightConversationDocumentsMigration(): ConversationDocumentsMigrationPreflight | undefined {
    if (!this.tableExists("conversation_documents")) return undefined;

    const columns = this.db.prepare("PRAGMA table_info(conversation_documents)").all() as Array<{
      name?: string;
      notnull?: number;
    }>;
    const ingestionIdColumn = columns.find((column) => column.name === "ingestion_id");
    if (ingestionIdColumn?.notnull !== 1) return undefined;

    const migrationTableName = "conversation_documents__migration_v2";
    if (this.tableExists(migrationTableName)) {
      throw new Error(`CONVERSATION_DOCUMENTS_MIGRATION_RESIDUAL_TABLE:${migrationTableName}`);
    }

    const invalidDocuments = this.db.prepare(`
      SELECT document_id AS documentId
      FROM conversation_documents
      WHERE batch_ingestion_id IS NULL
        AND ingestion_id IS NULL
      ORDER BY document_id
    `).all() as Array<{ documentId?: string }>;
    if (invalidDocuments.length > 0) {
      const documentIds = invalidDocuments
        .map((row) => row.documentId ?? "<null>")
        .join(",");
      throw new Error(`CONVERSATION_DOCUMENTS_MIGRATION_INVALID_LINKS:${documentIds}`);
    }

    return {
      documentCount: this.tableRowCount("conversation_documents"),
      ingestionCount: this.tableRowCount("conversation_ingestions"),
      batchIngestionCount: this.tableRowCount("conversation_batch_ingestions")
    };
  }

  private rebuildConversationDocuments(preflight: ConversationDocumentsMigrationPreflight) {
    const migrationTableName = "conversation_documents__migration_v2";
    this.db.exec(`
      CREATE TABLE ${migrationTableName} (
        document_id TEXT PRIMARY KEY,
        batch_ingestion_id TEXT UNIQUE,
        ingestion_id TEXT UNIQUE,
        schema_version TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        raw_markdown TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (batch_ingestion_id)
          REFERENCES conversation_batch_ingestions(batch_ingestion_id)
          ON DELETE CASCADE,
        FOREIGN KEY (ingestion_id)
          REFERENCES conversation_ingestions(ingestion_id)
          ON DELETE CASCADE,
        CHECK (batch_ingestion_id IS NOT NULL OR ingestion_id IS NOT NULL)
      );

      INSERT INTO ${migrationTableName} (
        document_id, batch_ingestion_id, ingestion_id, schema_version,
        sha256, byte_size, raw_markdown, created_at
      )
      SELECT
        document_id, batch_ingestion_id, ingestion_id, schema_version,
        sha256, byte_size, raw_markdown, created_at
      FROM conversation_documents;
    `);

    const sourceCount = this.tableRowCount("conversation_documents");
    const migratedCount = this.tableRowCount(migrationTableName);
    if (sourceCount !== preflight.documentCount || migratedCount !== sourceCount) {
      throw new Error(
        `CONVERSATION_DOCUMENTS_MIGRATION_COUNT_MISMATCH:${preflight.documentCount}:${sourceCount}:${migratedCount}`
      );
    }

    const missingDocument = this.db.prepare(`
      SELECT source.document_id AS documentId
      FROM conversation_documents AS source
      LEFT JOIN ${migrationTableName} AS migrated
        ON migrated.document_id = source.document_id
      WHERE migrated.document_id IS NULL
      LIMIT 1
    `).get() as { documentId?: string | null } | undefined;
    if (missingDocument) {
      throw new Error(
        `CONVERSATION_DOCUMENTS_MIGRATION_DOCUMENT_MISSING:${missingDocument.documentId ?? "<null>"}`
      );
    }

    this.db.exec(`
      DROP TABLE conversation_documents;
      ALTER TABLE ${migrationTableName} RENAME TO conversation_documents;
    `);

    const ingestionIdColumn = (this.db.prepare("PRAGMA table_info(conversation_documents)").all() as Array<{
      name?: string;
      notnull?: number;
    }>).find((column) => column.name === "ingestion_id");
    if (ingestionIdColumn?.notnull !== 0) {
      throw new Error("CONVERSATION_DOCUMENTS_MIGRATION_SCHEMA_INVALID:ingestion_id");
    }

    const tableNames = (this.db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name LIKE 'conversation_documents%'
      ORDER BY name
    `).all() as Array<{ name?: string }>).flatMap((row) => row.name ? [row.name] : []);
    if (tableNames.length !== 1 || tableNames[0] !== "conversation_documents") {
      throw new Error(`CONVERSATION_DOCUMENTS_MIGRATION_TABLE_SWITCH_INVALID:${tableNames.join(",")}`);
    }

    const ingestionCount = this.tableRowCount("conversation_ingestions");
    const batchIngestionCount = this.tableRowCount("conversation_batch_ingestions");
    if (
      ingestionCount !== preflight.ingestionCount ||
      batchIngestionCount !== preflight.batchIngestionCount
    ) {
      throw new Error(
        `CONVERSATION_DOCUMENTS_MIGRATION_PARENT_COUNT_MISMATCH:${preflight.ingestionCount}:${ingestionCount}:${preflight.batchIngestionCount}:${batchIngestionCount}`
      );
    }

    const foreignKeyViolation = this.db.prepare("PRAGMA foreign_key_check").get() as {
      table?: string;
      rowid?: number | null;
      parent?: string;
      fkid?: number;
    } | undefined;
    if (foreignKeyViolation) {
      throw new Error(
        `CONVERSATION_DOCUMENTS_MIGRATION_FOREIGN_KEY_VIOLATION:${foreignKeyViolation.table ?? "<unknown>"}:${foreignKeyViolation.rowid ?? "<null>"}:${foreignKeyViolation.parent ?? "<unknown>"}:${foreignKeyViolation.fkid ?? "<unknown>"}`
      );
    }
  }

  private rebuildConversationMessagesIfNeeded() {
    const columns = this.tableColumnNames("conversation_messages");
    const canonicalColumns = [
      "conversation_message_row_id",
      "first_ingestion_id",
      "tenant_id",
      "principal_id",
      "source_app",
      "session_id",
      "batch_id",
      "message_id",
      "sequence",
      "role",
      "status",
      "content_type",
      "content",
      "content_sha256",
      "reply_to_message_id",
      "parent_message_id",
      "branch_id",
      "tool_call_id",
      "tool_name",
      "revision",
      "operation",
      "metadata",
      "created_at",
      "completed_at",
      "timezone",
      "locale",
      "time_confidence",
      "stored_at"
    ];
    if (canonicalColumns.every((column) => columns.has(column))) return;

    const rowCount = this.tableRowCount("conversation_messages");
    const createdAtColumn = columns.has("source_created_at")
      ? "source_created_at"
      : columns.has("created_at") ? "created_at" : undefined;
    const firstIngestionColumn = columns.has("first_ingestion_id")
      ? "first_ingestion_id"
      : columns.has("ingestion_id") ? "ingestion_id" : undefined;
    const migratableColumns = [
      "conversation_message_row_id",
      "tenant_id",
      "principal_id",
      "source_app",
      "session_id",
      "batch_id",
      "message_id",
      "sequence",
      "role",
      "content",
      "content_sha256"
    ];
    const canMigrate = Boolean(
      firstIngestionColumn &&
      createdAtColumn &&
      migratableColumns.every((column) => columns.has(column))
    );
    if (rowCount > 0 && !canMigrate) {
      this.backupLegacyConversationTable("conversation_messages");
      this.createCanonicalConversationMessagesTable("conversation_messages");
      return;
    }

    this.createCanonicalConversationMessagesTable("conversation_messages__temporal_v1");
    if (rowCount > 0 && firstIngestionColumn && createdAtColumn) {
      const expression = (column: string, fallback: string) => columns.has(column) ? column : fallback;
      const timeConfidence = columns.has("time_confidence")
        ? "time_confidence"
        : columns.has("source_created_at") ? "'high'" : "'low'";
      const storedAt = columns.has("stored_at")
        ? "stored_at"
        : columns.has("source_created_at") && columns.has("created_at")
          ? "created_at"
          : createdAtColumn;
      this.db.exec(`
        INSERT INTO conversation_messages__temporal_v1 (
          conversation_message_row_id, first_ingestion_id, tenant_id, principal_id,
          source_app, session_id, batch_id, message_id, sequence, role, status,
          content_type, content, content_sha256, reply_to_message_id,
          parent_message_id, branch_id, tool_call_id, tool_name, revision,
          operation, metadata, created_at, completed_at, timezone, locale,
          time_confidence, stored_at
        )
        SELECT
          conversation_message_row_id, ${firstIngestionColumn}, tenant_id, principal_id,
          source_app, session_id, batch_id, message_id, sequence, role,
          ${expression("status", "'completed'")},
          ${expression("content_type", "'text/markdown'")},
          content, content_sha256,
          ${expression("reply_to_message_id", "NULL")},
          ${expression("parent_message_id", "NULL")},
          ${expression("branch_id", "'main'")},
          ${expression("tool_call_id", "NULL")},
          ${expression("tool_name", "NULL")},
          ${expression("revision", "1")},
          ${expression("operation", "'append'")},
          ${expression("metadata", "NULL")},
          ${createdAtColumn},
          ${expression("completed_at", "NULL")},
          ${expression("timezone", "NULL")},
          ${expression("locale", "NULL")},
          ${timeConfidence},
          ${storedAt}
        FROM conversation_messages;
      `);
    }
    this.db.exec(`
      DROP TABLE conversation_messages;
      ALTER TABLE conversation_messages__temporal_v1 RENAME TO conversation_messages;
    `);
  }

  private rebuildConversationDocumentMessagesIfNeeded() {
    const columns = this.tableColumnNames("conversation_document_messages");
    const canonicalColumns = [
      "document_id",
      "ingestion_id",
      "conversation_message_row_id",
      "message_order"
    ];
    if (canonicalColumns.every((column) => columns.has(column))) return;

    const rowCount = this.tableRowCount("conversation_document_messages");
    const canMigrate = ["document_id", "conversation_message_row_id", "message_order"]
      .every((column) => columns.has(column));
    if (rowCount > 0 && !canMigrate) {
      this.backupLegacyConversationTable("conversation_document_messages");
      this.createCanonicalConversationDocumentMessagesTable("conversation_document_messages");
      return;
    }

    this.createCanonicalConversationDocumentMessagesTable("conversation_document_messages__temporal_v1");
    if (rowCount > 0) {
      const ingestionExpression = columns.has("ingestion_id")
        ? "cdm.ingestion_id"
        : "COALESCE(cm.first_ingestion_id, cd.ingestion_id)";
      const unresolved = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_document_messages AS cdm
        LEFT JOIN conversation_messages AS cm
          ON cm.conversation_message_row_id = cdm.conversation_message_row_id
        LEFT JOIN conversation_documents AS cd
          ON cd.document_id = cdm.document_id
        WHERE ${ingestionExpression} IS NULL OR trim(${ingestionExpression}) = ''
      `).get() as { count?: number } | undefined;
      if (Number(unresolved?.count ?? 0) > 0) {
        this.db.exec("DROP TABLE conversation_document_messages__temporal_v1;");
        this.backupLegacyConversationTable("conversation_document_messages");
        this.createCanonicalConversationDocumentMessagesTable("conversation_document_messages");
        return;
      }
      this.db.exec(`
        INSERT INTO conversation_document_messages__temporal_v1 (
          document_id, ingestion_id, conversation_message_row_id, message_order
        )
        SELECT
          cdm.document_id,
          ${ingestionExpression},
          cdm.conversation_message_row_id,
          cdm.message_order
        FROM conversation_document_messages AS cdm
        LEFT JOIN conversation_messages AS cm
          ON cm.conversation_message_row_id = cdm.conversation_message_row_id
        LEFT JOIN conversation_documents AS cd
          ON cd.document_id = cdm.document_id;
      `);
    }
    this.db.exec(`
      DROP TABLE conversation_document_messages;
      ALTER TABLE conversation_document_messages__temporal_v1
        RENAME TO conversation_document_messages;
    `);
  }

  private createCanonicalConversationMessagesTable(tableName: string) {
    this.db.exec(`
      CREATE TABLE ${tableName} (
        conversation_message_row_id TEXT PRIMARY KEY,
        first_ingestion_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        source_app TEXT NOT NULL,
        session_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        content_type TEXT NOT NULL DEFAULT 'text/markdown',
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        reply_to_message_id TEXT,
        parent_message_id TEXT,
        branch_id TEXT NOT NULL DEFAULT 'main',
        tool_call_id TEXT,
        tool_name TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        operation TEXT NOT NULL DEFAULT 'append',
        metadata TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        timezone TEXT,
        locale TEXT,
        time_confidence TEXT NOT NULL,
        stored_at TEXT NOT NULL,
        UNIQUE (tenant_id, principal_id, source_app, session_id, message_id, revision),
        UNIQUE (tenant_id, principal_id, source_app, session_id, sequence, branch_id, revision),
        FOREIGN KEY (first_ingestion_id) REFERENCES conversation_ingestions(ingestion_id)
      );
    `);
  }

  private createCanonicalConversationDocumentMessagesTable(tableName: string) {
    this.db.exec(`
      CREATE TABLE ${tableName} (
        document_id TEXT NOT NULL,
        ingestion_id TEXT NOT NULL,
        conversation_message_row_id TEXT NOT NULL,
        message_order INTEGER NOT NULL,
        PRIMARY KEY (document_id, ingestion_id, conversation_message_row_id),
        UNIQUE (document_id, ingestion_id, message_order),
        FOREIGN KEY (document_id) REFERENCES conversation_documents(document_id) ON DELETE CASCADE,
        FOREIGN KEY (ingestion_id) REFERENCES conversation_ingestions(ingestion_id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_message_row_id) REFERENCES conversation_messages(conversation_message_row_id)
      );
    `);
  }

  private backupLegacyConversationTable(tableName: string) {
    let suffix = 1;
    let backupName = `context_legacy_${tableName}_v${suffix}`;
    while (this.tableExists(backupName)) {
      suffix += 1;
      backupName = `context_legacy_${tableName}_v${suffix}`;
    }
    this.db.exec(`ALTER TABLE ${tableName} RENAME TO ${backupName};`);
  }

  private tableColumnNames(tableName: string) {
    return new Set(
      (this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>)
        .flatMap((column) => column.name ? [column.name] : [])
    );
  }

  private tableRowCount(tableName: string) {
    if (!this.tableExists(tableName)) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private tableExists(tableName: string) {
    const row = this.db.prepare(`
      SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1
    `).get(tableName) as { present?: number } | undefined;
    return Boolean(row?.present);
  }

  private ensureTextIndexFts() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS context_text_index_fts USING fts5(
        index_id UNINDEXED,
        owner_id UNINDEXED,
        owner_type UNINDEXED,
        term,
        document_frequency UNINDEXED,
        term_frequency UNINDEXED,
        document_length UNINDEXED,
        lifecycle_status UNINDEXED,
        refreshed_at UNINDEXED,
        tokenize = 'unicode61'
      )
    `);
  }

  private dropLegacyTextIndexTable() {
    this.db.exec(`DROP TABLE IF EXISTS context_text_index_entries`);
  }

  private backfillLegacyTextIndexTable() {
    const legacyExists = this.db
      .prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'context_text_index_entries'`)
      .get() as { present?: number } | undefined;
    if (!legacyExists) return;

    const rows = this.queryAll<ContextTextIndexEntry>(`
      SELECT
        index_id AS indexId,
        owner_id AS ownerId,
        owner_type AS ownerType,
        term,
        document_frequency AS documentFrequency,
        term_frequency AS termFrequency,
        document_length AS documentLength,
        lifecycle_status AS lifecycleStatus,
        refreshed_at AS refreshedAt
      FROM context_text_index_entries
    `);

    for (const entry of rows) {
      this.exec(`DELETE FROM context_text_index_fts WHERE index_id = ?`, [entry.indexId]);
      this.exec(
        `INSERT INTO context_text_index_fts (index_id, owner_id, owner_type, term, document_frequency, term_frequency, document_length, lifecycle_status, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.indexId,
          entry.ownerId,
          entry.ownerType,
          entry.term,
          entry.documentFrequency,
          entry.termFrequency,
          entry.documentLength,
          entry.lifecycleStatus,
          entry.refreshedAt
        ]
      );
    }
  }

  override async saveTextIndexEntry(entry: ContextTextIndexEntry) {
    await super.saveTextIndexEntry(entry);
    this.exec(`DELETE FROM context_text_index_fts WHERE index_id = ?`, [entry.indexId]);
    this.exec(
      `INSERT INTO context_text_index_fts (index_id, owner_id, owner_type, term, document_frequency, term_frequency, document_length, lifecycle_status, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.indexId,
        entry.ownerId,
        entry.ownerType,
        entry.term,
        entry.documentFrequency,
        entry.termFrequency,
        entry.documentLength,
        entry.lifecycleStatus,
        entry.refreshedAt
      ]
    );
  }

  override async upsertGraphMemoryNode(node: GraphMemoryNode) {
    const { factSummary, ...nodeWithoutFactSummary } = node;
    const normalizedFactSummary = normalizeFactSummary(factSummary);
    const normalizedNode: GraphMemoryNode = {
      ...nodeWithoutFactSummary,
      ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {})
    };
    await super.upsertGraphMemoryNode(normalizedNode);
    this.exec(
      `INSERT INTO graph_memory_nodes (graph_node_id, owner_id, owner_type, memory_type, content, fact_summary, vector, lifecycle_status, retrieval_weight, source_refs, entity_ids, evidence_time_start, evidence_time_end, evidence_time_confidence, valid_time_start, valid_time_end, valid_time_confidence, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(graph_node_id) DO UPDATE SET
         owner_id=excluded.owner_id,
         owner_type=excluded.owner_type,
         memory_type=excluded.memory_type,
         content=excluded.content,
         fact_summary=excluded.fact_summary,
         vector=excluded.vector,
         lifecycle_status=excluded.lifecycle_status,
         retrieval_weight=excluded.retrieval_weight,
         source_refs=excluded.source_refs,
         entity_ids=excluded.entity_ids,
         evidence_time_start=excluded.evidence_time_start,
         evidence_time_end=excluded.evidence_time_end,
         evidence_time_confidence=excluded.evidence_time_confidence,
         valid_time_start=excluded.valid_time_start,
         valid_time_end=excluded.valid_time_end,
         valid_time_confidence=excluded.valid_time_confidence,
         refreshed_at=excluded.refreshed_at`,
      [
        normalizedNode.graphNodeId,
        normalizedNode.ownerId,
        normalizedNode.ownerType,
        normalizedNode.memoryType ?? null,
        normalizedNode.content,
        normalizedNode.factSummary ?? null,
        JSON.stringify(normalizedNode.vector),
        normalizedNode.lifecycleStatus,
        normalizedNode.retrievalWeight,
        JSON.stringify(normalizedNode.sourceRefs),
        JSON.stringify(normalizedNode.entityIds),
        normalizedNode.evidenceTimeStart ?? null,
        normalizedNode.evidenceTimeEnd ?? null,
        normalizedNode.evidenceTimeConfidence ?? "low",
        normalizedNode.validTimeStart ?? null,
        normalizedNode.validTimeEnd ?? null,
        normalizedNode.validTimeConfidence ?? "low",
        normalizedNode.refreshedAt
      ]
    );
  }

  override async deleteGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string) {
    await super.deleteGraphMemoryNode(ownerType, ownerId);
    this.exec(`DELETE FROM graph_memory_nodes WHERE owner_type = ? AND owner_id = ?`, [ownerType, ownerId]);
  }

  override getShortTermMemory(memoryDataId: string): ShortTermMemory | undefined {
    const cached = super.getShortTermMemory(memoryDataId);
    if (cached) return cached;
    const row = this.db
      .prepare(`
        SELECT
          memory_data_id AS memoryDataId,
          tenant_id AS tenantId,
          principal_id AS principalId,
          created_at AS createdAt,
          updated_at AS updatedAt,
          memory_data_type AS memoryDataType,
          memory_type AS memoryType,
          content,
          structured_facts AS structuredFacts,
          fact_summary AS factSummary,
          summary,
          evidence_time AS evidenceTime,
          valid_time AS validTime,
          evidence_time_start AS evidenceTimeStart,
          evidence_time_end AS evidenceTimeEnd,
          evidence_time_confidence AS evidenceTimeConfidence,
          valid_time_start AS validTimeStart,
          valid_time_end AS validTimeEnd,
          valid_time_confidence AS validTimeConfidence,
          importance_level AS importanceLevel,
          retrieval_weight AS retrievalWeight,
          user_retrieval_weight AS userRetrievalWeight,
          confidence_level AS confidenceLevel,
          admission_result AS admissionResult,
          admission_reason AS admissionReason,
          source_fact_ids AS sourceFactIds,
          source_refs AS sourceRefs,
          entity_ids AS entityIds,
          matched_rules AS matchedRules,
          admission_signals AS admissionSignals,
          access_state AS accessState,
          lifecycle_status AS lifecycleStatus,
          consolidation_status AS consolidationStatus,
          next_evaluate_at AS nextEvaluateAt,
          last_evaluated_at AS lastEvaluatedAt,
          observe_count AS observeCount,
          reevaluation_reason AS reevaluationReason,
          expires_at AS expiresAt,
          dreaming_policy_version AS dreamingPolicyVersion,
          latest_decision_id AS latestDecisionId,
          reevaluation_tier AS reevaluationTier,
          cycle_attempt_count AS cycleAttemptCount,
          total_attempt_count AS totalAttemptCount,
          last_dreaming_error AS lastDreamingError,
          latest_dreaming_run_id AS latestDreamingRunId
        FROM short_term_memories
        WHERE memory_data_id = ?
        LIMIT 1
      `)
      .get(memoryDataId) as Record<string, unknown> | undefined;
    return row ? normalizeShortTermMemoryRow(normalizeRow(row)) : undefined;
  }

  override getShortTermMemoriesByIds(memoryDataIds: string[]): ShortTermMemory[] {
    const allowed = [...new Set(memoryDataIds.map((item) => item.trim()).filter(Boolean))];
    if (!allowed.length) return [];
    return chunkSqlValues(allowed).flatMap((batch) => {
      const placeholders = sqlPlaceholders(batch.length);
      return this.db.prepare(`
        SELECT
          memory_data_id AS memoryDataId,
          tenant_id AS tenantId,
          principal_id AS principalId,
          created_at AS createdAt,
          updated_at AS updatedAt,
          memory_data_type AS memoryDataType,
          memory_type AS memoryType,
          content,
          structured_facts AS structuredFacts,
          fact_summary AS factSummary,
          summary,
          evidence_time AS evidenceTime,
          valid_time AS validTime,
          evidence_time_start AS evidenceTimeStart,
          evidence_time_end AS evidenceTimeEnd,
          evidence_time_confidence AS evidenceTimeConfidence,
          valid_time_start AS validTimeStart,
          valid_time_end AS validTimeEnd,
          valid_time_confidence AS validTimeConfidence,
          importance_level AS importanceLevel,
          retrieval_weight AS retrievalWeight,
          user_retrieval_weight AS userRetrievalWeight,
          confidence_level AS confidenceLevel,
          admission_result AS admissionResult,
          admission_reason AS admissionReason,
          source_fact_ids AS sourceFactIds,
          source_refs AS sourceRefs,
          entity_ids AS entityIds,
          matched_rules AS matchedRules,
          admission_signals AS admissionSignals,
          access_state AS accessState,
          lifecycle_status AS lifecycleStatus,
          consolidation_status AS consolidationStatus,
          next_evaluate_at AS nextEvaluateAt,
          last_evaluated_at AS lastEvaluatedAt,
          observe_count AS observeCount,
          reevaluation_reason AS reevaluationReason,
          expires_at AS expiresAt,
          dreaming_policy_version AS dreamingPolicyVersion,
          latest_decision_id AS latestDecisionId,
          reevaluation_tier AS reevaluationTier,
          cycle_attempt_count AS cycleAttemptCount,
          total_attempt_count AS totalAttemptCount,
          last_dreaming_error AS lastDreamingError,
          latest_dreaming_run_id AS latestDreamingRunId
        FROM short_term_memories
        WHERE memory_data_id IN (${placeholders})
        ORDER BY memory_data_id
      `).all(...batch).map((row) =>
        normalizeShortTermMemoryRow(normalizeRow(row as Record<string, unknown>))
      );
    }).sort((left, right) => left.memoryDataId.localeCompare(right.memoryDataId));
  }

  override selectShortTermMemoriesForBackground(query: BackgroundStmPageQuery): BackgroundStmPage {
    const cursorClause = query.cursor
      ? `AND (
          updated_at > ? OR
          (updated_at = ? AND memory_data_id > ?)
        )`
      : "";
    const params = query.cursor
      ? [
          query.tenantId,
          query.principalId,
          query.windowStart,
          query.windowEnd,
          query.cursor.updatedAt,
          query.cursor.updatedAt,
          query.cursor.memoryDataId,
          query.limit + 1
        ]
      : [query.tenantId, query.principalId, query.windowStart, query.windowEnd, query.limit + 1];
    const rows = this.db.prepare(`
      SELECT
        memory_data_id AS memoryDataId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        memory_data_type AS memoryDataType,
        memory_type AS memoryType,
        content,
        structured_facts AS structuredFacts,
        fact_summary AS factSummary,
        summary,
        evidence_time AS evidenceTime,
        valid_time AS validTime,
        evidence_time_start AS evidenceTimeStart,
        evidence_time_end AS evidenceTimeEnd,
        evidence_time_confidence AS evidenceTimeConfidence,
        valid_time_start AS validTimeStart,
        valid_time_end AS validTimeEnd,
        valid_time_confidence AS validTimeConfidence,
        importance_level AS importanceLevel,
        retrieval_weight AS retrievalWeight,
        user_retrieval_weight AS userRetrievalWeight,
        confidence_level AS confidenceLevel,
        admission_result AS admissionResult,
        admission_reason AS admissionReason,
        source_fact_ids AS sourceFactIds,
        source_refs AS sourceRefs,
        entity_ids AS entityIds,
        matched_rules AS matchedRules,
        admission_signals AS admissionSignals,
        access_state AS accessState,
        lifecycle_status AS lifecycleStatus,
        consolidation_status AS consolidationStatus,
        next_evaluate_at AS nextEvaluateAt,
        last_evaluated_at AS lastEvaluatedAt,
        observe_count AS observeCount,
        reevaluation_reason AS reevaluationReason,
        expires_at AS expiresAt,
        dreaming_policy_version AS dreamingPolicyVersion,
        latest_decision_id AS latestDecisionId,
        reevaluation_tier AS reevaluationTier,
        cycle_attempt_count AS cycleAttemptCount,
        total_attempt_count AS totalAttemptCount,
        last_dreaming_error AS lastDreamingError,
        latest_dreaming_run_id AS latestDreamingRunId
      FROM short_term_memories
      WHERE tenant_id = ?
        AND principal_id = ?
        AND updated_at >= ?
        AND updated_at < ?
        ${cursorClause}
      ORDER BY updated_at ASC, memory_data_id ASC
      LIMIT ?
    `).all(...(params as never[]))
      .map((row) => normalizeShortTermMemoryRow(normalizeRow(row as Record<string, unknown>)));
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      memories: page,
      ...(last
        ? { nextCursor: { updatedAt: last.updatedAt, memoryDataId: last.memoryDataId } }
        : {}),
      hasMore: rows.length > query.limit
    };
  }

  override getBackgroundStmWindowStats(query: BackgroundStmWindowStatsQuery): BackgroundStmWindowStats {
    if (!Number.isInteger(query.countLimit) || query.countLimit < 1) {
      throw new Error(`BACKGROUND_STM_STATS_LIMIT_INVALID:${query.countLimit}`);
    }
    const throughClause = query.throughCursor
      ? `AND (
          updated_at < ? OR
          (updated_at = ? AND memory_data_id <= ?)
        )`
      : "";
    const params = [
      query.tenantId,
      query.principalId,
      query.cursor.updatedAt,
      query.cursor.updatedAt,
      query.cursor.memoryDataId,
      query.windowEnd,
      ...(query.throughCursor
        ? [query.throughCursor.updatedAt, query.throughCursor.updatedAt, query.throughCursor.memoryDataId]
        : [])
    ];
    const whereSql = `
      tenant_id = ?
      AND principal_id = ?
      AND (updated_at > ? OR (updated_at = ? AND memory_data_id > ?))
      AND updated_at < ?
      ${throughClause}
    `;
    const latest = this.db.prepare(`
      SELECT updated_at AS updatedAt, memory_data_id AS memoryDataId
      FROM short_term_memories
      WHERE ${whereSql}
      ORDER BY updated_at DESC, memory_data_id DESC
      LIMIT 1
    `).get(...(params as never[])) as { updatedAt?: string; memoryDataId?: string } | undefined;
    const countRows = this.db.prepare(`
      SELECT memory_data_id
      FROM short_term_memories
      WHERE ${whereSql}
      ORDER BY updated_at ASC, memory_data_id ASC
      LIMIT ?
    `).all(...([...params, query.countLimit + 1] as never[]));
    return {
      ...(latest?.updatedAt && latest.memoryDataId
        ? { latestCursor: { updatedAt: latest.updatedAt, memoryDataId: latest.memoryDataId } }
        : {}),
      pendingCount: Math.min(countRows.length, query.countLimit),
      countCapped: countRows.length > query.countLimit
    };
  }

  override async saveBackgroundDocument(item: BackgroundContextDocument) {
    const existing = this.db.prepare(`
      SELECT tenant_id AS tenantId, principal_id AS principalId
      FROM background_context_documents
      WHERE background_id = ?
      LIMIT 1
    `).get(item.backgroundId) as { tenantId: string; principalId: string } | undefined;
    if (existing && (existing.tenantId !== item.tenantId || existing.principalId !== item.principalId)) {
      throw new Error(`BACKGROUND_OWNER_CONFLICT:${item.backgroundId}`);
    }

    const revisionConflict = this.db.prepare(`
      SELECT background_id AS backgroundId
      FROM background_context_documents
      WHERE tenant_id = ? AND principal_id = ? AND fixed_revision = ?
        AND background_id <> ?
      LIMIT 1
    `).get(
      item.tenantId,
      item.principalId,
      item.fixedRevision,
      item.backgroundId
    ) as { backgroundId: string } | undefined;
    if (revisionConflict) {
      throw new Error(`BACKGROUND_REVISION_CONFLICT:${item.tenantId}:${item.principalId}:${item.fixedRevision}`);
    }

    await super.saveBackgroundDocument(item);
  }

  override getLatestBackgroundDocument(tenantId: string, principalId: string): BackgroundContextDocument | undefined {
    const row = this.db.prepare(`
      SELECT ${backgroundDocumentSelectColumns}
      FROM background_context_documents
      WHERE tenant_id = ? AND principal_id = ?
      ORDER BY fixed_revision DESC, updated_at DESC, background_id DESC
      LIMIT 1
    `).get(tenantId, principalId) as Record<string, unknown> | undefined;
    return row ? normalizeBackgroundContextDocumentRow(row) : undefined;
  }

  override getBackgroundMaintenanceTask(
    tenantId: string,
    principalId: string,
    runId: string
  ): BackgroundMaintenanceTask | undefined {
    const row = this.db.prepare(`
      SELECT ${backgroundMaintenanceTaskSelectColumns}
      FROM background_maintenance_tasks
      WHERE tenant_id = ? AND principal_id = ? AND run_id = ?
      LIMIT 1
    `).get(tenantId, principalId, runId) as Record<string, unknown> | undefined;
    return row ? normalizeBackgroundMaintenanceTaskRow(row) : undefined;
  }

  override async createBackgroundMaintenanceTask(task: BackgroundMaintenanceTask) {
    assertBackgroundMaintenanceTask(task);
    const taskSnapshot = [...this.cache.backgroundMaintenanceTasks];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.getBackgroundMaintenanceTask(task.tenantId, task.principalId, task.runId);
      if (existing) {
        replaceById(this.cache.backgroundMaintenanceTasks, existing, "taskId");
        this.db.exec("COMMIT;");
        return existing;
      }
      await super.saveBackgroundMaintenanceTask(task);
      this.db.exec("COMMIT;");
      return task;
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.cache.backgroundMaintenanceTasks, taskSnapshot);
      throw caught;
    }
  }

  override async claimBackgroundMaintenanceTask(input: {
    taskId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }) {
    const taskSnapshot = [...this.cache.backgroundMaintenanceTasks];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db.prepare(`
        SELECT ${backgroundMaintenanceTaskSelectColumns}
        FROM background_maintenance_tasks
        WHERE task_id = ?
        LIMIT 1
      `).get(input.taskId) as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT;");
        return undefined;
      }
      const task = normalizeBackgroundMaintenanceTaskRow(row);
      const competing = this.db.prepare(`
        SELECT task_id AS taskId
        FROM background_maintenance_tasks
        WHERE tenant_id = ? AND principal_id = ? AND task_id <> ?
          AND status = 'running' AND lease_expires_at > ?
        LIMIT 1
      `).get(task.tenantId, task.principalId, task.taskId, input.claimedAt) as { taskId?: string } | undefined;
      const leaseActive = task.status === "running" &&
        Boolean(task.leaseExpiresAt && task.leaseExpiresAt > input.claimedAt) &&
        task.claimedBy !== input.claimedBy;
      if (task.status === "succeeded" || competing?.taskId || leaseActive) {
        this.db.exec("COMMIT;");
        return undefined;
      }
      const { error: _error, ...taskWithoutError } = task;
      const claimed: BackgroundMaintenanceTask = {
        ...taskWithoutError,
        status: "running",
        attempt: task.attempt + 1,
        retryable: task.attempt + 1 < task.maxAttempts,
        claimedBy: input.claimedBy,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.claimedAt
      };
      await super.saveBackgroundMaintenanceTask(claimed);
      this.db.exec("COMMIT;");
      return claimed;
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.cache.backgroundMaintenanceTasks, taskSnapshot);
      throw caught;
    }
  }

  override getBackgroundMaintenanceBatches(taskId: string) {
    return this.db.prepare(`
      SELECT
        task_id AS taskId,
        batch_index AS batchIndex,
        through_cursor_json AS throughCursor,
        memory_ids_json AS memoryIds,
        memory_source_refs_json AS memorySourceRefs,
        memory_count AS memoryCount,
        analysis_output_json AS analysisOutput,
        estimated_input_tokens AS estimatedInputTokens,
        created_at AS createdAt
      FROM background_maintenance_batches
      WHERE task_id = ?
      ORDER BY batch_index
    `).all(taskId).map((row) => normalizeBackgroundMaintenanceBatchRow(row as Record<string, unknown>));
  }

  override async saveBackgroundMaintenanceBatch(batch: BackgroundMaintenanceBatch) {
    const existing = this.getBackgroundMaintenanceBatches(batch.taskId)
      .find((item) => item.batchIndex === batch.batchIndex);
    if (existing) {
      if (!isDeepStrictEqual(existing, batch)) {
        throw new Error(`BACKGROUND_MAINTENANCE_BATCH_CONFLICT:${batch.taskId}:${batch.batchIndex}`);
      }
      replaceBackgroundMaintenanceBatch(this.cache.backgroundMaintenanceBatches, existing);
      return;
    }
    const batchSnapshot = [...this.cache.backgroundMaintenanceBatches];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      await super.saveBackgroundMaintenanceBatch(batch);
      this.db.exec("COMMIT;");
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.cache.backgroundMaintenanceBatches, batchSnapshot);
      throw caught;
    }
  }

  override async commitBackgroundMaintenanceCheckpoint(input: CommitBackgroundMaintenanceCheckpointRequest) {
    const taskSnapshot = [...this.cache.backgroundMaintenanceTasks];
    const batchSnapshot = [...this.cache.backgroundMaintenanceBatches];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const currentTask = this.readBackgroundMaintenanceTaskById(input.task.taskId);
      assertBackgroundMaintenanceLease(currentTask, input.claimedBy, input.task.updatedAt);
      if (input.batch.taskId !== input.task.taskId) {
        throw new Error(`BACKGROUND_MAINTENANCE_CHECKPOINT_TASK_CONFLICT:${input.task.taskId}`);
      }
      await super.saveBackgroundMaintenanceBatch(input.batch);
      await super.saveBackgroundMaintenanceTask(input.task);
      this.db.exec("COMMIT;");
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.cache.backgroundMaintenanceTasks, taskSnapshot);
      replaceArray(this.cache.backgroundMaintenanceBatches, batchSnapshot);
      throw caught;
    }
  }

  override async commitFixedBackgroundMaintenance(input: CommitFixedBackgroundMaintenanceRequest) {
    const documentSnapshot = [...this.cache.backgroundDocuments];
    const taskSnapshot = [...this.cache.backgroundMaintenanceTasks];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      assertBackgroundMaintenanceCommitScope(input);
      assertBackgroundMaintenanceLease(
        this.readBackgroundMaintenanceTaskById(input.task.taskId),
        input.claimedBy,
        input.task.updatedAt
      );
      const currentRow = this.db.prepare(`
        SELECT fixed_revision AS fixedRevision
        FROM background_context_documents
        WHERE tenant_id = ? AND principal_id = ?
        ORDER BY fixed_revision DESC
        LIMIT 1
      `).get(input.document.tenantId, input.document.principalId) as { fixedRevision?: number } | undefined;
      const currentRevision = Number(currentRow?.fixedRevision ?? 0);
      if (currentRevision !== input.expectedFixedRevision) {
        throw new Error(`REVISION_CONFLICT:${input.expectedFixedRevision}:${currentRevision}`);
      }
      await super.saveBackgroundDocument(input.document);
      await super.saveBackgroundMaintenanceTask(input.task);
      this.db.exec("COMMIT;");
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.cache.backgroundDocuments, documentSnapshot);
      replaceArray(this.cache.backgroundMaintenanceTasks, taskSnapshot);
      throw caught;
    }
  }

  override getBackgroundDynamicCache(cacheKey: string) {
    const row = this.db.prepare(`
      SELECT ${backgroundDynamicCacheSelectColumns}
      FROM background_dynamic_cache
      WHERE cache_key = ?
      LIMIT 1
    `).get(cacheKey) as Record<string, unknown> | undefined;
    return row ? normalizeBackgroundDynamicCacheRow(row) : undefined;
  }

  override async saveBackgroundDynamicCache(record: BackgroundDynamicCacheRecord) {
    const cacheSnapshot = [...this.cache.backgroundDynamicCaches];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      await super.saveBackgroundDynamicCache(record);
      this.db.exec("COMMIT;");
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.cache.backgroundDynamicCaches, cacheSnapshot);
      throw caught;
    }
  }

  override getLatestBackgroundDynamicCache(
    tenantId: string,
    principalId: string,
    fixedRevision?: number
  ) {
    const revisionClause = fixedRevision === undefined ? "" : "AND fixed_revision = ?";
    const params = fixedRevision === undefined
      ? [tenantId, principalId]
      : [tenantId, principalId, fixedRevision];
    const row = this.db.prepare(`
      SELECT ${backgroundDynamicCacheSelectColumns}
      FROM background_dynamic_cache
      WHERE tenant_id = ? AND principal_id = ? ${revisionClause}
      ORDER BY generated_at DESC, cache_key DESC
      LIMIT 1
    `).get(...(params as never[])) as Record<string, unknown> | undefined;
    return row ? normalizeBackgroundDynamicCacheRow(row) : undefined;
  }

  override async deleteExpiredBackgroundDynamicCaches(expiredAt: string) {
    const result = this.db.prepare(`DELETE FROM background_dynamic_cache WHERE expires_at <= ?`).run(expiredAt);
    removeWhere(this.cache.backgroundDynamicCaches, (record) => record.expiresAt <= expiredAt);
    return Number(result.changes);
  }

  override getSessionBackgroundSnapshot(tenantId: string, principalId: string, sessionId: string) {
    const row = this.db.prepare(`
      SELECT ${sessionBackgroundSnapshotSelectColumns}
      FROM session_background_snapshots
      WHERE tenant_id = ? AND principal_id = ? AND session_id = ?
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT 1
    `).get(tenantId, principalId, sessionId) as Record<string, unknown> | undefined;
    return row ? normalizeSessionBackgroundSnapshotRow(row) : undefined;
  }

  override async createSessionBackgroundSnapshot(snapshot: SessionBackgroundSnapshot) {
    assertSessionBackgroundSnapshot(snapshot);
    const snapshotCache = [...this.cache.sessionBackgroundSnapshots];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existingRow = this.db.prepare(`
        SELECT ${sessionBackgroundSnapshotSelectColumns}
        FROM session_background_snapshots
        WHERE snapshot_id = ?
        LIMIT 1
      `).get(snapshot.snapshotId) as Record<string, unknown> | undefined;
      if (existingRow) {
        const existing = normalizeSessionBackgroundSnapshotRow(existingRow);
        if (
          existing.tenantId !== snapshot.tenantId ||
          existing.principalId !== snapshot.principalId ||
          existing.sessionId !== snapshot.sessionId
        ) {
          throw new Error(`SESSION_BACKGROUND_SCOPE_CONFLICT:${snapshot.snapshotId}`);
        }
        replaceById(this.cache.sessionBackgroundSnapshots, existing, "snapshotId");
        this.db.exec("COMMIT;");
        return existing;
      }
      const created = await super.createSessionBackgroundSnapshot(snapshot);
      this.db.exec("COMMIT;");
      return created;
    } catch (caught) {
      this.db.exec("ROLLBACK;");
      replaceArray(this.cache.sessionBackgroundSnapshots, snapshotCache);
      throw caught;
    }
  }

  private readBackgroundMaintenanceTaskById(taskId: string) {
    const row = this.db.prepare(`
      SELECT ${backgroundMaintenanceTaskSelectColumns}
      FROM background_maintenance_tasks
      WHERE task_id = ?
      LIMIT 1
    `).get(taskId) as Record<string, unknown> | undefined;
    return row ? normalizeBackgroundMaintenanceTaskRow(row) : undefined;
  }

  override getLongTermMemory(memoryId: string): LongTermMemory | undefined {
    const cached = super.getLongTermMemory(memoryId);
    if (cached) return cached;
    const row = this.db
      .prepare(`
        SELECT
          memory_id AS memoryId,
          tenant_id AS tenantId,
          principal_id AS principalId,
          theory_class AS theoryClass,
          memory_type AS memoryType,
          content,
          structured_facts AS structuredFacts,
          fact_summary AS factSummary,
          summary,
          evidence_time_start AS evidenceTimeStart,
          evidence_time_end AS evidenceTimeEnd,
          evidence_time_confidence AS evidenceTimeConfidence,
          valid_time_start AS validTimeStart,
          valid_time_end AS validTimeEnd,
          valid_time_confidence AS validTimeConfidence,
          consolidation_key AS consolidationKey,
          version,
          previous_version_id AS previousVersionId,
          consolidation_score AS consolidationScore,
          consolidation_factors AS consolidationFactors,
          policy_version AS policyVersion,
          prompt_version AS promptVersion,
          model,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_maintained_at AS lastMaintainedAt,
          confidence_level AS confidenceLevel,
          recall_weight AS recallWeight,
          retrieval_weight AS retrievalWeight,
          user_retrieval_weight AS userRetrievalWeight,
          solidify_reason AS solidifyReason,
          source_refs AS sourceRefs,
          source_memory_data_ids AS sourceMemoryDataIds,
          source_fact_ids AS sourceFactIds,
          entity_ids AS entityIds,
          matched_rules AS matchedRules,
          access_state AS accessState,
          lifecycle_status AS lifecycleStatus
        FROM long_term_memories
        WHERE memory_id = ?
        LIMIT 1
      `)
      .get(memoryId) as Record<string, unknown> | undefined;
    return row ? normalizeLongTermMemoryRow(normalizeRow(row)) : undefined;
  }

  override getGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string): GraphMemoryNode | undefined {
    const cached = super.getGraphMemoryNode(ownerType, ownerId);
    if (cached) return cached;
    const row = this.db
      .prepare(`
        SELECT
          graph_node_id AS graphNodeId,
          owner_id AS ownerId,
          owner_type AS ownerType,
          memory_type AS memoryType,
          content,
          fact_summary AS factSummary,
          vector,
          lifecycle_status AS lifecycleStatus,
          retrieval_weight AS retrievalWeight,
          source_refs AS sourceRefs,
          entity_ids AS entityIds,
          evidence_time_start AS evidenceTimeStart,
          evidence_time_end AS evidenceTimeEnd,
          evidence_time_confidence AS evidenceTimeConfidence,
          valid_time_start AS validTimeStart,
          valid_time_end AS validTimeEnd,
          valid_time_confidence AS validTimeConfidence,
          refreshed_at AS refreshedAt
        FROM graph_memory_nodes
        WHERE owner_type = ? AND owner_id = ?
        LIMIT 1
      `)
      .get(ownerType, ownerId) as Record<string, unknown> | undefined;
    return row ? normalizeGraphMemoryNodeRow(normalizeRow(row)) : undefined;
  }

  override listGraphMemoryNodes(query: GraphMemoryNodePageQuery): MaybePromise<GraphMemoryNodePage> {
    if (this.graphStore) return this.graphStore.listGraphMemoryNodes(query);
    const ownerTypePlaceholders = sqlPlaceholders(query.ownerTypes.length);
    const afterClause = query.after
      ? `AND (owner_type > ? OR (owner_type = ? AND owner_id > ?))`
      : "";
    const params: unknown[] = [
      ...query.ownerTypes,
      ...(query.after ? [query.after.layer, query.after.layer, query.after.id] : []),
      query.limit + 1,
      Math.max(0, query.offset ?? 0)
    ];
    const rows = this.db.prepare(`
      SELECT
        graph_node_id AS graphNodeId,
        owner_id AS ownerId,
        owner_type AS ownerType,
        memory_type AS memoryType,
        content,
        fact_summary AS factSummary,
        vector,
        lifecycle_status AS lifecycleStatus,
        retrieval_weight AS retrievalWeight,
        source_refs AS sourceRefs,
        entity_ids AS entityIds,
        evidence_time_start AS evidenceTimeStart,
        evidence_time_end AS evidenceTimeEnd,
        evidence_time_confidence AS evidenceTimeConfidence,
        valid_time_start AS validTimeStart,
        valid_time_end AS validTimeEnd,
        valid_time_confidence AS validTimeConfidence,
        refreshed_at AS refreshedAt
      FROM graph_memory_nodes
      WHERE owner_type IN (${ownerTypePlaceholders})
        ${afterClause}
      ORDER BY owner_type ASC, owner_id ASC
      LIMIT ? OFFSET ?
    `).all(...(params as never[])).map((row) =>
      normalizeGraphMemoryNodeRow(normalizeRow(row as Record<string, unknown>))
    );
    return {
      nodes: rows.slice(0, query.limit).map(cloneGraphMemoryNode),
      hasMore: rows.length > query.limit
    };
  }

  override listGraphRelationEdges(query: GraphRelationEdgePageQuery): MaybePromise<GraphRelationEdgePage> {
    if (this.graphStore) return this.graphStore.listGraphRelationEdges(query);
    const ownerTypePlaceholders = sqlPlaceholders(query.ownerTypes.length);
    const relationTypePlaceholders = sqlPlaceholders(query.relationTypes.length);
    const afterClause = query.after ? `AND rel.edge_id > ?` : "";
    const params: unknown[] = [
      ...query.ownerTypes,
      ...query.ownerTypes,
      ...query.relationTypes,
      ...(query.after ? [query.after.id] : []),
      query.limit + 1,
      Math.max(0, query.offset ?? 0)
    ];
    const rows = this.db.prepare(`
      SELECT DISTINCT
        rel.edge_id AS edgeId,
        rel.from_id AS fromId,
        rel.to_id AS toId,
        rel.relation_type AS relationType,
        rel.evidence,
        rel.strength,
        rel.confidence,
        rel.source,
        rel.created_at AS createdAt
      FROM relation_edges rel
      INNER JOIN graph_memory_nodes from_node
        ON from_node.owner_id = rel.from_id
      INNER JOIN graph_memory_nodes to_node
        ON to_node.owner_id = rel.to_id
      WHERE from_node.owner_type IN (${ownerTypePlaceholders})
        AND to_node.owner_type IN (${ownerTypePlaceholders})
        AND rel.relation_type IN (${relationTypePlaceholders})
        ${afterClause}
      ORDER BY rel.edge_id ASC
      LIMIT ? OFFSET ?
    `).all(...(params as never[])).map((row) =>
      normalizeRelationEdgeRow(normalizeRow(row as Record<string, unknown>))
    );
    return {
      edges: rows.slice(0, query.limit).map(cloneRelationEdge),
      hasMore: rows.length > query.limit
    };
  }

  override getIndexEntryByOwnerId(ownerId: string): ContextIndexEntry | undefined {
    const cached = super.getIndexEntryByOwnerId(ownerId);
    if (cached) return cached;
    const row = this.db
      .prepare(`
        SELECT
          index_id AS indexId,
          owner_id AS ownerId,
          owner_type AS ownerType,
          '' AS content,
          token_count AS tokenCount,
          lifecycle_status AS lifecycleStatus,
          refreshed_at AS refreshedAt
        FROM context_index_entries
        WHERE owner_id = ?
        ORDER BY refreshed_at DESC
        LIMIT 1
      `)
      .get(ownerId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const item = normalizeRow(row);
    return {
      indexId: String(item.indexId ?? ""),
      ownerId: String(item.ownerId ?? ""),
      ownerType: item.ownerType as ContextIndexEntry["ownerType"],
      content: String(item.content ?? ""),
      lifecycleStatus: String(item.lifecycleStatus ?? "active"),
      refreshedAt: String(item.refreshedAt ?? new Date(0).toISOString()),
      tokenCount: Number(item.tokenCount ?? 0)
    };
  }

  override findMemoryOwnersBySourceIds(sourceIds: string[], ownerTypes: GraphMemoryOwnerType[] = ["stm", "ltm"]): MemoryOwnerBySourceHit[] {
    const allowed = new Set(sourceIds.map((item) => item.trim()).filter(Boolean));
    if (!allowed.size) return [];
    const hits: MemoryOwnerBySourceHit[] = [];
    if (ownerTypes.includes("stm")) {
      const rows = this.db
        .prepare(`SELECT memory_data_id AS ownerId, source_refs AS sourceRefs FROM short_term_memories`)
        .all()
        .map((row) => normalizeRow(row as Record<string, unknown>)) as Array<{ ownerId: string; sourceRefs?: unknown }>;
      for (const row of rows) {
        const sourceRefs = Array.isArray(row.sourceRefs) ? row.sourceRefs as Array<{ sourceId?: string }> : [];
        if (sourceRefs.some((source) => source.sourceId && allowed.has(source.sourceId))) {
          hits.push({ ownerType: "stm", ownerId: row.ownerId, score: 1 });
        }
      }
    }
    if (ownerTypes.includes("ltm")) {
      const rows = this.db
        .prepare(`SELECT memory_id AS ownerId, source_refs AS sourceRefs FROM long_term_memories`)
        .all()
        .map((row) => normalizeRow(row as Record<string, unknown>)) as Array<{ ownerId: string; sourceRefs?: unknown }>;
      for (const row of rows) {
        const sourceRefs = Array.isArray(row.sourceRefs) ? row.sourceRefs as Array<{ sourceId?: string }> : [];
        if (sourceRefs.some((source) => source.sourceId && allowed.has(source.sourceId))) {
          hits.push({ ownerType: "ltm", ownerId: row.ownerId, score: 1 });
        }
      }
    }
    return hits;
  }

  override findMemoryOwnersByContextScopeId(
    contextScopeId: string,
    ownerTypes: GraphMemoryOwnerType[] = ["stm", "ltm"]
  ): MemoryOwnerBySourceHit[] {
    const scopeId = contextScopeId.trim();
    if (!scopeId) return [];
    const scopedFactRows = this.db
      .prepare(`SELECT fact_id AS factId FROM fact_items WHERE context_scope_id = ?`)
      .all(scopeId) as Array<{ factId?: string }>;
    const scopedFactIds = new Set(scopedFactRows.flatMap((row) => row.factId ? [row.factId] : []));
    if (!scopedFactIds.size) return [];

    const scopedStmIds = new Set<string>();
    const stmRows = this.db
      .prepare(`SELECT memory_data_id AS ownerId, source_fact_ids AS sourceFactIds FROM short_term_memories`)
      .all()
      .map((row) => normalizeRow(row as Record<string, unknown>)) as Array<{ ownerId: string; sourceFactIds?: unknown }>;
    for (const row of stmRows) {
      const sourceFactIds = Array.isArray(row.sourceFactIds) ? row.sourceFactIds as string[] : [];
      if (sourceFactIds.some((factId) => scopedFactIds.has(factId))) scopedStmIds.add(row.ownerId);
    }

    const hits: MemoryOwnerBySourceHit[] = [];
    if (ownerTypes.includes("stm")) {
      for (const ownerId of scopedStmIds) hits.push({ ownerType: "stm", ownerId, score: 1 });
    }
    if (ownerTypes.includes("ltm")) {
      const ltmRows = this.db
        .prepare(`SELECT memory_id AS ownerId, source_fact_ids AS sourceFactIds, source_memory_data_ids AS sourceMemoryDataIds FROM long_term_memories`)
        .all()
        .map((row) => normalizeRow(row as Record<string, unknown>)) as Array<{
          ownerId: string;
          sourceFactIds?: unknown;
          sourceMemoryDataIds?: unknown;
        }>;
      for (const row of ltmRows) {
        const sourceFactIds = Array.isArray(row.sourceFactIds) ? row.sourceFactIds as string[] : [];
        const sourceMemoryDataIds = Array.isArray(row.sourceMemoryDataIds) ? row.sourceMemoryDataIds as string[] : [];
        if (
          sourceFactIds.some((factId) => scopedFactIds.has(factId)) ||
          sourceMemoryDataIds.some((memoryDataId) => scopedStmIds.has(memoryDataId))
        ) {
          hits.push({ ownerType: "ltm", ownerId: row.ownerId, score: 1 });
        }
      }
    }
    return hits;
  }

  override getFactItemsByIds(factIds: string[]): FactItem[] {
    const allowed = [...new Set(factIds.map((item) => item.trim()).filter(Boolean))];
    if (!allowed.length) return [];
    return chunkSqlValues(allowed).flatMap((batch) => {
      const placeholders = sqlPlaceholders(batch.length);
      return this.db
        .prepare(`
          SELECT
            fact_id AS factId,
            session_id AS sessionId,
            fact_sequence AS factSequence,
            tenant_id AS tenantId,
            principal_id AS principalId,
            context_scope_id AS contextScopeId,
            fact_type AS factType,
            fact_text AS factText,
            time_anchor AS timeAnchor,
            source_claim AS sourceClaim,
            normalized_claim AS normalizedClaim,
            linked_event_ids AS linkedEventIds,
            linked_segment_ids AS linkedSegmentIds,
            linked_source_refs AS linkedSourceRefs,
            entity_ids AS entityIds,
            confidence_level AS confidenceLevel,
            version,
            status,
            observed_at AS observedAt,
            evidence_time AS evidenceTime,
            valid_time AS validTime,
            temporal_events AS events,
            evidence_time_start AS evidenceTimeStart,
            evidence_time_end AS evidenceTimeEnd,
            evidence_time_confidence AS evidenceTimeConfidence,
            source_message_ids AS sourceMessageIds,
            valid_time_start AS validTimeStart,
            valid_time_end AS validTimeEnd,
            valid_time_basis AS validTimeBasis,
            valid_time_confidence AS validTimeConfidence,
            time_basis AS timeBasis,
            time_confidence AS timeConfidence,
            schema_version AS schemaVersion
          FROM fact_items
          WHERE fact_id IN (${placeholders})
          ORDER BY fact_id
        `)
        .all(...batch)
        .map((row) => normalizeFactItemRow(normalizeRow(row as Record<string, unknown>)));
    }).sort((left, right) => left.factId.localeCompare(right.factId));
  }

  override findFactItemsByEventIds(eventIds: string[]): FactItem[] {
    const allowed = [...new Set(eventIds.map((item) => item.trim()).filter(Boolean))];
    if (!allowed.length) return [];
    const factIds = chunkSqlValues(allowed).flatMap((batch) => {
      const placeholders = sqlPlaceholders(batch.length);
      return this.db.prepare(`
        SELECT DISTINCT fact.fact_id AS factId
        FROM fact_items AS fact
        JOIN json_each(
          CASE WHEN json_valid(fact.linked_event_ids) THEN fact.linked_event_ids ELSE '[]' END
        ) AS linked_event
        WHERE linked_event.value IN (${placeholders})
        ORDER BY fact.fact_id
      `).all(...batch).flatMap((row) => {
        const factId = (row as { factId?: unknown }).factId;
        return typeof factId === "string" && factId ? [factId] : [];
      });
    });
    return this.getFactItemsByIds([...new Set(factIds)]);
  }

  override searchTextIndex(queryTokens: string[]): TextIndexSearchHit[] {
    const normalizedTokens = expandSearchTokens(queryTokens);
    if (!normalizedTokens.length) return [];
    const query = normalizedTokens
      .map((token) => `"${token.replaceAll('"', '""')}"*`)
      .join(" OR ");
    if (!query.trim()) return [];
    return this.db
      .prepare(
        `SELECT owner_type AS ownerType, owner_id AS ownerId, SUM(term_frequency) AS score, COUNT(DISTINCT term) AS matchedTerms
         FROM context_text_index_fts
         WHERE context_text_index_fts MATCH ?
         GROUP BY owner_type, owner_id
         ORDER BY score DESC, owner_type, owner_id`
      )
      .all(query)
      .map((row) => normalizeRow(row) as { ownerType: "fact" | "stm" | "ltm"; ownerId: string; score: number; matchedTerms: number })
      .map((row) => ({
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        score: Number(row.score ?? 0),
        matchedTerms: Number(row.matchedTerms ?? 0)
      }));
  }

  override listKeywordCorpusContents(): string[] {
    return this.db
      .prepare(`
        SELECT content
        FROM context_index_entries
        WHERE owner_type IN ('stm', 'ltm') AND content <> ''
        ORDER BY owner_type, owner_id
      `)
      .all()
      .map((row) => String(normalizeRow(row as Record<string, unknown>).content ?? ""))
      .filter(Boolean);
  }

  override searchGraphText(queryTokens: string[], options: GraphMemorySearchOptions = {}): GraphMemorySearchHit[] {
    const normalizedTokens = [...new Set(queryTokens.map((token) => token.normalize("NFKC").toLowerCase().trim()).filter(Boolean))];
    if (!normalizedTokens.length) return [];
    const query = normalizedTokens
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(" OR ");
    if (!query.trim()) return [];
    return this.db
      .prepare(
        `SELECT context_text_index_fts.owner_type AS ownerType, context_text_index_fts.owner_id AS ownerId, -bm25(context_text_index_fts) AS score
         FROM context_text_index_fts
         JOIN graph_memory_nodes graph
           ON graph.owner_type = context_text_index_fts.owner_type
          AND graph.owner_id = context_text_index_fts.owner_id
         LEFT JOIN short_term_memories stm
           ON context_text_index_fts.owner_type = 'stm'
          AND stm.memory_data_id = context_text_index_fts.owner_id
         LEFT JOIN long_term_memories ltm
           ON context_text_index_fts.owner_type = 'ltm'
          AND ltm.memory_id = context_text_index_fts.owner_id
         WHERE context_text_index_fts MATCH ?
           AND (
             (context_text_index_fts.owner_type = 'stm' AND stm.memory_data_id IS NOT NULL) OR
             (context_text_index_fts.owner_type = 'ltm' AND ltm.memory_id IS NOT NULL)
           )
         ORDER BY score DESC, context_text_index_fts.owner_type, context_text_index_fts.owner_id`
      )
      .all(query)
      .map((row) => normalizeRow(row) as { ownerType: GraphMemoryOwnerType; ownerId: string; score: number })
      .filter((row) => matchesGraphSearchOptions(row.ownerType, row.ownerId, options))
      .map((row) => ({
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        score: Number(row.score ?? 0)
      }));
  }

  override searchFactText(queryTokens: string[], options: FactIndexSearchQuery = {}): FactIndexSearchHit[] {
    const tokens = [...new Set(queryTokens.map((token) => token.normalize("NFKC").toLowerCase().trim()).filter(Boolean))];
    if (!tokens.length) return [];
    const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    return this.db.prepare(`
      SELECT fts.owner_id AS factId, -bm25(context_text_index_fts) AS score
      FROM context_text_index_fts fts
      JOIN fact_items fact ON fact.fact_id = fts.owner_id
      WHERE context_text_index_fts MATCH ?
        AND fts.owner_type = 'fact'
        AND (? IS NULL OR fact.tenant_id = ?)
        AND (? IS NULL OR fact.principal_id = ?)
        AND (? = 1 OR fact.status IN ('active', 'conflicted'))
      ORDER BY score DESC, factId
      LIMIT ?
    `).all(
      ftsQuery,
      options.tenantId ?? null,
      options.tenantId ?? null,
      options.principalId ?? null,
      options.principalId ?? null,
      options.includeInactive ? 1 : 0,
      options.limit ?? 100
    ).map((row) => normalizeRow(row) as { factId: string; score: number })
      .map((row) => ({ factId: row.factId, score: Number(row.score ?? 0) }));
  }

  override searchFactVector(queryVector: number[], options: FactIndexSearchQuery = {}): FactIndexSearchHit[] {
    if (!queryVector.length) return [];
    const facts = new Map(this.getDebugSnapshot().facts.map((fact) => [fact.factId, fact]));
    return this.db.prepare(`
      SELECT owner_id AS factId, vector
      FROM context_vector_index_entries
      WHERE owner_type = 'fact'
    `).all().flatMap((raw) => {
      const row = normalizeRow(raw as Record<string, unknown>);
      const factId = String(row.factId ?? "");
      const fact = facts.get(factId);
      if (!fact || !factMatchesIndexQuery(fact, options)) return [];
      const vector = parseJsonArray(row.vector).map(Number);
      return [{ factId, score: cosine(queryVector, vector) }];
    }).filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.factId.localeCompare(right.factId))
      .slice(0, options.limit ?? 100);
  }

  override async deleteTextIndexEntry(indexId: string) {
    await super.deleteTextIndexEntry(indexId);
    this.exec(`DELETE FROM context_text_index_fts WHERE index_id = ?`, [indexId]);
  }

  override async deleteIndexEntry(indexId: string) {
    await super.deleteIndexEntry(indexId);
    this.exec(`DELETE FROM context_index_entries WHERE index_id = ?`, [indexId]);
  }

  override async deleteVectorIndexEntry(indexId: string) {
    await super.deleteVectorIndexEntry(indexId);
    this.exec(`DELETE FROM context_vector_index_entries WHERE index_id = ?`, [indexId]);
  }

  override async deleteIndexBundle(ownerType: "fact" | "stm" | "ltm", ownerId: string) {
    await super.deleteIndexBundle(ownerType, ownerId);
    this.exec(`DELETE FROM context_index_entries WHERE owner_id = ? AND owner_type = ?`, [ownerId, ownerType]);
    this.exec(`DELETE FROM context_vector_index_entries WHERE owner_id = ? AND owner_type = ?`, [ownerId, ownerType]);
    this.exec(`DELETE FROM context_text_index_fts WHERE owner_id = ? AND owner_type = ?`, [ownerId, ownerType]);
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private loadFromDatabase() {
    const multimodalDataByEventId = groupBy(
      this.queryAll<(MemoryEvent["multimodalData"][number]) & { eventId: string; sourceItemId?: string }>(`
        SELECT
          event_id AS eventId,
          item_id AS itemId,
          source_item_id AS sourceItemId,
          type,
          format,
          content,
          ref,
          source_ref AS sourceRef,
          source_refs AS sourceRefs,
          time_basis AS timeBasis,
          time_confidence AS timeConfidence,
          custom_fields AS customFields
        FROM multimodal_data_items
      `),
      (item) => item.eventId
    );
    const sourceRefsByEventId = groupBy(
      this.queryAll<NonNullable<MemoryEvent["sourceRefs"]>[number] & { eventId: string }>(`
        SELECT
          esr.event_id AS eventId,
          sr.source_ref_id AS sourceRefId,
          sr.source_type AS sourceType,
          sr.source_id AS sourceId,
          sr.source_url AS sourceUrl
        FROM event_source_refs esr
        JOIN source_refs sr ON sr.source_ref_id = esr.source_ref_id
      `),
      (item) => item.eventId
    );

    appendAll(
      this.memoryEvents,
      this.queryAll<MemoryEvent>(`
        SELECT
          event_id AS eventId,
          context_scope_id AS contextScopeId,
          event_type AS eventType,
          event_summary AS eventSummary,
          event_description AS eventDescription,
          event_time AS eventTime,
          source_app AS sourceApp,
          source_id AS sourceId,
          data_source AS dataSource,
          custom_fields AS customFields,
          tenant_id AS tenantId,
          principal_id AS principalId,
          source_acl_version AS sourceAclVersion,
          visibility
        FROM memory_events
      `).map((event) => {
        const {
          tenantId,
          principalId,
          sourceAclVersion,
          visibility,
          ...eventFields
        } = event as MemoryEvent & {
          tenantId?: string;
          principalId?: string;
          sourceAclVersion?: string;
          visibility?: MemoryEvent["permissionSnapshot"]["visibility"];
        };
        return normalizeMemoryEventSourceRefs({
          ...eventFields,
          permissionSnapshot: {
            snapshotId: `ps_${event.eventId}`,
            tenantId: tenantId ?? "local",
            principalId: principalId ?? "local",
            sourceAclVersion: sourceAclVersion ?? "default",
            visibility: visibility ?? "private"
          },
          eventSummary: event.eventSummary ?? event.eventDescription ?? event.eventType,
          multimodalData: (multimodalDataByEventId.get(event.eventId) ?? []).map(({ eventId: _eventId, sourceItemId, itemId, ...item }) => ({
            ...item,
            itemId: typeof sourceItemId === "string" && sourceItemId ? sourceItemId : itemId
          })),
          sourceRefs: (sourceRefsByEventId.get(event.eventId) ?? []).map(({ eventId: _eventId, ...item }) => item)
        });
      })
    );

    appendAll(this.parsedSegments, this.queryAll<ParsedSegment & { dataSource?: string; customFields?: string }>(`
      SELECT
        segment_id AS segmentId,
        event_id AS eventId,
        modality,
        content,
        status,
        confidence,
        data_source AS dataSource,
        custom_fields AS customFields
      FROM parsed_segments
    `).map((segment) => {
      const customFields = normalizeCustomFields(segment.customFields);
      const hasCustomFields = Object.keys(customFields).length > 0;
      return {
        ...segment,
        ...(segment.dataSource ? { dataSource: segment.dataSource as ParsedSegment["dataSource"] } : {}),
        ...(hasCustomFields ? { customFields } : {})
      };
    }));

    appendAll(this.facts, this.queryAll<Record<string, unknown>>(`
      SELECT
        fact_id AS factId,
        session_id AS sessionId,
        fact_sequence AS factSequence,
        tenant_id AS tenantId,
        principal_id AS principalId,
        context_scope_id AS contextScopeId,
        fact_type AS factType,
        fact_text AS factText,
        time_anchor AS timeAnchor,
        source_claim AS sourceClaim,
        normalized_claim AS normalizedClaim,
        linked_event_ids AS linkedEventIds,
        linked_segment_ids AS linkedSegmentIds,
        linked_source_refs AS linkedSourceRefs,
        entity_ids AS entityIds,
        confidence_level AS confidenceLevel,
        version,
        status,
        observed_at AS observedAt,
        evidence_time AS evidenceTime,
        valid_time AS validTime,
        temporal_events AS events,
        evidence_time_start AS evidenceTimeStart,
        evidence_time_end AS evidenceTimeEnd,
        evidence_time_confidence AS evidenceTimeConfidence,
        source_message_ids AS sourceMessageIds,
        valid_time_start AS validTimeStart,
        valid_time_end AS validTimeEnd,
        valid_time_basis AS validTimeBasis,
        valid_time_confidence AS validTimeConfidence,
        time_basis AS timeBasis,
        time_confidence AS timeConfidence,
        schema_version AS schemaVersion
      FROM fact_items
    `).map(normalizeFactItemRow));

    appendAll(this.factVersions, this.queryAll<Record<string, unknown>>(`
      SELECT
        fact_version_id AS factVersionId,
        fact_id AS factId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        version,
        previous_version_id AS previousVersionId,
        fact_text AS factText,
        normalized_claim AS normalizedClaim,
        fact_type AS factType,
        evidence_time_start AS evidenceTimeStart,
        evidence_time_end AS evidenceTimeEnd,
        valid_time_start AS validTimeStart,
        valid_time_end AS validTimeEnd,
        confidence_level AS confidenceLevel,
        source_fact_ids AS sourceFactIds,
        linked_event_ids AS linkedEventIds,
        linked_segment_ids AS linkedSegmentIds,
        linked_source_refs AS linkedSourceRefs,
        update_reason AS updateReason,
        conflict_refs AS conflictRefs,
        source_fingerprint AS sourceFingerprint,
        created_at AS createdAt
      FROM fact_versions
      ORDER BY fact_id, version, fact_version_id
    `).map(normalizeFactVersionRow));

    appendAll(this.factBatches, this.queryAll<Record<string, unknown>>(`
      SELECT
        batch_id AS batchId,
        trigger_type AS triggerType,
        tenant_id AS tenantId,
        principal_id AS principalId,
        context_scope_id AS contextScopeId,
        new_fact_ids AS newFactIds,
        committed_at AS committedAt
      FROM fact_batches
      ORDER BY committed_at, batch_id
    `).map(normalizeFactBatchRow));

    appendAll(this.timelineFusionTasks, this.queryAll<Record<string, unknown>>(`
      SELECT
        task_id AS taskId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        context_scope_id AS contextScopeId,
        batch_ids AS batchIds,
        new_fact_ids AS newFactIds,
        status,
        scheduled_at AS scheduledAt,
        deadline_at AS deadlineAt,
        ready_at AS readyAt,
        execution_fingerprints AS executionFingerprints,
        completion_reason AS completionReason,
        completed_at AS completedAt,
        error,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM timeline_fusion_tasks
      ORDER BY scheduled_at, task_id
    `).map(normalizeTimelineFusionTaskRow));

    appendAll(this.timelineFusionExecutions, this.queryAll<Record<string, unknown>>(`
      SELECT
        fingerprint,
        execution_id AS executionId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        context_scope_id AS contextScopeId,
        task_ids AS taskIds,
        batch_ids AS batchIds,
        new_fact_ids AS newFactIds,
        temporal_basis AS temporalBasis,
        temporal_start_at AS temporalStartAt,
        temporal_end_at AS temporalEndAt,
        fusion_policy_version AS fusionPolicyVersion,
        status,
        result_fact_ids AS resultFactIds,
        attempt,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        completion_reason AS completionReason,
        error,
        created_at AS createdAt,
        updated_at AS updatedAt,
        completed_at AS completedAt
      FROM timeline_fusion_executions
      ORDER BY created_at, fingerprint
    `).map(normalizeTimelineFusionExecutionRow));

    appendAll(this.shortTermMemories, this.queryAll<ShortTermMemory>(`
      SELECT
        memory_data_id AS memoryDataId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        memory_data_type AS memoryDataType,
        memory_type AS memoryType,
        content,
        structured_facts AS structuredFacts,
        fact_summary AS factSummary,
        summary,
        evidence_time AS evidenceTime,
        valid_time AS validTime,
        evidence_time_start AS evidenceTimeStart,
        evidence_time_end AS evidenceTimeEnd,
        evidence_time_confidence AS evidenceTimeConfidence,
        valid_time_start AS validTimeStart,
        valid_time_end AS validTimeEnd,
        valid_time_confidence AS validTimeConfidence,
        importance_level AS importanceLevel,
        retrieval_weight AS retrievalWeight,
        user_retrieval_weight AS userRetrievalWeight,
        confidence_level AS confidenceLevel,
        admission_result AS admissionResult,
        admission_reason AS admissionReason,
        source_fact_ids AS sourceFactIds,
        source_refs AS sourceRefs,
        entity_ids AS entityIds,
        matched_rules AS matchedRules,
        admission_signals AS admissionSignals,
        access_state AS accessState,
        lifecycle_status AS lifecycleStatus,
        consolidation_status AS consolidationStatus,
        next_evaluate_at AS nextEvaluateAt,
        last_evaluated_at AS lastEvaluatedAt,
        observe_count AS observeCount,
        reevaluation_reason AS reevaluationReason,
        expires_at AS expiresAt,
        dreaming_policy_version AS dreamingPolicyVersion,
        latest_decision_id AS latestDecisionId,
        reevaluation_tier AS reevaluationTier,
        cycle_attempt_count AS cycleAttemptCount,
        total_attempt_count AS totalAttemptCount,
        last_dreaming_error AS lastDreamingError,
        latest_dreaming_run_id AS latestDreamingRunId
      FROM short_term_memories
    `).map((item) => {
      const {
        factSummary,
        evidenceTime: _evidenceTime,
        validTime: _validTime,
        evidenceTimeStart: _evidenceTimeStart,
        evidenceTimeEnd: _evidenceTimeEnd,
        evidenceTimeConfidence: _evidenceTimeConfidence,
        validTimeStart: _validTimeStart,
        validTimeEnd: _validTimeEnd,
        validTimeConfidence: _validTimeConfidence,
        ...memoryWithoutFactSummary
      } = item;
      const normalizedFactSummary = normalizeFactSummary(factSummary);
      const sourceEventId = item.memoryDataId.startsWith("stm_")
        ? item.memoryDataId.slice("stm_".length)
        : item.memoryDataId;
      const sourceFacts = this.facts.filter((fact) => fact.linkedEventIds.includes(sourceEventId));
      const sourceFactIds = readArrayOrFallback(item.sourceFactIds, () => sourceFacts.map((fact) => fact.factId));
      const exactSourceFacts = this.facts.filter((fact) => sourceFactIds.includes(fact.factId));
      const structuredFacts = typeof item.structuredFacts === "string" && item.structuredFacts
        ? JSON.parse(item.structuredFacts)
        : item.structuredFacts;
      const temporalMetadata = aggregateMemoryTemporalMetadata(exactSourceFacts.length
        ? [
          ...exactSourceFacts.map(temporalMetadataFromFact),
          ...(structuredFacts?.facts ?? [])
        ]
        : [
          ...(structuredFacts?.facts ?? []),
          item
        ]);
      return {
        ...memoryWithoutFactSummary,
        ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {}),
        ...temporalMetadata,
        structuredFacts,
        memoryType: item.memoryType ?? "fact",
        sourceFactIds,
        sourceRefs: readArrayOrFallback(item.sourceRefs, () => uniqueById(
          sourceFacts.flatMap((fact) => fact.linkedSourceRefs),
          (source) => source.sourceRefId
        )),
        entityIds: readArrayOrFallback(item.entityIds, () => uniqueStrings(sourceFacts.flatMap((fact) => fact.entityIds))),
        matchedRules: Array.isArray(item.matchedRules) ? item.matchedRules : [],
        retrievalWeight: typeof item.retrievalWeight === "number" ? item.retrievalWeight : shortTermRetrievalWeight(item.importanceLevel),
        admissionSignals: typeof item.admissionSignals === "string" ? JSON.parse(item.admissionSignals) : item.admissionSignals
      };
    }) as ShortTermMemory[]);

    appendAll(this.longTermMemories, this.queryAll<LongTermMemory>(`
      SELECT
        memory_id AS memoryId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        consolidation_key AS consolidationKey,
        version,
        previous_version_id AS previousVersionId,
        consolidation_score AS consolidationScore,
        consolidation_factors AS consolidationFactors,
        policy_version AS policyVersion,
        prompt_version AS promptVersion,
        model,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_maintained_at AS lastMaintainedAt,
        theory_class AS theoryClass,
        memory_type AS memoryType,
        content,
        structured_facts AS structuredFacts,
        fact_summary AS factSummary,
        summary,
        evidence_time_start AS evidenceTimeStart,
        evidence_time_end AS evidenceTimeEnd,
        evidence_time_confidence AS evidenceTimeConfidence,
        valid_time_start AS validTimeStart,
        valid_time_end AS validTimeEnd,
        valid_time_confidence AS validTimeConfidence,
        confidence_level AS confidenceLevel,
        recall_weight AS recallWeight,
        retrieval_weight AS retrievalWeight,
        user_retrieval_weight AS userRetrievalWeight,
        solidify_reason AS solidifyReason,
        source_refs AS sourceRefs,
        source_memory_data_ids AS sourceMemoryDataIds,
        source_fact_ids AS sourceFactIds,
        entity_ids AS entityIds,
        matched_rules AS matchedRules,
        access_state AS accessState,
        lifecycle_status AS lifecycleStatus
      FROM long_term_memories
    `).map((item) => {
      const { factSummary, ...memoryWithoutFactSummary } = item;
      const normalizedFactSummary = normalizeFactSummary(factSummary);
      const structuredFacts = typeof item.structuredFacts === "string" && item.structuredFacts
        ? JSON.parse(item.structuredFacts)
        : item.structuredFacts;
      const consolidationFactors = typeof item.consolidationFactors === "string" && item.consolidationFactors
        ? JSON.parse(item.consolidationFactors)
        : item.consolidationFactors;
      const sourceMemoryDataIds = typeof item.sourceMemoryDataIds === "string"
        ? JSON.parse(item.sourceMemoryDataIds)
        : item.sourceMemoryDataIds ?? [];
      const sourceFactIds = typeof item.sourceFactIds === "string"
        ? JSON.parse(item.sourceFactIds)
        : item.sourceFactIds ?? [];
      const sourceMemories = this.shortTermMemories.filter((memory) =>
        sourceMemoryDataIds.includes(memory.memoryDataId)
      );
      const temporalMetadata = aggregateMemoryTemporalMetadata(sourceMemories.length
        ? [...sourceMemories, ...(structuredFacts?.facts ?? [])]
        : [...(structuredFacts?.facts ?? []), item]);
      return {
        ...memoryWithoutFactSummary,
        ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {}),
        ...temporalMetadata,
        ...(item.consolidationKey ? { consolidationKey: item.consolidationKey } : {}),
        version: typeof item.version === "number" ? item.version : 1,
        ...(item.previousVersionId ? { previousVersionId: item.previousVersionId } : {}),
        ...(typeof item.consolidationScore === "number" ? { consolidationScore: item.consolidationScore } : {}),
        ...(consolidationFactors ? { consolidationFactors } : {}),
        ...(item.policyVersion ? { policyVersion: item.policyVersion } : {}),
        ...(item.promptVersion ? { promptVersion: item.promptVersion } : {}),
        ...(item.model ? { model: item.model } : {}),
        ...(item.createdAt ? { createdAt: item.createdAt } : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        ...(item.lastMaintainedAt ? { lastMaintainedAt: item.lastMaintainedAt } : {}),
        structuredFacts,
        sourceRefs: typeof item.sourceRefs === "string" ? JSON.parse(item.sourceRefs) : item.sourceRefs ?? [],
        sourceMemoryDataIds,
        sourceFactIds,
        entityIds: typeof item.entityIds === "string" ? JSON.parse(item.entityIds) : item.entityIds ?? [],
        matchedRules: typeof item.matchedRules === "string" ? JSON.parse(item.matchedRules) : item.matchedRules ?? [],
        retrievalWeight: typeof item.retrievalWeight === "number" ? item.retrievalWeight : longTermRetrievalWeight(item.recallWeight)
      } as LongTermMemory;
    }));

    appendAll(this.relationEdges, this.queryAll<RelationEdge>(`
      SELECT
        edge_id AS edgeId,
        from_id AS fromId,
        to_id AS toId,
        relation_type AS relationType,
        evidence,
        strength,
        confidence,
        source,
        created_at AS createdAt
      FROM relation_edges
    `));

    appendAll(this.packTraces, this.queryAll<ContextPackTrace>(`
      SELECT trace_id AS traceId, pack_id AS packId, final_score AS finalScore,
             token_budget AS tokenBudget, temporal_trace AS temporal
      FROM context_pack_traces
    `).map((item) => ({
      ...item,
      ...(typeof item.temporal === "string" ? { temporal: JSON.parse(item.temporal) } : {})
    })));

    appendAll(this.llmFactFusionTraces, this.queryAll<LlmFactFusionTrace>(`
      SELECT
        trace_id AS traceId,
        event_id AS eventId,
        provider,
        endpoint,
        model,
        key_source AS keySource,
        prompt_version AS promptVersion,
        schema_version AS schemaVersion,
        '' AS prompt,
        '[]' AS alignedEvidence,
        NULL AS rawResponse,
        '[]' AS parsedFacts,
        '[]' AS rejectedSegments,
        fallback_reason AS fallbackReason,
        temporal_trace AS temporal,
        created_at AS createdAt
      FROM llm_fact_fusion_traces
    `).map(({ rawResponse, ...item }) => ({
      ...item,
      alignedEvidence: typeof item.alignedEvidence === "string" ? JSON.parse(item.alignedEvidence) : item.alignedEvidence,
      ...(rawResponse === null ? {} : { rawResponse: typeof rawResponse === "string" ? JSON.parse(rawResponse) : rawResponse }),
      parsedFacts: typeof item.parsedFacts === "string" ? JSON.parse(item.parsedFacts) : item.parsedFacts,
      rejectedSegments: typeof item.rejectedSegments === "string" ? JSON.parse(item.rejectedSegments) : item.rejectedSegments,
      ...(typeof item.temporal === "string" ? { temporal: JSON.parse(item.temporal) } : {})
    } as LlmFactFusionTrace)));

    appendAll(this.llmStmAdmissionTraces, this.queryAll<LlmStmAdmissionTrace>(`
      SELECT
        trace_id AS traceId,
        event_id AS eventId,
        provider,
        endpoint,
        model,
        key_source AS keySource,
        prompt_version AS promptVersion,
        schema_version AS schemaVersion,
        '' AS prompt,
        '[]' AS factInputs,
        NULL AS rawResponse,
        NULL AS parsedDecision,
        fallback_reason AS fallbackReason,
        override_reason AS overrideReason,
        created_at AS createdAt
      FROM llm_stm_admission_traces
    `).map(({ rawResponse, parsedDecision, ...item }) => ({
      ...item,
      factInputs: typeof item.factInputs === "string" ? JSON.parse(item.factInputs) : item.factInputs,
      ...(rawResponse === null ? {} : { rawResponse: typeof rawResponse === "string" ? JSON.parse(rawResponse) : rawResponse }),
      ...(parsedDecision === null ? {} : { parsedDecision: typeof parsedDecision === "string" ? JSON.parse(parsedDecision) : parsedDecision })
    } as LlmStmAdmissionTrace)));

    appendAll(this.llmDreamingTraces, this.queryAll<LlmDreamingTrace>(`
      SELECT
        trace_id AS traceId,
        source_memory_data_ids AS sourceMemoryDataIds,
        provider,
        endpoint,
        model,
        key_source AS keySource,
        prompt_version AS promptVersion,
        schema_version AS schemaVersion,
        '' AS prompt,
        '[]' AS candidateMemories,
        NULL AS rawResponse,
        '[]' AS parsedMemories,
        stm_evaluations AS stmEvaluations,
        ltm_operations AS ltmOperations,
        '[]' AS rejectedCandidates,
        fallback_reason AS fallbackReason,
        retry_after AS retryAfter,
        created_at AS createdAt
      FROM llm_dreaming_traces
    `).map(({ rawResponse, ...item }) => ({
      ...item,
      sourceMemoryDataIds: typeof item.sourceMemoryDataIds === "string" ? JSON.parse(item.sourceMemoryDataIds) : item.sourceMemoryDataIds,
      candidateMemories: typeof item.candidateMemories === "string" ? JSON.parse(item.candidateMemories) : item.candidateMemories,
      ...(rawResponse === null ? {} : { rawResponse: typeof rawResponse === "string" ? JSON.parse(rawResponse) : rawResponse }),
      parsedMemories: typeof item.parsedMemories === "string" ? JSON.parse(item.parsedMemories) : item.parsedMemories,
      stmEvaluations: typeof item.stmEvaluations === "string" ? JSON.parse(item.stmEvaluations) : item.stmEvaluations,
      ltmOperations: typeof item.ltmOperations === "string" ? JSON.parse(item.ltmOperations) : item.ltmOperations,
      rejectedCandidates: typeof item.rejectedCandidates === "string" ? JSON.parse(item.rejectedCandidates) : item.rejectedCandidates
    } as LlmDreamingTrace)));

    appendAll(this.pipelineTasks, this.queryAll<ContextPipelineTask>(`
      SELECT
        task_id AS taskId,
        event_id AS eventId,
        task_type AS taskType,
        status,
        attempt,
        max_attempts AS maxAttempts,
        retryable,
        stage,
        error,
        retry_after AS retryAfter,
        checkpoint,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        stats,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM context_pipeline_tasks
    `).map((item) => ({
      ...item,
      retryable: Boolean(item.retryable),
      ...(typeof item.stats === "string" && item.stats ? { stats: JSON.parse(item.stats) } : {})
    } as ContextPipelineTask)));

    appendAll(this.dreamingCandidateDecisions, this.queryAll<Record<string, unknown>>(`
      SELECT
        decision_id AS decisionId,
        run_id AS runId,
        candidate_fingerprint AS candidateFingerprint,
        memory_data_id AS memoryDataId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        decision,
        reason_codes AS reasonCodes,
        source_fact_ids AS sourceFactIds,
        source_refs AS sourceRefs,
        permission_snapshot_ids AS permissionSnapshotIds,
        policy_version AS policyVersion,
        trace_id AS traceId,
        evaluated_at AS evaluatedAt,
        next_evaluate_at AS nextEvaluateAt,
        created_at AS createdAt
      FROM dreaming_candidate_decisions
    `).map((item) => ({
      ...item,
      reasonCodes: parseJsonArray(item.reasonCodes),
      sourceFactIds: parseJsonArray(item.sourceFactIds),
      sourceRefs: parseJsonArray(item.sourceRefs),
      permissionSnapshotIds: parseJsonArray(item.permissionSnapshotIds)
    } as DreamingCandidateDecision)));

    appendAll(this.dreamingOutbox, this.queryAll<Record<string, unknown>>(`
      SELECT outbox_id AS outboxId, operation, owner_id AS ownerId, payload, status, attempts,
             next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
      FROM dreaming_outbox
    `).map((item) => ({
      ...item,
      ...(typeof item.payload === "string" && item.payload ? { payload: JSON.parse(item.payload) } : {})
    } as DreamingOutboxRecord)));

    appendAll(this.dreamingRuns, this.queryAll<DreamingRun>(`
      SELECT
        run_id AS runId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        trigger_type AS triggerType,
        schedule_key AS scheduleKey,
        status,
        requested_at AS requestedAt,
        candidate_window_start_at AS candidateWindowStartAt,
        candidate_cutoff_at AS candidateCutoffAt,
        actual_started_at AS actualStartedAt,
        paused_at AS pausedAt,
        pause_reason AS pauseReason,
        completed_at AS completedAt,
        checkpoint,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        policy_version AS policyVersion,
        prompt_version AS promptVersion,
        model,
        candidate_count AS candidateCount,
        processed_count AS processedCount,
        consolidated_count AS consolidatedCount,
        observing_count AS observingCount,
        dropped_count AS droppedCount,
        retry_wait_count AS retryWaitCount,
        skipped_count AS skippedCount,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM dreaming_runs
    `));

    appendAll(this.dreamingRunCandidates, this.queryAll<DreamingRunCandidate>(`
      SELECT
        run_candidate_id AS runCandidateId,
        run_id AS runId,
        memory_data_id AS memoryDataId,
        stm_version AS stmVersion,
        candidate_fingerprint AS candidateFingerprint,
        source_type AS sourceType,
        status,
        cycle_attempt_count AS cycleAttemptCount,
        total_attempt_count AS totalAttemptCount,
        reevaluation_tier AS reevaluationTier,
        next_evaluate_at AS nextEvaluateAt,
        decision_id AS decisionId,
        trace_id AS traceId,
        result_ltm_id AS resultLtmId,
        last_error AS lastError,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        started_at AS startedAt,
        completed_at AS completedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM dreaming_run_candidates
    `));

    appendAll(this.indexEntries, this.queryAll<ContextIndexEntry>(`
      SELECT index_id AS indexId, owner_id AS ownerId, owner_type AS ownerType, '' AS content, lifecycle_status AS lifecycleStatus, refreshed_at AS refreshedAt, token_count AS tokenCount
      FROM context_index_entries
    `));

    appendAll(this.vectorIndexEntries, this.queryAll<ContextVectorIndexEntry>(`
      SELECT
        index_id AS indexId,
        owner_id AS ownerId,
        owner_type AS ownerType,
        '' AS content,
        '[]' AS vector,
        lifecycle_status AS lifecycleStatus,
        refreshed_at AS refreshedAt
      FROM context_vector_index_entries
    `).map((item) => ({ ...item, vector: typeof item.vector === "string" ? JSON.parse(item.vector) : item.vector } as ContextVectorIndexEntry)));

    appendAll(this.graphMemoryNodes, this.queryAll<GraphMemoryNode>(`
      SELECT
        graph_node_id AS graphNodeId,
        owner_id AS ownerId,
        owner_type AS ownerType,
        memory_type AS memoryType,
        content,
        fact_summary AS factSummary,
        vector,
        lifecycle_status AS lifecycleStatus,
        retrieval_weight AS retrievalWeight,
        source_refs AS sourceRefs,
        entity_ids AS entityIds,
        evidence_time_start AS evidenceTimeStart,
        evidence_time_end AS evidenceTimeEnd,
        evidence_time_confidence AS evidenceTimeConfidence,
        valid_time_start AS validTimeStart,
        valid_time_end AS validTimeEnd,
        valid_time_confidence AS validTimeConfidence,
        refreshed_at AS refreshedAt
      FROM graph_memory_nodes
    `).map((item) => {
      const { factSummary, ...nodeWithoutFactSummary } = item;
      const normalizedFactSummary = normalizeFactSummary(factSummary);
      return {
        ...nodeWithoutFactSummary,
        ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {}),
        vector: typeof item.vector === "string" ? JSON.parse(item.vector) : item.vector,
        sourceRefs: typeof item.sourceRefs === "string" ? JSON.parse(item.sourceRefs) : item.sourceRefs,
        entityIds: typeof item.entityIds === "string" ? JSON.parse(item.entityIds) : item.entityIds
      } as GraphMemoryNode;
    }));

    appendAll(this.changeEvents, this.queryAll<MemoryChangeEvent>(`
      SELECT
        event_id AS eventId,
        memory_id AS memoryId,
        memory_data_id AS memoryDataId,
        change_type AS changeType,
        storage_layer AS storageLayer,
        reason,
        created_at AS createdAt
      FROM memory_change_events
    `));

    appendAll(this.feedbackItems, this.queryAll<MemoryFeedbackItem>(`
      SELECT
        feedback_id AS feedbackId,
        target_id AS targetId,
        target_type AS targetType,
        action,
        note,
        created_at AS createdAt
      FROM memory_feedback_items
    `));

    appendAll(this.retrievalEvents, this.queryAll<MemoryRetrievalEvent>(`
      SELECT
        retrieval_event_id AS retrievalEventId,
        owner_type AS ownerType,
        owner_id AS ownerId,
        tenant_id AS tenantId,
        principal_id AS principalId,
        session_id AS sessionId,
        task_id AS taskId,
        request_id AS requestId,
        event_type AS eventType,
        query,
        feedback_action AS feedbackAction,
        created_at AS createdAt
      FROM memory_retrieval_events
    `));

    appendAll(this.backgroundDocuments, this.db.prepare(`
      SELECT ${backgroundDocumentSelectColumns}
      FROM background_context_documents
    `).all().map((row) => normalizeBackgroundContextDocumentRow(row as Record<string, unknown>)));
    appendAll(this.backgroundMaintenanceTasks, this.db.prepare(`
      SELECT ${backgroundMaintenanceTaskSelectColumns}
      FROM background_maintenance_tasks
    `).all().map((row) => normalizeBackgroundMaintenanceTaskRow(row as Record<string, unknown>)));
    appendAll(this.backgroundMaintenanceBatches, this.db.prepare(`
      SELECT
        task_id AS taskId,
        batch_index AS batchIndex,
        through_cursor_json AS throughCursor,
        memory_ids_json AS memoryIds,
        memory_source_refs_json AS memorySourceRefs,
        memory_count AS memoryCount,
        analysis_output_json AS analysisOutput,
        estimated_input_tokens AS estimatedInputTokens,
        created_at AS createdAt
      FROM background_maintenance_batches
    `).all().map((row) => normalizeBackgroundMaintenanceBatchRow(row as Record<string, unknown>)));
    appendAll(this.backgroundDynamicCaches, this.db.prepare(`
      SELECT ${backgroundDynamicCacheSelectColumns}
      FROM background_dynamic_cache
    `).all().map((row) => normalizeBackgroundDynamicCacheRow(row as Record<string, unknown>)));
    appendAll(this.sessionBackgroundSnapshots, this.db.prepare(`
      SELECT ${sessionBackgroundSnapshotSelectColumns}
      FROM session_background_snapshots
    `).all().map((row) => normalizeSessionBackgroundSnapshotRow(row as Record<string, unknown>)));
    appendAll(this.conversationBatchIngestions, this.db.prepare(`
      SELECT * FROM conversation_batch_ingestions ORDER BY rowid
    `).all().map((row) => normalizeConversationBatchIngestionRow(row as Record<string, unknown>)));
    appendAll(this.conversationIngestions, this.db.prepare(`
      SELECT * FROM conversation_ingestions ORDER BY rowid
    `).all().map((row) => normalizeConversationIngestionRow(row as Record<string, unknown>)));
    appendAll(this.conversationDocuments, this.db.prepare(`
      SELECT
        document_id AS documentId,
        batch_ingestion_id AS batchIngestionId,
        ingestion_id AS ingestionId,
        schema_version AS schemaVersion,
        sha256,
        byte_size AS byteSize,
        raw_markdown AS rawMarkdown,
        created_at AS createdAt
      FROM conversation_documents
      ORDER BY rowid
    `).all().map((row) => normalizeRow(row as Record<string, unknown>) as unknown as ConversationDocumentRecord));
    appendAll(this.conversationMessages, this.db.prepare(`
      SELECT ${conversationMessageSelectColumns("cm", {
        documentIdExpression: `(SELECT cdm.document_id
          FROM conversation_document_messages AS cdm
          WHERE cdm.conversation_message_row_id = cm.conversation_message_row_id
            AND cdm.ingestion_id = cm.first_ingestion_id
          ORDER BY cdm.message_order LIMIT 1)`
      })}
      FROM conversation_messages AS cm
      ORDER BY cm.sequence, cm.revision, cm.message_id
    `).all().map((row) => normalizeConversationMessageRow(row as Record<string, unknown>)));
    appendAll(this.conversationDocumentMessageRows, this.db.prepare(`
      SELECT
        document_id AS documentId,
        ingestion_id AS ingestionId,
        conversation_message_row_id AS conversationMessageRowId,
        message_order AS messageOrder
      FROM conversation_document_messages
      ORDER BY ingestion_id, message_order
    `).all().map((row) => normalizeRow(row as Record<string, unknown>) as {
      documentId: string;
      ingestionId: string;
      conversationMessageRowId: string;
      messageOrder: number;
    }));
    appendAll(this.conversationSessionCursors, this.db.prepare(`
      SELECT
        tenant_id AS tenantId,
        source_app AS sourceApp,
        principal_id AS principalId,
        session_id AS sessionId,
        committed_cursor AS committedCursor,
        last_sequence AS lastSequence,
        last_ingestion_id AS lastIngestionId,
        updated_at AS updatedAt
      FROM conversation_session_cursors
      ORDER BY rowid
    `).all().map((row) => normalizeRow(row as Record<string, unknown>) as unknown as ConversationSessionCursorRecord));
    appendAll(this.conversationIngestionJobs, this.db.prepare(`
      SELECT * FROM conversation_ingestion_jobs ORDER BY rowid
    `).all().map((row) => normalizeConversationIngestionJobRow(row as Record<string, unknown>)));
    appendAll(this.conversationTemporalBackfillMigrations, this.db.prepare(`
      SELECT version, status, attempt, counts_json AS countsJson, errors_json AS errorsJson,
             started_at AS startedAt, completed_at AS completedAt, updated_at AS updatedAt,
             duration_ms AS durationMs
      FROM context_engine_migrations
      WHERE migration_type = 'temporal_backfill'
      ORDER BY version
    `).all().map((row) => normalizeTemporalBackfillMigrationRow(row as Record<string, unknown>)));
  }
}

function appendAll<T>(target: T[], items: T[]) {
  for (const item of items) {
    target.push(item);
  }
}

function readArrayOrFallback<T>(value: unknown, fallback: () => T[]): T[] {
  return Array.isArray(value) && value.length ? value as T[] : fallback();
}

function uniqueById<T>(items: T[], keyForItem: (item: T) => string) {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = keyForItem(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

function replaceById<T extends object, K extends keyof T>(items: T[], item: T, key: K) {
  const index = items.findIndex((entry) => entry[key] === item[key]);
  if (index >= 0) {
    items[index] = item;
    return;
  }
  items.push(item);
}

function resolveFactOwner(
  fact: FactItem,
  existing: FactItem | undefined,
  events: readonly MemoryEvent[]
): FactItem {
  const explicitTenantId = fact.tenantId?.trim();
  const explicitPrincipalId = fact.principalId?.trim();
  const explicitContextScopeId = fact.contextScopeId?.trim();
  if (Boolean(explicitTenantId) !== Boolean(explicitPrincipalId)) {
    throw new Error(`FACT_OWNER_INCOMPLETE:${fact.factId}`);
  }
  const linkedEventIds = new Set(fact.linkedEventIds);
  const eventOwners = uniqueById(
    events
      .filter((event) => linkedEventIds.has(event.eventId))
      .map((event) => ({
        tenantId: event.permissionSnapshot.tenantId,
        principalId: event.permissionSnapshot.principalId
      })),
    (owner) => `${owner.tenantId}\u001f${owner.principalId}`
  );
  if (eventOwners.length > 1) throw new Error(`FACT_OWNER_AMBIGUOUS:${fact.factId}`);
  const eventOwner = eventOwners[0];
  const eventContextScopeIds = uniqueStrings(
    events
      .filter((event) => linkedEventIds.has(event.eventId))
      .map((event) => event.contextScopeId?.trim() ?? "")
      .filter(Boolean)
  );
  if (eventContextScopeIds.length > 1) throw new Error(`FACT_CONTEXT_SCOPE_AMBIGUOUS:${fact.factId}`);
  const existingOwner = existing?.tenantId && existing.principalId
    ? { tenantId: existing.tenantId, principalId: existing.principalId }
    : undefined;
  const explicitOwner = explicitTenantId && explicitPrincipalId
    ? { tenantId: explicitTenantId, principalId: explicitPrincipalId }
    : undefined;
  const owner = explicitOwner ?? existingOwner ?? eventOwner;
  const contextScopeId = explicitContextScopeId ?? existing?.contextScopeId ?? eventContextScopeIds[0];
  const contextScopeCandidates = uniqueStrings([
    explicitContextScopeId ?? "",
    existing?.contextScopeId ?? "",
    ...eventContextScopeIds
  ]);
  if (contextScopeCandidates.length > 1) throw new Error(`FACT_CONTEXT_SCOPE_CONFLICT:${fact.factId}`);
  for (const candidate of [explicitOwner, existingOwner, eventOwner]) {
    if (owner && candidate && (
      owner.tenantId !== candidate.tenantId || owner.principalId !== candidate.principalId
    )) {
      throw new Error(`FACT_OWNER_CONFLICT:${fact.factId}`);
    }
  }
  return {
    ...fact,
    ...(owner ? { tenantId: owner.tenantId, principalId: owner.principalId } : {}),
    ...(contextScopeId ? { contextScopeId } : {})
  };
}

function factVersionParams(version: FactVersion): unknown[] {
  return [
    version.factVersionId,
    version.factId,
    version.tenantId,
    version.principalId,
    version.version,
    version.previousVersionId ?? null,
    version.factText,
    version.normalizedClaim,
    version.factType,
    version.evidenceTimeStart ?? null,
    version.evidenceTimeEnd ?? null,
    version.validTimeStart ?? null,
    version.validTimeEnd ?? null,
    version.confidenceLevel,
    JSON.stringify(version.sourceFactIds),
    JSON.stringify(version.linkedEventIds),
    JSON.stringify(version.linkedSegmentIds),
    JSON.stringify(version.linkedSourceRefs),
    version.updateReason,
    JSON.stringify(version.conflictRefs),
    version.sourceFingerprint,
    version.createdAt
  ];
}

function compareFactVersions(left: FactVersion, right: FactVersion) {
  return left.factId.localeCompare(right.factId) ||
    left.version - right.version ||
    left.factVersionId.localeCompare(right.factVersionId);
}

function factVersionConflict(key: string) {
  return new TimelineFusionFactStoreError(
    "TIMELINE_FUSION_FACT_STORE_CONFLICT",
    `Fact version conflicts with an immutable stored version: ${key}.`
  );
}

function replaceArray<T>(target: T[], items: T[]) {
  target.splice(0, target.length, ...items);
}

function replaceBackgroundMaintenanceBatch(
  batches: BackgroundMaintenanceBatch[],
  batch: BackgroundMaintenanceBatch
) {
  const index = batches.findIndex((item) =>
    item.taskId === batch.taskId && item.batchIndex === batch.batchIndex
  );
  if (index >= 0) {
    batches[index] = batch;
  } else {
    batches.push(batch);
  }
}

function removeWhere<T>(items: T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item !== undefined && predicate(item)) {
      items.splice(index, 1);
    }
  }
}

function groupBy<T, K>(items: T[], keyForItem: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyForItem(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

function expandSearchTokens(tokens: string[]) {
  const expanded: string[] = [];
  for (const token of tokens) {
    if (/^[\u3400-\u9fff]+$/u.test(token)) {
      expanded.push(...token.split(""));
    } else {
      expanded.push(token);
    }
  }
  return [...new Set(expanded.filter(Boolean))];
}

function factMatchesIndexQuery(fact: FactItem, query: FactIndexSearchQuery) {
  return (!query.tenantId || fact.tenantId === query.tenantId) &&
    (!query.principalId || fact.principalId === query.principalId) &&
    (query.includeInactive || fact.status === "active" || fact.status === "conflicted") &&
    fact.accessState !== "permission-invalid";
}

function buildFactIndexContent(fact: FactItem) {
  return `${fact.factText}\n${fact.normalizedClaim}\n${fact.sourceClaim ?? ""}`.normalize("NFKC").toLowerCase();
}

function matchesGraphSearchOptions(
  ownerType: GraphMemoryOwnerType,
  ownerId: string,
  options: GraphMemorySearchOptions
) {
  if (options.ownerTypes && !options.ownerTypes.includes(ownerType)) return false;
  if (options.ownerKeys && !options.ownerKeys.includes(`${ownerType}:${ownerId}`)) return false;
  return true;
}

function graphMemoryNodeIsAfter(
  node: GraphMemoryNode,
  after: NonNullable<GraphMemoryNodePageQuery["after"]>
) {
  return node.ownerType > after.layer ||
    (node.ownerType === after.layer && node.ownerId > after.id);
}

function compareGraphMemoryNodes(left: GraphMemoryNode, right: GraphMemoryNode) {
  return compareText(left.ownerType, right.ownerType) || compareText(left.ownerId, right.ownerId);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function latestConversationEvidenceMessages(messages: readonly ConversationMessageRecord[]) {
  const latest = new Map<string, ConversationMessageRecord>();
  for (const message of messages) {
    const key = [
      message.tenantId,
      message.principalId,
      message.sourceApp,
      message.sessionId,
      message.messageId
    ].join("\u0000");
    const current = latest.get(key);
    if (!current || message.revision > current.revision) latest.set(key, message);
  }
  return [...latest.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) ||
    left.sequence - right.sequence ||
    left.conversationMessageRowId.localeCompare(right.conversationMessageRowId)
  );
}

function cloneGraphMemoryNode(node: GraphMemoryNode): GraphMemoryNode {
  return {
    ...node,
    vector: [...node.vector],
    sourceRefs: node.sourceRefs.map((sourceRef) => ({ ...sourceRef })),
    entityIds: [...node.entityIds]
  };
}

function cloneRelationEdge(edge: RelationEdge): RelationEdge {
  return { ...edge };
}

function normalizeCustomFields(value: unknown): DataLakeCustomFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isJsonValue(item)) {
      normalized[key] = item;
    }
  }
  return normalized as DataLakeCustomFields;
}

function isJsonValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function cosine(left: number[], right: number[]) {
  if (!left.length || !right.length) return 0;
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom > 0 ? dot / denom : 0;
}

function normalizeRow<T extends Record<string, unknown>>(row: T): T {
  const entries = Object.entries(row).map(([key, value]) => {
    if (typeof value === "string") {
      if (value.startsWith("{") || value.startsWith("[")) {
        try {
          return [key, JSON.parse(value)] as const;
        } catch {
          return [key, value] as const;
        }
      }
    }
    return [key, value] as const;
  });
  return Object.fromEntries(entries) as T;
}

function normalizeShortTermMemoryRow(row: Record<string, unknown>): ShortTermMemory {
  const item = row as Partial<ShortTermMemory>;
  const normalizedFactSummary = normalizeFactSummary(item.factSummary);
  const structuredFacts = item.structuredFacts
    ? item.structuredFacts as NonNullable<ShortTermMemory["structuredFacts"]>
    : undefined;
  const temporalMetadata = aggregateMemoryTemporalMetadata([
    item,
    ...(structuredFacts?.facts ?? [])
  ]);
  const memory: ShortTermMemory = {
    memoryDataId: String(item.memoryDataId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    memoryDataType: String(item.memoryDataType ?? "manual_memory_event"),
    content: String(item.content ?? ""),
    ...temporalMetadata,
    sourceFactIds: Array.isArray(item.sourceFactIds) ? item.sourceFactIds as string[] : [],
    sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs as ShortTermMemory["sourceRefs"] : [],
    entityIds: Array.isArray(item.entityIds) ? item.entityIds as string[] : [],
    importanceLevel: item.importanceLevel ?? "medium",
    confidenceLevel: item.confidenceLevel ?? "medium",
    admissionResult: item.admissionResult ?? "write_short_term",
    admissionReason: String(item.admissionReason ?? ""),
    matchedRules: Array.isArray(item.matchedRules) ? item.matchedRules as string[] : [],
    admissionSignals: item.admissionSignals && typeof item.admissionSignals === "object"
      ? item.admissionSignals as ShortTermMemory["admissionSignals"]
      : {
          importance: "medium",
          confidence: "medium",
          freshness: "recent",
          sensitivity: "low",
          actorWeight: "medium",
          conflict: "none",
          permission: "private"
        },
    lifecycleStatus: item.lifecycleStatus ?? "active",
    ...(item.memoryType ? { memoryType: item.memoryType } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {}),
    ...(structuredFacts ? { structuredFacts } : {}),
    ...(typeof item.retrievalWeight === "number" ? { retrievalWeight: item.retrievalWeight } : {}),
    ...(typeof item.userRetrievalWeight === "number" ? { userRetrievalWeight: item.userRetrievalWeight } : {}),
    ...(item.accessState ? { accessState: item.accessState } : {}),
    ...(item.consolidationStatus ? { consolidationStatus: item.consolidationStatus } : {}),
    ...(item.nextEvaluateAt ? { nextEvaluateAt: item.nextEvaluateAt } : {}),
    ...(item.lastEvaluatedAt ? { lastEvaluatedAt: item.lastEvaluatedAt } : {}),
    ...(typeof item.observeCount === "number" ? { observeCount: item.observeCount } : {}),
    ...(item.reevaluationReason ? { reevaluationReason: item.reevaluationReason } : {}),
    ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
    ...(item.dreamingPolicyVersion ? { dreamingPolicyVersion: item.dreamingPolicyVersion } : {}),
    ...(item.latestDecisionId ? { latestDecisionId: item.latestDecisionId } : {}),
    ...(item.reevaluationTier ? { reevaluationTier: item.reevaluationTier } : {}),
    ...(typeof item.cycleAttemptCount === "number" ? { cycleAttemptCount: item.cycleAttemptCount } : {}),
    ...(typeof item.totalAttemptCount === "number" ? { totalAttemptCount: item.totalAttemptCount } : {}),
    ...(item.lastDreamingError ? { lastDreamingError: item.lastDreamingError } : {}),
    ...(item.latestDreamingRunId ? { latestDreamingRunId: item.latestDreamingRunId } : {})
  };
  return memory;
}

function normalizeDreamingRunRow(row: Record<string, unknown>): DreamingRun {
  return {
    runId: String(row.runId ?? ""),
    tenantId: String(row.tenantId ?? ""),
    principalId: String(row.principalId ?? ""),
    triggerType: row.triggerType === "manual" ? "manual" : "scheduled",
    ...(row.scheduleKey ? { scheduleKey: String(row.scheduleKey) } : {}),
    status: String(row.status ?? "queued") as DreamingRun["status"],
    requestedAt: String(row.requestedAt ?? ""),
    candidateWindowStartAt: String(row.candidateWindowStartAt ?? ""),
    candidateCutoffAt: String(row.candidateCutoffAt ?? ""),
    ...(row.actualStartedAt ? { actualStartedAt: String(row.actualStartedAt) } : {}),
    ...(row.pausedAt ? { pausedAt: String(row.pausedAt) } : {}),
    ...(row.pauseReason === "foreground_activity" || row.pauseReason === "manual" ? { pauseReason: row.pauseReason } : {}),
    ...(row.completedAt ? { completedAt: String(row.completedAt) } : {}),
    ...(row.checkpoint ? { checkpoint: String(row.checkpoint) } : {}),
    ...(row.leaseOwner ? { leaseOwner: String(row.leaseOwner) } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: String(row.leaseExpiresAt) } : {}),
    policyVersion: String(row.policyVersion ?? ""),
    promptVersion: String(row.promptVersion ?? ""),
    ...(row.model ? { model: String(row.model) } : {}),
    candidateCount: Number(row.candidateCount ?? 0),
    processedCount: Number(row.processedCount ?? 0),
    consolidatedCount: Number(row.consolidatedCount ?? 0),
    observingCount: Number(row.observingCount ?? 0),
    droppedCount: Number(row.droppedCount ?? 0),
    retryWaitCount: Number(row.retryWaitCount ?? 0),
    skippedCount: Number(row.skippedCount ?? 0),
    ...(row.lastError ? { lastError: String(row.lastError) } : {}),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? "")
  };
}

function normalizeDreamingRunCandidateRow(row: Record<string, unknown>): DreamingRunCandidate {
  return {
    runCandidateId: String(row.runCandidateId ?? ""),
    runId: String(row.runId ?? ""),
    memoryDataId: String(row.memoryDataId ?? ""),
    stmVersion: String(row.stmVersion ?? ""),
    candidateFingerprint: String(row.candidateFingerprint ?? ""),
    sourceType: String(row.sourceType ?? "new") as DreamingRunCandidate["sourceType"],
    status: String(row.status ?? "pending") as DreamingRunCandidate["status"],
    cycleAttemptCount: Number(row.cycleAttemptCount ?? 0),
    totalAttemptCount: Number(row.totalAttemptCount ?? 0),
    ...(row.reevaluationTier ? { reevaluationTier: String(row.reevaluationTier) as NonNullable<DreamingRunCandidate["reevaluationTier"]> } : {}),
    ...(row.nextEvaluateAt ? { nextEvaluateAt: String(row.nextEvaluateAt) } : {}),
    ...(row.decisionId ? { decisionId: String(row.decisionId) } : {}),
    ...(row.traceId ? { traceId: String(row.traceId) } : {}),
    ...(row.resultLtmId ? { resultLtmId: String(row.resultLtmId) } : {}),
    ...(row.lastError ? { lastError: String(row.lastError) } : {}),
    ...(row.leaseOwner ? { leaseOwner: String(row.leaseOwner) } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: String(row.leaseExpiresAt) } : {}),
    ...(row.startedAt ? { startedAt: String(row.startedAt) } : {}),
    ...(row.completedAt ? { completedAt: String(row.completedAt) } : {}),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? "")
  };
}

function isDreamingNewShortTermMemory(memory: ShortTermMemory, policyVersion: string) {
  const status = memory.consolidationStatus ?? "unseen";
  if (status === "unseen" || status === "evaluating" || status === "pending_confirm") return true;
  return (status === "consolidated" || status === "dropped") &&
    (memory.dreamingPolicyVersion !== policyVersion || Boolean(memory.reevaluationReason));
}

function isDueDreamingRetry(memory: ShortTermMemory, cutoffAt: string) {
  return (memory.consolidationStatus === "observing" ||
    memory.consolidationStatus === "retry_wait" ||
    memory.consolidationStatus === "retryable_failure") &&
    Boolean(memory.nextEvaluateAt) &&
    memory.nextEvaluateAt! <= cutoffAt;
}

function isTerminalDreamingDecisionFromOlderPolicy(memory: ShortTermMemory, policyVersion: string) {
  return (memory.consolidationStatus === "consolidated" || memory.consolidationStatus === "dropped") &&
    (memory.dreamingPolicyVersion !== policyVersion || Boolean(memory.reevaluationReason));
}

function orderShortTermMemoriesByIds(memories: ShortTermMemory[], orderedIds: string[]) {
  const byId = new Map(memories.map((memory) => [memory.memoryDataId, memory]));
  return orderedIds.flatMap((memoryDataId) => {
    const memory = byId.get(memoryDataId);
    return memory ? [memory] : [];
  });
}

function normalizeBackgroundContextDocumentRow(row: Record<string, unknown>): BackgroundContextDocument {
  const item = normalizeRow(row);
  const status = item.updateSuggestionStatus;
  const summary = item.updateSuggestionSummary;
  const updateSuggestion = isBackgroundSuggestionStatus(status) && typeof summary === "string"
    ? {
        status,
        summary,
        targetSections: backgroundSectionArrayOrEmpty(item.updateSuggestionTargetSections)
      }
    : undefined;
  return {
    backgroundId: String(item.backgroundId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    fixedText: String(item.fixedText ?? ""),
    dynamicText: String(item.dynamicText ?? ""),
    fixedRevision: Number(item.fixedRevision ?? 0),
    fixedTextUpdatedAt: String(item.fixedTextUpdatedAt ?? ""),
    fixedWatermark: backgroundCursorOrInitial(item.fixedWatermark),
    dynamicWindowStart: String(item.dynamicWindowStart ?? ""),
    dynamicWindowEnd: String(item.dynamicWindowEnd ?? ""),
    dynamicSourceMemoryIds: stringArrayOrEmpty(item.dynamicSourceMemoryIds),
    latestStmCursor: backgroundCursorOrInitial(item.latestStmCursor),
    sourceRefIds: stringArrayOrEmpty(item.sourceRefIds),
    conflictIds: stringArrayOrEmpty(item.conflictIds),
    ...(typeof item.dynamicCacheKey === "string" && item.dynamicCacheKey
      ? { dynamicCacheKey: item.dynamicCacheKey }
      : {}),
    ...(typeof item.degradedModeReason === "string" && item.degradedModeReason
      ? { degradedModeReason: item.degradedModeReason }
      : {}),
    ...(updateSuggestion ? { updateSuggestion } : {}),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? "")
  };
}

function backgroundMaintenanceTaskParams(task: BackgroundMaintenanceTask) {
  return [
    task.taskId,
    task.runId,
    task.tenantId,
    task.principalId,
    task.status,
    task.executionStrategy,
    task.baseBackgroundId ?? null,
    task.baseRevision,
    task.windowStart,
    task.windowEnd,
    task.throughCursor ? JSON.stringify(task.throughCursor) : null,
    task.checkpointCursor ? JSON.stringify(task.checkpointCursor) : null,
    task.sectionAccumulator ? JSON.stringify(task.sectionAccumulator) : null,
    task.scannedPageCount,
    task.llmAnalysisCallCount,
    task.processedMemoryCount,
    task.ignoredMemoryCount,
    JSON.stringify(task.deferredRanges),
    task.deferredMemoryCount,
    task.inputTokenUsage,
    task.attempt,
    task.maxAttempts,
    task.retryable ? 1 : 0,
    task.error ?? null,
    task.result ? JSON.stringify(task.result) : null,
    task.claimedBy ?? null,
    task.leaseExpiresAt ?? null,
    task.createdAt,
    task.updatedAt
  ];
}

function normalizeBackgroundMaintenanceTaskRow(row: Record<string, unknown>): BackgroundMaintenanceTask {
  const item = normalizeRow(row);
  return {
    taskId: String(item.taskId ?? ""),
    runId: String(item.runId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    status: item.status as BackgroundMaintenanceTask["status"],
    executionStrategy: item.executionStrategy as BackgroundMaintenanceTask["executionStrategy"],
    baseRevision: Number(item.baseRevision ?? 0),
    windowStart: String(item.windowStart ?? ""),
    windowEnd: String(item.windowEnd ?? ""),
    scannedPageCount: Number(item.scannedPageCount ?? 0),
    llmAnalysisCallCount: Number(item.llmAnalysisCallCount ?? 0),
    processedMemoryCount: Number(item.processedMemoryCount ?? 0),
    ignoredMemoryCount: Number(item.ignoredMemoryCount ?? 0),
    deferredRanges: Array.isArray(item.deferredRanges)
      ? item.deferredRanges as BackgroundMaintenanceTask["deferredRanges"]
      : [],
    deferredMemoryCount: Number(item.deferredMemoryCount ?? 0),
    inputTokenUsage: Number(item.inputTokenUsage ?? 0),
    attempt: Number(item.attempt ?? 0),
    maxAttempts: Number(item.maxAttempts ?? 3),
    retryable: Boolean(item.retryable),
    ...(typeof item.baseBackgroundId === "string" ? { baseBackgroundId: item.baseBackgroundId } : {}),
    ...(isBackgroundCursor(item.throughCursor) ? { throughCursor: item.throughCursor } : {}),
    ...(isBackgroundCursor(item.checkpointCursor) ? { checkpointCursor: item.checkpointCursor } : {}),
    ...(item.sectionAccumulator && typeof item.sectionAccumulator === "object"
      ? { sectionAccumulator: item.sectionAccumulator as NonNullable<BackgroundMaintenanceTask["sectionAccumulator"]> }
      : {}),
    ...(typeof item.error === "string" ? { error: item.error } : {}),
    ...(item.result && typeof item.result === "object"
      ? { result: item.result as NonNullable<BackgroundMaintenanceTask["result"]> }
      : {}),
    ...(typeof item.claimedBy === "string" ? { claimedBy: item.claimedBy } : {}),
    ...(typeof item.leaseExpiresAt === "string" ? { leaseExpiresAt: item.leaseExpiresAt } : {}),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? "")
  };
}

function normalizeBackgroundMaintenanceBatchRow(row: Record<string, unknown>): BackgroundMaintenanceBatch {
  const item = normalizeRow(row);
  return {
    taskId: String(item.taskId ?? ""),
    batchIndex: Number(item.batchIndex ?? 0),
    throughCursor: backgroundCursorOrInitial(item.throughCursor),
    memoryIds: stringArrayOrEmpty(item.memoryIds),
    memorySourceRefs: item.memorySourceRefs && typeof item.memorySourceRefs === "object"
      ? item.memorySourceRefs as BackgroundMaintenanceBatch["memorySourceRefs"]
      : {},
    memoryCount: Number(item.memoryCount ?? 0),
    analysisOutput: item.analysisOutput as BackgroundMaintenanceBatch["analysisOutput"],
    estimatedInputTokens: Number(item.estimatedInputTokens ?? 0),
    createdAt: String(item.createdAt ?? "")
  };
}

function normalizeBackgroundDynamicCacheRow(row: Record<string, unknown>): BackgroundDynamicCacheRecord {
  const item = normalizeRow(row);
  return {
    cacheKey: String(item.cacheKey ?? ""),
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    fixedBackgroundId: String(item.fixedBackgroundId ?? ""),
    fixedRevision: Number(item.fixedRevision ?? 0),
    latestStmCursor: backgroundCursorOrInitial(item.latestStmCursor),
    referenceTime: String(item.referenceTime ?? "1970-01-01T00:00:00.000Z"),
    timezone: String(item.timezone ?? "Asia/Shanghai"),
    locale: String(item.locale ?? "zh-CN"),
    localDate: String(item.localDate ?? "1970-01-01"),
    windowStart: String(item.windowStart ?? ""),
    windowEnd: String(item.windowEnd ?? ""),
    dynamicText: String(item.dynamicText ?? ""),
    sourceMemoryIds: stringArrayOrEmpty(item.sourceMemoryIds),
    sourceRefIds: stringArrayOrEmpty(item.sourceRefIds),
    citations: Array.isArray(item.citations)
      ? item.citations as BackgroundDynamicCacheRecord["citations"]
      : [],
    conflictIds: stringArrayOrEmpty(item.conflictIds),
    processedMemoryCount: Number(item.processedMemoryCount ?? 0),
    pendingStmCount: Number(item.pendingStmCount ?? 0),
    deferredMemoryCount: Number(item.deferredMemoryCount ?? 0),
    deferredRanges: Array.isArray(item.deferredRanges)
      ? item.deferredRanges as BackgroundDynamicCacheRecord["deferredRanges"]
      : [],
    watermarkLagSeconds: Number(item.watermarkLagSeconds ?? 0),
    executionStrategy: item.executionStrategy as BackgroundDynamicCacheRecord["executionStrategy"],
    status: item.status as BackgroundDynamicCacheRecord["status"],
    ...(typeof item.degradedModeReason === "string"
      ? { degradedModeReason: item.degradedModeReason }
      : {}),
    generatedAt: String(item.generatedAt ?? ""),
    expiresAt: String(item.expiresAt ?? "")
  };
}

function normalizeSessionBackgroundSnapshotRow(row: Record<string, unknown>): SessionBackgroundSnapshot {
  const item = normalizeRow(row);
  return {
    snapshotId: String(item.snapshotId ?? ""),
    sessionId: String(item.sessionId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    backgroundId: String(item.backgroundId ?? ""),
    fixedRevision: Number(item.fixedRevision ?? 0),
    fixedText: String(item.fixedText ?? ""),
    dynamicText: String(item.dynamicText ?? ""),
    dynamicWindowStart: String(item.dynamicWindowStart ?? ""),
    dynamicWindowEnd: String(item.dynamicWindowEnd ?? ""),
    referenceTime: String(item.referenceTime ?? "1970-01-01T00:00:00.000Z"),
    timezone: String(item.timezone ?? "Asia/Shanghai"),
    locale: String(item.locale ?? "zh-CN"),
    localDate: String(item.localDate ?? "1970-01-01"),
    fixedSourceRefIds: stringArrayOrEmpty(item.fixedSourceRefIds),
    dynamicSourceRefIds: stringArrayOrEmpty(item.dynamicSourceRefIds),
    sourceMemoryIds: stringArrayOrEmpty(item.sourceMemoryIds),
    citations: Array.isArray(item.citations)
      ? item.citations as SessionBackgroundSnapshot["citations"]
      : [],
    conflictIds: stringArrayOrEmpty(item.conflictIds),
    latestStmCursor: backgroundCursorOrInitial(item.latestStmCursor),
    dynamicCacheKey: String(item.dynamicCacheKey ?? ""),
    cacheHit: Boolean(item.cacheHit),
    executionStrategy: item.executionStrategy as SessionBackgroundSnapshot["executionStrategy"],
    processedMemoryCount: Number(item.processedMemoryCount ?? 0),
    pendingStmCount: Number(item.pendingStmCount ?? 0),
    deferredMemoryCount: Number(item.deferredMemoryCount ?? 0),
    watermarkLagSeconds: Number(item.watermarkLagSeconds ?? 0),
    generatedAt: String(item.generatedAt ?? ""),
    status: item.status as SessionBackgroundSnapshot["status"],
    ...(typeof item.degradedModeReason === "string"
      ? { degradedModeReason: item.degradedModeReason }
      : {}),
    serializedPrompt: String(item.serializedPrompt ?? ""),
    createdAt: String(item.createdAt ?? "")
  };
}

function assertBackgroundMaintenanceTask(task: BackgroundMaintenanceTask) {
  if (!task.taskId.trim() || !task.runId.trim()) throw new Error("BACKGROUND_MAINTENANCE_TASK_ID_REQUIRED");
  if (!task.tenantId.trim() || !task.principalId.trim()) {
    throw new Error(`BACKGROUND_MAINTENANCE_TASK_OWNER_REQUIRED:${task.taskId}`);
  }
  for (const [value, code] of [
    [task.windowStart, "WINDOW_START"],
    [task.windowEnd, "WINDOW_END"],
    [task.createdAt, "CREATED_AT"],
    [task.updatedAt, "UPDATED_AT"]
  ] as const) {
    if (!isIsoTimestamp(value)) throw new Error(`BACKGROUND_MAINTENANCE_TASK_${code}_INVALID:${task.taskId}`);
  }
  if (task.windowStart > task.windowEnd) throw new Error(`BACKGROUND_MAINTENANCE_TASK_WINDOW_INVALID:${task.taskId}`);
  for (const [value, code] of [
    [task.baseRevision, "BASE_REVISION"],
    [task.scannedPageCount, "SCANNED_PAGE_COUNT"],
    [task.llmAnalysisCallCount, "LLM_CALL_COUNT"],
    [task.processedMemoryCount, "PROCESSED_COUNT"],
    [task.ignoredMemoryCount, "IGNORED_COUNT"],
    [task.deferredMemoryCount, "DEFERRED_COUNT"],
    [task.inputTokenUsage, "INPUT_TOKEN_USAGE"],
    [task.attempt, "ATTEMPT"]
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`BACKGROUND_MAINTENANCE_TASK_${code}_INVALID:${task.taskId}`);
    }
  }
  if (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1) {
    throw new Error(`BACKGROUND_MAINTENANCE_TASK_MAX_ATTEMPTS_INVALID:${task.taskId}`);
  }
}

function assertBackgroundMaintenanceBatch(batch: BackgroundMaintenanceBatch) {
  if (!batch.taskId.trim() || !Number.isInteger(batch.batchIndex) || batch.batchIndex < 1) {
    throw new Error("BACKGROUND_MAINTENANCE_BATCH_ID_INVALID");
  }
  if (!isBackgroundCursor(batch.throughCursor)) {
    throw new Error(`BACKGROUND_MAINTENANCE_BATCH_CURSOR_INVALID:${batch.taskId}:${batch.batchIndex}`);
  }
  if (batch.memoryCount !== batch.memoryIds.length) {
    throw new Error(`BACKGROUND_MAINTENANCE_BATCH_COUNT_MISMATCH:${batch.taskId}:${batch.batchIndex}`);
  }
  if (!isIsoTimestamp(batch.createdAt)) {
    throw new Error(`BACKGROUND_MAINTENANCE_BATCH_CREATED_AT_INVALID:${batch.taskId}:${batch.batchIndex}`);
  }
}

function assertBackgroundDynamicCache(record: BackgroundDynamicCacheRecord) {
  if (!record.cacheKey.trim() || !record.tenantId.trim() || !record.principalId.trim()) {
    throw new Error("BACKGROUND_DYNAMIC_CACHE_SCOPE_REQUIRED");
  }
  if (!record.fixedBackgroundId.trim() || !Number.isInteger(record.fixedRevision) || record.fixedRevision < 0) {
    throw new Error(`BACKGROUND_DYNAMIC_CACHE_FIXED_INVALID:${record.cacheKey}`);
  }
  if (!isBackgroundCursor(record.latestStmCursor)) {
    throw new Error(`BACKGROUND_DYNAMIC_CACHE_CURSOR_INVALID:${record.cacheKey}`);
  }
  assertBackgroundTemporalContext(
    record.referenceTime,
    record.timezone,
    record.locale,
    record.localDate,
    `BACKGROUND_DYNAMIC_CACHE_TEMPORAL_INVALID:${record.cacheKey}`
  );
  if (
    !["single_request", "hierarchical_batch"].includes(record.executionStrategy) ||
    !["ready", "degraded"].includes(record.status)
  ) {
    throw new Error(`BACKGROUND_DYNAMIC_CACHE_STATUS_INVALID:${record.cacheKey}`);
  }
  assertBackgroundWindow(record.windowStart, record.windowEnd, `BACKGROUND_DYNAMIC_CACHE_WINDOW_INVALID:${record.cacheKey}`);
  for (const [value, code] of [
    [record.processedMemoryCount, "PROCESSED_COUNT"],
    [record.pendingStmCount, "PENDING_COUNT"],
    [record.deferredMemoryCount, "DEFERRED_COUNT"],
    [record.watermarkLagSeconds, "WATERMARK_LAG"]
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`BACKGROUND_DYNAMIC_CACHE_${code}_INVALID:${record.cacheKey}`);
    }
  }
  if (!isIsoTimestamp(record.generatedAt) || !isIsoTimestamp(record.expiresAt) || record.expiresAt <= record.generatedAt) {
    throw new Error(`BACKGROUND_DYNAMIC_CACHE_EXPIRY_INVALID:${record.cacheKey}`);
  }
  assertBackgroundReferences(record.sourceMemoryIds, record.sourceRefIds, record.conflictIds, record.citations, record.cacheKey);
  assertBackgroundRanges(record.deferredRanges, record.cacheKey);
}

function assertSessionBackgroundSnapshot(snapshot: SessionBackgroundSnapshot) {
  if (
    !snapshot.snapshotId.trim() ||
    !snapshot.sessionId.trim() ||
    !snapshot.tenantId.trim() ||
    !snapshot.principalId.trim() ||
    !snapshot.backgroundId.trim() ||
    !snapshot.dynamicCacheKey.trim()
  ) {
    throw new Error("SESSION_BACKGROUND_SCOPE_REQUIRED");
  }
  if (!Number.isInteger(snapshot.fixedRevision) || snapshot.fixedRevision < 0) {
    throw new Error(`SESSION_BACKGROUND_REVISION_INVALID:${snapshot.snapshotId}`);
  }
  assertBackgroundWindow(
    snapshot.dynamicWindowStart,
    snapshot.dynamicWindowEnd,
    `SESSION_BACKGROUND_WINDOW_INVALID:${snapshot.snapshotId}`
  );
  if (!isBackgroundCursor(snapshot.latestStmCursor)) {
    throw new Error(`SESSION_BACKGROUND_CURSOR_INVALID:${snapshot.snapshotId}`);
  }
  assertBackgroundTemporalContext(
    snapshot.referenceTime,
    snapshot.timezone,
    snapshot.locale,
    snapshot.localDate,
    `SESSION_BACKGROUND_TEMPORAL_INVALID:${snapshot.snapshotId}`
  );
  if (
    !["single_request", "hierarchical_batch"].includes(snapshot.executionStrategy) ||
    !["ready", "stale", "degraded"].includes(snapshot.status)
  ) {
    throw new Error(`SESSION_BACKGROUND_STATUS_INVALID:${snapshot.snapshotId}`);
  }
  for (const [value, code] of [
    [snapshot.processedMemoryCount, "PROCESSED_COUNT"],
    [snapshot.pendingStmCount, "PENDING_COUNT"],
    [snapshot.deferredMemoryCount, "DEFERRED_COUNT"],
    [snapshot.watermarkLagSeconds, "WATERMARK_LAG"]
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`SESSION_BACKGROUND_${code}_INVALID:${snapshot.snapshotId}`);
    }
  }
  if (!isIsoTimestamp(snapshot.generatedAt) || !isIsoTimestamp(snapshot.createdAt)) {
    throw new Error(`SESSION_BACKGROUND_TIMESTAMP_INVALID:${snapshot.snapshotId}`);
  }
  if (!snapshot.fixedText.trim() || !snapshot.dynamicText.trim() || !snapshot.serializedPrompt.trim()) {
    throw new Error(`SESSION_BACKGROUND_TEXT_REQUIRED:${snapshot.snapshotId}`);
  }
  assertBackgroundReferences(
    snapshot.sourceMemoryIds,
    [...snapshot.fixedSourceRefIds, ...snapshot.dynamicSourceRefIds],
    snapshot.conflictIds,
    snapshot.citations,
    snapshot.snapshotId
  );
}

function assertBackgroundWindow(windowStart: string, windowEnd: string, code: string) {
  if (!isIsoTimestamp(windowStart) || !isIsoTimestamp(windowEnd) || windowStart > windowEnd) {
    throw new Error(code);
  }
}

function assertBackgroundTemporalContext(
  referenceTime: string,
  timezone: string,
  locale: string,
  localDate: string,
  code: string
) {
  if (!isIsoTimestamp(referenceTime) || !/^\d{4}-\d{2}-\d{2}$/u.test(localDate)) throw new Error(code);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    new Intl.Locale(locale);
  } catch {
    throw new Error(code);
  }
}

function assertBackgroundReferences(
  memoryIds: string[],
  sourceRefIds: string[],
  conflictIds: string[],
  citations: BackgroundDynamicCacheRecord["citations"],
  ownerId: string
) {
  if (
    !memoryIds.every(isNonEmptyString) ||
    !sourceRefIds.every(isNonEmptyString) ||
    !conflictIds.every(isNonEmptyString) ||
    !citations.every((citation) =>
      citation.layer === "stm" &&
      isNonEmptyString(citation.memoryDataId) &&
      isNonEmptyString(citation.sourceRefId)
    )
  ) {
    throw new Error(`BACKGROUND_REFERENCE_INVALID:${ownerId}`);
  }
}

function assertBackgroundRanges(ranges: BackgroundDynamicCacheRecord["deferredRanges"], ownerId: string) {
  for (const range of ranges) {
    if (
      !isBackgroundCursor(range.throughInclusive) ||
      (range.afterExclusive !== undefined && !isBackgroundCursor(range.afterExclusive)) ||
      !Number.isInteger(range.estimatedCount) ||
      range.estimatedCount < 1
    ) {
      throw new Error(`BACKGROUND_DEFERRED_RANGE_INVALID:${ownerId}`);
    }
  }
}

function assertBackgroundMaintenanceCommitScope(input: CommitFixedBackgroundMaintenanceRequest) {
  if (
    input.task.tenantId !== input.document.tenantId ||
    input.task.principalId !== input.document.principalId
  ) {
    throw new Error(`BACKGROUND_MAINTENANCE_COMMIT_OWNER_CONFLICT:${input.task.taskId}`);
  }
}

function assertBackgroundMaintenanceLease(
  current: BackgroundMaintenanceTask | undefined,
  claimedBy: string,
  operationAt: string
) {
  if (
    !current ||
    current.status !== "running" ||
    current.claimedBy !== claimedBy ||
    !current.leaseExpiresAt ||
    current.leaseExpiresAt <= operationAt
  ) {
    throw new Error(`BACKGROUND_MAINTENANCE_LEASE_LOST:${current?.taskId ?? "missing"}`);
  }
}

function assertBackgroundDocument(document: BackgroundContextDocument) {
  if (!document.backgroundId.trim()) throw new Error("BACKGROUND_ID_REQUIRED");
  if (!document.tenantId.trim()) throw new Error(`BACKGROUND_TENANT_REQUIRED:${document.backgroundId}`);
  if (!document.principalId.trim()) throw new Error(`BACKGROUND_PRINCIPAL_REQUIRED:${document.backgroundId}`);
  if (!isPositiveInteger(document.fixedRevision)) {
    throw new Error(`BACKGROUND_REVISION_INVALID:${document.backgroundId}`);
  }
  for (const [field, value] of [
    ["FIXED_TEXT_UPDATED_AT", document.fixedTextUpdatedAt],
    ["DYNAMIC_WINDOW_START", document.dynamicWindowStart],
    ["DYNAMIC_WINDOW_END", document.dynamicWindowEnd],
    ["CREATED_AT", document.createdAt],
    ["UPDATED_AT", document.updatedAt]
  ] as const) {
    if (!isIsoTimestamp(value)) throw new Error(`BACKGROUND_${field}_INVALID:${document.backgroundId}`);
  }
  if (document.dynamicWindowStart > document.dynamicWindowEnd) {
    throw new Error(`BACKGROUND_DYNAMIC_WINDOW_INVALID:${document.backgroundId}`);
  }
  if (document.createdAt > document.updatedAt) {
    throw new Error(`BACKGROUND_UPDATED_AT_BEFORE_CREATED_AT:${document.backgroundId}`);
  }
  if (!isBackgroundCursor(document.fixedWatermark)) {
    throw new Error(`BACKGROUND_FIXED_WATERMARK_INVALID:${document.backgroundId}`);
  }
  if (!isBackgroundCursor(document.latestStmCursor)) {
    throw new Error(`BACKGROUND_LATEST_STM_CURSOR_INVALID:${document.backgroundId}`);
  }
  if (
    !document.dynamicSourceMemoryIds.every(isNonEmptyString) ||
    !document.sourceRefIds.every(isNonEmptyString) ||
    !document.conflictIds.every(isNonEmptyString)
  ) {
    throw new Error(`BACKGROUND_REFERENCE_INVALID:${document.backgroundId}`);
  }
  if (document.updateSuggestion && (
    !document.updateSuggestion.summary.trim() ||
    !isBackgroundSuggestionStatus(document.updateSuggestion.status) ||
    !document.updateSuggestion.targetSections.every(isBackgroundSectionKey)
  )) {
    throw new Error(`BACKGROUND_UPDATE_SUGGESTION_INVALID:${document.backgroundId}`);
  }
}

function compareBackgroundDocumentsNewestFirst(
  left: BackgroundContextDocument,
  right: BackgroundContextDocument
) {
  return right.fixedRevision - left.fixedRevision ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.backgroundId.localeCompare(left.backgroundId);
}

function backgroundCursorJsonOrInitial(value: unknown) {
  return JSON.stringify(backgroundCursorOrInitial(value));
}

function backgroundCursorOrInitial(value: unknown) {
  const parsed = parseJsonValue(value);
  if (isBackgroundCursor(parsed)) {
    return { updatedAt: parsed.updatedAt, memoryDataId: parsed.memoryDataId };
  }
  return { ...INITIAL_BACKGROUND_CURSOR };
}

function isBackgroundCursor(value: unknown): value is BackgroundContextDocument["latestStmCursor"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as { updatedAt?: unknown; memoryDataId?: unknown };
  return typeof cursor.updatedAt === "string" &&
    isIsoTimestamp(cursor.updatedAt) &&
    typeof cursor.memoryDataId === "string";
}

function stringArrayJsonOrEmpty(value: unknown) {
  return JSON.stringify(stringArrayOrEmpty(value));
}

function stringArrayOrEmpty(value: unknown): string[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed.filter(isNonEmptyString) : [];
}

function backgroundSectionArrayJsonOrEmpty(value: unknown) {
  return JSON.stringify(backgroundSectionArrayOrEmpty(value));
}

function backgroundSectionArrayOrEmpty(
  value: unknown
): NonNullable<BackgroundContextDocument["updateSuggestion"]>["targetSections"] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed.filter(isBackgroundSectionKey) : [];
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isBackgroundSectionKey(
  value: unknown
): value is NonNullable<BackgroundContextDocument["updateSuggestion"]>["targetSections"][number] {
  return value === "identity" ||
    value === "relationships" ||
    value === "recentTasks" ||
    value === "aiSoul";
}

function isBackgroundSuggestionStatus(
  value: unknown
): value is NonNullable<BackgroundContextDocument["updateSuggestion"]>["status"] {
  return value === "pending" || value === "applied" || value === "rejected";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function assertShortTermMemoryScope(memory: ShortTermMemory) {
  if (!memory.tenantId.trim()) throw new Error(`STM_TENANT_REQUIRED:${memory.memoryDataId}`);
  if (!memory.principalId.trim()) throw new Error(`STM_PRINCIPAL_REQUIRED:${memory.memoryDataId}`);
  if (!isIsoTimestamp(memory.createdAt)) throw new Error(`STM_CREATED_AT_INVALID:${memory.memoryDataId}`);
  if (!isIsoTimestamp(memory.updatedAt)) throw new Error(`STM_UPDATED_AT_INVALID:${memory.memoryDataId}`);
  if (Date.parse(memory.updatedAt) < Date.parse(memory.createdAt)) {
    throw new Error(`STM_UPDATED_AT_BEFORE_CREATED_AT:${memory.memoryDataId}`);
  }
}

function sameShortTermMemoryState(left: ShortTermMemory, right: ShortTermMemory) {
  const { updatedAt: _leftUpdatedAt, ...leftState } = left;
  const { updatedAt: _rightUpdatedAt, ...rightState } = right;
  return isDeepStrictEqual(leftState, rightState);
}

function compareShortTermMemoryCursor(left: ShortTermMemory, right: ShortTermMemory) {
  const timeOrder = left.updatedAt.localeCompare(right.updatedAt);
  return timeOrder || left.memoryDataId.localeCompare(right.memoryDataId);
}

function backgroundMemoryMatchesStats(memory: ShortTermMemory, query: BackgroundStmWindowStatsQuery) {
  if (memory.tenantId !== query.tenantId || memory.principalId !== query.principalId) return false;
  if (memory.updatedAt >= query.windowEnd) return false;
  const cursorOrder = memory.updatedAt.localeCompare(query.cursor.updatedAt) ||
    memory.memoryDataId.localeCompare(query.cursor.memoryDataId);
  if (cursorOrder <= 0) return false;
  if (!query.throughCursor) return true;
  const throughOrder = memory.updatedAt.localeCompare(query.throughCursor.updatedAt) ||
    memory.memoryDataId.localeCompare(query.throughCursor.memoryDataId);
  return throughOrder <= 0;
}

function nextShortTermMemoryTimestamp(previous: string, requested: string) {
  const previousMs = Date.parse(previous);
  const requestedMs = Date.parse(requested);
  const nextMs = Math.max(Date.now(), requestedMs, previousMs + 1);
  return new Date(nextMs).toISOString();
}

function isIsoTimestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validIsoTimestampOrUndefined(value: string | null | undefined) {
  return typeof value === "string" && isIsoTimestamp(value) ? value : undefined;
}

function latestIsoTimestamp(...values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
}

function normalizeLongTermMemoryRow(row: Record<string, unknown>): LongTermMemory {
  const item = row as Partial<LongTermMemory>;
  const normalizedFactSummary = normalizeFactSummary(item.factSummary);
  const consolidationFactors = typeof item.consolidationFactors === "string" && item.consolidationFactors
    ? JSON.parse(item.consolidationFactors)
    : item.consolidationFactors;
  return {
    memoryId: String(item.memoryId ?? ""),
    ...(item.tenantId ? { tenantId: item.tenantId } : {}),
    ...(item.principalId ? { principalId: item.principalId } : {}),
    ...(item.consolidationKey ? { consolidationKey: item.consolidationKey } : {}),
    version: typeof item.version === "number" ? item.version : 1,
    ...(item.previousVersionId ? { previousVersionId: item.previousVersionId } : {}),
    ...(typeof item.consolidationScore === "number" ? { consolidationScore: item.consolidationScore } : {}),
    ...(consolidationFactors ? { consolidationFactors } : {}),
    ...(item.policyVersion ? { policyVersion: item.policyVersion } : {}),
    ...(item.promptVersion ? { promptVersion: item.promptVersion } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    ...(item.lastMaintainedAt ? { lastMaintainedAt: item.lastMaintainedAt } : {}),
    theoryClass: item.theoryClass ?? "semantic",
    memoryType: item.memoryType ?? "fact",
    content: String(item.content ?? ""),
    ...normalizeMemoryTemporalMetadata(item),
    confidenceLevel: item.confidenceLevel ?? "medium",
    recallWeight: item.recallWeight ?? "medium",
    solidifyReason: String(item.solidifyReason ?? ""),
    sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs as LongTermMemory["sourceRefs"] : [],
    sourceMemoryDataIds: Array.isArray(item.sourceMemoryDataIds) ? item.sourceMemoryDataIds as string[] : [],
    ...(Array.isArray(item.sourceFactIds) ? { sourceFactIds: item.sourceFactIds as string[] } : {}),
    entityIds: Array.isArray(item.entityIds) ? item.entityIds as string[] : [],
    matchedRules: Array.isArray(item.matchedRules) ? item.matchedRules as string[] : [],
    lifecycleStatus: item.lifecycleStatus ?? "active",
    ...(item.summary ? { summary: item.summary } : {}),
    ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {}),
    ...(item.structuredFacts ? { structuredFacts: item.structuredFacts as NonNullable<LongTermMemory["structuredFacts"]> } : {}),
    ...(typeof item.retrievalWeight === "number" ? { retrievalWeight: item.retrievalWeight } : {}),
    ...(typeof item.userRetrievalWeight === "number" ? { userRetrievalWeight: item.userRetrievalWeight } : {}),
    ...(item.accessState ? { accessState: item.accessState } : {})
  };
}

function normalizeGraphMemoryNodeRow(row: Record<string, unknown>): GraphMemoryNode {
  const item = row as Partial<GraphMemoryNode>;
  const normalizedFactSummary = normalizeFactSummary(item.factSummary);
  return {
    graphNodeId: String(item.graphNodeId ?? ""),
    ownerId: String(item.ownerId ?? ""),
    ownerType: item.ownerType ?? "stm",
    content: String(item.content ?? ""),
    ...normalizeMemoryTemporalMetadata(item),
    vector: Array.isArray(item.vector) ? item.vector as number[] : [],
    lifecycleStatus: item.lifecycleStatus ?? "active",
    retrievalWeight: typeof item.retrievalWeight === "number" ? item.retrievalWeight : 0,
    sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs as GraphMemoryNode["sourceRefs"] : [],
    entityIds: Array.isArray(item.entityIds) ? item.entityIds as string[] : [],
    refreshedAt: String(item.refreshedAt ?? new Date(0).toISOString()),
    ...(item.memoryType ? { memoryType: item.memoryType } : {}),
    ...(normalizedFactSummary ? { factSummary: normalizedFactSummary } : {})
  };
}

function normalizeRelationEdgeRow(row: Record<string, unknown>): RelationEdge {
  const item = row as Partial<RelationEdge>;
  return {
    edgeId: String(item.edgeId ?? ""),
    fromId: String(item.fromId ?? ""),
    toId: String(item.toId ?? ""),
    relationType: item.relationType ?? "related_to",
    ...(typeof item.evidence === "string" ? { evidence: item.evidence } : {}),
    ...(typeof item.strength === "number" ? { strength: item.strength } : {}),
    ...(item.confidence === "low" || item.confidence === "medium" || item.confidence === "high"
      ? { confidence: item.confidence }
      : {}),
    ...(item.source === "rule" || item.source === "llm" || item.source === "dreaming" ||
      item.source === "user" || item.source === "system"
      ? { source: item.source }
      : {}),
    ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt } : {})
  };
}

function sqlPlaceholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

const SQLITE_BIND_BATCH_SIZE = 500;

function chunkSqlValues<T>(values: T[], batchSize = SQLITE_BIND_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push(values.slice(index, index + batchSize));
  }
  return batches;
}

function normalizeFactItemRow(row: Record<string, unknown>): FactItem {
  const item = row as Partial<FactItem>;
  const validTimeBasis = item.validTimeBasis ?? (item.validTimeStart
    ? item.timeBasis === "event_relative" || item.timeBasis === "absolute" || item.timeBasis === "source_time"
      ? item.timeBasis
      : "source_time"
    : undefined);
  const validTimeConfidence = item.validTimeConfidence ?? item.timeConfidence ?? "low";
  return {
    factId: String(item.factId ?? ""),
    ...(typeof item.sessionId === "string" && item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(typeof item.factSequence === "number" && Number.isInteger(item.factSequence) && item.factSequence > 0
      ? { factSequence: item.factSequence }
      : {}),
    ...(typeof item.tenantId === "string" && item.tenantId ? { tenantId: item.tenantId } : {}),
    ...(typeof item.principalId === "string" && item.principalId ? { principalId: item.principalId } : {}),
    ...(typeof item.contextScopeId === "string" && item.contextScopeId
      ? { contextScopeId: item.contextScopeId }
      : {}),
    factType: String(item.factType ?? "text"),
    factText: String(item.factText ?? ""),
    timeAnchor: typeof item.timeAnchor === "string" && item.timeAnchor ? item.timeAnchor : null,
    ...(item.sourceClaim ? { sourceClaim: String(item.sourceClaim) } : {}),
    normalizedClaim: String(item.normalizedClaim ?? item.factText ?? ""),
    linkedEventIds: Array.isArray(item.linkedEventIds) ? item.linkedEventIds as string[] : [],
    linkedSegmentIds: Array.isArray(item.linkedSegmentIds) ? item.linkedSegmentIds as string[] : [],
    linkedSourceRefs: Array.isArray(item.linkedSourceRefs) ? item.linkedSourceRefs as FactItem["linkedSourceRefs"] : [],
    entityIds: Array.isArray(item.entityIds) ? item.entityIds as string[] : [],
    confidenceLevel: item.confidenceLevel ?? "medium",
    version: typeof item.version === "number" ? item.version : 1,
    status: item.status ?? "active",
    observedAt: String(item.observedAt ?? new Date(0).toISOString()),
    ...(item.evidenceTime ? { evidenceTime: item.evidenceTime } : {}),
    ...(item.validTime ? { validTime: item.validTime } : {}),
    ...(Array.isArray(item.events) && item.events.length ? { events: item.events } : {}),
    ...(item.evidenceTimeStart ? { evidenceTimeStart: item.evidenceTimeStart } : {}),
    ...(item.evidenceTimeEnd ? { evidenceTimeEnd: item.evidenceTimeEnd } : {}),
    evidenceTimeConfidence: item.evidenceTimeConfidence ?? "low",
    sourceMessageIds: Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds as string[] : [],
    ...(item.validTimeStart ? { validTimeStart: item.validTimeStart } : {}),
    ...(item.validTimeEnd ? { validTimeEnd: item.validTimeEnd } : {}),
    ...(validTimeBasis ? { validTimeBasis } : {}),
    validTimeConfidence,
    timeBasis: item.timeBasis ?? "source_time",
    timeConfidence: item.timeConfidence ?? validTimeConfidence,
    schemaVersion: String(item.schemaVersion ?? "fact-item.v1")
  };
}

function normalizeFactVersionRow(row: Record<string, unknown>): FactVersion {
  const item = row as Partial<FactVersion>;
  return normalizeFactVersion({
    factVersionId: String(item.factVersionId ?? ""),
    factId: String(item.factId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    version: Number(item.version ?? 0),
    ...(typeof item.previousVersionId === "string" ? { previousVersionId: item.previousVersionId } : {}),
    factText: String(item.factText ?? ""),
    normalizedClaim: String(item.normalizedClaim ?? ""),
    factType: String(item.factType ?? ""),
    ...(typeof item.evidenceTimeStart === "string" ? { evidenceTimeStart: item.evidenceTimeStart } : {}),
    ...(typeof item.evidenceTimeEnd === "string" ? { evidenceTimeEnd: item.evidenceTimeEnd } : {}),
    ...(typeof item.validTimeStart === "string" ? { validTimeStart: item.validTimeStart } : {}),
    ...(typeof item.validTimeEnd === "string" ? { validTimeEnd: item.validTimeEnd } : {}),
    confidenceLevel: item.confidenceLevel ?? "low",
    sourceFactIds: Array.isArray(item.sourceFactIds) ? item.sourceFactIds as string[] : [],
    linkedEventIds: Array.isArray(item.linkedEventIds) ? item.linkedEventIds as string[] : [],
    linkedSegmentIds: Array.isArray(item.linkedSegmentIds) ? item.linkedSegmentIds as string[] : [],
    linkedSourceRefs: Array.isArray(item.linkedSourceRefs)
      ? item.linkedSourceRefs as FactVersion["linkedSourceRefs"]
      : [],
    updateReason: String(item.updateReason ?? ""),
    conflictRefs: Array.isArray(item.conflictRefs) ? item.conflictRefs as string[] : [],
    sourceFingerprint: String(item.sourceFingerprint ?? ""),
    createdAt: String(item.createdAt ?? "")
  });
}

function normalizeFactBatchRow(row: Record<string, unknown>): FactBatchCommitted {
  const item = row as Partial<FactBatchCommitted>;
  return normalizeFactBatchCommitted({
    batchId: String(item.batchId ?? ""),
    triggerType: item.triggerType as FactBatchCommitted["triggerType"],
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    ...(typeof item.contextScopeId === "string" ? { contextScopeId: item.contextScopeId } : {}),
    newFactIds: Array.isArray(item.newFactIds) ? item.newFactIds as string[] : [],
    committedAt: String(item.committedAt ?? "")
  });
}

function normalizeTimelineFusionTaskRow(row: Record<string, unknown>): TimelineFusionTask {
  const item = row as Partial<TimelineFusionTask>;
  return normalizeTimelineFusionTask({
    taskId: String(item.taskId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    ...(typeof item.contextScopeId === "string" ? { contextScopeId: item.contextScopeId } : {}),
    batchIds: Array.isArray(item.batchIds) ? item.batchIds as string[] : [],
    newFactIds: Array.isArray(item.newFactIds) ? item.newFactIds as string[] : [],
    status: item.status as TimelineFusionTask["status"],
    scheduledAt: String(item.scheduledAt ?? ""),
    deadlineAt: String(item.deadlineAt ?? ""),
    ...(typeof item.readyAt === "string" ? { readyAt: item.readyAt } : {}),
    ...(Array.isArray(item.executionFingerprints)
      ? { executionFingerprints: item.executionFingerprints as string[] }
      : {}),
    ...(item.completionReason === "no_candidate" || item.completionReason === "no_temporal_window"
      ? { completionReason: item.completionReason }
      : {}),
    ...(typeof item.completedAt === "string" ? { completedAt: item.completedAt } : {}),
    ...(typeof item.error === "string" ? { error: item.error } : {}),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? "")
  });
}

function normalizeTimelineFusionExecutionRow(
  row: Record<string, unknown>
): TimelineFusionExecution {
  const item = row as Record<string, unknown>;
  return normalizeTimelineFusionExecution({
    executionId: String(item.executionId ?? ""),
    fingerprint: String(item.fingerprint ?? ""),
    tenantId: String(item.tenantId ?? ""),
    principalId: String(item.principalId ?? ""),
    ...(typeof item.contextScopeId === "string" ? { contextScopeId: item.contextScopeId } : {}),
    taskIds: Array.isArray(item.taskIds) ? item.taskIds as string[] : [],
    batchIds: Array.isArray(item.batchIds) ? item.batchIds as string[] : [],
    newFactIds: Array.isArray(item.newFactIds) ? item.newFactIds as string[] : [],
    temporalWindow: {
      basis: item.temporalBasis as TimelineFusionExecution["temporalWindow"]["basis"],
      startAt: String(item.temporalStartAt ?? ""),
      endAt: String(item.temporalEndAt ?? "")
    },
    fusionPolicyVersion: String(item.fusionPolicyVersion ?? ""),
    status: item.status as TimelineFusionExecution["status"],
    resultFactIds: Array.isArray(item.resultFactIds) ? item.resultFactIds as string[] : [],
    attempt: Number(item.attempt ?? 0),
    ...(typeof item.leaseOwner === "string" ? { leaseOwner: item.leaseOwner } : {}),
    ...(typeof item.leaseExpiresAt === "string" ? { leaseExpiresAt: item.leaseExpiresAt } : {}),
    ...(item.completionReason === "no_candidate" ? { completionReason: item.completionReason } : {}),
    ...(typeof item.error === "string" ? { error: item.error } : {}),
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    ...(typeof item.completedAt === "string" ? { completedAt: item.completedAt } : {})
  });
}

function timelineFusionExecutionParams(execution: TimelineFusionExecution): unknown[] {
  return [
    execution.fingerprint,
    execution.executionId,
    execution.tenantId,
    execution.principalId,
    execution.contextScopeId ?? null,
    JSON.stringify(execution.taskIds),
    JSON.stringify(execution.batchIds),
    JSON.stringify(execution.newFactIds),
    execution.temporalWindow.basis,
    execution.temporalWindow.startAt,
    execution.temporalWindow.endAt,
    execution.fusionPolicyVersion,
    execution.status,
    JSON.stringify(execution.resultFactIds),
    execution.attempt,
    execution.leaseOwner ?? null,
    execution.leaseExpiresAt ?? null,
    execution.completionReason ?? null,
    execution.error ?? null,
    execution.createdAt,
    execution.updatedAt,
    execution.completedAt ?? null
  ];
}

function timelineFusionExecutionConflict(fingerprint: string) {
  return new TimelineFusionExecutionError(
    "TIMELINE_FUSION_EXECUTION_CONFLICT",
    `Timeline fusion fingerprint ${fingerprint} is already reserved with incompatible canonical input.`
  );
}

function conversationMessageSelectColumns(
  alias: string,
  options: {
    ingestionIdExpression?: string;
    documentIdExpression?: string;
  } = {}
) {
  const column = (name: string) => `${alias}.${name}`;
  return `
    ${column("conversation_message_row_id")} AS conversationMessageRowId,
    ${options.ingestionIdExpression ?? column("first_ingestion_id")} AS ingestionId,
    ${options.documentIdExpression ?? "''"} AS documentId,
    ${column("session_id")} AS sessionId,
    ${column("batch_id")} AS batchId,
    ${column("source_app")} AS sourceApp,
    ${column("tenant_id")} AS tenantId,
    ${column("principal_id")} AS principalId,
    ${column("message_id")} AS messageId,
    ${column("sequence")} AS sequence,
    ${column("role")} AS role,
    ${column("status")} AS status,
    ${column("content_type")} AS contentType,
    ${column("content")} AS content,
    ${column("content_sha256")} AS contentSha256,
    ${column("reply_to_message_id")} AS replyToMessageId,
    ${column("parent_message_id")} AS parentMessageId,
    ${column("branch_id")} AS branchId,
    ${column("tool_call_id")} AS toolCallId,
    ${column("tool_name")} AS toolName,
    ${column("revision")} AS revision,
    ${column("operation")} AS operation,
    ${column("metadata")} AS metadata,
    ${column("created_at")} AS createdAt,
    ${column("completed_at")} AS completedAt,
    ${column("timezone")} AS timezone,
    ${column("locale")} AS locale,
    ${column("time_confidence")} AS timeConfidence,
    ${column("stored_at")} AS storedAt
  `;
}

function normalizeConversationMessageRow(row: Record<string, unknown>): ConversationMessageRecord {
  const normalized = normalizeRow(row) as Record<string, unknown>;
  const storedAt = String(normalized.storedAt ?? "");
  return {
    conversationMessageRowId: String(normalized.conversationMessageRowId ?? ""),
    ingestionId: String(normalized.ingestionId ?? ""),
    documentId: String(normalized.documentId ?? ""),
    sessionId: String(normalized.sessionId ?? ""),
    batchId: String(normalized.batchId ?? ""),
    sourceApp: String(normalized.sourceApp ?? ""),
    tenantId: String(normalized.tenantId ?? ""),
    principalId: String(normalized.principalId ?? ""),
    messageId: String(normalized.messageId ?? ""),
    sequence: Number(normalized.sequence ?? 0),
    role: String(normalized.role ?? "user") as ConversationMessageRecord["role"],
    status: String(normalized.status ?? "completed") as ConversationMessageRecord["status"],
    contentType: String(normalized.contentType ?? "text/markdown") as ConversationMessageRecord["contentType"],
    content: String(normalized.content ?? ""),
    contentSha256: String(normalized.contentSha256 ?? ""),
    ...(normalized.replyToMessageId ? { replyToMessageId: String(normalized.replyToMessageId) } : {}),
    ...(normalized.parentMessageId ? { parentMessageId: String(normalized.parentMessageId) } : {}),
    branchId: String(normalized.branchId ?? "main"),
    ...(normalized.toolCallId ? { toolCallId: String(normalized.toolCallId) } : {}),
    ...(normalized.toolName ? { toolName: String(normalized.toolName) } : {}),
    revision: Number(normalized.revision ?? 1),
    operation: String(normalized.operation ?? "append") as ConversationMessageRecord["operation"],
    ...(normalized.metadata && typeof normalized.metadata === "object"
      ? { metadata: normalized.metadata as Record<string, unknown> }
      : {}),
    createdAt: String(normalized.createdAt ?? ""),
    ...(normalized.completedAt ? { completedAt: String(normalized.completedAt) } : {}),
    ...(normalized.timezone ? { timezone: String(normalized.timezone) } : {}),
    ...(normalized.locale ? { locale: String(normalized.locale) } : {}),
    timeConfidence: normalized.timeConfidence === "high" ? "high" : "low",
    storedAt,
    createdAtStored: storedAt
  };
}

function normalizeConversationIngestionRow(row: Record<string, unknown>): ConversationIngestionRecord {
  const normalized = normalizeRow(row) as Record<string, unknown>;
  return {
    ingestionId: String(normalized.ingestion_id ?? ""),
    ...(normalized.batch_ingestion_id ? { batchIngestionId: String(normalized.batch_ingestion_id) } : {}),
    idempotencyKey: String(normalized.idempotency_key ?? ""),
    documentSha256: String(normalized.document_sha256 ?? ""),
    batchId: String(normalized.batch_id ?? ""),
    sessionId: String(normalized.session_id ?? ""),
    sourceApp: String(normalized.source_app ?? ""),
    tenantId: String(normalized.tenant_id ?? ""),
    principalId: String(normalized.principal_id ?? ""),
    visibility: String(normalized.visibility ?? "private") as ConversationIngestionRecord["visibility"],
    ...(normalized.timezone ? { timezone: String(normalized.timezone) } : {}),
    ...(normalized.locale ? { locale: String(normalized.locale) } : {}),
    temporalMode: normalized.temporal_mode === "extended" ? "extended" : "legacy",
    ...(normalized.previous_cursor ? { previousCursor: String(normalized.previous_cursor) } : {}),
    committedCursor: String(normalized.committed_cursor ?? ""),
    firstSequence: Number(normalized.first_sequence ?? 0),
    lastSequence: Number(normalized.last_sequence ?? 0),
    documentStatus: String(normalized.document_status ?? "received") as ConversationIngestionRecord["documentStatus"],
    processingStatus: String(normalized.processing_status ?? "not_scheduled") as ConversationIngestionRecord["processingStatus"],
    processingStage: String(normalized.processing_stage ?? "not_started") as ConversationIngestionRecord["processingStage"],
    processingMode: String(normalized.processing_mode ?? "async") as ConversationIngestionRecord["processingMode"],
    progressPercent: Number(normalized.progress_percent ?? 0),
    messageCounts: normalized.message_counts as ConversationIngestionRecord["messageCounts"],
    layerCounts: normalizeConversationLayerCounts(normalized.layer_counts),
    retry: normalized.retry_state as ConversationIngestionRecord["retry"],
    ...(normalized.last_error
      ? { lastError: normalized.last_error as NonNullable<ConversationIngestionRecord["lastError"]> }
      : {}),
    createdAt: String(normalized.created_at ?? ""),
    committedAt: String(normalized.committed_at ?? ""),
    updatedAt: String(normalized.updated_at ?? "")
  };
}

function normalizeConversationBatchIngestionRow(
  row: Record<string, unknown>
): ConversationBatchIngestionRecord {
  const normalized = normalizeRow(row) as Record<string, unknown>;
  return {
    batchIngestionId: String(normalized.batch_ingestion_id ?? ""),
    idempotencyKey: String(normalized.idempotency_key ?? ""),
    documentSha256: String(normalized.document_sha256 ?? ""),
    batchId: String(normalized.batch_id ?? ""),
    sourceApp: String(normalized.source_app ?? ""),
    tenantId: String(normalized.tenant_id ?? ""),
    principalId: String(normalized.principal_id ?? ""),
    documentStatus: "raw_committed",
    processingStatus: "queued",
    createdAt: String(normalized.created_at ?? ""),
    committedAt: String(normalized.committed_at ?? ""),
    updatedAt: String(normalized.updated_at ?? "")
  };
}

function normalizeConversationLayerCounts(value: unknown): ConversationIngestionRecord["layerCounts"] {
  const counts = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    messages: Number(counts.messages ?? 0),
    segments: Number(counts.segments ?? 0),
    evidenceGroups: Number(counts.evidenceGroups ?? 0),
    factCandidates: Number(counts.factCandidates ?? 0),
    facts: Number(counts.facts ?? 0),
    shortTermMemories: Number(counts.shortTermMemories ?? 0),
    timelineFacts: Number(counts.timelineFacts ?? 0),
    longTermMemories: Number(counts.longTermMemories ?? 0),
    factPending: Number(counts.factPending ?? 0),
    rejected: Number(counts.rejected ?? 0),
    sensitivePendingConfirmation: Number(counts.sensitivePendingConfirmation ?? 0)
  };
}

function normalizeConversationIngestionJobRow(row: Record<string, unknown>): ConversationIngestionJobRecord {
  const normalized = normalizeRow(row) as Record<string, unknown>;
  return {
    jobId: String(normalized.job_id ?? ""),
    ingestionId: String(normalized.ingestion_id ?? ""),
    status: String(normalized.status ?? "queued") as ConversationIngestionJobRecord["status"],
    stage: String(normalized.stage ?? "not_started") as ConversationIngestionJobRecord["stage"],
    attempt: Number(normalized.attempt ?? 0),
    maxAttempts: Number(normalized.max_attempts ?? 3),
    retryable: Boolean(normalized.retryable),
    ...(normalized.retry_after ? { retryAfter: String(normalized.retry_after) } : {}),
    ...(normalized.claimed_by ? { claimedBy: String(normalized.claimed_by) } : {}),
    ...(normalized.claimed_at ? { claimedAt: String(normalized.claimed_at) } : {}),
    ...(normalized.heartbeat_at ? { heartbeatAt: String(normalized.heartbeat_at) } : {}),
    ...(normalized.last_error && typeof normalized.last_error === "object"
      ? { lastError: normalized.last_error as NonNullable<ConversationIngestionJobRecord["lastError"]> }
      : {}),
    ...(normalized.completed_at ? { completedAt: String(normalized.completed_at) } : {}),
    createdAt: String(normalized.created_at ?? ""),
    updatedAt: String(normalized.updated_at ?? "")
  };
}

function normalizeTemporalBackfillMigrationRow(
  row: Record<string, unknown>
): ConversationTemporalBackfillMigrationRecord {
  const normalized = normalizeRow(row) as Record<string, unknown>;
  const counts = parseJsonValue(normalized.countsJson) as ConversationTemporalBackfillMigrationRecord["counts"];
  const errors = parseJsonValue(normalized.errorsJson) as ConversationTemporalBackfillMigrationRecord["errors"];
  return {
    version: String(normalized.version ?? ""),
    status: String(normalized.status ?? "failed") as ConversationTemporalBackfillMigrationRecord["status"],
    attempt: Number(normalized.attempt ?? 0),
    counts,
    errors,
    startedAt: String(normalized.startedAt ?? ""),
    ...(normalized.completedAt ? { completedAt: String(normalized.completedAt) } : {}),
    updatedAt: String(normalized.updatedAt ?? ""),
    ...(normalized.durationMs === null || normalized.durationMs === undefined
      ? {}
      : { durationMs: Number(normalized.durationMs) })
  };
}

function sameConversationScope(
  left: { tenantId: string; sourceApp: string; principalId: string; sessionId: string },
  right: { tenantId: string; sourceApp: string; principalId: string; sessionId: string }
) {
  return left.tenantId === right.tenantId &&
    left.sourceApp === right.sourceApp &&
    left.principalId === right.principalId &&
    left.sessionId === right.sessionId;
}

function sameConversationMessageIdentity(left: ConversationMessageRecord, right: ConversationMessageRecord) {
  return sameConversationScope(left, right) &&
    left.messageId === right.messageId &&
    left.revision === right.revision;
}

interface ResolvedConversationMessage {
  incoming: ConversationMessageRecord;
  stored?: ConversationMessageRecord;
}

function resolveConversationMessages(
  storedMessages: readonly ConversationMessageRecord[],
  incomingMessages: readonly ConversationMessageRecord[]
): ResolvedConversationMessage[] {
  const working = [...storedMessages];
  return incomingMessages.map((message) => {
    const matching = working.find((item) => sameConversationMessageIdentity(item, message));
    if (matching) assertConversationMessageCompatible(matching, message);
    const sequenceOwner = working.find((item) =>
      sameConversationScope(item, message) &&
      item.sequence === message.sequence &&
      item.branchId === message.branchId &&
      item.revision === message.revision
    );
    if (sequenceOwner && sequenceOwner.messageId !== message.messageId) {
      throw new ConversationRepositoryError(
        "MESSAGE_CONTENT_CONFLICT",
        `Sequence ${message.sequence} is already assigned to message ${sequenceOwner.messageId}.`,
        {
          reason: "sequence_conflict",
          sequence: message.sequence,
          branchId: message.branchId,
          revision: message.revision,
          existingMessageId: sequenceOwner.messageId,
          incomingMessageId: message.messageId
        }
      );
    }
    const rowOwner = working.find((item) =>
      item.conversationMessageRowId === message.conversationMessageRowId
    );
    if (rowOwner && !sameConversationMessageIdentity(rowOwner, message)) {
      throw new ConversationRepositoryError(
        "MESSAGE_CONTENT_CONFLICT",
        `Message row ${message.conversationMessageRowId} is already assigned to another message identity.`,
        { reason: "row_id_conflict", conversationMessageRowId: message.conversationMessageRowId }
      );
    }
    if (!matching) working.push(message);
    return matching ? { incoming: message, stored: matching } : { incoming: message };
  });
}

function assertConversationMessageCompatible(
  stored: ConversationMessageRecord,
  incoming: ConversationMessageRecord
) {
  const immutableFields: Array<keyof ConversationMessageRecord> = [
    "conversationMessageRowId",
    "sequence",
    "role",
    "status",
    "contentType",
    "content",
    "contentSha256",
    "branchId",
    "operation",
    "createdAt",
    "completedAt",
    "timezone",
    "locale",
    "timeConfidence"
  ];
  const conflictingField = immutableFields.find((field) =>
    !isDeepStrictEqual(stored[field], incoming[field])
  );
  if (!conflictingField) return;
  throw new ConversationRepositoryError(
    "MESSAGE_CONTENT_CONFLICT",
    `Message ${incoming.messageId} revision ${incoming.revision} conflicts on ${String(conflictingField)}.`,
    {
      reason: conflictingField === "sequence" ? "sequence_conflict" : "message_identity_conflict",
      messageId: incoming.messageId,
      revision: incoming.revision,
      field: String(conflictingField)
    }
  );
}

function conversationMessageCounts(
  messages: readonly ConversationMessageRecord[],
  resolved: readonly ResolvedConversationMessage[]
): ConversationIngestionRecord["messageCounts"] {
  const inserted = resolved.filter((item) => !item.stored).length;
  return {
    received: messages.length,
    inserted,
    deduplicated: messages.length - inserted,
    revised: resolved.filter((item) => !item.stored && item.incoming.revision > 1).length,
    deleted: resolved.filter((item) => !item.stored && item.incoming.operation === "delete").length
  };
}

function withCommittedConversationMessageCounts(
  ingestion: ConversationIngestionRecord,
  messageCounts: ConversationIngestionRecord["messageCounts"]
): ConversationIngestionRecord {
  return {
    ...ingestion,
    messageCounts,
    layerCounts: {
      ...ingestion.layerCounts,
      messages: messageCounts.received
    }
  };
}

function assertConversationCursorMatches(
  current: ConversationSessionCursorRecord | undefined,
  request: CommitConversationIngestionRequest
) {
  const previousCursor = request.ingestion.previousCursor;
  if (previousCursor !== current?.committedCursor) {
    throw new ConversationRepositoryError(
      "CURSOR_MISMATCH",
      "The document previous_cursor does not match the committed server cursor.",
      { serverCursor: current?.committedCursor ?? null }
    );
  }
  const onlyRevisionsOrDeletes = request.messages.every((message) => message.operation !== "append");
  if (current && !onlyRevisionsOrDeletes && request.ingestion.firstSequence !== current.lastSequence + 1) {
    throw new ConversationRepositoryError(
      "SEQUENCE_GAP",
      "New append messages must start at exactly the next committed sequence.",
      { lastSequence: current.lastSequence, expectedFirstSequence: current.lastSequence + 1 }
    );
  }
}

function legacyConversationPersistenceRemoved() {
  return new ConversationRepositoryError(
    "CONTEXT_ENGINE_UNAVAILABLE",
    "Legacy per-message conversation persistence is not available in the current document ingestion version."
  );
}

function assertConversationCursorValueMatches(
  current: ConversationSessionCursorRecord | undefined,
  ingestion: ConversationIngestionRecord
) {
  if (ingestion.previousCursor === current?.committedCursor) return;
  throw new ConversationRepositoryError(
    "CURSOR_MISMATCH",
    "The submitted previous cursor does not match the committed cursor.",
    {
      sessionId: ingestion.sessionId,
      currentCursor: current?.committedCursor ?? null
    }
  );
}

function replaceConversationCursor(
  cursors: ConversationSessionCursorRecord[],
  cursor: ConversationSessionCursorRecord
) {
  const index = cursors.findIndex((item) => sameConversationScope(item, cursor));
  if (index < 0) {
    cursors.push(cursor);
  } else {
    const current = cursors[index] as ConversationSessionCursorRecord;
    cursors[index] = {
      ...cursor,
      lastSequence: Math.max(current.lastSequence, cursor.lastSequence)
    };
  }
}

function buildMemoryReuseSignals(
  events: readonly MemoryRetrievalEvent[],
  ownerIds: string[] | undefined,
  now: string
) {
  const nowMs = Date.parse(now);
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const allowedOwnerIds = ownerIds?.length ? new Set(ownerIds) : undefined;
  const recentEvents = events.filter((event) => {
    if (allowedOwnerIds && !allowedOwnerIds.has(event.ownerId)) return false;
    const createdAtMs = Date.parse(event.createdAt);
    return Number.isFinite(createdAtMs) && effectiveNowMs - createdAtMs <= 30 * 86_400_000;
  });
  const grouped = groupBy(recentEvents, (event) => `${event.ownerType}:${event.ownerId}`);

  return [...grouped.values()].map((ownerEvents) => {
    const first = ownerEvents[0] as MemoryRetrievalEvent;
    const within7d = ownerEvents.filter((event) => effectiveNowMs - Date.parse(event.createdAt) <= 7 * 86_400_000);
    const retrievalEvents = ownerEvents.filter((event) => event.eventType !== "user_feedback");
    const feedbackEvents = ownerEvents.filter((event) => event.eventType === "user_feedback");
    const decayedEventValue = ownerEvents.reduce((total, event) => {
      const ageDays = Math.max(0, (effectiveNowMs - Date.parse(event.createdAt)) / 86_400_000);
      const decay = Math.exp(-ageDays / 14);
      const weight = event.eventType === "search_hit"
        ? 0.55
        : event.eventType === "context_pack_selected"
          ? 1.25
          : event.eventType === "agent_cited"
            ? 1.75
            : feedbackWeight(event.feedbackAction);
      return total + weight * decay;
    }, 0);
    const sessions7d = uniqueNonEmpty(within7d.map((event) => event.sessionId));
    const sessions30d = uniqueNonEmpty(ownerEvents.map((event) => event.sessionId));
    const tasks30d = uniqueNonEmpty(ownerEvents.map((event) => event.taskId));
    const reuseValue = clampReuseValue(
      decayedEventValue + Math.min(2, sessions30d.size * 0.35) + Math.min(2, tasks30d.size * 0.5)
    );
    const lastRetrievedAt = retrievalEvents
      .map((event) => event.createdAt)
      .sort((left, right) => right.localeCompare(left))[0];
    return {
      ownerType: first.ownerType,
      ownerId: first.ownerId,
      ...(lastRetrievedAt ? { lastRetrievedAt } : {}),
      uniqueSessionCount7d: sessions7d.size,
      uniqueSessionCount30d: sessions30d.size,
      uniqueTaskCount30d: tasks30d.size,
      searchHitCount30d: ownerEvents.filter((event) => event.eventType === "search_hit").length,
      contextPackCount30d: ownerEvents.filter((event) => event.eventType === "context_pack_selected").length,
      agentCitationCount30d: ownerEvents.filter((event) => event.eventType === "agent_cited").length,
      positiveFeedbackCount30d: feedbackEvents.filter((event) => event.feedbackAction === "like" || event.feedbackAction === "confirm").length,
      negativeFeedbackCount30d: feedbackEvents.filter((event) => event.feedbackAction === "dislike" || event.feedbackAction === "ignore" || event.feedbackAction === "delete").length,
      correctionCount30d: feedbackEvents.filter((event) => event.feedbackAction === "correct").length,
      reuseValue
    };
  }).sort((left, right) => left.ownerType.localeCompare(right.ownerType) || left.ownerId.localeCompare(right.ownerId));
}

function feedbackWeight(action: MemoryRetrievalEvent["feedbackAction"]) {
  if (action === "like" || action === "confirm") return 1.5;
  if (action === "correct") return -1;
  if (action === "dislike" || action === "ignore" || action === "delete") return -1.5;
  return 0;
}

function uniqueNonEmpty(values: Array<string | undefined>) {
  return new Set(values.filter((value): value is string => Boolean(value?.trim())));
}

function clampReuseValue(value: number) {
  return Number(Math.max(0, Math.min(10, value)).toFixed(2));
}
