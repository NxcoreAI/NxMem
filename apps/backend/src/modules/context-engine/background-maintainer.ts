import { createHash, randomUUID } from "node:crypto";
import type {
  BackgroundAnalysisConflict,
  BackgroundContextDocument,
  BackgroundMaintenanceBatch,
  BackgroundMaintenanceTask,
  BackgroundSectionKey,
  BackgroundStmCursor,
  BackgroundStmRange,
  MaintainFixedBackgroundRequest,
  MaintainFixedBackgroundResponse,
  SourceRef
} from "./domain.js";
import { INITIAL_BACKGROUND_CURSOR } from "./domain.js";
import type { BackgroundMemoryCandidate } from "./background-stm-selector.js";
import { selectBackgroundMemories } from "./background-stm-selector.js";
import {
  BACKGROUND_SECTION_KEYS,
  createEmptyBackgroundSections,
  parseBackgroundMarkdown,
  renderBackgroundMarkdown,
  type BackgroundSections
} from "./background-markdown.js";
import {
  analyzeBackground,
  estimateBackgroundAnalyzerInputTokens,
  type BackgroundAnalyzerBatchProgress,
  type BackgroundAnalyzerLlmOptions,
  type BackgroundAnalyzerRunResult
} from "./llm-background-analyzer.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

const DEFAULT_STM_PAGE_SIZE = 100;
const DEFAULT_MAX_INPUT_TOKENS = 8_000;
const DEFAULT_LEASE_DURATION_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RESULT_ID_LIMIT = 100;
const DEFAULT_DEFERRED_RANGE_LIMIT = 32;

export interface MaintainFixedBackgroundOptions {
  analyzer?: typeof analyzeBackground;
  analyzerOptions?: BackgroundAnalyzerLlmOptions;
  now?: () => string;
  claimedBy?: string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  resultIdLimit?: number;
  deferredRangeLimit?: number;
}

