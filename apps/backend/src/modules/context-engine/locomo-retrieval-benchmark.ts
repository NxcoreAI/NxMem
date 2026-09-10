import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ContextEngineConfig } from "../../config.js";
import type { EmbeddingClient } from "./embedding.js";
import { createEmbeddingClient, embeddingFingerprint } from "./embedding.js";
import { createCrossEncoderReranker, type CrossEncoderReranker } from "./cross-encoder-reranker.js";
import type {
  ContextPipelineTask,
  FactItem,
  MemoryEvent,
  ShortTermMemory,
  SourceRef
} from "./domain.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import {
  longMemEvalAnswerContextTokenBudget,
  longMemEvalAnswerEvidenceLimit,
  selectLongMemEvalAnswerEvidenceFromSearch,
  type LongMemEvalAnswerEvidenceRejectReason,
  type LongMemEvalAnswerEvidenceRole
} from "./longmemeval.js";
import {
  admitFactsToMemoryPipeline,
  type AdmitFactsToMemoryOptions
} from "./parse-event.js";
import { createParserAdapter } from "./parser.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { createPipelineTask, scheduleRetry, updatePipelineTask } from "./pipeline-task.js";
import {
  scoreTargetMetrics,
  type RetrievalBenchmarkCandidate,
  type RetrievalMetric
} from "./retrieval-benchmark.js";
import {
  searchContext,
  type ContextSearchResponse,
  type ContextSearchResult
} from "./search-context.js";

export const LOCOMO_DEFAULT_LIMIT = 100;
export const LOCOMO_DEFAULT_KS = [1, 5, 10, 20, 50, 100] as const;
export const LOCOMO_DEFAULT_SELECTION_KS = [1, 5, 20] as const;
export const LOCOMO_TENANT_ID = "locomo";

export interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
  img_url?: string[];
  query?: string;
  [key: string]: unknown;
}

export interface LocomoQa {
  question: string;
  answer?: unknown;
  evidence?: string[];
  category?: number;
}

export interface LocomoSample {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: LocomoQa[];
  observation?: Record<string, unknown>;
}

export interface LocomoGoldFact {
  goldFactId: string;
  claim: string;
  evidenceDiaIds: string[];
  evidenceSegmentIds: string[];
  linkedEventIds: string[];
  linkedSourceRefs: SourceRef[];
  observedAt: string;
}

export interface LocomoBenchmarkCase {
  caseId: string;
  sampleId: string;
  qaIndex: number;
  category?: number;
  query: string;
  evidenceDiaIds: string[];
  referenceTime?: string;
  tenantId: string;
  principalId: string;
  goldFacts: LocomoGoldFact[];
  skipReason?: "no_evidence" | "gold_observation_not_found";
}

export interface LocomoDataset {
  samples: LocomoSample[];
  cases: LocomoBenchmarkCase[];
  events: MemoryEvent[];
  facts: LocomoGoldFact[];
}

export interface LocomoPreparationProgress {
  stage: "ingest" | "dreaming";
  current: number;
  total: number;
  sampleId?: string;
  eventId?: string;
}

export interface LocomoPreparationOptions {
  admissionOptions?: Pick<
    AdmitFactsToMemoryOptions,
    "llm" | "disableStmAdmissionLlm" | "skipStmAdmission" | "embeddingClient"
  >;
  dreamingLlm?: LlmFactFusionOptions;
  skipDreaming?: boolean;
  resume?: boolean;
  onProgress?: (progress: LocomoPreparationProgress) => void;
}

export interface LocomoPreparationReport {
  startedAt: string;
  completedAt: string;
  eventCount: number;
  ingestedEventCount: number;
  resumedEventCount: number;
  factCount: number;
  shortTermMemoryCount: number;
  longTermMemoryCount: number;
  validity: {
    fullPipelineCompleted: boolean;
    reasons: string[];
  };
  fallbacks: {
    stmAdmission: Record<string, number>;
    dreaming: Record<string, number>;
  };
  dreaming: {
    enabled: boolean;
    batchCount: number;
    candidateCount: number;
    generatedLongTermMemoryCount: number;
  };
}

export interface LocomoFactTarget {
  goldFactId: string;
  claim: string;
  evidenceDiaIds: string[];
}

export type LocomoFactDiagnosticStatus =
  | "retrieved"
  | "not_in_top_k"
  | "filtered_before_top_k"
  | "memory_not_indexed"
  | "fact_not_admitted"
  | "fact_not_ingested";

export interface LocomoFactDiagnostic extends LocomoFactTarget {
  status: LocomoFactDiagnosticStatus;
  stmOwnerIds: string[];
  ltmOwnerIds: string[];
  indexedOwnerIds: string[];
  candidateRanks: number[];
  stmCandidateRanks: number[];
  ltmCandidateRanks: number[];
  droppedOwnerReasons: string[];
  selectionStatus: "selected" | "retrieved_not_selected" | "not_retrieved";
  selectionRanks: number[];
  selectionRejectionReasons: string[];
}

export interface LocomoRankedCandidate {
  rank: number;
  id: string;
  layer: ContextSearchResult["layer"];
  score: number;
  scoreBreakdown: ContextSearchResult["scoreBreakdown"];
  factIds: string[];
  matchedGoldFactIds: string[];
  reason: string;
  status: string;
}

export interface LocomoSelectedCandidate extends LocomoRankedCandidate {
  retrievalRank: number;
  selectionRank: number;
  selectionReason: string;
  evidenceRole: LongMemEvalAnswerEvidenceRole;
}

export interface LocomoSelectionRejection {
  id: string;
  layer?: ContextSearchResult["layer"];
  reason: LongMemEvalAnswerEvidenceRejectReason;
  retrievalRank?: number;
  factIds: string[];
  matchedGoldFactIds: string[];
}

