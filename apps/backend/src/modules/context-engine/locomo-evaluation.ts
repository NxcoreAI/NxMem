import { createHash } from "node:crypto";
import type { MemoryEvent, SourceRef } from "./domain.js";
import type { EmbeddingClient } from "./embedding.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { postOpenAiCompatibleJson, rateLimitRetryDelayMs, isRateLimitLlmError } from "./llm-request.js";
import type { ContextPack } from "./assemble-context.js";
import {
  BENCHMARK_ANSWER_CANDIDATE_LIMIT,
  BENCHMARK_ANSWER_EVIDENCE_LIMIT,
  BENCHMARK_ANSWER_TOKEN_BUDGET,
  buildBenchmarkAnswerContext
} from "./benchmark-answer-context.js";
import type { CrossEncoderReranker } from "./cross-encoder-reranker.js";
import { parseAndAdmitEvent } from "./parse-event.js";
import { createPipelineTask, formatPipelineError, updatePipelineTask } from "./pipeline-task.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import type { ContextSearchResult } from "./search-context.js";
import type {
  LocomoEvaluationConversation,
  LocomoEvaluationQuestion,
  LocomoEvaluationSession
} from "./locomo-dataset.js";
import { scoreLocomoQuestion, type LocomoQuestionScore } from "./locomo-official-scorer.js";
import { judgeLocomoAnswer, type LocomoJudgeOutcome } from "./locomo-llm-judge.js";

export const LOCOMO_EVALUATION_PROFILE = "locomo-fact-stm-v1";

export interface LocomoPrepareOptions {
  llm?: LlmFactFusionOptions;
  embeddingClient?: EmbeddingClient;
  disableIngestLlm?: boolean;
  maxSessionAttempts?: number;
  sessionIngest?: (
    repository: ContextEngineRepository,
    event: MemoryEvent,
    options: Omit<LocomoPrepareOptions, "sessionIngest">
  ) => Promise<void>;
}

export interface LocomoPreparationResult {
  conversationId: string;
  contextScopeId: string;
  status: "prepared" | "failed";
  sessionsPrepared: number;
  facts: number;
  shortTermMemories: number;
  error?: string;
}

