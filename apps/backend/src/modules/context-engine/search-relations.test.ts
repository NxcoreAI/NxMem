import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../../modules/health/server.js";
import type { LongTermMemory, RelationEdge, ShortTermMemory } from "./domain.js";
import { searchRelations } from "./search-relations.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("searchRelations finds edges by relation type and returns endpoint summaries", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm_relation_search", "短期记忆：用户刚更新了 PRD 关系检索要求。");
  const ltm = createLtm("ltm_relation_search", "长期记忆：PRD 需要支持记忆关系图谱。", [stm.memoryDataId]);
  const edge: RelationEdge = {
    edgeId: "edge_direct_relation_search",
    fromId: stm.memoryDataId,
    toId: ltm.memoryId,
    relationType: "derived_from",
    evidence: "direct relation search evidence",
    strength: 0.95,
    confidence: "high",
    source: "dreaming",
    createdAt: "2026-07-03T00:00:00.000Z"
  };

  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(ltm);
  await repository.saveRelationEdge(edge);

  const result = await searchRelations(repository, {
    relationTypes: ["derived_from"],
    q: "direct relation",
    limit: 10
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.edge.edgeId, edge.edgeId);
  assert.equal(result.items[0]?.edge.strength, 0.95);
  assert.equal(result.items[0]?.from?.id, stm.memoryDataId);
  assert.equal(result.items[0]?.from?.layer, "stm");
  assert.equal(result.items[0]?.to?.id, ltm.memoryId);
  assert.equal(result.items[0]?.to?.layer, "ltm");
  assert.equal(result.items[0]?.reason, "relation_type_match,evidence_match");
});

test("searchRelations filters inactive endpoints by default", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm_relation_hidden", "短期记忆：隐藏关系端点。");
  const ltm = {
    ...createLtm("ltm_relation_hidden", "长期记忆：已删除端点。", [stm.memoryDataId]),
    lifecycleStatus: "deleted" as const
  };
  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(ltm);
  await repository.saveRelationEdge({
    edgeId: "edge_relation_hidden",
    fromId: stm.memoryDataId,
    toId: ltm.memoryId,
    relationType: "related_to",
    evidence: "hidden endpoint"
  });

  const hidden = await searchRelations(repository, { relationTypes: ["related_to"] });
  const visible = await searchRelations(repository, { relationTypes: ["related_to"], includeInactive: true });

  assert.equal(hidden.total, 0);
  assert.equal(visible.total, 1);
});

test("GET /context/relations/search exposes direct relation search", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);
  const stm = createStm("stm_relation_route", "短期记忆：路由关系搜索。");
  const ltm = createLtm("ltm_relation_route", "长期记忆：路由关系搜索目标。", [stm.memoryDataId]);

  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(ltm);
  await repository.saveRelationEdge({
    edgeId: "edge_relation_route",
    fromId: stm.memoryDataId,
    toId: ltm.memoryId,
    relationType: "updates",
    evidence: "route evidence"
  });

  const response = await server.inject({
    method: "GET",
    url: "/context/relations/search?relationType=updates&q=route"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.total, 1);
  assert.equal(body.result.items[0].edge.edgeId, "edge_relation_route");

  await server.close();
});

function createStm(memoryDataId: string, content: string): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "manual_memory_event",
    memoryType: "project",
    content,
    factSummary: content.slice(0, 20),
    sourceFactIds: [`fact_${memoryDataId}`],
    sourceRefs: [{ sourceRefId: `src_${memoryDataId}`, sourceType: "file", sourceId: `source_${memoryDataId}` }],
    entityIds: ["entity_relation_search"],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "relation_search_test",
    matchedRules: ["relation_search_test"],
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

function createLtm(memoryId: string, content: string, sourceMemoryDataIds: string[]): LongTermMemory {
  return {
    memoryId,
    theoryClass: "semantic",
    memoryType: "knowledge",
    content,
    factSummary: content.slice(0, 20),
    sourceRefs: [{ sourceRefId: `src_${memoryId}`, sourceType: "file", sourceId: `source_${memoryId}` }],
    sourceMemoryDataIds,
    entityIds: ["entity_relation_search"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "relation_search_test",
    matchedRules: ["relation_search_test"],
    lifecycleStatus: "active",
    accessState: "visible"
  };
}
