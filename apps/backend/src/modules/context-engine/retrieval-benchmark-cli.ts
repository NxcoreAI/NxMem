import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getContextEngineConfig } from "../../config.js";
import {
  evaluateRetrievalBenchmark,
  readRetrievalBenchmarkCases,
  type RetrievalBenchmarkCase,
  type RetrievalBenchmarkReport
} from "./retrieval-benchmark.js";
import {
  getLongMemEvalStorePath,
  openLongMemEvalRepository
} from "./longmemeval.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

const defaultDataset = "data/longmemeval_s_cleaned.json";

interface CliOptions {
  dataset: string;
  format: "longmemeval" | "cases";
  storePath?: string;
  storeNamespace?: string;
  localStore: boolean;
  questionIds: string[];
  sampleRange?: { start: number; end: number };
  limit: number;
  ks: number[];
  output?: string;
  diagnostics?: string;
  json: boolean;
  includeInactive?: boolean;
}

class CliError extends Error {}

export function parseRetrievalBenchmarkArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const options: CliOptions = {
    dataset: defaultDataset,
    format: "longmemeval",
    localStore: false,
    questionIds: [],
    limit: 100,
    ks: [1, 5, 10, 20, 50, 100],
    json: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") continue;
    const next = () => {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new CliError(`${arg} requires a value`);
      return value;
    };
    if (arg === "--dataset" || arg === "--input") options.dataset = next();
    else if (arg === "--format") options.format = parseFormat(next());
    else if (arg === "--store-path") options.storePath = next();
    else if (arg === "--store-namespace") options.storeNamespace = next();
    else if (arg === "--local-store") options.localStore = true;
    else if (arg === "--question-id") options.questionIds.push(...next().split(",").map((value) => value.trim()).filter(Boolean));
    else if (arg === "--sample-range") options.sampleRange = parseRange(next());
    else if (arg === "--limit") options.limit = parsePositiveInteger(next(), "limit");
    else if (arg === "--k") options.ks = parseKs(next());
    else if (arg === "--output") options.output = next();
    else if (arg === "--diagnostics") options.diagnostics = next();
    else if (arg === "--json") options.json = true;
    else if (arg === "--include-inactive") options.includeInactive = true;
    else if (arg === "--active-only") options.includeInactive = false;
    else if (arg === "--help" || arg === "-h") throw new CliError(helpText());
    else throw new CliError(`unknown option: ${arg}`);
  }
  if (options.questionIds.length && options.sampleRange) {
    throw new CliError("--question-id and --sample-range cannot be used together");
  }
  options.ks = [...new Set(options.ks.map((k) => Math.min(k, options.limit)))].sort((a, b) => a - b);
  return options;
}

async function main() {
  const options = parseRetrievalBenchmarkArgs(process.argv);
  const datasetPath = await resolveInputPath(options.dataset);
  await assertFileExists(datasetPath, "benchmark input");
  const loadedCases = await readRetrievalBenchmarkCases(datasetPath, options.format);
  const selectedCases = selectCases(loadedCases, options);
  const cases = selectedCases.map((item) => options.includeInactive === undefined
    ? item
    : { ...item, includeInactive: options.includeInactive });
  const storePath = options.storePath
    ? resolveCliPath(options.storePath)
    : getLongMemEvalStorePath(datasetPath, options.storeNamespace);
  const outputPath = options.output ? resolveCliPath(options.output) : undefined;
  const diagnosticsPath = options.diagnostics ? resolveCliPath(options.diagnostics) : undefined;
  await assertFileExists(storePath, "ingested retrieval store");

  const handle = await openRepository(datasetPath, storePath, options);
  try {
    const report = await evaluateRetrievalBenchmark(handle.repository, cases, {
      limit: options.limit,
      ks: options.ks
    });
    const payload = {
      datasetPath,
      storePath,
      format: options.format,
      ...report
    };
    if (outputPath) await writeJsonAtomic(outputPath, payload);
    if (diagnosticsPath) await writeJsonl(diagnosticsPath, report.cases);
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else printSummary(report, datasetPath, storePath, outputPath, diagnosticsPath);
  } finally {
    if (handle.repository instanceof SqliteContextEngineRepository) handle.repository.close();
    await handle.close?.();
  }
}

async function openRepository(datasetPath: string, storePath: string, options: CliOptions): Promise<{
  repository: ContextEngineRepository;
  close?: (() => Promise<void>) | undefined;
}> {
  if (options.localStore || options.storePath) {
    return {
      repository: new SqliteContextEngineRepository(storePath, undefined, { loadCache: true, readOnly: true })
    };
  }
  return openLongMemEvalRepository(datasetPath, {
    ...(options.storeNamespace ? { storeNamespace: options.storeNamespace } : {}),
    lazyCache: false,
    readOnly: true
  });
}

