import React from "react";
import "./app.css";
import { requestFileIngestion } from "./features/import/request-file-ingestion";
import { buildLongMemEvalLlmTestPayload, requestCancelLongMemEvalJob, requestClearLongMemEvalDatabase, requestLongMemEvalEvaluation, requestLongMemEvalJob, requestLongMemEvalJobResults, requestLongMemEvalSelectedItemDetails, type LongMemEvalJobSnapshot, type LongMemEvalJsonlResultItem, type LongMemEvalJsonlResultPage, type LongMemEvalLlmTestTarget, type LongMemEvalSelectedEvidence, type LongMemEvalSelectedItemDetail } from "./features/evaluation/request-longmemeval-evaluation";
import { parseLongMemEvalJsonlText } from "./features/evaluation/parse-longmemeval-jsonl-results";
import {
  buildManualStepProgress,
  buildProgressStages,
  translateMemoryProgressStage,
  type MemoryIngestionProgressState,
  type MemoryProgressStep
} from "./memory-progress";
import { formatShortTermMemoryTrail } from "./short-term-memory-format";
import { formatMemoryInspectorSummary } from "./memory-inspector-format";
import { formatContextEventTitle } from "./memory-event-format";
import {
  buildDataLakeSearchUrl,
  formatCustomFieldBadges,
  parseCustomFieldExistsText,
  parseCustomFieldInput,
  type CustomFieldValue
} from "./data-lake-search";
import {
  buildDebugMemoryEvent,
  parseDraftCustomFields,
  type EventDraft,
  type SourceRef,
  type Visibility
} from "./memory-event-draft";
import { DreamingConsole } from "./features/dreaming/DreamingConsole";
import { requestCancelLocomoEvaluation, requestLocomoEvaluation, requestLocomoEvaluationJob, type LocomoEvaluationJob } from "./features/evaluation/request-locomo-evaluation";

type Tab = "longMemEval" | "dataLake" | "timeline" | "stm" | "ltm" | "dreaming" | "graph" | "search" | "pack" | "background" | "feedback" | "metrics";

interface DataLakeSourceDescriptor {
  sourceApp: string;
  sourceId: string;
  sourceName?: string;
  sourceType?: string;
  sourceUri?: string;
  connectorId?: string;
  syncCursor?: string;
  syncVersion?: string;
}

interface MemoryEvent {
  eventId: string;
  eventType: string;
  eventSummary?: string;
  eventDescription?: string;
  eventTime: string;
  sourceApp?: string;
  sourceId?: string;
  dataSource?: DataLakeSourceDescriptor;
  customFields?: Record<string, CustomFieldValue>;
  permissionSnapshot: {
    snapshotId: string;
    tenantId: string;
    principalId: string;
    sourceAclVersion: string;
    visibility: Visibility;
  };
  multimodalData: Array<{
    itemId: string;
    type: "text" | "document" | "image" | "audio" | "video" | "tool_result";
    format: string;
    content?: CustomFieldValue;
    ref?: string;
    sourceRefs?: MemoryEvent["sourceRefs"];
    timeBasis?: "absolute" | "event_relative" | "media_offset" | "source_time";
    timeConfidence?: "low" | "medium" | "high";
    customFields?: Record<string, CustomFieldValue>;
  }>;
  sourceRefs?: Array<{
    sourceRefId: string;
    sourceType: string;
    sourceId: string;
    sourceUrl?: string;
  }>;
}

interface ParsedSegment {
  segmentId: string;
  eventId: string;
  modality: string;
  content: string;
  status: "parsed" | "unsupported" | "pending";
  confidence: "low" | "medium" | "high";
  dataSource?: DataLakeSourceDescriptor;
  customFields?: Record<string, CustomFieldValue>;
}

interface FactItem {
  factId: string;
  factType: string;
  factText: string;
  normalizedClaim?: string;
  linkedEventIds: string[];
  linkedSegmentIds: string[];
  confidenceLevel: "low" | "medium" | "high";
  status: string;
  observedAt?: string;
  validTimeStart?: string;
  validTimeEnd?: string;
  timeBasis?: string;
  timeConfidence?: "low" | "medium" | "high";
  schemaVersion?: string;
}

interface AggregatedFactItem {
  aggregationId: string;
  factId: string;
  factType: string;
  factText: string;
  normalizedClaim: string;
  sourceEventIds: string[];
  sourceFactIds: string[];
  sourceSegmentIds: string[];
  sourceRefs: SourceRef[];
  validTimeStart: string;
  validTimeEnd?: string;
  timeBasis: string;
  timeConfidence: "low" | "medium" | "high";
}

interface LlmFactFusionTrace {
  traceId: string;
  eventId: string;
  provider: "openai-compatible";
  endpoint: string;
  model: string;
  keySource: "request" | "env" | "missing";
  promptVersion: string;
  schemaVersion: string;
  prompt: string;
  alignedEvidence: Array<{
    segmentId: string;
    itemId?: string;
    modality: string;
    content: string;
    eventTime: string;
    validTimeStart: string;
    timeBasis: string;
    timeConfidence: string;
    confidence: string;
  }>;
  rawResponse?: unknown;
  parsedFacts: FactItem[];
  rejectedSegments: Array<{
    segmentId: string;
    reason: string;
  }>;
  fallbackReason?: string;
  createdAt: string;
}

interface LlmDreamingTrace {
  traceId: string;
  sourceMemoryDataIds: string[];
  provider: "openai-compatible";
  endpoint: string;
  model: string;
  keySource: "request" | "env" | "missing";
  promptVersion: string;
  schemaVersion: string;
  prompt: string;
  candidateMemories: Array<{
    memoryDataId: string;
    memoryDataType: string;
    content: string;
    summary?: string;
    importanceLevel: ShortTermMemory["importanceLevel"];
    confidenceLevel: ShortTermMemory["confidenceLevel"];
    lifecycleStatus: ShortTermMemory["lifecycleStatus"];
    matchedRules: string[];
    sourceFactIds: string[];
    entityIds: string[];
  }>;
  rawResponse?: unknown;
  parsedMemories: LongTermMemory[];
  rejectedCandidates: Array<{
    memoryDataId: string;
    reason: string;
  }>;
  fallbackReason?: string;
  createdAt: string;
}

interface ShortTermMemory {
  memoryDataId: string;
  tenantId?: string;
  principalId?: string;
  memoryDataType: string;
  memoryType?: string;
  content: string;
  structuredFacts?: {
    schemaVersion?: string;
    memoryKind?: string;
    facts?: Array<{
      claim?: string;
      explanation?: string;
      factId?: string;
      sourceMemoryDataId?: string;
      factType?: string;
      confidenceLevel?: string;
      validTimeStart?: string;
      validTimeEnd?: string;
      entityIds?: string[];
      sourceRefIds?: string[];
    }>;
  };
  factSummary?: string;
  summary?: string;
  sourceFactIds: string[];
  importanceLevel: "low" | "medium" | "high" | "critical";
  retrievalWeight?: number | null;
  userRetrievalWeight?: number | null;
  confidenceLevel: "low" | "medium" | "high";
  admissionResult: string;
  admissionReason: string;
  matchedRules: string[];
  admissionSignals?: {
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
}

interface LongTermMemory {
  memoryId: string;
  theoryClass: string;
  memoryType: string;
  content: string;
  structuredFacts?: {
    schemaVersion?: string;
    memoryKind?: string;
    facts?: Array<{
      claim?: string;
      explanation?: string;
      sourceMemoryDataId?: string;
      confidenceLevel?: string;
      entityIds?: string[];
      sourceRefIds?: string[];
    }>;
  };
  factSummary?: string;
  summary?: string;
  confidenceLevel: "low" | "medium" | "high";
  recallWeight: "low" | "medium" | "high";
  retrievalWeight?: number | null;
  userRetrievalWeight?: number | null;
  solidifyReason: string;
  matchedRules: string[];
  lifecycleStatus: "active" | "weakened" | "archived" | "rejected" | "deleted" | "revised";
  accessState?: "visible" | "hidden" | "permission-invalid";
}

interface MemoryChangeEvent {
  eventId: string;
  memoryId?: string;
  memoryDataId?: string;
  changeType: string;
  storageLayer: string;
  reason: string;
  createdAt: string;
}

interface MemoryFeedbackItem {
  feedbackId: string;
  targetId: string;
  targetType: "fact" | "stm" | "ltm";
  action: "like" | "dislike" | "correct" | "confirm" | "ignore" | "delete";
  note?: string;
  createdAt: string;
}

interface BackgroundContextDocument {
  backgroundId: string;
  fixedText: string;
  dynamicText: string;
  sourceRefIds: string[];
  conflictIds: string[];
  degradedModeReason?: string;
  updateSuggestion?: {
    status: "pending" | "applied" | "rejected";
    summary: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface PipelineTask {
  taskId: string;
  eventId: string;
  taskType: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  stage: string;
  error?: string;
}

class ManualStepRecoveredAfterTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualStepRecoveredAfterTimeoutError";
  }
}

interface Snapshot {
  memoryEvents: MemoryEvent[];
  parsedSegments: ParsedSegment[];
  facts: FactItem[];
  shortTermMemories: ShortTermMemory[];
  longTermMemories: LongTermMemory[];
  graphMemoryNodes: Array<{
    graphNodeId: string;
    ownerId: string;
    ownerType: "stm" | "ltm";
    memoryType?: string;
    content: string;
    factSummary?: string;
    vector: number[];
    lifecycleStatus: string;
    retrievalWeight: number | null;
    sourceRefs: SourceRef[];
    entityIds: string[];
    refreshedAt: string;
  }>;
  relationEdges: unknown[];
  packTraces: unknown[];
  llmFactFusionTraces: LlmFactFusionTrace[];
  llmDreamingTraces: LlmDreamingTrace[];
  pipelineTasks: PipelineTask[];
  indexEntries: Array<{
    indexId: string;
    ownerId: string;
    ownerType: string;
    lifecycleStatus: string;
    refreshedAt: string;
    tokenCount: number;
  }>;
  changeEvents: MemoryChangeEvent[];
  feedbackItems: MemoryFeedbackItem[];
  backgroundDocuments: BackgroundContextDocument[];
}

interface LongMemEvalReport {
  datasetPath: string;
  totalSamples: number;
  questionTypeCounts: Record<string, number>;
  questionTypeAccuracy: Record<string, { total: number; judgeAccuracy: number; exactMatch: number }>;
  ingestion?: {
    totalSessions: number;
    ingestedSessions: number;
    skippedSessions: number;
  };
  answerGeneration?: {
    totalHypotheses: number;
    answered: number;
    failed: number;
    answerRate: number;
    fallbackUsed: boolean;
  };
  judge?: {
    totalJudged: number;
    judged: number;
    accuracy: number;
    fallbackUsed: boolean;
    model: string;
    baseUrl: string;
  };
  metrics: Record<string, {
    k: number;
    recallAtK: number;
    recallAnyAtK: number;
    recallAllAtK: number;
    precisionAtK: number;
    mrrAtK: number;
    ndcgAtK: number;
    exactMatch: number;
    judgeAccuracy: number;
  }>;
  samples?: Array<{
    questionId: string;
    questionType: string;
    question: string;
    answer: string;
    hypothesis: string;
    answerFallbackUsed?: boolean;
    answerFallbackReason?: string;
    judgment: {
      label: "correct" | "incorrect";
      score: number;
      reason: string;
      model: string;
      baseUrl: string;
    };
  }>;
}

interface LongMemEvalMultiModelReport {
  datasetPath: string;
  totalSamples: number;
  ks: number[];
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  modelConcurrency: number;
  questionTypeCounts: Record<string, number>;
  summary: Array<{
    runId: string;
    label?: string;
    status: "done" | "error";
    judgeAccuracy?: number;
    answerRate?: number;
    judgeModel?: string;
    judgeBaseUrl?: string;
    error?: string;
  }>;
  runs: Array<{
    runId: string;
    label?: string;
    status: "done" | "error";
    report?: LongMemEvalReport;
    error?: string;
  }>;
}

type LongMemEvalEvaluationReport = LongMemEvalReport | LongMemEvalMultiModelReport;

interface LongMemEvalRunState {
  status: "idle" | "queued" | "running" | "done" | "error" | "cancelled";
  jobId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  fallbackReason?: string;
  fallbackTrace?: {
    traceId: string;
    eventId: string;
    prompt: string;
    rawResponse?: unknown;
    parsedFacts?: unknown[];
    rejectedSegments?: Array<{
      segmentId: string;
      reason: string;
    }>;
  };
  stage?: "ingest" | "timeline_aggregation" | "stm" | "ltm" | "answer" | "judge" | "result_commit";
  ingestStage?: "save_event" | "parse" | "fact" | "stm" | "finalize" | "pipeline_wait";
  stageProgress?: number;
  stageMessage?: string;
  batchIndex?: number;
  batchCount?: number;
  batchProgress?: number;
  batchMessage?: string;
  progress?: number;
  processedSamples?: number;
  totalSamples?: number;
  processedSessions?: number;
  totalSessions?: number;
  processedSteps?: number;
  totalSteps?: number;
  currentQuestionId?: string;
  currentQuestionType?: string;
  currentQuestion?: string;
  currentSampleIndex?: number;
  currentSampleCount?: number;
  currentSessionIndex?: number;
  currentSessionCount?: number;
  currentSessionId?: string;
  currentSessionDate?: string;
  currentHypothesis?: string;
  currentJudgment?: string;
  activeSamples?: LongMemEvalJobSnapshot["activeSamples"];
  resultPath?: string;
  tracePath?: string;
  resume?: boolean;
  retrySkipped?: boolean;
  resumedSamples?: number;
  committedSamples?: number;
  modelArtifacts?: LongMemEvalJobSnapshot["modelArtifacts"];
  effectiveConcurrency?: LongMemEvalJobSnapshot["effectiveConcurrency"];
  llmRequest?: {
    status: "started" | "succeeded" | "failed";
    operation: string;
    endpoint: string;
    startedAt: string;
    elapsedMs?: number;
    active: number;
    completed: number;
    failed: number;
    batchIndex?: number;
    batchCount?: number;
    error?: string;
  };
  report?: LongMemEvalEvaluationReport;
}

interface FileIngestionBatchItemProgress {
  path: string;
  eventId: string;
  status: "remembered" | "failed";
  currentStage: "event" | "data_lake" | "fact" | "stm" | "index";
  completedStages: Array<"event" | "data_lake" | "fact" | "stm" | "index">;
  progress: number;
  error?: string;
  droppedReason?: string;
}

interface FileIngestionBatchProgress {
  total: number;
  processed: number;
  remembered: number;
  failed: number;
  progress: number;
  items: FileIngestionBatchItemProgress[];
}

interface FileIngestionResponse {
  ok?: boolean;
  result?: {
    directory: string;
    ingested: Array<{
      path: string;
      idempotencyKey: string;
      progress: FileIngestionBatchItemProgress;
    }>;
    skipped: Array<{ path: string; reason: string }>;
    failed: Array<{
      path: string;
      idempotencyKey: string;
      error: string;
      progress: FileIngestionBatchItemProgress;
    }>;
    progress: FileIngestionBatchProgress;
  };
  error?: string;
}

interface TimelineItem {
  fact: AggregatedFactItem;
  sourceEvents: MemoryEvent[];
  sourceSegments: ParsedSegment[];
  sourceFacts: FactItem[];
  shortTermMemories: ShortTermMemory[];
  pipelineTasks?: PipelineTask[];
  changeEvents: MemoryChangeEvent[];
}

interface SearchResult {
  id: string;
  layer: "fact" | "stm" | "ltm";
  content: string;
  status: string;
  score: number;
  reason: string;
  scoreBreakdown?: {
    keyword: number;
    vector: number;
    graph: number;
    recency: number;
    importance: number;
    retrievalWeight: number | null;
    userRetrievalWeight: number | null;
    sourceReliability: number;
    feedback: number;
    diversity: number;
    rrf: number;
    conflictPenalty: number;
    permissionRiskPenalty: number;
    stalenessPenalty: number;
    route?: {
      keyword: number;
      vector: number;
      graph: number;
      time: number;
      feedback: number;
    };
  };
}

interface DataLakeSearchResult {
  id: string;
  type: "segment" | "fact";
  content: string;
  status: string;
  dataSource?: DataLakeSourceDescriptor;
  customFields?: Record<string, CustomFieldValue>;
  sourceRefIds: string[];
}

interface ContextPackItem {
  id: string;
  layer: "fact" | "stm" | "ltm";
  content: string;
  compressedContent?: string;
  score: number;
}

interface ContextPack {
  packId: string;
  task: string;
  serializedPrompt: string;
  profileContext: ContextPackItem[];
  taskContext: ContextPackItem[];
  recentContext: ContextPackItem[];
  constraints: ContextPackItem[];
  citations: Array<{
    sourceRefId: string;
    sourceType: string;
    sourceId: string;
    itemIds: string[];
  }>;
  conflicts: Array<{
    edgeId: string;
    fromId: string;
    toId: string;
    evidence?: string;
    itemIds: string[];
  }>;
  tokenBudget: {
    requested: number;
    used: number;
    allocations: Record<string, number>;
    plan?: {
      profileContext: number;
      taskContext: number;
      recentContext: number;
      constraints: number;
      citations: number;
      conflicts: number;
      reservedForCritical: number;
    };
  };
  compressionSteps?: Array<{
    id: string;
    layer?: "fact" | "stm" | "ltm";
    action: "keep" | "compress" | "drop";
    beforeTokens: number;
    afterTokens: number;
    reason: string;
  }>;
  dropped: Array<{
    id: string;
    layer?: string;
    reason: string;
  }>;
  traceId: string;
}

interface ManualMemoryFlowResult {
  stages: Array<{
    stage: "event" | "data_lake" | "timeline_aggregation" | "ltm" | "stm";
    status: "started" | "succeeded";
    message: string;
    at: string;
    counts?: Record<string, number>;
    resourceIds?: string[];
  }>;
  event: MemoryEvent;
  dataLake: {
    parsedSegments: number;
    facts: number;
    segments: Array<{
      segmentId: string;
      modality: string;
      status: string;
      confidence: string;
      content: string;
    }>;
    factItems: Array<{
      factId: string;
      status: string;
      confidenceLevel: string;
      factText: string;
      sourceEventIds: string[];
      sourceSegmentIds: string[];
      validTimeStart: string;
      validTimeEnd?: string;
      timeBasis: string;
      timeConfidence: string;
    }>;
    sourceRefs: SourceRef[];
  };
  timelineAggregation: {
    eventIds: string[];
    factIds: string[];
    summary: string;
    aggregatedFacts: AggregatedFactItem[];
  };
  llmFactFusionTrace?: LlmFactFusionTrace;
  longTermMemory: LongTermMemory;
  shortTermMemory: ShortTermMemory;
  tasks: PipelineTask[];
  changeEvents: MemoryChangeEvent[];
}

interface ManualStepResult {
  action: "event" | "data_lake" | "timeline_fusion" | "stm" | "ltm";
  event?: MemoryEvent;
  parsedSegments: ParsedSegment[];
  facts: FactItem[];
  shortTermMemory?: ShortTermMemory;
  ltmResult?: {
    trace: LlmDreamingTrace;
    longTermMemories: LongTermMemory[];
  };
  task: PipelineTask;
  changeEvents: MemoryChangeEvent[];
}

interface LlmSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface LlmTestState {
  status: "idle" | "testing" | "ok" | "error";
  message?: string;
  elapsedMs?: number;
  tokenUsage?: LlmTokenUsage;
}

interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface LongMemEvalLlmTestState extends LlmTestState {
  target?: LongMemEvalLlmTestTarget;
}

interface LongMemEvalLlmSettings {
  extractionBaseUrl: string;
  extractionModel: string;
  extractionApiKey: string;
  answerBaseUrl: string;
  answerModel: string;
  answerApiKey: string;
  judgeBaseUrl: string;
  judgeModel: string;
  judgeApiKey: string;
  ingestSampleConcurrency: number;
  ingestSessionConcurrency: number;
  answerConcurrency: number;
  judgeConcurrency: number;
  resultFileName: string;
  traceFileName: string;
  resume: boolean;
  retrySkipped: boolean;
  resumeLegacy: boolean;
  logIngestRequestContext: boolean;
  answerContextMode: "context_pack" | "retrieval";
  disableIngestLlm: boolean;
  skipStmAdmission: boolean;
  skipLtmDreaming: boolean;
  modelOnlyEvaluation: boolean;
}

interface PublicContextEngineConfig {
  llm: {
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    apiKeyConfigured: boolean;
  };
  embedding: {
    protocol: "openai-compatible" | "adapter";
    baseUrl?: string;
    model: string;
    apiKeyEnv: string;
    apiKeyConfigured: boolean;
    dimensions: number;
    sendDimensions: boolean;
    timeoutMs: number;
    maxAttempts: number;
    retryDelayMs: number;
    concurrency: number;
    batchSize: number;
  };
}

interface PersistedContextEngineConfig extends PublicContextEngineConfig {
  llm: PublicContextEngineConfig["llm"] & {
    apiKeyConfigured?: boolean;
  };
}

interface WritableEventTemplate {
  source: EventDraft["source"];
  title: string;
  eventType: string;
  writePath: string;
  modality: string;
  description: string;
  content: string;
}

const emptySnapshot: Snapshot = {
  memoryEvents: [],
  parsedSegments: [],
  facts: [],
  shortTermMemories: [],
  longTermMemories: [],
  graphMemoryNodes: [],
  relationEdges: [],
  packTraces: [],
  llmFactFusionTraces: [],
  llmDreamingTraces: [],
  pipelineTasks: [],
  indexEntries: [],
  changeEvents: [],
  feedbackItems: [],
  backgroundDocuments: []
};

const writableEventTemplates: WritableEventTemplate[] = [
  {
    source: "PRD.md",
    title: "PRD 文档记忆事件",
    eventType: "prd_memory_event",
    writePath: "POST /context/events",
    modality: "文本",
    description: "PRD 记忆事件：上下文引擎需要为智能体提供有证据的上下文。",
    content: JSON.stringify({
      text: "上下文引擎应捕获多模态记忆事件，保留来源引用，展示短期记忆和长期记忆状态，并允许智能体检索可追溯的上下文包。",
      project: "ospx-new",
      document: "PRD.md"
    }, null, 2)
  },
  {
    source: "方案.md",
    title: "方案文档记忆事件",
    eventType: "solution_memory_event",
    writePath: "POST /context/events",
    modality: "文本",
    description: "方案记忆事件：覆盖摄入、融合、准入、检索和调试前端流程。",
    content: JSON.stringify({
      text: "实现方案使用 write_event 摄入、解析适配器、时间轴融合、短期记忆准入、长期记忆巩固、检索打分追踪，以及用于检查链路的调试前端。",
      project: "ospx-new",
      document: "方案.md"
    }, null, 2)
  },
  {
    source: "manual",
    title: "手动测试记忆事件",
    eventType: "manual_memory_event",
    writePath: "POST /context/events",
    modality: "文本",
    description: "手动记忆事件",
    content: JSON.stringify({
      text: "在这里写入一条测试记忆事件。"
    }, null, 2)
  }
];

const sourceTemplates = Object.fromEntries(
  writableEventTemplates.map((template) => [
    template.source,
    {
      eventType: template.eventType,
      description: template.description,
      content: template.content
    }
  ])
) as Record<EventDraft["source"], Pick<EventDraft, "eventType" | "description" | "content">>;

export function DebugApp() {
  const [health, setHealth] = React.useState("未知");
  const [activeTab, setActiveTab] = React.useState<Tab>("dataLake");
  const [snapshot, setSnapshot] = React.useState<Snapshot>(emptySnapshot);
  const [timeline, setTimeline] = React.useState<TimelineItem[]>([]);
  const [selected, setSelected] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState("就绪");
  const [query, setQuery] = React.useState("");
  const [searchLayer, setSearchLayer] = React.useState("all");
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([]);
  const [dataLakeQuery, setDataLakeQuery] = React.useState("");
  const [dataLakeSourceApp, setDataLakeSourceApp] = React.useState("");
  const [dataLakeSourceType, setDataLakeSourceType] = React.useState("");
  const [dataLakeCustomFilters, setDataLakeCustomFilters] = React.useState("");
  const [dataLakeCustomExists, setDataLakeCustomExists] = React.useState("");
  const [dataLakeResults, setDataLakeResults] = React.useState<DataLakeSearchResult[]>([]);
  const [packTask, setPackTask] = React.useState("为智能体组装上下文，用于说明当前记忆引擎状态。");
  const [packBudget, setPackBudget] = React.useState(600);
  const [contextPack, setContextPack] = React.useState<ContextPack | null>(null);
  const [longMemEvalContextPack, setLongMemEvalContextPack] = React.useState<ContextPack | null>(null);
  const [longMemEvalClearRevision, setLongMemEvalClearRevision] = React.useState(0);
  const [manualFlow, setManualFlow] = React.useState<ManualMemoryFlowResult | null>(null);
  const [manualStep, setManualStep] = React.useState<ManualStepResult | null>(null);
  const [manualStepEventId, setManualStepEventId] = React.useState("");
  const [fileBatch, setFileBatch] = React.useState<FileIngestionBatchProgress | null>(null);
  const [memoryProgress, setMemoryProgress] = React.useState<MemoryIngestionProgressState | null>(null);
  const [memoryProgressSteps, setMemoryProgressSteps] = React.useState<MemoryProgressStep[]>([]);
  const [backgroundContext, setBackgroundContext] = React.useState<BackgroundContextDocument | null>(null);
  const [longMemEvalDatasetPath, setLongMemEvalDatasetPath] = React.useState("../../datasets/LongMemEval/longmemeval_s_cleaned.json");
  const [longMemEvalPackQuestionId, setLongMemEvalPackQuestionId] = React.useState("");
  const [longMemEvalJsonlFileName, setLongMemEvalJsonlFileName] = React.useState("");
  const [longMemEvalJsonlText, setLongMemEvalJsonlText] = React.useState("");
  const [longMemEvalJsonlPage, setLongMemEvalJsonlPage] = React.useState(1);
  const [longMemEvalJsonlResult, setLongMemEvalJsonlResult] = React.useState<LongMemEvalJsonlResultPage | null>(null);
  const [longMemEvalJsonlStatus, setLongMemEvalJsonlStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [longMemEvalJsonlError, setLongMemEvalJsonlError] = React.useState("");
  const [longMemEvalKs, setLongMemEvalKs] = React.useState("1,5");
  const [longMemEvalLlmSettings, setLongMemEvalLlmSettings] = React.useState<LongMemEvalLlmSettings>({
    extractionBaseUrl: "",
    extractionModel: "",
    extractionApiKey: "",
    answerBaseUrl: "",
    answerModel: "",
    answerApiKey: "",
    judgeBaseUrl: "",
    judgeModel: "",
    judgeApiKey: "",
    ingestSampleConcurrency: 1,
    ingestSessionConcurrency: 1,
    answerConcurrency: 1,
    judgeConcurrency: 1,
    resultFileName: "longmemeval-result.jsonl",
    traceFileName: "",
    resume: false,
    retrySkipped: false,
    resumeLegacy: false,
    logIngestRequestContext: false,
    answerContextMode: "context_pack",
    disableIngestLlm: false,
    skipStmAdmission: false,
    skipLtmDreaming: false,
    modelOnlyEvaluation: false
  });
  const [longMemEvalReport, setLongMemEvalReport] = React.useState<LongMemEvalEvaluationReport | null>(null);
  const [longMemEvalRunState, setLongMemEvalRunState] = React.useState<LongMemEvalRunState>({ status: "idle" });
  const [longMemEvalLlmTestState, setLongMemEvalLlmTestState] = React.useState<LongMemEvalLlmTestState>({ status: "idle" });
  const [llmSettings, setLlmSettings] = React.useState<LlmSettings>({
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini"
  });
  const [llmTestState, setLlmTestState] = React.useState<LlmTestState>({ status: "idle" });
  const [llmConfigured, setLlmConfigured] = React.useState(false);
  const [draft, setDraft] = React.useState<EventDraft>({
    source: "PRD.md",
    eventTime: toDatetimeLocalValue(new Date()),
    visibility: "private",
    ...sourceTemplates["PRD.md"],
    customFields: ""
  });

  React.useEffect(() => {
    void refreshConfig();
    void refreshHealth();
    void refreshSnapshot();
  }, []);
  React.useEffect(() => {
    setLongMemEvalContextPack(null);
    setLongMemEvalPackQuestionId("");
  }, [longMemEvalDatasetPath]);

  const stats = React.useMemo(
    () => [
      { label: "事实", value: snapshot.facts.length },
      { label: "事件", value: snapshot.memoryEvents.length },
      { label: "短期记忆", value: snapshot.shortTermMemories.length },
      { label: "长期记忆", value: snapshot.longTermMemories.length },
      { label: "图节点", value: snapshot.graphMemoryNodes.length },
      { label: "LLM 融合", value: snapshot.llmFactFusionTraces.length },
      { label: "LLM 做梦", value: snapshot.llmDreamingTraces.length },
      { label: "任务", value: snapshot.pipelineTasks.length },
      { label: "索引", value: snapshot.indexEntries.length },
      { label: "反馈", value: snapshot.feedbackItems.length }
    ],
    [snapshot]
  );

  async function refreshHealth() {
    const response = await fetch("/health");
    const data = (await response.json()) as { ok?: boolean };
    setHealth(data.ok ? "正常" : "异常");
  }

  async function refreshConfig() {
    const response = await fetch("/context/config");
    const data = (await response.json()) as { ok?: boolean; config?: PersistedContextEngineConfig };
    if (!data.ok || !data.config) return;
    setLlmSettings((current) => ({
      ...current,
      baseUrl: data.config?.llm.baseUrl ?? current.baseUrl,
      model: data.config?.llm.model ?? current.model,
      apiKey: data.config?.llm.apiKeyConfigured ? current.apiKey : ""
    }));
    setLlmConfigured(Boolean(data.config.llm.apiKeyConfigured));
  }

  async function refreshSnapshot() {
    const response = await fetch("/context/debug/snapshot");
    const data = (await response.json()) as {
      ok?: boolean;
      items?: Snapshot;
      timeline?: TimelineItem[];
    };
    if (data.ok && data.items) {
      setSnapshot(data.items);
      setTimeline(data.timeline ?? []);
      setBackgroundContext(data.items.backgroundDocuments.at(-1) ?? null);
      setToast("快照已刷新");
    }
  }

  async function pollPipelineProgress(eventId: string) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      await pause(1_500);
      const response = await fetch(`/context/tasks/by-event/${encodeURIComponent(eventId)}`);
      const data = (await response.json()) as {
        ok?: boolean;
        result?: PipelineTask;
      };
      if (!response.ok || !data.ok || !data.result) continue;
      const task = data.result;
      const progress = task ? progressForPipelineTask(task) : null;
      if (progress) {
        setMemoryProgress(progress.current);
        setMemoryProgressSteps(progress.steps);
      }
      if (task.status === "succeeded" || task.status === "failed" || task.status === "retry_scheduled") {
        void refreshSnapshot();
        return;
      }
    }
  }