export async function maintainFixedBackground(
  repository: ContextEngineRepository,
  request: MaintainFixedBackgroundRequest,
  options: MaintainFixedBackgroundOptions = {}
): Promise<MaintainFixedBackgroundResponse> {
  const normalized = normalizeRequest(request, options);
  const existingTask = await repository.getBackgroundMaintenanceTask(
    normalized.tenantId,
    normalized.principalId,
    normalized.runId
  );
  if (existingTask?.status === "succeeded" && existingTask.result) return existingTask.result;
  if (existingTask && existingTask.windowEnd !== normalized.scheduledAt) {
    throw new Error(`BACKGROUND_MAINTENANCE_RUN_CONFLICT:${normalized.runId}`);
  }
  if (existingTask?.status === "failed" && !existingTask.retryable) {
    throw new Error(`BACKGROUND_MAINTENANCE_ATTEMPTS_EXHAUSTED:${normalized.runId}`);
  }

  const backgroundBeforeClaim = await repository.getLatestBackgroundDocument(
    normalized.tenantId,
    normalized.principalId
  );
  validateRequestedBase(normalized, backgroundBeforeClaim, existingTask);
  const baseRevision = backgroundBeforeClaim?.fixedRevision ?? 0;
  const task = await repository.createBackgroundMaintenanceTask(existingTask ?? createTask(
    normalized,
    backgroundBeforeClaim,
    baseRevision,
    options
  ));
  if (task.status === "succeeded" && task.result) return task.result;
  assertTaskRequestMatches(task, normalized);

  const claimedAt = normalized.now();
  const claimedBy = options.claimedBy?.trim() || `background-maintainer:${randomUUID()}`;
  const claimed = await repository.claimBackgroundMaintenanceTask({
    taskId: task.taskId,
    claimedBy,
    claimedAt,
    leaseExpiresAt: new Date(Date.parse(claimedAt) + normalized.leaseDurationMs).toISOString()
  });
  if (!claimed) throw new Error(`BACKGROUND_MAINTENANCE_LEASE_UNAVAILABLE:${task.taskId}`);

  let workingTask = claimed;
  try {
    const background = await repository.getLatestBackgroundDocument(
      normalized.tenantId,
      normalized.principalId
    );
    if ((background?.fixedRevision ?? 0) !== claimed.baseRevision) {
      throw new Error(`REVISION_CONFLICT:${claimed.baseRevision}:${background?.fixedRevision ?? 0}`);
    }
    if (claimed.baseBackgroundId && claimed.baseBackgroundId !== background?.backgroundId) {
      throw new Error(`BACKGROUND_BASE_ID_CONFLICT:${claimed.baseBackgroundId}:${background?.backgroundId ?? "missing"}`);
    }

    const existingSections = background
      ? parseBackgroundMarkdown(background.fixedText)
      : createEmptyBackgroundSections("fixed");
    const completedBatches = await repository.getBackgroundMaintenanceBatches(claimed.taskId);
    const scanStart = claimed.checkpointCursor ?? background?.fixedWatermark ?? INITIAL_BACKGROUND_CURSOR;
    const scan = await scanCandidateWindow(repository, normalized, claimed, scanStart);
    const sortedCandidates = uniqueCandidatesById(scan.memories).sort(compareCandidateCursor);
    const firstOversizedIndex = sortedCandidates.findIndex((memory) =>
      isIndivisibleMemoryOverLimit(memory, existingSections, claimed, normalized.maxInputTokens)
    );
    const memories = firstOversizedIndex < 0
      ? sortedCandidates
      : sortedCandidates.slice(0, firstOversizedIndex);
    const deferredMemories = firstOversizedIndex < 0
      ? []
      : sortedCandidates.slice(firstOversizedIndex);
    const continuousThrough = deferredMemories.length
      ? maxCursor(scanStart, ...memories.map(cursorForMemory))
      : scan.throughCursor ?? claimed.checkpointCursor ?? scanStart;
    const newDeferredRanges = deferredMemories.length
      ? [{
          afterExclusive: continuousThrough,
          throughInclusive: scan.throughCursor ?? cursorForMemory(deferredMemories.at(-1)!),
          estimatedCount: deferredMemories.length
        }]
      : [];
    const deferredRanges = mergeBackgroundStmRanges(
      newDeferredRanges,
      normalized.deferredRangeLimit
    );
    const predictedStrategy = completedBatches.length ||
      estimateSingleRequestTokens(memories, existingSections, claimed) > normalized.maxInputTokens
      ? "hierarchical_batch"
      : "single_request";

    workingTask = {
      ...workingTask,
      executionStrategy: predictedStrategy,
      ...(scan.throughCursor ? { throughCursor: scan.throughCursor } : {}),
      scannedPageCount: workingTask.scannedPageCount + scan.pageCount,
      deferredRanges,
      deferredMemoryCount: deferredRanges.reduce((sum, range) => sum + range.estimatedCount, 0),
      updatedAt: normalized.now()
    };
    await repository.saveBackgroundMaintenanceTask(workingTask);

    if (!memories.length && !completedBatches.length) {
      const response = createNoAnalysisResponse(
        normalized,
        background,
        workingTask,
        deferredMemories
      );
      const succeeded = releaseSucceededTask(workingTask, response, normalized.now());
      await repository.saveBackgroundMaintenanceTask(succeeded);
      return response;
    }

    const sourceRefsByMemoryId = collectSourceRefs(completedBatches, memories);
    const taskAtAttemptStart = workingTask;
    let checkpointedNewBatchCount = 0;
    let checkpointedNewMemoryCount = 0;
    let checkpointedNewIgnoredCount = 0;
    let checkpointedNewInputTokens = 0;
    const analyzer = options.analyzer ?? analyzeBackground;
    const analyzerResult = await analyzer({
      mode: "fixed_maintenance",
      existingSections,
      memories,
      windowStart: claimed.windowStart,
      windowEnd: claimed.windowEnd
    }, createAnalyzerOptions(
      request,
      options,
      normalized.maxInputTokens,
      completedBatches,
      predictedStrategy,
      async (progress) => {
        checkpointedNewBatchCount += 1;
        checkpointedNewMemoryCount += progress.memories.length;
        checkpointedNewIgnoredCount += progress.output.ignoredMemoryIds.length;
        checkpointedNewInputTokens += progress.estimatedTokens;
        const checkpointAt = normalized.now();
        const batch = createMaintenanceBatch(claimed.taskId, progress, checkpointAt);
        workingTask = {
          ...workingTask,
          executionStrategy: "hierarchical_batch",
          checkpointCursor: batch.throughCursor,
          sectionAccumulator: sectionAccumulatorFor(progress, workingTask.sectionAccumulator),
          llmAnalysisCallCount: taskAtAttemptStart.llmAnalysisCallCount + checkpointedNewBatchCount,
          processedMemoryCount: taskAtAttemptStart.processedMemoryCount + checkpointedNewMemoryCount,
          ignoredMemoryCount: taskAtAttemptStart.ignoredMemoryCount + checkpointedNewIgnoredCount,
          inputTokenUsage: taskAtAttemptStart.inputTokenUsage + checkpointedNewInputTokens,
          updatedAt: checkpointAt
        };
        await repository.commitBackgroundMaintenanceCheckpoint({
          task: workingTask,
          batch,
          claimedBy
        });
        await options.analyzerOptions?.onBatchCompleted?.(progress);
      }
    ));

    validateAnalyzerResult(analyzerResult, normalized.sectionLimits);
    const processedMemoryIds = uniqueStrings([
      ...completedBatches.flatMap((batch) => batch.memoryIds),
      ...memories.map((memory) => memory.memoryDataId)
    ]);
    const sourceRefIds = sourceRefsForOutput(analyzerResult, sourceRefsByMemoryId);
    const conflictIds = analyzerResult.output.conflicts.map(conflictId);
    const hasDeferred = workingTask.deferredMemoryCount > 0;
    const status = hasDeferred ? "degraded" : "updated";
    const fixedRevision = claimed.baseRevision + 1;
    const backgroundId = backgroundIdFor(normalized.tenantId, normalized.principalId, fixedRevision);
    const response: MaintainFixedBackgroundResponse = {
      runId: normalized.runId,
      backgroundId,
      previousRevision: claimed.baseRevision,
      fixedRevision,
      fixedText: analyzerResult.markdown,
      executionStrategy: analyzerResult.executionStrategy,
      processedMemoryCount: processedMemoryIds.length,
      processedMemoryIds: processedMemoryIds.slice(0, normalized.resultIdLimit),
      ignoredMemoryCount: analyzerResult.output.ignoredMemoryIds.length,
      ignoredMemoryIds: analyzerResult.output.ignoredMemoryIds.slice(0, normalized.resultIdLimit),
      deferredMemoryCount: workingTask.deferredMemoryCount,
      deferredMemoryIds: deferredMemories
        .map((memory) => memory.memoryDataId)
        .slice(0, normalized.resultIdLimit),
      scannedPageCount: workingTask.scannedPageCount,
      llmAnalysisCallCount: taskAtAttemptStart.llmAnalysisCallCount + analyzerResult.llmCallCount,
      inputTokenUsage: taskAtAttemptStart.inputTokenUsage + analyzerResult.estimatedInputTokenUsage,
      sourceRefIds,
      conflictIds,
      status,
      ...(hasDeferred
        ? { degradedModeReason: "STM_INPUT_EXCEEDS_MAX_TOKENS" }
        : {})
    };
    const committedAt = normalized.now();
    const {
      claimedBy: _succeededClaimedBy,
      leaseExpiresAt: _succeededLeaseExpiresAt,
      error: _succeededError,
      ...taskWithoutLease
    } = workingTask;
    const succeededTask: BackgroundMaintenanceTask = {
      ...taskWithoutLease,
      status: "succeeded",
      executionStrategy: analyzerResult.executionStrategy,
      checkpointCursor: continuousThrough,
      processedMemoryCount: processedMemoryIds.length,
      ignoredMemoryCount: analyzerResult.output.ignoredMemoryIds.length,
      llmAnalysisCallCount: response.llmAnalysisCallCount,
      inputTokenUsage: response.inputTokenUsage,
      retryable: false,
      result: response,
      updatedAt: committedAt
    };
    const document = createCommittedDocument({
      background,
      normalized,
      backgroundId,
      fixedRevision,
      fixedText: analyzerResult.markdown,
      fixedWatermark: continuousThrough,
      latestStmCursor: scan.throughCursor ?? continuousThrough,
      sourceRefIds,
      conflictIds,
      committedAt,
      ...(response.degradedModeReason
        ? { degradedModeReason: response.degradedModeReason }
        : {})
    });
    await repository.commitFixedBackgroundMaintenance({
      task: succeededTask,
      document,
      expectedFixedRevision: claimed.baseRevision,
      claimedBy
    });
    return response;
  } catch (caught) {
    await markMaintenanceFailure(repository, workingTask, claimedBy, caught, normalized.now());
    throw caught;
  }
}

