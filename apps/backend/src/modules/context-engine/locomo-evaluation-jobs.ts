import type { FastifyBaseLogger } from "fastify";
import { getContextEngineConfig } from "../../config.js";
import { createEmbeddingClient } from "./embedding.js";
import { createHash } from "node:crypto";
import { LOCOMO_EVALUATION_PROFILE, prepareLocomoConversation } from "./locomo-evaluation.js";
import { createLocomoRunId, projectLocomoQuestionTerminal, type LocomoQuestionTerminalSummary, type LocomoRunIdentity } from "./locomo-evaluation-artifacts.js";
import { runLocomoEvaluation, type LocomoEvaluationRunReport } from "./locomo-evaluation-runner.js";
import { readLocomoEvaluationDataset, type LocomoEvaluationConversation } from "./locomo-dataset.js";
import type { LongMemEvalLlmOptions } from "./longmemeval.js";
import { openLocomoEvaluationRepository } from "./locomo-repository.js";
import { LocomoResultWriter, LocomoTraceWriter, atomicWriteLocomoSummary } from "./locomo-evaluation-artifacts.js";
import {
  assertLocomoStoreManifest,
  assertLocomoStoreReusable,
  createLocomoStoreManifest,
  locomoStoreIdentity,
  writeLocomoStoreManifest
} from "./locomo-store-manifest.js";

export interface LocomoEvaluationJobSnapshot {
  jobId: string;
  datasetPath: string;
  command: "full" | "prepare" | "evaluate";
  profile: typeof LOCOMO_EVALUATION_PROFILE;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  totalConversations?: number;
  processedConversations?: number;
  totalQuestions?: number;
  processedQuestions?: number;
  progress?: number;
  currentConversationId?: string;
  currentQuestionId?: string;
  preparation?: Awaited<ReturnType<typeof prepareLocomoConversation>>[];
  questions?: LocomoQuestionTerminalSummary[];
  summary?: LocomoEvaluationRunReport["summary"];
  storePath?: string;
  artifacts?: {
    resultPath?: string | undefined;
    tracePath: string;
    summaryPath: string;
  };
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

interface Job extends LocomoEvaluationJobSnapshot {
  abortController: AbortController;
}

type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
const jobs = new Map<string, Job>();

export function getLocomoEvaluationJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  const {
    abortController: _abortController,
    preparation: _preparation,
    questions: _questions,
    ...snapshot
  } = job;
  return snapshot;
}

export function cancelLocomoEvaluationJob(jobId: string, logger?: Logger) {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (job.status === "queued" || job.status === "running") {
    job.abortController.abort();
    job.status = "cancelled";
    job.error = "LoCoMo evaluation cancelled";
    job.finishedAt = new Date().toISOString();
    logger?.warn({ jobId }, "locomo evaluation cancelled");
  }
  return getLocomoEvaluationJob(jobId);
}

