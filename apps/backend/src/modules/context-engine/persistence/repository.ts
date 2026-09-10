import type {
  ContextPackTrace,
  ContextIndexEntry,
  ContextTextIndexEntry,
  ContextVectorIndexEntry,
  ContextPipelineTask,
  FactBatchCommitted,
  FactItem,
  FactVersion,
  GraphMemoryNode,
  GraphMemorySearchHit,
  GraphMemorySearchOptions,
  GraphMemoryOwnerType,
  LlmDreamingTrace,
  LlmFactFusionTrace,
  LlmStmAdmissionTrace,
  LongTermMemory,
  MemoryChangeEvent,
  MemoryEvent,
  ParsedSegment,
  RelationEdge,
  BackgroundMaintenanceBatch,
  BackgroundMaintenanceTask,
  BackgroundDynamicCacheRecord,
  BackgroundContextDocument,
  BackgroundStmCursor,
  SessionBackgroundSnapshot,
  MemoryFeedbackItem,
  ShortTermMemory,
  TimelineFusionExecution,
  TimelineFusionTask,
  DreamingCandidateDecision,
  DreamingOutboxRecord,
  DreamingRun,
  DreamingRunCandidate,
  MemoryRetrievalEvent
} from "../domain.js";
import type {
  GraphMemoryNodePage,
  GraphMemoryNodePageQuery,
  GraphRelationEdgePage,
  GraphRelationEdgePageQuery,
  GraphRelationSearchQuery,
  MaybePromise
} from "./graph-store.js";
import type {
  ConversationBatchIngestionRecord,
  ConversationDocumentRecord,
  ConversationEvidenceGroupRecord,
  ConversationExtractionWindowRecord,
  ConversationFactCandidateRecord,
  ConversationIngestionJobRecord,
  ConversationIngestionRecord,
  ConversationIngestionRepository,
  ConversationMessageRecord,
  ConversationMessageSegmentRecord,
  ConversationSessionCursorRecord,
  ConversationTemporalBackfillMigrationRecord
} from "../conversation-ingestion/persistence.js";
import type { EvidenceSearchCandidate, EvidenceSearchQuery } from "../evidence-retrieval.js";
import type { TimelineFusionCandidateQuery } from "../timeline-fusion-window.js";

export interface ContextDebugSnapshot {
  memoryEvents: MemoryEvent[];
  parsedSegments: ParsedSegment[];
  facts: FactItem[];
  factVersions?: FactVersion[];
  factBatches?: FactBatchCommitted[];
  timelineFusionTasks?: TimelineFusionTask[];
  timelineFusionExecutions?: TimelineFusionExecution[];
  shortTermMemories: ShortTermMemory[];
  longTermMemories: LongTermMemory[];
  graphMemoryNodes: GraphMemoryNode[];
  relationEdges: RelationEdge[];
  packTraces: ContextPackTrace[];
  llmFactFusionTraces: LlmFactFusionTrace[];
  llmStmAdmissionTraces: LlmStmAdmissionTrace[];
  llmDreamingTraces: LlmDreamingTrace[];
  pipelineTasks: ContextPipelineTask[];
  indexEntries: ContextIndexEntry[];
  textIndexEntries: ContextTextIndexEntry[];
  vectorIndexEntries: ContextVectorIndexEntry[];
  changeEvents: MemoryChangeEvent[];
  feedbackItems: MemoryFeedbackItem[];
  retrievalEvents: MemoryRetrievalEvent[];
  dreamingCandidateDecisions: DreamingCandidateDecision[];
  dreamingOutbox: DreamingOutboxRecord[];
  dreamingRuns: DreamingRun[];
  dreamingRunCandidates: DreamingRunCandidate[];
  backgroundDocuments: BackgroundContextDocument[];
  backgroundMaintenanceTasks: BackgroundMaintenanceTask[];
  backgroundMaintenanceBatches: BackgroundMaintenanceBatch[];
  backgroundDynamicCaches: BackgroundDynamicCacheRecord[];
  sessionBackgroundSnapshots: SessionBackgroundSnapshot[];
  conversationBatchIngestions: ConversationBatchIngestionRecord[];
  conversationIngestions: ConversationIngestionRecord[];
  conversationDocuments: ConversationDocumentRecord[];
  conversationMessages: ConversationMessageRecord[];
  conversationSessionCursors: ConversationSessionCursorRecord[];
  conversationIngestionJobs: ConversationIngestionJobRecord[];
  conversationMessageSegments: ConversationMessageSegmentRecord[];
  conversationEvidenceGroups: ConversationEvidenceGroupRecord[];
  conversationExtractionWindows: ConversationExtractionWindowRecord[];
  conversationFactCandidates: ConversationFactCandidateRecord[];
  conversationDocumentMessageRows: Array<{
    documentId: string;
    ingestionId: string;
    conversationMessageRowId: string;
    messageOrder: number;
  }>;
  conversationTemporalBackfillMigrations: ConversationTemporalBackfillMigrationRecord[];
}

