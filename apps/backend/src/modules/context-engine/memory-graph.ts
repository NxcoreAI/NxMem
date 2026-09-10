import type { LongTermMemory, RelationEdge, ShortTermMemory } from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

type RelationType = RelationEdge["relationType"];

type MemoryGraphNode = {
  id: string;
  layer: "stm" | "ltm";
  content: string;
  sourceRefIds: string[];
  sourceFactIds: string[];
  sourceMemoryDataIds: string[];
  entityIds: string[];
  conflict: "none" | "possible" | "known";
};

const symmetricRelations = new Set<RelationType>([
  "is_same_as",
  "alias_of",
  "same_source",
  "supports",
  "conflicts_with",
  "related_to",
  "updates"
]);

export async function reconcileMemoryGraphForShortTermMemory(
  repository: ContextEngineRepository,
  memoryDataId: string
) {
  const snapshot = repository.getDebugSnapshot();
  const memory = snapshot.shortTermMemories.find((item) => item.memoryDataId === memoryDataId);
  if (!memory) return [];

  const target = shortTermNode(memory);
  const candidates = [
    ...snapshot.shortTermMemories.filter((item) => item.memoryDataId !== memoryDataId).map(shortTermNode),
    ...snapshot.longTermMemories.map(longTermNode)
  ];

  return saveRelations(repository, target, candidates);
}

export async function reconcileMemoryGraphForLongTermMemory(
  repository: ContextEngineRepository,
  memoryId: string
) {
  const snapshot = repository.getDebugSnapshot();
  const memory = snapshot.longTermMemories.find((item) => item.memoryId === memoryId);
  if (!memory) return [];

  const saved: RelationEdge[] = [];
  for (const sourceMemoryDataId of memory.sourceMemoryDataIds) {
    const edge = createRelationEdge(longTermNode(memory), {
      id: sourceMemoryDataId,
      layer: "stm",
      content: "",
      sourceRefIds: [],
      sourceFactIds: [],
      sourceMemoryDataIds: [],
      entityIds: [],
      conflict: "none"
    }, "derived_from", "ltm_dreaming_consolidation");
    await repository.saveRelationEdge(edge);
    saved.push(edge);
  }

  const target = longTermNode(memory);
  const candidates = snapshot.longTermMemories
    .filter((item) => item.memoryId !== memoryId)
    .map(longTermNode);
  saved.push(...await saveRelations(repository, target, candidates));
  return saved;
}

async function saveRelations(
  repository: ContextEngineRepository,
  target: MemoryGraphNode,
  candidates: MemoryGraphNode[]
) {
  const saved: RelationEdge[] = [];
  for (const candidate of candidates) {
    for (const relation of inferRelations(target, candidate)) {
      const edge = relation.reverse
        ? createRelationEdge(candidate, target, relation.type, relation.evidence)
        : createRelationEdge(target, candidate, relation.type, relation.evidence);
      await repository.saveRelationEdge(edge);
      saved.push(edge);
    }
  }
  return saved;
}

function inferRelations(left: MemoryGraphNode, right: MemoryGraphNode): Array<{ type: RelationType; evidence: string; reverse?: boolean }> {
  const relations: Array<{ type: RelationType; evidence: string; reverse?: boolean }> = [];

  if (normalizeMemoryContent(left.content) === normalizeMemoryContent(right.content)) {
    relations.push({ type: "is_same_as", evidence: "normalized_content_match" });
  }

  const sharesFact = intersects(left.sourceFactIds, right.sourceFactIds);
  const sharesSourceMemory = intersects(left.sourceMemoryDataIds, right.sourceMemoryDataIds);
  const sharesSource = intersects(left.sourceRefIds, right.sourceRefIds);
  const sharesEntity = intersects(left.entityIds, right.entityIds);
  const conflict = hasConflictSignal(left, right);
  const update = hasUpdateSignal(left, right);
  const aliasDirection = aliasDirectionFor(left, right);
  const partDirection = partOfDirectionFor(left, right);
  const canSupport = !conflict && !update && (sharesFact || sharesSource || sharesEntity || sharesSourceMemory);

  if (conflict && (sharesFact || sharesSource || sharesEntity || sharesSourceMemory)) {
    relations.push({ type: "conflicts_with", evidence: "memory_graph_conflict_signal" });
  }
  if (update && (sharesFact || sharesSource || sharesEntity || sharesSourceMemory)) {
    relations.push({ type: "updates", evidence: "memory_graph_update_signal" });
  }
  if (aliasDirection) {
    relations.push({ type: "alias_of", evidence: "memory_graph_alias_signal", reverse: aliasDirection === "right_to_left" });
  }
  if (partDirection) {
    relations.push({ type: "part_of", evidence: "memory_graph_part_of_signal", reverse: partDirection === "right_to_left" });
  }
  if (sharesFact || sharesSourceMemory) {
    relations.push({ type: "derived_from", evidence: sharesFact ? "shared_source_fact" : "shared_source_memory" });
  }
  if (sharesSource) {
    relations.push({ type: "same_source", evidence: "shared_source_ref" });
  }
  if (canSupport) {
    relations.push({ type: "supports", evidence: "shared_context_without_conflict" });
  }
  if (sharesEntity) {
    relations.push({ type: "related_to", evidence: "shared_entity" });
  }
  return relations;
}

