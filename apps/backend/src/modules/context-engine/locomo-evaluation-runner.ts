import { createHash } from "node:crypto";
import type { ContextEngineRepository } from "./persistence/repository.js";
import type { LocomoEvaluationConversation, LocomoEvaluationQuestion } from "./locomo-dataset.js";
import {
  assertConversationPrepared,
  evaluateLocomoQuestion,
  prepareLocomoConversation,
  type LocomoPrepareOptions,
  type LocomoQuestionResult
} from "./locomo-evaluation.js";
import {
  locomoQuestionKey,
  type LocomoQuestionTerminal,
  type LocomoRecoveryState,
  type LocomoResultWriter,
  type LocomoRunIdentity,
  type LocomoSkippedQuestionResult,
  type LocomoTraceWriter
} from "./locomo-evaluation-artifacts.js";
import { summarizeLocomoScores } from "./locomo-official-scorer.js";
import { LOCOMO_JUDGE_CATEGORIES, LOCOMO_LLM_JUDGE_VERSION, type LocomoJudgeOutcome } from "./locomo-llm-judge.js";

export interface LocomoEvaluationRunOptions {
  command: "full" | "prepare" | "evaluate";
  repository: ContextEngineRepository;
  conversations: LocomoEvaluationConversation[];
  identity: LocomoRunIdentity;
  prepareOptions?: LocomoPrepareOptions;
  questionOptions?: Parameters<typeof evaluateLocomoQuestion>[3];
  questionLimit?: number;
  questionConcurrency?: number;
  maxQuestionAttempts?: number;
  recovery?: LocomoRecoveryState;
  retrySkipped?: boolean;
  resultWriter?: LocomoResultWriter;
  traceWriter?: LocomoTraceWriter;
  signal?: AbortSignal;
  onProgress?: (event: LocomoRunProgress) => void;
  operations?: {
    prepareConversation?: typeof prepareLocomoConversation;
    evaluateQuestion?: typeof evaluateLocomoQuestion;
  };
}

export interface LocomoRunProgress {
  stage: "prepare" | "question";
  processedConversations: number;
  totalConversations: number;
  processedQuestions: number;
  totalQuestions: number;
  conversationId?: string;
  questionId?: string;
}

export interface LocomoEvaluationRunReport {
  preparation: Awaited<ReturnType<typeof prepareLocomoConversation>>[];
  questions: LocomoQuestionTerminal[];
  summary: ReturnType<typeof buildLocomoRunSummary>;
  resumedQuestions: number;
  committedQuestions: number;
}

