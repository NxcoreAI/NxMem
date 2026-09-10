import type {
  DreamingLtmOperation,
  LongTermMemory,
  RelationEdge
} from "./domain.js";

export interface DreamingOperationInput {
  memoryDataId: string;
  memory: LongTermMemory;
  existingMemories: LongTermMemory[];
}

export function decideDreamingLtmOperation(input: DreamingOperationInput): DreamingLtmOperation {
  const sameClaim = input.existingMemories.find((memory) => normalize(memory.content) === normalize(input.memory.content));
  if (sameClaim) {
    return {
      memoryDataId: input.memoryDataId,
      operation: "create",
      targetLtmId: sameClaim.memoryId,
      resultLtmId: input.memory.memoryId,
      relationType: "is_same_as",
      reason: "normalized_claim_matches_existing_ltm"
    };
  }

  const related = input.existingMemories.filter((memory) =>
    memory.entityIds.some((id) => input.memory.entityIds.includes(id))
  );
  const relationText = input.memory.content;
  const conflict = /冲突|矛盾|不一致|否认|改为|contradict|conflict/i.test(relationText);
  if (conflict && related[0]) {
    return {
      memoryDataId: input.memoryDataId,
      operation: "conflict",
      targetLtmId: related[0].memoryId,
      resultLtmId: input.memory.memoryId,
      relationType: "conflicts_with",
      reason: "new_evidence_conflicts_with_existing_ltm"
    };
  }

  const update = input.memory.memoryType === related[0]?.memoryType &&
    /更新|修订|变更|不再|改为|现在|最新|updated?|changed?|revised?/i.test(relationText);
  if (update && related[0]) {
    return {
      memoryDataId: input.memoryDataId,
      operation: "revise",
      targetLtmId: related[0].memoryId,
      resultLtmId: input.memory.memoryId,
      relationType: "updates",
      reason: "same_subject_or_update_signal_requires_new_ltm_version"
    };
  }

  const support = /支持|证明|证实|确认|佐证|support|confirm|verify/i.test(relationText);
  if (support && related[0]) {
    return {
      memoryDataId: input.memoryDataId,
      operation: "create",
      targetLtmId: related[0].memoryId,
      resultLtmId: input.memory.memoryId,
      relationType: "supports",
      reason: "new_evidence_supports_existing_ltm"
    };
  }

  if (input.memory.memoryType === related[0]?.memoryType && related[0]) {
    return {
      memoryDataId: input.memoryDataId,
      operation: "revise",
      targetLtmId: related[0].memoryId,
      resultLtmId: input.memory.memoryId,
      relationType: "updates",
      reason: "same_subject_requires_new_ltm_version"
    };
  }

  if (related[0]) {
    return {
      memoryDataId: input.memoryDataId,
      operation: "create",
      targetLtmId: related[0].memoryId,
      resultLtmId: input.memory.memoryId,
      relationType: "related_to",
      reason: "same_subject_has_semantic_relation"
    };
  }

  return {
    memoryDataId: input.memoryDataId,
    operation: "create",
    resultLtmId: input.memory.memoryId,
    reason: "no_semantically_equivalent_existing_ltm"
  };
}

export function createDreamingOperationEdge(operation: DreamingLtmOperation): RelationEdge | undefined {
  if (!operation.targetLtmId || !operation.relationType) return undefined;
  const directional = operation.relationType === "updates" || operation.relationType === "supports";
  const fromId = directional
    ? operation.resultLtmId
    : [operation.resultLtmId, operation.targetLtmId].sort()[0]!;
  const toId = directional
    ? operation.targetLtmId
    : [operation.resultLtmId, operation.targetLtmId].sort()[1]!;
  return {
    edgeId: `edge_${operation.relationType}_${fromId}_${toId}`,
    fromId,
    toId,
    relationType: operation.relationType,
    evidence: operation.reason,
    confidence: "high",
    source: "dreaming",
    createdAt: new Date().toISOString()
  };
}

function normalize(value: string) {
  return value.toLocaleLowerCase().replace(/[\s，。！？；：:,.!?]+/gu, "").trim();
}
