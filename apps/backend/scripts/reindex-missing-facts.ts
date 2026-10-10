import { getContextEngineConfig } from "../src/config.js";
import { createEmbeddingClient } from "../src/modules/context-engine/embedding.js";
import { refreshFactIndexes } from "../src/modules/context-engine/indexing.js";
import { SqliteContextEngineRepository } from "../src/modules/context-engine/persistence/memory-repository.js";

const config = getContextEngineConfig();
const storePath = "/Users/zyt/context-egine/data/longmemeval/9eb5b064fadc.sqlite";
const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
try {
  const db = (repository as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => { fact_id: string }[] }; exec: (sql: string) => void } }).db;
  db.exec("PRAGMA synchronous=NORMAL");
  const rows = db.prepare(`
    SELECT f.fact_id FROM fact_items f
    WHERE f.status != 'deleted' AND NOT EXISTS (
      SELECT 1 FROM context_vector_index_entries v
      WHERE v.owner_type = 'fact' AND v.owner_id = f.fact_id
    ) ORDER BY f.fact_id`).all();
  console.log("facts missing index:", rows.length);
  const chunk = 2000;
  for (let i = 0; i < rows.length; i += chunk) {
    const ids = rows.slice(i, i + chunk).map((row) => row.fact_id);
    const facts = await repository.getFactItemsByIds(ids);
    db.exec("BEGIN IMMEDIATE");
    try {
      await refreshFactIndexes(repository, facts, createEmbeddingClient(config.embedding));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log(`reindexed ${Math.min(i + chunk, rows.length)}/${rows.length}`);
  }
  console.log("done");
} finally {
  repository.close();
}
