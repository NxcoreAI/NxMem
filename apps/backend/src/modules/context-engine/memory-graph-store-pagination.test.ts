import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GraphMemoryNode, RelationEdge } from "./domain.js";
import type {
  GraphMemoryNodePageQuery,
  GraphMemoryStore,
  GraphRelationEdgePageQuery
} from "./persistence/graph-store.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";
import {
  Neo4jGraphMemoryStore,
  type Neo4jDriverModule
} from "./persistence/neo4j-graph-store.js";

type PageStore = Pick<GraphMemoryStore, "listGraphMemoryNodes" | "listGraphRelationEdges">;

interface StoreHarness {
  store: PageStore;
  close(): Promise<void>;
}

type StoreHarnessFactory = () => Promise<StoreHarness>;

const nodes: GraphMemoryNode[] = [
  createNode("stm", "stm_b"),
  createNode("ltm", "ltm_b"),
  createNode("stm", "stm_a"),
  createNode("ltm", "ltm_a", {
    memoryType: "preference",
    factSummary: "alpha summary"
  })
];

const edges: RelationEdge[] = [
  createEdge("edge_05", "ltm_a", "stm_a", "updates"),
  createEdge("edge_03", "stm_a", "ltm_a", "related_to"),
  createEdge("edge_01", "ltm_a", "ltm_b", "supports", {
    evidence: "shared source",
    strength: 0.8,
    confidence: "high",
    source: "rule",
    createdAt: "2026-07-22T09:00:00.000Z"
  }),
  createEdge("edge_04", "stm_a", "missing_node", "related_to"),
  createEdge("edge_02", "stm_a", "stm_b", "conflicts_with")
];

registerPaginationContract("in-memory", createInMemoryHarness);
registerPaginationContract("sqlite", createSqliteHarness);
registerPaginationContract("neo4j", createNeo4jHarness);

function registerPaginationContract(name: string, createHarness: StoreHarnessFactory) {
  test(`${name} graph store follows the shared node pagination contract`, async () => {
    const harness = await createHarness();
    try {
      const first = await harness.store.listGraphMemoryNodes({
        ownerTypes: ["stm", "ltm"],
        limit: 2
      });
      assert.deepEqual(first, {
        nodes: [nodeById("ltm_a"), nodeById("ltm_b")],
        hasMore: true
      });

      const second = await harness.store.listGraphMemoryNodes({
        ownerTypes: ["stm", "ltm"],
        after: { layer: "ltm", id: "ltm_b" },
        limit: 2
      });
      assert.deepEqual(second, {
        nodes: [nodeById("stm_a"), nodeById("stm_b")],
        hasMore: false
      });

      const directPage = await harness.store.listGraphMemoryNodes({
        ownerTypes: ["stm", "ltm"],
        offset: 2,
        limit: 1
      });
      assert.deepEqual(directPage, {
        nodes: [nodeById("stm_a")],
        hasMore: true
      });

      const stmOnly = await harness.store.listGraphMemoryNodes({
        ownerTypes: ["stm"],
        limit: 10
      });
      assert.deepEqual(stmOnly.nodes.map((node) => node.ownerId), ["stm_a", "stm_b"]);

      first.nodes[0]!.content = "mutated";
      first.nodes[0]!.vector.push(99);
      first.nodes[0]!.sourceRefs[0]!.sourceId = "mutated";
      first.nodes[0]!.entityIds.push("mutated");
      const reread = await harness.store.listGraphMemoryNodes({
        ownerTypes: ["ltm"],
        limit: 1
      });
      assert.deepEqual(reread.nodes[0], nodeById("ltm_a"));
    } finally {
      await harness.close();
    }
  });

  test(`${name} graph store follows the shared edge pagination contract`, async () => {
    const harness = await createHarness();
    try {
      const first = await harness.store.listGraphRelationEdges({
        ownerTypes: ["stm", "ltm"],
        relationTypes: ["supports", "conflicts_with", "related_to", "updates"],
        limit: 2
      });
      assert.deepEqual(first, {
        edges: [edgeById("edge_01"), edgeById("edge_02")],
        hasMore: true
      });

      const second = await harness.store.listGraphRelationEdges({
        ownerTypes: ["stm", "ltm"],
        relationTypes: ["supports", "conflicts_with", "related_to", "updates"],
        after: { id: "edge_02" },
        limit: 2
      });
      assert.deepEqual(second, {
        edges: [edgeById("edge_03"), edgeById("edge_05")],
        hasMore: false
      });

      const directPage = await harness.store.listGraphRelationEdges({
        ownerTypes: ["stm", "ltm"],
        relationTypes: ["supports", "conflicts_with", "related_to", "updates"],
        offset: 2,
        limit: 1
      });
      assert.deepEqual(directPage, {
        edges: [edgeById("edge_03")],
        hasMore: true
      });

      const stmOnly = await harness.store.listGraphRelationEdges({
        ownerTypes: ["stm"],
        relationTypes: ["supports", "conflicts_with", "related_to", "updates"],
        limit: 10
      });
      assert.deepEqual(stmOnly.edges, [edgeById("edge_02")]);

      const supportsOnly = await harness.store.listGraphRelationEdges({
        ownerTypes: ["stm", "ltm"],
        relationTypes: ["supports"],
        limit: 10
      });
      assert.deepEqual(supportsOnly.edges, [edgeById("edge_01")]);

      first.edges[0]!.evidence = "mutated";
      const reread = await harness.store.listGraphRelationEdges({
        ownerTypes: ["ltm"],
        relationTypes: ["supports"],
        limit: 1
      });
      assert.deepEqual(reread.edges[0], edgeById("edge_01"));
    } finally {
      await harness.close();
    }
  });
}