export interface LocomoAnswerModel {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface LocomoQuestionResult {
  status: "succeeded";
  conversationId: string;
  questionId: string;
  questionIndex: number;
  category: LocomoEvaluationQuestion["category"];
  referenceAnswer: string;
  hypothesis: string;
  official: LocomoQuestionScore;
  judge: LocomoJudgeOutcome;
  candidates: ContextSearchResult[];
  selectedItems: ReturnType<typeof selectedPackItems>;
  dropped: ContextPack["dropped"];
  serializedPrompt: string;
  serializedPromptHash: string;
  answerPrompt: string;
  answerPromptHash: string;
  tokenUsage: ContextPack["tokenBudget"];
  citations: ContextPack["citations"];
  conflicts: ContextPack["conflicts"];
  evidenceSelection: {
    selected: Array<{ itemId: string; reason: string; evidenceRole: string }>;
    rejected: Array<{ itemId: string; layer?: ContextSearchResult["layer"]; reason: string; contentChars: number }>;
  };
  evidence: LocomoEvidenceMetrics;
  fallbackUsed: false;
  elapsedMs: number;
  profile: typeof LOCOMO_EVALUATION_PROFILE;
}

export interface LocomoEvidenceMetrics {
  evaluable: boolean;
  goldCount: number;
  factMatchedDiaIds: string[];
  stmMatchedDiaIds: string[];
  retrievalMatchedDiaIds: string[];
  packMatchedDiaIds: string[];
  retrievalRanks?: Record<string, number>;
  packRanks?: Record<string, number>;
  retrievalRecall?: number;
  packRecall?: number;
  factExtractionRecall?: number;
  stmAdmissionRecall?: number;
  evidenceRetention?: number;
  retrievalAny?: boolean;
  retrievalAll?: boolean;
  packAny?: boolean;
  packAll?: boolean;
}

export function buildLocomoSessionEvent(
  conversation: LocomoEvaluationConversation,
  session: LocomoEvaluationSession
): MemoryEvent {
  const eventId = `locomo_native_${safeId(conversation.conversationId)}_${safeId(session.sessionId)}`;
  const refs = session.turns.map((turn) => sourceRef(conversation, session, turn.diaId, turn.speaker));
  return {
    eventId,
    contextScopeId: conversation.contextScopeId,
    eventType: "locomo_conversation_session",
    eventSummary: `LoCoMo conversation ${conversation.conversationId} ${session.sessionId}`,
    eventTime: session.eventTime,
    sourceApp: "locomo-native-evaluation",
    sourceId: `${conversation.conversationId}:${session.sessionId}`,
    permissionSnapshot: {
      snapshotId: `ps_${eventId}`,
      tenantId: conversation.tenantId,
      principalId: conversation.principalId,
      sourceAclVersion: LOCOMO_EVALUATION_PROFILE,
      visibility: "private"
    },
    multimodalData: session.turns.map((turn) => {
      const ref = sourceRef(conversation, session, turn.diaId, turn.speaker);
      const text = [
        `${turn.speaker}: ${turn.text}`,
        ...(turn.caption ? [`Image description: ${turn.caption}`] : [])
      ].join("\n");
      return {
        itemId: `turn_${safeId(turn.diaId)}`,
        type: "text" as const,
        format: "json",
        content: {
          text,
          conversationId: conversation.conversationId,
          sessionId: session.sessionId,
          diaId: turn.diaId,
          speaker: turn.speaker,
          ...(turn.caption ? { imageCaption: turn.caption } : {}),
          ...(turn.imageUrls ? { imageUrls: turn.imageUrls } : {})
        },
        ref: turn.diaId,
        sourceRefs: [ref],
        timeBasis: "source_time" as const,
        timeConfidence: "high" as const
      };
    }),
    sourceRefs: refs
  };
}

export async function prepareLocomoConversation(
  repository: ContextEngineRepository,
  conversation: LocomoEvaluationConversation,
  options: LocomoPrepareOptions = {}
): Promise<LocomoPreparationResult> {
  const maxAttempts = Math.max(1, options.maxSessionAttempts ?? 5);
  let sessionsPrepared = 0;
  try {
    assertScopeEmptyOrComplete(repository, conversation);
    for (const session of conversation.sessions) {
      const event = buildLocomoSessionEvent(conversation, session);
      const snapshot = repository.getDebugSnapshot();
      // 一个事件对应一个 task（taskId = ingest_<eventId>），taskType 会被管线一路改写（最终 "index"），按 eventId 查找
      const sessionTask = snapshot.pipelineTasks.find((task) => task.eventId === event.eventId);
      // 幂等跳过：只有事件已保存且 ingest 管线成功完成才算已 prepare。
      // 事件存在但 task 非终态 succeeded（如 LLM 抖动中断留下的 running/failed）时必须重跑 ingest：
      // 事件 / segments / facts / STM 全部使用确定性 ID + upsert，重跑幂等，可恢复部分失败。
      if (snapshot.memoryEvents.some((item) => item.eventId === event.eventId) && sessionTask?.status === "succeeded") {
        sessionsPrepared += 1;
        continue;
      }
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          if (options.sessionIngest) {
            const { sessionIngest: _sessionIngest, ...ingestOptions } = options;
            await options.sessionIngest(repository, event, ingestOptions);
          } else {
            await ingestLocomoSession(repository, event, options);
          }
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < maxAttempts && isRateLimitLlmError(error)) {
            await sleep(rateLimitRetryDelayMs(attempt, error));
          }
        }
      }
      if (lastError) throw lastError;
      sessionsPrepared += 1;
    }
    assertConversationPrepared(repository, conversation);
    const snapshot = repository.getDebugSnapshot();
    return {
      conversationId: conversation.conversationId,
      contextScopeId: conversation.contextScopeId,
      status: "prepared",
      sessionsPrepared,
      facts: snapshot.facts.filter((item) => item.contextScopeId === conversation.contextScopeId).length,
      shortTermMemories: memoriesInScope(snapshot, conversation.contextScopeId).shortTerm.length
    };
  } catch (error) {
    return {
      conversationId: conversation.conversationId,
      contextScopeId: conversation.contextScopeId,
      status: "failed",
      sessionsPrepared,
      facts: 0,
      shortTermMemories: 0,
      error: formatError(error)
    };
  }
}

