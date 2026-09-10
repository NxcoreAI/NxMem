import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactItem, MemoryEvent, ShortTermMemory } from "./domain.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";

const timestamp = "2026-08-18T00:00:00.000Z";

test("sample-scoped cache eviction preserves concurrent samples and persisted rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-scope-cache-"));
  const storePath = join(directory, "context.sqlite");
  const repository = new SqliteContextEngineRepository(storePath);

  try {
    for (const scope of ["scope_a", "scope_b"]) {
      const event = createEvent(scope);
      const fact = createFact(scope, event.eventId);
      const memory = createShortTermMemory(scope, fact.factId);
      await repository.saveMemoryEvent(event);
      await repository.saveFactItem(fact);
      await repository.saveShortTermMemory(memory);
      await repository.saveIndexEntry({
        indexId: `index_${scope}`,
        ownerId: memory.memoryDataId,
        ownerType: "stm",
        content: memory.content,
        lifecycleStatus: "active",
        refreshedAt: timestamp,
        tokenCount: 1,
      });
      await repository.saveTextIndexEntry({
        indexId: `text_index_${scope}`,
        ownerId: memory.memoryDataId,
        ownerType: "stm",
        term: scope,
        documentFrequency: 1,
        termFrequency: 1,
        documentLength: 1,
        lifecycleStatus: "active",
        refreshedAt: timestamp,
      });
      await repository.saveVectorIndexEntry({
        indexId: `vector_index_${scope}`,
        ownerId: memory.memoryDataId,
        ownerType: "stm",
        content: memory.content,
        vector: [1],
        lifecycleStatus: "active",
        refreshedAt: timestamp,
      });
    }

    repository.evictLoadedCacheByContextScopeId("scope_a");

    const snapshot = repository.getDebugSnapshot();
    assert.deepEqual(
      snapshot.memoryEvents.map((event) => event.eventId),
      ["event_scope_b"],
    );
    assert.deepEqual(
      snapshot.facts.map((fact) => fact.factId),
      ["fact_scope_b"],
    );
    assert.deepEqual(
      snapshot.shortTermMemories.map((memory) => memory.memoryDataId),
      ["stm_scope_b"],
    );
    assert.deepEqual(
      snapshot.indexEntries.map((entry) => entry.ownerId),
      ["stm_scope_b"],
    );
    assert.deepEqual(
      snapshot.textIndexEntries.map((entry) => entry.ownerId),
      ["stm_scope_b"],
    );
    assert.deepEqual(
      snapshot.vectorIndexEntries.map((entry) => entry.ownerId),
      ["stm_scope_b"],
    );
  } finally {
    repository.close();
  }

  const reopened = new SqliteContextEngineRepository(storePath);
  try {
    const snapshot = reopened.getDebugSnapshot();
    assert.deepEqual(
      snapshot.memoryEvents.map((event) => event.eventId).sort(),
      ["event_scope_a", "event_scope_b"],
    );
    assert.deepEqual(snapshot.facts.map((fact) => fact.factId).sort(), [
      "fact_scope_a",
      "fact_scope_b",
    ]);
    assert.deepEqual(
      snapshot.shortTermMemories.map((memory) => memory.memoryDataId).sort(),
      ["stm_scope_a", "stm_scope_b"],
    );
  } finally {
    reopened.close();
  }
});

function createEvent(contextScopeId: string): MemoryEvent {
  return {
    eventId: `event_${contextScopeId}`,
    contextScopeId,
    eventType: "conversation_session",
    eventTime: timestamp,
    permissionSnapshot: {
      snapshotId: `permission_${contextScopeId}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "1",
      visibility: "private",
    },
    multimodalData: [],
  };
}

function createFact(contextScopeId: string, eventId: string): FactItem {
  return {
    factId: `fact_${contextScopeId}`,
    tenantId: "tenant",
    principalId: "principal",
    contextScopeId,
    factType: "event",
    factText: contextScopeId,
    normalizedClaim: contextScopeId,
    linkedEventIds: [eventId],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: timestamp,
    timeBasis: "absolute",
    timeConfidence: "high",
    schemaVersion: "1",
  };
}

function createShortTermMemory(
  contextScopeId: string,
  factId: string,
): ShortTermMemory {
  return {
    memoryDataId: `stm_${contextScopeId}`,
    tenantId: "tenant",
    principalId: "principal",
    createdAt: timestamp,
    updatedAt: timestamp,
    memoryDataType: "fact",
    content: contextScopeId,
    sourceFactIds: [factId],
    sourceRefs: [],
    entityIds: [],
    importanceLevel: "medium",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: [],
    admissionSignals: {
      importance: "medium",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "medium",
      conflict: "none",
      permission: "private",
    },
    lifecycleStatus: "active",
  };
}
