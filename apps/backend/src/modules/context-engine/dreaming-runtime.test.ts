import assert from "node:assert/strict";
import test from "node:test";
import { getContextEngineConfig } from "../../config.js";
import type { ShortTermMemory } from "./domain.js";
import { DreamingRunService } from "./dreaming-run-service.js";
import { DreamingRuntime } from "./dreaming-runtime.js";
import { DreamingWorker, type SingleStmEvaluationResult } from "./dreaming-worker.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

const CUTOFF = "2026-08-05T15:00:00.000Z";
const NOW = "2026-08-05T15:01:00.000Z";

test("foreground activity aborts without attempts and resumes the same Run after idle", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-preempted"));
  const runService = new DreamingRunService(repository, { now: () => NOW });
  const created = await runService.createScheduledRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    scheduledAt: CUTOFF
  });
  let evaluationCalls = 0;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async ({ memory, signal }) => {
      evaluationCalls += 1;
      if (evaluationCalls === 1) {
        notifyStarted();
        await waitForAbort(signal);
      }
      return observeEvaluation(memory.memoryDataId);
    }
  });
  const runtime = new DreamingRuntime(repository, {
    config: {
      ...getContextEngineConfig().dreaming,
      enabled: true,
      resumeIdleAfterMs: 10
    },
    now: () => NOW,
    runService,
    worker,
    workerId: "runtime-worker-test"
  });

  await runtime.start();
  await started;
  const release = await runtime.activityGate.acquire({ tenantId: "tenant-a", principalId: "user-a" });
  await waitUntil(() => repository.getDreamingRun(created.run.runId)?.status === "paused");

  const interrupted = repository.listDreamingRunCandidates(created.run.runId)[0];
  assert.equal(interrupted?.status, "pending");
  assert.equal(interrupted?.cycleAttemptCount, 0);
  assert.equal(interrupted?.totalAttemptCount, 0);
  assert.equal(repository.getDreamingRun(created.run.runId)?.pauseReason, "foreground_activity");

  release();
  await waitUntil(() => repository.getDreamingRun(created.run.runId)?.status === "completed");
  assert.equal(evaluationCalls, 2);
  assert.equal(repository.listDreamingRunCandidates(created.run.runId)[0]?.status, "observing");
  assert.equal(repository.getDreamingRun(created.run.runId)?.pauseReason, undefined);
  await runtime.stop();
});

function observeEvaluation(memoryDataId: string): SingleStmEvaluationResult {
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
      totalScore: 5.5,
      decision: "observe",
      decisionReason: "runtime_preemption_test",
      evaluatedAt: NOW
    }
  };
}

function createStm(memoryDataId: string): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "tenant-a",
    principalId: "user-a",
    createdAt: "2026-08-05T14:00:00.000Z",
    updatedAt: "2026-08-05T14:00:00.000Z",
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

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error("missing_abort_signal");
  if (signal.aborted) throw abortError();
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function abortError() {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
