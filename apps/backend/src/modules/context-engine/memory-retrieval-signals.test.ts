import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleContext } from "./assemble-context.js";
import { evaluateDreamingStms } from "./dreaming-stm-scoring.js";
import { refreshShortTermMemoryIndex } from "./indexing.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { searchContext } from "./search-context.js";
import type { LlmDreamingStmScore, ShortTermMemory } from "./domain.js";

const now = "2026-07-30T12:00:00.000Z";

test("search and context assembly record idempotent retrieval events only for selected memories", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = makeStm("stm_retrieval", "用户偏好先给结论，再解释依据。", now);
  await repository.saveShortTermMemory(memory);
  await refreshShortTermMemoryIndex(repository, memory);

  const query = {
    q: "先给结论",
    tenantId: memory.tenantId,
    principalId: memory.principalId,
    sessionId: "session-1",
    taskId: "task-1",
    requestId: "request-1"
  };
  await searchContext(repository, query);
  await searchContext(repository, query);

  assert.equal(repository.retrievalEvents.filter((event) => event.eventType === "search_hit").length, 1);

  const pack = await assembleContext(repository, {
    task: "回答时先给结论",
    ...query,
    tokenBudget: 800
  });
  assert.equal(pack.recentContext.some((item) => item.id === memory.memoryDataId), true);
  assert.equal(repository.retrievalEvents.filter((event) => event.eventType === "context_pack_selected").length, 1);
});

test("context assembly can disable retrieval event writes for benchmark reads", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = makeStm("stm_benchmark", "Benchmark answer evidence.", now);
  await repository.saveShortTermMemory(memory);
  await refreshShortTermMemoryIndex(repository, memory);

  const pack = await assembleContext(repository, {
    task: "Find benchmark answer evidence",
    q: "Benchmark answer evidence",
    tenantId: memory.tenantId,
    principalId: memory.principalId,
    tokenBudget: 800,
    recordRetrieval: false
  });

  assert.equal(pack.recentContext.some((item) => item.id === memory.memoryDataId), true);
  assert.equal(repository.retrievalEvents.length, 0);
});

test("reuse signals deduplicate sessions and tasks, decay old events, and include feedback", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveMemoryRetrievalEvent(retrievalEvent("recent-a", "stm_recent", "search_hit", now, "s1", "t1"));
  await repository.saveMemoryRetrievalEvent(retrievalEvent("recent-b", "stm_recent", "context_pack_selected", "2026-07-29T12:00:00.000Z", "s1", "t1"));
  await repository.saveMemoryRetrievalEvent(retrievalEvent("recent-c", "stm_recent", "agent_cited", "2026-07-25T12:00:00.000Z", "s2", "t2"));
  await repository.saveMemoryRetrievalEvent(retrievalEvent("old-a", "stm_old", "search_hit", "2026-07-01T12:00:00.000Z", "s3", "t3"));
  await repository.saveMemoryFeedback({
    feedbackId: "feedback-positive",
    targetId: "stm_recent",
    targetType: "stm",
    action: "confirm",
    createdAt: now
  });
  await repository.saveMemoryFeedback({
    feedbackId: "feedback-negative",
    targetId: "stm_recent",
    targetType: "stm",
    action: "dislike",
    createdAt: now
  });
  await repository.saveMemoryFeedback({
    feedbackId: "feedback-correction",
    targetId: "stm_recent",
    targetType: "stm",
    action: "correct",
    createdAt: now
  });

  const recent = repository.getMemoryReuseSignals(["stm_recent"], now)[0]!;
  const old = repository.getMemoryReuseSignals(["stm_old"], now)[0]!;
  assert.equal(recent.uniqueSessionCount7d, 2);
  assert.equal(recent.uniqueSessionCount30d, 2);
  assert.equal(recent.uniqueTaskCount30d, 2);
  assert.equal(recent.searchHitCount30d, 1);
  assert.equal(recent.contextPackCount30d, 1);
  assert.equal(recent.agentCitationCount30d, 1);
  assert.equal(recent.positiveFeedbackCount30d, 1);
  assert.equal(recent.negativeFeedbackCount30d, 1);
  assert.equal(recent.correctionCount30d, 1);
  assert.equal(recent.lastRetrievedAt, now);
  assert.ok(recent.reuseValue > old.reuseValue);
});

test("SQLite persists retrieval events and aggregates them without loading the full cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-retrieval-"));
  const storePath = join(dir, "store.sqlite");
  const writer = new SqliteContextEngineRepository(storePath);
  await writer.saveMemoryRetrievalEvent(retrievalEvent("sqlite-1", "stm_sqlite", "context_pack_selected", now, "s1", "t1"));
  writer.close();

  const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
  await reader.saveMemoryRetrievalEvent({
    ...retrievalEvent("sqlite-retry", "stm_sqlite", "context_pack_selected", now, "s1", "t1"),
    requestId: "sqlite-1"
  });
  const signal = reader.getMemoryReuseSignals(["stm_sqlite"], now)[0]!;
  assert.equal(signal.contextPackCount30d, 1);
  assert.equal(signal.uniqueSessionCount30d, 1);
  assert.ok(signal.reuseValue > 0);
  reader.close();
});

test("STM scoring uses server retrieval signals instead of LLM reuse scores", () => {
  const memory = makeStm("stm_score", "用户偏好先给结论。", now);
  const score: LlmDreamingStmScore = {
    memoryDataId: memory.memoryDataId,
    semanticScores: {
      stability: 10,
      reuseValue: 10,
      identityRelationValue: 10,
      actionCommitmentValue: 10,
      informationEntropy: 10,
      explicitWeight: 10,
      preferenceConsistency: 10
    }
  };

  const withoutEvents = evaluateDreamingStms([score], [memory], { now })[0]!;
  const withEvents = evaluateDreamingStms([score], [memory], {
    now,
    reuseSignals: [{
      ownerType: "stm",
      ownerId: memory.memoryDataId,
      lastRetrievedAt: now,
      uniqueSessionCount7d: 3,
      uniqueSessionCount30d: 3,
      uniqueTaskCount30d: 2,
      searchHitCount30d: 5,
      contextPackCount30d: 3,
      agentCitationCount30d: 1,
      positiveFeedbackCount30d: 1,
      negativeFeedbackCount30d: 0,
      correctionCount30d: 0,
      reuseValue: 8
    }]
  })[0]!;

  assert.equal(withoutEvents.factorScores.reuseValue, 1.5);
  assert.equal(withEvents.factorScores.reuseValue, 8.3);
  assert.notEqual(withEvents.factorScores.reuseValue, score.semanticScores?.reuseValue);
});

function makeStm(memoryDataId: string, content: string, createdAt: string): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "tenant-1",
    principalId: "principal-1",
    createdAt,
    updatedAt: createdAt,
    memoryDataType: "preference",
    memoryType: "preference",
    content,
    sourceFactIds: [`fact_${memoryDataId}`],
    sourceRefs: [{ sourceRefId: `source_${memoryDataId}`, sourceType: "test", sourceId: memoryDataId }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
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
    lifecycleStatus: "active"
  };
}

function retrievalEvent(
  id: string,
  ownerId: string,
  eventType: "search_hit" | "context_pack_selected" | "agent_cited",
  createdAt: string,
  sessionId: string,
  taskId: string
) {
  return {
    retrievalEventId: `retrieval_${id}`,
    ownerType: "stm" as const,
    ownerId,
    requestId: id,
    sessionId,
    taskId,
    eventType,
    createdAt
  };
}
