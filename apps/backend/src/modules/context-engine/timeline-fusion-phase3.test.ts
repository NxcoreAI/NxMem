import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleContext } from "./assemble-context.js";
import type {
  FactItem,
  LongTermMemory,
  MemoryEvent,
  ShortTermMemory,
  SourceRef,
  TimelineFusionTask
} from "./domain.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { createFactBatchCommitted } from "./fact-batch.js";
import { refreshLongTermMemoryIndex } from "./indexing.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";
import { searchContext } from "./search-context.js";
import { processTimelineFusionTask } from "./timeline-fusion-processor.js";
import type { TimelineFusionRelationJudgmentResult } from "./timeline-fusion-relation-judgment.js";
import { createTimelineFusionTask } from "./timeline-fusion-task.js";

const NOW = "2026-08-07T08:30:00.000Z";
const embeddingClient = createDeterministicTestEmbeddingClient(64);

test("lossless current fact replaces redundant atomic STM without deleting source facts", async () => {
  const repository = new CountingFactVersionRepository();
  const history = fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z");
  const incoming = fact("fact_new", "Atlas review covers power and cost", "2026-08-07T08:20:00.000Z");
  await seedAtomicDownstream(repository, [history, incoming]);
  await repository.saveLongTermMemory(longTermMemory(incoming));
  const task = await readyTask(repository, incoming.factId);

  await processTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1000,
    now: () => NOW,
    judgeRelations: async () => supplementJudgment(),
    downstream: { disableStmAdmissionLlm: true, embeddingClient }
  });

  const snapshot = repository.getDebugSnapshot();
  assert.equal(snapshot.shortTermMemories.some((memory) => memory.memoryDataId === "stm_fact_new"), false);
  const currentMemory = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === "stm_fact_history");
  assert.equal(currentMemory?.content, "atlas review is friday and covers power and cost");
  assert.deepEqual(currentMemory?.sourceFactIds, ["fact_history"]);
  assert.equal(snapshot.facts.some((item) => item.factId === "fact_new"), true);
  assert.equal(snapshot.longTermMemories.find((memory) => memory.memoryId === "ltm_fact_new")?.lifecycleStatus, "archived");
  assert.equal(snapshot.indexEntries.some((entry) => entry.ownerId === "ltm_fact_new"), false);

  const versions = await repository.getFactVersions({
    tenantId: "tenant_1",
    principalId: "principal_1",
    factId: "fact_history"
  });
  assert.deepEqual(versions.at(-1)?.sourceFactIds, ["fact_history", "fact_new"]);
  repository.resetFactVersionReadCounts();
  const search = await searchContext(repository, {
    q: "Atlas review",
    tenantId: "tenant_1",
    principalId: "principal_1"
  }, {
    embeddingClient,
    recordRetrieval: false,
    recordShadow: false
  });
  const factContext = search.results.find((result) =>
    result.factIds.includes("fact_history")
  )?.factContext;
  assert.equal(factContext?.currentFacts[0]?.factText, "Atlas review is Friday and covers power and cost.");
  assert.equal(factContext?.sourceFacts.some((fact) => fact.factText === "Atlas review is Friday"), true);
  assert.equal(factContext?.sourceFacts.some((fact) => fact.factText === "Atlas review covers power and cost"), true);
  assert.equal(repository.factVersionReads, 0);
  assert.equal(repository.factVersionBatchReads, 2);
});

test("fallback relation output keeps every atomic STM unchanged", async () => {
  const repository = new InMemoryContextEngineRepository();
  const history = fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z");
  const incoming = fact("fact_new", "Atlas review covers power and cost", "2026-08-07T08:20:00.000Z");
  await seedAtomicDownstream(repository, [history, incoming]);
  const task = await readyTask(repository, incoming.factId);

  await processTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1000,
    now: () => NOW,
    judgeRelations: async () => ({
      status: "fallback",
      responseFormat: "fallback",
      fallbackReason: "protected_details_lost",
      result: {
        schemaVersion: "timeline-fusion-relations.v1",
        relations: [],
        unusedFactIds: ["fact_history", "fact_new"]
      }
    }),
    downstream: { disableStmAdmissionLlm: true, embeddingClient }
  });

  const snapshot = repository.getDebugSnapshot();
  assert.equal(snapshot.shortTermMemories.some((memory) => memory.memoryDataId === "stm_fact_history"), true);
  assert.equal(snapshot.shortTermMemories.some((memory) => memory.memoryDataId === "stm_fact_new"), true);
  assert.equal(snapshot.facts.find((item) => item.factId === "fact_history")?.factText, history.factText);
  assert.equal(snapshot.facts.find((item) => item.factId === "fact_new")?.factText, incoming.factText);
});

