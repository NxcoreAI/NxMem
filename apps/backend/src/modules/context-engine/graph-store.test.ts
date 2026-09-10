import test from "node:test";
import assert from "node:assert/strict";
import type {
  GraphMemoryNode,
  GraphMemoryOwnerType,
  GraphMemorySearchHit,
  GraphMemorySearchOptions,
  LongTermMemory,
  MemoryEvent,
  RelationEdge,
  ShortTermMemory
} from "./domain.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { parseAndAdmitEvent } from "./parse-event.js";
import { searchContext } from "./search-context.js";
import {
  memoryOwnerTypeForId,
  ownerKey,
  type GraphMemoryNodePageQuery,
  type GraphMemoryStore,
  type GraphRelationEdgePageQuery,
  type GraphRelationSearchQuery
} from "./persistence/graph-store.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { getContextEngineConfig } from "../../config.js";

test("refreshing STM and LTM indexes synchronizes graph memory nodes", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm({
    memoryDataId: "stm_graph_sync",
    content: "Graph sync short term memory",
    sourceRefId: "src_graph_sync",
    entityIds: ["entity_graph_sync"]
  });
  const ltm = createLtm({
    memoryId: "ltm_graph_sync",
    content: "Graph sync long term memory",
    sourceMemoryDataIds: [stm.memoryDataId],
    sourceRefId: "src_graph_sync",
    entityIds: ["entity_graph_sync"]
  });

  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(ltm);
  await refreshShortTermMemoryIndex(repository, stm);
  await refreshLongTermMemoryIndex(repository, ltm);

  const nodes = repository.getDebugSnapshot().graphMemoryNodes;
  const stmNode = nodes.find((node) => node.ownerType === "stm" && node.ownerId === stm.memoryDataId);
  const ltmNode = nodes.find((node) => node.ownerType === "ltm" && node.ownerId === ltm.memoryId);
  const expectedDimensions = getContextEngineConfig().embedding.dimensions;

  assert.ok(stmNode);
  assert.equal(stmNode.content, stm.content);
  assert.deepEqual(stmNode.sourceRefs, stm.sourceRefs);
  assert.deepEqual(stmNode.entityIds, stm.entityIds);
  assert.equal(stmNode.vector.length, expectedDimensions);
  assert.ok(ltmNode);
  assert.equal(ltmNode.content, ltm.content);
  assert.deepEqual(ltmNode.sourceRefs, ltm.sourceRefs);
  assert.deepEqual(ltmNode.entityIds, ltm.entityIds);
  assert.equal(ltmNode.vector.length, expectedDimensions);
});

test("search_context gets graph text and vector candidates from graph store", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm({
    memoryDataId: "stm_graph_search",
    content: "graph database full text memory alpha",
    sourceRefId: "src_graph_search",
    entityIds: ["entity_graph_search"]
  });
  await repository.saveShortTermMemory(stm);
  await refreshShortTermMemoryIndex(repository, stm);

  const textHits = await repository.searchGraphText(["alpha"]);
  const vectorHits = await repository.searchGraphVector(repository.getDebugSnapshot().graphMemoryNodes[0]?.vector ?? []);
  const search = await searchContext(repository, { q: "alpha" });

  assert.equal(textHits.some((hit) => hit.ownerType === "stm" && hit.ownerId === stm.memoryDataId), true);
  assert.equal(vectorHits.some((hit) => hit.ownerType === "stm" && hit.ownerId === stm.memoryDataId), true);
  assert.equal(search.results.some((result) => result.id === stm.memoryDataId), true);
});

