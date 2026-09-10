import { createHash, randomUUID } from "node:crypto";
import type {
  BackgroundAnalysisConflict,
  BackgroundCitation,
  BackgroundContextDocument,
  BackgroundDynamicCacheRecord,
  BackgroundMaintenanceTask,
  BackgroundStmCursor,
  BackgroundStmRange,
  CreateSessionBackgroundRequest,
  SessionBackgroundSnapshot,
  SourceRef
} from "./domain.js";
import { INITIAL_BACKGROUND_CURSOR } from "./domain.js";
import {
  createEmptyBackgroundSections,
  parseBackgroundMarkdown,
  renderBackgroundMarkdown,
  type BackgroundSections
} from "./background-markdown.js";
import type { BackgroundMemoryCandidate } from "./background-stm-selector.js";
import { selectBackgroundMemories } from "./background-stm-selector.js";
import { mergeBackgroundStmRanges } from "./background-maintainer.js";
import {
  analyzeBackground,
  estimateBackgroundAnalyzerInputTokens,
  type BackgroundAnalyzerLlmOptions,
  type BackgroundAnalyzerRunResult
} from "./llm-background-analyzer.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

const DEFAULT_MAX_INPUT_TOKENS = 8_000;
const DEFAULT_MAX_DYNAMIC_CANDIDATES = 200;
const DEFAULT_TOKEN_BUDGET = 1_200;
const DEFAULT_STM_PAGE_SIZE = 100;
const DEFAULT_STATS_COUNT_LIMIT = 10_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS = 30_000;
const DEFAULT_DEFERRED_RANGE_LIMIT = 32;
const DEFAULT_MAINTENANCE_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_LOCALE = "zh-CN";
const DYNAMIC_BACKGROUND_SELECTION_POLICY_VERSION = "stm-generated-v3";

const flightsByRepository = new WeakMap<
  ContextEngineRepository,
  Map<string, Promise<BackgroundDynamicCacheRecord>>
>();

export interface CreateSessionBackgroundOptions {
  analyzer?: typeof analyzeBackground;
  analyzerOptions?: BackgroundAnalyzerLlmOptions;
  now?: () => string;
  cacheTtlMs?: number;
  singleFlightTimeoutMs?: number;
  stmPageSize?: number;
  statsCountLimit?: number;
  deferredRangeLimit?: number;
  maintenanceMaxAttempts?: number;
  principalTimezone?: string;
  tenantTimezone?: string;
  defaultTimezone?: string;
  defaultLocale?: string;
}

