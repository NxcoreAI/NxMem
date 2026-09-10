import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getContextEngineConfig } from "../../config.js";
import { reconcileGeneratedShortTermMemoryIndexes } from "./service-bootstrap.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { Neo4jGraphMemoryStore } from "./persistence/neo4j-graph-store.js";
import {
  importStructuredFactMarkdown,
  parseStructuredFactMarkdown,
  type StructuredFactImportReport
} from "./structured-fact-markdown-import.js";

interface CliOptions {
  mode: "dry-run" | "apply";
  file: string;
  datasetId: string;
  tenantId: string;
  principalId: string;
  json: boolean;
  help: boolean;
}

async function main() {
  const config = getContextEngineConfig();
  const options = parseArgs(process.argv.slice(2), config.projectRoot);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const markdown = await readFile(options.file, "utf8");
  const dataset = parseStructuredFactMarkdown(markdown);

  if (options.mode === "dry-run") {
    const report = await importStructuredFactMarkdown(undefined, dataset, {
      datasetId: options.datasetId,
      sourcePath: options.file,
      tenantId: options.tenantId,
      principalId: options.principalId,
      mode: options.mode
    });
    writeReport(report, options.json);
    return;
  }

  const graphStore = config.graphStore.mode === "neo4j"
    ? Neo4jGraphMemoryStore.fromConfig(config)
    : undefined;
  let repository: SqliteContextEngineRepository | undefined;

  try {
    if (graphStore) await graphStore.initialize();
    repository = new SqliteContextEngineRepository(config.storage.storePath, graphStore);
    await reconcileGeneratedShortTermMemoryIndexes(repository);
    const report = await importStructuredFactMarkdown(repository, dataset, {
      datasetId: options.datasetId,
      sourcePath: options.file,
      tenantId: options.tenantId,
      principalId: options.principalId,
      mode: options.mode
    });
    writeReport(report, options.json);
    if (!report.passed) process.exitCode = 1;
  } finally {
    repository?.close();
    await graphStore?.close();
  }
}

export function parseArgs(argv: string[], projectRoot: string): CliOptions {
  const options: CliOptions = {
    mode: "dry-run",
    file: resolve(projectRoot, "极核产品经理一周事实记忆假数据.md"),
    datasetId: "synthetic-pm-week-20260715-20260721-v1",
    tenantId: "synthetic-test",
    principalId: "synthetic-product-manager",
    json: false,
    help: false
  };
  let explicitMode: CliOptions["mode"] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dry-run" || arg === "--apply") {
      const nextMode = arg === "--apply" ? "apply" : "dry-run";
      if (explicitMode && explicitMode !== nextMode) throw new Error("choose either --dry-run or --apply");
      explicitMode = nextMode;
      options.mode = nextMode;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--file") {
      options.file = resolve(projectRoot, readRequiredValue(argv, ++index, arg));
      continue;
    }
    if (arg === "--dataset-id") {
      options.datasetId = readRequiredValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--tenant") {
      options.tenantId = readRequiredValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--principal") {
      options.principalId = readRequiredValue(argv, ++index, arg);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function readRequiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function writeReport(report: StructuredFactImportReport, json: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [
    `Mode:             ${report.mode}`,
    `Dataset:          ${report.datasetId}`,
    `Source:           ${report.sourcePath}`,
    `Declared:         ${report.declaredRecords}`,
    `Parsed:           ${report.parsedRecords}`,
    `Planned events:   ${report.plannedEvents}`,
    `Planned segments: ${report.plannedSegments}`,
    `Planned facts:    ${report.plannedFacts}`,
    `Applied:          ${report.appliedRecords}`
  ];
  if (report.mode === "apply") {
    lines.push(
      `Verified events: ${report.verification.events}`,
      `Verified facts:  ${report.verification.facts}`,
      `Verified STM:    ${report.verification.shortTermMemories}`,
      `Verified index:  ${report.verification.indexes}`,
      `Missing IDs:     ${report.verification.missingIds.length}`,
      `Mismatches:      ${report.verification.mismatches.length}`
    );
  }
  lines.push(`Result:           ${report.passed ? "PASS" : "FAIL"}`);
  if (report.verification.missingIds.length) lines.push(`Missing: ${report.verification.missingIds.join(", ")}`);
  if (report.verification.mismatches.length) lines.push(...report.verification.mismatches.map((item) => `Mismatch: ${item}`));
  process.stdout.write(`${lines.join("\n")}\n`);
}

function helpText() {
  return `Usage: pnpm import:weekly-facts [options]\n\nOptions:\n  --dry-run             Parse and validate only (default)\n  --apply               Write Event, Segment, Fact and STM records\n  --file <path>         Markdown source path\n  --dataset-id <id>     Stable dataset namespace\n  --tenant <id>         Target tenant (default: synthetic-test)\n  --principal <id>      Target principal (default: synthetic-product-manager)\n  --json                Print a JSON report\n  -h, --help            Show this help\n`;
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isMainModule() {
  const scriptPath = process.argv[1];
  return Boolean(scriptPath && import.meta.url === pathToFileURL(scriptPath).href);
}