export async function runLocomoEvaluation(options: LocomoEvaluationRunOptions): Promise<LocomoEvaluationRunReport> {
  const preparation: Awaited<ReturnType<typeof prepareLocomoConversation>>[] = [];
  const resultByKey = new Map<string, LocomoQuestionTerminal>();
  let processedConversations = 0;
  let processedQuestions = 0;
  let committedQuestions = 0;
  let resumedQuestions = 0;
  const targets = selectQuestions(options.conversations, options.questionLimit);
  const targetsByConversation = new Map(options.conversations.map((conversation) => [
    conversation.conversationId,
    targets.filter((target) => target.conversation.conversationId === conversation.conversationId)
  ]));
  await trace(options, { stage: "run", status: "started", detail: { command: options.command, questions: targets.length } });

  const runConversationQuestions = async (conversation: LocomoEvaluationConversation, preparationError?: string) => {
    const conversationTargets = targetsByConversation.get(conversation.conversationId) ?? [];
    const pending: Array<{ conversation: LocomoEvaluationConversation; question: LocomoEvaluationQuestion }> = [];
    for (const target of conversationTargets) {
      const key = locomoQuestionKey(conversation.conversationId, target.question.questionId);
      const recovered = options.recovery?.terminals.get(key)?.result;
      if (recovered && !(options.retrySkipped && recovered.status === "skipped")) {
        resultByKey.set(key, recovered);
        resumedQuestions += 1;
        processedQuestions += 1;
        progress(options, { stage: "question", processedConversations, processedQuestions, conversationId: conversation.conversationId, questionId: target.question.questionId }, targets.length);
        continue;
      }
      if (preparationError) {
        const skipped = skippedResult(conversation, target.question, "conversation_prepare", preparationError, 0);
        resultByKey.set(key, skipped);
        if (options.resultWriter) {
          const receipt = await options.resultWriter.commit(options.identity, skipped);
          if (!receipt.duplicate) committedQuestions += 1;
        }
        await trace(options, { stage: "question", status: "skipped", conversationId: conversation.conversationId, questionId: target.question.questionId, detail: skipped.reason });
        processedQuestions += 1;
        progress(options, { stage: "question", processedConversations, processedQuestions, conversationId: conversation.conversationId, questionId: target.question.questionId }, targets.length);
        continue;
      }
      pending.push(target);
    }

    const immutableBefore = memoryFingerprint(options.repository);
    await mapConcurrent(pending, options.questionConcurrency ?? 4, async ({ question }) => {
      abortIfNeeded(options.signal);
      const key = locomoQuestionKey(conversation.conversationId, question.questionId);
      const startedAt = Date.now();
      const attempts = Math.max(1, options.maxQuestionAttempts ?? 3);
      let terminal: LocomoQuestionTerminal | undefined;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        await trace(options, { stage: "question", status: "started", conversationId: conversation.conversationId, questionId: question.questionId, attempt });
        try {
          terminal = await (options.operations?.evaluateQuestion ?? evaluateLocomoQuestion)(
            options.repository,
            conversation,
            question,
            options.questionOptions ?? {}
          );
          await trace(options, { stage: "question", status: "succeeded", conversationId: conversation.conversationId, questionId: question.questionId, attempt, elapsedMs: Date.now() - startedAt, detail: questionTraceDetail(terminal) });
          break;
        } catch (error) {
          if (attempt === attempts) {
            terminal = skippedResult(conversation, question, "question", formatError(error), Date.now() - startedAt);
            await trace(options, { stage: "question", status: "failed", conversationId: conversation.conversationId, questionId: question.questionId, attempt, elapsedMs: Date.now() - startedAt, detail: terminal.reason });
          }
        }
      }
      resultByKey.set(key, terminal!);
      if (options.resultWriter) {
        const receipt = await options.resultWriter.commit(options.identity, terminal!);
        if (!receipt.duplicate) committedQuestions += 1;
        await trace(options, { stage: "result_commit", status: "succeeded", conversationId: conversation.conversationId, questionId: question.questionId, detail: { duplicate: receipt.duplicate, commitId: receipt.row.commitId } });
      }
      processedQuestions += 1;
      progress(options, { stage: "question", processedConversations, processedQuestions, conversationId: conversation.conversationId, questionId: question.questionId }, targets.length);
    });
    const immutableAfter = memoryFingerprint(options.repository);
    if (immutableBefore !== immutableAfter) throw new Error(`LoCoMo question phase modified Fact/STM state for ${conversation.conversationId}`);
  };

  for (const conversation of options.conversations) {
    abortIfNeeded(options.signal);
    const startedAt = Date.now();
    let preparationError: string | undefined;
    await trace(options, { stage: "prepare", status: "started", conversationId: conversation.conversationId });
    if (options.command === "evaluate") {
      try {
        assertConversationPrepared(options.repository, conversation);
        preparation.push(inspectPreparedConversation(options.repository, conversation));
      } catch (error) {
        preparationError = formatError(error);
        preparation.push(failedPreparation(conversation, preparationError));
      }
    } else {
      const result = await (options.operations?.prepareConversation ?? prepareLocomoConversation)(options.repository, conversation, options.prepareOptions);
      preparation.push(result);
      if (result.status === "failed") preparationError = result.error ?? "conversation preparation failed";
    }
    processedConversations += 1;
    const preparationResult = preparation.at(-1)!;
    await trace(options, {
      stage: "prepare",
      status: preparationResult.status === "prepared" ? "succeeded" : "failed",
      conversationId: conversation.conversationId,
      elapsedMs: Date.now() - startedAt,
      detail: preparationResult
    });
    progress(options, { stage: "prepare", processedConversations, processedQuestions, conversationId: conversation.conversationId }, targets.length);
    if (options.command !== "prepare") await runConversationQuestions(conversation, preparationError);
  }

  if (options.command === "prepare") {
    const report = { preparation, questions: [], summary: buildLocomoRunSummary([], preparation, options.conversations.length), resumedQuestions: 0, committedQuestions: 0 };
    await trace(options, { stage: "run", status: "succeeded", detail: report.summary });
    return report;
  }

  const questions = targets.map(({ conversation, question }) => resultByKey.get(locomoQuestionKey(conversation.conversationId, question.questionId))!);
  const summary = buildLocomoRunSummary(questions, preparation, options.conversations.length);
  await trace(options, { stage: "run", status: "succeeded", detail: summary });
  return { preparation, questions, summary, resumedQuestions, committedQuestions };
}