test("search_context relation edges come from graph relation neighborhood", async () => {
  const repository = new EdgeOverrideRepository();
  const stm = createStm({
    memoryDataId: "stm_graph_neighbor",
    content: "graph neighbor relation lookup",
    sourceRefId: "src_graph_neighbor",
    entityIds: ["entity_graph_neighbor"]
  });
  const edge: RelationEdge = {
    edgeId: "edge_graph_neighbor",
    fromId: stm.memoryDataId,
    toId: "ltm_graph_neighbor",
    relationType: "related_to",
    evidence: "test edge"
  };

  await repository.saveShortTermMemory(stm);
  await refreshShortTermMemoryIndex(repository, stm);
  await repository.saveRelationEdge(edge);

  const search = await searchContext(repository, { q: "neighbor" });

  assert.equal(repository.graphRelationLookups.includes(stm.memoryDataId), true);
  assert.deepEqual(search.results.find((result) => result.id === stm.memoryDataId)?.relationEdges, [edge]);
});

test("parseAndAdmitEvent creates graph-store STM relation edges after graph nodes exist", async () => {
  const graphStore = new Neo4jLikeGraphStore();
  const repository = new InMemoryContextEngineRepository(graphStore);
  const source = { sourceRefId: "src_parse_graph_edges", sourceType: "file", sourceId: "parse-graph-edges" };

  await parseAndAdmitEvent(repository, createMemoryEvent("parse_graph_edges_1", "用户偏好回答直接", source), undefined, {
    disableFactFusionLlm: true,
    disableStmAdmissionLlm: true
  });
  await parseAndAdmitEvent(repository, createMemoryEvent("parse_graph_edges_2", "用户偏好回答直接并带例子", source), undefined, {
    disableFactFusionLlm: true,
    disableStmAdmissionLlm: true
  });

  const snapshot = repository.getDebugSnapshot();
  const firstStmId = snapshot.shortTermMemories.find((memory) => memory.sourceFactIds.some((factId) => factId.includes("parse_graph_edges_1")))?.memoryDataId;
  const secondStmId = snapshot.shortTermMemories.find((memory) => memory.sourceFactIds.some((factId) => factId.includes("parse_graph_edges_2")))?.memoryDataId;
  assert.ok(firstStmId);
  assert.ok(secondStmId);
  assert.ok(graphStore.edges.some((edge) =>
    edge.fromId === firstStmId &&
    edge.toId === secondStmId &&
    edge.relationType === "same_source"
  ));
});

class EdgeOverrideRepository extends InMemoryContextEngineRepository {
  readonly graphRelationLookups: string[] = [];

  override getGraphRelationEdges(ownerId: string): RelationEdge[] {
    this.graphRelationLookups.push(ownerId);
    return this.relationEdges.filter((edge) => edge.fromId === ownerId || edge.toId === ownerId);
  }
}

class Neo4jLikeGraphStore implements GraphMemoryStore {
  readonly nodes = new Map<string, GraphMemoryNode>();
  readonly edges: RelationEdge[] = [];

  upsertGraphMemoryNode(node: GraphMemoryNode) {
    this.nodes.set(ownerKey(node.ownerType, node.ownerId), node);
  }

  deleteGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string) {
    const key = ownerKey(ownerType, ownerId);
    this.nodes.delete(key);
    const ownerEdgeIndex = (edge: RelationEdge) =>
      ownerKey(memoryOwnerTypeForId(edge.fromId)!, edge.fromId) === key ||
      ownerKey(memoryOwnerTypeForId(edge.toId)!, edge.toId) === key;
    for (let index = this.edges.length - 1; index >= 0; index -= 1) {
      if (ownerEdgeIndex(this.edges[index]!)) this.edges.splice(index, 1);
    }
  }

  upsertGraphRelationEdge(edge: RelationEdge) {
    const fromOwnerType = memoryOwnerTypeForId(edge.fromId);
    const toOwnerType = memoryOwnerTypeForId(edge.toId);
    if (!fromOwnerType || !toOwnerType) return;
    if (!this.nodes.has(ownerKey(fromOwnerType, edge.fromId))) return;
    if (!this.nodes.has(ownerKey(toOwnerType, edge.toId))) return;
    const index = this.edges.findIndex((item) => item.edgeId === edge.edgeId);
    if (index >= 0) this.edges[index] = edge;
    else this.edges.push(edge);
  }

  deleteGraphRelationEdges(edgeIds: string[]) {
    const ids = new Set(edgeIds);
    for (let index = this.edges.length - 1; index >= 0; index -= 1) {
      if (ids.has(this.edges[index]!.edgeId)) this.edges.splice(index, 1);
    }
  }

  clearGraph() {
    this.nodes.clear();
    this.edges.splice(0);
  }

  searchGraphText(_queryTokens: string[], _options?: GraphMemorySearchOptions): GraphMemorySearchHit[] {
    return [];
  }

  searchGraphVector(_queryVector: number[], _options?: GraphMemorySearchOptions): GraphMemorySearchHit[] {
    return [];
  }

  getGraphRelationEdges(ownerId: string): RelationEdge[] {
    return this.edges.filter((edge) => edge.fromId === ownerId || edge.toId === ownerId);
  }

  searchGraphRelationEdges(_query: GraphRelationSearchQuery): RelationEdge[] {
    return this.edges;
  }

  listGraphMemoryNodes(query: GraphMemoryNodePageQuery) {
    const rows = [...this.nodes.values()]
      .filter((node) => query.ownerTypes.includes(node.ownerType))
      .filter((node) => !query.after || node.ownerType > query.after.layer ||
        (node.ownerType === query.after.layer && node.ownerId > query.after.id))
      .sort((left, right) => left.ownerType.localeCompare(right.ownerType) || left.ownerId.localeCompare(right.ownerId))
      .slice(0, query.limit + 1);
    return { nodes: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }

  listGraphRelationEdges(query: GraphRelationEdgePageQuery) {
    const rows = this.edges
      .filter((edge) => {
        const fromOwnerType = memoryOwnerTypeForId(edge.fromId);
        const toOwnerType = memoryOwnerTypeForId(edge.toId);
        return Boolean(fromOwnerType && toOwnerType &&
          query.ownerTypes.includes(fromOwnerType) && query.ownerTypes.includes(toOwnerType));
      })
      .filter((edge) => query.relationTypes.includes(edge.relationType))
      .filter((edge) => !query.after || edge.edgeId > query.after.id)
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId))
      .slice(0, query.limit + 1);
    return { edges: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }
}

function createMemoryEvent(
  eventId: string,
  content: string,
  source: { sourceRefId: string; sourceType: string; sourceId: string }
): MemoryEvent {
  return {
    eventId,
    eventType: "agent_context_memory_event",
    eventDescription: "graph edge ordering test",
    eventTime: "2026-06-30T08:00:00.000Z",
    sourceApp: "test",
    sourceId: source.sourceId,
    permissionSnapshot: {
      snapshotId: `ps_${eventId}`,
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{ itemId: `item_${eventId}`, type: "text", format: "plain", content }],
    sourceRefs: [source]
  };
}

function createStm(input: {
  memoryDataId: string;
  content: string;
  sourceRefId: string;
  entityIds: string[];
}): ShortTermMemory {
  return {
    memoryDataId: input.memoryDataId,
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "manual_memory_event",
    content: input.content,
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: input.sourceRefId, sourceType: "file", sourceId: input.sourceRefId }],
    entityIds: input.entityIds,
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "graph_store_test",
    matchedRules: ["graph_store_test"],
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

function createLtm(input: {
  memoryId: string;
  content: string;
  sourceMemoryDataIds: string[];
  sourceRefId: string;
  entityIds: string[];
}): LongTermMemory {
  return {
    memoryId: input.memoryId,
    theoryClass: "semantic",
    memoryType: "profile",
    content: input.content,
    summary: input.content,
    sourceRefs: [{ sourceRefId: input.sourceRefId, sourceType: "file", sourceId: input.sourceRefId }],
    sourceMemoryDataIds: input.sourceMemoryDataIds,
    entityIds: input.entityIds,
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "graph_store_test",
    matchedRules: ["graph_store_test"],
    lifecycleStatus: "active",
    accessState: "visible"
  };
}