export async function evaluateLocomoQuestion(
  repository: ContextEngineRepository,
  conversation: LocomoEvaluationConversation,
  question: LocomoEvaluationQuestion,
  options: {
    embeddingClient?: EmbeddingClient;
    answerModel?: LocomoAnswerModel;
    generateAnswer?: (prompt: string) => Promise<string>;
    judgeModel?: LocomoAnswerModel;
    generateJudge?: (prompt: string) => Promise<string>;
    candidateLimit?: number;
    evidenceLimit?: number;
    tokenBudget?: number;
    memoryReranker?: CrossEncoderReranker | false;
    factReranker?: CrossEncoderReranker | false;
  }
): Promise<LocomoQuestionResult> {
  const startedAt = Date.now();
  assertConversationPrepared(repository, conversation);
  const answerContext = await buildBenchmarkAnswerContext(repository, {
    questionId: question.questionId,
    question: question.question,
    questionType: "multi-session",
    tenantId: conversation.tenantId,
    principalId: conversation.principalId,
    contextScopeId: conversation.contextScopeId,
    ...(question.referenceTime ? { referenceTime: question.referenceTime } : {}),
    modelRunId: "locomo",
    storeNamespace: LOCOMO_EVALUATION_PROFILE,
    allowedLayers: ["stm"],
    candidateLimit: options.candidateLimit ?? BENCHMARK_ANSWER_CANDIDATE_LIMIT,
    evidenceLimit: options.evidenceLimit ?? BENCHMARK_ANSWER_EVIDENCE_LIMIT,
    tokenBudget: options.tokenBudget ?? BENCHMARK_ANSWER_TOKEN_BUDGET,
    includeInactive: true,
    factRetrieval: false,
    ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
    ...(options.memoryReranker !== undefined ? { memoryReranker: options.memoryReranker } : {}),
    ...(options.factReranker !== undefined ? { factReranker: options.factReranker } : {})
  });
  const pack = answerContext.pack;
  const searchResults = answerContext.candidates;
  assertAllowedLayers(searchResults, "retrieval candidates");
  const selectedItems = selectedPackItems(pack);
  assertAllowedLayers(selectedItems, "Context Pack");
  const prompt = buildLocomoAnswerPrompt({
    question: question.question,
    questionDate: question.referenceTime,
    serializedPrompt: pack.serializedPrompt
  });
  const hypothesis = options.generateAnswer
    ? await options.generateAnswer(prompt)
    : await generateLocomoAnswer(prompt, requiredAnswerModel(options.answerModel));
  const official = scoreLocomoQuestion({ category: question.category, referenceAnswer: question.referenceAnswer, hypothesis });
  const judgeModel = options.judgeModel ?? options.answerModel;
  const judge = await judgeLocomoAnswer({
    category: question.category,
    question: question.question,
    referenceAnswer: question.referenceAnswer,
    response: hypothesis,
    ...(options.generateJudge ? { generateJudge: options.generateJudge } : judgeModel ? { model: judgeModel } : {})
  });
  const snapshot = repository.getDebugSnapshot();
  const scopedFacts = snapshot.facts.filter((fact) => fact.contextScopeId === conversation.contextScopeId);
  const scopedFactIds = new Set(scopedFacts.map((fact) => fact.factId));
  const stmFactIds = new Set(snapshot.shortTermMemories
    .filter((memory) => memory.sourceFactIds.some((factId) => scopedFactIds.has(factId)))
    .flatMap((memory) => memory.sourceFactIds));
  return {
    status: "succeeded",
    conversationId: conversation.conversationId,
    questionId: question.questionId,
    questionIndex: question.questionIndex,
    category: question.category,
    referenceAnswer: question.referenceAnswer,
    hypothesis,
    official,
    judge,
    candidates: searchResults,
    selectedItems,
    dropped: pack.dropped,
    serializedPrompt: pack.serializedPrompt,
    serializedPromptHash: createHash("sha256").update(pack.serializedPrompt).digest("hex"),
    answerPrompt: prompt,
    answerPromptHash: createHash("sha256").update(prompt).digest("hex"),
    tokenUsage: pack.tokenBudget,
    citations: pack.citations,
    conflicts: pack.conflicts,
    evidenceSelection: {
      selected: answerContext.selected,
      rejected: answerContext.rejected
    },
    evidence: evidenceMetrics(
      question.goldDiaIds,
      searchResults,
      selectedItems,
      scopedFacts.map((fact) => ({ sourceRefs: fact.linkedSourceRefs })),
      scopedFacts.filter((fact) => stmFactIds.has(fact.factId)).map((fact) => ({ sourceRefs: fact.linkedSourceRefs }))
    ),
    fallbackUsed: false,
    elapsedMs: Date.now() - startedAt,
    profile: LOCOMO_EVALUATION_PROFILE
  };
}

