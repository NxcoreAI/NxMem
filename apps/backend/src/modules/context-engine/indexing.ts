import type {
  ContextIndexEntry,
  ContextTextIndexEntry,
  ContextVectorIndexEntry,
  FactItem,
  LongTermMemory,
  MemoryTemporalMetadata,
  ShortTermMemory
} from "./domain.js";
import { normalizeMemoryTemporalMetadata } from "./memory-temporal.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { isLongTermRecallEligible, isShortTermRecallEligible } from "./lifecycle.js";
import { createEmbeddingClient, type EmbeddingClient } from "./embedding.js";
import { longTermRetrievalWeight, shortTermRetrievalWeight } from "./retrieval-weight.js";
import { estimateContextTokens } from "./token-estimator.js";
import { tokenizeSearchDocument } from "./search-tokenizer.js";

export async function refreshShortTermMemoryIndex(
  repository: ContextEngineRepository,
  memory: ShortTermMemory,
  embeddingClient: EmbeddingClient = createEmbeddingClient()
): Promise<ContextIndexEntry | undefined> {
  return (await refreshShortTermMemoryIndexes(repository, [memory], embeddingClient))[0];
}

export async function refreshShortTermMemoryIndexes(
  repository: ContextEngineRepository,
  memories: readonly ShortTermMemory[],
  embeddingClient: EmbeddingClient = createEmbeddingClient()
): Promise<Array<ContextIndexEntry | undefined>> {
  const results: Array<ContextIndexEntry | undefined> = new Array(memories.length).fill(undefined);
  const eligible: Array<{ index: number; memory: ShortTermMemory; entry: ContextIndexEntry }> = [];
  const eligibleMemories: Array<{ index: number; memory: ShortTermMemory }> = [];

  for (const [index, memory] of memories.entries()) {
    if (!isShortTermRecallEligible(memory)) {
      await repository.deleteIndexBundle("stm", memory.memoryDataId);
      continue;
    }
    eligibleMemories.push({ index, memory });
  }
  if (!eligibleMemories.length) return results;

  const factIds = [...new Set(eligibleMemories.flatMap(({ memory }) => memory.sourceFactIds))];
  const factById = new Map(
    (await repository.getFactItemsByIds(factIds)).map((fact) => [fact.factId, fact])
  );
  for (const { index, memory } of eligibleMemories) {
    const facts = memory.sourceFactIds.flatMap((factId) => {
      const fact = factById.get(factId);
      return fact ? [fact] : [];
    });
    eligible.push({
      index,
      memory,
      entry: buildIndexEntry(
        "stm",
        memory.memoryDataId,
        buildShortTermMemorySearchContent(memory, facts),
        memory.lifecycleStatus
      )
    });
  }

  const vectors = await embeddingClient.embed(eligible.map(({ entry }) => entry.content));
  if (vectors.length !== eligible.length) {
    throw new Error(`Embedding returned ${vectors.length} STM vectors for ${eligible.length} inputs`);
  }

  await Promise.all(eligible.map(async ({ index, memory, entry }, vectorIndex) => {
    const vector = vectors[vectorIndex]?.embedding;
    if (!vector) throw new Error(`Embedding omitted STM vector at index ${vectorIndex}`);
    await persistIndexBundleWithVector(repository, entry, {
      ...(memory.memoryType ? { memoryType: memory.memoryType } : {}),
      ...(memory.factSummary ? { factSummary: memory.factSummary } : {}),
      sourceRefs: memory.sourceRefs,
      entityIds: memory.entityIds,
      ...normalizeMemoryTemporalMetadata(memory),
      retrievalWeight: memory.retrievalWeight ?? shortTermRetrievalWeight(memory.importanceLevel)
    }, vector);
    results[index] = entry;
  }));
  return results;
}

