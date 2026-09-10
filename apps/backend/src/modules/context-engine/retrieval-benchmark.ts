import { readFile } from "node:fs/promises";
import type {
  ContextSearchResponse,
  ContextSearchResult,
  ContextQuery,
  ScoreBreakdown
} from "./search-context.js";
import { searchContext } from "./search-context.js";
import type { ContextEngineRepository, ContextDebugSnapshot } from "./persistence/repository.js";
import type { EmbeddingClient } from "./embedding.js";
import {
  longMemEvalSessionSourceId,
  type LongMemEvalSample
} from "./longmemeval.js";

export type RetrievalBenchmarkTarget = "fact" | "session";

export interface RetrievalBenchmarkCase {
  caseId: string;
  query: string;
  goldFactIds: string[];
  goldSessionIds: string[];
  sourceIds: string[];
  sessionSourceIds: Record<string, string>;
  tenantId?: string;
  principalId?: string;
  referenceTime?: string;
  includeInactive?: boolean;
}

export interface RetrievalBenchmarkCandidate {
  rank: number;
  id: string;
  layer: ContextSearchResult["layer"];
  score: number;
  scoreBreakdown: ScoreBreakdown;
  factIds: string[];
  sessionIds: string[];
  reason: string;
  status: string;
}

export interface RetrievalMetric {
  target: RetrievalBenchmarkTarget;
  k: number;
  evaluatedCases: number;
  goldTargetCount: number;
  candidateCount: number;
  relevantCandidateCount: number;
  matchedTargetCount: number;
  recallAtK: number;
  recallAnyAtK: number;
  recallAllAtK: number;
  precisionAtK: number;
  mrrAtK: number;
  ndcgAtK: number;
}

export type RetrievalTargetStatus =
  | "retrieved"
  | "not_in_top_k"
  | "filtered_before_top_k"
  | "memory_not_indexed"
  | "source_not_ingested"
  | "fact_not_generated"
  | "fact_not_admitted"
  | "memory_not_generated";

export interface RetrievalTargetDiagnostic {
  target: RetrievalBenchmarkTarget;
  targetId: string;
  exists: boolean;
  ownerIds: string[];
  indexedOwnerIds: string[];
  candidateRanks: number[];
  droppedReasons: string[];
  status: RetrievalTargetStatus;
}

export interface RetrievalBenchmarkCaseReport {
  caseId: string;
  query: string;
  gold: {
    factIds: string[];
    sessionIds: string[];
  };
  response: Pick<ContextSearchResponse, "total" | "dropped" | "trace" | "temporal">;
  candidates: RetrievalBenchmarkCandidate[];
  metrics: {
    fact: RetrievalMetric[];
    session: RetrievalMetric[];
  };
  diagnostics: RetrievalTargetDiagnostic[];
}

export interface RetrievalBenchmarkReport {
  schemaVersion: "retrieval-benchmark.v1";
  generatedAt: string;
  limit: number;
  ks: number[];
  totalCases: number;
  metrics: Record<RetrievalBenchmarkTarget, RetrievalMetric[]>;
  diagnosticCounts: Record<RetrievalTargetStatus, number>;
  cases: RetrievalBenchmarkCaseReport[];
}

export interface RetrievalBenchmarkOptions {
  limit?: number;
  ks?: number[];
  embeddingClient?: EmbeddingClient;
}

export async function readRetrievalBenchmarkCases(
  path: string,
  format: "longmemeval" | "cases" = "longmemeval"
): Promise<RetrievalBenchmarkCase[]> {
  const text = await readFile(path, "utf8");
  const parsed = parseJsonOrJsonl(text, path);
  if (format === "longmemeval") {
    const samples = Array.isArray(parsed)
      ? parsed as LongMemEvalSample[]
      : isRecord(parsed) && Array.isArray(parsed.samples)
        ? parsed.samples as LongMemEvalSample[]
        : [];
    if (!samples.length && Array.isArray(parsed) === false) {
      throw new Error("LongMemEval input must be a JSON array of samples");
    }
    return samples.map(longMemEvalSampleToCase);
  }

  const rawCases = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.cases)
      ? parsed.cases
      : isRecord(parsed)
        ? [parsed]
        : [];
  if (!rawCases.length) {
    throw new Error("retrieval benchmark case input must be an array or {cases: []}");
  }
  return rawCases.map((value, index) => parseCase(value, index));
}

