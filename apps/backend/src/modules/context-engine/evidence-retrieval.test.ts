import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evidenceOwnerKey,
  materializeEvidenceForOwners
} from "./evidence-retrieval.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { searchContext } from "./search-context.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";
import type {
  FactItem,
  LongTermMemory,
  MemoryEvent,
  ParsedSegment,
  ShortTermMemory,
  SourceRef
} from "./domain.js";
import type {
  CommitConversationIngestionRequest,
  ConversationIngestionRecord,
  ConversationMessageRecord
} from "./conversation-ingestion/persistence.js";

const messageTime = "2026-07-23T07:30:00.000Z";
const segmentTime = "2026-07-22T02:00:00.000Z";

test("evidence repository searches canonical conversation messages with owner, source, text and time filters", async () => {
  const repository = new InMemoryContextEngineRepository();
  const request = conversationCommitRequest({
    rowId: "conversation_message_row_allowed",
    messageId: "msg_allowed",
    tenantId: "tenant-a",
    principalId: "principal-a",
    sourceApp: "agent-a",
    sessionId: "session-a",
    content: "我 8 月 1 日去深圳",
    createdAt: messageTime
  });
  await repository.commitConversationIngestion(request);

  const matched = await repository.findEvidenceCandidates({
    tenantId: "tenant-a",
    principalId: "principal-a",
    sourceIds: ["conversation_message_row_allowed"],
    text: "深圳",
    evidenceTimeStart: "2026-07-23T00:00:00.000Z",
    evidenceTimeEnd: "2026-07-24T00:00:00.000Z"
  });
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.evidenceType, "conversation_message");
  assert.equal(matched[0]?.content, "我 8 月 1 日去深圳");
  assert.equal(matched[0]?.evidenceTimeStart, messageTime);
  assert.equal(matched[0]?.evidenceTimeConfidence, "high");
  assert.deepEqual(matched[0]?.sourceRefs, [{
    sourceRefId: "conversation_message_row_allowed",
    sourceType: "conversation_message",
    sourceId: "conversation_message_row_allowed",
    metadata: {
      messageId: "msg_allowed",
      sessionId: "session-a",
      ingestionId: request.ingestion.ingestionId,
      revision: 1
    }
  }]);

  assert.equal((await repository.findEvidenceCandidates({
    tenantId: "tenant-b",
    principalId: "principal-a",
    text: "深圳"
  })).length, 0);
  assert.equal((await repository.findEvidenceCandidates({
    tenantId: "tenant-a",
    principalId: "principal-a",
    sourceIds: ["another-source"],
    text: "深圳"
  })).length, 0);
  assert.equal((await repository.findEvidenceCandidates({
    tenantId: "tenant-a",
    principalId: "principal-a",
    text: "深圳",
    evidenceTimeStart: "2026-07-24T00:00:00.000Z",
    evidenceTimeEnd: "2026-07-25T00:00:00.000Z"
  })).length, 0);
});

test("parsed data lake evidence inherits event time, permission and concrete segment citation", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = dataLakeEvent({ visibility: "team" });
  const segment = dataLakeSegment();
  await repository.saveMemoryEvent(event);
  await repository.saveParsedSegment(segment);

  const matched = await repository.findEvidenceCandidates({
    tenantId: "tenant-a",
    principalId: "principal-a",
    sourceIds: [segment.segmentId],
    allowedVisibilities: ["team"],
    text: "预算"
  });
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.evidenceType, "parsed_segment");
  assert.equal(matched[0]?.evidenceTimeStart, segmentTime);
  assert.equal(matched[0]?.evidenceTimeConfidence, "high");
  assert.equal(matched[0]?.sourceRefs[0]?.sourceType, "parsed_segment");
  assert.equal(matched[0]?.sourceRefs[0]?.sourceId, segment.segmentId);
  assert.equal(matched[0]?.sourceRefs.some((ref) => ref.sourceId === "file-budget"), true);

  assert.equal((await repository.findEvidenceCandidates({
    tenantId: "tenant-a",
    principalId: "principal-a",
    allowedVisibilities: ["private"],
    text: "预算"
  })).length, 0);
});