export async function refreshLongTermMemoryIndex(
  repository: ContextEngineRepository,
  memory: LongTermMemory,
  embeddingClient: EmbeddingClient = createEmbeddingClient()
): Promise<ContextIndexEntry | undefined> {
  if (!isLongTermRecallEligible(memory)) {
    await repository.deleteIndexBundle("ltm", memory.memoryId);
    return undefined;
  }

  const entry = buildIndexEntry("ltm", memory.memoryId, memory.content, memory.lifecycleStatus);
  await persistIndexBundle(repository, entry, {
    memoryType: memory.memoryType,
    ...(memory.factSummary ? { factSummary: memory.factSummary } : {}),
    sourceRefs: memory.sourceRefs,
    entityIds: memory.entityIds,
    ...normalizeMemoryTemporalMetadata(memory),
    retrievalWeight: memory.retrievalWeight ?? longTermRetrievalWeight(memory.recallWeight)
  }, embeddingClient);
  return entry;
}

function buildIndexEntry(
  ownerType: "stm" | "ltm",
  ownerId: string,
  content: string,
  lifecycleStatus: string
): ContextIndexEntry {
  return {
    indexId: `idx_${ownerType}_${ownerId}`,
    ownerId,
    ownerType,
    content,
    lifecycleStatus,
    refreshedAt: new Date().toISOString(),
    tokenCount: estimateContextTokens(content)
  };
}

async function persistIndexBundle(
  repository: ContextEngineRepository,
  entry: ContextIndexEntry,
  graphMetadata: Pick<ShortTermMemory | LongTermMemory, "sourceRefs" | "entityIds" | "memoryType" | "factSummary"> &
    MemoryTemporalMetadata & { retrievalWeight: number },
  embeddingClient: EmbeddingClient
) {
  const ownerType = entry.ownerType;
  const [embedded] = await embeddingClient.embed([entry.content]);
  if (!embedded) throw new Error(`Embedding returned no vector for ${ownerType}:${entry.ownerId}`);
  await persistIndexBundleWithVector(repository, entry, graphMetadata, embedded.embedding);
}

async function persistIndexBundleWithVector(
  repository: ContextEngineRepository,
  entry: ContextIndexEntry,
  graphMetadata: Pick<ShortTermMemory | LongTermMemory, "sourceRefs" | "entityIds" | "memoryType" | "factSummary"> &
    MemoryTemporalMetadata & { retrievalWeight: number },
  vector: number[]
) {
  const ownerType = entry.ownerType;
  await repository.deleteIndexBundle(ownerType, entry.ownerId);
  await yieldToEventLoop();
  await repository.saveIndexEntry(entry);
  await yieldToEventLoop();
  await saveVectorAndGraphNode(repository, entry, graphMetadata, vector);
  await yieldToEventLoop();

  await repository.saveTextIndexEntry(buildTextIndexEntry(entry));
  await yieldToEventLoop();

}

export function buildTextIndexEntry(entry: ContextIndexEntry): ContextTextIndexEntry {
  const tokens = tokenizeSearchDocument(entry.content);
  return {
    indexId: entry.indexId,
    ownerId: entry.ownerId,
    ownerType: entry.ownerType,
    term: tokens.join(" "),
    documentFrequency: 1,
    termFrequency: tokens.length,
    documentLength: Math.max(1, tokens.length),
    lifecycleStatus: entry.lifecycleStatus,
    refreshedAt: entry.refreshedAt
  };
}

export function buildFactSearchContent(fact: FactItem) {
  return [...new Set([fact.factText, fact.normalizedClaim, fact.sourceClaim ?? ""]
    .map((value) => value.replace(/\s+/gu, " ").trim())
    .filter(Boolean))].join("\n");
}

export async function refreshFactIndexes(
  repository: ContextEngineRepository,
  facts: readonly FactItem[],
  embeddingClient: EmbeddingClient = createEmbeddingClient()
) {
  const entries = facts.map((fact): ContextIndexEntry => ({
    indexId: `idx_fact_${fact.factId}`,
    ownerId: fact.factId,
    ownerType: "fact",
    content: buildFactSearchContent(fact),
    lifecycleStatus: fact.status,
    refreshedAt: new Date().toISOString(),
    tokenCount: estimateContextTokens(buildFactSearchContent(fact))
  }));
  const vectors = await embeddingClient.embed(entries.map((entry) => entry.content));
  if (vectors.length !== entries.length) throw new Error(`Embedding returned ${vectors.length} Fact vectors for ${entries.length} inputs`);
  for (const [index, entry] of entries.entries()) {
    const vector = vectors[index]?.embedding;
    if (!vector) throw new Error(`Embedding omitted Fact vector at index ${index}`);
    await repository.deleteIndexBundle("fact", entry.ownerId);
    await repository.saveIndexEntry(entry);
    await repository.saveTextIndexEntry(buildTextIndexEntry(entry));
    await repository.saveVectorIndexEntry({
      indexId: entry.indexId,
      ownerId: entry.ownerId,
      ownerType: "fact",
      content: entry.content,
      vector,
      lifecycleStatus: entry.lifecycleStatus,
      refreshedAt: entry.refreshedAt
    });
  }
  return entries;
}

