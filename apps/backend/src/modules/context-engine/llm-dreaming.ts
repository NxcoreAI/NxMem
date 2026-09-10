import { createHash } from "node:crypto";
import { getContextEngineConfig } from "../../config.js";
import { isLlmRequestRetryExhausted, postOpenAiCompatibleJson, postOpenAiCompatibleResponse } from "./llm-request.js";
import type {
  DreamingLtmOperation,
  DreamingStmEvaluation,
  LlmDreamingStmScore,
  LlmDreamingTrace,
  LongTermMemory,
  MemoryChangeEvent,
  MemoryTemporalMetadata,
  RelationEdge,
  ShortTermMemory,
  SourceRef,
  StructuredMemoryFacts
} from "./domain.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { reconcileMemoryGraphForLongTermMemory } from "./memory-graph.js";
import {
  inferLongTermMemoryType,
  isPrdMemoryType,
  prdMemoryTypes,
  summarizeStructuredFacts,
  theoryClassForMemoryType,
  type PrdMemoryType
} from "./memory-types.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import type { EmbeddingClient } from "./embedding.js";
import { mergeLongTermStructuredFacts } from "./structured-memory.js";
import { gateDreamingCandidates, type DreamingCandidateGateOptions, type DreamingCandidateGateResult } from "./dreaming-candidate-gate.js";
import { evaluateDreamingStms } from "./dreaming-stm-scoring.js";
import { createDreamingOperationEdge, decideDreamingLtmOperation } from "./dreaming-ltm-operations.js";
import {
  buildDreamingScoringPrompt,
  DREAMING_SCORING_PROMPT_VERSION
} from "./dreaming-score-prompt.js";

export interface LlmDreamingOptions extends LlmFactFusionOptions {
  memoryDataIds?: string[];
  tenantId?: string;
  principalId?: string;
  runId?: string;
  policyVersion?: string;
  now?: string;
  maxAttempts?: number;
  persistResults?: boolean;
  embeddingClient?: EmbeddingClient;
}

export interface LlmDreamingResult {
  trace: LlmDreamingTrace;
  longTermMemories: LongTermMemory[];
  updatedShortTermMemories: ShortTermMemory[];
  relationEdges: RelationEdge[];
  changeEvents: MemoryChangeEvent[];
  fallbackReason?: string;
  retryAfter?: string;
  candidateGate?: DreamingCandidateGateResult;
  stmEvaluations?: DreamingStmEvaluation[];
  ltmOperations?: DreamingLtmOperation[];
}

interface DreamingCandidate extends MemoryTemporalMetadata {
  memoryDataId: string;
  memoryDataType: string;
  memoryType?: string;
  content: string;
  summary?: string;
  importanceLevel: ShortTermMemory["importanceLevel"];
  confidenceLevel: ShortTermMemory["confidenceLevel"];
  lifecycleStatus: ShortTermMemory["lifecycleStatus"];
  matchedRules: string[];
  sourceFactIds: string[];
  structuredFacts?: StructuredMemoryFacts;
  sourceRefs: SourceRef[];
  entityIds: string[];
  admissionResult: ShortTermMemory["admissionResult"];
  admissionReason: string;
}

interface DreamingScoreItem {
  memoryDataId?: unknown;
  scores?: unknown;
  scoreReasons?: unknown;
}

interface DreamingPayload {
  scores?: DreamingScoreItem[];
}

interface LtmClassificationPayload {
  classifications?: Array<{
    memoryId?: unknown;
    memoryType?: unknown;
  }>;
}

const promptVersion = DREAMING_SCORING_PROMPT_VERSION;
const ltmSchemaVersion = "long-term-memory.v1";
const policyVersionDefault = "dreaming-stm-score.v2";