export async function ingestLocomoSession(repository: ContextEngineRepository, event: MemoryEvent, options: LocomoPrepareOptions) {
  let task = createPipelineTask(event);
  await repository.savePipelineTask(task);
  await repository.saveMemoryEvent(event);
  try {
    task = await updatePipelineTask(repository, task, { taskType: "ingest", status: "running", stage: "event_saved" });
    await repository.saveMemoryChangeEvent({
      eventId: `mce_${event.eventId}`,
      memoryDataId: event.eventId,
      changeType: "created",
      storageLayer: "fact",
      reason: "locomo_native_session_accepted",
      createdAt: new Date().toISOString()
    });
    await parseAndAdmitEvent(repository, event, task, {
      ...(options.llm ? {
        llm: {
          ...options.llm,
          fallbackMode: options.disableIngestLlm ? "allow" : options.llm.fallbackMode ?? "throw",
          emptyFactsMode: "allow",
          semanticRetryMaxAttempts: 2
        }
      } : {}),
      disableFactFusionLlm: options.disableIngestLlm === true,
      disableStmAdmissionLlm: options.disableIngestLlm === true,
      skipTimelineFusion: true,
      ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {})
    });
  } catch (error) {
    // ingest 中途失败时把 task 置为终态 failed（附错误信息），避免留下僵尸 running 状态
    await updatePipelineTask(repository, task, {
      taskType: "ingest",
      status: "failed",
      stage: task.stage,
      error: formatPipelineError(error),
      retryable: true
    });
    throw error;
  }
}

function assertScopeEmptyOrComplete(repository: ContextEngineRepository, conversation: LocomoEvaluationConversation) {
  const events = repository.getDebugSnapshot().memoryEvents.filter((event) => event.contextScopeId === conversation.contextScopeId);
  const expected = new Set(conversation.sessions.map((session) => buildLocomoSessionEvent(conversation, session).eventId));
  const unknown = events.find((event) => !expected.has(event.eventId));
  if (unknown) throw new Error(`scope contains an unexpected event: ${unknown.eventId}`);
}

export function assertConversationPrepared(repository: ContextEngineRepository, conversation: LocomoEvaluationConversation) {
  const snapshot = repository.getDebugSnapshot();
  const eventIds = new Set(snapshot.memoryEvents.filter((event) => event.contextScopeId === conversation.contextScopeId).map((event) => event.eventId));
  for (const session of conversation.sessions) {
    const expected = buildLocomoSessionEvent(conversation, session).eventId;
    if (!eventIds.has(expected)) throw new Error(`conversation is not fully prepared; missing ${session.sessionId}`);
  }
  const pending = snapshot.pipelineTasks.find((task) => eventIds.has(task.eventId) && task.status !== "succeeded");
  if (pending) throw new Error(`conversation pipeline is not frozen: ${pending.taskId}=${pending.status}`);
  const ltm = memoriesInScope(snapshot, conversation.contextScopeId).longTerm[0];
  if (ltm) throw new Error(`profile ${LOCOMO_EVALUATION_PROFILE} forbids LTM: ${ltm.memoryId}`);
}