export interface MemoryReuseSignal {
  ownerType: "fact" | "stm" | "ltm";
  ownerId: string;
  lastRetrievedAt?: string;
  uniqueSessionCount7d: number;
  uniqueSessionCount30d: number;
  uniqueTaskCount30d: number;
  searchHitCount30d: number;
  contextPackCount30d: number;
  agentCitationCount30d: number;
  positiveFeedbackCount30d: number;
  negativeFeedbackCount30d: number;
  correctionCount30d: number;
  reuseValue: number;
}

export interface CommitFixedBackgroundMaintenanceRequest {
  task: BackgroundMaintenanceTask;
  document: BackgroundContextDocument;
  expectedFixedRevision: number;
  claimedBy: string;
}

export interface CommitBackgroundMaintenanceCheckpointRequest {
  task: BackgroundMaintenanceTask;
  batch: BackgroundMaintenanceBatch;
  claimedBy: string;
}

export interface TextIndexSearchHit {
  ownerType: "fact" | "stm" | "ltm";
  ownerId: string;
  score: number;
  matchedTerms: number;
}

export interface FactIndexSearchQuery {
  tenantId?: string;
  principalId?: string;
  includeInactive?: boolean;
  limit?: number;
}

export interface FactIndexSearchHit {
  factId: string;
  score: number;
}

export type { BackgroundStmCursor } from "../domain.js";

export interface BackgroundStmPageQuery {
  tenantId: string;
  principalId: string;
  windowStart: string;
  windowEnd: string;
  cursor?: BackgroundStmCursor;
  limit: number;
}

export interface BackgroundStmPage {
  memories: ShortTermMemory[];
  nextCursor?: BackgroundStmCursor;
  hasMore: boolean;
}

export interface BackgroundStmWindowStatsQuery {
  tenantId: string;
  principalId: string;
  cursor: BackgroundStmCursor;
  windowEnd: string;
  throughCursor?: BackgroundStmCursor;
  countLimit: number;
}

export interface BackgroundStmWindowStats {
  latestCursor?: BackgroundStmCursor;
  pendingCount: number;
  countCapped: boolean;
}

export interface MemoryOwnerBySourceHit {
  ownerType: "stm" | "ltm";
  ownerId: string;
  score: number;
}

export interface ContextDeleteResult {
  eventId: string;
  deleted: {
    memoryEvents: number;
    parsedSegments: number;
    facts: number;
    shortTermMemories: number;
    longTermMemories: number;
    relationEdges: number;
    packTraces: number;
    llmFactFusionTraces: number;
    llmStmAdmissionTraces: number;
    llmDreamingTraces: number;
    pipelineTasks: number;
    indexEntries: number;
  };
}

export interface ContextClearResult {
  deleted: {
    memoryEvents: number;
    parsedSegments: number;
    facts: number;
    shortTermMemories: number;
    longTermMemories: number;
    relationEdges: number;
    packTraces: number;
    llmFactFusionTraces: number;
    llmStmAdmissionTraces: number;
    llmDreamingTraces: number;
    pipelineTasks: number;
    indexEntries: number;
    changeEvents: number;
  };
}

