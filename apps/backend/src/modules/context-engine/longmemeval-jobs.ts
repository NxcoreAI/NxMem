import type { FastifyBaseLogger } from "fastify";
import {
  countLongMemEvalSamples,
  evaluateLongMemEvalDataset,
  evaluateLongMemEvalModelRuns,
  resolveLongMemEvalModelRunArtifacts,
  type LongMemEvalActiveSample,
  type LongMemEvalAnswerContextMode,
  type LongMemEvalEvaluationReport,
  type LongMemEvalLlmRequestProgress,
  type LongMemEvalLlmRunOptions,
  type LongMemEvalProgress,
} from "./longmemeval.js";
import { longMemEvalArtifactStore } from "./longmemeval-artifacts.js";

export interface LongMemEvalJobSnapshot {
  jobId: string;
  datasetPath: string;
  ks: number[];
  llm?: {
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
  };
  llmRuns?: LongMemEvalLlmRunOptions[];
  modelConcurrency?: number;
  ingestSampleConcurrency?: number;
  ingestSessionConcurrency?: number;
  logIngestRequestContext?: boolean;
  enableLtmReinforcement?: boolean;
  evalBatchSize?: number;
  answerConcurrency?: number;
  judgeConcurrency?: number;
  diagnosticsPath?: string;
  tracePath?: string;
  resultPath?: string;
  modelArtifacts?: Array<{ modelRunId: string; resultPath?: string; tracePath?: string }>;
  resume?: boolean;
  retrySkipped?: boolean;
  resumeLegacy?: boolean;
  resumedSamples?: number;
  committedSamples?: number;
  effectiveConcurrency?: {
    model: number;
    sample: number;
    session: number;
    answer: number;
    judge: number;
  };
  answerContextMode?: LongMemEvalAnswerContextMode;
  disableIngestLlm?: boolean;
  allowLlmFallback?: boolean;
  skipStmAdmission?: boolean;
  skipLtmDreaming?: boolean;
  modelOnlyEvaluation?: boolean;
  answerOnlyEvaluation?: boolean;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  totalSamples?: number;
  processedSamples?: number;
  processedSessions?: number;
  totalSessions?: number;
  processedSteps?: number;
  totalSteps?: number;
  progress?: number;
  ingestStage?: "save_event" | "parse" | "fact" | "stm" | "finalize" | "pipeline_wait";
  questionTypeCounts?: Record<string, number>;
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
  batchIndex?: number;
  batchCount?: number;
  batchProgress?: number;
  batchMessage?: string;
  report?: LongMemEvalEvaluationReport;
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
  startedAt?: string;
  finishedAt?: string;
  stage?: "ingest" | "timeline_aggregation" | "stm" | "ltm" | "answer" | "judge" | "result_commit";
  stageProgress?: number;
  stageMessage?: string;
  llmRequest?: LongMemEvalLlmRequestProgress;
  activeSamples?: LongMemEvalActiveSample[];
}

interface LongMemEvalJobState extends LongMemEvalJobSnapshot {
  settled: boolean;
  cancelRequested?: boolean;
  modelRecoveryCounts: Map<string, { resumedSamples: number; committedSamples: number }>;
  modelActiveSamples: Map<string, LongMemEvalActiveSample[]>;
  abortController: AbortController;
}

type LongMemEvalJobLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error" | "debug">;

const jobs = new Map<string, LongMemEvalJobState>();

export function getLongMemEvalJob(jobId: string): LongMemEvalJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  return stripJobState(job);
}

export function cancelLongMemEvalJob(jobId: string, logger?: LongMemEvalJobLogger): LongMemEvalJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    return stripJobState(job);
  }
  job.cancelRequested = true;
  job.abortController.abort();
  job.status = "cancelled";
  job.error = "LongMemEval evaluation cancelled";
  job.finishedAt = new Date().toISOString();
  logger?.warn({ jobId, datasetPath: job.datasetPath }, "longmemeval job cancellation requested");
  return stripJobState(job);
}