function normalizeRequest(
  request: MaintainFixedBackgroundRequest,
  options: MaintainFixedBackgroundOptions
) {
  const tenantId = request.tenantId.trim();
  const principalId = request.principalId.trim();
  const runId = request.runId.trim();
  if (!tenantId) throw new Error("BACKGROUND_MAINTENANCE_TENANT_REQUIRED");
  if (!principalId) throw new Error("BACKGROUND_MAINTENANCE_PRINCIPAL_REQUIRED");
  if (!runId) throw new Error("BACKGROUND_MAINTENANCE_RUN_ID_REQUIRED");
  assertIsoTimestamp(request.scheduledAt, "BACKGROUND_MAINTENANCE_SCHEDULED_AT_INVALID");
  const stmPageSize = positiveInteger(request.stmPageSize ?? DEFAULT_STM_PAGE_SIZE, "BACKGROUND_MAINTENANCE_PAGE_SIZE_INVALID");
  if (stmPageSize > 1_000) throw new Error("BACKGROUND_MAINTENANCE_PAGE_SIZE_INVALID");
  const maxInputTokens = positiveInteger(
    request.maxInputTokens ?? options.analyzerOptions?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    "BACKGROUND_MAINTENANCE_MAX_INPUT_TOKENS_INVALID"
  );
  const leaseDurationMs = positiveInteger(
    options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    "BACKGROUND_MAINTENANCE_LEASE_DURATION_INVALID"
  );
  const resultIdLimit = positiveInteger(
    options.resultIdLimit ?? DEFAULT_RESULT_ID_LIMIT,
    "BACKGROUND_MAINTENANCE_RESULT_LIMIT_INVALID"
  );
  const deferredRangeLimit = positiveInteger(
    options.deferredRangeLimit ?? DEFAULT_DEFERRED_RANGE_LIMIT,
    "BACKGROUND_MAINTENANCE_DEFERRED_RANGE_LIMIT_INVALID"
  );
  const now = options.now ?? (() => new Date().toISOString());
  assertIsoTimestamp(now(), "BACKGROUND_MAINTENANCE_CLOCK_INVALID");
  validateSectionLimits(request.sectionLimits);
  return {
    ...request,
    tenantId,
    principalId,
    runId,
    stmPageSize,
    maxInputTokens,
    leaseDurationMs,
    resultIdLimit,
    deferredRangeLimit,
    now
  };
}

