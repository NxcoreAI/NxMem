import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "../persistence/memory-repository.js";
import { createConversationIngestionService } from "./conversation-ingestion-service.js";
import type { ConversationCallerScope } from "./domain.js";
import { extendedConversationFixture } from "./fixtures/index.js";
import { createConversationMessageRowId } from "./message-normalization.js";
import {
  ConversationRepositoryError,
  type CommitConversationIngestionRequest,
  type ConversationIngestionRecord,
  type ConversationMessageRecord
} from "./persistence.js";

const callerScope: ConversationCallerScope = {
  tenantId: "tenant_fixture",
  principalId: "principal_fixture",
  sourceApp: "coding-agent",
  allowedVisibilities: ["private"]
};

test("persists extended timestamps and supports revision/delete on memory and SQLite repositories", async () => {
  await forEachRepository(async (repository) => {
    const ingestion = await ingestExtended(repository, `revision-${repository.constructor.name}`);
    const baseIngestion = await repository.getConversationIngestion(ingestion.ingestionId);
    const persistedMessages = await repository.getConversationMessages(ingestion.ingestionId);
    const baseMessage = persistedMessages[0];
    assert.ok(baseIngestion);
    assert.ok(baseMessage);
    assert.equal(persistedMessages.length, 2);
    assert.equal(baseIngestion.temporalMode, "extended");
    assert.equal(baseIngestion.timezone, "Asia/Shanghai");
    assert.equal(baseMessage.createdAt, extendedConversationFixture.messages[0]!.createdAt);
    assert.equal(baseMessage.timeConfidence, "high");
    assert.equal(persistedMessages[1]?.completedAt, extendedConversationFixture.messages[1]!.completedAt);
    assert.equal(persistedMessages[1]?.timezone, "Asia/Shanghai");
    assert.equal(persistedMessages[1]?.locale, "zh-CN");

    const replacement = buildMessageChangeCommit(
      baseIngestion,
      baseMessage,
      { revision: 2, operation: "replace", content: "我计划后天去深圳。" },
      "cursor_revision_2"
    );
    const replaced = await repository.commitConversationIngestion(replacement);
    assert.equal(replaced.messageCounts.revised, 1);
    assert.equal(replaced.messageCounts.deleted, 0);
    assert.equal((await repository.getConversationMessages(replacement.ingestion.ingestionId))[0]?.revision, 2);

    const deletion = buildMessageChangeCommit(
      replaced.ingestion,
      replacement.messages[0]!,
      { revision: 3, operation: "delete", content: "我计划后天去深圳。" },
      "cursor_revision_3"
    );
    const deleted = await repository.commitConversationIngestion(deletion);
    assert.equal(deleted.messageCounts.deleted, 1);
    assert.equal((await repository.getConversationMessages(deletion.ingestion.ingestionId))[0]?.operation, "delete");
  });
});

test("rejects content and sequence conflicts without advancing the cursor", async () => {
  await forEachRepository(async (repository) => {
    const ingestion = await ingestExtended(repository, `conflict-${repository.constructor.name}`);
    const baseIngestion = await repository.getConversationIngestion(ingestion.ingestionId);
    const baseMessage = (await repository.getConversationMessages(ingestion.ingestionId))[0];
    assert.ok(baseIngestion);
    assert.ok(baseMessage);

    const contentConflict = buildMessageChangeCommit(
      baseIngestion,
      baseMessage,
      { revision: 1, operation: "append", content: "相同 ID 的冲突内容。" },
      "cursor_content_conflict",
      { firstSequence: baseIngestion.lastSequence + 1 }
    );
    await assertRepositoryCode(
      () => repository.commitConversationIngestion(contentConflict),
      "MESSAGE_CONTENT_CONFLICT"
    );

    const sequenceConflictMessage: ConversationMessageRecord = {
      ...baseMessage,
      ingestionId: "cing_sequence_conflict",
      documentId: "cdoc_sequence_conflict",
      batchId: "batch_sequence_conflict",
      messageId: "msg_sequence_conflict",
      conversationMessageRowId: createConversationMessageRowId({
        tenantId: baseMessage.tenantId,
        sourceApp: baseMessage.sourceApp,
        principalId: baseMessage.principalId,
        sessionId: baseMessage.sessionId,
        messageId: "msg_sequence_conflict",
        revision: 1
      }),
      content: "占用已有 sequence。",
      contentSha256: sha256("占用已有 sequence。"),
      storedAt: "2026-07-24T08:00:00.000Z",
      createdAtStored: "2026-07-24T08:00:00.000Z"
    };
    const sequenceConflict = buildDirectCommit(
      baseIngestion,
      sequenceConflictMessage,
      "cursor_sequence_conflict",
      { firstSequence: baseIngestion.lastSequence + 1 }
    );
    await assertRepositoryCode(
      () => repository.commitConversationIngestion(sequenceConflict),
      "MESSAGE_CONTENT_CONFLICT"
    );

    const cursor = await repository.getConversationSessionCursor({
      tenantId: baseIngestion.tenantId,
      sourceApp: baseIngestion.sourceApp,
      principalId: baseIngestion.principalId,
      sessionId: baseIngestion.sessionId
    });
    assert.equal(cursor?.committedCursor, baseIngestion.committedCursor);
  });
});

