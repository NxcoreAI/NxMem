import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchContext, type ContextQuery } from "./search-context.js";
import { assembleContext } from "./assemble-context.js";
import { refreshFactIndexes, refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { admitFactsToMemoryPipeline } from "./parse-event.js";
import type { FactItem, MemoryEvent } from "./domain.js";
import type {
  CommitConversationIngestionRequest,
  ConversationIngestionRecord,
  ConversationMessageRecord
} from "./conversation-ingestion/persistence.js";

const testStmScope = {
  tenantId: "local",
  principalId: "debug-user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

test("search_context defaults to STM/LTM only and requires explicit Fact retrieval", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(512);
  await repository.saveFactItem({
    factId: "fact_only",
    tenantId: "local",
    principalId: "debug-user",
    factType: "observation",
    factText: "事实层参与混合检索",
    normalizedClaim: "事实层参与混合检索",
    linkedEventIds: [],
    linkedSegmentIds: [],
    linkedSourceRefs: [{ sourceRefId: "src_fact_only", sourceType: "file", sourceId: "fact-only-demo" }],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-01-01T00:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "test.v1",
    accessState: "visible"
  });
  await refreshFactIndexes(repository, repository.getDebugSnapshot().facts, embeddingClient);
  await repository.saveShortTermMemory({
    memoryDataId: "stm_only",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: "短期记忆参与混合检索",
    sourceFactIds: ["fact_only"],
    sourceRefs: [{ sourceRefId: "src_stm_only", sourceType: "file", sourceId: "stm-only-demo" }],
    entityIds: ["entity_stm_only"],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["rule"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!, embeddingClient);
  await repository.saveLongTermMemory({
    memoryId: "ltm_only",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "长期记忆参与混合检索",
    summary: "长期记忆",
    sourceRefs: [{ sourceRefId: "src_ltm_only", sourceType: "file", sourceId: "ltm-only-demo" }],
    sourceMemoryDataIds: ["stm_only"],
    entityIds: ["entity_ltm_only"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: ["rule"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!, embeddingClient);

  const originalFetch = globalThis.fetch;
  const originalRerankerEnabled = process.env.RERANKER_ENABLED;
  const originalRerankerBaseUrl = process.env.RERANKER_BASE_URL;
  const originalRerankerApiKey = process.env.RERANKER_API_KEY;
  let defaultRerankerCallCount = 0;
  process.env.RERANKER_ENABLED = "true";
  process.env.RERANKER_BASE_URL = "http://reranker.test/v1";
  process.env.RERANKER_API_KEY = "test-key";
  globalThis.fetch = (async (_input, init) => {
    defaultRerankerCallCount += 1;
    const body = JSON.parse(String(init?.body)) as { documents: string[] };
    return new Response(JSON.stringify({
      results: body.documents.map((_document, index) => ({
        index,
        relevance_score: 1 - index / Math.max(1, body.documents.length)
      }))
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const memoryOnlySearch = await searchContext(
      repository,
      { q: "参与混合检索" },
      { recordShadow: false, embeddingClient }
    );
    assert.equal(memoryOnlySearch.results.some((item) => item.layer === "fact"), false);
    assert.equal(memoryOnlySearch.results.some((item) => item.layer === "stm"), true);
    assert.equal(memoryOnlySearch.results.some((item) => item.layer === "ltm"), true);
    assert.equal(memoryOnlySearch.results.every((item) => item.scoreBreakdown.reranker !== undefined), true);
    assert.equal(defaultRerankerCallCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("RERANKER_ENABLED", originalRerankerEnabled);
    restoreEnvironment("RERANKER_BASE_URL", originalRerankerBaseUrl);
    restoreEnvironment("RERANKER_API_KEY", originalRerankerApiKey);
  }

  const factEnabledSearch = await searchContext(repository, { q: "参与混合检索" }, {
    factRetrieval: true,
    memoryReranker: false,
    embeddingClient
  });
  assert.equal(factEnabledSearch.results.some((item) => item.layer === "fact"), true);
  assert.equal(factEnabledSearch.results.some((item) => item.layer === "stm"), true);
  assert.equal(factEnabledSearch.results.some((item) => item.layer === "ltm"), true);

  let rerankedDocumentIds: string[] = [];
  const rerankedMemoryOnlySearch = await searchContext(repository, {
    q: "参与混合检索",
    limit: 100
  }, {
    factRetrieval: false,
    embeddingClient,
    memoryReranker: {
      model: "test-memory-reranker",
      async rerank(_query, documents) {
        rerankedDocumentIds = documents.map((document) => document.id);
        return documents.map((document, index) => ({
          id: document.id,
          score: document.id === "ltm_only" ? 0.9 : 0.1,
          originalRank: index + 1
        }));
      }
    }
  });
  assert.deepEqual(rerankedDocumentIds.sort(), ["ltm_only", "stm_only"]);
  assert.equal(rerankedMemoryOnlySearch.results.some((item) => item.layer === "fact"), false);
  assert.equal(rerankedMemoryOnlySearch.results[0]?.id, "ltm_only");
  assert.equal(rerankedMemoryOnlySearch.results[0]?.scoreBreakdown.reranker, 0.9);
  assert.match(rerankedMemoryOnlySearch.results[0]?.reason ?? "", /:cross_encoder$/u);

  const fallbackMemoryOnlySearch = await searchContext(repository, {
    q: "参与混合检索",
    limit: 100
  }, {
    factRetrieval: false,
    embeddingClient,
    memoryReranker: {
      model: "incomplete-test-memory-reranker",
      async rerank(_query, documents) {
        return documents.slice(0, 1).map((document, index) => ({
          id: document.id,
          score: 1,
          originalRank: index + 1
        }));
      }
    }
  });
  assert.equal(fallbackMemoryOnlySearch.results.every((item) => item.reason.endsWith(":reranker_fallback")), true);
  assert.equal(fallbackMemoryOnlySearch.results.every((item) => item.scoreBreakdown.reranker === undefined), true);
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("search_context recalls generated STM regardless of legacy hidden or admission lifecycle", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory({
    memoryDataId: "stm_hidden_candidate",
    ...testStmScope,
    memoryDataType: "project_fact",
    content: "用户计划八月一日从郑州前往深圳",
    sourceFactIds: ["fact_hidden_candidate"],
    sourceRefs: [{ sourceRefId: "src_hidden_candidate", sourceType: "agent_memory", sourceId: "flight-session" }],
    entityIds: [],
    importanceLevel: "medium",
    confidenceLevel: "high",
    admissionResult: "write_candidate",
    admissionReason: "test",
    matchedRules: ["project_fact"],
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
  await repository.saveShortTermMemory({
    memoryDataId: "stm_permission_invalid",
    ...testStmScope,
    memoryDataType: "project_fact",
    content: "权限已经失效的郑州深圳机票记忆",
    sourceFactIds: ["fact_permission_invalid"],
    sourceRefs: [{ sourceRefId: "src_permission_invalid", sourceType: "agent_memory", sourceId: "revoked-session" }],
    entityIds: [],
    importanceLevel: "medium",
    confidenceLevel: "high",
    admissionResult: "write_candidate",
    admissionReason: "test",
    matchedRules: ["project_fact"],
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
    accessState: "permission-invalid"
  });
  for (const memory of repository.getDebugSnapshot().shortTermMemories) {
    await refreshShortTermMemoryIndex(repository, memory);
  }

  const result = await searchContext(repository, {
    q: "郑州 深圳",
    layer: "stm"
  });

  assert.equal(result.results.some((item) => item.id === "stm_hidden_candidate"), true);
  assert.equal(result.dropped.some((item) => item.id === "stm_hidden_candidate"), false);

  const invalid = await searchContext(repository, {
    q: "权限已经失效",
    layer: "stm"
  });
  assert.equal(invalid.results.some((item) => item.id === "stm_permission_invalid"), false);
  assert.equal(invalid.dropped.some((item) =>
    item.id === "stm_permission_invalid" && item.reason === "permission_invalid"
  ), true);

  const pack = await assembleContext(repository, {
    task: "权限已经失效",
    q: "权限已经失效",
    layer: "stm",
    tokenBudget: 300
  });
  const selected = [...pack.profileContext, ...pack.taskContext, ...pack.recentContext, ...pack.constraints];
  assert.equal(selected.some((item) => item.id === "stm_permission_invalid"), false);
  assert.equal(pack.dropped.some((item) =>
    item.id === "stm_permission_invalid" && item.reason === "search:permission_invalid"
  ), true);
});

test("search_context lets user retrieval weight outrank system retrieval weight", async () => {
  const repository = new InMemoryContextEngineRepository();

  await repository.saveLongTermMemory({
    memoryId: "ltm_system_heavy",
    theoryClass: "semantic",
    memoryType: "preference",
    content: "权重优先级测试 alpha 系统权重高但用户没有强化",
    sourceRefs: [{ sourceRefId: "src_system_heavy", sourceType: "file", sourceId: "weight-system-demo" }],
    sourceMemoryDataIds: [],
    entityIds: ["entity_weight_priority"],
    confidenceLevel: "high",
    recallWeight: "high",
    retrievalWeight: 1,
    userRetrievalWeight: 0.1,
    solidifyReason: "test",
    matchedRules: ["rule"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);
  await repository.saveLongTermMemory({
    memoryId: "ltm_user_boosted",
    theoryClass: "semantic",
    memoryType: "preference",
    content: "权重优先级测试 alpha 系统权重低但用户明确强化",
    sourceRefs: [{ sourceRefId: "src_user_boosted", sourceType: "file", sourceId: "weight-user-demo" }],
    sourceMemoryDataIds: [],
    entityIds: ["entity_weight_priority"],
    confidenceLevel: "high",
    recallWeight: "low",
    retrievalWeight: 0.2,
    userRetrievalWeight: 1,
    solidifyReason: "test",
    matchedRules: ["rule"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[1]!);

  const result = await searchContext(repository, { q: "权重优先级测试 alpha", layer: "ltm", limit: 5 });

  assert.equal(result.results[0]?.id, "ltm_user_boosted");
  assert.equal(result.results[0]?.scoreBreakdown.retrievalWeight, 0.2);
  assert.equal(result.results[0]?.scoreBreakdown.userRetrievalWeight, 1);
  assert.equal(result.results[1]?.scoreBreakdown.retrievalWeight, 1);
  assert.equal(result.results[1]?.scoreBreakdown.userRetrievalWeight, 0.1);
});

test("search_context can materialize sqlite results without a full debug snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "search-context-lazy-sqlite-"));
  const storePath = join(dir, "context.sqlite");
  const writer = new SqliteContextEngineRepository(storePath);
  await writer.saveShortTermMemory({
    memoryDataId: "stm_lazy_sqlite",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: "lazy sqlite retrieval keeps searchable memory outside the debug snapshot",
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_lazy_sqlite", sourceType: "agent_memory", sourceId: "lazy-session" }],
    entityIds: ["entity_lazy_sqlite"],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["rule"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshShortTermMemoryIndex(writer, writer.getDebugSnapshot().shortTermMemories[0]!);

  const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
  assert.equal(reader.getDebugSnapshot().shortTermMemories.length, 0);
  reader.getDebugSnapshot = () => {
    throw new Error("debug snapshot should not be used for sqlite-backed retrieval");
  };

  const result = await searchContext(reader, {
    q: "lazy sqlite retrieval",
    layer: "stm",
    sourceIds: ["lazy-session"],
    includeInactive: true,
    limit: 5
  });

  assert.equal(result.results[0]?.id, "stm_lazy_sqlite");
  assert.equal(result.results[0]?.content.includes("lazy sqlite retrieval"), true);
});

test("sqlite repository can drop loaded objects without losing on-demand retrieval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "search-context-clear-cache-"));
  const storePath = join(dir, "context.sqlite");
  const repository = new SqliteContextEngineRepository(storePath);
  await repository.saveShortTermMemory({
    memoryDataId: "stm_clear_cache",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: "clear cache keeps sqlite backed retrieval available",
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_clear_cache", sourceType: "agent_memory", sourceId: "clear-cache-session" }],
    entityIds: ["entity_clear_cache"],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["rule"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);

  repository.clearLoadedCache();

  assert.equal(repository.getDebugSnapshot().shortTermMemories.length, 0);
  assert.equal(repository.getDebugSnapshot().graphMemoryNodes.length, 0);

  const result = await searchContext(repository, {
    q: "clear cache retrieval",
    layer: "stm",
    sourceIds: ["clear-cache-session"],
    includeInactive: true,
    limit: 5
  });

  assert.equal(result.results[0]?.id, "stm_clear_cache");
  assert.equal(result.results[0]?.content.includes("sqlite backed retrieval"), true);
});

test("LongMemEval single-value times survive Fact to STM to search and Context Pack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-single-time-chain-"));
  const storePath = join(dir, "context.sqlite");
  const event: MemoryEvent = {
    eventId: "longmemeval_event_temporal_chain_session_1",
    contextScopeId: "longmemeval:temporal_chain",
    eventType: "longmemeval_session",
    eventSummary: "LongMemEval temporal chain session",
    eventTime: "2023-04-01T00:00:00.000Z",
    sourceApp: "longmemeval",
    sourceId: "longmemeval_event_temporal_chain_session_1",
    permissionSnapshot: {
      snapshotId: "permission_temporal_chain",
      tenantId: "local",
      principalId: "longmemeval",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item_temporal_chain",
      type: "text",
      format: "plain",
      content: "The keyboard event happened one week earlier.",
      timeBasis: "source_time",
      timeConfidence: "high"
    }],
    sourceRefs: [{
      sourceRefId: "src_longmemeval_event_temporal_chain_session_1",
      sourceType: "agent_memory",
      sourceId: "longmemeval_event_temporal_chain_session_1",
      metadata: { questionId: "temporal_chain", sessionId: "session_1" }
    }]
  };
  const fact: FactItem = {
    factId: "fact_temporal_chain",
    tenantId: "local",
    principalId: "longmemeval",
    contextScopeId: "longmemeval:temporal_chain",
    factType: "event",
    factText: "The keyboard event happened one week earlier.",
    sourceClaim: "The keyboard event happened one week earlier.",
    normalizedClaim: "keyboard event happened",
    linkedEventIds: [event.eventId],
    linkedSegmentIds: [],
    linkedSourceRefs: event.sourceRefs!,
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: event.eventTime,
    evidenceTime: "2023-04-01T00:00:00.000Z",
    validTime: "2023-03-25T00:00:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeConfidence: "high",
    timeBasis: "event_relative",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  };

  let writer: SqliteContextEngineRepository | undefined;
  let reader: SqliteContextEngineRepository | undefined;
  try {
    writer = new SqliteContextEngineRepository(storePath);
    await writer.saveMemoryEvent(event);
    await writer.saveFactItem(fact);
    await admitFactsToMemoryPipeline(writer, event, [fact], {
      disableStmAdmissionLlm: true,
      fallbackSourceRefs: fact.linkedSourceRefs
    });
    const memoryDataId = writer.getDebugSnapshot().shortTermMemories.find((memory) =>
      memory.sourceFactIds.includes(fact.factId)
    )?.memoryDataId;
    assert.ok(memoryDataId);
    writer.close();
    writer = undefined;

    reader = new SqliteContextEngineRepository(storePath);
    reader.clearLoadedCache();
    assert.deepEqual(reader.findFactItemsByEventIds([event.eventId]).map((item) => item.factId), [fact.factId]);
    const restored = reader.getShortTermMemory(memoryDataId);
    assert.ok(restored);
    assert.equal(restored.evidenceTime, fact.evidenceTime);
    assert.equal(restored.validTime, fact.validTime);
    assert.equal(restored.evidenceTimeStart, undefined);
    assert.equal(restored.evidenceTimeEnd, undefined);
    assert.equal(restored.validTimeStart, undefined);
    assert.equal(restored.validTimeEnd, undefined);
    assert.equal(restored.structuredFacts?.facts[0]?.evidenceTime, fact.evidenceTime);
    assert.equal(restored.structuredFacts?.facts[0]?.validTime, fact.validTime);
    assert.equal(restored.structuredFacts?.facts[0]?.evidenceTimeStart, undefined);
    assert.equal(restored.structuredFacts?.facts[0]?.validTimeStart, undefined);
    assert.deepEqual(
      Object.keys(restored.structuredFacts?.facts[0] ?? {}).filter((key) => key.includes("Time")).sort(),
      ["evidenceTime", "validTime"]
    );

    const embeddingClient = createDeterministicTestEmbeddingClient(512);
    const search = await searchContext(reader, {
      q: "keyboard event",
      layer: "stm",
      tenantId: "local",
      principalId: "longmemeval",
      contextScopeId: "longmemeval:temporal_chain"
    }, { embeddingClient });
    const result = search.results.find((item) => item.id === memoryDataId);
    assert.ok(result);
    assert.equal(result.temporal.evidenceTime, fact.evidenceTime);
    assert.equal(result.temporal.validTime, fact.validTime);
    assert.equal(result.temporal.evidenceTimeStart, undefined);
    assert.equal(result.temporal.validTimeStart, undefined);
    assert.deepEqual(Object.keys(result.temporal).sort(), ["evidenceTime", "validTime"]);
    assert.deepEqual(
      reader.findMemoryOwnersByContextScopeId("longmemeval:temporal_chain", ["stm"]).map((owner) => owner.ownerId),
      [memoryDataId]
    );

    const validTimeSearch = await searchContext(reader, {
      q: "keyboard event",
      layer: "stm",
      tenantId: "local",
      principalId: "longmemeval",
      contextScopeId: "longmemeval:temporal_chain",
      timeRange: {
        startTime: "2023-03-25T00:00:00.000Z",
        endTime: "2023-03-25T23:59:59.999Z",
        basis: "auto"
      }
    }, { embeddingClient });
    const validTimeResult = validTimeSearch.results.find((item) => item.id === memoryDataId);
    assert.ok(validTimeResult);
    assert.deepEqual(Object.keys(validTimeResult.temporal).sort(), ["evidenceTime", "validTime"]);

    const pack = await assembleContext(reader, {
      task: "When did the keyboard event happen?",
      q: "keyboard event",
      layer: "stm",
      tenantId: "local",
      principalId: "longmemeval",
      timezone: "UTC",
      locale: "en-US",
      tokenBudget: 600,
      embeddingClient,
      recordRetrieval: false
    });
    const packItem = pack.recentContext.find((item) => item.id === memoryDataId);
    assert.ok(packItem);
    assert.equal(packItem.temporal.evidenceTime, fact.evidenceTime);
    assert.equal(packItem.temporal.validTime, fact.validTime);
    assert.equal(packItem.temporal.evidenceTimeStart, undefined);
    assert.equal(packItem.temporal.validTimeStart, undefined);
    assert.match(pack.serializedPrompt, /事实时间：2023-03-25 00:00/u);
    assert.match(pack.serializedPrompt, /消息时间：2023-04-01 00:00/u);
  } finally {
    writer?.close();
    reader?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fact records are stored without recall indexes", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveFactItem({
    factId: "fact_no_index",
    factType: "text",
    factText: "事实入库但不建索引",
    normalizedClaim: "事实入库但不建索引",
    linkedEventIds: ["event_no_index"],
    linkedSegmentIds: ["seg_no_index"],
    linkedSourceRefs: [{ sourceRefId: "src_no_index", sourceType: "file", sourceId: "no-index-demo" }],
    entityIds: ["entity_no_index"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: new Date().toISOString(),
    validTimeStart: new Date().toISOString(),
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  });

  const snapshot = repository.getDebugSnapshot();
  assert.equal(snapshot.textIndexEntries.some((item) => item.ownerId === "fact_no_index"), false);
  assert.equal(snapshot.vectorIndexEntries.some((item) => item.ownerId === "fact_no_index"), false);
  assert.equal((await searchContext(repository, { q: "事实入库但不建索引" })).results.length, 0);
});

test("search_context tolerates long term memories with missing source refs", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveLongTermMemory({
    memoryId: "ltm_missing_source_refs",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "缺失来源字段也不能把搜索打崩",
    summary: "缺失来源字段",
    sourceRefs: [],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const result = await searchContext(repository, {
    q: "缺失来源字段",
    tenantId: "tenant",
    principalId: "principal"
  });

  assert.equal(result.results.length, 0);
  assert.equal(result.dropped.some((item) => item.reason === "missing_source_refs"), true);
});

test("search_context reports access state drops precisely", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveLongTermMemory({
    memoryId: "ltm_hidden",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "隐藏记忆不应召回",
    summary: "hidden",
    sourceRefs: [{ sourceRefId: "src_hidden", sourceType: "file", sourceId: "hidden-source" }],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    accessState: "hidden"
  });
  await repository.saveLongTermMemory({
    memoryId: "ltm_permission_invalid",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "权限失效记忆不应召回",
    summary: "permission invalid",
    sourceRefs: [{ sourceRefId: "src_invalid", sourceType: "file", sourceId: "invalid-source" }],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    accessState: "permission-invalid"
  });
  for (const memory of repository.getDebugSnapshot().longTermMemories) {
    await refreshLongTermMemoryIndex(repository, memory);
  }

  const hidden = await searchContext(repository, { q: "隐藏记忆", includeInactive: true });
  const invalid = await searchContext(repository, { q: "权限失效记忆", includeInactive: true });

  assert.equal(hidden.dropped.some((item) => item.id === "ltm_hidden" && item.reason === "access_hidden"), true);
  assert.equal(invalid.dropped.some((item) => item.id === "ltm_permission_invalid" && item.reason === "permission_invalid"), true);
});

test("search_context treats legacy null access state as visible", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveLongTermMemory({
    memoryId: "ltm_legacy_null_access",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "旧库空访问状态应该保持可检索",
    summary: "legacy null access state",
    sourceRefs: [{ sourceRefId: "src_legacy_null", sourceType: "file", sourceId: "legacy-null-source" }],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    accessState: null as never
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const result = await searchContext(repository, { q: "旧库空访问状态" });

  assert.equal(result.results.some((item) => item.id === "ltm_legacy_null_access"), true);
  assert.equal(result.dropped.some((item) => item.id === "ltm_legacy_null_access"), false);
});

test("assemble_context groups selected candidates and preserves citations", async () => {
  const repository = new InMemoryContextEngineRepository();
  const now = new Date().toISOString();
  await repository.saveFactItem({
    factId: "fact_pack",
    factType: "text",
    factText: "必须保留引用并按 token 预算组装上下文",
    normalizedClaim: "必须保留引用并按 token 预算组装上下文",
    linkedEventIds: ["event_pack"],
    linkedSegmentIds: ["seg_pack"],
    linkedSourceRefs: [{ sourceRefId: "src_pack", sourceType: "file", sourceId: "pack-demo" }],
    entityIds: ["entity_pack"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: now,
    validTimeStart: now,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  });
  await repository.saveShortTermMemory({
    memoryDataId: "stm_pack",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: "必须保留引用并按 token 预算组装上下文",
    sourceFactIds: ["fact_pack"],
    sourceRefs: [{ sourceRefId: "src_pack", sourceType: "file", sourceId: "pack-demo" }],
    entityIds: ["entity_pack"],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_high_priority",
    admissionReason: "high_value_or_agent_confirmed_fact",
    matchedRules: ["parser_adapter"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "组装上下文用于回答检索问题",
    q: "必须保留引用",
    tokenBudget: 300
  });

  assert.equal(pack.citations.length > 0, true);
  assert.equal(pack.constraints.some((item) => item.id === "stm_pack"), true);
  assert.equal(pack.tokenBudget.requested, 300);
  assert.equal(pack.tokenBudget.used > 0, true);
  assert.equal(pack.serializedPrompt.includes("【Context Pack】"), true);
  assert.equal(pack.serializedPrompt.includes("【引用】"), true);
});

test("assemble_context can restrict retrieval to source ids", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory({
    memoryDataId: "stm_allowed",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: "shared query phrase allowed memory",
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_allowed", sourceType: "file", sourceId: "allowed-source" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_high_priority",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  await repository.saveShortTermMemory({
    memoryDataId: "stm_other",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: "shared query phrase unrelated memory",
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_other", sourceType: "file", sourceId: "other-source" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_high_priority",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  for (const memory of repository.getDebugSnapshot().shortTermMemories) {
    await refreshShortTermMemoryIndex(repository, memory);
  }

  const pack = await assembleContext(repository, {
    task: "shared query phrase",
    q: "shared query phrase",
    sourceIds: ["allowed-source"],
    tokenBudget: 300
  });

  const selectedIds = [...pack.profileContext, ...pack.taskContext, ...pack.recentContext, ...pack.constraints].map((item) => item.id);
  assert.deepEqual(selectedIds, ["stm_allowed"]);
  assert.equal(pack.dropped.some((item) => item.id === "stm_other" && item.reason === "search:source_filtered"), false);
});

test("assemble_context includes scoped source memories even when query text does not match", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory({
    memoryDataId: "stm_scoped_source",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: "the useful evidence is only connected by source scope",
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_scoped", sourceType: "file", sourceId: "scoped-source" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_high_priority",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "unmatched question terms",
    q: "unmatched question terms",
    sourceIds: ["scoped-source"],
    tokenBudget: 300
  });

  assert.equal(pack.recentContext.some((item) => item.id === "stm_scoped_source"), true);
});

test("assemble_context keeps separate budgets for long and short term memories", async () => {
  const repository = new InMemoryContextEngineRepository();
  const noisyStm = "shared budget pressure short term noise. ".repeat(120);
  await repository.saveShortTermMemory({
    memoryDataId: "stm_budget_noise",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: noisyStm,
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_budget_stm", sourceType: "file", sourceId: "budget-stm" }],
    entityIds: [],
    importanceLevel: "critical",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "critical",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  await repository.saveLongTermMemory({
    memoryId: "ltm_budget_signal",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "shared budget pressure long term signal",
    summary: "long term signal",
    sourceRefs: [{ sourceRefId: "src_budget_ltm", sourceType: "file", sourceId: "budget-ltm" }],
    sourceMemoryDataIds: ["stm_budget_noise"],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: ["test"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "shared budget pressure",
    q: "shared budget pressure",
    tokenBudget: 300
  });

  assert.equal(pack.recentContext.some((item) => item.id === "stm_budget_noise"), true);
  assert.equal(pack.profileContext.some((item) => item.id === "ltm_budget_signal"), true);
  assert.equal(pack.tokenBudget.allocations.recent <= pack.tokenBudget.plan.recentContext, true);
  assert.equal(pack.tokenBudget.allocations.profile <= pack.tokenBudget.plan.profileContext, true);
});

test("assemble_context uses stm items and can compress them under budget pressure", async () => {
  const repository = new InMemoryContextEngineRepository();
  const now = new Date().toISOString();

  await repository.saveShortTermMemory({
    memoryDataId: "stm_no_fact_layer",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: "事实层不应进入 Context Pack 组装结果",
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_no_fact_layer", sourceType: "file", sourceId: "no-fact-layer" }],
    entityIds: ["entity_no_fact_layer"],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_high_priority",
    admissionReason: "high_value_or_agent_confirmed_fact",
    matchedRules: ["parser_adapter"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "组装上下文",
    q: "事实层不应进入 Context Pack 组装结果",
    tokenBudget: 300
  });

  const stmItem = [...pack.profileContext, ...pack.taskContext, ...pack.recentContext, ...pack.constraints].find((item) => item.id === "stm_no_fact_layer");
  assert.ok(stmItem);
  assert.equal(stmItem?.compressedContent ?? stmItem?.content, stmItem?.content);
  assert.equal(pack.dropped.some((item) => item.id === "stm_no_fact_layer"), false);
  assert.equal(pack.recentContext.some((item) => item.id === "stm_no_fact_layer"), true);
});

test("assemble_context keeps long term memories in the long term context bucket", async () => {
  const repository = new InMemoryContextEngineRepository();

  await repository.saveLongTermMemory({
    memoryId: "ltm_profile",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "用户偏好：喜欢简洁的上下文展示",
    summary: "用户偏好：喜欢简洁展示",
    sourceRefs: [{ sourceRefId: "src_profile", sourceType: "file", sourceId: "profile-demo" }],
    sourceMemoryDataIds: ["stm_profile"],
    entityIds: ["entity_profile"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "profile_memory",
    matchedRules: ["feedback"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);
  await repository.saveLongTermMemory({
    memoryId: "ltm_timeline",
    theoryClass: "semantic",
    memoryType: "timeline_aggregation",
    content: "时间轴聚合：把跨事件事实按时间合并",
    summary: "时间轴聚合记忆",
    sourceRefs: [{ sourceRefId: "src_timeline", sourceType: "file", sourceId: "timeline-demo" }],
    sourceMemoryDataIds: ["stm_timeline"],
    entityIds: ["entity_timeline"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "timeline_memory",
    matchedRules: ["fusion"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[1]!);
  await repository.saveLongTermMemory({
    memoryId: "ltm_constraint",
    theoryClass: "semantic",
    memoryType: "constraint",
    content: "必须保留引用，不得静默丢弃来源",
    summary: "引用约束",
    sourceRefs: [{ sourceRefId: "src_constraint", sourceType: "file", sourceId: "constraint-demo" }],
    sourceMemoryDataIds: ["stm_constraint"],
    entityIds: ["entity_constraint"],
    confidenceLevel: "high",
    recallWeight: "medium",
    solidifyReason: "constraint_memory",
    matchedRules: ["must"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[2]!);

  const pack = await assembleContext(repository, {
    task: "组装长期记忆上下文",
    q: "用户偏好 时间轴 必须",
    tokenBudget: 500
  });

  assert.equal(pack.profileContext.some((item) => item.id === "ltm_profile"), true);
  assert.equal(pack.constraints.some((item) => item.id === "ltm_constraint"), true);
  assert.equal(pack.profileContext.some((item) => item.id === "ltm_timeline"), true);
  assert.equal(pack.profileContext.some((item) => item.id === "ltm_constraint"), false);
  assert.equal(pack.serializedPrompt.includes("长期记忆上下文"), true);
});

test("assemble_context compresses items before dropping them under budget pressure", async () => {
  const repository = new InMemoryContextEngineRepository();
  const longContent = "这是一个很长的上下文条目。".repeat(80);

  await repository.saveShortTermMemory({
    memoryDataId: "stm_compress",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content: longContent,
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_compress", sourceType: "file", sourceId: "compress-demo" }],
    entityIds: ["entity_compress"],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_high_priority",
    admissionReason: "budget_test",
    matchedRules: ["parser_adapter"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "压缩上下文",
    q: "很长的上下文条目",
    tokenBudget: 500
  });

  assert.equal(pack.profileContext.length + pack.taskContext.length + pack.recentContext.length + pack.constraints.length > 0, true);
  assert.equal(pack.compressionSteps?.some((step) => step.action === "compress"), true);
  assert.equal(pack.dropped.some((item) => item.reason === "token_budget_exceeded"), false);
  assert.equal(pack.serializedPrompt.includes(longContent), false);
  assert.equal(pack.serializedPrompt.includes(pack.recentContext[0]?.compressedContent ?? ""), true);
  assert.equal(pack.serializedPrompt.length > 0, true);
});

test("assemble_context prefers memory summaries before truncating long content", async () => {
  const repository = new InMemoryContextEngineRepository();
  const longContent = "预算控制需要避免把超长长期记忆原文完整塞进上下文包。".repeat(40);

  await repository.saveLongTermMemory({
    memoryId: "ltm_summary_budget",
    theoryClass: "semantic",
    memoryType: "knowledge",
    content: longContent,
    factSummary: "预算控制",
    summary: "预算控制：超长记忆注入时优先使用摘要。",
    sourceRefs: [{ sourceRefId: "src_summary_budget", sourceType: "file", sourceId: "summary-budget-demo" }],
    sourceMemoryDataIds: [],
    entityIds: ["entity_summary_budget"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "summary_budget_test",
    matchedRules: ["test"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "预算控制",
    q: "预算控制",
    tokenBudget: 100
  });

  const item = pack.profileContext.find((entry) => entry.id === "ltm_summary_budget");
  assert.ok(item);
  assert.equal(item.compressedContent, "预算控制");
  assert.equal(pack.serializedPrompt.includes("预算控制"), true);
  assert.equal(pack.serializedPrompt.includes(longContent), false);
});

test("assemble_context uses semantic summaries instead of list-number fragments", async () => {
  const repository = new InMemoryContextEngineRepository();
  const meetingSummary = [
    "本次会议讨论了新一代Agent服务的开发需求，明确了其功能模块、技术架构，并确定了后续的开发方案与节奏。",
    "小结 1. 新一代Agent服务开发需求 本次会议明确了新一代Agent服务（代号V3）的整体开发需求，旨在为PC端、Web端提供一个Agent的基建服务。",
    "2. 智能场景与事件管理 系统将通过事件触发机制，为特定事件绑定一个Skill，以实现自动化响应。",
    "3. 技术架构与开发方案 架构设计将基于现有open-code进行重构和升级，以支持本次需求。"
  ].join(" ");

  await repository.saveLongTermMemory({
    memoryId: "ltm_semantic_compression",
    theoryClass: "semantic",
    memoryType: "knowledge",
    content: meetingSummary,
    sourceRefs: [{ sourceRefId: "src_semantic_compression", sourceType: "file", sourceId: "meeting-summary" }],
    sourceMemoryDataIds: [],
    entityIds: ["agent_service"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "semantic_compression_test",
    matchedRules: ["test"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "说明 Agent 服务开发需求",
    q: "Agent服务 开发需求",
    tokenBudget: 100
  });

  const item = pack.profileContext.find((entry) => entry.id === "ltm_semantic_compression");
  assert.ok(item);
  assert.match(item.compressedContent, /Agent服务|开发需求/u);
  assert.equal(/[，,、；;：:][。.!?]?$/u.test(item.compressedContent), false);
  assert.equal(item.compressedContent.includes("、。"), false);
  assert.equal(/(?:^|\s)小结\s*1\.\s*2\.\s*3/u.test(item.compressedContent), false);
  assert.equal(/(?:^|\s)(?:1|2|3)\.\s*$/u.test(item.compressedContent), false);
  assert.equal(pack.serializedPrompt.includes("小结 1. 2. 3."), false);
  assert.equal(pack.compressionSteps.some((step) => step.id === "ltm_semantic_compression" && step.reason === "local_semantic_summary"), true);
});

test("assemble_context compresses low priority memories first and preserves high value task evidence", async () => {
  const repository = new InMemoryContextEngineRepository();

  for (let index = 0; index < 6; index += 1) {
    await repository.saveLongTermMemory({
      memoryId: `ltm_low_priority_${index}`,
      theoryClass: "semantic",
      memoryType: "knowledge",
      content: `记忆引擎状态 低优先级历史噪声 ${index}。`.repeat(20),
      summary: `低优先级噪声${index}`,
      sourceRefs: [{ sourceRefId: `src_low_priority_${index}`, sourceType: "file", sourceId: `low-priority-${index}` }],
      sourceMemoryDataIds: [],
      entityIds: [],
      confidenceLevel: "medium",
      recallWeight: "low",
      solidifyReason: "low_priority_budget_test",
      matchedRules: ["test"],
      lifecycleStatus: "active",
      accessState: "visible"
    });
    await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[index]!);
  }

  await repository.saveLongTermMemory({
    memoryId: "ltm_high_value_task_evidence",
    theoryClass: "semantic",
    memoryType: "project_status",
    content: "当前任务：说明当前记忆引擎状态。高价值事实：记忆引擎保留来源引用，并展示短期记忆和长期记忆状态。".repeat(4),
    factSummary: "记忆引擎状态：保留来源引用并展示STM/LTM。",
    sourceRefs: [{ sourceRefId: "src_high_value_task", sourceType: "file", sourceId: "high-value-task-source" }],
    sourceMemoryDataIds: ["stm_high_value_task"],
    entityIds: ["context_engine"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "high_value_task_evidence",
    matchedRules: ["task_relevant", "source_required"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[6]!);

  const pack = await assembleContext(repository, {
    task: "为智能体组装上下文，用于说明当前记忆引擎状态。",
    q: "记忆引擎状态 来源引用 短期记忆 长期记忆",
    tokenBudget: 100
  });

  const selectedIds = pack.profileContext.map((item) => item.id);
  assert.equal(selectedIds.includes("ltm_high_value_task_evidence"), true);
  assert.equal(pack.serializedPrompt.includes("记忆引擎状态：保留来源引用并展示STM/LTM。"), true);
  assert.equal(pack.citations.some((item) => item.sourceRefId === "src_high_value_task"), true);
  assert.equal(pack.compressionSteps.some((step) => step.id.startsWith("ltm_low_priority_") && step.reason === "low_priority_budget_pressure"), true);
  assert.equal(pack.dropped.some((item) => item.id === "ltm_high_value_task_evidence"), false);
});

test("assemble_context does not summarize high value memories just because low priority items pressure the bucket", async () => {
  const repository = new InMemoryContextEngineRepository();
  const highValueContent = [
    "当前任务：为智能体组装上下文，用于说明当前记忆引擎状态。",
    "高价值事实：上下文引擎通过write_event摄入事件，保留来源引用，展示短期记忆和长期记忆状态。",
    "任务证据：当预算足够容纳高价值事实时，应保留详细事实、任务和来源，而不是直接退化成极短factSummary。",
    "实现约束：只有在高价值内容本身放不进剩余预算时，才使用摘要式压缩。"
  ].join("");

  for (let index = 0; index < 12; index += 1) {
    await repository.saveLongTermMemory({
      memoryId: `ltm_moderate_low_priority_${index}`,
      theoryClass: "semantic",
      memoryType: "knowledge",
      content: `记忆引擎状态 低优先级背景噪声 ${index}。`.repeat(80),
      summary: `低优先级背景${index}`,
      sourceRefs: [{ sourceRefId: `src_moderate_low_${index}`, sourceType: "file", sourceId: `moderate-low-${index}` }],
      sourceMemoryDataIds: [],
      entityIds: [],
      confidenceLevel: "medium",
      recallWeight: "low",
      solidifyReason: "moderate_budget_pressure_test",
      matchedRules: ["test"],
      lifecycleStatus: "active",
      accessState: "visible"
    });
    await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[index]!);
  }

  await repository.saveLongTermMemory({
    memoryId: "ltm_moderate_high_value_task",
    theoryClass: "semantic",
    memoryType: "project_status",
    content: highValueContent,
    factSummary: "记忆引擎状态：保留来源引用。",
    sourceRefs: [{ sourceRefId: "src_moderate_high_value", sourceType: "file", sourceId: "moderate-high-value-source" }],
    sourceMemoryDataIds: ["stm_moderate_high_value"],
    entityIds: ["context_engine"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "moderate_high_value_task",
    matchedRules: ["task_relevant", "source_required"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[12]!);

  const pack = await assembleContext(repository, {
    task: "为智能体组装上下文，用于说明当前记忆引擎状态。",
    q: "记忆引擎状态 来源引用 短期记忆 长期记忆 write_event",
    tokenBudget: 3000
  });

  const item = pack.profileContext.find((entry) => entry.id === "ltm_moderate_high_value_task");
  assert.ok(item);
  assert.equal(item.compressedContent, highValueContent);
  assert.equal(item.compressedContent.includes("write_event摄入事件"), true);
  assert.equal(item.compressedContent.includes("只有在高价值内容本身放不进剩余预算时"), true);
  assert.equal(pack.serializedPrompt.includes("任务证据：当预算足够容纳高价值事实时"), true);
  assert.equal(pack.compressionSteps.some((step) => step.id === "ltm_moderate_high_value_task" && step.action === "keep"), true);
  assert.equal(pack.compressionSteps.some((step) => step.id.startsWith("ltm_moderate_low_priority_") && step.reason === "low_priority_budget_pressure"), true);
});

test("assemble_context borrows unused context budget to improve long term memory utilization", async () => {
  const repository = new InMemoryContextEngineRepository();

  for (let index = 0; index < 4; index += 1) {
    await repository.saveLongTermMemory({
      memoryId: `ltm_budget_refill_${index}`,
      theoryClass: "semantic",
      memoryType: "project_status",
      content: `记忆引擎预算回填 场景${index}：当当前任务和最近上下文没有候选时，长期记忆应该借用空闲预算保留详细事实、任务证据和来源引用。`.repeat(8),
      sourceRefs: [{ sourceRefId: `src_budget_refill_${index}`, sourceType: "file", sourceId: `budget-refill-${index}` }],
      sourceMemoryDataIds: [`stm_budget_refill_${index}`],
      entityIds: ["context_engine"],
      confidenceLevel: "high",
      recallWeight: "high",
      solidifyReason: "budget_refill_test",
      matchedRules: ["task_relevant"],
      lifecycleStatus: "active",
      accessState: "visible"
    });
    await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[index]!);
  }

  const pack = await assembleContext(repository, {
    task: "说明记忆引擎预算回填",
    q: "记忆引擎预算回填 详细事实 来源引用",
    tokenBudget: 3000
  });

  assert.equal(pack.profileContext.length, 4);
  assert.equal(pack.tokenBudget.allocations.profile > pack.tokenBudget.plan.profileContext, true);
  assert.equal(pack.tokenBudget.used > pack.tokenBudget.plan.profileContext, true);
  assert.equal(pack.dropped.some((item) => item.reason === "token_budget_exceeded"), false);
});

test("assemble_context uses LLM summaries for assembly compression when enabled", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(64);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "LLM摘要：保留预算控制事实和来源引用。"
            })
          }
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const longContent = "预算控制需要在组装阶段对超长记忆做摘要式压缩，同时保留高价值事实、当前任务和来源引用。".repeat(40);
    await repository.saveLongTermMemory({
      memoryId: "ltm_llm_context_summary",
      theoryClass: "semantic",
      memoryType: "knowledge",
      content: longContent,
      sourceRefs: [{ sourceRefId: "src_llm_context_summary", sourceType: "file", sourceId: "llm-context-summary" }],
      sourceMemoryDataIds: ["stm_llm_context_summary"],
      entityIds: ["context_engine"],
      confidenceLevel: "high",
      recallWeight: "high",
      solidifyReason: "llm_context_summary_test",
      matchedRules: ["test"],
      lifecycleStatus: "active",
      accessState: "visible"
    });
    await refreshLongTermMemoryIndex(
      repository,
      repository.getDebugSnapshot().longTermMemories[0]!,
      embeddingClient
    );

    const pack = await assembleContext(repository, {
      task: "预算控制",
      q: "预算控制 来源引用",
      tokenBudget: 100,
      embeddingClient,
      llmCompression: true,
      llm: {
        apiKey: "test-key",
        baseUrl: "https://llm.example/v1",
        model: "test-model"
      }
    });

    const item = pack.profileContext.find((entry) => entry.id === "ltm_llm_context_summary");
    assert.ok(item);
    assert.equal(item.compressedContent, "LLM摘要：保留预算控制事实和来源引用。");
    assert.equal(pack.compressionSteps.some((step) => step.id === "ltm_llm_context_summary" && step.reason === "llm_context_summary"), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://llm.example/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assemble_context uses only STM and LTM with temporal metadata and concrete citations", async () => {
  const repository = new InMemoryContextEngineRepository();
  const request = contextPackConversationRequest({
    rowId: "conversation_message_pack_temporal",
    messageId: "msg_pack_temporal",
    sessionId: "session_pack_temporal",
    content: "我计划 8 月 1 日去深圳",
    createdAt: "2026-07-23T07:30:00.000Z"
  });
  await repository.commitConversationIngestion(request);
  const sourceRef = {
    sourceRefId: request.messages[0]!.conversationMessageRowId,
    sourceType: "conversation_message",
    sourceId: request.messages[0]!.conversationMessageRowId,
    metadata: {
      messageId: request.messages[0]!.messageId,
      sessionId: request.messages[0]!.sessionId,
      ingestionId: request.messages[0]!.ingestionId,
      revision: request.messages[0]!.revision
    }
  };

  await repository.saveShortTermMemory({
    memoryDataId: "stm_pack_temporal",
    ...testStmScope,
    memoryDataType: "conversation_fact",
    content: "深圳行程：用户计划于 8 月 1 日出发",
    sourceFactIds: ["fact_pack_temporal"],
    sourceRefs: [sourceRef],
    entityIds: ["shenzhen"],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "temporal_pack_test",
    matchedRules: ["conversation_fact"],
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
    evidenceTimeStart: "2026-07-23T07:30:00.000Z",
    evidenceTimeEnd: "2026-07-23T07:30:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-07-31T16:00:00.000Z",
    validTimeConfidence: "high"
  });
  await repository.saveLongTermMemory({
    memoryId: "ltm_pack_temporal",
    theoryClass: "prospective",
    memoryType: "prospective",
    content: "长期行程记忆：深圳出行日期为 8 月 1 日",
    sourceRefs: [sourceRef],
    sourceMemoryDataIds: ["stm_pack_temporal"],
    entityIds: ["shenzhen"],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "temporal_pack_test",
    matchedRules: ["prospective"],
    lifecycleStatus: "active",
    accessState: "visible",
    evidenceTimeStart: "2026-07-23T07:30:00.000Z",
    evidenceTimeEnd: "2026-07-23T07:30:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-07-31T16:00:00.000Z",
    validTimeConfidence: "high"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "我去深圳的计划是什么？",
    q: "深圳",
    tenantId: "local",
    principalId: "debug-user",
    referenceTime: "2026-07-25T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    tokenBudget: 1000
  });

  assert.equal(pack.temporal.timezone, "Asia/Shanghai");
  assert.equal(pack.temporal.referenceTime, "2026-07-25T00:00:00.000Z");
  assert.equal(pack.recentContext.length, 1);
  const item = pack.recentContext[0]!;
  assert.equal(item.id, "stm_pack_temporal");
  assert.equal(item.layer, "stm");
  assert.deepEqual(item.sourceMessageIds, ["msg_pack_temporal"]);
  assert.equal(item.sourceRefs[0]?.sourceType, "conversation_message");
  assert.deepEqual(item.factIds, ["fact_pack_temporal"]);
  assert.deepEqual(new Set(item.memoryIds), new Set(["stm_pack_temporal", "ltm_pack_temporal"]));
  assert.equal(item.temporal.evidenceTimeStart, "2026-07-23T07:30:00.000Z");
  assert.equal(item.temporal.validTimeStart, "2026-07-31T16:00:00.000Z");
  assert.deepEqual(pack.profileContext, []);
  assert.equal(pack.dropped.filter((entry) => entry.reason === `pack:duplicate_of:${item.id}`).length, 1);
  assert.equal(pack.citations[0]?.sourceType, "conversation_message");
  assert.match(pack.serializedPrompt, /【时间范围】.*Asia\/Shanghai/u);
  assert.match(pack.serializedPrompt, /事实时间：2026-08-01 00:00/u);
  assert.match(pack.serializedPrompt, /消息时间：2026-07-23 15:30/u);
  assert.match(pack.serializedPrompt, /来源：msg_pack_temporal/u);
});

test("assemble_context excludes raw conversation evidence when no STM or LTM exists", async () => {
  const repository = new InMemoryContextEngineRepository();
  const older = contextPackConversationRequest({
    rowId: "conversation_message_pack_older",
    messageId: "msg_pack_older",
    sessionId: "session_pack_older",
    content: "项目进展：旧消息",
    createdAt: "2026-07-22T02:00:00.000Z"
  });
  const newer = contextPackConversationRequest({
    rowId: "conversation_message_pack_newer",
    messageId: "msg_pack_newer",
    sessionId: "session_pack_newer",
    content: "项目进展：新消息",
    createdAt: "2026-07-24T02:00:00.000Z"
  });
  await repository.commitConversationIngestion(older);
  await repository.commitConversationIngestion(newer);

  const pack = await assembleContext(repository, {
    task: "项目进展",
    q: "项目进展",
    tenantId: "local",
    principalId: "debug-user",
    referenceTime: "2026-07-25T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    tokenBudget: 500
  });

  assert.deepEqual(pack.recentContext, []);
  assert.deepEqual(pack.profileContext, []);
  assert.equal(pack.serializedPrompt.includes("项目进展：旧消息"), false);
  assert.equal(pack.serializedPrompt.includes("项目进展：新消息"), false);
});

test("assemble_context compression preserves temporal and source identifiers", async () => {
  const repository = new InMemoryContextEngineRepository();
  const longContent = "压缩时间元数据时会保留消息时间、事实时间和具体来源。".repeat(60);
  await repository.saveLongTermMemory({
    memoryId: "ltm_pack_compression_temporal",
    theoryClass: "semantic",
    memoryType: "knowledge",
    content: longContent,
    factSummary: "压缩后仍保留时间和来源。",
    sourceRefs: [{
      sourceRefId: "conversation_message_pack_compression",
      sourceType: "conversation_message",
      sourceId: "conversation_message_pack_compression",
      metadata: { messageId: "msg_pack_compression" }
    }],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "temporal_compression_test",
    matchedRules: ["test"],
    lifecycleStatus: "active",
    accessState: "visible",
    evidenceTimeStart: "2026-07-23T07:30:00.000Z",
    evidenceTimeEnd: "2026-07-23T07:30:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-07-31T16:00:00.000Z",
    validTimeConfidence: "medium"
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const pack = await assembleContext(repository, {
    task: "压缩时间元数据",
    q: "压缩时间元数据",
    referenceTime: "2026-07-25T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    tokenBudget: 100
  });
  const item = pack.profileContext[0]!;

  assert.equal(item.compressedContent, "压缩后仍保留时间和来源。");
  assert.deepEqual(item.sourceMessageIds, ["msg_pack_compression"]);
  assert.equal(item.temporal.evidenceTimeConfidence, "high");
  assert.equal(item.temporal.validTimeConfidence, "medium");
  assert.match(pack.serializedPrompt, /消息时间：2026-07-23 15:30/u);
  assert.match(pack.serializedPrompt, /事实时间：2026-08-01 00:00/u);
});

test("refreshShortTermMemoryIndex counts cjk text conservatively", async () => {
  const repository = new InMemoryContextEngineRepository();
  const content = "中文内容没有空格但仍然会消耗大量模型token";

  await repository.saveShortTermMemory({
    memoryDataId: "stm_cjk_token_count",
    ...testStmScope,
    memoryDataType: "manual_memory_event",
    content,
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_cjk_token_count", sourceType: "file", sourceId: "cjk-token-count" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "medium",
    admissionResult: "write_high_priority",
    admissionReason: "token_count_test",
    matchedRules: ["parser_adapter"],
    admissionSignals: {
      importance: "high",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });

  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);

  const indexEntry = repository.getDebugSnapshot().indexEntries.find((item) => item.ownerId === "stm_cjk_token_count");
  assert.ok(indexEntry);
  const cjkCharCount = content.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  assert.equal(indexEntry.tokenCount >= cjkCharCount, true);
  assert.equal(indexEntry.tokenCount > 2, true);
});

test("refreshShortTermMemoryIndex indexes source and normalized claims", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveFactItem({
    factId: "fact_bike_expense",
    factType: "profile",
    factText: "用户更换自行车链条花费25美元。",
    sourceClaim: "I replaced the bike chain and it cost me $25.",
    normalizedClaim: "用户更换自行车链条花费25美元",
    linkedEventIds: ["event_bike_expense"],
    linkedSegmentIds: ["segment_bike_expense"],
    linkedSourceRefs: [{ sourceRefId: "src_bike_expense", sourceType: "agent_memory", sourceId: "bike-expense" }],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2023-04-20T08:00:00.000Z",
    validTimeStart: "2023-04-20T08:00:00.000Z",
    timeBasis: "absolute",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  });
  await repository.saveShortTermMemory({
    memoryDataId: "stm_bike_expense",
    ...testStmScope,
    memoryDataType: "event",
    content: "用户更换自行车链条花费25美元。",
    sourceFactIds: ["fact_bike_expense"],
    sourceRefs: [{ sourceRefId: "src_bike_expense", sourceType: "agent_memory", sourceId: "bike-expense" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
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
  });

  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);

  const indexEntry = repository.getDebugSnapshot().indexEntries.find((item) => item.ownerId === "stm_bike_expense");
  assert.match(indexEntry?.content ?? "", /I replaced the bike chain/u);
  assert.match(indexEntry?.content ?? "", /用户更换自行车链条花费25美元/u);
});

test("keyword scoring uses indexed search content instead of memory content", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(512);
  await repository.saveFactItem({
    factId: "fact_keyword_index_content",
    factType: "event",
    factText: "用户更换自行车链条花费25美元。",
    sourceClaim: "I replaced the bike chain and it cost me $25.",
    normalizedClaim: "用户更换自行车链条花费25美元",
    linkedEventIds: ["event_keyword_index_content"],
    linkedSegmentIds: ["segment_keyword_index_content"],
    linkedSourceRefs: [{ sourceRefId: "src_keyword_index_content", sourceType: "agent_memory", sourceId: "keyword-index-content" }],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2023-04-20T08:00:00.000Z",
    validTimeStart: "2023-04-20T08:00:00.000Z",
    timeBasis: "absolute",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  });
  await repository.saveShortTermMemory({
    memoryDataId: "stm_keyword_index_content",
    ...testStmScope,
    memoryDataType: "event",
    content: "用户更换自行车链条花费25美元。",
    sourceFactIds: ["fact_keyword_index_content"],
    sourceRefs: [{ sourceRefId: "src_keyword_index_content", sourceType: "agent_memory", sourceId: "keyword-index-content" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
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
  });

  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!, embeddingClient);

  const response = await searchContext(repository, {
    q: "I replaced the bike chain",
    layer: "stm",
    sourceIds: ["keyword-index-content"]
  }, { recordShadow: false, embeddingClient });
  assert.equal(response.results[0]?.scoreBreakdown.keyword, 0.7);
});

test("STM and LTM use the same keyword coverage score", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(512);
  await repository.saveShortTermMemory({
    memoryDataId: "stm_keyword_parity",
    ...testStmScope,
    memoryDataType: "event",
    content: "father sent a short term gift",
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: "src_stm_keyword_parity", sourceType: "file", sourceId: "keyword-parity" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
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
  });
  await repository.saveLongTermMemory({
    memoryId: "ltm_keyword_parity",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "father sent a long term gift",
    sourceRefs: [{ sourceRefId: "src_ltm_keyword_parity", sourceType: "file", sourceId: "keyword-parity" }],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: ["test"],
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!, embeddingClient);
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!, embeddingClient);

  const response = await searchContext(repository, {
    q: "father unknown",
    sourceIds: ["keyword-parity"]
  }, { recordShadow: false, embeddingClient });
  const stm = response.results.find((item) => item.id === "stm_keyword_parity");
  const ltm = response.results.find((item) => item.id === "ltm_keyword_parity");

  assert.ok(stm);
  assert.ok(ltm);
  assert.equal(stm.scoreBreakdown.keyword, ltm.scoreBreakdown.keyword);
  assert.ok(stm.scoreBreakdown.keyword > 0);
  assert.ok(stm.scoreBreakdown.keyword < 0.7);
});

function contextPackConversationRequest(input: {
  rowId: string;
  messageId: string;
  sessionId: string;
  content: string;
  createdAt: string;
}): CommitConversationIngestionRequest {
  const now = "2026-07-25T00:00:00.000Z";
  const ingestionId = `ingestion_${input.messageId}`;
  const documentId = `document_${input.messageId}`;
  const ingestion: ConversationIngestionRecord = {
    ingestionId,
    idempotencyKey: `idempotency_${input.messageId}`,
    documentSha256: `sha_${input.messageId}`,
    batchId: `batch_${input.messageId}`,
    sessionId: input.sessionId,
    sourceApp: "agent",
    tenantId: "local",
    principalId: "debug-user",
    visibility: "private",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    temporalMode: "extended",
    committedCursor: "cursor-1",
    firstSequence: 1,
    lastSequence: 1,
    documentStatus: "raw_committed",
    processingStatus: "queued",
    processingStage: "not_started",
    processingMode: "async",
    progressPercent: 0,
    messageCounts: { received: 1, inserted: 0, deduplicated: 0, revised: 0, deleted: 0 },
    layerCounts: emptyContextPackLayerCounts(),
    retry: { attempt: 0, maxAttempts: 3, retryable: true },
    createdAt: now,
    committedAt: now,
    updatedAt: now
  };
  const message: ConversationMessageRecord = {
    conversationMessageRowId: input.rowId,
    ingestionId,
    documentId,
    sessionId: input.sessionId,
    batchId: ingestion.batchId,
    sourceApp: ingestion.sourceApp,
    tenantId: ingestion.tenantId,
    principalId: ingestion.principalId,
    messageId: input.messageId,
    sequence: 1,
    role: "user",
    createdAt: input.createdAt,
    status: "completed",
    contentType: "text/markdown",
    content: input.content,
    branchId: "main",
    revision: 1,
    operation: "append",
    contentSha256: `content_sha_${input.messageId}`,
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    timeConfidence: "high",
    storedAt: now
  };
  return {
    ingestion,
    document: {
      documentId,
      ingestionId,
      schemaVersion: "context-conversation-md.v3",
      sha256: ingestion.documentSha256,
      byteSize: input.content.length,
      rawMarkdown: input.content,
      createdAt: now
    },
    messages: [message],
    cursor: {
      tenantId: ingestion.tenantId,
      sourceApp: ingestion.sourceApp,
      principalId: ingestion.principalId,
      sessionId: input.sessionId,
      committedCursor: ingestion.committedCursor,
      lastSequence: 1,
      lastIngestionId: ingestionId,
      updatedAt: now
    }
  };
}

function emptyContextPackLayerCounts() {
  return {
    messages: 0,
    segments: 0,
    evidenceGroups: 0,
    factCandidates: 0,
    facts: 0,
    shortTermMemories: 0,
    timelineFacts: 0,
    longTermMemories: 0,
    factPending: 0,
    rejected: 0,
    sensitivePendingConfirmation: 0
  };
}