export async function replaceShortTermMemoryEmbedding(
  repository: ContextEngineRepository,
  memory: ShortTermMemory,
  vector: number[],
  refreshedAt = new Date().toISOString(),
  indexContent = memory.content
) {
  const entry = buildIndexEntry("stm", memory.memoryDataId, indexContent, memory.lifecycleStatus);
  entry.refreshedAt = refreshedAt;
  await saveVectorAndGraphNode(repository, entry, {
    ...(memory.memoryType ? { memoryType: memory.memoryType } : {}),
    ...(memory.factSummary ? { factSummary: memory.factSummary } : {}),
    sourceRefs: memory.sourceRefs,
    entityIds: memory.entityIds,
    ...normalizeMemoryTemporalMetadata(memory),
    retrievalWeight: memory.retrievalWeight ?? shortTermRetrievalWeight(memory.importanceLevel)
  }, vector);
}

export function buildShortTermMemorySearchContent(memory: ShortTermMemory, facts: readonly FactItem[]) {
  const values = [
    memory.content,
    ...facts.flatMap((fact) => [fact.factText, fact.sourceClaim ?? "", fact.normalizedClaim])
  ].map((value) => value.replace(/\s+/gu, " ").trim()).filter(Boolean);
  return [...new Set(values)].join("\n");
}

export async function replaceLongTermMemoryEmbedding(
  repository: ContextEngineRepository,
  memory: LongTermMemory,
  vector: number[],
  refreshedAt = new Date().toISOString()
) {
  const entry = buildIndexEntry("ltm", memory.memoryId, memory.content, memory.lifecycleStatus);
  entry.refreshedAt = refreshedAt;
  await saveVectorAndGraphNode(repository, entry, {
    memoryType: memory.memoryType,
    ...(memory.factSummary ? { factSummary: memory.factSummary } : {}),
    sourceRefs: memory.sourceRefs,
    entityIds: memory.entityIds,
    ...normalizeMemoryTemporalMetadata(memory),
    retrievalWeight: memory.retrievalWeight ?? longTermRetrievalWeight(memory.recallWeight)
  }, vector);
}

async function saveVectorAndGraphNode(
  repository: ContextEngineRepository,
  entry: ContextIndexEntry,
  graphMetadata: Pick<ShortTermMemory | LongTermMemory, "sourceRefs" | "entityIds" | "memoryType" | "factSummary"> &
    MemoryTemporalMetadata & { retrievalWeight: number },
  vector: number[]
) {
  const ownerType = entry.ownerType;
  await repository.saveVectorIndexEntry({
    indexId: entry.indexId,
    ownerId: entry.ownerId,
    ownerType,
    content: entry.content,
    vector,
    lifecycleStatus: entry.lifecycleStatus,
    refreshedAt: entry.refreshedAt
  });
  if (ownerType !== "stm" && ownerType !== "ltm") return;
  await repository.upsertGraphMemoryNode({
    graphNodeId: `graph_${ownerType}_${entry.ownerId}`,
    ownerId: entry.ownerId,
    ownerType,
    ...(graphMetadata.memoryType ? { memoryType: graphMetadata.memoryType } : {}),
    content: entry.content,
    ...(graphMetadata.factSummary ? { factSummary: graphMetadata.factSummary } : {}),
    vector,
    lifecycleStatus: entry.lifecycleStatus,
    retrievalWeight: graphMetadata.retrievalWeight,
    sourceRefs: graphMetadata.sourceRefs,
    entityIds: graphMetadata.entityIds,
    ...normalizeMemoryTemporalMetadata(graphMetadata),
    refreshedAt: entry.refreshedAt
  });
  await yieldToEventLoop();
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
