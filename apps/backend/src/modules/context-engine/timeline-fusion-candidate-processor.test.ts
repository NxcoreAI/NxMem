import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FactItem, MemoryEvent, TimelineFusionTask } from "./domain.js";
import { createFactBatchCommitted } from "./fact-batch.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";
import { prepareTimelineFusionTask } from "./timeline-fusion-candidate-processor.js";
import { TimelineFusionScheduler } from "./timeline-fusion-scheduler.js";
import { createTimelineFusionTask } from "./timeline-fusion-task.js";
import { buildTimelineFusionWindows } from "./timeline-fusion-window.js";

const now = "2026-08-07T08:00:00.000Z";

test("builds and merges valid and evidence windows independently", () => {
  const windows = buildTimelineFusionWindows([
    fact("fact_1", "event_1", {
      evidenceTimeStart: "2026-08-07T08:00:00.000Z",
      validTimeStart: "2026-08-08T02:00:00.000Z"
    }),
    fact("fact_2", "event_2", {
      evidenceTimeStart: "2026-08-07T08:30:00.000Z"
    })
  ], [], { windowMs: 60 * 60 * 1_000 });

  assert.deepEqual(windows, [
    {
      temporalWindow: {
        basis: "evidence",
        startAt: "2026-08-07T07:00:00.000Z",
        endAt: "2026-08-07T09:30:00.001Z"
      },
      newFactIds: ["fact_1", "fact_2"]
    },
    {
      temporalWindow: {
        basis: "valid",
        startAt: "2026-08-08T01:00:00.000Z",
        endAt: "2026-08-08T03:00:00.001Z"
      },
      newFactIds: ["fact_1"]
    }
  ]);
});

test("uses event time only as a weak anchor and never falls back to observedAt", () => {
  const weak = {
    ...fact("fact_weak", "event_weak", {
      validTimeStart: "2026-08-07T09:00:00.000Z"
    }),
    validTimeBasis: "source_time" as const
  };
  const unanchored = fact("fact_unanchored", "event_missing");
  const windows = buildTimelineFusionWindows(
    [weak, unanchored],
    [event("event_weak", "2026-08-07T09:00:00.000Z")],
    { windowMs: 30 * 60 * 1_000 }
  );

  assert.deepEqual(windows, [{
    temporalWindow: {
      basis: "weak_anchor",
      startAt: "2026-08-07T08:30:00.000Z",
      endAt: "2026-08-07T09:30:00.001Z"
    },
    newFactIds: ["fact_weak"]
  }]);
});

test("does not merge point windows farther apart than the configured distance", () => {
  const windows = buildTimelineFusionWindows([
    fact("fact_1", "event_1", { evidenceTimeStart: "2026-08-07T08:00:00.000Z" }),
    fact("fact_2", "event_2", { evidenceTimeStart: "2026-08-07T09:30:00.000Z" })
  ], [], { windowMs: 60 * 60 * 1_000 });

  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.newFactIds), [["fact_1"], ["fact_2"]]);
});

test("recalls a historical fact from another event within the same owner window", async () => {
  const repository = new InMemoryContextEngineRepository();
  await commit(repository, fact("fact_history", "event_history", {
    evidenceTimeStart: "2026-08-07T08:20:00.000Z"
  }), "event_history");
  const batch = await commit(repository, fact("fact_new", "event_new", {
    evidenceTimeStart: "2026-08-07T08:30:00.000Z"
  }), "event_new");
  await commit(repository, fact("fact_other_owner", "event_other", {
    evidenceTimeStart: "2026-08-07T08:25:00.000Z"
  }), "event_other", "principal_2");
  const task = await readyTask(repository, batch);

  const result = await prepareTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1_000,
    now: () => now
  });

  assert.equal(result.task.status, "ready");
  assert.deepEqual(result.windows[0]?.candidateFactIds, ["fact_history"]);
  assert.equal(result.windows[0]?.decision, "candidates_ready");
  assert.equal(result.windows[0]?.execution.status, "pending");
  assert.deepEqual(result.windows[0]?.relationInput?.facts.map((item) => [item.factId, item.isNew]), [
    ["fact_new", true],
    ["fact_history", false]
  ]);
});

