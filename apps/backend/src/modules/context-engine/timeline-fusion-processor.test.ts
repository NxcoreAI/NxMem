import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHealthServer } from "../health/server.js";
import type { FactItem, TimelineFusionTask } from "./domain.js";
import { createFactBatchCommitted } from "./fact-batch.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";
import { processTimelineFusionTask } from "./timeline-fusion-processor.js";
import type { TimelineFusionRelationJudgmentResult } from "./timeline-fusion-relation-judgment.js";
import { createTimelineFusionTask } from "./timeline-fusion-task.js";

const NOW = "2026-08-07T08:30:00.000Z";

test("runs relation judgment through an atomic immutable Fact Store update", async () => {
  const repository = new InMemoryContextEngineRepository();
  const task = await setupReadyTask(repository);
  let judgmentCount = 0;
  const result = await processTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1000,
    now: () => NOW,
    judgeRelations: async () => {
      judgmentCount += 1;
      return supplementJudgment();
    }
  });

  assert.equal(judgmentCount, 1);
  assert.equal(result.task.status, "succeeded");
  assert.equal(result.executions[0]?.status, "succeeded");
  assert.equal(result.executions[0]?.attempt, 1);
  const [current] = await repository.getFactItemsByIds(["fact_history"]);
  assert.equal(current?.factText, "Atlas review is Friday and covers power and cost.");
  assert.equal(current?.version, 2);
  const versions = await repository.getFactVersions({
    tenantId: "tenant_1",
    principalId: "principal_1",
    factId: "fact_history"
  });
  assert.deepEqual(versions.map((item) => item.version), [1, 2]);
  assert.equal(versions[0]?.factText, "Atlas review is Friday");
  assert.equal(versions[1]?.previousVersionId, versions[0]?.factVersionId);
});

test("replays a completed SQLite execution without another judgment or duplicate version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-fusion-processor-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const task = await setupReadyTask(writer);
    await processTimelineFusionTask(writer, task, {
      windowMs: 60 * 60 * 1000,
      now: () => NOW,
      judgeRelations: async () => supplementJudgment()
    });
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    const storedTask = await reader.getTimelineFusionTask(task.taskId);
    assert.equal(storedTask?.status, "succeeded");
    const { completedAt: _completedAt, completionReason: _completionReason, error: _error, ...rest } = storedTask!;
    const readyTask: TimelineFusionTask = {
      ...rest,
      status: "ready",
      readyAt: NOW,
      updatedAt: NOW
    };
    await reader.saveTimelineFusionTask(readyTask);
    let judgmentCount = 0;
    const replay = await processTimelineFusionTask(reader, readyTask, {
      windowMs: 60 * 60 * 1000,
      now: () => NOW,
      judgeRelations: async () => {
        judgmentCount += 1;
        return supplementJudgment();
      }
    });

    assert.equal(replay.task.status, "succeeded");
    assert.equal(judgmentCount, 0);
    assert.equal((await reader.getFactVersions({
      tenantId: "tenant_1",
      principalId: "principal_1"
    })).length, 3);
    reader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exposes an owner-scoped fact audit chain and includes versions in debug snapshots", async () => {
  const repository = new InMemoryContextEngineRepository();
  const task = await setupReadyTask(repository);
  await processTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1000,
    now: () => NOW,
    judgeRelations: async () => supplementJudgment()
  });
  const server = createHealthServer(repository);
  try {
    const missingOwner = await server.inject({
      method: "GET",
      url: "/context/facts/fact_history/versions"
    });
    assert.equal(missingOwner.statusCode, 400);

    const wrongOwner = await server.inject({
      method: "GET",
      url: "/context/facts/fact_history/versions",
      headers: ownerHeaders("principal_2")
    });
    assert.equal(wrongOwner.statusCode, 404);

    const audit = await server.inject({
      method: "GET",
      url: "/context/facts/fact_history/versions",
      headers: ownerHeaders()
    });
    assert.equal(audit.statusCode, 200);
    assert.deepEqual(audit.json().result.versions.map((item: { version: number }) => item.version), [1, 2]);

    const snapshot = await server.inject({ method: "GET", url: "/context/debug/snapshot" });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().items.factVersions.length, 3);
  } finally {
    await server.close();
  }
});

async function setupReadyTask(repository: InMemoryContextEngineRepository) {
  await repository.saveFactItem(fact(
    "fact_history",
    "Atlas review is Friday",
    "2026-08-07T08:00:00.000Z"
  ));
  await repository.saveFactItem(fact(
    "fact_new",
    "Atlas review covers power and cost",
    "2026-08-07T08:20:00.000Z"
  ));
  const batch = await repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "event",
    sourceKey: "processor_test",
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds: ["fact_new"],
    committedAt: NOW
  }));
  const pending = createTimelineFusionTask({
    batch,
    now: NOW,
    debounceMs: 0,
    maxWaitMs: 0
  });
  const ready: TimelineFusionTask = {
    ...pending,
    status: "ready",
    readyAt: NOW,
    updatedAt: NOW
  };
  await repository.saveTimelineFusionTask(ready);
  return ready;
}

function supplementJudgment(): TimelineFusionRelationJudgmentResult {
  return {
    status: "succeeded",
    responseFormat: "relations",
    result: {
      schemaVersion: "timeline-fusion-relations.v1",
      relations: [{
        type: "supplements",
        sourceFactIds: ["fact_new", "fact_history"],
        factText: "Atlas review is Friday and covers power and cost.",
        normalizedClaim: "atlas review is friday and covers power and cost",
        confidenceLevel: "high",
        reasonCode: "atlas_review_supplement"
      }],
      unusedFactIds: []
    }
  };
}

function fact(factId: string, factText: string, evidenceTimeStart: string): FactItem {
  return {
    factId,
    tenantId: "tenant_1",
    principalId: "principal_1",
    factType: "project_event",
    factText,
    normalizedClaim: factText.toLowerCase(),
    linkedEventIds: [`event_${factId}`],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: ["atlas_review"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: evidenceTimeStart,
    evidenceTimeStart,
    evidenceTimeEnd: evidenceTimeStart,
    evidenceTimeConfidence: "high",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-processor-test.v1"
  };
}

function ownerHeaders(principalId = "principal_1") {
  return {
    "x-context-tenant-id": "tenant_1",
    "x-context-principal-id": principalId
  };
}
