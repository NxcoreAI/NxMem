import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FactItem, MemoryEvent, MemoryTemporalMetadata, ShortTermMemory } from "./domain.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { runLlmDreaming } from "./llm-dreaming.js";
import {
  aggregateMemoryTemporalMetadata,
  memoryMatchesTemporalRange,
  memoryTemporalEnvelopeIntersects
} from "./memory-temporal.js";
import { admitFactsToMemoryPipeline } from "./parse-event.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";

test("memory temporal aggregation keeps independent evidence and valid axes", () => {
  const aggregated = aggregateMemoryTemporalMetadata([
    {
      evidenceTimeStart: "2026-07-23T07:30:00.000Z",
      evidenceTimeEnd: "2026-07-23T07:30:00.000Z",
      evidenceTimeConfidence: "high",
      validTimeStart: "2026-08-01T00:00:00.000Z",
      validTimeEnd: "2026-08-02T00:00:00.000Z",
      validTimeConfidence: "high"
    },
    {
      evidenceTimeStart: "2026-07-24T08:00:00.000Z",
      evidenceTimeEnd: "2026-07-24T08:05:00.000Z",
      evidenceTimeConfidence: "medium",
      validTimeStart: "2026-08-10T00:00:00.000Z",
      validTimeEnd: "2026-08-11T00:00:00.000Z",
      validTimeConfidence: "low"
    }
  ]);

  assert.deepEqual(aggregated, {
    evidenceTimeStart: "2026-07-23T07:30:00.000Z",
    evidenceTimeEnd: "2026-07-24T08:05:00.000Z",
    evidenceTimeConfidence: "medium",
    validTimeStart: "2026-08-01T00:00:00.000Z",
    validTimeEnd: "2026-08-11T00:00:00.000Z",
    validTimeConfidence: "low"
  });
});

test("non-contiguous structured facts use the envelope only for prefiltering", () => {
  const memory = createShortTermMemory({
    memoryDataId: "stm_non_contiguous",
    validTimeStart: "2026-08-01T00:00:00.000Z",
    validTimeEnd: "2026-08-11T00:00:00.000Z",
    validTimeConfidence: "high",
    structuredFacts: {
      schemaVersion: "memory-structured-facts.v1",
      memoryKind: "short_term",
      facts: [
        {
          factId: "fact_aug_1",
          claim: "8 月 1 日去深圳",
          explanation: "第一段有效时间。",
          validTimeStart: "2026-08-01T00:00:00.000Z",
          validTimeEnd: "2026-08-02T00:00:00.000Z",
          validTimeConfidence: "high"
        },
        {
          factId: "fact_aug_10",
          claim: "8 月 10 日回上海",
          explanation: "第二段有效时间。",
          validTimeStart: "2026-08-10T00:00:00.000Z",
          validTimeEnd: "2026-08-11T00:00:00.000Z",
          validTimeConfidence: "high"
        }
      ]
    }
  });
  const gap = {
    startTime: "2026-08-05T00:00:00.000Z",
    endTime: "2026-08-06T00:00:00.000Z",
    basis: "valid" as const
  };

  assert.equal(memoryTemporalEnvelopeIntersects(memory, gap), true);
  assert.equal(memoryMatchesTemporalRange(memory, gap), false);
  assert.equal(memoryMatchesTemporalRange(memory, {
    startTime: "2026-08-10T00:00:00.000Z",
    endTime: "2026-08-11T00:00:00.000Z",
    basis: "valid"
  }), true);
});

