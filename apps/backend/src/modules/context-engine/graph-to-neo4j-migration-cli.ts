import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getContextEngineConfig } from "../../config.js";
import { createRequiredGraphStore } from "./service-bootstrap.js";
import { createConfiguredLongMemEvalGraphStore } from "./longmemeval.js";
import {
  memoryOwnerTypeForId,
  ownerKey,
  relationTypeToNeo4jType,
  type GraphMemoryOwnerType,
  type GraphMemoryStore
} from "./persistence/graph-store.js";
import {
  normalizeGraphMemoryNodeRow,
  normalizeRelationEdgeRow
} from "./persistence/memory-repository.js";
import type { GraphMemoryNode, RelationEdge } from "./domain.js";

const config = getContextEngineConfig();
const args = process.argv.slice(2);
const readFlag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const useLongMemEvalGraph = args.includes("--graph") && readFlag("--graph") === "longmemeval";
const storeFlagValue = readFlag("--store-path");
const storePath = storeFlagValue
  ? resolve(config.projectRoot, storeFlagValue)
  : config.storage.storePath;
const sqlitePath = storePath.replace(/\.json$/u, ".sqlite");

const graphStore: GraphMemoryStore = useLongMemEvalGraph
  ? await createConfiguredLongMemEvalGraphStore(config)
  : await createRequiredGraphStore(config);

// Neo4jGraphMemoryStore 的 driver/database 是私有的；批量写入直接自建 driver。
const neo4j = (await import("neo4j-driver")).default;
const neo4jSource = useLongMemEvalGraph
  ? (config.longMemEval.graphStore.mode === "neo4j" ? config.longMemEval.graphStore.neo4j : config.graphStore.neo4j)
  : config.graphStore.neo4j;
const database = neo4jSource.database;
const driver = neo4j.driver(neo4jSource.uri, neo4j.auth.basic(neo4jSource.username, neo4jSource.password ?? ""));

const BATCH_SIZE = 1000;
const NEO4J_LABELS: Record<GraphMemoryOwnerType, string> = {
  stm: "MemoryNode:STM",
  ltm: "MemoryNode:LTM",
  fact: "MemoryNode:FACT"
};

