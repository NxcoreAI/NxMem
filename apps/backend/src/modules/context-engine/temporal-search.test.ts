import test from "node:test";
import assert from "node:assert/strict";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { searchContext } from "./search-context.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import type { LongTermMemory, MemoryEvent, ParsedSegment, ShortTermMemory } from "./domain.js";

const scope = {
  tenantId: "tenant-temporal",
  principalId: "principal-temporal",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z"
};

test("yesterday evidence query resolves local day and recalls parsed evidence", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveSegment(repository, "segment_yesterday", "2026-07-24T04:00:00.000Z", "昨天讨论了深圳行程", "file-yesterday");
  await saveSegment(repository, "segment_today", "2026-07-24T18:00:00.000Z", "今天讨论了深圳行程", "file-today");

  const response = await searchContext(repository, {
    q: "昨天聊了什么",
    layer: "evidence",
    tenantId: scope.tenantId,
    principalId: scope.principalId,
    referenceTime: "2026-07-25T04:00:00.000Z",
    timezone: "Asia/Shanghai",
    limit: 10
  });

  assert.deepEqual(response.temporal.range, {
    startTime: "2026-07-23T16:00:00.000Z",
    endTime: "2026-07-24T16:00:00.000Z"
  });
  assert.equal(response.temporal.basis, "evidence");
  assert.deepEqual(response.results.map((item) => item.id), ["segment_yesterday"]);
  assert.equal(response.results[0]?.temporal.matchedBasis, "evidence");
  assert.equal(response.results[0]?.temporal.evidenceTimeConfidence, "high");
  assert.equal(response.results[0]?.scoreBreakdown.recency, 0.6);
  assert.equal(response.total, 1);
});

test("explicit valid range filters known outside valid times but retains memories without valid time", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveLongTerm(repository, "ltm_inside", "深圳计划", {
    validTimeStart: "2026-08-01T00:00:00.000Z",
    validTimeConfidence: "high"
  });
  await saveLongTerm(repository, "ltm_outside", "深圳计划", {
    validTimeStart: "2026-09-01T00:00:00.000Z",
    validTimeConfidence: "high"
  });
  await saveLongTerm(repository, "ltm_missing", "深圳计划缺少事件时间", {});

  const response = await searchContext(repository, {
    q: "昨天聊过深圳",
    layer: "ltm",
    timeRange: {
      startTime: "2026-08-01T00:00:00.000Z",
      endTime: "2026-08-02T00:00:00.000Z",
      basis: "valid"
    },
    referenceTime: "2026-08-01T12:00:00.000Z",
    timezone: "Asia/Shanghai",
    limit: 10,
    offset: 0
  });

  assert.equal(response.temporal.source, "explicit");
  assert.deepEqual(new Set(response.results.map((item) => item.id)), new Set(["ltm_inside", "ltm_missing"]));
  assert.equal(response.total, 2);
  assert.equal(response.dropped.some((item) => item.id === "ltm_outside" && item.reason === "outside_valid_time_range"), true);
  assert.equal(response.dropped.some((item) => item.id === "ltm_missing"), false);
});

test("auto basis filters by valid time and does not substitute evidence time when valid time is missing", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveLongTerm(repository, "ltm_evidence_match", "自动 basis 深圳 evidence", {
    evidenceTimeStart: "2026-07-24T02:00:00.000Z",
    evidenceTimeEnd: "2026-07-24T02:00:00.000Z",
    evidenceTimeConfidence: "high"
  });
  await saveLongTerm(repository, "ltm_valid_match", "自动 basis 深圳 valid", {
    validTimeStart: "2026-07-24T02:00:00.000Z",
    validTimeConfidence: "high"
  });

  const response = await searchContext(repository, {
    q: "深圳",
    layer: "ltm",
    referenceTime: "2026-07-24T12:00:00.000Z",
    timezone: "Asia/Shanghai",
    timeRange: {
      startTime: "2026-07-24T00:00:00.000Z",
      endTime: "2026-07-25T00:00:00.000Z"
    }
  });

  assert.equal(response.temporal.basis, "auto");
  assert.equal(response.results.length, 2);
  assert.equal(response.results.find((item) => item.id === "ltm_evidence_match")?.temporal.matchedBasis, undefined);
  assert.equal(response.results.find((item) => item.id === "ltm_valid_match")?.temporal.matchedBasis, "valid");
});

