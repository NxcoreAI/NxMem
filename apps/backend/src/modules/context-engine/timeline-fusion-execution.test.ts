import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FactItem, MemoryEvent } from "./domain.js";
import { createFactBatchCommitted } from "./fact-batch.js";
import {
  createTimelineFusionExecution,
  TimelineFusionExecutionError
} from "./timeline-fusion-execution.js";
import {
  FileBackedContextEngineRepository,
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";

const firstCreatedAt = "2026-08-07T08:00:00.000Z";

test("creates a stable fingerprint from canonical facts and temporal instants", () => {
  const left = execution({
    newFactIds: ["fact_2", "fact_1", "fact_2"],
    temporalWindow: {
      basis: "evidence",
      startAt: "2026-08-07T16:00:00+08:00",
      endAt: "2026-08-07T17:00:00+08:00"
    }
  });
  const right = execution({
    newFactIds: ["fact_1", "fact_2"],
    temporalWindow: {
      basis: "evidence",
      startAt: "2026-08-07T08:00:00.000Z",
      endAt: "2026-08-07T09:00:00.000Z"
    }
  });

  assert.equal(left.fingerprint, right.fingerprint);
  assert.equal(left.executionId, right.executionId);
  assert.deepEqual(left.newFactIds, ["fact_1", "fact_2"]);
  assert.deepEqual(left.temporalWindow, {
    basis: "evidence",
    startAt: "2026-08-07T08:00:00.000Z",
    endAt: "2026-08-07T09:00:00.000Z"
  });
});

test("separates fingerprints by owner, temporal window, basis, and policy version", () => {
  const original = execution();

  assert.notEqual(execution({ tenantId: "tenant_2" }).fingerprint, original.fingerprint);
  assert.notEqual(execution({ principalId: "principal_2" }).fingerprint, original.fingerprint);
  assert.notEqual(execution({ contextScopeId: "question_1" }).fingerprint, original.fingerprint);
  assert.notEqual(
    execution({ contextScopeId: "question_1" }).fingerprint,
    execution({ contextScopeId: "question_2" }).fingerprint
  );
  assert.notEqual(execution({
    temporalWindow: {
      basis: "evidence",
      startAt: "2026-08-07T08:00:00.000Z",
      endAt: "2026-08-07T10:00:00.000Z"
    }
  }).fingerprint, original.fingerprint);
  assert.notEqual(execution({
    temporalWindow: {
      basis: "valid",
      startAt: "2026-08-07T08:00:00.000Z",
      endAt: "2026-08-07T09:00:00.000Z"
    }
  }).fingerprint, original.fingerprint);
  assert.notEqual(execution({ fusionPolicyVersion: "timeline-fusion.v2" }).fingerprint, original.fingerprint);
});

test("rejects empty facts, unresolved inputs, invalid ranges, and missing policy version", () => {
  assert.throws(
    () => execution({ newFactIds: [] }),
    invalidExecution
  );
  assert.throws(
    () => execution({ fusionPolicyVersion: " " }),
    invalidExecution
  );
  assert.throws(
    () => execution({
      temporalWindow: {
        basis: "evidence",
        startAt: "2026-08-07T10:00:00.000Z",
        endAt: "2026-08-07T09:00:00.000Z"
      }
    }),
    invalidExecution
  );
  assert.throws(
    () => execution({
      temporalWindow: {
        basis: "unresolved" as "evidence",
        startAt: "2026-08-07T08:00:00.000Z",
        endAt: "2026-08-07T09:00:00.000Z"
      }
    }),
    invalidExecution
  );
});

test("reuses the first in-memory reservation and rejects incompatible provenance", async () => {
  const repository = new InMemoryContextEngineRepository();
  const original = execution();
  const reserved = await repository.reserveTimelineFusionExecution(original);
  const repeated = await repository.reserveTimelineFusionExecution(execution({
    createdAt: "2026-08-07T08:05:00.000Z"
  }));

  assert.deepEqual(repeated, reserved);
  assert.equal(repeated.createdAt, firstCreatedAt);
  assert.equal(repeated.updatedAt, firstCreatedAt);
  assert.equal(repository.getDebugSnapshot().timelineFusionExecutions?.length, 1);

  await assert.rejects(
    repository.reserveTimelineFusionExecution({
      ...original,
      taskIds: ["timeline_task_other"]
    }),
    (error: unknown) => error instanceof TimelineFusionExecutionError &&
      error.code === "TIMELINE_FUSION_EXECUTION_CONFLICT"
  );
});

test("persists and clears file-backed execution reservations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-timeline-fusion-file-"));
  const storePath = join(directory, "context.json");
  const original = execution();

  try {
    const writer = new FileBackedContextEngineRepository(storePath);
    await writer.reserveTimelineFusionExecution(original);

    const restored = new FileBackedContextEngineRepository(storePath);
    assert.deepEqual(
      restored.getTimelineFusionExecutionByFingerprint(original.fingerprint),
      original
    );
    await restored.clearAllContextData();

    const cleared = new FileBackedContextEngineRepository(storePath);
    assert.equal(cleared.getTimelineFusionExecutionByFingerprint(original.fingerprint), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deletes an execution when its source event facts are deleted", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = memoryEvent();
  const sourceFact = fact("fact_event_1", event.eventId);
  await repository.saveMemoryEvent(event);
  await repository.saveFactItem(sourceFact);
  const batch = await repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "event",
    sourceKey: event.eventId,
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds: [sourceFact.factId],
    committedAt: firstCreatedAt
  }));
  const reserved = await repository.reserveTimelineFusionExecution(execution({
    batchIds: [batch.batchId],
    newFactIds: [sourceFact.factId]
  }));

  await repository.deleteMemoryEventCascade(event.eventId, { recordChangeEvent: false });

  assert.equal(repository.getFactBatchCommitted(batch.batchId), undefined);
  assert.equal(repository.getTimelineFusionExecutionByFingerprint(reserved.fingerprint), undefined);
});

