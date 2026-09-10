import test from "node:test";
import assert from "node:assert/strict";
import { Neo4jGraphMemoryStore, type Neo4jDriverModule } from "./persistence/neo4j-graph-store.js";

test("Neo4jGraphMemoryStore initializes constraints and graph indexes", async () => {
  const fake = createFakeNeo4j();
  const store = createStore(fake);

  await store.initialize();

  assert.equal(fake.driverConfigs[0]?.connectionTimeout, 5000);
  assert.equal(fake.queries.some((query) => query.includes("CREATE CONSTRAINT memory_node_owner_key")), true);
  assert.equal(fake.queries.some((query) => query.includes("CREATE FULLTEXT INDEX memory_node_fulltext")), true);
  assert.equal(fake.queries.some((query) => query.includes("CREATE VECTOR INDEX memory_node_vector")), true);
});

test("Neo4jGraphMemoryStore can rebuild only the configured vector index at a new dimension", async () => {
  const fake = createFakeNeo4j();
  const store = createStore(fake, 1024);

  await store.initialize({ createVectorIndex: false });
  await store.dropVectorIndex();
  await store.createVectorIndex();

  assert.equal(fake.queries.some((query) => query.includes("CREATE FULLTEXT INDEX memory_node_fulltext")), true);
  assert.equal(fake.queries.filter((query) => query.includes("CREATE VECTOR INDEX memory_node_vector")).length, 1);
  assert.equal(fake.queries.some((query) => query.includes("DROP INDEX memory_node_vector IF EXISTS")), true);
  assert.equal(fake.queries.some((query) => query.includes("MATCH (node:MemoryNode) DETACH DELETE node")), false);
  const vectorIndex = fake.executions.find(({ query }) => query.includes("CREATE VECTOR INDEX memory_node_vector"));
  assert.deepEqual(vectorIndex?.parameters, { vectorDimensions: 1024 });
});

test("Neo4jGraphMemoryStore clears memory nodes in bounded transactions", async () => {
  const fake = createFakeNeo4j([1000, 7, 0]);
  const store = createStore(fake);

  await store.clearGraph();

  const clearExecutions = fake.executions.filter(({ query }) => query.includes("DETACH DELETE node"));
  assert.equal(clearExecutions.length, 3);
  assert.equal(clearExecutions.every(({ query }) => query.includes("LIMIT $batchSize")), true);
  assert.equal(clearExecutions.every(({ query }) => query.includes("RETURN count(*) AS deleted")), true);
  assert.deepEqual(clearExecutions.map(({ parameters }) => parameters), [
    { batchSize: 1000 },
    { batchSize: 1000 },
    { batchSize: 1000 }
  ]);
});

