import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { getContextEngineConfig, type ContextEngineConfig } from "../../config.js";
import type { AssembleContextRequest, ContextPack, ContextPackItem } from "./assemble-context.js";
import {
  buildBenchmarkAnswerContext
} from "./benchmark-answer-context.js";
import { runLlmDreaming } from "./llm-dreaming.js";
import { isLlmRequestRetryExhausted, postOpenAiCompatibleJson } from "./llm-request.js";
import type { OpenAiCompatibleRequestObservation, OpenAiCompatibleRequestObserver } from "./llm-request.js";
import {
  searchContext,
  type ContextQuery,
  type ContextSearchResponse,
  type ContextSearchResult,
  type ScoreBreakdown
} from "./search-context.js";
import type { ContextDebugSnapshot, ContextEngineRepository } from "./persistence/repository.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import type { GraphMemoryStore } from "./persistence/graph-store.js";
import { Neo4jGraphMemoryStore } from "./persistence/neo4j-graph-store.js";
import { buildTimelineAggregatedFacts, type TimelineAggregatedFact } from "./timeline-aggregation.js";
import type { ContextPackTrace, FactItem, MemoryEvent, RelationEdge, ShortTermMemory, SourceRef } from "./domain.js";
import { estimateContextTokens } from "./token-estimator.js";
import {
  memoryEventSummary,
  multimodalContentPreview,
  multimodalContentToText,
  sourceRefsFromEvent
} from "./memory-event-fields.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { parseAndAdmitEvent, type ParseAndAdmitStageObservation } from "./parse-event.js";
import { createPipelineTask, updatePipelineTask } from "./pipeline-task.js";
import { createEmbeddingClient, embeddingFingerprint, probeEmbedding } from "./embedding.js";
import {
  LongMemEvalArtifactError,
  LongMemEvalResultWriter,
  LongMemEvalTraceWriter,
  acquireLongMemEvalResultLock,
  createLongMemEvalDatasetIdentity,
  createLongMemEvalResultCommitId,
  createLongMemEvalRunId,
  hashLongMemEvalResultPayload,
  longMemEvalSampleCompletionKey,
  scanLongMemEvalResultRecovery,
  toLongMemEvalStructuredError,
  type LongMemEvalDatasetIdentity,
  type LongMemEvalRecoveryScanResult,
  type LongMemEvalResultCommitReceipt,
  type LongMemEvalSampleIdentity,
  type LongMemEvalTraceEventInput,
  type LongMemEvalTraceOperation,
  type LongMemEvalTraceSample,
  type LongMemEvalTraceStage
} from "./longmemeval-artifacts.js";

export interface LongMemEvalSample {
  question_id?: string;
  question_type?: string;
  question?: string;
  answer?: unknown;
  question_date?: string;
  haystack_dates?: unknown;
  haystack_session_ids?: unknown;
  haystack_sessions?: unknown;
  answer_session_ids?: unknown;
}

export interface LongMemEvalLlmOptions {
  extraction?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  judge?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  /** LoCoMo uses an independent answer model while keeping its official scorer model-free. */
  answer?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
}

export interface LongMemEvalLlmRunOptions {
  runId?: string;
  label?: string;
  llm?: LongMemEvalLlmOptions;
  diagnosticsPath?: string;
  tracePath?: string;
}

export type LongMemEvalAnswerContextMode = "context_pack" | "retrieval";

export interface LongMemEvalOptions {
  ks?: number[];
  evalBatchSize?: number;
  answerConcurrency?: number;
  judgeConcurrency?: number;
  ingestSampleConcurrency?: number;
  ingestSessionConcurrency?: number;
  llm?: LongMemEvalLlmOptions;
  graphStore?: GraphMemoryStore;
  logger?: LongMemEvalLogger | undefined;
  onProgress?: (progress: LongMemEvalProgress) => void;
  logIngestRequestContext?: boolean;
  enableLtmReinforcement?: boolean;
  diagnosticsPath?: string;
  /** Independent sample-summary JSONL trace. Defaults to a run-specific sibling of diagnosticsPath. */
  tracePath?: string;
  /** Stable identity for trace and idempotent result commits. */
  runId?: string;
  /** Preserve and scan the result JSONL instead of starting a new result set. */
  resume?: boolean;
  /** When resuming, evaluate prior skipped terminals again. */
  retrySkipped?: boolean;
  /** Allow weak dataset-path/sample-index validation for pre-identity result rows. */
  resumeLegacy?: boolean;
  answerContextMode?: LongMemEvalAnswerContextMode;
  storeNamespace?: string;
  disableIngestLlm?: boolean;
  /** Formal evaluations default to strict mode at the job boundary. */
  allowLlmFallback?: boolean;
  skipStmAdmission?: boolean;
  skipLtmDreaming?: boolean;
  modelOnlyEvaluation?: boolean;
  answerOnlyEvaluation?: boolean;
  /** Identifies the owning model run when one evaluation contains multiple model configurations. */
  modelRunId?: string;
  /** Lightweight sample-stage lifecycle hook; full input/output tracing is added by the trace layer. */
  onSampleStage?: (event: LongMemEvalSampleStageEvent) => void | Promise<void>;
  /** Test seam for deterministic result-commit fault injection. */
  resultSinkOverride?: LongMemEvalResultSinkOverride;
  signal?: AbortSignal | undefined;
}

export interface LongMemEvalResultSinkOverride {
  path?: string;
  commit(result: Record<string, unknown>, sampleIdentity: LongMemEvalSampleIdentity): Promise<LongMemEvalResultCommitReceipt | undefined>;
  close?(): Promise<void>;
}

export interface LongMemEvalMultiModelOptions extends Omit<LongMemEvalOptions, "llm" | "storeNamespace" | "modelRunId"> {
  llmRuns: LongMemEvalLlmRunOptions[];
  modelConcurrency?: number;
}

const longMemEvalStoreSchemaVersion = "longmemeval-store-v20260811-query-scoped-stm";
const longMemEvalLogPreviewCharLimit = 500;
const longMemEvalDiagnosticPreviewCharLimit = 1000;
const longMemEvalAnswerContextConcurrency = 4;
const longMemEvalContextRetryAttempts = 3;
export const longMemEvalAnswerCandidateLimit = 100;
const longMemEvalRetrievalCompatibilityLimit = 10;
export const longMemEvalAnswerContextTokenBudget = 20_000;
export const longMemEvalAnswerEvidenceLimit = 20;
const longMemEvalAnswerBaselineCandidateCount = 12;
const longMemEvalAnswerCompletionCandidateCount = longMemEvalAnswerEvidenceLimit - longMemEvalAnswerBaselineCandidateCount;
const longMemEvalContextLimiters = new WeakMap<ContextEngineRepository, AsyncConcurrencyLimiter>();

interface AsyncConcurrencyLimiter {
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

interface LongMemEvalLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface LongMemEvalLlmRequestProgress {
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
}

export interface LongMemEvalProgress {
  stage: "ingest" | "timeline_aggregation" | "ltm" | "answer" | "judge" | "result_commit";
  ingestStage?: "save_event" | "parse" | "fact" | "stm" | "finalize" | "pipeline_wait";
  stageProgress?: number;
  stageMessage?: string;
  batchIndex?: number;
  batchCount?: number;
  batchProgress?: number;
  batchMessage?: string;
  advanceSamples?: number;
  advanceSessions?: number;
  advanceSteps?: number;
  processedSamples: number;
  totalSamples: number;
  processedSessions: number;
  totalSessions: number;
  processedSteps: number;
  totalSteps: number;
  questionTypeCounts: Record<string, number>;
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
  llmRequest?: LongMemEvalLlmRequestProgress;
  activeSamples: LongMemEvalActiveSample[];
  modelRunId?: string;
  resumedSamples: number;
  committedSamples: number;
}

export type LongMemEvalSampleStage =
  | "ingestion"
  | "stm_admission"
  | "timeline_aggregation"
  | "ltm"
  | "answer"
  | "judge"
  | "result_commit";

export interface LongMemEvalSampleStageEvent {
  stage: LongMemEvalSampleStage;
  status: "started" | "succeeded" | "failed" | "skipped";
  sampleIndex: number;
  sampleCount: number;
  questionId: string;
  questionType: string;
  contextScopeId: string;
  modelRunId: string;
  storeNamespace: string;
  reason?: string;
}

export interface LongMemEvalActiveSample {
  sampleIndex: number;
  questionId: string;
  questionType: string;
  contextScopeId: string;
  modelRunId: string;
  storeNamespace: string;
  stage: LongMemEvalSampleStage;
  status: LongMemEvalSampleStageEvent["status"];
  updatedAt: string;
}

type LongMemEvalProgressUpdate = Omit<
  LongMemEvalProgress,
  "processedSamples" | "totalSamples" | "processedSessions" | "totalSessions" | "processedSteps" | "totalSteps" | "questionTypeCounts" | "activeSamples" | "modelRunId" | "resumedSamples" | "committedSamples"
> & {
  advanceSamples?: number;
  advanceSessions?: number;
  advanceSteps?: number;
  processedSamples?: number;
  processedSessions?: number;
};

export interface LongMemEvalReport {
  datasetPath: string;
  totalSamples: number;
  recovery?: {
    resume: boolean;
    retrySkipped: boolean;
    resumedFromRunId?: string;
    resumedSamples: number;
    committedSamples: number;
    ignoredIncompleteTail: boolean;
  };
  questionTypeCounts: Record<string, number>;
  questionTypeAccuracy: Record<string, {
    total: number;
    judgeAccuracy: number;
    exactMatch: number;
  }>;
  ingestion: {
    totalSessions: number;
    ingestedSessions: number;
    skippedSessions: number;
  };
  answerGeneration: {
    totalHypotheses: number;
    answered: number;
    failed: number;
    skipped: number;
    answerRate: number;
    fallbackUsed: boolean;
  };
  judge: {
    totalJudged: number;
    judged: number;
    skipped: number;
    accuracy: number;
    fallbackUsed: boolean;
    model: string;
    baseUrl: string;
  };
  metrics: Record<number, LongMemEvalMetric>;
  samples: LongMemEvalSampleReport[];
}

export interface LongMemEvalModelRunReport {
  runId: string;
  label?: string;
  llm?: LongMemEvalLlmOptions;
  status: "done" | "error";
  startedAt: string;
  finishedAt: string;
  resultPath?: string;
  tracePath?: string;
  report?: LongMemEvalReport;
  error?: string;
}

export interface LongMemEvalMultiModelReport {
  datasetPath: string;
  totalSamples: number;
  ks: number[];
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  modelConcurrency: number;
  questionTypeCounts: Record<string, number>;
  runs: LongMemEvalModelRunReport[];
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
}

export type LongMemEvalEvaluationReport = LongMemEvalReport | LongMemEvalMultiModelReport;

export interface LongMemEvalDataClearResult {
  storage: {
    storeDirectory: string;
    deletedFiles: string[];
  };
  graphStore: {
    status: "cleared" | "skipped";
    mode: ContextEngineConfig["longMemEval"]["graphStore"]["mode"];
    database?: string;
    reason?: string;
  };
}

export interface LongMemEvalMetric {
  k: number;
  recallAtK: number;
  recallAnyAtK: number;
  recallAllAtK: number;
  precisionAtK: number;
  mrrAtK: number;
  ndcgAtK: number;
  exactMatch: number;
  judgeAccuracy: number;
}

export interface LongMemEvalSampleReport {
  questionId: string;
  questionType: string;
  question: string;
  answer: string;
  hypothesis: string;
  skipped?: boolean;
  skipReason?: string;
  answerFallbackUsed?: boolean;
  answerFallbackReason?: string;
  judgment: LongMemEvalJudgment;
  retrieval: Array<{
    k: number;
    recallAtK: number;
    recallAnyAtK: number;
    recallAllAtK: number;
    precisionAtK: number;
    mrrAtK: number;
    ndcgAtK: number;
  }>;
}

export interface LongMemEvalJudgment {
  label: "correct" | "incorrect";
  score: number;
  reason: string;
  model: string;
  baseUrl: string;
  raw?: unknown;
}

interface LongMemEvalSessionDocument {
  sessionId: string;
  questionId: string;
  content: string;
  turns: LongMemEvalSessionTurn[];
  eventTime: string;
  evidenceTime: string;
  sessionIndex: number;
  sampleIndex: number;
  sampleSessionIndex: number;
  sampleSessionCount: number;
}

interface LongMemEvalSessionTurn {
  role: string;
  content: string;
  line: string;
}

interface SampleContext {
  sample: LongMemEvalSample;
  questionId: string;
  questionType: string;
  question: string;
  answer: string;
  haystackSessionIds: string[];
  contextScopeId: string;
  modelRunId: string;
  storeNamespace: string;
  questionDate?: string;
}

interface LongMemEvalSampleRun extends SampleContext {
  repository: ContextEngineRepository;
  answerSessionIds: string[];
}

interface LongMemEvalCompatibilityResultSink {
  readonly path?: string;
  readonly datasetIdentity: LongMemEvalDatasetIdentity;
  readonly recovery: LongMemEvalRecoveryScanResult;
  commit(result: Record<string, unknown>, sampleIdentity: LongMemEvalSampleIdentity): Promise<LongMemEvalResultCommitReceipt | undefined>;
  close(): Promise<void>;
}

interface LongMemEvalTraceContext {
  runId: string;
  modelRunId: string;
  writer?: LongMemEvalTraceWriter;
}

interface LongMemEvalSampleTraceContext extends LongMemEvalTraceContext {
  sample: LongMemEvalTraceSample;
}

export class LongMemEvalStageRetryExhaustedError extends Error {
  readonly stage: LongMemEvalTraceStage;
  readonly operation: LongMemEvalTraceOperation;
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(input: {
    stage: LongMemEvalTraceStage;
    operation: LongMemEvalTraceOperation;
    attempts: number;
    lastError: unknown;
  }) {
    const reason = input.lastError instanceof Error ? input.lastError.message : String(input.lastError);
    super(`${input.stage}/${input.operation} stage attempts exhausted after ${input.attempts} attempts: ${reason}`);
    this.name = "LongMemEvalStageRetryExhaustedError";
    this.stage = input.stage;
    this.operation = input.operation;
    this.attempts = input.attempts;
    this.lastError = input.lastError;
  }
}

export async function executeStageWithRetry<T>(input: {
  stage: LongMemEvalTraceStage;
  operation: LongMemEvalTraceOperation;
  execute: (context: { stageAttempt: number }) => Promise<T>;
  maxAttempts?: number;
  signal?: AbortSignal | undefined;
  trace?: LongMemEvalSampleTraceContext | LongMemEvalTraceContext;
  traceInput?: unknown | ((stageAttempt: number) => unknown);
  traceOutput?: (output: T) => unknown;
  links?: Record<string, unknown>;
  isRetryable?: (error: unknown) => boolean;
}): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(3, Math.floor(input.maxAttempts ?? 3)));
  const stageExecutionId = `${input.stage}_${input.operation}_${randomUUID()}`;
  let lastError: unknown;
  for (let stageAttempt = 1; stageAttempt <= maxAttempts; stageAttempt += 1) {
    throwIfLongMemEvalCancelled(input.signal);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const traceInput = typeof input.traceInput === "function" ? input.traceInput(stageAttempt) : input.traceInput;
    await appendLongMemEvalTrace(input.trace, {
      stage: input.stage,
      operation: input.operation,
      stageExecutionId,
      status: "started",
      attempt: stageAttempt,
      stageAttempt,
      startedAt,
      ...(traceInput !== undefined ? { input: traceInput } : {}),
      ...(input.links ? { links: input.links } : {})
    });
    try {
      const output = await input.execute({ stageAttempt });
      const finishedAt = new Date().toISOString();
      await appendLongMemEvalTrace(input.trace, {
        stage: input.stage,
        operation: input.operation,
        stageExecutionId,
        status: "succeeded",
        attempt: stageAttempt,
        stageAttempt,
        startedAt,
        finishedAt,
        elapsedMs: Date.now() - startedAtMs,
        ...(traceInput !== undefined ? { input: traceInput } : {}),
        output: input.traceOutput ? input.traceOutput(output) : output,
        ...(input.links ? { links: input.links } : {})
      });
      return output;
    } catch (error) {
      lastError = error;
      const finishedAt = new Date().toISOString();
      await appendLongMemEvalTrace(input.trace, {
        stage: input.stage,
        operation: input.operation,
        stageExecutionId,
        status: "failed",
        attempt: stageAttempt,
        stageAttempt,
        startedAt,
        finishedAt,
        elapsedMs: Date.now() - startedAtMs,
        ...(traceInput !== undefined ? { input: traceInput } : {}),
        error: toLongMemEvalStructuredError(error),
        ...(input.links ? { links: input.links } : {})
      });
      if (isLongMemEvalCancellation(error, input.signal)) throw error;
      const retryable = input.isRetryable ? input.isRetryable(error) : isRetryableLongMemEvalStageError(error);
      if (!retryable) throw error;
      if (stageAttempt >= maxAttempts) break;
      await appendLongMemEvalTrace(input.trace, {
        stage: input.stage,
        operation: input.operation,
        stageExecutionId,
        status: "retrying",
        attempt: stageAttempt,
        stageAttempt,
        startedAt,
        finishedAt,
        elapsedMs: Date.now() - startedAtMs,
        error: toLongMemEvalStructuredError(error),
        links: { ...(input.links ?? {}), nextStageAttempt: stageAttempt + 1, maxAttempts }
      });
    }
  }
  throw new LongMemEvalStageRetryExhaustedError({
    stage: input.stage,
    operation: input.operation,
    attempts: maxAttempts,
    lastError
  });
}

function isRetryableLongMemEvalStageError(error: unknown) {
  if (isLlmRequestRetryExhausted(error)) return true;
  if (error instanceof LongMemEvalArtifactError) {
    return /^(?:EIO|ENOSPC|EMFILE|ENFILE|EBUSY|EAGAIN|ETIMEDOUT)$/u.test(error.code);
  }
  const value = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  if (value?.retryable === false || value?.deterministic === true) return false;
  const code = typeof value?.code === "string" ? value.code : "";
  const status = typeof value?.status === "number" ? value.status : undefined;
  if (status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500)) return true;
  if (status !== undefined && status >= 400 && status < 500) return false;
  if (/^(?:SQLITE_BUSY|SQLITE_LOCKED|EIO|ENOSPC|EMFILE|ENFILE|EBUSY|EAGAIN|ECONN|ENET|EHOST|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_)/iu.test(code)) return true;
  if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted|cancelled|canceled/iu.test(message)) return false;
  if (/(?:answer|judge)_fallback:4\d\d\b/iu.test(message)) return false;
  if (/http_4(?:00|01|02|03|04|05|06|07|10|11|12|13|14|15|16|17|18|21|22|23|24|25|26|28|31|32|51):/iu.test(message)) return false;
  if (/invalid|validation|invariant|mismatch|conflict.*payload|path.*escape|already committed with different|must be|required|unsupported/iu.test(message)) return false;
  return true;
}

async function appendLongMemEvalTrace(
  trace: LongMemEvalSampleTraceContext | LongMemEvalTraceContext | undefined,
  event: Omit<LongMemEvalTraceEventInput, "runId" | "modelRunId" | "sample">
) {
  if (!trace?.writer) return;
  if (!isLongMemEvalSampleSummaryOperation(event.operation)) return;
  await trace.writer.append({
    ...event,
    runId: trace.runId,
    modelRunId: trace.modelRunId,
    ...(isLongMemEvalSampleTraceContext(trace) ? { sample: trace.sample } : {})
  });
}

type LongMemEvalSampleSummaryOperation =
  | "sample_facts"
  | "sample_stms"
  | "retrieval_candidates"
  | "context_pack_facts";

function isLongMemEvalSampleSummaryOperation(
  operation: LongMemEvalTraceOperation
): operation is LongMemEvalSampleSummaryOperation {
  return operation === "sample_facts" ||
    operation === "sample_stms" ||
    operation === "retrieval_candidates" ||
    operation === "context_pack_facts";
}

async function appendLongMemEvalSampleSummaryTrace(
  trace: LongMemEvalSampleTraceContext | undefined,
  operation: LongMemEvalSampleSummaryOperation,
  output: unknown
) {
  if (!trace?.writer) return;
  const timestamp = new Date().toISOString();
  const onceKey = `${trace.modelRunId}\u0000${trace.sample.index}\u0000${trace.sample.questionId}\u0000${operation}`;
  await trace.writer.appendOnce(onceKey, {
    runId: trace.runId,
    modelRunId: trace.modelRunId,
    sample: trace.sample,
    stage: "sample_summary",
    operation,
    stageExecutionId: `summary_${operation}_${trace.sample.index}`,
    status: "succeeded",
    startedAt: timestamp,
    finishedAt: timestamp,
    output
  });
}

function isLongMemEvalSampleTraceContext(trace: LongMemEvalTraceContext): trace is LongMemEvalSampleTraceContext {
  return "sample" in trace;
}

interface LongMemEvalSampleExecutionResult {
  report: LongMemEvalSampleReport;
  resultRow: Record<string, unknown>;
  ingestedSessions: number;
  skippedSessions: number;
  judged: boolean;
  judgeFallbackUsed: boolean;
  answerFallbackUsed: boolean;
  retrievalEvaluable: boolean;
}

interface LongMemEvalAnswerArtifact {
  hypothesis: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  skipped?: boolean;
  skipReason?: string;
  rankedSessionIds: string[];
  promptHasAnswer: boolean;
  promptPreview: string;
  answerContextDiagnostic: ReturnType<typeof summarizeAnswerContextDiagnostic>;
  contextPackDiagnostic?: ReturnType<typeof summarizeContextPackDiagnostic>;
  scope: LongMemEvalScopeMetadata;
}

interface LongMemEvalScopeMetadata {
  questionId: string;
  contextScopeId: string;
  modelRunId: string;
  storeNamespace: string;
}

interface LongMemEvalAnswerContext {
  mode: LongMemEvalAnswerContextMode;
  serializedPrompt: string;
  selectedItems: ContextPackItem[];
  dropped: Array<{
    id: string;
    layer?: ContextSearchResult["layer"];
    reason: string;
  }>;
  tokenBudget: {
    requested: number;
    used: number;
  };
  evidenceTrace?: LongMemEvalAnswerEvidenceTrace;
  pack?: ContextPack;
  retrievalCandidates?: ContextSearchResult[];
}

type LongMemEvalAnswerTemporal = Pick<
  ContextPackItem["temporal"],
  "evidenceTime" | "validTime" | "events"
>;

export type LongMemEvalAnswerSourceRole = "user" | "assistant" | "tool" | "unknown";
export type LongMemEvalAnswerEvidenceRole =
  | "direct_answer"
  | "temporal_start"
  | "temporal_end"
  | "old_state"
  | "new_state"
  | "calculation_operand"
  | "disambiguation";
export type LongMemEvalAnswerEvidenceRejectReason =
  | "not_relevant"
  | "duplicate"
  | "budget"
  | "missing_required_metadata"
  | "lower_priority";

export interface LongMemEvalAnswerEvidenceCandidate {
  item: ContextPackItem;
  scoreBreakdown: ScoreBreakdown;
  sourceSessionIds: string[];
  sourceRoles: LongMemEvalAnswerSourceRole[];
  temporal: LongMemEvalAnswerTemporal;
  relations: RelationEdge[];
  facts: FactItem[];
  evidenceText: string;
  relevanceScore: number;
  estimatedTokens: number;
}

export interface LongMemEvalAnswerEvidenceRejection {
  itemId: string;
  layer?: ContextSearchResult["layer"];
  reason: LongMemEvalAnswerEvidenceRejectReason;
  contentChars: number;
  containsLiteralAnswer?: boolean;
}

export interface LongMemEvalAnswerEvidenceSelection {
  candidates: LongMemEvalAnswerEvidenceCandidate[];
  selectedCandidates: LongMemEvalAnswerEvidenceCandidate[];
  selected: Array<{
    itemId: string;
    reason: string;
    evidenceRole: LongMemEvalAnswerEvidenceRole;
  }>;
  rejected: LongMemEvalAnswerEvidenceRejection[];
  tokenBudget: number;
  usedTokens: number;
}

interface LongMemEvalAnswerEvidenceTrace {
  retrievalCallCount: number;
  retrievalLimit: number;
  retrievedItemIds: string[];
  eligibleCandidateItemIds: string[];
  candidates: Array<{
    itemId: string;
    layer: ContextSearchResult["layer"];
    score: number;
    scoreBreakdown: ScoreBreakdown;
    sourceSessionIds: string[];
    sourceRoles: LongMemEvalAnswerSourceRole[];
    contentChars: number;
    estimatedTokens: number;
    temporal: LongMemEvalAnswerTemporal;
    relationTypes: RelationEdge["relationType"][];
  }>;
  selected: Array<{
    itemId: string;
    reason: string;
    evidenceRole: LongMemEvalAnswerEvidenceRole;
  }>;
  rejected: LongMemEvalAnswerEvidenceRejection[];
  renderedPromptHasTemporalMetadata: boolean;
  failureClassification?: {
    stage:
      | "memory_not_generated"
      | "not_in_top_100"
      | "budget_rejected"
      | "not_selected"
      | "rendering_missing"
      | "prompt_ready"
      | "undetermined_requires_reasoning"
      | "diagnostic_error";
    basis: "literal_answer_match" | "structural";
    detail?: string;
  };
}

interface DreamBatchResult {
  totalBatches: number;
  totalCandidates: number;
  totalDreamed: number;
}

interface DreamBatchProgress {
  batchIndex: number;
  batchCount: number;
  batchCandidates: number;
  totalCandidates: number;
  totalDreamed: number;
}

interface JudgeConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface LongMemEvalMetricAccumulator {
  k: number;
  recall: number;
  recallAny: number;
  recallAll: number;
  precision: number;
  mrr: number;
  ndcg: number;
  exactMatch: number;
  judgeAccuracy: number;
  retrievalCount: number;
  count: number;
}