async function ingestExtended(
  repository: InMemoryContextEngineRepository,
  idempotencyKey: string
) {
  const response = await createConversationIngestionService(repository).ingest({
    document: extendedConversationFixture.document,
    idempotencyKey,
    documentSha256: sha256(extendedConversationFixture.document),
    processingMode: "async"
  }, callerScope);
  return response.sessions[0]!;
}

function buildMessageChangeCommit(
  baseIngestion: ConversationIngestionRecord,
  baseMessage: ConversationMessageRecord,
  change: {
    revision: number;
    operation: ConversationMessageRecord["operation"];
    content: string;
  },
  cursor: string,
  options: { firstSequence?: number } = {}
) {
  const ingestionId = `cing_${cursor}`;
  const documentId = `cdoc_${cursor}`;
  const message: ConversationMessageRecord = {
    ...baseMessage,
    conversationMessageRowId: createConversationMessageRowId({
      tenantId: baseMessage.tenantId,
      sourceApp: baseMessage.sourceApp,
      principalId: baseMessage.principalId,
      sessionId: baseMessage.sessionId,
      messageId: baseMessage.messageId,
      revision: change.revision
    }),
    ingestionId,
    documentId,
    batchId: `batch_${cursor}`,
    revision: change.revision,
    operation: change.operation,
    content: change.content,
    contentSha256: sha256(change.content),
    storedAt: "2026-07-24T08:00:00.000Z",
    createdAtStored: "2026-07-24T08:00:00.000Z"
  };
  return buildDirectCommit(baseIngestion, message, cursor, options);
}

function buildDirectCommit(
  baseIngestion: ConversationIngestionRecord,
  message: ConversationMessageRecord,
  cursor: string,
  options: { firstSequence?: number } = {}
): CommitConversationIngestionRequest {
  const ingestionId = message.ingestionId;
  const documentId = message.documentId;
  const rawMarkdown = `revision:${cursor}`;
  const { batchIngestionId: _batchIngestionId, ...baseWithoutBatch } = baseIngestion;
  return {
    ingestion: {
      ...baseWithoutBatch,
      ingestionId,
      idempotencyKey: `idempotency_${cursor}`,
      documentSha256: sha256(rawMarkdown),
      batchId: message.batchId,
      previousCursor: baseIngestion.committedCursor,
      committedCursor: cursor,
      firstSequence: options.firstSequence ?? message.sequence,
      lastSequence: Math.max(baseIngestion.lastSequence, message.sequence),
      messageCounts: { received: 1, inserted: 0, deduplicated: 0, revised: 0, deleted: 0 },
      layerCounts: { ...baseIngestion.layerCounts, messages: 1 },
      createdAt: message.storedAt,
      committedAt: message.storedAt,
      updatedAt: message.storedAt
    },
    document: {
      documentId,
      ingestionId,
      schemaVersion: "context-conversation-md.v3",
      sha256: sha256(rawMarkdown),
      byteSize: Buffer.byteLength(rawMarkdown, "utf8"),
      rawMarkdown,
      createdAt: message.storedAt
    },
    messages: [message],
    cursor: {
      tenantId: baseIngestion.tenantId,
      sourceApp: baseIngestion.sourceApp,
      principalId: baseIngestion.principalId,
      sessionId: baseIngestion.sessionId,
      committedCursor: cursor,
      lastSequence: Math.max(baseIngestion.lastSequence, message.sequence),
      lastIngestionId: ingestionId,
      updatedAt: message.storedAt
    }
  };
}

async function forEachRepository(
  run: (repository: InMemoryContextEngineRepository) => Promise<void>
) {
  await run(new InMemoryContextEngineRepository());
  const directory = mkdtempSync(join(tmpdir(), "context-message-evidence-"));
  const storePath = join(directory, "context.sqlite");
  const repository = new SqliteContextEngineRepository(storePath);
  try {
    await run(repository);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function assertRepositoryCode(call: () => Promise<unknown>, code: string) {
  await assert.rejects(call, (caught: unknown) => {
    assert.equal(caught instanceof ConversationRepositoryError, true);
    assert.equal((caught as ConversationRepositoryError).code, code);
    return true;
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
