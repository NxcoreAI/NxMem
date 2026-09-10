import type { GraphMemoryNode, RelationEdge } from "./domain.js";
import {
  MEMORY_GRAPH_SCHEMA_VERSION,
  decodeMemoryGraphEdgeCursor,
  decodeMemoryGraphNodeCursor,
  encodeMemoryGraphEdgeCursor,
  encodeMemoryGraphNodeCursor,
  parseMemoryGraphQueryRequest,
  type MemoryGraphEdgeResponse,
  type MemoryGraphNodeResponse,
  type MemoryGraphPageResponse,
  type MemoryGraphQueryResponse,
  type NormalizedMemoryGraphPageRequest
} from "./memory-graph-query-contract.js";
import type {
  GraphMemoryNodePage,
  GraphRelationEdgePage
} from "./persistence/graph-store.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

export class MemoryGraphQueryServiceError extends Error {
  readonly code = "MEMORY_GRAPH_QUERY_FAILED" as const;

  constructor() {
    super("Memory graph query failed.");
    this.name = "MemoryGraphQueryServiceError";
  }
}

export interface QueryMemoryGraphOptions {
  now?: () => Date;
}

export async function queryMemoryGraph(
  repository: ContextEngineRepository,
  request: unknown,
  options: QueryMemoryGraphOptions = {}
): Promise<MemoryGraphQueryResponse> {
  const query = parseMemoryGraphQueryRequest(request);
  const nodeAfter = query.nodePage?.cursor
    ? decodeMemoryGraphNodeCursor(query.nodePage.cursor, query.layers)
    : undefined;
  const edgeAfter = query.edgePage?.cursor
    ? decodeMemoryGraphEdgeCursor(query.edgePage.cursor, query.layers, query.relationTypes)
    : undefined;

  try {
    const [nodeResult, edgeResult] = await Promise.all([
      query.nodePage
        ? repository.listGraphMemoryNodes({
            ownerTypes: query.layers,
            ...(nodeAfter ? { after: nodeAfter } : {}),
            ...(query.page !== undefined
              ? { offset: (query.page - 1) * query.nodePage.limit }
              : {}),
            limit: query.nodePage.limit
          })
        : null,
      query.edgePage
        ? repository.listGraphRelationEdges({
            ownerTypes: query.layers,
            relationTypes: query.relationTypes,
            ...(edgeAfter ? { after: edgeAfter } : {}),
            ...(query.page !== undefined
              ? { offset: (query.page - 1) * query.edgePage.limit }
              : {}),
            limit: query.edgePage.limit
          })
        : null
    ]);

    return {
      ok: true,
      schemaVersion: MEMORY_GRAPH_SCHEMA_VERSION,
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      ...(query.page !== undefined ? { page: query.page } : {}),
      nodes: query.nodePage && nodeResult
        ? toNodePage(nodeResult, query.nodePage, query.layers)
        : null,
      edges: query.edgePage && edgeResult
        ? toEdgePage(edgeResult, query.edgePage, query.layers, query.relationTypes)
        : null
    };
  } catch (error) {
    if (error instanceof MemoryGraphQueryServiceError) throw error;
    throw new MemoryGraphQueryServiceError();
  }
}

function toNodePage(
  result: GraphMemoryNodePage,
  page: NormalizedMemoryGraphPageRequest,
  layers: GraphMemoryNode["ownerType"][]
): MemoryGraphPageResponse<MemoryGraphNodeResponse> {
  const last = result.nodes.at(-1);
  if (result.hasMore && !last) throw new MemoryGraphQueryServiceError();
  return {
    items: result.nodes.map(toNodeResponse),
    limit: page.limit,
    nextCursor: result.hasMore && last
      ? encodeMemoryGraphNodeCursor({ layer: last.ownerType, id: last.ownerId }, layers)
      : null,
    hasMore: result.hasMore
  };
}

function toEdgePage(
  result: GraphRelationEdgePage,
  page: NormalizedMemoryGraphPageRequest,
  layers: GraphMemoryNode["ownerType"][],
  relationTypes: RelationEdge["relationType"][]
): MemoryGraphPageResponse<MemoryGraphEdgeResponse> {
  const last = result.edges.at(-1);
  if (result.hasMore && !last) throw new MemoryGraphQueryServiceError();
  return {
    items: result.edges.map(toEdgeResponse),
    limit: page.limit,
    nextCursor: result.hasMore && last
      ? encodeMemoryGraphEdgeCursor({ id: last.edgeId }, layers, relationTypes)
      : null,
    hasMore: result.hasMore
  };
}

function toNodeResponse(node: GraphMemoryNode): MemoryGraphNodeResponse {
  return {
    id: node.ownerId,
    layer: node.ownerType,
    content: node.content,
    lifecycleStatus: node.lifecycleStatus,
    retrievalWeight: node.retrievalWeight,
    sourceRefs: node.sourceRefs.map((sourceRef) => ({ ...sourceRef })),
    entityIds: [...node.entityIds],
    ...(node.evidenceTimeStart ? { evidenceTimeStart: node.evidenceTimeStart } : {}),
    ...(node.evidenceTimeEnd ? { evidenceTimeEnd: node.evidenceTimeEnd } : {}),
    evidenceTimeConfidence: node.evidenceTimeConfidence ?? "low",
    ...(node.validTimeStart ? { validTimeStart: node.validTimeStart } : {}),
    ...(node.validTimeEnd ? { validTimeEnd: node.validTimeEnd } : {}),
    validTimeConfidence: node.validTimeConfidence ?? "low",
    refreshedAt: node.refreshedAt,
    ...(node.memoryType !== undefined ? { memoryType: node.memoryType } : {}),
    ...(node.factSummary !== undefined ? { factSummary: node.factSummary } : {})
  };
}

function toEdgeResponse(edge: RelationEdge): MemoryGraphEdgeResponse {
  return {
    id: edge.edgeId,
    from: edge.fromId,
    to: edge.toId,
    type: edge.relationType,
    ...(edge.evidence !== undefined ? { evidence: edge.evidence } : {}),
    ...(edge.strength !== undefined ? { strength: edge.strength } : {}),
    ...(edge.confidence !== undefined ? { confidence: edge.confidence } : {}),
    ...(edge.source !== undefined ? { source: edge.source } : {}),
    ...(edge.createdAt !== undefined ? { createdAt: edge.createdAt } : {})
  };
}
