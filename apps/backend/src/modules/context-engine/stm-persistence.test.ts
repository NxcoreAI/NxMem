import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DreamingRun, DreamingRunCandidate, ShortTermMemory } from "./domain.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";

test("short-term memory rejects an owner change for an existing id", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = createStm();
  await repository.saveShortTermMemory(memory);

  await assert.rejects(
    repository.replaceShortTermMemory({
      ...memory,
      principalId: "other-user"
    }),
    /STM_OWNER_CONFLICT:stm_owner_time/
  );

  assert.equal(repository.getShortTermMemory(memory.memoryDataId)?.principalId, "debug-user");
});

test("idempotent short-term memory writes preserve updatedAt", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = createStm();
  await repository.saveShortTermMemory(memory);

  await repository.replaceShortTermMemory({
    ...memory,
    updatedAt: "2026-02-01T00:00:00.000Z"
  });

  assert.equal(repository.getShortTermMemory(memory.memoryDataId)?.updatedAt, memory.updatedAt);
});

test("meaningful short-term memory changes advance updatedAt", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = createStm();
  await repository.saveShortTermMemory(memory);

  await repository.replaceShortTermMemory({
    ...memory,
    lifecycleStatus: "archived"
  });

  const updated = repository.getShortTermMemory(memory.memoryDataId);
  assert.equal(updated?.lifecycleStatus, "archived");
  assert.ok(Date.parse(updated?.updatedAt ?? "") > Date.parse(memory.updatedAt));
  assert.equal(updated?.createdAt, memory.createdAt);
});

test("Dreaming Run and candidate saves are idempotent and claimable in memory", async () => {
  const repository = new InMemoryContextEngineRepository();
  const run = createRun();
  const candidate = createCandidate(run.runId);

  await repository.saveDreamingRun(run);
  await repository.saveDreamingRun({ ...run, status: "queued", updatedAt: "2026-08-05T23:01:00.000Z" });
  await repository.saveDreamingRunCandidate(candidate);
  await repository.saveDreamingRunCandidate({ ...candidate, status: "pending", updatedAt: "2026-08-05T23:01:00.000Z" });

  assert.equal(repository.listDreamingRuns({ tenantId: "local", principalId: "debug-user" }).length, 1);
  assert.equal(repository.listDreamingRunCandidates(run.runId).length, 1);

  const claimedRun = await repository.claimNextDreamingRun({
    tenantId: "local",
    principalId: "debug-user",
    claimedBy: "worker-1",
    claimedAt: "2026-08-05T23:02:00.000Z",
    leaseExpiresAt: "2026-08-05T23:10:00.000Z"
  });
  assert.equal(claimedRun?.status, "running");
  assert.equal(claimedRun?.leaseOwner, "worker-1");

  const claimedCandidate = await repository.claimNextDreamingRunCandidate({
    runId: run.runId,
    claimedBy: "worker-1",
    claimedAt: "2026-08-05T23:02:01.000Z",
    leaseExpiresAt: "2026-08-05T23:10:00.000Z"
  });
  assert.equal(claimedCandidate?.status, "processing");
  assert.equal(claimedCandidate?.startedAt, "2026-08-05T23:02:01.000Z");
});

test("scheduled Dreaming Run and candidate uniqueness are enforced before persistence", async () => {
  const repository = new InMemoryContextEngineRepository();
  const run = createRun();
  await repository.saveDreamingRun(run);
  await repository.saveDreamingRunCandidate(createCandidate(run.runId));

  await assert.rejects(
    repository.saveDreamingRun({
      ...run,
      runId: "dreaming-run-duplicate"
    }),
    /DREAMING_RUN_SCHEDULE_CONFLICT/
  );

  await assert.rejects(
    repository.saveDreamingRunCandidate({
      ...createCandidate(run.runId),
      runCandidateId: "run-candidate-duplicate"
    }),
    /DREAMING_RUN_CANDIDATE_CONFLICT/
  );
});

test("due Dreaming STM selection keeps only due observing and retry-wait records", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm({
    memoryDataId: "stm-observing-due",
    consolidationStatus: "observing",
    nextEvaluateAt: "2026-08-05T23:00:00.000Z"
  }));
  await repository.saveShortTermMemory(createStm({
    memoryDataId: "stm-retry-due",
    consolidationStatus: "retry_wait",
    nextEvaluateAt: "2026-08-05T22:00:00.000Z"
  }));
  await repository.saveShortTermMemory(createStm({
    memoryDataId: "stm-observing-future",
    consolidationStatus: "observing",
    nextEvaluateAt: "2026-08-06T23:00:00.000Z"
  }));
  await repository.saveShortTermMemory(createStm({
    memoryDataId: "stm-consolidated",
    consolidationStatus: "consolidated",
    dreamingPolicyVersion: "dreaming-policy-v1",
    nextEvaluateAt: "2026-08-05T20:00:00.000Z"
  }));

  assert.deepEqual(
    repository.listDueDreamingShortTermMemories({
      tenantId: "local",
      principalId: "debug-user",
      cutoffAt: "2026-08-05T23:00:00.000Z",
      policyVersion: "dreaming-policy-v1"
    }).map((memory) => memory.memoryDataId),
    ["stm-retry-due", "stm-observing-due"]
  );
});