test("Fact, STM and LTM batch materialization follows source refs without N+1 reads", async () => {
  const repository = new CountingEvidenceRepository();
  const request = conversationCommitRequest({
    rowId: "conversation_message_row_materialize",
    messageId: "msg_materialize",
    tenantId: "tenant-a",
    principalId: "principal-a",
    sourceApp: "agent-a",
    sessionId: "session-materialize",
    content: "原始消息证据",
    createdAt: messageTime
  });
  await repository.commitConversationIngestion(request);
  const event = dataLakeEvent();
  const segment = dataLakeSegment();
  await repository.saveMemoryEvent(event);
  await repository.saveParsedSegment(segment);

  const messageRef = conversationSourceRef(request.messages[0]!);
  const segmentRef: SourceRef = {
    sourceRefId: segment.segmentId,
    sourceType: "parsed_segment",
    sourceId: segment.segmentId
  };
  const fact = testFact([messageRef, segmentRef], [segment.segmentId]);
  const stm = testStm(fact, [messageRef]);
  const ltm = testLtm(stm);
  await repository.saveFactItem(fact);
  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(ltm);

  const owners = [
    { layer: "fact" as const, owner: fact },
    { layer: "stm" as const, owner: stm },
    { layer: "ltm" as const, owner: ltm }
  ];
  const materialized = await materializeEvidenceForOwners(repository, owners);
  for (const owner of owners) {
    const evidence = materialized.get(evidenceOwnerKey(owner)) ?? [];
    assert.deepEqual(new Set(evidence.map((item) => item.evidenceType)), new Set([
      "conversation_message",
      "parsed_segment"
    ]));
  }
  assert.deepEqual(repository.batchReads, {
    shortTermMemories: 1,
    facts: 1,
    messages: 1,
    segments: 1,
    events: 1
  });
});

test("search_context layer=all recalls only STM and LTM while explicit evidence stays isolated", async () => {
  const repository = new InMemoryContextEngineRepository();
  const request = conversationCommitRequest({
    rowId: "conversation_message_row_all",
    messageId: "msg_all",
    tenantId: "tenant-a",
    principalId: "principal-a",
    sourceApp: "agent-a",
    sessionId: "session-all",
    content: "深圳行程原始消息",
    createdAt: messageTime
  });
  await repository.commitConversationIngestion(request);
  const messageRef = conversationSourceRef(request.messages[0]!);
  const fact = testFact([messageRef], []);
  const stm = {
    ...testStm(fact, [messageRef]),
    content: "深圳行程短期记忆"
  };
  const ltm = {
    ...testLtm(stm),
    content: "深圳行程长期记忆",
    sourceRefs: [messageRef]
  };
  await repository.saveFactItem(fact);
  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(ltm);
  await refreshShortTermMemoryIndex(repository, stm);
  await refreshLongTermMemoryIndex(repository, ltm);

  const all = await searchContext(repository, {
    q: "深圳行程",
    layer: "all",
    tenantId: "tenant-a",
    principalId: "principal-a"
  });
  assert.deepEqual(new Set(all.results.map((item) => item.layer)), new Set(["stm", "ltm"]));

  const stmOnly = await searchContext(repository, { q: "深圳行程", layer: "stm" });
  const ltmOnly = await searchContext(repository, { q: "深圳行程", layer: "ltm" });
  const evidenceOnly = await searchContext(repository, { q: "深圳行程", layer: "evidence" });
  assert.deepEqual(new Set(stmOnly.results.map((item) => item.layer)), new Set(["stm"]));
  assert.deepEqual(new Set(ltmOnly.results.map((item) => item.layer)), new Set(["ltm"]));
  assert.deepEqual(new Set(evidenceOnly.results.map((item) => item.layer)), new Set(["evidence"]));
  assert.equal(evidenceOnly.results[0]?.sourceRefs[0]?.sourceType, "conversation_message");
  assert.equal(evidenceOnly.results[0]?.sourceRefs[0]?.sourceId, "conversation_message_row_all");

  const unauthorized = await searchContext(repository, {
    q: "深圳行程",
    layer: "evidence",
    tenantId: "tenant-other",
    principalId: "principal-a"
  });
  assert.equal(unauthorized.results.length, 0);
});

