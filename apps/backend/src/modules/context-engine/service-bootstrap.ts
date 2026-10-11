import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { getContextEngineConfig, type ContextEngineConfig } from "../../config.js";
import { Neo4jGraphMemoryStore } from "./persistence/neo4j-graph-store.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { assertNeo4jCredentials } from "./persistence/graph-store.js";
import { refreshShortTermMemoryIndex } from "./indexing.js";
import { isShortTermRecallEligible } from "./lifecycle.js";
import { createEmbeddingClient, probeEmbedding } from "./embedding.js";

export function createInMemoryContextEngineRepository() {
  return new SqliteContextEngineRepository();
}

export async function createRequiredGraphStore(config = getContextEngineConfig()): Promise<Neo4jGraphMemoryStore> {
  assertNeo4jCredentials(config.graphStore.neo4j, "graphStore.neo4j");
  const graphStore = Neo4jGraphMemoryStore.fromConfig(config);
  try {
    await graphStore.initialize();
  } catch (error) {
    await graphStore.close().catch(() => {});
    throw new Error(
      `Failed to connect to the Neo4j graph store at ${config.graphStore.neo4j.uri}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return graphStore;
}

export async function createContextEngineRepository() {
  const config = getContextEngineConfig();
  await probeEmbedding(createEmbeddingClient(config.embedding));
  const graphStore = await createRequiredGraphStore(config);
  const repository = new SqliteContextEngineRepository(config.storage.storePath, graphStore);
  await reconcileGeneratedShortTermMemoryIndexes(repository);
  return repository;
}

export async function reconcileGeneratedShortTermMemoryIndexes(repository: ContextEngineRepository) {
  const snapshot = repository.getDebugSnapshot();
  const primaryIndexes = new Map(snapshot.indexEntries
    .filter((entry) => entry.ownerType === "stm")
    .map((entry) => [entry.ownerId, entry]));
  const graphRefs = new Map((await repository.listGraphNodeRefs?.(["stm", "ltm"]) ?? [])
    .map((ref) => [`${ref.ownerType}:${ref.ownerId}`, ref]));

  for (const memory of snapshot.shortTermMemories) {
    const primaryIndex = primaryIndexes.get(memory.memoryDataId);
    const graphRef = graphRefs.get(`stm:${memory.memoryDataId}`);
    const hasAnyIndex = Boolean(primaryIndex) || Boolean(graphRef);

    if (!isShortTermRecallEligible(memory) || memory.accessState === "permission-invalid") {
      if (hasAnyIndex) await repository.deleteIndexBundle("stm", memory.memoryDataId);
      continue;
    }

    const needsRefresh = !primaryIndex ||
      primaryIndex.lifecycleStatus !== memory.lifecycleStatus ||
      !graphRef ||
      graphRef.vectorLength === 0;

    if (needsRefresh) await refreshShortTermMemoryIndex(repository, memory);
  }
}