export async function evaluateRetrievalBenchmark(
  repository: ContextEngineRepository,
  cases: readonly RetrievalBenchmarkCase[],
  options: RetrievalBenchmarkOptions = {}
): Promise<RetrievalBenchmarkReport> {
  const limit = clampLimit(options.limit);
  const ks = normalizeKs(options.ks ?? [1, 5, 10, 20, 50, 100]).map((k) => Math.min(k, limit));
  const snapshot = repository.getDebugSnapshot();
  const reports: RetrievalBenchmarkCaseReport[] = [];

  for (const benchmarkCase of cases) {
    const query: ContextQuery = {
      q: benchmarkCase.query,
      layer: "all",
      limit,
      offset: 0,
      ...(benchmarkCase.tenantId ? { tenantId: benchmarkCase.tenantId } : {}),
      ...(benchmarkCase.principalId ? { principalId: benchmarkCase.principalId } : {}),
      ...(benchmarkCase.sourceIds.length ? { sourceIds: benchmarkCase.sourceIds } : {}),
      ...(benchmarkCase.referenceTime ? { referenceTime: benchmarkCase.referenceTime } : {}),
      ...(benchmarkCase.includeInactive !== undefined ? { includeInactive: benchmarkCase.includeInactive } : {})
    };
    const response = await searchContext(repository, query, {
      ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
      recordRetrieval: false,
      recordShadow: false
    });
    const candidates = response.results.map((result, index) => candidateFromResult(result, index + 1, benchmarkCase));
    const metrics = {
      fact: scoreTargetMetrics(candidates, benchmarkCase.goldFactIds, "fact", ks),
      session: scoreTargetMetrics(candidates, benchmarkCase.goldSessionIds, "session", ks)
    };
    const diagnostics = [
      ...benchmarkCase.goldFactIds.map((targetId) => diagnoseTarget(snapshot, response, candidates, benchmarkCase, "fact", targetId)),
      ...benchmarkCase.goldSessionIds.map((targetId) => diagnoseTarget(snapshot, response, candidates, benchmarkCase, "session", targetId))
    ];
    reports.push({
      caseId: benchmarkCase.caseId,
      query: benchmarkCase.query,
      gold: {
        factIds: benchmarkCase.goldFactIds,
        sessionIds: benchmarkCase.goldSessionIds
      },
      response: {
        total: response.total,
        dropped: response.dropped,
        trace: response.trace,
        temporal: response.temporal
      },
      candidates,
      metrics,
      diagnostics
    });
  }

  const diagnosticCounts = emptyDiagnosticCounts();
  for (const report of reports) {
    for (const diagnostic of report.diagnostics) diagnosticCounts[diagnostic.status] += 1;
  }
  return {
    schemaVersion: "retrieval-benchmark.v1",
    generatedAt: new Date().toISOString(),
    limit,
    ks,
    totalCases: reports.length,
    metrics: {
      fact: aggregateMetrics(reports, "fact", ks),
      session: aggregateMetrics(reports, "session", ks)
    },
    diagnosticCounts,
    cases: reports
  };
}

