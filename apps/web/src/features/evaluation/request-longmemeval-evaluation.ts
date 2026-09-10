export interface LongMemEvalSampleReport {
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
  retrieval?: Array<{
    k: number;
    recallAtK: number;
    recallAnyAtK: number;
    recallAllAtK: number;
    precisionAtK: number;
    mrrAtK: number;
    ndcgAtK: number;
  }>;
}

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
  samples?: LongMemEvalSampleReport[];
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
    resultPath?: string;
    tracePath?: string;
    report?: LongMemEvalReport;
    error?: string;
  }>;
}

export type LongMemEvalEvaluationReport = LongMemEvalReport | LongMemEvalMultiModelReport;

export interface LongMemEvalJobSnapshot {
  jobId: string;
  datasetPath: string;
  ks: number[];
  status: "queued" | "running" | "done" | "error" | "cancelled";
  stage?: "ingest" | "timeline_aggregation" | "stm" | "ltm" | "answer" | "judge" | "result_commit";
  ingestStage?: "save_event" | "parse" | "fact" | "stm" | "finalize";
  stageProgress?: number;
  stageMessage?: string;
  batchIndex?: number;
  batchCount?: number;
  batchProgress?: number;
  batchMessage?: string;
  totalSamples?: number;
  processedSamples?: number;
  processedSessions?: number;
  totalSessions?: number;
  processedSteps?: number;
  totalSteps?: number;
  progress?: number;
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
  activeSamples?: Array<{
    sampleIndex: number;
    questionId: string;
    questionType: string;
    contextScopeId: string;
    modelRunId: string;
    storeNamespace: string;
    stage: "ingestion" | "stm_admission" | "timeline_aggregation" | "ltm" | "answer" | "judge" | "result_commit";
    status: "started" | "succeeded" | "failed" | "skipped";
    updatedAt: string;
  }>;
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
  answerContextMode?: "context_pack" | "retrieval";
  ingestSampleConcurrency?: number;
  ingestSessionConcurrency?: number;
  answerConcurrency?: number;
  judgeConcurrency?: number;
  resultPath?: string;
  tracePath?: string;
  resume?: boolean;
  retrySkipped?: boolean;
  resumeLegacy?: boolean;
  resumedSamples?: number;
  committedSamples?: number;
  modelArtifacts?: Array<{ modelRunId: string; resultPath?: string; tracePath?: string }>;
  effectiveConcurrency?: {
    model: number;
    sample: number;
    session: number;
    answer: number;
    judge: number;
  };
  disableIngestLlm?: boolean;
  allowLlmFallback?: boolean;
  skipStmAdmission?: boolean;
  skipLtmDreaming?: boolean;
  modelOnlyEvaluation?: boolean;
  answerOnlyEvaluation?: boolean;
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
}

export interface LongMemEvalEvaluationResponse {
  ok?: boolean;
  result?: LongMemEvalJobSnapshot;
  error?: string;
}

export interface LongMemEvalSamplePage {
  jobId: string;
  datasetPath: string;
  totalSamples: number;
  page: number;
  pageSize: number;
  totalPages: number;
  samples: LongMemEvalSampleReport[];
}

export interface LongMemEvalSamplePageResponse {
  ok?: boolean;
  result?: LongMemEvalSamplePage;
  error?: string;
}

export interface LongMemEvalJsonlResultItem {
  lineNumber: number;
  sampleIndex?: number;
  runId?: string;
  modelRunId?: string;
  status?: string;
  completedAt?: string;
  datasetPath?: string;
  questionId: string;
  questionType: string;
  question: string;
  answer: string;
  hypothesis: string;
  correct?: boolean;
  exactMatch?: boolean;
  score?: number;
  reason?: string;
  errorReason?: string;
  answerFallbackUsed?: boolean;
  answerFallbackReason?: string;
  selectedItemCount: number;
  selectedItemIds: string[];
  selectedItems: LongMemEvalSelectedEvidence[];
  droppedReasons: Record<string, number>;
  answerContextMode?: string;
  tokenBudget?: {
    requested?: number;
    used?: number;
  };
  failureClassification?: {
    stage: string;
    basis?: string;
    detail?: string;
  };
}

export interface LongMemEvalSelectedEvidence {
  id: string;
  layer: "fact" | "stm" | "ltm" | string;
  score?: number;
  sourceIds: string[];
  sourceSessionIds: string[];
  sourceRoles: string[];
  factIds: string[];
  memoryIds: string[];
  relationTypes: string[];
  evidenceTime?: string;
  validTime?: string;
}

