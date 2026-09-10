import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { getContextEngineConfig } from "../../config.js";
import { Neo4jGraphMemoryStore } from "./persistence/neo4j-graph-store.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { refreshShortTermMemoryIndex } from "./indexing.js";
import { isShortTermRecallEligible } from "./lifecycle.js";
import { createEmbeddingClient, probeEmbedding } from "./embedding.js";

export function createInMemoryContextEngineRepository() {
  return new SqliteContextEngineRepository();
}

export async function createContextEngineRepository() {
  const config = getContextEngineConfig();
  await probeEmbedding(createEmbeddingClient(config.embedding));
  if (config.graphStore.mode !== "neo4j") {
    const repository = new SqliteContextEngineRepository(config.storage.storePath);
    await reconcileGeneratedShortTermMemoryIndexes(repository);
    return repository;
  }

  const graphStore = Neo4jGraphMemoryStore.fromConfig(config);
  await graphStore.initialize();
  const repository = new SqliteContextEngineRepository(config.storage.storePath, graphStore);
  await reconcileGeneratedShortTermMemoryIndexes(repository);
  return repository;
}

export async function reconcileGeneratedShortTermMemoryIndexes(repository: ContextEngineRepository) {
  const snapshot = repository.getDebugSnapshot();
  const primaryIndexes = new Map(snapshot.indexEntries
    .filter((entry) => entry.ownerType === "stm")
    .map((entry) => [entry.ownerId, entry]));
  const vectorOwnerIds = new Set(snapshot.vectorIndexEntries
    .filter((entry) => entry.ownerType === "stm")
    .map((entry) => entry.ownerId));
  const graphOwnerIds = new Set(snapshot.graphMemoryNodes
    .filter((node) => node.ownerType === "stm")
    .map((node) => node.ownerId));

  for (const memory of snapshot.shortTermMemories) {
    const primaryIndex = primaryIndexes.get(memory.memoryDataId);
    const hasVectorIndex = vectorOwnerIds.has(memory.memoryDataId);
    const hasGraphNode = graphOwnerIds.has(memory.memoryDataId);
    const hasAnyIndex = Boolean(primaryIndex) || hasVectorIndex || hasGraphNode;

    if (!isShortTermRecallEligible(memory) || memory.accessState === "permission-invalid") {
      if (hasAnyIndex) await repository.deleteIndexBundle("stm", memory.memoryDataId);
      continue;
    }

    const needsRefresh = !primaryIndex ||
      primaryIndex.lifecycleStatus !== memory.lifecycleStatus ||
      !hasVectorIndex ||
      !hasGraphNode;

    if (needsRefresh) await refreshShortTermMemoryIndex(repository, memory);
  }
}
