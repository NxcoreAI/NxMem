import { getContextEngineConfig, type ContextEngineConfig } from "../../config.js";
import { createEmbeddingClient, probeEmbedding, type EmbeddingClient } from "./embedding.js";
import {
  buildShortTermMemorySearchContent,
  replaceLongTermMemoryEmbedding,
  replaceShortTermMemoryEmbedding
} from "./indexing.js";
import { isLongTermRecallEligible, isShortTermRecallEligible } from "./lifecycle.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { Neo4jGraphMemoryStore } from "./persistence/neo4j-graph-store.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

export interface EmbeddingReindexProgress {
  processed: number;
  total: number;
  batchIndex: number;
  batchCount: number;
}

export interface EmbeddingReindexResult {
  fingerprint: string;
  dimensions: number;
  shortTermMemories: number;
  longTermMemories: number;
  vectorEntries: number;
}

export async function reindexConfiguredRepositoryEmbeddings(input: {
  config?: ContextEngineConfig;
  embeddingClient?: EmbeddingClient;
  repository?: ContextEngineRepository;
  onProgress?: (progress: EmbeddingReindexProgress) => void;
} = {}): Promise<EmbeddingReindexResult> {
  const config = input.config ?? getContextEngineConfig();
  const client = input.embeddingClient ?? createEmbeddingClient(config.embedding);
  await probeEmbedding(client);

  const graphStore = input.repository || config.graphStore.mode !== "neo4j"
    ? undefined
    : Neo4jGraphMemoryStore.fromConfig(config);
  let ownedRepository: SqliteContextEngineRepository | undefined;

  try {
    if (graphStore) {
      await graphStore.initialize({ createVectorIndex: false });
      await graphStore.dropVectorIndex();
    }
    const repository = input.repository ?? (ownedRepository = new SqliteContextEngineRepository(
      config.storage.storePath,
      graphStore
    ));
    const snapshot = repository.getDebugSnapshot();
    const shortTermMemories = snapshot.shortTermMemories.filter((memory) =>
      isShortTermRecallEligible(memory) && memory.accessState !== "permission-invalid"
    );
    const longTermMemories = snapshot.longTermMemories.filter(isLongTermRecallEligible);
    const factById = new Map(snapshot.facts.map((fact) => [fact.factId, fact]));
    const items = [
      ...shortTermMemories.map((memory) => ({
        kind: "stm" as const,
        memory,
        content: buildShortTermMemorySearchContent(
          memory,
          memory.sourceFactIds.flatMap((factId) => {
            const fact = factById.get(factId);
            return fact ? [fact] : [];
          })
        )
      })),
      ...longTermMemories.map((memory) => ({ kind: "ltm" as const, memory, content: memory.content }))
    ];
    const batches = chunk(items, config.embedding.batchSize);
    let processed = 0;

    for (const [batchIndex, batch] of batches.entries()) {
      const vectors = await client.embed(batch.map((item) => item.content));
      validateReindexBatch(vectors, batch.length, config.embedding.dimensions, processed);
      const refreshedAt = new Date().toISOString();
      for (const [index, item] of batch.entries()) {
        const vector = vectors[index]?.embedding;
        if (!vector) throw new Error(`Embedding batch omitted item ${processed + index}`);
        if (item.kind === "stm") {
          await replaceShortTermMemoryEmbedding(repository, item.memory, vector, refreshedAt, item.content);
        } else {
          await replaceLongTermMemoryEmbedding(repository, item.memory, vector, refreshedAt);
        }
      }
      processed += batch.length;
      input.onProgress?.({
        processed,
        total: items.length,
        batchIndex: batchIndex + 1,
        batchCount: batches.length
      });
    }

    const finalSnapshot = repository.getDebugSnapshot();
    const ownerKeys = new Set(items.map((item) => item.kind === "stm"
      ? `stm:${item.memory.memoryDataId}`
      : `ltm:${item.memory.memoryId}`
    ));
    const vectorEntries = finalSnapshot.vectorIndexEntries.filter((entry) =>
      ownerKeys.has(`${entry.ownerType}:${entry.ownerId}`)
    );
    if (vectorEntries.length !== items.length) {
      throw new Error(`Embedding reindex count mismatch: expected ${items.length}, got ${vectorEntries.length}`);
    }
    const invalid = vectorEntries.find((entry) => entry.vector.length !== config.embedding.dimensions);
    if (invalid) {
      throw new Error(`Embedding reindex dimension mismatch for ${invalid.ownerType}:${invalid.ownerId}`);
    }
    if (graphStore) {
      await verifyNeo4jVectors(graphStore, ownerKeys, config.embedding.dimensions);
      await graphStore.createVectorIndex();
    }

    return {
      fingerprint: client.fingerprint,
      dimensions: config.embedding.dimensions,
      shortTermMemories: shortTermMemories.length,
      longTermMemories: longTermMemories.length,
      vectorEntries: vectorEntries.length
    };
  } finally {
    ownedRepository?.close();
    await graphStore?.close();
  }
}

function validateReindexBatch(
  vectors: Awaited<ReturnType<EmbeddingClient["embed"]>>,
  expectedCount: number,
  dimensions: number,
  offset: number
) {
  if (vectors.length !== expectedCount) {
    throw new Error(`Embedding reindex batch count mismatch at ${offset}: expected ${expectedCount}, got ${vectors.length}`);
  }
  for (const [index, result] of vectors.entries()) {
    if (result.embedding.length !== dimensions) {
      throw new Error(`Embedding reindex batch dimension mismatch at ${offset + index}: expected ${dimensions}, got ${result.embedding.length}`);
    }
    if (result.embedding.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding reindex batch contains a non-finite value at ${offset + index}`);
    }
  }
}

async function verifyNeo4jVectors(
  graphStore: Neo4jGraphMemoryStore,
  ownerKeys: Set<string>,
  dimensions: number
) {
  const matched = new Set<string>();
  let after: { layer: "stm" | "ltm"; id: string } | undefined;
  while (true) {
    const page = await graphStore.listGraphMemoryNodes({
      ownerTypes: ["stm", "ltm"],
      ...(after ? { after } : {}),
      limit: 200
    });
    for (const node of page.nodes) {
      const key = `${node.ownerType}:${node.ownerId}`;
      if (!ownerKeys.has(key)) continue;
      if (node.vector.length !== dimensions) {
        throw new Error(`Neo4j embedding dimension mismatch for ${key}: expected ${dimensions}, got ${node.vector.length}`);
      }
      matched.add(key);
    }
    if (!page.hasMore) break;
    const last = page.nodes.at(-1);
    if (!last) throw new Error("Neo4j embedding verification pagination returned an empty page");
    after = { layer: last.ownerType, id: last.ownerId };
  }
  if (matched.size !== ownerKeys.size) {
    throw new Error(`Neo4j embedding reindex count mismatch: expected ${ownerKeys.size}, got ${matched.size}`);
  }
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