function memoriesInScope(snapshot: ReturnType<ContextEngineRepository["getDebugSnapshot"]>, contextScopeId: string) {
  const factIds = new Set(snapshot.facts.filter((fact) => fact.contextScopeId === contextScopeId).map((fact) => fact.factId));
  return {
    shortTerm: snapshot.shortTermMemories.filter((memory) => memory.sourceFactIds.some((factId) => factIds.has(factId))),
    longTerm: snapshot.longTermMemories.filter((memory) =>
      (memory.sourceFactIds ?? []).some((factId) => factIds.has(factId)) ||
      memory.sourceMemoryDataIds.some((memoryId) => snapshot.shortTermMemories.some((stm) =>
        stm.memoryDataId === memoryId && stm.sourceFactIds.some((factId) => factIds.has(factId))
      ))
    )
  };
}

function evidenceMetrics(
  goldDiaIds: string[],
  candidates: Array<{ sourceRefs: SourceRef[] }>,
  selected: Array<{ sourceRefs: SourceRef[] }>,
  facts: Array<{ sourceRefs: SourceRef[] }>,
  admittedFacts: Array<{ sourceRefs: SourceRef[] }>
): LocomoEvidenceMetrics {
  const gold = new Set(goldDiaIds);
  const factMatchedDiaIds = matchedDiaIds(facts, gold);
  const stmMatchedDiaIds = matchedDiaIds(admittedFacts, gold);
  const retrievalMatchedDiaIds = matchedDiaIds(candidates, gold);
  const packMatchedDiaIds = matchedDiaIds(selected, gold);
  if (!gold.size) return {
    evaluable: false,
    goldCount: 0,
    factMatchedDiaIds,
    stmMatchedDiaIds,
    retrievalMatchedDiaIds,
    packMatchedDiaIds
  };
  return {
    evaluable: true,
    goldCount: gold.size,
    factMatchedDiaIds,
    stmMatchedDiaIds,
    retrievalMatchedDiaIds,
    packMatchedDiaIds,
    retrievalRanks: diaIdRanks(candidates, gold),
    packRanks: diaIdRanks(selected, gold),
    retrievalRecall: retrievalMatchedDiaIds.length / gold.size,
    packRecall: packMatchedDiaIds.length / gold.size,
    factExtractionRecall: factMatchedDiaIds.length / gold.size,
    stmAdmissionRecall: stmMatchedDiaIds.length / gold.size,
    evidenceRetention: retrievalMatchedDiaIds.length
      ? packMatchedDiaIds.length / retrievalMatchedDiaIds.length
      : 0,
    retrievalAny: retrievalMatchedDiaIds.length > 0,
    retrievalAll: retrievalMatchedDiaIds.length === gold.size,
    packAny: packMatchedDiaIds.length > 0,
    packAll: packMatchedDiaIds.length === gold.size
  };
}

function diaIdRanks(items: Array<{ sourceRefs: SourceRef[] }>, gold: Set<string>) {
  const ranks: Record<string, number> = {};
  items.forEach((item, index) => {
    for (const ref of item.sourceRefs) {
      const diaId = typeof ref.metadata?.diaId === "string" ? ref.metadata.diaId : undefined;
      if (diaId && gold.has(diaId) && ranks[diaId] === undefined) ranks[diaId] = index + 1;
    }
  });
  return ranks;
}

function matchedDiaIds(items: Array<{ sourceRefs: SourceRef[] }>, gold: Set<string>) {
  const matched = new Set<string>();
  for (const item of items) for (const ref of item.sourceRefs) {
    const diaId = typeof ref.metadata?.diaId === "string" ? ref.metadata.diaId : undefined;
    if (diaId && gold.has(diaId)) matched.add(diaId);
  }
  return [...matched];
}

function sourceRef(conversation: LocomoEvaluationConversation, session: LocomoEvaluationSession, diaId: string, speaker: string): SourceRef {
  return {
    sourceRefId: `locomo_src_${safeId(conversation.conversationId)}_${safeId(diaId)}`,
    sourceType: "locomo_utterance",
    sourceId: diaId,
    metadata: { conversationId: conversation.conversationId, sessionId: session.sessionId, diaId, speaker }
  };
}