test("SQLite candidate lookup only returns facts from the requested context scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-timeline-scope-"));
  const storePath = join(directory, "context.sqlite");

  try {
    const repository = new SqliteContextEngineRepository(storePath);
    const shared = {
      tenantId: "tenant_1",
      principalId: "principal_1",
      evidenceTimeStart: "2026-08-07T08:20:00.000Z"
    };
    await repository.saveFactItem(fact("fact_scope_1", "event_scope_1", {
      ...shared,
      contextScopeId: "question_1"
    }));
    await repository.saveFactItem(fact("fact_scope_2", "event_scope_2", {
      ...shared,
      contextScopeId: "question_2"
    }));

    const candidates = repository.findTimelineFusionFactCandidates({
      tenantId: "tenant_1",
      principalId: "principal_1",
      contextScopeId: "question_1",
      temporalWindow: {
        basis: "evidence",
        startAt: "2026-08-07T08:00:00.000Z",
        endAt: "2026-08-07T09:00:00.000Z"
      }
    });

    assert.deepEqual(candidates.map((item) => item.factId), ["fact_scope_1"]);
    repository.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completes a single new fact through no_candidate without an LLM execution", async () => {
  const repository = new InMemoryContextEngineRepository();
  const batch = await commit(repository, fact("fact_new", "event_new", {
    evidenceTimeStart: "2026-08-07T08:30:00.000Z"
  }), "event_new");
  const task = await readyTask(repository, batch);

  const result = await prepareTimelineFusionTask(repository, task, { now: () => now });

  assert.equal(result.task.status, "succeeded");
  assert.equal(result.task.completionReason, "no_candidate");
  assert.equal(result.windows[0]?.execution.status, "succeeded");
  assert.equal(result.windows[0]?.execution.completionReason, "no_candidate");
  assert.deepEqual(result.windows[0]?.execution.resultFactIds, ["fact_new"]);
  assert.equal(result.windows[0]?.relationInput, undefined);
});

test("completes without a fingerprint when only observedAt is available", async () => {
  const repository = new InMemoryContextEngineRepository();
  const batch = await commit(repository, fact("fact_unanchored", "event_missing"), "event_missing");
  const task = await readyTask(repository, batch);

  const result = await prepareTimelineFusionTask(repository, task, { now: () => now });

  assert.equal(result.task.status, "succeeded");
  assert.equal(result.task.completionReason, "no_temporal_window");
  assert.deepEqual(result.windows, []);
  assert.deepEqual(repository.getDebugSnapshot().timelineFusionExecutions, []);
});

test("keeps multiple new facts in the same window ready for relationship judgment", async () => {
  const repository = new InMemoryContextEngineRepository();
  const first = fact("fact_1", "event_1", {
    evidenceTimeStart: "2026-08-07T08:00:00.000Z"
  });
  const second = fact("fact_2", "event_2", {
    evidenceTimeStart: "2026-08-07T08:30:00.000Z"
  });
  await repository.saveFactItem(first);
  await repository.saveFactItem(second);
  const batch = await repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "ingestion_job",
    sourceKey: "job_1",
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds: [first.factId, second.factId],
    committedAt: now
  }));
  const task = await readyTask(repository, batch);

  const result = await prepareTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1_000,
    now: () => now
  });

  assert.equal(result.task.status, "ready");
  assert.equal(result.windows[0]?.decision, "candidates_ready");
  assert.deepEqual(result.windows[0]?.execution.newFactIds, ["fact_1", "fact_2"]);
  assert.equal(result.windows[0]?.execution.status, "pending");
  assert.deepEqual(result.windows[0]?.relationInput?.newFactIds, ["fact_1", "fact_2"]);
});

test("filters a time-adjacent but semantically unrelated historical fact", async () => {
  const repository = new InMemoryContextEngineRepository();
  await commit(repository, fact("fact_history", "event_history", {
    evidenceTimeStart: "2026-08-07T08:20:00.000Z",
    factType: "text",
    factText: "Bob ordered noodles for lunch",
    normalizedClaim: "Bob ordered noodles for lunch",
    entityIds: ["bob"]
  }), "event_history");
  const batch = await commit(repository, fact("fact_new", "event_new", {
    evidenceTimeStart: "2026-08-07T08:30:00.000Z",
    factType: "event",
    factText: "Atlas deployment started",
    normalizedClaim: "Atlas deployment started",
    entityIds: ["atlas"]
  }), "event_new");
  const task = await readyTask(repository, batch);

  const result = await prepareTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1_000,
    now: () => now
  });

  assert.equal(result.task.status, "succeeded");
  assert.equal(result.windows[0]?.decision, "no_candidate");
  assert.deepEqual(result.windows[0]?.candidateFactIds, []);
});

