import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getContextEngineConfig, type ContextEngineConfig } from "../../config.js";
import { createEmbeddingClient } from "./embedding.js";
import { LOCOMO_EVALUATION_PROFILE, prepareLocomoConversation, type LocomoAnswerModel } from "./locomo-evaluation.js";
import { LocomoResultWriter, LocomoTraceWriter, atomicWriteLocomoSummary, createLocomoRunId, projectLocomoQuestionTerminal, scanLocomoResults, type LocomoQuestionTerminalSummary, type LocomoRunIdentity } from "./locomo-evaluation-artifacts.js";
import { runLocomoEvaluation, buildLocomoRunSummary } from "./locomo-evaluation-runner.js";
import { readLocomoEvaluationDataset, type LocomoEvaluationConversation, type LocomoEvaluationDataset } from "./locomo-dataset.js";
import { openLocomoEvaluationRepository } from "./locomo-repository.js";
import { assertLocomoStoreManifest, assertLocomoStoreReusable, createLocomoStoreManifest, locomoStoreFingerprint, writeLocomoStoreManifest } from "./locomo-store-manifest.js";

export interface LocomoEvaluationCliOptions {
  command: "full" | "prepare" | "evaluate" | "clean";
  dataset: string;
  storePath?: string;
  result?: string;
  trace?: string;
  summary?: string;
  sampleIds: string[];
  sampleRange?: { start: number; end: number };
  questionLimit?: number;
  questionConcurrency: number;
  questionAttempts: number;
  resume: boolean;
  retrySkipped: boolean;
  cleanAll: boolean;
  cleanResultsOnly: boolean;
  yes: boolean;
  extractionBaseUrl?: string;
  extractionModel?: string;
  extractionApiKey?: string;
  answerBaseUrl?: string;
  answerModel?: string;
  answerApiKey?: string;
  judgeBaseUrl?: string;
  judgeModel?: string;
  judgeApiKey?: string;
  ci: boolean;
  json: boolean;
}

export class LocomoEvaluationCliError extends Error {}

export function parseLocomoEvaluationArgs(argv: string[]): LocomoEvaluationCliOptions {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  const first = args[0];
  const command = first === "prepare" || first === "evaluate" || first === "full" || first === "clean" ? first : "full";
  let index = first === command ? 1 : 0;
  const options: LocomoEvaluationCliOptions = {
    command, dataset: "data/locomo/locomo10.json", sampleIds: [], questionConcurrency: 4,
    questionAttempts: 3, resume: false, retrySkipped: false, cleanAll: false, cleanResultsOnly: false, yes: false, ci: false, json: false
  };
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = () => {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new LocomoEvaluationCliError(`${arg} requires a value`);
      return value;
    };
    if (arg === "--dataset") options.dataset = next();
    else if (arg === "--store-path") options.storePath = next();
    else if (arg === "--result") options.result = next();
    else if (arg === "--trace") options.trace = next();
    else if (arg === "--summary") options.summary = next();
    else if (arg === "--sample-id") options.sampleIds.push(...next().split(",").map((item) => item.trim()).filter(Boolean));
    else if (arg === "--sample-range") options.sampleRange = parseRange(next());
    else if (arg === "--question-limit") options.questionLimit = positiveInteger(next(), "question-limit");
    else if (arg === "--question-concurrency") options.questionConcurrency = positiveInteger(next(), "question-concurrency");
    else if (arg === "--question-attempts") options.questionAttempts = positiveInteger(next(), "question-attempts");
    else if (arg === "--extraction-base-url") options.extractionBaseUrl = next();
    else if (arg === "--extraction-model") options.extractionModel = next();
    else if (arg === "--extraction-api-key") options.extractionApiKey = next();
    else if (arg === "--answer-base-url") options.answerBaseUrl = next();
    else if (arg === "--answer-model") options.answerModel = next();
    else if (arg === "--answer-api-key") options.answerApiKey = next();
    else if (arg === "--judge-base-url") options.judgeBaseUrl = next();
    else if (arg === "--judge-model") options.judgeModel = next();
    else if (arg === "--judge-api-key") options.judgeApiKey = next();
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--retry-skipped") options.retrySkipped = true;
    else if (arg === "--all") options.cleanAll = true;
    else if (arg === "--results-only") options.cleanResultsOnly = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--ci") options.ci = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--enable-ltm" || arg === "--skip-ltm") throw new LocomoEvaluationCliError(`${arg} is not valid for ${LOCOMO_EVALUATION_PROFILE}`);
    else if (arg === "--help" || arg === "-h") throw new LocomoEvaluationCliError(helpText());
    else throw new LocomoEvaluationCliError(`unknown option: ${arg}`);
  }
  if (options.sampleIds.length && options.sampleRange) throw new LocomoEvaluationCliError("--sample-id and --sample-range cannot be combined");
  if (options.retrySkipped && !options.resume) throw new LocomoEvaluationCliError("--retry-skipped requires --resume");
  if (options.command === "prepare" && (options.resume || options.retrySkipped)) throw new LocomoEvaluationCliError("prepare does not accept result resume options");
  if (options.command === "clean") {
    if (options.resume || options.retrySkipped) throw new LocomoEvaluationCliError("clean does not accept resume options");
    if (options.cleanAll && (options.storePath || options.result || options.trace || options.summary)) throw new LocomoEvaluationCliError("--all cannot be combined with explicit artifact paths");
    if (options.cleanAll && options.cleanResultsOnly) throw new LocomoEvaluationCliError("--all and --results-only cannot be combined");
  }
  return options;
}

