import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  DreamingRun,
  DreamingRunCandidate,
  DreamingStmDecision,
  LlmDreamingTrace,
  LongTermMemory,
  ShortTermMemory
} from "./domain.js";
import { DreamingRunService } from "./dreaming-run-service.js";
import { commitSingleDreamingResult, DreamingWorker, type SingleStmEvaluationResult } from "./dreaming-worker.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { refreshShortTermMemoryIndex } from "./indexing.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";

const CUTOFF = "2026-08-05T15:00:00.000Z";
const NOW = "2026-08-05T15:01:00.000Z";

test("Worker evaluates one STM at a time and applies the server-side reevaluation tier", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-observe", "2026-08-05T14:00:00.000Z"));
  await repository.saveShortTermMemory(createStm("stm-three-days", "2026-08-05T14:01:00.000Z"));
  await repository.saveShortTermMemory(createStm("stm-seven-days", "2026-08-05T14:02:00.000Z"));
  await repository.saveShortTermMemory(createStm("stm-drop", "2026-08-05T14:03:00.000Z"));
  const service = createRunService(repository);
  const created = await service.createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });

  const evaluations: string[] = [];
  let active = 0;
  let maxActive = 0;
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async ({ memory }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      evaluations.push(memory.memoryDataId);
      await Promise.resolve();
      active -= 1;
      const scoreByMemory: Record<string, [DreamingStmDecision, number]> = {
        "stm-observe": ["observe", 5.5],
        "stm-three-days": ["observe", 5.0],
        "stm-seven-days": ["observe", 4.0],
        "stm-drop": ["drop", 0]
      };
      const [decision, score] = scoreByMemory[memory.memoryDataId]!;
      return evaluation(memory.memoryDataId, decision, score);
    }
  });

  const result = await worker.processNextRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    workerId: "worker-a",
    now: NOW
  });

  assert.ok(result);
  assert.equal(result.completed, true);
  assert.deepEqual(new Set(evaluations), new Set(["stm-observe", "stm-three-days", "stm-seven-days", "stm-drop"]));
  assert.equal(maxActive, 1);
  assert.equal(result.run.processedCount, 4);
  assert.equal(result.run.observingCount, 3);
  assert.equal(result.run.droppedCount, 1);
  const observing = repository.getShortTermMemory("stm-observe");
  assert.equal(observing?.consolidationStatus, "observing");
  assert.equal(observing?.reevaluationTier, "NEXT_DAY");
  assert.equal(observing?.nextEvaluateAt, "2026-08-06T15:00:00.000Z");
  assert.equal(repository.getShortTermMemory("stm-three-days")?.nextEvaluateAt, "2026-08-08T15:00:00.000Z");
  assert.equal(repository.getShortTermMemory("stm-seven-days")?.nextEvaluateAt, "2026-08-12T15:00:00.000Z");
  const droppedCandidate = repository.listDreamingRunCandidates(created.run.runId).find((item) => item.memoryDataId === "stm-drop");
  assert.equal(droppedCandidate?.nextEvaluateAt, undefined);
  assert.equal(droppedCandidate?.lastError, undefined);
});

test("Worker retries model failures three times in one cycle, then schedules NEXT_DAY retry_wait", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-failing", "2026-08-05T14:00:00.000Z"));
  const service = createRunService(repository);
  await service.createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  let attempts = 0;
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async () => {
      attempts += 1;
      throw new Error("provider_timeout");
    }
  });

  const result = await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });
  assert.ok(result);
  assert.equal(attempts, 3);
  assert.equal(result.completed, true);
  assert.equal(result.run.processedCount, 1);
  assert.equal(result.run.retryWaitCount, 1);
  const candidate = repository.listDreamingRunCandidates(result.run.runId)[0];
  assert.equal(candidate?.status, "retry_wait");
  assert.equal(candidate?.cycleAttemptCount, 3);
  assert.equal(candidate?.totalAttemptCount, 3);
  assert.equal(candidate?.reevaluationTier, "NEXT_DAY");
  assert.equal(candidate?.nextEvaluateAt, "2026-08-06T15:00:00.000Z");
  const memory = repository.getShortTermMemory("stm-failing");
  assert.equal(memory?.consolidationStatus, "retry_wait");
  assert.equal(memory?.cycleAttemptCount, 3);
  assert.equal(memory?.totalAttemptCount, 3);
  assert.equal(memory?.lastDreamingError, "provider_timeout");
});