test("support classification cannot suppress an atomic STM when the current text loses a protected detail", async () => {
  const repository = new InMemoryContextEngineRepository();
  const history = fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z");
  const incoming = fact("fact_cost", "Atlas review costs 45 dollars", "2026-08-07T08:20:00.000Z");
  await seedAtomicDownstream(repository, [history, incoming]);
  const task = await readyTask(repository, incoming.factId);

  await processTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1000,
    now: () => NOW,
    judgeRelations: async () => ({
      status: "succeeded",
      responseFormat: "relations",
      result: {
        schemaVersion: "timeline-fusion-relations.v1",
        relations: [{
          type: "supports",
          sourceFactIds: ["fact_cost", "fact_history"],
          confidenceLevel: "high",
          reasonCode: "incorrect_support_with_new_detail"
        }],
        unusedFactIds: []
      }
    }),
    downstream: { disableStmAdmissionLlm: true, embeddingClient }
  });

  const snapshot = repository.getDebugSnapshot();
  assert.equal(snapshot.shortTermMemories.some((memory) => memory.memoryDataId === "stm_fact_cost"), true);
  assert.equal(snapshot.facts.some((item) => item.factId === "fact_cost" && item.factText.includes("45")), true);
});

test("conflicting current facts and both source chains survive search and Context Pack", async () => {
  const repository = new InMemoryContextEngineRepository();
  const history = fact("fact_friday", "Atlas review is Friday", "2026-08-07T08:00:00.000Z");
  const incoming = fact("fact_monday", "Atlas review is Monday", "2026-08-07T08:20:00.000Z");
  await seedAtomicDownstream(repository, [history, incoming]);
  const task = await readyTask(repository, incoming.factId);

  await processTimelineFusionTask(repository, task, {
    windowMs: 60 * 60 * 1000,
    now: () => NOW,
    judgeRelations: async () => conflictJudgment(),
    downstream: { disableStmAdmissionLlm: true, embeddingClient }
  });

  const pack = await assembleContext(repository, {
    task: "Atlas review schedule",
    q: "Atlas review",
    tenantId: "tenant_1",
    principalId: "principal_1",
    tokenBudget: 1200,
    recordRetrieval: false
  });
  const selected = [...pack.profileContext, ...pack.taskContext, ...pack.recentContext, ...pack.constraints];
  const friday = selected.find((item) => item.factIds.includes("fact_friday"));
  const monday = selected.find((item) => item.factIds.includes("fact_monday"));
  assert.ok(friday);
  assert.ok(monday);
  assert.equal(friday.factContext?.currentFacts[0]?.factVersionId?.startsWith("fact_version_"), true);
  assert.deepEqual(friday.factContext?.conflicts[0]?.conflictingFactIds, ["fact_monday"]);
  assert.equal(friday.factContext?.sourceFacts.some((fact) => fact.factId === "fact_monday"), true);
  assert.equal(pack.conflicts.some((conflict) =>
    conflict.kind === "fact" &&
    conflict.factIds.includes("fact_friday") &&
    conflict.factIds.includes("fact_monday") &&
    conflict.sourceRefs.length === 2
  ), true);
  assert.match(pack.serializedPrompt, /Atlas review is Friday/);
  assert.match(pack.serializedPrompt, /Atlas review is Monday/);
  assert.match(pack.serializedPrompt, /conversation_message:message_fact_friday/);
  assert.match(pack.serializedPrompt, /conversation_message:message_fact_monday/);
});