function failedPreparation(conversation: LocomoEvaluationConversation, error: string) {
  return {
    conversationId: conversation.conversationId,
    contextScopeId: conversation.contextScopeId,
    status: "failed" as const,
    sessionsPrepared: 0,
    facts: 0,
    shortTermMemories: 0,
    error
  };
}

export function buildLocomoRunSummary(
  terminals: LocomoQuestionTerminal[],
  preparation: Awaited<ReturnType<typeof prepareLocomoConversation>>[],
  conversationsSelected: number
) {
  const succeeded = terminals.filter((item): item is LocomoQuestionResult => item.status === "succeeded");
  const evaluable = succeeded.filter((item) => item.evidence.evaluable);
  // J-score：类别 1-4 的二元 LLM judge（CORRECT/WRONG）；judge 字段缺省视为 skipped，兼容旧结果行
  const isJudged = (item: LocomoQuestionResult): item is LocomoQuestionResult & { judge: Extract<LocomoJudgeOutcome, { status: "judged" }> } =>
    item.judge?.status === "judged";
  const judged = succeeded.filter(isJudged);
  const judgeCorrect = judged.filter((item) => item.judge.label === "CORRECT").length;
  const categoryJScores = {} as Record<(typeof LOCOMO_JUDGE_CATEGORIES)[number], { count: number; correct: number; jScore: number }>;
  for (const category of LOCOMO_JUDGE_CATEGORIES) {
    const selected = judged.filter((item) => item.category === category);
    const correct = selected.filter((item) => item.judge.label === "CORRECT").length;
    categoryJScores[category] = { count: selected.length, correct, jScore: selected.length ? correct / selected.length : 0 };
  }
  const judgeStatus = (item: LocomoQuestionResult) => item.judge?.status ?? "skipped";
  const average = (field: "factExtractionRecall" | "stmAdmissionRecall" | "retrievalRecall" | "packRecall" | "evidenceRetention") =>
    evaluable.length ? evaluable.reduce((sum, item) => sum + (item.evidence[field] ?? 0), 0) / evaluable.length : 0;
  return {
    ...summarizeLocomoScores(succeeded.map((item) => ({ category: item.category, score: item.official.score }))),
    llmJudge: {
      judgeVersion: LOCOMO_LLM_JUDGE_VERSION,
      judged: judged.length,
      correct: judgeCorrect,
      jScore: judged.length ? judgeCorrect / judged.length : 0,
      categoryJScores,
      skipped: succeeded.filter((item) => judgeStatus(item) === "skipped").length,
      failed: succeeded.filter((item) => judgeStatus(item) === "failed").length
    },
    evidence: {
      evaluableQuestions: evaluable.length,
      notEvaluableQuestions: succeeded.length - evaluable.length,
      factExtractionRecall: average("factExtractionRecall"),
      stmAdmissionRecall: average("stmAdmissionRecall"),
      retrievalRecall: average("retrievalRecall"),
      packRecall: average("packRecall"),
      evidenceRetention: average("evidenceRetention"),
      retrievalAnyRate: rate(evaluable, (item) => item.evidence.retrievalAny === true),
      retrievalAllRate: rate(evaluable, (item) => item.evidence.retrievalAll === true),
      packAnyRate: rate(evaluable, (item) => item.evidence.packAny === true),
      packAllRate: rate(evaluable, (item) => item.evidence.packAll === true)
    },
    pipeline: {
      conversationsSelected,
      conversationsPrepared: preparation.filter((item) => item.status === "prepared").length,
      conversationsFailed: preparation.filter((item) => item.status === "failed").length,
      questionsSelected: terminals.length,
      questionsEvaluated: succeeded.length,
      questionsSkipped: terminals.length - succeeded.length,
      factExtractionCoverage: average("factExtractionRecall"),
      stmAdmissionCoverage: average("stmAdmissionRecall"),
      retrievalCoverage: average("retrievalRecall"),
      contextPackCoverage: average("packRecall"),
      answerScore: succeeded.length ? succeeded.reduce((sum, item) => sum + item.official.score, 0) / succeeded.length : 0
    }
  };
}

