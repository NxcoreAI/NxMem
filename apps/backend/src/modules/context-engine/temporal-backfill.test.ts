import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";
import { createConversationIngestionService } from "./conversation-ingestion/conversation-ingestion-service.js";
import {
  extendedConversationFixture,
  validConversationFixture
} from "./conversation-ingestion/fixtures/index.js";
import type { ConversationCallerScope } from "./conversation-ingestion/domain.js";
import { runTemporalBackfill } from "./temporal-backfill.js";

const caller: ConversationCallerScope = {
  tenantId: "tenant_backfill",
  principalId: "principal_backfill",
  sourceApp: "coding-agent",
  allowedVisibilities: ["private"]
};

test("backfills extended message evidence through Fact, STM, LTM and indexes idempotently", async () => {
  const repository = new InMemoryContextEngineRepository();
  const ingestionId = await ingest(repository, extendedConversationFixture.document, "extended-backfill");
  const originalMessage = (await repository.getConversationMessages(ingestionId))[0]!;
  repository.conversationMessages.length = 0;
  repository.conversationDocumentMessageRows.length = 0;

  await repository.saveFactItem({
    factId: "fact_temporal_backfill",
    factType: "travel_plan",
    factText: "用户计划明天去深圳",
    normalizedClaim: "用户计划明天去深圳",
    linkedEventIds: [`conversation_document_${ingestionId}`],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: ["shenzhen"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-07-25T00:00:00.000Z",
    sourceMessageIds: [originalMessage.messageId],
    timeBasis: "source_time",
    timeConfidence: "low",
    schemaVersion: "conversation-document-fact.v2"
  });
  await repository.saveShortTermMemory(shortTermMemory());
  await repository.saveLongTermMemory(longTermMemory());

  const first = await runTemporalBackfill(repository, {
    version: "temporal-backfill-test-extended",
    now: () => new Date("2026-07-26T00:00:00.000Z")
  });
  const restoredMessage = (await repository.getConversationMessages(ingestionId))[0]!;
  const snapshot = repository.getDebugSnapshot();
  const fact = snapshot.facts.find((item) => item.factId === "fact_temporal_backfill")!;
  const stm = snapshot.shortTermMemories.find((item) => item.memoryDataId === "stm_temporal_backfill")!;
  const ltm = snapshot.longTermMemories.find((item) => item.memoryId === "ltm_temporal_backfill")!;

  assert.equal(first.status, "completed");
  assert.equal(first.counts.messagesRestored, 2);
  assert.equal(first.counts.factsUpdated, 1);
  assert.equal(first.counts.shortTermMemoriesUpdated, 1);
  assert.equal(first.counts.longTermMemoriesUpdated, 1);
  assert.equal(first.counts.indexesRefreshed, 2);
  assert.equal(restoredMessage.createdAt, originalMessage.createdAt);
  assert.equal(restoredMessage.timeConfidence, "high");
  assert.equal(fact.evidenceTimeStart, originalMessage.createdAt);
  assert.equal(fact.evidenceTimeConfidence, "high");
  assert.equal(fact.validTimeStart, undefined);
  assert.equal(stm.evidenceTimeStart, originalMessage.createdAt);
  assert.equal(ltm.evidenceTimeStart, originalMessage.createdAt);
  assert.equal(snapshot.indexEntries.filter((item) =>
    item.ownerId === stm.memoryDataId || item.ownerId === ltm.memoryId
  ).length, 2);

  const repeated = await runTemporalBackfill(repository, {
    version: "temporal-backfill-test-extended",
    now: () => new Date("2026-07-27T00:00:00.000Z")
  });
  assert.deepEqual(repeated, first);
  assert.equal(repository.conversationMessages.length, 2);
});

test("uses committedAt only as low-confidence evidence for legacy V3", async () => {
  const repository = new InMemoryContextEngineRepository();
  const ingestionId = await ingest(repository, validConversationFixture.document, "legacy-backfill");
  const ingestion = await repository.getConversationIngestion(ingestionId);
  const sourceMessageId = (await repository.getConversationMessages(ingestionId))[0]!.messageId;
  repository.conversationMessages.length = 0;
  repository.conversationDocumentMessageRows.length = 0;
  await repository.saveFactItem({
    factId: "fact_legacy_temporal_backfill",
    factType: "preference",
    factText: "用户偏好 TypeScript",
    normalizedClaim: "用户偏好 TypeScript",
    linkedEventIds: [`conversation_document_${ingestionId}`],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-07-25T00:00:00.000Z",
    sourceMessageIds: [sourceMessageId],
    timeBasis: "source_time",
    timeConfidence: "low",
    schemaVersion: "conversation-document-fact.v2"
  });

  const result = await runTemporalBackfill(repository, { version: "temporal-backfill-test-legacy" });
  const message = (await repository.getConversationMessages(ingestionId))[0]!;
  const fact = repository.getDebugSnapshot().facts.find((item) => item.factId === "fact_legacy_temporal_backfill")!;
  assert.equal(result.status, "completed");
  assert.equal(message.createdAt, ingestion?.committedAt);
  assert.equal(message.timeConfidence, "low");
  assert.equal(fact.evidenceTimeStart, ingestion?.committedAt);
  assert.equal(fact.evidenceTimeConfidence, "low");
  assert.equal(fact.validTimeStart, undefined);
  assert.equal(fact.validTimeEnd, undefined);
});

test("persists SQLite migration state and restored messages across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-temporal-backfill-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const ingestionId = await ingest(writer, extendedConversationFixture.document, "sqlite-backfill");
    writer.close();

    const legacy = new DatabaseSync(storePath);
    legacy.exec("PRAGMA foreign_keys=ON;");
    legacy.prepare("DELETE FROM conversation_document_messages WHERE ingestion_id = ?").run(ingestionId);
    legacy.prepare("DELETE FROM conversation_messages WHERE first_ingestion_id = ?").run(ingestionId);
    legacy.prepare("UPDATE conversation_ingestions SET temporal_mode = 'legacy' WHERE ingestion_id = ?").run(ingestionId);
    legacy.close();

    const migrated = new SqliteContextEngineRepository(storePath);
    const first = await runTemporalBackfill(migrated, { version: "temporal-backfill-test-sqlite" });
    assert.equal(first.status, "completed");
    assert.equal(first.counts.messagesRestored, 2);
    migrated.close();

    const restarted = new SqliteContextEngineRepository(storePath);
    const message = (await restarted.getConversationMessages(ingestionId))[0]!;
    assert.equal(message.messageId, extendedConversationFixture.messages[0]!.messageId);
    assert.equal(message.createdAt, extendedConversationFixture.messages[0]!.createdAt);
    assert.equal(message.timeConfidence, "high");
    assert.equal((await restarted.getConversationIngestion(ingestionId))?.temporalMode, "extended");
    const repeated = await runTemporalBackfill(restarted, { version: "temporal-backfill-test-sqlite" });
    assert.deepEqual(repeated, first);
    assert.equal((await restarted.getConversationMessages(ingestionId)).length, 2);
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries a failed migration version without duplicating completed rows", async () => {
  const repository = new InMemoryContextEngineRepository();
  const ingestionId = await ingest(repository, extendedConversationFixture.document, "retry-backfill");
  const document = await repository.getConversationDocument(ingestionId);
  assert.ok(document);
  const originalMarkdown = document.rawMarkdown;
  document.rawMarkdown = "invalid temporal document\n";

  const failed = await runTemporalBackfill(repository, { version: "temporal-backfill-test-retry" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempt, 1);
  assert.equal(failed.counts.failed, 1);
  assert.equal(failed.errors[0]?.code, "TEMPORAL_BACKFILL_FAILED");

  document.rawMarkdown = originalMarkdown;
  const completed = await runTemporalBackfill(repository, { version: "temporal-backfill-test-retry" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.attempt, 2);
  assert.equal(completed.counts.retried, 1);
  assert.equal((await repository.getConversationMessages(ingestionId)).length, 2);
});

async function ingest(
  repository: InMemoryContextEngineRepository,
  document: string,
  idempotencyKey: string
) {
  const response = await createConversationIngestionService(repository).ingest({
    document,
    documentSha256: createHash("sha256").update(document, "utf8").digest("hex"),
    idempotencyKey,
    processingMode: "async"
  }, caller);
  return response.sessions[0]!.ingestionId;
}

function shortTermMemory() {
  return {
    memoryDataId: "stm_temporal_backfill",
    tenantId: caller.tenantId,
    principalId: caller.principalId,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    memoryDataType: "conversation_fact",
    memoryType: "fact",
    content: "用户计划明天去深圳",
    structuredFacts: {
      schemaVersion: "memory-structured-facts.v1" as const,
      memoryKind: "short_term" as const,
      facts: [{
        factId: "fact_temporal_backfill",
        claim: "用户计划明天去深圳",
        explanation: "Backfill fixture"
      }]
    },
    sourceFactIds: ["fact_temporal_backfill"],
    sourceRefs: [],
    entityIds: ["shenzhen"],
    importanceLevel: "high" as const,
    confidenceLevel: "high" as const,
    admissionResult: "write_short_term" as const,
    admissionReason: "backfill_test",
    matchedRules: ["backfill_test"],
    admissionSignals: {
      importance: "high" as const,
      confidence: "high" as const,
      freshness: "fresh" as const,
      sensitivity: "low" as const,
      actorWeight: "high" as const,
      conflict: "none" as const,
      permission: "private" as const
    },
    lifecycleStatus: "active" as const
  };
}

function longTermMemory() {
  return {
    memoryId: "ltm_temporal_backfill",
    theoryClass: "prospective" as const,
    memoryType: "prospective",
    content: "用户计划明天去深圳",
    structuredFacts: {
      schemaVersion: "memory-structured-facts.v1" as const,
      memoryKind: "long_term" as const,
      facts: [{
        factId: "fact_temporal_backfill",
        sourceMemoryDataId: "stm_temporal_backfill",
        claim: "用户计划明天去深圳",
        explanation: "Backfill fixture"
      }]
    },
    sourceRefs: [],
    sourceMemoryDataIds: ["stm_temporal_backfill"],
    entityIds: ["shenzhen"],
    confidenceLevel: "high" as const,
    recallWeight: "high" as const,
    solidifyReason: "backfill_test",
    matchedRules: ["backfill_test"],
    lifecycleStatus: "active" as const
  };
}
