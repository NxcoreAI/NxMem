import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FactItem } from "./domain.js";
import { createFactBatchCommitted } from "./fact-batch.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";
import { TimelineFusionScheduler } from "./timeline-fusion-scheduler.js";

const startAt = "2026-08-07T08:00:00.000Z";

test("deduplicates the same batch and coalesces owner batches without passing the deadline", async () => {
  const repository = new InMemoryContextEngineRepository();
  let now = startAt;
  const scheduler = new TimelineFusionScheduler(repository, {
    debounceMs: 10_000,
    maxWaitMs: 30_000,
    now: () => now,
    enqueueJob: async (job) => job(),
    prepareReadyTask: async () => undefined
  });

  try {
    const first = await commitBatch(repository, "event_1", "fact_1");
    const firstTask = await scheduler.enqueue(first);
    assert.equal(firstTask.scheduledAt, "2026-08-07T08:00:10.000Z");
    assert.equal(firstTask.deadlineAt, "2026-08-07T08:00:30.000Z");

    const duplicate = await scheduler.enqueue(first);
    assert.equal(duplicate.taskId, firstTask.taskId);
    assert.deepEqual(duplicate.batchIds, [first.batchId]);

    now = "2026-08-07T08:00:08.000Z";
    const second = await commitBatch(repository, "event_2", "fact_2");
    const merged = await scheduler.enqueue(second);
    assert.equal(merged.taskId, firstTask.taskId);
    assert.equal(merged.scheduledAt, "2026-08-07T08:00:18.000Z");

    now = "2026-08-07T08:00:25.000Z";
    const third = await commitBatch(repository, "event_3", "fact_3");
    const capped = await scheduler.enqueue(third);
    assert.equal(capped.scheduledAt, capped.deadlineAt);
    assert.deepEqual(capped.newFactIds, ["fact_1", "fact_2", "fact_3"]);
    assert.equal(repository.getDebugSnapshot().timelineFusionTasks?.length, 1);

    now = "2026-08-07T08:00:29.000Z";
    await scheduler.runDue();
    assert.equal((await repository.getTimelineFusionTask(capped.taskId))?.status, "pending");

    now = "2026-08-07T08:00:30.000Z";
    await scheduler.runDue();
    const ready = await repository.getTimelineFusionTask(capped.taskId);
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.readyAt, now);
  } finally {
    scheduler.stop();
  }
});

test("does not coalesce batches across owner scope", async () => {
  const repository = new InMemoryContextEngineRepository();
  const scheduler = new TimelineFusionScheduler(repository, {
    debounceMs: 10_000,
    maxWaitMs: 30_000,
    now: () => startAt,
    enqueueJob: async (job) => job(),
    prepareReadyTask: async () => undefined
  });

  try {
    const first = await commitBatch(repository, "event_1", "fact_1");
    const second = await commitBatch(repository, "event_2", "fact_2", "principal_2");
    const firstTask = await scheduler.enqueue(first);
    const secondTask = await scheduler.enqueue(second);

    assert.notEqual(firstTask.taskId, secondTask.taskId);
    assert.equal(repository.getDebugSnapshot().timelineFusionTasks?.length, 2);
  } finally {
    scheduler.stop();
  }
});

test("does not coalesce batches across context scope", async () => {
  const repository = new InMemoryContextEngineRepository();
  const scheduler = new TimelineFusionScheduler(repository, {
    debounceMs: 10_000,
    maxWaitMs: 30_000,
    now: () => startAt,
    enqueueJob: async (job) => job(),
    prepareReadyTask: async () => undefined
  });

  try {
    const first = await commitBatch(repository, "event_1", "fact_1", "principal_1", "question_1");
    const second = await commitBatch(repository, "event_2", "fact_2", "principal_1", "question_2");
    const firstTask = await scheduler.enqueue(first);
    const secondTask = await scheduler.enqueue(second);

    assert.notEqual(firstTask.taskId, secondTask.taskId);
    assert.equal(firstTask.contextScopeId, "question_1");
    assert.equal(secondTask.contextScopeId, "question_2");
    assert.equal(repository.getDebugSnapshot().timelineFusionTasks?.length, 2);
  } finally {
    scheduler.stop();
  }
});

test("starts a new task after the 16 batch hard limit", async () => {
  const repository = new InMemoryContextEngineRepository();
  const scheduler = new TimelineFusionScheduler(repository, {
    debounceMs: 10_000,
    maxWaitMs: 30_000,
    now: () => startAt,
    enqueueJob: async (job) => job(),
    prepareReadyTask: async () => undefined
  });

  try {
    const tasks = [];
    for (let index = 1; index <= 17; index += 1) {
      const batch = await commitBatch(
        repository,
        `event_${index}`,
        `fact_${index}`,
        "principal_1",
        "question_1"
      );
      tasks.push(await scheduler.enqueue(batch));
    }

    assert.equal(tasks[15]?.batchIds.length, 16);
    assert.equal(tasks[16]?.batchIds.length, 1);
    assert.notEqual(tasks[15]?.taskId, tasks[16]?.taskId);
  } finally {
    scheduler.stop();
  }
});

