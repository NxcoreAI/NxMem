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
    allowedLayers: ["fact", "stm"],
    candidateLimit: options.candidateLimit ?? BENCHMARK_ANSWER_CANDIDATE_LIMIT,
    evidenceLimit: options.evidenceLimit ?? BENCHMARK_ANSWER_EVIDENCE_LIMIT,
    tokenBudget: options.tokenBudget ?? BENCHMARK_ANSWER_TOKEN_BUDGET,
    includeInactive: true,
    factRetrieval: true,
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

// LoCoMo-specific answer prompt, maintained independently from the LongMemEval prompt
// (locomo-answer-prompt-v6). The base structure was derived from the LongMemEval answer
// prompt but is now frozen here so that edits to either prompt never affect the other.
export function buildLocomoAnswerPrompt(input: {
  question: string;
  questionDate?: string;
  serializedPrompt: string;
}) {
  return [
    "Answer the question using the provided Context Pack.",
    `Question: ${input.question}`,
    ...(input.questionDate?.trim() ? [`Question Date: ${input.questionDate.trim()}`] : []),
    "Read the Context Pack carefully and understand the meaning of each fact and field:",
    "- content / factText: the content of the fact and the primary evidence for answering the question.",
    "- entity: the specific person, object, place, or concept involved in the fact. Do not treat different entities as the same merely because their names are similar.",
    "- event: the event described by the fact and, when available, its status or related details.",
    "- validTime: the time when the fact was true or the event occurred.",
    "- evidenceTime: the time when the fact was recorded, observed, or stated.",
    "- factSequence: the one-based extraction order of a fact within its source Session. A larger value means the fact appeared later in that same Session; values from different Sessions are not directly comparable.",
    "- source / sourceMessageIds: where the fact came from. Use this to understand the provenance of the evidence and, when timestamps are available, its chronological context.",
    "- relationship: the relationship between facts, entities, or events. Use it when reasoning across multiple facts.",
    "- factId, memoryId, and other IDs: reference identifiers only, not factual content. Do not use them as the answer itself.",
    "Prefer direct evidence about the required subject and action. Use related facts and paraphrases without inventing or overstating what happened; treat them only as supporting context.",
    "When the question involves numbers, amounts, counts, dates, durations, averages, differences, or other calculations, use all relevant facts and calculate accurately.",
    "Use the following general examples only to understand the reasoning method. Their entities, values, and answers are illustrative and are never evidence for the current question:",
    "- Deduplicated sum: one Session says a repair cost $30 and new lights cost $20, while another Session repeats the same $20 lights purchase. Count the repeated purchase once: $30 + $20 = $50, not $70.",
    "- Counting events in compound statements: one fact says the user attended dinners at Alex's place and at Blake's place, and another fact says the user attended dinner at Casey's place. These are three distinct attended dinners, even though two appear in one sentence.",
    "- Counting distinct entities rather than actions: the user cleaned and serviced the same road bike, then planned to service a commuter bike. For a question asking how many bikes were serviced or planned for service, the answer is two bikes, not three actions.",
    "- Subject and action-state filtering: if the question asks what the user has actually used, count only facts that state the user used, made, served, or otherwise completed the relevant action. Do not count ingredients that the assistant merely recommended, listed in a hypothetical recipe, or suggested for future experimentation. For example, if the user made cocktails with lime, orange, and lemon, while the assistant only suggested grapefruit and yuzu mixers, the count is three, not five.",
    "- Difference and duration: if a taxi costs $70 and a train costs $15, the savings are $70 - $15 = $55. If total tenure is 4 years 2 months and the prior role lasted 2 years 9 months, convert to months before subtracting: 50 - 33 = 17 months = 1 year 5 months.",
    "- Event-relative duration: if the user attended a baking class on March 20 and made a friend's birthday cake on April 10, then 'How many days ago did I attend the baking class when I made my friend's birthday cake?' uses the cake-making event as the reference point: April 10 - March 20 = 21 days, not the Question Date.",
    "- Insufficient operands: if the taxi price is known but the bus price is not present in the Context Pack, the savings cannot be determined. Do not import outside prices or guess the missing operand.",
    "For temporal reasoning, prefer validTime when it is available and consistent with the fact text. Otherwise, infer the event time from factText or sourceClaim together with that fact's evidenceTime. Resolve relative expressions such as \"today,\" \"yesterday,\" \"just got back,\" \"last week,\" and \"ago\" against the fact's evidenceTime, not the question date, and do not automatically treat evidenceTime as the event time.",
    "For temporal reasoning, identify the events and their relationship before calculating. - For \"between A and B,\" use A and B as the temporal operands. - When \"when,\" \"by the time,\" \"at the time,\" or \"since\" makes B the reference event, calculate up to B, not the Question Date. - Use the Question Date only when the question is relative to the present and provides no other reference event.",
    "For counts, list, justify, and deduplicate qualifying items first in your internal reasoning, then put only the concise result in the final response.",
    "For an update, correction, replacement, latest-state, or current-state question, when facts concern the same entity and property within the same Session, prefer the fact with the larger factSequence unless explicit validTime, evidenceTime, or correction semantics show otherwise. Across different Sessions, determine recency from validTime, evidenceTime, and explicit relationships instead of comparing factSequence values, and treat the chronologically later applicable fact as the latest fact to prioritize when answering.",
    "LoCoMo overrides (these override any conflicting instruction above):",
    "CRITICAL - Absolute date conversion: when the evidence contains a relative time expression (for example \"last Saturday\", \"next month\", \"this summer\", \"yesterday\"), you MUST convert it into an absolute date before answering. Use the evidenceTime of the fact (or the Question Date only when the question itself is relative to the present) as the anchor, count the offset precisely (a week = 7 days), and output the resolved calendar date or month (for example, evidenceTime 25 May 2023 with \"the charity race last Saturday\" means the Saturday before 25 May, so answer \"20 May 2023\"; \"next month\" said in May 2023 means \"June 2023\"). Never answer with the relative expression itself; do not preserve the relative phrasing even when the source text only supports relative timing.",
    "Partial-precision answers are acceptable: when the evidence supports the answer only at a coarser granularity (for example a month instead of an exact day), output that coarser answer (for example \"February 2023\") instead of refusing. A reasoned inference from pack facts counts as supported - only refuse when nothing in the pack relates to the question.",
    "Refusal rule: refuse only when the Context Pack contains no evidence related to the question at all. If the pack contains related or partially covering evidence, always give the most likely short answer based on it instead of refusing. Reserve \"No information available\" strictly for questions whose topic is entirely absent from the pack. Never guess an entity, date, or fact that has no support in the pack.",
    "Answer only based on information supported by the Context Pack.",
    "OUTPUT FORMAT (strict, mandatory):",
    "- Output ONLY the final answer itself: a name, date, number, or short phrase, usually under 12 words. Do not say anything else.",
    "- Do NOT include explanations, reasoning steps, citations, fact references such as \"fact [1]\", or prefaces such as \"Based on the Context Pack\". This overrides the instruction to list, justify, or explain your reasoning in the response; do any such reasoning silently and output only the concise result.",
    "- For date/time questions, give the most specific date the evidence supports, always written as \"day month-name year\" (for example \"19 January 2023\", \"February 2023\"). Never use ISO format such as \"2023-01-19\" and never use numeric-only dates.",
    "- For yes/no or likely/unlikely questions, start with the verdict and add a brief reason only if needed (for example \"Likely no, she prefers reading\").",
    "- For questions asking about multiple items, list them separated by commas.",
    "- When the Context Pack does not contain enough evidence to answer, respond exactly: No information available.",
    `Context Pack:\n${input.serializedPrompt}`
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