export interface LocomoCaseReport {
  caseId: string;
  sampleId: string;
  qaIndex: number;
  category?: number;
  query: string;
  evidenceDiaIds: string[];
  evaluable: boolean;
  skipReason?: LocomoBenchmarkCase["skipReason"];
  response?: Pick<ContextSearchResponse, "total" | "dropped" | "trace" | "temporal">;
  goldFacts: LocomoFactTarget[];
  candidates: LocomoRankedCandidate[];
  selection: {
    candidateLimit: number;
    evidenceLimit: number;
    tokenBudget: number;
    usedTokens: number;
    selectedCandidates: LocomoSelectedCandidate[];
    rejected: LocomoSelectionRejection[];
    metrics: {
      all: RetrievalMetric[];
      stm: RetrievalMetric[];
      ltm: RetrievalMetric[];
    };
  };
  metrics: {
    all: RetrievalMetric[];
    stm: RetrievalMetric[];
    ltm: RetrievalMetric[];
  };
  diagnostics: LocomoFactDiagnostic[];
}

export interface LocomoRetrievalReport {
  schemaVersion: "locomo-fact-retrieval.v3";
  generatedAt: string;
  dataset: {
    sampleCount: number;
    caseCount: number;
    evaluableCaseCount: number;
    skippedCaseCount: number;
    goldFactCount: number;
  };
  retrieval: {
    layer: "all";
    factCandidatesEnabled: boolean;
    memoryRerankerEnabled: boolean;
    memoryRerankerModel?: string;
    memoryRerankerFallbackCaseCount: number;
    limit: number;
    ks: number[];
    embeddingFingerprint: string;
  };
  selection: {
    evidenceLimit: number;
    tokenBudget: number;
    ks: number[];
  };
  store: {
    factCount: number;
    shortTermMemoryCount: number;
    longTermMemoryCount: number;
    indexedMemoryCount: number;
  };
  metrics: {
    all: RetrievalMetric[];
    stm: RetrievalMetric[];
    ltm: RetrievalMetric[];
  };
  selectionMetrics: {
    all: RetrievalMetric[];
    stm: RetrievalMetric[];
    ltm: RetrievalMetric[];
  };
  funnel: {
    goldFactCount: number;
    retrievedGoldFactCount: number;
    selectedGoldFactCount: number;
    selectedFromRetrievedRate: number;
    casesWithAnyRetrieved: number;
    casesWithAnySelected: number;
  };
  diagnosticCounts: Record<LocomoFactDiagnosticStatus, number>;
  cases: LocomoCaseReport[];
}

export interface LocomoEvaluationOptions {
  limit?: number;
  ks?: number[];
  selectionKs?: number[];
  selectionTokenBudget?: number;
  factCandidatesEnabled?: boolean;
  memoryReranker?: CrossEncoderReranker | false;
  embeddingClient?: EmbeddingClient;
  onProgress?: (current: number, total: number, benchmarkCase: LocomoBenchmarkCase) => void;
}

export async function readLocomoDataset(path: string): Promise<LocomoDataset> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LoCoMo dataset must be a JSON array");
  const samples = parsed.map(parseLocomoSample);
  return buildLocomoDataset(samples);
}

export function buildLocomoDataset(samples: readonly LocomoSample[]): LocomoDataset {
  const events = samples.flatMap(buildLocomoEvents);
  const factsBySampleId = new Map(samples.map((sample) => [sample.sample_id, buildLocomoFacts(sample)]));
  const facts = [...factsBySampleId.values()].flat();
  const cases = samples.flatMap((sample) => buildLocomoCases(sample, factsBySampleId.get(sample.sample_id) ?? []));
  return { samples: [...samples], events, facts, cases };
}

export function selectLocomoDataset(
  dataset: LocomoDataset,
  selector: { sampleIds?: string[]; sampleRange?: { start: number; end: number } }
): LocomoDataset {
  let samples = dataset.samples;
  if (selector.sampleRange) {
    const { start, end } = selector.sampleRange;
    if (start < 1 || end < start || end > samples.length) {
      throw new Error(`sample range must satisfy 1 <= start <= end <= ${samples.length}`);
    }
    samples = samples.slice(start - 1, end);
  } else if (selector.sampleIds?.length) {
    const allowed = new Set(selector.sampleIds);
    samples = samples.filter((sample) => allowed.has(sample.sample_id));
    const found = new Set(samples.map((sample) => sample.sample_id));
    const missing = [...allowed].filter((sampleId) => !found.has(sampleId));
    if (missing.length) throw new Error(`LoCoMo sample not found: ${missing.join(", ")}`);
  }
  return buildLocomoDataset(samples);
}

export async function prepareLocomoRetrievalStore(
  repository: ContextEngineRepository,
  dataset: LocomoDataset,
  options: LocomoPreparationOptions = {}
): Promise<LocomoPreparationReport> {
  const startedAt = new Date().toISOString();
  assertNoLegacyLocomoFacts(repository, dataset);
  let ingestedEventCount = 0;
  let resumedEventCount = 0;
  for (const [index, event] of dataset.events.entries()) {
    const sampleId = readMetadataString(event.sourceRefs?.[0], "sampleId");
    options.onProgress?.({
      stage: "ingest",
      current: index + 1,
      total: dataset.events.length,
      ...(sampleId ? { sampleId } : {}),
      eventId: event.eventId
    });
    const facts = dataset.facts
      .filter((fact) => fact.linkedEventIds[0] === event.eventId)
      .map((fact) => locomoGoldFactToFactItem(fact, event));
    const completed = options.resume !== false && await isCompletedObservationEvent(repository, event.eventId, facts);
    if (completed) {
      resumedEventCount += 1;
      continue;
    }
    await ingestLocomoObservationFacts(repository, event, facts, options.admissionOptions);
    ingestedEventCount += 1;
  }

  const snapshot = repository.getDebugSnapshot();
  const selectedPrincipals = new Set(dataset.samples.map((sample) => locomoPrincipalId(sample.sample_id)));
  const facts = snapshot.facts.filter((fact) => fact.tenantId === LOCOMO_TENANT_ID && fact.principalId && selectedPrincipals.has(fact.principalId));
  const stms = snapshot.shortTermMemories.filter((memory) => memory.tenantId === LOCOMO_TENANT_ID && selectedPrincipals.has(memory.principalId));
  const ltms = snapshot.longTermMemories.filter((memory) => memory.tenantId === LOCOMO_TENANT_ID && memory.principalId && selectedPrincipals.has(memory.principalId));
  const selectedEventIds = new Set(dataset.events.map((event) => event.eventId));
  const stmAdmissionFallbacks = countFallbacks(
    snapshot.llmStmAdmissionTraces.filter((trace) => selectedEventIds.has(trace.eventId))
  );
  const dreamingFallbacks: Record<string, number> = {};
  const validityReasons = [
    ...(Object.keys(stmAdmissionFallbacks).length ? ["stm_admission_fallback"] : []),
    "dreaming_skipped"
  ];
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    eventCount: dataset.events.length,
    ingestedEventCount,
    resumedEventCount,
    factCount: facts.length,
    shortTermMemoryCount: stms.length,
    longTermMemoryCount: ltms.length,
    validity: {
      fullPipelineCompleted: validityReasons.length === 0,
      reasons: validityReasons
    },
    fallbacks: {
      stmAdmission: stmAdmissionFallbacks,
      dreaming: dreamingFallbacks
    },
    dreaming: {
      enabled: false,
      batchCount: 0,
      candidateCount: 0,
      generatedLongTermMemoryCount: 0
    }
  };
}

