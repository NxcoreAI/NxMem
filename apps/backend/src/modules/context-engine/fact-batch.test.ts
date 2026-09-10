import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FactItem, MemoryEvent } from "./domain.js";
import {
  createFactBatchCommitted,
  FactBatchCommitError
} from "./fact-batch.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";

const firstCommittedAt = "2026-08-07T08:00:00.000Z";

test("creates a stable batch ID independent of fact ordering", () => {
  const left = createFactBatchCommitted({
    triggerType: "event",
    sourceKey: "event_1",
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds: ["fact_2", "fact_1", "fact_2"],
    committedAt: firstCommittedAt
  });
  const right = createFactBatchCommitted({
    triggerType: "event",
    sourceKey: "event_1",
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds: ["fact_1", "fact_2"],
    committedAt: "2026-08-07T08:01:00.000Z"
  });

  assert.equal(left.batchId, right.batchId);
  assert.deepEqual(left.newFactIds, ["fact_1", "fact_2"]);
  assert.deepEqual(right.newFactIds, left.newFactIds);
});

test("rejects a batch until every referenced fact is persisted", async () => {
  const repository = new InMemoryContextEngineRepository();
  const batch = eventBatch(["fact_missing"]);

  await assert.rejects(
    repository.saveFactBatchCommitted(batch),
    (error: unknown) => error instanceof FactBatchCommitError &&
      error.code === "FACT_BATCH_FACTS_MISSING"
  );
  assert.deepEqual(repository.getDebugSnapshot().factBatches, []);
});

test("reuses an identical commit and rejects changed content for the same stable batch", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveFactItem(fact("fact_1"));
  await repository.saveFactItem(fact("fact_2"));

  const original = await repository.saveFactBatchCommitted(eventBatch(["fact_1"]));
  const repeated = await repository.saveFactBatchCommitted({
    ...eventBatch(["fact_1"]),
    committedAt: "2026-08-07T09:00:00.000Z"
  });

  assert.deepEqual(repeated, original);
  assert.equal(repeated.committedAt, firstCommittedAt);
  assert.equal(repository.getDebugSnapshot().factBatches?.length, 1);

  await assert.rejects(
    repository.saveFactBatchCommitted(eventBatch(["fact_1", "fact_2"])),
    (error: unknown) => error instanceof FactBatchCommitError &&
      error.code === "FACT_BATCH_CONFLICT"
  );
  assert.equal(repository.getDebugSnapshot().factBatches?.length, 1);
});

test("persists batches across SQLite restart and supports uncached reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-fact-batch-"));
  const storePath = join(directory, "context.sqlite");
  const batch = eventBatch(["fact_1", "fact_2"]);

  try {
    const writer = new SqliteContextEngineRepository(storePath);
    await writer.saveFactItem(fact("fact_1"));
    await writer.saveFactItem(fact("fact_2"));
    await writer.saveFactBatchCommitted(batch);
    writer.close();

    const restored = new SqliteContextEngineRepository(storePath);
    assert.deepEqual(restored.getDebugSnapshot().factBatches, [batch]);
    assert.deepEqual(restored.getFactBatchCommitted(batch.batchId), batch);
    restored.close();

    const uncached = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    assert.deepEqual(uncached.getDebugSnapshot().factBatches, []);
    assert.deepEqual(uncached.getFactBatchCommitted(batch.batchId), batch);
    uncached.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inherits and persists context scope from a source event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-fact-scope-"));
  const storePath = join(directory, "context.sqlite");
  const sourceEvent = event("question_1");

  try {
    const writer = new SqliteContextEngineRepository(storePath);
    await writer.saveMemoryEvent(sourceEvent);
    await writer.saveFactItem(fact("fact_1"));
    const batch = await writer.saveFactBatchCommitted(createFactBatchCommitted({
      triggerType: "event",
      sourceKey: sourceEvent.eventId,
      tenantId: "tenant_1",
      principalId: "principal_1",
      contextScopeId: "question_1",
      factIds: ["fact_1"],
      committedAt: firstCommittedAt
    }));

    assert.equal(writer.getFactItemsByIds(["fact_1"])[0]?.contextScopeId, "question_1");
    writer.close();

    const restored = new SqliteContextEngineRepository(storePath);
    assert.equal(restored.getMemoryEventsByIds([sourceEvent.eventId])[0]?.contextScopeId, "question_1");
    assert.equal(restored.getFactItemsByIds(["fact_1"])[0]?.contextScopeId, "question_1");
    assert.equal(restored.getFactBatchCommitted(batch.batchId)?.contextScopeId, "question_1");
    restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function eventBatch(factIds: string[]) {
  return createFactBatchCommitted({
    triggerType: "event",
    sourceKey: "event_1",
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds,
    committedAt: firstCommittedAt
  });
}

function fact(factId: string): FactItem {
  return {
    factId,
    factType: "test_fact",
    factText: `Fact ${factId}`,
    normalizedClaim: `fact ${factId}`,
    linkedEventIds: ["event_1"],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: firstCommittedAt,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-batch-test.v1"
  };
}

function event(contextScopeId: string): MemoryEvent {
  return {
    eventId: "event_1",
    contextScopeId,
    eventType: "fact_batch_test",
    eventTime: firstCommittedAt,
    permissionSnapshot: {
      snapshotId: "permission_event_1",
      tenantId: "tenant_1",
      principalId: "principal_1",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: []
  };
}
