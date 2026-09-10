import test from "node:test";
import assert from "node:assert/strict";
import fastify, { type FastifyInstance } from "fastify";
import type { GraphMemoryNode, RelationEdge } from "./domain.js";
import {
  MEMORY_GRAPH_PAGE_LIMITS,
  MEMORY_GRAPH_RELATION_TYPES,
  type MemoryGraphQueryErrorResponse,
  type MemoryGraphQueryResponse
} from "./memory-graph-query-contract.js";
import type { GraphRelationEdgePageQuery } from "./persistence/graph-store.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { registerContextEngineRoutes } from "./routes.js";
import { createContextEngineService } from "./write-event.js";

test("4.1 route returns an empty graph with default page settings", async () => {
  const server = createTestServer(new NoDebugSnapshotRepository());
  try {
    const response = await requestGraph(server, { nodePage: {}, edgePage: {} });

    assert.equal(response.statusCode, 200);
    const body = response.json() as MemoryGraphQueryResponse;
    assert.equal(body.ok, true);
    assert.equal(body.schemaVersion, "memory-graph.v1");
    assert.equal(typeof body.generatedAt, "string");
    assert.equal(body.page, 1);
    assert.deepEqual(body.nodes, {
      items: [],
      limit: MEMORY_GRAPH_PAGE_LIMITS.node.default,
      nextCursor: null,
      hasMore: false
    });
    assert.deepEqual(body.edges, {
      items: [],
      limit: MEMORY_GRAPH_PAGE_LIMITS.edge.default,
      nextCursor: null,
      hasMore: false
    });
  } finally {
    await server.close();
  }
});

test("4.1 route returns STM, LTM, every relation type and optional fields", async () => {
  const repository = new InMemoryContextEngineRepository();
  await seedCompleteGraph(repository);
  const server = createTestServer(repository);
  try {
    const response = await requestGraph(server, { nodePage: {}, edgePage: {} });

    assert.equal(response.statusCode, 200);
    const body = response.json() as MemoryGraphQueryResponse;
    assert.deepEqual(body.nodes?.items.map((node) => node.layer), ["ltm", "stm", "stm"]);
    assert.deepEqual(body.edges?.items.map((edge) => edge.type), [...MEMORY_GRAPH_RELATION_TYPES]);
    const ltm = body.nodes?.items.find((node) => node.id === "ltm_a");
    assert.equal(ltm?.memoryType, "preference");
    assert.equal(ltm?.factSummary, "summary:ltm_a");
    assert.deepEqual(ltm?.sourceRefs, [{
      sourceRefId: "src_ltm_a",
      sourceType: "document",
      sourceId: "ltm_a",
      sourceUrl: "https://example.test/ltm_a"
    }]);
    assert.equal("graphNodeId" in (ltm ?? {}), false);
    assert.equal("vector" in (ltm ?? {}), false);
    assert.equal("embedding" in (ltm ?? {}), false);
    assert.deepEqual(body.edges?.items[0], {
      id: "edge_00_is_same_as",
      from: "stm_a",
      to: "ltm_a",
      type: "is_same_as",
      evidence: "optional edge evidence",
      strength: 0.95,
      confidence: "high",
      source: "rule",
      createdAt: "2026-07-22T09:00:00.000Z"
    });
  } finally {
    await server.close();
  }
});

