import type { ContextEngineConfig } from "../../../config.js";
import type {
  GraphMemoryNode,
  GraphMemoryOwnerType,
  GraphMemorySearchHit,
  GraphMemorySearchOptions,
  RelationEdge,
  SourceRef
} from "../domain.js";
import {
  memoryOwnerTypeForId,
  neo4jTypeToRelationType,
  ownerKey,
  relationTypeToNeo4jType,
  type GraphMemoryNodePage,
  type GraphMemoryNodePageQuery,
  type GraphRelationEdgePage,
  type GraphRelationEdgePageQuery,
  type GraphRelationSearchQuery,
  type GraphMemoryStore
} from "./graph-store.js";

export type Neo4jDriverModule = {
  default?: unknown;
  auth: {
    basic(username: string, password: string): unknown;
  };
  driver(uri: string, authToken: unknown, config?: { connectionTimeout?: number }): Neo4jDriver;
  int(value: number): unknown;
};

export type Neo4jDriver = {
  executeQuery<T = Record<string, unknown>>(
    query: string,
    parameters?: Record<string, unknown>,
    config?: { database?: string }
  ): Promise<{ records: Neo4jRecord<T>[] }>;
  verifyConnectivity(): Promise<void>;
  close(): Promise<void>;
};

type Neo4jRecord<T = Record<string, unknown>> = {
  get(key: keyof T | string): unknown;
};

type Neo4jNode = {
  properties: Record<string, unknown>;
};

type Neo4jRelationship = {
  type: string;
  properties: Record<string, unknown>;
};

export interface Neo4jGraphMemoryStoreOptions {
  uri: string;
  username: string;
  password: string;
  database: string;
  fulltextIndexName: string;
  vectorIndexName: string;
  vectorDimensions: number;
  /** Maximum number of memory nodes removed in one transaction. */
  clearBatchSize?: number;
  connectionTimeoutMs?: number;
  driverModule?: Neo4jDriverModule;
}

const defaultNeo4jConnectionTimeoutMs = 5000;
const defaultNeo4jClearBatchSize = 1000;

export class Neo4jGraphMemoryStore implements GraphMemoryStore {
  private readonly options: Neo4jGraphMemoryStoreOptions;
  private driver: Neo4jDriver | undefined;
  private neo4j: Neo4jDriverModule | undefined;

  constructor(options: Neo4jGraphMemoryStoreOptions) {
    this.options = options;
    this.neo4j = options.driverModule;
  }

  static fromConfig(config: ContextEngineConfig) {
    const neo4j = config.graphStore.neo4j;
    if (!neo4j.password) {
      throw new Error("Neo4j graph store requires a password");
    }
    return new Neo4jGraphMemoryStore({
      uri: neo4j.uri,
      username: neo4j.username,
      password: neo4j.password,
      database: neo4j.database,
      fulltextIndexName: neo4j.fulltextIndexName,
      vectorIndexName: neo4j.vectorIndexName,
      vectorDimensions: neo4j.vectorDimensions
    });
  }

  async initialize(options: { createVectorIndex?: boolean } = {}) {
    const driver = await this.getDriver();
    await driver.verifyConnectivity();
    await this.run(
      `CREATE CONSTRAINT memory_node_owner_key IF NOT EXISTS
       FOR (node:MemoryNode)
       REQUIRE node.ownerKey IS UNIQUE`
    );
    await this.run(
      `CREATE FULLTEXT INDEX ${escapeIndexName(this.options.fulltextIndexName)} IF NOT EXISTS
       FOR (node:MemoryNode)
       ON EACH [node.content]`
    );
    if (options.createVectorIndex !== false) await this.createVectorIndex();
  }

  async dropVectorIndex() {
    await this.run(`DROP INDEX ${escapeIndexName(this.options.vectorIndexName)} IF EXISTS`);
  }

  async createVectorIndex() {
    await this.run(
      `CREATE VECTOR INDEX ${escapeIndexName(this.options.vectorIndexName)} IF NOT EXISTS
       FOR (node:MemoryNode)
       ON (node.embedding)
       OPTIONS {indexConfig: {
         \`vector.dimensions\`: $vectorDimensions,
         \`vector.similarity_function\`: 'cosine'
       }}`,
      { vectorDimensions: this.neo4jModule().int(this.options.vectorDimensions) }
    );
  }

