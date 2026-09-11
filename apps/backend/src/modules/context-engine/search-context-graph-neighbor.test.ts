import test from "node:test";
import assert from "node:assert/strict";
import { searchContext } from "./search-context.js";
import { refreshShortTermMemoryIndex } from "./indexing.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import type { ShortTermMemory } from "./domain.js";

const embeddingClient = createDeterministicTestEmbeddingClient(512);

async function saveStm(
  repository: InMemoryContextEngineRepository,
  memoryDataId: string,
  content: string
) {
  const memory: ShortTermMemory = {
    memoryDataId,
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "manual_memory_event",
    content,
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: `src_${memoryDataId}`, sourceType: "file", sourceId: `demo-${memoryDataId}` }],
    entityIds: [],
    importanceLevel: "medium",
    confidenceLevel: "medium",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["rule"],
    admissionSignals: {
      importance: "medium",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  };
  await repository.saveShortTermMemory(memory);
  await refreshShortTermMemoryIndex(repository, memory, embeddingClient);
}

const searchOptions = {
  embeddingClient,
  memoryReranker: false as const,
  recordRetrieval: false
};

test("graphNeighborRecall supplements neighbors of top-ranked memories without disturbing base ranking", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveStm(repository, "stm_seed", "用户在周五买了咖啡机");
  await saveStm(repository, "stm_seed_two", "用户喜欢浅烘咖啡豆");
  await saveStm(repository, "stm_neighbor", "用户后来把订单换成了燕麦拿铁");
  await repository.saveRelationEdge({
    edgeId: "edge_updates_seed",
    fromId: "stm_neighbor",
    toId: "stm_seed",
    relationType: "updates",
    strength: 0.9,
    confidence: "high"
  });

  const baseResponse = await searchContext(repository, { q: "咖啡" }, searchOptions);
  const baseIds = baseResponse.results.map((result) => result.id);
  assert.ok(baseIds.includes("stm_seed"));
  assert.ok(baseIds.includes("stm_seed_two"));
  assert.ok(!baseIds.includes("stm_neighbor"), "non-matching memory must stay hidden without the flag");

  const response = await searchContext(repository, { q: "咖啡", graphNeighborRecall: true }, searchOptions);
  const ids = response.results.map((result) => result.id);
  assert.ok(ids.includes("stm_neighbor"), "related neighbor should be recalled via relation edge");
  const neighbor = response.results.find((result) => result.id === "stm_neighbor")!;
  assert.equal(neighbor.reason, "graph_neighbor_recall");
  assert.equal(neighbor.scoreBreakdown.graph, 0.81);
  assert.ok(neighbor.relationEdges.some((edge) => edge.edgeId === "edge_updates_seed"));

  assert.deepEqual(
    ids.filter((id) => baseIds.includes(id)),
    baseIds,
    "base ranking membership and relative order must be preserved"
  );
});

test("graphNeighborRecall does not duplicate memories already covered by base ranking", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveStm(repository, "stm_seed", "用户在周五买了咖啡机");
  await saveStm(repository, "stm_seed_two", "用户喜欢浅烘咖啡豆");
  await repository.saveRelationEdge({
    edgeId: "edge_same_seed",
    fromId: "stm_seed",
    toId: "stm_seed_two",
    relationType: "is_same_as"
  });

  const response = await searchContext(repository, { q: "咖啡", graphNeighborRecall: true }, searchOptions);
  const seedHits = response.results.filter((result) => result.id === "stm_seed_two");
  assert.equal(seedHits.length, 1, "base-hit neighbor must appear exactly once");
  assert.notEqual(seedHits[0]!.reason, "graph_neighbor_recall");
});

test("graphNeighborRecall drops deleted neighbors instead of returning them", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveStm(repository, "stm_seed", "用户在周五买了咖啡机");
  await saveStm(repository, "stm_neighbor", "用户后来把订单换成了燕麦拿铁");
  await repository.saveRelationEdge({
    edgeId: "edge_updates_deleted_neighbor",
    fromId: "stm_neighbor",
    toId: "stm_seed",
    relationType: "updates",
    strength: 0.9,
    confidence: "high"
  });
  const snapshotMemory = repository.getDebugSnapshot().shortTermMemories.find((memory) => memory.memoryDataId === "stm_neighbor")!;
  await repository.saveShortTermMemory({ ...snapshotMemory, lifecycleStatus: "deleted" });

  const response = await searchContext(repository, { q: "咖啡", graphNeighborRecall: true }, searchOptions);
  assert.ok(!response.results.some((result) => result.id === "stm_neighbor"));
  assert.ok(response.dropped.some((item) => item.id === "stm_neighbor" && item.reason === "inactive_stm"));
});
