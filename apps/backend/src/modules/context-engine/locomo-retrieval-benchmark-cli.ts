import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getContextEngineConfig } from "../../config.js";
import { createCrossEncoderReranker } from "./cross-encoder-reranker.js";
import {
  evaluateLocomoFactRetrieval,
  locomoStoreFingerprint,
  prepareLocomoRetrievalStore,
  readLocomoDataset,
  selectLocomoDataset,
  type LocomoPreparationReport,
  type LocomoRetrievalReport
} from "./locomo-retrieval-benchmark.js";
import { createConfiguredLongMemEvalGraphStore } from "./longmemeval.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import type { GraphMemoryStore } from "./persistence/graph-store.js";

const defaultDataset = "data/locomo/locomo10.json";

interface CliOptions {
  command: "full" | "prepare" | "evaluate";
  dataset: string;
  storePath?: string;
  sampleIds: string[];
  sampleRange?: { start: number; end: number };
  caseLimit?: number;
  limit: number;
  ks: number[];
  skipDreaming: boolean;
  noResume: boolean;
  memoryOnly: boolean;
  memoryReranker: boolean;
  output?: string;
  diagnostics?: string;
  json: boolean;
}

export class LocomoCliError extends Error {}

export function parseLocomoRetrievalArgs(argv: string[]): CliOptions {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  let index = 0;
  const first = args[0];
  const command = first === "full" || first === "prepare" || first === "evaluate" ? first : "full";
  if (command === first) index += 1;
  const options: CliOptions = {
    command,
    dataset: defaultDataset,
    sampleIds: [],
    limit: 100,
    ks: [1, 5, 10, 20, 50, 100],
    skipDreaming: true,
    noResume: false,
    memoryOnly: true,
    memoryReranker: true,
    json: false
  };
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = () => {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new LocomoCliError(`${arg} requires a value`);
      return value;
    };
    if (arg === "--dataset" || arg === "--input") options.dataset = next();
    else if (arg === "--store-path") options.storePath = next();
    else if (arg === "--sample-id") options.sampleIds.push(...next().split(",").map((value) => value.trim()).filter(Boolean));
    else if (arg === "--sample-range") options.sampleRange = parseRange(next());
    else if (arg === "--case-limit") options.caseLimit = parsePositiveInteger(next(), "case-limit");
    else if (arg === "--limit") options.limit = parsePositiveInteger(next(), "limit");
    else if (arg === "--k") options.ks = parseKs(next());
    else if (arg === "--skip-dreaming") options.skipDreaming = true;
    else if (arg === "--no-resume") options.noResume = true;
    else if (arg === "--memory-only") options.memoryOnly = true;
    else if (arg === "--fact-retrieval") options.memoryOnly = false;
    else if (arg === "--memory-reranker") options.memoryReranker = true;
    else if (arg === "--no-memory-reranker") options.memoryReranker = false;
    else if (arg === "--output") options.output = next();
    else if (arg === "--diagnostics") options.diagnostics = next();
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") throw new LocomoCliError(helpText());
    else throw new LocomoCliError(`unknown option: ${arg}`);
  }
  if (options.sampleIds.length && options.sampleRange) {
    throw new LocomoCliError("--sample-id and --sample-range cannot be used together");
  }
  if (options.limit > 100) throw new LocomoCliError("limit must not exceed searchContext maximum 100");
  options.ks = [...new Set(options.ks.map((k) => Math.min(k, options.limit)))].sort((a, b) => a - b);
  return options;
}