export interface LocomoCleanResult {
  command: "clean";
  stores: string[];
  artifacts: string[];
}

export interface LocomoEvaluationRunOutput {
  command: "full" | "prepare" | "evaluate";
  version: 2;
  profile: typeof LOCOMO_EVALUATION_PROFILE;
  identity: LocomoRunIdentity;
  dataset: { path: string; sha256: string; stats: LocomoEvaluationDataset["stats"] };
  storePath: string;
  resultPath?: string;
  tracePath: string;
  summaryPath: string;
  selectedConversationIds: string[];
  preparation: Awaited<ReturnType<typeof prepareLocomoConversation>>[];
  questions: LocomoQuestionTerminalSummary[];
  resumedQuestions: number;
  committedQuestions: number;
  manifest: ReturnType<typeof createLocomoStoreManifest>;
  summary: ReturnType<typeof buildLocomoRunSummary>;
}

export async function runLocomoEvaluationCli(options: LocomoEvaluationCliOptions & { command: "clean" }, io?: { stdout?: (value: string) => void; stderr?: (value: string) => void }): Promise<LocomoCleanResult>;
export async function runLocomoEvaluationCli(options: LocomoEvaluationCliOptions & { command: "full" | "prepare" | "evaluate" }, io?: { stdout?: (value: string) => void; stderr?: (value: string) => void }): Promise<LocomoEvaluationRunOutput>;
export async function runLocomoEvaluationCli(options: LocomoEvaluationCliOptions, io: { stdout?: (value: string) => void; stderr?: (value: string) => void } = {}): Promise<LocomoCleanResult | LocomoEvaluationRunOutput> {
  const stdout = io.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value: string) => process.stderr.write(value));
  const config = getContextEngineConfig();
  if (options.command === "clean") return runLocomoClean(options as LocomoEvaluationCliOptions & { command: "clean" }, { stdout, stderr, config });
  return runLocomoEvaluationRun(options as LocomoEvaluationCliOptions & { command: "full" | "prepare" | "evaluate" }, { stdout, stderr, config });
}