export async function evaluateLocomoFactRetrieval(
  repository: ContextEngineRepository,
  dataset: LocomoDataset,
  options: LocomoEvaluationOptions = {}
): Promise<LocomoRetrievalReport> {
  assertNoLegacyLocomoFacts(repository, dataset);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? LOCOMO_DEFAULT_LIMIT)));
  const ks = normalizeKs(options.ks ?? [...LOCOMO_DEFAULT_KS], limit);
  const selectionKs = normalizeKs(
    options.selectionKs ?? [...LOCOMO_DEFAULT_SELECTION_KS],
    longMemEvalAnswerEvidenceLimit
  );
  const selectionTokenBudget = options.selectionTokenBudget ?? longMemEvalAnswerContextTokenBudget;
  const embeddingClient = options.embeddingClient ?? createEmbeddingClient();
  const factCandidatesEnabled = options.factCandidatesEnabled === true;
  const memoryReranker = options.memoryReranker === false
    ? undefined
    : options.memoryReranker ?? createCrossEncoderReranker();
  const snapshot = repository.getDebugSnapshot();
  const ingestedFactIds = new Set(snapshot.facts.map((fact) => fact.factId));
  const indexOwnerIds = new Set(snapshot.indexEntries.map((entry) => entry.ownerId));
  const reports: LocomoCaseReport[] = [];

  for (const [caseIndex, benchmarkCase] of dataset.cases.entries()) {
    options.onProgress?.(caseIndex + 1, dataset.cases.length, benchmarkCase);
    if (benchmarkCase.skipReason || !benchmarkCase.goldFacts.length) {
      reports.push(emptyCaseReport(benchmarkCase, limit, selectionTokenBudget));
      continue;
    }
    const response = await searchContext(repository, {
      q: benchmarkCase.query,
      layer: "all",
      limit,
      offset: 0,
      tenantId: benchmarkCase.tenantId,
      principalId: benchmarkCase.principalId,
      ...(benchmarkCase.referenceTime ? { referenceTime: benchmarkCase.referenceTime } : {})
    }, {
      embeddingClient,
      factRetrieval: factCandidatesEnabled,
      memoryReranker: memoryReranker ?? false,
      recordRetrieval: false,
      recordShadow: false
    });
    const goldFactIds = benchmarkCase.goldFacts.map((fact) => fact.goldFactId);
    const candidates = response.results.map((result, index) => toRankedCandidate(result, index + 1, goldFactIds));
    const metricCandidates = candidates.map(toMetricCandidate);
    const metrics = {
      all: scoreTargetMetrics(metricCandidates, goldFactIds, "fact", ks),
      stm: scoreTargetMetrics(maskOtherLayers(metricCandidates, "stm"), goldFactIds, "fact", ks),
      ltm: scoreTargetMetrics(maskOtherLayers(metricCandidates, "ltm"), goldFactIds, "fact", ks)
    };
    const evidenceSelection = await selectLongMemEvalAnswerEvidenceFromSearch(repository, {
      question: benchmarkCase.query,
      questionType: locomoQuestionType(benchmarkCase.category),
      search: response,
      questionId: benchmarkCase.caseId,
      tokenBudget: selectionTokenBudget
    });
    const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selectionDetailsById = new Map(evidenceSelection.selected.map((item) => [item.itemId, item]));
    const selectedCandidates = evidenceSelection.selectedCandidates.flatMap((candidate, index) => {
      const retrieved = candidatesById.get(candidate.item.id);
      if (!retrieved) return [];
      const detail = selectionDetailsById.get(candidate.item.id);
      const selectionRank = index + 1;
      return [{
        ...retrieved,
        rank: selectionRank,
        retrievalRank: retrieved.rank,
        selectionRank,
        selectionReason: detail?.reason ?? "selected by current evidence selector",
        evidenceRole: detail?.evidenceRole ?? "disambiguation"
      }];
    });
    const selectedMetricCandidates = selectedCandidates.map(toMetricCandidate);
    const selectionMetrics = {
      all: scoreTargetMetrics(selectedMetricCandidates, goldFactIds, "fact", selectionKs),
      stm: scoreTargetMetrics(maskOtherLayers(selectedMetricCandidates, "stm"), goldFactIds, "fact", selectionKs),
      ltm: scoreTargetMetrics(maskOtherLayers(selectedMetricCandidates, "ltm"), goldFactIds, "fact", selectionKs)
    };
    const selectionRejected = evidenceSelection.rejected.map((rejection): LocomoSelectionRejection => {
      const retrieved = candidatesById.get(rejection.itemId);
      return {
        id: rejection.itemId,
        ...(rejection.layer ? { layer: rejection.layer } : {}),
        reason: rejection.reason,
        ...(retrieved ? { retrievalRank: retrieved.rank } : {}),
        factIds: retrieved?.factIds ?? [],
        matchedGoldFactIds: retrieved?.matchedGoldFactIds ?? []
      };
    });
    const diagnostics = benchmarkCase.goldFacts.map((fact) => buildFactDiagnostic(
      fact,
      candidates,
      selectedCandidates,
      selectionRejected,
      snapshot.shortTermMemories,
      snapshot.longTermMemories,
      indexOwnerIds,
      response.dropped,
      ingestedFactIds
    ));
    reports.push({
      caseId: benchmarkCase.caseId,
      sampleId: benchmarkCase.sampleId,
      qaIndex: benchmarkCase.qaIndex,
      ...(benchmarkCase.category === undefined ? {} : { category: benchmarkCase.category }),
      query: benchmarkCase.query,
      evidenceDiaIds: benchmarkCase.evidenceDiaIds,
      evaluable: true,
      response: {
        total: response.total,
        dropped: response.dropped,
        trace: response.trace,
        temporal: response.temporal
      },
      goldFacts: benchmarkCase.goldFacts.map(toFactTarget),
      candidates,
      selection: {
        candidateLimit: limit,
        evidenceLimit: longMemEvalAnswerEvidenceLimit,
        tokenBudget: evidenceSelection.tokenBudget,
        usedTokens: evidenceSelection.usedTokens,
        selectedCandidates,
        rejected: selectionRejected,
        metrics: selectionMetrics
      },
      metrics,
      diagnostics
    });
  }

  const diagnosticCounts = emptyDiagnosticCounts();
  for (const report of reports) {
    for (const diagnostic of report.diagnostics) diagnosticCounts[diagnostic.status] += 1;
  }
  const evaluableReports = reports.filter((report) => report.evaluable);
  return {
    schemaVersion: "locomo-fact-retrieval.v3",
    generatedAt: new Date().toISOString(),
    dataset: {
      sampleCount: dataset.samples.length,
      caseCount: reports.length,
      evaluableCaseCount: evaluableReports.length,
      skippedCaseCount: reports.length - evaluableReports.length,
      goldFactCount: evaluableReports.reduce((sum, report) => sum + report.goldFacts.length, 0)
    },
    retrieval: {
      layer: "all",
      factCandidatesEnabled,
      memoryRerankerEnabled: Boolean(memoryReranker),
      ...(memoryReranker ? { memoryRerankerModel: memoryReranker.model } : {}),
      memoryRerankerFallbackCaseCount: evaluableReports.filter((report) =>
        report.candidates.some((candidate) => candidate.reason.includes(":reranker_fallback"))
      ).length,
      limit,
      ks,
      embeddingFingerprint: embeddingClient.fingerprint
    },
    selection: {
      evidenceLimit: longMemEvalAnswerEvidenceLimit,
      tokenBudget: selectionTokenBudget,
      ks: selectionKs
    },
    store: {
      factCount: snapshot.facts.length,
      shortTermMemoryCount: snapshot.shortTermMemories.length,
      longTermMemoryCount: snapshot.longTermMemories.length,
      indexedMemoryCount: snapshot.indexEntries.filter((entry) => entry.ownerType === "stm" || entry.ownerType === "ltm").length
    },
    metrics: {
      all: aggregateCaseMetrics(evaluableReports, "all", ks),
      stm: aggregateCaseMetrics(evaluableReports, "stm", ks),
      ltm: aggregateCaseMetrics(evaluableReports, "ltm", ks)
    },
    selectionMetrics: {
      all: aggregateSelectionMetrics(evaluableReports, "all", selectionKs),
      stm: aggregateSelectionMetrics(evaluableReports, "stm", selectionKs),
      ltm: aggregateSelectionMetrics(evaluableReports, "ltm", selectionKs)
    },
    funnel: buildSelectionFunnel(evaluableReports),
    diagnosticCounts,
    cases: reports
  };
}