export function candidateFromResult(
  result: ContextSearchResult,
  rank: number,
  benchmarkCase: RetrievalBenchmarkCase
): RetrievalBenchmarkCandidate {
  const factIds = uniqueStrings([
    ...result.factIds,
    ...result.factContext.currentFacts.map((fact) => fact.factId),
    ...result.factContext.sourceFacts.map((fact) => fact.factId)
  ]);
  const sourceMap = new Map(Object.entries(benchmarkCase.sessionSourceIds).map(([sessionId, sourceId]) => [sourceId, sessionId]));
  const sessionIds = uniqueStrings(result.sourceRefs.flatMap((source) => {
    const metadataSessionId = source.metadata?.sessionId;
    if (typeof metadataSessionId === "string" && metadataSessionId.trim()) return [metadataSessionId];
    const mapped = sourceMap.get(source.sourceId);
    return mapped ? [mapped] : [source.sourceId];
  }));
  return {
    rank,
    id: result.id,
    layer: result.layer,
    score: result.score,
    scoreBreakdown: result.scoreBreakdown,
    factIds,
    sessionIds,
    reason: result.reason,
    status: result.status
  };
}

export function scoreTargetMetrics(
  candidates: readonly RetrievalBenchmarkCandidate[],
  goldIds: readonly string[],
  target: RetrievalBenchmarkTarget,
  ks: readonly number[]
): RetrievalMetric[] {
  const gold = new Set(uniqueStrings(goldIds));
  return ks.map((k) => {
    const top = candidates.slice(0, k);
    const matched = new Set<string>();
    let relevantCandidateCount = 0;
    let firstHitRank = -1;
    for (const candidate of top) {
      const targetIds = target === "fact" ? candidate.factIds : candidate.sessionIds;
      const hits = targetIds.filter((id) => gold.has(id));
      if (hits.length) {
        relevantCandidateCount += 1;
        if (firstHitRank < 0) firstHitRank = candidate.rank;
        for (const hit of hits) matched.add(hit);
      }
    }
    const matchedTargetCount = matched.size;
    const candidateDenominator = Math.max(1, top.length);
    const goldDenominator = Math.max(1, gold.size);
    const relevances = top.map((candidate) => {
      const targetIds = target === "fact" ? candidate.factIds : candidate.sessionIds;
      return targetIds.some((id) => gold.has(id)) ? 1 : 0;
    });
    const totalRelevantCandidates = candidates.filter((candidate) => {
      const targetIds = target === "fact" ? candidate.factIds : candidate.sessionIds;
      return targetIds.some((id) => gold.has(id));
    }).length;
    const idealHits = Math.min(totalRelevantCandidates, top.length);
    const idcg = discountedGain(Array.from({ length: idealHits }, () => 1));
    const dcg = discountedGain(relevances);
    return {
      target,
      k,
      evaluatedCases: gold.size ? 1 : 0,
      goldTargetCount: gold.size,
      candidateCount: top.length,
      relevantCandidateCount,
      matchedTargetCount,
      recallAtK: gold.size ? matchedTargetCount / gold.size : 0,
      recallAnyAtK: matchedTargetCount > 0 ? 1 : 0,
      recallAllAtK: gold.size > 0 && matchedTargetCount === gold.size ? 1 : 0,
      precisionAtK: relevantCandidateCount / candidateDenominator,
      mrrAtK: firstHitRank > 0 ? 1 / firstHitRank : 0,
      ndcgAtK: idcg > 0 ? dcg / idcg : 0
    };
  });
}

function aggregateMetrics(
  reports: readonly RetrievalBenchmarkCaseReport[],
  target: RetrievalBenchmarkTarget,
  ks: readonly number[]
) {
  return ks.map((k) => {
    const items = reports
      .map((report) => (target === "fact" ? report.metrics.fact : report.metrics.session).find((item) => item.k === k))
      .filter((item): item is RetrievalMetric => Boolean(item && item.goldTargetCount > 0));
    return {
      target,
      k,
      evaluatedCases: items.length,
      goldTargetCount: sum(items.map((item) => item.goldTargetCount)),
      candidateCount: sum(items.map((item) => item.candidateCount)),
      relevantCandidateCount: sum(items.map((item) => item.relevantCandidateCount)),
      matchedTargetCount: sum(items.map((item) => item.matchedTargetCount)),
      recallAtK: average(items.map((item) => item.recallAtK)),
      recallAnyAtK: average(items.map((item) => item.recallAnyAtK)),
      recallAllAtK: average(items.map((item) => item.recallAllAtK)),
      precisionAtK: average(items.map((item) => item.precisionAtK)),
      mrrAtK: average(items.map((item) => item.mrrAtK)),
      ndcgAtK: average(items.map((item) => item.ndcgAtK))
    } satisfies RetrievalMetric;
  });
}

