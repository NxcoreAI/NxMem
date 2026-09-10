import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getContextEngineConfig } from "../../config.js";
import {
  clearLongMemEvalData,
  evaluateLongMemEvalDataset,
  evaluateLongMemEvalModelRuns,
  resolveLongMemEvalModelRunArtifacts,
  type LongMemEvalLlmRunOptions,
  type LongMemEvalProgress
} from "./longmemeval.js";
import {
  buildLongMemEvalSelectionMetadata,
  readLongMemEvalDatasetSamples,
  selectLongMemEvalSamples,
  splitLongMemEvalSamples,
  writeLongMemEvalDataset,
  type LongMemEvalDatasetSelection
} from "./longmemeval-dataset.js";
import { longMemEvalArtifactStore } from "./longmemeval-artifacts.js";

const defaultDataset = "datasets/LongMemEval/longmemeval_s_cleaned.json";
const defaultSeed = 20260806;

interface CliOptions {
  command: "eval" | "sample" | "split" | "clear-db";
  dataset?: string;
  questionIds: string[];
  sampleRange?: { start: number; end: number };
  ratio?: number;
  seed?: number;
  output?: string;
  result?: string;
  yes: boolean;
  json: boolean;
  ci: boolean;
  ks: number[];
  enableLtmReinforcement: boolean;
  diagnosticsPath?: string;
  resultFileName?: string;
  traceFileName?: string;
  resume: boolean;
  retrySkipped: boolean;
  resumeLegacy: boolean;
  evalBatchSize?: number;
  ingestSampleConcurrency?: number;
  ingestSessionConcurrency?: number;
  answerConcurrency?: number;
  judgeConcurrency?: number;
  answerContextMode: "context_pack" | "retrieval";
  llmRunsPath?: string;
  modelConcurrency?: number;
  disableIngestLlm: boolean;
  allowLlmFallback: boolean;
  skipStmAdmission: boolean;
  skipLtmDreaming: boolean;
  modelOnlyEvaluation: boolean;
  answerOnlyEvaluation: boolean;
  progress?: boolean;
}

class CliError extends Error {
  constructor(message: string, readonly exitCode: 2 | 4 = 2) {
    super(message);
  }
}