test("SQLite evidence search works after restart without loading the debug cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-evidence-sqlite-"));
  const storePath = join(dir, "context.sqlite");
  const writer = new SqliteContextEngineRepository(storePath);
  const request = conversationCommitRequest({
    rowId: "conversation_message_row_sqlite",
    messageId: "msg_sqlite",
    tenantId: "tenant-a",
    principalId: "principal-a",
    sourceApp: "agent-a",
    sessionId: "session-sqlite",
    content: "SQLite 消息证据可恢复",
    createdAt: messageTime
  });
  await writer.commitConversationIngestion(request);
  await writer.saveMemoryEvent(dataLakeEvent());
  await writer.saveParsedSegment(dataLakeSegment());
  writer.close();

  const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
  assert.equal(reader.conversationMessages.length, 0);
  const messageResult = await searchContext(reader, {
    q: "SQLite 消息证据",
    layer: "evidence",
    tenantId: "tenant-a",
    principalId: "principal-a"
  });
  const segmentResult = await searchContext(reader, {
    q: "预算已经确认",
    layer: "evidence",
    tenantId: "tenant-a",
    principalId: "principal-a"
  });
  assert.equal(messageResult.results[0]?.id, "conversation_message_row_sqlite");
  assert.equal(segmentResult.results[0]?.id, "segment_budget");
  assert.equal(segmentResult.results[0]?.sourceRefs[0]?.sourceType, "parsed_segment");
  reader.close();
});

class CountingEvidenceRepository extends InMemoryContextEngineRepository {
  readonly batchReads = {
    shortTermMemories: 0,
    facts: 0,
    messages: 0,
    segments: 0,
    events: 0
  };

  override getShortTermMemoriesByIds(memoryDataIds: string[]) {
    this.batchReads.shortTermMemories += 1;
    return super.getShortTermMemoriesByIds(memoryDataIds);
  }

  override getFactItemsByIds(factIds: string[]) {
    this.batchReads.facts += 1;
    return super.getFactItemsByIds(factIds);
  }

  override async getConversationMessagesByRowIds(conversationMessageRowIds: string[]) {
    this.batchReads.messages += 1;
    return super.getConversationMessagesByRowIds(conversationMessageRowIds);
  }

  override getParsedSegmentsByIds(segmentIds: string[]) {
    this.batchReads.segments += 1;
    return super.getParsedSegmentsByIds(segmentIds);
  }

  override getMemoryEventsByIds(eventIds: string[]) {
    this.batchReads.events += 1;
    return super.getMemoryEventsByIds(eventIds);
  }
}

function conversationCommitRequest(input: {
  rowId: string;
  messageId: string;
  tenantId: string;
  principalId: string;
  sourceApp: string;
  sessionId: string;
  content: string;
  createdAt: string;
}): CommitConversationIngestionRequest {
  const ingestionId = `ingestion_${input.messageId}`;
  const documentId = `document_${input.messageId}`;
  const now = "2026-07-25T00:00:00.000Z";
  const ingestion: ConversationIngestionRecord = {
    ingestionId,
    idempotencyKey: `idempotency_${input.messageId}`,
    documentSha256: `sha_${input.messageId}`,
    batchId: `batch_${input.messageId}`,
    sessionId: input.sessionId,
    sourceApp: input.sourceApp,
    tenantId: input.tenantId,
    principalId: input.principalId,
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
    layerCounts: emptyLayerCounts(),
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
    sourceApp: input.sourceApp,
    tenantId: input.tenantId,
    principalId: input.principalId,
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
      tenantId: input.tenantId,
      sourceApp: input.sourceApp,
      principalId: input.principalId,
      sessionId: input.sessionId,
      committedCursor: "cursor-1",
      lastSequence: 1,
      lastIngestionId: ingestionId,
      updatedAt: now
    }
  };
}