test("unavailable candidates are retried by the common cycle policy and then skipped", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-unavailable", "2026-08-05T14:00:00.000Z"));
  const service = createRunService(repository);
  const created = await service.createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  await repository.deleteShortTermMemory("stm-unavailable");
  let evaluatorCalls = 0;
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async () => {
      evaluatorCalls += 1;
      throw new Error("must_not_call_model");
    }
  });

  const result = await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });
  assert.ok(result);
  assert.equal(evaluatorCalls, 0);
  const candidate = repository.listDreamingRunCandidates(created.run.runId)[0];
  assert.equal(candidate?.status, "skipped");
  assert.equal(candidate?.cycleAttemptCount, 3);
  assert.equal(candidate?.nextEvaluateAt, "2026-08-06T15:00:00.000Z");
});

test("expired Run and candidate leases can be reclaimed, while AbortError restores pending without attempts", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-lease", "2026-08-05T14:00:00.000Z"));
  const service = createRunService(repository);
  const created = await service.createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  const candidate = created.candidates[0]!;
  await repository.saveDreamingRun({
    ...created.run,
    status: "running",
    leaseOwner: "dead-worker",
    leaseExpiresAt: "2026-08-05T15:00:30.000Z",
    updatedAt: "2026-08-05T15:00:00.000Z"
  });
  await repository.saveDreamingRunCandidate({
    ...candidate,
    status: "processing",
    leaseOwner: "dead-worker",
    leaseExpiresAt: "2026-08-05T15:00:30.000Z",
    updatedAt: "2026-08-05T15:00:00.000Z"
  });
  const worker = new DreamingWorker(repository, {
    now: () => "2026-08-05T15:02:00.000Z",
    evaluator: async ({ memory }) => evaluation(memory.memoryDataId, "drop", 0)
  });
  const reclaimed = await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-b", now: "2026-08-05T15:02:00.000Z" });
  assert.ok(reclaimed);
  assert.equal(reclaimed.completed, true);
  assert.equal(reclaimed.run.status, "completed");

  const secondRepository = new InMemoryContextEngineRepository();
  await secondRepository.saveShortTermMemory(createStm("stm-abort", "2026-08-05T14:00:00.000Z"));
  const secondRun = await createRunService(secondRepository).createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  const controller = new AbortController();
  const abortWorker = new DreamingWorker(secondRepository, {
    now: () => NOW,
    evaluator: async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }
  });
  const paused = await abortWorker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW, signal: controller.signal });
  assert.ok(paused);
  assert.equal(paused.completed, false);
  const restored = secondRepository.listDreamingRunCandidates(secondRun.run.runId)[0];
  assert.equal(restored?.status, "pending");
  assert.equal(restored?.cycleAttemptCount, 0);
  assert.equal(restored?.totalAttemptCount, 0);
});