export async function createSessionBackground(
  repository: ContextEngineRepository,
  request: CreateSessionBackgroundRequest,
  options: CreateSessionBackgroundOptions = {}
): Promise<SessionBackgroundSnapshot> {
  const normalized = normalizeRequest(request, options);
  const persistedBackground = await repository.getLatestBackgroundDocument(
    normalized.tenantId,
    normalized.principalId
  );
  normalized.persistedBackground = Boolean(persistedBackground);
  if (
    normalized.fixedBackgroundId !== undefined &&
    normalized.fixedBackgroundId !== persistedBackground?.backgroundId
  ) {
    throw new Error(
      `SESSION_BACKGROUND_FIXED_ID_CONFLICT:${normalized.fixedBackgroundId}:${persistedBackground?.backgroundId ?? "missing"}`
    );
  }
  const fixed = persistedBackground ?? createDefaultFixedBackground(normalized);
  const windowStart = normalized.dynamicWindowStart ?? fixed.fixedTextUpdatedAt;
  const windowEnd = normalized.dynamicWindowEnd ?? normalized.referenceTime;
  assertWindow(windowStart, windowEnd);

  const observedStats = await repository.getBackgroundStmWindowStats({
    tenantId: normalized.tenantId,
    principalId: normalized.principalId,
    cursor: fixed.fixedWatermark,
    windowEnd,
    countLimit: normalized.statsCountLimit
  });
  const observedLatest = observedStats.latestCursor ?? fixed.fixedWatermark;
  const latestStmCursor = normalized.latestStmCursor ?? observedLatest;
  validateRequestedLatestCursor(latestStmCursor, fixed.fixedWatermark, observedLatest);
  const stats = normalized.latestStmCursor && compareCursor(latestStmCursor, observedLatest) < 0
    ? await repository.getBackgroundStmWindowStats({
        tenantId: normalized.tenantId,
        principalId: normalized.principalId,
        cursor: fixed.fixedWatermark,
        windowEnd,
        throughCursor: latestStmCursor,
        countLimit: normalized.statsCountLimit
      })
    : observedStats;
  const pendingStmCount = stats.pendingCount;
  const watermarkLagSeconds = pendingStmCount > 0
    ? Math.max(0, Math.floor(
        (Date.parse(latestStmCursor.updatedAt) - Date.parse(fixed.fixedWatermark.updatedAt)) / 1_000
      ))
    : 0;
  const cacheKey = dynamicCacheKey(
    normalized.tenantId,
    normalized.principalId,
    fixed.fixedRevision,
    latestStmCursor,
    normalized.timezone,
    normalized.localDate,
    dynamicWindowOverrideKey(normalized)
  );
  if (!normalized.forceRefresh) {
    const existingSnapshot = await repository.getSessionBackgroundSnapshot(
      normalized.tenantId,
      normalized.principalId,
      normalized.sessionId
    );
    if (existingSnapshot && canReuseSessionSnapshot(existingSnapshot, {
      normalized,
      fixed,
      latestStmCursor,
      windowStart,
      windowEnd
    })) {
      return existingSnapshot;
    }
  }
  const now = normalized.now();

  let cache: BackgroundDynamicCacheRecord | undefined;
  let cacheHit = false;
  let fallbackStatus: "stale" | "degraded" | undefined;
  let fallbackReason: string | undefined;
  const existingCache = await repository.getBackgroundDynamicCache(cacheKey);
  if (!normalized.forceRefresh && existingCache && existingCache.expiresAt > now) {
    cache = existingCache;
    cacheHit = true;
  } else {
    const flight = joinDynamicSingleFlight(repository, cacheKey, async () => {
      const generated = await generateDynamicCache(repository, {
        normalized,
        fixed,
        windowStart,
        windowEnd,
        latestStmCursor,
        pendingStmCount,
        watermarkLagSeconds,
        cacheKey
      }, options);
      await repository.saveBackgroundDynamicCache(generated);
      if (generated.deferredMemoryCount > 0) {
        await upsertFixedCatchupTask(repository, fixed, generated, normalized, options);
      }
      await repository.deleteExpiredBackgroundDynamicCaches(generated.generatedAt);
      return generated;
    });
    try {
      cache = flight.leader
        ? await flight.promise
        : await withTimeout(flight.promise, normalized.singleFlightTimeoutMs);
      cacheHit = !flight.leader;
    } catch (caught) {
      const fallback = await repository.getLatestBackgroundDynamicCache(
        normalized.tenantId,
        normalized.principalId,
        fixed.fixedRevision
      );
      if (fallback) {
        cache = fallback;
        cacheHit = true;
        fallbackStatus = "stale";
        fallbackReason = `DYNAMIC_BACKGROUND_STALE:${errorMessage(caught)}`;
      } else {
        cache = createFailedDynamicFallback({
          normalized,
          fixed,
          windowStart,
          windowEnd,
          latestStmCursor,
          pendingStmCount,
          watermarkLagSeconds,
          cacheKey
        }, errorMessage(caught));
        fallbackStatus = "degraded";
        fallbackReason = cache.degradedModeReason;
      }
    }
  }

  const status = fallbackStatus ?? cache.status;
  const degradedModeReason = fallbackReason ?? cache.degradedModeReason ??
    (!persistedBackground ? "FIXED_BACKGROUND_MISSING" : undefined);
  const serializedPrompt = serializeSessionBackgroundPrompt({
    fixedText: fixed.fixedText,
    dynamicText: cache.dynamicText,
    fixedRevision: fixed.fixedRevision,
    windowStart,
    windowEnd,
    referenceTime: normalized.referenceTime,
    timezone: normalized.timezone,
    locale: normalized.locale,
    localDate: normalized.localDate
  });
  const snapshotGeneratedAt = normalized.now();
  const snapshotId = normalized.forceRefresh
    ? `session_background_${hash(`${normalized.tenantId}\0${normalized.principalId}\0${normalized.sessionId}\0${randomUUID()}`).slice(0, 24)}`
    : sessionSnapshotId(
        normalized.tenantId,
        normalized.principalId,
        normalized.sessionId,
        cache.cacheKey,
        normalized.timezone,
        normalized.localDate,
        normalized.locale,
        dynamicWindowOverrideKey(normalized)
      );
  const snapshot: SessionBackgroundSnapshot = {
    snapshotId,
    sessionId: normalized.sessionId,
    tenantId: normalized.tenantId,
    principalId: normalized.principalId,
    backgroundId: fixed.backgroundId,
    fixedRevision: fixed.fixedRevision,
    fixedText: fixed.fixedText,
    dynamicText: cache.dynamicText,
    dynamicWindowStart: windowStart,
    dynamicWindowEnd: windowEnd,
    referenceTime: normalized.referenceTime,
    timezone: normalized.timezone,
    locale: normalized.locale,
    localDate: normalized.localDate,
    fixedSourceRefIds: [...fixed.sourceRefIds],
    dynamicSourceRefIds: [...cache.sourceRefIds],
    sourceMemoryIds: [...cache.sourceMemoryIds],
    citations: [...cache.citations],
    conflictIds: uniqueStrings([...fixed.conflictIds, ...cache.conflictIds]),
    latestStmCursor: { ...cache.latestStmCursor },
    dynamicCacheKey: cache.cacheKey,
    cacheHit,
    executionStrategy: cache.executionStrategy,
    processedMemoryCount: cache.processedMemoryCount,
    pendingStmCount,
    deferredMemoryCount: cache.deferredMemoryCount,
    watermarkLagSeconds,
    generatedAt: cache.generatedAt,
    status,
    ...(degradedModeReason ? { degradedModeReason } : {}),
    serializedPrompt,
    createdAt: snapshotGeneratedAt
  };
  return await repository.createSessionBackgroundSnapshot(snapshot);
}

