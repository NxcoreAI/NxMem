import assert from "node:assert/strict";
import test from "node:test";
import { getContextEngineConfig } from "../../config.js";
import { createHealthServer } from "../health/server.js";
import type { ShortTermMemory } from "./domain.js";
import { DreamingRuntime } from "./dreaming-runtime.js";
import { DreamingWorker } from "./dreaming-worker.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

const OWNER = { tenantId: "tenant-a", principalId: "user-a" };
const NOW = "2026-08-05T16:00:00.000Z";

test("durable Dreaming API creates, isolates, pauses, resumes, and cancels Runs", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-api"));
  let evaluationCalls = 0;
  const worker = new DreamingWorker(repository, {
    now: () => NOW,
    evaluator: async ({ signal }) => {
      evaluationCalls += 1;
      return waitForAbort(signal);
    }
  });
  const runtime = new DreamingRuntime(repository, {
    config: { ...getContextEngineConfig().dreaming, enabled: true, resumeIdleAfterMs: 5 },
    now: () => NOW,
    worker,
    workerId: "api-worker-test"
  });
  const server = createHealthServer(repository, { dreamingRuntime: runtime });

  try {
    const createResponse = await server.inject({
      method: "POST",
      url: "/context/dreaming/runs",
      payload: OWNER
    });
    assert.equal(createResponse.statusCode, 202);
    const created = createResponse.json().result as { runId: string; triggerType: string; candidateCutoffAt: string };
    assert.equal(created.triggerType, "manual");
    assert.equal(created.candidateCutoffAt, NOW);
    await waitUntil(() => repository.getDreamingRun(created.runId)?.status === "running");

    const wrongOwner = await server.inject({
      method: "GET",
      url: `/context/dreaming/runs/${created.runId}?tenantId=tenant-a&principalId=other-user`
    });
    assert.equal(wrongOwner.statusCode, 404);

    const pauseResponse = await server.inject({
      method: "POST",
      url: `/context/dreaming/runs/${created.runId}/pause`,
      payload: OWNER
    });
    assert.equal(pauseResponse.statusCode, 202);
    await waitUntil(() => repository.getDreamingRun(created.runId)?.status === "paused");
    assert.equal(repository.getDreamingRun(created.runId)?.pauseReason, "manual");
    assert.equal(repository.listDreamingRunCandidates(created.runId)[0]?.cycleAttemptCount, 0);

    const listResponse = await server.inject({
      method: "GET",
      url: "/context/dreaming/runs?tenantId=tenant-a&principalId=user-a&status=paused"
    });
    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual(listResponse.json().result.items.map((item: { runId: string }) => item.runId), [created.runId]);

    const resumeResponse = await server.inject({
      method: "POST",
      url: `/context/dreaming/runs/${created.runId}/resume`,
      payload: OWNER
    });
    assert.equal(resumeResponse.statusCode, 202);
    await waitUntil(() => evaluationCalls === 2 && repository.getDreamingRun(created.runId)?.status === "running");

    const cancelResponse = await server.inject({
      method: "POST",
      url: `/context/dreaming/runs/${created.runId}/cancel`,
      payload: OWNER
    });
    assert.equal(cancelResponse.statusCode, 202);
    await waitUntil(() => repository.getDreamingRun(created.runId)?.status === "cancelled");
    assert.equal(repository.listDreamingRunCandidates(created.runId)[0]?.status, "pending");
  } finally {
    await server.close();
  }
});

test("manual Dreaming API reports disabled runtime without creating a Run", async () => {
  const repository = new InMemoryContextEngineRepository();
  const runtime = new DreamingRuntime(repository, {
    config: { ...getContextEngineConfig().dreaming, enabled: false },
    now: () => NOW
  });
  const server = createHealthServer(repository, { dreamingRuntime: runtime });
  try {
    const response = await server.inject({
      method: "POST",
      url: "/context/dreaming/runs",
      payload: OWNER
    });
    assert.equal(response.statusCode, 503);
    assert.equal(repository.listDreamingRuns().length, 0);
  } finally {
    await server.close();
  }
});

function createStm(memoryDataId: string): ShortTermMemory {
  return {
    memoryDataId,
    ...OWNER,
    createdAt: "2026-08-05T15:30:00.000Z",
    updatedAt: "2026-08-05T15:30:00.000Z",
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