test("consolidate creates a linked LTM and releases the source STM and its artifacts", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm-consolidate", "2026-08-05T14:00:00.000Z");
  stm.evidenceTimeStart = "2026-08-01T00:00:00.000Z";
  stm.evidenceTimeEnd = "2026-08-01T01:00:00.000Z";
  stm.validTimeStart = "2026-08-02T00:00:00.000Z";
  await repository.saveShortTermMemory(stm);
  await refreshShortTermMemoryIndex(repository, stm, createDeterministicTestEmbeddingClient(512));
  const run = await createRunService(repository).createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async ({ memory }) => {
      const scored = evaluation(memory.memoryDataId, "consolidate", 8).evaluation;
      const longTermMemory: LongTermMemory = {
        memoryId: "ltm-new-consolidated",
        tenantId: memory.tenantId,
        principalId: memory.principalId,
        theoryClass: "semantic",
        memoryType: "fact",
        content: memory.content,
        sourceRefs: memory.sourceRefs,
        sourceMemoryDataIds: [memory.memoryDataId],
        sourceFactIds: memory.sourceFactIds,
        entityIds: memory.entityIds,
        confidenceLevel: memory.confidenceLevel,
        recallWeight: "high",
        solidifyReason: "test",
        matchedRules: [],
        lifecycleStatus: "active",
        accessState: "visible",
        ...(memory.evidenceTimeStart ? { evidenceTimeStart: memory.evidenceTimeStart } : {}),
        ...(memory.evidenceTimeEnd ? { evidenceTimeEnd: memory.evidenceTimeEnd } : {}),
        ...(memory.validTimeStart ? { validTimeStart: memory.validTimeStart } : {}),
        evidenceTimeConfidence: memory.evidenceTimeConfidence ?? "high",
        validTimeConfidence: memory.validTimeConfidence ?? "high"
      };
      return {
        evaluation: scored,
        longTermMemory,
        trace: dreamingTrace(memory, scored, longTermMemory)
      };
    }
  });
  const result = await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });
  assert.ok(result?.completed);
  assert.equal(repository.getShortTermMemory(stm.memoryDataId), undefined);
  assert.equal(repository.indexEntries.some((entry) => entry.ownerId === stm.memoryDataId), false);
  assert.equal(repository.textIndexEntries.some((entry) => entry.ownerId === stm.memoryDataId), false);
  assert.equal(repository.vectorIndexEntries.some((entry) => entry.ownerId === stm.memoryDataId), false);
  assert.equal(repository.graphMemoryNodes.some((node) => node.ownerId === stm.memoryDataId), false);
  const ltm = repository.getLongTermMemory("ltm-new-consolidated");
  assert.deepEqual(ltm?.sourceFactIds, stm.sourceFactIds);
  assert.equal(ltm?.evidenceTimeStart, stm.evidenceTimeStart);
  assert.equal(ltm?.validTimeStart, stm.validTimeStart);
  assert.equal(typeof ltm?.consolidationKey, "string");
  assert.equal(ltm?.version, 1);
  assert.equal(ltm?.consolidationScore, 8);
  assert.equal(ltm?.policyVersion, "dreaming-policy-test");
  assert.equal(ltm?.promptVersion, "dreaming-prompt-test");
  assert.equal(ltm?.model, "dreaming-model-test");
  assert.equal(repository.relationEdges.some((edge) => edge.fromId === stm.memoryDataId || edge.toId === stm.memoryDataId), false);
  assert.ok(repository.changeEvents.some((event) => event.memoryId === "ltm-new-consolidated" && event.storageLayer === "ltm"));
  assert.ok(repository.changeEvents.some((event) =>
    event.memoryDataId === stm.memoryDataId &&
    event.changeType === "deleted" &&
    event.reason === "dreaming_consolidated_to_ltm"
  ));
  const candidate = repository.listDreamingRunCandidates(run.run.runId)[0];
  assert.equal(candidate?.status, "consolidated");
  assert.equal(candidate?.traceId, "trace-stm-consolidate");
  assert.equal(candidate?.decisionId, `dream_final_decision_${candidate?.runCandidateId}`);
  const finalDecision = repository.getDebugSnapshot().dreamingCandidateDecisions.find((item) => item.decisionId === candidate?.decisionId);
  assert.equal(finalDecision?.decision, "accepted");
  assert.deepEqual(finalDecision?.sourceFactIds, stm.sourceFactIds);
  assert.equal(repository.getDebugSnapshot().llmDreamingTraces.some((trace) => trace.traceId === "trace-stm-consolidate"), true);
});

