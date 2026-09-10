import { resolve } from "node:path";
import { getContextEngineConfig } from "../../config.js";
import { createEmbeddingClient } from "./embedding.js";
import { refreshFactIndexes } from "./indexing.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";

const config = getContextEngineConfig();
const storeFlag = process.argv.indexOf("--store-path");
const storePath = storeFlag >= 0 && process.argv[storeFlag + 1]
  ? resolve(config.projectRoot, process.argv[storeFlag + 1]!)
  : config.storage.storePath;
const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: true });

try {
  const facts = repository.getDebugSnapshot().facts;
  const entries = await refreshFactIndexes(repository, facts, createEmbeddingClient(config.embedding));
  process.stdout.write(`${JSON.stringify({
    storePath,
    factCount: facts.length,
    textIndexCount: entries.length,
    vectorIndexCount: entries.length,
    embeddingFingerprint: `${config.embedding.protocol}:${config.embedding.model}:${config.embedding.dimensions}`
  }, null, 2)}\n`);
} finally {
  repository.close();
}
