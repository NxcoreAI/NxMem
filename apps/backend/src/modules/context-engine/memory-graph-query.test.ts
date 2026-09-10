import test from "node:test";
import assert from "node:assert/strict";
import type { GraphMemoryNode, RelationEdge } from "./domain.js";
import {
  decodeMemoryGraphEdgeCursor,
  decodeMemoryGraphNodeCursor
} from "./memory-graph-query-contract.js";
import {
  MemoryGraphQueryServiceError,
  queryMemoryGraph
} from "./memory-graph-query.js";
import type {
  GraphMemoryNodePageQuery,
  GraphRelationEdgePageQuery
} from "./persistence/graph-store.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("queryMemoryGraph returns independent normalized node and edge pages", async () => {
  const repository = await createRepository();
  const response = await queryMemoryGraph(repository, {
    nodePage: { limit: 1 },
    edgePage: { limit: 1 }
  }, {
    now: () => new Date("2026-07-22T10:00:00.000Z")
  });

  assert.equal(response.schemaVersion, "memory-graph.v1");
  assert.equal(response.generatedAt, "2026-07-22T10:00:00.000Z");
  assert.equal(response.page, 1);
  assert.deepEqual(response.nodes?.items, [{
    id: "ltm_a",
    layer: "ltm",
    memoryType: "preference",
    content: "content:ltm_a",
    factSummary: "summary:ltm_a",
    lifecycleStatus: "active",
    retrievalWeight: 0.8,
    sourceRefs: [{ sourceRefId: "src_ltm_a", sourceType: "document", sourceId: "ltm_a" }],
    entityIds: ["entity_ltm_a"],
    evidenceTimeStart: "2026-07-20T08:00:00.000Z",
    evidenceTimeEnd: "2026-07-20T08:00:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-08-01T00:00:00.000Z",
    validTimeEnd: "2026-08-02T00:00:00.000Z",
    validTimeConfidence: "medium",
    refreshedAt: "2026-07-22T08:00:00.000Z"
  }]);
  assert.equal(response.nodes?.hasMore, true);
  assert.deepEqual(
    decodeMemoryGraphNodeCursor(response.nodes!.nextCursor!, ["stm", "ltm"]),
    { layer: "ltm", id: "ltm_a" }
  );
  assert.deepEqual(response.edges?.items, [{
    id: "edge_01",
    from: "ltm_a",
    to: "stm_a",
    type: "supports",
    evidence: "test evidence",
    strength: 0.9,
    confidence: "high",
    source: "rule",
    createdAt: "2026-07-22T09:00:00.000Z"
  }]);
  assert.equal(response.edges?.hasMore, true);
  assert.deepEqual(
    decodeMemoryGraphEdgeCursor(
      response.edges!.nextCursor!,
      ["stm", "ltm"],
      [
        "is_same_as",
        "alias_of",
        "derived_from",
        "supports",
        "conflicts_with",
        "same_source",
        "updates",
        "related_to",
        "part_of"
      ]
    ),
    { id: "edge_01" }
  );
  assert.equal("graphNodeId" in response.nodes!.items[0]!, false);
  assert.equal("vector" in response.nodes!.items[0]!, false);
  assert.equal("embedding" in response.nodes!.items[0]!, false);
});

test("queryMemoryGraph applies one page number with independent limits", async () => {
  const repository = new CountingRepository();
  await seedRepository(repository);
  const response = await queryMemoryGraph(repository, {
    page: 2,
    nodePage: { limit: 1 },
    edgePage: { limit: 1 }
  });

  assert.equal(response.page, 2);
  assert.deepEqual(response.nodes?.items.map((node) => node.id), ["stm_a"]);
  assert.equal(response.nodes?.hasMore, true);
  assert.deepEqual(response.edges?.items.map((edge) => edge.id), ["edge_02"]);
  assert.equal(response.edges?.hasMore, false);
  assert.equal(repository.nodeQueries[0]?.offset, 1);
  assert.equal(repository.edgeQueries[0]?.offset, 1);
});