export function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const command = args[0] === "sample" || args[0] === "split" || args[0] === "clear-db" ? args.shift() as CliOptions["command"] : "eval";
  const options: CliOptions = {
    command,
    questionIds: [],
    yes: false,
    json: false,
    ci: false,
    ks: [1, 5, 10],
    enableLtmReinforcement: false,
    answerContextMode: "context_pack",
    disableIngestLlm: false,
    allowLlmFallback: true,
    skipStmAdmission: false,
    skipLtmDreaming: true,
    modelOnlyEvaluation: false,
    answerOnlyEvaluation: false,
    resume: false,
    retrySkipped: false,
    resumeLegacy: false
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const next = () => {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new CliError(`${arg} requires a value`);
      return value;
    };
    if (arg === "--dataset") options.dataset = next();
    else if (arg === "--question-id") options.questionIds.push(...next().split(",").map((id) => id.trim()).filter(Boolean));
    else if (arg === "--sample-range") options.sampleRange = parseRange(next());
    else if (arg === "--ratio") options.ratio = Number(next());
    else if (arg === "--seed") options.seed = parseInteger(next(), "seed");
    else if (arg === "--output") options.output = next();
    else if (arg === "--result") options.result = next();
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--ci") { options.ci = true; options.json = true; options.progress = false; }
    else if (arg === "--progress") options.progress = true;
    else if (arg === "--no-progress") options.progress = false;
    else if (arg === "--enable-ltm") options.enableLtmReinforcement = true;
    else if (arg === "--disable-ingest-llm") options.disableIngestLlm = true;
    else if (arg === "--allow-llm-fallback") options.allowLlmFallback = true;
    else if (arg === "--strict-llm") options.allowLlmFallback = false;
    else if (arg === "--skip-stm-admission") options.skipStmAdmission = true;
    else if (arg === "--skip-ltm-dreaming") options.skipLtmDreaming = true;
    else if (arg === "--model-only" || arg === "--model-only-evaluation") options.modelOnlyEvaluation = true;
    else if (arg === "--answer-only" || arg === "--resume-answer") { options.answerOnlyEvaluation = true; options.modelOnlyEvaluation = true; }
    else if (arg === "--k") options.ks = parseKs(next());
    else if (arg === "--batch-size") options.evalBatchSize = parsePositiveInteger(next(), "batch-size");
    else if (arg === "--answer-concurrency") options.answerConcurrency = parsePositiveInteger(next(), "answer-concurrency");
    else if (arg === "--judge-concurrency") options.judgeConcurrency = parsePositiveInteger(next(), "judge-concurrency");
    else if (arg === "--ingest-sample-concurrency") options.ingestSampleConcurrency = parsePositiveInteger(next(), "ingest-sample-concurrency");
    else if (arg === "--ingest-session-concurrency") options.ingestSessionConcurrency = parsePositiveInteger(next(), "ingest-session-concurrency");
    else if (arg === "--diagnostics") options.diagnosticsPath = next();
    else if (arg === "--result-file") options.resultFileName = next();
    else if (arg === "--trace-file") options.traceFileName = next();
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--retry-skipped") options.retrySkipped = true;
    else if (arg === "--resume-legacy") options.resumeLegacy = true;
    else if (arg === "--answer-context") { const value = next(); if (value !== "context_pack" && value !== "retrieval") throw new CliError("answer-context must be context_pack or retrieval"); options.answerContextMode = value; }
    else if (arg === "--llm-runs" || arg === "--models") options.llmRunsPath = next();
    else if (arg === "--model-concurrency") options.modelConcurrency = parsePositiveInteger(next(), "model-concurrency");
    else if (arg.startsWith("--")) throw new CliError(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (!options.dataset && positional[0]) options.dataset = positional[0];
  if (options.command === "sample" && options.questionIds.length === 0 && !options.sampleRange) throw new CliError("sample requires --question-id or --sample-range");
  if (options.command === "sample" && options.ratio !== undefined) throw new CliError("sample cannot use --ratio");
  if (options.command === "split") {
    if (options.ratio === undefined) throw new CliError("split requires --ratio");
    if (!Number.isFinite(options.ratio) || options.ratio <= 0 || options.ratio > 1) throw new CliError("ratio must satisfy 0 < ratio <= 1");
    if (options.ci && options.seed === undefined) throw new CliError("--ci split requires --seed");
    if (options.questionIds.length || options.sampleRange) throw new CliError("split cannot use sample selectors");
  }
  if (options.command === "clear-db" && (options.dataset || options.questionIds.length || options.sampleRange || options.ratio !== undefined)) throw new CliError("clear-db does not accept dataset selection options");
  if (options.questionIds.length && options.sampleRange) throw new CliError("--question-id and --sample-range cannot be used together");
  if ((options.retrySkipped || options.resumeLegacy) && !options.resume) throw new CliError("--retry-skipped and --resume-legacy require --resume");
  if (options.diagnosticsPath && options.resultFileName) throw new CliError("--diagnostics and --result-file cannot be used together");
  return options;
}

async function main() {
  if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
    process.stdout.write(formatHelp());
    return;
  }
  const options = parseArgs(process.argv);
  if (options.command === "clear-db") {
    if (!options.yes) throw new CliError("clear-db requires --yes", 4);
    const result = await clearLongMemEvalData();
    await emitResult({ command: options.command, result }, options);
    return;
  }

  const sourcePath = await resolveDatasetPath(options.dataset ?? defaultDataset);
  let datasetPath = sourcePath;
  let selection: LongMemEvalDatasetSelection | undefined;
  let generatedFile: Awaited<ReturnType<typeof writeLongMemEvalDataset>> | undefined;
  try {
    if (options.command === "sample" || options.command === "split") {
      let sourceSamples: Awaited<ReturnType<typeof readLongMemEvalDatasetSamples>>;
      try {
        sourceSamples = await readLongMemEvalDatasetSamples(sourcePath);
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error));
      }
      let selectedSamples: typeof sourceSamples;
      if (options.command === "sample") {
        try {
          selectedSamples = selectLongMemEvalSamples(sourceSamples, {
            ...(options.questionIds.length ? { questionIds: options.questionIds } : {}),
            ...(options.sampleRange ? { range: options.sampleRange } : {})
          });
        } catch (error) {
          throw new CliError(error instanceof Error ? error.message : String(error));
        }
        selection = buildLongMemEvalSelectionMetadata(sourcePath, selectedSamples, {
          selection: options.sampleRange ? "range" : "question_id",
          ...(options.questionIds.length ? { questionIds: options.questionIds } : {}),
          ...(options.sampleRange ? { sampleRange: options.sampleRange } : {})
        });
      } else {
        const seed = options.seed ?? defaultSeed;
        try {
          selectedSamples = splitLongMemEvalSamples(sourceSamples, options.ratio!, seed);
        } catch (error) {
          throw new CliError(error instanceof Error ? error.message : String(error));
        }
        selection = buildLongMemEvalSelectionMetadata(sourcePath, selectedSamples, { selection: "ratio", ratio: options.ratio!, seed });
      }
      selection.totalSamples = sourceSamples.length;
      generatedFile = await writeLongMemEvalDataset(selectedSamples, options.output);
      datasetPath = generatedFile.path;
      selection.outputPath = datasetPath;
    }
    const llmRuns = options.llmRunsPath ? await loadLlmRuns(options.llmRunsPath) : undefined;
    const progressReporter = createProgressReporter({ enabled: options.progress ?? !options.json });
    const artifactPaths = longMemEvalArtifactStore.resolvePaths({
      ...(options.resultFileName ? { resultBasename: options.resultFileName } : {}),
      ...(options.traceFileName ? { traceBasename: options.traceFileName } : {})
    });
    const diagnosticsPath = options.diagnosticsPath ? resolve(options.diagnosticsPath) : artifactPaths.resultPath;
    longMemEvalArtifactStore.assertManagedPath(diagnosticsPath);
    for (const artifact of llmRuns?.length
      ? resolveLongMemEvalModelRunArtifacts(llmRuns, { resultPath: diagnosticsPath, tracePath: artifactPaths.tracePath })
      : []) {
      if (artifact.resultPath) longMemEvalArtifactStore.assertManagedPath(artifact.resultPath);
      if (artifact.tracePath) longMemEvalArtifactStore.assertManagedPath(artifact.tracePath);
    }
    const cliLogger = {
      info: (fields: Record<string, unknown>, message: string) => process.stderr.write(`${message} ${JSON.stringify(fields)}\n`),
      warn: (fields: Record<string, unknown>, message: string) => process.stderr.write(`${message} ${JSON.stringify(fields)}\n`),
      error: (fields: Record<string, unknown>, message: string) => process.stderr.write(`${message} ${JSON.stringify(fields)}\n`)
    };
    const evaluationOptions = {
      ks: options.ks,
      logger: cliLogger,
      ...(options.modelConcurrency ? { modelConcurrency: options.modelConcurrency } : {}),
      ...(options.evalBatchSize ? { evalBatchSize: options.evalBatchSize } : {}),
      ...(options.ingestSampleConcurrency ? { ingestSampleConcurrency: options.ingestSampleConcurrency } : {}),
      ...(options.ingestSessionConcurrency ? { ingestSessionConcurrency: options.ingestSessionConcurrency } : {}),
      ...(options.answerConcurrency ? { answerConcurrency: options.answerConcurrency } : {}),
      ...(options.judgeConcurrency ? { judgeConcurrency: options.judgeConcurrency } : {}),
      ...(options.enableLtmReinforcement ? { enableLtmReinforcement: true } : {}),
      diagnosticsPath,
      tracePath: artifactPaths.tracePath,
      runId: artifactPaths.runId,
      resume: options.resume,
      retrySkipped: options.retrySkipped,
      resumeLegacy: options.resumeLegacy,
      answerContextMode: options.answerContextMode,
      ...(options.disableIngestLlm ? { disableIngestLlm: true } : {}),
      allowLlmFallback: options.allowLlmFallback,
      ...(options.skipStmAdmission ? { skipStmAdmission: true } : {}),
      ...(options.skipLtmDreaming ? { skipLtmDreaming: true } : {}),
      ...(options.modelOnlyEvaluation ? { modelOnlyEvaluation: true } : {}),
      ...(options.answerOnlyEvaluation ? { answerOnlyEvaluation: true } : {}),
      ...(progressReporter ? { onProgress: progressReporter } : {})
    };
    const report = llmRuns?.length
      ? await evaluateLongMemEvalModelRuns(datasetPath, { ...evaluationOptions, llmRuns })
      : await evaluateLongMemEvalDataset(datasetPath, evaluationOptions);
    const artifactSummary = {
      ...("runs" in report ? {
        models: report.runs.map((run) => ({
          modelRunId: run.runId,
          ...(run.resultPath ? { resultPath: run.resultPath } : {}),
          ...(run.tracePath ? { tracePath: run.tracePath } : {})
        }))
      } : { resultPath: diagnosticsPath, tracePath: artifactPaths.tracePath }),
      recovery: "runs" in report
        ? report.runs.map((run) => ({ runId: run.runId, recovery: run.report?.recovery }))
        : report.recovery
    };
    await emitResult(
      options.command === "eval"
        ? { ...(report as unknown as Record<string, unknown>), artifacts: artifactSummary }
        : { command: options.command, datasetPath, ...(selection ? { selection } : {}), report, artifacts: artifactSummary },
      options
    );
  } finally {
    await generatedFile?.cleanup();
  }
}