function selectQuestions(conversations: LocomoEvaluationConversation[], limit?: number) {
  // 只答题型 1-4；category 5（adversarial / 不可回答）不参与答题与评分
  const all = conversations.flatMap((conversation) =>
    conversation.questions
      .filter((question) => question.category !== 5)
      .map((question) => ({ conversation, question }))
  );
  return all.slice(0, limit ?? all.length);
}

function skippedResult(
  conversation: LocomoEvaluationConversation,
  question: LocomoEvaluationQuestion,
  stage: LocomoSkippedQuestionResult["stage"],
  reason: string,
  elapsedMs: number
): LocomoSkippedQuestionResult {
  return { status: "skipped", conversationId: conversation.conversationId, questionId: question.questionId, questionIndex: question.questionIndex, category: question.category, referenceAnswer: question.referenceAnswer, reason, stage, elapsedMs };
}

async function mapConcurrent<T>(items: T[], concurrency: number, operation: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(concurrency))) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await operation(items[index]!);
    }
  });
  await Promise.all(workers);
}

function memoryFingerprint(repository: ContextEngineRepository) {
  const snapshot = repository.getDebugSnapshot();
  return createHash("sha256").update(JSON.stringify({ facts: snapshot.facts, stm: snapshot.shortTermMemories, ltm: snapshot.longTermMemories })).digest("hex");
}

function inspectPreparedConversation(repository: ContextEngineRepository, conversation: LocomoEvaluationConversation) {
  const snapshot = repository.getDebugSnapshot();
  const facts = snapshot.facts.filter((fact) => fact.contextScopeId === conversation.contextScopeId);
  const factIds = new Set(facts.map((fact) => fact.factId));
  return {
    conversationId: conversation.conversationId,
    contextScopeId: conversation.contextScopeId,
    status: "prepared" as const,
    sessionsPrepared: conversation.sessions.length,
    facts: facts.length,
    shortTermMemories: snapshot.shortTermMemories.filter((memory) => memory.sourceFactIds.some((factId) => factIds.has(factId))).length
  };
}

function questionTraceDetail(result: LocomoQuestionResult) {
  return {
    candidateIds: result.candidates.map((item) => item.id),
    selectedIds: result.selectedItems.map((item) => item.id),
    dropped: result.dropped,
    tokenUsage: result.tokenUsage,
    serializedPromptHash: result.serializedPromptHash,
    answerPromptHash: result.answerPromptHash,
    officialScore: result.official.score,
    judge: result.judge?.status === "judged" ? `${result.judge.label}:${result.judge.score}` : result.judge?.status ?? "missing",
    fallbackUsed: result.fallbackUsed
  };
}

async function trace(options: LocomoEvaluationRunOptions, event: Omit<Parameters<LocomoTraceWriter["append"]>[0], "identity">) {
  await options.traceWriter?.append({ identity: options.identity, ...event });
}

function progress(options: LocomoEvaluationRunOptions, partial: Omit<LocomoRunProgress, "totalConversations" | "totalQuestions">, totalQuestions: number) {
  options.onProgress?.({ ...partial, totalConversations: options.conversations.length, totalQuestions });
}

function rate(items: LocomoQuestionResult[], predicate: (item: LocomoQuestionResult) => boolean) {
  return items.length ? items.filter(predicate).length / items.length : 0;
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("LoCoMo evaluation cancelled");
}

function formatError(error: unknown) { return error instanceof Error ? error.message : String(error); }
