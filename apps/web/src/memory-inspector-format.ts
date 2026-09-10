interface MemoryInspectorInput {
  graphNodeId?: string;
  ownerId?: string;
  memoryDataId?: string;
  memoryId?: string;
  memoryType?: string;
  memoryDataType?: string;
  ownerType?: string;
  factSummary?: string;
  summary?: string;
  content?: string;
}

export function formatMemoryInspectorSummary(memory: MemoryInspectorInput) {
  const id = memory.memoryId ?? memory.memoryDataId ?? memory.graphNodeId ?? memory.ownerId ?? "unknown";
  const type = memory.memoryType ?? memory.memoryDataType ?? memory.ownerType ?? "unknown";
  const factSummary = memory.factSummary?.trim() || memory.summary?.trim() || memory.content?.trim() || "无短摘要";

  return {
    id,
    type,
    factSummary
  };
}
