import type { ContextPackTrace, RelationEdge, SourceRef, TemporalConfidence } from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { getContextEngineConfig } from "../../config.js";
import { isLlmRequestRetryExhausted, postOpenAiCompatibleJson } from "./llm-request.js";
import {
  searchContext,
  type ContextQuery,
  type ContextSearchFactContext,
  type ContextSearchResult,
  type ContextSearchTemporalResult
} from "./search-context.js";
import { estimateContextTokens } from "./token-estimator.js";
import type { ResolvedTemporalQuery } from "./temporal-query.js";
import type { EmbeddingClient } from "./embedding.js";
import type { CrossEncoderReranker } from "./cross-encoder-reranker.js";

export interface AssembleContextRequest extends Omit<ContextQuery, "q" | "layer"> {
  task: string;
  q?: string;
  layer?: "all" | "fact" | "stm" | "ltm";
  tokenBudget?: number;
  llmCompression?: boolean;
  recordRetrieval?: boolean;
  recordPackTrace?: boolean;
  embeddingClient?: EmbeddingClient;
  /** Include raw Fact documents in benchmark retrieval. Defaults to the production search policy. */
  factRetrieval?: boolean;
  memoryReranker?: CrossEncoderReranker | false;
  llm?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}

export interface ContextPackItem {
  id: string;
  layer: ContextSearchResult["layer"];
  content: string;
  compressedContent: string;
  score: number;
  sourceRefs: SourceRef[];
  sourceMessageIds: string[];
  factIds: string[];
  memoryIds: string[];
  factContext?: ContextSearchFactContext;
  temporal: ContextSearchTemporalResult;
}

export interface ContextPack {
  packId: string;
  task: string;
  scope?: {
    questionId: string;
    contextScopeId: string;
    modelRunId: string;
    storeNamespace: string;
  };
  temporal: ResolvedTemporalQuery;
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
    kind: "graph" | "fact";
    edgeId: string;
    fromId: string;
    toId: string;
    evidence?: string;
    factIds: string[];
    sourceRefs: SourceRef[];
    itemIds: string[];
  }>;
  tokenBudget: {
    requested: number;
    used: number;
    allocations: ContextPackTrace["tokenUsage"];
    plan: {
      profileContext: number;
      taskContext: number;
      recentContext: number;
      constraints: number;
      citations: number;
      conflicts: number;
      reservedForCritical: number;
    };
  };
  compressionSteps: Array<{
    id: string;
    layer?: ContextSearchResult["layer"];
    action: "keep" | "compress" | "drop";
    beforeTokens: number;
    afterTokens: number;
    reason: string;
  }>;
  dropped: Array<{
    id: string;
    layer?: ContextSearchResult["layer"];
    reason: string;
  }>;
  traceId: string;
}

interface CompressionResult {
  content: string;
  reason:
    | "fits_within_budget"
    | "summary_field"
    | "llm_context_summary"
    | "llm_context_summary_failed"
    | "local_semantic_summary"
    | "high_value_summary_preserved"
    | "low_priority_budget_pressure"
    | "no_budget_left";
}

interface AssemblyCandidate {
  result: ContextSearchResult;
  bucket: "profileContext" | "taskContext" | "recentContext" | "constraints";
  item: ContextPackItem;
  estimatedTokens: number;
  priority: number;
}

interface EffectiveBudgetPlan {
  bucketReserve: ReturnType<typeof allocateBudget>["bucketReserve"];
  effectiveBucketReserve: ReturnType<typeof allocateBudget>["bucketReserve"];
  reservedForCritical: number;
  citations: number;
  conflicts: number;
}