async function generateDynamicCache(
  repository: ContextEngineRepository,
  context: DynamicGenerationContext,
  options: CreateSessionBackgroundOptions
): Promise<BackgroundDynamicCacheRecord> {
  const scan = await scanDynamicCandidates(repository, context);
  const existingSections = parseBackgroundMarkdown(context.fixed.fixedText);
  const sorted = uniqueCandidatesById(scan.memories).sort(compareCandidateCursor);
  const capped = sorted.slice(0, context.normalized.maxDynamicCandidates);
  const stoppedForCandidateLimit = scan.stoppedForCandidateLimit ||
    sorted.length > context.normalized.maxDynamicCandidates;
  const firstOversizedIndex = capped.findIndex((memory) =>
    isIndivisibleMemoryOverLimit(
      memory,
      existingSections,
      context.windowStart,
      context.windowEnd,
      context.normalized.maxInputTokens
    )
  );
  const memories = firstOversizedIndex < 0 ? capped : capped.slice(0, firstOversizedIndex);
  const deferred = stoppedForCandidateLimit || firstOversizedIndex >= 0;
  const deferredMemoryCount = deferred
    ? Math.max(1, context.pendingStmCount - memories.length, sorted.length - memories.length)
    : 0;
  const afterExclusive = memories.length
    ? cursorForMemory(memories.at(-1)!)
    : context.fixed.fixedWatermark;
  const deferredRanges: BackgroundStmRange[] = deferred
    ? mergeBackgroundStmRanges([{
        afterExclusive,
        throughInclusive: context.latestStmCursor,
        estimatedCount: deferredMemoryCount
      }], context.normalized.deferredRangeLimit)
    : [];
  const generatedAt = context.normalized.now();

  if (!memories.length) {
    const reason = firstOversizedIndex >= 0
      ? "STM_INPUT_EXCEEDS_MAX_TOKENS"
      : stoppedForCandidateLimit
        ? "DYNAMIC_CANDIDATE_LIMIT_EXCEEDED"
        : !context.normalized.persistedBackground
          ? "FIXED_BACKGROUND_MISSING"
          : undefined;
    return createDynamicCacheRecord(context, {
      dynamicText: renderBackgroundMarkdown(createEmptyBackgroundSections("dynamic"), "dynamic"),
      sourceMemoryIds: [],
      sourceRefIds: [],
      citations: [],
      conflictIds: [],
      processedMemoryCount: 0,
      deferredMemoryCount,
      deferredRanges,
      executionStrategy: "single_request",
      status: reason ? "degraded" : "ready",
      ...(reason ? { degradedModeReason: reason } : {}),
      generatedAt
    });
  }

  const analyzer = options.analyzer ?? analyzeBackground;
  const result = await analyzer({
    mode: "dynamic_session",
    existingSections,
    memories,
    windowStart: context.windowStart,
    windowEnd: context.windowEnd
  }, {
    ...options.analyzerOptions,
    maxInputTokens: context.normalized.maxInputTokens,
    maxOutputTokens: context.normalized.tokenBudget
  });
  const sourceRefsByMemoryId = new Map(memories.map((memory) => [memory.memoryDataId, memory.sourceRefs]));
  const sourceMemoryIds = referencedMemoryIds(result);
  const citations = citationsForMemoryIds(sourceMemoryIds, sourceRefsByMemoryId);
  const conflictIds = result.output.conflicts.map(conflictId);
  const reason = deferred
    ? firstOversizedIndex >= 0
      ? "STM_INPUT_EXCEEDS_MAX_TOKENS"
      : "DYNAMIC_CANDIDATE_LIMIT_EXCEEDED"
    : !context.normalized.persistedBackground
      ? "FIXED_BACKGROUND_MISSING"
      : undefined;
  return createDynamicCacheRecord(context, {
    dynamicText: result.markdown,
    sourceMemoryIds,
    sourceRefIds: uniqueStrings(citations.map((citation) => citation.sourceRefId)),
    citations,
    conflictIds,
    processedMemoryCount: memories.length,
    deferredMemoryCount,
    deferredRanges,
    executionStrategy: result.executionStrategy,
    status: reason ? "degraded" : "ready",
    ...(reason ? { degradedModeReason: reason } : {}),
    generatedAt
  });
}