export function formatHelp() {
  return `LongMemEval streaming evaluation

Usage:
  pnpm eval:longmemeval [dataset.json] [options]
  pnpm eval:longmemeval sample --dataset dataset.json (--question-id ID[,ID] | --sample-range START-END)
  pnpm eval:longmemeval split --dataset dataset.json --ratio 0.1 [--seed 20260806]

Artifacts and recovery:
  --result-file NAME              Result JSONL basename under apps/backend/data
  --trace-file NAME               Trace JSONL basename under apps/backend/data
  --resume                        Preserve and scan the existing result JSONL
  --retry-skipped                 Re-run skipped terminals; requires --resume
  --resume-legacy                 Allow weak validation of legacy result rows; requires --resume

Concurrency:
  --model-concurrency N
  --ingest-sample-concurrency N
  --ingest-session-concurrency N
  --answer-concurrency N
  --judge-concurrency N

Evaluation modes:
  --model-only                    Reuse completed ingestion where supported
  --answer-only                   Run answer/judge from pre-ingested data
  --disable-ingest-llm
  --skip-stm-admission
  --skip-ltm-dreaming
  --answer-context context_pack|retrieval
  --llm-runs FILE                 JSON array/object containing model runs

A new run truncates its result file after acquiring the exclusive lock. Artifact names must be safe .jsonl basenames.
`;
}