test("ambiguous relative time is a soft ranking signal and does not hard-filter candidates", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveLongTerm(repository, "ltm_previous_calendar_month", "plant acquired last month", {
    validTimeStart: "2026-06-15T00:00:00.000Z",
    validTimeConfidence: "high"
  });
  await saveLongTerm(repository, "ltm_recent_rolling_month", "plant acquired two weeks ago", {
    validTimeStart: "2026-07-11T00:00:00.000Z",
    validTimeConfidence: "high"
  });

  const response = await searchContext(repository, {
    q: "How many plants did I acquire in the last month?",
    layer: "ltm",
    referenceTime: "2026-07-25T12:00:00.000Z",
    timezone: "Asia/Shanghai",
    limit: 10
  });

  assert.equal(response.temporal.source, "deterministic");
  assert.equal(response.results.length, 2);
  assert.equal(response.dropped.some((item) => item.reason.startsWith("outside_")), false);
});

test("queries without temporal intent keep the old unbounded temporal behavior", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveLongTerm(repository, "ltm_no_time", "深圳行程", {
    validTimeStart: "2020-01-01T00:00:00.000Z",
    validTimeConfidence: "high"
  });
  const response = await searchContext(repository, {
    q: "深圳行程",
    layer: "ltm",
    referenceTime: "2026-07-25T00:00:00.000Z"
  });
  assert.equal(response.temporal.range, undefined);
  assert.equal(response.temporal.source, "none");
  assert.equal(response.results[0]?.id, "ltm_no_time");
});

test("valid-time intent without a resolvable range selects valid recency without hard filtering", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveLongTerm(repository, "ltm_when", "我计划去深圳", {
    evidenceTimeStart: "2025-01-01T00:00:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-08-01T02:00:00.000Z",
    validTimeConfidence: "high"
  });
  const response = await searchContext(repository, {
    q: "我什么时候去深圳",
    layer: "ltm",
    referenceTime: "2026-08-01T12:00:00.000Z"
  });
  assert.equal(response.temporal.range, undefined);
  assert.equal(response.temporal.basis, "valid");
  assert.equal(response.results[0]?.temporal.matchedBasis, "valid");
  assert.equal(response.results[0]?.scoreBreakdown.recency, 0.8);
});

test("semantic resolver failure records low confidence and does not apply guessed hard filtering", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveLongTerm(repository, "ltm_semantic_failure", "之前那次深圳讨论", {
    evidenceTimeStart: "2020-01-01T00:00:00.000Z",
    evidenceTimeConfidence: "low"
  });
  const response = await searchContext(repository, {
    q: "之前那次深圳讨论",
    layer: "ltm",
    referenceTime: "2026-08-01T12:00:00.000Z"
  }, {
    semanticResolver: {
      resolve() {
        throw new Error("unavailable");
      }
    }
  });
  assert.equal(response.temporal.range, undefined);
  assert.equal(response.temporal.confidence, "low");
  assert.equal(response.temporal.resolutionError, "semantic_resolver_failed");
  assert.equal(response.results[0]?.id, "ltm_semantic_failure");
});

test("STM recency uses propagated evidence time instead of index refresh time", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveShortTerm(repository, "stm_old_evidence", "STM recency old", "2020-01-01T00:00:00.000Z");
  await saveShortTerm(repository, "stm_recent_evidence", "STM recency recent", "2026-07-25T10:00:00.000Z");
  const response = await searchContext(repository, {
    q: "STM recency",
    layer: "stm",
    referenceTime: "2026-07-25T12:00:00.000Z"
  });
  assert.equal(response.results.find((item) => item.id === "stm_old_evidence")?.scoreBreakdown.recency, 0.3);
  assert.equal(response.results.find((item) => item.id === "stm_recent_evidence")?.scoreBreakdown.recency, 0.8);
});

