import { resolve } from "node:path";
import { getContextEngineConfig } from "../../config.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { reindexMemoryTextIndexes } from "./text-index-reindex.js";

const config = getContextEngineConfig();
const storeFlag = process.argv.indexOf("--store-path");
const storePath = storeFlag >= 0 && process.argv[storeFlag + 1]
  ? resolve(config.projectRoot, process.argv[storeFlag + 1]!)
  : config.storage.storePath;
const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: true });

try {
  const result = await reindexMemoryTextIndexes(repository, (processed, total) => {
    if (processed === total || processed % 100 === 0) process.stderr.write(`text reindex ${processed}/${total}\n`);
  });
  process.stdout.write(`${JSON.stringify({ storePath, ...result }, null, 2)}\n`);
} finally {
  repository.close();
}
