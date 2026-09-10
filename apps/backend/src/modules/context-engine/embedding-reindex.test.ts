import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getContextEngineConfig, type ContextEngineConfig } from "../../config.js";
import type { LongTermMemory, ShortTermMemory } from "./domain.js";
import type { EmbeddingClient } from "./embedding.js";
import { reindexConfiguredRepositoryEmbeddings } from "./embedding-reindex.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { searchContext } from "./search-context.js";

test("embedding reindex preserves memories and text indexes while replacing 512-dimensional vectors with 1024-dimensional vectors", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm();
  const ltm = createLtm(stm.memoryDataId);
  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(ltm);
  await refreshShortTermMemoryIndex(repository, stm, fixedEmbeddingClient(512));
  await refreshLongTermMemoryIndex(repository, ltm, fixedEmbeddingClient(512));
  const before = repository.getDebugSnapshot();
  const textIndexCount = before.textIndexEntries.length;
  assert.equal(before.vectorIndexEntries.every((entry) => entry.vector.length === 512), true);

  const progress: number[] = [];
  const result = await reindexConfiguredRepositoryEmbeddings({
    repository,
    config: configWithDimensions(1024),
    embeddingClient: fixedEmbeddingClient(1024),
    onProgress: (item) => progress.push(item.processed)
  });

  const after = repository.getDebugSnapshot();
  assert.equal(after.shortTermMemories[0]?.content, stm.content);
  assert.equal(after.longTermMemories[0]?.content, ltm.content);
  assert.equal(after.textIndexEntries.length, textIndexCount);
  assert.equal(after.vectorIndexEntries.length, 2);
  assert.equal(after.vectorIndexEntries.every((entry) => entry.vector.length === 1024), true);
  assert.equal(after.graphMemoryNodes.every((node) => node.vector.length === 1024), true);
  assert.deepEqual(progress, [1, 2]);
  assert.deepEqual(result, {
    fingerprint: "fake:1024",
    dimensions: 1024,
    shortTermMemories: 1,
    longTermMemories: 1,
    vectorEntries: 2
  });
});

test("embedding reindex loads every eligible memory from an existing SQLite store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embedding-reindex-sqlite-"));
  const storePath = join(directory, "context-store.sqlite");
  const stm = createStm();
  const ltm = createLtm(stm.memoryDataId);
  const source = new SqliteContextEngineRepository(storePath);
  await source.saveShortTermMemory(stm);
  await source.saveLongTermMemory(ltm);
  await refreshShortTermMemoryIndex(source, stm, fixedEmbeddingClient(512));
  await refreshLongTermMemoryIndex(source, ltm, fixedEmbeddingClient(512));
  source.close();

  const result = await reindexConfiguredRepositoryEmbeddings({
    config: configWithDimensions(1024, storePath),
    embeddingClient: fixedEmbeddingClient(1024)
  });

  const reopened = new SqliteContextEngineRepository(storePath);
  const snapshot = reopened.getDebugSnapshot();
  reopened.close();
  const database = new DatabaseSync(storePath, { readOnly: true });
  const persistedVectors = database.prepare("SELECT vector FROM context_vector_index_entries ORDER BY index_id").all() as Array<{ vector: string }>;
  database.close();
  assert.equal(result.shortTermMemories, 1);
  assert.equal(result.longTermMemories, 1);
  assert.equal(result.vectorEntries, 2);
  assert.equal(snapshot.shortTermMemories[0]?.content, stm.content);
  assert.equal(snapshot.longTermMemories[0]?.content, ltm.content);
  assert.equal(persistedVectors.every((entry) => (JSON.parse(entry.vector) as number[]).length === 1024), true);
  assert.equal(snapshot.graphMemoryNodes.every((node) => node.vector.length === 1024), true);
});

test("indexing and querying share configured 512, 1024, and 1536 dimensional clients", async () => {
  for (const dimensions of [512, 1024, 1536]) {
    const repository = new InMemoryContextEngineRepository();
    const stm = createStm();
    const client = fixedEmbeddingClient(dimensions);
    await repository.saveShortTermMemory(stm);
    await refreshShortTermMemoryIndex(repository, stm, client);

    const response = await searchContext(repository, { q: "玻璃动物园", limit: 5 }, { embeddingClient: client });
    const snapshot = repository.getDebugSnapshot();
    assert.equal(snapshot.vectorIndexEntries[0]?.vector.length, dimensions);
    assert.equal(snapshot.graphMemoryNodes[0]?.vector.length, dimensions);
    assert.equal(response.results.some((item) => item.id === stm.memoryDataId), true);
  }
});

test("embedding reindex validates a complete batch before replacing any vectors", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm();
  const ltm = createLtm(stm.memoryDataId);
  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(ltm);
  await refreshShortTermMemoryIndex(repository, stm, fixedEmbeddingClient(512));
  await refreshLongTermMemoryIndex(repository, ltm, fixedEmbeddingClient(512));

  await assert.rejects(reindexConfiguredRepositoryEmbeddings({
    repository,
    config: { ...configWithDimensions(1024), embedding: { ...configWithDimensions(1024).embedding, batchSize: 2 } },
    embeddingClient: {
      dimensions: 1024,
      fingerprint: "invalid-batch",
      async embed(inputs) {
        return inputs.map((input, index) => ({
          input,
          embedding: Array(index === 0 ? 1024 : 512).fill(0),
          source: "remote" as const
        }));
      }
    }
  }), /batch dimension mismatch/);

  assert.equal(repository.getDebugSnapshot().vectorIndexEntries.every((entry) => entry.vector.length === 512), true);
});

function configWithDimensions(dimensions: number, storePath?: string): ContextEngineConfig {
  const base = getContextEngineConfig();
  return {
    ...base,
    embedding: {
      ...base.embedding,
      dimensions,
      batchSize: 1
    },
    storage: storePath ? { storePath } : base.storage,
    graphStore: {
      ...base.graphStore,
      neo4j: { ...base.graphStore.neo4j, vectorDimensions: dimensions }
    },
    longMemEval: {
      ...base.longMemEval,
      graphStore: {
        ...base.longMemEval.graphStore,
        neo4j: { ...base.longMemEval.graphStore.neo4j, vectorDimensions: dimensions }
      }
    }
  };
}

function fixedEmbeddingClient(dimensions: number): EmbeddingClient {
  return {
    dimensions,
    fingerprint: `fake:${dimensions}`,
    async embed(inputs) {
      return inputs.map((input) => ({
        input,
        embedding: Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0),
        source: "remote" as const
      }));
    }
  };
}

function createStm(): ShortTermMemory {
  return {
    memoryDataId: "stm_embedding_reindex",
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "manual_memory_event",
    memoryType: "fact",
    content: "用户观看了玻璃动物园",
    sourceFactIds: ["fact_embedding_reindex"],
    sourceRefs: [{ sourceRefId: "src_embedding_reindex", sourceType: "file", sourceId: "embedding-reindex" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "embedding_reindex_test",
    matchedRules: ["embedding_reindex_test"],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible"
  };
}

function createLtm(sourceMemoryDataId: string): LongTermMemory {
  return {
    memoryId: "ltm_embedding_reindex",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "用户喜欢社区剧院",
    summary: "用户喜欢社区剧院",
    sourceRefs: [{ sourceRefId: "src_embedding_reindex", sourceType: "file", sourceId: "embedding-reindex" }],
    sourceMemoryDataIds: [sourceMemoryDataId],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "embedding_reindex_test",
    matchedRules: ["embedding_reindex_test"],
    lifecycleStatus: "active",
    accessState: "visible"
  };
}
