import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTextIndexEntry } from "./indexing.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { reindexMemoryTextIndexes } from "./text-index-reindex.js";

test("SQLite text retrieval uses multilingual tokens and BM25 ranking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-text-bm25-"));
  const repository = new SqliteContextEngineRepository(join(directory, "context.sqlite"));
  try {
    const now = "2026-08-12T00:00:00.000Z";
    const entries = [
      {
        indexId: "idx_stm_exact",
        ownerId: "stm_exact",
        ownerType: "stm" as const,
        content: "深圳出差安排",
        tokenCount: 3,
        lifecycleStatus: "active",
        refreshedAt: now
      },
      {
        indexId: "idx_stm_noisy",
        ownerId: "stm_noisy",
        ownerType: "stm" as const,
        content: "北京项目安排涉及很多人员和会议，之后可能出差",
        tokenCount: 12,
        lifecycleStatus: "active",
        refreshedAt: now
      }
    ];
    for (const entry of entries) {
      await repository.saveShortTermMemory({
        memoryDataId: entry.ownerId,
        tenantId: "local",
        principalId: "bm25-test",
        memoryDataType: "event",
        content: entry.content,
        sourceFactIds: [],
        sourceRefs: [{ sourceRefId: `src_${entry.ownerId}`, sourceType: "file", sourceId: entry.ownerId }],
        entityIds: [],
        importanceLevel: "medium",
        confidenceLevel: "high",
        admissionResult: "write_short_term",
        admissionReason: "test",
        matchedRules: ["test"],
        admissionSignals: {
          importance: "medium",
          confidence: "high",
          freshness: "fresh",
          sensitivity: "low",
          actorWeight: "medium",
          conflict: "none",
          permission: "private"
        },
        lifecycleStatus: "active",
        createdAt: now,
        updatedAt: now
      });
      await repository.saveIndexEntry(entry);
      await repository.saveTextIndexEntry(buildTextIndexEntry(entry));
      await repository.upsertGraphMemoryNode({
        graphNodeId: `graph_${entry.ownerId}`,
        ownerId: entry.ownerId,
        ownerType: "stm",
        content: entry.content,
        vector: [1, 0],
        lifecycleStatus: "active",
        retrievalWeight: 0.5,
        sourceRefs: [],
        entityIds: [],
        refreshedAt: now
      });
    }

    const hits = repository.searchGraphText(["深圳", "出差", "安排"]);
    assert.equal(hits[0]?.ownerId, "stm_exact");
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
    assert.equal(repository.searchGraphText(["安"]).length, 0);

    const result = await reindexMemoryTextIndexes(repository);
    assert.deepEqual(result, { shortTermMemories: 2, longTermMemories: 0, total: 2 });
    assert.equal(repository.searchGraphText(["深圳"])[0]?.ownerId, "stm_exact");
  } finally {
    repository.close();
  }
});