async function runLocomoEvaluationRun(
  options: LocomoEvaluationCliOptions & { command: "full" | "prepare" | "evaluate" },
  io: { stdout: (value: string) => void; stderr: (value: string) => void; config: ContextEngineConfig }
): Promise<LocomoEvaluationRunOutput> {
  const { stdout, stderr, config } = io;
  const datasetPath = resolveCliPath(options.dataset, config.projectRoot);
  const dataset = await readLocomoEvaluationDataset(datasetPath);
  const conversations = selectConversations(dataset.conversations, options);
  const storePath = resolveCliPath(options.storePath ?? join(config.longMemEval.storage.storeDirectory, `locomo-native-${dataset.sha256.slice(0, 16)}.sqlite`), config.projectRoot);
  const embeddingClient = createEmbeddingClient(config.embedding);
  const extractionModel = resolveModel(config, options, "extraction");
  const answerModel = resolveModel(config, options, "answer", extractionModel);
  const judgeModel = resolveModel(config, options, "judge", answerModel);
  const manifest = createLocomoStoreManifest({
    config, datasetSha256: dataset.sha256, conversationIds: conversations.map((item) => item.conversationId),
    embeddingFingerprint: embeddingClient.fingerprint,
    ingestionModel: options.ci ? "deterministic-local" : modelIdentity(extractionModel),
    answerModel: options.ci ? "deterministic-local" : modelIdentity(answerModel)
  });
  if (options.command === "evaluate") await assertLocomoStoreManifest(storePath, manifest);
  else {
    await assertLocomoStoreReusable(storePath, manifest);
    await writeLocomoStoreManifest(storePath, manifest);
  }

  const resultPath = resolveCliPath(options.result ?? `${storePath}.results.jsonl`, config.projectRoot);
  const tracePath = resolveCliPath(options.trace ?? `${storePath}.trace.jsonl`, config.projectRoot);
  const summaryPath = resolveCliPath(options.summary ?? `${storePath}.summary.json`, config.projectRoot);
  const identity: LocomoRunIdentity = {
    runId: createLocomoRunId(), datasetSha256: dataset.sha256,
    configFingerprint: fingerprint(JSON.stringify({ profile: LOCOMO_EVALUATION_PROFILE, manifest })),
    storeFingerprint: locomoStoreFingerprint(manifest),
    modelFingerprint: fingerprint(options.ci ? "deterministic-local" : modelIdentity(answerModel))
  };
  const recovery = options.resume ? await scanLocomoResults(resultPath, withoutRunId(identity)) : undefined;
  const resultWriter = options.command === "prepare" ? undefined : await LocomoResultWriter.open({ path: resultPath, truncate: !options.resume });
  const traceWriter = await LocomoTraceWriter.open(tracePath, !options.resume);
  const opened = await openLocomoEvaluationRepository({ config, storePath, readOnly: options.command === "evaluate" });
  try {
    const report = await runLocomoEvaluation({
      command: options.command, repository: opened.repository, conversations, identity,
      prepareOptions: { embeddingClient, disableIngestLlm: options.ci, ...(!options.ci ? { llm: { ...extractionModel, fallbackMode: "throw" as const } } : {}) },
      questionOptions: {
        embeddingClient,
        ...(options.ci
          ? {
              generateAnswer: async () => "No information available",
              generateJudge: async () => JSON.stringify({ reasoning: "ci deterministic judge", label: "CORRECT" })
            }
          : { answerModel, judgeModel })
      },
      ...(options.questionLimit ? { questionLimit: options.questionLimit } : {}),
      questionConcurrency: options.questionConcurrency, maxQuestionAttempts: options.questionAttempts,
      ...(recovery ? { recovery } : {}), retrySkipped: options.retrySkipped,
      ...(resultWriter ? { resultWriter } : {}), traceWriter,
      onProgress: (progress) => stderr(`${JSON.stringify({ type: "locomo-progress", ...progress })}\n`)
    });
    const output: LocomoEvaluationRunOutput = {
      command: options.command,
      version: 2, profile: LOCOMO_EVALUATION_PROFILE, identity,
      dataset: { path: dataset.path, sha256: dataset.sha256, stats: dataset.stats }, storePath,
      ...(options.command !== "prepare" ? { resultPath } : {}), tracePath, summaryPath,
      selectedConversationIds: conversations.map((item) => item.conversationId), preparation: report.preparation,
      // 精简投影：完整明细在 results.jsonl；此处若放全量会超过 V8 字符串序列化上限
      questions: report.questions.map(projectLocomoQuestionTerminal),
      resumedQuestions: report.resumedQuestions, committedQuestions: report.committedQuestions,
      manifest, summary: report.summary
    };
    await atomicWriteLocomoSummary(summaryPath, output);
    stdout(options.json ? `${JSON.stringify(output)}\n` : formatCliReport(output));
    return output;
  } finally {
    await Promise.allSettled([resultWriter?.close(), traceWriter.close()]);
    await opened.close();
  }
}

interface LocomoCleanPlan {
  stores: string[];      // 记忆 store 主文件（--results-only 时为空）
  artifacts: string[];   // manifest/results/trace/summary 等旁路产物
}