export function createLongMemEvalJob(
  input: {
    datasetPath: string;
    ks: number[];
    llm?: LongMemEvalJobSnapshot["llm"];
    llmRuns?: LongMemEvalLlmRunOptions[];
    modelConcurrency?: number;
    ingestSampleConcurrency?: number;
    ingestSessionConcurrency?: number;
    logIngestRequestContext?: boolean;
    enableLtmReinforcement?: boolean;
    evalBatchSize?: number;
    answerConcurrency?: number;
    judgeConcurrency?: number;
    diagnosticsPath?: string;
    resultBasename?: string;
    traceBasename?: string;
    resume?: boolean;
    retrySkipped?: boolean;
    resumeLegacy?: boolean;
    answerContextMode?: LongMemEvalAnswerContextMode;
    disableIngestLlm?: boolean;
    allowLlmFallback?: boolean;
    skipStmAdmission?: boolean;
    skipLtmDreaming?: boolean;
    modelOnlyEvaluation?: boolean;
    answerOnlyEvaluation?: boolean;
  },
  logger?: LongMemEvalJobLogger
): LongMemEvalJobSnapshot {
  const jobId = `longmemeval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const artifactPaths = longMemEvalArtifactStore.resolvePaths({
    ...(input.resultBasename ? { resultBasename: input.resultBasename } : {}),
    ...(input.traceBasename ? { traceBasename: input.traceBasename } : {}),
    runId: jobId
  });
  const diagnosticsPath = input.diagnosticsPath ?? artifactPaths.resultPath;
  longMemEvalArtifactStore.assertManagedPath(diagnosticsPath);
  const tracePath = artifactPaths.tracePath;
  const modelArtifacts = input.llmRuns?.length
    ? resolveLongMemEvalModelRunArtifacts(input.llmRuns, { resultPath: diagnosticsPath, tracePath })
    : undefined;
  for (const artifact of modelArtifacts ?? []) {
    if (artifact.resultPath) longMemEvalArtifactStore.assertManagedPath(artifact.resultPath);
    if (artifact.tracePath) longMemEvalArtifactStore.assertManagedPath(artifact.tracePath);
  }
  const modelRunCount = input.llmRuns?.length ?? 0;
  const modelConcurrency = modelRunCount > 0
    ? Math.min(normalizeJobConcurrency(input.modelConcurrency, Math.min(4, modelRunCount)), modelRunCount)
    : 1;
  const ingestSampleConcurrency = normalizeJobConcurrency(input.ingestSampleConcurrency, 1);
  const ingestSessionConcurrency = normalizeJobConcurrency(input.ingestSessionConcurrency, 1);
  const answerConcurrency = normalizeJobConcurrency(input.answerConcurrency ?? input.evalBatchSize, 1);
  const judgeConcurrency = normalizeJobConcurrency(input.judgeConcurrency ?? input.evalBatchSize, 1);
  const startedAt = new Date().toISOString();
  const job: LongMemEvalJobState = {
    jobId,
    datasetPath: input.datasetPath,
    ks: input.ks,
    ...(input.llm ? { llm: input.llm } : {}),
    ...(input.llmRuns?.length ? { llmRuns: input.llmRuns } : {}),
    modelConcurrency,
    ingestSampleConcurrency,
    ingestSessionConcurrency,
    ...(input.logIngestRequestContext !== undefined ? { logIngestRequestContext: input.logIngestRequestContext } : {}),
    ...(input.enableLtmReinforcement !== undefined ? { enableLtmReinforcement: input.enableLtmReinforcement } : {}),
    ...(input.evalBatchSize !== undefined ? { evalBatchSize: input.evalBatchSize } : {}),
    answerConcurrency,
    judgeConcurrency,
    diagnosticsPath,
    tracePath,
    resultPath: diagnosticsPath,
    ...(modelArtifacts ? { modelArtifacts } : {}),
    resume: input.resume === true,
    retrySkipped: input.retrySkipped === true,
    resumeLegacy: input.resumeLegacy === true,
    resumedSamples: 0,
    committedSamples: 0,
    effectiveConcurrency: {
      model: modelConcurrency,
      sample: ingestSampleConcurrency,
      session: ingestSessionConcurrency,
      answer: answerConcurrency,
      judge: judgeConcurrency
    },
    answerContextMode: input.answerContextMode ?? "context_pack",
    ...(input.disableIngestLlm !== undefined ? { disableIngestLlm: input.disableIngestLlm } : {}),
    allowLlmFallback: input.allowLlmFallback !== false,
    ...(input.skipStmAdmission !== undefined ? { skipStmAdmission: input.skipStmAdmission } : {}),
    ...(input.skipLtmDreaming !== undefined ? { skipLtmDreaming: input.skipLtmDreaming } : {}),
    ...(input.modelOnlyEvaluation !== undefined ? { modelOnlyEvaluation: input.modelOnlyEvaluation } : {}),
    ...(input.answerOnlyEvaluation !== undefined ? { answerOnlyEvaluation: input.answerOnlyEvaluation } : {}),
    status: "queued",
    stage: "ingest",
    progress: 0,
    stageProgress: 0,
    stageMessage: "queued_waiting_to_start",
    startedAt,
    settled: false,
    modelRecoveryCounts: new Map(),
    modelActiveSamples: new Map(),
    abortController: new AbortController()
  };
  jobs.set(jobId, job);
  logger?.info({ jobId, datasetPath: input.datasetPath, ks: input.ks }, "longmemeval job queued");
  void runLongMemEvalJob(
    jobId,
    input.datasetPath,
    input.ks,
    input.llm,
    input.llmRuns,
    modelConcurrency,
    ingestSampleConcurrency,
    ingestSessionConcurrency,
    input.logIngestRequestContext,
    input.enableLtmReinforcement,
    input.evalBatchSize,
    answerConcurrency,
    judgeConcurrency,
    diagnosticsPath,
    tracePath,
    input.resume === true,
    input.retrySkipped === true,
    input.resumeLegacy === true,
    input.answerContextMode,
    input.disableIngestLlm,
    input.allowLlmFallback !== false,
    input.skipStmAdmission,
    input.skipLtmDreaming,
    input.modelOnlyEvaluation,
    input.answerOnlyEvaluation,
    logger
  );
  return stripJobState(job);
}

async function runLongMemEvalJob(
  jobId: string,
  datasetPath: string,
  ks: number[],
  llm: LongMemEvalJobSnapshot["llm"],
  llmRuns: LongMemEvalLlmRunOptions[] | undefined,
  modelConcurrency: number | undefined,
  ingestSampleConcurrency: number | undefined,
  ingestSessionConcurrency: number | undefined,
  logIngestRequestContext: boolean | undefined,
  enableLtmReinforcement: boolean | undefined,
  evalBatchSize: number | undefined,
  answerConcurrency: number | undefined,
  judgeConcurrency: number | undefined,
  diagnosticsPath: string | undefined,
  tracePath: string | undefined,
  resume: boolean,
  retrySkipped: boolean,
  resumeLegacy: boolean,
  answerContextMode: LongMemEvalAnswerContextMode | undefined,
  disableIngestLlm: boolean | undefined,
  allowLlmFallback: boolean,
  skipStmAdmission: boolean | undefined,
  skipLtmDreaming: boolean | undefined,
  modelOnlyEvaluation: boolean | undefined,
  answerOnlyEvaluation: boolean | undefined,
  logger?: LongMemEvalJobLogger
) {
  const job = jobs.get(jobId);
  if (!job) return;
  const startedAt = Date.now();

  try {
    if (job.cancelRequested || job.abortController.signal.aborted) {
      throw new LongMemEvalJobCancelledError();
    }
    job.status = "running";
    job.stage = "ingest";
    job.progress = 1;
    job.stageProgress = 1;
    job.stageMessage = "counting_samples";
    job.totalSamples = await countLongMemEvalSamples(datasetPath);
    if (job.cancelRequested || job.abortController.signal.aborted) {
      throw new LongMemEvalJobCancelledError();
    }
    job.stageMessage = "initializing_evaluation_store";
    logger?.info({ jobId, datasetPath, totalSamples: job.totalSamples, ks }, "longmemeval job started");
    const report = llmRuns?.length
      ? await evaluateLongMemEvalModelRuns(datasetPath, {
          ks,
          llmRuns,
          ...(modelConcurrency ? { modelConcurrency } : {}),
          ...(ingestSampleConcurrency ? { ingestSampleConcurrency } : {}),
          ...(ingestSessionConcurrency ? { ingestSessionConcurrency } : {}),
          ...(logIngestRequestContext ? { logIngestRequestContext } : {}),
          ...(enableLtmReinforcement ? { enableLtmReinforcement } : {}),
          ...(evalBatchSize ? { evalBatchSize } : {}),
          ...(answerConcurrency ? { answerConcurrency } : {}),
          ...(judgeConcurrency ? { judgeConcurrency } : {}),
          ...(diagnosticsPath ? { diagnosticsPath } : {}),
          ...(tracePath ? { tracePath } : {}),
          runId: jobId,
          resume,
          retrySkipped,
          resumeLegacy,
          answerContextMode: answerContextMode ?? "context_pack",
          allowLlmFallback,
          ...(disableIngestLlm ? { disableIngestLlm } : {}),
          ...(skipStmAdmission ? { skipStmAdmission } : {}),
          ...(skipLtmDreaming ? { skipLtmDreaming } : {}),
          ...(modelOnlyEvaluation ? { modelOnlyEvaluation } : {}),
          ...(answerOnlyEvaluation ? { answerOnlyEvaluation } : {}),
          signal: job.abortController.signal,
          onProgress: (progress) => updateLongMemEvalJob(jobId, progress, logger),
          ...(logger ? { logger } : {})
        })
      : await evaluateLongMemEvalDataset(datasetPath, {
          ks,
          ...(llm ? { llm } : {}),
          ...(logIngestRequestContext ? { logIngestRequestContext } : {}),
          ...(enableLtmReinforcement ? { enableLtmReinforcement } : {}),
          ...(evalBatchSize ? { evalBatchSize } : {}),
          ...(answerConcurrency ? { answerConcurrency } : {}),
          ...(judgeConcurrency ? { judgeConcurrency } : {}),
          ...(ingestSampleConcurrency ? { ingestSampleConcurrency } : {}),
          ...(ingestSessionConcurrency ? { ingestSessionConcurrency } : {}),
          ...(diagnosticsPath ? { diagnosticsPath } : {}),
          ...(tracePath ? { tracePath } : {}),
          runId: jobId,
          resume,
          retrySkipped,
          resumeLegacy,
          answerContextMode: answerContextMode ?? "context_pack",
          allowLlmFallback,
          ...(disableIngestLlm ? { disableIngestLlm } : {}),
          ...(skipStmAdmission ? { skipStmAdmission } : {}),
          ...(skipLtmDreaming ? { skipLtmDreaming } : {}),
          ...(modelOnlyEvaluation ? { modelOnlyEvaluation } : {}),
          ...(answerOnlyEvaluation ? { answerOnlyEvaluation } : {}),
          signal: job.abortController.signal,
          onProgress: (progress) => updateLongMemEvalJob(jobId, progress, logger)
        });
    const current = jobs.get(jobId);
    if (!current) return;
    if (current.cancelRequested || current.status === "cancelled") {
      current.status = "cancelled";
      current.error = "LongMemEval evaluation cancelled";
      current.finishedAt = current.finishedAt ?? new Date().toISOString();
      current.settled = true;
      logger?.warn({ jobId, datasetPath, ks, elapsedMs: Date.now() - startedAt }, "longmemeval job cancelled");
      return;
    }
    current.report = report;
    if ("runs" in report) {
      current.modelArtifacts = report.runs.map((run) => ({
        modelRunId: run.runId,
        ...(run.resultPath ? { resultPath: run.resultPath } : {}),
        ...(run.tracePath ? { tracePath: run.tracePath } : {})
      }));
    }
    const recovery = readLongMemEvalReportRecovery(report);
    current.resumedSamples = recovery.resumedSamples;
    current.committedSamples = recovery.committedSamples;
    current.status = "done";
    current.finishedAt = new Date().toISOString();
    current.progress = 100;
    current.processedSamples = report.totalSamples;
    current.questionTypeCounts = report.questionTypeCounts;
    current.settled = true;
    logger?.info(
      {
        jobId,
        datasetPath,
        ks,
        totalSamples: report.totalSamples,
        elapsedMs: Date.now() - startedAt
      },
      "longmemeval job completed"
    );
  } catch (error) {
    const current = jobs.get(jobId);
    if (!current) return;
    if (current.cancelRequested || error instanceof LongMemEvalJobCancelledError) {
      current.status = "cancelled";
      current.error = "LongMemEval evaluation cancelled";
      current.finishedAt = current.finishedAt ?? new Date().toISOString();
      current.settled = true;
      logger?.warn({ jobId, datasetPath, ks, elapsedMs: Date.now() - startedAt }, "longmemeval job cancelled");
      return;
    }
    current.status = "error";
    const errorMessage = error instanceof Error ? error.message : "LongMemEval evaluation failed";
    current.error = errorMessage;
    const fallbackReason = readLongMemEvalFallbackReason(errorMessage);
    if (fallbackReason) current.fallbackReason = fallbackReason;
    const fallbackTrace = readFactFusionFallbackTrace(error);
    if (fallbackTrace) current.fallbackTrace = fallbackTrace;
    current.finishedAt = new Date().toISOString();
    current.settled = true;
    logger?.error(
      {
        jobId,
        datasetPath,
        ks,
        error: error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack
            }
          : error
      },
      "longmemeval job failed"
    );
  }
}

function readLongMemEvalReportRecovery(report: LongMemEvalEvaluationReport) {
  if (!("runs" in report)) {
    return {
      resumedSamples: report.recovery?.resumedSamples ?? 0,
      committedSamples: report.recovery?.committedSamples ?? 0
    };
  }
  return report.runs.reduce((total, run) => ({
    resumedSamples: total.resumedSamples + (run.report?.recovery?.resumedSamples ?? 0),
    committedSamples: total.committedSamples + (run.report?.recovery?.committedSamples ?? 0)
  }), { resumedSamples: 0, committedSamples: 0 });
}

function normalizeJobConcurrency(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function readLongMemEvalFallbackReason(message: string) {
  const prefixes = [
    "fact_fusion_fallback:",
    "stm_admission_fallback:",
    "ltm_dreaming_fallback:",
    "answer_fallback:",
    "judge_fallback:"
  ];
  const prefix = prefixes.find((candidate) => message.startsWith(candidate));
  return prefix ? message.slice(prefix.length).trim() : undefined;
}

function readFactFusionFallbackTrace(error: unknown): LongMemEvalJobSnapshot["fallbackTrace"] | undefined {
  if (!error || typeof error !== "object" || !("trace" in error)) return undefined;
  const trace = (error as { trace?: unknown }).trace;
  if (!trace || typeof trace !== "object") return undefined;
  const item = trace as {
    traceId?: unknown;
    eventId?: unknown;
    prompt?: unknown;
    rawResponse?: unknown;
    parsedFacts?: unknown;
    rejectedSegments?: unknown;
  };
  if (typeof item.traceId !== "string" || typeof item.eventId !== "string" || typeof item.prompt !== "string") {
    return undefined;
  }
  return {
    traceId: item.traceId,
    eventId: item.eventId,
    prompt: item.prompt,
    ...(item.rawResponse !== undefined ? { rawResponse: item.rawResponse } : {}),
    ...(Array.isArray(item.parsedFacts) ? { parsedFacts: item.parsedFacts } : {}),
    ...(Array.isArray(item.rejectedSegments) ? { rejectedSegments: item.rejectedSegments.map((rejected) => {
      const row = rejected && typeof rejected === "object" ? rejected as { segmentId?: unknown; reason?: unknown } : {};
      return {
        segmentId: typeof row.segmentId === "string" ? row.segmentId : "unknown",
        reason: typeof row.reason === "string" ? row.reason : "unknown"
      };
    }) } : {})
  };
}

function updateLongMemEvalJob(jobId: string, progress: LongMemEvalProgress, logger?: LongMemEvalJobLogger) {
  const job = jobs.get(jobId);
  if (!job || job.settled) return;
  if (job.cancelRequested || job.status === "cancelled") {
    throw new LongMemEvalJobCancelledError();
  }
  job.status = "running";
  job.stage = progress.stage;
  job.processedSamples = Math.max(job.processedSamples ?? 0, progress.processedSamples);
  const progressModelRunId = progress.modelRunId ?? "default";
  job.modelRecoveryCounts.set(progressModelRunId, {
    resumedSamples: progress.resumedSamples,
    committedSamples: progress.committedSamples
  });
  job.resumedSamples = [...job.modelRecoveryCounts.values()].reduce((total, value) => total + value.resumedSamples, 0);
  job.committedSamples = [...job.modelRecoveryCounts.values()].reduce((total, value) => total + value.committedSamples, 0);
  job.questionTypeCounts = progress.questionTypeCounts;
  job.processedSessions = progress.processedSessions;
  job.totalSessions = progress.totalSessions;
  job.processedSteps = progress.processedSteps;
  job.totalSteps = progress.totalSteps;
  job.modelActiveSamples.set(progressModelRunId, progress.activeSamples);
  job.activeSamples = [...job.modelActiveSamples.values()]
    .flat()
    .sort((left, right) => left.modelRunId.localeCompare(right.modelRunId) || left.sampleIndex - right.sampleIndex);
  const movedToAnotherSample = (
    progress.currentSampleIndex !== undefined &&
    job.currentSampleIndex !== undefined &&
    progress.currentSampleIndex !== job.currentSampleIndex
  ) || (
    progress.currentQuestionId !== undefined &&
    job.currentQuestionId !== undefined &&
    progress.currentQuestionId !== job.currentQuestionId
  );
  if (movedToAnotherSample && progress.llmRequest === undefined) {
    delete job.llmRequest;
  }
  assignIfDefined(job, "currentQuestionId", progress.currentQuestionId);
  assignIfDefined(job, "currentQuestionType", progress.currentQuestionType);
  assignIfDefined(job, "currentQuestion", progress.currentQuestion);
  assignIfDefined(job, "currentSampleIndex", progress.currentSampleIndex);
  assignIfDefined(job, "currentSampleCount", progress.currentSampleCount);
  assignIfDefined(job, "currentSessionIndex", progress.currentSessionIndex);
  assignIfDefined(job, "currentSessionCount", progress.currentSessionCount);
  assignIfDefined(job, "currentSessionId", progress.currentSessionId);
  assignIfDefined(job, "currentSessionDate", progress.currentSessionDate);
  assignIfDefined(job, "currentHypothesis", progress.currentHypothesis);
  assignIfDefined(job, "currentJudgment", progress.currentJudgment);
  assignIfDefined(job, "batchIndex", progress.batchIndex);
  assignIfDefined(job, "batchCount", progress.batchCount);
  assignIfDefined(job, "batchProgress", progress.batchProgress);
  assignIfDefined(job, "batchMessage", progress.batchMessage);
  if (progress.ingestStage !== undefined) {
    job.ingestStage = progress.ingestStage;
  }
  assignIfDefined(job, "stageProgress", progress.stageProgress);
  assignIfDefined(job, "stageMessage", compactLongMemEvalProgressText(progress.stageMessage));
  assignIfDefined(job, "llmRequest", progress.llmRequest);
  const nextProgress = job.totalSteps && job.totalSteps > 0
    ? Math.min(100, Number(((progress.processedSteps / job.totalSteps) * 100).toFixed(1)))
    : undefined;
  if (typeof nextProgress === "number") {
    job.progress = Math.max(job.progress ?? 0, nextProgress);
  }
  const progressStageMessage = compactLongMemEvalProgressText(progress.stageMessage);
  const isDuplicateIngestReuse = progressStageMessage === "haystack session 事件已存在，跳过入库";
  if (
    !isDuplicateIngestReuse && (
      progress.processedSteps === 1 ||
      (typeof job.totalSteps === "number" && progress.processedSteps === job.totalSteps) ||
      progress.processedSteps % 50 === 0 ||
      (progress.ingestStage === "finalize" && typeof progress.stageProgress === "number")
    )
  ) {
    logger?.info(
      {
        jobId,
        processedSamples: progress.processedSamples,
        totalSamples: job.totalSamples,
        processedSessions: progress.processedSessions,
        totalSessions: progress.totalSessions,
        processedSteps: progress.processedSteps,
        totalSteps: progress.totalSteps,
        progress: job.progress,
        currentQuestionId: progress.currentQuestionId,
        currentQuestionType: progress.currentQuestionType,
        currentSampleIndex: progress.currentSampleIndex,
        currentSampleCount: progress.currentSampleCount,
        currentSessionIndex: progress.currentSessionIndex,
        currentSessionCount: progress.currentSessionCount,
        currentSessionId: progress.currentSessionId,
        currentSessionDate: progress.currentSessionDate,
        ingestStage: progress.ingestStage,
        stageProgress: progress.stageProgress,
        stageMessage: progressStageMessage
      },
      "longmemeval job progress"
    );
  }
}

function compactLongMemEvalProgressText(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 500) return normalized;
  return `${normalized.slice(0, 499).trim()}…`;
}

function stripJobState(job: LongMemEvalJobState): LongMemEvalJobSnapshot {
  const {
    settled: _settled,
    cancelRequested: _cancelRequested,
    modelRecoveryCounts: _modelRecoveryCounts,
    modelActiveSamples: _modelActiveSamples,
    abortController: _abortController,
    ...snapshot
  } = job;
  return snapshot;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}

class LongMemEvalJobCancelledError extends Error {
  constructor() {
    super("LongMemEval evaluation cancelled");
    this.name = "LongMemEvalJobCancelledError";
  }
}