test("queryMemoryGraph stops querying a null page side", async () => {
  const repository = new CountingRepository();
  await seedRepository(repository);
  const first = await queryMemoryGraph(repository, {
    nodePage: { limit: 1 },
    edgePage: null
  });
  const second = await queryMemoryGraph(repository, {
    nodePage: { limit: 1, cursor: first.nodes?.nextCursor },
    edgePage: null
  });

  assert.equal(repository.nodeQueries.length, 2);
  assert.equal(repository.edgeQueries.length, 0);
  assert.equal(second.page, undefined);
  assert.deepEqual(second.nodes?.items.map((node) => node.id), ["stm_a"]);
  assert.equal(second.edges, null);
});

test("queryMemoryGraph wraps graph store failures without leaking their message", async () => {
  const repository = new FailingRepository();
  await assert.rejects(
    () => queryMemoryGraph(repository, { nodePage: {}, edgePage: {} }),
    (error) => error instanceof MemoryGraphQueryServiceError &&
      error.code === "MEMORY_GRAPH_QUERY_FAILED" &&
      !error.message.includes("database-password")
  );
});

class CountingRepository extends InMemoryContextEngineRepository {
  readonly nodeQueries: GraphMemoryNodePageQuery[] = [];
  readonly edgeQueries: GraphRelationEdgePageQuery[] = [];

  override listGraphMemoryNodes(query: GraphMemoryNodePageQuery) {
    this.nodeQueries.push(query);
    return super.listGraphMemoryNodes(query);
  }

  override listGraphRelationEdges(query: GraphRelationEdgePageQuery) {
    this.edgeQueries.push(query);
    return super.listGraphRelationEdges(query);
  }
}

class FailingRepository extends InMemoryContextEngineRepository {
  override listGraphMemoryNodes(_query: GraphMemoryNodePageQuery): never {
    throw new Error("database-password=secret");
  }
}

async function createRepository() {
  const repository = new InMemoryContextEngineRepository();
  await seedRepository(repository);
  return repository;
}

async function seedRepository(repository: InMemoryContextEngineRepository) {
  for (const node of [
    createNode("stm", "stm_b"),
    createNode("ltm", "ltm_a", { memoryType: "preference", factSummary: "summary:ltm_a" }),
    createNode("stm", "stm_a")
  ]) {
    await repository.upsertGraphMemoryNode(node);
  }
  for (const edge of [
    createEdge("edge_02", "stm_a", "stm_b", "updates"),
    createEdge("edge_01", "ltm_a", "stm_a", "supports", {
      evidence: "test evidence",
      strength: 0.9,
      confidence: "high",
      source: "rule",
      createdAt: "2026-07-22T09:00:00.000Z"
    })
  ]) {
    await repository.saveRelationEdge(edge);
  }
}

function createNode(
  ownerType: GraphMemoryNode["ownerType"],
  ownerId: string,
  optional: Pick<GraphMemoryNode, "memoryType" | "factSummary"> = {}
): GraphMemoryNode {
  return {
    graphNodeId: `graph_${ownerId}`,
    ownerType,
    ownerId,
    content: `content:${ownerId}`,
    vector: [0.1, 0.2],
    lifecycleStatus: "active",
    retrievalWeight: 0.8,
    sourceRefs: [{ sourceRefId: `src_${ownerId}`, sourceType: "document", sourceId: ownerId }],
    entityIds: [`entity_${ownerId}`],
    evidenceTimeStart: "2026-07-20T08:00:00.000Z",
    evidenceTimeEnd: "2026-07-20T08:00:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-08-01T00:00:00.000Z",
    validTimeEnd: "2026-08-02T00:00:00.000Z",
    validTimeConfidence: "medium",
    refreshedAt: "2026-07-22T08:00:00.000Z",
    ...optional
  };
}

function createEdge(
  edgeId: string,
  fromId: string,
  toId: string,
  relationType: RelationEdge["relationType"],
  optional: Omit<RelationEdge, "edgeId" | "fromId" | "toId" | "relationType"> = {}
): RelationEdge {
  return { edgeId, fromId, toId, relationType, ...optional };
}