export async function assembleContext(
  repository: ContextEngineRepository,
  request: AssembleContextRequest
): Promise<ContextPack> {
  const task = request.task.trim();
  if (!task) {
    throw new Error("task is required");
  }

  const requestedBudget = clampTokenBudget(request.tokenBudget);
  const query: ContextQuery = {
    q: request.q?.trim() || task,
    limit: request.limit ?? 50,
    offset: request.offset ?? 0,
    ...(request.tenantId ? { tenantId: request.tenantId } : {}),
    ...(request.principalId ? { principalId: request.principalId } : {}),
    ...(request.contextScopeId ? { contextScopeId: request.contextScopeId } : {}),
    ...(request.sourceIds ? { sourceIds: request.sourceIds } : {}),
    ...(request.referenceTime ? { referenceTime: request.referenceTime } : {}),
    ...(request.timezone ? { timezone: request.timezone } : {}),
    ...(request.locale ? { locale: request.locale } : {}),
    ...(request.timeRange ? { timeRange: request.timeRange } : {}),
    ...(request.includeInactive !== undefined ? { includeInactive: request.includeInactive } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.requestId ? { requestId: request.requestId } : {})
  };
  const search = await searchContext(
    repository,
    {
      ...query,
      layer: request.layer ?? "all"
    },
    {
      ...(request.recordRetrieval !== undefined ? { recordRetrieval: request.recordRetrieval } : {}),
      ...(request.embeddingClient ? { embeddingClient: request.embeddingClient } : {}),
      ...(request.factRetrieval !== undefined ? { factRetrieval: request.factRetrieval } : {}),
      ...(request.memoryReranker !== undefined ? { memoryReranker: request.memoryReranker } : {})
    }
  );
  const dropped: ContextPack["dropped"] = search.dropped.map((item) => ({
    id: item.id,
    layer: item.layer,
    reason: `search:${item.reason}`
  }));
  const authorizedResults = filterPackResults(search.results, query, dropped);
  const mergedResults = mergePackResults(authorizedResults, dropped);

  const pack: Omit<ContextPack, "tokenBudget" | "traceId"> = {
    packId: `pack_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    task,
    temporal: search.temporal,
    serializedPrompt: "",
    profileContext: [],
    taskContext: [],
    recentContext: [],
    constraints: [],
    citations: [],
    conflicts: [],
    compressionSteps: [],
    dropped
  };

  const usage: ContextPackTrace["tokenUsage"] = {
    profile: 0,
    task: 0,
    recent: 0,
    constraints: 0,
    citations: 0,
    conflicts: 0,
    total: 0
  };
  const selected: ContextPackItem[] = [];
  const compressionSteps: ContextPack["compressionSteps"] = [];
  const budgetPlan = allocateBudget(requestedBudget);
  const candidates = mergedResults
    .map((result): AssemblyCandidate => {
      const bucket = chooseBucket(result);
      const item = toPackItem(result);
      return {
        result,
        bucket,
        item,
        estimatedTokens: estimateTokens(item.content),
        priority: assemblyPriority(result, query.q)
      };
    });
  const effectiveBudgetPlan = allocateUnusedBucketBudget(requestedBudget, budgetPlan, candidates);
  const bucketPressure = calculateBucketPressure(candidates, budgetPlan.bucketReserve);

  for (const candidate of candidates.sort(compareAssemblyCandidates)) {
    const { result, bucket, item, estimatedTokens } = candidate;
    const usageKey = bucketToUsageKey(bucket);
    const availableBudget = Math.max(0, effectiveBudgetPlan.effectiveBucketReserve[bucket] - usage[usageKey]);
    const isPressured = bucketPressure[bucket];
    const isLowPriority = isLowPriorityCandidate(candidate);
    const isHighValue = isHighValueCandidate(candidate);
    const compression = await compressContent(item.content, availableBudget, [result.factSummary, result.summary], query.q, {
      preferSummary: isPressured && isLowPriority,
      ...(isPressured && isLowPriority ? { pressureReason: "low_priority_budget_pressure" as const } : {}),
      ...(isPressured && isHighValue ? { highValueReason: "high_value_summary_preserved" as const } : {}),
      llmCompression: request.llmCompression ?? Boolean(request.llm),
      llm: request.llm
    });
    const compressedContent = compression.content;
    const compressedTokens = estimateTokens(compressedContent);

    if (!compressedContent.trim()) {
      dropped.push({ id: result.id, layer: result.layer, reason: "token_budget_exceeded" });
      compressionSteps.push({
        id: result.id,
        layer: result.layer,
        action: "drop",
        beforeTokens: estimatedTokens,
        afterTokens: 0,
        reason: compression.reason
      });
      continue;
    }

    const selectedItem: ContextPackItem = {
      ...item,
      compressedContent
    };

    if (compressedTokens < estimatedTokens) {
      compressionSteps.push({
        id: result.id,
        layer: result.layer,
        action: "compress",
        beforeTokens: estimatedTokens,
        afterTokens: compressedTokens,
        reason: compression.reason
      });
    } else {
      compressionSteps.push({
        id: result.id,
        layer: result.layer,
        action: "keep",
        beforeTokens: estimatedTokens,
        afterTokens: compressedTokens,
        reason: "fits_within_budget"
      });
    }

    pack[bucket].push(selectedItem);
    selected.push(selectedItem);
    usage[usageKey] += compressedTokens;
    usage.total += compressedTokens;
  }

  pack.recentContext.sort(compareRecentContext);
  pack.citations = buildCitations(selected);
  usage.citations = estimateTokens(pack.citations.map((item) => `${item.sourceType}:${item.sourceId}`).join("\n"));
  pack.conflicts = buildConflicts(mergedResults);
  usage.conflicts = estimateTokens(pack.conflicts.map((item) => item.evidence ?? item.edgeId).join("\n"));
  usage.total += usage.citations + usage.conflicts;

  const traceId = `trace_${pack.packId}`;
  const finalPack: ContextPack = {
    ...pack,
    serializedPrompt: renderSerializedPrompt({
      task,
      packId: pack.packId,
      temporal: pack.temporal,
      profileContext: pack.profileContext,
      taskContext: pack.taskContext,
      recentContext: pack.recentContext,
      constraints: pack.constraints,
      citations: pack.citations,
      conflicts: pack.conflicts
    }),
    compressionSteps,
    tokenBudget: {
      requested: requestedBudget,
      used: usage.total,
      allocations: usage,
      plan: {
        profileContext: budgetPlan.bucketReserve.profileContext,
        taskContext: budgetPlan.bucketReserve.taskContext,
        recentContext: budgetPlan.bucketReserve.recentContext,
        constraints: budgetPlan.bucketReserve.constraints,
        citations: budgetPlan.citations,
        conflicts: budgetPlan.conflicts,
        reservedForCritical: budgetPlan.reservedForCritical
      }
    },
    traceId
  };

  if (request.recordPackTrace !== false) {
    await repository.saveContextPackTrace({
      traceId,
      packId: pack.packId,
      task,
      finalScore: averageScore(selected),
      tokenBudget: requestedBudget,
      tokenUsage: usage,
      selectedItemIds: selected.map((item) => item.id),
      droppedReasons: dropped.map((item) => `${item.id}:${item.reason}`),
      compressionSteps,
      temporal: search.trace,
      createdAt: new Date().toISOString()
    });
  }

  if (request.recordRetrieval !== false) {
    await Promise.all(selected.flatMap((item) => {
      if (item.layer !== "fact" && item.layer !== "stm" && item.layer !== "ltm") return [];
      return [repository.saveMemoryRetrievalEvent({
        retrievalEventId: `retrieval_pack_${pack.packId}_${item.layer}_${item.id}`,
        ownerType: item.layer,
        ownerId: item.id,
        ...(request.tenantId ? { tenantId: request.tenantId } : {}),
        ...(request.principalId ? { principalId: request.principalId } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.taskId ? { taskId: request.taskId } : {}),
        requestId: pack.packId,
        eventType: "context_pack_selected",
        query: query.q,
        createdAt: new Date().toISOString()
      })];
    }));
  }

  return finalPack;
}

function chooseBucket(result: ContextSearchResult): "profileContext" | "taskContext" | "recentContext" | "constraints" {
  const content = result.content.toLowerCase();
  if (content.includes("must") || content.includes("shall") || content.includes("constraint") || content.includes("必须")) {
    return "constraints";
  }
  if (result.layer === "ltm") return "profileContext";
  if (result.layer === "fact") return "taskContext";
  if (result.layer === "evidence" || result.scoreBreakdown.recency >= 0.75 || result.layer === "stm") {
    return "recentContext";
  }
  return "taskContext";
}

function bucketToUsageKey(bucket: ReturnType<typeof chooseBucket>): keyof Omit<ContextPackTrace["tokenUsage"], "total" | "citations" | "conflicts"> {
  if (bucket === "profileContext") return "profile";
  if (bucket === "taskContext") return "task";
  if (bucket === "recentContext") return "recent";
  return "constraints";
}

function toPackItem(result: ContextSearchResult): ContextPackItem {
  const sourceRefs = mergeSourceRefs(result.sourceRefs);
  return {
    id: result.id,
    layer: result.layer,
    content: result.content,
    compressedContent: result.content,
    score: result.score,
    sourceRefs,
    sourceMessageIds: sourceMessageIdsFromRefs(sourceRefs),
    factIds: uniqueStrings(result.factIds),
    memoryIds: uniqueStrings(result.memoryIds),
    factContext: cloneFactContext(result.factContext),
    temporal: { ...result.temporal }
  };
}

function filterPackResults(
  results: ContextSearchResult[],
  query: ContextQuery,
  dropped: ContextPack["dropped"]
) {
  return results.filter((result) => {
    if (result.permissionStatus !== "allowed") {
      dropped.push({ id: result.id, layer: result.layer, reason: "pack:permission_filtered" });
      return false;
    }
    if ((query.tenantId || query.principalId) && result.sourceRefs.length === 0) {
      dropped.push({ id: result.id, layer: result.layer, reason: "pack:missing_source_refs" });
      return false;
    }
    return true;
  });
}

function mergePackResults(
  results: ContextSearchResult[],
  dropped: ContextPack["dropped"]
) {
  const groups: Array<{ members: ContextSearchResult[]; keys: Set<string> }> = [];

  for (const result of results) {
    const keys = packDedupKeys(result);
    const matchingGroups = groups.filter((group) => keys.some((key) => group.keys.has(key)));
    if (!matchingGroups.length) {
      groups.push({ members: [result], keys: new Set(keys) });
      continue;
    }

    const target = matchingGroups[0]!;
    target.members.push(result);
    for (const key of keys) target.keys.add(key);
    for (const group of matchingGroups.slice(1)) {
      for (const member of group.members) target.members.push(member);
      for (const key of group.keys) target.keys.add(key);
      groups.splice(groups.indexOf(group), 1);
    }
  }

  return groups.map((group) => {
    const representative = [...group.members].sort(comparePackRepresentatives)[0]!;
    const merged = mergeResultGroup(representative, group.members);
    for (const member of group.members) {
      if (member === representative) continue;
      dropped.push({
        id: member.id,
        layer: member.layer,
        reason: `pack:duplicate_of:${representative.id}`
      });
    }
    return merged;
  });
}

function packDedupKeys(result: ContextSearchResult) {
  const hasFactConflict = result.factContext.conflicts.length > 0;
  const keys = (hasFactConflict ? [] : result.sourceRefs)
    .filter(isConcreteSourceRef)
    .map((source) => `source:${source.sourceType}:${source.sourceRefId || source.sourceId}`);
  keys.push(...result.factIds.map((factId) => `fact:${factId}`));
  keys.push(...result.memoryIds.map((memoryId) => `memory:${memoryId}`));
  const content = hasFactConflict ? "" : normalizeDedupContent(result.content);
  if (content) keys.push(`content:${content}`);
  return uniqueStrings(keys);
}

function comparePackRepresentatives(left: ContextSearchResult, right: ContextSearchResult) {
  return (
    resultSourceSpecificity(right) - resultSourceSpecificity(left) ||
    layerRepresentativePriority(right.layer) - layerRepresentativePriority(left.layer) ||
    right.score - left.score ||
    left.id.localeCompare(right.id)
  );
}

function resultSourceSpecificity(result: ContextSearchResult) {
  const priorities = result.sourceRefs.map(sourceRefPriority);
  const strongest = Math.max(0, ...priorities);
  const concreteCount = priorities.filter((priority) => priority > 1).length;
  return strongest * 10_000 + concreteCount * 100 + result.sourceRefs.length;
}

function layerRepresentativePriority(layer: ContextSearchResult["layer"]) {
  if (layer === "evidence") return 3;
  if (layer === "fact") return 3;
  if (layer === "stm") return 2;
  return 1;
}

function mergeResultGroup(representative: ContextSearchResult, members: ContextSearchResult[]): ContextSearchResult {
  const temporal = mergeTemporalResults(representative.temporal, members.map((member) => member.temporal));
  const relationEdges = uniqueBy(
    members.flatMap((member) => member.relationEdges),
    (edge) => edge.edgeId
  );
  return {
    ...representative,
    score: Math.max(...members.map((member) => member.score)),
    sourceRefs: mergeSourceRefs(members.flatMap((member) => member.sourceRefs)),
    factIds: uniqueStrings(members.flatMap((member) => member.factIds)),
    memoryIds: uniqueStrings(members.flatMap((member) => member.memoryIds)),
    factContext: mergeFactContexts(members.map((member) => member.factContext)),
    temporal,
    ...(temporal.evidenceTime ? { evidenceTime: temporal.evidenceTime } : {}),
    ...(temporal.evidenceTimeStart ? { evidenceTimeStart: temporal.evidenceTimeStart } : {}),
    ...(temporal.evidenceTimeEnd ? { evidenceTimeEnd: temporal.evidenceTimeEnd } : {}),
    ...(temporal.evidenceTimeConfidence
      ? { evidenceTimeConfidence: temporal.evidenceTimeConfidence }
      : {}),
    relationEdges
  };
}

function mergeTemporalResults(
  representative: ContextSearchTemporalResult,
  values: ContextSearchTemporalResult[]
): ContextSearchTemporalResult {
  const matchedBasis = representative.matchedBasis ?? values.find((value) => value.matchedBasis)?.matchedBasis;
  return {
    ...optionalField("evidenceTime", uniqueTimestamp(values.map((value) => value.evidenceTime))),
    ...optionalField("validTime", uniqueTimestamp(values.map((value) => value.validTime))),
    ...optionalField("events", mergeTemporalEvents(values)),
    ...optionalField("evidenceTimeStart", earliestTimestamp(values.map((value) => value.evidenceTimeStart))),
    ...optionalField("evidenceTimeEnd", latestTimestamp(values.map((value) => value.evidenceTimeEnd ?? value.evidenceTimeStart))),
    ...optionalField("validTimeStart", earliestTimestamp(values.map((value) => value.validTimeStart))),
    ...optionalField("validTimeEnd", latestTimestamp(values.map((value) => value.validTimeEnd ?? value.validTimeStart))),
    ...(matchedBasis ? { matchedBasis } : {}),
    ...optionalField(
      "evidenceTimeConfidence",
      lowestTemporalConfidence(values.map((value) => value.evidenceTimeConfidence))
    ),
    ...optionalField(
      "validTimeConfidence",
      lowestTemporalConfidence(values.map((value) => value.validTimeConfidence))
    )
  };
}

function mergeTemporalEvents(values: ContextSearchTemporalResult[]) {
  const byIdentity = new Map<string, NonNullable<ContextSearchTemporalResult["events"]>[number]>();
  for (const event of values.flatMap((value) => value.events ?? [])) {
    byIdentity.set(`${event.eventKey}\u0000${event.validTime}`, event);
  }
  const events = [...byIdentity.values()].sort((left, right) =>
    left.validTime.localeCompare(right.validTime) || left.eventKey.localeCompare(right.eventKey)
  );
  return events.length ? events : undefined;
}

function uniqueTimestamp(values: Array<string | undefined>) {
  const present = uniqueStrings(values.filter((value): value is string => Boolean(value)));
  return present.length === 1 ? present[0] : undefined;
}

function optionalField<Key extends string, Value>(key: Key, value: Value | undefined) {
  return value === undefined ? {} : { [key]: value } as Record<Key, Value>;
}

function earliestTimestamp(values: Array<string | undefined>) {
  return orderedTimestamps(values)[0];
}

function latestTimestamp(values: Array<string | undefined>) {
  return orderedTimestamps(values).at(-1);
}

function orderedTimestamps(values: Array<string | undefined>) {
  return uniqueStrings(values.filter((value): value is string => Boolean(value)))
    .sort((left, right) => timestampValue(left) - timestampValue(right) || left.localeCompare(right));
}

function timestampValue(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function lowestTemporalConfidence(values: Array<TemporalConfidence | undefined>) {
  const present = values.filter((value): value is TemporalConfidence => Boolean(value));
  if (!present.length) return undefined;
  const rank: Record<TemporalConfidence, number> = { low: 0, medium: 1, high: 2 };
  return [...present].sort((left, right) => rank[left] - rank[right])[0];
}

function mergeSourceRefs(sourceRefs: SourceRef[]) {
  return uniqueBy(sourceRefs, (source) => source.sourceRefId)
    .sort(compareSourceRefs);
}

function compareSourceRefs(left: SourceRef, right: SourceRef) {
  return (
    sourceRefPriority(right) - sourceRefPriority(left) ||
    left.sourceType.localeCompare(right.sourceType) ||
    left.sourceId.localeCompare(right.sourceId)
  );
}

function sourceRefPriority(source: SourceRef) {
  if (source.sourceType === "conversation_message") return 3;
  if (source.sourceType === "parsed_segment") return 2;
  return 1;
}

function isConcreteSourceRef(source: SourceRef) {
  return source.sourceType === "conversation_message" || source.sourceType === "parsed_segment";
}

function sourceMessageIdsFromRefs(sourceRefs: SourceRef[]) {
  return uniqueStrings(sourceRefs.flatMap((source) => {
    const messageId = source.metadata?.messageId;
    return source.sourceType === "conversation_message" && typeof messageId === "string"
      ? [messageId]
      : [];
  }));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function uniqueBy<Value>(values: Value[], keyOf: (value: Value) => string) {
  const result = new Map<string, Value>();
  for (const value of values) {
    const key = keyOf(value);
    if (!result.has(key)) result.set(key, value);
  }
  return [...result.values()];
}

function normalizeDedupContent(content: string) {
  return content.toLowerCase().replace(/\s+/gu, " ").trim();
}

function compareRecentContext(left: ContextPackItem, right: ContextPackItem) {
  const leftTime = evidenceSortTimestamp(left);
  const rightTime = evidenceSortTimestamp(right);
  return rightTime - leftTime || right.score - left.score || left.id.localeCompare(right.id);
}

function evidenceSortTimestamp(item: ContextPackItem) {
  const value = item.temporal.evidenceTime ?? item.temporal.evidenceTimeEnd ?? item.temporal.evidenceTimeStart;
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function calculateBucketPressure(
  candidates: AssemblyCandidate[],
  bucketReserve: ReturnType<typeof allocateBudget>["bucketReserve"]
) {
  const totals = {
    profileContext: 0,
    taskContext: 0,
    recentContext: 0,
    constraints: 0
  };
  for (const candidate of candidates) {
    totals[candidate.bucket] += candidate.estimatedTokens;
  }
  return {
    profileContext: totals.profileContext > bucketReserve.profileContext,
    taskContext: totals.taskContext > bucketReserve.taskContext,
    recentContext: totals.recentContext > bucketReserve.recentContext,
    constraints: totals.constraints > bucketReserve.constraints
  };
}

function allocateUnusedBucketBudget(
  requestedBudget: number,
  budgetPlan: ReturnType<typeof allocateBudget>,
  candidates: AssemblyCandidate[]
): EffectiveBudgetPlan {
  if (requestedBudget < 1000) {
    return {
      bucketReserve: budgetPlan.bucketReserve,
      effectiveBucketReserve: budgetPlan.bucketReserve,
      reservedForCritical: budgetPlan.reservedForCritical,
      citations: budgetPlan.citations,
      conflicts: budgetPlan.conflicts
    };
  }

  const candidateCounts = {
    profileContext: 0,
    taskContext: 0,
    recentContext: 0,
    constraints: 0
  };
  for (const candidate of candidates) {
    candidateCounts[candidate.bucket] += 1;
  }

  const activeBuckets = Object.entries(candidateCounts)
    .filter(([, count]) => count > 0)
    .map(([bucket]) => bucket as keyof typeof candidateCounts);
  const effectiveBucketReserve = { ...budgetPlan.bucketReserve };
  if (activeBuckets.length > 0) {
    const unusedReserve = (Object.keys(candidateCounts) as Array<keyof typeof candidateCounts>)
      .filter((bucket) => candidateCounts[bucket] === 0)
      .reduce((sum, bucket) => sum + budgetPlan.bucketReserve[bucket], 0);
    const activePrioritySum = activeBuckets.reduce((sum, bucket) => {
      const bucketPriority = candidates
        .filter((candidate) => candidate.bucket === bucket)
        .reduce((total, candidate) => total + Math.max(1, candidate.priority), 0);
      return sum + Math.max(1, bucketPriority);
    }, 0);

    for (const bucket of activeBuckets) {
      const bucketPriority = candidates
        .filter((candidate) => candidate.bucket === bucket)
        .reduce((total, candidate) => total + Math.max(1, candidate.priority), 0);
      const share = activePrioritySum > 0 ? Math.floor(unusedReserve * (bucketPriority / activePrioritySum)) : 0;
      effectiveBucketReserve[bucket] += share;
    }
  }

  return {
    bucketReserve: budgetPlan.bucketReserve,
    effectiveBucketReserve,
    reservedForCritical: budgetPlan.reservedForCritical,
    citations: budgetPlan.citations,
    conflicts: budgetPlan.conflicts
  };
}

function compareAssemblyCandidates(left: AssemblyCandidate, right: AssemblyCandidate) {
  return right.priority - left.priority || right.result.score - left.result.score || left.result.id.localeCompare(right.result.id);
}

function assemblyPriority(result: ContextSearchResult, queryText: string) {
  const queryTerms = tokenizeCompressionQuery(queryText);
  const taskMatch = queryTerms.length
    ? queryTerms.filter((term) => result.content.toLowerCase().includes(term)).length / queryTerms.length
    : 0;
  return (
    result.scoreBreakdown.importance * 30 +
    result.scoreBreakdown.sourceReliability * 12 +
    taskMatch * 24 +
    result.score * 4 +
    (result.factIds.length > 0 ? 12 : 0) +
    (result.sourceRefs.length > 0 ? 8 : 0) +
    (isTaskLikeMemoryType(result.memoryType) ? 10 : 0) +
    (result.relationEdges.some(isConflictEdge) ? 20 : 0)
  );
}

function isHighValueCandidate(candidate: AssemblyCandidate) {
  const result = candidate.result;
  return (
    candidate.bucket === "constraints" ||
    result.scoreBreakdown.importance >= 0.8 ||
    result.factIds.length > 0 ||
    result.relationEdges.some(isConflictEdge) ||
    isTaskLikeMemoryType(result.memoryType)
  );
}

function isLowPriorityCandidate(candidate: AssemblyCandidate) {
  const result = candidate.result;
  return (
    candidate.bucket !== "constraints" &&
    result.scoreBreakdown.importance <= 0.35 &&
    result.factIds.length === 0 &&
    !result.relationEdges.some(isConflictEdge) &&
    !isTaskLikeMemoryType(result.memoryType)
  );
}

function isTaskLikeMemoryType(memoryType: string | undefined) {
  return memoryType === "project_status" ||
    memoryType === "prospective" ||
    memoryType === "task" ||
    memoryType === "constraint" ||
    memoryType === "action_item";
}

async function compressContent(
  content: string,
  budget: number,
  alternatives: Array<string | undefined> = [],
  queryText = "",
  options: {
    preferSummary?: boolean;
    pressureReason?: CompressionResult["reason"];
    highValueReason?: CompressionResult["reason"];
    llmCompression?: boolean;
    llm?: AssembleContextRequest["llm"];
  } = {}
): Promise<CompressionResult> {
  const text = content.trim();
  if (!text) return { content: "", reason: "no_budget_left" };
  if (budget <= 0) return { content: "", reason: "no_budget_left" };

  const summary = alternatives
    .map((item) => normalizeSummaryCandidate(item ?? ""))
    .find((item) => isMeaningfulSummary(item) && item !== text && estimateTokens(item) <= budget);
  if (options.preferSummary && summary) {
    return { content: summary, reason: options.pressureReason ?? options.highValueReason ?? "summary_field" };
  }

  if (estimateTokens(text) <= budget) return { content: text, reason: "fits_within_budget" };

  if (options.llmCompression) {
    const llmSummary = await summarizeContextWithLlm(text, budget, queryText, options.llm);
    if (llmSummary) return { content: llmSummary, reason: "llm_context_summary" };
  }

  if (summary) return { content: summary, reason: options.pressureReason ?? options.highValueReason ?? "summary_field" };

  const localSummary = buildLocalSemanticSummary(text, budget, queryText);
  if (localSummary) {
    return { content: localSummary, reason: options.pressureReason ?? "local_semantic_summary" };
  }

  return { content: "", reason: options.pressureReason ?? "no_budget_left" };
}

async function summarizeContextWithLlm(
  content: string,
  budget: number,
  queryText: string,
  options: AssembleContextRequest["llm"] = {}
) {
  const config = getContextEngineConfig();
  const endpointBase = normalizeBaseUrl(options.baseUrl ?? config.llm.baseUrl);
  const endpoint = `${endpointBase}/chat/completions`;
  const model = options.model?.trim() || config.llm.model;
  const requestApiKey = options.apiKey?.trim();
  const apiKey = requestApiKey ?? config.llm.apiKey;
  if (!apiKey) return "";

  try {
    const response = await postOpenAiCompatibleJson({
      endpoint,
      apiKey,
      operation: "context_pack_compression",
      timeoutMs: 60_000,
      body: {
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "你是 Context Pack 摘要压缩器。只返回严格 JSON，不要输出 Markdown、代码块或解释。"
          },
          {
            role: "user",
            content: JSON.stringify({
              instruction: "请将记忆内容压缩成可直接注入给智能体的中文摘要，保留高价值事实、当前任务相关信息和来源线索，不编造原文没有的信息。",
              task: queryText,
              maxTokens: budget,
              outputSchema: { summary: "string" },
              content
            })
          }
        ]
      }
    });
    const summary = normalizeSummaryCandidate(extractLlmSummary(response));
    return isMeaningfulSummary(summary) && estimateTokens(summary) <= budget ? ensureCompleteSentence(summary) : "";
  } catch (error) {
    if (isLlmRequestRetryExhausted(error)) throw error;
    return "";
  }
}

function extractLlmSummary(response: unknown) {
  const content = readChoiceContent(response);
  if (!content) return "";
  const parsed = parseJsonObject(content);
  if (parsed && typeof parsed.summary === "string") return parsed.summary;
  return content;
}

function readChoiceContent(response: unknown) {
  if (!response || typeof response !== "object") return "";
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (message && typeof message === "object" && typeof (message as { content?: unknown }).content === "string") {
    return (message as { content: string }).content;
  }
  if (typeof (first as { text?: unknown }).text === "string") return (first as { text: string }).text;
  return "";
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/u, "");
}

function buildLocalSemanticSummary(text: string, budget: number, queryText: string) {
  const queryTerms = tokenizeCompressionQuery(queryText);
  const fragments = splitIntoSemanticFragments(text)
    .map((fragment, index) => ({
      fragment,
      index,
      score: semanticFragmentScore(fragment, queryTerms, index)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  for (const { fragment } of fragments) {
    const fitted = fitSemanticFragment(fragment, budget);
    if (fitted) return fitted;
  }

  return "";
}

function splitIntoSemanticFragments(text: string) {
  const normalized = text
    .replace(/\s+/g, " ")
    .replace(/\s+(?=(?:\d+|[一二三四五六七八九十]+)[.、)]\s*\S)/gu, "。")
    .replace(/(^|[。！？；;]\s*)(?:小结|总结|待办)[:：]?\s*/gu, "$1")
    .replace(/(^|[。！？；;]\s*)(?:\d+|[一二三四五六七八九十]+)[.、)]\s*/gu, "$1")
    .trim();

  return normalized
    .split(/(?<=[。！？；;!?.])\s*/gu)
    .map(normalizeSummaryCandidate)
    .filter(isMeaningfulSummary);
}

function fitSemanticFragment(fragment: string, budget: number) {
  const normalized = normalizeSummaryCandidate(fragment);
  if (!isMeaningfulSummary(normalized)) return "";
  if (estimateTokens(normalized) <= budget) return ensureCompleteSentence(normalized);

  const phrase = firstSemanticPhrase(normalized);
  if (phrase && estimateTokens(phrase) <= budget) return ensureCompleteSentence(phrase);

  const clauses = normalized
    .split(/(?<=[，,、；;.])\s*|\s+(?=本次会议|系统|架构|核心|旨在|事件|方案|开发|用户|Agent|agent)/gu)
    .map(normalizeSummaryCandidate)
    .filter(isMeaningfulSummary);
  const picked: string[] = [];
  let used = 0;

  for (const clause of clauses) {
    const nextUsed = used + estimateTokens(clause);
    if (nextUsed > budget) continue;
    picked.push(clause);
    used = nextUsed;
    if (used >= budget) break;
  }

  const summary = normalizeSummaryCandidate(picked.join(""));
  return summary && isMeaningfulSummary(summary) ? ensureCompleteSentence(summary) : "";
}

function firstSemanticPhrase(fragment: string) {
  return normalizeSummaryCandidate(fragment
    .replace(/\s+(?:本次会议|系统将|架构设计|核心功能模块|旨在|为|事件管理|方案输出|开发节奏).*$/u, "")
    .replace(/[，,、；;：:].*$/u, ""));
}

function normalizeSummaryCandidate(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^(?:小结|总结|待办)[:：]?\s*/u, "")
    .replace(/^(?:\d+|[一二三四五六七八九十]+)[.、)]\s*/u, "")
    .replace(/[，,、:：；;]+$/u, "")
    .trim();
}

function isMeaningfulSummary(value: string) {
  if (!value) return false;
  if (!/[A-Za-z\u3400-\u9fff\uf900-\ufaff]/u.test(value)) return false;
  if (/^(?:小结|总结|待办)?\s*(?:\d+[.、)]?\s*)+$/u.test(value)) return false;
  if (/^[\d\s.、)：:;；-]+$/u.test(value)) return false;
  return estimateTokens(value) >= 4;
}

function ensureCompleteSentence(value: string) {
  const normalized = normalizeSummaryCandidate(value);
  if (!normalized) return "";
  if (/[。！？.!?]$/u.test(normalized)) return normalized;
  return `${normalized}。`;
}

function semanticFragmentScore(fragment: string, queryTerms: string[], index: number) {
  const normalized = fragment.toLowerCase();
  const queryScore = queryTerms.filter((term) => normalized.includes(term)).length * 10;
  const positionScore = Math.max(0, 5 - index);
  const densityScore = Math.min(5, Math.ceil(estimateTokens(fragment) / 20));
  return queryScore + positionScore + densityScore;
}

function tokenizeCompressionQuery(queryText: string) {
  return queryText
    .toLowerCase()
    .split(/[\s,，、。！？；;:：()（）[\]{}"'“”]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildCitations(items: ContextPackItem[]) {
  const grouped = new Map<string, ContextPack["citations"][number]>();
  for (const item of items) {
    for (const source of item.sourceRefs) {
      const key = source.sourceRefId;
      const existing = grouped.get(key);
      if (existing) {
        existing.itemIds.push(item.id);
        continue;
      }
      grouped.set(key, {
        sourceRefId: source.sourceRefId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        itemIds: [item.id]
      });
    }
  }
  return [...grouped.values()].sort((left, right) =>
    citationPriority(right.sourceType) - citationPriority(left.sourceType) ||
    left.sourceType.localeCompare(right.sourceType) ||
    left.sourceId.localeCompare(right.sourceId)
  );
}

function citationPriority(sourceType: string) {
  if (sourceType === "conversation_message") return 3;
  if (sourceType === "parsed_segment") return 2;
  return 1;
}

function buildConflicts(results: ContextSearchResult[]) {
  const conflicts = new Map<string, ContextPack["conflicts"][number]>();
  for (const result of results) {
    for (const edge of result.relationEdges.filter(isConflictEdge)) {
      const existing = conflicts.get(edge.edgeId);
      if (existing) {
        if (!existing.itemIds.includes(result.id)) existing.itemIds.push(result.id);
        continue;
      }
      conflicts.set(edge.edgeId, {
        kind: "graph",
        edgeId: edge.edgeId,
        fromId: edge.fromId,
        toId: edge.toId,
        ...(edge.evidence ? { evidence: edge.evidence } : {}),
        factIds: [],
        sourceRefs: [],
        itemIds: [result.id]
      });
    }
    for (const conflict of result.factContext.conflicts) {
      const endpoints = uniqueStrings([conflict.factId, ...conflict.conflictingFactIds]);
      if (endpoints.length < 2) continue;
      const edgeId = `fact_conflict_${endpoints.join("_")}`;
      const existing = conflicts.get(edgeId);
      if (existing) {
        existing.itemIds = uniqueStrings([...existing.itemIds, result.id]);
        existing.factIds = uniqueStrings([...existing.factIds, ...conflict.sourceFactIds]);
        existing.sourceRefs = mergeSourceRefs([...existing.sourceRefs, ...conflict.sourceRefs]);
        continue;
      }
      const claimById = new Map([
        ...result.factContext.currentFacts,
        ...result.factContext.sourceFacts
      ].map((fact) => [fact.factId, fact.factText]));
      const claims = endpoints.flatMap((factId) => {
        const claim = claimById.get(factId);
        return claim ? [`${factId}: ${claim}`] : [];
      });
      conflicts.set(edgeId, {
        kind: "fact",
        edgeId,
        fromId: endpoints[0]!,
        toId: endpoints[1]!,
        evidence: [conflict.explanation, ...claims].join(" | "),
        factIds: uniqueStrings(conflict.sourceFactIds),
        sourceRefs: mergeSourceRefs(conflict.sourceRefs),
        itemIds: [result.id]
      });
    }
  }
  return [...conflicts.values()];
}

function isConflictEdge(edge: RelationEdge) {
  return edge.relationType === "conflicts_with";
}

function hasConflict(result: ContextSearchResult) {
  return result.relationEdges.some(isConflictEdge) || result.factContext.conflicts.length > 0;
}

function reserveForCritical(results: ContextSearchResult[]) {
  return results.some(hasConflict) ? 80 : 0;
}

function estimateTokens(text: string) {
  return estimateContextTokens(text);
}

function averageScore(items: ContextPackItem[]) {
  if (!items.length) return 0;
  return Number((items.reduce((sum, item) => sum + item.score, 0) / items.length).toFixed(4));
}

function renderSerializedPrompt(input: {
  task: string;
  packId: string;
  temporal: ResolvedTemporalQuery;
  profileContext: ContextPackItem[];
  taskContext: ContextPackItem[];
  recentContext: ContextPackItem[];
  constraints: ContextPackItem[];
  citations: ContextPack["citations"];
  conflicts: ContextPack["conflicts"];
}) {
  const sections = [
    `【Context Pack】${input.packId}`,
    `【任务】${input.task}`,
    renderQueryTemporal(input.temporal),
    "",
    "【背景信息 — AI 的持久认知】",
    renderSection("长期记忆上下文", input.profileContext, input.temporal),
    renderSection("当前任务", input.taskContext, input.temporal),
    renderSection("最近上下文", input.recentContext, input.temporal),
    renderSection("约束", input.constraints, input.temporal),
    renderCitations(input.citations),
    renderConflicts(input.conflicts)
  ];

  return sections.filter((section) => section.trim()).join("\n");
}

function renderSection(title: string, items: ContextPackItem[], temporal: ResolvedTemporalQuery) {
  if (!items.length) return `【${title}】\n- 无`;
  return [
    `【${title}】`,
    ...items.map((item) => `- ${item.compressedContent}${renderItemTemporal(item, temporal)}`)
  ].join("\n");
}

function renderQueryTemporal(temporal: ResolvedTemporalQuery) {
  const basis = temporalBasisLabel(temporal.basis);
  const range = temporal.range
    ? `${formatPromptTime(temporal.range.startTime, temporal)} 至 ${formatPromptTime(temporal.range.endTime, temporal)}`
    : "未限定硬时间范围";
  return `【时间范围】${range}（${temporal.timezone}，${basis}；解析来源：${temporal.source}；置信度：${temporal.confidence}）`;
}

function renderItemTemporal(item: ContextPackItem, queryTemporal: ResolvedTemporalQuery) {
  const details: string[] = [];
  if (item.temporal.matchedBasis) {
    details.push(`命中依据：${temporalBasisLabel(item.temporal.matchedBasis)}`);
  }
  const validTime = formatItemTimeRange(
    item.temporal.validTime ?? item.temporal.validTimeStart,
    item.temporal.validTime ? undefined : item.temporal.validTimeEnd,
    item.temporal.validTimeConfidence,
    queryTemporal
  );
  if (validTime) details.push(`事实时间：${validTime}`);
  const evidenceTime = formatItemTimeRange(
    item.temporal.evidenceTime ?? item.temporal.evidenceTimeStart,
    item.temporal.evidenceTime ? undefined : item.temporal.evidenceTimeEnd,
    item.temporal.evidenceTimeConfidence,
    queryTemporal
  );
  if (evidenceTime) details.push(`消息时间：${evidenceTime}`);
  const sourceLabels = promptSourceLabels(item);
  if (sourceLabels.length) details.push(`来源：${sourceLabels.join(", ")}`);
  return details.length ? `（${details.join("；")}）` : "";
}

function temporalBasisLabel(basis: ResolvedTemporalQuery["basis"] | NonNullable<ContextSearchTemporalResult["matchedBasis"]>) {
  if (basis === "evidence") return "按消息证据时间";
  if (basis === "valid") return "按事实时间";
  return "自动选择消息证据时间或事实时间";
}

function formatPromptTime(value: string, temporal: ResolvedTemporalQuery) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  try {
    const parts = new Intl.DateTimeFormat(temporal.locale, {
      timeZone: temporal.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(timestamp);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
  } catch {
    return value;
  }
}

function formatItemTimeRange(
  startTime: string | undefined,
  endTime: string | undefined,
  confidence: TemporalConfidence | undefined,
  temporal: ResolvedTemporalQuery
) {
  if (!startTime) return "";
  const formattedStart = formatPromptTime(startTime, temporal);
  const formattedEnd = endTime && endTime !== startTime ? formatPromptTime(endTime, temporal) : undefined;
  const range = formattedEnd ? `${formattedStart} 至 ${formattedEnd}` : formattedStart;
  return confidence ? `${range}（${confidence}）` : range;
}

function promptSourceLabels(item: ContextPackItem) {
  const messageIds = item.sourceMessageIds;
  const concreteRefs = item.sourceRefs
    .filter(isConcreteSourceRef)
    .map((source) => `${source.sourceType}:${source.sourceId}`);
  const fallbackRefs = item.sourceRefs
    .filter((source) => !isConcreteSourceRef(source))
    .map((source) => `${source.sourceType}:${source.sourceId}`);
  return uniqueStrings(messageIds.length ? [...messageIds, ...concreteRefs] : [...concreteRefs, ...fallbackRefs]);
}

function renderCitations(citations: ContextPack["citations"]) {
  if (!citations.length) return "【引用】\n- 无";
  return [
    "【引用】",
    ...citations.map((citation) => `- ${citation.sourceType}:${citation.sourceId} -> ${citation.itemIds.join(", ")}`)
  ].join("\n");
}

function renderConflicts(conflicts: ContextPack["conflicts"]) {
  if (!conflicts.length) return "【冲突】\n- 无";
  return [
    "【冲突】",
    ...conflicts.map((conflict) => {
      const sources = conflict.sourceRefs.map((ref) => `${ref.sourceType}:${ref.sourceId}`);
      const details = [
        conflict.evidence,
        sources.length ? `来源：${sources.join(", ")}` : undefined
      ].filter(Boolean).join("；");
      return `- ${conflict.fromId} <-> ${conflict.toId}${details ? ` (${details})` : ""}`;
    })
  ].join("\n");
}

function cloneFactContext(context: ContextSearchFactContext): ContextSearchFactContext {
  return {
    currentFacts: context.currentFacts.map((fact) => ({
      ...fact,
      sourceFactIds: [...fact.sourceFactIds],
      conflictRefs: [...fact.conflictRefs],
      sourceRefs: mergeSourceRefs(fact.sourceRefs)
    })),
    sourceFacts: context.sourceFacts.map((fact) => ({
      ...fact,
      sourceFactIds: [...fact.sourceFactIds],
      conflictRefs: [...fact.conflictRefs],
      sourceRefs: mergeSourceRefs(fact.sourceRefs)
    })),
    conflicts: context.conflicts.map((conflict) => ({
      ...conflict,
      conflictingFactIds: [...conflict.conflictingFactIds],
      sourceFactIds: [...conflict.sourceFactIds],
      sourceRefs: mergeSourceRefs(conflict.sourceRefs)
    }))
  };
}

function mergeFactContexts(contexts: ContextSearchFactContext[]): ContextSearchFactContext {
  return {
    currentFacts: uniqueBy(contexts.flatMap((context) => context.currentFacts), (fact) =>
      `${fact.factId}:${fact.factVersionId ?? fact.version}`
    ),
    sourceFacts: uniqueBy(contexts.flatMap((context) => context.sourceFacts), (fact) =>
      `${fact.factId}:${fact.factVersionId ?? fact.version}`
    ),
    conflicts: uniqueBy(contexts.flatMap((context) => context.conflicts), (conflict) =>
      `${conflict.factId}:${uniqueStrings(conflict.conflictingFactIds).join(",")}`
    )
  };
}

function clampTokenBudget(value: number | undefined) {
  if (!value || Number.isNaN(value)) return 1200;
  return Math.min(Math.max(100, Math.floor(value)), 12000);
}

function allocateBudget(requestedBudget: number) {
  const constraints = Math.max(80, Math.floor(requestedBudget * 0.24));
  const citations = Math.max(40, Math.floor(requestedBudget * 0.12));
  const conflicts = Math.max(40, Math.floor(requestedBudget * 0.12));
  const profile = Math.max(60, Math.floor(requestedBudget * 0.24));
  const task = Math.max(60, Math.floor(requestedBudget * 0.2));
  const recent = Math.max(60, Math.floor(requestedBudget * 0.2));
  const reservedForCritical = Math.max(0, Math.floor(requestedBudget * 0.1));

  return {
    bucketReserve: {
      profileContext: profile,
      taskContext: task,
      recentContext: recent,
      constraints
    },
    reservedForCritical,
    citations,
    conflicts
  };
}