function createTask(
  request: ReturnType<typeof normalizeRequest>,
  background: BackgroundContextDocument | undefined,
  baseRevision: number,
  options: MaintainFixedBackgroundOptions
): BackgroundMaintenanceTask {
  const now = request.now();
  return {
    taskId: taskIdFor(request.tenantId, request.principalId, request.runId),
    runId: request.runId,
    tenantId: request.tenantId,
    principalId: request.principalId,
    status: "queued",
    executionStrategy: "single_request",
    ...(background ? { baseBackgroundId: background.backgroundId } : {}),
    baseRevision,
    windowStart: background?.fixedTextUpdatedAt ?? INITIAL_BACKGROUND_CURSOR.updatedAt,
    windowEnd: request.scheduledAt,
    scannedPageCount: 0,
    llmAnalysisCallCount: 0,
    processedMemoryCount: 0,
    ignoredMemoryCount: 0,
    deferredRanges: [],
    deferredMemoryCount: 0,
    inputTokenUsage: 0,
    attempt: 0,
    maxAttempts: positiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "BACKGROUND_MAINTENANCE_MAX_ATTEMPTS_INVALID"
    ),
    retryable: true,
    createdAt: now,
    updatedAt: now
  };
}

function validateRequestedBase(
  request: ReturnType<typeof normalizeRequest>,
  background: BackgroundContextDocument | undefined,
  existingTask: BackgroundMaintenanceTask | undefined
) {
  if (existingTask) return;
  if (request.baseBackgroundId !== undefined && request.baseBackgroundId !== background?.backgroundId) {
    throw new Error(`BACKGROUND_BASE_ID_CONFLICT:${request.baseBackgroundId}:${background?.backgroundId ?? "missing"}`);
  }
  if (
    request.expectedFixedRevision !== undefined &&
    request.expectedFixedRevision !== (background?.fixedRevision ?? 0)
  ) {
    throw new Error(`REVISION_CONFLICT:${request.expectedFixedRevision}:${background?.fixedRevision ?? 0}`);
  }
}