export function locomoStoreFingerprint(datasetPath: string, config: ContextEngineConfig) {
  return createHash("sha1")
    .update(`locomo-retrieval.v2:${embeddingFingerprint(config.embedding)}:${datasetPath}`)
    .digest("hex")
    .slice(0, 12);
}

export function locomoPrincipalId(sampleId: string) {
  return `locomo_observation_v2_${safeId(sampleId)}`;
}

export function locomoSessionEventId(sampleId: string, sessionId: string) {
  return `locomo_event_${safeId(sampleId)}_${safeId(sessionId)}`;
}

export function locomoUtteranceSourceId(sampleId: string, diaId: string) {
  return `locomo_utterance_${safeId(sampleId)}_${safeId(diaId)}`;
}

export function locomoUtteranceSegmentId(sampleId: string, sessionId: string, diaId: string) {
  return `seg_${locomoSessionEventId(sampleId, sessionId)}_${locomoTurnItemId(diaId)}`;
}

function parseLocomoSample(value: unknown, index: number): LocomoSample {
  if (!isRecord(value)) throw new Error(`LoCoMo sample ${index + 1} must be an object`);
  if (!isRecord(value.conversation)) throw new Error(`LoCoMo sample ${index + 1} has no conversation`);
  if (!Array.isArray(value.qa)) throw new Error(`LoCoMo sample ${index + 1} has no qa array`);
  const sampleId = readString(value.sample_id) || `sample-${index + 1}`;
  return {
    sample_id: sampleId,
    conversation: value.conversation,
    qa: value.qa.map((qa, qaIndex) => parseQa(qa, sampleId, qaIndex)),
    ...(isRecord(value.observation) ? { observation: value.observation } : {})
  };
}

function parseQa(value: unknown, sampleId: string, index: number): LocomoQa {
  if (!isRecord(value) || !readString(value.question)) {
    throw new Error(`LoCoMo sample ${sampleId} QA ${index + 1} has no question`);
  }
  return {
    question: readString(value.question)!,
    ...(value.answer === undefined ? {} : { answer: value.answer }),
    ...(Array.isArray(value.evidence) ? { evidence: value.evidence.flatMap(splitEvidenceRefs) } : {}),
    ...(typeof value.category === "number" ? { category: value.category } : {})
  };
}