async function emitResult(result: Record<string, unknown>, options: CliOptions) {
  const payload = options.result ? { ...result, resultPath: options.result } : result;
  const text = JSON.stringify(payload, null, 2);
  if (options.result) {
    const path = options.result;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    await writeFile(temp, `${text}\n`, "utf8");
    await rename(temp, path);
  }
  if (options.json) process.stdout.write(`${text}\n`);
  else printHumanResult(result);
}

function printHumanResult(result: Record<string, unknown>) {
  if (result.command === "clear-db") {
    process.stdout.write(`LongMemEval database cleared: ${JSON.stringify(result.result)}\n`);
    return;
  }
  const report = (result.report ?? result) as { datasetPath?: string; totalSamples?: number; questionTypeCounts?: Record<string, number>; questionTypeAccuracy?: Record<string, { judgeAccuracy: number }>; judge?: { accuracy?: number }; metrics?: Record<string, { recallAnyAtK: number; recallAllAtK: number; ndcgAtK: number }>; summary?: Array<{ runId: string; status: string; judgeAccuracy?: number }> };
  const artifacts = result.artifacts as { resultPath?: string; tracePath?: string; models?: Array<{ modelRunId: string; resultPath?: string; tracePath?: string }>; recovery?: unknown } | undefined;
  process.stdout.write(`LongMemEval dataset: ${report.datasetPath ?? result.datasetPath}\n`);
  process.stdout.write(`Samples: ${report.totalSamples ?? "n/a"}\n`);
  if (artifacts?.resultPath) process.stdout.write(`Result JSONL: ${artifacts.resultPath}\n`);
  if (artifacts?.tracePath) process.stdout.write(`Trace JSONL: ${artifacts.tracePath}\n`);
  for (const artifact of artifacts?.models ?? []) {
    if (artifact.resultPath) process.stdout.write(`Result JSONL [${artifact.modelRunId}]: ${artifact.resultPath}\n`);
    if (artifact.tracePath) process.stdout.write(`Trace JSONL [${artifact.modelRunId}]: ${artifact.tracePath}\n`);
  }
  if (artifacts?.recovery !== undefined) process.stdout.write(`Recovery: ${JSON.stringify(artifacts.recovery)}\n`);
  if (report.judge) process.stdout.write(`Overall Judge: ${report.judge.accuracy?.toFixed(4) ?? "n/a"}\n`);
  if (report.questionTypeCounts) process.stdout.write(`Question types: ${JSON.stringify(report.questionTypeCounts)}\n`);
  if (report.questionTypeAccuracy) process.stdout.write(`Task Judge: ${JSON.stringify(Object.fromEntries(Object.entries(report.questionTypeAccuracy).map(([type, value]) => [type, value.judgeAccuracy.toFixed(4)])))}\n`);
  for (const item of report.summary ?? []) process.stdout.write(`${item.runId}\t${item.status}\tjudge=${item.judgeAccuracy?.toFixed(4) ?? "n/a"}\n`);
  for (const k of Object.keys(report.metrics ?? {}).map(Number).sort((a, b) => a - b)) {
    const metric = report.metrics?.[k];
    if (metric) process.stdout.write(`@${k} Any=${metric.recallAnyAtK.toFixed(4)} All=${metric.recallAllAtK.toFixed(4)} NDCG=${metric.ndcgAtK.toFixed(4)}\n`);
  }
}