function createRelationEdge(
  left: MemoryGraphNode,
  right: MemoryGraphNode,
  relationType: RelationType,
  evidence: string
): RelationEdge {
  const [fromId, toId] = edgeEndpoints(left.id, right.id, relationType);
  return {
    edgeId: `edge_${relationType}_${sanitizeEdgePart(fromId)}_${sanitizeEdgePart(toId)}`,
    fromId,
    toId,
    relationType,
    evidence
  };
}

function edgeEndpoints(leftId: string, rightId: string, relationType: RelationType): [string, string] {
  if (relationType === "derived_from" && !leftId.startsWith("ltm_")) {
    return leftId <= rightId ? [leftId, rightId] : [rightId, leftId];
  }
  if (!symmetricRelations.has(relationType)) return [leftId, rightId];
  return leftId <= rightId ? [leftId, rightId] : [rightId, leftId];
}

function shortTermNode(memory: ShortTermMemory): MemoryGraphNode {
  return {
    id: memory.memoryDataId,
    layer: "stm",
    content: memory.content,
    sourceRefIds: memory.sourceRefs.map((source) => source.sourceRefId),
    sourceFactIds: memory.sourceFactIds,
    sourceMemoryDataIds: [],
    entityIds: memory.entityIds,
    conflict: memory.admissionSignals.conflict
  };
}

function longTermNode(memory: LongTermMemory): MemoryGraphNode {
  return {
    id: memory.memoryId,
    layer: "ltm",
    content: memory.content,
    sourceRefIds: memory.sourceRefs.map((source) => source.sourceRefId),
    sourceFactIds: memory.sourceFactIds ?? [],
    sourceMemoryDataIds: memory.sourceMemoryDataIds,
    entityIds: memory.entityIds,
    conflict: memory.lifecycleStatus === "rejected" ? "known" : "none"
  };
}

function normalizeMemoryContent(content: string) {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function intersects(left: string[], right: string[]) {
  if (!left.length || !right.length) return false;
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function hasConflictSignal(left: MemoryGraphNode, right: MemoryGraphNode) {
  if (left.conflict === "known" || right.conflict === "known") return true;
  const text = `${left.content}\n${right.content}`;
  return /冲突|矛盾|不一致|conflict|contradict/i.test(text);
}

function hasUpdateSignal(left: MemoryGraphNode, right: MemoryGraphNode) {
  const text = `${left.content}\n${right.content}`;
  return /更新|修订|变更|改为|加入|updated?|changed?|revised?/i.test(text);
}

function aliasDirectionFor(left: MemoryGraphNode, right: MemoryGraphNode): "left_to_right" | "right_to_left" | undefined {
  if (!intersects(left.entityIds, right.entityIds)) return undefined;
  const leftAlias = hasAliasSignal(left.content);
  const rightAlias = hasAliasSignal(right.content);
  if (leftAlias && !rightAlias) return "left_to_right";
  if (rightAlias && !leftAlias) return "right_to_left";
  if (leftAlias && rightAlias) return "left_to_right";
  return undefined;
}

function partOfDirectionFor(left: MemoryGraphNode, right: MemoryGraphNode): "left_to_right" | "right_to_left" | undefined {
  if (!intersects(left.entityIds, right.entityIds)) return undefined;
  const leftPart = hasPartOfSignal(left.content);
  const rightPart = hasPartOfSignal(right.content);
  const leftWhole = hasWholeSignal(left.content);
  const rightWhole = hasWholeSignal(right.content);
  if (leftPart && (rightWhole || !rightPart)) return "left_to_right";
  if (rightPart && (leftWhole || !leftPart)) return "right_to_left";
  return undefined;
}

function hasAliasSignal(content: string) {
  return /别名|又称|也叫|简称|alias|aka|also known as/i.test(content);
}

function hasPartOfSignal(content: string) {
  return /一部分|属于|隶属|归属于|包含于|part of|belongs to|component of/i.test(content);
}

function hasWholeSignal(content: string) {
  return /包含|包括|由.+组成|下设|has part|includes?|contains?|comprises?/i.test(content);
}

function sanitizeEdgePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_\-:.]/g, "_");
}