export interface LongMemEvalJsonlResultSummary {
  filePath: string;
  datasetPath?: string;
  totalItems: number;
  judgedItems: number;
  correctItems: number;
  incorrectItems: number;
  accuracy?: number;
  exactMatchItems: number;
  exactMatchAccuracy?: number;
  answerFallbacks: number;
  ignoredIncompleteTail: boolean;
  modelGroups: Record<string, {
    modelRunId: string;
    totalItems: number;
    judgedItems: number;
    correctItems: number;
    accuracy?: number;
  }>;
  questionTypeAccuracy: Record<string, {
    total: number;
    judged: number;
    correct: number;
    accuracy?: number;
  }>;
  errorReasons: Record<string, number>;
  selection: {
    rowsWithSelection: number;
    totalSelectedItems: number;
    droppedReasons: Record<string, number>;
  };
}

export interface LongMemEvalJsonlResultPage {
  summary: LongMemEvalJsonlResultSummary;
  page: number;
  pageSize: number;
  totalPages: number;
  items: LongMemEvalJsonlResultItem[];
  allItems?: LongMemEvalJsonlResultItem[];
}

export interface LongMemEvalSelectedItemDetail {
  id: string;
  layer: "fact" | "stm" | "ltm";
  content: string;
  summary?: string;
  compressedContent?: string;
  sourceSegments?: Array<{
    segmentId: string;
    eventId: string;
    eventTime?: string;
    sourceId?: string;
    content: string;
  }>;
  metadata: Record<string, unknown>;
}

export interface LongMemEvalSelectedItemDetailResponse {
  ok?: boolean;
  result?: {
    datasetPath: string;
    questionId: string;
    question: string;
    selectedItemIds: string[];
    items: LongMemEvalSelectedItemDetail[];
    missingItemIds: string[];
  };
  error?: string;
}

export interface LongMemEvalJsonlResultPageResponse {
  ok?: boolean;
  result?: LongMemEvalJsonlResultPage;
  error?: string;
}

export interface LongMemEvalDatabaseClearResponse {
  ok?: boolean;
  result?: {
    storage: {
      storeDirectory: string;
      deletedFiles: string[];
    };
    graphStore: {
      status: "cleared" | "skipped";
      mode: "inherit" | "local" | "neo4j";
      database?: string;
      reason?: string;
    };
  };
  error?: string;
}

export const DEFAULT_LONGMEMEVAL_RESULT_FILE_NAME = "longmemeval-result.jsonl";

export interface LongMemEvalLlmTestSettings {
  extractionBaseUrl: string;
  extractionModel: string;
  extractionApiKey: string;
  answerBaseUrl?: string;
  answerModel?: string;
  answerApiKey?: string;
  judgeBaseUrl: string;
  judgeModel: string;
  judgeApiKey: string;
}

export type LongMemEvalLlmTestTarget = "extraction" | "judge" | "ingest" | "answer";

export function buildLongMemEvalLlmTestPayload(settings: LongMemEvalLlmTestSettings, target: LongMemEvalLlmTestTarget) {
  const baseUrl = target === "judge"
    ? settings.judgeBaseUrl.trim() || settings.extractionBaseUrl.trim()
    : target === "answer" ? settings.answerBaseUrl?.trim() || settings.extractionBaseUrl.trim()
    : settings.extractionBaseUrl.trim();
  const model = target === "judge"
    ? settings.judgeModel.trim() || settings.extractionModel.trim()
    : target === "answer" ? settings.answerModel?.trim() || settings.extractionModel.trim()
    : settings.extractionModel.trim();
  const apiKey = target === "judge"
    ? settings.judgeApiKey.trim() || settings.extractionApiKey.trim()
    : target === "answer" ? settings.answerApiKey?.trim() || settings.extractionApiKey.trim()
    : settings.extractionApiKey.trim();
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {})
  };
}