async function main() {
  const options = parseLocomoRetrievalArgs(process.argv);
  const config = getContextEngineConfig();
  const datasetPath = await resolveInputPath(options.dataset);
  await assertFileExists(datasetPath, "LoCoMo dataset");
  const completeDataset = await readLocomoDataset(datasetPath);
  const selectedDataset = selectLocomoDataset(completeDataset, {
    ...(options.sampleIds.length ? { sampleIds: options.sampleIds } : {}),
    ...(options.sampleRange ? { sampleRange: options.sampleRange } : {})
  });
  const dataset = options.caseLimit
    ? {
      ...selectedDataset,
      cases: selectedDataset.cases
        .filter((benchmarkCase) => !benchmarkCase.skipReason && benchmarkCase.goldFacts.length > 0)
        .slice(0, options.caseLimit)
    }
    : selectedDataset;
  const storePath = options.storePath
    ? resolveCliPath(options.storePath)
    : join(config.longMemEval.storage.storeDirectory, `locomo-${locomoStoreFingerprint(datasetPath, config)}.sqlite`);
  const outputPath = options.output ? resolveCliPath(options.output) : undefined;
  const diagnosticsPath = options.diagnostics ? resolveCliPath(options.diagnostics) : undefined;
  const shouldCreateMemoryReranker = options.command !== "prepare" && options.memoryReranker;
  const memoryReranker = shouldCreateMemoryReranker ? createCrossEncoderReranker() : undefined;
  if (shouldCreateMemoryReranker && !memoryReranker) {
    throw new LocomoCliError("memory reranker is enabled but no reranker service is configured");
  }

  let preparation: LocomoPreparationReport | undefined;
  if (options.command === "full" || options.command === "prepare") {
    const writer = await openRepository(storePath, false);
    try {
      preparation = await prepareLocomoRetrievalStore(writer.repository, dataset, {
        skipDreaming: options.skipDreaming,
        resume: !options.noResume,
        onProgress: (progress) => {
          if (options.json) return;
          process.stderr.write(
            `[${progress.stage}] ${progress.current}/${progress.total}${progress.sampleId ? ` ${progress.sampleId}` : ""}${progress.eventId ? ` ${progress.eventId}` : ""}\n`
          );
        }
      });
    } finally {
      await writer.close();
    }
    if (options.command === "prepare") {
      const payload = { datasetPath, storePath, preparation };
      if (outputPath) await writeJsonAtomic(outputPath, payload);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
  } else {
    await assertFileExists(storePath, "prepared LoCoMo store");
  }

  const reader = await openRepository(storePath, true);
  try {
    const report = await evaluateLocomoFactRetrieval(reader.repository, dataset, {
      limit: options.limit,
      ks: options.ks,
      factCandidatesEnabled: !options.memoryOnly,
      ...(memoryReranker ? { memoryReranker } : {}),
      onProgress: (current, total, benchmarkCase) => {
        if (!options.json) process.stderr.write(`[evaluate] ${current}/${total} ${benchmarkCase.caseId}\n`);
      }
    });
    const payload = { datasetPath, storePath, ...(preparation ? { preparation } : {}), report };
    if (outputPath) await writeJsonAtomic(outputPath, payload);
    if (diagnosticsPath) await writeJsonl(diagnosticsPath, report.cases);
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else printSummary(report, datasetPath, storePath, preparation, outputPath, diagnosticsPath);
  } finally {
    await reader.close();
  }
}

async function openRepository(storePath: string, readOnly: boolean) {
  let graphStore: GraphMemoryStore | undefined;
  try {
    graphStore = await createConfiguredLongMemEvalGraphStore(getContextEngineConfig());
    const repository = new SqliteContextEngineRepository(storePath, graphStore, {
      loadCache: true,
      ...(readOnly ? { readOnly: true } : {})
    });
    return {
      repository,
      async close() {
        repository.close();
        await graphStore?.close?.();
      }
    };
  } catch (error) {
    await graphStore?.close?.();
    throw error;
  }
}

function printSummary(
  report: LocomoRetrievalReport,
  datasetPath: string,
  storePath: string,
  preparation: LocomoPreparationReport | undefined,
  outputPath: string | undefined,
  diagnosticsPath: string | undefined
) {
  process.stdout.write(`LoCoMo dataset: ${datasetPath}\n`);
  process.stdout.write(`Retrieval store: ${storePath}\n`);
  if (preparation) {
    process.stdout.write(`Prepared: events=${preparation.eventCount} facts=${preparation.factCount} stm=${preparation.shortTermMemoryCount} ltm=${preparation.longTermMemoryCount}\n`);
    process.stdout.write(`Fallbacks: ${JSON.stringify(preparation.fallbacks)}\n`);
    process.stdout.write(`Full pipeline valid: ${preparation.validity.fullPipelineCompleted}${preparation.validity.reasons.length ? ` (${preparation.validity.reasons.join(",")})` : ""}\n`);
  }
  process.stdout.write(`Cases: ${report.dataset.evaluableCaseCount}/${report.dataset.caseCount}, gold facts=${report.dataset.goldFactCount}, Top-${report.retrieval.limit}\n`);
  process.stdout.write(`Fact candidates: ${report.retrieval.factCandidatesEnabled ? "enabled" : "disabled (STM/LTM only)"}\n`);
  process.stdout.write(`Memory reranker: ${report.retrieval.memoryRerankerEnabled ? `${report.retrieval.memoryRerankerModel} (fallback cases=${report.retrieval.memoryRerankerFallbackCaseCount})` : "disabled"}\n`);
  for (const layer of ["all", "stm", "ltm"] as const) {
    process.stdout.write(`${layer.toUpperCase()} Top-${report.retrieval.limit} retrieval fact metrics:\n`);
    for (const metric of report.metrics[layer]) {
      process.stdout.write(`  @${metric.k} recall=${metric.recallAtK.toFixed(4)} any=${metric.recallAnyAtK.toFixed(4)} all=${metric.recallAllAtK.toFixed(4)} mrr=${metric.mrrAtK.toFixed(4)} ndcg=${metric.ndcgAtK.toFixed(4)}\n`);
    }
    process.stdout.write(`${layer.toUpperCase()} selected evidence fact metrics (max ${report.selection.evidenceLimit}):\n`);
    for (const metric of report.selectionMetrics[layer]) {
      process.stdout.write(`  @${metric.k} recall=${metric.recallAtK.toFixed(4)} any=${metric.recallAnyAtK.toFixed(4)} all=${metric.recallAllAtK.toFixed(4)} mrr=${metric.mrrAtK.toFixed(4)} ndcg=${metric.ndcgAtK.toFixed(4)}\n`);
    }
  }
  process.stdout.write(`Selection funnel: gold=${report.funnel.goldFactCount} retrieved=${report.funnel.retrievedGoldFactCount} selected=${report.funnel.selectedGoldFactCount} selected/retrieved=${report.funnel.selectedFromRetrievedRate.toFixed(4)} cases_any_retrieved=${report.funnel.casesWithAnyRetrieved} cases_any_selected=${report.funnel.casesWithAnySelected}\n`);
  process.stdout.write(`Diagnostics: ${JSON.stringify(report.diagnosticCounts)}\n`);
  if (outputPath) process.stdout.write(`Report: ${outputPath}\n`);
  if (diagnosticsPath) process.stdout.write(`Case diagnostics: ${diagnosticsPath}\n`);
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function writeJsonl(path: string, values: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

async function resolveInputPath(path: string) {
  const invocationPath = resolveCliPath(path);
  try {
    await access(invocationPath);
    return invocationPath;
  } catch {
    return resolve(getContextEngineConfig().projectRoot, path);
  }
}

function resolveCliPath(path: string) {
  return resolve(process.env.INIT_CWD?.trim() || process.cwd(), path);
}

async function assertFileExists(path: string, label: string) {
  try {
    await access(path);
  } catch {
    throw new LocomoCliError(`${label} not found: ${path}`);
  }
}

function parseRange(value: string) {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(value.trim());
  if (!match) throw new LocomoCliError("sample-range must be an index or start-end");
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (start < 1 || end < start) throw new LocomoCliError("sample-range must satisfy 1 <= start <= end");
  return { start, end };
}

function parsePositiveInteger(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new LocomoCliError(`${name} must be a positive integer`);
  return parsed;
}

function parseKs(value: string) {
  const values = value.split(",").map((item) => Number(item.trim()));
  if (!values.length || values.some((item) => !Number.isInteger(item) || item <= 0)) {
    throw new LocomoCliError("k must contain comma-separated positive integers");
  }
  return values;
}

function helpText() {
  return [
    "Usage: pnpm --filter @nexcore/backend eval:locomo-retrieval -- [full|prepare|evaluate] [options]",
    "  full                         Prepare STM/LTM, then evaluate (default)",
    "  prepare                      Run LoCoMo preprocessing only",
    "  evaluate                     Evaluate an existing store read-only",
    "  --dataset <path>             LoCoMo JSON (default: data/locomo/locomo10.json)",
    "  --store-path <path>          Explicit SQLite store",
    "  --sample-id <id[,id]>        Select conversation sample IDs",
    "  --sample-range <n|start-end> Select conversation positions",
    "  --case-limit <n>              Evaluate the first n evaluable questions",
    "  --limit <n>                  searchContext candidate limit (default/max: 100)",
    "  --k <1,5,10,...>             Metric cutoffs",
    "  --skip-dreaming              Prepare Fact/STM only; no LTM generation",
    "  --no-resume                  Re-run already completed event pipelines",
    "  --memory-only                Search STM/LTM without Fact candidates (default)",
    "  --fact-retrieval              Include Fact candidates for historical comparisons",
    "  --memory-reranker            Rerank STM/LTM Top-100 with the configured cross-encoder (default)",
    "  --no-memory-reranker         Disable STM/LTM cross-encoder reranking",
    "  --output <path>              Full JSON report",
    "  --diagnostics <path>         Per-question JSONL diagnostics",
    "  --json                       Print full JSON to stdout"
  ].join("\n");
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof LocomoCliError ? 2 : 3;
  });
}

function isMainModule() {
  const scriptPath = process.argv[1];
  return Boolean(scriptPath && import.meta.url === pathToFileURL(scriptPath).href);
}