test("allows exactly 128 facts and starts a new task above the fact hard limit", async () => {
  const repository = new InMemoryContextEngineRepository();
  const scheduler = new TimelineFusionScheduler(repository, {
    debounceMs: 10_000,
    maxWaitMs: 30_000,
    now: () => startAt,
    enqueueJob: async (job) => job(),
    prepareReadyTask: async () => undefined
  });

  try {
    const firstFactIds = Array.from({ length: 127 }, (_, index) => `fact_${index + 1}`);
    const first = await commitBatchFacts(repository, "event_many", firstFactIds, "question_1");
    const second = await commitBatch(repository, "event_128", "fact_128", "principal_1", "question_1");
    const third = await commitBatch(repository, "event_129", "fact_129", "principal_1", "question_1");

    const firstTask = await scheduler.enqueue(first);
    const boundaryTask = await scheduler.enqueue(second);
    const overflowTask = await scheduler.enqueue(third);

    assert.equal(boundaryTask.taskId, firstTask.taskId);
    assert.equal(boundaryTask.newFactIds.length, 128);
    assert.notEqual(overflowTask.taskId, firstTask.taskId);
    assert.deepEqual(overflowTask.newFactIds, ["fact_129"]);
  } finally {
    scheduler.stop();
  }
});

test("rejects scheduling a batch that has not been committed", async () => {
  const repository = new InMemoryContextEngineRepository();
  const scheduler = new TimelineFusionScheduler(repository, {
    now: () => startAt,
    enqueueJob: async (job) => job(),
    prepareReadyTask: async () => undefined
  });
  const batch = createBatch("event_missing", "fact_missing");

  try {
    await assert.rejects(
      scheduler.enqueue(batch),
      /timeline_fusion_batch_not_committed/u
    );
  } finally {
    scheduler.stop();
  }
});

test("recovers an overdue pending task from SQLite without loading repository cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-timeline-fusion-scheduler-"));
  const storePath = join(directory, "context.sqlite");
  let writerScheduler: TimelineFusionScheduler | undefined;
  let readerScheduler: TimelineFusionScheduler | undefined;

  try {
    const writer = new SqliteContextEngineRepository(storePath);
    writerScheduler = new TimelineFusionScheduler(writer, {
      debounceMs: 10_000,
      maxWaitMs: 30_000,
      now: () => startAt,
      enqueueJob: async (job) => job(),
      prepareReadyTask: async () => undefined
    });
    const batch = await commitBatch(
      writer,
      "event_restart",
      "fact_restart",
      "principal_1",
      "question_restart"
    );
    const pending = await writerScheduler.enqueue(batch);
    writerScheduler.stop();
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    readerScheduler = new TimelineFusionScheduler(reader, {
      now: () => "2026-08-07T08:00:11.000Z",
      enqueueJob: async (job) => job(),
      prepareReadyTask: async () => undefined
    });
    assert.equal(reader.getDebugSnapshot().timelineFusionTasks?.length, 0);
    await readerScheduler.start();

    const restored = await reader.getTimelineFusionTask(pending.taskId);
    assert.equal(restored?.status, "ready");
    assert.equal(restored?.contextScopeId, "question_restart");
    assert.deepEqual(restored?.batchIds, [batch.batchId]);
    readerScheduler.stop();
    reader.close();
  } finally {
    writerScheduler?.stop();
    readerScheduler?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers an interrupted running task as ready for an idempotent retry", async () => {
  const repository = new InMemoryContextEngineRepository();
  const writer = new TimelineFusionScheduler(repository, {
    debounceMs: 60_000,
    maxWaitMs: 60_000,
    now: () => startAt,
    enqueueJob: async (job) => job(),
    prepareReadyTask: async () => undefined
  });
  const batch = await commitBatch(repository, "event_running", "fact_running");
  const pending = await writer.enqueue(batch);
  writer.stop();
  await repository.saveTimelineFusionTask({
    ...pending,
    status: "running",
    updatedAt: startAt
  });

  let recoveredStatus: string | undefined;
  const reader = new TimelineFusionScheduler(repository, {
    now: () => "2026-08-07T08:00:05.000Z",
    enqueueJob: async (job) => job(),
    prepareReadyTask: async (task) => {
      recoveredStatus = task.status;
    }
  });
  try {
    await reader.start();
    assert.equal(recoveredStatus, "ready");
    assert.equal((await repository.getTimelineFusionTask(pending.taskId))?.status, "ready");
  } finally {
    reader.stop();
  }
});

async function commitBatch(
  repository: InMemoryContextEngineRepository,
  sourceKey: string,
  factId: string,
  principalId = "principal_1",
  contextScopeId?: string
) {
  await repository.saveFactItem(fact(factId));
  return repository.saveFactBatchCommitted(createBatch(sourceKey, factId, principalId, contextScopeId));
}

async function commitBatchFacts(
  repository: InMemoryContextEngineRepository,
  sourceKey: string,
  factIds: string[],
  contextScopeId?: string
) {
  for (const factId of factIds) await repository.saveFactItem(fact(factId));
  return repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "event",
    sourceKey,
    tenantId: "tenant_1",
    principalId: "principal_1",
    ...(contextScopeId ? { contextScopeId } : {}),
    factIds,
    committedAt: startAt
  }));
}

function createBatch(
  sourceKey: string,
  factId: string,
  principalId = "principal_1",
  contextScopeId?: string
) {
  return createFactBatchCommitted({
    triggerType: "event",
    sourceKey,
    tenantId: "tenant_1",
    principalId,
    ...(contextScopeId ? { contextScopeId } : {}),
    factIds: [factId],
    committedAt: startAt
  });
}

function fact(factId: string): FactItem {
  return {
    factId,
    factType: "test_fact",
    factText: `Fact ${factId}`,
    normalizedClaim: `fact ${factId}`,
    linkedEventIds: [factId.replace("fact", "event")],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: startAt,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-scheduler-test.v1"
  };
}