async function scanDynamicCandidates(
  repository: ContextEngineRepository,
  context: DynamicGenerationContext
) {
  const memories: BackgroundMemoryCandidate[] = [];
  let cursor = context.fixed.fixedWatermark;
  let pageCount = 0;
  let stoppedForCandidateLimit = false;
  while (compareCursor(cursor, context.latestStmCursor) < 0) {
    const page = await selectBackgroundMemories(repository, {
      tenantId: context.normalized.tenantId,
      principalId: context.normalized.principalId,
      windowStart: context.fixed.fixedWatermark.updatedAt,
      windowEnd: context.windowEnd,
      cursor,
      limit: context.normalized.stmPageSize
    });
    pageCount += 1;
    memories.push(...page.memories.filter((memory) =>
      compareCursor(cursorForMemory(memory), context.latestStmCursor) <= 0
    ));
    const nextCursor = page.nextCursor;
    if (page.hasMore && !nextCursor) throw new Error("SESSION_BACKGROUND_PAGINATION_STALLED");
    const reachedUpperBound = !nextCursor || compareCursor(nextCursor, context.latestStmCursor) >= 0;
    if (
      memories.length > context.normalized.maxDynamicCandidates ||
      (memories.length >= context.normalized.maxDynamicCandidates && page.hasMore && !reachedUpperBound)
    ) {
      stoppedForCandidateLimit = true;
      break;
    }
    if (!page.hasMore || reachedUpperBound) break;
    if (sameCursor(nextCursor, cursor)) throw new Error("SESSION_BACKGROUND_PAGINATION_STALLED");
    cursor = nextCursor!;
  }
  return { memories, pageCount, stoppedForCandidateLimit };
}

function createDynamicCacheRecord(
  context: DynamicGenerationContext,
  output: {
    dynamicText: string;
    sourceMemoryIds: string[];
    sourceRefIds: string[];
    citations: BackgroundCitation[];
    conflictIds: string[];
    processedMemoryCount: number;
    deferredMemoryCount: number;
    deferredRanges: BackgroundStmRange[];
    executionStrategy: BackgroundDynamicCacheRecord["executionStrategy"];
    status: BackgroundDynamicCacheRecord["status"];
    degradedModeReason?: string;
    generatedAt: string;
  }
): BackgroundDynamicCacheRecord {
  return {
    cacheKey: context.cacheKey,
    tenantId: context.normalized.tenantId,
    principalId: context.normalized.principalId,
    fixedBackgroundId: context.fixed.backgroundId,
    fixedRevision: context.fixed.fixedRevision,
    latestStmCursor: { ...context.latestStmCursor },
    referenceTime: context.normalized.referenceTime,
    timezone: context.normalized.timezone,
    locale: context.normalized.locale,
    localDate: context.normalized.localDate,
    windowStart: context.windowStart,
    windowEnd: context.windowEnd,
    dynamicText: output.dynamicText,
    sourceMemoryIds: output.sourceMemoryIds,
    sourceRefIds: output.sourceRefIds,
    citations: output.citations,
    conflictIds: output.conflictIds,
    processedMemoryCount: output.processedMemoryCount,
    pendingStmCount: context.pendingStmCount,
    deferredMemoryCount: output.deferredMemoryCount,
    deferredRanges: output.deferredRanges,
    watermarkLagSeconds: context.watermarkLagSeconds,
    executionStrategy: output.executionStrategy,
    status: output.status,
    ...(output.degradedModeReason ? { degradedModeReason: output.degradedModeReason } : {}),
    generatedAt: output.generatedAt,
    expiresAt: new Date(Date.parse(output.generatedAt) + context.normalized.cacheTtlMs).toISOString()
  };
}