function assertTaskRequestMatches(
  task: BackgroundMaintenanceTask,
  request: ReturnType<typeof normalizeRequest>
) {
  if (
    task.windowEnd !== request.scheduledAt ||
    (request.expectedFixedRevision !== undefined && request.expectedFixedRevision !== task.baseRevision) ||
    (request.baseBackgroundId !== undefined && request.baseBackgroundId !== task.baseBackgroundId)
  ) {
    throw new Error(`BACKGROUND_MAINTENANCE_RUN_CONFLICT:${task.runId}`);
  }
}

async function scanCandidateWindow(
  repository: ContextEngineRepository,
  request: ReturnType<typeof normalizeRequest>,
  task: BackgroundMaintenanceTask,
  startCursor: BackgroundStmCursor
) {
  const memories: BackgroundMemoryCandidate[] = [];
  let cursor: BackgroundStmCursor | undefined = startCursor;
  let throughCursor: BackgroundStmCursor | undefined;
  let pageCount = 0;
  while (true) {
    const page = await selectBackgroundMemories(repository, {
      tenantId: request.tenantId,
      principalId: request.principalId,
      windowStart: startCursor.updatedAt,
      windowEnd: task.windowEnd,
      ...(cursor ? { cursor } : {}),
      limit: request.stmPageSize
    });
    pageCount += 1;
    memories.push(...page.memories);
    if (page.nextCursor) throughCursor = page.nextCursor;
    if (!page.hasMore) break;
    if (!page.nextCursor || sameCursor(page.nextCursor, cursor)) {
      throw new Error("BACKGROUND_MAINTENANCE_PAGINATION_STALLED");
    }
    cursor = page.nextCursor;
  }
  return { memories, throughCursor, pageCount };
}

function createAnalyzerOptions(
  request: MaintainFixedBackgroundRequest,
  options: MaintainFixedBackgroundOptions,
  maxInputTokens: number,
  completedBatches: BackgroundMaintenanceBatch[],
  predictedStrategy: BackgroundMaintenanceTask["executionStrategy"],
  onBatchCompleted: (progress: BackgroundAnalyzerBatchProgress) => Promise<void>
): BackgroundAnalyzerLlmOptions {
  return {
    ...options.analyzerOptions,
    ...(request.llm?.apiKey !== undefined ? { apiKey: request.llm.apiKey } : {}),
    ...(request.llm?.baseUrl !== undefined ? { baseUrl: request.llm.baseUrl } : {}),
    ...(request.llm?.model !== undefined ? { model: request.llm.model } : {}),
    maxInputTokens,
    completedBatches: completedBatches.map((batch) => ({ output: batch.analysisOutput })),
    forceHierarchical: predictedStrategy === "hierarchical_batch",
    onBatchCompleted
  };
}

function createMaintenanceBatch(
  taskId: string,
  progress: BackgroundAnalyzerBatchProgress,
  createdAt: string
): BackgroundMaintenanceBatch {
  return {
    taskId,
    batchIndex: progress.batchIndex,
    throughCursor: maxCursor(...progress.memories.map(cursorForMemory)),
    memoryIds: progress.memories.map((memory) => memory.memoryDataId),
    memorySourceRefs: Object.fromEntries(progress.memories.map((memory) => [
      memory.memoryDataId,
      memory.sourceRefs
    ])),
    memoryCount: progress.memories.length,
    analysisOutput: progress.output,
    estimatedInputTokens: progress.estimatedTokens,
    createdAt
  };
}

