import type { ContextEngineRepository } from "./persistence/repository.js";
import { memoryOwnerTypeForId } from "./persistence/graph-store.js";
import type {
  FactItem,
  FactVersion,
  GraphMemorySearchOptions,
  GraphMemoryOwnerType,
  LongTermMemory,
  MemoryTemporalMetadata,
  RelationEdge,
  ShortTermMemory,
  SourceRef,
  TemporalConfidence,
  TemporalTraceMetadata
} from "./domain.js";
import { createEmbeddingClient, type EmbeddingClient } from "./embedding.js";
import { isLongTermRecallEligible, isShortTermRecallEligible } from "./lifecycle.js";
import {
  longTermRetrievalWeight,
  longTermRetrievalWeights,
  shortTermRetrievalWeight,
  shortTermRetrievalWeights
} from "./retrieval-weight.js";
import type { EvidenceSearchCandidate } from "./evidence-retrieval.js";
import { memoryMatchesTemporalRange } from "./memory-temporal.js";
import {
  resolveTemporalQuery,
  temporalRangeIntersects,
  type MatchedTemporalBasis,
  type ResolvedTemporalQuery,
  type ResolveTemporalQueryOptions,
  type TemporalSearchRange
} from "./temporal-query.js";
import {
  getTemporalFeatureFlags,
  type TemporalFeatureFlags
} from "./temporal-rollout.js";
import { temporalDropReasonErrorCode, uniqueTemporalErrorCodes } from "./temporal-observability.js";
import {
  buildKeywordCorpusStats,
  scoreKeywordMatch,
  type KeywordCorpusStats
} from "./keyword-scoring.js";
import { tokenizeSearchText } from "./search-tokenizer.js";
import { createCrossEncoderReranker, type CrossEncoderReranker } from "./cross-encoder-reranker.js";

const searchMaterializationConcurrency = 8;

const graphNeighborSeedLimit = 10;
const graphNeighborSupplementLimit = 20;
const graphNeighborRelationWeights: Partial<Record<RelationEdge["relationType"], number>> = {
  is_same_as: 1,
  alias_of: 1,
  updates: 0.9,
  derived_from: 0.7,
  part_of: 0.7,
  conflicts_with: 0.6
};
const graphNeighborConfidenceFactors = { high: 1, medium: 0.7, low: 0.4 } as const;

export interface ScoreBreakdown {
  keyword: number;
  vector: number;
  graph: number;
  recency: number;
  importance: number;
  retrievalWeight: number;
  userRetrievalWeight: number;
  sourceReliability: number;
  feedback: number;
  diversity: number;
  conflictPenalty: number;
  permissionRiskPenalty: number;
  stalenessPenalty: number;
  route: {
    keyword: number;
    vector: number;
    graph: number;
    time: number;
    feedback: number;
  };
  reranker?: number;
  rrf: number;
}

export interface ContextQuery {
  q: string;
  layer?: "all" | "evidence" | "fact" | "stm" | "ltm";
  referenceTime?: string;
  timezone?: string;
  locale?: string;
  timeRange?: TemporalSearchRange;
  tenantId?: string;
  principalId?: string;
  contextScopeId?: string;
  sourceIds?: string[];
  limit?: number;
  offset?: number;
  includeInactive?: boolean;
  /** Expand graph relation neighbors of top-ranked memories as supplemental results. */
  graphNeighborRecall?: boolean;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
}

export interface ContextSearchTemporalResult {
  evidenceTime?: string;
  validTime?: string;
  events?: NonNullable<MemoryTemporalMetadata["events"]>;
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  validTimeStart?: string;
  validTimeEnd?: string;
  matchedBasis?: MatchedTemporalBasis;
  evidenceTimeConfidence?: TemporalConfidence;
  validTimeConfidence?: TemporalConfidence;
}

export interface ContextSearchFactSnapshot {
  factId: string;
  factVersionId?: string;
  version: number;
  status: FactItem["status"];
  factText: string;
  normalizedClaim: string;
  updateReason?: string;
  sourceFactIds: string[];
  conflictRefs: string[];
  sourceRefs: SourceRef[];
}

export interface ContextSearchFactConflict {
  factId: string;
  conflictingFactIds: string[];
  sourceFactIds: string[];
  explanation: string;
  sourceRefs: SourceRef[];
}

export interface ContextSearchFactContext {
  currentFacts: ContextSearchFactSnapshot[];
  sourceFacts: ContextSearchFactSnapshot[];
  conflicts: ContextSearchFactConflict[];
}

export interface ContextSearchResult {
  id: string;
  layer: "evidence" | "fact" | "stm" | "ltm";
  content: string;
  evidenceType?: EvidenceSearchCandidate["evidenceType"];
  evidenceTime?: string;
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  evidenceTimeConfidence?: EvidenceSearchCandidate["evidenceTimeConfidence"];
  temporal: ContextSearchTemporalResult;
  factSummary?: string;
  summary?: string;
  memoryType?: string;
  status: string;
  score: number;
  reason: string;
  sourceRefs: SourceRef[];
  factIds: string[];
  factContext: ContextSearchFactContext;
  memoryIds: string[];
  permissionStatus: "allowed" | "filtered";
  scoreBreakdown: ScoreBreakdown;
  relationEdges: RelationEdge[];
}

export interface ContextSearchResponse {
  query: ContextQuery;
  temporal: ResolvedTemporalQuery;
  results: ContextSearchResult[];
  total: number;
  limit: number;
  offset: number;
  dropped: Array<{
    id: string;
    layer: ContextSearchResult["layer"];
    reason: string;
  }>;
  trace: TemporalTraceMetadata;
}

export interface SearchContextOptions extends ResolveTemporalQueryOptions {
  featureFlags?: Partial<TemporalFeatureFlags>;
  recordShadow?: boolean;
  recordRetrieval?: boolean;
  /** Fact documents are excluded by default; set true only for explicit Fact-retrieval experiments. */
  factRetrieval?: boolean;
  embeddingClient?: EmbeddingClient;
  reranker?: CrossEncoderReranker | false;
  /** Undefined uses the configured cross-encoder; false explicitly disables STM/LTM reranking. */
  memoryReranker?: CrossEncoderReranker | false;
}

export function redactContextSearchResponse(response: ContextSearchResponse): ContextSearchResponse {
  return {
    ...response,
    results: response.results.map((item) => redactContextSearchResult(item)),
    dropped: response.dropped.map((item) => ({
      ...item,
      reason: redactSensitiveText(item.reason)
    }))
  };
}