function createFailedDynamicFallback(context: DynamicGenerationContext, failure: string) {
  const generatedAt = context.normalized.now();
  return createDynamicCacheRecord(context, {
    dynamicText: renderBackgroundMarkdown(createEmptyBackgroundSections("dynamic"), "dynamic"),
    sourceMemoryIds: [],
    sourceRefIds: [],
    citations: [],
    conflictIds: [],
    processedMemoryCount: 0,
    deferredMemoryCount: context.pendingStmCount,
    deferredRanges: context.pendingStmCount > 0
      ? [{
          afterExclusive: context.fixed.fixedWatermark,
          throughInclusive: context.latestStmCursor,
          estimatedCount: context.pendingStmCount
        }]
      : [],
    executionStrategy: "single_request",
    status: "degraded",
    degradedModeReason: `DYNAMIC_ANALYSIS_FAILED:${failure}`,
    generatedAt
  });
}

async function upsertFixedCatchupTask(
  repository: ContextEngineRepository,
  fixed: FixedBackgroundState,
  cache: BackgroundDynamicCacheRecord,
  request: NormalizedSessionBackgroundRequest,
  options: CreateSessionBackgroundOptions
) {
  const cursorHash = hash(JSON.stringify(cache.latestStmCursor)).slice(0, 16);
  const runId = `background-catchup:${request.tenantId}:${request.principalId}:${fixed.fixedRevision}:${cursorHash}`;
  const createdAt = request.now();
  const task: BackgroundMaintenanceTask = {
    taskId: `background_task_${hash(`${request.tenantId}\0${request.principalId}\0${runId}`).slice(0, 24)}`,
    runId,
    tenantId: request.tenantId,
    principalId: request.principalId,
    status: "queued",
    executionStrategy: "hierarchical_batch",
    ...(request.persistedBackground ? { baseBackgroundId: fixed.backgroundId } : {}),
    baseRevision: fixed.fixedRevision,
    windowStart: fixed.fixedTextUpdatedAt,
    windowEnd: cache.windowEnd,
    throughCursor: cache.latestStmCursor,
    scannedPageCount: 0,
    llmAnalysisCallCount: 0,
    processedMemoryCount: 0,
    ignoredMemoryCount: 0,
    deferredRanges: cache.deferredRanges,
    deferredMemoryCount: cache.deferredMemoryCount,
    inputTokenUsage: 0,
    attempt: 0,
    maxAttempts: positiveInteger(
      options.maintenanceMaxAttempts ?? DEFAULT_MAINTENANCE_MAX_ATTEMPTS,
      "SESSION_BACKGROUND_MAINTENANCE_ATTEMPTS_INVALID"
    ),
    retryable: true,
    createdAt,
    updatedAt: createdAt
  };
  await repository.createBackgroundMaintenanceTask(task);
}