export async function requestLongMemEvalEvaluation(
  fetchImpl: typeof fetch = fetch,
  payload: {
    datasetPath: string;
    ks: number[];
    diagnosticsPath?: string;
    resultFileName?: string;
    traceFileName?: string;
    resume?: boolean;
    retrySkipped?: boolean;
    resumeLegacy?: boolean;
    llm?: {
      extraction?: { baseUrl?: string; model?: string; apiKey?: string };
      judge?: { baseUrl?: string; model?: string; apiKey?: string };
    };
    llmRuns?: Array<{
      runId?: string;
      id?: string;
      label?: string;
      diagnosticsPath?: string;
      tracePath?: string;
      llm?: {
        extraction?: { baseUrl?: string; model?: string; apiKey?: string };
        judge?: { baseUrl?: string; model?: string; apiKey?: string };
      };
      extraction?: { baseUrl?: string; model?: string; apiKey?: string };
      judge?: { baseUrl?: string; model?: string; apiKey?: string };
    }>;
    modelConcurrency?: number;
    evalBatchSize?: number;
    answerConcurrency?: number;
    judgeConcurrency?: number;
    ingestSampleConcurrency?: number;
    ingestSessionConcurrency?: number;
    logIngestRequestContext?: boolean;
    enableLtmReinforcement?: boolean;
    answerContextMode?: "context_pack" | "retrieval";
    disableIngestLlm?: boolean;
    allowLlmFallback?: boolean;
    skipStmAdmission?: boolean;
    skipLtmDreaming?: boolean;
    modelOnlyEvaluation?: boolean;
    answerOnlyEvaluation?: boolean;
  }
): Promise<LongMemEvalEvaluationResponse> {
  try {
    const response = await fetchImpl("/context/evaluations/longmemeval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        ...(!payload.diagnosticsPath ? { resultFileName: payload.resultFileName ?? DEFAULT_LONGMEMEVAL_RESULT_FILE_NAME } : {})
      })
    });
    return (await response.json()) as LongMemEvalEvaluationResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LongMemEval evaluation request failed"
    };
  }
}

export async function requestLongMemEvalJob(
  fetchImpl: typeof fetch = fetch,
  jobId: string
): Promise<LongMemEvalEvaluationResponse> {
  try {
    const response = await fetchImpl(`/context/evaluations/longmemeval/${encodeURIComponent(jobId)}`);
    return (await response.json()) as LongMemEvalEvaluationResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LongMemEval job request failed"
    };
  }
}

export async function requestLongMemEvalSamples(
  fetchImpl: typeof fetch = fetch,
  jobId: string,
  page: number,
  pageSize: number
): Promise<LongMemEvalSamplePageResponse> {
  try {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize)
    });
    const response = await fetchImpl(`/context/evaluations/longmemeval/${encodeURIComponent(jobId)}/samples?${params.toString()}`);
    return (await response.json()) as LongMemEvalSamplePageResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LongMemEval samples request failed"
    };
  }
}

export async function requestLongMemEvalJsonlResults(
  fetchImpl: typeof fetch = fetch,
  filePath: string,
  page: number,
  pageSize: number
): Promise<LongMemEvalJsonlResultPageResponse> {
  try {
    const params = new URLSearchParams({
      path: filePath,
      page: String(page),
      pageSize: String(pageSize)
    });
    const response = await fetchImpl(`/context/evaluations/longmemeval/jsonl-results?${params.toString()}`);
    return (await response.json()) as LongMemEvalJsonlResultPageResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LongMemEval JSONL result request failed"
    };
  }
}

export async function requestLongMemEvalJobResults(
  fetchImpl: typeof fetch = fetch,
  jobId: string,
  page: number,
  pageSize: number,
  modelRunId?: string
): Promise<LongMemEvalJsonlResultPageResponse> {
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (modelRunId) params.set("modelRunId", modelRunId);
    const response = await fetchImpl(`/context/evaluations/longmemeval/${encodeURIComponent(jobId)}/results?${params.toString()}`);
    return (await response.json()) as LongMemEvalJsonlResultPageResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LongMemEval job results request failed"
    };
  }
}

export async function requestLongMemEvalSelectedItemDetails(
  fetchImpl: typeof fetch = fetch,
  datasetPath: string,
  questionId: string,
  selectedItemIds: string[]
): Promise<LongMemEvalSelectedItemDetailResponse> {
  try {
    const response = await fetchImpl("/context/evaluations/longmemeval/selected-items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetPath, questionId, selectedItemIds })
    });
    return (await response.json()) as LongMemEvalSelectedItemDetailResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LongMemEval selected item request failed"
    };
  }
}

export async function requestCancelLongMemEvalJob(
  fetchImpl: typeof fetch = fetch,
  jobId: string
): Promise<LongMemEvalEvaluationResponse> {
  try {
    const response = await fetchImpl(`/context/evaluations/longmemeval/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST"
    });
    return (await response.json()) as LongMemEvalEvaluationResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LongMemEval cancel request failed"
    };
  }
}

export async function requestClearLongMemEvalDatabase(
  fetchImpl: typeof fetch = fetch
): Promise<LongMemEvalDatabaseClearResponse> {
  try {
    const response = await fetchImpl("/context/evaluations/longmemeval/database", {
      method: "DELETE"
    });
    return (await response.json()) as LongMemEvalDatabaseClearResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LongMemEval database clear request failed"
    };
  }
}