  async close() {
    await this.driver?.close();
    this.driver = undefined;
  }

  async upsertGraphMemoryNode(node: GraphMemoryNode) {
    this.assertVectorDimensions(node.vector);
    const labels = node.ownerType === "stm" ? "MemoryNode:STM" : "MemoryNode:LTM";
    await this.run(
      `MERGE (node:${labels} {ownerKey: $ownerKey})
       SET node.ownerType = $ownerType,
           node.ownerId = $ownerId,
           node.graphNodeId = $graphNodeId,
           node.memoryType = $memoryType,
           node.content = $content,
           node.factSummary = $factSummary,
           node.lifecycleStatus = $lifecycleStatus,
           node.sourceRefsJson = $sourceRefsJson,
           node.entityIds = $entityIds,
           node.retrievalWeight = $retrievalWeight,
           node.evidenceTimeStart = $evidenceTimeStart,
           node.evidenceTimeEnd = $evidenceTimeEnd,
           node.evidenceTimeConfidence = $evidenceTimeConfidence,
           node.validTimeStart = $validTimeStart,
           node.validTimeEnd = $validTimeEnd,
           node.validTimeConfidence = $validTimeConfidence,
           node.embedding = $embedding,
           node.refreshedAt = $refreshedAt`,
      {
        ownerKey: ownerKey(node.ownerType, node.ownerId),
        ownerType: node.ownerType,
        ownerId: node.ownerId,
        graphNodeId: node.graphNodeId,
        memoryType: node.memoryType ?? null,
        content: node.content,
        factSummary: node.factSummary ?? null,
        lifecycleStatus: node.lifecycleStatus,
        sourceRefsJson: JSON.stringify(node.sourceRefs),
        entityIds: node.entityIds,
        retrievalWeight: node.retrievalWeight,
        evidenceTimeStart: node.evidenceTimeStart ?? null,
        evidenceTimeEnd: node.evidenceTimeEnd ?? null,
        evidenceTimeConfidence: node.evidenceTimeConfidence ?? "low",
        validTimeStart: node.validTimeStart ?? null,
        validTimeEnd: node.validTimeEnd ?? null,
        validTimeConfidence: node.validTimeConfidence ?? "low",
        embedding: node.vector,
        refreshedAt: node.refreshedAt
      }
    );
  }