function normalizeRequest(
  request: CreateSessionBackgroundRequest,
  options: CreateSessionBackgroundOptions
): NormalizedSessionBackgroundRequest {
  const sessionId = request.sessionId.trim();
  const tenantId = request.tenantId.trim();
  const principalId = request.principalId.trim();
  if (!sessionId) throw new Error("SESSION_BACKGROUND_SESSION_ID_REQUIRED");
  if (!tenantId) throw new Error("SESSION_BACKGROUND_TENANT_REQUIRED");
  if (!principalId) throw new Error("SESSION_BACKGROUND_PRINCIPAL_REQUIRED");
  assertIsoTimestamp(request.createdAt, "SESSION_BACKGROUND_CREATED_AT_INVALID");
  if (request.dynamicWindowStart) {
    assertIsoTimestamp(request.dynamicWindowStart, "SESSION_BACKGROUND_WINDOW_START_INVALID");
  }
  if (request.dynamicWindowEnd) {
    assertIsoTimestamp(request.dynamicWindowEnd, "SESSION_BACKGROUND_WINDOW_END_INVALID");
  }
  if (request.latestStmCursor) assertCursor(request.latestStmCursor, "SESSION_BACKGROUND_LATEST_CURSOR_INVALID");
  const now = options.now ?? (() => new Date().toISOString());
  const requestReceivedAt = now();
  assertIsoTimestamp(requestReceivedAt, "SESSION_BACKGROUND_CLOCK_INVALID");
  const referenceTime = normalizeReferenceTime(request.referenceTime, requestReceivedAt);
  const timezone = resolveTimezone(request.timezone, options);
  const locale = resolveLocale(request.locale, options.defaultLocale);
  return {
    ...request,
    sessionId,
    tenantId,
    principalId,
    referenceTime,
    timezone,
    locale,
    localDate: localDateAt(referenceTime, timezone),
    tokenBudget: positiveInteger(request.tokenBudget ?? DEFAULT_TOKEN_BUDGET, "SESSION_BACKGROUND_TOKEN_BUDGET_INVALID"),
    maxInputTokens: positiveInteger(
      request.maxInputTokens ?? options.analyzerOptions?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      "SESSION_BACKGROUND_MAX_INPUT_TOKENS_INVALID"
    ),
    maxDynamicCandidates: positiveInteger(
      request.maxDynamicCandidates ?? DEFAULT_MAX_DYNAMIC_CANDIDATES,
      "SESSION_BACKGROUND_MAX_CANDIDATES_INVALID"
    ),
    stmPageSize: boundedPositiveInteger(
      options.stmPageSize ?? DEFAULT_STM_PAGE_SIZE,
      1_000,
      "SESSION_BACKGROUND_PAGE_SIZE_INVALID"
    ),
    statsCountLimit: positiveInteger(
      options.statsCountLimit ?? DEFAULT_STATS_COUNT_LIMIT,
      "SESSION_BACKGROUND_STATS_LIMIT_INVALID"
    ),
    cacheTtlMs: positiveInteger(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, "SESSION_BACKGROUND_CACHE_TTL_INVALID"),
    singleFlightTimeoutMs: positiveInteger(
      options.singleFlightTimeoutMs ?? DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS,
      "SESSION_BACKGROUND_SINGLE_FLIGHT_TIMEOUT_INVALID"
    ),
    deferredRangeLimit: positiveInteger(
      options.deferredRangeLimit ?? DEFAULT_DEFERRED_RANGE_LIMIT,
      "SESSION_BACKGROUND_DEFERRED_RANGE_LIMIT_INVALID"
    ),
    forceRefresh: request.forceRefresh === true,
    persistedBackground: false,
    now
  };
}

function createDefaultFixedBackground(request: NormalizedSessionBackgroundRequest): FixedBackgroundState {
  return {
    backgroundId: `background_empty_${hash(`${request.tenantId}\0${request.principalId}`).slice(0, 20)}`,
    fixedRevision: 0,
    fixedText: renderBackgroundMarkdown(createEmptyBackgroundSections("fixed"), "fixed"),
    fixedTextUpdatedAt: INITIAL_BACKGROUND_CURSOR.updatedAt,
    fixedWatermark: { ...INITIAL_BACKGROUND_CURSOR },
    sourceRefIds: [],
    conflictIds: []
  };
}

function joinDynamicSingleFlight(
  repository: ContextEngineRepository,
  cacheKey: string,
  factory: () => Promise<BackgroundDynamicCacheRecord>
) {
  let flights = flightsByRepository.get(repository);
  if (!flights) {
    flights = new Map();
    flightsByRepository.set(repository, flights);
  }
  const existing = flights.get(cacheKey);
  if (existing) return { promise: existing, leader: false };
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => flights!.delete(cacheKey));
  flights.set(cacheKey, promise);
  return { promise, leader: true };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DYNAMIC_SINGLE_FLIGHT_TIMEOUT")), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function dynamicCacheKey(
  tenantId: string,
  principalId: string,
  fixedRevision: number,
  cursor: BackgroundStmCursor,
  timezone: string,
  localDate: string,
  windowOverrideKey = "default"
) {
  const cursorKey = cursor.memoryDataId || cursor.updatedAt !== INITIAL_BACKGROUND_CURSOR.updatedAt
    ? hash(JSON.stringify(cursor)).slice(0, 20)
    : "empty";
  return [
    "dynamic-background",
    DYNAMIC_BACKGROUND_SELECTION_POLICY_VERSION,
    tenantId,
    principalId,
    String(fixedRevision),
    encodeURIComponent(timezone),
    localDate,
    windowOverrideKey,
    cursorKey
  ].join(":");
}