export interface ContextEngineRepository extends ConversationIngestionRepository {
  hasMemoryEvent(eventId: string): Promise<boolean>;
  saveMemoryEvent(event: MemoryEvent): Promise<void>;
  saveParsedSegment(segment: ParsedSegment): Promise<void>;
  saveFactItem(fact: FactItem): Promise<void>;
  saveFactBatchCommitted(batch: FactBatchCommitted): Promise<FactBatchCommitted>;
  getFactBatchCommitted(batchId: string): MaybePromise<FactBatchCommitted | undefined>;
  saveTimelineFusionTask(task: TimelineFusionTask): Promise<void>;
  getTimelineFusionTask(taskId: string): MaybePromise<TimelineFusionTask | undefined>;
  listTimelineFusionTasks(query?: {
    tenantId?: string;
    principalId?: string;
    contextScopeId?: string;
    statuses?: TimelineFusionTask["status"][];
  }): MaybePromise<TimelineFusionTask[]>;
  reserveTimelineFusionExecution(execution: TimelineFusionExecution): Promise<TimelineFusionExecution>;
  saveTimelineFusionExecution(execution: TimelineFusionExecution): Promise<void>;
  getTimelineFusionExecutionByFingerprint(
    fingerprint: string
  ): MaybePromise<TimelineFusionExecution | undefined>;
  findFactCandidatesForFusion(query: TimelineFusionCandidateQuery): MaybePromise<FactItem[]>;
  findTimelineFusionFactCandidates(query: TimelineFusionCandidateQuery): MaybePromise<FactItem[]>;
  saveFactVersion(version: FactVersion): Promise<FactVersion>;
  getFactVersions(query: {
    tenantId: string;
    principalId: string;
    factId?: string;
    sourceFingerprint?: string;
  }): MaybePromise<FactVersion[]>;
  getFactVersionsByFactIds(query: {
    tenantId: string;
    principalId: string;
    factIds: string[];
  }): MaybePromise<FactVersion[]>;
  commitTimelineFusionFactStore(input: {
    execution: TimelineFusionExecution;
    facts: FactItem[];
    versions: FactVersion[];
    resultFactIds: string[];
    completedAt: string;
  }): Promise<{
    execution: TimelineFusionExecution;
    facts: FactItem[];
    versions: FactVersion[];
  }>;
  saveShortTermMemory(memory: ShortTermMemory): Promise<void>;
  saveLongTermMemory(memory: LongTermMemory): Promise<void>;
  replaceShortTermMemory(memory: ShortTermMemory): Promise<void>;
  replaceLongTermMemory(memory: LongTermMemory): Promise<void>;
  saveRelationEdge(edge: RelationEdge): Promise<void>;
  saveContextPackTrace(trace: ContextPackTrace): Promise<void>;
  saveLlmFactFusionTrace(trace: LlmFactFusionTrace): Promise<void>;
  saveLlmStmAdmissionTrace(trace: LlmStmAdmissionTrace): Promise<void>;
  saveLlmDreamingTrace(trace: LlmDreamingTrace): Promise<void>;
  savePipelineTask(task: ContextPipelineTask): Promise<void>;
  getPipelineTaskByEventId(eventId: string): MaybePromise<ContextPipelineTask | undefined>;
  saveDreamingCandidateDecision(decision: DreamingCandidateDecision): Promise<void>;
  saveDreamingRun(run: DreamingRun): Promise<void>;
  getDreamingRun(runId: string): MaybePromise<DreamingRun | undefined>;
  listDreamingRuns(query?: {
    tenantId?: string;
    principalId?: string;
    statuses?: DreamingRun["status"][];
  }): MaybePromise<DreamingRun[]>;
  claimNextDreamingRun(input: {
    tenantId: string;
    principalId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): MaybePromise<DreamingRun | undefined>;
  saveDreamingRunCandidate(candidate: DreamingRunCandidate): Promise<void>;
  getDreamingRunCandidate(runCandidateId: string): MaybePromise<DreamingRunCandidate | undefined>;
  listDreamingRunCandidates(runId: string): MaybePromise<DreamingRunCandidate[]>;
  claimNextDreamingRunCandidate(input: {
    runId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): MaybePromise<DreamingRunCandidate | undefined>;
  deleteShortTermMemory(memoryDataId: string): Promise<void>;
  deleteShortTermMemoryArtifacts(memoryDataId: string): Promise<void>;
  listDueDreamingShortTermMemories(query: {
    tenantId: string;
    principalId: string;
    cutoffAt: string;
    policyVersion: string;
  }): MaybePromise<ShortTermMemory[]>;
  listDreamingShortTermMemoriesInWindow(query: {
    tenantId: string;
    principalId: string;
    windowStart: string;
    cutoffAt: string;
    policyVersion: string;
  }): MaybePromise<ShortTermMemory[]>;
  withDreamingTransaction<T>(callback: () => Promise<T>): Promise<T>;
  saveDreamingOutbox(record: DreamingOutboxRecord): Promise<void>;
  listPendingDreamingOutbox(now?: string): DreamingOutboxRecord[];
  markDreamingOutbox(record: DreamingOutboxRecord): Promise<void>;
  saveIndexEntry(entry: ContextIndexEntry): Promise<void>;
  saveTextIndexEntry(entry: ContextTextIndexEntry): Promise<void>;
  saveVectorIndexEntry(entry: ContextVectorIndexEntry): Promise<void>;
  searchTextIndex(queryTokens: string[]): TextIndexSearchHit[];
  searchFactText(queryTokens: string[], query?: FactIndexSearchQuery): MaybePromise<FactIndexSearchHit[]>;
  searchFactVector(queryVector: number[], query?: FactIndexSearchQuery): MaybePromise<FactIndexSearchHit[]>;
  listKeywordCorpusContents(): MaybePromise<string[]>;
  selectShortTermMemoriesForBackground(query: BackgroundStmPageQuery): MaybePromise<BackgroundStmPage>;
  getBackgroundStmWindowStats(query: BackgroundStmWindowStatsQuery): MaybePromise<BackgroundStmWindowStats>;
  getShortTermMemory(memoryDataId: string): MaybePromise<ShortTermMemory | undefined>;
  getShortTermMemoriesByIds(memoryDataIds: string[]): MaybePromise<ShortTermMemory[]>;
  getLongTermMemory(memoryId: string): MaybePromise<LongTermMemory | undefined>;
  getParsedSegmentsByIds(segmentIds: string[]): MaybePromise<ParsedSegment[]>;
  getMemoryEventsByIds(eventIds: string[]): MaybePromise<MemoryEvent[]>;
  findEvidenceCandidates(query: EvidenceSearchQuery): MaybePromise<EvidenceSearchCandidate[]>;
  getGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string): MaybePromise<GraphMemoryNode | undefined>;
  getIndexEntryByOwnerId(ownerId: string): MaybePromise<ContextIndexEntry | undefined>;
  findMemoryOwnersBySourceIds(sourceIds: string[], ownerTypes?: GraphMemoryOwnerType[]): MaybePromise<MemoryOwnerBySourceHit[]>;
  findMemoryOwnersByContextScopeId(contextScopeId: string, ownerTypes?: GraphMemoryOwnerType[]): MaybePromise<MemoryOwnerBySourceHit[]>;
  getFactItemsByIds(factIds: string[]): MaybePromise<FactItem[]>;
  findFactItemsByEventIds(eventIds: string[]): MaybePromise<FactItem[]>;
  upsertGraphMemoryNode(node: GraphMemoryNode): MaybePromise<void>;
  deleteGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string): MaybePromise<void>;
  searchGraphText(queryTokens: string[], options?: GraphMemorySearchOptions): MaybePromise<GraphMemorySearchHit[]>;
  searchGraphVector(queryVector: number[], options?: GraphMemorySearchOptions): MaybePromise<GraphMemorySearchHit[]>;
  getGraphRelationEdges(ownerId: string): MaybePromise<RelationEdge[]>;
  searchGraphRelationEdges(query: GraphRelationSearchQuery): MaybePromise<RelationEdge[]>;
  listGraphMemoryNodes(query: GraphMemoryNodePageQuery): MaybePromise<GraphMemoryNodePage>;
  listGraphRelationEdges(query: GraphRelationEdgePageQuery): MaybePromise<GraphRelationEdgePage>;
  deleteIndexEntry(indexId: string): Promise<void>;
  deleteTextIndexEntry(indexId: string): Promise<void>;
  deleteVectorIndexEntry(indexId: string): Promise<void>;
  deleteIndexBundle(ownerType: "fact" | "stm" | "ltm", ownerId: string): Promise<void>;
  saveMemoryChangeEvent(event: MemoryChangeEvent): Promise<void>;
  saveMemoryFeedback(item: MemoryFeedbackItem): Promise<void>;
  saveMemoryRetrievalEvent(event: MemoryRetrievalEvent): Promise<void>;
  getMemoryReuseSignals(ownerIds?: string[], now?: string): MemoryReuseSignal[];
  saveBackgroundDocument(item: BackgroundContextDocument): Promise<void>;
  getLatestBackgroundDocument(tenantId: string, principalId: string): MaybePromise<BackgroundContextDocument | undefined>;
  getBackgroundMaintenanceTask(tenantId: string, principalId: string, runId: string): MaybePromise<BackgroundMaintenanceTask | undefined>;
  createBackgroundMaintenanceTask(task: BackgroundMaintenanceTask): Promise<BackgroundMaintenanceTask>;
  claimBackgroundMaintenanceTask(input: {
    taskId: string;
    claimedBy: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): Promise<BackgroundMaintenanceTask | undefined>;
  saveBackgroundMaintenanceTask(task: BackgroundMaintenanceTask): Promise<void>;
  getBackgroundMaintenanceBatches(taskId: string): MaybePromise<BackgroundMaintenanceBatch[]>;
  saveBackgroundMaintenanceBatch(batch: BackgroundMaintenanceBatch): Promise<void>;
  commitBackgroundMaintenanceCheckpoint(input: CommitBackgroundMaintenanceCheckpointRequest): Promise<void>;
  commitFixedBackgroundMaintenance(input: CommitFixedBackgroundMaintenanceRequest): Promise<void>;
  getBackgroundDynamicCache(cacheKey: string): MaybePromise<BackgroundDynamicCacheRecord | undefined>;
  getLatestBackgroundDynamicCache(
    tenantId: string,
    principalId: string,
    fixedRevision?: number
  ): MaybePromise<BackgroundDynamicCacheRecord | undefined>;
  saveBackgroundDynamicCache(record: BackgroundDynamicCacheRecord): Promise<void>;
  deleteExpiredBackgroundDynamicCaches(expiredAt: string): Promise<number>;
  getSessionBackgroundSnapshot(
    tenantId: string,
    principalId: string,
    sessionId: string
  ): MaybePromise<SessionBackgroundSnapshot | undefined>;
  createSessionBackgroundSnapshot(snapshot: SessionBackgroundSnapshot): Promise<SessionBackgroundSnapshot>;
  markPermissionInvalidated(sourceRefIds: string[], reason?: string): Promise<{
    affectedFacts: number;
    affectedShortTermMemories: number;
    affectedLongTermMemories: number;
    affectedPackTraces: number;
    affectedIndexEntries: number;
  }>;
  deleteMemoryEventCascade(
    eventId: string,
    options?: { recordChangeEvent?: boolean }
  ): Promise<ContextDeleteResult | undefined>;
  clearAllContextData(): Promise<ContextClearResult>;
  getDebugSnapshot(): ContextDebugSnapshot;
}
