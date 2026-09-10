import type { GraphMemoryOwnerType, RelationEdge } from "./domain.js";
import { isLongTermRecallEligible, isShortTermRecallEligible } from "./lifecycle.js";
import { memoryOwnerTypeForId, type GraphRelationSearchQuery } from "./persistence/graph-store.js";
import type { ContextDebugSnapshot, ContextEngineRepository } from "./persistence/repository.js";

export interface RelationQuery extends GraphRelationSearchQuery {
  includeInactive?: boolean;
}

export interface RelationEndpointSummary {
  id: string;
  layer: GraphMemoryOwnerType;
  memoryType?: string;
  factSummary?: string;
  summary?: string;
  contentPreview: string;
  lifecycleStatus: string;
  accessState?: string;
}

export interface RelationSearchItem {
  edge: RelationEdge;
  from?: RelationEndpointSummary;
  to?: RelationEndpointSummary;
  score: number;
  reason: string;
  permissionStatus: "allowed" | "filtered";
}

export interface RelationSearchResponse {
  total: number;
  limit: number;
  offset: number;
  items: RelationSearchItem[];
}

export async function searchRelations(
  repository: ContextEngineRepository,
  query: RelationQuery
): Promise<RelationSearchResponse> {
  const limit = Math.max(0, query.limit ?? 50);
  const offset = Math.max(0, query.offset ?? 0);
  const prefetchLimit = Math.max(limit + offset, 200);
  const edges = await repository.searchGraphRelationEdges({
    ...query,
    limit: prefetchLimit,
    offset: 0
  });
  const snapshot = repository.getDebugSnapshot();
  const items = edges
    .map((edge) => buildRelationSearchItem(edge, query, snapshot))
    .filter((item) => query.includeInactive || item.permissionStatus === "allowed");

  return {
    total: items.length,
    limit,
    offset,
    items: items.slice(offset, offset + limit)
  };
}

function buildRelationSearchItem(
  edge: RelationEdge,
  query: RelationQuery,
  snapshot: ContextDebugSnapshot
): RelationSearchItem {
  const from = endpointSummary(edge.fromId, snapshot);
  const to = endpointSummary(edge.toId, snapshot);
  const reasons: string[] = [];
  if (query.relationTypes?.includes(edge.relationType)) reasons.push("relation_type_match");
  if (query.q?.trim() && (edge.evidence ?? "").toLowerCase().includes(query.q.trim().toLowerCase())) {
    reasons.push("evidence_match");
  }
  if (!reasons.length) reasons.push("relation_match");
  const permissionStatus = isEndpointAllowed(from) && isEndpointAllowed(to) ? "allowed" : "filtered";

  return {
    edge: normalizeRelationEdge(edge),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    score: scoreRelation(edge, reasons),
    reason: reasons.join(","),
    permissionStatus
  };
}

function endpointSummary(id: string, snapshot: ContextDebugSnapshot): RelationEndpointSummary | undefined {
  const stm = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === id);
  if (stm) {
    return {
      id: stm.memoryDataId,
      layer: "stm",
      memoryType: stm.memoryType ?? stm.memoryDataType,
      ...(stm.factSummary ? { factSummary: stm.factSummary } : {}),
      ...(stm.summary ? { summary: stm.summary } : {}),
      contentPreview: previewText(stm.factSummary ?? stm.summary ?? stm.content),
      lifecycleStatus: stm.lifecycleStatus,
      ...(stm.accessState ? { accessState: stm.accessState } : {})
    };
  }

  const ltm = snapshot.longTermMemories.find((memory) => memory.memoryId === id);
  if (ltm) {
    return {
      id: ltm.memoryId,
      layer: "ltm",
      memoryType: ltm.memoryType,
      ...(ltm.factSummary ? { factSummary: ltm.factSummary } : {}),
      ...(ltm.summary ? { summary: ltm.summary } : {}),
      contentPreview: previewText(ltm.factSummary ?? ltm.summary ?? ltm.content),
      lifecycleStatus: ltm.lifecycleStatus,
      ...(ltm.accessState ? { accessState: ltm.accessState } : {})
    };
  }

  const graphNode = snapshot.graphMemoryNodes.find((node) => node.ownerId === id);
  if (graphNode) {
    return {
      id: graphNode.ownerId,
      layer: graphNode.ownerType,
      ...(graphNode.memoryType ? { memoryType: graphNode.memoryType } : {}),
      ...(graphNode.factSummary ? { factSummary: graphNode.factSummary } : {}),
      contentPreview: previewText(graphNode.factSummary ?? graphNode.content),
      lifecycleStatus: graphNode.lifecycleStatus
    };
  }

  const layer = memoryOwnerTypeForId(id);
  if (!layer) return undefined;
  return {
    id,
    layer,
    contentPreview: "",
    lifecycleStatus: "missing"
  };
}

function isEndpointAllowed(endpoint: RelationEndpointSummary | undefined) {
  if (!endpoint) return false;
  if (endpoint.layer === "stm") {
    if (endpoint.accessState === "permission-invalid") return false;
    return isShortTermRecallEligible({
      lifecycleStatus: endpoint.lifecycleStatus as never
    });
  }
  if (endpoint.accessState === "hidden" || endpoint.accessState === "permission-invalid") return false;
  return isLongTermRecallEligible({
    memoryId: endpoint.id,
    theoryClass: "semantic",
    memoryType: endpoint.memoryType ?? "unknown",
    content: endpoint.contentPreview,
    sourceRefs: [],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "low",
    recallWeight: "low",
    solidifyReason: "relation_search_endpoint_check",
    matchedRules: [],
    lifecycleStatus: endpoint.lifecycleStatus as never
  });
}

function normalizeRelationEdge(edge: RelationEdge): RelationEdge {
  return {
    edgeId: edge.edgeId,
    fromId: edge.fromId,
    toId: edge.toId,
    relationType: edge.relationType,
    ...(edge.evidence ? { evidence: edge.evidence } : {}),
    ...(typeof edge.strength === "number" ? { strength: edge.strength } : {}),
    ...(isRelationConfidence(edge.confidence) ? { confidence: edge.confidence } : {}),
    ...(isRelationSource(edge.source) ? { source: edge.source } : {}),
    ...(edge.createdAt ? { createdAt: edge.createdAt } : {})
  };
}

function scoreRelation(edge: RelationEdge, reasons: string[]) {
  const strength = typeof edge.strength === "number" ? edge.strength : 0.5;
  return strength + reasons.length * 0.1;
}

function previewText(value: string) {
  return value.trim().slice(0, 120);
}

function isRelationConfidence(value: unknown): value is NonNullable<RelationEdge["confidence"]> {
  return value === "low" || value === "medium" || value === "high";
}

function isRelationSource(value: unknown): value is NonNullable<RelationEdge["source"]> {
  return value === "rule" || value === "llm" || value === "dreaming" || value === "user" || value === "system";
}