async function createInMemoryHarness(): Promise<StoreHarness> {
  const repository = new InMemoryContextEngineRepository();
  await seedRepository(repository);
  return { store: repository, close: async () => {} };
}

async function createSqliteHarness(): Promise<StoreHarness> {
  const directory = await mkdtemp(join(tmpdir(), "memory-graph-pagination-"));
  const storePath = join(directory, "context.sqlite");
  const db = new DatabaseSync(storePath);
  db.exec(`
    CREATE TABLE graph_memory_nodes (
      graph_node_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      memory_type TEXT,
      content TEXT NOT NULL,
      fact_summary TEXT,
      vector TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL,
      retrieval_weight REAL NOT NULL,
      source_refs TEXT NOT NULL,
      entity_ids TEXT NOT NULL,
      evidence_time_start TEXT,
      evidence_time_end TEXT,
      evidence_time_confidence TEXT NOT NULL DEFAULT 'low',
      valid_time_start TEXT,
      valid_time_end TEXT,
      valid_time_confidence TEXT NOT NULL DEFAULT 'low',
      refreshed_at TEXT NOT NULL
    );
    CREATE TABLE relation_edges (
      edge_id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      evidence TEXT,
      strength REAL,
      confidence TEXT,
      source TEXT,
      created_at TEXT
    );
  `);
  const insertNode = db.prepare(`
    INSERT INTO graph_memory_nodes (
      graph_node_id, owner_id, owner_type, memory_type, content, fact_summary,
      vector, lifecycle_status, retrieval_weight, source_refs, entity_ids,
      evidence_time_start, evidence_time_end, evidence_time_confidence,
      valid_time_start, valid_time_end, valid_time_confidence, refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const node of nodes) {
    insertNode.run(
      node.graphNodeId,
      node.ownerId,
      node.ownerType,
      node.memoryType ?? null,
      node.content,
      node.factSummary ?? null,
      JSON.stringify(node.vector),
      node.lifecycleStatus,
      node.retrievalWeight,
      JSON.stringify(node.sourceRefs),
      JSON.stringify(node.entityIds),
      node.evidenceTimeStart ?? null,
      node.evidenceTimeEnd ?? null,
      node.evidenceTimeConfidence ?? "low",
      node.validTimeStart ?? null,
      node.validTimeEnd ?? null,
      node.validTimeConfidence ?? "low",
      node.refreshedAt
    );
  }
  const insertEdge = db.prepare(`
    INSERT INTO relation_edges (
      edge_id, from_id, to_id, relation_type, evidence, strength, confidence, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const edge of edges) {
    insertEdge.run(
      edge.edgeId,
      edge.fromId,
      edge.toId,
      edge.relationType,
      edge.evidence ?? null,
      edge.strength ?? null,
      edge.confidence ?? null,
      edge.source ?? null,
      edge.createdAt ?? null
    );
  }
  // This Node build lacks FTS5, so exercise the production pagination methods against the minimal graph schema.
  const reader = Object.create(SqliteContextEngineRepository.prototype) as SqliteContextEngineRepository;
  Object.defineProperty(reader, "db", { value: db });
  return {
    store: reader,
    close: async () => {
      reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function createNeo4jHarness(): Promise<StoreHarness> {
  const store = new Neo4jGraphMemoryStore({
    uri: "bolt://localhost:7687",
    username: "neo4j",
    password: "password",
    database: "neo4j",
    fulltextIndexName: "memory_node_fulltext",
    vectorIndexName: "memory_node_vector",
    vectorDimensions: 3,
    driverModule: createPaginationNeo4jDriver(nodes, edges)
  });
  return { store, close: async () => store.close() };
}

async function seedRepository(repository: InMemoryContextEngineRepository) {
  for (const node of nodes) await repository.upsertGraphMemoryNode(cloneNode(node));
  for (const edge of edges) await repository.saveRelationEdge({ ...edge });
}

function createPaginationNeo4jDriver(
  sourceNodes: GraphMemoryNode[],
  sourceEdges: RelationEdge[]
): Neo4jDriverModule {
  return {
    auth: { basic: () => ({}) },
    int: (value) => value,
    driver: () => ({
      verifyConnectivity: async () => {},
      close: async () => {},
      executeQuery: async (query, parameters = {}) => {
        if (query.includes("RETURN node AS node")) {
          const layers = parameters.layers as GraphMemoryNodePageQuery["ownerTypes"];
          const afterLayer = parameters.afterLayer as string | null;
          const afterId = parameters.afterId as string | null;
          const offset = Number(parameters.offset);
          const limit = Number(parameters.limitPlusOne);
          const result = sourceNodes
            .filter((node) => layers.includes(node.ownerType))
            .filter((node) => afterLayer === null || node.ownerType > afterLayer ||
              (node.ownerType === afterLayer && node.ownerId > (afterId ?? "")))
            .sort(compareNodes)
            .slice(offset, offset + limit)
            .map((node) => neo4jRecord({ node: neo4jNode(node) }));
          return { records: result };
        }
        if (query.includes("MATCH (from:MemoryNode)-[rel]->(to:MemoryNode)")) {
          const layers = parameters.layers as GraphRelationEdgePageQuery["ownerTypes"];
          const relationTypes = parameters.relationTypes as GraphRelationEdgePageQuery["relationTypes"];
          const afterEdgeId = parameters.afterEdgeId as string | null;
          const offset = Number(parameters.offset);
          const limit = Number(parameters.limitPlusOne);
          const ownerTypesById = new Map(sourceNodes.map((node) => [node.ownerId, node.ownerType]));
          const result = sourceEdges
            .filter((edge) => {
              const fromOwnerType = ownerTypesById.get(edge.fromId);
              const toOwnerType = ownerTypesById.get(edge.toId);
              return Boolean(fromOwnerType && toOwnerType &&
                layers.includes(fromOwnerType) && layers.includes(toOwnerType));
            })
            .filter((edge) => relationTypes.includes(edge.relationType))
            .filter((edge) => afterEdgeId === null || edge.edgeId > afterEdgeId)
            .sort((left, right) => compareText(left.edgeId, right.edgeId))
            .slice(offset, offset + limit)
            .map((edge) => neo4jRecord({
              rel: neo4jRelationship(edge),
              fromId: edge.fromId,
              toId: edge.toId
            }));
          return { records: result };
        }
        return { records: [] };
      }
    })
  };
}

function neo4jNode(node: GraphMemoryNode) {
  return {
    properties: {
      graphNodeId: node.graphNodeId,
      ownerId: node.ownerId,
      ownerType: node.ownerType,
      memoryType: node.memoryType ?? null,
      content: node.content,
      factSummary: node.factSummary ?? null,
      embedding: [...node.vector],
      lifecycleStatus: node.lifecycleStatus,
      retrievalWeight: node.retrievalWeight,
      sourceRefsJson: JSON.stringify(node.sourceRefs),
      entityIds: [...node.entityIds],
      evidenceTimeStart: node.evidenceTimeStart ?? null,
      evidenceTimeEnd: node.evidenceTimeEnd ?? null,
      evidenceTimeConfidence: node.evidenceTimeConfidence ?? "low",
      validTimeStart: node.validTimeStart ?? null,
      validTimeEnd: node.validTimeEnd ?? null,
      validTimeConfidence: node.validTimeConfidence ?? "low",
      refreshedAt: node.refreshedAt
    }
  };
}

function neo4jRelationship(edge: RelationEdge) {
  return {
    type: edge.relationType.toUpperCase(),
    properties: {
      edgeId: edge.edgeId,
      relationType: edge.relationType,
      evidence: edge.evidence ?? null,
      strength: edge.strength ?? null,
      confidence: edge.confidence ?? null,
      source: edge.source ?? null,
      createdAt: edge.createdAt ?? null
    }
  };
}

function neo4jRecord(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
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
    retrievalWeight: 0.75,
    sourceRefs: [{
      sourceRefId: `source_ref_${ownerId}`,
      sourceType: "document",
      sourceId: `source_${ownerId}`,
      sourceUrl: `https://example.test/${ownerId}`
    }],
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

function nodeById(ownerId: string) {
  return cloneNode(nodes.find((node) => node.ownerId === ownerId)!);
}

function edgeById(edgeId: string) {
  return { ...edges.find((edge) => edge.edgeId === edgeId)! };
}

function cloneNode(node: GraphMemoryNode): GraphMemoryNode {
  return {
    ...node,
    vector: [...node.vector],
    sourceRefs: node.sourceRefs.map((sourceRef) => ({ ...sourceRef })),
    entityIds: [...node.entityIds]
  };
}

function compareNodes(left: GraphMemoryNode, right: GraphMemoryNode) {
  return compareText(left.ownerType, right.ownerType) || compareText(left.ownerId, right.ownerId);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