function buildLocomoEvents(sample: LocomoSample): MemoryEvent[] {
  return readSessions(sample).map(({ sessionId, dateTime, turns }) => {
    const eventId = locomoSessionEventId(sample.sample_id, sessionId);
    const eventTime = parseLocomoDateTime(dateTime) ?? "1970-01-01T00:00:00.000Z";
    const refs = turns.map((turn) => locomoSourceRef(sample.sample_id, sessionId, turn));
    return {
      eventId,
      eventType: "locomo_session",
      eventSummary: `LoCoMo ${sample.sample_id} ${sessionId}`,
      eventTime,
      sourceApp: "locomo",
      sourceId: `${sample.sample_id}:${sessionId}`,
      permissionSnapshot: {
        snapshotId: `ps_${eventId}`,
        tenantId: LOCOMO_TENANT_ID,
        principalId: locomoPrincipalId(sample.sample_id),
        sourceAclVersion: "locomo-v1",
        visibility: "private"
      },
      multimodalData: turns.map((turn) => {
        const sourceRef = locomoSourceRef(sample.sample_id, sessionId, turn);
        return {
          itemId: locomoTurnItemId(turn.dia_id),
          type: "text" as const,
          format: "json",
          content: {
            text: renderLocomoTurn(turn),
            sampleId: sample.sample_id,
            sessionId,
            diaId: turn.dia_id,
            speaker: turn.speaker,
            ...(turn.blip_caption ? { imageCaption: turn.blip_caption } : {})
          },
          ref: turn.dia_id,
          sourceRefs: [sourceRef],
          timeBasis: "source_time" as const,
          timeConfidence: "high" as const
        };
      }),
      sourceRefs: refs
    };
  });
}

function buildLocomoFacts(sample: LocomoSample): LocomoGoldFact[] {
  const sessions = readSessions(sample);
  const evidenceByDiaId = new Map(sessions.flatMap((session) => session.turns.map((turn) => [turn.dia_id, {
    eventId: locomoSessionEventId(sample.sample_id, session.sessionId),
    segmentId: locomoUtteranceSegmentId(sample.sample_id, session.sessionId, turn.dia_id),
    sourceRef: locomoSourceRef(sample.sample_id, session.sessionId, turn),
    observedAt: parseLocomoDateTime(session.dateTime) ?? "1970-01-01T00:00:00.000Z",
    sessionIndex: session.sessionIndex
  }] as const)));
  return readGoldObservations(sample).flatMap((observation) => {
    const evidence = observation.evidenceDiaIds
      .flatMap((diaId) => {
        const item = evidenceByDiaId.get(diaId);
        return item ? [{ diaId, ...item }] : [];
      })
      .sort((left, right) => left.sessionIndex - right.sessionIndex || left.diaId.localeCompare(right.diaId));
    if (!evidence.length) return [];
    const evidenceDiaIds = uniqueStrings(evidence.map((item) => item.diaId));
    return [{
      goldFactId: locomoObservationFactId(sample.sample_id, observation.claim, evidenceDiaIds),
      claim: observation.claim,
      evidenceDiaIds,
      evidenceSegmentIds: uniqueStrings(evidence.map((item) => item.segmentId)),
      linkedEventIds: uniqueStrings(evidence.map((item) => item.eventId)),
      linkedSourceRefs: uniqueSourceRefs(evidence.map((item) => item.sourceRef)),
      observedAt: evidence[0]!.observedAt
    }];
  });
}

function buildLocomoCases(sample: LocomoSample, facts: readonly LocomoGoldFact[]): LocomoBenchmarkCase[] {
  const referenceTime = readSessions(sample)
    .map((session) => parseLocomoDateTime(session.dateTime))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return sample.qa.map((qa, qaIndex) => {
    const evidenceDiaIds = uniqueStrings((qa.evidence ?? []).flatMap(splitEvidenceRefs));
    const goldFacts = selectGoldObservations(qa, evidenceDiaIds, facts);
    return {
      caseId: `${sample.sample_id}:q${qaIndex + 1}`,
      sampleId: sample.sample_id,
      qaIndex: qaIndex + 1,
      ...(qa.category === undefined ? {} : { category: qa.category }),
      query: qa.question,
      evidenceDiaIds,
      ...(referenceTime ? { referenceTime } : {}),
      tenantId: LOCOMO_TENANT_ID,
      principalId: locomoPrincipalId(sample.sample_id),
      goldFacts,
      ...(!evidenceDiaIds.length
        ? { skipReason: "no_evidence" as const }
        : !goldFacts.length ? { skipReason: "gold_observation_not_found" as const } : {})
    };
  });
}

export function locomoObservationFactId(
  sampleId: string,
  claim: string,
  evidenceDiaIds: readonly string[]
) {
  const digest = createHash("sha256")
    .update(JSON.stringify([sampleId, claim.trim(), [...evidenceDiaIds].sort()]))
    .digest("hex")
    .slice(0, 24);
  return `locomo_fact_${safeId(sampleId)}_${digest}`;
}

function locomoGoldFactToFactItem(fact: LocomoGoldFact, event: MemoryEvent): FactItem {
  return {
    factId: fact.goldFactId,
    tenantId: event.permissionSnapshot.tenantId,
    principalId: event.permissionSnapshot.principalId,
    factType: "locomo_observation",
    factText: fact.claim,
    sourceClaim: fact.claim,
    normalizedClaim: normalizeObservationClaim(fact.claim),
    linkedEventIds: fact.linkedEventIds,
    linkedSegmentIds: fact.evidenceSegmentIds,
    linkedSourceRefs: fact.linkedSourceRefs,
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: fact.observedAt,
    evidenceTimeStart: fact.observedAt,
    evidenceTimeConfidence: "high",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "locomo-observation-fact.v1",
    accessState: "visible"
  };
}

function toFactTarget(fact: LocomoGoldFact): LocomoFactTarget {
  return {
    goldFactId: fact.goldFactId,
    claim: fact.claim,
    evidenceDiaIds: fact.evidenceDiaIds
  };
}

function normalizeObservationClaim(claim: string) {
  return claim.trim().toLowerCase().replace(/\s+/gu, " ");
}

function locomoQuestionType(category: number | undefined) {
  if (category === 2) return "temporal";
  if (category === 1) return "multi-session";
  return "single-session";
}