export function serializeSessionBackgroundPrompt(input: {
  fixedText: string;
  dynamicText: string;
  fixedRevision: number;
  windowStart: string;
  windowEnd: string;
  referenceTime: string;
  timezone: string;
  locale: string;
  localDate: string;
}) {
  return [
    `<fixed_background revision="${input.fixedRevision}">`,
    input.fixedText,
    "</fixed_background>",
    `<session_dynamic_background window_start="${input.windowStart}" window_end="${input.windowEnd}" reference_time="${input.referenceTime}" timezone="${input.timezone}" locale="${input.locale}" local_date="${input.localDate}">`,
    input.dynamicText,
    "</session_dynamic_background>"
  ].join("\n");
}

function referencedMemoryIds(result: BackgroundAnalyzerRunResult) {
  const ids = new Set<string>();
  for (const section of Object.values(result.output.sections)) {
    section.sourceMemoryIds.forEach((id) => ids.add(id));
  }
  result.output.conflicts.forEach((conflict) =>
    conflict.memoryDataIds.forEach((id) => ids.add(id))
  );
  return [...ids];
}

function citationsForMemoryIds(
  memoryIds: string[],
  sourceRefsByMemoryId: Map<string, SourceRef[]>
) {
  const citations = new Map<string, BackgroundCitation>();
  for (const memoryDataId of memoryIds) {
    for (const source of sourceRefsByMemoryId.get(memoryDataId) ?? []) {
      const citation: BackgroundCitation = { sourceRefId: source.sourceRefId, memoryDataId, layer: "stm" };
      citations.set(`${memoryDataId}\0${source.sourceRefId}`, citation);
    }
  }
  return [...citations.values()];
}

function conflictId(conflict: BackgroundAnalysisConflict) {
  return `background_conflict_${hash(JSON.stringify({
    memoryDataIds: [...conflict.memoryDataIds].sort(),
    section: conflict.section,
    description: conflict.description
  })).slice(0, 20)}`;
}

function validateRequestedLatestCursor(
  requested: BackgroundStmCursor,
  fixedWatermark: BackgroundStmCursor,
  observedLatest: BackgroundStmCursor
) {
  if (
    compareCursor(requested, fixedWatermark) < 0 ||
    compareCursor(requested, observedLatest) > 0
  ) {
    throw new Error("SESSION_BACKGROUND_LATEST_CURSOR_OUT_OF_RANGE");
  }
}

function assertWindow(windowStart: string, windowEnd: string) {
  assertIsoTimestamp(windowStart, "SESSION_BACKGROUND_WINDOW_START_INVALID");
  assertIsoTimestamp(windowEnd, "SESSION_BACKGROUND_WINDOW_END_INVALID");
  if (windowStart > windowEnd) {
    throw new Error("SESSION_BACKGROUND_WINDOW_INVALID");
  }
}

function canReuseSessionSnapshot(
  snapshot: SessionBackgroundSnapshot,
  context: {
    normalized: NormalizedSessionBackgroundRequest;
    fixed: FixedBackgroundState;
    latestStmCursor: BackgroundStmCursor;
    windowStart: string;
    windowEnd: string;
  }
) {
  return (
    snapshot.backgroundId === context.fixed.backgroundId &&
    snapshot.fixedRevision === context.fixed.fixedRevision &&
    sameCursor(snapshot.latestStmCursor, context.latestStmCursor) &&
    snapshot.timezone === context.normalized.timezone &&
    snapshot.localDate === context.normalized.localDate &&
    snapshot.locale === context.normalized.locale &&
    (!context.normalized.dynamicWindowStart || snapshot.dynamicWindowStart === context.windowStart) &&
    (!context.normalized.dynamicWindowEnd || snapshot.dynamicWindowEnd === context.windowEnd)
  );
}

function dynamicWindowOverrideKey(request: CreateSessionBackgroundRequest) {
  if (!request.dynamicWindowStart && !request.dynamicWindowEnd) return "default";
  return `explicit-${hash(JSON.stringify({
    windowStart: request.dynamicWindowStart ?? null,
    windowEnd: request.dynamicWindowEnd ?? null
  })).slice(0, 16)}`;
}