test("Fact to STM to LTM preserves temporal metadata across rebuild, reindex, and SQLite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-memory-temporal-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const event = createMemoryEvent();
    const fact = createFact();
    await writer.saveMemoryEvent(event);
    await writer.saveFactItem(fact);
    await admitFactsToMemoryPipeline(writer, event, [fact], {
      disableStmAdmissionLlm: true,
      fallbackSourceRefs: fact.linkedSourceRefs
    });

    const stm = writer.getDebugSnapshot().shortTermMemories.find((item) =>
      item.sourceFactIds.includes(fact.factId)
    );
    assert.ok(stm);
    assertTemporalInvariant(stm);
    assertTemporalInvariant(stm.structuredFacts?.facts[0]);

    await writer.replaceShortTermMemory({
      ...stm,
      evidenceTimeStart: "2099-01-01T00:00:00.000Z",
      evidenceTimeEnd: "2099-01-01T00:00:00.000Z",
      validTimeStart: "2099-02-01T00:00:00.000Z",
      validTimeEnd: "2099-02-02T00:00:00.000Z"
    });
    assertTemporalInvariant(writer.getShortTermMemory(stm.memoryDataId));

    const stmReader = new SqliteContextEngineRepository(storePath);
    assertTemporalInvariant(stmReader.getShortTermMemory(stm.memoryDataId));
    stmReader.close();

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            scores: [{
              memoryDataId: stm.memoryDataId,
              scores: {
                stability: 10,
                reuseValue: 0,
                identityRelationValue: 10,
                actionCommitmentValue: 10,
                informationEntropy: 10,
                explicitWeight: 10,
                preferenceConsistency: 10
              },
              scoreReasons: {
                stability: "evidence=test; rationale=test",
                reuseValue: "evidence=server_owned; rationale=placeholder_only",
                identityRelationValue: "evidence=test; rationale=test",
                actionCommitmentValue: "evidence=test; rationale=test",
                informationEntropy: "evidence=test; rationale=test",
                explicitWeight: "evidence=test; rationale=test",
                preferenceConsistency: "evidence=test; rationale=test"
              }
            }]
          }) } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = JSON.parse(body.messages[1]!.content) as { memories: Array<{ memoryId: string }> };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          classifications: prompt.memories.map((memory) => ({ memoryId: memory.memoryId, memoryType: "task" }))
        }) } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    let dreaming: Awaited<ReturnType<typeof runLlmDreaming>>;
    try {
      dreaming = await runLlmDreaming(writer, {
        embeddingClient: createDeterministicTestEmbeddingClient(512),
        apiKey: "test-key",
        baseUrl: "https://llm.example/v1",
        model: "test-model",
        memoryDataIds: [stm.memoryDataId],
        now: "2026-09-01T00:00:00.000Z"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const ltm = dreaming.longTermMemories[0];
    assert.ok(ltm, JSON.stringify({
      fallbackReason: dreaming.fallbackReason,
      candidateGate: dreaming.candidateGate,
      evaluations: dreaming.stmEvaluations,
      rejectedCandidates: dreaming.trace.rejectedCandidates
    }));
    assertTemporalInvariant(ltm);
    assertTemporalInvariant(ltm.structuredFacts?.facts[0]);

    await writer.replaceLongTermMemory({
      ...ltm,
      solidifyReason: "rebuild_temporal_invariance"
    });
    const rebuilt = writer.getLongTermMemory(ltm.memoryId);
    assertTemporalInvariant(rebuilt);
    await refreshLongTermMemoryIndex(writer, rebuilt!);
    const graphNode = writer.getGraphMemoryNode("ltm", ltm.memoryId);
    assertTemporalInvariant(graphNode);
    assert.notEqual(graphNode?.refreshedAt, graphNode?.evidenceTimeStart);
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath);
    assertTemporalInvariant(reader.getLongTermMemory(ltm.memoryId));
    assertTemporalInvariant(reader.getGraphMemoryNode("ltm", ltm.memoryId));
    reader.close();

    const db = new DatabaseSync(storePath);
    const stmIndexes = indexNames(db, "short_term_memories");
    const ltmIndexes = indexNames(db, "long_term_memories");
    const graphIndexes = indexNames(db, "graph_memory_nodes");
    assert.equal(stmIndexes.has("idx_stm_owner_evidence_time"), true);
    assert.equal(stmIndexes.has("idx_stm_owner_valid_time"), true);
    assert.equal(ltmIndexes.has("idx_ltm_evidence_time"), true);
    assert.equal(ltmIndexes.has("idx_ltm_valid_time"), true);
    assert.equal(graphIndexes.has("idx_graph_memory_nodes_evidence_time"), true);
    assert.equal(graphIndexes.has("idx_graph_memory_nodes_valid_time"), true);
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("graph search can prefilter candidates by temporal envelope", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = createShortTermMemory({
    memoryDataId: "stm_temporal_prefilter",
    content: "深圳行程记忆",
    evidenceTimeStart: "2026-07-23T07:30:00.000Z",
    evidenceTimeEnd: "2026-07-23T07:30:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-08-01T00:00:00.000Z",
    validTimeEnd: "2026-08-02T00:00:00.000Z",
    validTimeConfidence: "high"
  });
  await repository.saveShortTermMemory(memory);
  await refreshShortTermMemoryIndex(repository, memory);

  const evidenceHits = await repository.searchGraphText(["深圳"], {
    temporalRange: {
      startTime: "2026-07-23T00:00:00.000Z",
      endTime: "2026-07-24T00:00:00.000Z",
      basis: "evidence"
    }
  });
  const outsideValidHits = await repository.searchGraphText(["深圳"], {
    temporalRange: {
      startTime: "2026-08-05T00:00:00.000Z",
      endTime: "2026-08-06T00:00:00.000Z",
      basis: "valid"
    }
  });

  assert.deepEqual(evidenceHits.map((hit) => hit.ownerId), ["stm_temporal_prefilter"]);
  assert.deepEqual(outsideValidHits, []);
});

function createFact(): FactItem {
  return {
    factId: "fact_trip_to_shenzhen",
    factType: "prospective_event",
    factText: "我 8 月 1 日去深圳",
    normalizedClaim: "用户计划在 8 月 1 日去深圳",
    linkedEventIds: ["event_trip_to_shenzhen"],
    linkedSegmentIds: ["segment_trip_to_shenzhen"],
    linkedSourceRefs: [{
      sourceRefId: "conversation_message_trip_to_shenzhen",
      sourceType: "conversation_message",
      sourceId: "conversation_message_trip_to_shenzhen"
    }],
    entityIds: ["city_shenzhen"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-07-25T00:00:00.000Z",
    evidenceTimeStart: "2026-07-23T07:30:00.000Z",
    evidenceTimeEnd: "2026-07-23T07:30:00.000Z",
    evidenceTimeConfidence: "high",
    sourceMessageIds: ["msg_trip_to_shenzhen"],
    validTimeStart: "2026-08-01T00:00:00.000Z",
    validTimeEnd: "2026-08-02T00:00:00.000Z",
    validTimeBasis: "absolute",
    validTimeConfidence: "high",
    timeBasis: "absolute",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  };
}

function createMemoryEvent(): MemoryEvent {
  return {
    eventId: "event_trip_to_shenzhen",
    eventType: "agent_context_memory_event",
    eventSummary: "用户计划去深圳",
    eventTime: "2026-07-23T07:30:00.000Z",
    sourceApp: "agent",
    sourceId: "session_trip_to_shenzhen",
    permissionSnapshot: {
      snapshotId: "permission_trip_to_shenzhen",
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item_trip_to_shenzhen",
      type: "text",
      format: "plain",
      content: "我 8 月 1 日去深圳",
      timeBasis: "source_time",
      timeConfidence: "high"
    }]
  };
}

function createShortTermMemory(
  overrides: Partial<ShortTermMemory> & Pick<ShortTermMemory, "memoryDataId">
): ShortTermMemory {
  const { memoryDataId, ...rest } = overrides;
  return {
    memoryDataId,
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    memoryDataType: "event",
    content: "时间测试记忆",
    sourceFactIds: [],
    sourceRefs: [],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "temporal_test",
    matchedRules: ["temporal_test"],
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
    ...rest
  };
}

function assertTemporalInvariant(value: MemoryTemporalMetadata | undefined) {
  assert.ok(value);
  const temporal = value as {
    evidenceTimeStart?: string;
    evidenceTimeEnd?: string;
    evidenceTimeConfidence?: string;
    validTimeStart?: string;
    validTimeEnd?: string;
    validTimeConfidence?: string;
  };
  assert.equal(temporal.evidenceTimeStart, "2026-07-23T07:30:00.000Z");
  assert.equal(temporal.evidenceTimeEnd, "2026-07-23T07:30:00.000Z");
  assert.equal(temporal.evidenceTimeConfidence, "high");
  assert.equal(temporal.validTimeStart, "2026-08-01T00:00:00.000Z");
  assert.equal(temporal.validTimeEnd, "2026-08-02T00:00:00.000Z");
  assert.equal(temporal.validTimeConfidence, "high");
}

function indexNames(db: DatabaseSync, table: string) {
  return new Set((db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}