function diagnoseTarget(
  snapshot: ContextDebugSnapshot,
  response: Pick<ContextSearchResponse, "results" | "dropped">,
  candidates: readonly RetrievalBenchmarkCandidate[],
  benchmarkCase: RetrievalBenchmarkCase,
  target: RetrievalBenchmarkTarget,
  targetId: string
): RetrievalTargetDiagnostic {
  const owners = target === "fact"
    ? factOwnerIds(snapshot, targetId)
    : sessionOwnerIds(snapshot, benchmarkCase, targetId);
  const indexedOwnerIds = owners.filter((ownerId) => hasCompleteIndexBundle(snapshot, ownerId));
  const candidateRanks = candidates
    .filter((candidate) => target === "fact" ? candidate.factIds.includes(targetId) : candidate.sessionIds.includes(targetId))
    .map((candidate) => candidate.rank);
  const ownerIds = new Set(owners);
  const droppedReasons = uniqueStrings(response.dropped
    .filter((item) => ownerIds.has(item.id))
    .map((item) => item.reason));
  let status: RetrievalTargetStatus;
  if (candidateRanks.length) status = "retrieved";
  else if (droppedReasons.length) status = "filtered_before_top_k";
  else if (owners.length && indexedOwnerIds.length === 0) status = "memory_not_indexed";
  else if (indexedOwnerIds.length) status = "not_in_top_k";
  else if (target === "fact") status = snapshot.facts.some((fact) => fact.factId === targetId)
    ? "fact_not_admitted"
    : "fact_not_generated";
  else status = sessionSourceExists(snapshot, benchmarkCase, targetId)
    ? "memory_not_generated"
    : "source_not_ingested";
  return {
    target,
    targetId,
    exists: target === "fact"
      ? snapshot.facts.some((fact) => fact.factId === targetId)
      : owners.length > 0,
    ownerIds: owners,
    indexedOwnerIds,
    candidateRanks,
    droppedReasons,
    status
  };
}

function factOwnerIds(snapshot: ContextDebugSnapshot, factId: string) {
  return uniqueStrings([
    ...snapshot.shortTermMemories.filter((memory) => memory.sourceFactIds.includes(factId)).map((memory) => memory.memoryDataId),
    ...snapshot.longTermMemories
      .filter((memory) => memory.sourceFactIds?.includes(factId) || memory.structuredFacts?.facts.some((fact) => fact.factId === factId))
      .map((memory) => memory.memoryId)
  ]);
}

function sessionOwnerIds(snapshot: ContextDebugSnapshot, benchmarkCase: RetrievalBenchmarkCase, sessionId: string) {
  const sourceId = benchmarkCase.sessionSourceIds[sessionId] ?? sessionId;
  return uniqueStrings([
    ...snapshot.shortTermMemories.filter((memory) => memory.sourceRefs.some((source) => source.sourceId === sourceId || source.metadata?.sessionId === sessionId)).map((memory) => memory.memoryDataId),
    ...snapshot.longTermMemories.filter((memory) => memory.sourceRefs.some((source) => source.sourceId === sourceId || source.metadata?.sessionId === sessionId)).map((memory) => memory.memoryId)
  ]);
}

function sessionSourceExists(snapshot: ContextDebugSnapshot, benchmarkCase: RetrievalBenchmarkCase, sessionId: string) {
  const sourceId = benchmarkCase.sessionSourceIds[sessionId] ?? sessionId;
  return snapshot.memoryEvents.some((event) =>
    event.eventId === sourceId ||
    event.sourceId === sourceId ||
    event.sourceRefs?.some((source) => source.sourceId === sourceId || source.metadata?.sessionId === sessionId)
  );
}