test("SQLite persists Dreaming Run, candidate, and STM retry fields across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-dreaming-persistence-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const run = {
      ...createRun(),
      status: "paused" as const,
      pausedAt: "2026-08-05T16:00:00.000Z",
      pauseReason: "manual" as const
    };
    const candidate = createCandidate(run.runId);
    const stm = createStm({
      memoryDataId: "stm-sqlite-due",
      consolidationStatus: "retry_wait",
      nextEvaluateAt: "2026-08-05T23:00:00.000Z",
      cycleAttemptCount: 3,
      totalAttemptCount: 7,
      lastDreamingError: "timeout",
      latestDreamingRunId: run.runId
    });
    const writer = new SqliteContextEngineRepository(storePath);
    await writer.saveDreamingRun(run);
    await writer.saveDreamingRunCandidate(candidate);
    await writer.saveShortTermMemory(stm);
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath);
    assert.deepEqual(reader.getDreamingRun(run.runId), run);
    assert.deepEqual(reader.getDreamingRunCandidate(candidate.runCandidateId), candidate);
    const restoredStm = reader.getShortTermMemory(stm.memoryDataId);
    assert.equal(restoredStm?.consolidationStatus, "retry_wait");
    assert.equal(restoredStm?.nextEvaluateAt, stm.nextEvaluateAt);
    assert.equal(restoredStm?.cycleAttemptCount, 3);
    assert.equal(restoredStm?.totalAttemptCount, 7);
    assert.equal(restoredStm?.lastDreamingError, "timeout");
    assert.equal(restoredStm?.latestDreamingRunId, run.runId);
    assert.equal(restoredStm?.content, stm.content);
    assert.deepEqual(
      reader.listDueDreamingShortTermMemories({
        tenantId: "local",
        principalId: "debug-user",
        cutoffAt: "2026-08-05T23:00:00.000Z",
        policyVersion: "dreaming-policy-v1"
      }).map((memory) => memory.memoryDataId),
      [stm.memoryDataId]
    );
    reader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite migration maps legacy retryable_failure to retry_wait without losing its deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-dreaming-migration-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const stm = createStm({
      memoryDataId: "stm-legacy-retry",
      consolidationStatus: "retryable_failure",
      nextEvaluateAt: "2026-08-08T23:00:00.000Z"
    });
    await writer.saveShortTermMemory(stm);
    writer.close();

    const legacyDb = new DatabaseSync(storePath);
    legacyDb.prepare("UPDATE short_term_memories SET consolidation_status = 'retryable_failure' WHERE memory_data_id = ?").run(stm.memoryDataId);
    legacyDb.close();

    const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    const migrated = reader.getShortTermMemory(stm.memoryDataId);
    assert.equal(migrated?.consolidationStatus, "retry_wait");
    assert.equal(migrated?.nextEvaluateAt, stm.nextEvaluateAt);
    reader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("STM release removes the primary record and recall artifacts but keeps the source STM data elsewhere", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm({ memoryDataId: "stm-release" });
  await repository.saveShortTermMemory(stm);
  await repository.saveIndexEntry({
    indexId: "idx_stm_stm-release",
    ownerId: stm.memoryDataId,
    ownerType: "stm",
    content: stm.content,
    lifecycleStatus: "active",
    refreshedAt: stm.updatedAt,
    tokenCount: 1
  });
  await repository.upsertGraphMemoryNode({
    graphNodeId: "graph-stm-release",
    ownerId: stm.memoryDataId,
    ownerType: "stm",
    content: stm.content,
    vector: [],
    lifecycleStatus: "active",
    retrievalWeight: 0.2,
    sourceRefs: stm.sourceRefs,
    entityIds: stm.entityIds,
    refreshedAt: stm.updatedAt
  });

  await repository.deleteShortTermMemory(stm.memoryDataId);
  await repository.deleteShortTermMemoryArtifacts(stm.memoryDataId);
  assert.equal(repository.getShortTermMemory(stm.memoryDataId), undefined);
  assert.equal(repository.getIndexEntryByOwnerId(stm.memoryDataId), undefined);
  assert.equal(repository.getGraphMemoryNode("stm", stm.memoryDataId), undefined);
});

function createStm(overrides: Partial<ShortTermMemory> = {}): ShortTermMemory {
  return {
    memoryDataId: "stm_owner_time",
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "manual_memory_event",
    memoryType: "fact",
    content: "用户正在推进 Context Engine。",
    sourceFactIds: ["fact_owner_time"],
    sourceRefs: [{ sourceRefId: "src_owner_time", sourceType: "file", sourceId: "owner-time" }],
    entityIds: ["entity_context_engine"],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible",
    ...overrides
  };
}

function createRun(): DreamingRun {
  return {
    runId: "dreaming-run-1",
    tenantId: "local",
    principalId: "debug-user",
    triggerType: "scheduled",
    scheduleKey: "2026-08-05T23:00:00+08:00",
    status: "queued",
    requestedAt: "2026-08-05T23:00:00.000Z",
    candidateWindowStartAt: "2026-08-04T23:00:00.000Z",
    candidateCutoffAt: "2026-08-05T23:00:00.000Z",
    policyVersion: "dreaming-v1",
    promptVersion: "dreaming-prompt-v1",
    candidateCount: 1,
    processedCount: 0,
    consolidatedCount: 0,
    observingCount: 0,
    droppedCount: 0,
    retryWaitCount: 0,
    skippedCount: 0,
    createdAt: "2026-08-05T23:00:00.000Z",
    updatedAt: "2026-08-05T23:00:00.000Z"
  };
}

function createCandidate(runId: string): DreamingRunCandidate {
  return {
    runCandidateId: "run-candidate-1",
    runId,
    memoryDataId: "stm-owner-time",
    stmVersion: "2026-08-05T22:59:00.000Z",
    candidateFingerprint: "fp-stm-owner-time-v1",
    sourceType: "new",
    status: "pending",
    cycleAttemptCount: 0,
    totalAttemptCount: 0,
    createdAt: "2026-08-05T23:00:00.000Z",
    updatedAt: "2026-08-05T23:00:00.000Z"
  };
}