export async function runLlmDreaming(
  repository: ContextEngineRepository,
  options: LlmDreamingOptions = {}
): Promise<LlmDreamingResult> {
  const repositorySnapshot = repository.getDebugSnapshot();
  const snapshot = {
    ...repositorySnapshot,
    shortTermMemories: repositorySnapshot.shortTermMemories.map((memory) => ({ ...memory })),
    longTermMemories: repositorySnapshot.longTermMemories.map((memory) => ({ ...memory }))
  };
  const policyVersion = options.policyVersion ?? policyVersionDefault;
  const gateOptions: DreamingCandidateGateOptions = {
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.principalId ? { principalId: options.principalId } : {}),
    ...(options.memoryDataIds ? { memoryDataIds: options.memoryDataIds } : {}),
    policyVersion,
    ...(options.now ? { now: options.now } : {})
  };
  const candidateGate = await gateDreamingCandidates(repository, gateOptions);
  const candidates = selectDreamingCandidates(candidateGate.accepted, options.memoryDataIds);
  const sourceMemoryDataIds = candidates.map((candidate) => candidate.memoryDataId).sort();
  const traceKey = hashStable([
    options.runId ?? "standalone",
    policyVersion,
    ...sourceMemoryDataIds.map((memoryDataId) => {
      const memory = snapshot.shortTermMemories.find((item) => item.memoryDataId === memoryDataId);
      return options.runId ? memoryDataId : `${memoryDataId}:${memory?.updatedAt ?? "missing"}`;
    })
  ].join("|") || "empty");
  const config = getContextEngineConfig();
  const endpointBase = normalizeBaseUrl(options.baseUrl ?? config.llm.baseUrl);
  const endpoint = `${endpointBase}/chat/completions`;
  const model = options.model?.trim() || config.llm.model;
  const requestApiKey = options.apiKey === undefined ? undefined : options.apiKey.trim();
  const apiKey = options.apiKey === undefined ? config.llm.apiKey : requestApiKey;
  const keySource: LlmDreamingTrace["keySource"] = requestApiKey ? "request" : apiKey ? "env" : "missing";
  const prompt = buildDreamingScoringPrompt(candidates);

  let rawResponse: unknown;
  let stmScores: LlmDreamingStmScore[] = [];
  let stmEvaluations: DreamingStmEvaluation[] = [];
  let projectedMemories: LongTermMemory[] = [];
  let ltmOperations: DreamingLtmOperation[] = [];
  let rejectedCandidates: LlmDreamingTrace["rejectedCandidates"] = [];
  let fallbackReason: string | undefined;
  let retryAfter: string | undefined;

  if (!apiKey) {
    fallbackReason = "missing_api_key";
  } else if (!candidates.length) {
    fallbackReason = "no_dreaming_candidates";
  } else {
    try {
      rawResponse = await callOpenAiCompatibleChatCompletion({
        endpoint,
        apiKey,
      model,
      prompt,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.transport ? { transport: options.transport } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      });
      const converted = convertLlmStmScores(candidates, parseDreamingResponse(rawResponse));
      stmScores = converted.scores;
      rejectedCandidates = converted.rejectedCandidates;
      if (stmScores.length !== candidates.length) {
        fallbackReason = "llm_returned_incomplete_stm_scores";
      } else {
        stmEvaluations = evaluateDreamingStms(stmScores, snapshot.shortTermMemories, {
          ...(options.now ? { now: options.now } : {}),
          reuseSignals: repository.getMemoryReuseSignals(sourceMemoryDataIds, options.now)
        });
        const evaluationById = new Map(stmEvaluations.map((evaluation) => [evaluation.memoryDataId, evaluation]));
        projectedMemories = candidates.flatMap((candidate) => {
          const evaluation = evaluationById.get(candidate.memoryDataId);
          const source = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === candidate.memoryDataId);
          return evaluation?.decision === "consolidate" && source
            ? [projectShortTermMemoryToLongTerm(source, evaluation, policyVersion)]
            : [];
        });
        projectedMemories = await classifyLongTermMemories(projectedMemories, {
          endpoint,
          apiKey,
          model,
          ...(options.transport ? { transport: options.transport } : {}),
          ...(options.signal ? { signal: options.signal } : {})
        });
        const stmById = new Map(snapshot.shortTermMemories.map((memory) => [memory.memoryDataId, memory]));
        ltmOperations = projectedMemories.map((memory) => {
          const memoryDataId = memory.sourceMemoryDataIds[0]!;
          const source = stmById.get(memoryDataId)!;
          return decideDreamingLtmOperation({
            memoryDataId,
            memory,
            existingMemories: snapshot.longTermMemories.filter((existing) =>
              longTermMemoryBelongsToOwner(existing, source, stmById)
            )
          });
        });
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (isLlmRequestRetryExhausted(error)) throw error;
      rawResponse = serializeError(error);
      fallbackReason = error instanceof Error ? `llm_error:${error.message}` : "llm_error:unknown";
    }
  }

  if (fallbackReason) {
    stmEvaluations = [];
    projectedMemories = [];
    ltmOperations = [];
    const alreadyRejected = new Set(rejectedCandidates.map((item) => item.memoryDataId));
    rejectedCandidates = [
      ...rejectedCandidates,
      ...candidates.filter((candidate) => !alreadyRejected.has(candidate.memoryDataId)).map((candidate) => ({
        memoryDataId: candidate.memoryDataId,
        reason: `fallback:${fallbackReason}`
      }))
    ];
    if (fallbackReason !== "no_dreaming_candidates") {
      retryAfter = new Date(Date.now() + 30_000).toISOString();
    }
  }

  const trace: LlmDreamingTrace = {
    traceId: `llm_dreaming_${traceKey}`,
    sourceMemoryDataIds,
    provider: "openai-compatible",
    endpoint,
    model,
    keySource,
    promptVersion,
    schemaVersion: ltmSchemaVersion,
    prompt,
    candidateMemories: candidates.map(toTraceCandidate),
    ...(rawResponse === undefined ? {} : { rawResponse }),
    ...(stmEvaluations.length ? { stmEvaluations } : {}),
    ...(ltmOperations.length ? { ltmOperations } : {}),
    parsedMemories: projectedMemories,
    rejectedCandidates,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    createdAt: new Date().toISOString()
  };

  if (fallbackReason && options.fallbackMode === "throw") {
    await repository.saveLlmDreamingTrace(trace);
    throw new Error(`ltm_dreaming_fallback:${fallbackReason}`);
  }

  if (options.persistResults === false) {
    return {
      trace,
      longTermMemories: projectedMemories,
      updatedShortTermMemories: [],
      relationEdges: [],
      changeEvents: [],
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(retryAfter ? { retryAfter } : {}),
      candidateGate,
      ...(stmEvaluations.length ? { stmEvaluations } : {}),
      ...(ltmOperations.length ? { ltmOperations } : {})
    };
  }

  const task = createDreamingTask(trace.traceId, candidates);
  await repository.savePipelineTask({
    ...task,
    status: retryAfter ? "retry_scheduled" : "running",
    stage: retryAfter ? `dreaming_retry_scheduled:${fallbackReason}` : "dreaming_started",
    retryable: Boolean(retryAfter),
    ...(retryAfter ? { retryAfter } : {})
  });

  const relationEdges: RelationEdge[] = [];
  const changeEvents: MemoryChangeEvent[] = [];
  const updatedShortTermMemories: ShortTermMemory[] = [];
  const evaluationById = new Map(stmEvaluations.map((evaluation) => [evaluation.memoryDataId, evaluation]));

  for (const evaluation of stmEvaluations) {
    if (evaluation.decision !== "observe") continue;
    const source = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === evaluation.memoryDataId);
    if (!source) continue;
    const current = await repository.getShortTermMemory(source.memoryDataId) ?? source;
    const updated: ShortTermMemory = {
      ...current,
      consolidationStatus: "observing",
      lastEvaluatedAt: evaluation.evaluatedAt,
      ...(evaluation.nextEvaluateAt ? { nextEvaluateAt: evaluation.nextEvaluateAt } : {}),
      observeCount: (source.observeCount ?? 0) + 1,
      dreamingPolicyVersion: policyVersion,
      updatedAt: evaluation.evaluatedAt
    };
    delete updated.reevaluationReason;
    await repository.replaceShortTermMemory(updated);
    await refreshShortTermMemoryIndex(repository, updated, options.embeddingClient);
    updatedShortTermMemories.push(updated);
  }

  if (retryAfter) {
    const failedAt = new Date().toISOString();
    for (const candidate of candidates) {
      const source = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === candidate.memoryDataId);
      if (!source) continue;
      const updated: ShortTermMemory = {
        ...source,
        consolidationStatus: "retryable_failure",
        lastEvaluatedAt: failedAt,
        dreamingPolicyVersion: policyVersion,
        updatedAt: failedAt
      };
      await repository.replaceShortTermMemory(updated);
      await refreshShortTermMemoryIndex(repository, updated, options.embeddingClient);
      updatedShortTermMemories.push(updated);
    }
    await repository.saveLlmDreamingTrace(trace);
    await repository.savePipelineTask({
      ...task,
      status: "retry_scheduled",
      stage: `dreaming_retry_scheduled:${fallbackReason}`,
      retryable: true,
      retryAfter,
      updatedAt: failedAt
    });
    return {
      trace,
      longTermMemories: [],
      updatedShortTermMemories,
      relationEdges: [],
      changeEvents: [],
      ...(fallbackReason ? { fallbackReason } : {}),
      retryAfter,
      candidateGate,
      ...(stmEvaluations.length ? { stmEvaluations } : {})
    };
  }

  const persistedMemories: LongTermMemory[] = [];
  let committedOperationCount = 0;
  await repository.withDreamingTransaction(async () => {
    for (const memory of projectedMemories) {
      const memoryDataId = memory.sourceMemoryDataIds[0]!;
      const operation = ltmOperations.find((item) => item.memoryDataId === memoryDataId);
      const target = operation?.targetLtmId
        ? snapshot.longTermMemories.find((item) => item.memoryId === operation.targetLtmId)
        : undefined;
      const evaluation = evaluationById.get(memoryDataId);
      const source = snapshot.shortTermMemories.find((item) => item.memoryDataId === memoryDataId)!;
      const consolidationKey = createDreamingConsolidationKey(source, policyVersion);
      const alreadyCommitted = snapshot.longTermMemories.find((item) =>
        item.consolidationKey === consolidationKey
      );
      if (alreadyCommitted) {
        persistedMemories.push(alreadyCommitted);
        continue;
      }

      const maintainedAt = new Date().toISOString();
      const operationMemory: LongTermMemory = {
        ...memory,
        consolidationKey,
        version: operation?.operation === "revise"
          ? (target?.version ?? 1) + 1
          : 1,
        ...(operation?.operation === "revise" && target ? { previousVersionId: target.memoryId } : {}),
        ...(evaluation ? { consolidationScore: evaluation.totalScore, consolidationFactors: evaluation.factorScores } : {}),
        policyVersion,
        promptVersion,
        model,
        createdAt: memory.createdAt ?? maintainedAt,
        updatedAt: maintainedAt,
        lastMaintainedAt: maintainedAt
      };

      await repository.replaceLongTermMemory(operationMemory);
      await enqueueDreamingIndexRefresh(repository, operationMemory);
      persistedMemories.push(operationMemory);
      const changeEvent = createChangeEvent({
        memoryId: operationMemory.memoryId,
        memoryDataId,
        changeType: operation?.operation === "revise"
          ? "revised"
          : operation?.operation === "conflict" ? "relation_changed" : "created",
        storageLayer: "ltm",
        reason: operationMemory.solidifyReason
      });
      await repository.saveMemoryChangeEvent(changeEvent);
      changeEvents.push(changeEvent);
      relationEdges.push(...await reconcileMemoryGraphForLongTermMemory(repository, operationMemory.memoryId));
      if (operation?.operation === "revise" && target && target.lifecycleStatus !== "revised") {
        const revisedTarget: LongTermMemory = {
          ...target,
          lifecycleStatus: "revised",
          updatedAt: maintainedAt,
          lastMaintainedAt: maintainedAt
        };
        await repository.replaceLongTermMemory(revisedTarget);
        await enqueueDreamingIndexRefresh(repository, revisedTarget);
      }
      const operationEdge = operation ? createDreamingOperationEdge(operation) : undefined;
      if (operationEdge) {
        await repository.saveRelationEdge(operationEdge);
        relationEdges.push(operationEdge);
      }

      committedOperationCount += 1;
      await repository.savePipelineTask({
        ...task,
        status: "running",
        stage: `dreaming_operation_committed:${operation?.operation ?? "create"}`,
        checkpoint: consolidationKey,
        stats: { committedOperations: committedOperationCount },
        updatedAt: maintainedAt
      });
    }

    for (const evaluation of stmEvaluations) {
      if (evaluation.decision === "observe") continue;
      const source = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === evaluation.memoryDataId);
      if (!source) continue;
      const current = await repository.getShortTermMemory(source.memoryDataId) ?? source;
      const updated: ShortTermMemory = {
        ...current,
        consolidationStatus: evaluation.decision === "consolidate" ? "consolidated" : "dropped",
        lastEvaluatedAt: evaluation.evaluatedAt,
        dreamingPolicyVersion: policyVersion,
        updatedAt: evaluation.evaluatedAt
      };
      delete updated.nextEvaluateAt;
      delete updated.reevaluationTier;
      delete updated.reevaluationReason;
      await repository.replaceShortTermMemory(updated);
      const changeEvent = createChangeEvent({
        memoryDataId: source.memoryDataId,
        changeType: evaluation.decision === "consolidate" ? "deleted" : "updated",
        storageLayer: "stm",
        reason: evaluation.decision === "consolidate"
          ? "dreaming_consolidated_to_ltm"
          : "dreaming_ltm_skipped_stm_retained"
      });
      await repository.saveMemoryChangeEvent(changeEvent);
      changeEvents.push(changeEvent);
      if (evaluation.decision === "consolidate") {
        await repository.deleteShortTermMemoryArtifacts(source.memoryDataId);
        await repository.deleteShortTermMemory(source.memoryDataId);
      } else {
        updatedShortTermMemories.push(updated);
      }
    }

    await repository.saveLlmDreamingTrace(trace);
    await repository.savePipelineTask({
      ...task,
      status: "succeeded",
      stage: "dreaming_completed",
      retryable: false,
      checkpoint: "completed",
      stats: { committedOperations: committedOperationCount },
      updatedAt: new Date().toISOString()
    });
  });

  await processDreamingOutbox(repository, new Date().toISOString(), options.embeddingClient);

  return {
    trace,
    longTermMemories: persistedMemories,
    updatedShortTermMemories,
    relationEdges,
    changeEvents,
    ...(fallbackReason ? { fallbackReason } : {}),
    candidateGate,
    ...(stmEvaluations.length ? { stmEvaluations } : {}),
    ...(ltmOperations.length ? { ltmOperations } : {})
  };
}