function dataLakeEvent(options: { visibility?: MemoryEvent["permissionSnapshot"]["visibility"] } = {}): MemoryEvent {
  return {
    eventId: "event_budget",
    eventType: "file_ingested",
    eventSummary: "预算文档",
    eventTime: segmentTime,
    sourceApp: "drive",
    sourceId: "file-budget",
    dataSource: {
      sourceApp: "drive",
      sourceId: "file-budget",
      sourceType: "file"
    },
    customFields: {
      eventTimeStart: segmentTime,
      eventTimeEnd: segmentTime,
      eventTimeConfidence: "high"
    },
    permissionSnapshot: {
      snapshotId: "permission_budget",
      tenantId: "tenant-a",
      principalId: "principal-a",
      sourceAclVersion: "acl-1",
      visibility: options.visibility ?? "private"
    },
    multimodalData: [{
      itemId: "item_budget",
      type: "document",
      format: "text/plain",
      content: "预算已经确认",
      sourceRefs: [{
        sourceRefId: "source_file_budget",
        sourceType: "file",
        sourceId: "file-budget"
      }],
      timeBasis: "source_time",
      timeConfidence: "high"
    }]
  };
}

function dataLakeSegment(): ParsedSegment {
  return {
    segmentId: "segment_budget",
    eventId: "event_budget",
    modality: "document",
    content: "项目预算已经确认",
    status: "parsed",
    confidence: "high",
    dataSource: {
      sourceApp: "drive",
      sourceId: "file-budget",
      sourceType: "file"
    }
  };
}

function conversationSourceRef(message: ConversationMessageRecord): SourceRef {
  return {
    sourceRefId: message.conversationMessageRowId,
    sourceType: "conversation_message",
    sourceId: message.conversationMessageRowId,
    metadata: {
      messageId: message.messageId,
      sessionId: message.sessionId,
      ingestionId: message.ingestionId,
      revision: message.revision
    }
  };
}

function testFact(sourceRefs: SourceRef[], segmentIds: string[]): FactItem {
  return {
    factId: "fact_evidence",
    factType: "event",
    factText: "深圳行程与项目预算",
    normalizedClaim: "深圳行程与项目预算",
    linkedEventIds: segmentIds.length ? ["event_budget"] : [],
    linkedSegmentIds: segmentIds,
    linkedSourceRefs: sourceRefs,
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-07-25T00:00:00.000Z",
    evidenceTimeStart: segmentTime,
    evidenceTimeEnd: messageTime,
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-08-01T00:00:00.000+08:00",
    validTimeConfidence: "high",
    timeBasis: "absolute",
    timeConfidence: "high",
    schemaVersion: "fact-item.v2",
    accessState: "visible"
  };
}

function testStm(fact: FactItem, sourceRefs: SourceRef[]): ShortTermMemory {
  return {
    memoryDataId: "stm_evidence",
    tenantId: "tenant-a",
    principalId: "principal-a",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    memoryDataType: "event",
    memoryType: "event",
    content: "深圳行程与项目预算短期记忆",
    sourceFactIds: [fact.factId],
    sourceRefs,
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
    lifecycleStatus: "active",
    accessState: "visible"
  };
}

function testLtm(stm: ShortTermMemory): LongTermMemory {
  return {
    memoryId: "ltm_evidence",
    theoryClass: "episodic",
    memoryType: "event",
    content: "深圳行程与项目预算长期记忆",
    sourceRefs: [],
    sourceMemoryDataIds: [stm.memoryDataId],
    entityIds: [],
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: ["test"],
    lifecycleStatus: "active",
    accessState: "visible"
  };
}

function emptyLayerCounts() {
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
