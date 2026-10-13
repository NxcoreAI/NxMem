import type {
  FactItem,
  GraphMemoryNode,
  GraphMemoryOwnerType,
  GraphMemorySearchHit,
  GraphMemorySearchOptions,
  LongTermMemory,
  RelationEdge,
  ShortTermMemory
} from "../domain.js";
import type {
  GraphMemoryNodePage,
  GraphMemoryNodePageQuery,
  GraphMemoryNodeRef,
  GraphMemoryStore,
  GraphRelationEdgePage,
  GraphRelationEdgePageQuery,
  GraphRelationSearchQuery
} from "./graph-store.js";
import { memoryOwnerTypeForId } from "./graph-store.js";
import { memoryTemporalEnvelopeIntersects } from "../memory-temporal.js";
import {
  cloneGraphMemoryNode,
  cloneRelationEdge,
  compareGraphMemoryNodes,
  compareText,
  cosine,
  expandSearchTokens,
  graphMemoryNodeIsAfter
} from "./memory-repository.js";

export interface InMemoryGraphStoreCache {
  graphMemoryNodes: GraphMemoryNode[];
  relationEdges: RelationEdge[];
  shortTermMemories: ShortTermMemory[];
  longTermMemories: LongTermMemory[];
  facts: FactItem[];
}

export class InMemoryGraphMemoryStore implements GraphMemoryStore {
  constructor(private readonly cache: InMemoryGraphStoreCache) {}

  // 写方法为 no-op：仓库写路径先更新共享 cache 数组，再通知本存储。数据已在数组内。
  upsertGraphMemoryNode(_node: GraphMemoryNode): void {}
  deleteGraphMemoryNode(_ownerType: GraphMemoryOwnerType, _ownerId: string): void {}
  upsertGraphRelationEdge(_edge: RelationEdge): void {}
  deleteGraphRelationEdges(_edgeIds: string[]): void {}
  clearGraph(): void {}