function readGoldObservations(sample: LocomoSample) {
  const rows: Array<{ claim: string; evidenceDiaIds: string[] }> = [];
  for (const value of Object.values(sample.observation ?? {})) {
    if (!isRecord(value)) continue;
    for (const speakerRows of Object.values(value)) {
      if (!Array.isArray(speakerRows)) continue;
      for (const row of speakerRows) {
        if (!Array.isArray(row)) continue;
        const claim = readString(row[0]);
        const evidenceDiaIds = splitEvidenceRefs(row[1]);
        if (claim && evidenceDiaIds.length) rows.push({ claim, evidenceDiaIds });
      }
    }
  }
  return deduplicateObservations(rows);
}

function readSessions(sample: LocomoSample) {
  return Object.entries(sample.conversation)
    .flatMap(([key, value]) => {
      const match = /^session_(\d+)$/u.exec(key);
      if (!match || !Array.isArray(value)) return [];
      const turns = value.map((turn, index) => parseTurn(turn, sample.sample_id, key, index));
      return [{
        sessionId: key,
        sessionIndex: Number(match[1]),
        dateTime: readString(sample.conversation[`${key}_date_time`]) ?? "",
        turns
      }];
    })
    .sort((left, right) => left.sessionIndex - right.sessionIndex);
}

function parseTurn(value: unknown, sampleId: string, sessionId: string, index: number): LocomoTurn {
  if (!isRecord(value)) throw new Error(`LoCoMo ${sampleId} ${sessionId} turn ${index + 1} must be an object`);
  const diaId = readString(value.dia_id);
  const text = readString(value.text);
  if (!diaId || !text) throw new Error(`LoCoMo ${sampleId} ${sessionId} turn ${index + 1} is missing dia_id or text`);
  return {
    ...value,
    speaker: readString(value.speaker) ?? "unknown",
    dia_id: diaId,
    text,
    ...(readString(value.blip_caption) ? { blip_caption: readString(value.blip_caption)! } : {})
  } as LocomoTurn;
}

function locomoSourceRef(sampleId: string, sessionId: string, turn: LocomoTurn): SourceRef {
  const sourceId = locomoUtteranceSourceId(sampleId, turn.dia_id);
  return {
    sourceRefId: `src_${sourceId}`,
    sourceType: "agent_memory",
    sourceId,
    metadata: {
      dataset: "locomo",
      sampleId,
      sessionId,
      diaId: turn.dia_id,
      speaker: turn.speaker
    }
  };
}

function renderLocomoTurn(turn: LocomoTurn) {
  return [
    `${turn.speaker}: ${turn.text}`,
    ...(turn.blip_caption ? [`Image description: ${turn.blip_caption}`] : [])
  ].join("\n");
}

async function ingestLocomoObservationFacts(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  facts: readonly FactItem[],
  admissionOptions: LocomoPreparationOptions["admissionOptions"] = {}
) {
  let task: ContextPipelineTask = createPipelineTask(event);
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
  try {
    task = await updatePipelineTask(repository, task, {
      taskType: "parse",
      status: "running",
      stage: "parse_started"
    });
    const parsed = await createParserAdapter().parse(event);
    for (const segment of parsed.segments) await repository.saveParsedSegment(segment);
    for (const fact of facts) {
      await repository.saveFactItem(fact);
      await repository.saveMemoryChangeEvent({
        eventId: `mce_${event.eventId}_${fact.factId}`,
        memoryDataId: fact.factId,
        changeType: "created",
        storageLayer: "fact",
        reason: "locomo_observation_fact_imported",
        createdAt: new Date().toISOString()
      });
    }
    if (!facts.length) {
      await updatePipelineTask(repository, task, {
        taskType: "index",
        status: "succeeded",
        stage: "no_observation_facts",
        retryable: false
      });
      return;
    }
    await admitFactsToMemoryPipeline(repository, event, facts, {
      ...admissionOptions,
      task,
      fallbackSourceRefs: parsed.sourceRefs
    });
  } catch (error) {
    await repository.savePipelineTask(scheduleRetry(task, error));
    throw error;
  }
}

function assertNoLegacyLocomoFacts(repository: ContextEngineRepository, dataset: LocomoDataset) {
  const selectedEventIds = new Set(dataset.events.map((event) => event.eventId));
  const legacy = repository.getDebugSnapshot().facts.find((fact) =>
    fact.linkedEventIds.some((eventId) => selectedEventIds.has(eventId)) &&
    fact.schemaVersion !== "locomo-observation-fact.v1"
  );
  if (legacy) {
    throw new Error(
      `LoCoMo store contains legacy extracted Fact ${legacy.factId}; use a new --store-path for observation-v2 evaluation`
    );
  }
}

async function isCompletedObservationEvent(
  repository: ContextEngineRepository,
  eventId: string,
  expectedFacts: readonly FactItem[]
) {
  if (!await repository.hasMemoryEvent(eventId)) return false;
  if ((await repository.getPipelineTaskByEventId(eventId))?.status !== "succeeded") return false;
  if (!expectedFacts.length) return true;
  const storedIds = new Set(
    (await repository.getFactItemsByIds(expectedFacts.map((fact) => fact.factId))).map((fact) => fact.factId)
  );
  return expectedFacts.every((fact) => storedIds.has(fact.factId));
}

function toRankedCandidate(
  result: ContextSearchResult,
  rank: number,
  goldFactIds: readonly string[]
): LocomoRankedCandidate {
  const factIds = uniqueStrings([
    ...result.factIds,
    ...result.factContext.currentFacts.map((fact) => fact.factId),
    ...result.factContext.sourceFacts.map((fact) => fact.factId)
  ]);
  const gold = new Set(goldFactIds);
  return {
    rank,
    id: result.id,
    layer: result.layer,
    score: result.score,
    scoreBreakdown: result.scoreBreakdown,
    factIds,
    matchedGoldFactIds: factIds.filter((factId) => gold.has(factId)),
    reason: result.reason,
    status: result.status
  };
}

function toMetricCandidate(candidate: LocomoRankedCandidate): RetrievalBenchmarkCandidate {
  return {
    rank: candidate.rank,
    id: candidate.id,
    layer: candidate.layer,
    score: candidate.score,
    scoreBreakdown: candidate.scoreBreakdown,
    factIds: candidate.matchedGoldFactIds,
    sessionIds: [],
    reason: candidate.reason,
    status: candidate.status
  };
}