export function projectShortTermMemoryToLongTerm(
  source: ShortTermMemory,
  evaluation: DreamingStmEvaluation,
  policyVersion: string
): LongTermMemory {
  const memoryType = inferLongTermMemoryType([source]);
  const structuredFacts = mergeLongTermStructuredFacts([source]);
  return {
    memoryId: `ltm_dream_${hashStable(`${source.memoryDataId}:${source.updatedAt}:${source.content}:${source.sourceFactIds.slice().sort().join(",")}`)}`,
    tenantId: source.tenantId,
    principalId: source.principalId,
    theoryClass: theoryClassForMemoryType(memoryType),
    memoryType,
    content: source.content,
    structuredFacts,
    ...(source.factSummary ? { factSummary: source.factSummary } : { factSummary: summarizeStructuredFacts({ structuredFacts, content: source.content }) }),
    ...(source.summary ? { summary: source.summary } : {}),
    ...(source.evidenceTimeStart ? { evidenceTimeStart: source.evidenceTimeStart } : {}),
    ...(source.evidenceTimeEnd ? { evidenceTimeEnd: source.evidenceTimeEnd } : {}),
    evidenceTimeConfidence: source.evidenceTimeConfidence ?? "low",
    ...(source.validTimeStart ? { validTimeStart: source.validTimeStart } : {}),
    ...(source.validTimeEnd ? { validTimeEnd: source.validTimeEnd } : {}),
    validTimeConfidence: source.validTimeConfidence ?? "low",
    sourceRefs: source.sourceRefs,
    sourceMemoryDataIds: [source.memoryDataId],
    sourceFactIds: source.sourceFactIds,
    entityIds: source.entityIds,
    confidenceLevel: source.confidenceLevel,
    recallWeight: recallWeightFromStm(source),
    ...(source.retrievalWeight === undefined ? {} : { retrievalWeight: source.retrievalWeight }),
    ...(source.userRetrievalWeight === undefined ? {} : { userRetrievalWeight: source.userRetrievalWeight }),
    solidifyReason: `stm_seven_factor_score:${evaluation.totalScore}`,
    matchedRules: uniqueStrings(["dreaming_stm_scored", ...source.matchedRules]),
    accessState: "visible",
    lifecycleStatus: "active",
    consolidationScore: evaluation.totalScore,
    consolidationFactors: evaluation.factorScores,
    policyVersion
  };
}