export function createProgressReporter({ enabled, write = (line) => process.stderr.write(line) }: { enabled: boolean; write?: (line: string) => void }) {
  if (!enabled) return undefined;
  let lastLine = "";
  return (progress: LongMemEvalProgress) => { const line = formatProgress(progress); if (!line || line === lastLine) return; lastLine = line; write(`${line}\n`); };
}

export function formatProgress(progress: LongMemEvalProgress) {
  const parts = [`[longmemeval] ${progress.stage}`];
  if (progress.ingestStage) parts.push(`/${progress.ingestStage}`);
  const percent = typeof progress.stageProgress === "number"
    ? Math.max(0, Math.min(100, progress.stageProgress))
    : progress.totalSteps > 0 ? Math.max(0, Math.min(100, (progress.processedSteps / progress.totalSteps) * 100)) : undefined;
  if (percent !== undefined) parts.push(`${percent.toFixed(1)}%`);
  if (progress.currentSampleIndex !== undefined || progress.currentSampleCount !== undefined) {
    parts.push(`sample ${progress.currentSampleIndex ?? "?"}/${progress.currentSampleCount ?? progress.totalSamples}`);
  } else {
    parts.push(`samples ${progress.processedSamples}/${progress.totalSamples}`);
  }
  if (progress.currentSessionIndex !== undefined || progress.currentSessionCount !== undefined) {
    parts.push(`session ${progress.currentSessionIndex ?? "?"}/${progress.currentSessionCount ?? progress.totalSessions}`);
  }
  if (progress.batchIndex !== undefined || progress.batchCount !== undefined) {
    parts.push(`batch ${progress.batchIndex ?? "?"}/${progress.batchCount ?? "?"}`);
  }
  const message = progress.stageMessage ?? progress.batchMessage ?? progress.currentJudgment;
  if (message) parts.push(`- ${oneLine(message, 180)}`);
  return parts.join(" ");
}

function oneLine(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function parseRange(value: string) {
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized);
    if (index < 1) throw new CliError("sample-range index must be positive");
    return { start: index, end: index };
  }
  const match = /^(\d+)-(\d+)$/.exec(normalized);
  if (!match) throw new CliError("sample-range must use index or start-end");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end < start) throw new CliError("sample-range must satisfy 1 <= start <= end");
  return { start, end };
}

async function resolveDatasetPath(path: string) {
  try {
    await access(path);
    return path;
  } catch {
    const repositoryPath = resolve(getContextEngineConfig().projectRoot, path);
    try {
      await access(repositoryPath);
      return repositoryPath;
    } catch {
      return repositoryPath;
    }
  }
}

function parseInteger(value: string, name: string) { const number = Number(value); if (!Number.isInteger(number)) throw new CliError(`${name} must be an integer`); return number; }
function parsePositiveInteger(value: string, name: string) { const number = parseInteger(value, name); if (number <= 0) throw new CliError(`${name} must be positive`); return number; }
function parseKs(value: string) { const ks = value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0); if (!ks.length) throw new CliError("k must contain positive integers"); return ks; }

async function loadLlmRuns(path: string): Promise<LongMemEvalLlmRunOptions[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (Array.isArray(parsed)) return parsed as LongMemEvalLlmRunOptions[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { llmRuns?: unknown }).llmRuns)) return (parsed as { llmRuns: LongMemEvalLlmRunOptions[] }).llmRuns;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { runs?: unknown }).runs)) return (parsed as { runs: LongMemEvalLlmRunOptions[] }).runs;
  throw new CliError("llm runs file must be an array or an object with llmRuns/runs");
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : process.argv.slice(2).includes("clear-db") ? 4 : 3;
  });
}

function isMainModule() { const scriptPath = process.argv[1]; return Boolean(scriptPath && import.meta.url === pathToFileURL(scriptPath).href); }