function selectedPackItems(pack: ContextPack) {
  return [...pack.profileContext, ...pack.taskContext, ...pack.recentContext, ...pack.constraints];
}

function assertAllowedLayers(items: Array<{ layer: string; id: string }>, location: string) {
  const invalid = items.find((item) => item.layer !== "fact" && item.layer !== "stm");
  if (invalid) throw new Error(`${location} contains forbidden ${invalid.layer} item: ${invalid.id}`);
}

// LoCoMo-specific answer prompt, maintained independently from the LongMemEval prompt.
// locomo-answer-prompt-v7: a concise, instruction-first template ported from the reference
// answer prompt ("You are a knowledgeable and helpful AI assistant ... Answer:"), replacing
// the earlier prescriptive v6 template and its worked calculation examples. It keeps the
// LoCoMo-specific relative-time → absolute-date rule, the Question Date line, and the
// "No information available" refusal answer.
export function buildLocomoAnswerPrompt(input: {
  question: string;
  questionDate?: string;
  serializedPrompt: string;
}) {
  return [
    "You are a knowledgeable and helpful AI assistant.",
    "# CONTEXT:",
    "You have access to memories from two speakers in a conversation. These memories contain timestamped information that may be relevant to answering the question.",
    "# INSTRUCTIONS:",
    "1. Carefully analyze all provided memories. Synthesize information across different entries if needed to form a complete answer.",
    "2. Pay close attention to the timestamps to determine the answer. If memories contain contradictory information, the most recent memory is the source of truth.",
    "3. If the question asks about a specific event or fact, look for direct evidence in the memories.",
    "4. Your answer must be grounded in the memories. However, you may use general world knowledge to interpret or complete information found within a memory (e.g., identifying a landmark mentioned by description).",
    "5. If the question involves time references (like \"last year\", \"two months ago\", etc.), you must calculate the actual date based on the memory's timestamp. For example, if a memory from 4 May 2022 mentions \"went to India last year,\" then the trip occurred in 2021. Use the Question Date only when the question is relative to the present and no memory timestamp applies.",
    "6. Always convert relative time references to specific dates, months, or years in your final answer.",
    "7. Do not confuse character names mentioned in memories with the actual users who created them.",
    "8. The answer must be brief (under 5-6 words) and direct, with no extra description.",
    "# APPROACH (Think step by step):",
    "1. First, examine all memories that contain information related to the question.",
    "2. Synthesize findings from multiple memories if a single entry is insufficient.",
    "3. Examine timestamps and content carefully, looking for explicit dates, times, locations, or events.",
    "4. If the answer requires calculation (e.g., converting relative time references), perform the calculation.",
    "5. Formulate a precise, concise answer based on the evidence from the memories (and allowed world knowledge).",
    "6. Double-check that your answer directly addresses the question asked and adheres to all instructions.",
    "7. Ensure your final answer is specific and avoids vague time references.",
    input.serializedPrompt,
    `Question: ${input.question}`,
    ...(input.questionDate?.trim() ? [`Question Date: ${input.questionDate.trim()}`] : []),
    "Answer:"
  ].join("\n\n");
}

async function generateLocomoAnswer(prompt: string, model: LocomoAnswerModel) {
  const payload = await postOpenAiCompatibleJson({
    endpoint: `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    apiKey: model.apiKey ?? "",
    operation: "locomo_answer",
    body: { model: model.model, messages: [{ role: "user", content: prompt }], temperature: 0 },
    ...(model.fetchImpl ? { fetchImpl: model.fetchImpl } : {})
  }) as { choices?: Array<{ message?: { content?: string } }> };
  const answer = payload.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("LoCoMo answer model returned an empty response");
  return answer;
}

function requiredAnswerModel(value?: LocomoAnswerModel): LocomoAnswerModel {
  if (!value?.baseUrl || !value.model) throw new Error("answerModel is required when generateAnswer is not provided");
  return value;
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