test("creates one execution per topic group in a shared temporal window", async () => {
  const repository = new InMemoryContextEngineRepository();
  await commit(repository, fact("fact_history", "event_history", {
    evidenceTimeStart: "2026-08-07T08:15:00.000Z",
    factType: "document",
    factText: "Atlas release deployment is in progress",
    normalizedClaim: "Atlas release deployment is in progress",
    entityIds: ["atlas"]
  }), "event_history");
  const lunch = fact("fact_lunch", "event_lunch", {
    evidenceTimeStart: "2026-08-07T08:20:00.000Z",
    factType: "text",
    factText: "Bob ordered noodles for lunch",
    normalizedClaim: "Bob ordered noodles for lunch",
    entityIds: ["bob"]
  });
  const release = fact("fact_release", "event_release", {
    evidenceTimeStart: "2026-08-07T08:30:00.000Z",
    factType: "event",
    factText: "Atlas release deployment started",
    normalizedClaim: "Atlas release deployment started",
    entityIds: ["atlas"]
  });
  await repository.saveFactItem(lunch);
  await repository.saveFactItem(release);
  const batch = await repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "ingestion_job",
    sourceKey: "job_topics",
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds: [lunch.factId, release.factId],
    committedAt: now
  }));
  const task = await readyTask(repository, batch);

  const result = await prepareTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1_000,
    now: () => now
  });

  assert.equal(result.task.status, "ready");
  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.windows.map((item) => ({
    newFactIds: item.newFactIds,
    candidateFactIds: item.candidateFactIds,
    status: item.execution.status
  })), [
    { newFactIds: ["fact_lunch"], candidateFactIds: [], status: "succeeded" },
    { newFactIds: ["fact_release"], candidateFactIds: ["fact_history"], status: "pending" }
  ]);
  assert.equal(result.task.executionFingerprints?.length, 2);
});

test("recovers and prepares a ready task from SQLite without loading cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-timeline-candidates-"));
  const storePath = join(directory, "context.sqlite");
  let scheduler: TimelineFusionScheduler | undefined;

  try {
    const writer = new SqliteContextEngineRepository(storePath);
    await commit(writer, fact("fact_history", "event_history", {
      evidenceTimeStart: "2026-08-07T08:10:00.000Z"
    }), "event_history");
    const batch = await commit(writer, fact("fact_new", "event_new", {
      evidenceTimeStart: "2026-08-07T08:20:00.000Z"
    }), "event_new");
    const task = await readyTask(writer, batch);
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    scheduler = new TimelineFusionScheduler(reader, {
      now: () => now,
      enqueueJob: async (job) => job(),
      prepareReadyTask: async (ready) => {
        await prepareTimelineFusionTask(reader, ready, {
          windowMs: 60 * 60 * 1_000,
          now: () => now
        });
      }
    });
    await scheduler.start();

    const restored = await reader.getTimelineFusionTask(task.taskId);
    assert.equal(restored?.status, "ready");
    assert.equal(restored?.executionFingerprints?.length, 1);
    const execution = reader.getTimelineFusionExecutionByFingerprint(
      restored!.executionFingerprints![0]!
    );
    assert.equal(execution?.status, "pending");
    reader.close();
  } finally {
    scheduler?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

async function commit(
  repository: InMemoryContextEngineRepository,
  item: FactItem,
  sourceKey: string,
  principalId = "principal_1"
) {
  await repository.saveFactItem(item);
  return repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "event",
    sourceKey,
    tenantId: "tenant_1",
    principalId,
    factIds: [item.factId],
    committedAt: now
  }));
}

async function readyTask(
  repository: InMemoryContextEngineRepository,
  batch: Awaited<ReturnType<typeof commit>>
) {
  const pending = createTimelineFusionTask({
    batch,
    now,
    debounceMs: 0,
    maxWaitMs: 0
  });
  const ready: TimelineFusionTask = {
    ...pending,
    status: "ready",
    readyAt: now
  };
  await repository.saveTimelineFusionTask(ready);
  return ready;
}

function fact(
  factId: string,
  eventId: string,
  overrides: Partial<FactItem> = {}
): FactItem {
  return {
    factId,
    factType: "test_fact",
    factText: `Fact ${factId}`,
    normalizedClaim: `fact ${factId}`,
    linkedEventIds: [eventId],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: ["entity_test"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: now,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-candidate-test.v1",
    ...overrides
  };
}

function event(eventId: string, eventTime: string): MemoryEvent {
  return {
    eventId,
    eventType: "timeline_test",
    eventDescription: eventId,
    eventTime,
    sourceApp: "test",
    sourceId: eventId,
    permissionSnapshot: {
      snapshotId: `permission_${eventId}`,
      tenantId: "tenant_1",
      principalId: "principal_1",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [],
    sourceRefs: []
  };
}
