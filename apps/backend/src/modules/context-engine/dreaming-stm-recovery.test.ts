import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FactItem, LongTermMemory, ShortTermMemory } from "./domain.js";
import { recoverDreamingRemovedShortTermMemories } from "./dreaming-stm-recovery.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";

test("restores only Dreaming-removed STM with terminal policy state and recall indexes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dreaming-stm-recovery-"));
  const source = new SqliteContextEngineRepository(join(directory, "source.sqlite"));
  const target = new SqliteContextEngineRepository(join(directory, "target.sqlite"));
  const consolidated = createStm("stm_consolidated", "fact_consolidated");
  const dropped = createStm("stm_dropped", "fact_dropped");
  const admissionOnly = createStm("stm_admission_only", "fact_admission_only");
  for (const memory of [consolidated, dropped, admissionOnly]) {
    await source.saveFactItem(createFact(memory.sourceFactIds[0]!));
    await source.saveShortTermMemory(memory);
    await target.saveFactItem(createFact(memory.sourceFactIds[0]!));
  }
  await target.saveLongTermMemory(createLtm(consolidated));
  await target.saveDreamingCandidateDecision({
    decisionId: "decision_consolidated",
    runId: "run_1",
    candidateFingerprint: "candidate_1",
    memoryDataId: consolidated.memoryDataId,
    tenantId: consolidated.tenantId,
    principalId: consolidated.principalId,
    decision: "accepted",
    reasonCodes: [],
    sourceFactIds: consolidated.sourceFactIds,
    sourceRefs: consolidated.sourceRefs,
    permissionSnapshotIds: [],
    policyVersion: "policy.v1",
    traceId: "trace_1",
    evaluatedAt: "2026-08-01T10:00:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z"
  });
  await target.saveMemoryChangeEvent({
    eventId: "removed_consolidated",
    memoryDataId: consolidated.memoryDataId,
    changeType: "deleted",
    storageLayer: "stm",
    reason: "dreaming_consolidated_to_ltm",
    createdAt: "2026-08-01T10:00:00.000Z"
  });
  await target.saveMemoryChangeEvent({
    eventId: "removed_dropped",
    memoryDataId: dropped.memoryDataId,
    changeType: "deleted",
    storageLayer: "stm",
    reason: "dreaming_dropped",
    createdAt: "2026-08-01T10:00:00.000Z"
  });

  const result = await recoverDreamingRemovedShortTermMemories({
    source,
    target,
    embeddingClient: createDeterministicTestEmbeddingClient(16),
    now: "2026-08-13T12:00:00.000Z"
  });
  assert.equal(result.restored, 2);
  assert.equal(result.textIndexes, 2);
  assert.equal(result.vectorIndexes, 2);
  assert.equal(result.graphNodes, 2);
  assert.equal(result.sourceRelations, 1);
  assert.equal(target.getShortTermMemory(consolidated.memoryDataId)?.consolidationStatus, "consolidated");
  assert.equal(target.getShortTermMemory(consolidated.memoryDataId)?.latestDecisionId, "decision_consolidated");
  assert.equal(target.getShortTermMemory(dropped.memoryDataId)?.consolidationStatus, "dropped");
  assert.equal(target.getShortTermMemory(admissionOnly.memoryDataId), undefined);
  assert.ok(target.getDebugSnapshot().relationEdges.some((edge) =>
    edge.fromId === "ltm_consolidated" && edge.toId === consolidated.memoryDataId && edge.relationType === "derived_from"
  ));

  const replay = await recoverDreamingRemovedShortTermMemories({
    source,
    target,
    embeddingClient: createDeterministicTestEmbeddingClient(16)
  });
  assert.equal(replay.restored, 0);
  assert.equal(replay.skippedExisting, 2);
  source.close();
  target.close();
});

function createStm(memoryDataId: string, factId: string): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "tenant-a",
    principalId: "user-a",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    memoryDataType: "fact",
    memoryType: "fact",
    content: `memory ${memoryDataId}`,
    sourceFactIds: [factId],
    sourceRefs: [{ sourceRefId: `source_${factId}`, sourceType: "file", sourceId: "recovery-test" }],
    entityIds: [],
    importanceLevel: "medium",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "medium",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "medium",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    consolidationStatus: "retryable_failure",
    accessState: "visible"
  };
}

function createFact(factId: string): FactItem {
  return {
    factId,
    tenantId: "tenant-a",
    principalId: "user-a",
    factType: "observation",
    factText: `fact ${factId}`,
    normalizedClaim: `fact ${factId}`,
    linkedEventIds: [],
    linkedSegmentIds: [],
    linkedSourceRefs: [{ sourceRefId: `source_${factId}`, sourceType: "file", sourceId: "recovery-test" }],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-08-01T00:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "test.v1",
    accessState: "visible"
  };
}

function createLtm(source: ShortTermMemory): LongTermMemory {
  return {
    memoryId: "ltm_consolidated",
    tenantId: source.tenantId,
    principalId: source.principalId,
    theoryClass: "semantic",
    memoryType: "fact",
    content: source.content,
    sourceRefs: source.sourceRefs,
    sourceMemoryDataIds: [source.memoryDataId],
    sourceFactIds: source.sourceFactIds,
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    accessState: "visible"
  };
}
