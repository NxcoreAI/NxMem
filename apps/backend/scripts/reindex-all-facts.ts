import { getContextEngineConfig } from "../src/config.js";
import { createEmbeddingClient } from "../src/modules/context-engine/embedding.js";
import { refreshFactIndexes } from "../src/modules/context-engine/indexing.js";
import { SqliteContextEngineRepository } from "../src/modules/context-engine/persistence/memory-repository.js";

const config = getContextEngineConfig();
const storePath = "/Users/zyt/context-egine/data/longmemeval/9eb5b064fadc.sqlite";
const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
try {
  const db = (repository as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => { fact_id: string }[]; get: (...args: unknown[]) => { n: number } } } }).db;
  const total = db.prepare("SELECT COUNT(*) n FROM fact_items WHERE status != 'deleted'").get().n;
  console.log("total facts to index:", total);
  const chunk = 2000;
  let done = 0;
  let lastId = "";
  while (true) {
    const rows = db.prepare(
      "SELECT fact_id FROM fact_items WHERE status != 'deleted' AND fact_id > ? ORDER BY fact_id LIMIT ?"
    ).all(lastId, chunk);
    if (!rows.length) break;
    const ids = rows.map((row) => row.fact_id);
    lastId = ids[ids.length - 1]!;
    const facts = await repository.getFactItemsByIds(ids);
    await refreshFactIndexes(repository, facts, createEmbeddingClient(config.embedding));
    done += facts.length;
    if (done % 20000 === 0 || done >= total) console.log(`reindexed ${done}/${total}`);
  }
  console.log("done");
} finally {
  repository.close();
}