export async function searchContext(
  repository: ContextEngineRepository,
  query: ContextQuery,
  options: SearchContextOptions = {}
): Promise<ContextSearchResponse> {
  const featureFlags = getTemporalFeatureFlags(options.featureFlags);
  const resolvedTemporal = await resolveTemporalQuery({
    text: query.q,
    ...(query.referenceTime ? { referenceTime: query.referenceTime } : {}),
    ...(query.timezone ? { timezone: query.timezone } : {}),
    ...(query.locale ? { locale: query.locale } : {}),
    ...(query.timeRange ? { timeRange: query.timeRange } : {})
  }, options);
  const hardFilterEnabled = featureFlags.temporalRead && featureFlags.temporalHardFilter;
  const ambiguousRelativeTime = resolvedTemporal.source !== "explicit" &&
    isAmbiguousRelativeTemporalQuery(query.q);
  const retrievalTemporal = hardFilterEnabled && !ambiguousRelativeTime
    ? resolvedTemporal
    : withoutTemporalRange(resolvedTemporal);
  const normalizedQuery = normalizeText(query.q);
  const retrievalQuery = temporalContentQuery(normalizedQuery, resolvedTemporal);
  const queryTokens = tokenize(retrievalQuery);
  const layer = query.layer ?? "all";
  const limit = clampPageSize(query.limit);
  const offset = Math.max(0, query.offset ?? 0);
  const retrievalLimit = hardFilterEnabled && resolvedTemporal.range
    ? Math.min(500, Math.max(offset + limit, (offset + limit) * 4))
    : undefined;
  const dropped: ContextSearchResponse["dropped"] = [];
  const shouldSearchMemory = layer !== "evidence" && layer !== "fact";
  const shouldSearchFacts = options.factRetrieval === true && (layer === "all" || layer === "fact");
  const memoryReranker = shouldSearchMemory && options.memoryReranker !== false
    ? options.memoryReranker ?? createCrossEncoderReranker()
    : undefined;
  const shouldSearchEvidence = featureFlags.evidenceLayer && layer === "evidence";
  const sourceScope = shouldSearchMemory
    ? await buildMemoryScope(repository, query, layer)
    : emptySourceScope();
  const factContextLoader = new FactContextLoader(repository);

  const memoryCandidatesPromise = shouldSearchMemory
    ? retrieveMemoryCandidates(
        repository,
        retrievalQuery,
        queryTokens,
        query,
        sourceScope,
        retrievalTemporal,
        retrievalLimit,
        options.embeddingClient ?? createEmbeddingClient(),
        factContextLoader
      )
    : Promise.resolve({ base: [] as CandidateResult[], supplements: [] as CandidateResult[] });
  const evidenceCandidatesPromise = shouldSearchEvidence
    ? repository.findEvidenceCandidates({
        ...(query.tenantId ? { tenantId: query.tenantId } : {}),
        ...(query.principalId ? { principalId: query.principalId } : {}),
        ...(query.sourceIds ? { sourceIds: query.sourceIds } : {}),
        text: retrievalQuery,
        tokens: queryTokens,
        ...(hardFilterEnabled && resolvedTemporal.range && resolvedTemporal.basis !== "valid"
          ? {
              evidenceTimeStart: resolvedTemporal.range.startTime,
              evidenceTimeEnd: resolvedTemporal.range.endTime
            }
          : {}),
        limit: retrievalLimit ?? Math.min(500, offset + limit)
      })
    : Promise.resolve([] as EvidenceSearchCandidate[]);
  const factResultsPromise = shouldSearchFacts
    ? retrieveFactCandidates(
        repository,
        retrievalQuery,
        queryTokens,
        query,
        retrievalTemporal,
        options.embeddingClient ?? createEmbeddingClient(),
        options.reranker === false ? undefined : options.reranker ?? createCrossEncoderReranker()
      )
    : Promise.resolve([] as ContextSearchResult[]);
  const [materialized, evidenceCandidates, factResults] = await Promise.all([
    memoryCandidatesPromise,
    evidenceCandidatesPromise,
    factResultsPromise
  ]);
  const collectActiveMemoryResults = (items: CandidateResult[]) => items
    .filter((item): item is ContextSearchResult => {
      if ("dropReason" in item) {
        dropped.push({ id: item.id, layer: item.layer, reason: item.dropReason });
        return false;
      }
      return true;
    })
    .filter((item) => layer === "all" || item.layer === layer);
  const memoryResults = collectActiveMemoryResults(materialized.base);
  const supplementResults = collectActiveMemoryResults(materialized.supplements);
  const rankedMemoryResults = memoryReranker
    ? await rerankMemoryResults(retrievalQuery, memoryResults, memoryReranker, dropped)
    : memoryResults;
  const memoryResultsWithSupplements = supplementBaseRanking(rankedMemoryResults, supplementResults);
  const evidenceResults = evidenceCandidates.flatMap((candidate) => {
    if (candidate.permissionStatus === "filtered") {
      dropped.push({ id: candidate.id, layer: "evidence", reason: "permission_filtered" });
      return [];
    }
    const temporalMatch = matchTemporalMetadata({
      ...(candidate.evidenceTimeStart ? { evidenceTimeStart: candidate.evidenceTimeStart } : {}),
      ...(candidate.evidenceTimeEnd ? { evidenceTimeEnd: candidate.evidenceTimeEnd } : {}),
      evidenceTimeConfidence: candidate.evidenceTimeConfidence
    }, retrievalTemporal);
    if (hardFilterEnabled && temporalMatch.dropReason) {
      dropped.push({ id: candidate.id, layer: "evidence", reason: temporalMatch.dropReason });
      return [];
    }
    return [buildEvidenceResult(
      candidate,
      retrievalQuery,
      queryTokens,
      retrievalTemporal,
      temporalMatch.matchedBasis
    )];
  });
  const rerankedFactResults = factResults.filter((result) => result.scoreBreakdown.reranker !== undefined);
  const candidates = rerankedFactResults.length >= limit
    ? [...rerankedFactResults, ...evidenceResults].sort(compareSearchResults)
    : [...memoryResultsWithSupplements, ...factResults, ...evidenceResults].sort(compareSearchResults);
  const deduped = dedupeResults(candidates, dropped, query.contextScopeId !== undefined);

  const baseResponse: ContextSearchResponse = {
    query: { ...query, q: query.q, layer },
    temporal: resolvedTemporal,
    results: deduped.slice(offset, offset + limit),
    total: deduped.length,
    limit,
    offset,
    dropped,
    trace: buildSearchTrace(
      resolvedTemporal,
      featureFlags,
      deduped,
      dropped
    )
  };
  if (
    options.recordShadow !== false &&
    (!featureFlags.temporalRead || !featureFlags.evidenceLayer || !featureFlags.temporalHardFilter)
  ) {
    const shadowResponse = await searchContext(repository, query, {
      ...options,
      featureFlags: {
        ...featureFlags,
        temporalRead: true,
        evidenceLayer: true,
        temporalHardFilter: true
      },
      recordShadow: false,
      recordRetrieval: false
    });
    baseResponse.trace.shadow = compareShadowResults(baseResponse.results, shadowResponse.results);
  }
  if (options.recordRetrieval !== false) {
    await Promise.all(baseResponse.results.flatMap((result) => {
      if (result.layer !== "fact" && result.layer !== "stm" && result.layer !== "ltm") return [];
      const requestId = query.requestId?.trim();
      const uniquePart = requestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      return [repository.saveMemoryRetrievalEvent({
        retrievalEventId: `retrieval_search_${uniquePart}_${result.layer}_${result.id}`,
        ownerType: result.layer,
        ownerId: result.id,
        ...(query.tenantId ? { tenantId: query.tenantId } : {}),
        ...(query.principalId ? { principalId: query.principalId } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(requestId ? { requestId } : {}),
        eventType: "search_hit",
        query: query.q,
        createdAt: new Date().toISOString()
      })];
    }));
  }
  return baseResponse;
}

async function rerankMemoryResults(
  queryText: string,
  results: ContextSearchResult[],
  reranker: CrossEncoderReranker,
  dropped: ContextSearchResponse["dropped"]
) {
  const coarseResults = dedupeResults(results.slice().sort(compareSearchResults), dropped).slice(0, 100);
  if (coarseResults.length < 2) return coarseResults;
  try {
    const reranked = await reranker.rerank(queryText, coarseResults.map((result) => ({
      id: result.id,
      text: buildRerankerMemoryText(result)
    })));
    const scoreById = new Map(reranked.map((item) => [item.id, item.score]));
    return coarseResults.map((result) => {
      const score = scoreById.get(result.id);
      if (score === undefined || !Number.isFinite(score)) throw new Error(`reranker omitted ${result.id}`);
      return {
        ...result,
        score,
        reason: `${result.reason}:cross_encoder`,
        scoreBreakdown: { ...result.scoreBreakdown, reranker: score }
      };
    }).sort(compareSearchResults);
  } catch {
    return coarseResults.map((result) => ({ ...result, reason: `${result.reason}:reranker_fallback` }));
  }
}

function buildRerankerMemoryText(result: ContextSearchResult) {
  const temporal = [
    result.temporal.evidenceTimeStart,
    result.temporal.evidenceTimeEnd,
    result.temporal.validTimeStart,
    result.temporal.validTimeEnd
  ].filter(Boolean).join(" ");
  return [result.content, result.factSummary, result.summary, result.memoryType, temporal]
    .filter(Boolean)
    .join("\n");
}

type CandidateResult = ContextSearchResult | { id: string; layer: "stm" | "ltm"; dropReason: string };
type RankedOwner = { ownerType: "stm" | "ltm"; ownerId: string; rrfScore: number };
type GraphNeighborCandidate = { ownerType: "stm" | "ltm"; ownerId: string; neighborScore: number };
type SourceScopedOwner = { ownerType: "stm" | "ltm"; ownerId: string; score: number };
type SourceScope = {
  active: boolean;
  ownerKeys: Set<string>;
  owners: SourceScopedOwner[];
};

function withoutTemporalRange(resolved: ResolvedTemporalQuery): ResolvedTemporalQuery {
  const { range: _range, ...rest } = resolved;
  return rest;
}

function buildSearchTrace(
  resolved: ResolvedTemporalQuery,
  flags: TemporalFeatureFlags,
  results: ContextSearchResult[],
  dropped: ContextSearchResponse["dropped"]
): TemporalTraceMetadata {
  const temporalDrops = dropped.filter((item) =>
    item.reason === "outside_evidence_time_range" ||
    item.reason === "outside_valid_time_range" ||
    item.reason === "outside_temporal_range" ||
    item.reason === "temporal_metadata_missing"
  );
  const dropReasonCounts = Object.fromEntries([...new Set(dropped.map((item) => item.reason))].map((reason) => [
    reason,
    dropped.filter((item) => item.reason === reason).length
  ]));
  return {
    operation: "search",
    timezone: resolved.timezone,
    locale: resolved.locale,
    resolverSource: resolved.source,
    resolverConfidence: resolved.confidence,
    timeBasis: resolved.basis,
    sourceMessageRowIds: [...new Set(results.flatMap((item) => item.sourceRefs.flatMap((ref) =>
      ref.sourceType === "conversation_message" ? [ref.sourceId] : []
    )))],
    filterBeforeCount: results.length + temporalDrops.length,
    filterAfterCount: results.length,
    dropReasonCounts,
    featureFlags: {
      temporalRead: flags.temporalRead,
      evidenceLayer: flags.evidenceLayer,
      temporalHardFilter: flags.temporalHardFilter,
      agentMessageTimestamps: flags.agentMessageTimestamps
    },
    errorCodes: uniqueTemporalErrorCodes(temporalDrops.flatMap((item) => {
      const code = temporalDropReasonErrorCode(item.reason);
      return code ? [code] : [];
    }))
  };
}

function compareShadowResults(
  actual: ContextSearchResult[],
  shadow: ContextSearchResult[]
): NonNullable<TemporalTraceMetadata["shadow"]> {
  const actualIds = new Set(actual.map((item) => `${item.layer}:${item.id}`));
  const shadowIds = new Set(shadow.map((item) => `${item.layer}:${item.id}`));
  return {
    enabled: true,
    resultCount: shadow.length,
    addedResultIds: [...shadowIds].filter((id) => !actualIds.has(id)),
    removedResultIds: [...actualIds].filter((id) => !shadowIds.has(id))
  };
}

async function retrieveMemoryCandidates(
  repository: ContextEngineRepository,
  normalizedQuery: string,
  queryTokens: string[],
  query: ContextQuery,
  sourceScope: SourceScope,
  resolvedTemporal: ResolvedTemporalQuery,
  retrievalLimit: number | undefined,
  embeddingClient: EmbeddingClient,
  factContextLoader: FactContextLoader
): Promise<{ base: CandidateResult[]; supplements: CandidateResult[] }> {
  const queryVector = normalizedQuery ? await createQueryVector(normalizedQuery, embeddingClient) : [];
  const keywordCorpusStats = buildKeywordCorpusStats(
    await repository.listKeywordCorpusContents(),
    queryTokens
  );
  const [ftsRanked, vectorRanked, temporalRanked] = await Promise.all([
    rankByGraphText(repository, queryTokens, query, sourceScope, resolvedTemporal),
    rankByGraphVector(repository, queryVector, query, sourceScope, resolvedTemporal),
    rankByTemporalFallback(repository, query, sourceScope, resolvedTemporal, retrievalLimit)
  ]);
  const ranked = mergeByRrf(
    ftsRanked,
    vectorRanked,
    rankBySourceScope(sourceScope),
    temporalRanked
  ).filter((item) =>
    !sourceScope.active || sourceScope.ownerKeys.has(`${item.ownerType}:${item.ownerId}`)
  );
  const merged = retrievalLimit === undefined ? ranked : ranked.slice(0, retrievalLimit);
  const neighborCandidates = query.graphNeighborRecall
    ? await collectGraphNeighborCandidates(repository, merged, query, sourceScope)
    : [];
  const base = await mapWithConcurrency(merged, searchMaterializationConcurrency, (item) =>
    materializeCandidate(
      repository,
      item.ownerType,
      item.ownerId,
      normalizedQuery,
      queryTokens,
      query,
      item.rrfScore,
      resolvedTemporal,
      queryVector,
      factContextLoader,
      keywordCorpusStats
    )
  );
  const supplements = await mapWithConcurrency(neighborCandidates, searchMaterializationConcurrency, async (item) => {
    const candidate = await materializeCandidate(
      repository,
      item.ownerType,
      item.ownerId,
      normalizedQuery,
      queryTokens,
      query,
      0,
      resolvedTemporal,
      queryVector,
      factContextLoader,
      keywordCorpusStats
    );
    if ("dropReason" in candidate) return candidate;
    return decorateGraphNeighborResult(candidate, item.neighborScore);
  });
  return { base, supplements };
}

// ponytail: 1-hop expansion, both edge directions weighted equally; add
// direction-aware or multi-hop traversal only if recall measurably needs it.
async function collectGraphNeighborCandidates(
  repository: ContextEngineRepository,
  baseRanking: RankedOwner[],
  query: ContextQuery,
  sourceScope: SourceScope
): Promise<GraphNeighborCandidate[]> {
  const seeds = baseRanking.slice(0, graphNeighborSeedLimit);
  if (!seeds.length) return [];
  const baseOwnerKeys = new Set(baseRanking.map((item) => `${item.ownerType}:${item.ownerId}`));
  const layerFilter = layerOwnerTypes(query.layer);
  const edgeLists = await Promise.all(seeds.map((seed) => repository.getGraphRelationEdges(seed.ownerId)));
  const bestByOwnerKey = new Map<string, GraphNeighborCandidate>();
  seeds.forEach((seed, seedIndex) => {
    for (const edge of edgeLists[seedIndex] ?? []) {
      const relationWeight = graphNeighborRelationWeights[edge.relationType];
      if (relationWeight === undefined) continue;
      const neighborId = edge.fromId === seed.ownerId ? edge.toId : edge.fromId;
      const ownerType = memoryOwnerTypeForId(neighborId);
      if (!ownerType) continue;
      if (layerFilter && !layerFilter.includes(ownerType)) continue;
      const ownerKey = `${ownerType}:${neighborId}`;
      if (baseOwnerKeys.has(ownerKey)) continue;
      if (sourceScope.active && !sourceScope.ownerKeys.has(ownerKey)) continue;
      const neighborScore = relationWeight *
        (typeof edge.strength === "number" ? edge.strength : 0.5) *
        graphNeighborConfidenceFactors[edge.confidence ?? "medium"];
      const existing = bestByOwnerKey.get(ownerKey);
      if (!existing || existing.neighborScore < neighborScore) {
        bestByOwnerKey.set(ownerKey, { ownerType, ownerId: neighborId, neighborScore });
      }
    }
  });
  return [...bestByOwnerKey.values()]
    .sort((left, right) => right.neighborScore - left.neighborScore || left.ownerId.localeCompare(right.ownerId))
    .slice(0, graphNeighborSupplementLimit);
}

function decorateGraphNeighborResult(result: ContextSearchResult, neighborScore: number): ContextSearchResult {
  const scoreBreakdown = {
    ...result.scoreBreakdown,
    graph: Math.max(result.scoreBreakdown.graph, neighborScore)
  };
  return {
    ...result,
    score: finalScore(scoreBreakdown),
    reason: "graph_neighbor_recall",
    scoreBreakdown
  };
}

function supplementBaseRanking(
  base: ContextSearchResult[],
  supplements: ContextSearchResult[]
): ContextSearchResult[] {
  if (!supplements.length) return base;
  const baseKeys = new Set(base.map((item) => `${item.layer}:${item.id}`));
  return [...base, ...supplements.filter((item) => !baseKeys.has(`${item.layer}:${item.id}`))];
}

async function retrieveFactCandidates(
  repository: ContextEngineRepository,
  queryText: string,
  queryTokens: string[],
  query: ContextQuery,
  resolvedTemporal: ResolvedTemporalQuery,
  embeddingClient: EmbeddingClient,
  reranker: CrossEncoderReranker | undefined
) {
  const queryVector = queryText ? await createQueryVector(queryText, embeddingClient) : [];
  const searchOptions = {
    ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    ...(query.principalId ? { principalId: query.principalId } : {}),
    ...(query.includeInactive ? { includeInactive: true } : {}),
    limit: 100
  };
  const [textHits, vectorHits] = await Promise.all([
    repository.searchFactText(queryTokens, searchOptions),
    repository.searchFactVector(queryVector, searchOptions)
  ]);
  const merged = mergeFactHitsByRrf(textHits, vectorHits);
  const facts = await repository.getFactItemsByIds(merged.map((hit) => hit.factId));
  const factById = new Map(facts.map((fact) => [fact.factId, fact]));
  const keywordCorpusStats = buildKeywordCorpusStats(await repository.listKeywordCorpusContents(), queryTokens);
  const coarseResults = merged.flatMap((hit) => {
    const fact = factById.get(hit.factId);
    if (!fact) return [];
    const temporalMatch = matchTemporalMetadata(fact, resolvedTemporal);
    if (temporalMatch.dropReason) return [];
    const keyword = scoreKeywordMatch(buildFactResultContent(fact), queryTokens, keywordCorpusStats).score;
    const scoreBreakdown: ScoreBreakdown = {
      keyword,
      vector: hit.vectorScore,
      graph: 0,
      recency: recencyScore(
        temporalRecencyTimestamp(fact, temporalMatch.matchedBasis, resolvedTemporal.basis) ?? fact.observedAt,
        resolvedTemporal.referenceTime
      ),
      importance: confidenceScore(fact.confidenceLevel),
      retrievalWeight: 0.5,
      userRetrievalWeight: 0.5,
      sourceReliability: sourceReliabilityScore(fact.linkedSourceRefs),
      feedback: 0.5,
      diversity: diversityScore(fact.factText, queryText, queryTokens),
      conflictPenalty: fact.status === "conflicted" ? 0.5 : 0,
      permissionRiskPenalty: 0.05,
      stalenessPenalty: fact.status === "superseded" ? 0.5 : 0,
      route: routeSignals(queryTokens, queryText),
      rrf: hit.rrfScore
    };
    const snapshot = factSnapshot(fact);
    return [{
      id: fact.factId,
      layer: "fact" as const,
      content: fact.factText,
      temporal: temporalResult(fact, temporalMatch.matchedBasis),
      memoryType: fact.factType,
      status: fact.status,
      score: finalScore(scoreBreakdown),
      reason: hit.keywordScore > 0 ? "fact_bm25_vector_match" : "fact_vector_match",
      sourceRefs: fact.linkedSourceRefs,
      factIds: [fact.factId],
      factContext: { currentFacts: [snapshot], sourceFacts: [], conflicts: [] },
      memoryIds: [],
      permissionStatus: "allowed" as const,
      scoreBreakdown,
      relationEdges: []
    }];
  }).sort(compareSearchResults).slice(0, 100);
  if (!reranker || coarseResults.length < 2) return coarseResults;
  try {
    const reranked = await reranker.rerank(queryText, coarseResults.map((result) => ({
      id: result.id,
      text: buildRerankerFactText(result)
    })));
    const scoreById = new Map(reranked.map((item) => [item.id, item.score]));
    return coarseResults.map((result) => {
      const score = scoreById.get(result.id);
      if (score === undefined) throw new Error(`reranker omitted ${result.id}`);
      return {
        ...result,
        score,
        reason: `${result.reason}:cross_encoder`,
        scoreBreakdown: { ...result.scoreBreakdown, reranker: score }
      };
    }).sort(compareSearchResults);
  } catch {
    return coarseResults.map((result) => ({ ...result, reason: `${result.reason}:reranker_fallback` }));
  }
}

function buildRerankerFactText(result: ContextSearchResult) {
  const temporal = [result.temporal.evidenceTimeStart, result.temporal.validTimeStart].filter(Boolean).join(" ");
  return [result.content, result.memoryType, temporal].filter(Boolean).join("\n");
}

function buildFactResultContent(fact: FactItem) {
  return `${fact.factText}\n${fact.normalizedClaim}\n${fact.sourceClaim ?? ""}`;
}

function confidenceScore(value: FactItem["confidenceLevel"]) {
  return value === "high" ? 1 : value === "medium" ? 0.6 : 0.3;
}

function mergeFactHitsByRrf(
  textHits: Array<{ factId: string; score: number }>,
  vectorHits: Array<{ factId: string; score: number }>
) {
  const combined = new Map<string, { factId: string; rrfScore: number; keywordScore: number; vectorScore: number }>();
  for (const [kind, hits] of [["keyword", textHits], ["vector", vectorHits]] as const) {
    for (const [index, hit] of hits.entries()) {
      const current = combined.get(hit.factId) ?? { factId: hit.factId, rrfScore: 0, keywordScore: 0, vectorScore: 0 };
      current.rrfScore += 1 / (60 + index + 1);
      if (kind === "keyword") current.keywordScore = hit.score;
      else current.vectorScore = hit.score;
      combined.set(hit.factId, current);
    }
  }
  return [...combined.values()].sort((left, right) => right.rrfScore - left.rrfScore || left.factId.localeCompare(right.factId));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
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

function emptySourceScope(): SourceScope {
  return {
    active: false,
    ownerKeys: new Set<string>(),
    owners: []
  };
}

async function materializeCandidate(
  repository: ContextEngineRepository,
  ownerType: RankedOwner["ownerType"],
  ownerId: string,
  queryText: string,
  queryTokens: string[],
  query: ContextQuery,
  rrfScore: number,
  resolvedTemporal: ResolvedTemporalQuery,
  queryVector: number[],
  factContextLoader: FactContextLoader,
  keywordCorpusStats: KeywordCorpusStats
): Promise<CandidateResult> {
  if (ownerType === "stm") {
    const memory = await repository.getShortTermMemory(ownerId);
    if (!memory) return { id: ownerId, layer: "stm", dropReason: "missing_stm" };
    if (!query.includeInactive && !isShortTermRecallEligible(memory)) {
      return { id: ownerId, layer: "stm", dropReason: "inactive_stm" };
    }
    const sourcePermissionDrop = sourcePermissionDropReason(memory.sourceRefs, query);
    if (sourcePermissionDrop) return { id: ownerId, layer: "stm", dropReason: sourcePermissionDrop };
    const accessDrop = shortTermAccessStateDropReason(memory.accessState);
    if (accessDrop) return { id: ownerId, layer: "stm", dropReason: accessDrop };
    const temporalMatch = matchMemoryTemporal(memory, resolvedTemporal);
    if (temporalMatch.dropReason) {
      return { id: ownerId, layer: "stm", dropReason: temporalMatch.dropReason };
    }
    return buildShortTermResult(
      repository,
      memory,
      queryText,
      queryTokens,
      rrfScore,
      resolvedTemporal,
      temporalMatch.matchedBasis,
      queryVector,
      factContextLoader,
      keywordCorpusStats
    );
  }

  const memory = await repository.getLongTermMemory(ownerId);
  if (!memory) return { id: ownerId, layer: "ltm", dropReason: "missing_ltm" };
  if (!query.includeInactive && !isLongTermRecallEligible(memory)) {
    return { id: ownerId, layer: "ltm", dropReason: "inactive_ltm" };
  }
  const sourcePermissionDrop = sourcePermissionDropReason(memory.sourceRefs, query);
  if (sourcePermissionDrop) return { id: ownerId, layer: "ltm", dropReason: sourcePermissionDrop };
  const accessDrop = accessStateDropReason(memory.accessState);
  if (accessDrop) return { id: ownerId, layer: "ltm", dropReason: accessDrop };
  const temporalMatch = matchMemoryTemporal(memory, resolvedTemporal);
  if (temporalMatch.dropReason) {
    return { id: ownerId, layer: "ltm", dropReason: temporalMatch.dropReason };
  }
  return buildLongTermResult(
    repository,
    memory,
    queryText,
    queryTokens,
    rrfScore,
    resolvedTemporal,
    temporalMatch.matchedBasis,
    queryVector,
    factContextLoader,
    keywordCorpusStats
  );
}

async function buildShortTermResult(
  repository: ContextEngineRepository,
  memory: ShortTermMemory,
  queryText: string,
  queryTokens: string[],
  rrfScore: number,
  resolvedTemporal: ResolvedTemporalQuery,
  matchedBasis: MatchedTemporalBasis | undefined,
  queryVector: number[],
  factContextLoader: FactContextLoader,
  keywordCorpusStats: KeywordCorpusStats
): Promise<ContextSearchResult> {
  const graphNode = await repository.getGraphMemoryNode("stm", memory.memoryDataId);
  const indexEntry = await repository.getIndexEntryByOwnerId(memory.memoryDataId);
  const keywordContent = indexEntry?.content ?? memory.content;
  const keyword = scoreKeywordMatch(keywordContent, queryTokens, keywordCorpusStats).score;
  const vector = vectorScore(graphNode?.vector, queryVector);
  const weights = shortTermRetrievalWeights(memory);
  const scoreBreakdown = {
    keyword,
    vector,
    graph: graphScore(memory.entityIds.length + memory.sourceRefs.length),
    recency: recencyScore(
      temporalRecencyTimestamp(memory, matchedBasis, resolvedTemporal.basis),
      resolvedTemporal.referenceTime
    ),
    importance: weights.importance,
    retrievalWeight: weights.retrievalWeight,
    userRetrievalWeight: weights.userRetrievalWeight,
    sourceReliability: sourceReliabilityScore(memory.sourceRefs),
    feedback: 0.5,
    diversity: diversityScore(memory.content, queryText, queryTokens),
    conflictPenalty: memory.admissionSignals.conflict === "known" ? 1 : memory.admissionSignals.conflict === "possible" ? 0.5 : 0,
    permissionRiskPenalty: memory.admissionSignals.permission === "public" ? 0 : 0.05,
    stalenessPenalty: indexEntry ? stalenessPenaltyOf(indexEntry.refreshedAt) : 0.1,
    route: routeSignals(queryTokens, queryText),
    rrf: rrfScore
  };

  const factContext = await materializeFactContext(
    factContextLoader,
    memory.sourceFactIds,
    memory.tenantId,
    memory.principalId
  );
  return {
    id: memory.memoryDataId,
    layer: "stm",
    content: memory.content,
    ...(memory.factSummary ? { factSummary: memory.factSummary } : {}),
    ...(memory.summary ? { summary: memory.summary } : {}),
    ...(memory.memoryType ? { memoryType: memory.memoryType } : {}),
    temporal: temporalResult(memory, matchedBasis),
    status: memory.lifecycleStatus,
    score: finalScore(scoreBreakdown),
    reason: keyword > 0 ? "bm25_stm_match" : "stm_match",
    sourceRefs: mergeSourceRefs([
      ...memory.sourceRefs,
      ...factContext.currentFacts.flatMap((fact) => fact.sourceRefs),
      ...factContext.sourceFacts.flatMap((fact) => fact.sourceRefs)
    ]),
    factIds: memory.sourceFactIds,
    factContext,
    memoryIds: [memory.memoryDataId],
    permissionStatus: "allowed",
    scoreBreakdown,
    relationEdges: await repository.getGraphRelationEdges(memory.memoryDataId)
  };
}

async function buildLongTermResult(
  repository: ContextEngineRepository,
  memory: LongTermMemory,
  queryText: string,
  queryTokens: string[],
  rrfScore: number,
  resolvedTemporal: ResolvedTemporalQuery,
  matchedBasis: MatchedTemporalBasis | undefined,
  queryVector: number[],
  factContextLoader: FactContextLoader,
  keywordCorpusStats: KeywordCorpusStats
): Promise<ContextSearchResult> {
  const graphNode = await repository.getGraphMemoryNode("ltm", memory.memoryId);
  const indexEntry = await repository.getIndexEntryByOwnerId(memory.memoryId);
  const keywordContent = indexEntry?.content ?? memory.content;
  const weights = longTermRetrievalWeights(memory);
  const scoreBreakdown = {
    keyword: scoreKeywordMatch(keywordContent, queryTokens, keywordCorpusStats).score,
    vector: vectorScore(graphNode?.vector, queryVector),
    graph: graphScore(memory.entityIds.length + memory.sourceRefs.length),
    recency: recencyScore(
      temporalRecencyTimestamp(memory, matchedBasis, resolvedTemporal.basis),
      resolvedTemporal.referenceTime
    ),
    importance: weights.importance,
    retrievalWeight: weights.retrievalWeight,
    userRetrievalWeight: weights.userRetrievalWeight,
    sourceReliability: sourceReliabilityScore(memory.sourceRefs),
    feedback: 0.5,
    diversity: diversityScore(memory.content, queryText, queryTokens),
    conflictPenalty: memory.lifecycleStatus === "rejected" ? 1 : 0,
    permissionRiskPenalty: 0.05,
    stalenessPenalty: memory.lifecycleStatus === "weakened" ? 0.3 : 0.1,
    route: routeSignals(queryTokens, queryText),
    rrf: rrfScore
  };

  const factIds = uniqueStrings([
    ...(memory.sourceFactIds ?? []),
    ...(memory.structuredFacts?.facts.flatMap((fact) => fact.factId ? [fact.factId] : []) ?? [])
  ]);
  const factContext = await materializeFactContext(
    factContextLoader,
    factIds,
    memory.tenantId,
    memory.principalId
  );
  return {
    id: memory.memoryId,
    layer: "ltm",
    content: memory.content,
    ...(memory.factSummary ? { factSummary: memory.factSummary } : {}),
    ...(memory.summary ? { summary: memory.summary } : {}),
    memoryType: memory.memoryType,
    temporal: temporalResult(memory, matchedBasis),
    status: memory.lifecycleStatus,
    score: finalScore(scoreBreakdown),
    reason: "bm25_ltm_match",
    sourceRefs: mergeSourceRefs([
      ...memory.sourceRefs,
      ...factContext.currentFacts.flatMap((fact) => fact.sourceRefs),
      ...factContext.sourceFacts.flatMap((fact) => fact.sourceRefs)
    ]),
    factIds,
    factContext,
    memoryIds: [memory.memoryId],
    permissionStatus: "allowed",
    scoreBreakdown,
    relationEdges: await repository.getGraphRelationEdges(memory.memoryId)
  };
}

function buildEvidenceResult(
  candidate: EvidenceSearchCandidate,
  queryText: string,
  queryTokens: string[],
  resolvedTemporal: ResolvedTemporalQuery,
  matchedBasis: MatchedTemporalBasis | undefined
): ContextSearchResult {
  const scoreBreakdown: ScoreBreakdown = {
    keyword: candidate.score,
    vector: 0,
    graph: 0,
    recency: recencyScore(
      candidate.evidenceTimeEnd ?? candidate.evidenceTimeStart,
      resolvedTemporal.referenceTime
    ),
    importance: 0.5,
    retrievalWeight: 0.5,
    userRetrievalWeight: 0.5,
    sourceReliability: sourceReliabilityScore(candidate.sourceRefs),
    feedback: 0.5,
    diversity: diversityScore(candidate.content, queryText, queryTokens),
    conflictPenalty: 0,
    permissionRiskPenalty: 0,
    stalenessPenalty: 0,
    route: routeSignals(queryTokens, queryText),
    rrf: 0
  };
  return {
    id: candidate.id,
    layer: "evidence",
    content: candidate.content,
    evidenceType: candidate.evidenceType,
    ...(candidate.evidenceTimeStart ? { evidenceTimeStart: candidate.evidenceTimeStart } : {}),
    ...(candidate.evidenceTimeEnd ? { evidenceTimeEnd: candidate.evidenceTimeEnd } : {}),
    evidenceTimeConfidence: candidate.evidenceTimeConfidence,
    temporal: temporalResult(candidate, matchedBasis),
    status: "active",
    score: finalScore(scoreBreakdown),
    reason: candidate.evidenceType === "conversation_message"
      ? "conversation_message_evidence_match"
      : "parsed_segment_evidence_match",
    sourceRefs: candidate.sourceRefs,
    factIds: [],
    factContext: emptyFactContext(),
    memoryIds: [],
    permissionStatus: "allowed",
    scoreBreakdown,
    relationEdges: []
  };
}

async function rankByGraphText(
  repository: ContextEngineRepository,
  queryTokens: string[],
  query: ContextQuery,
  sourceScope: SourceScope,
  resolvedTemporal: ResolvedTemporalQuery
): Promise<Array<{ ownerType: "stm" | "ltm"; ownerId: string; score: number }>> {
  const hits = await repository.searchGraphText(
    queryTokens,
    graphSearchOptions(query, sourceScope, resolvedTemporal)
  );
  return hits
    .map(
      (entry): { ownerType: "stm" | "ltm"; ownerId: string; score: number } => ({
        ownerType: entry.ownerType,
        ownerId: entry.ownerId,
        score: entry.score
      })
    )
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

async function rankByGraphVector(
  repository: ContextEngineRepository,
  queryVector: number[],
  query: ContextQuery,
  sourceScope: SourceScope,
  resolvedTemporal: ResolvedTemporalQuery
) {
  return await repository.searchGraphVector(
    queryVector,
    graphSearchOptions(query, sourceScope, resolvedTemporal)
  );
}

async function rankByTemporalFallback(
  repository: ContextEngineRepository,
  query: ContextQuery,
  sourceScope: SourceScope,
  resolvedTemporal: ResolvedTemporalQuery,
  retrievalLimit: number | undefined
): Promise<Array<{ ownerType: "stm" | "ltm"; ownerId: string; score: number }>> {
  if (!resolvedTemporal.range || !retrievalLimit) return [];
  const ownerTypes = layerOwnerTypes(query.layer) ?? ["stm", "ltm"];
  const page = await repository.listGraphMemoryNodes({
    ownerTypes,
    offset: 0,
    limit: retrievalLimit
  });
  return page.nodes
    .filter((node) => !sourceScope.active || sourceScope.ownerKeys.has(`${node.ownerType}:${node.ownerId}`))
    .map((node) => ({
      ownerType: node.ownerType,
      ownerId: node.ownerId,
      score: 0
    }));
}

function graphSearchOptions(
  query: ContextQuery | undefined,
  sourceScope: SourceScope,
  resolvedTemporal: ResolvedTemporalQuery
) {
  const ownerTypes = layerOwnerTypes(query?.layer);
  const options: GraphMemorySearchOptions = {};
  if (ownerTypes) options.ownerTypes = ownerTypes;
  if (sourceScope.active) options.ownerKeys = [...sourceScope.ownerKeys];
  // Valid-time filtering is applied after materialization so memories without
  // validTime remain eligible instead of being silently excluded by the index.
  if (resolvedTemporal.range && resolvedTemporal.basis === "evidence") {
    options.temporalRange = {
      ...resolvedTemporal.range,
      basis: resolvedTemporal.basis
    };
  }
  return options;
}

function layerOwnerTypes(layer: ContextQuery["layer"] | undefined): GraphMemoryOwnerType[] | undefined {
  if (layer === "stm") return ["stm"];
  if (layer === "ltm") return ["ltm"];
  return undefined;
}

async function buildSourceScope(repository: ContextEngineRepository, sourceIds: string[] | undefined, layer: ContextQuery["layer"]): Promise<SourceScope> {
  const allowed = new Set((sourceIds ?? []).map((item) => item.trim()).filter(Boolean));
  const ownerKeys = new Set<string>();
  const owners: SourceScopedOwner[] = [];
  if (!allowed.size) return { active: false, ownerKeys, owners };
  const ownerTypes = layerOwnerTypes(layer) ?? ["stm", "ltm"];
  for (const owner of await repository.findMemoryOwnersBySourceIds([...allowed], ownerTypes)) {
    ownerKeys.add(`${owner.ownerType}:${owner.ownerId}`);
    owners.push(owner);
  }

  return { active: true, ownerKeys, owners };
}

async function buildMemoryScope(
  repository: ContextEngineRepository,
  query: ContextQuery,
  layer: ContextQuery["layer"]
): Promise<SourceScope> {
  const sourceScope = await buildSourceScope(repository, query.sourceIds, layer);
  const contextScopeId = query.contextScopeId?.trim();
  if (!contextScopeId) return sourceScope;
  const ownerTypes = layerOwnerTypes(layer) ?? ["stm", "ltm"];
  const contextOwners = await repository.findMemoryOwnersByContextScopeId(contextScopeId, ownerTypes);
  const contextScope = sourceScopeFromOwners(contextOwners);
  if (!sourceScope.active) return contextScope;

  const ownerKeys = new Set([...sourceScope.ownerKeys].filter((key) => contextScope.ownerKeys.has(key)));
  return {
    active: true,
    ownerKeys,
    owners: sourceScope.owners.filter((owner) => ownerKeys.has(`${owner.ownerType}:${owner.ownerId}`))
  };
}

function sourceScopeFromOwners(owners: SourceScopedOwner[]): SourceScope {
  return {
    active: true,
    ownerKeys: new Set(owners.map((owner) => `${owner.ownerType}:${owner.ownerId}`)),
    owners
  };
}

function rankBySourceScope(sourceScope: SourceScope) {
  return sourceScope.active ? sourceScope.owners : [];
}

function mergeByRrf(...rankedLists: Array<Array<{ ownerType: "stm" | "ltm"; ownerId: string; score: number }>>) {
  const k = 60;
  const combined = new Map<string, RankedOwner>();
  for (const ranked of rankedLists) {
    for (const [index, item] of ranked.entries()) {
      const key = `${item.ownerType}:${item.ownerId}`;
      combined.set(key, {
        ownerType: item.ownerType,
        ownerId: item.ownerId,
        rrfScore: (combined.get(key)?.rrfScore ?? 0) + 1 / (k + index + 1)
      });
    }
  }
  return [...combined.values()].sort((left, right) => right.rrfScore - left.rrfScore);
}

function vectorScore(vector: number[] | undefined, queryVector: number[]) {
  if (!vector || !queryVector.length) return 0;
  return cosine(queryVector, vector);
}

function routeSignals(queryTokens: string[], queryText: string) {
  return {
    keyword: queryTokens.length ? Math.min(1, queryTokens.length / 4) : 0.2,
    vector: queryText ? 1 : 0,
    graph: queryTokens.some((token) => token.length > 1) ? 0.5 : 0.2,
    time: queryTokens.some((token) => /\d{4}|today|recent|最近|今天/.test(token)) ? 0.8 : 0.3,
    feedback: queryTokens.some((token) => /confirm|feedback|确认|反馈/.test(token)) ? 0.9 : 0.4
  };
}

function finalScore(score: ScoreBreakdown) {
  return Number(
    (
      0.18 * score.keyword +
      0.35 * score.vector +
      0.08 * score.graph +
      0.06 * score.recency +
      0.015 * score.retrievalWeight +
      0.055 * score.userRetrievalWeight +
      0.05 * score.sourceReliability +
      0.04 * score.feedback +
      0.04 * score.diversity +
      0.08 * score.rrf -
      0.20 * score.conflictPenalty -
      0.15 * score.permissionRiskPenalty -
      0.08 * score.stalenessPenalty
    ).toFixed(6)
  );
}

function redactContextSearchResult(result: ContextSearchResult): ContextSearchResult {
  return {
    ...result,
    content: redactSensitiveText(result.content),
    reason: redactSensitiveText(result.reason),
    sourceRefs: result.sourceRefs.map((ref) => ({
      ...ref,
      sourceId: redactSensitiveText(ref.sourceId)
    }))
  };
}

function redactSensitiveText(value: string) {
  return value;
}

function recallWeightScore(weight: LongTermMemory["recallWeight"]) {
  return longTermRetrievalWeight(weight);
}

async function createQueryVector(text: string, embeddingClient: EmbeddingClient) {
  const [result] = await embeddingClient.embed([text]);
  if (!result) throw new Error("Embedding returned no query vector");
  return result.embedding;
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

function sourcePermissionDropReason(sourceRefs: SourceRef[], query: ContextQuery) {
  const safeSourceRefs = Array.isArray(sourceRefs) ? sourceRefs : [];
  if (safeSourceRefs.length > 0 || (!query.tenantId && !query.principalId)) return undefined;
  return "missing_source_refs";
}

function accessStateDropReason(value: ShortTermMemory["accessState"] | LongTermMemory["accessState"] | null) {
  if (value === undefined || value === null || value === "visible") return undefined;
  if (value === "hidden") return "access_hidden";
  if (value === "permission-invalid") return "permission_invalid";
  return "access_filtered";
}

function shortTermAccessStateDropReason(value: ShortTermMemory["accessState"] | null) {
  return value === "permission-invalid" ? "permission_invalid" : undefined;
}

function clampPageSize(limit: number | undefined) {
  if (!limit || Number.isNaN(limit)) return 20;
  return Math.min(Math.max(1, limit), 100);
}

function normalizeText(content: string) {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(text: string) {
  return tokenizeSearchText(text);
}

function graphScore(entityCount: number) {
  if (entityCount <= 0) return 0;
  return Math.min(1, entityCount / 5);
}

function recencyScore(timestamp: string | undefined, referenceTime: string) {
  if (!timestamp) return 0.2;
  const ageMs = Math.abs(Date.parse(referenceTime) - Date.parse(timestamp));
  if (Number.isNaN(ageMs)) return 0.2;
  if (ageMs < 60 * 60 * 1000) return 1;
  if (ageMs < 24 * 60 * 60 * 1000) return 0.8;
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return 0.6;
  return 0.3;
}

function importanceScore(level: ShortTermMemory["importanceLevel"]) {
  return shortTermRetrievalWeight(level);
}

function stalenessPenaltyOf(timestamp: string) {
  const ageMs = Date.now() - Date.parse(timestamp);
  if (Number.isNaN(ageMs)) return 0.2;
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return 0;
  if (ageMs < 30 * 24 * 60 * 60 * 1000) return 0.2;
  return 0.5;
}

function sourceReliabilityScore(sourceRefs: SourceRef[]) {
  if (sourceRefs.some((source) => source.sourceType === "agent_memory")) return 0.8;
  if (sourceRefs.some((source) => source.sourceType === "file")) return 0.7;
  return sourceRefs.length > 0 ? 0.6 : 0.2;
}

function diversityScore(content: string, query: string, queryTokens: string[]) {
  if (!query) return 0.5;
  const contentTerms = new Set(tokenize(content));
  const queryTerms = queryTokens.length ? queryTokens : tokenize(query);
  if (!queryTerms.length) return 0.5;
  const uniqueOverlap = queryTerms.filter((term) => contentTerms.has(term)).length;
  return Math.min(1, 0.3 + (uniqueOverlap / queryTerms.length) * 0.7);
}

function dedupeResults(
  results: ContextSearchResult[],
  dropped: ContextSearchResponse["dropped"],
  preserveDistinctSources = false
) {
  const seen = new Map<string, ContextSearchResult>();
  const deduped: ContextSearchResult[] = [];
  for (const result of results) {
    const hasFactConflict = result.factContext.conflicts.length > 0;
    const key = result.layer === "evidence" || result.layer === "fact" || hasFactConflict
      ? `${result.layer}:${result.id}`
      : [
          normalizeText(result.content),
          ...(preserveDistinctSources
            ? [uniqueStrings(result.sourceRefs.map((source) => source.sourceId)).sort().join("|")]
            : [])
        ].join("::sources::");
    const existing = seen.get(key);
    if (existing) {
      dropped.push({ id: result.id, layer: result.layer, reason: `duplicate_of:${existing.id}` });
      continue;
    }
    seen.set(key, result);
    deduped.push(result);
  }
  return deduped;
}

async function materializeFactContext(
  loader: FactContextLoader,
  factIds: readonly string[],
  tenantId?: string,
  principalId?: string
): Promise<ContextSearchFactContext> {
  const currentFacts = (await loader.loadFacts(factIds))
    .filter((fact) =>
      (!tenantId || fact.tenantId === tenantId) &&
      (!principalId || fact.principalId === principalId)
    );
  if (!currentFacts.length) return emptyFactContext();

  const versions = tenantId && principalId
    ? await loader.loadVersions(currentFacts.map((fact) => fact.factId), tenantId, principalId)
    : [];
  const currentSnapshots = currentFacts.map((fact) => factSnapshot(
    fact,
    currentFactVersion(fact, versions)
  ));
  const sourceFactIds = uniqueStrings(currentSnapshots.flatMap((fact) => [
    ...fact.sourceFactIds,
    ...fact.conflictRefs
  ]));
  const sourceFacts = (await loader.loadFacts(sourceFactIds))
    .filter((fact) =>
      (!tenantId || fact.tenantId === tenantId) &&
      (!principalId || fact.principalId === principalId)
    );
  const additionalSourceVersions = tenantId && principalId
    ? await loader.loadVersions(
        sourceFacts
          .filter((fact) => !currentFacts.some((current) => current.factId === fact.factId))
          .map((fact) => fact.factId),
        tenantId,
        principalId
      )
    : [];
  const allVersions = [...versions, ...additionalSourceVersions];
  const sourceSnapshots = sourceFacts.map((fact) => factSnapshot(
    fact,
    provenanceFactVersion(fact, allVersions),
    true
  ));
  const sourceById = new Map(sourceSnapshots.map((fact) => [fact.factId, fact]));
  const conflicts = currentSnapshots.flatMap((fact): ContextSearchFactConflict[] => {
    if (!fact.conflictRefs.length && fact.status !== "conflicted") return [];
    const conflicting = fact.conflictRefs.flatMap((factId) => {
      const source = sourceById.get(factId);
      return source ? [source] : [];
    });
    return [{
      factId: fact.factId,
      conflictingFactIds: uniqueStrings(fact.conflictRefs),
      sourceFactIds: uniqueStrings([fact.factId, ...fact.sourceFactIds, ...fact.conflictRefs]),
      explanation: fact.updateReason ?? "conflicting_current_facts",
      sourceRefs: mergeSourceRefs([
        ...fact.sourceRefs,
        ...conflicting.flatMap((item) => item.sourceRefs)
      ])
    }];
  });

  return {
    currentFacts: currentSnapshots,
    sourceFacts: sourceSnapshots,
    conflicts
  };
}

class FactContextLoader {
  private readonly factsById = new Map<string, Promise<FactItem | undefined>>();
  private readonly versionsByOwnerAndFactId = new Map<string, Promise<FactVersion[]>>();

  constructor(private readonly repository: ContextEngineRepository) {}

  async loadFacts(factIds: readonly string[]): Promise<FactItem[]> {
    const requestedIds = uniqueStrings([...factIds]);
    const missingIds = requestedIds.filter((factId) => !this.factsById.has(factId));
    if (missingIds.length) {
      const fetchedById = Promise.resolve(this.repository.getFactItemsByIds(missingIds))
        .then((facts) => new Map(facts.map((fact) => [fact.factId, fact])));
      for (const factId of missingIds) {
        this.factsById.set(factId, fetchedById.then((facts) => facts.get(factId)));
      }
    }
    return (await Promise.all(requestedIds.map((factId) => this.factsById.get(factId)!)))
      .filter((fact): fact is FactItem => Boolean(fact));
  }

  async loadVersions(
    factIds: readonly string[],
    tenantId: string,
    principalId: string
  ): Promise<FactVersion[]> {
    const requestedIds = uniqueStrings([...factIds]);
    const cacheKey = (factId: string) => `${tenantId}\u0000${principalId}\u0000${factId}`;
    const missingIds = requestedIds.filter((factId) =>
      !this.versionsByOwnerAndFactId.has(cacheKey(factId))
    );
    if (missingIds.length) {
      const fetchedById = Promise.resolve(this.repository.getFactVersionsByFactIds({
        tenantId,
        principalId,
        factIds: missingIds
      })).then((versions) => {
        const grouped = new Map<string, FactVersion[]>();
        for (const version of versions) {
          const existing = grouped.get(version.factId) ?? [];
          existing.push(version);
          grouped.set(version.factId, existing);
        }
        return grouped;
      });
      for (const factId of missingIds) {
        this.versionsByOwnerAndFactId.set(
          cacheKey(factId),
          fetchedById.then((versions) => versions.get(factId) ?? [])
        );
      }
    }
    return (await Promise.all(requestedIds.map((factId) =>
      this.versionsByOwnerAndFactId.get(cacheKey(factId))!
    ))).flat().sort((left, right) =>
      left.factId.localeCompare(right.factId) ||
      left.version - right.version ||
      left.factVersionId.localeCompare(right.factVersionId)
    );
  }
}

function factSnapshot(
  fact: FactItem,
  version?: FactVersion,
  useVersionContent = false
): ContextSearchFactSnapshot {
  return {
    factId: fact.factId,
    ...(version ? { factVersionId: version.factVersionId } : {}),
    version: useVersionContent && version ? version.version : fact.version,
    status: fact.status,
    factText: useVersionContent && version ? version.factText : fact.factText,
    normalizedClaim: useVersionContent && version ? version.normalizedClaim : fact.normalizedClaim,
    ...(version ? { updateReason: version.updateReason } : {}),
    sourceFactIds: uniqueStrings(version?.sourceFactIds ?? [fact.factId]),
    conflictRefs: uniqueStrings(version?.conflictRefs ?? []),
    sourceRefs: mergeSourceRefs([
      ...fact.linkedSourceRefs,
      ...(version?.linkedSourceRefs ?? [])
    ])
  };
}

function currentFactVersion(fact: FactItem, versions: readonly FactVersion[]) {
  const matching = versions
    .filter((version) => version.factId === fact.factId)
    .sort((left, right) => left.version - right.version || left.factVersionId.localeCompare(right.factVersionId));
  return matching.find((version) => version.version === fact.version) ?? matching.at(-1);
}

function provenanceFactVersion(fact: FactItem, versions: readonly FactVersion[]) {
  const matching = versions
    .filter((version) => version.factId === fact.factId)
    .sort((left, right) => left.version - right.version || left.factVersionId.localeCompare(right.factVersionId));
  return matching.find((version) =>
    version.updateReason === "created" &&
    version.sourceFactIds.length === 1 &&
    version.sourceFactIds[0] === fact.factId
  ) ?? matching[0];
}

function emptyFactContext(): ContextSearchFactContext {
  return { currentFacts: [], sourceFacts: [], conflicts: [] };
}

function mergeSourceRefs(refs: readonly SourceRef[]) {
  const byId = new Map<string, SourceRef>();
  for (const ref of refs) {
    if (!byId.has(ref.sourceRefId)) byId.set(ref.sourceRefId, ref);
  }
  return [...byId.values()].sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId));
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function compareSearchResults(left: ContextSearchResult, right: ContextSearchResult) {
  return right.score - left.score || left.layer.localeCompare(right.layer) || left.id.localeCompare(right.id);
}

function matchMemoryTemporal(
  memory: ShortTermMemory | LongTermMemory,
  resolved: ResolvedTemporalQuery
) {
  if (!resolved.range) return matchTemporalMetadata(memory, resolved);
  if (resolved.basis === "evidence" || resolved.basis === "valid") {
    const start = temporalAxisStart(memory, resolved.basis);
    if (!start) return resolved.basis === "valid" ? {} : { dropReason: "temporal_metadata_missing" };
    const matched = memoryMatchesTemporalRange(memory, {
      ...resolved.range,
      basis: resolved.basis
    });
    return matched
      ? { matchedBasis: resolved.basis }
      : { dropReason: `outside_${resolved.basis}_time_range` };
  }

  const validPresent = Boolean(memory.validTime || memory.validTimeStart);
  if (validPresent && memoryMatchesTemporalRange(memory, { ...resolved.range, basis: "valid" })) {
    return { matchedBasis: "valid" as const };
  }
  if (validPresent) return { dropReason: "outside_valid_time_range" };
  return {};
}

function matchTemporalMetadata(
  metadata: MemoryTemporalMetadata,
  resolved: ResolvedTemporalQuery
): { matchedBasis?: MatchedTemporalBasis; dropReason?: string } {
  if (!resolved.range) {
    const matchedBasis = preferredTemporalBasis(metadata, resolved.basis);
    return matchedBasis ? { matchedBasis } : {};
  }
  if (resolved.basis === "evidence" || resolved.basis === "valid") {
    const start = temporalAxisStart(metadata, resolved.basis);
    if (!start) return resolved.basis === "valid" ? {} : { dropReason: "temporal_metadata_missing" };
    return temporalAxisIntersects(metadata, resolved.range, resolved.basis)
      ? { matchedBasis: resolved.basis }
      : { dropReason: `outside_${resolved.basis}_time_range` };
  }

  const validPresent = Boolean(metadata.validTime || metadata.validTimeStart);
  if (validPresent && temporalAxisIntersects(metadata, resolved.range, "valid")) {
    return { matchedBasis: "valid" };
  }
  if (validPresent) return { dropReason: "outside_valid_time_range" };
  return {};
}

function isAmbiguousRelativeTemporalQuery(text: string) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  return /(?:\b(?:recently|lately|recent)\b|(?:最近|近期|近来|前段时间|不久前)|\b(?:last|past)\s+(?:month|year)\b|\b(?:about|around|approximately)\s+(?:an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|few|several|couple(?:\s+of)?)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b)/iu.test(normalized);
}

function temporalAxisIntersects(
  metadata: MemoryTemporalMetadata,
  range: NonNullable<ResolvedTemporalQuery["range"]>,
  basis: MatchedTemporalBasis
) {
  const startTime = temporalAxisStart(metadata, basis);
  const endTime = temporalAxisEnd(metadata, basis);
  return temporalRangeIntersects({
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {})
  }, range);
}

function preferredTemporalBasis(
  metadata: MemoryTemporalMetadata,
  basis: ResolvedTemporalQuery["basis"]
): MatchedTemporalBasis | undefined {
  if (basis === "evidence") return metadata.evidenceTime || metadata.evidenceTimeStart ? "evidence" : undefined;
  if (basis === "valid") return metadata.validTime || metadata.validTimeStart ? "valid" : undefined;
  if (metadata.validTime) return "valid";
  if (metadata.evidenceTime) return "evidence";
  if (metadata.evidenceTimeStart) return "evidence";
  if (metadata.validTimeStart) return "valid";
  return undefined;
}

function temporalResult(
  metadata: MemoryTemporalMetadata,
  matchedBasis: MatchedTemporalBasis | undefined
): ContextSearchTemporalResult {
  if (metadata.evidenceTime || metadata.validTime) {
    return {
      ...(metadata.evidenceTime ? { evidenceTime: metadata.evidenceTime } : {}),
      ...(metadata.validTime ? { validTime: metadata.validTime } : {}),
      ...(metadata.events?.length ? { events: metadata.events } : {})
    };
  }
  return {
    ...(metadata.evidenceTime ? { evidenceTime: metadata.evidenceTime } : {}),
    ...(metadata.validTime ? { validTime: metadata.validTime } : {}),
    ...(metadata.events?.length ? { events: metadata.events } : {}),
    ...(metadata.evidenceTimeStart ? { evidenceTimeStart: metadata.evidenceTimeStart } : {}),
    ...(metadata.evidenceTimeEnd ? { evidenceTimeEnd: metadata.evidenceTimeEnd } : {}),
    ...(metadata.validTimeStart ? { validTimeStart: metadata.validTimeStart } : {}),
    ...(metadata.validTimeEnd ? { validTimeEnd: metadata.validTimeEnd } : {}),
    ...(matchedBasis ? { matchedBasis } : {}),
    ...(metadata.evidenceTimeConfidence
      ? { evidenceTimeConfidence: metadata.evidenceTimeConfidence }
      : {}),
    ...(metadata.validTimeConfidence ? { validTimeConfidence: metadata.validTimeConfidence } : {})
  };
}

function temporalRecencyTimestamp(
  metadata: MemoryTemporalMetadata,
  matchedBasis: MatchedTemporalBasis | undefined,
  queryBasis: ResolvedTemporalQuery["basis"]
) {
  const basis = matchedBasis ?? preferredTemporalBasis(metadata, queryBasis);
  if (!basis) return undefined;
  return temporalAxisEnd(metadata, basis) ?? temporalAxisStart(metadata, basis);
}

function temporalAxisStart(metadata: MemoryTemporalMetadata, basis: MatchedTemporalBasis) {
  return basis === "evidence"
    ? metadata.evidenceTime ?? metadata.evidenceTimeStart
    : metadata.validTime ?? metadata.validTimeStart;
}

function temporalAxisEnd(metadata: MemoryTemporalMetadata, basis: MatchedTemporalBasis) {
  return basis === "evidence"
    ? metadata.evidenceTime ?? metadata.evidenceTimeEnd
    : metadata.validTime ?? metadata.validTimeEnd;
}

function temporalContentQuery(text: string, resolved: ResolvedTemporalQuery) {
  if (!resolved.range) return text;
  const stripped = text
    .replace(/(?<!\d)\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)/gu, " ")
    .replace(/(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/gu, " ")
    .replace(/(?:前天|昨天|昨日|今天|今日|上周|本周|这周|最近\s*[一二两三四五六七八九十\d]+\s*天|近\s*[一二两三四五六七八九十\d]+\s*天|过去\s*[一二两三四五六七八九十\d]+\s*天|day before yesterday|yesterday|today|last week|this week|last\s+\d+\s+days?)/giu, " ")
    .replace(/(?:之前那次|之前|月底前|月底|春节后|春节前|before that|by the end of the month|after spring festival|before spring festival)/giu, " ")
    .replace(/(?:聊过什么|聊了什么|说过什么|说了什么|提到什么|发生了什么|发生的事情|有哪些消息|什么消息|什么时候|哪天|何时)/gu, " ")
    .replace(/(?:聊过|聊了|说过|说了|提到|提过|消息|对话|发生|生效|计划|安排)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return stripped;
}
