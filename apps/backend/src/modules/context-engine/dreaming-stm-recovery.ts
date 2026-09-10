import { createHash } from "node:crypto";
import type { EmbeddingClient } from "./embedding.js";
import { refreshShortTermMemoryIndexes } from "./indexing.js";
import { reconcileMemoryGraphForLongTermMemory } from "./memory-graph.js";
import type { MemoryChangeEvent, ShortTermMemory } from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

const legacyRemovalReasons = new Map([
  ["dreaming_consolidated_to_ltm", "consolidated"],
  ["dreaming_dropped", "dropped"]
] as const);

export interface DreamingStmRecoveryResult {
  candidates: number;
  restored: number;
  repairedExisting: number;
  skippedExisting: number;
  missingSource: number;
  missingFacts: number;
  consolidated: number;
  dropped: number;
  textIndexes: number;
  vectorIndexes: number;
  graphNodes: number;
  sourceRelations: number;
  dryRun: boolean;
}

export async function recoverDreamingRemovedShortTermMemories(input: {
  source: ContextEngineRepository;
  target: ContextEngineRepository;
  embeddingClient: EmbeddingClient;
  dryRun?: boolean;
  indexBatchSize?: number;
  now?: string;
  onProgress?: (processed: number, total: number) => void;
}): Promise<DreamingStmRecoveryResult> {
  const sourceSnapshot = input.source.getDebugSnapshot();
  const targetSnapshot = input.target.getDebugSnapshot();
  const sourceById = new Map(sourceSnapshot.shortTermMemories.map((memory) => [memory.memoryDataId, memory]));
  const currentById = new Map(targetSnapshot.shortTermMemories.map((memory) => [memory.memoryDataId, memory]));
  const primaryIndexIds = new Set(targetSnapshot.indexEntries.filter((entry) => entry.ownerType === "stm").map((entry) => entry.ownerId));
  const vectorIndexIds = new Set(targetSnapshot.vectorIndexEntries.filter((entry) => entry.ownerType === "stm").map((entry) => entry.ownerId));
  const graphNodeIds = new Set(targetSnapshot.graphMemoryNodes.filter((node) => node.ownerType === "stm").map((node) => node.ownerId));
  const completedRecoveryIds = new Set(targetSnapshot.changeEvents
    .filter((event) => event.reason === "dreaming_stm_restored_non_destructive" && event.memoryDataId)
    .map((event) => event.memoryDataId!));
  const factIds = new Set(targetSnapshot.facts.map((fact) => fact.factId));
  const latestDecisionByMemory = new Map<string, typeof targetSnapshot.dreamingCandidateDecisions[number]>();
  for (const decision of targetSnapshot.dreamingCandidateDecisions) {
    const previous = latestDecisionByMemory.get(decision.memoryDataId);
    if (!previous || decision.evaluatedAt > previous.evaluatedAt || (
      decision.evaluatedAt === previous.evaluatedAt && decision.createdAt > previous.createdAt
    )) latestDecisionByMemory.set(decision.memoryDataId, decision);
  }

  const removalByMemory = new Map<string, "consolidated" | "dropped">();
  for (const event of targetSnapshot.changeEvents) {
    if (!event.memoryDataId || event.storageLayer !== "stm") continue;
    const status = legacyRemovalReasons.get(event.reason as "dreaming_consolidated_to_ltm" | "dreaming_dropped");
    if (status) removalByMemory.set(event.memoryDataId, status);
  }

  const candidates = [...removalByMemory]
    .sort(([left], [right]) => left.localeCompare(right));
  const recoverable: ShortTermMemory[] = [];
  const repairable: ShortTermMemory[] = [];
  let skippedExisting = 0;
  let missingSource = 0;
  let missingFacts = 0;
  let consolidated = 0;
  let dropped = 0;

  for (const [memoryDataId, status] of candidates) {
    const current = currentById.get(memoryDataId);
    if (current) {
      if (
        completedRecoveryIds.has(memoryDataId) &&
        primaryIndexIds.has(memoryDataId) &&
        vectorIndexIds.has(memoryDataId) &&
        graphNodeIds.has(memoryDataId)
      ) {
        skippedExisting += 1;
      } else {
        repairable.push(current);
      }
      continue;
    }
    const source = sourceById.get(memoryDataId);
    if (!source) {
      missingSource += 1;
      continue;
    }
    if (source.sourceFactIds.some((factId) => !factIds.has(factId))) {
      missingFacts += 1;
      continue;
    }
    const decision = latestDecisionByMemory.get(memoryDataId);
    const restored: ShortTermMemory = {
      ...source,
      lifecycleStatus: "active",
      consolidationStatus: status,
      ...(decision ? {
        lastEvaluatedAt: decision.evaluatedAt,
        dreamingPolicyVersion: decision.policyVersion,
        latestDecisionId: decision.decisionId
      } : {})
    };
    delete restored.nextEvaluateAt;
    delete restored.reevaluationReason;
    delete restored.reevaluationTier;
    delete restored.lastDreamingError;
    recoverable.push(restored);
    if (status === "consolidated") consolidated += 1;
    else dropped += 1;
  }

  if (input.dryRun) {
    return buildResult({
      candidates: candidates.length,
      restored: recoverable.length,
      repairedExisting: repairable.length,
      skippedExisting,
      missingSource,
      missingFacts,
      consolidated,
      dropped,
      dryRun: true
    });
  }

  const now = input.now ?? new Date().toISOString();
  for (const memory of recoverable) {
    await input.target.replaceShortTermMemory(memory);
  }

  const batchSize = input.indexBatchSize ?? 32;
  const indexable = [...recoverable, ...repairable];
  let processed = 0;
  for (let offset = 0; offset < indexable.length; offset += batchSize) {
    const batch = indexable.slice(offset, offset + batchSize);
    await refreshShortTermMemoryIndexes(input.target, batch, input.embeddingClient);
    processed += batch.length;
    input.onProgress?.(processed, indexable.length);
  }
  for (const memory of indexable) {
    await input.target.saveMemoryChangeEvent(createRecoveryEvent(memory.memoryDataId, now));
  }

  for (const memory of targetSnapshot.longTermMemories) {
    if (memory.sourceMemoryDataIds.some((memoryDataId) => removalByMemory.has(memoryDataId))) {
      await reconcileMemoryGraphForLongTermMemory(input.target, memory.memoryId);
    }
  }

  const finalSnapshot = input.target.getDebugSnapshot();
  const restoredIds = new Set(indexable.map((memory) => memory.memoryDataId));
  const textIndexes = new Set(finalSnapshot.textIndexEntries
    .filter((entry) => entry.ownerType === "stm" && restoredIds.has(entry.ownerId))
    .map((entry) => entry.ownerId)).size;
  const vectorIndexes = new Set(finalSnapshot.vectorIndexEntries
    .filter((entry) => entry.ownerType === "stm" && restoredIds.has(entry.ownerId))
    .map((entry) => entry.ownerId)).size;
  const graphNodes = new Set(finalSnapshot.graphMemoryNodes
    .filter((node) => node.ownerType === "stm" && restoredIds.has(node.ownerId))
    .map((node) => node.ownerId)).size;
  const sourceRelations = finalSnapshot.relationEdges.filter((edge) =>
    edge.relationType === "derived_from" && restoredIds.has(edge.toId)
  ).length;
  if (textIndexes !== indexable.length || vectorIndexes !== indexable.length || graphNodes !== indexable.length) {
    throw new Error(
      `Recovered STM index mismatch: indexed=${indexable.length}, text=${textIndexes}, vector=${vectorIndexes}, graph=${graphNodes}`
    );
  }

  return {
    candidates: candidates.length,
    restored: recoverable.length,
    repairedExisting: repairable.length,
    skippedExisting,
    missingSource,
    missingFacts,
    consolidated,
    dropped,
    textIndexes,
    vectorIndexes,
    graphNodes,
    sourceRelations,
    dryRun: false
  };
}

function buildResult(input: Omit<DreamingStmRecoveryResult, "textIndexes" | "vectorIndexes" | "graphNodes" | "sourceRelations">): DreamingStmRecoveryResult {
  return {
    ...input,
    textIndexes: 0,
    vectorIndexes: 0,
    graphNodes: 0,
    sourceRelations: 0
  };
}

function createRecoveryEvent(memoryDataId: string, createdAt: string): MemoryChangeEvent {
  return {
    eventId: `mce_dreaming_stm_recovery_${createHash("sha256").update(memoryDataId).digest("hex").slice(0, 24)}`,
    memoryDataId,
    changeType: "created",
    storageLayer: "stm",
    reason: "dreaming_stm_restored_non_destructive",
    createdAt
  };
}