export function createLocomoEvaluationJob(input: {
  datasetPath: string;
  command?: "full" | "prepare" | "evaluate";
  storePath?: string;
  sampleIds?: string[];
  sampleRange?: { start: number; end: number };
  questionLimit?: number;
  questionConcurrency?: number;
  llm?: LongMemEvalLlmOptions;
  disableIngestLlm?: boolean;
  ci?: boolean;
}, logger?: Logger) {
  const config = getContextEngineConfig();
  const jobId = `locomo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job: Job = {
    jobId,
    datasetPath: input.datasetPath,
    command: input.command ?? "full",
    profile: LOCOMO_EVALUATION_PROFILE,
    status: "queued",
    startedAt: new Date().toISOString(),
    abortController: new AbortController()
  };
  jobs.set(jobId, job);
  void run(jobId, input, config.projectRoot, logger);
  return getLocomoEvaluationJob(jobId)!;
}

async function run(jobId: string, input: Parameters<typeof createLocomoEvaluationJob>[0], projectRoot: string, logger?: Logger) {
  const job = jobs.get(jobId);
  if (!job) return;
  try {
    job.status = "running";
    const dataset = await readLocomoEvaluationDataset(resolvePath(input.datasetPath, projectRoot));
    const conversations = selectConversations(dataset.conversations, input.sampleIds ?? [], input.sampleRange);
    const config = getContextEngineConfig();
    const embeddingClient = createEmbeddingClient(config.embedding);
    const extractionModel = {
      baseUrl: input.llm?.extraction?.baseUrl?.trim() || config.llm.baseUrl,
      model: input.llm?.extraction?.model?.trim() || config.llm.model,
      ...(input.llm?.extraction?.apiKey?.trim() || config.llm.apiKey
        ? { apiKey: input.llm?.extraction?.apiKey?.trim() || config.llm.apiKey }
        : {})
    };
    const answerModel = {
      baseUrl: input.llm?.answer?.baseUrl?.trim() || extractionModel.baseUrl,
      model: input.llm?.answer?.model?.trim() || extractionModel.model,
      ...(input.llm?.answer?.apiKey?.trim() || extractionModel.apiKey
        ? { apiKey: input.llm?.answer?.apiKey?.trim() || extractionModel.apiKey }
        : {})
    };
    const judgeModel = {
      baseUrl: input.llm?.judge?.baseUrl?.trim() || answerModel.baseUrl,
      model: input.llm?.judge?.model?.trim() || answerModel.model,
      ...(input.llm?.judge?.apiKey?.trim() || answerModel.apiKey
        ? { apiKey: input.llm?.judge?.apiKey?.trim() || answerModel.apiKey }
        : {})
    };
    const manifest = createLocomoStoreManifest({
      config,
      datasetSha256: dataset.sha256,
      conversationIds: conversations.map((item) => item.conversationId),
      embeddingFingerprint: embeddingClient.fingerprint,
      ingestionModel: input.ci || input.disableIngestLlm ? "deterministic-local" : modelIdentity(extractionModel),
      answerModel: input.ci ? "deterministic-local" : modelIdentity(answerModel)
    });
    const storePath = resolvePath(input.storePath ?? `${config.longMemEval.storage.storeDirectory}/locomo-native-${dataset.sha256.slice(0, 16)}-${locomoStoreIdentity(manifest)}.sqlite`, projectRoot);
    job.storePath = storePath;
    job.totalConversations = conversations.length;
    job.totalQuestions = conversations.reduce((sum, item) => sum + item.questions.length, 0);
    if (input.command === "evaluate") await assertLocomoStoreManifest(storePath, manifest);
    else {
      await assertLocomoStoreReusable(storePath, manifest);
      await writeLocomoStoreManifest(storePath, manifest);
    }
    const resultPath = `${storePath}.results.jsonl`;
    const tracePath = `${storePath}.trace.jsonl`;
    const summaryPath = `${storePath}.summary.json`;
    const resultWriter = (input.command ?? "full") === "prepare"
      ? undefined
      : await LocomoResultWriter.open({ path: resultPath });
    const traceWriter = await LocomoTraceWriter.open(tracePath);
    const opened = await openLocomoEvaluationRepository({ config, storePath, readOnly: input.command === "evaluate" });
    const repository = opened.repository;
    try {
      const storeFingerprint = locomoStoreIdentity(manifest);
      const identity: LocomoRunIdentity = {
        runId: createLocomoRunId(),
        datasetSha256: dataset.sha256,
        configFingerprint: hash(JSON.stringify({ profile: LOCOMO_EVALUATION_PROFILE, manifest })),
        storeFingerprint,
        modelFingerprint: hash(input.ci ? "deterministic-local" : modelIdentity(answerModel))
      };
      const report = await runLocomoEvaluation({
        command: input.command ?? "full",
        repository,
        conversations,
        identity,
        prepareOptions: {
            embeddingClient,
            disableIngestLlm: input.ci === true || input.disableIngestLlm === true,
            ...(!input.ci && !input.disableIngestLlm ? {
              llm: {
                ...extractionModel,
                fallbackMode: "throw" as const
              }
            } : {})
        },
        questionOptions: {
          embeddingClient,
          ...(input.ci
            ? {
                generateAnswer: async () => "No information available",
                generateJudge: async () => JSON.stringify({ reasoning: "ci deterministic judge", label: "CORRECT" })
              }
            : { answerModel, judgeModel })
        },
        ...(input.questionLimit ? { questionLimit: input.questionLimit } : {}),
        questionConcurrency: input.questionConcurrency ?? 4,
        signal: job.abortController.signal,
        ...(resultWriter ? { resultWriter } : {}),
        traceWriter,
        onProgress: (progress) => {
          job.processedConversations = progress.processedConversations;
          job.processedQuestions = progress.processedQuestions;
          if (progress.conversationId) job.currentConversationId = progress.conversationId;
          else delete job.currentConversationId;
          if (progress.questionId) job.currentQuestionId = progress.questionId;
          else delete job.currentQuestionId;
          const preparationWeight = (input.command ?? "full") === "full" ? 0.5 : (input.command === "prepare" ? 1 : 0);
          job.progress = Math.round(100 * (
            preparationWeight * progress.processedConversations / Math.max(1, progress.totalConversations) +
            (1 - preparationWeight) * progress.processedQuestions / Math.max(1, progress.totalQuestions)
          ));
        }
      });
      job.preparation = report.preparation;
      // 精简投影：完整明细在 results.jsonl；快照会整体 JSON 序列化，放全量会超过 V8 字符串上限
      job.questions = report.questions.map(projectLocomoQuestionTerminal);
      job.summary = report.summary;
      job.artifacts = { resultPath: (input.command ?? "full") === "prepare" ? undefined : resultPath, tracePath, summaryPath };
      job.status = "done";
      job.progress = 100;
      job.finishedAt = new Date().toISOString();
      logger?.info({ jobId, totalQuestions: report.questions.length, resultPath, tracePath, summaryPath }, "locomo evaluation completed");
    } finally {
      await resultWriter?.close();
      await traceWriter.close();
      await opened.close();
    }
  } catch (error) {
    if (job.abortController.signal.aborted) {
      job.status = "cancelled";
      job.error = "LoCoMo evaluation cancelled";
    } else {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      logger?.error({ jobId, error: job.error }, "locomo evaluation failed");
    }
    job.finishedAt = new Date().toISOString();
  }
}

function selectConversations(conversations: LocomoEvaluationConversation[], ids: string[], range?: { start: number; end: number }) {
  if (ids.length && range) throw new Error("sampleIds and sampleRange cannot be combined");
  if (ids.length) {
    const selected = conversations.filter((item) => ids.includes(item.conversationId));
    const missing = ids.filter((id) => !selected.some((item) => item.conversationId === id));
    if (missing.length) throw new Error(`unknown sample ID: ${missing.join(", ")}`);
    return selected;
  }
  if (range) {
    if (range.start < 1 || range.end < range.start || range.end > conversations.length) throw new Error("sampleRange is out of bounds");
    return conversations.slice(range.start - 1, range.end);
  }
  return conversations;
}

function resolvePath(value: string, projectRoot: string) {
  return value.startsWith("/") ? value : `${projectRoot}/${value}`;
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function modelIdentity(model: { baseUrl: string; model: string; apiKey?: string }) { return `${model.baseUrl}|${model.model}|${model.apiKey ? hash(model.apiKey) : "missing"}`; }