test("4.2 independently traverses every stable node and edge page", async () => {
  const repository = new CountingRepository();
  await seedPagingGraph(repository);
  const server = createTestServer(repository);
  try {
    const nodeIds: string[] = [];
    const edgeIds: string[] = [];
    let nodeCursor: string | null = null;
    let edgeCursor: string | null = null;
    let queryNodes = true;
    let queryEdges = true;
    let sawNodeOnlyRequest = false;

    for (let pageIndex = 0; pageIndex < 10 && (queryNodes || queryEdges); pageIndex += 1) {
      if (queryNodes && !queryEdges) sawNodeOnlyRequest = true;
      const response = await requestGraph(server, {
        nodePage: queryNodes ? { limit: 1, cursor: nodeCursor } : null,
        edgePage: queryEdges ? { limit: 1, cursor: edgeCursor } : null
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as MemoryGraphQueryResponse;

      if (queryNodes) {
        assert.ok(body.nodes);
        assert.equal(body.nodes.items.length <= 1, true);
        nodeIds.push(...body.nodes.items.map((node) => node.id));
        queryNodes = body.nodes.hasMore;
        nodeCursor = body.nodes.nextCursor;
      } else {
        assert.equal(body.nodes, null);
      }
      if (queryEdges) {
        assert.ok(body.edges);
        assert.equal(body.edges.items.length <= 1, true);
        edgeIds.push(...body.edges.items.map((edge) => edge.id));
        queryEdges = body.edges.hasMore;
        edgeCursor = body.edges.nextCursor;
      } else {
        assert.equal(body.edges, null);
      }
    }

    assert.equal(queryNodes, false);
    assert.equal(queryEdges, false);
    assert.equal(sawNodeOnlyRequest, true);
    assert.deepEqual(nodeIds, ["ltm_a", "ltm_b", "stm_a", "stm_b"]);
    assert.deepEqual(edgeIds, ["edge_01", "edge_02"]);
    assert.equal(new Set(nodeIds).size, nodeIds.length);
    assert.equal(new Set(edgeIds).size, edgeIds.length);
    assert.equal(repository.nodeQueries.length, 4);
    assert.equal(repository.edgeQueries.length, 2);

    const maximums = await requestGraph(server, {
      nodePage: { limit: MEMORY_GRAPH_PAGE_LIMITS.node.max },
      edgePage: { limit: MEMORY_GRAPH_PAGE_LIMITS.edge.max }
    });
    assert.equal(maximums.statusCode, 200);
    const maximumBody = maximums.json() as MemoryGraphQueryResponse;
    assert.equal(maximumBody.nodes?.limit, MEMORY_GRAPH_PAGE_LIMITS.node.max);
    assert.equal(maximumBody.edges?.limit, MEMORY_GRAPH_PAGE_LIMITS.edge.max);
  } finally {
    await server.close();
  }
});

test("4.2 applies one page number with independent node and edge limits", async () => {
  const repository = new InMemoryContextEngineRepository();
  await seedPagingGraph(repository);
  const server = createTestServer(repository);
  try {
    const response = await requestGraph(server, {
      page: 2,
      nodePage: { limit: 1 },
      edgePage: { limit: 1 }
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as MemoryGraphQueryResponse;
    assert.equal(body.page, 2);
    assert.deepEqual(body.nodes?.items.map((node) => node.id), ["ltm_b"]);
    assert.equal(body.nodes?.hasMore, true);
    assert.deepEqual(body.edges?.items.map((edge) => edge.id), ["edge_02"]);
    assert.equal(body.edges?.hasMore, false);

    const lastNodePage = await requestGraph(server, {
      page: 4,
      nodePage: { limit: 1 },
      edgePage: null
    });
    assert.equal(lastNodePage.statusCode, 200);
    const lastNodeBody = lastNodePage.json() as MemoryGraphQueryResponse;
    assert.equal(lastNodeBody.page, 4);
    assert.deepEqual(lastNodeBody.nodes?.items.map((node) => node.id), ["stm_b"]);
    assert.equal(lastNodeBody.nodes?.hasMore, false);
    assert.equal(lastNodeBody.edges, null);
  } finally {
    await server.close();
  }
});

test("4.3 applies layer and relation filters", async () => {
  const repository = new InMemoryContextEngineRepository();
  await seedFilterGraph(repository);
  const server = createTestServer(repository);
  try {
    const stmOnly = await requestGraph(server, {
      layers: ["stm"],
      relationTypes: ["conflicts_with", "updates"],
      nodePage: { limit: 10 },
      edgePage: { limit: 10 }
    });
    assert.equal(stmOnly.statusCode, 200);
    const stmBody = stmOnly.json() as MemoryGraphQueryResponse;
    assert.deepEqual(stmBody.nodes?.items.map((node) => node.id), ["stm_a", "stm_b"]);
    assert.deepEqual(stmBody.edges?.items.map((edge) => edge.id), ["edge_01"]);

    const supportsOnly = await requestGraph(server, {
      layers: ["stm", "ltm"],
      relationTypes: ["supports"],
      nodePage: null,
      edgePage: { limit: 10 }
    });
    assert.equal(supportsOnly.statusCode, 200);
    const supportsBody = supportsOnly.json() as MemoryGraphQueryResponse;
    assert.equal(supportsBody.nodes, null);
    assert.deepEqual(supportsBody.edges?.items.map((edge) => edge.id), ["edge_03"]);
  } finally {
    await server.close();
  }
});

test("4.3 rejects wrong cursor types, filter changes and excessive limits", async () => {
  const repository = new InMemoryContextEngineRepository();
  await seedFilterGraph(repository);
  const server = createTestServer(repository);
  try {
    const first = await requestGraph(server, {
      layers: ["stm", "ltm"],
      relationTypes: ["supports", "updates", "conflicts_with"],
      nodePage: { limit: 1 },
      edgePage: { limit: 1 }
    });
    const firstBody = first.json() as MemoryGraphQueryResponse;
    assert.ok(firstBody.nodes?.nextCursor);
    assert.ok(firstBody.edges?.nextCursor);

    const invalidRequests = [
      {
        layers: ["stm", "ltm"],
        relationTypes: ["supports", "updates", "conflicts_with"],
        nodePage: null,
        edgePage: { limit: 1, cursor: firstBody.nodes.nextCursor }
      },
      {
        layers: ["stm"],
        relationTypes: ["supports", "updates", "conflicts_with"],
        nodePage: { limit: 1, cursor: firstBody.nodes.nextCursor },
        edgePage: null
      },
      {
        layers: ["stm", "ltm"],
        relationTypes: ["supports"],
        nodePage: null,
        edgePage: { limit: 1, cursor: firstBody.edges.nextCursor }
      }
    ];
    for (const payload of invalidRequests) {
      const response = await requestGraph(server, payload);
      assertMemoryGraphError(response.statusCode, response.json(), 400, "INVALID_MEMORY_GRAPH_CURSOR");
    }

    const excessiveLimit = await requestGraph(server, {
      nodePage: { limit: MEMORY_GRAPH_PAGE_LIMITS.node.max + 1 },
      edgePage: null
    });
    assertMemoryGraphError(
      excessiveLimit.statusCode,
      excessiveLimit.json(),
      400,
      "INVALID_MEMORY_GRAPH_QUERY"
    );

    for (const pageRequest of [
      { page: 0, nodePage: {}, edgePage: null },
      { page: 1.5, nodePage: {}, edgePage: null },
      { page: 2, nodePage: { cursor: firstBody.nodes.nextCursor }, edgePage: null },
      { nodePage: { page: 2 }, edgePage: null }
    ]) {
      const response = await requestGraph(server, pageRequest);
      assertMemoryGraphError(
        response.statusCode,
        response.json(),
        400,
        "INVALID_MEMORY_GRAPH_QUERY"
      );
    }
  } finally {
    await server.close();
  }
});

test("4.4 repeated queries are read-only", async () => {
  const repository = new InMemoryContextEngineRepository();
  await seedFilterGraph(repository);
  const before = structuredClone(repository.getDebugSnapshot());
  const server = createTestServer(repository);
  try {
    const payload = {
      layers: ["stm", "ltm"],
      nodePage: { limit: 10 },
      edgePage: { limit: 10 }
    };
    const first = await requestGraph(server, payload);
    const second = await requestGraph(server, payload);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const firstBody = first.json() as MemoryGraphQueryResponse;
    const secondBody = second.json() as MemoryGraphQueryResponse;
    assert.deepEqual(secondBody.nodes, firstBody.nodes);
    assert.deepEqual(secondBody.edges, firstBody.edges);
    assert.deepEqual(repository.getDebugSnapshot(), before);
  } finally {
    await server.close();
  }
});

test("4.4 graph store failures return no partial graph or internal details", async () => {
  const repository = new FailingEdgeRepository();
  await repository.upsertGraphMemoryNode(createNode("stm", "stm_a"));
  const server = createTestServer(repository);
  try {
    const response = await requestGraph(server, {
      nodePage: { limit: 10 },
      edgePage: { limit: 10 }
    });

    assert.equal(response.statusCode, 500);
    const body = response.json() as MemoryGraphQueryErrorResponse & Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "MEMORY_GRAPH_QUERY_FAILED");
    assert.equal(typeof body.error.requestId, "string");
    assert.equal(body.error.requestId.length > 0, true);
    assert.equal(body.error.message.includes("neo4j://secret-host"), false);
    assert.equal("nodes" in body, false);
    assert.equal("edges" in body, false);
    assert.deepEqual(Object.keys(body).sort(), ["error", "ok"]);
  } finally {
    await server.close();
  }
});

class NoDebugSnapshotRepository extends InMemoryContextEngineRepository {
  override getDebugSnapshot(): never {
    throw new Error("memory graph route must not read debug snapshot");
  }
}

class CountingRepository extends InMemoryContextEngineRepository {
  readonly nodeQueries: unknown[] = [];
  readonly edgeQueries: unknown[] = [];

  override listGraphMemoryNodes(query: Parameters<InMemoryContextEngineRepository["listGraphMemoryNodes"]>[0]) {
    this.nodeQueries.push(query);
    return super.listGraphMemoryNodes(query);
  }

  override listGraphRelationEdges(query: GraphRelationEdgePageQuery) {
    this.edgeQueries.push(query);
    return super.listGraphRelationEdges(query);
  }
}

class FailingEdgeRepository extends InMemoryContextEngineRepository {
  override listGraphRelationEdges(_query: GraphRelationEdgePageQuery): never {
    throw new Error("neo4j://secret-host?password=secret");
  }
}

function createTestServer(repository: InMemoryContextEngineRepository) {
  const app = fastify({ logger: false });
  registerContextEngineRoutes(app, createContextEngineService(repository), repository);
  return app;
}

function requestGraph(server: FastifyInstance, payload: unknown) {
  return server.inject({
    method: "POST",
    url: "/context/memory-graph/query",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload)
  });
}

function assertMemoryGraphError(
  actualStatus: number,
  value: unknown,
  expectedStatus: number,
  expectedCode: MemoryGraphQueryErrorResponse["error"]["code"]
) {
  assert.equal(actualStatus, expectedStatus);
  const body = value as MemoryGraphQueryErrorResponse;
  assert.equal(body.ok, false);
  assert.equal(body.error.code, expectedCode);
  assert.equal(typeof body.error.requestId, "string");
  assert.equal(body.error.requestId.length > 0, true);
}

async function seedCompleteGraph(repository: InMemoryContextEngineRepository) {
  for (const node of [
    createNode("stm", "stm_b"),
    createNode("ltm", "ltm_a", { memoryType: "preference", factSummary: "summary:ltm_a" }),
    createNode("stm", "stm_a")
  ]) {
    await repository.upsertGraphMemoryNode(node);
  }
  for (const [index, relationType] of MEMORY_GRAPH_RELATION_TYPES.entries()) {
    await repository.saveRelationEdge(createEdge(
      `edge_${String(index).padStart(2, "0")}_${relationType}`,
      "stm_a",
      "ltm_a",
      relationType,
      index === 0
        ? {
            evidence: "optional edge evidence",
            strength: 0.95,
            confidence: "high",
            source: "rule",
            createdAt: "2026-07-22T09:00:00.000Z"
          }
        : {}
    ));
  }
}

async function seedPagingGraph(repository: InMemoryContextEngineRepository) {
  for (const node of [
    createNode("stm", "stm_b"),
    createNode("ltm", "ltm_b"),
    createNode("stm", "stm_a"),
    createNode("ltm", "ltm_a")
  ]) {
    await repository.upsertGraphMemoryNode(node);
  }
  await repository.saveRelationEdge(createEdge("edge_02", "stm_a", "stm_b", "updates"));
  await repository.saveRelationEdge(createEdge("edge_01", "ltm_a", "stm_a", "supports"));
}

async function seedFilterGraph(repository: InMemoryContextEngineRepository) {
  for (const node of [
    createNode("ltm", "ltm_b"),
    createNode("stm", "stm_b"),
    createNode("ltm", "ltm_a"),
    createNode("stm", "stm_a")
  ]) {
    await repository.upsertGraphMemoryNode(node);
  }
  await repository.saveRelationEdge(createEdge("edge_03", "ltm_a", "ltm_b", "supports"));
  await repository.saveRelationEdge(createEdge("edge_01", "stm_a", "stm_b", "conflicts_with"));
  await repository.saveRelationEdge(createEdge("edge_02", "stm_a", "ltm_a", "updates"));
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
    vector: [0.1, 0.2, 0.3],
    lifecycleStatus: "active",
    retrievalWeight: 0.8,
    sourceRefs: [{
      sourceRefId: `src_${ownerId}`,
      sourceType: "document",
      sourceId: ownerId,
      sourceUrl: `https://example.test/${ownerId}`
    }],
    entityIds: [`entity_${ownerId}`],
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