function createNoAnalysisResponse(
  request: ReturnType<typeof normalizeRequest>,
  background: BackgroundContextDocument | undefined,
  task: BackgroundMaintenanceTask,
  deferred: BackgroundMemoryCandidate[]
): MaintainFixedBackgroundResponse {
  const degraded = deferred.length > 0;
  return {
    runId: request.runId,
    backgroundId: background?.backgroundId ?? backgroundIdFor(request.tenantId, request.principalId, 1),
    previousRevision: task.baseRevision,
    fixedRevision: task.baseRevision,
    fixedText: background?.fixedText ?? renderBackgroundMarkdown(createEmptyBackgroundSections("fixed"), "fixed"),
    executionStrategy: task.executionStrategy,
    processedMemoryCount: 0,
    processedMemoryIds: [],
    ignoredMemoryCount: 0,
    ignoredMemoryIds: [],
    deferredMemoryCount: task.deferredMemoryCount,
    deferredMemoryIds: deferred.map((memory) => memory.memoryDataId).slice(0, request.resultIdLimit),
    scannedPageCount: task.scannedPageCount,
    llmAnalysisCallCount: task.llmAnalysisCallCount,
    inputTokenUsage: task.inputTokenUsage,
    sourceRefIds: [],
    conflictIds: [],
    status: degraded ? "degraded" : "unchanged",
    ...(degraded ? { degradedModeReason: "STM_INPUT_EXCEEDS_MAX_TOKENS" } : {})
  };
}

function createCommittedDocument(input: {
  background: BackgroundContextDocument | undefined;
  normalized: ReturnType<typeof normalizeRequest>;
  backgroundId: string;
  fixedRevision: number;
  fixedText: string;
  fixedWatermark: BackgroundStmCursor;
  latestStmCursor: BackgroundStmCursor;
  sourceRefIds: string[];
  conflictIds: string[];
  committedAt: string;
  degradedModeReason?: string;
}): BackgroundContextDocument {
  const existing = input.background;
  return {
    backgroundId: input.backgroundId,
    tenantId: input.normalized.tenantId,
    principalId: input.normalized.principalId,
    fixedText: input.fixedText,
    dynamicText: renderBackgroundMarkdown(createEmptyBackgroundSections("dynamic"), "dynamic"),
    fixedRevision: input.fixedRevision,
    fixedTextUpdatedAt: input.normalized.scheduledAt,
    fixedWatermark: input.fixedWatermark,
    dynamicWindowStart: input.normalized.scheduledAt,
    dynamicWindowEnd: input.normalized.scheduledAt,
    dynamicSourceMemoryIds: [],
    latestStmCursor: maxCursor(existing?.latestStmCursor ?? INITIAL_BACKGROUND_CURSOR, input.latestStmCursor),
    sourceRefIds: uniqueStrings([...(existing?.sourceRefIds ?? []), ...input.sourceRefIds]),
    conflictIds: uniqueStrings([...(existing?.conflictIds ?? []), ...input.conflictIds]),
    ...(input.degradedModeReason ? { degradedModeReason: input.degradedModeReason } : {}),
    ...(existing?.updateSuggestion ? { updateSuggestion: existing.updateSuggestion } : {}),
    createdAt: input.committedAt,
    updatedAt: input.committedAt
  };
}

async function markMaintenanceFailure(
  repository: ContextEngineRepository,
  task: BackgroundMaintenanceTask,
  claimedBy: string,
  caught: unknown,
  updatedAt: string
) {
  const latest = await repository.getBackgroundMaintenanceTask(task.tenantId, task.principalId, task.runId) ?? task;
  if (latest.status === "succeeded") return;
  if (latest.status !== "running" || latest.claimedBy !== claimedBy) return;
  const retryable = latest.attempt < latest.maxAttempts;
  const {
    claimedBy: _claimedBy,
    leaseExpiresAt: _leaseExpiresAt,
    result: _result,
    error: _previousError,
    ...withoutLease
  } = latest;
  await repository.saveBackgroundMaintenanceTask({
    ...withoutLease,
    status: retryable ? "retry_scheduled" : "failed",
    retryable,
    error: errorMessage(caught),
    updatedAt
  });
}