function selectCases(cases: RetrievalBenchmarkCase[], options: CliOptions) {
  if (options.sampleRange) {
    const { start, end } = options.sampleRange;
    if (end > cases.length) throw new CliError(`sample range end ${end} exceeds case count ${cases.length}`);
    return cases.slice(start - 1, end);
  }
  if (options.questionIds.length) {
    const allowed = new Set(options.questionIds);
    const selected = cases.filter((item) => allowed.has(item.caseId));
    const found = new Set(selected.map((item) => item.caseId));
    const missing = [...allowed].filter((id) => !found.has(id));
    if (missing.length) throw new CliError(`question id not found: ${missing.join(", ")}`);
    return selected;
  }
  return cases;
}

function printSummary(
  report: RetrievalBenchmarkReport,
  datasetPath: string,
  storePath: string,
  outputPath: string | undefined,
  diagnosticsPath: string | undefined
) {
  process.stdout.write(`Retrieval benchmark input: ${datasetPath}\n`);
  process.stdout.write(`Retrieval store: ${storePath}\n`);
  process.stdout.write(`Cases: ${report.totalCases}, Top-${report.limit}\n`);
  for (const target of ["session", "fact"] as const) {
    const metrics = report.metrics[target];
    if (!metrics.some((metric) => metric.evaluatedCases > 0)) continue;
    process.stdout.write(`${target} metrics:\n`);
    for (const metric of metrics) {
      process.stdout.write(
        `  @${metric.k} recall=${metric.recallAtK.toFixed(4)} any=${metric.recallAnyAtK.toFixed(4)} all=${metric.recallAllAtK.toFixed(4)} mrr=${metric.mrrAtK.toFixed(4)} ndcg=${metric.ndcgAtK.toFixed(4)}\n`
      );
    }
  }
  process.stdout.write(`Diagnostics: ${JSON.stringify(report.diagnosticCounts)}\n`);
  if (outputPath) process.stdout.write(`Report: ${outputPath}\n`);
  if (diagnosticsPath) process.stdout.write(`Case diagnostics: ${diagnosticsPath}\n`);
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function writeJsonl(path: string, values: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

async function assertFileExists(path: string, label: string) {
  try {
    await access(path);
  } catch {
    throw new CliError(`${label} not found: ${path}`);
  }
}

async function resolveInputPath(path: string) {
  const cliPath = resolveCliPath(path);
  try {
    await access(cliPath);
    return cliPath;
  } catch {
    return resolve(getContextEngineConfig().projectRoot, path);
  }
}

function resolveCliPath(path: string) {
  const invocationDirectory = process.env.INIT_CWD?.trim() || process.cwd();
  return resolve(invocationDirectory, path);
}

function parseFormat(value: string): CliOptions["format"] {
  if (value === "longmemeval" || value === "cases") return value;
  throw new CliError("format must be longmemeval or cases");
}

function parseRange(value: string) {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(value.trim());
  if (!match) throw new CliError("sample-range must be an index or start-end");
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (start < 1 || end < start) throw new CliError("sample-range must satisfy 1 <= start <= end");
  return { start, end };
}

function parsePositiveInteger(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CliError(`${name} must be a positive integer`);
  return parsed;
}

function parseKs(value: string) {
  const values = value.split(",").map((item) => Number(item.trim()));
  if (!values.length || values.some((item) => !Number.isInteger(item) || item <= 0)) {
    throw new CliError("k must contain comma-separated positive integers");
  }
  return values;
}

function helpText() {
  return [
    "Usage: pnpm --filter @nexcore/backend eval:retrieval -- [options]",
    "  --dataset <path>             LongMemEval JSON or generic case JSON/JSONL",
    "  --format longmemeval|cases   Input format (default: longmemeval)",
    "  --store-path <path>          Explicit SQLite store; implies local store search",
    "  --store-namespace <name>     LongMemEval model-run namespace",
    "  --local-store                Use SQLite graph/index data without configured Neo4j",
    "  --question-id <id[,id]>      Evaluate selected case IDs",
    "  --sample-range <n|start-end> Evaluate selected input positions",
    "  --limit <n>                  Candidate limit (default: 100, max: 100)",
    "  --k <1,5,10,...>             Metric cutoffs",
    "  --output <path>              Full JSON report",
    "  --diagnostics <path>         Per-case JSONL diagnostics",
    "  --active-only                Override cases to exclude inactive memories",
    "  --include-inactive           Override cases to include inactive memories",
    "  --json                       Print the full report to stdout"
  ].join("\n");
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CliError ? 2 : 3;
  });
}

function isMainModule() {
  const scriptPath = process.argv[1];
  return Boolean(scriptPath && import.meta.url === pathToFileURL(scriptPath).href);
}