  searchGraphText(queryTokens: string[], options: GraphMemorySearchOptions = {}): GraphMemorySearchHit[] {
    const normalizedTokens = expandSearchTokens(queryTokens.map((token) => token.toLowerCase()));
    if (!normalizedTokens.length) return [];
    return this.filterGraphNodes(options)
      .map((node) => {
        const normalizedContent = node.content.toLowerCase();
        const matchedTerms = normalizedTokens.filter((token) => normalizedContent.includes(token)).length;
        return {
          ownerType: node.ownerType,
          ownerId: node.ownerId,
          score: matchedTerms,
          matchedTerms
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.ownerType.localeCompare(right.ownerType) || left.ownerId.localeCompare(right.ownerId));
  }

  searchGraphVector(queryVector: number[], options: GraphMemorySearchOptions = {}): GraphMemorySearchHit[] {
    if (!queryVector.length) return [];
    return this.filterGraphNodes(options)
      .map((node) => ({
        ownerType: node.ownerType,
        ownerId: node.ownerId,
        score: cosine(queryVector, node.vector)
      }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.ownerType.localeCompare(right.ownerType) || left.ownerId.localeCompare(right.ownerId));
  }

  getGraphRelationEdges(ownerId: string): RelationEdge[] {
    return this.cache.relationEdges.filter((edge) => edge.fromId === ownerId || edge.toId === ownerId);
  }

  searchGraphRelationEdges(query: GraphRelationSearchQuery): RelationEdge[] {
    const relationTypes = query.relationTypes?.filter(Boolean);
    const ownerTypes = query.ownerTypes?.filter(Boolean);
    const evidenceQuery = query.q?.trim().toLowerCase();
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(0, query.limit ?? 50);
    const matches = this.cache.relationEdges
      .filter((edge) => !query.fromId || edge.fromId === query.fromId)
      .filter((edge) => !query.toId || edge.toId === query.toId)
      .filter((edge) => !relationTypes?.length || relationTypes.includes(edge.relationType))
      .filter((edge) => {
        if (!ownerTypes?.length) return true;
        const fromOwnerType = memoryOwnerTypeForId(edge.fromId);
        const toOwnerType = memoryOwnerTypeForId(edge.toId);
        return Boolean((fromOwnerType && ownerTypes.includes(fromOwnerType)) || (toOwnerType && ownerTypes.includes(toOwnerType)));
      })
      .filter((edge) => !evidenceQuery || (edge.evidence ?? "").toLowerCase().includes(evidenceQuery));
    return matches
      .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.edgeId.localeCompare(right.edgeId))
      .slice(offset, offset + limit);
  }

  listGraphMemoryNodes(query: GraphMemoryNodePageQuery): GraphMemoryNodePage {
    const offset = Math.max(0, query.offset ?? 0);
    const rows = this.cache.graphMemoryNodes
      .filter((node) => query.ownerTypes.includes(node.ownerType))
      .filter((node) => !query.after || graphMemoryNodeIsAfter(node, query.after))
      .sort(compareGraphMemoryNodes)
      .slice(offset, offset + query.limit + 1);
    return {
      nodes: rows.slice(0, query.limit).map(cloneGraphMemoryNode),
      hasMore: rows.length > query.limit
    };
  }

  listGraphRelationEdges(query: GraphRelationEdgePageQuery): GraphRelationEdgePage {
    const offset = Math.max(0, query.offset ?? 0);
    const nodeOwnerTypes = new Map<string, Set<GraphMemoryOwnerType>>();
    for (const node of this.cache.graphMemoryNodes) {
      const ownerTypes = nodeOwnerTypes.get(node.ownerId) ?? new Set<GraphMemoryOwnerType>();
      ownerTypes.add(node.ownerType);
      nodeOwnerTypes.set(node.ownerId, ownerTypes);
    }
    const endpointIsIncluded = (ownerId: string) =>
      [...(nodeOwnerTypes.get(ownerId) ?? [])].some((ownerType) => query.ownerTypes.includes(ownerType));
    const rows = this.cache.relationEdges
      .filter((edge) => endpointIsIncluded(edge.fromId) && endpointIsIncluded(edge.toId))
      .filter((edge) => query.relationTypes.includes(edge.relationType))
      .filter((edge) => !query.after || edge.edgeId > query.after.id)
      .sort((left, right) => compareText(left.edgeId, right.edgeId))
      .slice(offset, offset + query.limit + 1);
    return {
      edges: rows.slice(0, query.limit).map(cloneRelationEdge),
      hasMore: rows.length > query.limit
    };
  }

  listGraphNodeRefs(ownerTypes?: GraphMemoryOwnerType[]): GraphMemoryNodeRef[] {
    const allowed = ownerTypes ? new Set(ownerTypes) : undefined;
    return this.cache.graphMemoryNodes
      .filter((node) => !allowed || allowed.has(node.ownerType))
      .map((node) => ({ ownerType: node.ownerType, ownerId: node.ownerId, vectorLength: node.vector.length }));
  }

  private filterGraphNodes(options: GraphMemorySearchOptions): GraphMemoryNode[] {
    const ownerTypes = new Set(options.ownerTypes ?? ["stm", "ltm"]);
    const ownerKeys = options.ownerKeys ? new Set(options.ownerKeys) : undefined;
    return this.cache.graphMemoryNodes.filter((node) =>
      ownerTypes.has(node.ownerType) &&
      this.hasGraphNodeOwner(node) &&
      (!ownerKeys || ownerKeys.has(`${node.ownerType}:${node.ownerId}`)) &&
      (!options.tenantId || node.tenantId === options.tenantId) &&
      (!options.principalId || node.principalId === options.principalId) &&
      (!options.temporalRange || memoryTemporalEnvelopeIntersects(node, options.temporalRange))
    );
  }

  private hasGraphNodeOwner(node: GraphMemoryNode) {
    if (node.ownerType === "stm") {
      return this.cache.shortTermMemories.some((memory) => memory.memoryDataId === node.ownerId);
    }
    if (node.ownerType === "fact") {
      return this.cache.facts.some((fact) => fact.factId === node.ownerId);
    }
    return this.cache.longTermMemories.some((memory) => memory.memoryId === node.ownerId);
  }
}