test("persists SQLite reservations across restart and supports uncached read and retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-timeline-fusion-sqlite-"));
  const storePath = join(directory, "context.sqlite");
  const original = execution({ contextScopeId: "question_1" });

  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const reserved = await writer.reserveTimelineFusionExecution(original);
    const completed = {
      ...reserved,
      status: "succeeded" as const,
      resultFactIds: ["fact_result_1", "fact_result_1"],
      attempt: 1,
      updatedAt: "2026-08-07T08:01:00.000Z",
      completedAt: "2026-08-07T08:01:00.000Z"
    };
    await writer.saveTimelineFusionExecution(completed);
    writer.close();

    const restored = new SqliteContextEngineRepository(storePath);
    assert.deepEqual(restored.getDebugSnapshot().timelineFusionExecutions, [{
      ...completed,
      resultFactIds: ["fact_result_1"]
    }]);
    assert.deepEqual(
      restored.getTimelineFusionExecutionByFingerprint(original.fingerprint),
      { ...completed, resultFactIds: ["fact_result_1"] }
    );
    restored.close();

    const uncached = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    assert.deepEqual(uncached.getDebugSnapshot().timelineFusionExecutions, []);
    assert.deepEqual(
      uncached.getTimelineFusionExecutionByFingerprint(original.fingerprint),
      { ...completed, resultFactIds: ["fact_result_1"] }
    );
    const repeated = await uncached.reserveTimelineFusionExecution(execution({
      contextScopeId: "question_1",
      createdAt: "2026-08-07T08:10:00.000Z"
    }));
    assert.deepEqual(repeated, { ...completed, resultFactIds: ["fact_result_1"] });
    assert.equal(uncached.getDebugSnapshot().timelineFusionExecutions?.length, 1);

    await assert.rejects(
      uncached.reserveTimelineFusionExecution({
        ...original,
        batchIds: ["fact_batch_other"]
      }),
      (error: unknown) => error instanceof TimelineFusionExecutionError &&
        error.code === "TIMELINE_FUSION_EXECUTION_CONFLICT"
    );
    await uncached.clearAllContextData();
    assert.equal(uncached.getTimelineFusionExecutionByFingerprint(original.fingerprint), undefined);
    uncached.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function execution(overrides: Partial<Parameters<typeof createTimelineFusionExecution>[0]> = {}) {
  return createTimelineFusionExecution({
    tenantId: "tenant_1",
    principalId: "principal_1",
    taskIds: ["timeline_task_1"],
    batchIds: ["fact_batch_1"],
    newFactIds: ["fact_1"],
    temporalWindow: {
      basis: "evidence",
      startAt: "2026-08-07T08:00:00.000Z",
      endAt: "2026-08-07T09:00:00.000Z"
    },
    fusionPolicyVersion: "timeline-fusion.v1",
    createdAt: firstCreatedAt,
    ...overrides
  });
}

function invalidExecution(error: unknown) {
  return error instanceof TimelineFusionExecutionError &&
    error.code === "TIMELINE_FUSION_EXECUTION_INVALID";
}

function memoryEvent(): MemoryEvent {
  return {
    eventId: "event_1",
    eventType: "timeline_fusion_test",
    eventDescription: "Timeline fusion execution cleanup test",
    eventTime: firstCreatedAt,
    sourceApp: "test",
    sourceId: "event_1",
    permissionSnapshot: {
      snapshotId: "permission_event_1",
      tenantId: "tenant_1",
      principalId: "principal_1",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item_event_1",
      type: "text",
      format: "plain",
      content: "Timeline fusion cleanup fact",
      ref: "event_1"
    }],
    sourceRefs: []
  };
}

function fact(factId: string, eventId: string): FactItem {
  return {
    factId,
    factType: "test_fact",
    factText: "Timeline fusion cleanup fact",
    normalizedClaim: "timeline fusion cleanup fact",
    linkedEventIds: [eventId],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: firstCreatedAt,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-execution-test.v1"
  };
}