test("LTM rebuild, index refresh, and SQLite restart do not rewrite Fact Store time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeline-fusion-phase3-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const item = fact("fact_temporal", "Atlas review is Friday", "2026-08-07T08:00:00.000Z");
    item.validTimeStart = "2026-08-08T01:00:00.000Z";
    item.validTimeEnd = "2026-08-08T02:00:00.000Z";
    item.validTimeBasis = "absolute";
    item.validTimeConfidence = "high";
    await seedAtomicDownstream(writer, [item]);
    const beforeFact = structuredClone((await writer.getFactItemsByIds([item.factId]))[0]!);

    const ltm = longTermMemory(item);
    await writer.saveLongTermMemory(ltm);
    await refreshLongTermMemoryIndex(writer, ltm, embeddingClient);
    await writer.replaceLongTermMemory({
      ...ltm,
      lastMaintainedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    });
    await refreshLongTermMemoryIndex(writer, (await writer.getLongTermMemory(ltm.memoryId))!, embeddingClient);
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    const afterFact = (await reader.getFactItemsByIds([item.factId]))[0]!;
    assert.deepEqual({
      evidenceTimeStart: afterFact.evidenceTimeStart,
      evidenceTimeEnd: afterFact.evidenceTimeEnd,
      validTimeStart: afterFact.validTimeStart,
      validTimeEnd: afterFact.validTimeEnd,
      observedAt: afterFact.observedAt
    }, {
      evidenceTimeStart: beforeFact.evidenceTimeStart,
      evidenceTimeEnd: beforeFact.evidenceTimeEnd,
      validTimeStart: beforeFact.validTimeStart,
      validTimeEnd: beforeFact.validTimeEnd,
      observedAt: beforeFact.observedAt
    });
    const restoredLtm = await reader.getLongTermMemory(ltm.memoryId);
    assert.equal(restoredLtm?.evidenceTimeStart, item.evidenceTimeStart);
    assert.equal(restoredLtm?.validTimeStart, item.validTimeStart);
    reader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class CountingFactVersionRepository extends InMemoryContextEngineRepository {
  factVersionReads = 0;
  factVersionBatchReads = 0;

  override getFactVersions(query: Parameters<InMemoryContextEngineRepository["getFactVersions"]>[0]) {
    this.factVersionReads += 1;
    return super.getFactVersions(query);
  }

  override getFactVersionsByFactIds(
    query: Parameters<InMemoryContextEngineRepository["getFactVersionsByFactIds"]>[0]
  ) {
    this.factVersionBatchReads += 1;
    return super.getFactVersionsByFactIds(query);
  }

  resetFactVersionReadCounts() {
    this.factVersionReads = 0;
    this.factVersionBatchReads = 0;
  }
}

async function seedAtomicDownstream(
  repository: InMemoryContextEngineRepository,
  facts: FactItem[]
) {
  for (const item of facts) {
    await repository.saveMemoryEvent(event(item));
    await repository.saveFactItem(item);
    await repository.saveShortTermMemory(shortTermMemory(item));
  }
}

async function readyTask(repository: InMemoryContextEngineRepository, newFactId: string) {
  const batch = await repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "event",
    sourceKey: `phase3_${newFactId}`,
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds: [newFactId],
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

function conflictJudgment(): TimelineFusionRelationJudgmentResult {
  return {
    status: "succeeded",
    responseFormat: "relations",
    result: {
      schemaVersion: "timeline-fusion-relations.v1",
      relations: [{
        type: "conflicts",
        sourceFactIds: ["fact_monday", "fact_friday"],
        confidenceLevel: "high",
        reasonCode: "incompatible_schedule"
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
    linkedSourceRefs: [sourceRef(factId)],
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
    schemaVersion: "timeline-fusion-phase3-test.v1"
  };
}

function sourceRef(factId: string): SourceRef {
  return {
    sourceRefId: `source_${factId}`,
    sourceType: "conversation_message",
    sourceId: `message_${factId}`,
    metadata: { messageId: `message_${factId}` }
  };
}

function event(item: FactItem): MemoryEvent {
  return {
    eventId: item.linkedEventIds[0]!,
    eventType: "conversation",
    eventSummary: item.factText,
    eventTime: item.evidenceTimeStart!,
    sourceApp: "agent",
    permissionSnapshot: {
      snapshotId: `permission_${item.factId}`,
      tenantId: "tenant_1",
      principalId: "principal_1",
      sourceAclVersion: "1",
      visibility: "private"
    },
    multimodalData: [],
    sourceRefs: item.linkedSourceRefs
  };
}

function shortTermMemory(item: FactItem): ShortTermMemory {
  return {
    memoryDataId: `stm_${item.factId}`,
    tenantId: "tenant_1",
    principalId: "principal_1",
    createdAt: item.observedAt,
    updatedAt: item.observedAt,
    memoryDataType: item.factType,
    memoryType: "fact",
    content: item.normalizedClaim,
    structuredFacts: {
      schemaVersion: "memory-structured-facts.v1",
      memoryKind: "short_term",
      facts: [{
        factId: item.factId,
        claim: item.normalizedClaim,
        explanation: item.factText,
        factType: item.factType,
        confidenceLevel: item.confidenceLevel,
        ...(item.evidenceTimeStart ? { evidenceTimeStart: item.evidenceTimeStart } : {}),
        ...(item.evidenceTimeEnd ? { evidenceTimeEnd: item.evidenceTimeEnd } : {}),
        ...(item.evidenceTimeConfidence ? { evidenceTimeConfidence: item.evidenceTimeConfidence } : {}),
        sourceRefIds: item.linkedSourceRefs.map((ref) => ref.sourceRefId)
      }]
    },
    sourceFactIds: [item.factId],
    sourceRefs: item.linkedSourceRefs,
    entityIds: item.entityIds,
    importanceLevel: "medium",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "test_atomic_safety_net",
    matchedRules: ["fact_level_stm"],
    admissionSignals: {
      importance: "medium",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "medium",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible"
  };
}

function longTermMemory(item: FactItem): LongTermMemory {
  return {
    memoryId: `ltm_${item.factId}`,
    tenantId: "tenant_1",
    principalId: "principal_1",
    theoryClass: "episodic",
    memoryType: "event",
    content: item.factText,
    sourceRefs: item.linkedSourceRefs,
    sourceMemoryDataIds: [`stm_${item.factId}`],
    sourceFactIds: [item.factId],
    entityIds: item.entityIds,
    confidenceLevel: "high",
    recallWeight: "medium",
    solidifyReason: "test",
    matchedRules: ["test"],
    lifecycleStatus: "active"
  };
}