test("drop skips LTM creation while retaining STM and its candidate audit record", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm-drop-release", "2026-08-05T14:00:00.000Z");
  await repository.saveShortTermMemory(stm);
  await refreshShortTermMemoryIndex(repository, stm, createDeterministicTestEmbeddingClient(512));
  const run = await createRunService(repository).createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  const worker = new DreamingWorker(repository, { now: () => NOW, evaluator: async ({ memory }) => evaluation(memory.memoryDataId, "drop", 0) });
  await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });
  const retained = repository.getShortTermMemory(stm.memoryDataId);
  assert.equal(retained?.consolidationStatus, "dropped");
  assert.equal(retained?.lifecycleStatus, "active");
  assert.equal(repository.indexEntries.some((entry) => entry.ownerId === stm.memoryDataId), true);
  assert.equal(repository.textIndexEntries.some((entry) => entry.ownerId === stm.memoryDataId), true);
  assert.equal(repository.vectorIndexEntries.some((entry) => entry.ownerId === stm.memoryDataId), true);
  assert.equal(repository.graphMemoryNodes.some((node) => node.ownerId === stm.memoryDataId), true);
  const candidate = repository.listDreamingRunCandidates(run.run.runId)[0];
  assert.equal(candidate?.status, "dropped");
  assert.ok(repository.changeEvents.some((event) =>
    event.memoryDataId === stm.memoryDataId &&
    event.changeType === "updated" &&
    event.reason === "dreaming_ltm_skipped_stm_retained"
  ));
});

test("a failed LTM commit keeps STM available for retry", async () => {
  class FailingRepository extends InMemoryContextEngineRepository {
    override async replaceLongTermMemory(): Promise<void> {
      throw new Error("ltm_commit_failed");
    }
  }
  const repository = new FailingRepository();
  const stm = createStm("stm-commit-failure", "2026-08-05T14:00:00.000Z");
  await repository.saveShortTermMemory(stm);
  const run = await createRunService(repository).createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async ({ memory }) => ({ evaluation: evaluation(memory.memoryDataId, "consolidate", 8).evaluation, longTermMemory: { memoryId: "ltm-failure", theoryClass: "semantic", memoryType: "fact", content: memory.content, sourceRefs: memory.sourceRefs, sourceMemoryDataIds: [memory.memoryDataId], sourceFactIds: memory.sourceFactIds, entityIds: [], confidenceLevel: "high", recallWeight: "high", solidifyReason: "test", matchedRules: [], lifecycleStatus: "active" } })
  });
  const result = await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });
  assert.ok(result?.completed);
  assert.equal(repository.getShortTermMemory(stm.memoryDataId)?.consolidationStatus, "retry_wait");
  assert.equal(repository.getLongTermMemory("ltm-failure"), undefined);
  assert.equal(repository.getDebugSnapshot().dreamingCandidateDecisions.length, 0);
  assert.equal(repository.getDebugSnapshot().llmDreamingTraces.length, 0);
});

test("updates creates a new LTM version and retains the previous LTM as revised", async () => {
  const repository = new InMemoryContextEngineRepository();
  const oldLtm: LongTermMemory = {
    memoryId: "ltm-old-version",
    tenantId: "tenant-a",
    principalId: "user-a",
    version: 2,
    theoryClass: "semantic",
    memoryType: "fact",
    content: "项目使用旧方案",
    sourceRefs: [],
    sourceMemoryDataIds: ["stm-old"],
    sourceFactIds: ["fact-old"],
    entityIds: ["project-a"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "existing",
    matchedRules: [],
    lifecycleStatus: "active"
  };
  await repository.saveLongTermMemory(oldLtm);
  const stm = createStm("stm-update", "2026-08-05T14:00:00.000Z");
  stm.entityIds = ["project-a"];
  await repository.saveShortTermMemory(stm);
  await createRunService(repository).createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async ({ memory }) => ({
      evaluation: evaluation(memory.memoryDataId, "consolidate", 9).evaluation,
      longTermMemory: createProjectedLtm(memory, "ltm-new-version"),
      ltmOperation: {
        memoryDataId: memory.memoryDataId,
        operation: "revise",
        targetLtmId: oldLtm.memoryId,
        resultLtmId: "ltm-new-version",
        relationType: "updates",
        reason: "new fact updates old fact"
      }
    })
  });
  await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });

  const oldAfter = repository.getLongTermMemory(oldLtm.memoryId);
  const newLtm = repository.getLongTermMemory("ltm-new-version");
  assert.equal(oldAfter?.content, oldLtm.content);
  assert.equal(oldAfter?.lifecycleStatus, "revised");
  assert.equal(newLtm?.version, 3);
  assert.equal(newLtm?.previousVersionId, oldLtm.memoryId);
  assert.ok(repository.relationEdges.some((edge) =>
    edge.relationType === "updates" && edge.fromId === "ltm-new-version" && edge.toId === oldLtm.memoryId
  ));
});