  async deleteGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string) {
    await this.run(
      `MATCH (node:MemoryNode {ownerKey: $ownerKey})
       DETACH DELETE node`,
      { ownerKey: ownerKey(ownerType, ownerId) }
    );
  }

  async upsertGraphRelationEdge(edge: RelationEdge) {
    const fromOwnerType = memoryOwnerTypeForId(edge.fromId);
    const toOwnerType = memoryOwnerTypeForId(edge.toId);
    if (!fromOwnerType || !toOwnerType) return;
    const relType = safeRelationshipType(edge.relationType);
    await this.run(
      `MATCH (from:MemoryNode {ownerKey: $fromOwnerKey})
       MATCH (to:MemoryNode {ownerKey: $toOwnerKey})
       MERGE (from)-[rel:${relType} {edgeId: $edgeId}]->(to)
       SET rel.relationType = $relationType,
           rel.evidence = $evidence,
           rel.strength = $strength,
           rel.confidence = $confidence,
           rel.source = $source,
           rel.createdAt = $createdAt`,
      {
        fromOwnerKey: ownerKey(fromOwnerType, edge.fromId),
        toOwnerKey: ownerKey(toOwnerType, edge.toId),
        edgeId: edge.edgeId,
        relationType: edge.relationType,
        evidence: edge.evidence ?? null,
        strength: edge.strength ?? null,
        confidence: edge.confidence ?? null,
        source: edge.source ?? null,
        createdAt: edge.createdAt ?? null
      }
    );
  }

  async deleteGraphRelationEdges(edgeIds: string[]) {
    const safeIds = edgeIds.filter(Boolean);
    if (!safeIds.length) return;
    await this.run(
      `MATCH ()-[rel]-()
       WHERE rel.edgeId IN $edgeIds
       DELETE rel`,
      { edgeIds: safeIds }
    );
  }

  async clearGraph() {
    const batchSize = normalizeClearBatchSize(this.options.clearBatchSize);
    while (true) {
      const rows = await this.run(
        `CALL {
           MATCH (node:MemoryNode)
           WITH node
           LIMIT $batchSize
           DETACH DELETE node
           RETURN count(*) AS deleted
         }
         RETURN deleted`,
        { batchSize: this.neo4jModule().int(batchSize) }
      );
      const deleted = readNeo4jCount(rows.records[0]?.get("deleted"));
      if (deleted <= 0) break;
    }
  }

  async searchGraphText(queryTokens: string[], options: GraphMemorySearchOptions = {}): Promise<GraphMemorySearchHit[]> {
    const query = buildFulltextQuery(queryTokens);
    if (!query) return [];
    const rows = await this.run(
      `CALL db.index.fulltext.queryNodes($indexName, $query) YIELD node, score
       WHERE ($ownerTypes IS NULL OR node.ownerType IN $ownerTypes)
         AND ($ownerKeys IS NULL OR node.ownerKey IN $ownerKeys)
         AND (${temporalEnvelopePredicate("node")})
       RETURN node.ownerType AS ownerType,
              node.ownerId AS ownerId,
              score AS score
       ORDER BY score DESC`,
      {
        indexName: this.options.fulltextIndexName,
        query,
        ownerTypes: options.ownerTypes ?? null,
        ownerKeys: options.ownerKeys ?? null,
        temporalBasis: options.temporalRange?.basis ?? null,
        temporalStart: options.temporalRange?.startTime ?? null,
        temporalEnd: options.temporalRange?.endTime ?? null
      }
    );
    return rows.records.map((record) => ({
      ownerType: record.get("ownerType") as GraphMemoryOwnerType,
      ownerId: String(record.get("ownerId")),
      score: Number(record.get("score") ?? 0),
      matchedTerms: queryTokens.length
    }));
  }

  async searchGraphVector(queryVector: number[], options: GraphMemorySearchOptions = {}): Promise<GraphMemorySearchHit[]> {
    if (!queryVector.length) return [];
    this.assertVectorDimensions(queryVector);
    const limit = Math.max(100, (options.ownerKeys?.length ?? 0) || 100);
    const rows = await this.run(
      `CALL db.index.vector.queryNodes($indexName, $limit, $queryVector) YIELD node, score
       WHERE ($ownerTypes IS NULL OR node.ownerType IN $ownerTypes)
         AND ($ownerKeys IS NULL OR node.ownerKey IN $ownerKeys)
         AND (${temporalEnvelopePredicate("node")})
       RETURN node.ownerType AS ownerType,
              node.ownerId AS ownerId,
              score AS score
       ORDER BY score DESC`,
      {
        indexName: this.options.vectorIndexName,
        limit: this.neo4jModule().int(limit),
        queryVector,
        ownerTypes: options.ownerTypes ?? null,
        ownerKeys: options.ownerKeys ?? null,
        temporalBasis: options.temporalRange?.basis ?? null,
        temporalStart: options.temporalRange?.startTime ?? null,
        temporalEnd: options.temporalRange?.endTime ?? null
      }
    );
    return rows.records.map((record) => ({
      ownerType: record.get("ownerType") as GraphMemoryOwnerType,
      ownerId: String(record.get("ownerId")),
      score: Number(record.get("score") ?? 0)
    }));
  }

  async getGraphRelationEdges(ownerId: string): Promise<RelationEdge[]> {
    const ownerType = memoryOwnerTypeForId(ownerId);
    if (!ownerType) return [];
    const rows = await this.run(
      `MATCH (node:MemoryNode {ownerKey: $ownerKey})-[rel]-(other:MemoryNode)
       RETURN rel AS rel,
              startNode(rel).ownerId AS fromId,
              endNode(rel).ownerId AS toId`,
      { ownerKey: ownerKey(ownerType, ownerId) }
    );
    return rows.records.map((record) => relationFromNeo4j(
      record.get("rel") as Neo4jRelationship,
      String(record.get("fromId")),
      String(record.get("toId"))
    ));
  }

  async searchGraphRelationEdges(query: GraphRelationSearchQuery): Promise<RelationEdge[]> {
    const relationTypes = query.relationTypes?.filter(Boolean);
    const neo4jRelationTypes = relationTypes?.map((relationType) => relationTypeToNeo4jType(relationType));
    const ownerTypes = query.ownerTypes?.filter(Boolean);
    const evidenceQuery = query.q?.trim().toLowerCase();
    const rows = await this.run(
      `MATCH (from:MemoryNode)-[rel]-(to:MemoryNode)
       WHERE ($relationTypes IS NULL OR rel.relationType IN $relationTypes OR type(rel) IN $neo4jRelationTypes)
         AND ($fromId IS NULL OR startNode(rel).ownerId = $fromId)
         AND ($toId IS NULL OR endNode(rel).ownerId = $toId)
         AND ($ownerTypes IS NULL OR from.ownerType IN $ownerTypes OR to.ownerType IN $ownerTypes)
         AND ($evidenceQuery IS NULL OR toLower(rel.evidence) CONTAINS $evidenceQuery)
       RETURN DISTINCT rel AS rel,
              startNode(rel).ownerId AS fromId,
              endNode(rel).ownerId AS toId
       ORDER BY rel.createdAt DESC, rel.edgeId ASC
       SKIP $offset
       LIMIT $limit`,
      {
        relationTypes: relationTypes?.length ? relationTypes : null,
        neo4jRelationTypes: neo4jRelationTypes?.length ? neo4jRelationTypes : null,
        fromId: query.fromId ?? null,
        toId: query.toId ?? null,
        ownerTypes: ownerTypes?.length ? ownerTypes : null,
        evidenceQuery: evidenceQuery || null,
        offset: this.neo4jModule().int(Math.max(0, query.offset ?? 0)),
        limit: this.neo4jModule().int(Math.max(0, query.limit ?? 50))
      }
    );
    return rows.records.map((record) => relationFromNeo4j(
      record.get("rel") as Neo4jRelationship,
      String(record.get("fromId")),
      String(record.get("toId"))
    ));
  }

  async listGraphMemoryNodes(query: GraphMemoryNodePageQuery): Promise<GraphMemoryNodePage> {
    const rows = await this.run(
      `MATCH (node:MemoryNode)
       WHERE node.ownerType IN $layers
         AND ($afterLayer IS NULL OR node.ownerType > $afterLayer
           OR (node.ownerType = $afterLayer AND node.ownerId > $afterId))
       RETURN node AS node
       ORDER BY node.ownerType, node.ownerId
       SKIP $offset
       LIMIT $limitPlusOne`,
      {
        layers: query.ownerTypes,
        afterLayer: query.after?.layer ?? null,
        afterId: query.after?.id ?? null,
        offset: this.neo4jModule().int(Math.max(0, query.offset ?? 0)),
        limitPlusOne: this.neo4jModule().int(query.limit + 1)
      }
    );
    const nodes = rows.records.map((record) => graphMemoryNodeFromNeo4j(
      record.get("node") as Neo4jNode
    ));
    return {
      nodes: nodes.slice(0, query.limit),
      hasMore: nodes.length > query.limit
    };
  }

  async listGraphRelationEdges(query: GraphRelationEdgePageQuery): Promise<GraphRelationEdgePage> {
    const rows = await this.run(
      `MATCH (from:MemoryNode)-[rel]->(to:MemoryNode)
       WHERE from.ownerType IN $layers
         AND to.ownerType IN $layers
         AND (rel.relationType IN $relationTypes OR type(rel) IN $neo4jRelationTypes)
         AND ($afterEdgeId IS NULL OR rel.edgeId > $afterEdgeId)
       RETURN rel AS rel,
              from.ownerId AS fromId,
              to.ownerId AS toId
       ORDER BY rel.edgeId
       SKIP $offset
       LIMIT $limitPlusOne`,
      {
        layers: query.ownerTypes,
        relationTypes: query.relationTypes,
        neo4jRelationTypes: query.relationTypes.map(relationTypeToNeo4jType),
        afterEdgeId: query.after?.id ?? null,
        offset: this.neo4jModule().int(Math.max(0, query.offset ?? 0)),
        limitPlusOne: this.neo4jModule().int(query.limit + 1)
      }
    );
    const edges = rows.records.map((record) => relationFromNeo4j(
      record.get("rel") as Neo4jRelationship,
      String(record.get("fromId")),
      String(record.get("toId"))
    ));
    return {
      edges: edges.slice(0, query.limit),
      hasMore: edges.length > query.limit
    };
  }

  private async run<T = Record<string, unknown>>(query: string, parameters: Record<string, unknown> = {}) {
    return (await this.getDriver()).executeQuery<T>(query, parameters, { database: this.options.database });
  }

  private async getDriver() {
    if (this.driver) return this.driver;
    const neo4j = this.neo4j ?? await loadNeo4jDriver();
    this.neo4j = neo4j;
    this.driver = neo4j.driver(
      this.options.uri,
      neo4j.auth.basic(this.options.username, this.options.password),
      { connectionTimeout: this.options.connectionTimeoutMs ?? defaultNeo4jConnectionTimeoutMs }
    );
    return this.driver;
  }

  private neo4jModule() {
    if (!this.neo4j) throw new Error("Neo4j driver is not initialized");
    return this.neo4j;
  }

  private assertVectorDimensions(vector: number[]) {
    if (vector.length !== this.options.vectorDimensions) {
      throw new Error(`Neo4j vector dimension mismatch: expected ${this.options.vectorDimensions}, got ${vector.length}`);
    }
  }
}