export async function evaluateLongMemEvalDataset(
  datasetPath: string,
  options: LongMemEvalOptions = {}
): Promise<LongMemEvalReport> {
  const externalSignal = options.signal;
  const runAbortController = new AbortController();
  const forwardExternalAbort = () => runAbortController.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
  if (externalSignal?.aborted) forwardExternalAbort();
  const signal = runAbortController.signal;
  throwIfLongMemEvalCancelled(signal);
  const config = getContextEngineConfig();
  await probeEmbedding(createEmbeddingClient(config.embedding), signal);
  throwIfLongMemEvalCancelled(signal);
  const logIngestRequestContext = options.logIngestRequestContext === true;
  // Evaluation deliberately stops at STM; production dreaming remains available through its own runtime paths.
  const skipLtmDreaming = true;
  const modelOnlyEvaluation = options.modelOnlyEvaluation === true;
  const answerOnlyEvaluation = options.answerOnlyEvaluation === true;
  const runLtmDreaming = false;
  const disableIngestLlm = options.disableIngestLlm === true;
  const strictLlm = options.allowLlmFallback === false;
  const skipStmAdmission = options.skipStmAdmission === true;
  const answerContextMode = normalizeAnswerContextMode(options.answerContextMode);
  const ingestSampleConcurrency = normalizeIngestSampleConcurrency(options.ingestSampleConcurrency);
  const ingestSessionConcurrency = normalizeIngestSessionConcurrency(options.ingestSessionConcurrency);
  const answerConcurrency = normalizeEvalStageConcurrency(options.answerConcurrency ?? options.evalBatchSize);
  const judgeConcurrency = normalizeEvalStageConcurrency(options.judgeConcurrency ?? options.evalBatchSize);
  const diagnosticsPath = options.diagnosticsPath?.trim() ? resolve(options.diagnosticsPath) : undefined;
  const resume = options.resume === true;
  const retrySkipped = options.retrySkipped === true;
  const resumeLegacy = options.resumeLegacy === true;
  if ((retrySkipped || resumeLegacy) && !resume) {
    throw new LongMemEvalArtifactError("RESUME_OPTION_REQUIRED", "retrySkipped and resumeLegacy require resume=true");
  }
  if (resume && !diagnosticsPath) {
    throw new LongMemEvalArtifactError("RESUME_RESULT_PATH_REQUIRED", "LongMemEval resume requires diagnosticsPath");
  }
  if (resume && options.resultSinkOverride) {
    throw new LongMemEvalArtifactError("RESUME_RESULT_SINK_UNSUPPORTED", "LongMemEval resume cannot use resultSinkOverride");
  }
  const runId = options.runId?.trim() || createLongMemEvalRunId();
  const modelRunId = options.modelRunId?.trim() || "default";
  const tracePath = options.tracePath?.trim()
    ? resolve(options.tracePath)
    : diagnosticsPath
      ? longMemEvalSiblingTracePath(diagnosticsPath, runId)
      : undefined;
  const samples = await loadLongMemEvalSamples(datasetPath);
  const datasetIdentity = await createLongMemEvalDatasetIdentity(datasetPath);
  const sampleIdentities = samples.map((sample, index) => ({ index: index + 1, questionId: readQuestionId(sample) }));
  throwIfLongMemEvalCancelled(signal);
  const ks = normalizeKs(options.ks);
  const questionTypeCounts: Record<string, number> = {};
  const questionTypeAccuracy: Record<string, { total: number; judgeAccuracy: number; exactMatch: number }> = {};
  const sampleReports: LongMemEvalSampleReport[] = [];
  const metricsByK = new Map<number, LongMemEvalMetricAccumulator>();
  for (const k of ks) {
    metricsByK.set(k, {
      k,
      recall: 0,
      recallAny: 0,
      recallAll: 0,
      precision: 0,
      mrr: 0,
      ndcg: 0,
      exactMatch: 0,
      judgeAccuracy: 0,
      retrievalCount: 0,
      count: 0
    });
  }

  const repositoryHandle = await createLongMemEvalRepository(resolve(datasetPath), options.graphStore, options.storeNamespace, {
    lazyCache: true
  });
  throwIfLongMemEvalCancelled(signal);
  const repository = repositoryHandle.repository;
  let resultSink: LongMemEvalCompatibilityResultSink | undefined;
  let traceWriter: LongMemEvalTraceWriter | undefined;
  let runTrace: LongMemEvalTraceContext | undefined;
  const runStartedAtMs = Date.now();
  const runStartedAt = new Date(runStartedAtMs).toISOString();
  try {
    resultSink = options.resultSinkOverride
      ? {
          ...(options.resultSinkOverride.path ? { path: options.resultSinkOverride.path } : {}),
          datasetIdentity,
          recovery: emptyLongMemEvalRecovery(sampleIdentities),
          commit: options.resultSinkOverride.commit,
          close: options.resultSinkOverride.close ?? (async () => undefined)
        }
      : await createLongMemEvalCompatibilityResultSink(diagnosticsPath, {
          runId,
          modelRunId,
          datasetIdentity
        }, sampleIdentities, { resume, retrySkipped, resumeLegacy });
    traceWriter = tracePath ? await LongMemEvalTraceWriter.open(tracePath) : undefined;
    const trace: LongMemEvalTraceContext = { runId, modelRunId, ...(traceWriter ? { writer: traceWriter } : {}) };
    runTrace = trace;
    await appendLongMemEvalTrace(trace, {
      stage: "run",
      operation: "run_lifecycle",
      stageExecutionId: `run_${runId}`,
      status: "started",
      startedAt: runStartedAt,
      input: {
        datasetPath: resolve(datasetPath),
        datasetIdentity,
        options: longMemEvalTraceableOptions(options),
        recovery: {
          resume,
          retrySkipped,
          resumeLegacy,
          resumedSamples: resultSink.recovery.completedSamples.length,
          pendingSamples: resultSink.recovery.pendingSamples.length,
          firstPendingSample: resultSink.recovery.firstPendingSample,
          ignoredIncompleteTail: resultSink.recovery.ignoredIncompleteTail,
          duplicateCommits: resultSink.recovery.duplicateCommits,
          resumedFromRunId: resultSink.recovery.latestRunId
        }
      },
      ...(resultSink.recovery.latestRunId ? { links: { resumedFromRunId: resultSink.recovery.latestRunId } } : {})
    });
    const sampleResultSink = resultSink;
    const sampleRuns: LongMemEvalSampleRun[] = samples.map((sample) => ({
      sample,
      repository,
      questionId: readQuestionId(sample),
      questionType: readQuestionType(sample),
      question: readQuestion(sample),
      answer: readAnswer(sample),
      answerSessionIds: toStringArray(sample.answer_session_ids),
      haystackSessionIds: toStringArray(sample.haystack_session_ids),
      contextScopeId: longMemEvalContextScopeId(readQuestionId(sample)),
      modelRunId,
      storeNamespace: options.storeNamespace?.trim() || "default",
      ...(typeof sample.question_date === "string" ? { questionDate: sample.question_date } : {})
    }));
    let completedSamples = resultSink.recovery.completedSamples.length;
    const completedSampleIndexes = new Set(resultSink.recovery.completedSamples.map((sample) => sample.index));
    let processedSessions = sampleRuns.reduce((total, run, index) =>
      total + (completedSampleIndexes.has(index + 1) ? buildSessionDocuments([run.sample]).length : 0), 0);
    let processedSteps = 0;
    const activeSamples = new Map<number, LongMemEvalActiveSample>();
    const totalSessions = countLongMemEvalSessionAttempts(samples);
    const totalSteps = totalSessions * 5 + samples.length * 6;
    const emitProgress = (progress: LongMemEvalProgressUpdate) => {
      throwIfLongMemEvalCancelled(signal);
      processedSteps += progress.advanceSteps ?? 1;
      processedSessions += progress.advanceSessions ?? 0;
      options.onProgress?.({
        ...progress,
        processedSamples: completedSamples,
        totalSamples: samples.length,
        processedSessions,
        totalSessions,
        processedSteps,
        totalSteps,
        questionTypeCounts: { ...questionTypeCounts },
        activeSamples: [...activeSamples.values()].sort((a, b) => a.sampleIndex - b.sampleIndex),
        modelRunId,
        resumedSamples: sampleResultSink.recovery.completedSamples.length,
        committedSamples: Math.max(0, completedSamples - sampleResultSink.recovery.completedSamples.length)
      } as LongMemEvalProgress);
      throwIfLongMemEvalCancelled(signal);
    };

    const onSampleStage = async (event: LongMemEvalSampleStageEvent) => {
      if (event.stage === "result_commit" && event.status === "succeeded") {
        completedSamples += 1;
        activeSamples.delete(event.sampleIndex);
      } else {
        activeSamples.set(event.sampleIndex, {
          sampleIndex: event.sampleIndex,
          questionId: event.questionId,
          questionType: event.questionType,
          contextScopeId: event.contextScopeId,
          modelRunId: event.modelRunId,
          storeNamespace: event.storeNamespace,
          stage: event.stage,
          status: event.status,
          updatedAt: new Date().toISOString()
        });
      }
      await options.onSampleStage?.(event);
    };

    const judgeConfig = resolveJudgeConfig(options.llm, config);
    const answerLimiter = createAsyncConcurrencyLimiter(answerConcurrency);
    const judgeLimiter = createAsyncConcurrencyLimiter(judgeConcurrency);
    const canReuseCompletedIngest = (modelOnlyEvaluation || answerOnlyEvaluation) && await allSampleTimelineEventsExist(repository, samples);
    if (answerOnlyEvaluation && !canReuseCompletedIngest) {
      throw new Error("LongMemEval answer-only evaluation requires all samples to be pre-ingested; rerun without --answer-only to build the store first");
    }
    if (modelOnlyEvaluation && answerContextMode === "retrieval" && !canReuseCompletedIngest) {
      throw new Error("LongMemEval model-only retrieval requires all samples to be pre-ingested; rerun without --model-only to build the store first");
    }

    const sampleSessionOffsets: number[] = [];
    let nextSessionOffset = 0;
    for (const [sampleIndex, run] of sampleRuns.entries()) {
      throwIfLongMemEvalCancelled(signal);
      sampleSessionOffsets[sampleIndex] = nextSessionOffset;
      nextSessionOffset += buildSessionDocuments([run.sample]).length;
      questionTypeCounts[run.questionType] = (questionTypeCounts[run.questionType] ?? 0) + 1;
      questionTypeAccuracy[run.questionType] ??= { total: 0, judgeAccuracy: 0, exactMatch: 0 };
    }

    const sampleTargets = sampleRuns
      .map((run, sampleIndex) => ({ run, sampleIndex }))
      .filter(({ run, sampleIndex }) => !resultSink!.recovery.completedKeys.has(longMemEvalSampleCompletionKey(modelRunId, {
        index: sampleIndex + 1,
        questionId: run.questionId
      })));
    const sampleResults = await mapWithConcurrencyUntilError(sampleTargets, ingestSampleConcurrency, async (target) => {
      throwIfLongMemEvalCancelled(signal);
      const { run, sampleIndex } = target;
      return executeLongMemEvalSample({
        datasetPath,
        run,
        sampleIndex: sampleIndex + 1,
        sampleCount: samples.length,
        totalSessions,
        sessionOffset: sampleSessionOffsets[sampleIndex] ?? 0,
        ks,
        judgeConfig,
        resultSink: sampleResultSink,
        emitProgress,
        answerLimiter,
        judgeLimiter,
        reuseIngest: canReuseCompletedIngest,
        runLtmDreaming,
        skipLtmDreaming,
        answerOnlyEvaluation,
        answerContextMode,
        ingestSessionConcurrency,
        logIngestRequestContext,
        disableIngestLlm,
        strictLlm,
        skipStmAdmission,
        modelRunId,
        storeNamespace: options.storeNamespace?.trim() || "default",
        ...(options.llm ? { llm: options.llm } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        onSampleStage,
        trace: {
          ...trace,
          sample: {
            index: sampleIndex + 1,
            count: samples.length,
            questionId: run.questionId,
            questionType: run.questionType,
            contextScopeId: run.contextScopeId
          }
        },
        abortRun: (reason) => runAbortController.abort(reason),
        ...(signal ? { signal } : {})
      });
    }, signal);

    let ingestedSessions = 0;
    let skippedSessions = 0;
    let judged = 0;
    let correctJudgments = 0;
    let fallbackUsed = false;
    for (const [targetIndex, result] of sampleResults.entries()) {
      const target = sampleTargets[targetIndex]!;
      const run = target.run;
      sampleReports.push(result.report);
      ingestedSessions += result.ingestedSessions;
      skippedSessions += result.skippedSessions;
      if (result.judged) {
        judged += 1;
        if (result.report.judgment.label === "correct") correctJudgments += 1;
      }
      fallbackUsed ||= result.judgeFallbackUsed || result.answerFallbackUsed;

      if (result.report.skipped !== true) {
        for (const metric of result.report.retrieval) {
          const stat = metricsByK.get(metric.k);
          if (!stat) continue;
          if (result.retrievalEvaluable) {
            stat.recall += metric.recallAtK;
            stat.recallAny += metric.recallAnyAtK;
            stat.recallAll += metric.recallAllAtK;
            stat.precision += metric.precisionAtK;
            stat.mrr += metric.mrrAtK;
            stat.ndcg += metric.ndcgAtK;
            stat.retrievalCount += 1;
          }
          stat.exactMatch += result.answerFallbackUsed ? 0 : exactMatchScore(run.answer, result.report.hypothesis) ? 1 : 0;
          stat.judgeAccuracy += result.report.judgment.label === "correct" ? 1 : 0;
          stat.count += 1;
        }
        const typeStat = questionTypeAccuracy[run.questionType]!;
        typeStat.total += 1;
        typeStat.judgeAccuracy += result.report.judgment.label === "correct" ? 1 : 0;
        typeStat.exactMatch += result.answerFallbackUsed ? 0 : exactMatchScore(run.answer, result.report.hypothesis) ? 1 : 0;
      }
    }

  const metrics: Record<number, LongMemEvalMetric> = {};
  for (const [k, stat] of metricsByK.entries()) {
    metrics[k] = {
      k,
      recallAtK: avg(stat.recall, stat.retrievalCount),
      recallAnyAtK: avg(stat.recallAny, stat.retrievalCount),
      recallAllAtK: avg(stat.recallAll, stat.retrievalCount),
      precisionAtK: avg(stat.precision, stat.retrievalCount),
      mrrAtK: avg(stat.mrr, stat.retrievalCount),
      ndcgAtK: avg(stat.ndcg, stat.retrievalCount),
      exactMatch: avg(stat.exactMatch, stat.count),
      judgeAccuracy: avg(stat.judgeAccuracy, stat.count)
    };
  }

    const report: LongMemEvalReport = {
      datasetPath,
      totalSamples: samples.length,
      recovery: {
        resume,
        retrySkipped,
        ...(resultSink.recovery.latestRunId ? { resumedFromRunId: resultSink.recovery.latestRunId } : {}),
        resumedSamples: resultSink.recovery.completedSamples.length,
        committedSamples: sampleResults.length,
        ignoredIncompleteTail: resultSink.recovery.ignoredIncompleteTail
      },
      questionTypeCounts,
      questionTypeAccuracy: Object.fromEntries(
        Object.entries(questionTypeAccuracy).map(([questionType, value]) => [
          questionType,
          {
            total: value.total,
            judgeAccuracy: avg(value.judgeAccuracy, value.total),
            exactMatch: avg(value.exactMatch, value.total)
          }
        ])
      ),
      ingestion: {
        totalSessions,
        ingestedSessions,
        skippedSessions
      },
      answerGeneration: {
        totalHypotheses: sampleReports.filter((sample) => sample.skipped !== true).length,
        answered: sampleReports.filter((sample) => sample.skipped !== true && sample.answerFallbackUsed !== true).length,
        failed: sampleReports.filter((sample) => sample.answerFallbackUsed === true).length,
        skipped: sampleReports.filter((sample) => sample.skipped === true).length,
        answerRate: avg(sampleReports.filter((sample) => sample.skipped !== true && sample.answerFallbackUsed !== true).length, sampleReports.length),
        fallbackUsed: sampleReports.some((sample) => sample.answerFallbackUsed === true)
      },
      judge: {
        totalJudged: sampleReports.length,
        judged,
        skipped: sampleReports.filter((sample) => sample.skipped === true).length,
        accuracy: avg(correctJudgments, judged),
        fallbackUsed,
        model: judgeConfig.model,
        baseUrl: judgeConfig.baseUrl
      },
      metrics,
      samples: sampleReports
    };
    await appendLongMemEvalTrace(trace, {
      stage: "run",
      operation: "run_lifecycle",
      stageExecutionId: `run_${runId}`,
      status: "succeeded",
      startedAt: runStartedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - runStartedAtMs,
      output: {
        totalSamples: report.totalSamples,
        resumedSamples: resultSink.recovery.completedSamples.length,
        committedSamples: sampleResults.length,
        resultPath: resultSink.path,
        tracePath
      }
    });
    return report;
  } catch (error) {
    await appendLongMemEvalTrace(runTrace, {
      stage: "run",
      operation: "run_lifecycle",
      stageExecutionId: `run_${runId}`,
      status: externalSignal?.aborted === true ? "skipped" : "failed",
      startedAt: runStartedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - runStartedAtMs,
      error: toLongMemEvalStructuredError(error),
      output: { resultPath: resultSink?.path, tracePath }
    });
    throw error;
  } finally {
    try {
      await resultSink?.close();
    } finally {
      try {
        await traceWriter?.close();
      } finally {
        externalSignal?.removeEventListener("abort", forwardExternalAbort);
        await repositoryHandle.close?.();
      }
    }
  }
}

interface ExecuteLongMemEvalSampleInput {
  datasetPath: string;
  run: LongMemEvalSampleRun;
  sampleIndex: number;
  sampleCount: number;
  totalSessions: number;
  sessionOffset: number;
  ks: number[];
  judgeConfig: JudgeConfig;
  resultSink: LongMemEvalCompatibilityResultSink;
  emitProgress: (progress: LongMemEvalProgressUpdate) => void;
  answerLimiter: AsyncConcurrencyLimiter;
  judgeLimiter: AsyncConcurrencyLimiter;
  reuseIngest: boolean;
  runLtmDreaming: boolean;
  skipLtmDreaming: boolean;
  answerOnlyEvaluation: boolean;
  answerContextMode: LongMemEvalAnswerContextMode;
  ingestSessionConcurrency: number;
  logIngestRequestContext: boolean;
  disableIngestLlm: boolean;
  strictLlm: boolean;
  skipStmAdmission: boolean;
  modelRunId: string;
  storeNamespace: string;
  llm?: LongMemEvalLlmOptions;
  logger?: LongMemEvalLogger | undefined;
  onSampleStage?: LongMemEvalOptions["onSampleStage"];
  trace: LongMemEvalSampleTraceContext;
  abortRun(reason: unknown): void;
  signal?: AbortSignal;
}

async function executeLongMemEvalSample(
  input: ExecuteLongMemEvalSampleInput
): Promise<LongMemEvalSampleExecutionResult> {
  try {
    return await executeLongMemEvalSampleAndCommit(input);
  } finally {
    pruneLongMemEvalRepositoryCache(input.run.repository, input.run.contextScopeId);
    await yieldToEventLoop();
  }
}

async function executeLongMemEvalSampleAndCommit(
  input: ExecuteLongMemEvalSampleInput
): Promise<LongMemEvalSampleExecutionResult> {
  const { run } = input;
  const sampleSessionCount = buildSessionDocuments([run.sample]).length;
  const commonProgress = {
    currentSampleIndex: input.sampleIndex,
    currentSampleCount: input.sampleCount,
    currentQuestionId: run.questionId,
    currentQuestionType: run.questionType,
    currentQuestion: run.question,
    stageProgress: percent(input.sampleIndex, input.sampleCount),
    batchIndex: input.sampleIndex,
    batchCount: input.sampleCount,
    batchProgress: percent(input.sampleIndex, input.sampleCount)
  };
  let ingestedSessions = 0;
  let skippedSessions = 0;
  let timelineSummary = "";
  let timelineHasAnswer = false;
  let answerArtifact: LongMemEvalAnswerArtifact | undefined;
  let hypothesis = "";
  let judgment: LongMemEvalJudgment | undefined;
  let failure: { stage: LongMemEvalSampleFailureStage; reason: string; error?: unknown } | undefined;
  let ingestionSnapshot = sampleFactAndStmTraceSnapshot(run.repository, run.contextScopeId);

  throwIfLongMemEvalCancelled(input.signal);
  await executeStageWithRetry({
    stage: "sample_normalization",
    operation: "normalize_sample",
    trace: input.trace,
    signal: input.signal,
    maxAttempts: 1,
    traceInput: run.sample,
    execute: async () => ({
      questionId: run.questionId,
      questionType: run.questionType,
      question: run.question,
      answer: run.answer,
      answerSessionIds: run.answerSessionIds,
      haystackSessionIds: run.haystackSessionIds,
      questionDate: run.questionDate,
      contextScopeId: run.contextScopeId,
      modelRunId: run.modelRunId,
      storeNamespace: run.storeNamespace,
      sessions: buildSessionDocuments([run.sample])
    })
  });
  if (input.reuseIngest) {
    skippedSessions = sampleSessionCount;
    await emitLongMemEvalSampleStage(input, "ingestion", "skipped", "completed_ingest_reused");
    input.emitProgress({
      stage: "ingest",
      ingestStage: "finalize",
      ...commonProgress,
      stageMessage: "model_only_ingest_reused",
      batchMessage: "复用已入库样本",
      processedSamples: input.sampleIndex,
      processedSessions: input.sessionOffset + sampleSessionCount,
      advanceSteps: 0,
      advanceSessions: sampleSessionCount
    });
  } else {
    await emitLongMemEvalSampleStage(input, "ingestion", "started");
    if (input.skipStmAdmission) {
      await emitLongMemEvalSampleStage(input, "stm_admission", "skipped", "stm_admission_skipped");
    }
    input.emitProgress({
      stage: "ingest",
      ingestStage: "save_event",
      ...commonProgress,
      stageMessage: "ingesting_sample_sessions",
      batchMessage: "样本入库批次",
      advanceSteps: 0
    });
    try {
      const artifacts = await executeStageWithRetry({
        stage: "ingestion",
        operation: "finalize_ingestion",
        trace: input.trace,
        signal: input.signal,
        traceInput: {
          sample: run.sample,
          sessions: buildSessionDocuments([run.sample]),
          ingestSessionConcurrency: input.ingestSessionConcurrency,
          skipStmAdmission: input.skipStmAdmission,
          disableIngestLlm: input.disableIngestLlm,
          scope: buildLongMemEvalResultScope(input)
        },
        execute: ({ stageAttempt }) => ingestSampleTimeline(run.repository, run.sample, {
          sampleIndex: input.sampleIndex,
          sampleCount: input.sampleCount,
          totalSessions: input.totalSessions,
          sessionOffset: input.sessionOffset,
          ingestSessionConcurrency: input.ingestSessionConcurrency,
          emitProgress: input.emitProgress,
          logger: input.logger,
          logIngestRequestContext: input.logIngestRequestContext,
          disableIngestLlm: input.disableIngestLlm,
          ...(input.strictLlm ? { allowLlmFallback: false } : {}),
          skipStmAdmission: input.skipStmAdmission,
          llm: withLongMemEvalStreamingTransport(input.llm?.extraction, input.signal),
          trace: input.trace,
          stageAttempt
        }),
        traceOutput: (result: Awaited<ReturnType<typeof ingestSampleTimeline>>) => {
          ingestionSnapshot = sampleFactAndStmTraceSnapshot(run.repository, run.contextScopeId);
          return {
            ...result,
            repository: sampleRepositoryTraceSnapshot(run.repository, run.questionId)
          };
        }
      });
      ingestedSessions = artifacts.ingestedSessions;
      skippedSessions = artifacts.skippedSessions;
      await emitLongMemEvalSampleStage(input, "ingestion", "succeeded");
    } catch (error) {
      if (isLongMemEvalCancellation(error, input.signal)) throw error;
      ingestionSnapshot = sampleFactAndStmTraceSnapshot(run.repository, run.contextScopeId);
      failure = sampleExecutionFailure(input, "ingest", error);
      skippedSessions = sampleSessionCount;
      await emitLongMemEvalSampleStage(input, "ingestion", "failed", failure.reason);
      input.emitProgress({
        stage: "ingest",
        ingestStage: "finalize",
        ...commonProgress,
        currentJudgment: failure.reason,
        stageMessage: "sample_skipped_error",
        batchMessage: "样本入库批次"
      });
    }
  }

  await appendLongMemEvalSampleSummaryTrace(input.trace, "sample_facts", {
    count: ingestionSnapshot.facts.length,
    facts: ingestionSnapshot.facts
  });
  await appendLongMemEvalSampleSummaryTrace(input.trace, "sample_stms", {
    count: ingestionSnapshot.shortTermMemories.length,
    stms: ingestionSnapshot.shortTermMemories
  });

  if (failure) {
    await skipRemainingLongMemEvalSampleStages(input, "timeline_aggregation", failure.reason);
  } else {
    await emitLongMemEvalSampleStage(input, "timeline_aggregation", "started");
    try {
      const timeline = await executeStageWithRetry({
        stage: "timeline_aggregation",
        operation: "aggregate_timeline",
        trace: input.trace,
        signal: input.signal,
        traceInput: {
          question: run.question,
          answer: run.answer,
          sessionEventIds: buildSessionDocuments([run.sample]).map((session) => makeSampleSessionEvent(run.sample, session).eventId),
          contextScopeId: run.contextScopeId
        },
        execute: () => buildSampleTimelineAggregation(run.repository, run.sample)
      });
      timelineSummary = timeline.summary;
      timelineHasAnswer = containsAnswer(timelineSummary, run.answer);
      logLongMemEvalRequest(input.logger, {
        stage: "timeline_aggregation",
        questionId: run.questionId,
        questionType: run.questionType,
        contextScopeId: run.contextScopeId,
        modelRunId: input.modelRunId,
        storeNamespace: input.storeNamespace,
        sampleIndex: input.sampleIndex,
        sampleCount: input.sampleCount,
        eventTime: timeline.event.eventTime,
        factCount: timeline.facts.length,
        aggregatedFactCount: timeline.aggregatedFacts.length,
        relatedFactCount: timeline.related.length,
        haystackSessionCount: run.haystackSessionIds.length,
        answerSessionIds: run.answerSessionIds,
        summaryPreview: timelineSummary.slice(0, 2000)
      });
      input.emitProgress({
        stage: "timeline_aggregation",
        ...commonProgress,
        currentSessionDate: timeline.event.eventTime,
        stageMessage: timelineSummary,
        batchMessage: "时间轴聚合批次"
      });
      await emitLongMemEvalSampleStage(input, "timeline_aggregation", "succeeded");
    } catch (error) {
      if (isLongMemEvalCancellation(error, input.signal)) throw error;
      failure = sampleExecutionFailure(input, "timeline_aggregation", error);
      await emitLongMemEvalSampleStage(input, "timeline_aggregation", "failed", failure.reason);
      input.emitProgress({
        stage: "timeline_aggregation",
        ...commonProgress,
        currentJudgment: failure.reason,
        stageMessage: "sample_skipped_error",
        batchMessage: "时间轴聚合批次"
      });
      await skipRemainingLongMemEvalSampleStages(input, "ltm", failure.reason);
    }
  }

  if (!failure) {
    const ltmSkipReason = input.answerOnlyEvaluation
      ? "answer_only_evaluation"
      : input.skipLtmDreaming
        ? "ltm_dreaming_skipped"
        : "ltm_reinforcement_skipped";
    if (!input.runLtmDreaming) {
      await emitLongMemEvalSampleStage(input, "ltm", "skipped", ltmSkipReason);
      if (!input.answerOnlyEvaluation) {
        input.emitProgress({
          stage: "ltm",
          ...commonProgress,
          currentJudgment: ltmSkipReason,
          stageMessage: ltmSkipReason,
          batchIndex: 0,
          batchCount: 0,
          batchProgress: 100,
          batchMessage: "跳过 LTM 做梦"
        });
      }
    } else {
      const sourceMemoryDataIds = buildSampleTimelineMemoryIds(run.sample);
      await emitLongMemEvalSampleStage(input, "ltm", "started");
      input.emitProgress({
        stage: "ltm",
        ...commonProgress,
        ...(sourceMemoryDataIds[0] ? { currentSessionId: sourceMemoryDataIds[0] } : {}),
        stageMessage: "running_ltm_reinforcement",
        batchIndex: 1,
        batchCount: 1,
        batchProgress: 0,
        batchMessage: "做梦批次准备中"
      });
      try {
        const ltmCandidates = (await Promise.all(
          sourceMemoryDataIds.map((memoryDataId) => run.repository.getShortTermMemory(memoryDataId))
        )).filter((memory): memory is ShortTermMemory => Boolean(memory));
        const dreamResult = await executeStageWithRetry({
          stage: "ltm",
          operation: "dream_ltm",
          trace: input.trace,
          signal: input.signal,
          traceInput: {
            timelineSummary,
            sourceMemoryDataIds,
            candidates: ltmCandidates,
            scope: buildLongMemEvalResultScope(input)
          },
          execute: ({ stageAttempt }) => runDreamingInBatches(run.repository, {
          ...withLongMemEvalStreamingTransport(input.llm?.extraction, input.signal),
          fallbackMode: input.strictLlm ? "throw" : "allow",
          observer: createLongMemEvalTraceLlmObserver(input, "ltm", stageAttempt)
          }, {
          logger: input.logger,
          questionId: run.questionId,
          questionType: run.questionType,
          sampleIndex: input.sampleIndex,
          sampleCount: input.sampleCount,
          stage: "ltm",
          timelineSummary,
          sourceMemoryDataIds,
          onBatchProgress: (batch) => input.emitProgress({
            stage: "ltm",
            ...commonProgress,
            ...(sourceMemoryDataIds[0] ? { currentSessionId: sourceMemoryDataIds[0] } : {}),
            stageMessage: `做梦批次 ${batch.batchIndex} / ${batch.batchCount}`,
            stageProgress: percent(batch.batchIndex, batch.batchCount),
            batchIndex: batch.batchIndex,
            batchCount: batch.batchCount,
            batchProgress: percent(batch.batchIndex, batch.batchCount),
            batchMessage: `候选 ${batch.batchCandidates} / ${batch.totalCandidates}`,
            currentJudgment: `dreamed:${batch.totalDreamed}`
          })
          }),
          traceOutput: (result) => ({
            ...result,
            repository: sampleRepositoryTraceSnapshot(run.repository, run.questionId)
          })
        });
        await emitLongMemEvalSampleStage(input, "ltm", "succeeded");
        input.emitProgress({
          stage: "ltm",
          ...commonProgress,
          stageMessage: `batches:${dreamResult.totalBatches}, candidates:${dreamResult.totalCandidates}, dreamed:${dreamResult.totalDreamed}`,
          batchIndex: dreamResult.totalBatches,
          batchCount: dreamResult.totalBatches,
          batchProgress: 100,
          batchMessage: `候选 ${dreamResult.totalCandidates}，已做梦 ${dreamResult.totalDreamed}`
        });
      } catch (error) {
        if (isLongMemEvalCancellation(error, input.signal)) throw error;
        failure = sampleExecutionFailure(input, "ltm", error);
        await emitLongMemEvalSampleStage(input, "ltm", "failed", failure.reason);
        input.emitProgress({
          stage: "ltm",
          ...commonProgress,
          currentJudgment: failure.reason,
          stageMessage: "sample_skipped_error",
          batchMessage: "LTM 队列"
        });
        await skipRemainingLongMemEvalSampleStages(input, "answer", failure.reason);
      }
    }
  }

  if (!failure) {
    await emitLongMemEvalSampleStage(input, "answer", "started");
    input.emitProgress({
      stage: "answer",
      ...commonProgress,
      stageMessage: "answer_started",
      batchMessage: "答案生成队列",
      advanceSteps: 0
    });
    try {
      const answerResult = await executeStageWithRetry({
        stage: "answer",
        operation: "generate_hypothesis",
        trace: input.trace,
        signal: input.signal,
        traceInput: {
          question: run.question,
          questionType: run.questionType,
          answer: run.answer,
          questionDate: run.questionDate,
          timelineSummary,
          answerContextMode: input.answerContextMode,
          scope: buildLongMemEvalResultScope(input)
        },
        execute: ({ stageAttempt }) => input.answerLimiter.run(
          async () => {
            const result = await generateHypothesis(run.repository, run, input.llm?.extraction, {
          logger: input.logger,
          questionId: run.questionId,
          questionType: run.questionType,
          contextScopeId: run.contextScopeId,
          modelRunId: input.modelRunId,
          storeNamespace: input.storeNamespace,
          sampleIndex: input.sampleIndex,
          sampleCount: input.sampleCount,
          stage: "answer",
          contextSummary: timelineSummary,
          answerContextMode: input.answerContextMode,
          allowLlmFallback: !input.strictLlm,
          trace: input.trace,
          stageAttempt,
          observer: mergeLongMemEvalObservers(
            createLongMemEvalStageLlmObserver({ stage: "answer", emitProgress: input.emitProgress }, {
            currentQuestionId: run.questionId,
            currentQuestionType: run.questionType,
            currentQuestion: run.question,
            currentSampleIndex: input.sampleIndex,
            currentSampleCount: input.sampleCount
            }),
            createLongMemEvalTraceLlmObserver(input, "answer", stageAttempt)
          ),
          ...(input.signal ? { signal: input.signal } : {})
            });
            if (result.skipped) throw retryableLongMemEvalStageError(result.skipReason ?? "answer_retry_exhausted");
            return result;
          },
          input.signal
        ),
        traceOutput: (result: Awaited<ReturnType<typeof generateHypothesis>>) => result
      });
      throwIfLongMemEvalCancelled(input.signal);
      hypothesis = answerResult.hypothesis;
      answerArtifact = {
        hypothesis,
        fallbackUsed: answerResult.fallbackUsed,
        ...(answerResult.fallbackReason ? { fallbackReason: answerResult.fallbackReason } : {}),
        ...(answerResult.skipped ? { skipped: true, skipReason: answerResult.skipReason ?? "llm_retry_exhausted" } : {}),
        rankedSessionIds: answerResult.rankedSessionIds,
        promptHasAnswer: containsAnswer(answerResult.prompt, run.answer),
        promptPreview: limitLongMemEvalPreview(answerResult.prompt, longMemEvalDiagnosticPreviewCharLimit),
        answerContextDiagnostic: summarizeAnswerContextDiagnostic(answerResult.answerContext),
        ...(answerResult.pack ? { contextPackDiagnostic: summarizeContextPackDiagnostic(answerResult.pack) } : {}),
        scope: buildLongMemEvalResultScope(input)
      };
      if (answerResult.skipped) {
        failure = { stage: "answer", reason: answerResult.skipReason ?? "llm_retry_exhausted" };
        await emitLongMemEvalSampleStage(input, "answer", "failed", failure.reason);
        await emitLongMemEvalSampleStage(input, "judge", "skipped", failure.reason);
      } else {
        await emitLongMemEvalSampleStage(input, "answer", "succeeded");
      }
      input.emitProgress({
        stage: "answer",
        ...commonProgress,
        ...(hypothesis ? { currentHypothesis: hypothesis } : {}),
        ...(answerResult.fallbackReason || answerResult.skipReason
          ? { currentJudgment: answerResult.fallbackReason ?? answerResult.skipReason }
          : {}),
        stageMessage: answerResult.skipped
          ? "sample_skipped_llm_retry_exhausted"
          : answerResult.fallbackUsed ? "answer_failed" : "answer_ready",
        batchMessage: "答案生成队列"
      });
    } catch (error) {
      if (isLongMemEvalCancellation(error, input.signal)) throw error;
      failure = sampleExecutionFailure(input, "answer", error);
      await emitLongMemEvalSampleStage(input, "answer", "failed", failure.reason);
      await emitLongMemEvalSampleStage(input, "judge", "skipped", failure.reason);
      input.emitProgress({
        stage: "answer",
        ...commonProgress,
        currentJudgment: failure.reason,
        stageMessage: "sample_skipped_error",
        batchMessage: "答案生成队列"
      });
    }
  }

  if (!failure && answerArtifact) {
    const completedAnswerArtifact = answerArtifact;
    await emitLongMemEvalSampleStage(input, "judge", "started");
    try {
      judgment = await executeStageWithRetry({
        stage: "judge",
        operation: "judge_hypothesis",
        trace: input.trace,
        signal: input.signal,
        traceInput: {
          question: run.question,
          answer: run.answer,
          hypothesis,
          prompt: buildJudgePrompt(run, hypothesis),
          judge: { baseUrl: input.judgeConfig.baseUrl, model: input.judgeConfig.model },
          scope: buildLongMemEvalResultScope(input)
        },
        execute: ({ stageAttempt }) => input.judgeLimiter.run(
          async () => {
            const result = completedAnswerArtifact.fallbackUsed
              ? answerFailureJudgment(completedAnswerArtifact, input.judgeConfig)
              : await judgeHypothesis(hypothesis, run, input.judgeConfig, input.llm?.extraction, {
            logger: input.logger,
            questionId: run.questionId,
            questionType: run.questionType,
            contextScopeId: run.contextScopeId,
            modelRunId: input.modelRunId,
            storeNamespace: input.storeNamespace,
            sampleIndex: input.sampleIndex,
            sampleCount: input.sampleCount,
            stage: "judge",
            observer: mergeLongMemEvalObservers(
              createLongMemEvalStageLlmObserver({ stage: "judge", emitProgress: input.emitProgress }, {
              currentQuestionId: run.questionId,
              currentQuestionType: run.questionType,
              currentQuestion: run.question,
              currentSampleIndex: input.sampleIndex,
              currentSampleCount: input.sampleCount,
              currentHypothesis: hypothesis
              }),
              createLongMemEvalTraceLlmObserver(input, "judge", stageAttempt)
            ),
            ...(input.signal ? { signal: input.signal } : {}),
            allowLlmFallback: !input.strictLlm
              });
            if (isSkippedJudgment(result)) throw retryableLongMemEvalStageError(readSkippedJudgmentReason(result));
            return result;
          },
          input.signal
        )
      });
      throwIfLongMemEvalCancelled(input.signal);
      if (isSkippedJudgment(judgment)) {
        failure = { stage: "judge", reason: readSkippedJudgmentReason(judgment) };
        await emitLongMemEvalSampleStage(input, "judge", "failed", failure.reason);
      } else {
        await emitLongMemEvalSampleStage(input, "judge", "succeeded");
      }
      input.emitProgress({
        stage: "judge",
        ...commonProgress,
        currentHypothesis: hypothesis,
        currentJudgment: failure?.reason ?? judgment.reason,
        stageMessage: failure ? "sample_skipped_llm_retry_exhausted" : judgment.label,
        batchMessage: "Judge 队列"
      });
    } catch (error) {
      if (isLongMemEvalCancellation(error, input.signal)) throw error;
      failure = sampleExecutionFailure(input, "judge", error);
      await emitLongMemEvalSampleStage(input, "judge", "failed", failure.reason);
      input.emitProgress({
        stage: "judge",
        ...commonProgress,
        currentHypothesis: hypothesis,
        currentJudgment: failure.reason,
        stageMessage: "sample_skipped_error",
        batchMessage: "Judge 队列"
      });
    }
  }

  if (!judgment) judgment = skippedJudgment(input.judgeConfig, failure?.reason);
  const retrieval = failure || !answerArtifact
    ? []
    : input.ks.map((k) => scoreRanking(run.answerSessionIds, answerArtifact!.rankedSessionIds, k));
  const report: LongMemEvalSampleReport = {
    questionId: run.questionId,
    questionType: run.questionType,
    question: run.question,
    answer: run.answer,
    hypothesis,
    ...(failure ? { skipped: true, skipReason: failure.reason } : {}),
    ...(answerArtifact?.fallbackUsed ? { answerFallbackUsed: true } : {}),
    ...(answerArtifact?.fallbackReason ? { answerFallbackReason: answerArtifact.fallbackReason } : {}),
    judgment,
    retrieval
  };
  const resultRow = failure
    ? buildLongMemEvalSkippedResultRow(input, report, failure, answerArtifact, timelineSummary, timelineHasAnswer)
    : buildLongMemEvalSucceededResultRow(input, report, answerArtifact!, timelineSummary, timelineHasAnswer);

  await emitLongMemEvalSampleStage(input, "result_commit", "started");
  input.emitProgress({
    stage: "result_commit",
    ...commonProgress,
    stageMessage: "result_commit_started",
    batchMessage: "结果写入队列",
    advanceSteps: 0
  });
  try {
    throwIfLongMemEvalCancelled(input.signal);
    const sampleIdentity = { index: input.sampleIndex, questionId: run.questionId };
    const resultCommitId = createLongMemEvalResultCommitId({
      runId: input.trace.runId,
      modelRunId: input.modelRunId,
      datasetIdentity: input.resultSink.datasetIdentity,
      sampleIdentity
    });
    const payloadHash = hashLongMemEvalResultPayload({
      ...resultRow,
      runId: input.trace.runId,
      modelRunId: input.modelRunId,
      datasetIdentity: input.resultSink.datasetIdentity,
      sampleIdentity,
      resultCommitId
    });
    await executeStageWithRetry({
      stage: "result_commit",
      operation: "append_result",
      trace: input.trace,
      signal: input.signal,
      traceInput: {
        result: resultRow,
        resultCommitId,
        payloadHash,
        targetPath: input.resultSink.path
      },
      links: { resultCommitId, payloadHash, targetPath: input.resultSink.path },
      execute: () => input.resultSink.commit(resultRow, sampleIdentity)
    });
    await emitLongMemEvalSampleStage(input, "result_commit", "succeeded");
    input.emitProgress({
      stage: "result_commit",
      ...commonProgress,
      stageMessage: "result_commit_succeeded",
      batchMessage: "结果写入队列"
    });
  } catch (error) {
    await emitLongMemEvalSampleStage(input, "result_commit", "failed", error instanceof Error ? error.message : String(error));
    input.abortRun(error);
    throw error;
  }
  return {
    report,
    resultRow,
    ingestedSessions,
    skippedSessions,
    judged: !failure,
    judgeFallbackUsed: Boolean(judgment.raw && typeof judgment.raw === "object" && "fallbackReason" in judgment.raw),
    answerFallbackUsed: answerArtifact?.fallbackUsed === true,
    retrievalEvaluable: isOfficialRetrievalEvaluable(run.sample)
  };
}

async function emitLongMemEvalSampleStage(
  input: ExecuteLongMemEvalSampleInput,
  stage: LongMemEvalSampleStage,
  status: LongMemEvalSampleStageEvent["status"],
  reason?: string
) {
  const traceStage = sampleStageToTraceStage(stage);
  const now = new Date().toISOString();
  await appendLongMemEvalTrace(input.trace, {
    stage: traceStage,
    operation: sampleStageLifecycleOperation(stage),
    stageExecutionId: `lifecycle_${stage}_${input.sampleIndex}`,
    status,
    startedAt: now,
    ...(status !== "started" ? { finishedAt: now, elapsedMs: 0 } : {}),
    ...(reason ? { output: { reason } } : {}),
    links: { ...buildLongMemEvalResultScope(input) }
  });
  await input.onSampleStage?.({
    stage,
    status,
    sampleIndex: input.sampleIndex,
    sampleCount: input.sampleCount,
    questionId: input.run.questionId,
    questionType: input.run.questionType,
    contextScopeId: input.run.contextScopeId,
    modelRunId: input.modelRunId,
    storeNamespace: input.storeNamespace,
    ...(reason ? { reason } : {})
  });
}

function sampleStageToTraceStage(stage: LongMemEvalSampleStage): LongMemEvalTraceStage {
  return stage === "stm_admission" ? "ingestion" : stage;
}

function sampleStageLifecycleOperation(stage: LongMemEvalSampleStage): LongMemEvalTraceOperation {
  switch (stage) {
    case "stm_admission": return "stm_admission";
    case "timeline_aggregation": return "aggregate_timeline";
    case "ltm": return "dream_ltm";
    case "answer": return "generate_hypothesis";
    case "judge": return "judge_hypothesis";
    case "result_commit": return "append_result";
    default: return "finalize_ingestion";
  }
}

function sampleExecutionFailure(
  input: ExecuteLongMemEvalSampleInput,
  stage: LongMemEvalSampleFailureStage,
  error: unknown
) {
  const reason = longMemEvalSampleFailureReason(stage, error);
  logLongMemEvalSampleFailure(input.logger, {
    sampleIndex: input.sampleIndex,
    sampleCount: input.sampleCount,
    questionId: input.run.questionId,
    questionType: input.run.questionType,
    failureStage: stage,
    reason
  }, error);
  return { stage, reason, error };
}

async function skipRemainingLongMemEvalSampleStages(
  input: ExecuteLongMemEvalSampleInput,
  firstStage: Exclude<LongMemEvalSampleStage, "ingestion" | "stm_admission" | "result_commit">,
  reason: string
) {
  const stages: Array<Exclude<LongMemEvalSampleStage, "ingestion" | "result_commit">> = [
    "stm_admission",
    "timeline_aggregation",
    "ltm",
    "answer",
    "judge"
  ];
  const start = stages.indexOf(firstStage);
  for (const stage of stages.slice(start)) {
    await emitLongMemEvalSampleStage(input, stage, "skipped", reason);
  }
}

function buildLongMemEvalResultScope(input: ExecuteLongMemEvalSampleInput): LongMemEvalScopeMetadata {
  return {
    questionId: input.run.questionId,
    contextScopeId: input.run.contextScopeId,
    modelRunId: input.modelRunId,
    storeNamespace: input.storeNamespace
  };
}

function buildLongMemEvalSkippedResultRow(
  input: ExecuteLongMemEvalSampleInput,
  report: LongMemEvalSampleReport,
  failure: { stage: LongMemEvalSampleFailureStage; reason: string },
  answer: LongMemEvalAnswerArtifact | undefined,
  timelineSummary: string,
  timelineHasAnswer: boolean
) {
  return {
    datasetPath: input.datasetPath,
    sampleIndex: input.sampleIndex,
    sampleCount: input.sampleCount,
    questionId: input.run.questionId,
    questionType: input.run.questionType,
    question: input.run.question,
    answer: input.run.answer,
    hypothesis: report.hypothesis,
    failureStage: failure.stage,
    status: "skipped",
    skipped: true,
    skipReason: failure.reason,
    failureReason: failure.reason,
    error: failure.reason,
    ...(timelineSummary
      ? {
          timelineHasAnswer,
          timelineSummaryPreview: limitLongMemEvalPreview(timelineSummary, longMemEvalDiagnosticPreviewCharLimit)
        }
      : {}),
    ...(answer
      ? {
          answerFallbackUsed: answer.fallbackUsed,
          answerFallbackReason: answer.fallbackReason,
          promptHasAnswer: answer.promptHasAnswer,
          answerRankedSessionIds: answer.rankedSessionIds.slice(0, Math.max(10, ...input.ks)),
          answerContextMode: answer.answerContextDiagnostic.mode,
          answerContext: answer.answerContextDiagnostic,
          answerScope: answer.scope,
          ...(answer.contextPackDiagnostic ? { contextPack: answer.contextPackDiagnostic } : {}),
          promptPreview: answer.promptPreview
        }
      : {}),
    scope: buildLongMemEvalResultScope(input)
  };
}

function buildLongMemEvalSucceededResultRow(
  input: ExecuteLongMemEvalSampleInput,
  report: LongMemEvalSampleReport,
  answer: LongMemEvalAnswerArtifact,
  timelineSummary: string,
  timelineHasAnswer: boolean
) {
  return {
    datasetPath: input.datasetPath,
    sampleIndex: input.sampleIndex,
    sampleCount: input.sampleCount,
    questionId: input.run.questionId,
    questionType: input.run.questionType,
    question: input.run.question,
    answer: input.run.answer,
    hypothesis: report.hypothesis,
    answerFallbackUsed: answer.fallbackUsed,
    answerFallbackReason: answer.fallbackReason,
    exactMatch: answer.fallbackUsed ? false : exactMatchScore(input.run.answer, report.hypothesis),
    judgment: report.judgment,
    timelineHasAnswer,
    promptHasAnswer: answer.promptHasAnswer,
    answerRankedSessionIds: answer.rankedSessionIds.slice(0, Math.max(10, ...input.ks)),
    answerContextMode: answer.answerContextDiagnostic.mode,
    answerContext: answer.answerContextDiagnostic,
    answerScope: answer.scope,
    ...(answer.contextPackDiagnostic ? { contextPack: answer.contextPackDiagnostic } : {}),
    promptPreview: answer.promptPreview,
    timelineSummaryPreview: limitLongMemEvalPreview(timelineSummary, longMemEvalDiagnosticPreviewCharLimit),
    scope: buildLongMemEvalResultScope(input)
  };
}

async function createLongMemEvalCompatibilityResultSink(
  path: string | undefined,
  identity: {
    runId: string;
    modelRunId: string;
    datasetIdentity: LongMemEvalDatasetIdentity;
  },
  samples: LongMemEvalSampleIdentity[],
  options: { resume: boolean; retrySkipped: boolean; resumeLegacy: boolean }
): Promise<LongMemEvalCompatibilityResultSink> {
  if (!path) {
    return {
      datasetIdentity: identity.datasetIdentity,
      recovery: emptyLongMemEvalRecovery(samples),
      commit: async () => undefined,
      close: async () => undefined
    };
  }
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLongMemEvalResultLock(path, identity.runId);
  let writer: LongMemEvalResultWriter | undefined;
  try {
    const recovery = options.resume
      ? await scanLongMemEvalResultRecovery({
          resultPath: path,
          datasetIdentity: identity.datasetIdentity,
          samples,
          modelRunId: identity.modelRunId,
          retrySkipped: options.retrySkipped,
          resumeLegacy: options.resumeLegacy
        })
      : emptyLongMemEvalRecovery(samples);
    writer = await LongMemEvalResultWriter.open({ path, truncate: !options.resume });
    const openedWriter = writer;
    let closed = false;
    return {
      path,
      datasetIdentity: identity.datasetIdentity,
      recovery,
      async commit(result, sampleIdentity) {
        return openedWriter.commit({
          result,
          runId: identity.runId,
          modelRunId: identity.modelRunId,
          datasetIdentity: identity.datasetIdentity,
          sampleIdentity
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await openedWriter.close();
        } finally {
          await lock.release();
        }
      }
    };
  } catch (error) {
    await writer?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}

function emptyLongMemEvalRecovery(samples: LongMemEvalSampleIdentity[]): LongMemEvalRecoveryScanResult {
  return {
    completedKeys: new Set(),
    completedSamples: [],
    pendingSamples: samples,
    ...(samples[0] ? { firstPendingSample: samples[0] } : {}),
    ignoredIncompleteTail: false,
    duplicateCommits: 0
  };
}

function longMemEvalSiblingTracePath(resultPath: string, runId: string) {
  const suffix = ".jsonl";
  return resultPath.endsWith(suffix)
    ? `${resultPath.slice(0, -suffix.length)}.${sanitizeLongMemEvalRunId(runId)}.trace.jsonl`
    : `${resultPath}.${sanitizeLongMemEvalRunId(runId)}.trace.jsonl`;
}

function longMemEvalTraceableOptions(options: LongMemEvalOptions) {
  return {
    ks: options.ks,
    answerConcurrency: options.answerConcurrency,
    judgeConcurrency: options.judgeConcurrency,
    ingestSampleConcurrency: options.ingestSampleConcurrency,
    ingestSessionConcurrency: options.ingestSessionConcurrency,
    answerContextMode: options.answerContextMode,
    enableLtmReinforcement: options.enableLtmReinforcement,
    disableIngestLlm: options.disableIngestLlm,
    allowLlmFallback: options.allowLlmFallback,
    skipStmAdmission: options.skipStmAdmission,
    skipLtmDreaming: options.skipLtmDreaming,
    modelOnlyEvaluation: options.modelOnlyEvaluation,
    answerOnlyEvaluation: options.answerOnlyEvaluation,
    resume: options.resume,
    retrySkipped: options.retrySkipped,
    resumeLegacy: options.resumeLegacy,
    modelRunId: options.modelRunId,
    storeNamespace: options.storeNamespace,
    llm: options.llm
  };
}

function retryableLongMemEvalStageError(message: string) {
  const error = new Error(message) as Error & { retryable: true };
  error.name = "LongMemEvalRetryableStageError";
  error.retryable = true;
  return error;
}

function mergeLongMemEvalObservers(
  ...observers: Array<OpenAiCompatibleRequestObserver | undefined>
): OpenAiCompatibleRequestObserver {
  return (observation) => {
    for (const observer of observers) observer?.(observation);
  };
}

function createLongMemEvalTraceLlmObserver(
  input: ExecuteLongMemEvalSampleInput,
  stage: "ingestion" | "ltm" | "answer" | "judge",
  stageAttempt = 1
): OpenAiCompatibleRequestObserver {
  const stageExecutionIds = new Map<string, string>();
  return (observation) => {
    const internalAttempt = observation.internalAttempt ?? 1;
    const key = `${observation.operation}\u0000${internalAttempt}\u0000${observation.startedAt}`;
    const stageExecutionId = stageExecutionIds.get(key) ?? `llm_${randomUUID()}`;
    stageExecutionIds.set(key, stageExecutionId);
    void appendLongMemEvalTrace(input.trace, {
      stage,
      operation: "llm_request",
      stageExecutionId,
      status: observation.status,
      attempt: internalAttempt,
      stageAttempt,
      internalAttempt,
      startedAt: observation.startedAt,
      ...(observation.status !== "started" ? { finishedAt: new Date().toISOString() } : {}),
      ...(observation.elapsedMs !== undefined ? { elapsedMs: observation.elapsedMs } : {}),
      input: {
        operation: observation.operation,
        endpoint: observation.endpoint,
        model: observation.model,
        requestBody: observation.requestBody,
        context: observation.context
      },
      ...(observation.status === "succeeded"
        ? { output: { rawResponse: observation.response, usage: observation.usage } }
        : {}),
      ...(observation.status === "failed"
        ? { error: longMemEvalObservationError(observation) }
        : {}),
      links: { contextScopeId: input.run.contextScopeId }
    }).catch((error) => input.abortRun(error));
  };
}

function sampleRepositoryTraceSnapshot(repository: ContextEngineRepository, questionId: string) {
  const snapshot = repository.getDebugSnapshot();
  const matches = (value: unknown) => JSON.stringify(value).includes(questionId);
  return {
    memoryEvents: snapshot.memoryEvents.filter(matches),
    parsedSegments: snapshot.parsedSegments.filter(matches),
    facts: snapshot.facts.filter(matches),
    shortTermMemories: snapshot.shortTermMemories.filter(matches),
    longTermMemories: snapshot.longTermMemories.filter(matches),
    pipelineTasks: snapshot.pipelineTasks.filter(matches),
    changeEvents: snapshot.changeEvents.filter(matches),
    llmFactFusionTraces: snapshot.llmFactFusionTraces.filter(matches),
    llmStmAdmissionTraces: snapshot.llmStmAdmissionTraces.filter(matches),
    llmDreamingTraces: snapshot.llmDreamingTraces.filter(matches)
  };
}

function sampleFactAndStmTraceSnapshot(
  repository: ContextEngineRepository,
  contextScopeId: string
) {
  const snapshot = repository.getDebugSnapshot();
  const facts = snapshot.facts.filter((fact) => fact.contextScopeId === contextScopeId);
  const factIds = new Set(facts.map((fact) => fact.factId));
  const shortTermMemories = snapshot.shortTermMemories.filter((memory) =>
    memory.sourceFactIds.some((factId) => factIds.has(factId))
  );
  return { facts, shortTermMemories };
}

function longMemEvalObservationError(observation: OpenAiCompatibleRequestObservation) {
  if (!observation.structuredError) return toLongMemEvalStructuredError(observation.error);
  return {
    name: observation.structuredError.name,
    message: observation.structuredError.message,
    ...(observation.structuredError.code !== undefined ? { code: observation.structuredError.code } : {}),
    ...(observation.structuredError.status !== undefined ? { cause: { status: observation.structuredError.status } } : {})
  };
}

export async function evaluateLongMemEvalModelRuns(
  datasetPath: string,
  options: LongMemEvalMultiModelOptions
): Promise<LongMemEvalMultiModelReport> {
  throwIfLongMemEvalCancelled(options.signal);
  const llmRuns = normalizeLongMemEvalLlmRuns(options.llmRuns);
  if (!llmRuns.length) {
    throw new Error("llmRuns must contain at least one model run");
  }

  const ks = normalizeKs(options.ks);
  const totalSamples = await countLongMemEvalSamples(datasetPath);
  throwIfLongMemEvalCancelled(options.signal);
  const modelConcurrency = normalizeModelConcurrency(options.modelConcurrency, llmRuns.length);
  const runs = await mapWithConcurrency<(typeof llmRuns)[number], LongMemEvalModelRunReport>(llmRuns, modelConcurrency, async (run) => {
    throwIfLongMemEvalCancelled(options.signal);
    const startedAt = new Date().toISOString();
    const diagnosticsPath = resolveRunDiagnosticsPath(options.diagnosticsPath, run);
    const tracePath = resolveRunArtifactPath(options.tracePath, run.tracePath, run.runId);
    try {
      const lifecycleRunId = options.runId
        ? `${sanitizeLongMemEvalRunId(options.runId)}.${sanitizeLongMemEvalRunId(run.runId)}`
        : createLongMemEvalRunId();
      const report = await evaluateLongMemEvalDataset(datasetPath, {
        ks,
        ...(run.llm ? { llm: run.llm } : {}),
        ...(options.graphStore ? { graphStore: options.graphStore } : {}),
        ...(options.evalBatchSize ? { evalBatchSize: options.evalBatchSize } : {}),
        ...(options.answerConcurrency ? { answerConcurrency: options.answerConcurrency } : {}),
        ...(options.judgeConcurrency ? { judgeConcurrency: options.judgeConcurrency } : {}),
        ...(options.ingestSampleConcurrency ? { ingestSampleConcurrency: options.ingestSampleConcurrency } : {}),
        ...(options.ingestSessionConcurrency ? { ingestSessionConcurrency: options.ingestSessionConcurrency } : {}),
        ...(options.logIngestRequestContext ? { logIngestRequestContext: options.logIngestRequestContext } : {}),
        ...(options.enableLtmReinforcement ? { enableLtmReinforcement: options.enableLtmReinforcement } : {}),
        ...(options.disableIngestLlm ? { disableIngestLlm: options.disableIngestLlm } : {}),
        ...(options.allowLlmFallback !== undefined ? { allowLlmFallback: options.allowLlmFallback } : {}),
        ...(options.skipStmAdmission ? { skipStmAdmission: options.skipStmAdmission } : {}),
        ...(options.skipLtmDreaming ? { skipLtmDreaming: options.skipLtmDreaming } : {}),
        ...(options.modelOnlyEvaluation ? { modelOnlyEvaluation: options.modelOnlyEvaluation } : {}),
        ...(options.answerOnlyEvaluation ? { answerOnlyEvaluation: options.answerOnlyEvaluation } : {}),
        ...(options.resume ? { resume: true } : {}),
        ...(options.retrySkipped ? { retrySkipped: true } : {}),
        ...(options.resumeLegacy ? { resumeLegacy: true } : {}),
        ...(diagnosticsPath ? { diagnosticsPath } : {}),
        ...(tracePath ? { tracePath } : {}),
        ...(options.answerContextMode ? { answerContextMode: options.answerContextMode } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.onProgress ? { onProgress: (progress: LongMemEvalProgress) => options.onProgress?.({
          ...progress,
          modelRunId: run.runId
        }) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        runId: lifecycleRunId,
        modelRunId: run.runId,
        storeNamespace: `run_${sanitizeLongMemEvalRunId(run.runId)}`
      });
      return {
        runId: run.runId,
        ...(run.label ? { label: run.label } : {}),
        ...(run.llm ? { llm: run.llm } : {}),
        status: "done" as const,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(diagnosticsPath ? { resultPath: resolve(diagnosticsPath) } : {}),
        ...(tracePath ? { tracePath: resolve(tracePath) } : {}),
        report
      };
    } catch (error) {
      return {
        runId: run.runId,
        ...(run.label ? { label: run.label } : {}),
        ...(run.llm ? { llm: run.llm } : {}),
        status: "error" as const,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(diagnosticsPath ? { resultPath: resolve(diagnosticsPath) } : {}),
        ...(tracePath ? { tracePath: resolve(tracePath) } : {}),
        error: error instanceof Error ? error.message : "LongMemEval model run failed"
      };
    }
  });
  const completedRuns = runs.filter((run) => run.status === "done").length;
  const firstReport = runs.find((run) => run.report)?.report;

  return {
    datasetPath,
    totalSamples,
    ks,
    totalRuns: runs.length,
    completedRuns,
    failedRuns: runs.length - completedRuns,
    modelConcurrency,
    questionTypeCounts: firstReport?.questionTypeCounts ?? {},
    runs,
    summary: runs.map((run) => ({
      runId: run.runId,
      ...(run.label ? { label: run.label } : {}),
      status: run.status,
      ...(run.report ? { judgeAccuracy: run.report.judge.accuracy } : {}),
      ...(run.report ? { answerRate: run.report.answerGeneration.answerRate } : {}),
      ...(run.report ? { judgeModel: run.report.judge.model } : {}),
      ...(run.report ? { judgeBaseUrl: run.report.judge.baseUrl } : {}),
      ...(run.error ? { error: run.error } : {})
    }))
  };
}

export function resolveLongMemEvalModelRunArtifacts(
  llmRuns: LongMemEvalLlmRunOptions[],
  options: { resultPath?: string; tracePath?: string }
) {
  return normalizeLongMemEvalLlmRuns(llmRuns).map((run) => {
    const resultPath = resolveRunDiagnosticsPath(options.resultPath, run);
    const tracePath = resolveRunArtifactPath(options.tracePath, run.tracePath, run.runId);
    return {
      modelRunId: run.runId,
      ...(resultPath ? { resultPath: resolve(resultPath) } : {}),
      ...(tracePath ? { tracePath: resolve(tracePath) } : {})
    };
  });
}

export async function countLongMemEvalSamples(datasetPath: string): Promise<number> {
  let count = 0;
  for await (const _sample of streamLongMemEvalSamples(datasetPath)) {
    count += 1;
  }
  return count;
}

export async function readLongMemEvalDebugSnapshot(datasetPath: string): Promise<ContextDebugSnapshot> {
  const repositoryHandle = await createLongMemEvalRepository(resolve(datasetPath), undefined, undefined, {
    lazyCache: true
  });
  try {
    return repositoryHandle.repository.getDebugSnapshot();
  } finally {
    await repositoryHandle.close?.();
  }
}

export interface LongMemEvalSelectedItemDetail {
  id: string;
  layer: "fact" | "stm" | "ltm";
  content: string;
  summary?: string;
  compressedContent?: string;
  sourceSegments: Array<{
    segmentId: string;
    eventId: string;
    eventTime?: string;
    sourceId?: string;
    content: string;
  }>;
  metadata: Record<string, unknown>;
}

export async function readLongMemEvalSelectedItemDetails(
  datasetPath: string,
  questionId: string,
  selectedItemIds: string[]
): Promise<{
  datasetPath: string;
  questionId: string;
  question: string;
  selectedItemIds: string[];
  items: LongMemEvalSelectedItemDetail[];
  missingItemIds: string[];
}> {
  const sample = await readLongMemEvalSampleByQuestionId(datasetPath, questionId).catch(() => undefined);
  if (sample) {
    const config = getContextEngineConfig();
    const storePath = getLongMemEvalStorePath(resolve(datasetPath), undefined, config);
    const storeStat = await readOptionalFileStat(storePath);
    if (storeStat?.isFile()) {
      const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
      try {
        return await buildLongMemEvalSelectedItemDetailsFromSample(repository, datasetPath, sample, selectedItemIds);
      } finally {
        repository.close();
      }
    }
  }

  const snapshot = await readLongMemEvalDebugSnapshot(datasetPath);
  return {
    ...buildLongMemEvalSelectedItemDetails(snapshot, datasetPath, selectedItemIds),
    questionId: sample ? readQuestionId(sample) : questionId,
    question: sample ? readQuestion(sample) : ""
  };
}

export function buildLongMemEvalSelectedItemDetails(
  snapshot: ContextDebugSnapshot,
  datasetPath: string,
  selectedItemIds: string[]
): {
  datasetPath: string;
  selectedItemIds: string[];
  items: LongMemEvalSelectedItemDetail[];
  missingItemIds: string[];
} {
  const requested = selectedItemIds.map((item) => item.trim()).filter(Boolean);
  const uniqueRequested = [...new Set(requested)];
  const factById = new Map(snapshot.facts.map((item) => [item.factId, item] as const));
  const stmById = new Map(snapshot.shortTermMemories.map((item) => [item.memoryDataId, item] as const));
  const ltmById = new Map(snapshot.longTermMemories.map((item) => [item.memoryId, item] as const));
  const items: LongMemEvalSelectedItemDetail[] = [];
  const missingItemIds: string[] = [];

  for (const itemId of uniqueRequested) {
    const fact = factById.get(itemId);
    if (fact) {
      items.push({
        id: fact.factId,
        layer: "fact",
        content: fact.factText,
        summary: fact.normalizedClaim || fact.factText,
        sourceSegments: buildLongMemEvalSourceSegmentsFromSnapshot(snapshot, [fact.factId]),
        metadata: {
          factType: fact.factType,
          confidenceLevel: fact.confidenceLevel,
          status: fact.status,
          observedAt: fact.observedAt,
          evidenceTime: fact.evidenceTime,
          validTime: fact.validTime,
          timeBasis: fact.timeBasis,
          timeConfidence: fact.timeConfidence,
          linkedEventIds: fact.linkedEventIds,
          linkedSegmentIds: fact.linkedSegmentIds,
          linkedSourceRefs: fact.linkedSourceRefs,
          entityIds: fact.entityIds,
          schemaVersion: fact.schemaVersion
        }
      });
      continue;
    }

    const stm = stmById.get(itemId);
    if (stm) {
      items.push({
        id: stm.memoryDataId,
        layer: "stm",
        content: stm.content,
        summary: stm.summary ?? stm.factSummary ?? stm.content,
        ...(stm.factSummary && stm.factSummary !== stm.content ? { compressedContent: stm.factSummary } : {}),
        sourceSegments: buildLongMemEvalSourceSegmentsFromSnapshot(snapshot, stm.sourceFactIds),
        metadata: {
          memoryDataType: stm.memoryDataType,
          memoryType: stm.memoryType,
          importanceLevel: stm.importanceLevel,
          confidenceLevel: stm.confidenceLevel,
          admissionResult: stm.admissionResult,
          admissionReason: stm.admissionReason,
          matchedRules: stm.matchedRules,
          sourceFactIds: stm.sourceFactIds,
          sourceRefs: stm.sourceRefs,
          entityIds: stm.entityIds,
          retrievalWeight: stm.retrievalWeight,
          userRetrievalWeight: stm.userRetrievalWeight,
          accessState: stm.accessState,
          lifecycleStatus: stm.lifecycleStatus,
          structuredFacts: stm.structuredFacts
        }
      });
      continue;
    }

    const ltm = ltmById.get(itemId);
    if (ltm) {
      items.push({
        id: ltm.memoryId,
        layer: "ltm",
        content: ltm.content,
        summary: ltm.summary ?? ltm.factSummary ?? ltm.content,
        ...(ltm.factSummary && ltm.factSummary !== ltm.content ? { compressedContent: ltm.factSummary } : {}),
        sourceSegments: buildLongMemEvalSourceSegmentsFromSnapshot(
          snapshot,
          snapshot.shortTermMemories
            .filter((memory) => ltm.sourceMemoryDataIds.includes(memory.memoryDataId))
            .flatMap((memory) => memory.sourceFactIds)
        ),
        metadata: {
          theoryClass: ltm.theoryClass,
          memoryType: ltm.memoryType,
          confidenceLevel: ltm.confidenceLevel,
          recallWeight: ltm.recallWeight,
          retrievalWeight: ltm.retrievalWeight,
          userRetrievalWeight: ltm.userRetrievalWeight,
          solidifyReason: ltm.solidifyReason,
          matchedRules: ltm.matchedRules,
          sourceRefs: ltm.sourceRefs,
          sourceMemoryDataIds: ltm.sourceMemoryDataIds,
          entityIds: ltm.entityIds,
          accessState: ltm.accessState,
          lifecycleStatus: ltm.lifecycleStatus,
          structuredFacts: ltm.structuredFacts
        }
      });
      continue;
    }

    missingItemIds.push(itemId);
  }

  return {
    datasetPath,
    selectedItemIds: uniqueRequested,
    items,
    missingItemIds
  };
}

function buildLongMemEvalSourceSegmentsFromSnapshot(
  snapshot: ContextDebugSnapshot,
  factIds: string[]
): LongMemEvalSelectedItemDetail["sourceSegments"] {
  const factIdSet = new Set(factIds);
  const segmentIdSet = new Set(snapshot.facts
    .filter((fact) => factIdSet.has(fact.factId))
    .flatMap((fact) => fact.linkedSegmentIds));
  const eventById = new Map(snapshot.memoryEvents.map((event) => [event.eventId, event] as const));
  return snapshot.parsedSegments
    .filter((segment) => segmentIdSet.has(segment.segmentId))
    .map((segment) => {
      const event = eventById.get(segment.eventId);
      return {
        segmentId: segment.segmentId,
        eventId: segment.eventId,
        ...(event?.eventTime ? { eventTime: event.eventTime } : {}),
        ...(event?.sourceId ? { sourceId: event.sourceId } : {}),
        content: segment.content
      };
    });
}

export async function buildLongMemEvalSelectedItemDetailsFromSample(
  repository: ContextEngineRepository,
  datasetPath: string,
  sample: LongMemEvalSample,
  selectedItemIds: string[]
): Promise<{
  datasetPath: string;
  questionId: string;
  question: string;
  selectedItemIds: string[];
  items: LongMemEvalSelectedItemDetail[];
  missingItemIds: string[];
}> {
  const requested = selectedItemIds.map((item) => item.trim()).filter(Boolean);
  const uniqueRequested = [...new Set(requested)];
  const items: LongMemEvalSelectedItemDetail[] = [];
  const missingItemIds: string[] = [];
  const questionId = readQuestionId(sample);
  const question = readQuestion(sample);

  for (const itemId of uniqueRequested) {
    const [fact] = await repository.getFactItemsByIds([itemId]);
    if (fact) {
      items.push({
        id: fact.factId,
        layer: "fact",
        content: fact.factText,
        summary: fact.normalizedClaim || fact.factText,
        sourceSegments: await buildLongMemEvalSourceSegmentsFromRepository(repository, [fact.factId]),
        metadata: {
          factType: fact.factType,
          confidenceLevel: fact.confidenceLevel,
          status: fact.status,
          observedAt: fact.observedAt,
          evidenceTime: fact.evidenceTime,
          validTime: fact.validTime,
          timeBasis: fact.timeBasis,
          timeConfidence: fact.timeConfidence,
          linkedEventIds: fact.linkedEventIds,
          linkedSegmentIds: fact.linkedSegmentIds,
          linkedSourceRefs: fact.linkedSourceRefs,
          entityIds: fact.entityIds,
          schemaVersion: fact.schemaVersion
        }
      });
      continue;
    }

    const stm = await repository.getShortTermMemory(itemId);
    if (stm) {
      items.push({
        id: stm.memoryDataId,
        layer: "stm",
        content: stm.content,
        summary: stm.summary ?? stm.factSummary ?? stm.content,
        ...(stm.factSummary && stm.factSummary !== stm.content ? { compressedContent: stm.factSummary } : {}),
        sourceSegments: await buildLongMemEvalSourceSegmentsFromRepository(repository, stm.sourceFactIds),
        metadata: {
          memoryDataType: stm.memoryDataType,
          memoryType: stm.memoryType,
          importanceLevel: stm.importanceLevel,
          confidenceLevel: stm.confidenceLevel,
          admissionResult: stm.admissionResult,
          admissionReason: stm.admissionReason,
          matchedRules: stm.matchedRules,
          sourceFactIds: stm.sourceFactIds,
          sourceRefs: stm.sourceRefs,
          entityIds: stm.entityIds,
          retrievalWeight: stm.retrievalWeight,
          userRetrievalWeight: stm.userRetrievalWeight,
          accessState: stm.accessState,
          lifecycleStatus: stm.lifecycleStatus,
          structuredFacts: stm.structuredFacts
        }
      });
      continue;
    }

    const ltm = await repository.getLongTermMemory(itemId);
    if (ltm) {
      const sourceMemories = await repository.getShortTermMemoriesByIds(ltm.sourceMemoryDataIds);
      items.push({
        id: ltm.memoryId,
        layer: "ltm",
        content: ltm.content,
        summary: ltm.summary ?? ltm.factSummary ?? ltm.content,
        ...(ltm.factSummary && ltm.factSummary !== ltm.content ? { compressedContent: ltm.factSummary } : {}),
        sourceSegments: await buildLongMemEvalSourceSegmentsFromRepository(
          repository,
          sourceMemories.flatMap((memory) => memory.sourceFactIds)
        ),
        metadata: {
          theoryClass: ltm.theoryClass,
          memoryType: ltm.memoryType,
          confidenceLevel: ltm.confidenceLevel,
          recallWeight: ltm.recallWeight,
          retrievalWeight: ltm.retrievalWeight,
          userRetrievalWeight: ltm.userRetrievalWeight,
          solidifyReason: ltm.solidifyReason,
          matchedRules: ltm.matchedRules,
          sourceRefs: ltm.sourceRefs,
          sourceMemoryDataIds: ltm.sourceMemoryDataIds,
          entityIds: ltm.entityIds,
          accessState: ltm.accessState,
          lifecycleStatus: ltm.lifecycleStatus,
          structuredFacts: ltm.structuredFacts
        }
      });
      continue;
    }

    missingItemIds.push(itemId);
  }

  return {
    datasetPath,
    questionId,
    question,
    selectedItemIds: uniqueRequested,
    items,
    missingItemIds
  };
}

async function buildLongMemEvalSourceSegmentsFromRepository(
  repository: ContextEngineRepository,
  factIds: string[]
): Promise<LongMemEvalSelectedItemDetail["sourceSegments"]> {
  const facts = await repository.getFactItemsByIds([...new Set(factIds)]);
  const segments = await repository.getParsedSegmentsByIds([...new Set(facts.flatMap((fact) => fact.linkedSegmentIds))]);
  const events = await repository.getMemoryEventsByIds([...new Set(segments.map((segment) => segment.eventId))]);
  const eventById = new Map(events.map((event) => [event.eventId, event] as const));
  return segments.map((segment) => {
    const event = eventById.get(segment.eventId);
    return {
      segmentId: segment.segmentId,
      eventId: segment.eventId,
      ...(event?.eventTime ? { eventTime: event.eventTime } : {}),
      ...(event?.sourceId ? { sourceId: event.sourceId } : {}),
      content: segment.content
    };
  });
}

async function readLongMemEvalSampleByQuestionId(datasetPath: string, questionId: string): Promise<LongMemEvalSample | undefined> {
  const target = questionId.trim();
  if (!target) return undefined;
  for await (const sample of streamLongMemEvalSamples(datasetPath)) {
    if (readQuestionId(sample) === target) return sample;
  }
  return undefined;
}

export async function readCurrentLongMemEvalDebugSnapshot(datasetPath?: string): Promise<ContextDebugSnapshot> {
  const config = getContextEngineConfig();
  const candidates = await listLongMemEvalDebugStoreCandidates(config, datasetPath);
  if (!candidates.length) {
    throw new Error("LongMemEval evaluation database not found");
  }

  let firstSnapshot: ContextDebugSnapshot | undefined;
  for (const candidate of candidates) {
    const repository = new SqliteContextEngineRepository(candidate, undefined);
    const snapshot = repository.getDebugSnapshot();
    firstSnapshot ??= snapshot;
    if (hasLongMemEvalDebugSnapshotData(snapshot)) return snapshot;
  }

  return firstSnapshot as ContextDebugSnapshot;
}

export type LongMemEvalDebugView = "dataLake" | "timeline" | "stm" | "ltm";

export interface LongMemEvalDebugSnapshotPage {
  items: ContextDebugSnapshot;
  timeline: Array<{
    fact: TimelineAggregatedFact;
    sourceEvents: MemoryEvent[];
    sourceSegments: Array<ContextDebugSnapshot["parsedSegments"][number]>;
    sourceFacts: FactItem[];
    shortTermMemories: ShortTermMemory[];
    pipelineTasks: ContextDebugSnapshot["pipelineTasks"];
    changeEvents: ContextDebugSnapshot["changeEvents"];
  }>;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export async function readCurrentLongMemEvalDebugSnapshotPage(input: {
  datasetPath?: string;
  view: LongMemEvalDebugView;
  page: number;
  pageSize: number;
  filters?: LongMemEvalDebugFilters;
}): Promise<LongMemEvalDebugSnapshotPage> {
  const config = getContextEngineConfig();
  const candidates = await listLongMemEvalDebugStoreCandidates(config, input.datasetPath);
  if (!candidates.length) {
    throw new Error("LongMemEval evaluation database not found");
  }

  let firstPage: LongMemEvalDebugSnapshotPage | undefined;
  for (const candidate of candidates) {
    const page = readLongMemEvalDebugSnapshotPageFromSqlite(candidate, input.view, input.page, input.pageSize, input.filters);
    firstPage ??= page;
    if (page.totalItems > 0) return page;
  }

  return firstPage as LongMemEvalDebugSnapshotPage;
}

export interface LongMemEvalContextPackPreviewInput extends AssembleContextRequest {
  datasetPath: string;
  questionId: string;
}

export async function assembleLongMemEvalContextPackPreview(
  input: LongMemEvalContextPackPreviewInput
): Promise<ContextPack> {
  const config = getContextEngineConfig();
  const datasetPath = resolve(input.datasetPath);
  const sample = await readLongMemEvalSampleByQuestionId(datasetPath, input.questionId);
  if (!sample) {
    throw new Error(`LongMemEval sample not found: ${input.questionId}`);
  }
  const storePath = getLongMemEvalStorePath(datasetPath, undefined, config);
  const storeStat = await readOptionalFileStat(storePath);
  if (!storeStat?.isFile()) {
    throw new Error("LongMemEval evaluation database not found for this dataset; rerun ingestion with the current store schema");
  }

  const context = longMemEvalSampleContext(sample);
  const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
  try {
    const answerContext = await buildLongMemEvalAnswerContext(repository, context, "context_pack", {
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {})
    });
    if (!answerContext.pack) throw new Error("LongMemEval context pack preview was not generated");
    return answerContext.pack;
  } finally {
    repository.close();
  }
}

export interface LongMemEvalDebugFilters {
  contentQuery?: string;
  sampleQuery?: string;
}

export async function clearLongMemEvalData(config = getContextEngineConfig()): Promise<LongMemEvalDataClearResult> {
  const deletedFiles = await deleteLongMemEvalStoreFiles(config.longMemEval.storage.storeDirectory);
  if (config.longMemEval.graphStore.mode !== "neo4j") {
    return {
      storage: {
        storeDirectory: config.longMemEval.storage.storeDirectory,
        deletedFiles
      },
      graphStore: {
        status: "skipped",
        mode: config.longMemEval.graphStore.mode,
        reason: config.longMemEval.graphStore.mode === "inherit"
          ? "longmemeval_graph_store_inherits_main_context"
          : "longmemeval_graph_store_local"
      }
    };
  }

  const graphStore = await createConfiguredLongMemEvalGraphStore(config);
  if (!graphStore) {
    return {
      storage: {
        storeDirectory: config.longMemEval.storage.storeDirectory,
        deletedFiles
      },
      graphStore: {
        status: "skipped",
        mode: config.longMemEval.graphStore.mode,
        reason: "longmemeval_graph_store_not_configured"
      }
    };
  }

  try {
    await graphStore.clearGraph();
    await graphStore.dropVectorIndex();
    await graphStore.createVectorIndex();
    return {
      storage: {
        storeDirectory: config.longMemEval.storage.storeDirectory,
        deletedFiles
      },
      graphStore: {
        status: "cleared",
        mode: config.longMemEval.graphStore.mode,
        database: config.longMemEval.graphStore.neo4j.database
      }
    };
  } finally {
    await graphStore.close?.();
  }
}

export async function ingestLongMemEvalDataset(
  repository: ContextEngineRepository,
  datasetPath: string,
  options: {
    onProgress?: (progress: LongMemEvalProgress) => void;
    logIngestRequestContext?: boolean;
    llm?: LlmFactFusionOptions;
    deferPipeline?: boolean;
    ingestSampleConcurrency?: number;
    ingestSessionConcurrency?: number;
    skipStmAdmission?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<{
  totalSamples: number;
  totalSessions: number;
  ingestedSessions: number;
  skippedSessions: number;
}> {
  const config = getContextEngineConfig();
  await probeEmbedding(createEmbeddingClient(config.embedding), options.signal);
  const samples = await loadLongMemEvalSamples(datasetPath);
  const totalSessions = countLongMemEvalSessionAttempts(samples);
  let ingestedSessions = 0;
  let skippedSessions = 0;
  const logIngestRequestContext = options.logIngestRequestContext === true;
  const ingestSampleConcurrency = normalizeIngestSampleConcurrency(options.ingestSampleConcurrency);
  const ingestSessionConcurrency = normalizeIngestSessionConcurrency(options.ingestSessionConcurrency);
  const sampleSessionOffsets: number[] = [];
  let nextSessionOffset = 0;
  for (const [sampleIndex, sample] of samples.entries()) {
    sampleSessionOffsets[sampleIndex] = nextSessionOffset;
    nextSessionOffset += buildSessionDocuments([sample]).length;
  }

  const results = await mapWithConcurrency(samples, ingestSampleConcurrency, async (sample, sampleIndex) => {
    throwIfLongMemEvalCancelled(options.signal);
    const result = await ingestSampleTimeline(
      repository,
      sample,
      {
        sampleIndex: sampleIndex + 1,
        sampleCount: samples.length,
        totalSessions,
        sessionOffset: sampleSessionOffsets[sampleIndex] ?? 0,
        ingestSessionConcurrency,
        emitProgress: (progress) => options.onProgress?.({
          ...progress,
          processedSamples: progress.processedSamples ?? sampleIndex + 1,
          totalSamples: samples.length,
          processedSessions: progress.processedSessions ?? sampleSessionOffsets[sampleIndex] ?? 0,
          totalSessions,
          processedSteps: 0,
          totalSteps: 0,
          questionTypeCounts: {}
        } as LongMemEvalProgress),
        logIngestRequestContext,
        skipStmAdmission: options.skipStmAdmission === true,
        llm: withLongMemEvalStreamingTransport(options.llm, options.signal)
      }
    );
    await yieldToEventLoop();
    throwIfLongMemEvalCancelled(options.signal);
    return result;
  });
  for (const result of results) {
    ingestedSessions += result.ingestedSessions;
    skippedSessions += result.skippedSessions;
  }

  return {
    totalSamples: samples.length,
    totalSessions,
    ingestedSessions,
    skippedSessions
  };
}

export function scoreRanking(goldSessionIds: string[], rankedSessionIds: string[], k: number): LongMemEvalMetric {
  const normalizedGold = new Set(goldSessionIds.map(normalizeToken).filter(Boolean));
  const topK = rankedSessionIds.slice(0, Math.max(0, k)).map(normalizeToken).filter(Boolean);
  const hits = topK.filter((item) => normalizedGold.has(item));
  const precisionAtK = topK.length === 0 ? 0 : hits.length / Math.max(1, topK.length);
  const recallAtK = normalizedGold.size === 0 ? 0 : hits.length / normalizedGold.size;
  const recallAnyAtK = hits.length > 0 ? 1 : 0;
  const recallAllAtK = normalizedGold.size > 0 && hits.length === normalizedGold.size ? 1 : 0;
  const firstHitRank = topK.findIndex((item) => normalizedGold.has(item));
  const mrrAtK = firstHitRank >= 0 ? 1 / (firstHitRank + 1) : 0;
  const dcg = discountedCumulativeGain(topK.map((item) => (normalizedGold.has(item) ? 1 : 0)), k);
  const idealHits = Math.min(normalizedGold.size, topK.length);
  const idcg = discountedCumulativeGain(Array.from({ length: idealHits }, () => 1), k);
  const ndcgAtK = idcg > 0 ? dcg / idcg : 0;
  return {
    k,
    recallAtK,
    recallAnyAtK,
    recallAllAtK,
    precisionAtK,
    mrrAtK,
    ndcgAtK,
    exactMatch: 0,
    judgeAccuracy: 0
  };
}

function discountedCumulativeGain(relevances: number[], k: number) {
  const sliced = relevances.slice(0, Math.max(0, k));
  if (!sliced.length) return 0;
  return sliced.reduce((sum, relevance, index) => {
    if (index === 0) return sum + relevance;
    return sum + relevance / Math.log2(index + 1);
  }, 0);
}

async function rankedSessionIdsFromAnswerContextItems(
  items: ContextPackItem[],
  repository: ContextEngineRepository,
  haystackSessionIds: string[]
): Promise<string[]> {
  const allowed = new Set(haystackSessionIds.map(normalizeToken).filter(Boolean));
  const selected = [...items].sort((left, right) => right.score - left.score);
  const ranked: string[] = [];
  const pushSessionId = (value: string | undefined) => {
    const normalized = normalizeToken(value ?? "");
    if (!normalized || !allowed.has(normalized) || ranked.includes(normalized)) return;
    ranked.push(normalized);
  };
  const factById = await factByFactId(repository, uniqueStrings(selected.flatMap((item) => item.factIds)));

  for (const item of selected) {
    for (const source of item.sourceRefs) {
      pushSessionId(longMemEvalSessionIdFromSourceRef(source));
    }
    for (const fact of rankItemFactsByContextText(item, factById)) {
      for (const source of fact.linkedSourceRefs) {
        pushSessionId(longMemEvalSessionIdFromSourceRef(source));
      }
    }
  }

  return ranked;
}

async function factByFactId(repository: ContextEngineRepository, factIds: string[]) {
  const mapped = new Map<string, FactItem>();
  for (const fact of await repository.getFactItemsByIds(factIds)) {
    mapped.set(fact.factId, fact);
  }
  return mapped;
}

function rankItemFactsByContextText(item: ContextPack["recentContext"][number], factById: Map<string, FactItem>) {
  const contextText = normalizeText(`${item.compressedContent}\n${item.content}`);
  const scored = item.factIds
    .map((factId, index) => ({ fact: factById.get(factId), index }))
    .filter((entry): entry is { fact: FactItem; index: number } => Boolean(entry.fact))
    .map((entry) => ({
      ...entry,
      score: scoreFactContextOverlap(entry.fact.factText, contextText)
    }));
  const directMatches = scored.filter((entry) => entry.score > 0);
  const ranked = directMatches.length ? directMatches : scored;
  return ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.fact);
}

function scoreFactContextOverlap(factText: string, normalizedContextText: string) {
  const normalizedFact = normalizeText(factText);
  if (!normalizedFact) return 0;
  if (normalizedContextText.includes(normalizedFact)) return 1000;
  const factTokens = extractAttributionTokens(normalizedFact);
  if (!factTokens.length) return 0;
  const matchedTokens = factTokens.filter((token) => normalizedContextText.includes(token));
  const phrases = extractAttributionPhrases(factTokens);
  const matchedPhrases = phrases.filter((phrase) => normalizedContextText.includes(phrase));
  const coverage = matchedTokens.length / factTokens.length;
  if (!matchedPhrases.length && matchedTokens.length < 2) return 0;
  return matchedPhrases.length * 10 + coverage;
}

function extractAttributionTokens(text: string) {
  return Array.from(
    new Set(
      text
        .match(/[a-z0-9$]+/g)
        ?.map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .filter((token) => !LONGMEMEVAL_QUERY_STOPWORDS.has(token)) ?? []
    )
  );
}

function extractAttributionPhrases(tokens: string[]) {
  const phrases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (left && right) phrases.push(`${left} ${right}`);
  }
  return phrases;
}

function isOfficialRetrievalEvaluable(sample: LongMemEvalSample) {
  if (readQuestionId(sample).includes("_abs")) return false;
  const haystackSessions = Array.isArray(sample.haystack_sessions) ? sample.haystack_sessions : [];
  return haystackSessions.some((session) =>
    Array.isArray(session) &&
    session.some((turn) =>
      Boolean(
        turn &&
        typeof turn === "object" &&
        (turn as { role?: unknown }).role === "user" &&
        (turn as { has_answer?: unknown }).has_answer === true
      )
    )
  );
}

async function rankedSessionIdsForLongMemEvalAnswer(
  answerContext: LongMemEvalAnswerContext,
  repository: ContextEngineRepository,
  context: SampleContext
): Promise<string[]> {
  const documents = buildSessionDocuments([context.sample]);
  const packRanked = await rankedSessionIdsFromAnswerContextItems(answerContext.selectedItems, repository, context.haystackSessionIds);
  const packBoosts = new Map(packRanked.map((sessionId, index) => [normalizeToken(sessionId), Math.max(0, 8 - index)]));
  const queryRanked = documents
    .map((session, index) => ({
      session,
      index,
      score: scoreSessionForChronologicalEvidence(context.question, session) + (packBoosts.get(normalizeToken(session.sessionId)) ?? 0)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || compareSessionDocumentsByTime(left.session, right.session) || left.index - right.index)
    .map((entry) => normalizeToken(entry.session.sessionId));
  return uniqueStrings([...queryRanked, ...packRanked]);
}

function compareSessionDocumentsByTime(left: LongMemEvalSessionDocument, right: LongMemEvalSessionDocument) {
  const leftTime = Date.parse(left.eventTime);
  const rightTime = Date.parse(right.eventTime);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const byTextTime = left.eventTime.localeCompare(right.eventTime);
  if (byTextTime !== 0) return byTextTime;
  return left.sampleSessionIndex - right.sampleSessionIndex;
}

function scoreSessionForChronologicalEvidence(question: string, session: LongMemEvalSessionDocument) {
  const queryTokens = extractAttributionTokens(normalizeText(question));
  if (!queryTokens.length) return 0;
  const normalizedContent = normalizeText(session.content);
  const phrases = extractAttributionPhrases(queryTokens);
  const tokenScore = queryTokens.reduce((score, token) => score + (normalizedContent.includes(token) ? (token.length >= 5 ? 2 : 1) : 0), 0);
  const phraseScore = phrases.reduce((score, phrase) => score + (normalizedContent.includes(phrase) ? 6 : 0), 0);
  const lineScores = (session.turns.length ? session.turns.map((turn) => turn.line) : session.content.split("\n"))
    .map((line) => scoreLineForChronologicalEvidence(line, queryTokens))
    .sort((left, right) => right - left);
  const bestLineScore = lineScores[0] ?? 0;
  const supportingLineScore = lineScores.slice(1, 4).reduce((sum, score) => sum + score * 0.5, 0);
  return tokenScore + phraseScore + bestLineScore + supportingLineScore;
}

function scoreLineForChronologicalEvidence(line: string, queryTokens: string[]) {
  const normalized = normalizeText(line);
  let score = 0;
  for (const token of queryTokens) {
    if (normalized.includes(token)) score += token.length >= 5 ? 2 : 1;
  }
  return score;
}

function limitLongMemEvalPreview(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

async function generateHypothesis(
  repository: ContextEngineRepository,
  context: SampleContext,
  llm?: LongMemEvalLlmOptions["extraction"],
  input?: {
    logger?: LongMemEvalLogger | undefined;
    questionId?: string;
    questionType?: string;
    contextScopeId?: string;
    modelRunId?: string;
    storeNamespace?: string;
    sampleIndex?: number;
    sampleCount?: number;
    stage?: string;
    contextSummary?: string;
    answerContextMode?: LongMemEvalAnswerContextMode;
    allowLlmFallback?: boolean;
    observer?: OpenAiCompatibleRequestObserver;
    trace?: LongMemEvalSampleTraceContext;
    stageAttempt?: number;
    signal?: AbortSignal;
  }
): Promise<{
  hypothesis: string;
  answerContext: LongMemEvalAnswerContext;
  pack?: ContextPack;
  prompt: string;
  rankedSessionIds: string[];
  fallbackUsed: boolean;
  fallbackReason?: string;
  skipped?: boolean;
  skipReason?: string;
}> {
  const answerContext = await withLongMemEvalContextRetry(
    (internalAttempt) => longMemEvalContextLimiter(repository).run(
      () => buildLongMemEvalAnswerContext(repository, context, input?.answerContextMode, {
        ...(input?.trace ? { trace: input.trace } : {}),
        ...(input?.stageAttempt !== undefined ? { stageAttempt: input.stageAttempt } : {}),
        internalAttempt
      })
    ),
    {
      logger: input?.logger,
      questionId: input?.questionId,
      sampleIndex: input?.sampleIndex,
      ...(input?.signal ? { signal: input.signal } : {})
    }
  );
  const rankedSessionIds = await rankedSessionIdsForLongMemEvalAnswer(answerContext, repository, context);
  const prompt = buildLongMemEvalAnswerPrompt({
    question: context.question,
    ...(context.questionDate ? { questionDate: context.questionDate } : {}),
    serializedPrompt: answerContext.serializedPrompt
  });

  logLongMemEvalRequest(input?.logger, {
    stage: input?.stage ?? "answer",
    questionId: input?.questionId,
    questionType: input?.questionType,
    contextScopeId: input?.contextScopeId ?? context.contextScopeId,
    modelRunId: input?.modelRunId,
    storeNamespace: input?.storeNamespace,
    sampleIndex: input?.sampleIndex,
    sampleCount: input?.sampleCount,
    endpoint: `${normalizeBaseUrl(llm?.baseUrl ?? getContextEngineConfig().llm.baseUrl)}/chat/completions`,
    model: llm?.model ?? getContextEngineConfig().llm.model,
    disableReasoning: false,
    contextSummaryPreview: input?.contextSummary ? limitLongMemEvalPreview(input.contextSummary, longMemEvalLogPreviewCharLimit) : undefined,
    ...summarizeAnswerContextForLog(answerContext),
    answerRankedSessionIds: rankedSessionIds.slice(0, 10),
    promptPreview: limitLongMemEvalPreview(prompt, longMemEvalLogPreviewCharLimit)
  });

  const answer = await callOpenAiCompatibleText({
    baseUrl: llm?.baseUrl ?? getContextEngineConfig().llm.baseUrl,
    model: llm?.model ?? getContextEngineConfig().llm.model,
    ...(llm?.apiKey || getContextEngineConfig().llm.apiKey ? { apiKey: llm?.apiKey ?? getContextEngineConfig().llm.apiKey } : {}),
    prompt,
    disableReasoning: false,
    logger: input?.logger,
    ...(input?.signal ? { signal: input.signal } : {}),
    logContext: {
      stage: input?.stage ?? "answer",
      questionId: input?.questionId,
      questionType: input?.questionType,
      contextScopeId: input?.contextScopeId ?? context.contextScopeId,
      modelRunId: input?.modelRunId,
      storeNamespace: input?.storeNamespace,
      sampleIndex: input?.sampleIndex,
      sampleCount: input?.sampleCount,
      answerContextMode: answerContext.mode,
      ...(answerContext.pack ? { contextPackId: answerContext.pack.packId } : {}),
      contextSummaryPreview: input?.contextSummary ? limitLongMemEvalPreview(input.contextSummary, longMemEvalLogPreviewCharLimit) : undefined,
      promptPreview: limitLongMemEvalPreview(prompt, longMemEvalLogPreviewCharLimit)
    },
    ...(input?.observer ? { observer: input.observer } : {})
  });
  if (!answer.ok) {
    if (answer.reason.startsWith("retry_exhausted:")) {
      return {
        hypothesis: "",
        answerContext,
        ...(answerContext.pack ? { pack: answerContext.pack } : {}),
        prompt,
        rankedSessionIds,
        fallbackUsed: false,
        skipped: true,
        skipReason: answer.reason
      };
    }
    if (input?.allowLlmFallback === false) {
      throw new Error(`answer_fallback:${answer.reason}`);
    }
    return {
      hypothesis: fallbackHypothesis(answer.reason),
      answerContext,
      ...(answerContext.pack ? { pack: answerContext.pack } : {}),
      prompt,
      rankedSessionIds,
      fallbackUsed: true,
      fallbackReason: answer.reason
    };
  }
  return {
    hypothesis: answer.text,
    answerContext,
    ...(answerContext.pack ? { pack: answerContext.pack } : {}),
    prompt,
    rankedSessionIds,
    fallbackUsed: false
  };
}

async function withLongMemEvalContextRetry<T>(
  operation: (internalAttempt: number) => Promise<T>,
  input: {
    logger?: LongMemEvalLogger | undefined;
    questionId?: string | undefined;
    sampleIndex?: number | undefined;
    signal?: AbortSignal;
  }
) {
  for (let attempt = 1; attempt <= longMemEvalContextRetryAttempts; attempt += 1) {
    throwIfLongMemEvalCancelled(input.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      if (isLongMemEvalCancellation(error, input.signal)) throw error;
      if (!isTransientLongMemEvalContextError(error) || attempt === longMemEvalContextRetryAttempts) {
        throw error;
      }
      const fields = {
        operation: "longmemeval",
        stage: "answer_context",
        questionId: input.questionId,
        sampleIndex: input.sampleIndex,
        attempt,
        maxAttempts: longMemEvalContextRetryAttempts,
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error)
      };
      if (input.logger) input.logger.warn(fields, "longmemeval answer context transient failure; retrying");
      else console.warn("longmemeval answer context transient failure; retrying", fields);
      await delay(250 * attempt);
    }
  }
  throw new Error("longmemeval answer context retry exhausted");
}

function isTransientLongMemEvalContextError(error: unknown) {
  const value = error as { code?: unknown; name?: unknown } | undefined;
  const code = typeof value?.code === "string" ? value.code : "";
  const name = typeof value?.name === "string" ? value.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return /database (?:table )?is locked|database is busy|connection acquisition timed out/iu.test(message) ||
    /Neo\.TransientError|ServiceUnavailable|SessionExpired/iu.test(`${code} ${name}`);
}

function longMemEvalContextLimiter(repository: ContextEngineRepository) {
  const existing = longMemEvalContextLimiters.get(repository);
  if (existing) return existing;
  const limiter = createAsyncConcurrencyLimiter(longMemEvalAnswerContextConcurrency);
  longMemEvalContextLimiters.set(repository, limiter);
  return limiter;
}

function createAsyncConcurrencyLimiter(concurrency: number): AsyncConcurrencyLimiter {
  let active = 0;
  const waiting: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  return {
    async run<T>(operation: () => Promise<T>, signal?: AbortSignal) {
      throwIfLongMemEvalCancelled(signal);
      if (active >= concurrency) {
        await new Promise<void>((resolve, reject) => {
          const waiter: (typeof waiting)[number] = { resolve, reject, ...(signal ? { signal } : {}) };
          if (signal) {
            waiter.onAbort = () => {
              const index = waiting.indexOf(waiter);
              if (index >= 0) waiting.splice(index, 1);
              reject(new LongMemEvalCancelledError());
            };
            signal.addEventListener("abort", waiter.onAbort, { once: true });
          }
          waiting.push(waiter);
        });
      } else {
        active += 1;
      }
      try {
        throwIfLongMemEvalCancelled(signal);
        return await operation();
      } finally {
        let next = waiting.shift();
        while (next?.signal?.aborted) {
          next.signal.removeEventListener("abort", next.onAbort!);
          next.reject(new LongMemEvalCancelledError());
          next = waiting.shift();
        }
        if (next) {
          if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
          next.resolve();
        } else {
          active -= 1;
        }
      }
    }
  };
}

async function buildLongMemEvalAnswerContext(
  repository: ContextEngineRepository,
  context: SampleContext,
  mode: LongMemEvalAnswerContextMode | undefined,
  options: {
    tokenBudget?: number;
    trace?: LongMemEvalSampleTraceContext;
    stageAttempt?: number;
    internalAttempt?: number;
  } = {}
): Promise<LongMemEvalAnswerContext> {
  const answerContextMode = normalizeAnswerContextMode(mode);
  if (answerContextMode === "retrieval") {
    const retrievalContext = await traceLongMemEvalAnswerContextBoundary({
      ...(options.trace ? { trace: options.trace } : {}),
      stage: "retrieval",
      operation: "search",
      ...(options.stageAttempt !== undefined ? { stageAttempt: options.stageAttempt } : {}),
      ...(options.internalAttempt !== undefined ? { internalAttempt: options.internalAttempt } : {}),
      input: {
        query: longMemEvalAnswerContextQuery(context),
        mode: answerContextMode,
        tokenBudget: longMemEvalAnswerContextTokenBudget
      },
      links: { contextScopeId: context.contextScopeId },
      execute: () => buildRetrievalAnswerContext(repository, context)
    });
    await appendLongMemEvalSampleSummaryTrace(options.trace, "retrieval_candidates", {
      count: retrievalContext.retrievalCandidates?.length ?? retrievalContext.selectedItems.length,
      candidates: retrievalContext.retrievalCandidates ?? []
    });
    return retrievalContext;
  }

  const tokenBudget = normalizeLongMemEvalAnswerTokenBudget(options.tokenBudget);
  const shared = await traceLongMemEvalAnswerContextBoundary({
    ...(options.trace ? { trace: options.trace } : {}),
    stage: "retrieval",
    operation: "search",
    ...(options.stageAttempt !== undefined ? { stageAttempt: options.stageAttempt } : {}),
    ...(options.internalAttempt !== undefined ? { internalAttempt: options.internalAttempt } : {}),
    input: {
      query: longMemEvalAnswerContextQuery(context),
      mode: answerContextMode,
      tokenBudget
    },
    links: { contextScopeId: context.contextScopeId },
    execute: () => buildBenchmarkAnswerContext(repository, {
      questionId: context.questionId,
      question: context.question,
      questionType: context.questionType,
      tenantId: "local",
      principalId: "longmemeval",
      contextScopeId: context.contextScopeId,
      ...(context.questionDate ? {
        referenceTime: normalizeLongMemEvalDateTime(context.questionDate),
        displayReferenceTime: context.questionDate
      } : {}),
      modelRunId: context.modelRunId,
      storeNamespace: context.storeNamespace,
      allowedLayers: ["stm"],
      candidateLimit: longMemEvalAnswerCandidateLimit,
      evidenceLimit: longMemEvalAnswerEvidenceLimit,
      tokenBudget,
      includeInactive: true,
      factRetrieval: false,
      resolveSessionId: (source) => longMemEvalSessionIdForQuestion(source, context.questionId)
    })
  });
  const contextPack = await traceLongMemEvalAnswerContextBoundary({
    ...(options.trace ? { trace: options.trace } : {}),
    stage: "context_pack",
    operation: "assemble_context_pack",
    ...(options.stageAttempt !== undefined ? { stageAttempt: options.stageAttempt } : {}),
    ...(options.internalAttempt !== undefined ? { internalAttempt: options.internalAttempt } : {}),
    input: {
      question: context.question,
      questionType: context.questionType,
      ...(context.questionDate ? { questionDate: context.questionDate } : {}),
      tokenBudget,
      candidates: shared.evidenceCandidates
    },
    links: { contextScopeId: context.contextScopeId },
    execute: async () => {
      const candidates = shared.evidenceCandidates as LongMemEvalAnswerEvidenceCandidate[];
      const rejected: LongMemEvalAnswerEvidenceRejection[] = shared.rejected.map((item) => ({
        ...item,
        containsLiteralAnswer: containsLongMemEvalExpectedAnswer(
          candidates.find((candidate) => candidate.item.id === item.itemId)?.evidenceText ?? "",
          context.answer
        )
      }));
      const selectedCandidates = shared.selectedItems.flatMap((item) => {
        const candidate = candidates.find((entry) => entry.item.id === item.id);
        return candidate ? [candidate] : [];
      });
      const selection = { selectedCandidates, selected: shared.selected, rejected, usedTokens: shared.tokenBudget.used };
      const evidenceTrace: LongMemEvalAnswerEvidenceTrace = {
        retrievalCallCount: 1,
        retrievalLimit: longMemEvalAnswerCandidateLimit,
        retrievedItemIds: shared.candidates.map((item) => item.id),
        eligibleCandidateItemIds: candidates.map((candidate) => candidate.item.id),
        candidates: candidates.map((candidate) => ({
          itemId: candidate.item.id,
          layer: candidate.item.layer,
          score: candidate.item.score,
          scoreBreakdown: candidate.scoreBreakdown,
          sourceSessionIds: candidate.sourceSessionIds,
          sourceRoles: candidate.sourceRoles,
          contentChars: candidate.evidenceText.length,
          estimatedTokens: candidate.estimatedTokens,
          temporal: candidate.temporal,
          relationTypes: uniqueStrings(candidate.relations.map((edge) => edge.relationType)) as RelationEdge["relationType"][]
        })),
        selected: shared.selected,
        rejected,
        renderedPromptHasTemporalMetadata: candidates.some((candidate) =>
          shared.selectedItems.some((item) => item.id === candidate.item.id) &&
          longMemEvalAnswerCandidateHasTemporalEvidence(candidate) &&
          [candidate.temporal.validTime, candidate.temporal.evidenceTime]
            .some((value) => value ? shared.serializedPrompt.includes(value) : false)
        )
      };
      evidenceTrace.failureClassification = await classifyLongMemEvalAnswerEvidenceFailure(
        repository,
        context,
        candidates,
        selectedCandidates,
        rejected,
        shared.serializedPrompt
      );
      return { selection, pack: shared.pack, evidenceTrace };
    }
  });
  await appendLongMemEvalSampleSummaryTrace(options.trace, "retrieval_candidates", {
    count: shared.candidates.length,
    candidates: shared.candidates
  });
  const selectedCandidates = contextPack.selection.selectedCandidates;
  const selectedFacts = uniqueFactsForLongMemEvalTrace(selectedCandidates.flatMap((candidate) => candidate.facts));
  await appendLongMemEvalSampleSummaryTrace(options.trace, "context_pack_facts", {
    contextPackId: contextPack.pack.packId,
    selectedCandidateCount: selectedCandidates.length,
    selectedFactCount: selectedFacts.length,
    selected: selectedCandidates.map((candidate) => ({
      candidateId: candidate.item.id,
      layer: candidate.item.layer,
      score: candidate.item.score,
      memoryIds: candidate.item.memoryIds,
      factIds: candidate.item.factIds,
      facts: candidate.facts,
      sourceSessionIds: candidate.sourceSessionIds,
      sourceRoles: candidate.sourceRoles
    })),
    facts: selectedFacts
  });
  return {
    mode: "context_pack",
    serializedPrompt: contextPack.pack.serializedPrompt,
    selectedItems: contextPack.selection.selectedCandidates.map(longMemEvalAnswerCandidateContextItem),
    dropped: contextPack.pack.dropped,
    tokenBudget: {
      requested: contextPack.pack.tokenBudget.requested,
      used: contextPack.pack.tokenBudget.used
    },
    evidenceTrace: contextPack.evidenceTrace,
    pack: contextPack.pack,
    retrievalCandidates: shared.candidates
  };
}

function uniqueFactsForLongMemEvalTrace(facts: FactItem[]) {
  const byId = new Map<string, FactItem>();
  for (const fact of facts) byId.set(fact.factId, fact);
  return [...byId.values()];
}

async function traceLongMemEvalAnswerContextBoundary<T>(input: {
  trace?: LongMemEvalSampleTraceContext;
  stage: "retrieval" | "context_pack";
  operation: "search" | "assemble_context_pack";
  stageAttempt?: number;
  internalAttempt?: number;
  input: unknown;
  links?: Record<string, unknown>;
  execute: () => Promise<T>;
}): Promise<T> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const stageExecutionId = `${input.stage}_${randomUUID()}`;
  await appendLongMemEvalTrace(input.trace, {
    stage: input.stage,
    operation: input.operation,
    stageExecutionId,
    status: "started",
    attempt: input.stageAttempt ?? 1,
    stageAttempt: input.stageAttempt ?? 1,
    ...(input.internalAttempt !== undefined ? { internalAttempt: input.internalAttempt } : {}),
    startedAt,
    input: input.input,
    ...(input.links ? { links: input.links } : {})
  });
  try {
    const output = await input.execute();
    await appendLongMemEvalTrace(input.trace, {
      stage: input.stage,
      operation: input.operation,
      stageExecutionId,
      status: "succeeded",
      attempt: input.stageAttempt ?? 1,
      stageAttempt: input.stageAttempt ?? 1,
      ...(input.internalAttempt !== undefined ? { internalAttempt: input.internalAttempt } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      input: input.input,
      output,
      ...(input.links ? { links: input.links } : {})
    });
    return output;
  } catch (error) {
    await appendLongMemEvalTrace(input.trace, {
      stage: input.stage,
      operation: input.operation,
      stageExecutionId,
      status: "failed",
      attempt: input.stageAttempt ?? 1,
      stageAttempt: input.stageAttempt ?? 1,
      ...(input.internalAttempt !== undefined ? { internalAttempt: input.internalAttempt } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      input: input.input,
      error: toLongMemEvalStructuredError(error),
      ...(input.links ? { links: input.links } : {})
    });
    throw error;
  }
}

async function searchAnswerMemoryCandidates(
  repository: ContextEngineRepository,
  context: SampleContext
): Promise<ContextSearchResponse> {
  const query = longMemEvalAnswerContextQuery(context);
  const search = await searchContext(
    repository,
    { ...query, layer: "stm", limit: longMemEvalAnswerCandidateLimit, offset: 0 },
    { recordRetrieval: false }
  );
  return {
    ...search,
    results: search.results
      .slice()
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, longMemEvalAnswerCandidateLimit)
  };
}

async function buildLongMemEvalAnswerEvidenceCandidates(
  repository: ContextEngineRepository,
  context: SampleContext,
  results: ContextSearchResult[]
): Promise<{
  candidates: LongMemEvalAnswerEvidenceCandidate[];
  rejected: LongMemEvalAnswerEvidenceRejection[];
}> {
  const factIds = uniqueStrings(results.flatMap((result) => result.factIds));
  const facts = await repository.getFactItemsByIds(factIds);
  const factById = new Map(facts.map((fact) => [fact.factId, fact]));
  const messageRowIds = uniqueStrings(facts.flatMap((fact) => fact.sourceMessageIds ?? []));
  const messageRoleById = new Map<string, LongMemEvalAnswerSourceRole>();
  if (messageRowIds.length) {
    for (const message of await repository.getConversationMessagesByRowIds(messageRowIds)) {
      const role = normalizeLongMemEvalSourceRole(message.role);
      messageRoleById.set(message.conversationMessageRowId, role);
      messageRoleById.set(message.messageId, role);
    }
  }

  const candidates: LongMemEvalAnswerEvidenceCandidate[] = [];
  const rejected: LongMemEvalAnswerEvidenceRejection[] = [];
  for (const result of results) {
    const searchItem = searchResultToContextItem(result);
    const itemFacts = searchItem.factIds
      .map((factId) => factById.get(factId))
      .filter((fact): fact is FactItem => Boolean(fact));
    const sourceRefs = uniqueLongMemEvalSourceRefs([
      ...searchItem.sourceRefs,
      ...itemFacts.flatMap((fact) => fact.linkedSourceRefs)
    ]);
    const temporal = mergeLongMemEvalAnswerTemporal(searchItem.temporal, itemFacts);
    const item: ContextPackItem = {
      ...searchItem,
      sourceRefs,
      sourceMessageIds: uniqueStrings([
        ...searchItem.sourceMessageIds,
        ...itemFacts.flatMap((fact) => fact.sourceMessageIds ?? [])
      ]),
      temporal
    };
    const evidenceText = buildLongMemEvalAnswerEvidenceText(item, itemFacts);
    const sourceRoles = inferLongMemEvalAnswerSourceRoles(sourceRefs, itemFacts, messageRoleById);
    const candidate: LongMemEvalAnswerEvidenceCandidate = {
      item,
      scoreBreakdown: result.scoreBreakdown,
      sourceSessionIds: uniqueStrings(sourceRefs.flatMap((source) => {
        const sessionId = longMemEvalSessionIdForQuestion(source, context.questionId);
        return sessionId ? [sessionId] : [];
      })),
      sourceRoles,
      temporal,
      relations: result.relationEdges.map((edge) => ({ ...edge })),
      facts: itemFacts,
      evidenceText,
      relevanceScore: scoreLongMemEvalAnswerCandidateRelevance(context.question, evidenceText),
      estimatedTokens: 0
    };
    candidate.estimatedTokens = estimateContextTokens(renderLongMemEvalAnswerEvidenceItem(candidate, 1));
    candidates.push(candidate);
  }
  return { candidates, rejected };
}

export async function selectLongMemEvalAnswerEvidenceFromSearch(
  repository: ContextEngineRepository,
  input: {
    question: string;
    questionType: string;
    search: ContextSearchResponse;
    answer?: string;
    questionDate?: string;
    questionId?: string;
    tokenBudget?: number;
  }
): Promise<LongMemEvalAnswerEvidenceSelection> {
  const questionId = input.questionId?.trim() || "external";
  const context: SampleContext = {
    sample: {},
    questionId,
    questionType: input.questionType,
    question: input.question,
    answer: input.answer ?? "",
    haystackSessionIds: [],
    contextScopeId: longMemEvalContextScopeId(questionId),
    modelRunId: "default",
    storeNamespace: "default",
    ...(input.questionDate ? { questionDate: input.questionDate } : {})
  };
  const tokenBudget = normalizeLongMemEvalAnswerTokenBudget(input.tokenBudget);
  const built = await buildLongMemEvalAnswerEvidenceCandidates(repository, context, input.search.results);
  const selection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: input.question,
    answer: input.answer ?? "",
    questionType: input.questionType,
    ...(input.questionDate ? { questionDate: input.questionDate } : {}),
    candidates: built.candidates,
    tokenBudget
  });
  return {
    candidates: built.candidates,
    selectedCandidates: selection.selectedCandidates,
    selected: selection.selected,
    rejected: [...built.rejected, ...selection.rejected],
    tokenBudget,
    usedTokens: selection.usedTokens
  };
}

export function buildLongMemEvalAnswerEvidenceText(item: ContextPackItem, facts: FactItem[]) {
  const sections: string[] = [];
  const seen = new Set<string>();
  const append = (value: string | undefined) => {
    const text = value?.trim();
    if (!text) return;
    const key = normalizeText(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    sections.push(text);
  };
  append(item.content);
  for (const fact of facts) append(fact.factText || fact.normalizedClaim);
  for (const fact of facts) append(fact.sourceClaim);
  return sections.join("\n");
}

function longMemEvalAnswerCandidateContextItem(candidate: LongMemEvalAnswerEvidenceCandidate): ContextPackItem {
  return {
    ...candidate.item,
    content: candidate.evidenceText,
    compressedContent: candidate.evidenceText
  };
}

function uniqueLongMemEvalSourceRefs(sourceRefs: SourceRef[]) {
  const byId = new Map<string, SourceRef>();
  for (const source of sourceRefs) {
    const key = source.sourceRefId || `${source.sourceType}:${source.sourceId}`;
    if (!byId.has(key)) byId.set(key, source);
  }
  return [...byId.values()];
}

function mergeLongMemEvalAnswerTemporal(
  temporal: ContextPackItem["temporal"],
  facts: FactItem[]
): LongMemEvalAnswerTemporal {
  const evidenceTime = temporal.evidenceTime ?? facts.find((fact) => fact.evidenceTime)?.evidenceTime;
  const validTime = temporal.validTime ?? facts.find((fact) => fact.validTime)?.validTime;
  const events = mergeLongMemEvalTemporalEvents([
    ...(temporal.events ?? []),
    ...facts.flatMap((fact) => fact.events ?? [])
  ]);
  return {
    ...(evidenceTime ? { evidenceTime } : {}),
    ...(validTime && events.length <= 1 ? { validTime } : {}),
    ...(events.length ? { events } : {})
  };
}

function mergeLongMemEvalTemporalEvents(
  events: NonNullable<ContextPackItem["temporal"]["events"]>
) {
  const byIdentity = new Map<string, NonNullable<ContextPackItem["temporal"]["events"]>[number]>();
  for (const event of events) byIdentity.set(`${event.eventKey}\u0000${event.validTime}`, event);
  return [...byIdentity.values()].sort((left, right) =>
    left.validTime.localeCompare(right.validTime) || left.eventKey.localeCompare(right.eventKey)
  );
}

export function selectLongMemEvalAnswerEvidenceWithinBudget(input: {
  question: string;
  answer: string;
  questionType: string;
  questionDate?: string;
  candidates: LongMemEvalAnswerEvidenceCandidate[];
  tokenBudget: number;
}) {
  const rejected: LongMemEvalAnswerEvidenceRejection[] = [];
  const deduped: LongMemEvalAnswerEvidenceCandidate[] = [];
  const duplicateIndexByKey = new Map<string, number>();
  for (const candidate of input.candidates) {
    const key = longMemEvalAnswerCandidateDuplicateKey(candidate);
    const existingIndex = duplicateIndexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = deduped[existingIndex]!;
      const keepCandidate = longMemEvalAnswerCandidateCompleteness(candidate) > longMemEvalAnswerCandidateCompleteness(existing);
      const duplicate = keepCandidate ? existing : candidate;
      rejected.push({
        itemId: duplicate.item.id,
        layer: duplicate.item.layer,
        reason: "duplicate",
        contentChars: duplicate.evidenceText.length,
        containsLiteralAnswer: containsLongMemEvalExpectedAnswer(duplicate.evidenceText, input.answer)
      });
      if (keepCandidate) deduped[existingIndex] = candidate;
      continue;
    }
    duplicateIndexByKey.set(key, deduped.length);
    deduped.push(candidate);
  }

  const ranked = deduped.slice().sort(compareLongMemEvalAnswerCandidatesByReranker);
  const coreCandidates = ranked.slice(0, longMemEvalAnswerBaselineCandidateCount);
  const completionCandidates = ranked.slice(
    longMemEvalAnswerBaselineCandidateCount,
    longMemEvalAnswerBaselineCandidateCount + longMemEvalAnswerCompletionCandidateCount
  );

  const fixedPromptTokens = estimateContextTokens(
    renderLongMemEvalAnswerContextHeader(input.questionType, input.question, input.questionDate)
  );
  let usedTokens = fixedPromptTokens;
  const selectedCandidates: LongMemEvalAnswerEvidenceCandidate[] = [];
  const selectInRankOrder = (candidates: LongMemEvalAnswerEvidenceCandidate[]) => {
    for (const candidate of candidates) {
      if (selectedCandidates.length >= longMemEvalAnswerEvidenceLimit) return;
      const renderedTokens = estimateContextTokens(renderLongMemEvalAnswerEvidenceItem(candidate, selectedCandidates.length + 1));
      if (usedTokens + renderedTokens > input.tokenBudget) {
        rejected.push({
          itemId: candidate.item.id,
          layer: candidate.item.layer,
          reason: "budget",
          contentChars: candidate.evidenceText.length,
          containsLiteralAnswer: containsLongMemEvalExpectedAnswer(candidate.evidenceText, input.answer)
        });
        continue;
      }
      selectedCandidates.push(candidate);
      usedTokens += renderedTokens;
    }
  };
  selectInRankOrder(coreCandidates);
  selectInRankOrder(completionCandidates);

  const consideredIds = new Set([
    ...selectedCandidates.map((candidate) => candidate.item.id),
    ...rejected.map((candidate) => candidate.itemId)
  ]);
  for (const candidate of ranked) {
    if (consideredIds.has(candidate.item.id)) continue;
    rejected.push({
      itemId: candidate.item.id,
      layer: candidate.item.layer,
      reason: "lower_priority",
      contentChars: candidate.evidenceText.length,
      containsLiteralAnswer: containsLongMemEvalExpectedAnswer(candidate.evidenceText, input.answer)
    });
  }

  usedTokens = estimateContextTokens(renderLongMemEvalAnswerContext(
    input.question,
    input.questionDate,
    selectedCandidates,
    "pack_budget_estimate_0000000000000000",
    input.questionType
  ));
  while (selectedCandidates.length && usedTokens > input.tokenBudget) {
    const candidate = selectedCandidates.pop()!;
    rejected.push({
      itemId: candidate.item.id,
      layer: candidate.item.layer,
      reason: "budget",
      contentChars: candidate.evidenceText.length,
      containsLiteralAnswer: containsLongMemEvalExpectedAnswer(candidate.evidenceText, input.answer)
    });
    usedTokens = estimateContextTokens(renderLongMemEvalAnswerContext(
      input.question,
      input.questionDate,
      selectedCandidates,
      "pack_budget_estimate_0000000000000000",
      input.questionType
    ));
  }

  const selected = assignLongMemEvalAnswerEvidenceRoles(selectedCandidates, input.questionType, input.question);
  return { selectedCandidates, selected, rejected, usedTokens };
}

function normalizeLongMemEvalAnswerTokenBudget(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return longMemEvalAnswerContextTokenBudget;
  return Math.min(100_000, Math.max(100, Math.floor(value)));
}

function normalizeLongMemEvalSourceRole(value: unknown): LongMemEvalAnswerSourceRole {
  if (value === "user" || value === "assistant" || value === "tool") return value;
  return "unknown";
}

function inferLongMemEvalAnswerSourceRoles(
  sourceRefs: SourceRef[],
  facts: FactItem[],
  messageRoleById: Map<string, LongMemEvalAnswerSourceRole>
): LongMemEvalAnswerSourceRole[] {
  const directRoles = uniqueStrings(facts.flatMap((fact) =>
    (fact.sourceMessageIds ?? []).flatMap((messageId) => {
      const role = messageRoleById.get(messageId);
      return role && role !== "unknown" ? [role] : [];
    })
  )) as LongMemEvalAnswerSourceRole[];
  if (directRoles.length) return directRoles;

  const metadataRoles = uniqueStrings(sourceRefs.flatMap((source) => {
    const role = normalizeLongMemEvalSourceRole(source.metadata?.role);
    return role === "unknown" ? [] : [role];
  })) as LongMemEvalAnswerSourceRole[];
  if (metadataRoles.length) return metadataRoles;

  const inferredRoles = uniqueStrings(facts.flatMap((fact) => {
    const factType = fact.factType.trim().toLowerCase();
    const text = `${fact.factText}\n${fact.sourceClaim ?? ""}`.trim().toLowerCase();
    if (
      factType.startsWith("assistant_") ||
      factType === "assistant_response" ||
      factType.includes("recommendation") ||
      /^(?:assistant|助手|助理)\s*[:：]/u.test(text)
    ) {
      return ["assistant"];
    }
    if (factType.startsWith("user_") || /^(?:user|用户)\s*[:：]/u.test(text)) return ["user"];
    return [];
  })) as LongMemEvalAnswerSourceRole[];
  return inferredRoles.length ? inferredRoles : ["unknown"];
}

function longMemEvalSessionIdForQuestion(source: SourceRef, questionId: string) {
  const metadataSessionId = source.metadata?.sessionId;
  if (typeof metadataSessionId === "string" && metadataSessionId.trim()) return metadataSessionId.trim();
  const prefix = `longmemeval_event_${questionId}_`;
  return source.sourceId.startsWith(prefix) ? source.sourceId.slice(prefix.length) : undefined;
}

function scoreLongMemEvalAnswerCandidateRelevance(question: string, evidenceText: string) {
  const queryTerms = extractLongMemEvalQueryTerms(question);
  if (!queryTerms.length) return 0;
  const normalizedQuestion = normalizeText(question);
  const normalized = normalizeText(evidenceText);
  const matchedTerms = queryTerms.filter((term) => normalized.includes(term));
  const phraseMatches = extractLongMemEvalQueryPhrases(queryTerms)
    .filter((phrase) => normalized.includes(phrase));
  const numericMatches = queryTerms.filter((term) => /\d/u.test(term) && normalized.includes(term));
  let entityOperandScore = 0;
  if (/\bage\b/u.test(normalizedQuestion)) {
    if (/\b(?:me|myself)\b/u.test(normalizedQuestion) && /\bi\b.{0,40}\b(?:am|turned)\b.{0,12}\b\d{1,3}\b/u.test(normalized)) {
      entityOperandScore += 12;
    }
    if (/\bparents?\b/u.test(normalizedQuestion) && /\b(?:mom|mother|dad|father)\b.{0,16}\b(?:is|was|aged?)\b.{0,8}\b\d{1,3}\b/u.test(normalized)) {
      entityOperandScore += 12;
    }
    if (/\bgrandparents?\b/u.test(normalizedQuestion) && /\b(?:grandma|grandmother|grandpa|grandfather)\b.{0,16}\b(?:is|was|aged?)\b.{0,8}\b\d{1,3}\b/u.test(normalized)) {
      entityOperandScore += 12;
    }
  }
  return matchedTerms.length * 2 + phraseMatches.length * 5 + numericMatches.length * 3 + entityOperandScore;
}

function longMemEvalAnswerCandidateIdentityIds(candidate: LongMemEvalAnswerEvidenceCandidate) {
  return uniqueStrings([candidate.item.id, ...candidate.item.memoryIds, ...candidate.item.factIds]);
}

function longMemEvalAnswerCandidateOwnsId(candidate: LongMemEvalAnswerEvidenceCandidate, id: string) {
  return longMemEvalAnswerCandidateIdentityIds(candidate).includes(id);
}

function longMemEvalAnswerCandidateDuplicateKey(candidate: LongMemEvalAnswerEvidenceCandidate) {
  if (candidate.item.factIds.length) return `facts:${[...candidate.item.factIds].sort().join("|")}`;
  return `content:${normalizeText(candidate.evidenceText)}`;
}

function longMemEvalAnswerCandidateCompleteness(candidate: LongMemEvalAnswerEvidenceCandidate) {
  const temporalFields = [
    candidate.temporal.validTime,
    candidate.temporal.evidenceTime
  ].filter(Boolean).length;
  const knownRoles = candidate.sourceRoles.filter((role) => role !== "unknown").length;
  return temporalFields * 20 + candidate.relations.length * 10 + knownRoles * 8 + candidate.sourceSessionIds.length * 5 +
    candidate.item.sourceRefs.length * 3 + Math.min(10, candidate.evidenceText.length / 200);
}

function renderLongMemEvalAnswerContextHeader(
  questionType: string,
  question: string,
  questionDate?: string,
  packId = "pending"
) {
  return [
    `【Context Pack】${packId}`,
    `【任务】${question}`,
    ...(questionDate?.trim() ? [`【问题时间】${questionDate.trim()}`] : []),
    "【答题证据】",
    ...(longMemEvalQuestionNeedsEventCountEvidence(questionType, question)
      ? ["【计数规则】先枚举符合问题时间范围的独立事件，再计数；不要把支持性事实、参数或同一事件的重复提及当作额外事件。"]
      : [])
  ].join("\n");
}

function renderLongMemEvalAnswerRelation(
  candidate: LongMemEvalAnswerEvidenceCandidate,
  edge: RelationEdge,
  itemIndexByIdentity?: Map<string, number>
) {
  const candidateIsFrom = longMemEvalAnswerCandidateOwnsId(candidate, edge.fromId);
  const counterpartId = candidateIsFrom ? edge.toId : edge.fromId;
  const counterpartIndex = itemIndexByIdentity?.get(counterpartId);
  const counterpart = counterpartIndex ? `[${counterpartIndex}]` : counterpartId;
  if (edge.relationType === "updates") {
    return candidateIsFrom ? `更新了 ${counterpart}` : `被 ${counterpart} 更新`;
  }
  if (edge.relationType === "conflicts_with") return `与 ${counterpart} 冲突`;
  if (edge.relationType === "is_same_as" || edge.relationType === "alias_of") return `与 ${counterpart} 表达同一事实`;
  if (edge.relationType === "supports") return candidateIsFrom ? `支持 ${counterpart}` : `被 ${counterpart} 支持`;
  if (edge.relationType === "derived_from") return candidateIsFrom ? `来源于 ${counterpart}` : `${counterpart} 来源于本条`;
  return `${edge.relationType} ${counterpart}`;
}

function renderLongMemEvalAnswerEvidenceItem(
  candidate: LongMemEvalAnswerEvidenceCandidate,
  index: number,
  itemIndexByIdentity?: Map<string, number>
) {
  const sourceRefs = uniqueStrings(candidate.item.sourceRefs.map((source) => `${source.sourceType}:${source.sourceId}`));
  const relations = uniqueStrings(candidate.relations.map((edge) =>
    renderLongMemEvalAnswerRelation(candidate, edge, itemIndexByIdentity)
  ));
  const sequencedFacts = candidate.facts
    .filter((fact) => fact.factSequence !== undefined)
    .map((fact) => {
      const sessionId = fact.sessionId ?? candidate.sourceSessionIds[0] ?? "未知";
      return `  - Session ${sessionId}, factSequence ${fact.factSequence}: ${fact.factText || fact.normalizedClaim}`;
    });
  return [
    `- [${index}] item:${candidate.item.id}`,
    candidate.evidenceText,
    ...(sequencedFacts.length ? ["  事实抽取顺序：", ...sequencedFacts] : []),
    `  事实发生时间：${candidate.temporal.validTime ?? "未提供"}`,
    ...(candidate.temporal.events?.length
      ? [`  事件时间映射：${candidate.temporal.events.map((event) => `${event.eventKey} | ${event.label} | ${event.validTime}`).join("；")}`]
      : []),
    `  消息发送时间：${candidate.temporal.evidenceTime ?? "未提供"}`,
    `  来源角色：${candidate.sourceRoles.join(", ") || "unknown"}`,
    `  来源 Session：${candidate.sourceSessionIds.join(", ") || "未知"}`,
    `  来源引用：${sourceRefs.join(", ") || "无"}`,
    `  关系：${relations.join("；") || "无"}`
  ].join("\n");
}

export function renderLongMemEvalAnswerContext(
  question: string,
  questionDate: string | undefined,
  candidates: LongMemEvalAnswerEvidenceCandidate[],
  packId: string,
  questionType = "multi-session"
) {
  const itemIndexByIdentity = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    for (const id of longMemEvalAnswerCandidateIdentityIds(candidate)) itemIndexByIdentity.set(id, index + 1);
  });
  return [
    renderLongMemEvalAnswerContextHeader(questionType, question, questionDate, packId),
    ...(candidates.length
      ? candidates.map((candidate, index) => renderLongMemEvalAnswerEvidenceItem(candidate, index + 1, itemIndexByIdentity))
      : ["- 无"])
  ].join("\n");
}

function longMemEvalQuestionNeedsTemporalEvidence(questionType: string, question: string) {
  return questionType.includes("temporal") ||
    /\b(?:when|date|time|before|after|earlier|later|first|last|how long|ago|year|month|week|day)\b/iu.test(question);
}

function longMemEvalQuestionNeedsCalculationEvidence(questionType: string, question: string) {
  return questionType.includes("multi-session") &&
      /\b(?:how many|how much|total|sum|difference|cost|spent|amount|count|number|combined|altogether)\b/iu.test(question) ||
    /\b(?:how many|how much|total|sum|difference|combined|altogether)\b/iu.test(question);
}

function longMemEvalQuestionNeedsEventCountEvidence(questionType: string, question: string) {
  return questionType.includes("multi-session") &&
    (
      /\b(?:how often|times?|occasions?|instances?)\b/iu.test(question) ||
      /\bhow many\b.{0,80}\b(?:did|have|was|were)\s+i\b/iu.test(question) ||
      /\bnumber of\b.{0,40}\b(?:events?|visits?|trips?|purchases?|appointments?)\b/iu.test(question)
    );
}

function longMemEvalAnswerCandidateHasNumericEvidence(candidate: LongMemEvalAnswerEvidenceCandidate) {
  return /(?:\d[\d,.]*|[$€£¥]\s*\d)/u.test(candidate.evidenceText);
}

function longMemEvalAnswerCandidateHasTemporalEvidence(candidate: LongMemEvalAnswerEvidenceCandidate) {
  return Boolean(candidate.temporal.validTime || candidate.temporal.evidenceTime || candidate.temporal.events?.length);
}

function compareLongMemEvalAnswerCandidatesByReranker(
  left: LongMemEvalAnswerEvidenceCandidate,
  right: LongMemEvalAnswerEvidenceCandidate
) {
  const leftRerankerScore = left.scoreBreakdown.reranker;
  const rightRerankerScore = right.scoreBreakdown.reranker;
  if (leftRerankerScore !== undefined && rightRerankerScore !== undefined) {
    const rerankerOrder = rightRerankerScore - leftRerankerScore;
    if (rerankerOrder) return rerankerOrder;
  }
  return right.relevanceScore - left.relevanceScore ||
    (rightRerankerScore ?? right.item.score) - (leftRerankerScore ?? left.item.score) ||
    right.item.score - left.item.score ||
    left.item.id.localeCompare(right.item.id);
}

function assignLongMemEvalAnswerEvidenceRoles(
  candidates: LongMemEvalAnswerEvidenceCandidate[],
  questionType: string,
  question: string
): Array<{ itemId: string; reason: string; evidenceRole: LongMemEvalAnswerEvidenceRole }> {
  const temporalQuestion = longMemEvalQuestionNeedsTemporalEvidence(questionType, question);
  const calculationQuestion = longMemEvalQuestionNeedsCalculationEvidence(questionType, question);
  const temporalCandidates = candidates
    .filter(longMemEvalAnswerCandidateHasTemporalEvidence)
    .slice()
    .sort((left, right) => longMemEvalAnswerCandidateTime(left).localeCompare(longMemEvalAnswerCandidateTime(right)));
  const temporalStartId = temporalCandidates[0]?.item.id;
  const temporalEndId = temporalCandidates.length > 1 ? temporalCandidates.at(-1)?.item.id : undefined;

  return candidates.map((candidate) => {
    const updateEdge = candidate.relations.find((edge) => edge.relationType === "updates");
    if (updateEdge) {
      if (longMemEvalAnswerCandidateOwnsId(candidate, updateEdge.fromId)) {
        return { itemId: candidate.item.id, reason: "提供更新后的状态", evidenceRole: "new_state" };
      }
      if (longMemEvalAnswerCandidateOwnsId(candidate, updateEdge.toId)) {
        return { itemId: candidate.item.id, reason: "提供更新前的状态", evidenceRole: "old_state" };
      }
    }
    if (temporalQuestion && candidate.item.id === temporalStartId) {
      return { itemId: candidate.item.id, reason: "提供时间起点", evidenceRole: "temporal_start" };
    }
    if (temporalQuestion && candidate.item.id === temporalEndId) {
      return { itemId: candidate.item.id, reason: "提供时间终点", evidenceRole: "temporal_end" };
    }
    if (calculationQuestion && longMemEvalAnswerCandidateHasNumericEvidence(candidate)) {
      return { itemId: candidate.item.id, reason: "提供计算所需数值", evidenceRole: "calculation_operand" };
    }
    if (candidate.relevanceScore > 0) {
      return { itemId: candidate.item.id, reason: "与问题中的关键内容直接匹配", evidenceRole: "direct_answer" };
    }
    return { itemId: candidate.item.id, reason: "用于补充上下文或消除歧义", evidenceRole: "disambiguation" };
  });
}

function longMemEvalAnswerCandidateTime(candidate: LongMemEvalAnswerEvidenceCandidate) {
  return candidate.temporal.validTime ?? candidate.temporal.evidenceTime ?? "9999";
}

async function buildLongMemEvalAnswerContextPack(
  repository: ContextEngineRepository,
  context: SampleContext,
  search: ContextSearchResponse,
  selection: ReturnType<typeof selectLongMemEvalAnswerEvidenceWithinBudget>,
  rejected: LongMemEvalAnswerEvidenceRejection[],
  tokenBudget: number
): Promise<ContextPack> {
  const packId = `pack_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const traceId = `trace_${packId}`;
  const serializedPrompt = renderLongMemEvalAnswerContext(
    context.question,
    context.questionDate,
    selection.selectedCandidates,
    packId,
    context.questionType
  );
  const used = estimateContextTokens(serializedPrompt);
  const taskContext = selection.selectedCandidates.map(longMemEvalAnswerCandidateContextItem);
  const citations = buildLongMemEvalAnswerCitations(taskContext);
  const conflicts = buildLongMemEvalAnswerConflicts(selection.selectedCandidates);
  const dropped = [
    ...search.dropped.map((item) => ({ id: item.id, layer: item.layer, reason: `search:${item.reason}` })),
    ...rejected.map((item) => ({ id: item.itemId, ...(item.layer ? { layer: item.layer } : {}), reason: `selection:${item.reason}` }))
  ];
  const compressionSteps: ContextPack["compressionSteps"] = [
    ...selection.selectedCandidates.map((candidate) => ({
      id: candidate.item.id,
      layer: candidate.item.layer,
      action: "keep" as const,
      beforeTokens: estimateContextTokens(candidate.evidenceText),
      afterTokens: estimateContextTokens(candidate.evidenceText),
      reason: "selected_complete_evidence"
    })),
    ...rejected.map((item) => ({
      id: item.itemId,
      ...(item.layer ? { layer: item.layer } : {}),
      action: "drop" as const,
      beforeTokens: 0,
      afterTokens: 0,
      reason: item.reason
    }))
  ];
  const allocations: ContextPackTrace["tokenUsage"] = {
    profile: 0,
    task: used,
    recent: 0,
    constraints: 0,
    citations: 0,
    conflicts: 0,
    total: used
  };
  const pack: ContextPack = {
    packId,
    task: context.question,
    scope: {
      questionId: context.questionId,
      contextScopeId: context.contextScopeId,
      modelRunId: context.modelRunId,
      storeNamespace: context.storeNamespace
    },
    temporal: search.temporal,
    serializedPrompt,
    profileContext: [],
    taskContext,
    recentContext: [],
    constraints: [],
    citations,
    conflicts,
    tokenBudget: {
      requested: tokenBudget,
      used,
      allocations,
      plan: {
        profileContext: 0,
        taskContext: tokenBudget,
        recentContext: 0,
        constraints: 0,
        citations: 0,
        conflicts: 0,
        reservedForCritical: 0
      }
    },
    compressionSteps,
    dropped,
    traceId
  };
  const trace: ContextPackTrace = {
    traceId,
    packId,
    task: context.question,
    finalScore: taskContext.length
      ? taskContext.reduce((sum, item) => sum + item.score, 0) / taskContext.length
      : 0,
    tokenBudget,
    tokenUsage: allocations,
    selectedItemIds: taskContext.map((item) => item.id),
    droppedReasons: dropped.map((item) => `${item.id}:${item.reason}`),
    compressionSteps,
    temporal: search.trace,
    createdAt: new Date().toISOString()
  };
  try {
    await repository.saveContextPackTrace(trace);
  } catch {
    // Context diagnostics must not prevent the answer request.
  }
  return pack;
}

function buildLongMemEvalAnswerCitations(items: ContextPackItem[]): ContextPack["citations"] {
  const citations = new Map<string, ContextPack["citations"][number]>();
  for (const item of items) {
    for (const source of item.sourceRefs) {
      const existing = citations.get(source.sourceRefId);
      if (existing) {
        if (!existing.itemIds.includes(item.id)) existing.itemIds.push(item.id);
        continue;
      }
      citations.set(source.sourceRefId, {
        sourceRefId: source.sourceRefId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        itemIds: [item.id]
      });
    }
  }
  return [...citations.values()];
}

function buildLongMemEvalAnswerConflicts(
  candidates: LongMemEvalAnswerEvidenceCandidate[]
): ContextPack["conflicts"] {
  const conflicts = new Map<string, ContextPack["conflicts"][number]>();
  for (const candidate of candidates) {
    for (const edge of candidate.relations.filter((relation) => relation.relationType === "conflicts_with")) {
      const existing = conflicts.get(edge.edgeId);
      if (existing) {
        if (!existing.itemIds.includes(candidate.item.id)) existing.itemIds.push(candidate.item.id);
        continue;
      }
      conflicts.set(edge.edgeId, {
        kind: "graph",
        edgeId: edge.edgeId,
        fromId: edge.fromId,
        toId: edge.toId,
        ...(edge.evidence ? { evidence: edge.evidence } : {}),
        factIds: [...candidate.item.factIds],
        sourceRefs: [...candidate.item.sourceRefs],
        itemIds: [candidate.item.id]
      });
    }
  }
  return [...conflicts.values()];
}

function buildLongMemEvalAnswerEvidenceTrace(
  search: ContextSearchResponse,
  candidates: LongMemEvalAnswerEvidenceCandidate[],
  selection: ReturnType<typeof selectLongMemEvalAnswerEvidenceWithinBudget>,
  rejected: LongMemEvalAnswerEvidenceRejection[],
  serializedPrompt: string
): LongMemEvalAnswerEvidenceTrace {
  return {
    retrievalCallCount: 1,
    retrievalLimit: longMemEvalAnswerCandidateLimit,
    retrievedItemIds: search.results.map((result) => result.id),
    eligibleCandidateItemIds: candidates.map((candidate) => candidate.item.id),
    candidates: candidates.map((candidate) => ({
      itemId: candidate.item.id,
      layer: candidate.item.layer,
      score: candidate.item.score,
      scoreBreakdown: candidate.scoreBreakdown,
      sourceSessionIds: candidate.sourceSessionIds,
      sourceRoles: candidate.sourceRoles,
      contentChars: candidate.evidenceText.length,
      estimatedTokens: candidate.estimatedTokens,
      temporal: candidate.temporal,
      relationTypes: uniqueStrings(candidate.relations.map((edge) => edge.relationType)) as RelationEdge["relationType"][]
    })),
    selected: selection.selected,
    rejected,
    renderedPromptHasTemporalMetadata: selection.selectedCandidates.some((candidate) =>
      longMemEvalAnswerCandidateHasTemporalEvidence(candidate) &&
      [
        candidate.temporal.validTime,
        candidate.temporal.evidenceTime
      ].some((value) => value ? serializedPrompt.includes(value) : false)
    )
  };
}

async function classifyLongMemEvalAnswerEvidenceFailure(
  repository: ContextEngineRepository,
  context: SampleContext,
  candidates: LongMemEvalAnswerEvidenceCandidate[],
  selectedCandidates: LongMemEvalAnswerEvidenceCandidate[],
  rejected: LongMemEvalAnswerEvidenceRejection[],
  serializedPrompt: string
): Promise<NonNullable<LongMemEvalAnswerEvidenceTrace["failureClassification"]>> {
  try {
    const selectedMatch = selectedCandidates.find((candidate) =>
      containsLongMemEvalExpectedAnswer(candidate.evidenceText, context.answer)
    );
    if (selectedMatch) {
      return containsLongMemEvalExpectedAnswer(serializedPrompt, context.answer)
        ? { stage: "prompt_ready", basis: "literal_answer_match" }
        : { stage: "rendering_missing", basis: "literal_answer_match", detail: selectedMatch.item.id };
    }

    const rejectedMatch = rejected.find((item) => item.containsLiteralAnswer);
    if (rejectedMatch?.reason === "budget") {
      return { stage: "budget_rejected", basis: "literal_answer_match", detail: rejectedMatch.itemId };
    }
    if (rejectedMatch) {
      return { stage: "not_selected", basis: "literal_answer_match", detail: `${rejectedMatch.itemId}:${rejectedMatch.reason}` };
    }
    if (candidates.some((candidate) => containsLongMemEvalExpectedAnswer(candidate.evidenceText, context.answer))) {
      return { stage: "not_selected", basis: "literal_answer_match" };
    }

    const owners = await repository.findMemoryOwnersByContextScopeId(
      longMemEvalContextScopeId(context.questionId),
      ["stm"]
    );
    const stmIds = owners.filter((owner) => owner.ownerType === "stm").map((owner) => owner.ownerId);
    const shortTermMemories = await repository.getShortTermMemoriesByIds(stmIds);
    const factIds = uniqueStrings(shortTermMemories.flatMap((memory) => memory.sourceFactIds));
    const facts = await repository.getFactItemsByIds(factIds);
    const storedTexts = [
      ...shortTermMemories.flatMap((memory) => [memory.content, memory.factSummary ?? "", memory.summary ?? ""]),
      ...facts.flatMap((fact) => [fact.factText, fact.sourceClaim ?? "", fact.normalizedClaim])
    ];
    return storedTexts.some((text) => containsLongMemEvalExpectedAnswer(text, context.answer))
      ? { stage: "not_in_top_100", basis: "literal_answer_match" }
      : { stage: "memory_not_generated", basis: "literal_answer_match" };
  } catch (error) {
    return {
      stage: "diagnostic_error",
      basis: "structural",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function containsLongMemEvalExpectedAnswer(text: string, answer: string) {
  return containsAnswer(text, answer);
}

async function buildRetrievalAnswerContext(
  repository: ContextEngineRepository,
  context: SampleContext
): Promise<LongMemEvalAnswerContext> {
  const query = longMemEvalAnswerContextQuery(context);
  const search = await searchContext(
    repository,
    { ...query, layer: "stm", limit: longMemEvalRetrievalCompatibilityLimit, offset: 0 },
    { recordRetrieval: false }
  );
  const selectedItems = search.results
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, longMemEvalRetrievalCompatibilityLimit)
    .map(searchResultToContextItem);
  const dropped = search.dropped;
  const serializedPrompt = renderRetrievalResultsPrompt(context.question, selectedItems);
  return {
    mode: "retrieval",
    serializedPrompt,
    selectedItems,
    dropped,
    tokenBudget: {
      requested: longMemEvalAnswerContextTokenBudget,
      used: estimateContextTokens(serializedPrompt)
    },
    retrievalCandidates: search.results
  };
}

function longMemEvalAnswerContextQuery(context: SampleContext): Omit<ContextQuery, "layer"> {
  return {
    q: context.question,
    tenantId: "local",
    principalId: "longmemeval",
    contextScopeId: context.contextScopeId,
    ...(context.questionDate ? { referenceTime: normalizeLongMemEvalDateTime(context.questionDate) } : {}),
    includeInactive: true,
    limit: longMemEvalAnswerCandidateLimit,
    offset: 0
  };
}

function longMemEvalSampleContext(sample: LongMemEvalSample): SampleContext {
  const questionDate = readQuestionDate(sample);
  return {
    sample,
    questionId: readQuestionId(sample),
    questionType: readQuestionType(sample),
    question: readQuestion(sample),
    answer: readAnswer(sample),
    haystackSessionIds: toStringArray(sample.haystack_session_ids),
    contextScopeId: longMemEvalContextScopeId(readQuestionId(sample)),
    modelRunId: "default",
    storeNamespace: "default",
    ...(questionDate ? { questionDate } : {})
  };
}

function normalizeAnswerContextMode(mode: LongMemEvalAnswerContextMode | undefined): LongMemEvalAnswerContextMode {
  return mode === "retrieval" ? "retrieval" : "context_pack";
}

function searchResultToContextItem(result: ContextSearchResult): ContextPackItem {
  return {
    id: result.id,
    layer: result.layer,
    content: result.content,
    compressedContent: result.content,
    score: result.score,
    sourceRefs: result.sourceRefs,
    sourceMessageIds: result.sourceRefs.flatMap((source) => {
      const messageId = source.metadata?.messageId;
      return source.sourceType === "conversation_message" && typeof messageId === "string"
        ? [messageId]
        : [];
    }),
    factIds: result.factIds,
    memoryIds: result.memoryIds,
    factContext: result.factContext,
    temporal: result.temporal
  };
}

function renderRetrievalResultsPrompt(task: string, items: ContextPackItem[]) {
  const header = [`【Retrieval Results】`, `【任务】${task}`];
  if (!items.length) return [...header, "【检索结果】\n- 无"].join("\n");
  return [
    ...header,
    "【检索结果】",
    ...items.map((item, index) => `- [${index + 1}] ${item.content}`)
  ].join("\n");
}

export function buildLongMemEvalAnswerPrompt(input: {
  question: string;
  questionDate?: string;
  serializedPrompt: string;
  answer?: string;
}) {
  return [
    "Answer the question using the provided Context Pack.",
    `Question: ${input.question}`,
    ...(input.questionDate?.trim() ? [`Question Date: ${input.questionDate.trim()}`] : []),
    "Read the Context Pack carefully and understand the meaning of each fact and field:",
    "- content / factText: the content of the fact and the primary evidence for answering the question.",
    "- entity: the specific person, object, place, or concept involved in the fact. Do not treat different entities as the same merely because their names are similar.",
    "- event: the event described by the fact and, when available, its status or related details.",
    "- validTime: the time when the fact was true or the event occurred.",
    "- evidenceTime: the time when the fact was recorded, observed, or stated.",
    "- factSequence: the one-based extraction order of a fact within its source Session. A larger value means the fact appeared later in that same Session; values from different Sessions are not directly comparable.",
    "- source / sourceMessageIds: where the fact came from. Use this to understand the provenance of the evidence and, when timestamps are available, its chronological context.",
    "- relationship: the relationship between facts, entities, or events. Use it when reasoning across multiple facts.",
    "- factId, memoryId, and other IDs: reference identifiers only, not factual content. Do not use them as the answer itself.",
    "Prefer direct evidence about the required subject and action. Use related facts and paraphrases without inventing or overstating what happened; treat them only as supporting context.",
    
    "When the question involves numbers, amounts, counts, dates, durations, averages, differences, or other calculations, use all relevant facts and calculate accurately.",
    "Use the following general examples only to understand the reasoning method. Their entities, values, and answers are illustrative and are never evidence for the current question:",
    "- Deduplicated sum: one Session says a repair cost $30 and new lights cost $20, while another Session repeats the same $20 lights purchase. Count the repeated purchase once: $30 + $20 = $50, not $70.",
    "- Counting events in compound statements: one fact says the user attended dinners at Alex's place and at Blake's place, and another fact says the user attended dinner at Casey's place. These are three distinct attended dinners, even though two appear in one sentence.",
    "- Counting distinct entities rather than actions: the user cleaned and serviced the same road bike, then planned to service a commuter bike. For a question asking how many bikes were serviced or planned for service, the answer is two bikes, not three actions.",
    "- Subject and action-state filtering: if the question asks what the user has actually used, count only facts that state the user used, made, served, or otherwise completed the relevant action. Do not count ingredients that the assistant merely recommended, listed in a hypothetical recipe, or suggested for future experimentation. For example, if the user made cocktails with lime, orange, and lemon, while the assistant only suggested grapefruit and yuzu mixers, the count is three, not five.",
    "- Difference and duration: if a taxi costs $70 and a train costs $15, the savings are $70 - $15 = $55. If total tenure is 4 years 2 months and the prior role lasted 2 years 9 months, convert to months before subtracting: 50 - 33 = 17 months = 1 year 5 months.",
    "- Event-relative duration: if the user attended a baking class on March 20 and made a friend's birthday cake on April 10, then 'How many days ago did I attend the baking class when I made my friend's birthday cake?' uses the cake-making event as the reference point: April 10 - March 20 = 21 days, not the Question Date.",
    "- Insufficient operands: if the taxi price is known but the bus price is not present in the Context Pack, the savings cannot be determined. Do not import outside prices or guess the missing operand.",

    "For temporal reasoning, prefer validTime when it is available and consistent with the fact text. Otherwise, infer the event time from factText or sourceClaim together with that fact’s evidenceTime. Resolve relative expressions such as “today,” “yesterday,” “just got back,” “last week,” and “ago” against the fact’s evidenceTime, not the question date. Preserve the precision supported by the text, and do not automatically treat evidenceTime as the event time. A missing validTime alone is not insufficient evidence; answer “cannot be determined” only when no defensible inference provides the precision required by the question.",
    "For temporal reasoning, identify the events and their relationship before calculating. - For “between A and B,” use A and B as the temporal operands. - When “when,” “by the time,” “at the time,” or “since” makes B the reference event, calculate up to B, not the Question Date. - Use the Question Date only when the question is relative to the present and provides no other reference event.",
    "For counts, list, justify, and deduplicate qualifying items first in your internal reasoning, then put only the concise result in the final response.",
    "For an update, correction, replacement, latest-state, or current-state question, when facts concern the same entity and property within the same Session, prefer the fact with the larger factSequence unless explicit validTime, evidenceTime, or correction semantics show otherwise. Across different Sessions, determine recency from validTime, evidenceTime, and explicit relationships instead of comparing factSequence values, and treat the chronologically later applicable fact as the latest fact to prioritize when answering.",
    "Answer only based on information supported by the Context Pack. If the evidence is insufficient or ambiguous, say that the answer cannot be determined.",
    "Answer concisely.",
    `Context Pack:\n${input.serializedPrompt}`
  ].join("\n\n");
}

function selectedContextPackItems(pack: ContextPack) {
  return [
    ...pack.profileContext,
    ...pack.taskContext,
    ...pack.recentContext,
    ...pack.constraints
  ];
}

function summarizeAnswerContextForLog(answerContext: LongMemEvalAnswerContext) {
  const selected = answerContext.selectedItems;
  const evidenceTrace = answerContext.evidenceTrace;
  return {
    answerContextMode: answerContext.mode,
    ...(answerContext.pack ? { contextPackId: answerContext.pack.packId } : {}),
    tokenBudgetRequested: answerContext.tokenBudget.requested,
    tokenBudgetUsed: answerContext.tokenBudget.used,
    ...(answerContext.pack ? { tokenBudgetPlan: answerContext.pack.tokenBudget.plan } : {}),
    selectedItemIds: selected.map((item) => item.id),
    selectedMemoryIds: uniqueStrings(selected.flatMap((item) => item.memoryIds)),
    selectedFactIds: uniqueStrings(selected.flatMap((item) => item.factIds)),
    selectedSourceRefs: selected.flatMap((item) =>
      item.sourceRefs.map((source) => ({
        sourceRefId: source.sourceRefId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        itemId: item.id
      }))
    ),
    dropped: answerContext.dropped.slice(0, 20),
    ...(evidenceTrace
      ? {
          answerEvidenceRetrievalCallCount: evidenceTrace.retrievalCallCount,
          answerEvidenceRetrievalLimit: evidenceTrace.retrievalLimit,
          answerEvidenceRetrievedCount: evidenceTrace.retrievedItemIds.length,
          answerEvidenceEligibleCount: evidenceTrace.eligibleCandidateItemIds.length,
          answerEvidenceSelected: evidenceTrace.selected,
          answerEvidenceRejectedSummary: summarizeAnswerEvidenceRejectReasons(evidenceTrace.rejected),
          answerEvidenceRenderedPromptHasTemporalMetadata: evidenceTrace.renderedPromptHasTemporalMetadata,
          answerEvidenceFailureClassification: evidenceTrace.failureClassification
        }
      : {}),
    ...(answerContext.pack
      ? {
          compressionSteps: answerContext.pack.compressionSteps.slice(0, 20).map((step) => ({
            id: step.id,
            layer: step.layer,
            action: step.action,
            beforeTokens: step.beforeTokens,
            afterTokens: step.afterTokens,
            reason: step.reason
          }))
        }
      : {})
  };
}

function summarizeContextPackDiagnostic(pack: ContextPack) {
  const selected = selectedContextPackItems(pack);
  return {
    contextPackId: pack.packId,
    ...(pack.scope ? { scope: pack.scope } : {}),
    tokenBudget: pack.tokenBudget,
    selectedItemIds: selected.map((item) => item.id),
    selectedItems: selected.map((item) => ({
      id: item.id,
      layer: item.layer,
      score: item.score,
      contentChars: item.content.length,
      compressedChars: item.compressedContent.length,
      sourceIds: item.sourceRefs.map((source) => source.sourceId),
      factIds: item.factIds,
      memoryIds: item.memoryIds,
      temporal: item.temporal
    })),
    droppedSummary: summarizeDropReasons(pack.dropped),
    dropped: pack.dropped.slice(0, 50),
    compressionSteps: pack.compressionSteps.slice(0, 50)
  };
}

function summarizeAnswerContextDiagnostic(answerContext: LongMemEvalAnswerContext) {
  const selected = answerContext.selectedItems;
  const candidateById = new Map(answerContext.evidenceTrace?.candidates.map((candidate) => [candidate.itemId, candidate]) ?? []);
  return {
    mode: answerContext.mode,
    ...(answerContext.pack?.scope ? { scope: answerContext.pack.scope } : {}),
    tokenBudget: answerContext.tokenBudget,
    selectedItemIds: selected.map((item) => item.id),
    selectedItems: selected.map((item) => ({
      id: item.id,
      layer: item.layer,
      score: item.score,
      contentChars: item.content.length,
      compressedChars: item.compressedContent.length,
      sourceIds: item.sourceRefs.map((source) => source.sourceId),
      factIds: item.factIds,
      memoryIds: item.memoryIds,
      temporal: item.temporal,
      sourceSessionIds: candidateById.get(item.id)?.sourceSessionIds ?? [],
      sourceRoles: candidateById.get(item.id)?.sourceRoles ?? [],
      relationTypes: candidateById.get(item.id)?.relationTypes ?? []
    })),
    droppedSummary: summarizeDropReasons(answerContext.dropped),
    dropped: answerContext.dropped.slice(0, 50),
    ...(answerContext.pack ? { contextPackId: answerContext.pack.packId } : {}),
    ...(answerContext.evidenceTrace ? { evidenceTrace: answerContext.evidenceTrace } : {})
  };
}

function summarizeAnswerEvidenceRejectReasons(rejected: LongMemEvalAnswerEvidenceRejection[]) {
  const summary: Record<string, number> = {};
  for (const item of rejected) summary[item.reason] = (summary[item.reason] ?? 0) + 1;
  return summary;
}

function summarizeDropReasons(dropped: LongMemEvalAnswerContext["dropped"]) {
  const summary: Record<string, number> = {};
  for (const item of dropped) {
    summary[item.reason] = (summary[item.reason] ?? 0) + 1;
  }
  return summary;
}

function pruneLongMemEvalRepositoryCache(repository: ContextEngineRepository, contextScopeId: string) {
  if (!(repository instanceof SqliteContextEngineRepository)) return;
  repository.evictLoadedCacheByContextScopeId(contextScopeId);
}

type LongMemEvalSampleFailureStage = "ingest" | "timeline_aggregation" | "ltm" | "answer" | "judge";

function longMemEvalSampleFailureReason(stage: LongMemEvalSampleFailureStage, error: unknown) {
  if (isLlmRequestRetryExhausted(error)) return `retry_exhausted:${error.message}`;
  const message = error instanceof Error ? error.message : String(error);
  return `sample_error:${stage}:${message}`;
}

function isLongMemEvalCancellation(error: unknown, signal: AbortSignal | undefined) {
  return signal?.aborted === true || error instanceof LongMemEvalCancelledError;
}

function logLongMemEvalSampleFailure(
  logger: LongMemEvalLogger | undefined,
  fields: {
    sampleIndex: number;
    sampleCount: number;
    questionId: string;
    questionType: string;
    failureStage: LongMemEvalSampleFailureStage;
    reason: string;
  },
  error: unknown
) {
  const payload = {
    operation: "longmemeval",
    ...fields,
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error
  };
  if (logger) logger.error(payload, "longmemeval sample failed and was skipped");
  else console.error("longmemeval sample failed and was skipped", payload);
}

function containsAnswer(text: string, answer: string) {
  const normalizedAnswer = normalizeText(answer);
  if (!normalizedAnswer) return false;
  return normalizeText(text).includes(normalizedAnswer);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function judgeHypothesis(
  hypothesis: string,
  context: SampleContext,
  judge: JudgeConfig,
  extraction?: LongMemEvalLlmOptions["extraction"],
  input?: {
    logger?: LongMemEvalLogger | undefined;
    questionId?: string;
    questionType?: string;
    contextScopeId?: string;
    modelRunId?: string;
    storeNamespace?: string;
    sampleIndex?: number;
    sampleCount?: number;
    stage?: string;
    allowLlmFallback?: boolean;
    observer?: OpenAiCompatibleRequestObserver;
    signal?: AbortSignal;
  }
): Promise<LongMemEvalJudgment> {
  const fallbackCorrect = exactMatchScore(context.answer, hypothesis);
  const apiKey = judge.apiKey ?? extraction?.apiKey ?? getContextEngineConfig().llm.apiKey;
  const prompt = buildJudgePrompt(context, hypothesis);
  logLongMemEvalRequest(input?.logger, {
    stage: input?.stage ?? "judge",
    questionId: input?.questionId,
    questionType: input?.questionType,
    contextScopeId: input?.contextScopeId ?? context.contextScopeId,
    modelRunId: input?.modelRunId,
    storeNamespace: input?.storeNamespace,
    sampleIndex: input?.sampleIndex,
    sampleCount: input?.sampleCount,
    endpoint: `${normalizeBaseUrl(judge.baseUrl || extraction?.baseUrl || getContextEngineConfig().llm.baseUrl)}/responses`,
    model: judge.model || extraction?.model || getContextEngineConfig().llm.model,
    disableReasoning: true,
    promptPreview: limitLongMemEvalPreview(prompt, longMemEvalLogPreviewCharLimit),
    hypothesisPreview: limitLongMemEvalPreview(hypothesis, longMemEvalLogPreviewCharLimit)
  });
  try {
    const response = await callOpenAiCompatibleText(
      {
        baseUrl: judge.baseUrl || extraction?.baseUrl || getContextEngineConfig().llm.baseUrl,
        model: judge.model || extraction?.model || getContextEngineConfig().llm.model,
        ...(apiKey ? { apiKey } : {}),
        prompt,
        disableReasoning: true,
        logger: input?.logger,
        ...(input?.observer ? { observer: input.observer } : {}),
        ...(input?.signal ? { signal: input.signal } : {}),
        logContext: {
          stage: input?.stage ?? "judge",
          questionId: input?.questionId,
          questionType: input?.questionType,
          contextScopeId: input?.contextScopeId ?? context.contextScopeId,
          modelRunId: input?.modelRunId,
          storeNamespace: input?.storeNamespace,
          sampleIndex: input?.sampleIndex,
          sampleCount: input?.sampleCount,
          promptPreview: limitLongMemEvalPreview(prompt, longMemEvalLogPreviewCharLimit),
          hypothesisPreview: limitLongMemEvalPreview(hypothesis, longMemEvalLogPreviewCharLimit)
        }
      }
    );
    if (!response.ok) {
      if (response.reason.startsWith("retry_exhausted:")) {
        return skippedJudgment(judge, response.reason);
      }
      if (input?.allowLlmFallback === false) {
        throw new Error(`judge_fallback:${response.reason}`);
      }
      return {
        label: fallbackCorrect ? "correct" : "incorrect",
        score: fallbackCorrect ? 1 : 0,
        reason: fallbackJudgeReason(context, hypothesis, fallbackCorrect, response.reason),
        model: judge.model || extraction?.model || getContextEngineConfig().llm.model,
        baseUrl: judge.baseUrl || extraction?.baseUrl || getContextEngineConfig().llm.baseUrl,
        raw: { fallbackReason: response.reason }
      };
    }
    const normalized = normalizeText(response.text);
    const label = normalized.startsWith("yes") || normalized.includes(" yes") ? "correct" : "incorrect";
    return {
      label,
      score: label === "correct" ? 1 : 0,
      reason: fallbackJudgeReason(context, hypothesis, label === "correct", response.text),
      model: judge.model || extraction?.model || getContextEngineConfig().llm.model,
      baseUrl: judge.baseUrl || extraction?.baseUrl || getContextEngineConfig().llm.baseUrl,
      raw: { text: response.text }
    };
  } catch (error) {
    if (input?.allowLlmFallback === false) throw error;
    return {
      label: fallbackCorrect ? "correct" : "incorrect",
      score: fallbackCorrect ? 1 : 0,
      reason: fallbackJudgeReason(context, hypothesis, fallbackCorrect, error instanceof Error ? error.message : undefined),
      model: judge.model || extraction?.model || getContextEngineConfig().llm.model,
      baseUrl: judge.baseUrl || extraction?.baseUrl || getContextEngineConfig().llm.baseUrl,
      raw: { fallbackReason: "judge_failure" }
    };
  }
}

async function callOpenAiCompatibleText(input: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  prompt: string;
  disableReasoning?: boolean;
  fetchImpl?: typeof fetch;
  logger?: LongMemEvalLogger | undefined;
  logContext?: Record<string, unknown>;
  observer?: OpenAiCompatibleRequestObserver;
  signal?: AbortSignal;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (!input.apiKey) return { ok: false, reason: "llm_api_key_missing" };
  const messages = [
    { role: "system", content: "Answer the question directly." },
    { role: "user", content: input.prompt }
  ];
  try {
    return await callLongMemEvalChatCompletionText(input, messages);
  } catch (error) {
    if (isLlmRequestRetryExhausted(error)) {
      return { ok: false, reason: `retry_exhausted:${error.message}` };
    }
    const reason = error instanceof Error ? error.message : "llm_request_failed";
    if (error instanceof Error && /timed out/i.test(error.message)) {
      const fields = {
        message: error.message,
        baseUrl: input.baseUrl,
        model: input.model,
        disableReasoning: input.disableReasoning === true,
        ...(input.logContext ?? {})
      };
      if (input.logger) {
        input.logger.warn(fields, "longmemeval LLM request timed out");
      } else {
        console.warn("longmemeval LLM request timed out", fields);
      }
    }
    return { ok: false, reason };
  }
}

async function callLongMemEvalChatCompletionText(
  input: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
    observer?: OpenAiCompatibleRequestObserver;
    signal?: AbortSignal;
    operation?: string;
  },
  messages: Array<{ role: string; content: string }>
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const parsed = await postOpenAiCompatibleJson({
    endpoint: `${normalizeBaseUrl(input.baseUrl)}/chat/completions`,
    apiKey: input.apiKey!,
    operation: input.operation ?? "longmemeval",
    transport: "openai-sdk-stream",
    body: {
      model: input.model,
      messages,
      temperature: 0
    },
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.observer ? { observer: input.observer } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  }) as { choices?: Array<{ message?: { content?: string } }> };
  const text = parsed.choices?.[0]?.message?.content?.trim();
  return text ? { ok: true, text } : { ok: false, reason: "llm_empty_response" };
}

function extractResponseText(payload: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }) {
  const texts: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("").trim();
}

function buildSessionDocuments(samples: LongMemEvalSample[]): LongMemEvalSessionDocument[] {
  const sessions: LongMemEvalSessionDocument[] = [];
  const seenSessionIds = new Set<string>();
  for (const [sampleIndex, sample] of samples.entries()) {
    const questionId = readQuestionId(sample);
    const questionDate = readQuestionDate(sample) ?? new Date().toISOString();
    const haystackSessionIds = toStringArray(sample.haystack_session_ids);
    const haystackSessions = Array.isArray(sample.haystack_sessions) ? sample.haystack_sessions : [];
    for (let i = 0; i < haystackSessionIds.length; i += 1) {
      const sessionId = haystackSessionIds[i]!;
      if (seenSessionIds.has(sessionId)) continue;
      seenSessionIds.add(sessionId);
      const turns = readSessionTurns(haystackSessions[i]);
      const transcript = flattenSessionTranscript(turns);
      if (!transcript.trim()) continue;
      const sessionDate = readSampleSessionDate(sample, i) ?? questionDate;
      sessions.push({
        sessionId,
        questionId,
        content: transcript,
        turns,
        eventTime: sessionDate,
        evidenceTime: normalizeLongMemEvalDateTime(sessionDate),
        sessionIndex: i,
        sampleIndex,
        sampleSessionIndex: i,
        sampleSessionCount: haystackSessionIds.length
      });
    }
  }
  return sessions.sort((left, right) => {
    const byQuestion = left.questionId.localeCompare(right.questionId);
    if (byQuestion !== 0) return byQuestion;
    const byTime = left.eventTime.localeCompare(right.eventTime);
    if (byTime !== 0) return byTime;
    return left.sessionIndex - right.sessionIndex;
  });
}

function countLongMemEvalSessionAttempts(samples: LongMemEvalSample[]) {
  return samples.reduce((total, sample) => total + buildSessionDocuments([sample]).length, 0);
}

function buildSampleTimelineMemoryIds(sample: LongMemEvalSample) {
  return buildSessionDocuments([sample]).map((session) => `stm_${makeSampleSessionEvent(sample, session).eventId}`);
}

export async function runDreamingInBatches(
  repository: ContextEngineRepository,
  extraction?: LlmFactFusionOptions,
  input?: {
    logger?: LongMemEvalLogger | undefined;
    questionId?: string;
    questionType?: string;
    sampleIndex?: number;
    sampleCount?: number;
    stage?: string;
    timelineSummary?: string;
    sourceMemoryDataIds?: string[];
    onBatchProgress?: (progress: DreamBatchProgress) => void;
  }
): Promise<DreamBatchResult> {
  const hasSourceFilter = input?.sourceMemoryDataIds !== undefined;
  const allowedSourceMemoryDataIds = new Set(
    (input?.sourceMemoryDataIds ?? []).map((item) => item.trim()).filter(Boolean)
  );
  const sourceCandidates = hasSourceFilter
    ? (await Promise.all([...allowedSourceMemoryDataIds].map((memoryDataId) => repository.getShortTermMemory(memoryDataId))))
      .filter((memory): memory is ShortTermMemory => Boolean(memory))
    : repository.getDebugSnapshot().shortTermMemories;
  const candidates = sourceCandidates.filter((memory) => {
    if (
      memory.lifecycleStatus !== "active" &&
      memory.lifecycleStatus !== "expired" &&
      memory.lifecycleStatus !== "candidate_queue"
    ) {
      return false;
    }
    if (!hasSourceFilter) return true;
    return allowedSourceMemoryDataIds.has(memory.memoryDataId);
  });
  const batches = chunkDreamingCandidates(candidates, 6000);
  let dreamed = 0;
  let totalBatches = 0;

  for (const batch of batches) {
    totalBatches += 1;
    input?.onBatchProgress?.({
      batchIndex: totalBatches,
      batchCount: batches.length,
      batchCandidates: batch.length,
      totalCandidates: candidates.length,
      totalDreamed: dreamed
    });
    logLongMemEvalRequest(input?.logger, {
      stage: input?.stage ?? "ltm",
      questionId: input?.questionId,
      questionType: input?.questionType,
      sampleIndex: input?.sampleIndex,
      sampleCount: input?.sampleCount,
      endpoint: `${normalizeBaseUrl(extraction?.baseUrl ?? getContextEngineConfig().llm.baseUrl)}/chat/completions`,
      model: extraction?.model ?? getContextEngineConfig().llm.model,
      disableReasoning: false,
      sourceMemoryDataIds: input?.sourceMemoryDataIds ?? batch.map((candidate) => candidate.memoryDataId),
      timelineSummaryPreview: input?.timelineSummary ? limitLongMemEvalPreview(input.timelineSummary, longMemEvalLogPreviewCharLimit) : undefined,
      promptPreview: limitLongMemEvalPreview(batch.map((candidate) => candidate.content).join("\n\n"), longMemEvalLogPreviewCharLimit)
    });
    const result = await runLlmDreaming(repository, {
      ...(extraction ? { ...extraction } : {}),
      memoryDataIds: batch.map((candidate) => candidate.memoryDataId)
    });
    dreamed += result.longTermMemories.length;
    input?.onBatchProgress?.({
      batchIndex: totalBatches,
      batchCount: batches.length,
      batchCandidates: batch.length,
      totalCandidates: candidates.length,
      totalDreamed: dreamed
    });
  }

  return {
    totalBatches,
    totalCandidates: candidates.length,
    totalDreamed: dreamed
  };
}

function chunkDreamingCandidates(
  candidates: ShortTermMemory[],
  maxTokens: number
): ShortTermMemory[][] {
  const batches: ShortTermMemory[][] = [];
  let current: ShortTermMemory[] = [];
  let currentTokens = 0;

  for (const candidate of candidates) {
    const tokenCost = estimateDreamingTokens(candidate);
    if (current.length && currentTokens + tokenCost > maxTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(candidate);
    currentTokens += tokenCost;
  }

  if (current.length) batches.push(current);
  return batches;
}

function estimateDreamingTokens(candidate: ShortTermMemory) {
  const fields = [
    candidate.memoryDataId,
    candidate.memoryDataType,
    candidate.summary ?? "",
    candidate.content,
    candidate.admissionReason,
    candidate.matchedRules.join(" "),
    candidate.sourceFactIds.join(" "),
    candidate.entityIds.join(" ")
  ];
  return fields.reduce((sum, value) => sum + Math.max(1, Math.ceil(value.trim().split(/\s+/).filter(Boolean).length * 1.3)), 0);
}

function readSessionTurns(session: unknown): LongMemEvalSessionTurn[] {
  if (!Array.isArray(session)) return [];
  return session
    .map((turn) => {
      if (!turn || typeof turn !== "object") return undefined;
      const role = typeof (turn as { role?: unknown }).role === "string" ? (turn as { role: string }).role : "unknown";
      const content = typeof (turn as { content?: unknown }).content === "string" ? (turn as { content: string }).content : "";
      const line = `${role}: ${content}`.trim();
      if (!line) return undefined;
      return {
        role,
        content,
        line
      };
    })
    .filter((turn): turn is LongMemEvalSessionTurn => Boolean(turn));
}

function flattenSessionTranscript(turns: LongMemEvalSessionTurn[]): string {
  return turns
    .map((turn) => turn.line)
    .join("\n");
}

function buildJudgePrompt(context: SampleContext, hypothesis: string) {
  const questionType = context.questionType;
  const abstention = context.questionId.endsWith("_abs");
  const instructions: string[] = [
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. Reply with yes or no only."
  ];

  if (abstention) {
    instructions.push("This is an abstention question. The model is correct if it correctly identifies the question as unanswerable.");
  } else if (questionType === "temporal-reasoning") {
    instructions.push("Do not penalize off-by-one errors for the number of days, weeks, months, etc.");
  } else if (questionType === "knowledge-update") {
    instructions.push("If the response contains some previous information along with an updated answer, it should still be considered correct as long as the updated answer is the required answer.");
  } else if (questionType === "single-session-preference") {
    instructions.push("If the question is a preference rubric, answer yes if the response satisfies the desired response. The response does not need to reflect all points in the rubric.");
  } else {
    instructions.push("Accept equivalent wording and answers that include the required intermediate reasoning.");
  }

  instructions.push(
    `Question type: ${questionType}`,
    `Question: ${context.question}`,
    `Correct Answer: ${context.answer}`,
    `Model Response: ${hypothesis}`,
    "Is the model response correct? Answer yes or no only."
  );

  return instructions.join("\n\n");
}

async function loadLongMemEvalSamples(datasetPath: string): Promise<LongMemEvalSample[]> {
  const samples: LongMemEvalSample[] = [];
  for await (const sample of streamLongMemEvalSamples(datasetPath)) {
    samples.push(sample);
  }
  return samples;
}

async function* streamLongMemEvalSamples(datasetPath: string): AsyncGenerator<LongMemEvalSample> {
  const stream = createReadStream(datasetPath, { encoding: "utf8" });
  let current = "";
  let braceDepth = 0;
  let inString = false;
  let escaped = false;
  let arrayStarted = false;
  let objectStarted = false;

  for await (const chunk of stream) {
    for (const char of chunk as string) {
      if (!arrayStarted) {
        if (/\s/.test(char)) continue;
        if (char !== "[") throw new Error("LongMemEval dataset must be a JSON array");
        arrayStarted = true;
        continue;
      }

      if (!objectStarted) {
        if (/\s/.test(char) || char === ",") continue;
        if (char === "]") return;
        if (char !== "{") throw new Error(`LongMemEval dataset contains invalid top-level token: ${char}`);
        objectStarted = true;
        braceDepth = 1;
        current = char;
        inString = false;
        escaped = false;
        continue;
      }

      current += char;

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = inString;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === "{") {
        braceDepth += 1;
      } else if (char === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) {
          const parsed = JSON.parse(current);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("LongMemEval dataset sample must be a JSON object");
          }
          yield parsed as LongMemEvalSample;
          current = "";
          objectStarted = false;
        }
      }
    }
  }

  if (!arrayStarted) throw new Error("LongMemEval dataset must be a JSON array");
  if (objectStarted || current.trim()) throw new Error("LongMemEval dataset ended before the current sample object closed");
}

function resolveJudgeConfig(
  options: LongMemEvalLlmOptions | undefined,
  config = getContextEngineConfig()
): JudgeConfig {
  return {
    baseUrl: options?.judge?.baseUrl?.trim() || options?.extraction?.baseUrl?.trim() || config.llm.baseUrl,
    model: options?.judge?.model?.trim() || options?.extraction?.model?.trim() || config.llm.model,
    ...(options?.judge?.apiKey?.trim() || options?.extraction?.apiKey?.trim() || config.llm.apiKey
      ? { apiKey: options?.judge?.apiKey?.trim() || options?.extraction?.apiKey?.trim() || config.llm.apiKey }
      : {})
  };
}

function exactMatchScore(answer: string, hypothesis: string) {
  return normalizeText(hypothesis).includes(normalizeText(answer));
}

function fallbackHypothesis(reason: string) {
  return `[ANSWER_FAILED:${reason}]`;
}

function answerFailureJudgment(
  answerResult: { fallbackReason?: string },
  judge: JudgeConfig
): LongMemEvalJudgment {
  const reason = answerResult.fallbackReason ?? "answer_generation_failed";
  return {
    label: "incorrect",
    score: 0,
    reason: `answer_failed:${reason}`,
    model: judge.model,
    baseUrl: judge.baseUrl,
    raw: { fallbackReason: reason }
  };
}

function skippedJudgment(judge: JudgeConfig, reason?: string): LongMemEvalJudgment {
  return {
    label: "incorrect",
    score: 0,
    reason: `sample_skipped:${reason ?? "llm_retry_exhausted"}`,
    model: judge.model,
    baseUrl: judge.baseUrl,
    raw: { skipped: true, skipReason: reason ?? "llm_retry_exhausted" }
  };
}

function isSkippedJudgment(judgment: LongMemEvalJudgment) {
  return Boolean(
    judgment.raw &&
    typeof judgment.raw === "object" &&
    "skipped" in judgment.raw &&
    (judgment.raw as { skipped?: unknown }).skipped === true
  );
}

function readSkippedJudgmentReason(judgment: LongMemEvalJudgment) {
  if (!judgment.raw || typeof judgment.raw !== "object" || !("skipReason" in judgment.raw)) {
    return judgment.reason;
  }
  const reason = (judgment.raw as { skipReason?: unknown }).skipReason;
  return typeof reason === "string" && reason ? reason : judgment.reason;
}

function fallbackJudgeReason(context: SampleContext, hypothesis: string, correct: boolean, errorMessage?: string) {
  if (correct) return "exact_match";
  const answer = normalizeText(context.answer);
  const guessed = normalizeText(hypothesis);
  if (answer && guessed.includes(answer)) return "contains_answer";
  return errorMessage ? `judge_error:${errorMessage}` : "string_match";
}

function readQuestionDate(sample: LongMemEvalSample) {
  return typeof sample.question_date === "string" && sample.question_date.trim() ? sample.question_date.trim() : undefined;
}

function readSampleSessionDate(sample: LongMemEvalSample, index: number) {
  if (!Array.isArray(sample.haystack_dates)) return undefined;
  const value = sample.haystack_dates[index];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeLongMemEvalDateTime(value: string) {
  const normalized = value.trim().match(/^(\d{4})[/-](\d{2})[/-](\d{2})(?:\s+\([^)]+\))?(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (normalized) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = normalized;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))).toISOString();
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString();
}

function percent(current: number, total: number) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Number(((current / total) * 100).toFixed(1))));
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeLongMemEvalLlmRuns(runs: LongMemEvalLlmRunOptions[]) {
  const seen = new Set<string>();
  return runs
    .map((run, index) => {
      const fallbackId = run.label?.trim() || run.llm?.judge?.model?.trim() || run.llm?.extraction?.model?.trim() || `model_${index + 1}`;
      const baseRunId = sanitizeLongMemEvalRunId(run.runId?.trim() || fallbackId);
      const runId = uniqueLongMemEvalRunId(baseRunId, seen);
      seen.add(runId);
      return {
        runId,
        ...(run.label?.trim() ? { label: run.label.trim() } : {}),
        ...(run.llm ? { llm: run.llm } : {}),
        ...(run.diagnosticsPath?.trim() ? { diagnosticsPath: run.diagnosticsPath.trim() } : {}),
        ...(run.tracePath?.trim() ? { tracePath: run.tracePath.trim() } : {})
      };
    });
}

function normalizeModelConcurrency(value: number | undefined, runCount: number) {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return Math.min(4, Math.max(1, runCount));
  return Math.min(Math.floor(value), Math.max(1, runCount));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function mapWithConcurrencyUntilError<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length && firstError === undefined && signal?.aborted !== true) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

function resolveRunDiagnosticsPath(basePath: string | undefined, run: { runId: string; diagnosticsPath?: string }) {
  return resolveRunArtifactPath(basePath, run.diagnosticsPath, run.runId);
}

function resolveRunArtifactPath(basePath: string | undefined, overridePath: string | undefined, runId: string) {
  if (overridePath) return overridePath;
  if (!basePath?.trim()) return undefined;
  const normalized = basePath.trim();
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : "";
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dotIndex = filename.lastIndexOf(".");
  const safeRunId = sanitizeLongMemEvalRunId(runId);
  if (dotIndex <= 0) return `${directory}${filename}.${safeRunId}`;
  return `${directory}${filename.slice(0, dotIndex)}.${safeRunId}${filename.slice(dotIndex)}`;
}

function uniqueLongMemEvalRunId(baseRunId: string, seen: Set<string>) {
  let runId = baseRunId || "model";
  let suffix = 2;
  while (seen.has(runId)) {
    runId = `${baseRunId}_${suffix}`;
    suffix += 1;
  }
  return runId;
}

function sanitizeLongMemEvalRunId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "model";
}

async function buildSampleTimelineAggregation(repository: ContextEngineRepository, sample: LongMemEvalSample) {
  const event = makeSampleEvent(sample);
  const question = readQuestion(sample);
  const sampleSessions = buildSessionDocuments([sample]);
  const sampleEventIdList = sampleSessions.map((session) => makeSampleSessionEvent(sample, session).eventId);
  const sampleEventIds = new Set(sampleEventIdList);
  const questionId = readQuestionId(sample);
  const sampleSourceIds = new Set(sampleSessions.map((session) =>
    longMemEvalSessionSourceId(questionId, session.sessionId)
  ));
  const [factsByEvent, sessionEvents] = await Promise.all([
    repository.findFactItemsByEventIds(sampleEventIdList),
    repository.getMemoryEventsByIds(sampleEventIdList)
  ]);
  const facts = factsByEvent.filter((fact) =>
    fact.linkedEventIds.some((eventId) => sampleEventIds.has(eventId)) ||
    fact.linkedSourceRefs.some((ref) => sampleSourceIds.has(ref.sourceId))
  );
  const aggregatedFacts = facts.length
    ? buildSessionLocalTimelineAggregatedFacts(facts, sampleEventIds)
    : buildTimelineFactsFromSessionEvents(sessionEvents, question);
  const related = aggregatedFacts.filter((item) =>
    item.sourceEventIds.some((eventId) => sampleEventIds.has(eventId)) ||
    item.sourceRefs.some((ref) => sampleSourceIds.has(ref.sourceId))
  );
  const summary = summarizeLongMemEvalTimelineEvidence(question, related.length ? related : aggregatedFacts, event);
  return { event, facts, aggregatedFacts, related, summary };
}

function buildSessionLocalTimelineAggregatedFacts(facts: FactItem[], sampleEventIds: Set<string>) {
  return [...sampleEventIds]
    .sort()
    .flatMap((eventId) => buildTimelineAggregatedFacts(
      facts.filter((fact) => fact.linkedEventIds.includes(eventId))
    ));
}

function buildSampleTimelineAggregationFromDataset(sample: LongMemEvalSample) {
  const event = makeSampleEvent(sample);
  const question = readQuestion(sample);
  const sessionEvents = buildSessionDocuments([sample]).map((session) => makeSampleSessionEvent(sample, session));
  const aggregatedFacts = buildTimelineFactsFromSessionEvents(sessionEvents, question);
  const summary = summarizeLongMemEvalTimelineEvidence(question, aggregatedFacts, event);
  return {
    event,
    facts: [],
    aggregatedFacts,
    related: aggregatedFacts,
    summary
  };
}

function buildTimelineFactsFromSessionEvents(events: MemoryEvent[], question: string): TimelineAggregatedFact[] {
  return events
    .slice()
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.eventId.localeCompare(right.eventId))
    .map((event, index) => {
      const content = event.multimodalData.map((item) => multimodalContentToText(item.content)).filter(Boolean).join("\n");
      const evidence = limitLongMemEvalMemoryText(selectLongMemEvalEvidence(question || memoryEventSummary(event), [content]));
      return {
        aggregationId: `timeline_raw_${index}_${event.eventId}`,
        factId: `raw_session_${index}_${event.eventId}`,
        factType: event.eventType,
        factText: evidence,
        normalizedClaim: normalizeText(evidence),
        evidenceTime: event.eventTime,
        sourceEventIds: [event.eventId],
        sourceFactIds: [],
        sourceSegmentIds: [],
        sourceRefs: sourceRefsFromEvent(event),
        timeBasis: "source_time" as const,
        timeConfidence: "high" as const
      };
    })
    .filter((fact) => fact.factText.trim());
}

const LONGMEMEVAL_TIMELINE_EVIDENCE_CHAR_LIMIT = 2400;
const LONGMEMEVAL_TIMELINE_CHUNK_CHAR_LIMIT = 700;
const LONGMEMEVAL_TIMELINE_MEMORY_TEXT_CHAR_LIMIT = 1600;
const LONGMEMEVAL_QUERY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "where",
  "what",
  "when",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "long",
  "did",
  "does",
  "was",
  "were",
  "have",
  "has",
  "had",
  "much",
  "many",
  "from",
  "that",
  "this",
  "there",
  "their",
  "your",
  "you",
  "about",
  "after",
  "before",
  "into",
  "onto",
  "over",
  "under"
]);

function summarizeLongMemEvalTimelineEvidence(question: string, aggregatedFacts: TimelineAggregatedFact[], event: MemoryEvent) {
  const sourceTexts = aggregatedFacts.length
    ? aggregatedFacts.map((fact) => fact.factText)
    : event.multimodalData.map((item) => multimodalContentToText(item.content)).filter(Boolean);
  const evidence = selectLongMemEvalEvidence(question, sourceTexts);

  return [
    `时间轴聚合事件：${memoryEventSummary(event)}`,
    `事件时间：${event.eventTime}`,
    `来源：${event.sourceId ?? event.sourceApp ?? event.eventId}`,
    `聚合证据：${evidence}`
  ].join("\n");
}

function selectLongMemEvalEvidence(question: string, sourceTexts: string[]) {
  const queryTerms = extractLongMemEvalQueryTerms(question);
  const queryPhrases = extractLongMemEvalQueryPhrases(queryTerms);
  const chunks = sourceTexts.flatMap((text, sourceIndex) =>
    chunkLongMemEvalEvidence(text).map((chunk, chunkIndex) => ({
      text: truncateLongMemEvalChunk(chunk),
      sourceIndex,
      chunkIndex,
      score: scoreLongMemEvalEvidenceChunk(chunk, queryTerms, queryPhrases)
    }))
  );
  const ranked = chunks
    .filter((chunk) => chunk.score > 0)
    .sort(compareLongMemEvalEvidenceChunks);
  const fallback = chunks.slice(0, 4);
  const selected = selectLongMemEvalEvidenceWithinBudget(ranked.length ? ranked : fallback);
  return selected.map((chunk) => chunk.text).join("\n");
}

function extractLongMemEvalQueryTerms(question: string) {
  const normalized = question.toLowerCase();
  const tokens = normalized
    .match(/[a-z0-9$]+/g)
    ?.map((token) => token.trim())
    .filter((token) => token.length >= 3 || token.startsWith("$"))
    .filter((token) => !LONGMEMEVAL_QUERY_STOPWORDS.has(token)) ?? [];
  return Array.from(new Set(tokens));
}

function extractLongMemEvalQueryPhrases(queryTerms: string[]) {
  const phrases: string[] = [];
  for (let index = 0; index < queryTerms.length - 1; index += 1) {
    const left = queryTerms[index];
    const right = queryTerms[index + 1];
    if (left && right) phrases.push(`${left} ${right}`);
  }
  return phrases;
}

function chunkLongMemEvalEvidence(text: string) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  const turns = normalized
    .split(/\n(?=(?:user|assistant|system):\s)/gi)
    .map((item) => item.trim())
    .filter(Boolean);
  const baseChunks = turns.length > 1 ? turns : normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  return baseChunks.flatMap(splitLongEvidenceChunk);
}

function splitLongEvidenceChunk(chunk: string) {
  if (chunk.length <= LONGMEMEVAL_TIMELINE_CHUNK_CHAR_LIMIT) return [chunk];
  const sentences = chunk.split(/(?<=[.!?。！？])\s+/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences.length ? sentences : [chunk]) {
    if (current && current.length + sentence.length + 1 > LONGMEMEVAL_TIMELINE_CHUNK_CHAR_LIMIT) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks.flatMap((item) => {
    if (item.length <= LONGMEMEVAL_TIMELINE_CHUNK_CHAR_LIMIT) return [item];
    const pieces: string[] = [];
    for (let index = 0; index < item.length; index += LONGMEMEVAL_TIMELINE_CHUNK_CHAR_LIMIT) {
      pieces.push(item.slice(index, index + LONGMEMEVAL_TIMELINE_CHUNK_CHAR_LIMIT));
    }
    return pieces;
  });
}

function scoreLongMemEvalEvidenceChunk(chunk: string, queryTerms: string[], queryPhrases: string[]) {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const phrase of queryPhrases) {
    if (lower.includes(phrase)) score += 10;
  }
  for (const term of queryTerms) {
    if (!term) continue;
    if (lower.includes(term)) score += term.length >= 5 ? 2 : 1;
  }
  return score;
}

function compareLongMemEvalEvidenceChunks(
  left: { score: number; sourceIndex: number; chunkIndex: number },
  right: { score: number; sourceIndex: number; chunkIndex: number }
) {
  return right.score - left.score || left.sourceIndex - right.sourceIndex || left.chunkIndex - right.chunkIndex;
}

function selectLongMemEvalEvidenceWithinBudget<T extends { text: string }>(chunks: T[]) {
  const selected: T[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const separatorCost = selected.length ? 1 : 0;
    const nextCost = chunk.text.length + separatorCost;
    if (selected.length && used + nextCost > LONGMEMEVAL_TIMELINE_EVIDENCE_CHAR_LIMIT) continue;
    if (!selected.length && nextCost > LONGMEMEVAL_TIMELINE_EVIDENCE_CHAR_LIMIT) {
      selected.push({ ...chunk, text: limitLongMemEvalEvidence(chunk.text) });
      break;
    }
    selected.push(chunk);
    used += nextCost;
  }
  return selected;
}

function truncateLongMemEvalChunk(chunk: string) {
  const normalized = chunk.replace(/\s+/g, " ").trim();
  if (normalized.length <= LONGMEMEVAL_TIMELINE_CHUNK_CHAR_LIMIT) return normalized;
  return `${normalized.slice(0, LONGMEMEVAL_TIMELINE_CHUNK_CHAR_LIMIT - 1).trim()}…`;
}

function limitLongMemEvalEvidence(evidence: string) {
  const normalized = evidence.trim();
  if (normalized.length <= LONGMEMEVAL_TIMELINE_EVIDENCE_CHAR_LIMIT) return normalized;
  return `${normalized.slice(0, LONGMEMEVAL_TIMELINE_EVIDENCE_CHAR_LIMIT - 1).trim()}…`;
}

function limitLongMemEvalMemoryText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= LONGMEMEVAL_TIMELINE_MEMORY_TEXT_CHAR_LIMIT) return normalized;
  return `${normalized.slice(0, LONGMEMEVAL_TIMELINE_MEMORY_TEXT_CHAR_LIMIT - 1).trim()}…`;
}

function logLongMemEvalRequest(logger: LongMemEvalLogger | undefined, fields: Record<string, unknown>) {
  const payload = sanitizeLongMemEvalLogPayload({ operation: "longmemeval", ...fields });
  if (logger) {
    logger.info(payload, "longmemeval llm request context");
  } else {
    console.info("longmemeval llm request context", payload);
  }
}

function sanitizeLongMemEvalLogPayload(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string" ? limitLongMemEvalPreview(entry, longMemEvalLogPreviewCharLimit) : entry
    ])
  );
}

async function ingestSampleTimeline(
  repository: ContextEngineRepository,
  sample: LongMemEvalSample,
  input: {
    sampleIndex: number;
    sampleCount: number;
    totalSessions: number;
    sessionOffset: number;
    ingestSessionConcurrency: number;
    emitProgress: (progress: LongMemEvalProgressUpdate) => void;
    logger?: LongMemEvalLogger | undefined;
    logIngestRequestContext: boolean;
    llm?: LlmFactFusionOptions;
    disableIngestLlm?: boolean;
    allowLlmFallback?: boolean;
    skipStmAdmission?: boolean;
    trace?: LongMemEvalSampleTraceContext;
    stageAttempt?: number;
  }
): Promise<{ sessions: LongMemEvalSessionDocument[]; ingestedSessions: number; skippedSessions: number }> {
  const sessions = buildSessionDocuments([sample]);
  if (!sessions.length) return { sessions, ingestedSessions: 0, skippedSessions: 0 };
  let ingestedSessions = 0;
  let skippedSessions = 0;
  let completedSessions = 0;

  const results = await mapWithConcurrencyUntilError(sessions, input.ingestSessionConcurrency, async (session, sessionIndex) => {
    const event = makeSampleSessionEvent(sample, session);
    await traceLongMemEvalIngestionOperation(input, "build_event", {
      sample,
      session
    }, event, {
      eventId: event.eventId,
      sessionId: session.sessionId,
      contextScopeId: event.contextScopeId
    });
    const processedSessionCount = input.sessionOffset + sessionIndex + 1;
    const sampleProgress = {
      currentQuestionId: readQuestionId(sample),
      currentQuestionType: readQuestionType(sample),
      currentQuestion: readQuestion(sample),
      currentSampleIndex: input.sampleIndex,
      currentSampleCount: input.sampleCount,
      currentSessionIndex: processedSessionCount,
      currentSessionCount: input.totalSessions,
      currentSessionId: session.sessionId,
      currentSessionDate: session.eventTime
    };

    if (await hasCompletedMemoryEvent(repository, event.eventId)) {
      completedSessions += 1;
      input.emitProgress({
        stage: "ingest",
        ingestStage: "finalize",
        ...sampleProgress,
        stageMessage: "haystack session 事件已存在，跳过入库",
        stageProgress: percent(input.sampleIndex, input.sampleCount),
        batchProgress: percent(processedSessionCount, input.totalSessions),
        batchMessage: "入库去重批次",
        processedSamples: input.sampleIndex,
        processedSessions: processedSessionCount,
        advanceSteps: 1,
        advanceSessions: 1,
        ...(completedSessions === sessions.length ? { advanceSamples: 1 } : {}),
        batchIndex: processedSessionCount,
        batchCount: input.totalSessions
      });
      return { ingested: 0, skipped: 1 };
    }

    if (input.logIngestRequestContext) {
      logLongMemEvalRequest(input.logger, {
        stage: "ingest",
        ingestStage: "save_event",
        phase: "sample_session_event_input",
        questionId: readQuestionId(sample),
        questionType: readQuestionType(sample),
        currentSampleIndex: input.sampleIndex,
        currentSampleCount: input.sampleCount,
        eventId: event.eventId,
        eventType: event.eventType,
        sessionId: session.sessionId,
        sessionTime: session.eventTime,
        multimodalCount: event.multimodalData.length,
        sourceRefCount: sourceRefsFromEvent(event).length,
        contentPreview: multimodalContentPreview(event.multimodalData[0]?.content)
      });
    }

    const writeStartedAt = Date.now();
    input.emitProgress({
      stage: "ingest",
      ingestStage: "save_event",
      ...sampleProgress,
      stageMessage: "保存 haystack session 事件中",
      stageProgress: percent(input.sampleIndex, input.sampleCount),
      batchProgress: percent(processedSessionCount, input.totalSessions),
      batchMessage: "保存事件批次",
      processedSamples: input.sampleIndex,
      processedSessions: processedSessionCount,
      advanceSteps: 1,
      batchIndex: processedSessionCount,
      batchCount: input.totalSessions
    });

    const observer = createLongMemEvalIngestLlmObserver(input, sampleProgress);
    try {
      await runLongMemEvalSamplePipeline(repository, event, input.llm ? {
        ...input.llm,
        observer: mergeLongMemEvalObservers(
          observer,
          input.trace ? createLongMemEvalIngestionTraceLlmObserver(input, event) : undefined
        )
      } : { observer }, {
        disableIngestLlm: input.disableIngestLlm === true,
        allowLlmFallback: input.disableIngestLlm === true || input.allowLlmFallback !== false,
        skipStmAdmission: input.skipStmAdmission === true,
        ...(input.trace ? { trace: input.trace } : {}),
        stageAttempt: input.stageAttempt ?? 1,
        sessionId: session.sessionId
      });
    } catch (error) {
      await repository.deleteMemoryEventCascade(event.eventId, { recordChangeEvent: false });
      throw error;
    }

    if (input.logIngestRequestContext) {
      const snapshot = repository.getDebugSnapshot();
      const task = snapshot.pipelineTasks.find((item) => item.eventId === event.eventId && item.taskType === "index");
      logLongMemEvalRequest(input.logger, {
        stage: "ingest",
        ingestStage: "finalize",
        phase: "sample_session_event_saved",
        questionId: readQuestionId(sample),
        questionType: readQuestionType(sample),
        currentSampleIndex: input.sampleIndex,
        currentSampleCount: input.sampleCount,
        eventId: event.eventId,
        eventType: event.eventType,
        sessionId: session.sessionId,
        pipelineStage: task?.stage,
        durationMs: Date.now() - writeStartedAt
      });
    }

    completedSessions += 1;
    input.emitProgress({
      stage: "ingest",
      ingestStage: "finalize",
      ...sampleProgress,
      stageMessage: "haystack session 入库完成",
      stageProgress: percent(input.sampleIndex, input.sampleCount),
      batchProgress: percent(processedSessionCount, input.totalSessions),
      batchMessage: "入库收尾批次",
      processedSamples: input.sampleIndex,
      processedSessions: processedSessionCount,
      advanceSteps: 1,
      advanceSessions: 1,
      ...(completedSessions === sessions.length ? { advanceSamples: 1 } : {}),
      batchIndex: processedSessionCount,
      batchCount: input.totalSessions
    });
    return { ingested: 1, skipped: 0 };
  });
  for (const result of results) {
    ingestedSessions += result.ingested;
    skippedSessions += result.skipped;
  }
  await yieldToEventLoop();
  return { sessions, ingestedSessions, skippedSessions };
}

async function traceLongMemEvalIngestionOperation(
  input: { trace?: LongMemEvalSampleTraceContext; stageAttempt?: number },
  operation: "build_event" | "save_event" | "parse_event" | "fact_fusion" | "stm_admission",
  traceInput: unknown,
  output: unknown,
  links: Record<string, unknown>
) {
  if (!input.trace) return;
  const now = new Date().toISOString();
  const stageExecutionId = `${operation}_${randomUUID()}`;
  await appendLongMemEvalTrace(input.trace, {
    stage: "ingestion",
    operation,
    stageExecutionId,
    status: "started",
    attempt: input.stageAttempt ?? 1,
    stageAttempt: input.stageAttempt ?? 1,
    startedAt: now,
    input: traceInput,
    links
  });
  await appendLongMemEvalTrace(input.trace, {
    stage: "ingestion",
    operation,
    stageExecutionId,
    status: "succeeded",
    attempt: input.stageAttempt ?? 1,
    stageAttempt: input.stageAttempt ?? 1,
    startedAt: now,
    finishedAt: now,
    elapsedMs: 0,
    input: traceInput,
    output,
    links
  });
}

function createLongMemEvalIngestionTraceLlmObserver(
  input: { trace?: LongMemEvalSampleTraceContext; stageAttempt?: number },
  event: MemoryEvent
): OpenAiCompatibleRequestObserver {
  const ids = new Map<string, string>();
  return (observation) => {
    if (!input.trace) return;
    const internalAttempt = observation.internalAttempt ?? 1;
    const key = `${observation.operation}\u0000${internalAttempt}\u0000${observation.startedAt}`;
    const stageExecutionId = ids.get(key) ?? `llm_${randomUUID()}`;
    ids.set(key, stageExecutionId);
    void appendLongMemEvalTrace(input.trace, {
      stage: "ingestion",
      operation: "llm_request",
      stageExecutionId,
      status: observation.status,
      attempt: internalAttempt,
      stageAttempt: input.stageAttempt ?? 1,
      internalAttempt,
      startedAt: observation.startedAt,
      ...(observation.status !== "started" ? { finishedAt: new Date().toISOString() } : {}),
      ...(observation.elapsedMs !== undefined ? { elapsedMs: observation.elapsedMs } : {}),
      input: {
        operation: observation.operation,
        endpoint: observation.endpoint,
        model: observation.model,
        requestBody: observation.requestBody,
        context: observation.context
      },
      ...(observation.status === "succeeded" ? { output: { rawResponse: observation.response, usage: observation.usage } } : {}),
      ...(observation.status === "failed" ? { error: longMemEvalObservationError(observation) } : {}),
      links: { eventId: event.eventId, contextScopeId: event.contextScopeId }
    });
  };
}

function createLongMemEvalIngestLlmObserver(
  input: {
    sampleIndex: number;
    sampleCount: number;
    totalSessions: number;
    emitProgress: (progress: LongMemEvalProgressUpdate) => void;
  },
  sampleProgress: Pick<LongMemEvalProgress,
    "currentQuestionId" |
    "currentQuestionType" |
    "currentQuestion" |
    "currentSampleIndex" |
    "currentSampleCount" |
    "currentSessionIndex" |
    "currentSessionCount" |
    "currentSessionId" |
    "currentSessionDate"
  >
): OpenAiCompatibleRequestObserver {
  let active = 0;
  let completed = 0;
  let failed = 0;
  return (observation) => {
    if (observation.status === "started") {
      active += 1;
    } else {
      active = Math.max(0, active - 1);
      if (observation.status === "failed") failed += 1;
      else completed += 1;
    }
    const batchIndex = readObservationNumber(observation, "batchIndex");
    const batchCount = readObservationNumber(observation, "batchCount");
    input.emitProgress({
      stage: "ingest",
      ingestStage: operationToIngestStage(observation.operation),
      ...sampleProgress,
      stageMessage: formatLlmRequestMessage(observation),
      stageProgress: percent(input.sampleIndex, input.sampleCount),
      ...(batchIndex !== undefined ? { batchIndex } : {}),
      ...(batchCount !== undefined ? { batchCount } : {}),
      ...(batchIndex !== undefined && batchCount !== undefined ? { batchProgress: percent(batchIndex, batchCount) } : {}),
      batchMessage: `LLM ${observation.operation} active:${active} done:${completed} failed:${failed}`,
      advanceSteps: 0,
      llmRequest: {
        status: observation.status,
        operation: observation.operation,
        endpoint: observation.endpoint,
        startedAt: observation.startedAt,
        active,
        completed,
        failed,
        ...(observation.elapsedMs !== undefined ? { elapsedMs: observation.elapsedMs } : {}),
        ...(batchIndex !== undefined ? { batchIndex } : {}),
        ...(batchCount !== undefined ? { batchCount } : {}),
        ...(observation.error ? { error: observation.error } : {})
      }
    });
  };
}

function createLongMemEvalStageLlmObserver(
  input: {
    stage: "answer" | "judge";
    emitProgress: (progress: LongMemEvalProgressUpdate) => void;
  },
  sampleProgress: Pick<LongMemEvalProgress,
    "currentQuestionId" |
    "currentQuestionType" |
    "currentQuestion" |
    "currentSampleIndex" |
    "currentSampleCount" |
    "currentHypothesis"
  >
): OpenAiCompatibleRequestObserver {
  let active = 0;
  let completed = 0;
  let failed = 0;
  return (observation) => {
    if (observation.status === "started") {
      active += 1;
    } else {
      active = Math.max(0, active - 1);
      if (observation.status === "failed") failed += 1;
      else completed += 1;
    }
    const batchIndex = readObservationNumber(observation, "batchIndex");
    const batchCount = readObservationNumber(observation, "batchCount");
    input.emitProgress({
      stage: input.stage,
      ...sampleProgress,
      stageMessage: formatLlmRequestMessage(observation),
      ...(batchIndex !== undefined ? { batchIndex } : {}),
      ...(batchCount !== undefined ? { batchCount } : {}),
      ...(batchIndex !== undefined && batchCount !== undefined ? { batchProgress: percent(batchIndex, batchCount) } : {}),
      batchMessage: `LLM ${observation.operation} active:${active} done:${completed} failed:${failed}`,
      advanceSteps: 0,
      llmRequest: {
        status: observation.status,
        operation: observation.operation,
        endpoint: observation.endpoint,
        startedAt: observation.startedAt,
        active,
        completed,
        failed,
        ...(observation.elapsedMs !== undefined ? { elapsedMs: observation.elapsedMs } : {}),
        ...(batchIndex !== undefined ? { batchIndex } : {}),
        ...(batchCount !== undefined ? { batchCount } : {}),
        ...(observation.error ? { error: observation.error } : {})
      }
    });
  };
}

function readObservationNumber(observation: OpenAiCompatibleRequestObservation, key: "batchIndex" | "batchCount") {
  const value = observation.context?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function operationToIngestStage(operation: string): NonNullable<LongMemEvalProgress["ingestStage"]> {
  return operation === "stm_admission" ? "stm" : operation === "fact_fusion" ? "fact" : "save_event";
}

function formatLlmRequestMessage(observation: OpenAiCompatibleRequestObservation) {
  const batchIndex = readObservationNumber(observation, "batchIndex");
  const batchCount = readObservationNumber(observation, "batchCount");
  const batchText = batchIndex && batchCount ? ` ${batchIndex}/${batchCount}` : "";
  if (observation.status === "started") return `LLM ${observation.operation}${batchText} 调用中`;
  if (observation.status === "failed") return `LLM ${observation.operation}${batchText} 调用失败`;
  return `LLM ${observation.operation}${batchText} 调用完成`;
}

async function runLongMemEvalSamplePipeline(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  llm: LlmFactFusionOptions | undefined,
  options: {
    disableIngestLlm?: boolean;
    allowLlmFallback?: boolean;
    skipStmAdmission?: boolean;
    trace?: LongMemEvalSampleTraceContext;
    stageAttempt?: number;
    sessionId?: string;
  } = {}
) {
  let task = createPipelineTask(event);
  const traceInput = {
    ...(options.trace ? { trace: options.trace } : {}),
    ...(options.stageAttempt !== undefined ? { stageAttempt: options.stageAttempt } : {})
  };
  const links = {
    eventId: event.eventId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(event.contextScopeId ? { contextScopeId: event.contextScopeId } : {})
  };
  await traceLongMemEvalIngestionBoundary(traceInput, "save_event", event, links, async () => {
    await repository.savePipelineTask(task);
    await repository.saveMemoryEvent(event);
    task = await updatePipelineTask(repository, task, {
      taskType: "ingest",
      status: "running",
      stage: "event_saved"
    });
    await repository.saveMemoryChangeEvent({
      eventId: `mce_${event.eventId}`,
      memoryDataId: event.eventId,
      changeType: "created",
      storageLayer: "fact",
      reason: "memory_event_accepted",
      createdAt: new Date().toISOString()
    });
    return { event, task };
  });
  await traceLongMemEvalIngestionBoundary(traceInput, "parse_event", event.multimodalData, links, async () => {
    const parsed = await parseAndAdmitEvent(repository, event, task, {
      ...(llm
        ? {
            llm: {
              ...llm,
              fallbackMode: options.disableIngestLlm === true || options.allowLlmFallback !== false ? "allow" : "throw",
              emptyFactsMode: "allow",
              semanticRetryMaxAttempts: 2
            }
          }
        : {}),
      disableFactFusionLlm: options.disableIngestLlm === true,
      disableStmAdmissionLlm: options.disableIngestLlm === true,
      skipStmAdmission: options.skipStmAdmission === true,
      skipTimelineFusion: true,
      ...(options.trace
        ? { stageObserver: createLongMemEvalParseAndAdmitStageObserver(traceInput, links) }
        : {})
    });
    const repositoryOutput = sampleRepositoryTraceSnapshot(repository, options.trace?.sample.questionId ?? event.sourceId ?? event.eventId);
    return { parsed, repository: repositoryOutput };
  });
}

function createLongMemEvalParseAndAdmitStageObserver(
  input: { trace?: LongMemEvalSampleTraceContext; stageAttempt?: number },
  links: Record<string, unknown>
) {
  return async (observation: ParseAndAdmitStageObservation) => {
    await appendLongMemEvalTrace(input.trace, {
      stage: "ingestion",
      operation: observation.operation,
      stageExecutionId: observation.stageExecutionId,
      status: observation.status,
      attempt: input.stageAttempt ?? 1,
      stageAttempt: input.stageAttempt ?? 1,
      startedAt: observation.startedAt,
      ...(observation.finishedAt ? { finishedAt: observation.finishedAt } : {}),
      ...(observation.elapsedMs !== undefined ? { elapsedMs: observation.elapsedMs } : {}),
      input: observation.input,
      ...(observation.output !== undefined ? { output: observation.output } : {}),
      ...(observation.error !== undefined ? { error: toLongMemEvalStructuredError(observation.error) } : {}),
      links
    });
  };
}

async function traceLongMemEvalIngestionBoundary<T>(
  input: { trace?: LongMemEvalSampleTraceContext; stageAttempt?: number },
  operation: "save_event" | "parse_event",
  traceInput: unknown,
  links: Record<string, unknown>,
  execute: () => Promise<T>
) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const stageExecutionId = `${operation}_${randomUUID()}`;
  await appendLongMemEvalTrace(input.trace, {
    stage: "ingestion",
    operation,
    stageExecutionId,
    status: "started",
    attempt: input.stageAttempt ?? 1,
    stageAttempt: input.stageAttempt ?? 1,
    startedAt,
    input: traceInput,
    links
  });
  try {
    const output = await execute();
    await appendLongMemEvalTrace(input.trace, {
      stage: "ingestion",
      operation,
      stageExecutionId,
      status: "succeeded",
      attempt: input.stageAttempt ?? 1,
      stageAttempt: input.stageAttempt ?? 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      input: traceInput,
      output,
      links
    });
    return output;
  } catch (error) {
    await appendLongMemEvalTrace(input.trace, {
      stage: "ingestion",
      operation,
      stageExecutionId,
      status: "failed",
      attempt: input.stageAttempt ?? 1,
      stageAttempt: input.stageAttempt ?? 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      input: traceInput,
      error: toLongMemEvalStructuredError(error),
      links
    });
    throw error;
  }
}

function withLongMemEvalStreamingTransport(
  llm?: LongMemEvalLlmOptions["extraction"] | LlmFactFusionOptions,
  signal?: AbortSignal
): LlmFactFusionOptions {
  return {
    ...(llm ?? {}),
    ...(signal ? { signal } : {}),
    transport: "openai-sdk-stream"
  };
}

function throwIfLongMemEvalCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new LongMemEvalCancelledError();
  }
}

class LongMemEvalCancelledError extends Error {
  constructor() {
    super("LongMemEval evaluation cancelled");
    this.name = "LongMemEvalCancelledError";
  }
}

function makeSampleEvent(sample: LongMemEvalSample): MemoryEvent {
  const questionId = readQuestionId(sample);
  const questionDate = readQuestionDate(sample) ?? new Date().toISOString();
  return {
    eventId: `longmemeval_event_${questionId}`,
    contextScopeId: longMemEvalContextScopeId(questionId),
    eventType: `longmemeval_${readQuestionType(sample)}`,
    eventSummary: readQuestion(sample),
    eventTime: questionDate,
    sourceApp: "longmemeval",
    sourceId: questionId,
    permissionSnapshot: {
      snapshotId: `ps_longmemeval_${questionId}`,
      tenantId: "local",
      principalId: "longmemeval",
      sourceAclVersion: "longmemeval-v1",
      visibility: "private"
    },
    multimodalData: [],
    sourceRefs: [
      {
        sourceRefId: `src_longmemeval_${questionId}`,
        sourceType: "longmemeval",
        sourceId: questionId
      }
    ]
  };
}

function makeSampleSessionEvent(sample: LongMemEvalSample, session: LongMemEvalSessionDocument): MemoryEvent {
  const base = makeSampleEvent(sample);
  const sourceRef = longMemEvalSessionSourceRef(session.questionId, session.sessionId);
  return {
    ...base,
    eventId: longMemEvalSessionSourceId(session.questionId, session.sessionId),
    eventType: "longmemeval_session",
    eventSummary: `LongMemEval session ${session.sessionId} for sample ${session.questionId}`,
    eventTime: session.evidenceTime,
    multimodalData: [buildLongMemEvalTimelineSessionItem(session)],
    sourceRefs: [sourceRef]
  };
}

function buildLongMemEvalTimelineSessionItem(session: LongMemEvalSessionDocument): MemoryEvent["multimodalData"][number] {
  const sourceRef = longMemEvalSessionSourceRef(session.questionId, session.sessionId);
  return {
    itemId: `item_${session.questionId}_${session.sessionId}`,
    type: "text",
    format: "json",
    content: {
      text: buildLongMemEvalSessionMemoryContent(session),
      rawTranscript: session.content,
      sessionId: session.sessionId,
      questionId: session.questionId,
      evidenceTime: session.evidenceTime,
      sessionIndex: session.sessionIndex,
      sampleIndex: session.sampleIndex,
      sampleSessionIndex: session.sampleSessionIndex,
      sampleSessionCount: session.sampleSessionCount
    },
    ref: session.sessionId,
    sourceRefs: [sourceRef],
    timeBasis: "source_time",
    timeConfidence: "high"
  };
}

export function longMemEvalSessionSourceId(questionId: string, sessionId: string) {
  return `longmemeval_event_${questionId}_${sessionId}`;
}

function longMemEvalContextScopeId(questionId: string) {
  return `longmemeval:${questionId}`;
}

function longMemEvalSessionSourceRef(questionId: string, sessionId: string): SourceRef {
  const sourceId = longMemEvalSessionSourceId(questionId, sessionId);
  return {
    sourceRefId: `src_${sourceId}`,
    sourceType: "agent_memory",
    sourceId,
    metadata: { questionId, sessionId }
  };
}

function longMemEvalSessionIdFromSourceRef(source: SourceRef) {
  const sessionId = source.metadata?.sessionId;
  return typeof sessionId === "string" ? sessionId : source.sourceId;
}

function buildLongMemEvalSessionMemoryContent(session: LongMemEvalSessionDocument) {
  return session.content;
}

async function hasMemoryEvent(repository: ContextEngineRepository, eventId: string) {
  return repository.hasMemoryEvent(eventId);
}

async function hasCompletedMemoryEvent(repository: ContextEngineRepository, eventId: string) {
  if (!await hasMemoryEvent(repository, eventId)) return false;
  const task = await repository.getPipelineTaskByEventId(eventId);
  return task?.status === "succeeded";
}

async function allSampleTimelineEventsExist(repository: ContextEngineRepository, samples: LongMemEvalSample[]) {
  if (!samples.length) return false;
  for (const sample of samples) {
    const sessions = buildSessionDocuments([sample]);
    if (!sessions.length) return false;
    for (const session of sessions) {
      if (!await hasCompletedMemoryEvent(repository, makeSampleSessionEvent(sample, session).eventId)) return false;
    }
  }
  return true;
}

export async function openLongMemEvalRepository(
  datasetPath: string,
  options: {
    storeNamespace?: string;
    lazyCache?: boolean;
    readOnly?: boolean;
  } = {}
) {
  return createLongMemEvalRepository(
    resolve(datasetPath),
    undefined,
    options.storeNamespace,
    {
      lazyCache: options.lazyCache ?? false,
      readOnly: options.readOnly ?? false
    }
  );
}

async function createLongMemEvalRepository(
  datasetPath: string,
  graphStoreOverride?: GraphMemoryStore,
  storeNamespace?: string,
  options: { lazyCache?: boolean; readOnly?: boolean } = {}
) {
  const config = getContextEngineConfig();
  const storePath = getLongMemEvalStorePath(datasetPath, storeNamespace, config);
  const repositoryOptions = {
    ...(options.lazyCache === false ? {} : { loadCache: false }),
    ...(options.readOnly ? { readOnly: true } : {})
  };
  if (graphStoreOverride) {
    return {
      repository: new SqliteContextEngineRepository(storePath, graphStoreOverride, repositoryOptions),
      close: undefined
    };
  }

  if (readLongMemEvalGraphStoreMode(config) === "local") {
    return {
      repository: new SqliteContextEngineRepository(storePath, undefined, repositoryOptions),
      close: undefined
    };
  }

  try {
    const graphStore = await createConfiguredLongMemEvalGraphStore(config, {
      initialize: !options.readOnly
    });
    if (!graphStore) throw new Error("neo4j_graph_store_not_created");
    const repository = new SqliteContextEngineRepository(storePath, graphStore, repositoryOptions);
    return {
      repository,
      close: graphStore.close.bind(graphStore)
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "graph_store_unavailable";
    throw new Error(`LongMemEval requires Neo4j graph store but initialization failed: ${reason}`);
  }
}

export function getLongMemEvalStorePath(
  datasetPath: string,
  storeNamespace?: string,
  config = getContextEngineConfig()
) {
  const namespace = storeNamespace?.trim() ? `:${storeNamespace.trim()}` : "";
  const embeddingKey = embeddingFingerprint(config.embedding);
  const datasetKey = createHash("sha1")
    .update(`${longMemEvalStoreSchemaVersion}:${embeddingKey}:${datasetPath}${namespace}`)
    .digest("hex")
    .slice(0, 12);
  return join(config.longMemEval.storage.storeDirectory, `${datasetKey}.sqlite`);
}

async function listLongMemEvalDebugStoreCandidates(config: ContextEngineConfig, datasetPath?: string) {
  const candidates: Array<{ path: string; mtimeMs: number; priority: number }> = [];
  const seen = new Set<string>();
  const normalizedDatasetPath = datasetPath?.trim() ? resolve(datasetPath) : "";

  if (normalizedDatasetPath) {
    const expectedPath = getLongMemEvalStorePath(normalizedDatasetPath, undefined, config);
    const expectedStat = await readOptionalFileStat(expectedPath);
    if (expectedStat?.isFile()) {
      candidates.push({ path: expectedPath, mtimeMs: expectedStat.mtimeMs, priority: 0 });
      seen.add(expectedPath);
    }
  }

  await mkdir(config.longMemEval.storage.storeDirectory, { recursive: true });
  const fileNames = await readdir(config.longMemEval.storage.storeDirectory);
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".sqlite")) continue;
    const storePath = join(config.longMemEval.storage.storeDirectory, fileName);
    if (seen.has(storePath)) continue;
    const fileStat = await readOptionalFileStat(storePath);
    if (!fileStat?.isFile()) continue;
    candidates.push({ path: storePath, mtimeMs: fileStat.mtimeMs, priority: 1 });
  }

  return candidates
    .sort((left, right) => left.priority - right.priority || right.mtimeMs - left.mtimeMs)
    .map((candidate) => candidate.path);
}

async function readOptionalFileStat(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function hasLongMemEvalDebugSnapshotData(snapshot: ContextDebugSnapshot) {
  return Boolean(
    snapshot.memoryEvents.length ||
    snapshot.parsedSegments.length ||
    snapshot.facts.length ||
    snapshot.shortTermMemories.length ||
    snapshot.longTermMemories.length ||
    snapshot.llmDreamingTraces.length
  );
}

function readLongMemEvalDebugSnapshotPageFromSqlite(
  storePath: string,
  view: LongMemEvalDebugView,
  requestedPage: number,
  requestedPageSize: number,
  filters: LongMemEvalDebugFilters = {}
): LongMemEvalDebugSnapshotPage {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const pageSize = Math.max(1, Math.min(200, Math.floor(requestedPageSize)));
    const totalItems = countLongMemEvalDebugSqliteItems(db, view, filters);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const page = Math.max(1, Math.min(totalPages, Math.floor(requestedPage)));
    const offset = (page - 1) * pageSize;
    const snapshot = createEmptyLongMemEvalDebugSnapshot();
    let timeline: LongMemEvalDebugSnapshotPage["timeline"] = [];

    if (view === "dataLake") {
      snapshot.memoryEvents = readLongMemEvalMemoryEvents(db, pageSize, offset, filters);
      snapshot.parsedSegments = readLongMemEvalParsedSegments(db, pageSize, offset, filters);
      snapshot.facts = readLongMemEvalFacts(db, pageSize, offset, filters);
    } else if (view === "stm") {
      snapshot.shortTermMemories = readLongMemEvalShortTermMemories(db, pageSize, offset, filters);
    } else if (view === "ltm") {
      snapshot.longTermMemories = readLongMemEvalLongTermMemories(db, pageSize, offset, filters);
      snapshot.llmDreamingTraces = readLongMemEvalDreamingTraces(db, pageSize, offset);
    } else {
      const aggregatedFacts = buildTimelineAggregatedFacts(readLongMemEvalFacts(db, undefined, 0, filters))
        .sort((left, right) => {
          const leftTime = left.validTime ?? left.evidenceTime ?? left.validTimeStart ?? left.evidenceTimeStart ?? "";
          const rightTime = right.validTime ?? right.evidenceTime ?? right.validTimeStart ?? right.evidenceTimeStart ?? "";
          return leftTime.localeCompare(rightTime);
        });
      timeline = aggregatedFacts.slice(offset, offset + pageSize).map((fact) => ({
        fact,
        sourceEvents: readLongMemEvalMemoryEventsByIds(db, fact.sourceEventIds),
        sourceSegments: readLongMemEvalParsedSegmentsByIds(db, fact.sourceSegmentIds),
        sourceFacts: readLongMemEvalFactsByIds(db, fact.sourceFactIds),
        shortTermMemories: readLongMemEvalShortTermMemoriesByFactIds(db, fact.sourceFactIds),
        pipelineTasks: [],
        changeEvents: []
      }));
    }

    return {
      items: snapshot,
      timeline,
      page,
      pageSize,
      totalItems,
      totalPages
    };
  } finally {
    db.close();
  }
}

function countLongMemEvalDebugSqliteItems(db: DatabaseSync, view: LongMemEvalDebugView, filters: LongMemEvalDebugFilters = {}) {
  if (view === "timeline") {
    return countLongMemEvalSqliteTable(db, "fact_items", buildLongMemEvalFactsWhere(filters).where, buildLongMemEvalFactsWhere(filters).params);
  }
  if (view === "dataLake") {
    return Math.max(
      countLongMemEvalSqliteTable(db, "memory_events", buildLongMemEvalMemoryEventsWhere(filters).where, buildLongMemEvalMemoryEventsWhere(filters).params),
      countLongMemEvalSqliteTable(db, "parsed_segments", buildLongMemEvalParsedSegmentsWhere(filters).where, buildLongMemEvalParsedSegmentsWhere(filters).params),
      countLongMemEvalSqliteTable(db, "fact_items", buildLongMemEvalFactsWhere(filters).where, buildLongMemEvalFactsWhere(filters).params)
    );
  }
  return countLongMemEvalSqliteTable(
    db,
    view === "stm" ? "short_term_memories" : "long_term_memories",
    view === "stm"
      ? buildLongMemEvalShortTermMemoriesWhere(filters).where
      : buildLongMemEvalLongTermMemoriesWhere(filters).where,
    view === "stm"
      ? buildLongMemEvalShortTermMemoriesWhere(filters).params
      : buildLongMemEvalLongTermMemoriesWhere(filters).params
  );
}

function countLongMemEvalSqliteTable(db: DatabaseSync, tableName: string, where = "", params: unknown[] = []) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}${where}`).get(...(params as never[])) as { count?: number | bigint } | undefined;
  return Number(row?.count ?? 0);
}

function createEmptyLongMemEvalDebugSnapshot(): ContextDebugSnapshot {
  return {
    memoryEvents: [],
    parsedSegments: [],
    facts: [],
    shortTermMemories: [],
    longTermMemories: [],
    graphMemoryNodes: [],
    relationEdges: [],
    packTraces: [],
    llmFactFusionTraces: [],
    llmStmAdmissionTraces: [],
    llmDreamingTraces: [],
    pipelineTasks: [],
    indexEntries: [],
    textIndexEntries: [],
    vectorIndexEntries: [],
    changeEvents: [],
    feedbackItems: [],
    retrievalEvents: [],
    dreamingCandidateDecisions: [],
    dreamingOutbox: [],
    dreamingRuns: [],
    dreamingRunCandidates: [],
    backgroundDocuments: [],
    backgroundMaintenanceTasks: [],
    backgroundMaintenanceBatches: [],
    backgroundDynamicCaches: [],
    sessionBackgroundSnapshots: [],
    conversationBatchIngestions: [],
    conversationIngestions: [],
    conversationDocuments: [],
    conversationMessages: [],
    conversationSessionCursors: [],
    conversationIngestionJobs: [],
    conversationMessageSegments: [],
    conversationEvidenceGroups: [],
    conversationExtractionWindows: [],
    conversationFactCandidates: [],
    conversationDocumentMessageRows: [],
    conversationTemporalBackfillMigrations: []
  };
}

function buildLongMemEvalMemoryEventsWhere(filters: LongMemEvalDebugFilters) {
  return buildLongMemEvalDebugWhere(filters, {
    contentColumns: ["event_summary", "event_description", "event_type", "source_app", "source_id", "custom_fields"],
    sampleColumns: ["event_id", "source_id", "event_summary", "custom_fields"]
  });
}

function buildLongMemEvalParsedSegmentsWhere(filters: LongMemEvalDebugFilters) {
  return buildLongMemEvalDebugWhere(filters, {
    contentColumns: ["content", "segment_id", "event_id", "custom_fields"],
    sampleColumns: ["segment_id", "event_id", "custom_fields"]
  });
}

function buildLongMemEvalFactsWhere(filters: LongMemEvalDebugFilters) {
  return buildLongMemEvalDebugWhere(filters, {
    contentColumns: ["fact_text", "normalized_claim", "fact_type", "fact_id", "linked_source_refs"],
    sampleColumns: ["fact_id", "linked_event_ids", "linked_segment_ids", "linked_source_refs"]
  });
}

function buildLongMemEvalShortTermMemoriesWhere(filters: LongMemEvalDebugFilters) {
  const filter = buildLongMemEvalDebugWhere(filters, {
    contentColumns: ["content", "structured_facts", "fact_summary", "summary", "memory_type", "memory_data_type"],
    sampleColumns: ["memory_data_id", "source_fact_ids", "source_refs", "structured_facts", "summary"]
  });
  return {
    where: filter.where ? `${filter.where} AND lifecycle_status != 'deleted'` : " WHERE lifecycle_status != 'deleted'",
    params: filter.params
  };
}

function buildLongMemEvalLongTermMemoriesWhere(filters: LongMemEvalDebugFilters) {
  return buildLongMemEvalDebugWhere(filters, {
    contentColumns: ["content", "structured_facts", "fact_summary", "summary", "memory_type", "theory_class"],
    sampleColumns: ["memory_id", "source_memory_data_ids", "source_refs", "structured_facts", "summary"]
  });
}

function buildLongMemEvalDebugWhere(
  filters: LongMemEvalDebugFilters,
  columns: { contentColumns: string[]; sampleColumns: string[] }
) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const contentQuery = filters.contentQuery?.trim();
  if (contentQuery) {
    conditions.push(buildLongMemEvalLikeCondition(columns.contentColumns));
    params.push(...columns.contentColumns.map(() => contentQuery));
  }
  const sampleQuery = filters.sampleQuery?.trim();
  if (sampleQuery) {
    conditions.push(buildLongMemEvalLikeCondition(columns.sampleColumns));
    params.push(...columns.sampleColumns.map(() => sampleQuery));
  }
  return {
    where: conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "",
    params
  };
}

function buildLongMemEvalLikeCondition(columns: string[]) {
  return `(${columns.map((column) => `instr(lower(coalesce(${column}, '')), lower(?)) > 0`).join(" OR ")})`;
}

function readLongMemEvalMemoryEvents(db: DatabaseSync, limit?: number, offset = 0, filters: LongMemEvalDebugFilters = {}): MemoryEvent[] {
  const filter = buildLongMemEvalMemoryEventsWhere(filters);
  return queryLongMemEvalRows<MemoryEvent & {
    tenantId?: string;
    principalId?: string;
    sourceAclVersion?: string;
    visibility?: MemoryEvent["permissionSnapshot"]["visibility"];
  }>(db, `
    SELECT
      event_id AS eventId,
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
    ${filter.where}
    ORDER BY event_time DESC, event_id DESC
    ${limit ? "LIMIT ? OFFSET ?" : ""}
  `, [...filter.params, ...(limit ? [limit, offset] : [])]).map(({ tenantId, principalId, sourceAclVersion, visibility, ...event }) => ({
    ...event,
    eventSummary: event.eventSummary ?? event.eventDescription ?? event.eventType,
    multimodalData: [],
    sourceRefs: [],
    permissionSnapshot: {
      snapshotId: `ps_${event.eventId}`,
      tenantId: tenantId ?? "local",
      principalId: principalId ?? "local",
      sourceAclVersion: sourceAclVersion ?? "default",
      visibility: visibility ?? "private"
    }
  }));
}

function readLongMemEvalMemoryEventsByIds(db: DatabaseSync, ids: string[]): MemoryEvent[] {
  if (!ids.length) return [];
  return readLongMemEvalMemoryEventsWhere(db, "event_id", ids);
}

function readLongMemEvalMemoryEventsWhere(db: DatabaseSync, column: "event_id", values: string[]): MemoryEvent[] {
  const placeholders = values.map(() => "?").join(", ");
  return queryLongMemEvalRows<MemoryEvent & {
    tenantId?: string;
    principalId?: string;
    sourceAclVersion?: string;
    visibility?: MemoryEvent["permissionSnapshot"]["visibility"];
  }>(db, `
    SELECT
      event_id AS eventId,
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
    WHERE ${column} IN (${placeholders})
    ORDER BY event_time DESC, event_id DESC
  `, values).map(({ tenantId, principalId, sourceAclVersion, visibility, ...event }) => ({
    ...event,
    eventSummary: event.eventSummary ?? event.eventDescription ?? event.eventType,
    multimodalData: [],
    sourceRefs: [],
    permissionSnapshot: {
      snapshotId: `ps_${event.eventId}`,
      tenantId: tenantId ?? "local",
      principalId: principalId ?? "local",
      sourceAclVersion: sourceAclVersion ?? "default",
      visibility: visibility ?? "private"
    }
  }));
}

function readLongMemEvalParsedSegments(db: DatabaseSync, limit?: number, offset = 0, filters: LongMemEvalDebugFilters = {}): ContextDebugSnapshot["parsedSegments"] {
  const filter = buildLongMemEvalParsedSegmentsWhere(filters);
  return queryLongMemEvalRows<ContextDebugSnapshot["parsedSegments"][number] & { dataSource?: string; customFields?: unknown }>(db, `
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
    ${filter.where}
    ORDER BY segment_id DESC
    ${limit ? "LIMIT ? OFFSET ?" : ""}
  `, [...filter.params, ...(limit ? [limit, offset] : [])]).map(normalizeLongMemEvalParsedSegmentRow);
}

function readLongMemEvalParsedSegmentsByIds(db: DatabaseSync, ids: string[]) {
  if (!ids.length) return [];
  return readLongMemEvalParsedSegmentsWhere(db, "segment_id", ids);
}

function readLongMemEvalParsedSegmentsWhere(db: DatabaseSync, column: "segment_id", values: string[]) {
  const placeholders = values.map(() => "?").join(", ");
  return queryLongMemEvalRows<ContextDebugSnapshot["parsedSegments"][number] & { dataSource?: string; customFields?: unknown }>(db, `
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
    WHERE ${column} IN (${placeholders})
    ORDER BY segment_id DESC
  `, values).map(normalizeLongMemEvalParsedSegmentRow);
}

function normalizeLongMemEvalParsedSegmentRow(
  segment: ContextDebugSnapshot["parsedSegments"][number] & { dataSource?: string; customFields?: unknown }
): ContextDebugSnapshot["parsedSegments"][number] {
  const { dataSource, customFields, ...rest } = segment;
  const normalized: ContextDebugSnapshot["parsedSegments"][number] = { ...rest };
  if (dataSource) {
    normalized.dataSource = dataSource as NonNullable<ContextDebugSnapshot["parsedSegments"][number]["dataSource"]>;
  }
  if (customFields && typeof customFields === "object" && !Array.isArray(customFields)) {
    normalized.customFields = customFields as Record<string, never>;
  }
  return normalized;
}

function readLongMemEvalFacts(db: DatabaseSync, limit?: number, offset = 0, filters: LongMemEvalDebugFilters = {}): FactItem[] {
  const filter = buildLongMemEvalFactsWhere(filters);
  return queryLongMemEvalRows<FactItem>(db, `
    SELECT
      fact_id AS factId,
      fact_type AS factType,
      fact_text AS factText,
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
      valid_time_start AS validTimeStart,
      valid_time_end AS validTimeEnd,
      time_basis AS timeBasis,
      time_confidence AS timeConfidence,
      schema_version AS schemaVersion
    FROM fact_items
    ${filter.where}
    ORDER BY COALESCE(valid_time, valid_time_start, evidence_time) DESC, fact_id DESC
    ${limit ? "LIMIT ? OFFSET ?" : ""}
  `, [...filter.params, ...(limit ? [limit, offset] : [])]).map((fact) => ({
    ...fact,
    linkedEventIds: Array.isArray(fact.linkedEventIds) ? fact.linkedEventIds : [],
    linkedSegmentIds: Array.isArray(fact.linkedSegmentIds) ? fact.linkedSegmentIds : [],
    linkedSourceRefs: Array.isArray(fact.linkedSourceRefs) ? fact.linkedSourceRefs : [],
    entityIds: Array.isArray(fact.entityIds) ? fact.entityIds : []
  }));
}

function readLongMemEvalFactsByIds(db: DatabaseSync, ids: string[]) {
  if (!ids.length) return [];
  return readLongMemEvalFactsWhere(db, "fact_id", ids);
}

function readLongMemEvalFactsWhere(db: DatabaseSync, column: "fact_id", values: string[]) {
  const placeholders = values.map(() => "?").join(", ");
  return queryLongMemEvalRows<FactItem>(db, `
    SELECT
      fact_id AS factId,
      fact_type AS factType,
      fact_text AS factText,
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
      valid_time_start AS validTimeStart,
      valid_time_end AS validTimeEnd,
      time_basis AS timeBasis,
      time_confidence AS timeConfidence,
      schema_version AS schemaVersion
    FROM fact_items
    WHERE ${column} IN (${placeholders})
    ORDER BY COALESCE(valid_time, valid_time_start, evidence_time) DESC, fact_id DESC
  `, values).map((fact) => ({
    ...fact,
    linkedEventIds: Array.isArray(fact.linkedEventIds) ? fact.linkedEventIds : [],
    linkedSegmentIds: Array.isArray(fact.linkedSegmentIds) ? fact.linkedSegmentIds : [],
    linkedSourceRefs: Array.isArray(fact.linkedSourceRefs) ? fact.linkedSourceRefs : [],
    entityIds: Array.isArray(fact.entityIds) ? fact.entityIds : []
  }));
}

function readLongMemEvalShortTermMemories(db: DatabaseSync, limit?: number, offset = 0, filters: LongMemEvalDebugFilters = {}): ShortTermMemory[] {
  const filter = buildLongMemEvalShortTermMemoriesWhere(filters);
  return queryLongMemEvalRows<ShortTermMemory>(db, `
    SELECT
      memory_data_id AS memoryDataId,
      memory_data_type AS memoryDataType,
      memory_type AS memoryType,
      content,
      structured_facts AS structuredFacts,
      fact_summary AS factSummary,
      summary,
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
      lifecycle_status AS lifecycleStatus
    FROM short_term_memories
    ${filter.where}
    ORDER BY memory_data_id DESC
    ${limit ? "LIMIT ? OFFSET ?" : ""}
  `, [...filter.params, ...(limit ? [limit, offset] : [])]).map((item) => ({
    ...item,
    memoryType: item.memoryType ?? "fact",
    sourceFactIds: Array.isArray(item.sourceFactIds) ? item.sourceFactIds : [],
    sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs : [],
    entityIds: Array.isArray(item.entityIds) ? item.entityIds : [],
    matchedRules: Array.isArray(item.matchedRules) ? item.matchedRules : []
  }));
}

function readLongMemEvalShortTermMemoriesByFactIds(db: DatabaseSync, factIds: string[]) {
  if (!factIds.length) return [];
  return [];
}

function readLongMemEvalLongTermMemories(db: DatabaseSync, limit?: number, offset = 0, filters: LongMemEvalDebugFilters = {}): ContextDebugSnapshot["longTermMemories"] {
  const filter = buildLongMemEvalLongTermMemoriesWhere(filters);
  return queryLongMemEvalRows<ContextDebugSnapshot["longTermMemories"][number]>(db, `
    SELECT
      memory_id AS memoryId,
      theory_class AS theoryClass,
      memory_type AS memoryType,
      content,
      structured_facts AS structuredFacts,
      fact_summary AS factSummary,
      summary,
      confidence_level AS confidenceLevel,
      recall_weight AS recallWeight,
      retrieval_weight AS retrievalWeight,
      user_retrieval_weight AS userRetrievalWeight,
      solidify_reason AS solidifyReason,
      source_refs AS sourceRefs,
      source_memory_data_ids AS sourceMemoryDataIds,
      entity_ids AS entityIds,
      matched_rules AS matchedRules,
      access_state AS accessState,
      lifecycle_status AS lifecycleStatus
    FROM long_term_memories
    ${filter.where}
    ORDER BY memory_id DESC
    ${limit ? "LIMIT ? OFFSET ?" : ""}
  `, [...filter.params, ...(limit ? [limit, offset] : [])]).map((item) => ({
    ...item,
    sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs : [],
    sourceMemoryDataIds: Array.isArray(item.sourceMemoryDataIds) ? item.sourceMemoryDataIds : [],
    entityIds: Array.isArray(item.entityIds) ? item.entityIds : [],
    matchedRules: Array.isArray(item.matchedRules) ? item.matchedRules : []
  }));
}

function readLongMemEvalDreamingTraces(db: DatabaseSync, limit?: number, offset = 0): ContextDebugSnapshot["llmDreamingTraces"] {
  return queryLongMemEvalRows<ContextDebugSnapshot["llmDreamingTraces"][number]>(db, `
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
      '[]' AS rejectedCandidates,
      fallback_reason AS fallbackReason,
      created_at AS createdAt
    FROM llm_dreaming_traces
    ORDER BY created_at DESC, trace_id DESC
    ${limit ? "LIMIT ? OFFSET ?" : ""}
  `, limit ? [limit, offset] : []);
}

function queryLongMemEvalRows<T>(db: DatabaseSync, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])).map((row) => normalizeLongMemEvalSqliteRow(row as Record<string, unknown>)) as T[];
}

function normalizeLongMemEvalSqliteRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        return [key, JSON.parse(value)] as const;
      } catch {
        return [key, value] as const;
      }
    }
    return [key, value] as const;
  }));
}

async function deleteLongMemEvalStoreFiles(storeDirectory: string) {
  await mkdir(storeDirectory, { recursive: true });
  const deletedFiles: string[] = [];
  const entries = await readdir(storeDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isLongMemEvalSqliteFile(entry.name)) continue;
    const filePath = join(storeDirectory, entry.name);
    await unlink(filePath);
    deletedFiles.push(filePath);
  }
  return deletedFiles.sort();
}

function isLongMemEvalSqliteFile(fileName: string) {
  return (
    fileName.endsWith(".sqlite") ||
    fileName.endsWith(".sqlite-wal") ||
    fileName.endsWith(".sqlite-shm") ||
    fileName.endsWith(".sqlite-journal")
  );
}

export async function createConfiguredLongMemEvalGraphStore(
  config = getContextEngineConfig(),
  options: { initialize?: boolean } = {}
) {
  const mode = readLongMemEvalGraphStoreMode(config);
  if (mode === "local") return undefined;
  const graphStore = config.longMemEval.graphStore.mode === "neo4j"
    ? new Neo4jGraphMemoryStore({
      uri: config.longMemEval.graphStore.neo4j.uri,
      username: config.longMemEval.graphStore.neo4j.username,
      password: config.longMemEval.graphStore.neo4j.password ?? "",
      database: config.longMemEval.graphStore.neo4j.database,
      fulltextIndexName: config.longMemEval.graphStore.neo4j.fulltextIndexName,
      vectorIndexName: config.longMemEval.graphStore.neo4j.vectorIndexName,
      vectorDimensions: config.longMemEval.graphStore.neo4j.vectorDimensions
    })
    : Neo4jGraphMemoryStore.fromConfig(config);
  if (options.initialize !== false) await graphStore.initialize();
  return graphStore;
}