try {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const nodeCount = (db.prepare(`SELECT COUNT(*) AS c FROM graph_memory_nodes`).get() as { c: number }).c;
  const edgeCount = (db.prepare(`SELECT COUNT(*) AS c FROM relation_edges`).get() as { c: number }).c;
  const nodeStatement = db.prepare(`
    SELECT
      g.graph_node_id AS graphNodeId,
      g.owner_id AS ownerId,
      g.owner_type AS ownerType,
      g.memory_type AS memoryType,
      g.content AS content,
      g.fact_summary AS factSummary,
      g.vector AS vector,
      g.lifecycle_status AS lifecycleStatus,
      g.retrieval_weight AS retrievalWeight,
      g.source_refs AS sourceRefs,
      g.entity_ids AS entityIds,
      g.evidence_time_start AS evidenceTimeStart,
      g.evidence_time_end AS evidenceTimeEnd,
      g.evidence_time_confidence AS evidenceTimeConfidence,
      g.valid_time_start AS validTimeStart,
      g.valid_time_end AS validTimeEnd,
      g.valid_time_confidence AS validTimeConfidence,
      g.refreshed_at AS refreshedAt,
      COALESCE(s.tenant_id, l.tenant_id) AS tenantId,
      COALESCE(s.principal_id, l.principal_id) AS principalId
    FROM graph_memory_nodes g
    LEFT JOIN short_term_memories s
      ON g.owner_type = 'stm' AND s.memory_data_id = g.owner_id
    LEFT JOIN long_term_memories l
      ON g.owner_type = 'ltm' AND l.memory_id = g.owner_id
    ORDER BY g.owner_type, g.owner_id
  `);
  const edgeStatement = db.prepare(`
    SELECT
      edge_id AS edgeId,
      from_id AS fromId,
      to_id AS toId,
      relation_type AS relationType,
      evidence,
      strength,
      confidence,
      source,
      created_at AS createdAt
    FROM relation_edges
    ORDER BY edge_id
  `);
  process.stderr.write(`streaming ${nodeCount} nodes, ${edgeCount} edges from ${sqlitePath} into ${neo4jSource.uri} db=${database}\n`);

  await driver.executeQuery(
    `CREATE CONSTRAINT memory_node_owner_key IF NOT EXISTS
     FOR (node:MemoryNode) REQUIRE node.ownerKey IS UNIQUE`,
    {}, { database }
  );

  let migratedNodes = 0;
  const nodeBatch = new Map<GraphMemoryOwnerType, GraphMemoryNode[]>();
  let dimensionMismatch: string | undefined;
  const factsOnly = args.includes("--facts-only");
  const flushNodes = async () => {
    for (const [ownerType, nodes] of nodeBatch) {
      if (!nodes.length) continue;
      await driver.executeQuery(`
        UNWIND $rows AS row
        MERGE (node:${NEO4J_LABELS[ownerType]} {ownerKey: row.ownerKey})
        SET node.ownerType = row.ownerType,
            node.ownerId = row.ownerId,
            node.graphNodeId = row.graphNodeId,
            node.memoryType = row.memoryType,
            node.content = row.content,
            node.factSummary = row.factSummary,
            node.lifecycleStatus = row.lifecycleStatus,
            node.sourceRefsJson = row.sourceRefsJson,
            node.entityIds = row.entityIds,
            node.retrievalWeight = row.retrievalWeight,
            node.tenantId = row.tenantId,
            node.principalId = row.principalId,
            node.evidenceTimeStart = row.evidenceTimeStart,
            node.evidenceTimeEnd = row.evidenceTimeEnd,
            node.evidenceTimeConfidence = row.evidenceTimeConfidence,
            node.validTimeStart = row.validTimeStart,
            node.validTimeEnd = row.validTimeEnd,
            node.validTimeConfidence = row.validTimeConfidence,
            node.embedding = row.embedding,
            node.refreshedAt = row.refreshedAt`,
        { rows: nodes.map(nodeRow) },
        { database }
      );
    }
    nodeBatch.clear();
  };
  if (!factsOnly) {
    for (const row of nodeStatement.iterate() as IterableIterator<Record<string, unknown>>) {
      const node = withTenant(normalizeGraphMemoryNodeRow(parseJsonColumns(row)), row);
      if (node.vector.length !== config.embedding.dimensions) {
        dimensionMismatch = `node ${node.ownerType}:${node.ownerId} has vector length ${node.vector.length}, expected ${config.embedding.dimensions}. Run pnpm reindex:embeddings first.`;
        break;
      }
      const ownerType = (node.ownerType as GraphMemoryOwnerType) ?? "stm";
      const batch = nodeBatch.get(ownerType) ?? [];
      batch.push(node);
      nodeBatch.set(ownerType, batch);
      migratedNodes += 1;
      if (batch.length >= BATCH_SIZE) await flushNodes();
      if (migratedNodes % 100_000 === 0) process.stderr.write(`nodes ${migratedNodes}/${nodeCount}\n`);
    }
    await flushNodes();
    if (dimensionMismatch) throw new Error(dimensionMismatch);
    process.stderr.write(`nodes done: ${migratedNodes}\n`);
  }

  let migratedEdges = 0;
  let skippedEdges = 0;
  const edgeBatch = new Map<string, RelationEdge[]>();
  const flushEdges = async () => {
    for (const [relType, edges] of edgeBatch) {
      if (!edges.length) continue;
      await driver.executeQuery(`
        UNWIND $rows AS row
        MATCH (from:MemoryNode {ownerKey: row.fromOwnerKey})
        MATCH (to:MemoryNode {ownerKey: row.toOwnerKey})
        MERGE (from)-[rel:${relationTypeToNeo4jType(relType as RelationEdge["relationType"])} {edgeId: row.edgeId}]->(to)
        SET rel.relationType = row.relationType,
            rel.evidence = row.evidence,
            rel.strength = row.strength,
            rel.confidence = row.confidence,
            rel.source = row.source,
            rel.createdAt = row.createdAt`,
        { rows: edges.map(edgeRow) },
        { database }
      );
    }
    edgeBatch.clear();
  };
  if (!factsOnly) {
    for (const row of edgeStatement.iterate() as IterableIterator<Record<string, unknown>>) {
      const edge = normalizeRelationEdgeRow(row);
      const fromType = memoryOwnerTypeForId(edge.fromId);
      const toType = memoryOwnerTypeForId(edge.toId);
      if (!fromType || !toType) {
        skippedEdges += 1;
        continue;
      }
      const batch = edgeBatch.get(edge.relationType) ?? [];
      batch.push(edge);
      edgeBatch.set(edge.relationType, batch);
      migratedEdges += 1;
      if (batch.length >= BATCH_SIZE) await flushEdges();
      if (migratedEdges % 500_000 === 0) process.stderr.write(`edges ${migratedEdges}/${edgeCount}\n`);
    }
    await flushEdges();
    process.stderr.write(`edges done: ${migratedEdges}\n`);
  }

  let migratedFactNodes = 0;
  let factEdges = 0;
  let factsWithoutVector = 0;
  if (args.includes("--include-facts")) {
    const factVectorCount = (db.prepare(`
      SELECT COUNT(*) AS c FROM context_vector_index_entries WHERE owner_type = 'fact'
    `).get() as { c: number }).c;
    const factStatement = db.prepare(`
      SELECT
        f.fact_id AS factId,
        f.fact_type AS memoryType,
        v.content AS content,
        v.vector AS vector,
        f.status AS lifecycleStatus,
        f.confidence_level AS confidenceLevel,
        f.linked_source_refs AS sourceRefs,
        f.entity_ids AS entityIds,
        f.tenant_id AS tenantId,
        f.principal_id AS principalId,
        f.evidence_time_start AS evidenceTimeStart,
        f.evidence_time_end AS evidenceTimeEnd,
        f.evidence_time_confidence AS evidenceTimeConfidence,
        f.valid_time_start AS validTimeStart,
        f.valid_time_end AS validTimeEnd,
        f.valid_time_confidence AS validTimeConfidence,
        f.evidence_time AS evidenceTime,
        f.valid_time AS validTime,
        v.refreshed_at AS refreshedAt
      FROM fact_items f
      JOIN context_vector_index_entries v
        ON v.owner_type = 'fact' AND v.owner_id = f.fact_id
      WHERE f.status IN ('active', 'conflicted')
    `);
    process.stderr.write(`streaming facts with stored vectors (~${factVectorCount})\n`);

    const memoriesByEntity = new Map<string, Array<{ ownerType: GraphMemoryOwnerType; ownerId: string }>>();
    const memoryEntityStatement = db.prepare(`
      SELECT owner_id AS ownerId, owner_type AS ownerType, entity_ids AS entityIds
      FROM graph_memory_nodes
    `);
    for (const row of memoryEntityStatement.iterate() as IterableIterator<Record<string, unknown>>) {
      const ownerType = String(row.ownerType) as GraphMemoryOwnerType;
      const ownerId = String(row.ownerId);
      const entityIds = typeof row.entityIds === "string" ? JSON.parse(row.entityIds) as string[] : [];
      for (const entityId of entityIds) {
        const owners = memoriesByEntity.get(entityId) ?? [];
        owners.push({ ownerType, ownerId });
        memoriesByEntity.set(entityId, owners);
      }
    }

    const FACT_WEIGHT: Record<string, number> = { high: 1, medium: 0.6, low: 0.3 };
    let factEdgeBatch: RelationEdge[] = [];
    const flushFactEdges = async () => {
      if (!factEdgeBatch.length) return;
      await flushNodes(); // 先保证 fact 节点已入库，MATCH 端点才不落空
      await driver.executeQuery(`
        UNWIND $rows AS row
        MATCH (from:MemoryNode {ownerKey: row.fromOwnerKey})
        MATCH (to:MemoryNode {ownerKey: row.toOwnerKey})
        MERGE (from)-[rel:RELATED_TO {edgeId: row.edgeId}]->(to)
        SET rel.relationType = row.relationType,
            rel.evidence = row.evidence,
            rel.source = row.source,
            rel.createdAt = row.createdAt`,
        { rows: factEdgeBatch.map(edgeRow) },
        { database }
      );
      factEdgeBatch = [];
    };

    for (const row of factStatement.iterate() as IterableIterator<Record<string, unknown>>) {
      const parsed = parseJsonColumns(row);
      const factId = String(parsed.factId);
      const vector = parsed.vector as number[];
      if (!Array.isArray(vector) || vector.length !== config.embedding.dimensions) {
        factsWithoutVector += 1;
        continue;
      }
      const sourceRefs = Array.isArray(parsed.sourceRefs) ? parsed.sourceRefs as GraphMemoryNode["sourceRefs"] : [];
      const node: GraphMemoryNode = {
        graphNodeId: `graph_fact_${factId}`,
        ownerId: factId,
        ownerType: "fact",
        ...(parsed.memoryType ? { memoryType: String(parsed.memoryType) } : {}),
        content: String(parsed.content ?? ""),
        vector,
        lifecycleStatus: String(parsed.lifecycleStatus ?? "active"),
        retrievalWeight: FACT_WEIGHT[String(parsed.confidenceLevel)] ?? 0.3,
        sourceRefs,
        entityIds: Array.isArray(parsed.entityIds) ? parsed.entityIds as string[] : [],
        ...(typeof parsed.tenantId === "string" ? { tenantId: parsed.tenantId } : {}),
        ...(typeof parsed.principalId === "string" ? { principalId: parsed.principalId } : {}),
        ...(typeof parsed.evidenceTimeStart === "string" ? { evidenceTimeStart: parsed.evidenceTimeStart } : {}),
        ...(typeof parsed.evidenceTimeEnd === "string" ? { evidenceTimeEnd: parsed.evidenceTimeEnd } : {}),
        ...(typeof parsed.evidenceTimeConfidence === "string" ? { evidenceTimeConfidence: parsed.evidenceTimeConfidence as GraphMemoryNode["evidenceTimeConfidence"] } : {}),
        ...(typeof parsed.validTimeStart === "string" ? { validTimeStart: parsed.validTimeStart } : {}),
        ...(typeof parsed.validTimeEnd === "string" ? { validTimeEnd: parsed.validTimeEnd } : {}),
        ...(typeof parsed.validTimeConfidence === "string" ? { validTimeConfidence: parsed.validTimeConfidence as GraphMemoryNode["validTimeConfidence"] } : {}),
        refreshedAt: String(parsed.refreshedAt ?? new Date(0).toISOString())
      };
      const batch = nodeBatch.get("fact") ?? [];
      batch.push(node);
      nodeBatch.set("fact", batch);
      migratedFactNodes += 1;
      if (batch.length >= BATCH_SIZE) await flushNodes();

      const seen = new Set<string>();
      for (const entityId of node.entityIds) {
        for (const memory of memoriesByEntity.get(entityId) ?? []) {
          const key = `${memory.ownerType}:${memory.ownerId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          factEdgeBatch.push(factMemoryEdge(factId, memory.ownerId));
          factEdges += 1;
        }
      }
      if (factEdgeBatch.length >= BATCH_SIZE) await flushFactEdges();
      if (migratedFactNodes % 100_000 === 0) process.stderr.write(`fact nodes ${migratedFactNodes}\n`);
    }
    await flushNodes();
    await flushFactEdges();
    process.stderr.write(`fact nodes done: ${migratedFactNodes}, fact-memory edges: ${factEdges}, facts without vector: ${factsWithoutVector}\n`);
  }

  db.close();

  process.stdout.write(`${JSON.stringify({
    storePath: sqlitePath,
    graph: useLongMemEvalGraph ? "longmemeval" : "default",
    database,
    migratedNodes,
    migratedEdges,
    skippedEdges,
    migratedFactNodes,
    factMemoryEdges: factEdges,
    factsWithoutVector,
    vectorDimensions: config.embedding.dimensions,
    note: factsWithoutVector
      ? "Facts without a stored vector were skipped; backfill them with pnpm reindex:facts."
      : undefined
  }, null, 2)}\n`);
} finally {
  await driver.close();
  await graphStore.close?.();
}

function nodeRow(node: GraphMemoryNode) {
  return {
    ownerKey: ownerKey(node.ownerType as GraphMemoryOwnerType, node.ownerId),
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
    tenantId: node.tenantId ?? null,
    principalId: node.principalId ?? null,
    evidenceTimeStart: node.evidenceTimeStart ?? null,
    evidenceTimeEnd: node.evidenceTimeEnd ?? null,
    evidenceTimeConfidence: node.evidenceTimeConfidence ?? "low",
    validTimeStart: node.validTimeStart ?? null,
    validTimeEnd: node.validTimeEnd ?? null,
    validTimeConfidence: node.validTimeConfidence ?? "low",
    embedding: node.vector,
    refreshedAt: node.refreshedAt
  };
}

function edgeRow(edge: RelationEdge) {
  return {
    fromOwnerKey: ownerKey(memoryOwnerTypeForId(edge.fromId)!, edge.fromId),
    toOwnerKey: ownerKey(memoryOwnerTypeForId(edge.toId)!, edge.toId),
    edgeId: edge.edgeId,
    relationType: edge.relationType,
    evidence: edge.evidence ?? null,
    strength: edge.strength ?? null,
    confidence: edge.confidence ?? null,
    source: edge.source ?? null,
    createdAt: edge.createdAt ?? null
  };
}

function parseJsonColumns(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    vector: typeof row.vector === "string" ? JSON.parse(row.vector) : row.vector,
    sourceRefs: typeof row.sourceRefs === "string" ? JSON.parse(row.sourceRefs) : row.sourceRefs,
    entityIds: typeof row.entityIds === "string" ? JSON.parse(row.entityIds) : row.entityIds
  };
}

// 与 memory-graph.ts 的 reconcileMemoryGraphForFacts 保持同一 edgeId 规则，重跑幂等
function factMemoryEdge(factId: string, memoryOwnerId: string): RelationEdge {
  const [fromId, toId] = [factId, memoryOwnerId].sort();
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_\-:.]/g, "_");
  return {
    edgeId: `edge_related_to_${sanitize(fromId)}_${sanitize(toId)}`,
    fromId,
    toId,
    relationType: "related_to",
    evidence: "shared_entity"
  };
}

function withTenant(node: GraphMemoryNode, row: Record<string, unknown>): GraphMemoryNode {
  const ownerType = node.ownerType as GraphMemoryOwnerType;
  return {
    ...node,
    ...(ownerType !== "fact" && typeof row.tenantId === "string" ? { tenantId: row.tenantId } : {}),
    ...(ownerType !== "fact" && typeof row.principalId === "string" ? { principalId: row.principalId } : {})
  };
}