test("Neo4jGraphMemoryStore writes nodes, edges, FTS, vector and neighborhood queries through Cypher", async () => {
  const fake = createFakeNeo4j();
  const store = createStore(fake);

  await store.upsertGraphMemoryNode({
    graphNodeId: "graph_stm_1",
    ownerType: "stm",
    ownerId: "stm_1",
    memoryType: "preference",
    content: "alpha memory",
    factSummary: "图节点摘要：alpha memory",
    lifecycleStatus: "active",
    sourceRefs: [{ sourceRefId: "src_1", sourceType: "file", sourceId: "src-1" }],
    entityIds: ["entity_1"],
    retrievalWeight: 0.8,
    vector: [0.1, 0.2, 0.3],
    refreshedAt: "2026-06-30T00:00:00.000Z"
  });
  await store.upsertGraphRelationEdge({
    edgeId: "edge_1",
    fromId: "stm_1",
    toId: "ltm_1",
    relationType: "related_to",
    evidence: "test"
  });
  await store.searchGraphText(["alpha"], { ownerTypes: ["stm"], ownerKeys: ["stm:stm_1"] });
  await store.searchGraphVector([0.1, 0.2, 0.3], { ownerTypes: ["stm"], ownerKeys: ["stm:stm_1"] });
  await store.getGraphRelationEdges("stm_1");
  await store.searchGraphRelationEdges({ relationTypes: ["related_to"], q: "test", limit: 10 });
  await store.listGraphMemoryNodes({
    ownerTypes: ["stm", "ltm"],
    after: { layer: "ltm", id: "ltm_1" },
    limit: 2
  });
  await store.listGraphRelationEdges({
    ownerTypes: ["stm"],
    relationTypes: ["conflicts_with", "updates"],
    after: { id: "edge_2" },
    limit: 3
  });

  assert.equal(fake.queries.some((query) => query.includes("MERGE (node:MemoryNode:STM")), true);
  assert.equal(fake.queries.some((query) => query.includes("node.memoryType = $memoryType")), true);
  assert.equal(fake.queries.some((query) => query.includes("node.factSummary = $factSummary")), true);
  assert.equal(fake.queries.some((query) => query.includes("node.retrievalWeight = $retrievalWeight")), true);
  assert.equal(fake.queries.some((query) => query.includes("MERGE (from)-[rel:RELATED_TO")), true);
  assert.equal(fake.queries.some((query) => query.includes("db.index.fulltext.queryNodes")), true);
  assert.equal(fake.queries.some((query) => query.includes("db.index.vector.queryNodes")), true);
  assert.equal(fake.queries.some((query) => query.includes("MATCH (node:MemoryNode {ownerKey: $ownerKey})-[rel]-(other:MemoryNode)")), true);
  assert.equal(fake.queries.some((query) => query.includes("MATCH (from:MemoryNode)-[rel]-(to:MemoryNode)")), true);
  assert.equal(fake.queries.some((query) => query.includes("toLower(rel.evidence) CONTAINS $evidenceQuery")), true);
  const nodePageExecution = fake.executions.find(({ query }) => query.includes("RETURN node AS node"));
  assert.match(nodePageExecution?.query ?? "", /node\.ownerType IN \$layers/u);
  assert.match(nodePageExecution?.query ?? "", /node\.ownerId > \$afterId/u);
  assert.match(nodePageExecution?.query ?? "", /ORDER BY node\.ownerType, node\.ownerId/u);
  assert.match(nodePageExecution?.query ?? "", /SKIP \$offset/u);
  assert.deepEqual(nodePageExecution?.parameters, {
    layers: ["stm", "ltm"],
    afterLayer: "ltm",
    afterId: "ltm_1",
    offset: 0,
    limitPlusOne: 3
  });
  const edgePageExecution = fake.executions.find(({ query }) =>
    query.includes("MATCH (from:MemoryNode)-[rel]->(to:MemoryNode)")
  );
  assert.match(edgePageExecution?.query ?? "", /from\.ownerType IN \$layers/u);
  assert.match(edgePageExecution?.query ?? "", /to\.ownerType IN \$layers/u);
  assert.match(edgePageExecution?.query ?? "", /rel\.relationType IN \$relationTypes/u);
  assert.match(edgePageExecution?.query ?? "", /rel\.edgeId > \$afterEdgeId/u);
  assert.match(edgePageExecution?.query ?? "", /ORDER BY rel\.edgeId/u);
  assert.match(edgePageExecution?.query ?? "", /SKIP \$offset/u);
  assert.deepEqual(edgePageExecution?.parameters, {
    layers: ["stm"],
    relationTypes: ["conflicts_with", "updates"],
    neo4jRelationTypes: ["CONFLICTS_WITH", "UPDATES"],
    afterEdgeId: "edge_2",
    offset: 0,
    limitPlusOne: 4
  });
});

function createStore(driverModule: Neo4jDriverModule, vectorDimensions = 3) {
  return new Neo4jGraphMemoryStore({
    uri: "bolt://localhost:7687",
    username: "neo4j",
    password: "password",
    database: "neo4j",
    fulltextIndexName: "memory_node_fulltext",
    vectorIndexName: "memory_node_vector",
    vectorDimensions,
    driverModule
  });
}

function createFakeNeo4j(clearCounts: number[] = []) {
  const queries: string[] = [];
  const executions: Array<{ query: string; parameters: Record<string, unknown> }> = [];
  const driverConfigs: Array<{ connectionTimeout?: number }> = [];
  const module: Neo4jDriverModule & {
    queries: string[];
    executions: Array<{ query: string; parameters: Record<string, unknown> }>;
    driverConfigs: Array<{ connectionTimeout?: number }>;
  } = {
    queries,
    executions,
    driverConfigs,
    auth: {
      basic: () => ({})
    },
    int: (value) => value,
    driver: (_uri, _authToken, config) => {
      driverConfigs.push(config ?? {});
      return {
      verifyConnectivity: async () => {},
      close: async () => {},
      executeQuery: async (query, parameters = {}) => {
        queries.push(query);
        executions.push({ query, parameters });
        if (query.includes("DETACH DELETE node")) {
          const deleted = clearCounts.shift() ?? 0;
          return {
            records: [{ get: (key: string) => key === "deleted" ? deleted : undefined }]
          };
        }
        return { records: [] };
      }
      };
    }
  };
  return module;
}