async function runLocomoClean(
  options: LocomoEvaluationCliOptions & { command: "clean" },
  io: { stdout: (value: string) => void; stderr: (value: string) => void; config: ContextEngineConfig }
): Promise<LocomoCleanResult> {
  const storeDirectory = io.config.longMemEval.storage.storeDirectory;
  const targets = options.cleanAll ? await listLocomoStores(storeDirectory) : [await defaultStorePath(options, io.config)];
  const plan: LocomoCleanPlan = { stores: [], artifacts: [] };
  for (const store of targets) {
    const prefix = store.endsWith(".sqlite") ? store : `${store}.sqlite`;
    if (!options.cleanResultsOnly) plan.stores.push(prefix);
    plan.artifacts.push(
      ...artifactPaths(prefix, {
        manifest: true, results: true, trace: true, summary: true
      })
    );
  }
  const existing = {
    stores: plan.stores.filter(await pathExistsFilter()),
    artifacts: plan.artifacts.filter(await pathExistsFilter())
  };
  const removed = { stores: [] as string[], artifacts: [] as string[] };
  const describe = (stores: string[], artifacts: string[]) =>
    [...stores, ...artifacts].map((path) => `  ${path}`).join("\n") || "  (nothing found)";
  if (!existing.stores.length && !existing.artifacts.length) {
    io.stdout(`LoCoMo clean: nothing to delete for ${options.cleanAll ? storeDirectory : targets[0]!}\n`);
    return { command: "clean" as const, stores: [], artifacts: [] };
  }
  if (!options.yes) {
    io.stderr(`LoCoMo clean will permanently delete:\n${describe(existing.stores, existing.artifacts)}\n`);
    throw new LocomoEvaluationCliError("refusing to delete without --yes");
  }
  for (const path of existing.stores) { await rm(path, { force: true }); removed.stores.push(path); }
  for (const path of existing.artifacts) { await rm(path, { force: true }); removed.artifacts.push(path); }
  io.stdout(`LoCoMo clean: deleted ${removed.stores.length} store(s), ${removed.artifacts.length} artifact(s)\n${describe(removed.stores, removed.artifacts)}\n`);
  return { command: "clean" as const, stores: removed.stores, artifacts: removed.artifacts };
}

async function defaultStorePath(options: LocomoEvaluationCliOptions, config: ContextEngineConfig) {
  if (options.storePath) return resolveCliPath(options.storePath, config.projectRoot);
  const dataset = await readLocomoEvaluationDataset(resolveCliPath(options.dataset, config.projectRoot));
  return join(config.longMemEval.storage.storeDirectory, `locomo-native-${dataset.sha256.slice(0, 16)}.sqlite`);
}

async function listLocomoStores(storeDirectory: string) {
  const entries = await readdir(storeDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("locomo-native-") && entry.name.endsWith(".sqlite"))
    .map((entry) => join(storeDirectory, entry.name));
}

function artifactPaths(storePath: string, keep: { manifest: boolean; results: boolean; trace: boolean; summary: boolean }) {
  const suffixes = [] as string[];
  if (keep.manifest) suffixes.push(".manifest.json");
  if (keep.results) suffixes.push(".results.jsonl");
  if (keep.trace) suffixes.push(".trace.jsonl");
  if (keep.summary) suffixes.push(".summary.json");
  return suffixes.map((suffix) => `${storePath}${suffix}`);
}

function pathExistsFilter() {
  return async (path: string) => {
    try { await stat(path); return true; } catch { return false; }
  };
}

function formatCliReport(output: LocomoEvaluationRunOutput) {  const { summary } = output;
  const judge = summary.llmJudge;
  const categories = Object.entries(judge.categoryJScores)
    .map(([category, stat]) => `${category}=${stat.jScore.toFixed(3)}(${stat.correct}/${stat.count})`)
    .join("  ");
  return [
    `LoCoMo evaluation finished: run ${output.identity.runId}`,
    `  conversations: ${summary.pipeline.conversationsSelected} selected, ${summary.pipeline.conversationsPrepared} prepared, ${summary.pipeline.conversationsFailed} failed`,
    `  questions: ${summary.pipeline.questionsEvaluated} evaluated, ${summary.pipeline.questionsSkipped} skipped, ${output.resumedQuestions} resumed`,
    `  LLM judge J-score: ${judge.jScore.toFixed(4)} (correct ${judge.correct}/${judge.judged}, skipped ${judge.skipped}, failed ${judge.failed})`,
    `    category: ${categories}`,
    `  official tokenF1: ${summary.overallOfficialQaScore.toFixed(4)}`,
    `  store:   ${output.storePath}`,
    ...(output.resultPath ? [`  results: ${output.resultPath}`] : []),
    `  trace:   ${output.tracePath}`,
    `  summary: ${output.summaryPath}`
  ].join("\n") + "\n";
}

