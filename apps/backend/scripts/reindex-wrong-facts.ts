import { readFileSync } from "node:fs";
import { getContextEngineConfig } from "../src/config.js";
import { createEmbeddingClient } from "../src/modules/context-engine/embedding.js";
import { refreshFactIndexes } from "../src/modules/context-engine/indexing.js";
import { SqliteContextEngineRepository } from "../src/modules/context-engine/persistence/memory-repository.js";

const config = getContextEngineConfig();
const storePath = "/Users/zyt/context-egine/data/longmemeval/9eb5b064fadc.sqlite";
const questionIds = readFileSync("/tmp/wrong90-ids.txt", "utf8").split(",").filter(Boolean);
const scopes = questionIds.map((id) => `longmemeval:${id}`);
const placeholders = scopes.map(() => "?").join(",");

const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
try {
  const db = (repository as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => { fact_id: string }[] } } }).db;
  const rows = db.prepare(
    `SELECT fact_id FROM fact_items WHERE context_scope_id IN (${placeholders}) AND status != 'deleted'`
  ).all(...scopes);
  const ids = rows.map((row) => row.fact_id);
  console.log("facts to index:", ids.length);
  const facts = await repository.getFactItemsByIds(ids);
  console.log("loaded via repository:", facts.length);
  const chunk = 2000;
  for (let i = 0; i < facts.length; i += chunk) {
    await refreshFactIndexes(repository, facts.slice(i, i + chunk), createEmbeddingClient(config.embedding));
    console.log(`reindexed ${Math.min(i + chunk, facts.length)}/${facts.length}`);
  }
  console.log("done");
} finally {
  repository.close();
}