function convertLlmStmScores(candidates: DreamingCandidate[], payload: DreamingPayload) {
  const scores: LlmDreamingStmScore[] = [];
  const rejectedCandidates: LlmDreamingTrace["rejectedCandidates"] = [];
  const candidateIds = new Set(candidates.map((candidate) => candidate.memoryDataId));
  const seen = new Set<string>();
  if (!Array.isArray(payload.scores)) {
    return {
      scores,
      rejectedCandidates: candidates.map((candidate) => ({
        memoryDataId: candidate.memoryDataId,
        reason: "scores_array_required"
      }))
    };
  }

  for (const item of payload.scores) {
    const memoryDataId = typeof item.memoryDataId === "string" ? item.memoryDataId.trim() : "";
    if (!candidateIds.has(memoryDataId) || seen.has(memoryDataId)) {
      if (memoryDataId) rejectedCandidates.push({ memoryDataId, reason: seen.has(memoryDataId) ? "duplicate_stm_score" : "score_outside_candidates" });
      continue;
    }
    const semanticScores = parseCompleteScoreFactors(item.scores);
    if (!semanticScores) {
      rejectedCandidates.push({ memoryDataId, reason: "seven_factor_scores_required" });
      continue;
    }
    const scoreReasons = parseScoreReasons(item.scoreReasons);
    if (!scoreReasons) {
      rejectedCandidates.push({ memoryDataId, reason: "seven_factor_score_reasons_required" });
      continue;
    }
    seen.add(memoryDataId);
    scores.push({
      memoryDataId,
      semanticScores,
      scoreReasons
    });
  }

  for (const candidate of candidates) {
    if (!seen.has(candidate.memoryDataId) && !rejectedCandidates.some((item) => item.memoryDataId === candidate.memoryDataId)) {
      rejectedCandidates.push({ memoryDataId: candidate.memoryDataId, reason: "stm_score_missing" });
    }
  }
  return { scores, rejectedCandidates };
}