test("temporal filtering happens before deduplication and pagination, and recency uses content time", async () => {
  const repository = new InMemoryContextEngineRepository();
  await saveLongTerm(repository, "ltm_recent", "分页深圳 recent", {
    evidenceTimeStart: "2026-07-25T10:00:00.000Z",
    evidenceTimeEnd: "2026-07-25T10:00:00.000Z",
    evidenceTimeConfidence: "high"
  });
  await saveLongTerm(repository, "ltm_middle", "分页深圳 middle", {
    evidenceTimeStart: "2026-07-24T10:00:00.000Z",
    evidenceTimeEnd: "2026-07-24T10:00:00.000Z",
    evidenceTimeConfidence: "high"
  });
  await saveLongTerm(repository, "ltm_old", "分页深圳 old", {
    evidenceTimeStart: "2026-07-23T10:00:00.000Z",
    evidenceTimeEnd: "2026-07-23T10:00:00.000Z",
    evidenceTimeConfidence: "high"
  });

  const response = await searchContext(repository, {
    q: "分页深圳",
    layer: "ltm",
    timeRange: {
      startTime: "2026-07-23T00:00:00.000Z",
      endTime: "2026-07-26T00:00:00.000Z",
      basis: "evidence"
    },
    referenceTime: "2026-07-25T12:00:00.000Z",
    limit: 1,
    offset: 1
  });

  assert.equal(response.total, 3);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.temporal.evidenceTimeStart, "2026-07-24T10:00:00.000Z");
  assert.equal(response.results[0]?.scoreBreakdown.recency, 0.6);
});

async function saveLongTerm(
  repository: InMemoryContextEngineRepository,
  id: string,
  content: string,
  temporal: {
    evidenceTimeStart?: string;
    evidenceTimeEnd?: string;
    evidenceTimeConfidence?: "low" | "medium" | "high";
    validTimeStart?: string;
    validTimeEnd?: string;
    validTimeConfidence?: "low" | "medium" | "high";
  }
) {
  const memory: LongTermMemory = {
    memoryId: id,
    theoryClass: "episodic",
    memoryType: "event",
    content,
    sourceRefs: [{ sourceRefId: `${id}_source`, sourceType: "file", sourceId: `${id}_source` }],
    sourceMemoryDataIds: [],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "temporal test",
    matchedRules: ["test"],
    lifecycleStatus: "active",
    accessState: "visible",
    ...temporal
  };
  await repository.saveLongTermMemory(memory);
  await refreshLongTermMemoryIndex(repository, memory);
}

async function saveSegment(
  repository: InMemoryContextEngineRepository,
  segmentId: string,
  eventTime: string,
  content: string,
  sourceId: string
) {
  const event: MemoryEvent = {
    eventId: `event_${segmentId}`,
    eventType: "file_ingested",
    eventSummary: content,
    eventTime,
    sourceApp: "drive",
    sourceId,
    dataSource: { sourceApp: "drive", sourceId, sourceType: "file" },
    permissionSnapshot: {
      snapshotId: `permission_${segmentId}`,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      sourceAclVersion: "1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: `item_${segmentId}`,
      type: "document",
      format: "text/plain",
      content,
      sourceRefs: [],
      timeBasis: "source_time",
      timeConfidence: "high"
    }]
  };
  const segment: ParsedSegment = {
    segmentId,
    eventId: event.eventId,
    modality: "document",
    content,
    status: "parsed",
    confidence: "high",
    dataSource: { sourceApp: "drive", sourceId, sourceType: "file" }
  };
  await repository.saveMemoryEvent(event);
  await repository.saveParsedSegment(segment);
}

async function saveShortTerm(
  repository: InMemoryContextEngineRepository,
  memoryDataId: string,
  content: string,
  evidenceTimeStart: string
) {
  const memory: ShortTermMemory = {
    memoryDataId,
    ...scope,
    memoryDataType: "event",
    memoryType: "event",
    content,
    sourceFactIds: [],
    sourceRefs: [{ sourceRefId: `${memoryDataId}_source`, sourceType: "file", sourceId: `${memoryDataId}_source` }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "temporal test",
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
    lifecycleStatus: "active",
    accessState: "visible",
    evidenceTimeStart,
    evidenceTimeEnd: evidenceTimeStart,
    evidenceTimeConfidence: "high"
  };
  await repository.saveShortTermMemory(memory);
  await refreshShortTermMemoryIndex(repository, memory);
}
