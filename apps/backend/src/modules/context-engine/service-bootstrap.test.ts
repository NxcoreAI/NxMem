import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { sanitizeDebugSnapshot } from "./debug-snapshot.js";
import { sourceRefsFromEvent } from "./memory-event-fields.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { reconcileGeneratedShortTermMemoryIndexes } from "./service-bootstrap.js";

const testStmScope = {
  tenantId: "local",
  principalId: "debug-user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

test("startup normalizes legacy hidden STM and backfills recall indexes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-stm-index-reconcile-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const writer = new SqliteContextEngineRepository(storePath);
    await writer.saveShortTermMemory({
      memoryDataId: "stm_legacy_hidden_candidate",
      ...testStmScope,
      memoryDataType: "project_fact",
      memoryType: "task",
      content: "用户请求关注郑州到深圳超低价机票",
      sourceFactIds: ["fact_legacy_hidden_candidate"],
      sourceRefs: [{ sourceRefId: "src_legacy_hidden_candidate", sourceType: "agent_memory", sourceId: "flight-session" }],
      entityIds: [],
      importanceLevel: "medium",
      confidenceLevel: "high",
      admissionResult: "write_candidate",
      admissionReason: "test",
      matchedRules: ["action_item"],
      admissionSignals: {
        importance: "medium",
        confidence: "high",
        freshness: "fresh",
        sensitivity: "low",
        actorWeight: "medium",
        conflict: "none",
        permission: "private"
      },
      lifecycleStatus: "consolidated",
      accessState: "hidden"
    });
    writer.close();

    const repository = new SqliteContextEngineRepository(storePath);
    assert.equal(repository.getDebugSnapshot().shortTermMemories[0]?.accessState, "visible");
    assert.equal(repository.getDebugSnapshot().indexEntries.length, 0);

    await reconcileGeneratedShortTermMemoryIndexes(repository);
    const snapshot = repository.getDebugSnapshot();
    assert.equal(snapshot.indexEntries.some((entry) => entry.ownerId === "stm_legacy_hidden_candidate"), true);
    assert.equal(snapshot.textIndexEntries.some((entry) => entry.ownerId === "stm_legacy_hidden_candidate"), true);
    assert.equal(snapshot.vectorIndexEntries.some((entry) => entry.ownerId === "stm_legacy_hidden_candidate"), true);
    assert.equal(snapshot.graphMemoryNodes.some((node) => node.ownerId === "stm_legacy_hidden_candidate"), true);
    repository.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository rehydrates event child data for debug snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-snapshot-"));
  const storePath = join(directory, "context-engine-store.json");
  const eventId = `sqlite_snapshot_${Date.now()}`;

  try {
    const firstRepository = new SqliteContextEngineRepository(storePath);
    await firstRepository.saveMemoryEvent({
      eventId,
      eventType: "manual_memory_event",
      eventDescription: "Contact alice@example.com",
      eventTime: new Date().toISOString(),
      sourceApp: "test",
      sourceId: "sqlite-snapshot",
      permissionSnapshot: {
        snapshotId: `ps_${eventId}`,
        tenantId: "local",
        principalId: "debug-user",
        sourceAclVersion: "v1",
        visibility: "private"
      },
      multimodalData: [
        {
          itemId: `item_${eventId}`,
          type: "text",
          format: "plain",
          content: "Use token secret for alice@example.com",
          ref: "call +1 555 010 1234"
        }
      ],
      sourceRefs: [
        {
          sourceRefId: `src_${eventId}`,
          sourceType: "file",
          sourceId: "alice@example.com",
          sourceUrl: "https://example.com/token"
        }
      ]
    });

    const secondRepository = new SqliteContextEngineRepository(storePath);
    const snapshot = sanitizeDebugSnapshot(secondRepository.getDebugSnapshot());
    const event = snapshot.memoryEvents.find((item) => item.eventId === eventId);

    assert.ok(event);
    assert.deepEqual(event.multimodalData.map((item) => item.itemId), [`item_${eventId}`]);
    const sourceRefs = sourceRefsFromEvent(event);
    assert.deepEqual(sourceRefs.map((item) => item.sourceRefId), [`src_${eventId}`]);
    assert.equal(event.multimodalData[0]?.content, "Use token secret for alice@example.com");
    assert.equal(sourceRefs[0]?.sourceId, "alice@example.com");
    assert.equal("permissionSnapshot.tenantId" in (event as unknown as Record<string, unknown>), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository normalizes multimodal item source refs into event source refs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-source-ref-normalize-"));
  const storePath = join(directory, "context-engine-store.json");
  const eventId = `sqlite_source_ref_normalize_${Date.now()}`;
  const source = {
    sourceRefId: `src_${eventId}`,
    sourceType: "file",
    sourceId: "manual"
  };

  try {
    const firstRepository = new SqliteContextEngineRepository(storePath);
    await firstRepository.saveMemoryEvent({
      eventId,
      eventType: "manual_memory_event",
      eventTime: new Date().toISOString(),
      sourceApp: "test",
      sourceId: "manual",
      permissionSnapshot: {
        snapshotId: `ps_${eventId}`,
        tenantId: "local",
        principalId: "debug-user",
        sourceAclVersion: "v1",
        visibility: "private"
      },
      multimodalData: [
        {
          itemId: `item_${eventId}`,
          type: "text",
          format: "json",
          content: { text: "" },
          ref: "manual",
          sourceRefs: [source],
          timeBasis: "source_time",
          timeConfidence: "high"
        }
      ]
    });

    const secondRepository = new SqliteContextEngineRepository(storePath);
    const event = secondRepository.getDebugSnapshot().memoryEvents.find((item) => item.eventId === eventId);

    assert.ok(event);
    assert.deepEqual(sourceRefsFromEvent(event).map(({ sourceRefId, sourceType, sourceId }) => ({ sourceRefId, sourceType, sourceId })), [source]);
    assert.deepEqual(event.multimodalData[0]?.sourceRefs, [source]);
    assert.equal("sourceRef" in (event.multimodalData[0] as unknown as Record<string, unknown>), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository clearAllContextData removes persisted rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-clear-"));
  const storePath = join(directory, "context-engine-store.json");
  const eventId = `sqlite_clear_${Date.now()}`;

  try {
    const repository = new SqliteContextEngineRepository(storePath);
    await repository.saveMemoryEvent({
      eventId,
      eventType: "manual_memory_event",
      eventTime: new Date().toISOString(),
      sourceApp: "test",
      sourceId: "sqlite-clear",
      permissionSnapshot: {
        snapshotId: `ps_${eventId}`,
        tenantId: "local",
        principalId: "debug-user",
        sourceAclVersion: "v1",
        visibility: "private"
      },
      multimodalData: [
        {
          itemId: `item_${eventId}`,
          type: "text",
          format: "plain",
          content: "clear sqlite persisted rows",
          ref: "sqlite-clear"
        }
      ],
      sourceRefs: [
        {
          sourceRefId: `src_${eventId}`,
          sourceType: "file",
          sourceId: "sqlite-clear"
        }
      ]
    });

    const result = await repository.clearAllContextData();
    assert.equal(result.deleted.memoryEvents, 1);

    const reloaded = new SqliteContextEngineRepository(storePath);
    const snapshot = reloaded.getDebugSnapshot();
    assert.equal(snapshot.memoryEvents.length, 0);
    assert.equal(snapshot.textIndexEntries.length, 0);
    assert.equal(snapshot.vectorIndexEntries.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository updates multimodal rows when item ids are reused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-reused-item-"));
  const storePath = join(directory, "context-engine-store.json");
  const itemId = "item_reused";

  try {
    const repository = new SqliteContextEngineRepository(storePath);
    await repository.saveMemoryEvent({
      eventId: "event_a",
      eventType: "manual_memory_event",
      eventTime: new Date().toISOString(),
      permissionSnapshot: {
        snapshotId: "ps_a",
        tenantId: "local",
        principalId: "debug-user",
        sourceAclVersion: "v1",
        visibility: "private"
      },
      multimodalData: [
        {
          itemId,
          type: "text",
          format: "plain",
          content: "first",
          ref: "ref-a"
        }
      ],
      sourceRefs: [
        {
          sourceRefId: "src_a",
          sourceType: "file",
          sourceId: "a"
        }
      ]
    });

    await repository.saveMemoryEvent({
      eventId: "event_b",
      eventType: "manual_memory_event",
      eventTime: new Date().toISOString(),
      permissionSnapshot: {
        snapshotId: "ps_b",
        tenantId: "local",
        principalId: "debug-user",
        sourceAclVersion: "v1",
        visibility: "private"
      },
      multimodalData: [
        {
          itemId,
          type: "text",
          format: "plain",
          content: "second",
          ref: "ref-b"
        }
      ],
      sourceRefs: [
        {
          sourceRefId: "src_b",
          sourceType: "file",
          sourceId: "b"
        }
      ]
    });

    const sqlitePath = storePath.replace(/\.json$/u, ".sqlite");
    const snapshot = new SqliteContextEngineRepository(storePath).getDebugSnapshot();
    const firstEvent = snapshot.memoryEvents.find((event) => event.eventId === "event_a");
    const secondEvent = snapshot.memoryEvents.find((event) => event.eventId === "event_b");

    assert.ok(firstEvent);
    assert.ok(secondEvent);
    assert.equal(firstEvent?.multimodalData[0]?.itemId, itemId);
    assert.equal(secondEvent?.multimodalData[0]?.itemId, itemId);
    const db = new DatabaseSync(sqlitePath);
    const rowCount = db.prepare("SELECT count(*) AS count FROM multimodal_data_items WHERE source_item_id = ?").get(itemId) as { count: number };
    db.close();
    assert.equal(rowCount.count, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository rehydrates short-term memory arrays for debug snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-stm-arrays-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const firstRepository = new SqliteContextEngineRepository(storePath);
    await firstRepository.saveShortTermMemory({
      memoryDataId: "stm_sqlite_arrays",
      ...testStmScope,
      memoryDataType: "manual_memory_event",
      content: "sqlite should rehydrate safe STM arrays",
      sourceFactIds: ["fact_1"],
      sourceRefs: [],
      entityIds: [],
      importanceLevel: "medium",
      confidenceLevel: "high",
      admissionResult: "write_short_term",
      admissionReason: "test",
      matchedRules: ["rule_1"],
      admissionSignals: {
        importance: "medium",
        confidence: "high",
        freshness: "fresh",
        sensitivity: "low",
        actorWeight: "medium",
        conflict: "none",
        permission: "private"
      },
      lifecycleStatus: "active"
    });

    const secondRepository = new SqliteContextEngineRepository(storePath);
    const memory = secondRepository.getDebugSnapshot().shortTermMemories.find((item) => item.memoryDataId === "stm_sqlite_arrays");

    assert.ok(memory);
    assert.deepEqual(memory.sourceFactIds, ["fact_1"]);
    assert.deepEqual(memory.sourceRefs, []);
    assert.deepEqual(memory.entityIds, []);
    assert.deepEqual(memory.matchedRules, ["rule_1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository stores structured STM facts outside readable content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-structured-stm-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const firstRepository = new SqliteContextEngineRepository(storePath);
    await firstRepository.saveShortTermMemory({
      memoryDataId: "stm_sqlite_structured",
      ...testStmScope,
      memoryDataType: "manual_memory_event",
      content: "PRD 要求 STM 保存结构化事实与补充解释",
      structuredFacts: {
        schemaVersion: "memory-structured-facts.v1",
        memoryKind: "short_term",
        facts: [{
          factId: "fact_sqlite_structured",
          claim: "STM 保存结构化事实",
          explanation: "补充解释保存在结构化字段和 summary 中，content 保持可读主事实。"
        }]
      },
      summary: "补充解释：SQLite 持久化应保留 structuredFacts。",
      sourceFactIds: ["fact_sqlite_structured"],
      sourceRefs: [],
      entityIds: [],
      importanceLevel: "medium",
      confidenceLevel: "high",
      admissionResult: "write_short_term",
      admissionReason: "test",
      matchedRules: ["rule_1"],
      admissionSignals: {
        importance: "medium",
        confidence: "high",
        freshness: "fresh",
        sensitivity: "low",
        actorWeight: "medium",
        conflict: "none",
        permission: "private"
      },
      lifecycleStatus: "active"
    });

    const secondRepository = new SqliteContextEngineRepository(storePath);
    const memory = secondRepository.getDebugSnapshot().shortTermMemories.find((item) => item.memoryDataId === "stm_sqlite_structured");

    assert.ok(memory);
    assert.equal(memory.content.trim().startsWith("{"), false);
    assert.equal(memory.structuredFacts?.schemaVersion, "memory-structured-facts.v1");
    assert.equal(memory.structuredFacts?.memoryKind, "short_term");
    assert.equal(memory.structuredFacts?.facts[0]?.claim, "STM 保存结构化事实");
    assert.equal(memory.summary, "补充解释：SQLite 持久化应保留 structuredFacts。");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository persists PRD memory type and fact summary for STM and LTM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-memory-type-summary-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const firstRepository = new SqliteContextEngineRepository(storePath);
    await firstRepository.saveShortTermMemory({
      memoryDataId: "stm_sqlite_memory_type",
      ...testStmScope,
      memoryDataType: "manual_memory_event",
      memoryType: "preference",
      content: "用户偏好 PRD 规则配例子。",
      factSummary: "偏好：PRD 规则需要配例子。",
      summary: "补充解释：用户明确表达了 PRD 写作偏好。",
      sourceFactIds: ["fact_memory_type"],
      sourceRefs: [{ sourceRefId: "src_memory_type", sourceType: "file", sourceId: "prd.md" }],
      entityIds: ["entity_prd"],
      importanceLevel: "high",
      confidenceLevel: "high",
      admissionResult: "write_high_priority",
      admissionReason: "high_value_or_agent_confirmed_fact",
      matchedRules: ["preference_memory_type"],
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
      accessState: "visible"
    });
    await firstRepository.saveLongTermMemory({
      memoryId: "ltm_sqlite_memory_type",
      theoryClass: "procedural",
      memoryType: "preference",
      content: "用户长期偏好 PRD 表述专业且每条规则配例子。",
      factSummary: "长期偏好：PRD 要专业并配例子。",
      summary: "补充解释：由用户显式偏好巩固为长期记忆。",
      sourceRefs: [{ sourceRefId: "src_memory_type", sourceType: "file", sourceId: "prd.md" }],
      sourceMemoryDataIds: ["stm_sqlite_memory_type"],
      entityIds: ["entity_prd"],
      confidenceLevel: "high",
      recallWeight: "high",
      solidifyReason: "explicit_preference",
      matchedRules: ["prd_memory_type"],
      lifecycleStatus: "active",
      accessState: "visible"
    });

    const secondRepository = new SqliteContextEngineRepository(storePath);
    const snapshot = secondRepository.getDebugSnapshot();
    const stm = snapshot.shortTermMemories.find((item) => item.memoryDataId === "stm_sqlite_memory_type");
    const ltm = snapshot.longTermMemories.find((item) => item.memoryId === "ltm_sqlite_memory_type");
    assert.equal(stm?.memoryType, "preference");
    assert.equal(stm?.factSummary, "偏好：PRD 规则需要配例子。");
    assert.equal(ltm?.memoryType, "preference");
    assert.equal(ltm?.factSummary, "长期偏好：PRD 要专业并配例子。");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository persists retrieval weights for memory and graph nodes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-retrieval-weight-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const firstRepository = new SqliteContextEngineRepository(storePath);
    await firstRepository.saveShortTermMemory({
      memoryDataId: "stm_sqlite_weight",
      ...testStmScope,
      memoryDataType: "manual_memory_event",
      content: "高价值 STM 需要持久化静态检索权重",
      sourceFactIds: [],
      sourceRefs: [],
      entityIds: [],
      importanceLevel: "high",
      userRetrievalWeight: 0.4,
      confidenceLevel: "high",
      admissionResult: "write_short_term",
      admissionReason: "test",
      matchedRules: [],
      admissionSignals: {
        importance: "high",
        confidence: "high",
        freshness: "fresh",
        sensitivity: "low",
        actorWeight: "medium",
        conflict: "none",
        permission: "private"
      },
      lifecycleStatus: "active"
    });
    await firstRepository.saveLongTermMemory({
      memoryId: "ltm_sqlite_weight",
      theoryClass: "semantic",
      memoryType: "preference",
      content: "高召回 LTM 需要持久化静态检索权重",
      confidenceLevel: "high",
      recallWeight: "high",
      userRetrievalWeight: 0.9,
      solidifyReason: "test",
      sourceRefs: [],
      sourceMemoryDataIds: ["stm_sqlite_weight"],
      entityIds: [],
      matchedRules: [],
      lifecycleStatus: "active"
    });
    await firstRepository.upsertGraphMemoryNode({
      graphNodeId: "graph_ltm_sqlite_weight",
      ownerType: "ltm",
      ownerId: "ltm_sqlite_weight",
      memoryType: "preference",
      content: "高召回 LTM 需要持久化静态检索权重",
      factSummary: "长期图节点摘要：权重字段需要持久化。",
      vector: [0.1, 0.2, 0.3],
      lifecycleStatus: "active",
      retrievalWeight: 1,
      sourceRefs: [],
      entityIds: [],
      refreshedAt: "2026-06-30T00:00:00.000Z"
    });

    const secondRepository = new SqliteContextEngineRepository(storePath);
    const snapshot = secondRepository.getDebugSnapshot();

    assert.equal(snapshot.shortTermMemories.find((item) => item.memoryDataId === "stm_sqlite_weight")?.retrievalWeight, 0.8);
    assert.equal(snapshot.shortTermMemories.find((item) => item.memoryDataId === "stm_sqlite_weight")?.userRetrievalWeight, 0.4);
    assert.equal(snapshot.longTermMemories.find((item) => item.memoryId === "ltm_sqlite_weight")?.retrievalWeight, 1);
    assert.equal(snapshot.longTermMemories.find((item) => item.memoryId === "ltm_sqlite_weight")?.userRetrievalWeight, 0.9);
    assert.equal(snapshot.graphMemoryNodes.find((item) => item.graphNodeId === "graph_ltm_sqlite_weight")?.retrievalWeight, 1);
    assert.equal(snapshot.graphMemoryNodes.find((item) => item.graphNodeId === "graph_ltm_sqlite_weight")?.memoryType, "preference");
    assert.equal(snapshot.graphMemoryNodes.find((item) => item.graphNodeId === "graph_ltm_sqlite_weight")?.factSummary, "长期图节点摘要：权重字段需要持久化。");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository does not hydrate large text index tables on startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-large-index-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const sqlitePath = storePath.replace(/\.json$/u, ".sqlite");
    new SqliteContextEngineRepository(storePath);
    const db = new DatabaseSync(sqlitePath);
    const insert = db.prepare(`INSERT INTO context_text_index_fts (index_id, owner_id, owner_type, term, document_frequency, term_frequency, document_length, lifecycle_status, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec("BEGIN");
    for (let index = 0; index < 130_000; index += 1) {
      insert.run(
        `idx_large_${index}`,
        "owner-large",
        "fact",
        `term${index}`,
        1,
        1,
        1,
        "active",
        "2026-06-22T00:00:00.000Z"
      );
    }
    db.exec("COMMIT");
    db.close();

    const secondRepository = new SqliteContextEngineRepository(storePath);
    const snapshot = secondRepository.getDebugSnapshot();

    assert.equal(snapshot.textIndexEntries.length, 0);
    const hits = secondRepository.searchTextIndex(["term129999"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.ownerId, "owner-large");

    const reopenedDb = new DatabaseSync(sqlitePath);
    const tables = reopenedDb
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'context_text_index_entries'`)
      .all() as Array<{ name: string }>;
    assert.equal(tables.length, 0);
    reopenedDb.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository does not hydrate large persisted index payloads on startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-large-index-payloads-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const sqlitePath = storePath.replace(/\.json$/u, ".sqlite");
    new SqliteContextEngineRepository(storePath);
    const db = new DatabaseSync(sqlitePath);
    const largeContent = "large indexed content ".repeat(80_000);
    db.prepare(
      `INSERT INTO context_index_entries (index_id, owner_id, owner_type, content, lifecycle_status, refreshed_at, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("idx_large_payload", "stm_large_payload", "stm", largeContent, "active", "2026-06-22T00:00:00.000Z", 1000);
    db.prepare(
      `INSERT INTO context_vector_index_entries (index_id, owner_id, owner_type, content, vector, lifecycle_status, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("idx_large_payload", "stm_large_payload", "stm", largeContent, JSON.stringify([0.1, 0.2, 0.3]), "active", "2026-06-22T00:00:00.000Z");
    db.close();

    const repository = new SqliteContextEngineRepository(storePath);
    const snapshot = repository.getDebugSnapshot();

    assert.equal(snapshot.indexEntries.length, 1);
    assert.equal(snapshot.indexEntries[0]?.ownerId, "stm_large_payload");
    assert.equal(snapshot.indexEntries[0]?.content, "");
    assert.equal(snapshot.indexEntries[0]?.tokenCount, 1000);
    assert.equal(snapshot.vectorIndexEntries.length, 1);
    assert.equal(snapshot.vectorIndexEntries[0]?.ownerId, "stm_large_payload");
    assert.equal(snapshot.vectorIndexEntries[0]?.content, "");
    assert.deepEqual(snapshot.vectorIndexEntries[0]?.vector, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository does not hydrate large persisted LLM trace payloads on startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-large-llm-payloads-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const sqlitePath = storePath.replace(/\.json$/u, ".sqlite");
    new SqliteContextEngineRepository(storePath);
    const db = new DatabaseSync(sqlitePath);
    const largePrompt = "large prompt context ".repeat(80_000);
    const largeJson = JSON.stringify([{ content: "large trace body ".repeat(80_000) }]);
    db.prepare(
      `INSERT INTO llm_fact_fusion_traces (trace_id, event_id, provider, endpoint, model, key_source, prompt_version, schema_version, prompt, aligned_evidence, raw_response, parsed_facts, rejected_segments, fallback_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "trace_large_fact",
      "event_large_trace",
      "openai-compatible",
      "https://example.invalid/v1/chat/completions",
      "test-model",
      "missing",
      "fact-fusion.openai-compatible.v1",
      "llm-fact-fusion-trace.v1",
      largePrompt,
      largeJson,
      largeJson,
      largeJson,
      largeJson,
      null,
      "2026-06-22T00:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO llm_dreaming_traces (trace_id, source_memory_data_ids, provider, endpoint, model, key_source, prompt_version, schema_version, prompt, candidate_memories, raw_response, parsed_memories, rejected_candidates, fallback_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "trace_large_dream",
      JSON.stringify(["stm_large_trace"]),
      "openai-compatible",
      "https://example.invalid/v1/chat/completions",
      "test-model",
      "missing",
      "ltm-dreaming.openai-compatible.v1",
      "llm-dreaming-trace.v1",
      largePrompt,
      largeJson,
      largeJson,
      largeJson,
      largeJson,
      null,
      "2026-06-22T00:00:00.000Z"
    );
    db.close();

    const repository = new SqliteContextEngineRepository(storePath);
    const snapshot = repository.getDebugSnapshot();

    assert.equal(snapshot.llmFactFusionTraces.length, 1);
    assert.equal(snapshot.llmFactFusionTraces[0]?.traceId, "trace_large_fact");
    assert.equal(snapshot.llmFactFusionTraces[0]?.prompt, "");
    assert.deepEqual(snapshot.llmFactFusionTraces[0]?.alignedEvidence, []);
    assert.equal(snapshot.llmFactFusionTraces[0]?.rawResponse, undefined);
    assert.deepEqual(snapshot.llmFactFusionTraces[0]?.parsedFacts, []);
    assert.deepEqual(snapshot.llmFactFusionTraces[0]?.rejectedSegments, []);
    assert.equal(snapshot.llmDreamingTraces.length, 1);
    assert.equal(snapshot.llmDreamingTraces[0]?.traceId, "trace_large_dream");
    assert.deepEqual(snapshot.llmDreamingTraces[0]?.sourceMemoryDataIds, ["stm_large_trace"]);
    assert.equal(snapshot.llmDreamingTraces[0]?.prompt, "");
    assert.deepEqual(snapshot.llmDreamingTraces[0]?.candidateMemories, []);
    assert.equal(snapshot.llmDreamingTraces[0]?.rawResponse, undefined);
    assert.deepEqual(snapshot.llmDreamingTraces[0]?.parsedMemories, []);
    assert.deepEqual(snapshot.llmDreamingTraces[0]?.rejectedCandidates, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite repository backfills legacy text indexes into FTS5 on startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-sqlite-fts-backfill-"));
  const storePath = join(directory, "context-engine-store.json");

  try {
    const sqlitePath = storePath.replace(/\.json$/u, ".sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE context_text_index_entries (
        index_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        term TEXT NOT NULL,
        document_frequency INTEGER NOT NULL,
        term_frequency INTEGER NOT NULL,
        document_length INTEGER NOT NULL,
        lifecycle_status TEXT NOT NULL,
        refreshed_at TEXT NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO context_text_index_entries (index_id, owner_id, owner_type, term, document_frequency, term_frequency, document_length, lifecycle_status, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("idx_legacy_fact:legacy", "fact-legacy", "fact", "legacy", 1, 4, 1, "active", "2026-06-22T00:00:00.000Z");
    db.close();

    const repository = new SqliteContextEngineRepository(storePath);
    const hits = repository.searchTextIndex(["legacy"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.ownerId, "fact-legacy");
    assert.equal(hits[0]?.score, 4);

    const reopenedDb = new DatabaseSync(sqlitePath);
    const tables = reopenedDb
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'context_text_index_entries'`)
      .all() as Array<{ name: string }>;
    assert.equal(tables.length, 0);
    reopenedDb.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