function maskOtherLayers(
  candidates: readonly RetrievalBenchmarkCandidate[],
  layer: "stm" | "ltm"
) {
  return candidates.map((candidate) => candidate.layer === layer
    ? candidate
    : { ...candidate, factIds: [] });
}

function buildFactDiagnostic(
  fact: LocomoGoldFact,
  candidates: readonly LocomoRankedCandidate[],
  selectedCandidates: readonly LocomoSelectedCandidate[],
  selectionRejected: readonly LocomoSelectionRejection[],
  stms: readonly ShortTermMemory[],
  ltms: ReturnType<ContextEngineRepository["getDebugSnapshot"]>["longTermMemories"],
  indexOwnerIds: Set<string>,
  dropped: ContextSearchResponse["dropped"],
  ingestedFactIds: Set<string>
): LocomoFactDiagnostic {
  const stmOwnerIds = stms.filter((memory) => memory.sourceFactIds.includes(fact.goldFactId)).map((memory) => memory.memoryDataId);
  const ltmOwnerIds = ltms.filter((memory) => (memory.sourceFactIds ?? []).includes(fact.goldFactId)).map((memory) => memory.memoryId);
  const ownerIds = [...stmOwnerIds, ...ltmOwnerIds];
  const indexedOwnerIds = ownerIds.filter((ownerId) => indexOwnerIds.has(ownerId));
  const hits = candidates.filter((candidate) => candidate.matchedGoldFactIds.includes(fact.goldFactId));
  const candidateRanks = hits.map((candidate) => candidate.rank);
  const stmCandidateRanks = hits.filter((candidate) => candidate.layer === "stm").map((candidate) => candidate.rank);
  const ltmCandidateRanks = hits.filter((candidate) => candidate.layer === "ltm").map((candidate) => candidate.rank);
  const selectionHits = selectedCandidates.filter((candidate) => candidate.matchedGoldFactIds.includes(fact.goldFactId));
  const selectionRanks = selectionHits.map((candidate) => candidate.selectionRank);
  const selectionRejectionReasons = uniqueStrings(selectionRejected
    .filter((item) => item.matchedGoldFactIds.includes(fact.goldFactId))
    .map((item) => `${item.id}:${item.reason}`));
  const ownerIdSet = new Set(ownerIds);
  const droppedOwnerReasons = dropped
    .filter((item) => ownerIdSet.has(item.id))
    .map((item) => `${item.id}:${item.reason}`);
  const status: LocomoFactDiagnosticStatus = candidateRanks.length
    ? "retrieved"
    : !ingestedFactIds.has(fact.goldFactId)
      ? "fact_not_ingested"
      : !ownerIds.length
        ? "fact_not_admitted"
        : !indexedOwnerIds.length
          ? "memory_not_indexed"
          : droppedOwnerReasons.length
            ? "filtered_before_top_k"
            : "not_in_top_k";
  return {
    ...toFactTarget(fact),
    status,
    stmOwnerIds,
    ltmOwnerIds,
    indexedOwnerIds,
    candidateRanks,
    stmCandidateRanks,
    ltmCandidateRanks,
    droppedOwnerReasons,
    selectionStatus: selectionRanks.length
      ? "selected"
      : candidateRanks.length ? "retrieved_not_selected" : "not_retrieved",
    selectionRanks,
    selectionRejectionReasons
  };
}

function aggregateCaseMetrics(
  reports: readonly LocomoCaseReport[],
  layer: keyof LocomoCaseReport["metrics"],
  ks: readonly number[]
) {
  return ks.map((k) => {
    const rows = reports.flatMap((report) => report.metrics[layer].filter((metric) => metric.k === k));
    const evaluated = rows.filter((row) => row.evaluatedCases > 0);
    const sum = (key: keyof RetrievalMetric) => evaluated.reduce((total, row) => total + Number(row[key]), 0);
    const count = evaluated.length;
    return {
      target: "fact" as const,
      k,
      evaluatedCases: count,
      goldTargetCount: sum("goldTargetCount"),
      candidateCount: sum("candidateCount"),
      relevantCandidateCount: sum("relevantCandidateCount"),
      matchedTargetCount: sum("matchedTargetCount"),
      recallAtK: count ? sum("recallAtK") / count : 0,
      recallAnyAtK: count ? sum("recallAnyAtK") / count : 0,
      recallAllAtK: count ? sum("recallAllAtK") / count : 0,
      precisionAtK: count ? sum("precisionAtK") / count : 0,
      mrrAtK: count ? sum("mrrAtK") / count : 0,
      ndcgAtK: count ? sum("ndcgAtK") / count : 0
    } satisfies RetrievalMetric;
  });
}

function aggregateSelectionMetrics(
  reports: readonly LocomoCaseReport[],
  layer: keyof LocomoCaseReport["selection"]["metrics"],
  ks: readonly number[]
) {
  return ks.map((k) => aggregateMetricRows(
    reports.flatMap((report) => report.selection.metrics[layer].filter((metric) => metric.k === k)),
    k
  ));
}

function aggregateMetricRows(rows: RetrievalMetric[], k: number): RetrievalMetric {
  const evaluated = rows.filter((row) => row.evaluatedCases > 0);
  const sum = (key: keyof RetrievalMetric) => evaluated.reduce((total, row) => total + Number(row[key]), 0);
  const count = evaluated.length;
  return {
    target: "fact",
    k,
    evaluatedCases: count,
    goldTargetCount: sum("goldTargetCount"),
    candidateCount: sum("candidateCount"),
    relevantCandidateCount: sum("relevantCandidateCount"),
    matchedTargetCount: sum("matchedTargetCount"),
    recallAtK: count ? sum("recallAtK") / count : 0,
    recallAnyAtK: count ? sum("recallAnyAtK") / count : 0,
    recallAllAtK: count ? sum("recallAllAtK") / count : 0,
    precisionAtK: count ? sum("precisionAtK") / count : 0,
    mrrAtK: count ? sum("mrrAtK") / count : 0,
    ndcgAtK: count ? sum("ndcgAtK") / count : 0
  };
}