function isIndivisibleMemoryOverLimit(
  memory: BackgroundMemoryCandidate,
  existingSections: BackgroundSections,
  windowStart: string,
  windowEnd: string,
  maxInputTokens: number
) {
  const input = {
    mode: "dynamic_session" as const,
    existingSections,
    memories: [memory],
    windowStart,
    windowEnd,
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

function compareCandidateCursor(left: BackgroundMemoryCandidate, right: BackgroundMemoryCandidate) {
  return compareCursor(cursorForMemory(left), cursorForMemory(right));
}

function cursorForMemory(memory: BackgroundMemoryCandidate): BackgroundStmCursor {
  return { updatedAt: memory.updatedAt, memoryDataId: memory.memoryDataId };
}

function compareCursor(left: BackgroundStmCursor, right: BackgroundStmCursor) {
  return left.updatedAt.localeCompare(right.updatedAt) || left.memoryDataId.localeCompare(right.memoryDataId);
}

function sameCursor(left: BackgroundStmCursor | undefined, right: BackgroundStmCursor | undefined) {
  return Boolean(left && right && left.updatedAt === right.updatedAt && left.memoryDataId === right.memoryDataId);
}

function assertCursor(cursor: BackgroundStmCursor, code: string) {
  assertIsoTimestamp(cursor.updatedAt, code);
  if (typeof cursor.memoryDataId !== "string") throw new Error(code);
}

function sessionSnapshotId(
  tenantId: string,
  principalId: string,
  sessionId: string,
  cacheKey: string,
  timezone: string,
  localDate: string,
  locale: string,
  windowOverrideKey: string
) {
  return `session_background_${hash([
    tenantId,
    principalId,
    sessionId,
    cacheKey,
    timezone,
    localDate,
    locale,
    windowOverrideKey
  ].join("\0")).slice(0, 24)}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim()))];
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveInteger(value: number, code: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(code);
  return value;
}

function boundedPositiveInteger(value: number, max: number, code: string) {
  const normalized = positiveInteger(value, code);
  if (normalized > max) throw new Error(code);
  return normalized;
}

function assertIsoTimestamp(value: string, code: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
}

function normalizeReferenceTime(value: string | undefined, requestReceivedAt: string) {
  const referenceTime = value ?? requestReceivedAt;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(referenceTime)) {
    throw new Error("SESSION_BACKGROUND_REFERENCE_TIME_INVALID");
  }
  const parsed = Date.parse(referenceTime);
  if (!Number.isFinite(parsed)) throw new Error("SESSION_BACKGROUND_REFERENCE_TIME_INVALID");
  return new Date(parsed).toISOString();
}

function resolveTimezone(value: string | undefined, options: CreateSessionBackgroundOptions) {
  const timezone = firstNonEmpty(
    value,
    options.principalTimezone,
    options.tenantTimezone,
    options.defaultTimezone,
    DEFAULT_TIMEZONE
  )!;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error("SESSION_BACKGROUND_TIMEZONE_INVALID");
  }
  return timezone;
}

function resolveLocale(value: string | undefined, defaultLocale: string | undefined) {
  const locale = firstNonEmpty(value, defaultLocale, DEFAULT_LOCALE)!;
  try {
    return new Intl.Locale(locale).toString();
  } catch {
    throw new Error("SESSION_BACKGROUND_LOCALE_INVALID");
  }
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function localDateAt(referenceTime: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(referenceTime));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught);
}

interface FixedBackgroundState {
  backgroundId: string;
  fixedRevision: number;
  fixedText: string;
  fixedTextUpdatedAt: string;
  fixedWatermark: BackgroundStmCursor;
  sourceRefIds: string[];
  conflictIds: string[];
}

interface NormalizedSessionBackgroundRequest extends CreateSessionBackgroundRequest {
  sessionId: string;
  tenantId: string;
  principalId: string;
  referenceTime: string;
  timezone: string;
  locale: string;
  localDate: string;
  tokenBudget: number;
  maxInputTokens: number;
  maxDynamicCandidates: number;
  stmPageSize: number;
  statsCountLimit: number;
  cacheTtlMs: number;
  singleFlightTimeoutMs: number;
  deferredRangeLimit: number;
  forceRefresh: boolean;
  persistedBackground: boolean;
  now: () => string;
}

interface DynamicGenerationContext {
  normalized: NormalizedSessionBackgroundRequest;
  fixed: FixedBackgroundState;
  windowStart: string;
  windowEnd: string;
  latestStmCursor: BackgroundStmCursor;
  pendingStmCount: number;
  watermarkLagSeconds: number;
  cacheKey: string;
}