  async function refreshBackgroundContext() {
    const response = await fetch("/context/background");
    const data = (await response.json()) as { ok?: boolean; result?: BackgroundContextDocument };
    if (data.ok && data.result) {
      setBackgroundContext(data.result);
      setSelected(data.result);
    }
  }

  function setLtmProgress(active: boolean, details: string) {
    setMemoryProgress({
      label: "长期记忆 / LTM",
      stage: "ltm",
      percent: active ? 78 : 100,
      details
    });
    setMemoryProgressSteps([
      { label: "写入事件", stage: "event", percent: 12, details: "已创建 MemoryEvent", status: "complete" },
      { label: "数据湖 / 解析", stage: "data_lake", percent: 35, details: "已生成解析片段", status: "complete" },
      { label: "时间轴 / 融合", stage: "timeline_aggregation", percent: 58, details: "已抽取事实并融合", status: "complete" },
      { label: "长期记忆 / LTM", stage: "ltm", percent: 78, details, status: active ? "active" : "complete" },
      {
        label: "短期记忆 / STM",
        stage: "stm",
        percent: 100,
        details: active ? "等待短期记忆回灌" : "已完成 STM 回写",
        status: active ? "pending" : "complete"
      }
    ]);
  }

  async function scanFiles() {
    await runTask("文件扫描完成", async () => {
      const response = (await requestFileIngestion()) as FileIngestionResponse;
      if (!response.ok || !response.result) {
        throw new Error(response.error ?? "文件摄入失败");
      }
      setFileBatch(response.result.progress);
      setSelected(response.result.progress);
      await refreshSnapshot();
    });
  }