test("replaying the same consolidation key does not create another LTM", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm-idempotent", "2026-08-05T14:00:00.000Z");
  await repository.saveShortTermMemory(stm);
  const created = await createRunService(repository).createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  const result: SingleStmEvaluationResult = {
    evaluation: evaluation(stm.memoryDataId, "consolidate", 8).evaluation,
    longTermMemory: createProjectedLtm(stm, "ltm-idempotent-first")
  };
  const worker = new DreamingWorker(repository, { now: () => NOW, evaluator: async () => result });
  await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });
  const completedCandidate = repository.listDreamingRunCandidates(created.run.runId)[0]!;
  await repository.saveShortTermMemory(stm);
  await commitSingleDreamingResult(repository, {
    run: created.run,
    candidate: completedCandidate,
    memory: stm,
    result: { ...result, longTermMemory: createProjectedLtm(stm, "ltm-idempotent-replay") },
    timezone: "Asia/Shanghai",
    now: NOW
  });
  assert.equal(repository.getDebugSnapshot().longTermMemories.length, 1);
  assert.equal(repository.getLongTermMemory("ltm-idempotent-first")?.memoryId, "ltm-idempotent-first");
  assert.equal(repository.getLongTermMemory("ltm-idempotent-replay"), undefined);
});

test("a failed LTM index outbox does not restore the released STM", async () => {
  class FailingIndexRepository extends InMemoryContextEngineRepository {
    override async saveIndexEntry(): Promise<void> {
      throw new Error("ltm_index_failed");
    }
  }
  const repository = new FailingIndexRepository();
  const stm = createStm("stm-outbox-failure", "2026-08-05T14:00:00.000Z");
  await repository.saveShortTermMemory(stm);
  await createRunService(repository).createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async ({ memory }) => ({
      evaluation: evaluation(memory.memoryDataId, "consolidate", 8).evaluation,
      longTermMemory: createProjectedLtm(memory, "ltm-outbox-failure")
    })
  });
  await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });
  assert.equal(repository.getShortTermMemory(stm.memoryDataId), undefined);
  assert.equal(repository.getLongTermMemory("ltm-outbox-failure")?.memoryId, "ltm-outbox-failure");
  const outbox = repository.getDebugSnapshot().dreamingOutbox.find((item) => item.ownerId === "ltm-outbox-failure");
  assert.equal(outbox?.status, "failed");
  assert.match(outbox?.lastError ?? "", /ltm_index_failed/u);
});

