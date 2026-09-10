import { resolve } from "node:path";
import { getContextEngineConfig } from "../../config.js";
import { recoverDreamingRemovedShortTermMemories } from "./dreaming-stm-recovery.js";
import { createEmbeddingClient, probeEmbedding } from "./embedding.js";
import { createConfiguredLongMemEvalGraphStore } from "./longmemeval.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";

const options = parseOptions(process.argv.slice(2));
const config = getContextEngineConfig();
const sourcePath = resolve(config.projectRoot, options.source);
const targetPath = resolve(config.projectRoot, options.target);
const source = new SqliteContextEngineRepository(sourcePath, undefined, { readOnly: true, loadCache: true });
let graphStore: Awaited<ReturnType<typeof createConfiguredLongMemEvalGraphStore>>;
let target: SqliteContextEngineRepository | undefined;

try {
  if (!options.dryRun) graphStore = await createConfiguredLongMemEvalGraphStore(config);
  target = new SqliteContextEngineRepository(targetPath, graphStore, { loadCache: true });
  const embeddingClient = createEmbeddingClient(config.embedding);
  if (!options.dryRun) await probeEmbedding(embeddingClient);
  const result = await recoverDreamingRemovedShortTermMemories({
    source,
    target,
    embeddingClient,
    dryRun: options.dryRun,
    indexBatchSize: options.batchSize,
    onProgress(processed, total) {
      process.stderr.write(`[restore:dreaming-stm] indexed ${processed}/${total}\n`);
    }
  });
  process.stdout.write(`${JSON.stringify({ sourcePath, targetPath, ...result }, null, 2)}\n`);
} finally {
  source.close();
  target?.close();
  await graphStore?.close?.();
}

function parseOptions(args: string[]) {
  let source = "data/longmemeval/locomo-63ba5d03e69d.sqlite";
  let target = "data/longmemeval/locomo-stage-3.sqlite";
  let dryRun = false;
  let batchSize = 32;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--source") source = readValue(args, ++index, arg);
    else if (arg === "--target") target = readValue(args, ++index, arg);
    else if (arg === "--batch-size") batchSize = Number(readValue(args, ++index, arg));
    else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("--batch-size must be a positive integer");
  if (resolve(source) === resolve(target)) throw new Error("Recovery source and target must be different databases");
  return { source, target, dryRun, batchSize };
}

function readValue(args: string[], index: number, flag: string) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