function buildSelectionFunnel(reports: readonly LocomoCaseReport[]) {
  const goldFactCount = reports.reduce((sum, report) => sum + report.goldFacts.length, 0);
  const retrievedGoldFactCount = reports.reduce((sum, report) =>
    sum + report.diagnostics.filter((item) => item.candidateRanks.length > 0).length, 0);
  const selectedGoldFactCount = reports.reduce((sum, report) =>
    sum + report.diagnostics.filter((item) => item.selectionRanks.length > 0).length, 0);
  return {
    goldFactCount,
    retrievedGoldFactCount,
    selectedGoldFactCount,
    selectedFromRetrievedRate: retrievedGoldFactCount ? selectedGoldFactCount / retrievedGoldFactCount : 0,
    casesWithAnyRetrieved: reports.filter((report) => report.diagnostics.some((item) => item.candidateRanks.length > 0)).length,
    casesWithAnySelected: reports.filter((report) => report.diagnostics.some((item) => item.selectionRanks.length > 0)).length
  };
}

function emptyCaseReport(
  benchmarkCase: LocomoBenchmarkCase,
  candidateLimit = LOCOMO_DEFAULT_LIMIT,
  tokenBudget = longMemEvalAnswerContextTokenBudget
): LocomoCaseReport {
  return {
    caseId: benchmarkCase.caseId,
    sampleId: benchmarkCase.sampleId,
    qaIndex: benchmarkCase.qaIndex,
    ...(benchmarkCase.category === undefined ? {} : { category: benchmarkCase.category }),
    query: benchmarkCase.query,
    evidenceDiaIds: benchmarkCase.evidenceDiaIds,
    evaluable: false,
    ...(benchmarkCase.skipReason ? { skipReason: benchmarkCase.skipReason } : {}),
    goldFacts: benchmarkCase.goldFacts.map(toFactTarget),
    candidates: [],
    selection: {
      candidateLimit,
      evidenceLimit: longMemEvalAnswerEvidenceLimit,
      tokenBudget,
      usedTokens: 0,
      selectedCandidates: [],
      rejected: [],
      metrics: { all: [], stm: [], ltm: [] }
    },
    metrics: { all: [], stm: [], ltm: [] },
    diagnostics: []
  };
}

function deduplicateObservations(rows: Array<{ claim: string; evidenceDiaIds: string[] }>) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.claim.trim().toLowerCase()}|${row.evidenceDiaIds.slice().sort().join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectGoldObservations(
  qa: LocomoQa,
  evidenceDiaIds: readonly string[],
  facts: readonly LocomoGoldFact[]
) {
  const relevant = facts.filter((fact) =>
    fact.evidenceDiaIds.some((diaId) => evidenceDiaIds.includes(diaId))
  );
  const selected = new Set<(typeof relevant)[number]>();
  const labelText = `${qa.question} ${renderAnswerForGoldSelection(qa.answer)}`;
  for (const diaId of evidenceDiaIds) {
    const candidates = relevant.filter((fact) => fact.evidenceDiaIds.includes(diaId));
    if (candidates.length <= 1) {
      if (candidates[0]) selected.add(candidates[0]);
      continue;
    }
    const scored = candidates.map((fact) => ({
      fact,
      score: lexicalOverlap(fact.claim, labelText)
    }));
    const best = Math.max(...scored.map((item) => item.score));
    for (const item of scored) {
      if (best === 0 || item.score >= best - 0.05) selected.add(item.fact);
    }
  }
  return relevant.filter((fact) => selected.has(fact));
}

function renderAnswerForGoldSelection(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(renderAnswerForGoldSelection).join(" ");
  if (isRecord(value)) return Object.values(value).map(renderAnswerForGoldSelection).join(" ");
  return "";
}

function lexicalOverlap(left: string, right: string) {
  const leftTokens = new Set(labelTokens(left));
  const rightTokens = new Set(labelTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.sqrt(leftTokens.size * rightTokens.size);
}

function labelTokens(value: string) {
  const stopWords = new Set([
    "a", "an", "and", "are", "at", "be", "did", "do", "does", "for", "from", "had", "has", "have",
    "he", "her", "his", "how", "i", "in", "is", "it", "of", "on", "or", "she", "that", "the", "their",
    "they", "this", "to", "was", "were", "what", "when", "where", "which", "who", "why", "with", "would"
  ]);
  return (value.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]/gu) ?? [])
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function splitEvidenceRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(splitEvidenceRefs);
  if (typeof value !== "string") return [];
  return value.split(/[;,]/gu).map((item) => item.trim()).filter((item) => /^D\d+:\d+$/iu.test(item));
}

function parseLocomoDateTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/iu.exec(value.trim());
  if (!match) return undefined;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    .indexOf(match[5]!.toLowerCase());
  if (month < 0) return undefined;
  let hour = Number(match[1]);
  if (match[3]!.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[3]!.toLowerCase() === "am" && hour === 12) hour = 0;
  return new Date(Date.UTC(Number(match[6]), month, Number(match[4]), hour, Number(match[2]))).toISOString();
}

function normalizeKs(values: readonly number[], limit: number) {
  return [...new Set(values.map((value) => Math.min(limit, Math.floor(value))).filter((value) => value > 0))].sort((a, b) => a - b);
}

function emptyDiagnosticCounts(): Record<LocomoFactDiagnosticStatus, number> {
  return {
    retrieved: 0,
    not_in_top_k: 0,
    filtered_before_top_k: 0,
    memory_not_indexed: 0,
    fact_not_admitted: 0,
    fact_not_ingested: 0
  };
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueSourceRefs(values: readonly SourceRef[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.sourceRefId)) return false;
    seen.add(value.sourceRefId);
    return true;
  });
}


function locomoTurnItemId(diaId: string) {
  return `turn_${safeId(diaId)}`;
}

function safeId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/gu, "_");
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMetadataString(sourceRef: SourceRef | undefined, key: string) {
  const value = sourceRef?.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function countFallbacks(traces: ReadonlyArray<{ fallbackReason?: string }>) {
  const counts: Record<string, number> = {};
  for (const trace of traces) {
    if (!trace.fallbackReason) continue;
    counts[trace.fallbackReason] = (counts[trace.fallbackReason] ?? 0) + 1;
  }
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