function releaseSucceededTask(
  task: BackgroundMaintenanceTask,
  result: MaintainFixedBackgroundResponse,
  updatedAt: string
): BackgroundMaintenanceTask {
  const { claimedBy: _claimedBy, leaseExpiresAt: _leaseExpiresAt, error: _error, ...withoutLease } = task;
  return {
    ...withoutLease,
    status: "succeeded",
    retryable: false,
    result,
    updatedAt
  };
}

export function mergeBackgroundStmRanges(
  ranges: BackgroundStmRange[],
  maxRanges = DEFAULT_DEFERRED_RANGE_LIMIT
) {
  const sorted = ranges
    .filter((range) => range.estimatedCount > 0)
    .sort((left, right) => compareCursor(left.throughInclusive, right.throughInclusive));
  const merged: BackgroundStmRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || !rangesTouchOrOverlap(previous, range)) {
      merged.push(cloneRange(range));
      continue;
    }
    const adjacent = range.afterExclusive && sameCursor(range.afterExclusive, previous.throughInclusive);
    previous.throughInclusive = maxCursor(previous.throughInclusive, range.throughInclusive);
    previous.estimatedCount = adjacent
      ? previous.estimatedCount + range.estimatedCount
      : Math.max(previous.estimatedCount, range.estimatedCount);
  }
  if (merged.length <= maxRanges) return merged;
  const first = merged[0]!;
  const last = merged.at(-1)!;
  return [{
    ...(first.afterExclusive ? { afterExclusive: first.afterExclusive } : {}),
    throughInclusive: last.throughInclusive,
    estimatedCount: merged.reduce((sum, range) => sum + range.estimatedCount, 0)
  }];
}

function rangesTouchOrOverlap(left: BackgroundStmRange, right: BackgroundStmRange) {
  return !right.afterExclusive || compareCursor(right.afterExclusive, left.throughInclusive) <= 0;
}

function cloneRange(range: BackgroundStmRange): BackgroundStmRange {
  return {
    ...(range.afterExclusive ? { afterExclusive: { ...range.afterExclusive } } : {}),
    throughInclusive: { ...range.throughInclusive },
    estimatedCount: range.estimatedCount
  };
}

function collectSourceRefs(
  completedBatches: BackgroundMaintenanceBatch[],
  memories: BackgroundMemoryCandidate[]
) {
  const entries: Array<[string, SourceRef[]]> = completedBatches.flatMap((batch) =>
    Object.entries(batch.memorySourceRefs)
  );
  entries.push(...memories.map((memory) => [memory.memoryDataId, memory.sourceRefs] as [string, SourceRef[]]));
  return new Map(entries);
}

function sourceRefsForOutput(
  result: BackgroundAnalyzerRunResult,
  sourceRefsByMemoryId: Map<string, SourceRef[]>
) {
  const memoryIds = new Set<string>();
  for (const section of Object.values(result.output.sections)) {
    section.sourceMemoryIds.forEach((id) => memoryIds.add(id));
  }
  result.output.conflicts.forEach((conflict) =>
    conflict.memoryDataIds.forEach((id) => memoryIds.add(id))
  );
  return uniqueStrings([...memoryIds].flatMap((id) =>
    (sourceRefsByMemoryId.get(id) ?? []).map((source) => source.sourceRefId)
  ));
}

function conflictId(conflict: BackgroundAnalysisConflict) {
  return `background_conflict_${hash(JSON.stringify({
    memoryDataIds: [...conflict.memoryDataIds].sort(),
    section: conflict.section,
    description: conflict.description
  })).slice(0, 20)}`;
}

function sectionAccumulatorFor(
  progress: BackgroundAnalyzerBatchProgress,
  current: BackgroundMaintenanceTask["sectionAccumulator"]
): NonNullable<BackgroundMaintenanceTask["sectionAccumulator"]> {
  return Object.fromEntries(BACKGROUND_SECTION_KEYS.map((key) => [key, {
    summary: progress.output.sections[key].text,
    sourceMemoryIds: uniqueStrings([
      ...(current?.[key]?.sourceMemoryIds ?? []),
      ...progress.output.sections[key].sourceMemoryIds
    ])
  }])) as NonNullable<BackgroundMaintenanceTask["sectionAccumulator"]>;
}