function normalizeClearBatchSize(value: number | undefined) {
  if (!Number.isFinite(value)) return defaultNeo4jClearBatchSize;
  return Math.max(1, Math.floor(value as number));
}

function readNeo4jCount(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value) {
    const toNumber = (value as { toNumber?: unknown }).toNumber;
    if (typeof toNumber === "function") return Number(toNumber.call(value));
  }
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadNeo4jDriver(): Promise<Neo4jDriverModule> {
  try {
    const imported = await import("neo4j-driver");
    return (imported.default ?? imported) as Neo4jDriverModule;
  } catch (error) {
    throw new Error(`Neo4j graph store requires neo4j-driver to be installed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildFulltextQuery(queryTokens: string[]) {
  return queryTokens
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => `${token.replaceAll('"', '\\"')}*`)
    .join(" OR ");
}

function relationFromNeo4j(rel: Neo4jRelationship, fromId: string, toId: string): RelationEdge {
  const relationType = typeof rel.properties.relationType === "string"
    ? rel.properties.relationType as RelationEdge["relationType"]
    : neo4jTypeToRelationType(rel.type);
  return {
    edgeId: String(rel.properties.edgeId),
    fromId,
    toId,
    relationType,
    ...(typeof rel.properties.evidence === "string" ? { evidence: rel.properties.evidence } : {}),
    ...(typeof rel.properties.strength === "number" ? { strength: rel.properties.strength } : {}),
    ...(isRelationConfidence(rel.properties.confidence) ? { confidence: rel.properties.confidence } : {}),
    ...(isRelationSource(rel.properties.source) ? { source: rel.properties.source } : {}),
    ...(typeof rel.properties.createdAt === "string" ? { createdAt: rel.properties.createdAt } : {})
  };
}

function graphMemoryNodeFromNeo4j(node: Neo4jNode): GraphMemoryNode {
  const ownerType = node.properties.ownerType;
  const ownerId = node.properties.ownerId;
  if ((ownerType !== "stm" && ownerType !== "ltm") || typeof ownerId !== "string") {
    throw new Error("Invalid Neo4j memory node owner");
  }
  return {
    graphNodeId: typeof node.properties.graphNodeId === "string"
      ? node.properties.graphNodeId
      : `graph_${ownerType}_${ownerId}`,
    ownerType,
    ownerId,
    content: String(node.properties.content ?? ""),
    vector: Array.isArray(node.properties.embedding)
      ? node.properties.embedding.map((value) => Number(value))
      : [],
    lifecycleStatus: String(node.properties.lifecycleStatus ?? "active"),
    retrievalWeight: Number(node.properties.retrievalWeight ?? 0),
    sourceRefs: parseSourceRefs(node.properties.sourceRefsJson),
    entityIds: Array.isArray(node.properties.entityIds)
      ? node.properties.entityIds.map((value) => String(value))
      : [],
    ...(typeof node.properties.evidenceTimeStart === "string"
      ? { evidenceTimeStart: node.properties.evidenceTimeStart }
      : {}),
    ...(typeof node.properties.evidenceTimeEnd === "string"
      ? { evidenceTimeEnd: node.properties.evidenceTimeEnd }
      : {}),
    ...(isTemporalConfidence(node.properties.evidenceTimeConfidence)
      ? { evidenceTimeConfidence: node.properties.evidenceTimeConfidence }
      : { evidenceTimeConfidence: "low" }),
    ...(typeof node.properties.validTimeStart === "string"
      ? { validTimeStart: node.properties.validTimeStart }
      : {}),
    ...(typeof node.properties.validTimeEnd === "string"
      ? { validTimeEnd: node.properties.validTimeEnd }
      : {}),
    ...(isTemporalConfidence(node.properties.validTimeConfidence)
      ? { validTimeConfidence: node.properties.validTimeConfidence }
      : { validTimeConfidence: "low" }),
    refreshedAt: String(node.properties.refreshedAt ?? new Date(0).toISOString()),
    ...(typeof node.properties.memoryType === "string"
      ? { memoryType: node.properties.memoryType }
      : {}),
    ...(typeof node.properties.factSummary === "string"
      ? { factSummary: node.properties.factSummary }
      : {})
  };
}

function parseSourceRefs(value: unknown): SourceRef[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid Neo4j memory node sourceRefsJson");
  }
  if (!Array.isArray(parsed) || !parsed.every(isSourceRef)) {
    throw new Error("Invalid Neo4j memory node sourceRefsJson");
  }
  return parsed.map((sourceRef) => ({ ...sourceRef }));
}

function isSourceRef(value: unknown): value is SourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SourceRef>;
  return typeof item.sourceRefId === "string" &&
    typeof item.sourceType === "string" &&
    typeof item.sourceId === "string" &&
    (item.sourceUrl === undefined || typeof item.sourceUrl === "string");
}

function isRelationConfidence(value: unknown): value is NonNullable<RelationEdge["confidence"]> {
  return value === "low" || value === "medium" || value === "high";
}

function isTemporalConfidence(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function temporalEnvelopePredicate(alias: string) {
  return `
    $temporalBasis IS NULL OR
    ($temporalBasis = 'evidence' AND ${alias}.evidenceTimeStart IS NOT NULL
      AND datetime(${alias}.evidenceTimeStart) < datetime($temporalEnd)
      AND (datetime(${alias}.evidenceTimeStart) >= datetime($temporalStart)
        OR datetime(coalesce(${alias}.evidenceTimeEnd, ${alias}.evidenceTimeStart)) > datetime($temporalStart))) OR
    ($temporalBasis = 'valid' AND ${alias}.validTimeStart IS NOT NULL
      AND datetime(${alias}.validTimeStart) < datetime($temporalEnd)
      AND (datetime(${alias}.validTimeStart) >= datetime($temporalStart)
        OR datetime(coalesce(${alias}.validTimeEnd, ${alias}.validTimeStart)) > datetime($temporalStart)))
  `.trim();
}

function isRelationSource(value: unknown): value is NonNullable<RelationEdge["source"]> {
  return value === "rule" || value === "llm" || value === "dreaming" || value === "user" || value === "system";
}

function safeRelationshipType(relationType: RelationEdge["relationType"]) {
  const relType = relationTypeToNeo4jType(relationType);
  if (!/^[A-Z_]+$/u.test(relType)) {
    throw new Error(`Invalid Neo4j relationship type: ${relType}`);
  }
  return relType;
}

function escapeIndexName(indexName: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(indexName)) {
    throw new Error(`Invalid Neo4j index name: ${indexName}`);
  }
  return indexName;
}