function hasCompleteIndexBundle(snapshot: ContextDebugSnapshot, ownerId: string) {
  const ownerType = snapshot.shortTermMemories.some((memory) => memory.memoryDataId === ownerId) ? "stm" : "ltm";
  return snapshot.indexEntries.some((entry) => entry.ownerType === ownerType && entry.ownerId === ownerId) &&
    snapshot.vectorIndexEntries.some((entry) => entry.ownerType === ownerType && entry.ownerId === ownerId) &&
    snapshot.graphMemoryNodes.some((node) => node.ownerType === ownerType && node.ownerId === ownerId);
}

function longMemEvalSampleToCase(sample: LongMemEvalSample): RetrievalBenchmarkCase {
  const caseId = String(sample.question_id ?? "").trim();
  if (!caseId) throw new Error("LongMemEval sample is missing question_id");
  const sessionIds = stringArray(sample.haystack_session_ids);
  const sessionSourceIds = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, longMemEvalSessionSourceId(caseId, sessionId)]));
  return {
    caseId,
    query: String(sample.question ?? "").trim(),
    goldFactIds: [],
    goldSessionIds: stringArray(sample.answer_session_ids),
    sourceIds: [caseId, ...Object.values(sessionSourceIds)],
    sessionSourceIds,
    tenantId: "local",
    principalId: "longmemeval",
    ...(typeof sample.question_date === "string" && sample.question_date.trim() ? { referenceTime: sample.question_date.trim() } : {}),
    includeInactive: true
  };
}

function parseCase(value: unknown, index: number): RetrievalBenchmarkCase {
  if (!isRecord(value)) throw new Error(`case ${index + 1} must be an object`);
  const query = readRequiredString(value.query ?? value.q, `case ${index + 1}.query`);
  const caseId = readRequiredString(value.caseId ?? value.id ?? `case_${index + 1}`, `case ${index + 1}.caseId`);
  const gold = isRecord(value.gold) ? value.gold : value;
  return {
    caseId,
    query,
    goldFactIds: stringArray(gold.factIds ?? gold.goldFactIds),
    goldSessionIds: stringArray(gold.sessionIds ?? gold.goldSessionIds),
    sourceIds: stringArray(value.sourceIds),
    sessionSourceIds: isRecord(value.sessionSourceIds)
      ? Object.fromEntries(Object.entries(value.sessionSourceIds).flatMap(([key, item]) => typeof item === "string" ? [[key, item]] : []))
      : {},
    ...(typeof value.tenantId === "string" && value.tenantId.trim() ? { tenantId: value.tenantId.trim() } : {}),
    ...(typeof value.principalId === "string" && value.principalId.trim() ? { principalId: value.principalId.trim() } : {}),
    ...(typeof value.referenceTime === "string" && value.referenceTime.trim() ? { referenceTime: value.referenceTime.trim() } : {}),
    ...(typeof value.includeInactive === "boolean" ? { includeInactive: value.includeInactive } : {})
  };
}

function parseJsonOrJsonl(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error(`input is empty: ${path}`);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`invalid JSON on line ${index + 1}: ${path}`);
      }
    });
  }
}

function discountedGain(relevances: number[]) {
  return relevances.reduce((sum, relevance, index) => sum + relevance / Math.log2(index + 2), 0);
}

function emptyDiagnosticCounts(): Record<RetrievalTargetStatus, number> {
  return {
    retrieved: 0,
    not_in_top_k: 0,
    filtered_before_top_k: 0,
    memory_not_indexed: 0,
    source_not_ingested: 0,
    fact_not_generated: 0,
    fact_not_admitted: 0,
    memory_not_generated: 0
  };
}

function normalizeKs(values: number[]) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

function clampLimit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
}

function readRequiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