function validateAnalyzerResult(
  result: BackgroundAnalyzerRunResult,
  limits: MaintainFixedBackgroundRequest["sectionLimits"]
) {
  const sections = parseBackgroundMarkdown(result.markdown);
  for (const key of BACKGROUND_SECTION_KEYS) {
    const limit = limits?.[key];
    if (limit !== undefined && sections[key].length > limit) {
      throw new Error(`BACKGROUND_MAINTENANCE_SECTION_TOO_LONG:${key}`);
    }
  }
}

function validateSectionLimits(limits: MaintainFixedBackgroundRequest["sectionLimits"]) {
  if (!limits) return;
  for (const key of Object.keys(limits)) {
    if (!BACKGROUND_SECTION_KEYS.includes(key as BackgroundSectionKey)) {
      throw new Error(`BACKGROUND_MAINTENANCE_SECTION_LIMIT_UNKNOWN:${key}`);
    }
    positiveInteger(limits[key as BackgroundSectionKey]!, `BACKGROUND_MAINTENANCE_SECTION_LIMIT_INVALID:${key}`);
  }
}

function estimateSingleRequestTokens(
  memories: BackgroundMemoryCandidate[],
  existingSections: BackgroundSections,
  task: BackgroundMaintenanceTask
) {
  const input = {
    mode: "fixed_maintenance" as const,
    existingSections,
    memories,
    windowStart: task.windowStart,
    windowEnd: task.windowEnd,
    execution: {
      strategy: "single_request" as const,
      memoryCount: memories.length,
      estimatedTokens: 0
    }
  };
  input.execution.estimatedTokens = estimateBackgroundAnalyzerInputTokens(input);
  return estimateBackgroundAnalyzerInputTokens(input);
}

function isIndivisibleMemoryOverLimit(
  memory: BackgroundMemoryCandidate,
  existingSections: BackgroundSections,
  task: BackgroundMaintenanceTask,
  maxInputTokens: number
) {
  const input = {
    mode: "fixed_maintenance" as const,
    existingSections,
    memories: [memory],
    windowStart: task.windowStart,
    windowEnd: task.windowEnd,
    execution: {
      strategy: "hierarchical_batch" as const,
      memoryCount: 1,
      batchIndex: 1,
      isLastBatch: true,
      estimatedTokens: 0
    }
  };
  input.execution.estimatedTokens = estimateBackgroundAnalyzerInputTokens(input);
  return estimateBackgroundAnalyzerInputTokens(input) > maxInputTokens;
}

function uniqueCandidatesById(memories: BackgroundMemoryCandidate[]) {
  return [...new Map(memories.map((memory) => [memory.memoryDataId, memory])).values()];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim()))];
}

function compareCandidateCursor(left: BackgroundMemoryCandidate, right: BackgroundMemoryCandidate) {
  return compareCursor(cursorForMemory(left), cursorForMemory(right));
}

function cursorForMemory(memory: BackgroundMemoryCandidate): BackgroundStmCursor {
  return { updatedAt: memory.updatedAt, memoryDataId: memory.memoryDataId };
}

function maxCursor(...cursors: BackgroundStmCursor[]): BackgroundStmCursor {
  const max = cursors.reduce((current, cursor) =>
    compareCursor(cursor, current) > 0 ? cursor : current
  );
  return { ...max };
}

function compareCursor(left: BackgroundStmCursor, right: BackgroundStmCursor) {
  return left.updatedAt.localeCompare(right.updatedAt) || left.memoryDataId.localeCompare(right.memoryDataId);
}

function sameCursor(left: BackgroundStmCursor | undefined, right: BackgroundStmCursor | undefined) {
  return Boolean(left && right && left.updatedAt === right.updatedAt && left.memoryDataId === right.memoryDataId);
}

function taskIdFor(tenantId: string, principalId: string, runId: string) {
  return `background_task_${hash(`${tenantId}\0${principalId}\0${runId}`).slice(0, 24)}`;
}

function backgroundIdFor(tenantId: string, principalId: string, fixedRevision: number) {
  return `background_${fixedRevision}_${hash(`${tenantId}\0${principalId}\0${fixedRevision}`).slice(0, 20)}`;
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveInteger(value: number, code: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(code);
  return value;
}

function assertIsoTimestamp(value: string, code: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
}

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught);
}