async function classifyLongTermMemories(
  memories: LongTermMemory[],
  input: {
    endpoint: string;
    apiKey: string;
    model: string;
    transport?: "fetch" | "openai-sdk-stream";
    signal?: AbortSignal;
  }
): Promise<LongTermMemory[]> {
  if (!memories.length) return memories;

  try {
    const rawResponse = await callOpenAiCompatibleChatCompletion({
      ...input,
      operation: "dreaming_ltm_classification",
      maxAttempts: 1,
      systemPrompt: "你是严格 JSON 输出的长期记忆分类服务。不要输出推理过程。",
      prompt: buildLtmClassificationPrompt(memories)
    });
    const classifications = parseLtmClassifications(rawResponse, memories);
    return memories.map((memory) => {
      const memoryType = classifications.get(memory.memoryId);
      if (!memoryType) return withClassificationFallback(memory);
      return {
        ...memory,
        memoryType,
        theoryClass: theoryClassForMemoryType(memoryType),
        matchedRules: uniqueStrings([...memory.matchedRules, "llm_ltm_classification"])
      };
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return memories.map(withClassificationFallback);
  }
}

function buildLtmClassificationPrompt(memories: LongTermMemory[]) {
  return JSON.stringify({
    instruction: "根据每条长期记忆的内容选择一个最匹配的工程类型。只返回严格 JSON。",
    memoryTypes: prdMemoryTypes,
    outputSchema: {
      classifications: [{ memoryId: "ltm_id", memoryType: "memoryTypes 中的一项" }]
    },
    constraints: [
      "classifications 必须为每条 memories 输入恰好返回一项，并使用原 memoryId。",
      "memoryType 必须来自 memoryTypes。",
      "不得改写记忆内容，不得返回 theoryClass。"
    ],
    memories: memories.map((memory) => ({ memoryId: memory.memoryId, content: memory.content }))
  }, null, 2);
}

function parseLtmClassifications(rawResponse: unknown, memories: LongTermMemory[]) {
  const messageContent = extractMessageContent(rawResponse);
  const payload = typeof messageContent === "string" ? JSON.parse(messageContent) : messageContent;
  const items = (payload as LtmClassificationPayload | undefined)?.classifications;
  if (!Array.isArray(items)) throw new Error("ltm_classifications_array_required");

  const allowedIds = new Set(memories.map((memory) => memory.memoryId));
  const classifications = new Map<string, PrdMemoryType>();
  for (const item of items) {
    const memoryId = typeof item.memoryId === "string" ? item.memoryId.trim() : "";
    const memoryType = typeof item.memoryType === "string" ? item.memoryType.trim() : "";
    if (!allowedIds.has(memoryId) || classifications.has(memoryId) || !isPrdMemoryType(memoryType)) continue;
    classifications.set(memoryId, memoryType);
  }
  return classifications;
}

function withClassificationFallback(memory: LongTermMemory): LongTermMemory {
  const memoryType = isPrdMemoryType(memory.memoryType) ? memory.memoryType : "fact";
  return {
    ...memory,
    memoryType,
    theoryClass: theoryClassForMemoryType(memoryType),
    matchedRules: uniqueStrings([...memory.matchedRules, "ltm_classification_fallback"])
  };
}

function parseDreamingResponse(rawResponse: unknown): DreamingPayload {
  if (!rawResponse || typeof rawResponse !== "object") throw new Error("invalid_response_object");
  const messageContent = extractMessageContent(rawResponse);
  const payload = typeof messageContent === "string" ? JSON.parse(messageContent) : messageContent;
  if (!payload || typeof payload !== "object") throw new Error("invalid_payload_object");
  return payload as DreamingPayload;
}

function parseCompleteScoreFactors(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const keys = ["stability", "reuseValue", "identityRelationValue", "actionCommitmentValue", "informationEntropy", "explicitWeight", "preferenceConsistency"] as const;
  const result: Record<string, number> = {};
  for (const key of keys) {
    const score = (value as Record<string, unknown>)[key];
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10) return undefined;
    result[key] = score;
  }
  if (result.reuseValue !== 0) return undefined;
  return result as LlmDreamingStmScore["semanticScores"];
}

function parseScoreReasons(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, string> = {};
  for (const key of ["stability", "reuseValue", "identityRelationValue", "actionCommitmentValue", "informationEntropy", "explicitWeight", "preferenceConsistency"]) {
    const reason = (value as Record<string, unknown>)[key];
    if (typeof reason !== "string" || !/^evidence=.+; rationale=.+$/u.test(reason.trim())) return undefined;
    result[key] = reason.trim();
  }
  if (result.reuseValue !== "evidence=server_owned; rationale=placeholder_only") return undefined;
  return result as LlmDreamingStmScore["scoreReasons"];
}

function toTraceCandidate(candidate: DreamingCandidate): LlmDreamingTrace["candidateMemories"][number] {
  return {
    memoryDataId: candidate.memoryDataId,
    memoryDataType: candidate.memoryDataType,
    ...(candidate.memoryType ? { memoryType: candidate.memoryType } : {}),
    content: candidate.content,
    ...(candidate.summary ? { summary: candidate.summary } : {}),
    importanceLevel: candidate.importanceLevel,
    confidenceLevel: candidate.confidenceLevel,
    lifecycleStatus: candidate.lifecycleStatus,
    matchedRules: candidate.matchedRules,
    sourceFactIds: candidate.sourceFactIds,
    entityIds: candidate.entityIds,
    ...(candidate.structuredFacts ? { structuredFacts: candidate.structuredFacts } : {}),
    ...(candidate.evidenceTimeStart ? { evidenceTimeStart: candidate.evidenceTimeStart } : {}),
    ...(candidate.evidenceTimeEnd ? { evidenceTimeEnd: candidate.evidenceTimeEnd } : {}),
    evidenceTimeConfidence: candidate.evidenceTimeConfidence ?? "low",
    ...(candidate.validTimeStart ? { validTimeStart: candidate.validTimeStart } : {}),
    ...(candidate.validTimeEnd ? { validTimeEnd: candidate.validTimeEnd } : {}),
    validTimeConfidence: candidate.validTimeConfidence ?? "low"
  };
}

export function selectDreamingCandidates(memories: ShortTermMemory[], memoryDataIds?: string[]): DreamingCandidate[] {
  const requested = new Set(memoryDataIds ?? []);
  return memories
    .filter((memory) => requested.size ? requested.has(memory.memoryDataId) : (
      memory.lifecycleStatus === "active" && (
        memory.importanceLevel === "high" ||
        memory.importanceLevel === "critical" ||
        memory.admissionResult === "write_high_priority" ||
        memory.matchedRules.some((rule) => rule.includes("feedback") || rule.includes("duplicate"))
      )
    ))
    .filter((memory) => memory.lifecycleStatus === "active" || memory.lifecycleStatus === "expired" || memory.lifecycleStatus === "candidate_queue")
    .sort((a, b) => a.memoryDataId.localeCompare(b.memoryDataId))
    .map((memory) => ({
      memoryDataId: memory.memoryDataId,
      memoryDataType: memory.memoryDataType,
      ...(memory.memoryType ? { memoryType: memory.memoryType } : {}),
      content: memory.content,
      ...(memory.summary ? { summary: memory.summary } : {}),
      importanceLevel: memory.importanceLevel,
      confidenceLevel: memory.confidenceLevel,
      lifecycleStatus: memory.lifecycleStatus,
      matchedRules: memory.matchedRules,
      sourceFactIds: memory.sourceFactIds,
      ...(memory.structuredFacts ? { structuredFacts: memory.structuredFacts } : {}),
      sourceRefs: memory.sourceRefs,
      entityIds: memory.entityIds,
      admissionResult: memory.admissionResult,
      admissionReason: memory.admissionReason,
      ...(memory.evidenceTimeStart ? { evidenceTimeStart: memory.evidenceTimeStart } : {}),
      ...(memory.evidenceTimeEnd ? { evidenceTimeEnd: memory.evidenceTimeEnd } : {}),
      evidenceTimeConfidence: memory.evidenceTimeConfidence ?? "low",
      ...(memory.validTimeStart ? { validTimeStart: memory.validTimeStart } : {}),
      ...(memory.validTimeEnd ? { validTimeEnd: memory.validTimeEnd } : {}),
      validTimeConfidence: memory.validTimeConfidence ?? "low"
    }));
}

export async function enqueueDreamingIndexRefresh(repository: ContextEngineRepository, memory: LongTermMemory) {
  const now = new Date().toISOString();
  await repository.saveDreamingOutbox({
    outboxId: `dream_outbox_ltm_${memory.memoryId}`,
    operation: "refresh_ltm_index",
    ownerId: memory.memoryId,
    payload: { memory },
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now
  });
}

export async function enqueueDreamingStmIndexRefresh(repository: ContextEngineRepository, memory: ShortTermMemory) {
  const now = new Date().toISOString();
  await repository.saveDreamingOutbox({
    outboxId: `dream_outbox_stm_${memory.memoryDataId}`,
    operation: "refresh_stm_index",
    ownerId: memory.memoryDataId,
    payload: { memory },
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now
  });
}

export async function processDreamingOutbox(
  repository: ContextEngineRepository,
  now = new Date().toISOString(),
  embeddingClient?: EmbeddingClient
) {
  const records = repository.listPendingDreamingOutbox(now);
  for (const record of records) {
    try {
      await repository.markDreamingOutbox({ ...record, status: "processing", attempts: record.attempts + 1, updatedAt: new Date().toISOString() });
      if (record.operation === "refresh_ltm_index") {
        const memory = record.payload?.memory as LongTermMemory | undefined;
        if (!memory) throw new Error("dreaming_outbox_ltm_payload_missing");
        await refreshLongTermMemoryIndex(repository, memory, embeddingClient);
      } else if (record.operation === "refresh_stm_index") {
        const memory = record.payload?.memory as ShortTermMemory | undefined;
        if (!memory) throw new Error("dreaming_outbox_stm_payload_missing");
        await refreshShortTermMemoryIndex(repository, memory, embeddingClient);
      }
      const { lastError: _lastError, nextAttemptAt: _nextAttemptAt, ...succeeded } = record;
      await repository.markDreamingOutbox({ ...succeeded, status: "succeeded", attempts: record.attempts + 1, updatedAt: new Date().toISOString() });
    } catch (error) {
      const attempts = record.attempts + 1;
      await repository.markDreamingOutbox({
        ...record,
        status: "failed",
        attempts,
        nextAttemptAt: new Date(Date.now() + Math.min(60_000, attempts * 1_000)).toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      });
    }
  }
  return records.length;
}

export function createDreamingConsolidationKey(
  memory: ShortTermMemory,
  policyVersion: string,
  stmVersion = memory.updatedAt
) {
  return `consolidation_${hashStable([
    policyVersion,
    memory.memoryDataId,
    stmVersion,
    memory.content,
    memory.sourceFactIds.slice().sort().join(",")
  ].join("|"))}`;
}

function recallWeightFromStm(memory: ShortTermMemory): LongTermMemory["recallWeight"] {
  if (memory.importanceLevel === "critical" || memory.importanceLevel === "high") return "high";
  if (memory.importanceLevel === "medium") return "medium";
  return "low";
}

function longTermMemoryBelongsToOwner(
  memory: LongTermMemory,
  source: ShortTermMemory,
  stmById: Map<string, ShortTermMemory>
) {
  if (memory.tenantId && memory.principalId) {
    return memory.tenantId === source.tenantId && memory.principalId === source.principalId;
  }
  return memory.sourceMemoryDataIds.length > 0 && memory.sourceMemoryDataIds.every((id) => {
    const existingSource = stmById.get(id);
    return existingSource?.tenantId === source.tenantId && existingSource.principalId === source.principalId;
  });
}

async function callOpenAiCompatibleChatCompletion(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  prompt: string;
  operation?: string;
  maxAttempts?: number;
  systemPrompt?: string;
  transport?: "fetch" | "openai-sdk-stream";
  signal?: AbortSignal;
}) {
  const request = {
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    operation: input.operation ?? "dreaming",
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    body: {
      model: input.model,
      messages: [
        { role: "system", content: input.systemPrompt ?? "你是严格 JSON 输出的 STM 长期价值评分服务。不要输出推理过程。" },
        { role: "user", content: input.prompt }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    },
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  } as const;
  if (input.transport === "openai-sdk-stream") return await postOpenAiCompatibleJson(request);
  const response = await postOpenAiCompatibleResponse(request);
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  if (!response.ok) throw new Error(`http_${response.status}:${truncate(text, 240)}`);
  return parsed;
}

function extractMessageContent(rawResponse: unknown): unknown {
  if (!rawResponse || typeof rawResponse !== "object") return rawResponse;
  const choices = (rawResponse as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return rawResponse;
  return (choices[0] as { message?: { content?: unknown } }).message?.content ?? rawResponse;
}

function uniqueStrings(values: string[]) { return [...new Set(values)]; }
function normalizeContent(value: string) { return value.toLocaleLowerCase().replace(/[\s，。！？；：:,.!?]+/gu, "").trim(); }
function hashStable(value: string) { return createHash("sha1").update(value).digest("hex").slice(0, 16); }
function normalizeBaseUrl(value: string) { return value.replace(/\/+$/, ""); }
function truncate(value: string, maxLength: number) { return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`; }
function serializeError(error: unknown) { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }

function createChangeEvent(input: Omit<MemoryChangeEvent, "eventId" | "createdAt">): MemoryChangeEvent {
  return {
    ...input,
    eventId: `mce_dreaming_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString()
  };
}

function createDreamingTask(traceId: string, candidates: DreamingCandidate[]) {
  const now = new Date().toISOString();
  return {
    taskId: `task_${traceId}`,
    eventId: candidates[0]?.sourceFactIds[0] ?? traceId,
    taskType: "dreaming" as const,
    status: "pending" as const,
    attempt: 1,
    maxAttempts: 3,
    retryable: true,
    stage: "created",
    createdAt: now,
    updatedAt: now
  };
}