test("SQLite restart preserves the LTM after releasing its source STM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dreaming-worker-ltm-"));
  const databasePath = join(directory, "store.sqlite");
  const repository = new SqliteContextEngineRepository(databasePath);
  const stm = createStm("stm-sqlite-release", "2026-08-05T14:00:00.000Z");
  try {
    await repository.saveShortTermMemory(stm);
    const created = await new DreamingRunService(repository, {
      policyVersion: "dreaming-policy-test",
      promptVersion: "dreaming-prompt-test",
      model: "dreaming-model-test"
    }).createScheduledRun({ tenantId: "tenant-a", principalId: "user-a", scheduledAt: CUTOFF });
    const worker = new DreamingWorker(repository, {
      now: () => NOW,
      evaluator: async ({ memory }) => ({
        evaluation: evaluation(memory.memoryDataId, "consolidate", 8).evaluation,
        longTermMemory: createProjectedLtm(memory, "ltm-sqlite-release")
      })
    });
    await worker.processNextRun({ tenantId: "tenant-a", principalId: "user-a", workerId: "worker-a", now: NOW });
    repository.close();

    const reopened = new SqliteContextEngineRepository(databasePath);
    try {
      const ltm = reopened.getLongTermMemory("ltm-sqlite-release");
      assert.equal(ltm?.tenantId, stm.tenantId);
      assert.equal(ltm?.principalId, stm.principalId);
      assert.deepEqual(ltm?.sourceFactIds, stm.sourceFactIds);
      assert.equal(reopened.getShortTermMemory(stm.memoryDataId), undefined);
      assert.equal(reopened.getDebugSnapshot().relationEdges.some((edge) =>
        edge.fromId === stm.memoryDataId || edge.toId === stm.memoryDataId
      ), false);
      const candidate = reopened.listDreamingRunCandidates(created.run.runId)[0];
      assert.equal(candidate?.status, "consolidated");
      assert.equal(reopened.getDebugSnapshot().dreamingCandidateDecisions.some((decision) =>
        decision.decisionId === candidate?.decisionId && decision.decision === "accepted"
      ), true);
    } finally {
      reopened.close();
    }
  } finally {
    try { repository.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

function createRunService(repository: InMemoryContextEngineRepository) {
  return new DreamingRunService(repository, {
    policyVersion: "dreaming-policy-test",
    promptVersion: "dreaming-prompt-test",
    model: "dreaming-model-test"
  });
}

function evaluation(memoryDataId: string, decision: DreamingStmDecision, totalScore: number): SingleStmEvaluationResult {
  return {
    evaluation: {
      memoryDataId,
      factorScores: {
        stability: 1,
        reuseValue: 1,
        identityRelationValue: 1,
        actionCommitmentValue: 1,
        informationEntropy: 1,
        explicitWeight: 1,
        preferenceConsistency: 1
      },
      factorReasons: {},
      totalScore,
      decision,
      decisionReason: `test_${decision}`,
      evaluatedAt: NOW
    }
  };
}

function createStm(memoryDataId: string, createdAt: string): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "tenant-a",
    principalId: "user-a",
    createdAt,
    updatedAt: createdAt,
    memoryDataType: "conversation_fact",
    memoryType: "fact",
    content: `STM ${memoryDataId}`,
    sourceFactIds: [`fact-${memoryDataId}`],
    sourceRefs: [{ sourceRefId: `source-${memoryDataId}`, sourceType: "conversation", sourceId: memoryDataId }],
    entityIds: [],
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
    consolidationStatus: "unseen"
  };
}

function createProjectedLtm(memory: ShortTermMemory, memoryId: string): LongTermMemory {
  return {
    memoryId,
    tenantId: memory.tenantId,
    principalId: memory.principalId,
    theoryClass: "semantic",
    memoryType: memory.memoryType ?? "fact",
    content: memory.content,
    sourceRefs: memory.sourceRefs,
    sourceMemoryDataIds: [memory.memoryDataId],
    sourceFactIds: memory.sourceFactIds,
    entityIds: memory.entityIds,
    confidenceLevel: memory.confidenceLevel,
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    accessState: "visible"
  };
}

function dreamingTrace(
  memory: ShortTermMemory,
  scored: SingleStmEvaluationResult["evaluation"],
  longTermMemory: LongTermMemory
): LlmDreamingTrace {
  return {
    traceId: `trace-${memory.memoryDataId}`,
    sourceMemoryDataIds: [memory.memoryDataId],
    provider: "openai-compatible",
    endpoint: "https://llm.example/v1/chat/completions",
    model: "dreaming-model-test",
    keySource: "request",
    promptVersion: "dreaming-prompt-test",
    schemaVersion: "long-term-memory.v1",
    prompt: "test prompt",
    candidateMemories: [{
      memoryDataId: memory.memoryDataId,
      memoryDataType: memory.memoryDataType,
      ...(memory.memoryType ? { memoryType: memory.memoryType } : {}),
      content: memory.content,
      importanceLevel: memory.importanceLevel,
      confidenceLevel: memory.confidenceLevel,
      lifecycleStatus: memory.lifecycleStatus,
      matchedRules: memory.matchedRules,
      sourceFactIds: memory.sourceFactIds,
      entityIds: memory.entityIds
    }],
    stmEvaluations: [scored],
    parsedMemories: [longTermMemory],
    rejectedCandidates: [],
    createdAt: scored.evaluatedAt
  };
}