function selectConversations(conversations: LocomoEvaluationConversation[], options: LocomoEvaluationCliOptions) {
  if (options.sampleIds.length) {
    const selected = conversations.filter((item) => options.sampleIds.includes(item.conversationId));
    const missing = options.sampleIds.filter((id) => !selected.some((item) => item.conversationId === id));
    if (missing.length) throw new LocomoEvaluationCliError(`unknown sample ID: ${missing.join(", ")}`);
    return selected;
  }
  if (options.sampleRange) {
    if (options.sampleRange.end > conversations.length) throw new LocomoEvaluationCliError("sample-range is out of bounds");
    return conversations.slice(options.sampleRange.start - 1, options.sampleRange.end);
  }
  return conversations;
}

function resolveModel(config: ContextEngineConfig, options: LocomoEvaluationCliOptions, kind: "extraction" | "answer" | "judge", fallback?: LocomoAnswerModel): LocomoAnswerModel {
  const baseUrl = kind === "extraction" ? options.extractionBaseUrl : kind === "answer" ? options.answerBaseUrl : options.judgeBaseUrl;
  const model = kind === "extraction" ? options.extractionModel : kind === "answer" ? options.answerModel : options.judgeModel;
  const apiKey = kind === "extraction" ? options.extractionApiKey : kind === "answer" ? options.answerApiKey : options.judgeApiKey;
  return {
    baseUrl: baseUrl?.trim() || fallback?.baseUrl || config.llm.baseUrl,
    model: model?.trim() || fallback?.model || config.llm.model,
    ...(apiKey?.trim() || fallback?.apiKey || config.llm.apiKey ? { apiKey: apiKey?.trim() || fallback?.apiKey || config.llm.apiKey } : {})
  };
}

function modelIdentity(model: LocomoAnswerModel) { return `${model.baseUrl}|${model.model}|${model.apiKey ? fingerprint(model.apiKey) : "missing"}`; }
function parseRange(value: string) { const match = /^(\d+):(\d+)$/.exec(value); if (!match) throw new LocomoEvaluationCliError("sample-range must use START:END (1-based, inclusive)"); const start = Number(match[1]); const end = Number(match[2]); if (start < 1 || end < start) throw new LocomoEvaluationCliError("sample-range must satisfy 1 <= START <= END"); return { start, end }; }
function positiveInteger(value: string, name: string) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new LocomoEvaluationCliError(`${name} must be a positive integer`); return parsed; }
function resolveCliPath(value: string, projectRoot: string) { return resolve(value.startsWith("/") ? value : join(projectRoot, value)); }
function fingerprint(value: string) { return createHash("sha256").update(value).digest("hex"); }
function withoutRunId(identity: LocomoRunIdentity) { const { runId: _runId, ...rest } = identity; return rest; }
function helpText() { return "eval:locomo [full|prepare|evaluate|clean] [--dataset PATH] [--sample-id ID|--sample-range START:END] [--store-path PATH] [--result JSONL] [--trace JSONL] [--summary JSON] [--resume] [--retry-skipped] [--question-limit N] [--question-concurrency N] [--question-attempts N] [--extraction-base-url URL] [--extraction-model MODEL] [--extraction-api-key KEY] [--answer-base-url URL] [--answer-model MODEL] [--answer-api-key KEY] [--judge-base-url URL] [--judge-model MODEL] [--judge-api-key KEY] [--ci] [--json]\nclean: [--all] [--results-only] [--yes]  delete stores and artifacts (--all: every locomo-native-* in the store directory; --results-only: keep the sqlite store, delete results/trace/summary; requires --yes)"; }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseLocomoEvaluationArgs(process.argv);
    const config = getContextEngineConfig();
    const write = (value: string) => { process.stdout.write(value); };
    const writeErr = (value: string) => { process.stderr.write(value); };
    const run = options.command === "clean"
      ? runLocomoClean(options as LocomoEvaluationCliOptions & { command: "clean" }, { stdout: write, stderr: writeErr, config })
      : runLocomoEvaluationRun(options as LocomoEvaluationCliOptions & { command: "full" | "prepare" | "evaluate" }, { stdout: write, stderr: writeErr, config });
    run.catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof LocomoEvaluationCliError && message === helpText() ? 0 : 2;
  }
}