  async function writeDraftEvent() {
    await runTask("记忆事件已写入", async () => {
      setMemoryProgressSteps([
        { label: "写入事件", stage: "event", percent: 12, details: "正在创建 MemoryEvent", status: "active" },
        { label: "数据湖 / 解析", stage: "data_lake", percent: 35, details: "等待后端解析", status: "pending" },
        { label: "时间轴 / 融合", stage: "timeline_aggregation", percent: 58, details: "等待后端融合", status: "pending" },
        { label: "长期记忆 / LTM", stage: "ltm", percent: 78, details: "写入事件后可手动触发做梦", status: "pending" },
        { label: "短期记忆 / STM", stage: "stm", percent: 100, details: "等待后端准入", status: "pending" }
      ]);
      setMemoryProgress({
        label: "写入事件",
        stage: "event",
        percent: 12,
        details: "正在创建 MemoryEvent"
      });
      const safeId = `${draft.source}_${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const event = buildDebugMemoryEvent(draft, {
        safeId,
        eventTime: parseDraftEventTime(draft.eventTime)
      });

      setMemoryProgress({
        label: "记忆处理",
        stage: "data_lake",
        percent: 35,
        details: "正在摄入、解析并生成短期记忆"
      });
      setMemoryProgressSteps([
        { label: "写入事件", stage: "event", percent: 12, details: "已创建 MemoryEvent", status: "complete" },
        { label: "数据湖 / 解析", stage: "data_lake", percent: 35, details: "正在后端解析", status: "active" },
        { label: "时间轴 / 融合", stage: "timeline_aggregation", percent: 58, details: "等待事实融合", status: "pending" },
        { label: "长期记忆 / LTM", stage: "ltm", percent: 78, details: "写入事件后可手动触发做梦", status: "pending" },
        { label: "短期记忆 / STM", stage: "stm", percent: 100, details: "等待准入", status: "pending" }
      ]);
      const response = await fetchWithTimeout("/context/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event,
          idempotencyKey: event.eventId,
          deferPipeline: true,
          llm: buildLlmPayload(llmSettings)
        })
      }, 60_000);
      const data = (await response.json()) as { ok?: boolean; result?: { eventId?: string; jobId?: string; pipelineStatus?: string }; error?: string };
      if (!response.ok || !data.ok || !data.result) {
        throw new Error(data.error ?? "记忆事件写入失败");
      }
      const pipelineQueued = data.result.pipelineStatus === "queued";
      setMemoryProgress({
        label: pipelineQueued ? "后台记忆管线" : "短期记忆 / STM",
        stage: pipelineQueued ? "data_lake" : "stm",
        percent: pipelineQueued ? 35 : 100,
        details: pipelineQueued
          ? "MemoryEvent 已入库，解析、融合和 STM 准入正在后台执行"
          : "后端已完成摄入、解析、事实融合和 STM 准入"
      });
      await refreshSnapshot();
      setSelected(data.result);
      setMemoryProgressSteps(pipelineQueued
        ? [
            { label: "写入事件", stage: "event", percent: 12, details: "已创建 MemoryEvent", status: "complete" },
            { label: "数据湖 / 解析", stage: "data_lake", percent: 35, details: "后台管线已排队", status: "active" },
            { label: "时间轴 / 融合", stage: "timeline_aggregation", percent: 58, details: "等待事实融合", status: "pending" },
            { label: "长期记忆 / LTM", stage: "ltm", percent: 78, details: "写入事件后可手动触发做梦", status: "pending" },
            { label: "短期记忆 / STM", stage: "stm", percent: 100, details: "等待准入和索引刷新", status: "pending" }
          ]
        : [
            { label: "写入事件", stage: "event", percent: 12, details: "已创建 MemoryEvent", status: "complete" },
            { label: "数据湖 / 解析", stage: "data_lake", percent: 35, details: "已生成解析片段", status: "complete" },
            { label: "时间轴 / 融合", stage: "timeline_aggregation", percent: 58, details: "已抽取事实并融合", status: "complete" },
            { label: "长期记忆 / LTM", stage: "ltm", percent: 78, details: "可在 LTM 做梦中继续巩固", status: "pending" },
            { label: "短期记忆 / STM", stage: "stm", percent: 100, details: "已完成准入和索引刷新", status: "complete" }
          ]);
      if (pipelineQueued && data.result.eventId) {
        await pollPipelineProgress(data.result.eventId);
      }
    });
  }

  async function saveLlmConfig() {
    await runTask("LLM 配置已保存", async () => {
      const response = await fetch("/context/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llm: buildLlmPayload(llmSettings) })
      });
      const data = (await response.json()) as { ok?: boolean; config?: PersistedContextEngineConfig; error?: string };
      if (!response.ok || !data.ok || !data.config) {
        throw new Error(data.error ?? "配置保存失败");
      }
      setLlmConfigured(Boolean(data.config.llm.apiKeyConfigured));
      setLlmSettings((current) => ({
        ...current,
        baseUrl: data.config?.llm.baseUrl ?? current.baseUrl,
        model: data.config?.llm.model ?? current.model,
        apiKey: ""
      }));
    });
  }

  async function testLlmConfig() {
    setLlmTestState({ status: "testing", message: "正在测试 LLM 调用" });
    await runTask("LLM 调用测试完成", async () => {
      const response = await fetch("/context/config/llm/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llm: buildLlmPayload(llmSettings) })
      });
      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: {
          baseUrl?: string;
          model?: string;
          elapsedMs?: number;
          responsePreview?: string;
        };
      };
      if (!response.ok || !data.ok) {
        const message = data.error ?? "LLM 调用测试失败";
        setLlmTestState({
          status: "error",
          message,
          ...(typeof data.result?.elapsedMs === "number" ? { elapsedMs: data.result.elapsedMs } : {})
        });
        throw new Error(message);
      }
      setLlmTestState({
        status: "ok",
        message: data.result?.responsePreview ? `响应：${data.result.responsePreview}` : "调用正常",
        ...(typeof data.result?.elapsedMs === "number" ? { elapsedMs: data.result.elapsedMs } : {})
      });
      setSelected(data.result ?? null);
    });
  }

  async function testLongMemEvalLlmConfig(target: LongMemEvalLlmTestTarget) {
    const label = target === "judge" ? "Judge" : target === "ingest" ? "入库 LLM" : target === "answer" ? "答题" : "提取";
    setLongMemEvalLlmTestState({ status: "testing", target, message: `正在测试 ${label} 模型` });
    await runTask(`LongMemEval ${label} 模型测试完成`, async () => {
      const response = await fetch("/context/config/llm/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(target === "ingest" ? { mode: "ingest" } : {}),
          ...(target === "answer" ? { mode: "answer" } : {}),
          llm: buildLongMemEvalLlmTestPayload(longMemEvalLlmSettings, target)
        })
      });
      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: {
          baseUrl?: string;
          model?: string;
          elapsedMs?: number;
          responsePreview?: string;
          factCount?: number;
          admissionResult?: string;
          tokenUsage?: LlmTokenUsage;
        };
      };
      if (!response.ok || !data.ok) {
        const message = data.error ?? `${label} 模型测试失败`;
        setLongMemEvalLlmTestState({
          status: "error",
          target,
          message,
          ...(typeof data.result?.elapsedMs === "number" ? { elapsedMs: data.result.elapsedMs } : {}),
          ...(data.result?.tokenUsage ? { tokenUsage: data.result.tokenUsage } : {})
        });
        throw new Error(message);
      }
      setLongMemEvalLlmTestState({
        status: "ok",
        target,
        message: target === "ingest" && data.result?.admissionResult
          ? `入库 LLM：${data.result.factCount ?? 0} facts / ${data.result.admissionResult}`
          : target === "answer" && data.result?.responsePreview ? `答题响应：${data.result.responsePreview}`
          : data.result?.responsePreview ? `${label} 响应：${data.result.responsePreview}` : `${label} 模型调用正常`,
        ...(typeof data.result?.elapsedMs === "number" ? { elapsedMs: data.result.elapsedMs } : {}),
        ...(data.result?.tokenUsage ? { tokenUsage: data.result.tokenUsage } : {})
      });
      setSelected(data.result ?? null);
    });
  }

  async function runManualFlow() {
    const draftEventTime = parseDraftEventTime(draft.eventTime);
    const customFields = parseDraftCustomFields(draft.customFields);
    const flowSkeleton: ManualMemoryFlowResult = {
      stages: [],
      event: {
        eventId: `pending_${Date.now()}`,
        eventType: "solution_memory_flow_event",
        eventDescription: "手动触发方案流程：事件到数据湖、时间轴聚合、长期记忆、短期记忆。",
        eventTime: draftEventTime,
        sourceApp: "context-debug-frontend",
        sourceId: draft.source,
        customFields,
        permissionSnapshot: {
          snapshotId: "pending",
          tenantId: "local",
          principalId: "debug-user",
          sourceAclVersion: "debug-flow-v1",
          visibility: draft.visibility
        },
        multimodalData: [
          {
            itemId: "pending",
            type: "text",
            format: "plain",
            content: draft.content,
            ref: draft.source,
            timeBasis: "source_time",
            timeConfidence: "high"
          }
        ],
        sourceRefs: []
      },
      dataLake: {
        parsedSegments: 0,
        facts: 0,
        segments: [],
        factItems: [],
        sourceRefs: []
      },
      timelineAggregation: {
        eventIds: [],
        factIds: [],
        summary: "",
        aggregatedFacts: []
      },
      longTermMemory: {
        memoryId: "pending",
        theoryClass: "semantic",
        memoryType: "timeline_aggregation",
        content: "",
        confidenceLevel: "low",
        recallWeight: "low",
        solidifyReason: "",
        matchedRules: [],
        lifecycleStatus: "active",
        accessState: "visible"
      },
      shortTermMemory: {
        memoryDataId: "pending",
        memoryDataType: "ltm_recall_context",
        content: "",
        sourceFactIds: [],
        importanceLevel: "low",
        confidenceLevel: "low",
        admissionResult: "write_low_priority",
        admissionReason: "",
        matchedRules: [],
        admissionSignals: {
          importance: "low",
          confidence: "low",
          freshness: "stale",
          sensitivity: "low",
          actorWeight: "low",
          conflict: "none",
          permission: "private"
        },
        lifecycleStatus: "active",
        accessState: "visible"
      },
      tasks: [],
      changeEvents: []
    };

    setMemoryProgressSteps([
      { label: "写入事件", stage: "event", percent: 12, details: "正在创建 MemoryEvent", status: "active" },
      { label: "数据湖 / 解析", stage: "data_lake", percent: 35, details: "正在生成解析片段", status: "pending" },
      { label: "时间轴 / 融合", stage: "timeline_aggregation", percent: 58, details: "正在抽取事实并融合", status: "pending" },
      { label: "长期记忆 / LTM", stage: "ltm", percent: 78, details: "正在做梦并巩固长期记忆", status: "pending" },
      { label: "短期记忆 / STM", stage: "stm", percent: 100, details: "正在回灌并建立可召回上下文", status: "pending" }
    ]);
    setMemoryProgress({
      label: "写入事件",
      stage: "event",
      percent: 12,
      details: "正在创建 MemoryEvent"
    });

    await runTask("事件到数据湖、时间轴、长期记忆、短期记忆流程已完成", async () => {
      setMemoryProgress({
        label: "解析为数据湖",
        stage: "data_lake",
        percent: 38,
        details: "正在解析文本并生成事实"
      });
      const response = await fetchWithTimeout("/context/debug/manual-flow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: draft.content,
          eventType: "solution_memory_flow_event",
          description: "手动触发方案流程：事件到数据湖、时间轴聚合、长期记忆、短期记忆。",
          sourceId: draft.source,
          eventTime: draftEventTime,
          visibility: draft.visibility,
          customFields,
          llm: buildLlmPayload(llmSettings)
        })
      }, 60_000);
      const data = (await response.json()) as { result?: ManualMemoryFlowResult; error?: string };
      if (!response.ok || !data.result) {
        throw new Error(data.error ?? "手动流程触发失败");
      }
      const result = data.result;
      const stages = buildProgressStages(result);
      setMemoryProgress(stages.at(-1) ?? null);
      setMemoryProgressSteps(
        stages.map((stage, index) => ({
          ...stage,
          status: index < stages.length - 1 ? "complete" : "active"
        }))
      );
      setManualFlow(result);
      setSelected(result);
      await refreshSnapshot();
      setActiveTab("timeline");
    });
  }

  async function runManualStep(action: ManualStepResult["action"]) {
    await runTask(translateManualStepSuccess(action), async () => {
      const customFields = parseDraftCustomFields(draft.customFields);
      const activeProgress = buildManualStepProgress(action);
      setMemoryProgress(activeProgress.current);
      setMemoryProgressSteps(activeProgress.steps);
      const needsDraftEvent = action !== "ltm";
      const trackedEventId = needsDraftEvent
        ? manualStepEventId || `manual_step_${action}_${Date.now()}_${Math.random().toString(16).slice(2)}`
        : "";
      if (trackedEventId) setManualStepEventId(trackedEventId);
      const response = await fetchWithTimeout("/context/debug/manual-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          ...(needsDraftEvent
            ? {
                eventId: trackedEventId,
                content: draft.content,
                eventType: draft.eventType,
                description: draft.description,
                sourceId: draft.source,
                eventTime: parseDraftEventTime(draft.eventTime),
                visibility: draft.visibility,
                customFields
              }
            : {}),
          llm: buildLlmPayload(llmSettings)
        })
      }, 60_000).catch(async (error) => {
        if (trackedEventId && isAbortTimeoutError(error)) {
          await recoverManualStepAfterTimeout(action, trackedEventId, error.message);
          throw new ManualStepRecoveredAfterTimeoutError(error.message);
        }
        throw error;
      });
      const data = (await response.json()) as { result?: ManualStepResult; error?: string };
      if (!response.ok || !data.result) {
        throw new Error(data.error ?? "分步触发失败");
      }
      setManualStep(data.result);
      setManualStepEventId(data.result.event?.eventId ?? "");
      setSelected(data.result);
      await refreshSnapshot();
      const completedProgress = buildManualStepProgress(action, true);
      setMemoryProgress(completedProgress.current);
      setMemoryProgressSteps(completedProgress.steps);
      if (action === "event" || action === "data_lake") setActiveTab("dataLake");
      if (action === "timeline_fusion") setActiveTab("timeline");
      if (action === "stm") setActiveTab("stm");
      if (action === "ltm") setActiveTab("ltm");
    });
  }

  async function promote(memory: ShortTermMemory) {
    await runTask("已提升为长期记忆", async () => {
      setLtmProgress(true, "正在将短期记忆提升为长期记忆");
      const response = await fetch(`/context/memories/stm/${memory.memoryDataId}/promote`, {
        method: "POST"
      });
      const data = await response.json();
      await refreshSnapshot();
      setSelected(data.result ?? data);
      setActiveTab("ltm");
      setLtmProgress(false, "长期记忆已更新");
    });
  }

  async function runDreaming(memory?: ShortTermMemory) {
    await runTask(memory ? "短期记忆已通过 LLM 做梦巩固" : "高价值短期记忆已通过 LLM 做梦巩固", async () => {
      setLtmProgress(true, "正在做梦并巩固长期记忆");
      const response = await fetch("/context/dreaming/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(memory ? { memoryDataIds: [memory.memoryDataId] } : {}),
          llm: buildLlmPayload(llmSettings)
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "LLM 做梦失败");
      }
      await refreshSnapshot();
      setSelected(data.result ?? data);
      setActiveTab("ltm");
      setLtmProgress(false, "长期记忆已更新");
    });
  }

  async function updateMemory(
    layer: "stm" | "ltm",
    id: string,
    body: Record<string, string | number>
  ) {
    await runTask("记忆已更新", async () => {
      const response = await fetch(`/context/memories/${layer}/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "记忆更新失败");
      }
      await refreshSnapshot();
      setSelected(data.result ?? data);
    });
  }

  async function deleteContextEvent(eventId: string) {
    const confirmed = window.confirm("确认删除这条上下文数据及其派生片段、事实、记忆、索引和 LLM trace？");
    if (!confirmed) return;

    await runTask("上下文数据已删除", async () => {
      const response = await fetch(`/context/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE"
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "上下文数据删除失败");
      }
      if (manualFlow?.event.eventId === eventId) {
        setManualFlow(null);
      }
      if (manualStep?.event?.eventId === eventId) {
        setManualStep(null);
        setManualStepEventId("");
      }
      await refreshSnapshot();
      setSelected(data.result ?? data);
    });
  }

  async function clearAllContextData() {
    const confirmed = window.confirm("确认一键清空所有上下文数据？这会删除事件、数据湖、事实、STM、LTM、索引、LLM trace 和上下文包 trace。");
    if (!confirmed) return;

    await runTask("上下文数据已清空", async () => {
      const response = await fetch("/context/debug/data", {
        method: "DELETE"
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "清空上下文数据失败");
      }
      setManualFlow(null);
      setManualStep(null);
      setManualStepEventId("");
      setFileBatch(null);
      setSelected(data.result ?? data);
      setSearchResults([]);
      setDataLakeResults([]);
      setContextPack(null);
      setBackgroundContext(null);
      await refreshSnapshot();
    });
  }

  async function search() {
    const params = new URLSearchParams({ q: query, layer: searchLayer });
    const response = await fetch(`/context/search?${params.toString()}`);
    const data = (await response.json()) as { results?: SearchResult[] };
    setSearchResults(data.results ?? []);
    setToast(`检索返回 ${(data.results ?? []).length} 条结果`);
  }

  async function searchDataLake() {
    await runTask("数据湖检索完成", async () => {
      const customFields = parseCustomFieldInput(dataLakeCustomFilters);
      if (!customFields.ok) {
        throw new Error(customFields.error);
      }
      const response = await fetch(buildDataLakeSearchUrl({
        q: dataLakeQuery,
        sourceApp: dataLakeSourceApp,
        sourceType: dataLakeSourceType,
        customFields: customFields.fields,
        customFieldExists: parseCustomFieldExistsText(dataLakeCustomExists)
      }));
      const data = (await response.json()) as {
        ok?: boolean;
        result?: {
          total: number;
          items: DataLakeSearchResult[];
        };
        error?: string;
      };
      if (!response.ok || !data.ok || !data.result) {
        throw new Error(data.error ?? "数据湖检索失败");
      }
      setDataLakeResults(data.result.items);
      setSelected(data.result);
    });
  }

  async function assemblePack() {
    await runTask("上下文包已组装", async () => {
      const response = await fetch("/context/assemble", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: packTask,
          q: query || packTask,
          layer: searchLayer,
          tokenBudget: packBudget,
          llmCompression: true
        })
      });
      const data = (await response.json()) as { result?: ContextPack; error?: string };
      if (!response.ok || !data.result) {
        throw new Error(data.error ?? "上下文组装失败");
      }
      setContextPack(data.result);
      setSelected(data.result);
      await refreshSnapshot();
    });
  }

  async function assembleLongMemEvalPack() {
    await runTask("Benchmark 上下文包预览已组装", async () => {
      const response = await fetch("/context/evaluations/longmemeval/context-pack-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          datasetPath: longMemEvalDatasetPath.trim(),
          questionId: longMemEvalPackQuestionId.trim(),
          task: packTask,
          q: query || packTask,
          layer: searchLayer,
          tokenBudget: packBudget,
          llmCompression: true,
          llm: buildLongMemEvalLlmPayload(longMemEvalLlmSettings).extraction
        })
      });
      const data = (await response.json()) as { ok?: boolean; result?: ContextPack; error?: string };
      if (!response.ok || !data.ok || !data.result) {
        throw new Error(data.error ?? "Benchmark 上下文包预览失败");
      }
      setPackTask(data.result.task);
      setLongMemEvalContextPack(data.result);
      setSelected(data.result);
    });
  }

  async function submitFeedback(
    targetType: MemoryFeedbackItem["targetType"],
    targetId: string,
    action: MemoryFeedbackItem["action"],
    note?: string
  ) {
    await runTask("反馈已提交", async () => {
      const response = await fetch("/context/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetType,
          targetId,
          action,
          ...(note ? { note } : {})
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "反馈提交失败");
      }
      await refreshSnapshot();
    });
  }

  async function runLongMemEval() {
    const startedAt = new Date().toISOString();
    setLongMemEvalRunState({ status: "queued", startedAt });
    await runTask("LongMemEval 评测已完成", async () => {
      const response = await requestLongMemEvalEvaluation(fetch, {
        datasetPath: longMemEvalDatasetPath.trim(),
        ks: longMemEvalKs
          .split(",")
          .map((item) => Number(item.trim()))
          .filter((item) => Number.isFinite(item) && item > 0),
        llm: buildLongMemEvalLlmPayload(longMemEvalLlmSettings),
        ingestSampleConcurrency: longMemEvalLlmSettings.ingestSampleConcurrency,
        ingestSessionConcurrency: longMemEvalLlmSettings.ingestSessionConcurrency,
        answerConcurrency: longMemEvalLlmSettings.answerConcurrency,
        judgeConcurrency: longMemEvalLlmSettings.judgeConcurrency,
        resultFileName: longMemEvalLlmSettings.resultFileName.trim() || "longmemeval-result.jsonl",
        ...(longMemEvalLlmSettings.traceFileName.trim() ? { traceFileName: longMemEvalLlmSettings.traceFileName.trim() } : {}),
        resume: longMemEvalLlmSettings.resume,
        retrySkipped: longMemEvalLlmSettings.retrySkipped,
        resumeLegacy: longMemEvalLlmSettings.resumeLegacy,
        enableLtmReinforcement: !longMemEvalLlmSettings.skipLtmDreaming && !longMemEvalLlmSettings.modelOnlyEvaluation,
        answerContextMode: longMemEvalLlmSettings.answerContextMode,
        disableIngestLlm: longMemEvalLlmSettings.disableIngestLlm,
        skipStmAdmission: longMemEvalLlmSettings.skipStmAdmission,
        skipLtmDreaming: longMemEvalLlmSettings.skipLtmDreaming,
        modelOnlyEvaluation: longMemEvalLlmSettings.modelOnlyEvaluation
      });
      if (!response.ok || !response.result?.jobId) {
        const error = response.error ?? "LongMemEval 评测失败";
        setLongMemEvalRunState({ status: "error", startedAt, finishedAt: new Date().toISOString(), error });
        throw new Error(error);
      }
      const jobId = response.result.jobId;
      setLongMemEvalRunState({
        status: response.result.status === "queued" ? "queued" : "running",
        jobId,
        startedAt,
        ...(typeof response.result.stage === "string" ? { stage: response.result.stage } : {}),
        ...(typeof response.result.progress === "number" ? { progress: response.result.progress } : {}),
        ...(typeof response.result.processedSamples === "number" ? { processedSamples: response.result.processedSamples } : {}),
        ...(typeof response.result.totalSamples === "number" ? { totalSamples: response.result.totalSamples } : {}),
        ...(typeof response.result.processedSessions === "number" ? { processedSessions: response.result.processedSessions } : {}),
        ...(typeof response.result.totalSessions === "number" ? { totalSessions: response.result.totalSessions } : {}),
        ...(typeof response.result.processedSteps === "number" ? { processedSteps: response.result.processedSteps } : {}),
        ...(typeof response.result.totalSteps === "number" ? { totalSteps: response.result.totalSteps } : {}),
        ...(typeof response.result.currentQuestionId === "string" ? { currentQuestionId: response.result.currentQuestionId } : {}),
        ...(typeof response.result.currentQuestionType === "string" ? { currentQuestionType: response.result.currentQuestionType } : {}),
        ...(typeof response.result.currentQuestion === "string" ? { currentQuestion: response.result.currentQuestion } : {}),
        ...(typeof response.result.currentSampleIndex === "number" ? { currentSampleIndex: response.result.currentSampleIndex } : {}),
        ...(typeof response.result.currentSampleCount === "number" ? { currentSampleCount: response.result.currentSampleCount } : {}),
        ...(typeof response.result.currentSessionIndex === "number" ? { currentSessionIndex: response.result.currentSessionIndex } : {}),
        ...(typeof response.result.currentSessionCount === "number" ? { currentSessionCount: response.result.currentSessionCount } : {}),
        ...(typeof response.result.currentSessionId === "string" ? { currentSessionId: response.result.currentSessionId } : {}),
        ...(typeof response.result.currentSessionDate === "string" ? { currentSessionDate: response.result.currentSessionDate } : {}),
        ...(typeof response.result.currentHypothesis === "string" ? { currentHypothesis: response.result.currentHypothesis } : {}),
        ...(typeof response.result.currentJudgment === "string" ? { currentJudgment: response.result.currentJudgment } : {}),
        ...(response.result.activeSamples ? { activeSamples: response.result.activeSamples } : {}),
        ...(response.result.resultPath ? { resultPath: response.result.resultPath } : {}),
        ...(response.result.tracePath ? { tracePath: response.result.tracePath } : {}),
        ...(response.result.resume !== undefined ? { resume: response.result.resume } : {}),
        ...(response.result.retrySkipped !== undefined ? { retrySkipped: response.result.retrySkipped } : {}),
        ...(response.result.resumedSamples !== undefined ? { resumedSamples: response.result.resumedSamples } : {}),
        ...(response.result.committedSamples !== undefined ? { committedSamples: response.result.committedSamples } : {}),
        ...(response.result.modelArtifacts ? { modelArtifacts: response.result.modelArtifacts } : {}),
        ...(response.result.effectiveConcurrency ? { effectiveConcurrency: response.result.effectiveConcurrency } : {}),
        ...(typeof response.result.ingestStage === "string" ? { ingestStage: response.result.ingestStage } : {}),
        ...(typeof response.result.stageProgress === "number" ? { stageProgress: response.result.stageProgress } : {}),
        ...(typeof response.result.stageMessage === "string" ? { stageMessage: response.result.stageMessage } : {}),
        ...(typeof response.result.batchIndex === "number" ? { batchIndex: response.result.batchIndex } : {}),
        ...(typeof response.result.batchCount === "number" ? { batchCount: response.result.batchCount } : {}),
        ...(typeof response.result.batchProgress === "number" ? { batchProgress: response.result.batchProgress } : {}),
        ...(typeof response.result.batchMessage === "string" ? { batchMessage: response.result.batchMessage } : {}),
        ...(response.result.llmRequest ? { llmRequest: response.result.llmRequest } : {}),
        ...(typeof response.result.fallbackReason === "string" ? { fallbackReason: response.result.fallbackReason } : {}),
        ...(response.result.fallbackTrace ? { fallbackTrace: response.result.fallbackTrace } : {}),
        ...(response.result.report ? { report: response.result.report } : {})
      });

      let consecutivePollFailures = 0;
      while (true) {
        await pause(800);
        const jobResponse = await requestLongMemEvalJob(fetch, jobId);
        if (!jobResponse.ok || !jobResponse.result) {
          const error = jobResponse.error ?? "LongMemEval 作业查询失败";
          consecutivePollFailures += 1;
          if (consecutivePollFailures >= 10) {
            setLongMemEvalRunState({ status: "error", jobId, startedAt, finishedAt: new Date().toISOString(), error });
            throw new Error(error);
          }
          setToast(`${error}，正在重新连接（${consecutivePollFailures}/10）`);
          continue;
        }
        if (consecutivePollFailures > 0) setToast("LongMemEval 状态连接已恢复");
        consecutivePollFailures = 0;
        const job = jobResponse.result;
        const liveModelRunId = job.modelArtifacts?.[0]?.modelRunId;
        const resultsResponse = await requestLongMemEvalJobResults(fetch, jobId, 1, 200, liveModelRunId);
        if (resultsResponse.ok && resultsResponse.result) {
          setLongMemEvalJsonlResult(resultsResponse.result);
          setLongMemEvalJsonlFileName(job.modelArtifacts?.[0]?.resultPath ?? job.resultPath ?? "longmemeval-result.jsonl");
          setLongMemEvalJsonlStatus("idle");
          setLongMemEvalJsonlError("");
        }
        setLongMemEvalRunState({
          status: job.status === "queued" ? "queued" : job.status === "running" ? "running" : job.status,
          jobId,
          startedAt,
          ...(typeof job.stage === "string" ? { stage: job.stage } : {}),
          ...(typeof job.progress === "number" ? { progress: job.progress } : {}),
          ...(typeof job.processedSamples === "number" ? { processedSamples: job.processedSamples } : {}),
          ...(typeof job.totalSamples === "number" ? { totalSamples: job.totalSamples } : {}),
          ...(typeof job.processedSessions === "number" ? { processedSessions: job.processedSessions } : {}),
          ...(typeof job.totalSessions === "number" ? { totalSessions: job.totalSessions } : {}),
          ...(typeof job.processedSteps === "number" ? { processedSteps: job.processedSteps } : {}),
          ...(typeof job.totalSteps === "number" ? { totalSteps: job.totalSteps } : {}),
          ...(typeof job.currentQuestionId === "string" ? { currentQuestionId: job.currentQuestionId } : {}),
          ...(typeof job.currentQuestionType === "string" ? { currentQuestionType: job.currentQuestionType } : {}),
          ...(typeof job.currentQuestion === "string" ? { currentQuestion: job.currentQuestion } : {}),
          ...(typeof job.currentSampleIndex === "number" ? { currentSampleIndex: job.currentSampleIndex } : {}),
          ...(typeof job.currentSampleCount === "number" ? { currentSampleCount: job.currentSampleCount } : {}),
          ...(typeof job.currentSessionIndex === "number" ? { currentSessionIndex: job.currentSessionIndex } : {}),
          ...(typeof job.currentSessionCount === "number" ? { currentSessionCount: job.currentSessionCount } : {}),
          ...(typeof job.currentSessionId === "string" ? { currentSessionId: job.currentSessionId } : {}),
          ...(typeof job.currentSessionDate === "string" ? { currentSessionDate: job.currentSessionDate } : {}),
          ...(typeof job.currentHypothesis === "string" ? { currentHypothesis: job.currentHypothesis } : {}),
          ...(typeof job.currentJudgment === "string" ? { currentJudgment: job.currentJudgment } : {}),
          ...(job.activeSamples ? { activeSamples: job.activeSamples } : {}),
          ...(job.resultPath ? { resultPath: job.resultPath } : {}),
          ...(job.tracePath ? { tracePath: job.tracePath } : {}),
          ...(job.resume !== undefined ? { resume: job.resume } : {}),
          ...(job.retrySkipped !== undefined ? { retrySkipped: job.retrySkipped } : {}),
          ...(job.resumedSamples !== undefined ? { resumedSamples: job.resumedSamples } : {}),
          ...(job.committedSamples !== undefined ? { committedSamples: job.committedSamples } : {}),
          ...(job.modelArtifacts ? { modelArtifacts: job.modelArtifacts } : {}),
          ...(job.effectiveConcurrency ? { effectiveConcurrency: job.effectiveConcurrency } : {}),
          ...(typeof job.ingestStage === "string" ? { ingestStage: job.ingestStage } : {}),
          ...(typeof job.stageProgress === "number" ? { stageProgress: job.stageProgress } : {}),
          ...(typeof job.stageMessage === "string" ? { stageMessage: job.stageMessage } : {}),
          ...(typeof job.batchIndex === "number" ? { batchIndex: job.batchIndex } : {}),
          ...(typeof job.batchCount === "number" ? { batchCount: job.batchCount } : {}),
          ...(typeof job.batchProgress === "number" ? { batchProgress: job.batchProgress } : {}),
          ...(typeof job.batchMessage === "string" ? { batchMessage: job.batchMessage } : {}),
          ...(job.llmRequest ? { llmRequest: job.llmRequest } : {}),
          ...(typeof job.finishedAt === "string" ? { finishedAt: job.finishedAt } : {}),
          ...(typeof job.error === "string" ? { error: job.error } : {}),
          ...(typeof job.fallbackReason === "string" ? { fallbackReason: job.fallbackReason } : {}),
          ...(job.fallbackTrace ? { fallbackTrace: job.fallbackTrace } : {}),
          ...((job.report ?? response.result.report) ? { report: job.report ?? response.result.report } : {})
        });
        if (job.status === "done" && (job.report ?? response.result.report)) {
          const report = job.report ?? response.result.report!;
          setLongMemEvalReport(report);
          setSelected(report);
          break;
        }
        if (job.status === "cancelled") {
          throw new Error(job.error ?? "LongMemEval 评测已终止");
        }
        if (job.status === "error") {
          throw new Error(job.error ?? "LongMemEval 评测失败");
        }
      }
    });
  }

  async function cancelLongMemEval() {
    const jobId = longMemEvalRunState.jobId;
    if (!jobId || (longMemEvalRunState.status !== "running" && longMemEvalRunState.status !== "queued")) return;
    const response = await requestCancelLongMemEvalJob(fetch, jobId);
    if (!response.ok || !response.result) {
      setToast(response.error ?? "终止评测失败");
      return;
    }
    setLongMemEvalRunState({
      ...longMemEvalRunState,
      ...response.result,
      status: "cancelled",
      finishedAt: response.result.finishedAt ?? new Date().toISOString(),
      error: response.result.error ?? "LongMemEval 评测已终止"
    });
    setToast("LongMemEval 评测已终止");
  }

  async function clearLongMemEvalDatabase() {
    const confirmed = window.confirm("确认清除 LongMemEval 隔离数据库？这会删除 LongMemEval SQLite 存储；仅在配置为独立 neo4j 时清空 LongMemEval 图数据库。");
    if (!confirmed) return;

    await runTask("LongMemEval 数据库已清除", async () => {
      const response = await requestClearLongMemEvalDatabase(fetch);
      if (!response.ok || !response.result) {
        throw new Error(response.error ?? "LongMemEval 数据库清除失败");
      }
      setLongMemEvalReport(null);
      setLongMemEvalRunState({ status: "idle" });
      setLongMemEvalContextPack(null);
      setSelected(null);
      setLongMemEvalClearRevision((revision) => revision + 1);
      const deletedFiles = response.result.storage.deletedFiles.length;
      const graphMessage = response.result.graphStore.status === "cleared"
        ? `Neo4j ${response.result.graphStore.database ?? ""} 已清除`
        : `Neo4j 跳过：${response.result.graphStore.reason ?? response.result.graphStore.mode}`;
      setToast(`LongMemEval 数据库已清除：${deletedFiles} 个 SQLite 文件，${graphMessage}`);
    });
  }

  async function runTask(successMessage: string, task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
      setToast(successMessage);
    } catch (error) {
      if (error instanceof ManualStepRecoveredAfterTimeoutError) {
        setBusy(false);
        return;
      }
      const message = error instanceof Error ? error.message : "请求失败";
      setToast(message);
      setMemoryProgress((current) => current ? { ...current, details: message } : current);
      setMemoryProgressSteps((current) => current.map((step) =>
        step.status === "active" ? { ...step, status: "error", details: message } : step
      ));
    } finally {
      setBusy(false);
    }
  }

  async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`后端 ${Math.round(timeoutMs / 1000)} 秒未响应，可能卡在 LLM、Neo4j 或记忆流水线`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function isAbortTimeoutError(error: unknown) {
    return error instanceof Error && error.message.includes("秒未响应");
  }

  async function recoverManualStepAfterTimeout(
    action: ManualStepResult["action"],
    eventId: string,
    timeoutMessage: string
  ) {
    const response = await fetch("/context/debug/snapshot");
    const data = (await response.json()) as {
      ok?: boolean;
      items?: Snapshot;
      timeline?: TimelineItem[];
    };
    if (!data.ok || !data.items) {
      throw new Error(timeoutMessage);
    }

    setSnapshot(data.items);
    setTimeline(data.timeline ?? []);
    setBackgroundContext(data.items.backgroundDocuments.at(-1) ?? null);
    const status = inferManualStepStatusAfterTimeout(data.items, action, eventId, timeoutMessage);
    setMemoryProgress(status.current);
    setMemoryProgressSteps(status.steps);
    if (status.manualStep) setManualStep(status.manualStep);
    setSelected(status.selected);
    setActiveTab(action === "stm" ? "stm" : action === "timeline_fusion" ? "timeline" : action === "data_lake" || action === "event" ? "dataLake" : "ltm");
    setToast(status.toast);
    if (!status.terminal) {
      void pollManualStepResultAfterTimeout(action, eventId, timeoutMessage);
    }
  }

  async function pollManualStepResultAfterTimeout(
    action: ManualStepResult["action"],
    eventId: string,
    timeoutMessage: string
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10 * 60_000) {
      await pause(2_000);
      const response = await fetch("/context/debug/snapshot");
      const data = (await response.json()) as {
        ok?: boolean;
        items?: Snapshot;
        timeline?: TimelineItem[];
      };
      if (!data.ok || !data.items) continue;

      setSnapshot(data.items);
      setTimeline(data.timeline ?? []);
      setBackgroundContext(data.items.backgroundDocuments.at(-1) ?? null);
      const status = inferManualStepStatusAfterTimeout(data.items, action, eventId, timeoutMessage);
      setMemoryProgress(status.current);
      setMemoryProgressSteps(status.steps);
      if (status.manualStep) setManualStep(status.manualStep);
      setSelected(status.selected);
      if (status.terminal) {
        setToast(status.toast);
        return;
      }
    }

    setToast(`后台仍未结束，可用事件 ${eventId} 继续刷新快照查看`);
    setMemoryProgress((current) => current ? {
      ...current,
      details: `后台仍未结束，可用事件 ${eventId} 继续刷新快照查看`
    } : current);
  }

  async function pause(ms: number) {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }

	  function applyTemplate(source: EventDraft["source"]) {
	    setDraft({
	      source,
	      eventTime: draft.eventTime,
	      visibility: draft.visibility,
	      ...sourceTemplates[source],
	      customFields: ""
	    });
	  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">上下文引擎调试</p>
          <h1>记忆操作台</h1>
        </div>
        <div className="top-actions">
          <span className={`health ${health === "正常" ? "health-ok" : "health-error"}`}>{health}</span>
          <button onClick={scanFiles} disabled={busy} type="button">扫描文件</button>
          <button onClick={refreshSnapshot} disabled={busy} type="button">刷新</button>
          <button className="danger-button" onClick={clearAllContextData} disabled={busy} type="button">
            一键清空
          </button>
        </div>
      </header>

      <section className="metric-strip" aria-label="上下文引擎指标">
        {stats.map((item) => (
          <div className="metric" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
        <div className="metric metric-wide">
          <span>状态</span>
          <strong>{toast}</strong>
        </div>
      </section>

      <section className="workspace">
        <aside className="event-panel">
          <div className="panel-header">
            <h2>写入事件</h2>
            <span>PRD / 方案</span>
          </div>
          <div className="segmented">
            {writableEventTemplates.map((template) => (
              <button
                className={draft.source === template.source ? "active" : ""}
                key={template.source}
                onClick={() => applyTemplate(template.source)}
                type="button"
              >
                {template.source === "manual" ? "手动" : template.source}
              </button>
            ))}
          </div>
          <section className="supported-events" aria-label="支持写入的事件">
            <div className="panel-header">
              <h3>支持写入的事件</h3>
              <span>{writableEventTemplates.length} 类</span>
            </div>
            {writableEventTemplates.map((template) => (
              <button
                className={`supported-event ${draft.source === template.source ? "active" : ""}`}
                key={template.eventType}
                onClick={() => applyTemplate(template.source)}
                type="button"
              >
                <span>
                  <strong>{template.title}</strong>
                  <small>{template.eventType}</small>
                </span>
                <span className="event-meta">
                  {template.modality} / {template.writePath}
                </span>
              </button>
            ))}
          </section>
          <label>
            事件类型
            <input
              value={draft.eventType}
              onChange={(event) => setDraft({ ...draft, eventType: event.target.value })}
            />
          </label>
          <label>
            事件概要
            <input
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label>
            内容 JSON
            <textarea
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              placeholder='{"text":"记忆正文","project":"ospx-new"}'
              rows={8}
            />
          </label>
          <label>
            事件时间
            <input
              type="datetime-local"
              value={draft.eventTime}
              onChange={(event) => setDraft({ ...draft, eventTime: event.target.value })}
            />
          </label>
          <label>
            可见性
            <select
              value={draft.visibility}
              onChange={(event) => setDraft({ ...draft, visibility: event.target.value as Visibility })}
            >
              <option value="private">私有</option>
              <option value="team">团队</option>
              <option value="tenant">租户</option>
              <option value="public">公开</option>
            </select>
          </label>
          <section className="llm-config" aria-label="LLM 事实融合配置">
            <div className="panel-header">
              <h3>LLM 事实融合</h3>
              <span>{llmConfigured ? "已保存到后端" : "未保存"}</span>
            </div>
            <label>
              模型
              <input
                value={llmSettings.model}
                onChange={(event) => setLlmSettings({ ...llmSettings, model: event.target.value })}
                placeholder="gpt-4o-mini"
              />
            </label>
            <label>
              端点
              <input
                value={llmSettings.baseUrl}
                onChange={(event) => setLlmSettings({ ...llmSettings, baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label>
              API Key
              <input
                value={llmSettings.apiKey}
                onChange={(event) => setLlmSettings({ ...llmSettings, apiKey: event.target.value })}
                placeholder={llmConfigured ? "留空则保留后端已保存的 key" : "输入后保存到后端"}
                type="password"
              />
            </label>
            <div className="llm-actions">
              <button className="secondary-action" onClick={saveLlmConfig} disabled={busy} type="button">
                保存 LLM 配置
              </button>
              <button className="secondary-action" onClick={testLlmConfig} disabled={busy || llmTestState.status === "testing"} type="button">
                测试调用
              </button>
            </div>
            {llmTestState.status !== "idle" ? (
              <div className={`llm-test-status ${llmTestState.status}`} aria-live="polite">
                <strong>{llmTestState.status === "testing" ? "测试中" : llmTestState.status === "ok" ? "调用正常" : "调用失败"}</strong>
                <span>{llmTestState.message ?? ""}{typeof llmTestState.elapsedMs === "number" ? ` · ${llmTestState.elapsedMs}ms` : ""}</span>
              </div>
            ) : null}
          </section>
          <button className="primary" onClick={writeDraftEvent} disabled={busy || !draft.content.trim()} type="button">
            写入记忆事件
          </button>
          <section className="manual-step-panel" aria-label="原始文本到 LTM 分步触发">
            <div className="panel-header">
              <h3>原始文本到 LTM</h3>
              <span>{manualStepEventId ? "最近事件" : "独立触发"}</span>
            </div>
            {memoryProgress ? (
              <div className="memory-progress-panel" aria-live="polite">
                <div className="panel-header compact">
                  <strong>{memoryProgress.label}</strong>
                  <span>{memoryProgress.percent}%</span>
                </div>
                <div className="batch-progress-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, Math.min(100, memoryProgress.percent))}%` }} />
                </div>
                <div className="batch-stats">
                  <span>{translateMemoryProgressStage(memoryProgress.stage)}</span>
                  <span>{memoryProgress.details}</span>
                </div>
              </div>
            ) : null}
            {manualStepEventId ? (
              <button className="step-event-id" onClick={() => setSelected({ eventId: manualStepEventId, manualStep })} type="button">
                {manualStepEventId}
              </button>
            ) : null}
            <div className="manual-step-grid">
              <button onClick={() => runManualStep("event")} disabled={busy || !draft.content.trim()} type="button">
                1 原始文本
              </button>
              <button onClick={() => runManualStep("data_lake")} disabled={busy || !draft.content.trim()} type="button">
                2 数据湖
              </button>
              <button onClick={() => runManualStep("timeline_fusion")} disabled={busy || !draft.content.trim()} type="button">
                3 时间轴融合
              </button>
              <button onClick={() => runManualStep("stm")} disabled={busy || !draft.content.trim()} type="button">
                4 STM
              </button>
              <button onClick={() => runManualStep("ltm")} disabled={busy} type="button">
                5 LTM 做梦
              </button>
            </div>
          </section>
          <button className="secondary-action" onClick={runManualFlow} disabled={busy || !draft.content.trim()} type="button">
            手动触发完整流程
          </button>
        </aside>

        <section className="main-panel">
          <nav className="tabs" aria-label="调试视图">
            {[
              ["dataLake", "数据湖"],
              ["timeline", "时间轴融合"],
              ["stm", "STM 短期记忆"],
              ["ltm", "LTM 长期记忆"],
              ["dreaming", "Dreaming"],
              ["graph", "图节点"],
              ["search", "检索 / 更新"],
              ["pack", "上下文包"],
              ["background", "背景上下文"],
              ["feedback", "反馈"],
              ["metrics", "指标"],
              ["longMemEval", "评测"]
            ].map(([id, label]) => (
              <button
                className={activeTab === id ? "active" : ""}
                key={id}
                onClick={() => setActiveTab(id as Tab)}
                type="button"
              >
                {label}
              </button>
            ))}
          </nav>

          {memoryProgress ? (
            <section className="memory-progress-panel main-flow-panel" aria-live="polite">
              <div className="panel-header">
                <h2>{memoryProgress.label}</h2>
                <span>{memoryProgress.percent}%</span>
              </div>
              <div className="batch-progress-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(100, memoryProgress.percent))}%` }} />
              </div>
              <div className="batch-stats">
                <span>{translateMemoryProgressStage(memoryProgress.stage)}</span>
                <span>{memoryProgress.details}</span>
              </div>
              {memoryProgressSteps.length ? (
                <div className="stage-list">
                  {memoryProgressSteps.map((step) => (
                    <div className="stage-row" key={`${step.stage}:${step.label}`}>
                      <span>
                        <strong>{step.label}</strong>
                        <small>{step.details}</small>
                      </span>
                      <span className="stage-meta">
                        {step.percent}% / {translateValue(step.status)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {activeTab === "timeline" ? (
            <TimelineView
              fileBatch={fileBatch}
              memoryProgress={memoryProgress}
              timeline={timeline}
              manualFlow={manualFlow}
              manualStep={manualStep}
              onDeleteEvent={deleteContextEvent}
              onSelect={setSelected}
            />
          ) : null}
          {activeTab === "dataLake" ? (
            <DataLakeView
              snapshot={snapshot}
              searchQuery={dataLakeQuery}
              sourceAppFilter={dataLakeSourceApp}
              sourceTypeFilter={dataLakeSourceType}
              customFieldFilters={dataLakeCustomFilters}
              customFieldExists={dataLakeCustomExists}
              searchResults={dataLakeResults}
              onCustomFieldExistsChange={setDataLakeCustomExists}
              onCustomFieldFiltersChange={setDataLakeCustomFilters}
              onDeleteEvent={deleteContextEvent}
              onSearch={searchDataLake}
              onSearchQueryChange={setDataLakeQuery}
              onSelect={setSelected}
              onSourceAppFilterChange={setDataLakeSourceApp}
              onSourceTypeFilterChange={setDataLakeSourceType}
            />
          ) : null}
          {activeTab === "stm" ? (
            <ShortTermView
              memories={snapshot.shortTermMemories}
              onDream={runDreaming}
              onPromote={promote}
              onSelect={setSelected}
              onUpdate={updateMemory}
            />
          ) : null}
          {activeTab === "ltm" ? (
            <LongTermView
              memories={snapshot.longTermMemories}
              traces={snapshot.llmDreamingTraces}
              onSelect={setSelected}
              onUpdate={updateMemory}
            />
          ) : null}
          {activeTab === "dreaming" ? (
            <DreamingConsole shortTermMemories={snapshot.shortTermMemories} />
          ) : null}
          {activeTab === "graph" ? (
            <GraphView nodes={snapshot.graphMemoryNodes} onSelect={setSelected} />
          ) : null}
          {activeTab === "search" ? (
            <SearchView
              query={query}
              layer={searchLayer}
              results={searchResults}
              onQueryChange={setQuery}
              onLayerChange={setSearchLayer}
              onSearch={search}
              onSelect={setSelected}
            />
          ) : null}
          {activeTab === "pack" ? (
            <ContextPackView
              task={packTask}
              budget={packBudget}
              pack={contextPack}
              traces={snapshot.packTraces}
              onTaskChange={setPackTask}
              onBudgetChange={setPackBudget}
              onAssemble={assemblePack}
              onSelect={setSelected}
            />
          ) : null}
          {activeTab === "background" ? (
            <BackgroundView
              background={backgroundContext}
              onRefresh={refreshBackgroundContext}
              onSelect={setSelected}
            />
          ) : null}
          {activeTab === "feedback" ? (
            <FeedbackView
              feedbackItems={snapshot.feedbackItems}
              changeEvents={snapshot.changeEvents}
              onSubmitFeedback={submitFeedback}
              onSelect={setSelected}
            />
          ) : null}
          {activeTab === "longMemEval" || activeTab === "metrics" ? (
            <MetricsView
              snapshot={snapshot}
              longMemEvalDatasetPath={longMemEvalDatasetPath}
              longMemEvalPackQuestionId={longMemEvalPackQuestionId}
              longMemEvalJsonlFileName={longMemEvalJsonlFileName}
              longMemEvalJsonlText={longMemEvalJsonlText}
              longMemEvalJsonlPage={longMemEvalJsonlPage}
              longMemEvalJsonlResult={longMemEvalJsonlResult}
              longMemEvalJsonlStatus={longMemEvalJsonlStatus}
              longMemEvalJsonlError={longMemEvalJsonlError}
              longMemEvalKs={longMemEvalKs}
              longMemEvalReport={longMemEvalReport}
              longMemEvalRunState={longMemEvalRunState}
              longMemEvalLlmSettings={longMemEvalLlmSettings}
              longMemEvalLlmTestState={longMemEvalLlmTestState}
              longMemEvalContextPack={longMemEvalContextPack}
              longMemEvalClearRevision={longMemEvalClearRevision}
              packTask={packTask}
              packBudget={packBudget}
              onLongMemEvalLlmSettingsChange={setLongMemEvalLlmSettings}
              onDatasetPathChange={setLongMemEvalDatasetPath}
              onPackQuestionIdChange={setLongMemEvalPackQuestionId}
              onJsonlFileNameChange={setLongMemEvalJsonlFileName}
              onJsonlTextChange={setLongMemEvalJsonlText}
              onJsonlPageChange={setLongMemEvalJsonlPage}
              onJsonlResultChange={setLongMemEvalJsonlResult}
              onJsonlStatusChange={setLongMemEvalJsonlStatus}
              onJsonlErrorChange={setLongMemEvalJsonlError}
              onKsChange={setLongMemEvalKs}
              onPackTaskChange={setPackTask}
              onPackBudgetChange={setPackBudget}
              onAssembleLongMemEvalPack={assembleLongMemEvalPack}
              onRunLongMemEval={runLongMemEval}
              onCancelLongMemEval={cancelLongMemEval}
              onClearLongMemEvalDatabase={clearLongMemEvalDatabase}
              onSelect={setSelected}
              onToastChange={setToast}
              onTestLongMemEvalLlm={testLongMemEvalLlmConfig}
            />
          ) : null}
        </section>

        <aside className="detail-panel">
          <div className="panel-header">
            <h2>检查器</h2>
            <span>{selected ? "已选择" : "空闲"}</span>
          </div>
          {selected ? (
            <div className="inspector-stack">
              {isInspectableMemory(selected) || isInspectableGraphMemory(selected) ? <MemoryInspectorSummary item={selected} /> : null}
              {typeof selected === "object" && selected && "selectedItemDetails" in selected ? (
                <div className="data-lake-panel">
                  <div className="panel-header compact">
                    <h3>选中项详情</h3>
                    <span>{Array.isArray((selected as { selectedItemDetails?: unknown[] }).selectedItemDetails) ? (selected as { selectedItemDetails: unknown[] }).selectedItemDetails.length : 0} 条</span>
                  </div>
                  {Array.isArray((selected as { selectedItemDetails?: Array<{ id: string; layer: string; content: string; summary?: string; compressedContent?: string; metadata: Record<string, unknown> }> }).selectedItemDetails)
                    ? (selected as { selectedItemDetails: Array<{ id: string; layer: string; content: string; summary?: string; compressedContent?: string; metadata: Record<string, unknown> }> }).selectedItemDetails.map((detail) => (
                        <section className="jsonl-reason-group" key={`${detail.layer}:${detail.id}`}>
                          <div className="panel-header compact">
                            <strong>{detail.layer}:{detail.id}</strong>
                          </div>
                          <div className="empty-state small">原文</div>
                          <pre>{detail.content}</pre>
                          <div className="empty-state small">摘要</div>
                          <pre>{detail.summary ?? detail.compressedContent ?? "n/a"}</pre>
                          <div className="empty-state small">元数据</div>
                          <pre>{JSON.stringify(detail.metadata, null, 2)}</pre>
                        </section>
                      ))
                    : null}
                  {typeof selected === "object" && selected && "missingItemIds" in selected ? (
                    <div className="empty-state small">
                      缺失：{preview((selected as { missingItemIds?: string[] }).missingItemIds?.join(" · ") ?? "无", 220)}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <pre>{JSON.stringify(selected, null, 2)}</pre>
              {selected && typeof selected === "object" && "sourceEventIds" in selected ? (
                <div className="empty-state small">
                  来源事件: {(selected as { sourceEventIds?: string[] }).sourceEventIds?.join(" · ") ?? "无"}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="empty-state">选择一个事件、记忆或检索结果查看详情。</div>
          )}
        </aside>
      </section>
    </main>
  );
}

function TimelineView({
  fileBatch,
  memoryProgress,
  timeline,
  manualFlow,
  manualStep,
  onDeleteEvent,
  onSelect
}: {
  fileBatch: FileIngestionBatchProgress | null;
  memoryProgress: MemoryIngestionProgressState | null;
  timeline: TimelineItem[];
  manualFlow: ManualMemoryFlowResult | null;
  manualStep: ManualStepResult | null;
  onDeleteEvent: (eventId: string) => void;
  onSelect: (item: unknown) => void;
}) {
  if (!timeline.length && !manualFlow && !manualStep && !fileBatch) {
    return <div className="empty-state">写入 PRD 或方案事件后，即可查看按事实聚合的时间轴。</div>;
  }

  return (
    <div className="timeline">
      {fileBatch ? (
        <article className="manual-flow-card">
          <div className="panel-header">
            <h2>文件摄入批次</h2>
            <span>{fileBatch.progress}%</span>
          </div>
          <div className="batch-summary">
            <div className="batch-progress-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, fileBatch.progress))}%` }} />
            </div>
            <div className="batch-stats">
              <span>已处理 {fileBatch.processed} / {fileBatch.total}</span>
              <span>记住 {fileBatch.remembered}</span>
              <span>失败 {fileBatch.failed}</span>
            </div>
          </div>
          <div className="stage-list">
            {fileBatch.items.map((item) => (
              <button className="stage-row" key={`${item.eventId}:${item.path}`} onClick={() => onSelect(item)} type="button">
                <span>
                  <strong>{item.path}</strong>
                  <small>{translateValue(item.currentStage)} / {translateValue(item.status)}</small>
                </span>
                <span className="stage-meta">
                  {item.progress}% / {item.completedStages.join(" · ")}
                </span>
              </button>
            ))}
          </div>
        </article>
      ) : null}
      {manualStep ? (
        <article className="manual-flow-card">
          <div className="panel-header">
            <h2>分步流程结果</h2>
            <span>{translateValue(manualStep.action)}</span>
          </div>
          <div className="flow flow-wide">
            <button className="flow-node interactive" onClick={() => onSelect(manualStep.event)} type="button">
              <span>事件</span>
              <strong>{manualStep.event?.eventType ?? "系统 STM"}</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualStep.parsedSegments)} type="button">
              <span>数据湖</span>
              <strong>{manualStep.parsedSegments.length} 片段</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualStep.facts)} type="button">
              <span>时间轴融合</span>
              <strong>{manualStep.facts.length} 抽取结果</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualStep.shortTermMemory ?? manualStep.task)} type="button">
              <span>STM</span>
              <strong>{manualStep.shortTermMemory?.memoryDataId ?? `${manualStep.ltmResult?.trace.sourceMemoryDataIds.length ?? 0} 条候选`}</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualStep.ltmResult ?? manualStep.changeEvents)} type="button">
              <span>LTM</span>
              <strong>{manualStep.ltmResult?.longTermMemories.length ?? 0} 条</strong>
            </button>
          </div>
        </article>
      ) : null}
      {manualFlow ? (
        <article className="manual-flow-card">
          <div className="panel-header">
            <h2>手动流程结果</h2>
            <button className="danger-button" onClick={() => onDeleteEvent(manualFlow.event.eventId)} type="button">
              删除上下文
            </button>
          </div>
          <div className="flow flow-wide">
            <button className="flow-node interactive" onClick={() => onSelect(manualFlow.timelineAggregation)} type="button">
              <span>时间轴事实</span>
              <strong>{manualFlow.timelineAggregation.aggregatedFacts.length} 条聚合事实</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualFlow.event)} type="button">
              <span>来源事件</span>
              <strong>{manualFlow.event.eventType}</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualFlow.dataLake)} type="button">
              <span>数据湖</span>
              <strong>{manualFlow.dataLake.parsedSegments} 片段 / {manualFlow.dataLake.facts} 抽取结果</strong>
            </button>
            <button
              className="flow-node interactive"
              onClick={() => onSelect(manualFlow.llmFactFusionTrace ?? manualFlow.dataLake)}
              type="button"
            >
              <span>LLM 融合</span>
              <strong>{manualFlow.llmFactFusionTrace?.fallbackReason ?? manualFlow.llmFactFusionTrace?.model ?? "未生成"}</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualFlow.timelineAggregation)} type="button">
              <span>时间轴聚合</span>
              <strong>{manualFlow.timelineAggregation.aggregatedFacts.length} 条聚合事实</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualFlow.longTermMemory)} type="button">
              <span>长期记忆</span>
              <strong>{manualFlow.longTermMemory.memoryId}</strong>
            </button>
            <button className="flow-node interactive" onClick={() => onSelect(manualFlow.shortTermMemory)} type="button">
              <span>短期记忆</span>
              <strong>{manualFlow.shortTermMemory.memoryDataId}</strong>
            </button>
          </div>
          <div className="stage-list">
            {manualFlow.stages.map((stage) => (
              <button
                className="stage-row"
                key={`${stage.stage}:${stage.status}:${stage.at}`}
                onClick={() => onSelect(stage)}
                type="button"
              >
                <span>
                  <strong>{translateValue(stage.stage)}</strong>
                  <small>{stage.message}</small>
                </span>
                <span className="stage-meta">
                  {translateValue(stage.status)} / {formatTime(stage.at)}
                </span>
              </button>
            ))}
          </div>
          <section className="data-lake-panel">
            <div className="panel-header">
              <h2>数据湖证据</h2>
              <span>{manualFlow.dataLake.parsedSegments} 片段 / {manualFlow.dataLake.facts} 抽取结果</span>
            </div>
            <div className="data-lake-grid">
              <div>
                <h3>解析片段</h3>
                <div className="evidence-list">
                  {manualFlow.dataLake.segments.map((segment) => (
                    <button
                      className="evidence-row"
                      key={segment.segmentId}
                      onClick={() => onSelect(segment)}
                      type="button"
                    >
                      <span className="row-kicker">
                        {translateValue(segment.modality)} / {translateValue(segment.status)} / {translateValue(segment.confidence)}
                      </span>
                      <strong>{preview(segment.content, 140)}</strong>
                    </button>
                  ))}
                  {!manualFlow.dataLake.segments.length ? <div className="empty-state small">暂无解析片段。</div> : null}
                </div>
              </div>
              <div>
                <h3>抽取结果</h3>
                <div className="evidence-list">
                  {manualFlow.dataLake.factItems.map((fact) => (
                    <button
                      className="evidence-row"
                      key={fact.factId}
                      onClick={() => onSelect(fact)}
                      type="button"
                    >
                      <span className="row-kicker">
                        {translateValue(fact.status)} / {translateValue(fact.confidenceLevel)}
                      </span>
                      <strong>{preview(fact.factText, 140)}</strong>
                      <span>{fact.sourceEventIds.length} 个事件 / {fact.sourceSegmentIds.length} 个片段</span>
                    </button>
                  ))}
                  {!manualFlow.dataLake.factItems.length ? <div className="empty-state small">暂无抽取结果。</div> : null}
                </div>
              </div>
            </div>
            <div className="source-ref-strip">
              {manualFlow.dataLake.sourceRefs.map((source) => (
                <button className="source-ref" key={source.sourceRefId} onClick={() => onSelect(source)} type="button">
                  {source.sourceType}:{source.sourceId}
                </button>
              ))}
            </div>
          </section>
          {manualFlow.timelineAggregation.aggregatedFacts.length ? (
            <section className="data-lake-panel">
              <div className="panel-header">
                <h2>跨事件时间轴</h2>
                <span>{manualFlow.timelineAggregation.aggregatedFacts.length} 条</span>
              </div>
              <div className="evidence-list">
                {manualFlow.timelineAggregation.aggregatedFacts.map((fact) => (
                  <button className="evidence-row" key={fact.aggregationId} onClick={() => onSelect(fact)} type="button">
                    <span className="row-kicker">
                      {fact.sourceEventIds.length} 个来源事件 / {fact.sourceSegmentIds.length} 个片段 / {formatTime(fact.validTimeStart)}
                    </span>
                    <strong>{preview(fact.factText, 140)}</strong>
                    <span>{previewTimelineSources(fact.sourceEventIds, manualFlow.event ? [manualFlow.event] : [], [], 160)}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <p>{preview(manualFlow.timelineAggregation.summary, 260)}</p>
        </article>
      ) : null}
      {timeline.map((item) => (
        <article className="timeline-row" key={item.fact.aggregationId} onClick={() => onSelect(item)}>
          <div className="time-rail">
            <span>{formatTime(item.fact.validTimeStart)}</span>
          </div>
          <div className="timeline-body">
            <div className="row-kicker timeline-fact-kicker">
              <span>时间轴事实</span>
              <span>{item.fact.factType}</span>
              <span>{item.fact.sourceEventIds.length} 个来源事件</span>
            </div>
            <div className="row-title">
              <h3>{item.fact.factText}</h3>
              <div className="row-meta">
                <StatusBadge label={item.fact.timeConfidence} />
                <button
                  className="danger-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteEvent(item.fact.sourceEventIds[0] ?? item.fact.factId);
                  }}
                  type="button"
                >
                  删除上下文
                </button>
              </div>
            </div>
            <p>{preview(`${item.fact.factType} · ${item.fact.normalizedClaim}`, 220)}</p>
            <div className="flow">
              <FlowNode label="来源事件" value={String(item.sourceEvents.length)} />
              <FlowNode label="来源片段" value={String(item.sourceSegments.length)} />
              <FlowNode label="短期" value={String(item.shortTermMemories.length)} />
              <FlowNode label="任务" value={String(item.pipelineTasks?.length ?? 0)} />
            </div>
            {item.sourceEvents.length ? (
              <div className="timeline-aggregation-list">
                <button className="timeline-aggregation-row" onClick={(event) => {
                  event.stopPropagation();
                  onSelect(item.sourceEvents);
                }} type="button">
                  <span className="row-kicker">
                    {item.sourceEvents.length} 个来源事件
                  </span>
                  <strong>{previewTimelineSources(item.fact.sourceEventIds, item.sourceEvents, item.sourceSegments, 180)}</strong>
                  <span>{preview(item.sourceEvents.map(formatTimelineEventSource).join(" · "), 180)}</span>
                </button>
                <div className="timeline-aggregation-row timeline-segment-group">
                  <button className="timeline-segment-group-header" onClick={(event) => {
                    event.stopPropagation();
                    onSelect(item.sourceSegments);
                  }} type="button">
                    <span className="row-kicker">
                      {item.sourceSegments.length} 个片段
                    </span>
                    <strong>查看全部来源片段</strong>
                  </button>
                  <div className="timeline-segment-list">
                    {item.sourceSegments.map((segment, index) => (
                      <button
                        className="timeline-segment-row"
                        key={segment.segmentId}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(segment);
                        }}
                        type="button"
                      >
                        <span className="row-kicker">
                          片段 {index + 1} / {translateValue(segment.modality)} / {translateValue(segment.confidence)}
                        </span>
                        <strong>{preview(segment.content, 180)}</strong>
                      </button>
                    ))}
                    {!item.sourceSegments.length ? <span className="empty-state small">暂无片段内容。</span> : null}
                  </div>
                </div>
                <button className="timeline-aggregation-row" onClick={(event) => {
                  event.stopPropagation();
                  onSelect(item.fact);
                }} type="button">
                  <span className="row-kicker">
                    聚合事实 / {formatTime(item.fact.validTimeStart)}
                  </span>
                  <strong>{preview(item.fact.factText, 140)}</strong>
                  <span>{preview(item.fact.normalizedClaim, 180)}</span>
                </button>
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function DataLakeView({
  snapshot,
  searchQuery,
  sourceAppFilter,
  sourceTypeFilter,
  customFieldFilters,
  customFieldExists,
  searchResults,
  onCustomFieldExistsChange,
  onCustomFieldFiltersChange,
  onDeleteEvent,
  onSearch,
  onSearchQueryChange,
  onSelect,
  onSourceAppFilterChange,
  onSourceTypeFilterChange
}: {
  snapshot: Snapshot;
  searchQuery: string;
  sourceAppFilter: string;
  sourceTypeFilter: string;
  customFieldFilters: string;
  customFieldExists: string;
  searchResults: DataLakeSearchResult[];
  onCustomFieldExistsChange: (value: string) => void;
  onCustomFieldFiltersChange: (value: string) => void;
  onDeleteEvent: (eventId: string) => void;
  onSearch: () => void;
  onSearchQueryChange: (value: string) => void;
  onSelect: (item: unknown) => void;
  onSourceAppFilterChange: (value: string) => void;
  onSourceTypeFilterChange: (value: string) => void;
}) {
  const sourceRefs = snapshot.memoryEvents.flatMap((event) => event.sourceRefs ?? []);

  return (
    <div className="data-lake-view">
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>按字段检索</h2>
          <span>{searchResults.length} 条结果</span>
        </div>
        <div className="data-lake-search-controls">
          <label>
            关键词
            <input
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder="片段或事实内容"
              value={searchQuery}
            />
          </label>
          <label>
            来源应用
            <input
              onChange={(event) => onSourceAppFilterChange(event.target.value)}
              placeholder="notion / slack"
              value={sourceAppFilter}
            />
          </label>
          <label>
            来源类型
            <input
              onChange={(event) => onSourceTypeFilterChange(event.target.value)}
              placeholder="document / message"
              value={sourceTypeFilter}
            />
          </label>
          <label>
            字段值匹配
            <textarea
              onChange={(event) => onCustomFieldFiltersChange(event.target.value)}
              placeholder='{"project":"ospx-ff","task":{"id":"task-123"},"marker":"*"}'
              rows={4}
              value={customFieldFilters}
            />
          </label>
          <label>
            存在字段
            <textarea
              onChange={(event) => onCustomFieldExistsChange(event.target.value)}
              placeholder="project, task.owner"
              rows={4}
              value={customFieldExists}
            />
          </label>
          <button className="primary" onClick={onSearch} type="button">
            检索数据湖
          </button>
        </div>
        <div className="evidence-list">
          {searchResults.map((item) => (
            <button className="evidence-row" key={`${item.type}:${item.id}`} onClick={() => onSelect(item)} type="button">
              <span className="row-kicker">
                {translateValue(item.type)} / {translateValue(item.status)} / {item.dataSource?.sourceApp ?? "unknown"}
              </span>
              <strong>{preview(item.content, 160)}</strong>
              <CustomFieldBadges fields={item.customFields} />
            </button>
          ))}
          {!searchResults.length ? <div className="empty-state small">输入来源或 custom 字段后检索数据湖。</div> : null}
        </div>
      </section>
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>上下文事件</h2>
          <span>{snapshot.memoryEvents.length} 条</span>
        </div>
        {snapshot.memoryEvents.length ? (
          <div className="event-delete-list">
            {snapshot.memoryEvents.map((event) => (
              <article className="context-event-row" key={event.eventId}>
                <button className="row-main" onClick={() => onSelect(event)} type="button">
                  <span className="row-kicker">{formatTime(event.eventTime)} / {event.sourceId ?? event.sourceApp ?? event.eventType}</span>
                  <strong>{preview(formatContextEventTitle(event), 180)}</strong>
                </button>
                <button className="danger-button" onClick={() => onDeleteEvent(event.eventId)} type="button">
                  删除上下文
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state small">暂无上下文事件。</div>
        )}
      </section>
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>数据湖概览</h2>
          <span>
            {snapshot.parsedSegments.length} 片段 / {snapshot.facts.length} 事实 / {snapshot.llmFactFusionTraces.length} LLM
          </span>
        </div>
        <div className="data-lake-grid">
          <DataLakeColumn
            title="解析片段"
            emptyText="暂无解析片段。先写入事件或手动触发完整流程。"
            items={snapshot.parsedSegments}
            getKey={(segment) => segment.segmentId}
            getMeta={(segment) => `${translateValue(segment.modality)} / ${translateValue(segment.status)} / ${translateValue(segment.confidence)}`}
            getContent={(segment) => segment.content}
            getCustomFields={(segment) => segment.customFields}
            onSelect={onSelect}
          />
          <DataLakeColumn
            title="事实条目"
            emptyText="暂无事实条目。"
            items={snapshot.facts}
            getKey={(fact) => fact.factId}
            getMeta={(fact) => `${translateValue(fact.status)} / ${translateValue(fact.confidenceLevel)}`}
            getContent={(fact) => fact.factText}
            onSelect={onSelect}
          />
        </div>
        <div className="source-ref-strip">
          {sourceRefs.map((source) => (
            <button className="source-ref" key={source.sourceRefId} onClick={() => onSelect(source)} type="button">
              {source.sourceType}:{source.sourceId}
            </button>
          ))}
          {!sourceRefs.length ? <div className="empty-state small">暂无来源引用。</div> : null}
        </div>
      </section>
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>LLM 融合审计</h2>
          <span>prompt / result / fallback</span>
        </div>
        {snapshot.llmFactFusionTraces.length ? (
          <div className="llm-trace-list">
            {snapshot.llmFactFusionTraces.map((trace) => (
              <article className="llm-trace-card" key={trace.traceId}>
                <button className="trace-row" onClick={() => onSelect(trace)} type="button">
                  <strong>{trace.model} / {trace.keySource === "missing" ? "未配置 Key" : trace.keySource}</strong>
                  <span>
                    {trace.eventId} / {trace.fallbackReason ? `fallback: ${translateValue(trace.fallbackReason)}` : "LLM 输出已采用"}
                  </span>
                </button>
                <div className="prompt-result-grid">
                  <button className="prompt-box" onClick={() => onSelect({ traceId: trace.traceId, prompt: trace.prompt })} type="button">
                    <span className="row-kicker">提取 Prompt</span>
                    <pre className="full-audit-text">{formatAuditPayload(trace.prompt)}</pre>
                  </button>
                  <button className="prompt-box" onClick={() => onSelect({ traceId: trace.traceId, rawResponse: trace.rawResponse, parsedFacts: trace.parsedFacts })} type="button">
                    <span className="row-kicker">LLM 结果</span>
                    <pre className="full-audit-text">{formatAuditPayload(trace.rawResponse ?? trace.parsedFacts)}</pre>
                  </button>
                </div>
                <div className="source-ref-strip">
                  <span className="badge">{trace.alignedEvidence.length} 条时间对齐证据</span>
                  <span className="badge">{trace.parsedFacts.length} 条事实</span>
                  <span className="badge">{trace.endpoint}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state small">暂无 LLM 融合 trace。写入事件后会显示 prompt 和结果。</div>
        )}
      </section>
    </div>
  );
}

function DataLakeColumn<T>({
  title,
  emptyText,
  items,
  getKey,
  getMeta,
  getContent,
  getCustomFields,
  onSelect
}: {
  title: string;
  emptyText: string;
  items: T[];
  getKey: (item: T) => string;
  getMeta: (item: T) => string;
  getContent: (item: T) => string;
  getCustomFields?: (item: T) => Record<string, CustomFieldValue> | undefined;
  onSelect: (item: T) => void;
}) {
  return (
    <div>
      <h3>{title}</h3>
      <div className="evidence-list">
        {items.map((item) => (
          <button className="evidence-row" key={getKey(item)} onClick={() => onSelect(item)} type="button">
            <span className="row-kicker">{getMeta(item)}</span>
            <strong>{preview(getContent(item), 160)}</strong>
            {getCustomFields ? <CustomFieldBadges fields={getCustomFields(item)} /> : null}
          </button>
        ))}
        {!items.length ? <div className="empty-state small">{emptyText}</div> : null}
      </div>
    </div>
  );
}

function CustomFieldBadges({ fields }: { fields: Record<string, CustomFieldValue> | undefined }) {
  const badges = formatCustomFieldBadges(fields);
  if (!badges.length) return null;

  return (
    <span className="custom-field-badges">
      {badges.map((badge) => (
        <span className="custom-field-badge" key={badge}>{badge}</span>
      ))}
    </span>
  );
}

function ShortTermView({
  memories,
  onDream,
  onPromote,
  onSelect,
  onUpdate
}: {
  memories: ShortTermMemory[];
  onDream: (memory?: ShortTermMemory) => void;
  onPromote: (memory: ShortTermMemory) => void;
  onSelect: (item: unknown) => void;
  onUpdate: (layer: "stm", id: string, body: Record<string, string | number>) => void;
}) {
  const visibleMemories = memories.filter((memory) => memory.lifecycleStatus !== "deleted");
  if (!visibleMemories.length) return <div className="empty-state">暂无短期记忆。</div>;

  return (
    <div className="memory-list">
      <section className="memory-toolbar">
        <div>
          <span className="row-kicker">Dreaming worker</span>
          <strong>将高价值 STM 巩固为 LTM</strong>
        </div>
        <button className="primary" onClick={() => onDream()} type="button">
          运行做梦
        </button>
      </section>
      {visibleMemories.map((memory) => (
        <article className="memory-row" key={memory.memoryDataId}>
          <button className="row-main" onClick={() => onSelect(memory)} type="button">
            <span className="row-kicker">STM · {memory.memoryType ?? memory.memoryDataType} · {memory.memoryDataId}</span>
            <strong>{preview(formatMemoryCardSummary(memory), 140)}</strong>
            <span>{formatShortTermMemoryTrail(memory)}</span>
          </button>
          <div className="row-meta">
            <StatusBadge label={memory.lifecycleStatus} />
            <StatusBadge label={memory.importanceLevel} />
            <RetrievalWeightBadge label="系统权重" value={memory.retrievalWeight} fallback={memory.importanceLevel === "critical" ? 1 : memory.importanceLevel === "high" ? 0.8 : memory.importanceLevel === "medium" ? 0.5 : 0.2} />
            <UserRetrievalWeightBadge value={memory.userRetrievalWeight} />
            <StatusBadge label={memory.admissionResult} />
            <button onClick={() => onDream(memory)} type="button">做梦</button>
            <button onClick={() => onPromote(memory)} type="button">规则提升</button>
            <button onClick={() => onUpdate("stm", memory.memoryDataId, { lifecycleStatus: "archived" })} type="button">
              归档
            </button>
            <button
              onClick={() => {
                if (window.confirm("确认删除这条短期记忆？")) {
                  onUpdate("stm", memory.memoryDataId, { lifecycleStatus: "deleted" });
                }
              }}
              type="button"
            >
              删除
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function LongTermView({
  memories,
  traces,
  onSelect,
  onUpdate
}: {
  memories: LongTermMemory[];
  traces: LlmDreamingTrace[];
  onSelect: (item: unknown) => void;
  onUpdate: (layer: "ltm", id: string, body: Record<string, string | number>) => void;
}) {
  if (!memories.length && !traces.length) return <div className="empty-state">将短期记忆做梦或提升后，会在这里生成长期记忆。</div>;

  return (
    <div className="ltm-view">
      <div className="ltm-grid">
        {memories.map((memory) => (
          <article className="ltm-card" key={memory.memoryId}>
            <button className="card-open" onClick={() => onSelect(memory)} type="button">
              <span className="row-kicker">{memory.theoryClass} / {memory.memoryType}</span>
              <strong>{preview(formatMemoryCardSummary(memory), 180)}</strong>
            </button>
            <div className="row-meta">
              <StatusBadge label={memory.lifecycleStatus} />
              <StatusBadge label={`召回权重 ${translateValue(memory.recallWeight)}`} />
              <RetrievalWeightBadge label="系统权重" value={memory.retrievalWeight} fallback={memory.recallWeight === "high" ? 1 : memory.recallWeight === "medium" ? 0.6 : 0.3} />
              <UserRetrievalWeightBadge value={memory.userRetrievalWeight} />
            </div>
            <div className="button-row">
              <button onClick={() => onUpdate("ltm", memory.memoryId, { lifecycleStatus: "revised" })} type="button">
                修订
              </button>
              <button
                onClick={() => onUpdate("ltm", memory.memoryId, {
                  userRetrievalWeight: Math.max(0, (coerceWeight(memory.userRetrievalWeight) ?? coerceWeight(memory.retrievalWeight) ?? 0.5) - 0.3),
                  lifecycleStatus: memory.lifecycleStatus === "archived" ? "archived" : "weakened"
                })}
                type="button"
              >
                降权
              </button>
              <button onClick={() => onUpdate("ltm", memory.memoryId, { userRetrievalWeight: 1, lifecycleStatus: "active" })} type="button">
                强化
              </button>
              <button onClick={() => onUpdate("ltm", memory.memoryId, { lifecycleStatus: "archived" })} type="button">
                归档
              </button>
              {memory.lifecycleStatus === "archived" ? (
                <button onClick={() => onUpdate("ltm", memory.memoryId, { lifecycleStatus: "active" })} type="button">
                  撤销归档
                </button>
              ) : null}
              <button onClick={() => onUpdate("ltm", memory.memoryId, { lifecycleStatus: "deleted" })} type="button">
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>LLM 做梦审计</h2>
          <span>prompt / result / fallback</span>
        </div>
        {traces.length ? (
          <div className="llm-trace-list">
            {traces.map((trace) => (
              <article className="llm-trace-card" key={trace.traceId}>
                <button className="trace-row" onClick={() => onSelect(trace)} type="button">
                  <strong>{trace.model} / {trace.keySource === "missing" ? "未配置 Key" : trace.keySource}</strong>
                  <span>
                    {trace.sourceMemoryDataIds.length} 条 STM / {trace.fallbackReason ? `fallback: ${translateValue(trace.fallbackReason)}` : "LLM 输出已采用"}
                  </span>
                </button>
                <div className="prompt-result-grid">
                  <button className="prompt-box" onClick={() => onSelect({ traceId: trace.traceId, prompt: trace.prompt })} type="button">
                    <span className="row-kicker">做梦 Prompt</span>
                    <pre className="full-audit-text">{formatAuditPayload(trace.prompt)}</pre>
                  </button>
                  <button
                    className="prompt-box"
                    onClick={() => onSelect({
                      traceId: trace.traceId,
                      rawResponse: trace.rawResponse,
                      parsedMemories: trace.parsedMemories,
                      rejectedCandidates: trace.rejectedCandidates
                    })}
                    type="button"
                  >
                    <span className="row-kicker">LLM 做梦结果</span>
                    <pre className="full-audit-text">{formatAuditPayload(trace.rawResponse ?? {
                      parsedMemories: trace.parsedMemories,
                      rejectedCandidates: trace.rejectedCandidates
                    })}</pre>
                  </button>
                </div>
                <div className="source-ref-strip">
                  <span className="badge">{trace.candidateMemories.length} 条候选 STM</span>
                  <span className="badge">{trace.parsedMemories.length} 条 LTM</span>
                  <span className="badge">{trace.endpoint}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state small">暂无 LLM 做梦 trace。点击 STM 页签里的“运行做梦”后会显示 prompt 和结果。</div>
        )}
      </section>
    </div>
  );
}

function MemoryInspectorSummary({ item }: { item: ShortTermMemory | LongTermMemory | GraphMemoryNode }) {
  const summary = formatMemoryInspectorSummary(item);
  return (
    <div className="empty-state small">
      <strong>{summary.type}</strong>
      <span>{summary.id}</span>
      <span>{summary.factSummary}</span>
    </div>
  );
}

function GraphView({
  nodes,
  onSelect
}: {
  nodes: Snapshot["graphMemoryNodes"];
  onSelect: (item: unknown) => void;
}) {
  if (!nodes.length) return <div className="empty-state">暂无图节点。</div>;

  return (
    <div className="memory-list">
      {nodes.map((node) => {
        const summary = formatMemoryInspectorSummary({
          memoryId: node.graphNodeId,
          ...(node.memoryType ? { memoryType: node.memoryType } : {}),
          ...(node.factSummary ? { factSummary: node.factSummary } : {}),
          content: node.content
        });

        return (
          <article className="memory-row" key={node.graphNodeId}>
            <button className="row-main" onClick={() => onSelect(node)} type="button">
              <span className="row-kicker">图节点 · {summary.type} · {node.ownerType}</span>
              <strong>{preview(summary.factSummary, 140)}</strong>
              <span>{node.ownerId} / {formatTime(node.refreshedAt)}</span>
            </button>
            <div className="row-meta">
              <StatusBadge label={node.lifecycleStatus} />
              <StatusBadge label={`检索权重 ${formatWeight(node.retrievalWeight, 0)}`} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function SearchView({
  query,
  layer,
  results,
  onQueryChange,
  onLayerChange,
  onSearch,
  onSelect
}: {
  query: string;
  layer: string;
  results: SearchResult[];
  onQueryChange: (query: string) => void;
  onLayerChange: (layer: string) => void;
  onSearch: () => void;
  onSelect: (item: unknown) => void;
}) {
  return (
    <div className="search-view">
      <div className="search-controls">
        <input
          placeholder="检索事实、短期记忆和长期记忆"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void onSearch();
          }}
        />
        <select value={layer} onChange={(event) => onLayerChange(event.target.value)}>
          <option value="all">全部</option>
          <option value="fact">事实</option>
          <option value="stm">短期记忆</option>
          <option value="ltm">长期记忆</option>
        </select>
        <button onClick={onSearch} type="button">检索</button>
      </div>
      <div className="memory-list">
        {results.map((result) => (
          <article className="memory-row" key={`${result.layer}:${result.id}`}>
            <button className="row-main" onClick={() => onSelect(result)} type="button">
              <span className="row-kicker">{translateValue(result.layer)} / {translateValue(result.reason)}</span>
              <strong>{preview(result.content, 180)}</strong>
            </button>
            <div className="row-meta">
              <StatusBadge label={result.status} />
              <StatusBadge label={formatWeight(result.score, 0)} />
            </div>
            <ScoreBreakdownView breakdown={result.scoreBreakdown} />
          </article>
        ))}
        {!results.length ? <div className="empty-state">执行一次检索后，可查看召回候选。</div> : null}
      </div>
    </div>
  );
}

function RetrievalWeightBadge({ label, value, fallback }: { label: string; value: number | null | undefined; fallback: number }) {
  return <StatusBadge label={`${label} ${formatWeight(value, fallback)}`} />;
}

function UserRetrievalWeightBadge({ value }: { value: number | null | undefined }) {
  const weight = coerceWeight(value);
  return <StatusBadge label={weight === undefined ? "用户权重 未设置" : `用户权重 ${weight.toFixed(2)}`} />;
}

function coerceWeight(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatWeight(value: number | null | undefined, fallback = 0) {
  return (coerceWeight(value) ?? fallback).toFixed(2);
}

function ScoreBreakdownView({ breakdown }: { breakdown?: SearchResult["scoreBreakdown"] }) {
  if (!breakdown) return null;
  const parts = [
    ["关键词", breakdown.keyword],
    ["向量", breakdown.vector],
    ["图", breakdown.graph],
    ["新近", breakdown.recency],
    ["系统权重", breakdown.retrievalWeight],
    ["用户权重", breakdown.userRetrievalWeight],
    ["RRF", breakdown.rrf],
    ["冲突", -breakdown.conflictPenalty],
    ["权限", -breakdown.permissionRiskPenalty],
    ["过期", -breakdown.stalenessPenalty]
  ] as const;

  return (
    <div className="score-breakdown">
      {parts.map(([label, value]) => (
        <span className="score-piece" key={label}>
          {label} {(coerceWeight(value) ?? 0) >= 0 ? "+" : ""}
          {formatWeight(value)}
        </span>
      ))}
      {breakdown.route ? (
        <span className="score-route">
          路由 K{formatWeight(breakdown.route.keyword)} / V{formatWeight(breakdown.route.vector)} / G{formatWeight(breakdown.route.graph)} / T{formatWeight(breakdown.route.time)} / F{formatWeight(breakdown.route.feedback)}
        </span>
      ) : null}
    </div>
  );
}

function ContextPackView({
  task,
  budget,
  pack,
  traces,
  scopeField,
  onTaskChange,
  onBudgetChange,
  onAssemble,
  onSelect
}: {
  task: string;
  budget: number;
  pack: ContextPack | null;
  traces: unknown[];
  scopeField?: {
    label: string;
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
  };
  onTaskChange: (task: string) => void;
  onBudgetChange: (budget: number) => void;
  onAssemble: () => void;
  onSelect: (item: unknown) => void;
}) {
  return (
    <div className="pack-view">
      <div className="pack-controls">
        {scopeField ? (
          <label>
            {scopeField.label}
            <input
              autoCapitalize="none"
              placeholder={scopeField.placeholder}
              spellCheck={false}
              value={scopeField.value}
              onChange={(event) => scopeField.onChange(event.target.value)}
            />
          </label>
        ) : null}
        <label>
          智能体任务
          <textarea
            rows={3}
            value={task}
            onChange={(event) => onTaskChange(event.target.value)}
          />
        </label>
        <label>
          预算
          <input
            min={100}
            max={12000}
            type="number"
            value={budget}
            onChange={(event) => onBudgetChange(Number(event.target.value))}
          />
        </label>
        <button
          className="primary"
          onClick={onAssemble}
          type="button"
          disabled={!task.trim() || Boolean(scopeField && !scopeField.value.trim())}
        >
          组装上下文
        </button>
      </div>

      {pack ? (
        <div className="pack-grid">
          <section className="pack-summary">
            <div>
              <span className="row-kicker">最终发给 LLM 的上下文</span>
              <strong>{pack.packId}</strong>
            </div>
            <div>
              <span className="row-kicker">最终注入文本</span>
              <button className="link-button" onClick={() => onSelect(pack)} type="button">
                {pack.traceId}
              </button>
            </div>
            <div>
              <span className="row-kicker">预算</span>
              <strong>{pack.tokenBudget.used} / {pack.tokenBudget.requested}</strong>
            </div>
            {pack.tokenBudget.plan ? (
              <div>
                <span className="row-kicker">预算计划</span>
                <strong>{pack.tokenBudget.plan.constraints} / {pack.tokenBudget.plan.taskContext} / {pack.tokenBudget.plan.recentContext}</strong>
              </div>
            ) : null}
          </section>

          <section className="pack-panel pack-panel-wide">
            <div className="panel-header">
              <h2>最终注入文本</h2>
              <span>{pack.serializedPrompt.length} 字符</span>
            </div>
            <pre className="serialized-prompt">{pack.serializedPrompt}</pre>
          </section>

          <PackSection title="约束" items={pack.constraints} onSelect={onSelect} />
          <PackSection title="近期上下文" items={pack.recentContext} onSelect={onSelect} />
          <PackSection title="任务上下文" items={pack.taskContext} onSelect={onSelect} />
          <PackSection title="长期记忆上下文" items={pack.profileContext} onSelect={onSelect} />

          <section className="pack-panel">
            <div className="panel-header">
              <h2>引用</h2>
              <span>{pack.citations.length}</span>
            </div>
            {pack.citations.length ? (
              pack.citations.map((citation) => (
                <button className="trace-row" key={citation.sourceRefId} onClick={() => onSelect(citation)} type="button">
                  <strong>{citation.sourceType}:{citation.sourceId}</strong>
                  <span>{citation.itemIds.join(", ")}</span>
                </button>
              ))
            ) : (
              <div className="empty-state small">暂无引用。</div>
            )}
          </section>

          <section className="pack-panel">
            <div className="panel-header">
              <h2>丢弃项</h2>
              <span>{pack.dropped.length}</span>
            </div>
            {pack.dropped.length ? (
              pack.dropped.map((item) => (
                <button className="trace-row" key={`${item.id}:${item.reason}`} onClick={() => onSelect(item)} type="button">
                  <strong>{translateValue(item.layer ?? "item")}:{item.id}</strong>
                  <span>{translateValue(item.reason)}</span>
                </button>
              ))
            ) : (
              <div className="empty-state small">暂无丢弃项。</div>
            )}
          </section>

          <section className="pack-panel">
            <div className="panel-header">
              <h2>冲突</h2>
              <span>{pack.conflicts.length}</span>
            </div>
            {pack.conflicts.length ? (
              pack.conflicts.map((conflict) => (
                <button className="trace-row" key={conflict.edgeId} onClick={() => onSelect(conflict)} type="button">
                  <strong>{`${conflict.fromId} -> ${conflict.toId}`}</strong>
                  <span>{conflict.evidence ?? conflict.edgeId}</span>
                </button>
              ))
            ) : (
              <div className="empty-state small">暂无冲突。</div>
            )}
          </section>
        </div>
      ) : (
        <div className="empty-state">组装上下文包后，可查看选中项、引用、冲突、预算和丢弃原因。</div>
      )}

      <section className="pack-panel">
        <div className="panel-header">
          <h2>上下文包追踪</h2>
          <span>{traces.length}</span>
        </div>
        {traces.length ? (
          <div className="trace-list">
            {traces.map((trace, index) => (
              <button className="trace-row" key={index} onClick={() => onSelect(trace)} type="button">
                <strong>{traceLabel(trace)}</strong>
                <span>{traceMeta(trace)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state small">暂无上下文包追踪。</div>
        )}
      </section>
    </div>
  );
}

function PackSection({
  title,
  items,
  onSelect
}: {
  title: string;
  items: ContextPackItem[];
  onSelect: (item: unknown) => void;
}) {
  return (
    <section className="pack-panel">
      <div className="panel-header">
        <h2>{title}</h2>
        <span>{items.length}</span>
      </div>
      {items.length ? (
            <div className="pack-items">
          {items.map((item) => (
            <button className="pack-item" key={`${item.layer}:${item.id}`} onClick={() => onSelect(item)} type="button">
              <span className="row-kicker">{translateValue(item.layer)} / {item.score.toFixed(2)}</span>
              <strong>{preview(item.compressedContent ?? item.content, 180)}</strong>
              {item.compressedContent && item.compressedContent !== item.content ? (
                <small>{preview(item.content, 140)}</small>
              ) : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state small">暂无选中项。</div>
      )}
    </section>
  );
}

function BackgroundView({
  background,
  onRefresh,
  onSelect
}: {
  background: BackgroundContextDocument | null;
  onRefresh: () => void;
  onSelect: (item: unknown) => void;
}) {
  return (
    <div className="trace-list">
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>背景上下文</h2>
          <button onClick={onRefresh} type="button">刷新背景</button>
        </div>
        {background ? (
          <div className="memory-list">
            <article className="memory-row">
              <button className="row-main" onClick={() => onSelect(background)} type="button">
                <span className="row-kicker">{background.backgroundId}</span>
                <strong>{preview(background.fixedText, 180)}</strong>
                <span>{preview(background.dynamicText, 180)}</span>
              </button>
              <div className="row-meta">
                <StatusBadge label={background.updateSuggestion?.status ?? "pending"} />
                <StatusBadge label={background.degradedModeReason ?? "active"} />
              </div>
            </article>
            <div className="source-ref-strip">
              {background.sourceRefIds.map((sourceRefId) => (
                <button className="source-ref" key={sourceRefId} onClick={() => onSelect({ sourceRefId })} type="button">
                  {sourceRefId}
                </button>
              ))}
            </div>
            <div className="source-ref-strip">
              {background.conflictIds.map((conflictId) => (
                <button className="source-ref" key={conflictId} onClick={() => onSelect({ conflictId })} type="button">
                  {conflictId}
                </button>
              ))}
            </div>
            {background.updateSuggestion ? (
              <div className="empty-state small">{background.updateSuggestion.summary}</div>
            ) : null}
          </div>
        ) : (
          <div className="empty-state">暂无背景上下文。</div>
        )}
      </section>
    </div>
  );
}

function FeedbackView({
  feedbackItems,
  changeEvents,
  onSubmitFeedback,
  onSelect
}: {
  feedbackItems: MemoryFeedbackItem[];
  changeEvents: MemoryChangeEvent[];
  onSubmitFeedback: (targetType: MemoryFeedbackItem["targetType"], targetId: string, action: MemoryFeedbackItem["action"], note?: string) => void;
  onSelect: (item: unknown) => void;
}) {
  return (
    <div className="trace-list">
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>记忆反馈</h2>
          <span>{feedbackItems.length} 条</span>
        </div>
        {feedbackItems.length ? (
          <div className="memory-list">
            {feedbackItems.map((item) => (
              <article className="memory-row" key={item.feedbackId}>
                <button className="row-main" onClick={() => onSelect(item)} type="button">
                  <span className="row-kicker">{translateValue(item.targetType)} / {translateValue(item.action)}</span>
                  <strong>{item.targetId}</strong>
                  <span>{item.note ?? formatTime(item.createdAt)}</span>
                </button>
                <div className="row-meta">
                  <button onClick={() => onSubmitFeedback(item.targetType, item.targetId, "confirm")} type="button">确认</button>
                  <button onClick={() => onSubmitFeedback(item.targetType, item.targetId, "correct")} type="button">纠正</button>
                  <button onClick={() => onSubmitFeedback(item.targetType, item.targetId, "delete")} type="button">删除</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">暂无反馈。</div>
        )}
      </section>

      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>生命周期变更</h2>
          <span>{changeEvents.length} 条</span>
        </div>
        {changeEvents.length ? (
          <div className="trace-list">
            {changeEvents.slice(-30).map((item) => (
              <button className="trace-row" key={item.eventId} onClick={() => onSelect(item)} type="button">
                <strong>{translateValue(item.changeType)}</strong>
                <span>{item.storageLayer} / {item.reason}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state small">暂无变更事件。</div>
        )}
      </section>
    </div>
  );
}

function MetricsView({
  snapshot,
  longMemEvalDatasetPath,
  longMemEvalPackQuestionId,
  longMemEvalJsonlFileName,
  longMemEvalJsonlText,
  longMemEvalJsonlPage,
  longMemEvalJsonlResult,
  longMemEvalJsonlStatus,
  longMemEvalJsonlError,
  longMemEvalKs,
  longMemEvalReport,
  longMemEvalRunState,
  longMemEvalLlmSettings,
  longMemEvalLlmTestState,
  longMemEvalContextPack,
  longMemEvalClearRevision,
  packTask,
  packBudget,
  onLongMemEvalLlmSettingsChange,
  onDatasetPathChange,
  onPackQuestionIdChange,
  onJsonlFileNameChange,
  onJsonlTextChange,
  onJsonlPageChange,
  onJsonlResultChange,
  onJsonlStatusChange,
  onJsonlErrorChange,
  onKsChange,
  onPackTaskChange,
  onPackBudgetChange,
  onAssembleLongMemEvalPack,
  onRunLongMemEval,
  onCancelLongMemEval,
  onClearLongMemEvalDatabase,
  onSelect,
  onToastChange,
  onTestLongMemEvalLlm
}: {
  snapshot: Snapshot;
  longMemEvalDatasetPath: string;
  longMemEvalPackQuestionId: string;
  longMemEvalJsonlFileName: string;
  longMemEvalJsonlText: string;
  longMemEvalJsonlPage: number;
  longMemEvalJsonlResult: LongMemEvalJsonlResultPage | null;
  longMemEvalJsonlStatus: "idle" | "loading" | "error";
  longMemEvalJsonlError: string;
  longMemEvalKs: string;
  longMemEvalReport: LongMemEvalEvaluationReport | null;
  longMemEvalRunState: LongMemEvalRunState;
  longMemEvalLlmSettings: LongMemEvalLlmSettings;
  longMemEvalLlmTestState: LongMemEvalLlmTestState;
  longMemEvalContextPack: ContextPack | null;
  longMemEvalClearRevision: number;
  packTask: string;
  packBudget: number;
  onLongMemEvalLlmSettingsChange: (value: LongMemEvalLlmSettings) => void;
  onDatasetPathChange: (value: string) => void;
  onPackQuestionIdChange: (value: string) => void;
  onJsonlFileNameChange: (value: string) => void;
  onJsonlTextChange: (value: string) => void;
  onJsonlPageChange: (value: number) => void;
  onJsonlResultChange: (value: LongMemEvalJsonlResultPage | null) => void;
  onJsonlStatusChange: (value: "idle" | "loading" | "error") => void;
  onJsonlErrorChange: (value: string) => void;
  onKsChange: (value: string) => void;
  onPackTaskChange: (value: string) => void;
  onPackBudgetChange: (value: number) => void;
  onAssembleLongMemEvalPack: () => Promise<void>;
  onRunLongMemEval: () => Promise<void>;
  onCancelLongMemEval: () => Promise<void>;
  onClearLongMemEvalDatabase: () => Promise<void>;
  onSelect: (item: unknown) => void;
  onToastChange: (value: string) => void;
  onTestLongMemEvalLlm: (target: LongMemEvalLlmTestTarget) => Promise<void>;
}) {
  const primaryLongMemEvalReport = readPrimaryLongMemEvalReport(longMemEvalReport);
  const primaryLongMemEvalReportKey = primaryLongMemEvalReport
    ? `${primaryLongMemEvalReport.datasetPath}:${primaryLongMemEvalReport.totalSamples}`
    : "empty";
  const [longMemEvalView, setLongMemEvalView] = React.useState<"dataLake" | "timeline" | "stm" | "ltm" | "pack" | "summary" | "jsonl">("dataLake");
  const [longMemEvalStoredSnapshot, setLongMemEvalStoredSnapshot] = React.useState<Snapshot>(emptySnapshot);
  const [longMemEvalStoredTimeline, setLongMemEvalStoredTimeline] = React.useState<TimelineItem[]>([]);
  const [longMemEvalStoredStatus, setLongMemEvalStoredStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [longMemEvalStoredError, setLongMemEvalStoredError] = React.useState("");
  const [longMemEvalStoredPage, setLongMemEvalStoredPage] = React.useState(1);
  const [longMemEvalStoredTotalPages, setLongMemEvalStoredTotalPages] = React.useState(1);
  const [longMemEvalStoredTotalItems, setLongMemEvalStoredTotalItems] = React.useState(0);
  const [longMemEvalContentQuery, setLongMemEvalContentQuery] = React.useState("");
  const [longMemEvalSampleQuery, setLongMemEvalSampleQuery] = React.useState("");
  const [longMemEvalDiagnostic, setLongMemEvalDiagnostic] = React.useState<{
    item: LongMemEvalJsonlResultItem;
    details: LongMemEvalSelectedItemDetail[];
    missingItemIds: string[];
    status: "idle" | "loading" | "error";
    error?: string;
  } | null>(null);
  const [datasetType, setDatasetType] = React.useState<"locomo" | "longmemeval">("longmemeval");
  const longMemEvalStoredPageSize = 50;
  React.useEffect(() => {
    setLongMemEvalStoredSnapshot(emptySnapshot);
    setLongMemEvalStoredTimeline([]);
    setLongMemEvalStoredStatus("idle");
    setLongMemEvalStoredError("");
    setLongMemEvalStoredPage(1);
    setLongMemEvalStoredTotalPages(1);
    setLongMemEvalStoredTotalItems(0);
  }, [primaryLongMemEvalReportKey, longMemEvalClearRevision]);
  React.useEffect(() => {
    setLongMemEvalStoredPage(1);
  }, [longMemEvalContentQuery, longMemEvalDatasetPath, longMemEvalSampleQuery, longMemEvalView]);
  React.useEffect(() => {
    onJsonlPageChange(1);
    setLongMemEvalDiagnostic(null);
  }, [longMemEvalJsonlText, onJsonlPageChange]);
  React.useEffect(() => {
    const datasetPath = longMemEvalDatasetPath.trim();
    if (datasetType !== "longmemeval") return;
    if (longMemEvalView === "summary" || longMemEvalView === "pack" || longMemEvalView === "jsonl") return;
    let cancelled = false;
    setLongMemEvalStoredStatus("loading");
    setLongMemEvalStoredError("");
    void fetch("/context/evaluations/longmemeval/debug-snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        datasetPath,
        view: longMemEvalView,
        page: longMemEvalStoredPage,
        pageSize: longMemEvalStoredPageSize,
        contentQuery: longMemEvalContentQuery,
        sampleQuery: longMemEvalSampleQuery
      })
    })
      .then((response) => response.json())
      .then((response: { ok?: boolean; items?: Snapshot; timeline?: TimelineItem[]; page?: number; totalItems?: number; totalPages?: number; error?: string }) => {
      if (cancelled) return;
      if (!response.ok || !response.items) {
        setLongMemEvalStoredStatus("error");
        setLongMemEvalStoredError(response.error ?? "LongMemEval 入库数据加载失败");
        return;
      }
      setLongMemEvalStoredSnapshot(response.items);
      setLongMemEvalStoredTimeline(response.timeline ?? []);
      setLongMemEvalStoredPage(response.page ?? longMemEvalStoredPage);
      setLongMemEvalStoredTotalItems(response.totalItems ?? 0);
      setLongMemEvalStoredTotalPages(response.totalPages ?? 1);
      setLongMemEvalStoredStatus("idle");
    }).catch((error) => {
      if (cancelled) return;
      setLongMemEvalStoredStatus("error");
      setLongMemEvalStoredError(error instanceof Error ? error.message : "LongMemEval 入库数据加载失败");
    });
    return () => {
      cancelled = true;
    };
  }, [datasetType, longMemEvalContentQuery, longMemEvalDatasetPath, longMemEvalSampleQuery, longMemEvalStoredPage, longMemEvalView]);
  React.useEffect(() => {
    if (longMemEvalView !== "jsonl") return;
    if (!longMemEvalJsonlText) {
      onJsonlStatusChange("idle");
      onJsonlResultChange(null);
      return;
    }

    try {
      const result = parseLongMemEvalJsonlText({
        text: longMemEvalJsonlText,
        fileName: longMemEvalJsonlFileName || "selected.jsonl",
        page: longMemEvalJsonlPage,
        pageSize: 20
      });
      onJsonlStatusChange("idle");
      onJsonlErrorChange("");
      onJsonlResultChange(result);
    } catch (error) {
      onJsonlStatusChange("error");
      onJsonlErrorChange(error instanceof Error ? error.message : "LongMemEval JSONL 结果解析失败");
      onJsonlResultChange(null);
    }
  }, [
    longMemEvalJsonlFileName,
    longMemEvalJsonlPage,
    longMemEvalJsonlText,
    longMemEvalView,
    onJsonlErrorChange,
    onJsonlResultChange,
    onJsonlStatusChange
  ]);
  async function selectLongMemEvalJsonlFile(file: File | null) {
    if (!file) return;
    onJsonlStatusChange("loading");
    onJsonlErrorChange("");
    onJsonlResultChange(null);
    try {
      const text = await file.text();
      onJsonlFileNameChange(file.name);
      onJsonlTextChange(text);
      onJsonlPageChange(1);
    } catch (error) {
      onJsonlStatusChange("error");
      onJsonlErrorChange(error instanceof Error ? error.message : "LongMemEval JSONL 文件读取失败");
    }
  }

  async function inspectLongMemEvalJsonlSelectedItems(item: LongMemEvalJsonlResultItem) {
    setLongMemEvalDiagnostic({
      item,
      details: [],
      missingItemIds: [],
      status: item.selectedItemIds.length ? "loading" : "idle"
    });
    if (!item.selectedItemIds.length) {
      return;
    }
    const datasetPath = item.datasetPath ?? longMemEvalJsonlResult?.summary.datasetPath;
    if (!datasetPath) {
      setLongMemEvalDiagnostic({
        item,
        details: [],
        missingItemIds: [],
        status: "error",
        error: "缺少 datasetPath，无法读取证据来源"
      });
      return;
    }
    const response = await requestLongMemEvalSelectedItemDetails(fetch, datasetPath, item.questionId, item.selectedItemIds);
    if (!response.ok || !response.result) {
      setLongMemEvalDiagnostic({
        item,
        details: [],
        missingItemIds: item.selectedItemIds,
        status: "error",
        error: response.error ?? "LongMemEval 选中项详情查询失败"
      });
      return;
    }

    setLongMemEvalDiagnostic({
      item: { ...item, datasetPath },
      details: response.result.items,
      missingItemIds: response.result.missingItemIds,
      status: "idle"
    });
  }

  const metrics = [
    ["摄入延迟", snapshot.pipelineTasks.filter((task) => task.taskType === "ingest").length],
    ["解析延迟", snapshot.pipelineTasks.filter((task) => task.taskType === "parse").length],
    ["融合延迟", snapshot.pipelineTasks.filter((task) => task.taskType === "fusion").length],
    ["STM 准入", snapshot.shortTermMemories.filter((memory) => memory.lifecycleStatus === "active").length],
    ["做梦吞吐", snapshot.longTermMemories.length],
    ["检索延迟", snapshot.packTraces.length],
    ["组装延迟", snapshot.packTraces.length],
    ["权限拒绝", snapshot.shortTermMemories.filter((memory) => memory.lifecycleStatus === "rejected" || memory.accessState === "permission-invalid").length],
    ["反馈记录", snapshot.feedbackItems.length]
  ] as const;

  return (
    <div className="metrics-stack">
      <div className="metrics-grid">
        {metrics.map(([label, value]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <section className="metric-panel" aria-label="数据集评测">
        <div className="panel-header">
          <div>
            <h2>数据集评测</h2>
            <span>{datasetType === "locomo" ? "LoCoMo · locomo-fact-stm-v1 · Fact + STM · 无 LTM" : "LongMemEval · 专用评测链路"}</span>
          </div>
          <span>
            {datasetType === "locomo"
              ? "LoCoMo"
              : longMemEvalRunState.status === "running"
              ? longMemEvalRunState.stage ?? "运行中"
              : longMemEvalRunState.status === "queued"
                ? "已排队"
              : longMemEvalRunState.status === "cancelled"
                ? "已终止"
              : longMemEvalRunState.status === "error"
                ? "运行失败"
                : longMemEvalReport
                  ? `${longMemEvalReport.totalSamples} 条`
                  : "未运行"}
          </span>
        </div>
        <div className="eval-dataset-picker">
          <label>
            数据集类型
            <select value={datasetType} onChange={(event) => setDatasetType(event.target.value as "locomo" | "longmemeval")}>
              <option value="longmemeval">LongMemEval</option>
              <option value="locomo">LoCoMo</option>
            </select>
          </label>
          <label>
            数据集路径
            <input
              value={longMemEvalDatasetPath}
              onChange={(event) => onDatasetPathChange(event.target.value)}
              placeholder="../../datasets/LongMemEval/longmemeval_s_cleaned.json 或 data/locomo/locomo10.json"
            />
          </label>
        </div>
        {datasetType === "locomo" ? (
          <LocomoEvaluationPanel
            datasetPath={longMemEvalDatasetPath}
            llmSettings={longMemEvalLlmSettings}
            llmTestState={longMemEvalLlmTestState}
            onLlmSettingsChange={onLongMemEvalLlmSettingsChange}
            onTestLlm={onTestLongMemEvalLlm}
          />
        ) : (
          <>
        <div className="segmented compact eval-view-switch" role="group" aria-label="LongMemEval 数据视图">
          <button
            className={longMemEvalView === "dataLake" ? "active" : ""}
            onClick={() => setLongMemEvalView("dataLake")}
            type="button"
          >
            数据湖
          </button>
          <button
            className={longMemEvalView === "timeline" ? "active" : ""}
            onClick={() => setLongMemEvalView("timeline")}
            type="button"
          >
            时间轴融合
          </button>
          <button
            className={longMemEvalView === "stm" ? "active" : ""}
            onClick={() => setLongMemEvalView("stm")}
            type="button"
          >
            STM
          </button>
          <button
            className={longMemEvalView === "ltm" ? "active" : ""}
            onClick={() => setLongMemEvalView("ltm")}
            type="button"
          >
            LTM
          </button>
          <button
            className={longMemEvalView === "pack" ? "active" : ""}
            onClick={() => setLongMemEvalView("pack")}
            type="button"
          >
            Context Pack
          </button>
          <button
            className={longMemEvalView === "summary" ? "active" : ""}
            onClick={() => setLongMemEvalView("summary")}
            type="button"
          >
            评测结果
          </button>
          <button
            className={longMemEvalView === "jsonl" ? "active" : ""}
            onClick={() => setLongMemEvalView("jsonl")}
            type="button"
          >
            JSONL 结果
          </button>
        </div>
        <div className="eval-debug-filters">
          <label>
            内容/名称
            <input
              value={longMemEvalContentQuery}
              onChange={(event) => setLongMemEvalContentQuery(event.target.value)}
              placeholder="问题、内容、session 名称"
            />
          </label>
          <label>
            样本编号
            <input
              value={longMemEvalSampleQuery}
              onChange={(event) => setLongMemEvalSampleQuery(event.target.value)}
              placeholder="question_id / sample index"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setLongMemEvalContentQuery("");
              setLongMemEvalSampleQuery("");
            }}
            disabled={!longMemEvalContentQuery && !longMemEvalSampleQuery}
          >
            清空筛选
          </button>
        </div>
        <div className="eval-controls">
          <div className="eval-form">
          <label>
            K 值
            <input
              value={longMemEvalKs}
              onChange={(event) => onKsChange(event.target.value)}
              placeholder="1,5"
            />
          </label>
          <label>
            样本并行
            <input
              min={1}
              step={1}
              type="number"
              value={longMemEvalLlmSettings.ingestSampleConcurrency}
              onChange={(event) => onLongMemEvalLlmSettingsChange({
                ...longMemEvalLlmSettings,
                ingestSampleConcurrency: Math.max(1, Math.floor(Number(event.target.value) || 1))
              })}
            />
          </label>
          <label>
            Session 并行
            <input
              min={1}
              step={1}
              type="number"
              value={longMemEvalLlmSettings.ingestSessionConcurrency}
              onChange={(event) => onLongMemEvalLlmSettingsChange({
                ...longMemEvalLlmSettings,
                ingestSessionConcurrency: Math.max(1, Math.floor(Number(event.target.value) || 1))
              })}
            />
          </label>
          <label>
            答题并行
            <input
              min={1}
              step={1}
              type="number"
              value={longMemEvalLlmSettings.answerConcurrency}
              onChange={(event) => onLongMemEvalLlmSettingsChange({
                ...longMemEvalLlmSettings,
                answerConcurrency: Math.max(1, Math.floor(Number(event.target.value) || 1))
              })}
            />
          </label>
          <label>
            评判并行
            <input
              min={1}
              step={1}
              type="number"
              value={longMemEvalLlmSettings.judgeConcurrency}
              onChange={(event) => onLongMemEvalLlmSettingsChange({
                ...longMemEvalLlmSettings,
                judgeConcurrency: Math.max(1, Math.floor(Number(event.target.value) || 1))
              })}
            />
          </label>
          <label>
            结果文件
            <input
              value={longMemEvalLlmSettings.resultFileName}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, resultFileName: event.target.value })}
              placeholder="longmemeval-result.jsonl"
            />
          </label>
          <label>
            Trace 文件
            <input
              value={longMemEvalLlmSettings.traceFileName}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, traceFileName: event.target.value })}
              placeholder="留空则按运行 ID 生成"
            />
          </label>
          <label className="answer-context-mode">
            答题上下文
            <div className="segmented compact" role="group" aria-label="LongMemEval 答题上下文模式">
              <button
                className={longMemEvalLlmSettings.answerContextMode === "context_pack" ? "active" : ""}
                onClick={() => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, answerContextMode: "context_pack" })}
                type="button"
              >
                Context Pack
              </button>
              <button
                className={longMemEvalLlmSettings.answerContextMode === "retrieval" ? "active" : ""}
                onClick={() => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, answerContextMode: "retrieval" })}
                type="button"
              >
                检索结果
              </button>
            </div>
          </label>
          <label>
            提取端点
            <input
              value={longMemEvalLlmSettings.extractionBaseUrl}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, extractionBaseUrl: event.target.value })}
              placeholder="留空则使用后端配置"
            />
          </label>
          <label>
            提取模型
            <input
              value={longMemEvalLlmSettings.extractionModel}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, extractionModel: event.target.value })}
              placeholder="留空则使用后端配置"
            />
          </label>
          <label>
            提取 Key
            <input
              value={longMemEvalLlmSettings.extractionApiKey}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, extractionApiKey: event.target.value })}
              type="password"
            />
          </label>
          <label>
            Judge 端点
            <input
              value={longMemEvalLlmSettings.judgeBaseUrl}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, judgeBaseUrl: event.target.value })}
              placeholder="留空则回退到提取端点"
            />
          </label>
          <label>
            Judge 模型
            <input
              value={longMemEvalLlmSettings.judgeModel}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, judgeModel: event.target.value })}
              placeholder="留空则回退到提取模型"
            />
          </label>
          <label>
            Judge Key
            <input
              value={longMemEvalLlmSettings.judgeApiKey}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, judgeApiKey: event.target.value })}
              type="password"
            />
          </label>
          </div>
          <div className="llm-actions">
            <button
              className="secondary-action"
              disabled={longMemEvalLlmTestState.status === "testing"}
              onClick={() => void onTestLongMemEvalLlm("extraction")}
              type="button"
            >
              测试提取模型
            </button>
            <button
              className="secondary-action"
              disabled={longMemEvalLlmTestState.status === "testing"}
              onClick={() => void onTestLongMemEvalLlm("judge")}
              type="button"
            >
              测试 Judge
            </button>
            <button
              className="secondary-action"
              disabled={longMemEvalLlmTestState.status === "testing"}
              onClick={() => void onTestLongMemEvalLlm("ingest")}
              type="button"
            >
              测试入库 LLM
            </button>
            <button
              className="secondary-action"
              disabled={longMemEvalLlmTestState.status === "testing"}
              onClick={() => void onTestLongMemEvalLlm("answer")}
              type="button"
            >
              测试答题模型
            </button>
          </div>
          {longMemEvalLlmTestState.status !== "idle" ? (
            <div className={`llm-test-status ${longMemEvalLlmTestState.status}`} aria-live="polite">
              <strong>{longMemEvalLlmTestState.status === "testing" ? "测试中" : longMemEvalLlmTestState.status === "ok" ? "调用正常" : "调用失败"}</strong>
              <span>
                {longMemEvalLlmTestState.message ?? ""}
                {typeof longMemEvalLlmTestState.elapsedMs === "number" ? ` · ${longMemEvalLlmTestState.elapsedMs}ms` : ""}
                {formatLlmTokenUsage(longMemEvalLlmTestState.tokenUsage)}
              </span>
            </div>
          ) : null}
          <div className="eval-options">
          <label className="checkbox">
            <input
              checked={longMemEvalLlmSettings.resume}
              onChange={(event) => onLongMemEvalLlmSettingsChange({
                ...longMemEvalLlmSettings,
                resume: event.target.checked,
                ...(event.target.checked ? {} : { retrySkipped: false, resumeLegacy: false })
              })}
              type="checkbox"
            />
            断点续跑
          </label>
          <label className="checkbox">
            <input
              checked={longMemEvalLlmSettings.retrySkipped}
              disabled={!longMemEvalLlmSettings.resume}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, retrySkipped: event.target.checked })}
              type="checkbox"
            />
            重跑 skipped
          </label>
          <label className="checkbox">
            <input
              checked={longMemEvalLlmSettings.resumeLegacy}
              disabled={!longMemEvalLlmSettings.resume}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, resumeLegacy: event.target.checked })}
              type="checkbox"
            />
            兼容旧结果恢复
          </label>
          <label className="checkbox">
            <input
              checked={longMemEvalLlmSettings.modelOnlyEvaluation}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, modelOnlyEvaluation: event.target.checked })}
              type="checkbox"
            />
            仅评测模型
          </label>
          <label className="checkbox">
            <input
              checked={longMemEvalLlmSettings.disableIngestLlm}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, disableIngestLlm: event.target.checked })}
              type="checkbox"
            />
            跳过入库 LLM
          </label>
          <label className="checkbox">
            <input
              checked={longMemEvalLlmSettings.skipStmAdmission}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, skipStmAdmission: event.target.checked })}
              type="checkbox"
            />
            跳过 STM 准入
          </label>
          <label className="checkbox">
            <input
              checked={longMemEvalLlmSettings.skipLtmDreaming}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, skipLtmDreaming: event.target.checked })}
              type="checkbox"
            />
            跳过 LTM 做梦
          </label>
          <label className="checkbox">
            <input
              checked={longMemEvalLlmSettings.logIngestRequestContext}
              onChange={(event) => onLongMemEvalLlmSettingsChange({ ...longMemEvalLlmSettings, logIngestRequestContext: event.target.checked })}
              type="checkbox"
            />
            入库细日志
          </label>
          <div className="empty-state small hint">仅评测模型会在样本已入库时复用数据并直接检索答题；跳过入库 LLM 会关闭 fact_fusion / stm_admission 的模型调用；跳过 STM 准入会保留事实抽取但不写 STM；跳过 LTM 做梦会关闭长期记忆强化。</div>
          </div>
          <div className="eval-run">
          <button className="primary" onClick={() => void onRunLongMemEval()} disabled={longMemEvalRunState.status === "running" || longMemEvalRunState.status === "queued"} type="button">
            {longMemEvalRunState.status === "running" || longMemEvalRunState.status === "queued" ? "运行中..." : "运行评测"}
          </button>
          {longMemEvalRunState.status === "running" || longMemEvalRunState.status === "queued" ? (
            <button className="danger-button" onClick={() => void onCancelLongMemEval()} disabled={!longMemEvalRunState.jobId} type="button">
              终止评测
            </button>
          ) : null}
          <button
            className="danger-button"
            onClick={() => void onClearLongMemEvalDatabase()}
            disabled={longMemEvalRunState.status === "running" || longMemEvalRunState.status === "queued"}
            type="button"
          >
            清除 LongMemEval 库
          </button>
          </div>
        </div>
        <div className="empty-state small">
          {longMemEvalRunState.status === "running" && longMemEvalRunState.startedAt
            ? `开始于 ${formatTime(longMemEvalRunState.startedAt)}`
            : longMemEvalRunState.status === "queued" && longMemEvalRunState.startedAt
              ? `已排队于 ${formatTime(longMemEvalRunState.startedAt)}`
            : longMemEvalRunState.status === "cancelled"
              ? longMemEvalRunState.error ?? "评测已终止"
            : longMemEvalRunState.status === "done" && longMemEvalRunState.finishedAt
              ? `完成于 ${formatTime(longMemEvalRunState.finishedAt)}`
              : longMemEvalRunState.status === "error"
                ? longMemEvalRunState.error ?? "评测失败"
                : "输入数据集路径并运行评测。"}
        </div>
        {longMemEvalRunState.fallbackReason ? (
          <div className="batch-stats batch-stats-secondary llm-request-row failed">
            <span>事实抽取 fallback 被阻止</span>
            <span>{formatLongMemEvalFallbackReason(longMemEvalRunState.fallbackReason)}</span>
            <span>{longMemEvalRunState.error ? preview(longMemEvalRunState.error, 120) : "严格模式要求修复 LLM 抽取后重跑"}</span>
          </div>
        ) : null}
        {longMemEvalRunState.fallbackTrace ? (
          <section className="data-lake-panel">
            <div className="panel-header">
              <h2>失败请求 Prompt</h2>
              <span>{longMemEvalRunState.fallbackTrace.traceId} / {longMemEvalRunState.fallbackTrace.eventId}</span>
            </div>
            <pre className="serialized-prompt">{longMemEvalRunState.fallbackTrace.prompt}</pre>
            {longMemEvalRunState.fallbackTrace.rejectedSegments?.length ? (
              <>
                <div className="panel-header">
                  <h2>Fact 拒绝原因</h2>
                  <span>{longMemEvalRunState.fallbackTrace.rejectedSegments.length} 条</span>
                </div>
                <div className="audit-list">
                  {longMemEvalRunState.fallbackTrace.rejectedSegments.map((item, index) => (
                    <div className="audit-row" key={`${item.segmentId}-${item.reason}-${index}`}>
                      <strong>{item.segmentId}</strong>
                      <span>{translateValue(item.reason)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            {longMemEvalRunState.fallbackTrace.parsedFacts?.length ? (
              <>
                <div className="panel-header">
                  <h2>已解析 Facts</h2>
                  <span>{longMemEvalRunState.fallbackTrace.parsedFacts.length} 条</span>
                </div>
                <pre className="serialized-prompt">{formatAuditPayload(longMemEvalRunState.fallbackTrace.parsedFacts)}</pre>
              </>
            ) : null}
            {longMemEvalRunState.fallbackTrace.rawResponse !== undefined ? (
              <>
                <div className="panel-header">
                  <h2>LLM 返回数据</h2>
                  <span>原始响应 / 解析错误</span>
                </div>
                <pre className="serialized-prompt">{formatAuditPayload(longMemEvalRunState.fallbackTrace.rawResponse)}</pre>
              </>
            ) : null}
          </section>
        ) : null}
        {longMemEvalRunState.status === "running" || longMemEvalRunState.status === "queued" ? (
          <div className="batch-summary">
            <div className="batch-progress-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(4, Math.min(100, longMemEvalRunState.stageProgress ?? longMemEvalRunState.progress ?? (longMemEvalRunState.status === "queued" ? 4 : 0)))}%` }} />
            </div>
            <div className="batch-stats">
              <span>
                样本 {longMemEvalRunState.currentSampleIndex ?? longMemEvalRunState.processedSamples ?? 0}
                {typeof longMemEvalRunState.currentSampleCount === "number"
                  ? ` / ${longMemEvalRunState.currentSampleCount}`
                  : typeof longMemEvalRunState.totalSamples === "number"
                    ? ` / ${longMemEvalRunState.totalSamples}`
                    : ""}
              </span>
              <span>{longMemEvalRunState.currentQuestionId ?? "等待样本"}</span>
              <span>
                {typeof longMemEvalRunState.processedSteps === "number" && typeof longMemEvalRunState.totalSteps === "number"
                  ? `步骤 ${longMemEvalRunState.processedSteps} / ${longMemEvalRunState.totalSteps}`
                  : "计算中"}
              </span>
            </div>
            <div className="batch-stats batch-stats-secondary">
              <span>
                {translateLongMemEvalStage(longMemEvalRunState.stage, longMemEvalRunState.ingestStage)}
              </span>
              <span>{typeof longMemEvalRunState.stageProgress === "number" ? `${longMemEvalRunState.stageProgress}%` : typeof longMemEvalRunState.progress === "number" ? `${longMemEvalRunState.progress}%` : "0%"}</span>
              <span>{longMemEvalRunState.currentQuestionType ?? "未选择样本"}</span>
            </div>
            <div className="batch-stats batch-stats-secondary">
              <span>
                {longMemEvalRunState.stage === "timeline_aggregation"
                  ? "时间轴聚合中"
                  : longMemEvalRunState.stage === "stm"
                    ? "STM 准入中"
                    : longMemEvalRunState.stage === "ltm"
                      ? "LTM 强化中"
                      : typeof longMemEvalRunState.currentSessionIndex === "number" && typeof longMemEvalRunState.currentSessionCount === "number"
                        ? `会话 ${longMemEvalRunState.currentSessionIndex} / ${longMemEvalRunState.currentSessionCount}`
                        : "会话计算中"}
              </span>
              <span>{longMemEvalRunState.stageMessage ?? longMemEvalRunState.currentSessionDate ?? "无日期"}</span>
              <span>{longMemEvalRunState.currentSessionId ?? "等待会话"}</span>
            </div>
            <div className="batch-stats batch-stats-secondary">
              <span>
                {longMemEvalRunState.batchIndex && longMemEvalRunState.batchCount
                  ? `批次 ${longMemEvalRunState.batchIndex} / ${longMemEvalRunState.batchCount}`
                  : longMemEvalRunState.ingestStage
                    ? `子阶段：${translateLongMemEvalStage(longMemEvalRunState.stage, longMemEvalRunState.ingestStage)}`
                    : "子阶段：无"}
              </span>
              <span>{typeof longMemEvalRunState.batchProgress === "number" ? `批次进度 ${longMemEvalRunState.batchProgress}%` : typeof longMemEvalRunState.stageProgress === "number" ? `阶段进度 ${longMemEvalRunState.stageProgress}%` : "阶段进度 0%"}</span>
              <span>{longMemEvalRunState.batchMessage ?? (longMemEvalRunState.currentSessionCount ? `会话总数 ${longMemEvalRunState.currentSessionCount}` : "会话总数未定")}</span>
            </div>
            <div className="batch-stats batch-stats-secondary">
              <span>恢复 {longMemEvalRunState.resumedSamples ?? 0}</span>
              <span>本次提交 {longMemEvalRunState.committedSamples ?? 0}</span>
              <span>{longMemEvalRunState.resultPath ?? "结果路径准备中"}</span>
              <span>{longMemEvalRunState.tracePath ?? "Trace 路径准备中"}</span>
            </div>
            {longMemEvalRunState.effectiveConcurrency ? (
              <div className="batch-stats batch-stats-secondary">
                <span>模型 {longMemEvalRunState.effectiveConcurrency.model}</span>
                <span>样本 {longMemEvalRunState.effectiveConcurrency.sample}</span>
                <span>Session {longMemEvalRunState.effectiveConcurrency.session}</span>
                <span>答题 {longMemEvalRunState.effectiveConcurrency.answer}</span>
                <span>评判 {longMemEvalRunState.effectiveConcurrency.judge}</span>
              </div>
            ) : null}
            {longMemEvalRunState.activeSamples?.length ? (
              <div className="audit-list">
                {longMemEvalRunState.activeSamples.map((sample) => (
                  <div className="audit-row" key={`${sample.modelRunId}:${sample.sampleIndex}:${sample.questionId}`}>
                    <strong>#{sample.sampleIndex} {sample.questionId}</strong>
                    <span>{translateLongMemEvalStage(normalizeLongMemEvalActiveStage(sample.stage))}</span>
                    <span>{sample.status}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {longMemEvalRunState.llmRequest ? (
              <div className={`batch-stats batch-stats-secondary llm-request-row ${longMemEvalRunState.llmRequest.status}`}>
                <span>LLM 请求：{translateLongMemEvalLlmOperation(longMemEvalRunState.llmRequest.operation)}</span>
                <span>{translateLongMemEvalLlmStatus(longMemEvalRunState.llmRequest.status)}</span>
                <span>耗时 {formatLongMemEvalLlmElapsed(longMemEvalRunState.llmRequest)}</span>
                <span>active {longMemEvalRunState.llmRequest.active} / done {longMemEvalRunState.llmRequest.completed} / failed {longMemEvalRunState.llmRequest.failed}</span>
                <span>
                  {typeof longMemEvalRunState.llmRequest.batchIndex === "number" && typeof longMemEvalRunState.llmRequest.batchCount === "number"
                    ? `LLM 批次 ${longMemEvalRunState.llmRequest.batchIndex} / ${longMemEvalRunState.llmRequest.batchCount}`
                    : "LLM 批次未分片"}
                </span>
                <span>{longMemEvalRunState.llmRequest.error ? preview(formatLongMemEvalFallbackError(longMemEvalRunState.llmRequest.error), 120) : preview(longMemEvalRunState.llmRequest.endpoint, 80)}</span>
              </div>
            ) : null}
            <div className="metric-strip eval-strip">
              <div className="metric metric-wide">
                <span>当前问题</span>
                <strong>{longMemEvalRunState.currentQuestion ?? longMemEvalRunState.currentQuestionType ?? longMemEvalDatasetPath}</strong>
              </div>
              {longMemEvalRunState.currentHypothesis ? (
                <div className="metric metric-wide">
                  <span>Hypothesis</span>
                  <strong>{longMemEvalRunState.currentHypothesis}</strong>
                </div>
              ) : null}
              {longMemEvalRunState.currentJudgment ? (
                <div className="metric metric-wide">
                  <span>Judge</span>
                  <strong>{longMemEvalRunState.currentJudgment}</strong>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {longMemEvalRunState.status !== "idle" && longMemEvalRunState.status !== "running" && longMemEvalRunState.status !== "queued" && (longMemEvalRunState.resultPath || longMemEvalRunState.tracePath) ? (
          <div className="batch-summary">
            <div className="batch-stats batch-stats-secondary">
              <span>恢复 {longMemEvalRunState.resumedSamples ?? 0}</span>
              <span>本次提交 {longMemEvalRunState.committedSamples ?? 0}</span>
              <span>{longMemEvalRunState.resultPath ?? "无结果路径"}</span>
              <span>{longMemEvalRunState.tracePath ?? "无 Trace 路径"}</span>
            </div>
            {longMemEvalRunState.modelArtifacts?.map((artifact) => (
              <div className="batch-stats batch-stats-secondary" key={artifact.modelRunId}>
                <span>{artifact.modelRunId}</span>
                <span>{artifact.resultPath ?? "无结果路径"}</span>
                <span>{artifact.tracePath ?? "无 Trace 路径"}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="eval-results">
          {longMemEvalView === "pack" ? (
            <ContextPackView
              task={packTask}
              budget={packBudget}
              pack={longMemEvalContextPack}
              traces={[]}
              scopeField={{
                label: "Question ID",
                placeholder: "例如 58bf7951",
                value: longMemEvalPackQuestionId,
                onChange: onPackQuestionIdChange
              }}
              onTaskChange={onPackTaskChange}
              onBudgetChange={onPackBudgetChange}
              onAssemble={onAssembleLongMemEvalPack}
              onSelect={onSelect}
            />
          ) : longMemEvalView === "summary" ? (
            longMemEvalReport ? (
              <>
                {isLongMemEvalMultiModelReport(longMemEvalReport) ? (
                  <div className="metric-strip eval-strip">
                    <div className="metric">
                      <span>模型完成</span>
                      <strong>{longMemEvalReport.completedRuns} / {longMemEvalReport.totalRuns}</strong>
                    </div>
                    <div className="metric">
                      <span>并发</span>
                      <strong>{longMemEvalReport.modelConcurrency}</strong>
                    </div>
                    <div className="metric metric-wide">
                      <span>模型准确率</span>
                      <strong>{longMemEvalReport.summary.map((item) => `${item.runId}:${typeof item.judgeAccuracy === "number" ? item.judgeAccuracy.toFixed(3) : item.status}`).join(" · ")}</strong>
                    </div>
                  </div>
                ) : null}
                {primaryLongMemEvalReport?.ingestion ? (
                  <div className="metric-strip eval-strip">
                    <div className="metric">
                      <span>入库会话</span>
                      <strong>{primaryLongMemEvalReport.ingestion.ingestedSessions} / {primaryLongMemEvalReport.ingestion.totalSessions}</strong>
                    </div>
                    <div className="metric">
                      <span>跳过会话</span>
                      <strong>{primaryLongMemEvalReport.ingestion.skippedSessions}</strong>
                    </div>
                    <div className="metric">
                      <span>答题率</span>
                      <strong>{primaryLongMemEvalReport.answerGeneration?.answerRate.toFixed(3) ?? "0.000"}</strong>
                    </div>
                    <div className="metric">
                      <span>答题失败</span>
                      <strong>{primaryLongMemEvalReport.answerGeneration?.failed ?? 0}</strong>
                    </div>
                  </div>
                ) : null}
                {primaryLongMemEvalReport ? (
                  <>
                    <div className="metric-strip eval-strip">
                      <div className="metric">
                        <span>整体准确率</span>
                        <strong>{primaryLongMemEvalReport.judge?.accuracy.toFixed(3) ?? "n/a"}</strong>
                      </div>
                      <div className="metric metric-wide">
                        <span>样本 / 类型</span>
                        <strong>{`${primaryLongMemEvalReport.totalSamples} · ${Object.entries(primaryLongMemEvalReport.questionTypeCounts).map(([key, value]) => `${key}:${value}`).join(" · ")}`}</strong>
                      </div>
                    </div>
                    <div className="metric-strip eval-strip">
                      <div className="metric metric-wide">
                        <span>任务正确率</span>
                        <strong>{Object.entries(primaryLongMemEvalReport.questionTypeAccuracy).map(([key, value]) => `${key}:${value.judgeAccuracy.toFixed(3)}`).join(" · ")}</strong>
                      </div>
                    </div>
                    <div className="metrics-grid eval-grid">
                      {Object.values(primaryLongMemEvalReport.metrics).map((metric) => (
                        <div className="metric" key={metric.k}>
                          <span>@{metric.k}</span>
                          <strong>Any {metric.recallAnyAtK.toFixed(3)}</strong>
                          <span>All {metric.recallAllAtK.toFixed(3)} / NDCG {metric.ndcgAtK.toFixed(3)}</span>
                          <span>EM {metric.exactMatch.toFixed(3)} / Judge {metric.judgeAccuracy.toFixed(3)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <div className="empty-state small">输入数据集路径并运行评测。</div>
            )
          ) : longMemEvalView === "jsonl" ? (
          <LongMemEvalJsonlResultView
            fileName={longMemEvalJsonlFileName}
            page={longMemEvalJsonlResult}
            status={longMemEvalJsonlStatus}
            error={longMemEvalJsonlError}
            currentPage={longMemEvalJsonlPage}
            onFileSelect={selectLongMemEvalJsonlFile}
            onPageChange={onJsonlPageChange}
            onInspectSelectedItems={inspectLongMemEvalJsonlSelectedItems}
            diagnostic={longMemEvalDiagnostic}
            onCloseDiagnostic={() => setLongMemEvalDiagnostic(null)}
          />
          ) : (
            <LongMemEvalStoredDataView
              snapshot={longMemEvalStoredSnapshot}
              status={longMemEvalStoredStatus}
              error={longMemEvalStoredError}
              disabled={false}
              timeline={longMemEvalStoredTimeline}
              view={longMemEvalView}
              page={longMemEvalStoredPage}
              totalItems={longMemEvalStoredTotalItems}
              totalPages={longMemEvalStoredTotalPages}
              onPageChange={setLongMemEvalStoredPage}
              onSelect={onSelect}
            />
          )}
        </div>
          </>
        )}
      </section>
    </div>
  );
}

function LocomoEvaluationPanel({
  datasetPath,
  llmSettings,
  llmTestState,
  onLlmSettingsChange,
  onTestLlm
}: {
  datasetPath: string;
  llmSettings: LongMemEvalLlmSettings;
  llmTestState: LongMemEvalLlmTestState;
  onLlmSettingsChange: (value: LongMemEvalLlmSettings) => void;
  onTestLlm: (target: LongMemEvalLlmTestTarget) => Promise<void>;
}) {
  const [storePath, setStorePath] = React.useState("");
  const [sampleIds, setSampleIds] = React.useState("");
  const [sampleRange, setSampleRange] = React.useState("");
  const [questionLimit, setQuestionLimit] = React.useState("");
  const [job, setJob] = React.useState<LocomoEvaluationJob | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!job?.jobId || (job.status !== "queued" && job.status !== "running")) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void requestLocomoEvaluationJob(fetch, job.jobId).then((response) => {
        if (cancelled) return;
        if (response.ok && response.result) setJob(response.result);
        else if (response.error) setError(response.error);
      });
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job?.jobId, job?.status]);

  async function run() {
    setError("");
    const range = parseLocomoUiRange(sampleRange);
    if (sampleRange.trim() && !range) {
      setError("conversation 范围应使用 1:2 格式");
      return;
    }
    if (sampleIds.trim() && range) {
      setError("conversation ID 与范围只能选择一种");
      return;
    }
    const limit = questionLimit.trim() ? Number(questionLimit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      setError("题数限制必须是正整数");
      return;
    }
    const response = await requestLocomoEvaluation(fetch, {
      datasetPath: datasetPath.trim(),
      command: "full",
      ...(storePath.trim() ? { storePath: storePath.trim() } : {}),
      ...(sampleIds.trim() ? { sampleIds: sampleIds.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
      ...(range ? { sampleRange: range } : {}),
      ...(limit ? { questionLimit: limit } : {}),
      questionConcurrency: llmSettings.answerConcurrency,
      llm: buildLongMemEvalLlmPayload(llmSettings, true),
      disableIngestLlm: llmSettings.disableIngestLlm
    });
    if (!response.ok || !response.result) {
      setError(response.error ?? "LoCoMo 评测启动失败");
      return;
    }
    setJob(response.result);
  }

  async function cancel() {
    if (!job?.jobId) return;
    const response = await requestCancelLocomoEvaluation(fetch, job.jobId);
    if (response.ok && response.result) setJob(response.result);
    else setError(response.error ?? "LoCoMo 评测终止失败");
  }

  const running = job?.status === "queued" || job?.status === "running";
  return (
    <div className="dataset-specific-evaluation" aria-label="LoCoMo 原生评测配置">
      <div className="evaluation-route-status"><span>当前链路</span><strong>LoCoMo 原生评测</strong><span>{job ? formatLocomoJobStatus(job) : "未运行"}</span></div>
      <div className="eval-controls">
        <div className="eval-form">
          <label>
            Conversation ID
            <input value={sampleIds} onChange={(event) => setSampleIds(event.target.value)} placeholder="conv-26,conv-30" />
          </label>
          <label>
            Conversation 范围
            <input value={sampleRange} onChange={(event) => setSampleRange(event.target.value)} placeholder="1:2" />
          </label>
          <label>
            题数限制
            <input min={1} type="number" value={questionLimit} onChange={(event) => setQuestionLimit(event.target.value)} placeholder="全部" />
          </label>
          <label>
            Store 路径
            <input value={storePath} onChange={(event) => setStorePath(event.target.value)} placeholder="自动生成独立 SQLite" />
          </label>
          <label>
            提取端点
            <input
              value={llmSettings.extractionBaseUrl}
              onChange={(event) => onLlmSettingsChange({ ...llmSettings, extractionBaseUrl: event.target.value })}
              placeholder="留空则使用后端配置"
            />
          </label>
          <label>
            提取模型
            <input
              value={llmSettings.extractionModel}
              onChange={(event) => onLlmSettingsChange({ ...llmSettings, extractionModel: event.target.value })}
              placeholder="留空则使用后端配置"
            />
          </label>
          <label>
            提取 Key
            <input
              value={llmSettings.extractionApiKey}
              onChange={(event) => onLlmSettingsChange({ ...llmSettings, extractionApiKey: event.target.value })}
              type="password"
            />
          </label>
          <label>
            答题端点
            <input
              value={llmSettings.answerBaseUrl}
              onChange={(event) => onLlmSettingsChange({ ...llmSettings, answerBaseUrl: event.target.value })}
              placeholder="留空则回退到提取端点"
            />
          </label>
          <label>
            答题模型
            <input
              value={llmSettings.answerModel}
              onChange={(event) => onLlmSettingsChange({ ...llmSettings, answerModel: event.target.value })}
              placeholder="留空则回退到提取模型"
            />
          </label>
          <label>
            答题 Key
            <input
              value={llmSettings.answerApiKey}
              onChange={(event) => onLlmSettingsChange({ ...llmSettings, answerApiKey: event.target.value })}
              type="password"
            />
          </label>
          <label>
            Judge
            <input disabled value="LoCoMo 官方 token F1（无需模型）" />
          </label>
        </div>
        <div className="llm-actions">
          <button className="secondary-action" disabled={llmTestState.status === "testing"} onClick={() => void onTestLlm("extraction")} type="button">
            测试提取模型
          </button>
          <button className="secondary-action" disabled={llmTestState.status === "testing"} onClick={() => void onTestLlm("ingest")} type="button">
            测试入库 LLM
          </button>
          <button className="secondary-action" disabled={llmTestState.status === "testing"} onClick={() => void onTestLlm("answer")} type="button">
            测试答题模型
          </button>
        </div>
        {llmTestState.status !== "idle" ? (
          <div className={`llm-test-status ${llmTestState.status}`} aria-live="polite">
            <strong>{llmTestState.status === "testing" ? "测试中" : llmTestState.status === "ok" ? "调用正常" : "调用失败"}</strong>
            <span>
              {llmTestState.message ?? ""}
              {typeof llmTestState.elapsedMs === "number" ? ` · ${llmTestState.elapsedMs}ms` : ""}
              {formatLlmTokenUsage(llmTestState.tokenUsage)}
            </span>
          </div>
        ) : null}
        <div className="eval-options">
          <label className="checkbox">
            <input
              checked={llmSettings.disableIngestLlm}
              onChange={(event) => onLlmSettingsChange({ ...llmSettings, disableIngestLlm: event.target.checked })}
              type="checkbox"
            />
            跳过入库 LLM
          </label>
          <div className="empty-state small hint">LoCoMo 固定使用 Context Pack、Fact + STM 和官方 token F1，不执行 LTM，也不调用 Judge 模型。</div>
        </div>
        <div className="toolbar-actions">
          <button type="button" onClick={() => void run()} disabled={running || !datasetPath.trim()}>
            {running ? "运行中..." : "运行 LoCoMo 评测"}
          </button>
          <button className="secondary-action" type="button" onClick={() => void cancel()} disabled={!running}>终止</button>
        </div>
      </div>
      {error || job?.error ? <div className="empty-state small error-text">{error || job?.error}</div> : null}
      {job ? (
        <>
          <div className="progress-track" aria-label="LoCoMo 评测进度"><span style={{ width: `${job.progress ?? 0}%` }} /></div>
          <div className="metric-strip eval-strip">
            <div className="metric"><span>进度</span><strong>{job.progress ?? 0}%</strong></div>
            <div className="metric"><span>Conversation</span><strong>{job.processedConversations ?? 0} / {job.totalConversations ?? 0}</strong></div>
            <div className="metric"><span>问题</span><strong>{job.processedQuestions ?? 0} / {job.totalQuestions ?? 0}</strong></div>
            <div className="metric metric-wide"><span>当前</span><strong>{job.currentQuestionId ?? job.currentConversationId ?? "-"}</strong></div>
          </div>
          {job.summary ? (
            <div className="metrics-grid eval-grid">
              <div className="metric"><span>官方 QA 平均 F1</span><strong>{job.summary.overallOfficialQaScore.toFixed(3)}</strong></div>
              <div className="metric"><span>满分题比例</span><strong>{job.summary.perfectScoreRate.toFixed(3)}</strong></div>
              {Object.entries(job.summary.categoryScores).map(([category, value]) => (
                <div className="metric" key={category}><span>Category {category}</span><strong>{value.score.toFixed(3)}</strong><span>{value.count} 题</span></div>
              ))}
            </div>
          ) : null}
        </>
      ) : <div className="empty-state small">该入口只接受包含 sample_id、conversation 和 qa 的 LoCoMo 数据集。</div>}
    </div>
  );
}

function parseLocomoUiRange(value: string) {
  if (!value.trim()) return undefined;
  const match = /^(\d+):(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start >= 1 && end >= start ? { start, end } : undefined;
}

function formatLocomoJobStatus(job: LocomoEvaluationJob) {
  if (job.status === "done") return "已完成";
  if (job.status === "error") return "失败";
  if (job.status === "cancelled") return "已终止";
  if (job.status === "queued") return "已排队";
  return "运行中";
}

function LongMemEvalJsonlResultView({
  fileName,
  page,
  status,
  error,
  currentPage,
  onFileSelect,
  onPageChange,
  onInspectSelectedItems,
  diagnostic,
  onCloseDiagnostic
}: {
  fileName: string;
  page: LongMemEvalJsonlResultPage | null;
  status: "idle" | "loading" | "error";
  error: string;
  currentPage: number;
  onFileSelect: (file: File | null) => Promise<void>;
  onPageChange: (page: number) => void;
  onInspectSelectedItems: (item: LongMemEvalJsonlResultItem) => Promise<void>;
  diagnostic: {
    item: LongMemEvalJsonlResultItem;
    details: LongMemEvalSelectedItemDetail[];
    missingItemIds: string[];
    status: "idle" | "loading" | "error";
    error?: string;
  } | null;
  onCloseDiagnostic: () => void;
}) {
  const [expandedErrorReason, setExpandedErrorReason] = React.useState("");
  const [errorReasonVisibleCounts, setErrorReasonVisibleCounts] = React.useState<Record<string, number>>({});

  const picker = (
    <section className="data-lake-panel jsonl-file-panel">
      <div className="panel-header">
        <h2>JSONL 结果解析</h2>
        <span>{fileName || "未选择文件"}</span>
      </div>
      <label className="jsonl-file-picker">
        <span>选择答题结果 JSONL</span>
        <input
          accept=".jsonl,application/jsonl,application/x-ndjson,application/json,text/plain"
          onChange={(event) => void onFileSelect(event.target.files?.[0] ?? null)}
          type="file"
        />
      </label>
    </section>
  );

  const allErrorItems = React.useMemo(
    () => (page?.allItems ?? page?.items ?? []).filter((item) => item.correct === false),
    [page]
  );
  const errorReasonGroups = React.useMemo(() => {
    const groups = new Map<string, LongMemEvalJsonlResultItem[]>();
    for (const item of allErrorItems) {
      const reason = item.errorReason ?? item.reason ?? "incorrect";
      const list = groups.get(reason);
      if (list) {
        list.push(item);
      } else {
        groups.set(reason, [item]);
      }
    }
    return Array.from(groups.entries())
      .map(([reason, items]) => ({
        reason,
        count: items.length,
        items: items.slice().sort((a, b) => a.lineNumber - b.lineNumber)
      }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "zh-Hans-CN"));
  }, [allErrorItems]);

  React.useEffect(() => {
    if (!expandedErrorReason) return;
    if (errorReasonGroups.some((group) => group.reason === expandedErrorReason)) return;
    setExpandedErrorReason("");
  }, [errorReasonGroups, expandedErrorReason]);

  if (diagnostic) {
    return <LongMemEvalSampleDiagnostic diagnostic={diagnostic} onClose={onCloseDiagnostic} />;
  }

  if (status === "loading" && !page) {
    return <div className="jsonl-results">{picker}<div className="empty-state small">正在解析 LongMemEval JSONL 结果...</div></div>;
  }
  if (status === "error") {
    return <div className="jsonl-results">{picker}<div className="empty-state small">{error || "LongMemEval JSONL 结果解析失败"}</div></div>;
  }
  if (!page) {
    return <div className="jsonl-results">{picker}<div className="empty-state small">选择 JSONL 文件后可查看准确率、错误原因和分页明细。</div></div>;
  }

  const summary = page.summary;
  const topDroppedReasons = Object.entries(summary.selection.droppedReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const toggleErrorReason = (reason: string) => {
    setExpandedErrorReason((current) => (current === reason ? "" : reason));
    setErrorReasonVisibleCounts((current) => ({
      ...current,
      [reason]: current[reason] ?? 8
    }));
  };

  const loadMoreErrorReasonItems = (reason: string, total: number) => {
    setErrorReasonVisibleCounts((current) => ({
      ...current,
      [reason]: Math.min(total, (current[reason] ?? 8) + 8)
    }));
  };

  return (
    <div className="jsonl-results">
      {picker}
      <div className="metric-strip eval-strip">
        <div className="metric">
          <span>准确率</span>
          <strong>{formatRatio(summary.accuracy)}</strong>
        </div>
        <div className="metric">
          <span>正确 / 已判定</span>
          <strong>{summary.correctItems} / {summary.judgedItems}</strong>
        </div>
        <div className="metric">
          <span>Exact Match</span>
          <strong>{formatRatio(summary.exactMatchAccuracy)}</strong>
        </div>
        <div className="metric">
          <span>答题 fallback</span>
          <strong>{summary.answerFallbacks}</strong>
        </div>
        <div className="metric metric-wide">
          <span>选择项</span>
          <strong>{summary.selection.totalSelectedItems} / {summary.selection.rowsWithSelection} 行</strong>
        </div>
      </div>
      <div className="metric-strip eval-strip">
        <div className="metric metric-wide jsonl-question-type-metric">
          <span>模型结果</span>
          {Object.keys(summary.modelGroups).length ? (
            <div className="jsonl-question-type-list">
              {Object.entries(summary.modelGroups).map(([modelRunId, item]) => (
                <span className="jsonl-question-type-item" key={modelRunId}>
                  <strong>{modelRunId}</strong>
                  <span>{item.totalItems} 条 · {formatRatio(item.accuracy)}</span>
                </span>
              ))}
            </div>
          ) : <strong>n/a</strong>}
        </div>
        <div className="metric metric-wide jsonl-question-type-metric">
          <span>题型准确率</span>
          {Object.keys(summary.questionTypeAccuracy).length ? (
            <div className="jsonl-question-type-list">
              {Object.entries(summary.questionTypeAccuracy).map(([type, item]) => (
                <span className="jsonl-question-type-item" key={type}>
                  <strong>{type}</strong>
                  <span>{formatRatio(item.accuracy)} · {item.correct}/{item.judged}</span>
                </span>
              ))}
            </div>
          ) : <strong>n/a</strong>}
        </div>
        <div className="metric metric-wide">
          <span>文件</span>
          <strong>{summary.filePath}</strong>
        </div>
      </div>
      <div className="jsonl-reason-grid">
        <section className="data-lake-panel">
          <div className="panel-header">
            <h2>错误原因</h2>
            <span>{summary.incorrectItems} 条错误</span>
          </div>
          <div className="jsonl-reason-list">
            {errorReasonGroups.length ? errorReasonGroups.map((group) => {
              const isExpanded = expandedErrorReason === group.reason;
              const visibleCount = errorReasonVisibleCounts[group.reason] ?? 8;
              const visibleItems = isExpanded ? group.items.slice(0, visibleCount) : [];
              return (
                <div className="jsonl-reason-group" key={group.reason}>
                  <button
                    className={`jsonl-reason-row ${isExpanded ? "expanded" : ""}`}
                    onClick={() => toggleErrorReason(group.reason)}
                    type="button"
                  >
                    <strong>{group.reason}</strong>
                    <span>{group.count} 条</span>
                  </button>
                  {isExpanded ? (
                    <div className="jsonl-reason-samples">
                      {visibleItems.map((item) => (
                        <button
                          className={`jsonl-reason-sample ${item.correct === false ? "incorrect" : ""}`}
                          key={`${item.lineNumber}-${item.questionId}`}
                          onClick={() => void onInspectSelectedItems(item)}
                          type="button"
                        >
                          <span className="jsonl-reason-sample-head">
                            <strong>{item.questionId}</strong>
                            <span>第 {item.lineNumber} 行</span>
                          </span>
                          <span>{item.questionType}</span>
                          <span>{preview(item.question || item.answer || item.hypothesis, 120)}</span>
                          <span>答案：{preview(item.answer || "n/a", 70)} · 输出：{preview(item.hypothesis || "n/a", 70)}</span>
                        </button>
                      ))}
                      {group.items.length > visibleCount ? (
                        <button
                          className="jsonl-reason-more"
                          onClick={() => loadMoreErrorReasonItems(group.reason, group.items.length)}
                          type="button"
                        >
                          加载更多样本（剩余 {group.items.length - visibleCount} 条）
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            }) : <div className="empty-state small">暂无错误原因。</div>}
          </div>
        </section>
        <section className="data-lake-panel">
          <div className="panel-header">
            <h2>选择丢弃原因</h2>
            <span>{summary.selection.rowsWithSelection} 行含选择</span>
          </div>
          <div className="audit-list compact-list">
            {topDroppedReasons.length ? topDroppedReasons.map(([reason, count]) => (
              <div className="audit-row" key={reason}>
                <strong>{reason}</strong>
                <span>{count}</span>
              </div>
            )) : <div className="empty-state small">暂无选择丢弃原因。</div>}
          </div>
        </section>
      </div>
      <LongMemEvalDebugPager
        page={page.page}
        totalPages={page.totalPages}
        totalItems={summary.totalItems}
        onPageChange={onPageChange}
      />
      <div className="jsonl-result-list">
        {page.items.map((item) => (
          <button
            className={`jsonl-result-row ${item.correct === false ? "incorrect" : item.correct === true ? "correct" : ""}`}
            key={`${item.lineNumber}-${item.questionId}`}
            onClick={() => void onInspectSelectedItems(item)}
            type="button"
          >
            <span className="jsonl-result-status">{item.correct === true ? "正确" : item.correct === false ? "错误" : "未判定"}</span>
            <strong>{item.questionId} · {item.questionType}</strong>
            <span>{preview(item.question || item.answer || item.hypothesis, 180)}</span>
            <span>答案：{preview(item.answer || "n/a", 90)} · 输出：{preview(item.hypothesis || "n/a", 90)}</span>
            <span>原因：{item.errorReason ?? item.reason ?? "n/a"} · 选择 {item.selectedItemCount}</span>
          </button>
        ))}
        {!page.items.length ? <div className="empty-state small">当前页暂无 JSONL 结果。</div> : null}
      </div>
      {status === "loading" ? <div className="empty-state small">正在刷新当前页...</div> : null}
      {currentPage !== page.page ? <div className="empty-state small">已自动定位到第 {page.page} 页。</div> : null}
    </div>
  );
}

function LongMemEvalSampleDiagnostic({
  diagnostic,
  onClose
}: {
  diagnostic: {
    item: LongMemEvalJsonlResultItem;
    details: LongMemEvalSelectedItemDetail[];
    missingItemIds: string[];
    status: "idle" | "loading" | "error";
    error?: string;
  };
  onClose: () => void;
}) {
  const { item, details, missingItemIds, status, error } = diagnostic;
  const [expandedEvidenceId, setExpandedEvidenceId] = React.useState<string | null>(null);
  const [evidenceTabs, setEvidenceTabs] = React.useState<Record<string, "source" | "raw">>({});
  const detailById = React.useMemo(() => new Map(details.map((detail) => [detail.id, detail] as const)), [details]);
  const evidenceItems: LongMemEvalSelectedEvidence[] = item.selectedItems?.length
    ? item.selectedItems
    : item.selectedItemIds.map((id) => ({
        id,
        layer: inferLongMemEvalEvidenceLayer(id),
        sourceIds: [],
        sourceSessionIds: [],
        sourceRoles: [],
        factIds: [],
        memoryIds: [],
        relationTypes: []
      }));
  const diagnosis = describeLongMemEvalDiagnostic(item);
  const tokenBudget = item.tokenBudget;

  return (
    <section className="eval-diagnostic" aria-label="单题诊断">
      <header className="eval-diagnostic-header">
        <button className="eval-back-button" onClick={onClose} type="button">← 返回测评结果</button>
        <div className="eval-diagnostic-title">
          <div className="eval-diagnostic-tags">
            <span className={`eval-outcome ${item.correct === true ? "correct" : item.correct === false ? "incorrect" : "unknown"}`}>
              {item.correct === true ? "正确" : item.correct === false ? "错误" : "未判定"}
            </span>
            <span>{item.questionType}</span>
            <span>{item.modelRunId ?? "default"}</span>
          </div>
          <h2>{item.questionId}</h2>
        </div>
      </header>

      <section className="eval-question-band">
        <span>问题</span>
        <strong>{item.question || "当前结果未记录问题正文"}</strong>
      </section>

      <div className="eval-answer-compare">
        <section>
          <span>标准答案</span>
          <p>{item.answer || "未提供"}</p>
        </section>
        <section className={item.correct === false ? "answer-incorrect" : ""}>
          <span>模型答案</span>
          <p>{item.hypothesis || "未生成答案"}</p>
        </section>
      </div>

      <section className={`eval-diagnosis-band ${diagnosis.tone}`}>
        <div>
          <span>诊断</span>
          <strong>{diagnosis.title}</strong>
          <p>{diagnosis.detail}</p>
        </div>
        <dl className="eval-diagnostic-facts">
          <div><dt>Judge</dt><dd>{item.errorReason ?? item.reason ?? "n/a"}</dd></div>
          <div><dt>证据</dt><dd>{item.selectedItemCount} 条</dd></div>
          <div><dt>上下文</dt><dd>{item.answerContextMode ?? "n/a"}</dd></div>
          <div>
            <dt>Token</dt>
            <dd>{tokenBudget?.used ?? "n/a"}{tokenBudget?.requested !== undefined ? ` / ${tokenBudget.requested}` : ""}</dd>
          </div>
        </dl>
      </section>

      <section className="eval-evidence-section">
        <div className="panel-header">
          <div>
            <h2>进入答案上下文的证据</h2>
            <p>按 Context Pack 中的顺序展示，展开可追溯到 Fact 和原始会话片段。</p>
          </div>
          <span>{evidenceItems.length} 条</span>
        </div>

        {status === "loading" ? <div className="empty-state small">正在读取证据来源...</div> : null}
        {status === "error" ? <div className="eval-evidence-error">{error ?? "证据来源读取失败"}</div> : null}
        {!evidenceItems.length ? (
          <div className="eval-no-evidence">
            <strong>本题没有选中证据</strong>
            <span>模型答案未使用可追溯的 Fact、STM 或 LTM，需要从召回和 Context Pack 选择阶段开始排查。</span>
          </div>
        ) : (
          <div className="eval-evidence-table">
            <div className="eval-evidence-head" aria-hidden="true">
              <span>#</span><span>记忆摘要</span><span>层级</span><span>来源</span><span>时间</span><span>分数</span><span />
            </div>
            {evidenceItems.map((evidence, index) => {
              const detail = detailById.get(evidence.id);
              const expanded = expandedEvidenceId === evidence.id;
              const activeTab = evidenceTabs[evidence.id] ?? "source";
              const firstSourceSegment = detail?.sourceSegments?.[0];
              const sourceLabel = evidence.sourceSessionIds[0] ?? firstSourceSegment?.sourceId ?? evidence.sourceIds[0] ?? "未记录";
              const evidenceTime = evidence.evidenceTime ?? evidence.validTime ?? firstSourceSegment?.eventTime;
              return (
                <article className={`eval-evidence-item ${expanded ? "expanded" : ""}`} key={evidence.id}>
                  <button
                    className="eval-evidence-row"
                    aria-expanded={expanded}
                    onClick={() => setExpandedEvidenceId((current) => current === evidence.id ? null : evidence.id)}
                    type="button"
                  >
                    <span className="eval-evidence-index">{index + 1}</span>
                    <span className="eval-evidence-summary">
                      <strong>{detail?.summary ?? detail?.compressedContent ?? detail?.content ?? evidence.id}</strong>
                      <small>{evidence.id}</small>
                    </span>
                    <span className={`eval-layer-badge ${evidence.layer}`}>{evidence.layer.toUpperCase()}</span>
                    <span>{sourceLabel}</span>
                    <span>{evidenceTime ? formatCompactDate(evidenceTime) : "未记录"}</span>
                    <span>{typeof evidence.score === "number" ? evidence.score.toFixed(3) : "n/a"}</span>
                    <span className="eval-evidence-toggle">{expanded ? "收起" : "展开"}</span>
                  </button>

                  {expanded ? (
                    <div className="eval-evidence-detail">
                      <div className="segmented compact eval-evidence-tabs" role="tablist" aria-label="证据详情视图">
                        <button
                          aria-selected={activeTab === "source"}
                          className={activeTab === "source" ? "active" : ""}
                          onClick={() => setEvidenceTabs((current) => ({ ...current, [evidence.id]: "source" }))}
                          role="tab"
                          type="button"
                        >
                          证据链
                        </button>
                        <button
                          aria-selected={activeTab === "raw"}
                          className={activeTab === "raw" ? "active" : ""}
                          onClick={() => setEvidenceTabs((current) => ({ ...current, [evidence.id]: "raw" }))}
                          role="tab"
                          type="button"
                        >
                          原始数据
                        </button>
                      </div>

                      {activeTab === "source" ? (
                        <div className="eval-source-chain">
                          <section>
                            <span>记忆</span>
                            <p>{detail?.content ?? "详情接口未返回该记忆"}</p>
                          </section>
                          <section>
                            <span>关联 Fact</span>
                            <div className="eval-id-list">
                              {(evidence.factIds.length ? evidence.factIds : readStringArray(detail?.metadata.sourceFactIds)).map((factId) => (
                                <code key={factId}>{factId}</code>
                              ))}
                              {!evidence.factIds.length && !readStringArray(detail?.metadata.sourceFactIds).length ? <em>未记录 Fact 关联</em> : null}
                            </div>
                          </section>
                          <section>
                            <span>原始会话片段</span>
                            <div className="eval-source-list">
                              {detail?.sourceSegments?.length ? detail.sourceSegments.map((segment) => (
                                <blockquote key={segment.segmentId}>
                                  <div>
                                    <strong>{segment.sourceId ?? segment.eventId}</strong>
                                    <time>{segment.eventTime ? formatCompactDate(segment.eventTime) : "时间未记录"}</time>
                                  </div>
                                  <p>{segment.content}</p>
                                </blockquote>
                              )) : <em>没有可用的原始会话片段</em>}
                            </div>
                          </section>
                        </div>
                      ) : (
                        <pre className="eval-raw-data">{JSON.stringify({ evidence, detail }, null, 2)}</pre>
                      )}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
        {missingItemIds.length ? (
          <div className="eval-missing-evidence">未找到 {missingItemIds.length} 条证据：{missingItemIds.join(" · ")}</div>
        ) : null}
      </section>
    </section>
  );
}

function describeLongMemEvalDiagnostic(item: LongMemEvalJsonlResultItem): { title: string; detail: string; tone: "success" | "warning" | "danger" } {
  if (item.status === "skipped") {
    return { title: "样本未完成评测", detail: item.reason ?? item.errorReason ?? "评测流水线在形成答案前结束。", tone: "warning" };
  }
  if (item.answerFallbackUsed) {
    return { title: "答案使用了 fallback", detail: item.answerFallbackReason ?? "主答题链路未正常生成答案，请先检查 fallback 原因。", tone: "warning" };
  }
  if (item.correct === true) {
    return { title: "证据和答案通过评判", detail: `模型使用 ${item.selectedItemCount} 条证据形成答案，Judge 判定结果正确。`, tone: "success" };
  }
  const stage = item.failureClassification?.stage;
  const diagnoses: Record<string, { title: string; detail: string }> = {
    memory_not_generated: { title: "记忆生成阶段缺失答案证据", detail: "已入库的 Fact 和 STM 中未发现可直接覆盖标准答案的证据。" },
    not_in_top_100: { title: "相关记忆未进入召回前 100", detail: "记忆已经生成，但召回排序未把包含答案的证据送入候选集合。" },
    budget_rejected: { title: "相关证据被预算淘汰", detail: "包含答案的候选已召回，但在 Context Pack 预算裁剪时被移除。" },
    not_selected: { title: "相关证据未进入最终 Context Pack", detail: "召回候选中存在答案证据，但选择阶段采用了其他记忆。" },
    rendering_missing: { title: "已选证据未进入答题 Prompt", detail: "Context Pack 已选择相关证据，但最终渲染的答题上下文缺失该内容。" },
    prompt_ready: { title: "证据已到位，错误发生在回答阶段", detail: "包含标准答案的证据已经进入 Prompt，但模型没有据此给出正确答案。" },
    undetermined_requires_reasoning: { title: "需要进一步判断推理链", detail: "结构化诊断无法仅通过字面答案定位失败阶段。" },
    diagnostic_error: { title: "自动诊断未完成", detail: item.failureClassification?.detail ?? "诊断过程发生错误。" }
  };
  if (stage && diagnoses[stage]) return { ...diagnoses[stage], tone: "danger" };
  if (!item.selectedItemCount) {
    return { title: "没有证据进入答案上下文", detail: "优先检查召回范围、候选排序和 Context Pack 选择策略。", tone: "danger" };
  }
  return { title: "已有选中证据，但答案未通过评判", detail: "展开下方证据，核对所选记忆是否覆盖问题所需事实。", tone: "danger" };
}

function inferLongMemEvalEvidenceLayer(id: string) {
  if (id.startsWith("stm_")) return "stm";
  if (id.startsWith("ltm_")) return "ltm";
  if (id.startsWith("fact_")) return "fact";
  return "unknown";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatCompactDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function LongMemEvalStoredDataView({
  snapshot,
  timeline,
  view,
  status,
  error,
  disabled,
  page,
  totalItems,
  totalPages,
  onPageChange,
  onSelect
}: {
  snapshot: Snapshot;
  timeline: TimelineItem[];
  view: "dataLake" | "timeline" | "stm" | "ltm";
  status: "idle" | "loading" | "error";
  error: string;
  disabled: boolean;
  page: number;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onSelect: (item: unknown) => void;
}) {
  if (disabled) return <div className="empty-state small">LongMemEval 运行完成后可查看入库数据。</div>;
  if (status === "loading") return <div className="empty-state small">正在加载 LongMemEval 入库数据...</div>;
  if (status === "error") return <div className="empty-state small">{error || "LongMemEval 入库数据加载失败"}</div>;
  const pager = (
    <LongMemEvalDebugPager
      page={page}
      totalItems={totalItems}
      totalPages={totalPages}
      onPageChange={onPageChange}
    />
  );

  if (view === "dataLake") {
    return (
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>LongMemEval 数据湖</h2>
          <span>{snapshot.memoryEvents.length} 事件 / {snapshot.parsedSegments.length} 片段 / {snapshot.facts.length} 事实</span>
        </div>
        <div className="data-lake-grid">
          <DataLakeColumn
            title="解析片段"
            emptyText="暂无 LongMemEval 解析片段。"
            items={snapshot.parsedSegments}
            getKey={(segment) => segment.segmentId}
            getMeta={(segment) => `${translateValue(segment.modality)} / ${translateValue(segment.status)} / ${translateValue(segment.confidence)}`}
            getContent={(segment) => segment.content}
            getCustomFields={(segment) => segment.customFields}
            onSelect={onSelect}
          />
          <DataLakeColumn
            title="事实条目"
            emptyText="暂无 LongMemEval 事实条目。"
            items={snapshot.facts}
            getKey={(fact) => fact.factId}
            getMeta={(fact) => `${translateValue(fact.status)} / ${translateValue(fact.confidenceLevel)}`}
            getContent={(fact) => fact.factText}
            onSelect={onSelect}
          />
        </div>
        <div className="event-delete-list">
          {snapshot.memoryEvents.map((event) => (
            <article className="context-event-row" key={event.eventId}>
              <button className="row-main" onClick={() => onSelect(event)} type="button">
                <span className="row-kicker">{formatTime(event.eventTime)} / {event.sourceId ?? event.sourceApp ?? event.eventType}</span>
                <strong>{preview(formatContextEventTitle(event), 180)}</strong>
              </button>
            </article>
          ))}
          {!snapshot.memoryEvents.length ? <div className="empty-state small">暂无 LongMemEval 上下文事件。</div> : null}
        </div>
        {pager}
      </section>
    );
  }

  if (view === "timeline") {
    return (
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>LongMemEval 时间轴融合</h2>
          <span>{timeline.length} 条聚合事实</span>
        </div>
        <div className="evidence-list">
          {timeline.map((item) => (
            <button className="evidence-row" key={item.fact.aggregationId} onClick={() => onSelect(item)} type="button">
              <span className="row-kicker">
                {item.fact.factType} / {item.fact.sourceEventIds.length} 事件 / {formatTime(item.fact.validTimeStart)}
              </span>
              <strong>{preview(item.fact.factText, 180)}</strong>
              <span>{previewTimelineSources(item.fact.sourceEventIds, item.sourceEvents, item.sourceSegments, 180)}</span>
            </button>
          ))}
          {!timeline.length ? <div className="empty-state small">暂无 LongMemEval 时间轴融合结果。</div> : null}
        </div>
        {pager}
      </section>
    );
  }

  if (view === "stm") {
    const memories = snapshot.shortTermMemories.filter((memory) => memory.lifecycleStatus !== "deleted");
    return (
      <section className="data-lake-panel">
        <div className="panel-header">
          <h2>LongMemEval STM</h2>
          <span>{memories.length} 条</span>
        </div>
        <div className="memory-list">
          {memories.map((memory) => (
            <article className="memory-row" key={memory.memoryDataId}>
              <button className="row-main" onClick={() => onSelect(memory)} type="button">
                <span className="row-kicker">STM · {memory.memoryType ?? memory.memoryDataType} · {memory.memoryDataId}</span>
                <strong>{preview(formatMemoryCardSummary(memory), 140)}</strong>
                <span>{formatShortTermMemoryTrail(memory)}</span>
              </button>
              <div className="row-meta">
                <StatusBadge label={memory.lifecycleStatus} />
                <StatusBadge label={memory.importanceLevel} />
                <RetrievalWeightBadge label="系统权重" value={memory.retrievalWeight} fallback={memory.importanceLevel === "critical" ? 1 : memory.importanceLevel === "high" ? 0.8 : memory.importanceLevel === "medium" ? 0.5 : 0.2} />
              </div>
            </article>
          ))}
          {!memories.length ? <div className="empty-state small">暂无 LongMemEval STM。</div> : null}
        </div>
        {pager}
      </section>
    );
  }

  return (
    <section className="data-lake-panel">
      <div className="panel-header">
        <h2>LongMemEval LTM</h2>
        <span>{snapshot.longTermMemories.length} 条 / {snapshot.llmDreamingTraces.length} trace</span>
      </div>
      <div className="ltm-grid">
        {snapshot.longTermMemories.map((memory) => (
          <article className="ltm-card" key={memory.memoryId}>
            <button className="card-open" onClick={() => onSelect(memory)} type="button">
              <span className="row-kicker">{memory.theoryClass} / {memory.memoryType}</span>
              <strong>{preview(formatMemoryCardSummary(memory), 180)}</strong>
            </button>
            <div className="row-meta">
              <StatusBadge label={memory.lifecycleStatus} />
              <StatusBadge label={`召回权重 ${translateValue(memory.recallWeight)}`} />
              <RetrievalWeightBadge label="系统权重" value={memory.retrievalWeight} fallback={memory.recallWeight === "high" ? 1 : memory.recallWeight === "medium" ? 0.6 : 0.3} />
            </div>
          </article>
        ))}
      </div>
      {!snapshot.longTermMemories.length ? <div className="empty-state small">暂无 LongMemEval LTM。</div> : null}
      {pager}
    </section>
  );
}

function LongMemEvalDebugPager({
  page,
  totalItems,
  totalPages,
  onPageChange
}: {
  page: number;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="pager compact">
      <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} type="button">
        上一页
      </button>
      <span>{page} / {totalPages} · {totalItems} 条</span>
      <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} type="button">
        下一页
      </button>
    </div>
  );
}

function FlowNode({ label, value }: { label: string; value: string }) {
  return (
    <div className="flow-node">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ label }: { label: string }) {
  return <span className="badge">{translateValue(label)}</span>;
}

function formatTime(value: string) {
  return new Date(value).toLocaleString();
}

function formatRatio(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function preview(value: unknown, maxLength: number) {
  const text = previewText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function previewText(value: unknown) {
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
}

function formatMemoryCardSummary(memory: {
  structuredFacts?: {
    facts?: Array<{
      claim?: string;
      explanation?: string;
    }>;
  };
  factSummary?: string;
  summary?: string;
  content?: string;
}) {
  const structuredClaim = memory.structuredFacts?.facts
    ?.map((fact) => fact.claim?.trim())
    .find((claim): claim is string => Boolean(claim));
  return structuredClaim || memory.factSummary?.trim() || memory.summary?.trim() || memory.content?.trim() || "无短摘要";
}

function formatTimelineEventSource(event: MemoryEvent) {
  return [
    event.eventSummary?.trim() || event.eventDescription?.trim() || event.eventType,
    event.sourceApp || event.dataSource?.sourceApp,
    event.sourceId || event.dataSource?.sourceId
  ].filter(Boolean).join(" / ");
}

function previewTimelineSources(
  sourceEventIds: string[],
  sourceEvents: MemoryEvent[],
  sourceSegments: ParsedSegment[],
  maxLength: number
) {
  const eventTexts = sourceEvents.map(formatTimelineEventSource).filter(Boolean);
  if (eventTexts.length) return preview(eventTexts.join(" · "), maxLength);

  const segmentTexts = sourceSegments.map((segment) => previewText(segment.content).trim()).filter(Boolean);
  if (segmentTexts.length) return preview(segmentTexts.join(" · "), maxLength);

  return preview(sourceEventIds.join(" · "), maxLength);
}

function previewTimelineSegments(sourceSegments: ParsedSegment[], maxLength: number) {
  const texts = sourceSegments.map((segment) => previewText(segment.content).trim()).filter(Boolean);
  if (texts.length) return preview(texts.join(" · "), maxLength);
  return "暂无片段内容";
}

function isLongMemEvalMultiModelReport(value: LongMemEvalEvaluationReport): value is LongMemEvalMultiModelReport {
  return "runs" in value && "totalRuns" in value && Array.isArray(value.runs);
}

function readPrimaryLongMemEvalReport(value: LongMemEvalEvaluationReport | null): LongMemEvalReport | null {
  if (!value) return null;
  if (!isLongMemEvalMultiModelReport(value)) return value;
  return value.runs.find((run) => run.report)?.report ?? null;
}

function isInspectableMemory(item: unknown): item is ShortTermMemory | LongTermMemory {
  return Boolean(
    item &&
    typeof item === "object" &&
    (("memoryDataId" in item && "memoryDataType" in item) || ("memoryId" in item && "memoryType" in item))
  );
}

type GraphMemoryNode = Snapshot["graphMemoryNodes"][number];

function isInspectableGraphMemory(item: unknown): item is GraphMemoryNode {
  return Boolean(item && typeof item === "object" && "graphNodeId" in item && "ownerType" in item && "content" in item);
}

function formatAuditPayload(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function buildLlmPayload(settings: LlmSettings) {
  const payload: Partial<LlmSettings> = {};
  if (settings.apiKey.trim()) payload.apiKey = settings.apiKey.trim();
  if (settings.baseUrl.trim()) payload.baseUrl = settings.baseUrl.trim();
  if (settings.model.trim()) payload.model = settings.model.trim();
  return payload;
}

function buildLongMemEvalLlmPayload(settings: LongMemEvalLlmSettings, includeAnswer = false) {
  const extraction: Partial<LongMemEvalLlmSettings> = {};
  if (settings.extractionBaseUrl.trim()) extraction.extractionBaseUrl = settings.extractionBaseUrl.trim();
  if (settings.extractionModel.trim()) extraction.extractionModel = settings.extractionModel.trim();
  if (settings.extractionApiKey.trim()) extraction.extractionApiKey = settings.extractionApiKey.trim();
  const answer: Partial<LongMemEvalLlmSettings> = {};
  if (settings.answerBaseUrl.trim()) answer.answerBaseUrl = settings.answerBaseUrl.trim();
  if (settings.answerModel.trim()) answer.answerModel = settings.answerModel.trim();
  if (settings.answerApiKey.trim()) answer.answerApiKey = settings.answerApiKey.trim();
  const judge: Partial<LongMemEvalLlmSettings> = {};
  if (settings.judgeBaseUrl.trim()) judge.judgeBaseUrl = settings.judgeBaseUrl.trim();
  if (settings.judgeModel.trim()) judge.judgeModel = settings.judgeModel.trim();
  if (settings.judgeApiKey.trim()) judge.judgeApiKey = settings.judgeApiKey.trim();
  return {
    ...(Object.keys(extraction).length
      ? {
          extraction: {
            ...(extraction.extractionBaseUrl ? { baseUrl: extraction.extractionBaseUrl } : {}),
            ...(extraction.extractionModel ? { model: extraction.extractionModel } : {}),
            ...(extraction.extractionApiKey ? { apiKey: extraction.extractionApiKey } : {})
          }
        }
      : {}),
    ...(includeAnswer && Object.keys(answer).length
      ? {
          answer: {
            ...(answer.answerBaseUrl ? { baseUrl: answer.answerBaseUrl } : {}),
            ...(answer.answerModel ? { model: answer.answerModel } : {}),
            ...(answer.answerApiKey ? { apiKey: answer.answerApiKey } : {})
          }
        }
      : {}),
    ...(Object.keys(judge).length
      ? {
          judge: {
            ...(judge.judgeBaseUrl ? { baseUrl: judge.judgeBaseUrl } : {}),
            ...(judge.judgeModel ? { model: judge.judgeModel } : {}),
            ...(judge.judgeApiKey ? { apiKey: judge.judgeApiKey } : {})
          }
        }
      : {}),
    ...(settings.logIngestRequestContext ? { logIngestRequestContext: true } : {})
  };
}

function formatLlmTokenUsage(usage?: LlmTokenUsage) {
  if (!usage) return "";
  const parts = [
    typeof usage.promptTokens === "number" ? `输入 ${usage.promptTokens}` : "",
    typeof usage.completionTokens === "number" ? `输出 ${usage.completionTokens}` : "",
    typeof usage.totalTokens === "number" ? `总计 ${usage.totalTokens}` : ""
  ].filter(Boolean);
  return parts.length ? ` · Tokens ${parts.join(" / ")}` : "";
}

function translateLongMemEvalStage(
  stage?: LongMemEvalRunState["stage"],
  ingestStage?: LongMemEvalRunState["ingestStage"]
) {
  if (stage === "ingest") {
    if (ingestStage === "save_event") return "样本入库 · 保存事件";
    if (ingestStage === "parse") return "样本入库 · 解析";
    if (ingestStage === "fact") return "样本入库 · 事实";
    if (ingestStage === "stm") return "样本入库 · STM";
    if (ingestStage === "finalize") return "样本入库 · 完成";
    if (ingestStage === "pipeline_wait") return "样本入库 · 后台处理";
    return "样本入库";
  }
  if (stage === "timeline_aggregation") return "时间轴聚合";
  if (stage === "stm") return "STM 准入";
  if (stage === "ltm") return "LTM 强化";
  if (stage === "answer") return "生成答案";
  if (stage === "judge") return "Judge";
  if (stage === "result_commit") return "写入结果";
  return "等待启动";
}

function normalizeLongMemEvalActiveStage(
  stage: NonNullable<LongMemEvalJobSnapshot["activeSamples"]>[number]["stage"]
): LongMemEvalRunState["stage"] {
  if (stage === "ingestion") return "ingest";
  if (stage === "stm_admission") return "stm";
  return stage;
}

function translateLongMemEvalLlmOperation(operation: string) {
  if (operation === "fact_fusion") return "事实融合";
  if (operation === "stm_admission") return "STM 准入";
  if (operation === "longmemeval") return "答案 / Judge";
  if (operation === "timeline_aggregation") return "时间轴聚合";
  return operation;
}

function translateLongMemEvalLlmStatus(status: NonNullable<LongMemEvalRunState["llmRequest"]>["status"]) {
  if (status === "started") return "调用中";
  if (status === "succeeded") return "已完成";
  return "失败";
}

function formatLongMemEvalFallbackReason(reason: string) {
  if (reason.startsWith("llm_error:")) {
    const detail = reason.slice("llm_error:".length);
    return `LLM 调用失败：${detail ? translateValue(detail) : "未知错误"}`;
  }
  return translateValue(reason);
}

function formatLongMemEvalFallbackError(error: string) {
  const prefix = "fact_fusion_fallback:";
  if (!error.startsWith(prefix)) return error;
  return `事实抽取 fallback 被阻止：${formatLongMemEvalFallbackReason(error.slice(prefix.length))}`;
}

function formatLongMemEvalLlmElapsed(request: NonNullable<LongMemEvalRunState["llmRequest"]>) {
  const elapsed = request.status === "started"
    ? Date.now() - Date.parse(request.startedAt)
    : request.elapsedMs;
  if (typeof elapsed !== "number" || Number.isNaN(elapsed)) return "0ms";
  if (elapsed < 1000) return `${Math.max(0, Math.round(elapsed))}ms`;
  return `${(elapsed / 1000).toFixed(1)}s`;
}

function parseDraftEventTime(value: string) {
  if (!value.trim()) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function toDatetimeLocalValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes())
  ].join("");
}

function translateManualStepSuccess(action: ManualStepResult["action"]) {
  const messages: Record<ManualStepResult["action"], string> = {
    event: "原始文本事件已写入",
    data_lake: "原始文本已解析到数据湖",
    timeline_fusion: "时间轴融合和事实生成已完成",
    stm: "短期记忆准入已完成",
    ltm: "长期记忆做梦已完成"
  };
  return messages[action];
}

function progressForPipelineTask(task: PipelineTask): { current: MemoryIngestionProgressState; steps: MemoryProgressStep[] } {
  const failed = task.status === "failed" || task.status === "retry_scheduled";
  const stage = task.stage;
  const isParse = stage === "queued" || stage.includes("parse") || stage === "event_saved";
  const isFusion = stage.includes("fusion");
  const isAdmission = stage.includes("admission");
  const isIndex = stage.includes("index") || stage.includes("stm_");
  const done = task.status === "succeeded";
  const currentStage: MemoryIngestionProgressState["stage"] = done || isIndex
    ? "stm"
    : isAdmission
      ? "stm"
      : isFusion
        ? "timeline_aggregation"
        : "data_lake";
  const percent = done ? 100 : isIndex || isAdmission ? 78 : isFusion ? 58 : 35;
  const details = failed
    ? `后台管线失败：${task.error ?? task.stage}`
    : done
      ? "后台管线已完成解析、融合和 STM 准入"
      : translatePipelineTaskStage(task);
  const current: MemoryIngestionProgressState = {
    label: failed ? "后台记忆管线失败" : done ? "后台记忆管线完成" : "后台记忆管线",
    stage: currentStage,
    percent,
    details
  };
  const statusFor = (stepStage: MemoryProgressStep["stage"]): MemoryProgressStep["status"] => {
    if (failed && stepStage === currentStage) return "error";
    if (done) return stepStage === "ltm" ? "pending" : "complete";
    if (stepStage === "event") return "complete";
    if (stepStage === "data_lake") return isParse ? "active" : "complete";
    if (stepStage === "timeline_aggregation") return isFusion ? "active" : isAdmission || isIndex ? "complete" : "pending";
    if (stepStage === "stm") return isAdmission || isIndex ? "active" : "pending";
    return "pending";
  };
  return {
    current,
    steps: [
      { label: "写入事件", stage: "event", percent: 12, details: "已创建 MemoryEvent", status: statusFor("event") },
      { label: "数据湖 / 解析", stage: "data_lake", percent: 35, details: isParse ? details : "已生成解析片段", status: statusFor("data_lake") },
      { label: "时间轴 / 融合", stage: "timeline_aggregation", percent: 58, details: isFusion ? details : "等待或已完成事实融合", status: statusFor("timeline_aggregation") },
      { label: "长期记忆 / LTM", stage: "ltm", percent: 78, details: "写入事件后可手动触发做梦", status: statusFor("ltm") },
      { label: "短期记忆 / STM", stage: "stm", percent: 100, details: isAdmission || isIndex || done || failed ? details : "等待准入和索引刷新", status: statusFor("stm") }
    ]
  };
}

function inferManualStepStatusAfterTimeout(
  snapshot: Snapshot,
  action: ManualStepResult["action"],
  eventId: string,
  timeoutMessage: string
): {
  current: MemoryIngestionProgressState;
  steps: MemoryProgressStep[];
  selected: unknown;
  toast: string;
  terminal: boolean;
  manualStep?: ManualStepResult;
} {
  const event = snapshot.memoryEvents.find((item) => item.eventId === eventId);
  const parsedSegments = snapshot.parsedSegments.filter((segment) => segment.eventId === eventId);
  const facts = snapshot.facts.filter((fact) => fact.linkedEventIds.includes(eventId));
  const shortTermMemory = snapshot.shortTermMemories.find((memory) =>
    memory.memoryDataId === `stm_${eventId}` || memory.sourceFactIds.some((factId) => facts.some((fact) => fact.factId === factId))
  );
  const task = findManualStepTask(snapshot.pipelineTasks, action, eventId);
  const changeEvents = snapshot.changeEvents.filter((change) =>
    change.memoryDataId === eventId ||
    change.memoryDataId === `stm_${eventId}` ||
    change.eventId.includes(eventId)
  );
  const rejectedChange = changeEvents.find((change) => change.storageLayer === "stm" && change.reason.includes("stm_rejected"));
  const failedTask = task?.status === "failed" || task?.status === "retry_scheduled" ? task : undefined;
  const succeededTask = task?.status === "succeeded" ? task : undefined;
  const fallbackTask = task ?? buildRecoveredManualStepTask(action, eventId, "manual_step_timeout_recovered", "running");
  const selected = {
    status: shortTermMemory ? "succeeded" : rejectedChange ? "rejected" : failedTask ? "failed" : "running",
    message: shortTermMemory
      ? "短期记忆准入已完成，STM 已写入。"
      : rejectedChange
        ? `短期记忆准入已拒绝：${rejectedChange.reason}`
        : failedTask
          ? `短期记忆准入失败：${failedTask.error ?? failedTask.stage}`
          : `${timeoutMessage}；已刷新快照，后台任务仍可能在运行。`,
    event,
    parsedSegments,
    facts,
    shortTermMemory,
    task: fallbackTask,
    changeEvents
  };

  if (shortTermMemory || rejectedChange || succeededTask) {
    const completedProgress = buildManualStepProgress(action, true);
    return {
      current: {
        ...completedProgress.current,
        stage: shortTermMemory || rejectedChange ? "done" : completedProgress.current.stage,
        details: shortTermMemory
          ? shortTermMemory.memoryDataId
          : rejectedChange
            ? `已拒绝：${rejectedChange.reason}`
            : "后台任务已完成"
      },
      steps: completedProgress.steps.map((step) =>
        step.stage === "stm" && rejectedChange
          ? { ...step, status: "complete", details: `已拒绝：${rejectedChange.reason}` }
          : step
      ),
      selected,
      toast: shortTermMemory ? "短期记忆准入已完成" : rejectedChange ? "短期记忆准入已拒绝" : "后台任务已完成",
      terminal: true,
      manualStep: {
        action,
        ...(event ? { event } : {}),
        parsedSegments,
        facts,
        ...(shortTermMemory ? { shortTermMemory } : {}),
        task: fallbackTask,
        changeEvents
      }
    };
  }

  if (failedTask) {
    const progress = progressForPipelineTask(failedTask);
    return {
      current: progress.current,
      steps: progress.steps,
      selected,
      toast: "短期记忆准入失败",
      terminal: true,
      manualStep: {
        action,
        ...(event ? { event } : {}),
        parsedSegments,
        facts,
        task: failedTask,
        changeEvents
      }
    };
  }

  const activeProgress = buildManualStepProgress(action);
  const runningDetails = `${timeoutMessage}；已刷新快照，后台仍在处理。事件：${eventId}`;
  return {
    current: { ...activeProgress.current, details: runningDetails },
    steps: activeProgress.steps.map((step) =>
      step.status === "active" ? { ...step, details: runningDetails } : step
    ),
    selected,
    toast: "请求超时，但后台状态已刷新",
    terminal: false,
    manualStep: {
      action,
      ...(event ? { event } : {}),
      parsedSegments,
      facts,
      ...(shortTermMemory ? { shortTermMemory } : {}),
      task: fallbackTask,
      changeEvents
    }
  };
}

function findManualStepTask(tasks: PipelineTask[], action: ManualStepResult["action"], eventId: string) {
  const expectedTaskType = action === "event" ? "ingest" : action === "data_lake" ? "parse" : action === "timeline_fusion" ? "fusion" : action === "stm" ? "admission" : "dreaming";
  return [...tasks]
    .filter((task) =>
      task.eventId === eventId &&
      (task.taskId === `manual_step_${action}_${eventId}` || task.taskType === expectedTaskType)
    )
    .sort((left, right) => right.taskId.localeCompare(left.taskId))[0];
}

function buildRecoveredManualStepTask(
  action: ManualStepResult["action"],
  eventId: string,
  stage: string,
  status: PipelineTask["status"]
): PipelineTask {
  return {
    taskId: `manual_step_${action}_${eventId}`,
    eventId,
    taskType: action === "event" ? "ingest" : action === "data_lake" ? "parse" : action === "timeline_fusion" ? "fusion" : action === "stm" ? "admission" : "dreaming",
    status,
    attempt: 1,
    maxAttempts: 1,
    stage
  };
}

function translatePipelineTaskStage(task: PipelineTask) {
  const stage = task.stage;
  if (stage === "queued") return "后台管线已排队";
  if (stage === "event_saved") return "MemoryEvent 已保存，等待解析";
  if (stage.includes("parse")) return "正在解析为数据湖片段";
  if (stage.includes("fusion")) return "正在抽取事实并融合";
  if (stage.includes("admission")) return "正在评估 STM 准入";
  if (stage.includes("index")) return "正在刷新 STM 索引";
  if (stage.includes("stm_rejected")) return "STM 准入已拒绝，无需索引";
  return stage;
}

function traceLabel(trace: unknown) {
  if (trace && typeof trace === "object" && "traceId" in trace) {
    return String(trace.traceId);
  }
  return "追踪";
}

function traceMeta(trace: unknown) {
  if (trace && typeof trace === "object" && "tokenBudget" in trace && "finalScore" in trace) {
    return `得分 ${String(trace.finalScore)} / 预算 ${String(trace.tokenBudget)}`;
  }
  return "查看";
}

function translateValue(value: string): string {
  const translations: Record<string, string> = {
    active: "活跃",
    pending_confirm: "待确认",
    rejected: "已拒绝",
    expired: "已过期",
    candidate_queue: "候选队列",
    consolidated: "已巩固",
    dropped: "已丢弃",
    archived: "已归档",
    deleted: "已删除",
    weakened: "已降权",
    revised: "已修订",
    low: "低",
    medium: "中",
    high: "高",
    critical: "关键",
    private: "私有",
    team: "团队",
    tenant: "租户",
    public: "公开",
    shared: "共享",
    fact: "事实",
    segment: "片段",
    stm: "短期记忆",
    ltm: "长期记忆",
    item: "条目",
    all: "全部",
    fact_keyword_match: "事实关键词命中",
    short_term_memory_index_match: "短期记忆索引命中",
    short_term_memory_match: "短期记忆命中",
    long_term_memory_match: "长期记忆命中",
    query_mismatch: "查询不匹配",
    inactive_fact: "非活跃事实",
    inactive_stm: "非活跃短期记忆",
    inactive_ltm: "非活跃长期记忆",
    permission_filtered: "权限过滤",
    permission_invalid: "权限失效",
    token_budget_exceeded: "超出预算",
    missing_api_key: "未配置 API Key",
    no_parsed_evidence: "没有可用于抽取的解析证据",
    llm_returned_no_valid_facts: "LLM 未返回有效事实",
    invalid_response_object: "LLM 响应不是有效对象",
    invalid_payload_object: "LLM 输出不是有效 JSON 对象",
    empty_message_content: "LLM 返回了空 message.content",
    facts_array_required: "LLM 输出缺少 facts 数组，可能执行了 evidence 中的嵌入式请求",
    linked_segment_required: "LLM fact 缺少 linkedSegmentIds",
    linked_segment_not_found: "LLM fact 引用了不存在的 evidence segmentId",
    fact_text_required: "LLM fact 缺少 factText",
    normalized_claim_required: "LLM fact 缺少 normalizedClaim",
    no_dreaming_candidates: "没有可做梦候选",
    llm_returned_no_valid_memories: "LLM 未返回有效长期记忆",
    dreaming_fallback_consolidation: "做梦 fallback 巩固",
    dreaming_consolidated_to_ltm: "已通过做梦巩固到长期记忆",
    event: "事件",
    data_lake: "数据湖",
    timeline_fusion: "时间轴融合",
    timeline_aggregation: "时间轴聚合",
    started: "开始",
    succeeded: "完成"
  };

  if (value.startsWith("search:")) {
    return `检索过滤：${translateValue(value.slice("search:".length))}`;
  }
  if (value.startsWith("duplicate_of:")) {
    return `重复于 ${value.slice("duplicate_of:".length)}`;
  }

  return translations[value] ?? value;
}