export function readLongMemEvalGraphStoreMode(config: ReturnType<typeof getContextEngineConfig>) {
  return config.longMemEval.graphStore.mode === "inherit"
    ? config.graphStore.mode
    : config.longMemEval.graphStore.mode;
}

function readQuestionId(sample: LongMemEvalSample) {
  return typeof sample.question_id === "string" && sample.question_id.trim() ? sample.question_id.trim() : "unknown";
}

function readQuestionType(sample: LongMemEvalSample) {
  return typeof sample.question_type === "string" && sample.question_type.trim() ? sample.question_type.trim() : "unknown";
}

function readQuestion(sample: LongMemEvalSample) {
  return typeof sample.question === "string" ? sample.question.trim() : "";
}

function readAnswer(sample: LongMemEvalSample) {
  return typeof sample.answer === "string" ? sample.answer.trim() : String(sample.answer ?? "").trim();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeKs(ks?: number[]): number[] {
  const values = (ks?.length ? ks : [1, 5, 10]).filter((k) => Number.isFinite(k) && k > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

function normalizeEvalBatchSize(value: number | undefined) {
  if (!Number.isFinite(value) || value === undefined) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeEvalStageConcurrency(value: number | undefined) {
  return normalizeEvalBatchSize(value);
}

function normalizeIngestSampleConcurrency(value: number | undefined) {
  if (!Number.isFinite(value) || value === undefined) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeIngestSessionConcurrency(value: number | undefined) {
  if (!Number.isFinite(value) || value === undefined) return 1;
  return Math.max(1, Math.floor(value));
}

function countBatches(totalItems: number, batchSize: number) {
  if (totalItems <= 0) return 0;
  return Math.ceil(totalItems / Math.max(1, batchSize));
}

function avg(total: number, count: number) {
  return count > 0 ? total / count : 0;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}
