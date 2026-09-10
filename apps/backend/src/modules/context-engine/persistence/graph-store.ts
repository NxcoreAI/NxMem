import type {
  GraphMemoryNode,
  GraphMemoryOwnerType,
  GraphMemorySearchHit,
  GraphMemorySearchOptions,
  RelationEdge
} from "../domain.js";
import type {
  MemoryGraphEdgeCursor,
  MemoryGraphNodeCursor
} from "../memory-graph-query-contract.js";

export type MaybePromise<T> = T | Promise<T>;

export interface GraphRelationSearchQuery {
  fromId?: string;
  toId?: string;
  relationTypes?: RelationEdge["relationType"][];
  ownerTypes?: GraphMemoryOwnerType[];
  q?: string;
  limit?: number;
  offset?: number;
}

export interface GraphMemoryNodePageQuery {
  ownerTypes: GraphMemoryOwnerType[];
  after?: MemoryGraphNodeCursor;
  offset?: number;
  limit: number;
}

export interface GraphMemoryNodePage {
  nodes: GraphMemoryNode[];
  hasMore: boolean;
}

export interface GraphRelationEdgePageQuery {
  ownerTypes: GraphMemoryOwnerType[];
  relationTypes: RelationEdge["relationType"][];
  after?: MemoryGraphEdgeCursor;
  offset?: number;
  limit: number;
}

export interface GraphRelationEdgePage {
  edges: RelationEdge[];
  hasMore: boolean;
}

export interface GraphMemoryStore {
  initialize?(): MaybePromise<void>;
  close?(): MaybePromise<void>;
  dropVectorIndex?(): MaybePromise<void>;
  createVectorIndex?(): MaybePromise<void>;
  upsertGraphMemoryNode(node: GraphMemoryNode): MaybePromise<void>;
  deleteGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string): MaybePromise<void>;
  upsertGraphRelationEdge(edge: RelationEdge): MaybePromise<void>;
  deleteGraphRelationEdges(edgeIds: string[]): MaybePromise<void>;
  clearGraph(): MaybePromise<void>;
  searchGraphText(queryTokens: string[], options?: GraphMemorySearchOptions): MaybePromise<GraphMemorySearchHit[]>;
  searchGraphVector(queryVector: number[], options?: GraphMemorySearchOptions): MaybePromise<GraphMemorySearchHit[]>;
  getGraphRelationEdges(ownerId: string): MaybePromise<RelationEdge[]>;
  searchGraphRelationEdges(query: GraphRelationSearchQuery): MaybePromise<RelationEdge[]>;
  listGraphMemoryNodes(query: GraphMemoryNodePageQuery): MaybePromise<GraphMemoryNodePage>;
  listGraphRelationEdges(query: GraphRelationEdgePageQuery): MaybePromise<GraphRelationEdgePage>;
}

export function ownerKey(ownerType: GraphMemoryOwnerType, ownerId: string) {
  return `${ownerType}:${ownerId}`;
}

export function memoryOwnerTypeForId(ownerId: string): GraphMemoryOwnerType | undefined {
  if (ownerId.startsWith("stm_") || ownerId.startsWith("stm")) return "stm";
  if (ownerId.startsWith("ltm_") || ownerId.startsWith("ltm")) return "ltm";
  return undefined;
}

export function relationTypeToNeo4jType(relationType: RelationEdge["relationType"]) {
  return relationType.toUpperCase();
}

export function neo4jTypeToRelationType(type: string): RelationEdge["relationType"] {
  return type.toLowerCase() as RelationEdge["relationType"];
}
