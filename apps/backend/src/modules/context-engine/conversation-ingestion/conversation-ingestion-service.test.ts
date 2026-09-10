import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createContextInventoryMcpServer } from "../context-inventory-mcp.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "../persistence/memory-repository.js";
import { ConversationIngestionServiceError, createConversationIngestionService } from "./conversation-ingestion-service.js";
import type { ConversationCallerScope, ConversationDocumentSession } from "./domain.js";
import {
  buildConversationMarkdown,
  extendedConversationFixture,
  invalidTemporalConversationFixtures,
  validConversationFixture
} from "./fixtures/index.js";

const callerScope: ConversationCallerScope = {
  tenantId: "tenant_fixture",
  principalId: "principal_fixture",
  sourceApp: "coding-agent",
  allowedVisibilities: ["private"]
};

test("atomically commits one raw document and one job per Session", async () => {
  const repository = new InMemoryContextEngineRepository();
  const sessions = twoSessions();
  const document = buildConversationMarkdown(validConversationFixture.frontMatter, sessions);
  const committed = await ingest(repository, document, "batch-two");

  assert.equal(committed.sessions.length, 2);
  assert.equal(repository.conversationDocuments.length, 1);
  assert.equal(repository.conversationIngestions.length, 2);
  assert.equal(repository.conversationIngestionJobs.length, 2);
  assert.equal(repository.conversationMessages.length, 2);
  for (const session of committed.sessions) {
    assert.equal((await repository.getConversationDocument(session.ingestionId))?.rawMarkdown, document);
    const messages = await repository.getConversationMessages(session.ingestionId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.sessionId, session.sessionId);
    assert.equal(messages[0]?.timeConfidence, "low");
  }
});

test("returns original child ingestion IDs on idempotent SQLite replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-conversation-v3-"));
  const storePath = join(directory, "context.sqlite");
  const document = buildConversationMarkdown(validConversationFixture.frontMatter, twoSessions());
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const first = await ingest(writer, document, "batch-replay");
    writer.close();
    const reader = new SqliteContextEngineRepository(storePath);
    const replay = await ingest(reader, document, "batch-replay");
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(replay.sessions.map((item) => item.ingestionId), first.sessions.map((item) => item.ingestionId));
    reader.close();
    const db = new DatabaseSync(storePath, { readOnly: true });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM conversation_documents").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM conversation_ingestions").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM conversation_messages").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM conversation_document_messages").get() as { count: number }).count, 2);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rebuilds canonical evidence tables without dropping unrelated legacy evidence tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-conversation-schema-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const legacyDb = new DatabaseSync(storePath);
    legacyDb.exec(`
      CREATE TABLE conversation_messages (id TEXT PRIMARY KEY);
      CREATE TABLE conversation_document_messages (id TEXT PRIMARY KEY);
      CREATE TABLE conversation_message_segments (id TEXT PRIMARY KEY);
    `);
    legacyDb.close();

    const migrated = new SqliteContextEngineRepository(storePath);
    migrated.close();
    const db = new DatabaseSync(storePath, { readOnly: true });
    const messageColumns = db.prepare("PRAGMA table_info(conversation_messages)")
      .all().map((row) => String((row as { name: string }).name));
    const linkColumns = db.prepare("PRAGMA table_info(conversation_document_messages)")
      .all().map((row) => String((row as { name: string }).name));
    const legacySegmentTable = db.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'conversation_message_segments'
    `).get() as { present?: number } | undefined;
    db.close();

    assert.equal(messageColumns.includes("created_at"), true);
    assert.equal(messageColumns.includes("stored_at"), true);
    assert.equal(messageColumns.includes("time_confidence"), true);
    assert.equal(linkColumns.includes("ingestion_id"), true);
    assert.equal(Boolean(legacySegmentTable?.present), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates an ingestion-only legacy document and preserves idempotent V3 replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-conversation-document-preflight-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const document = buildConversationMarkdown(validConversationFixture.frontMatter, twoSessions());
    const first = await ingest(writer, document, "legacy-document-preflight");
    writer.close();

    rewriteConversationDocumentsWithLegacyIngestionConstraint(storePath, { ingestionOnly: true });

    const preflightDb = new DatabaseSync(storePath);
    const preflightInternals = conversationDocumentsMigrationInternals(preflightDb);
    assert.deepEqual(preflightInternals.preflightConversationDocumentsMigration(), {
      documentCount: 1,
      ingestionCount: 2,
      batchIngestionCount: 1
    });
    const legacyBefore = preflightDb.prepare(`
      SELECT
        document_id AS documentId,
        batch_ingestion_id AS batchIngestionId,
        ingestion_id AS ingestionId,
        schema_version AS schemaVersion,
        sha256,
        byte_size AS byteSize,
        raw_markdown AS rawMarkdown,
        created_at AS createdAt
      FROM conversation_documents
    `).get() as {
      documentId: string;
      batchIngestionId: string | null;
      ingestionId: string;
      schemaVersion: string;
      sha256: string;
      byteSize: number;
      rawMarkdown: string;
      createdAt: string;
    };
    assert.equal(legacyBefore.batchIngestionId, null);
    assert.notEqual(legacyBefore.ingestionId, "");
    preflightDb.exec("CREATE TABLE conversation_documents__migration_v2 (document_id TEXT PRIMARY KEY);");
    assert.throws(
      () => preflightInternals.preflightConversationDocumentsMigration(),
      /CONVERSATION_DOCUMENTS_MIGRATION_RESIDUAL_TABLE:conversation_documents__migration_v2/u
    );
    preflightDb.exec("DROP TABLE conversation_documents__migration_v2;");
    preflightDb.close();

    const repository = new SqliteContextEngineRepository(storePath);
    const after = repository.conversationDocuments[0]!;
    assert.equal(after.documentId, legacyBefore.documentId);
    assert.equal(after.batchIngestionId, legacyBefore.batchIngestionId);
    assert.equal(after.ingestionId, legacyBefore.ingestionId);
    assert.equal(after.schemaVersion, legacyBefore.schemaVersion);
    assert.equal(after.sha256, legacyBefore.sha256);
    assert.equal(after.byteSize, legacyBefore.byteSize);
    assert.equal(after.rawMarkdown, legacyBefore.rawMarkdown);
    assert.equal(after.createdAt, legacyBefore.createdAt);

    const countsBeforeReplay = {
      documents: repository.conversationDocuments.length,
      ingestions: repository.conversationIngestions.length,
      jobs: repository.conversationIngestionJobs.length
    };
    const replay = await ingest(repository, document, "legacy-document-preflight");
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.batchIngestionId, first.batchIngestionId);
    assert.deepEqual(
      replay.sessions.map((session) => session.ingestionId),
      first.sessions.map((session) => session.ingestionId)
    );
    assert.deepEqual({
      documents: repository.conversationDocuments.length,
      ingestions: repository.conversationIngestions.length,
      jobs: repository.conversationIngestionJobs.length
    }, countsBeforeReplay);

    const nextDocument = buildConversationMarkdown(
      { ...validConversationFixture.frontMatter, batch_id: "batch_fixture_after_migration" },
      twoSessions().map((session, index) => ({
        ...session,
        sessionId: `session_after_migration_${index + 1}`,
        cursor: `cursor_after_migration_${index + 1}`
      }))
    );
    const committed = await ingest(repository, nextDocument, "batch-after-document-migration");
    assert.equal(committed.documentStatus, "raw_committed");
    repository.close();

    const db = new DatabaseSync(storePath, { readOnly: true });
    const ingestionIdColumn = (db.prepare("PRAGMA table_info(conversation_documents)").all() as Array<{
      name?: string;
      notnull?: number;
    }>).find((column) => column.name === "ingestion_id");
    assert.equal(ingestionIdColumn?.notnull, 0);
    const tableDefinition = db.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'conversation_documents'
    `).get() as { sql?: string } | undefined;
    assert.match(
      tableDefinition?.sql ?? "",
      /CHECK\s*\(batch_ingestion_id IS NOT NULL OR ingestion_id IS NOT NULL\)/u
    );
    const tableNames = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'conversation_documents%'
      ORDER BY name
    `).all().map((row) => String((row as { name?: string }).name));
    assert.deepEqual(tableNames, ["conversation_documents"]);
    const legacyDocument = db.prepare(`
      SELECT
        document_id AS documentId,
        batch_ingestion_id AS batchIngestionId,
        ingestion_id AS ingestionId,
        schema_version AS schemaVersion,
        sha256,
        byte_size AS byteSize,
        raw_markdown AS rawMarkdown,
        created_at AS createdAt
      FROM conversation_documents
      WHERE document_id = ?
    `).get(legacyBefore.documentId);
    assert.deepEqual(legacyDocument, legacyBefore);
    const batchDocument = db.prepare(`
      SELECT batch_ingestion_id AS batchIngestionId, ingestion_id AS ingestionId
      FROM conversation_documents
      WHERE batch_ingestion_id = ?
    `).get(committed.batchIngestionId) as {
      batchIngestionId?: string;
      ingestionId?: string | null;
    } | undefined;
    assert.equal(batchDocument?.batchIngestionId, committed.batchIngestionId);
    assert.equal(batchDocument?.ingestionId, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();

    const rerun = new SqliteContextEngineRepository(storePath);
    assert.equal(rerun.conversationDocuments.length, 2);
    assert.equal(rerun.conversationIngestions.length, 4);
    assert.equal(rerun.conversationIngestionJobs.length, 4);
    rerun.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skips conversation document migration preflight for the current schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-conversation-document-current-schema-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const repository = new SqliteContextEngineRepository(storePath);
    const internals = repository as unknown as {
      preflightConversationDocumentsMigration(): unknown;
    };
    assert.equal(internals.preflightConversationDocumentsMigration(), undefined);
    repository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rolls back the conversation document rebuild when foreign key validation fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-conversation-document-rollback-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const document = buildConversationMarkdown(validConversationFixture.frontMatter, twoSessions());
    await ingest(writer, document, "legacy-document-rollback");
    writer.close();

    rewriteConversationDocumentsWithLegacyIngestionConstraint(storePath);

    const db = new DatabaseSync(storePath);
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DELETE FROM conversation_ingestions
      WHERE ingestion_id = (
        SELECT ingestion_id FROM conversation_documents LIMIT 1
      );
      PRAGMA legacy_alter_table=ON;
      BEGIN IMMEDIATE;
    `);
    const internals = conversationDocumentsMigrationInternals(db);
    const preflight = internals.preflightConversationDocumentsMigration();
    assert.notEqual(preflight, undefined);
    assert.throws(
      () => internals.rebuildConversationDocuments(preflight!),
      /CONVERSATION_DOCUMENTS_MIGRATION_FOREIGN_KEY_VIOLATION/u
    );
    db.exec(`
      ROLLBACK;
      PRAGMA legacy_alter_table=OFF;
      PRAGMA foreign_keys=ON;
    `);

    const ingestionIdColumn = (db.prepare("PRAGMA table_info(conversation_documents)").all() as Array<{
      name?: string;
      notnull?: number;
    }>).find((column) => column.name === "ingestion_id");
    assert.equal(ingestionIdColumn?.notnull, 1);
    const tableNames = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'conversation_documents%'
      ORDER BY name
    `).all().map((row) => String((row as { name?: string }).name));
    assert.deepEqual(tableNames, ["conversation_documents"]);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates legacy message evidence rows without changing source timestamps", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-conversation-evidence-migration-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const committed = await ingest(writer, extendedConversationFixture.document, "legacy-evidence-migration");
    const ingestionId = committed.sessions[0]!.ingestionId;
    const before = await writer.getConversationMessages(ingestionId);
    writer.close();

    const legacyDb = new DatabaseSync(storePath);
    legacyDb.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE conversation_messages__legacy (
        conversation_message_row_id TEXT PRIMARY KEY,
        first_ingestion_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        source_app TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        reply_to_message_id TEXT,
        parent_message_id TEXT,
        branch_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        revision INTEGER NOT NULL,
        operation TEXT NOT NULL,
        metadata TEXT,
        source_created_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO conversation_messages__legacy
      SELECT
        conversation_message_row_id, first_ingestion_id, session_id, batch_id,
        source_app, tenant_id, principal_id, message_id, sequence, role, status,
        content_type, content, content_sha256, reply_to_message_id,
        parent_message_id, branch_id, tool_call_id, tool_name, revision,
        operation, metadata, created_at, stored_at
      FROM conversation_messages;

      CREATE TABLE conversation_document_messages__legacy (
        document_id TEXT NOT NULL,
        conversation_message_row_id TEXT NOT NULL,
        message_order INTEGER NOT NULL,
        PRIMARY KEY (document_id, conversation_message_row_id),
        UNIQUE (document_id, message_order)
      );
      INSERT INTO conversation_document_messages__legacy
      SELECT document_id, conversation_message_row_id, message_order
      FROM conversation_document_messages;

      DROP TABLE conversation_document_messages;
      DROP TABLE conversation_messages;
      ALTER TABLE conversation_messages__legacy RENAME TO conversation_messages;
      ALTER TABLE conversation_document_messages__legacy RENAME TO conversation_document_messages;
      PRAGMA foreign_keys=ON;
    `);
    legacyDb.close();

    const migrated = new SqliteContextEngineRepository(storePath);
    const after = await migrated.getConversationMessages(ingestionId);
    assert.deepEqual(after.map((message) => message.conversationMessageRowId),
      before.map((message) => message.conversationMessageRowId));
    assert.deepEqual(after.map((message) => message.createdAt), before.map((message) => message.createdAt));
    assert.deepEqual(after.map((message) => message.storedAt), before.map((message) => message.storedAt));
    migrated.close();

    const rerun = new SqliteContextEngineRepository(storePath);
    assert.equal((await rerun.getConversationMessages(ingestionId)).length, before.length);
    rerun.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rolls back every Session when one cursor or visibility is invalid", async () => {
  const repository = new InMemoryContextEngineRepository();
  const firstDocument = buildConversationMarkdown(validConversationFixture.frontMatter, [twoSessions()[0]!]);
  await ingest(repository, firstDocument, "first");

  const invalidCursorSessions = twoSessions().map((session, index) => ({
    ...session,
    cursor: `next_${index}`,
    ...(index === 0 ? { previousCursor: "wrong" } : {})
  }));
  const cursorDocument = buildConversationMarkdown(
    { ...validConversationFixture.frontMatter, batch_id: "batch_cursor_invalid" },
    invalidCursorSessions
  );
  await assertCode(() => ingest(repository, cursorDocument, "cursor-invalid"), "CURSOR_MISMATCH");
  assert.equal(repository.conversationDocuments.length, 1);
  assert.equal(repository.conversationIngestions.length, 1);

  const visibilityDocument = buildConversationMarkdown(
    { ...validConversationFixture.frontMatter, batch_id: "batch_visibility_invalid" },
    [{ ...twoSessions()[1]!, visibility: "public" }]
  );
  await assertCode(() => ingest(repository, visibilityDocument, "visibility-invalid"), "PERMISSION_SCOPE_MISMATCH");
  assert.equal(repository.conversationDocuments.length, 1);
});

test("classifies invalid timestamp protocol input for temporal observability", async () => {
  const repository = new InMemoryContextEngineRepository();
  const document = buildConversationMarkdown(
    { ...validConversationFixture.frontMatter, batch_id: "batch_temporal_protocol_invalid" },
    [{
      ...invalidTemporalConversationFixtures.invalidTimestamp.session,
      messages: invalidTemporalConversationFixtures.invalidTimestamp.session.messages.map((message) => ({ ...message }))
    }]
  );
  await assert.rejects(
    () => ingest(repository, document, "temporal-protocol-invalid"),
    (caught: unknown) => {
      assert.equal(caught instanceof ConversationIngestionServiceError, true);
      const error = caught as ConversationIngestionServiceError;
      assert.deepEqual(error.toolError.details?.temporalErrorCodes, ["TEMPORAL_PROTOCOL_INVALID"]);
      return true;
    }
  );
});

test("worker model input never contains another Session from the same document", async () => {
  const repository = new InMemoryContextEngineRepository();
  const document = buildConversationMarkdown(validConversationFixture.frontMatter, twoSessions());
  const committed = await ingest(repository, document, "isolated-worker");
  const seen: Array<{ sessionId: string; text: string }> = [];
  const { createConversationIngestionWorker } = await import("./conversation-ingestion-worker.js");
  const worker = createConversationIngestionWorker(repository, {
    phase3: {
      apiKey: "test-key",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        const payload = JSON.parse(request.messages.find((item) => item.role === "user")!.content) as {
          session: { sessionId: string; messages: Array<{ content: string }> };
        };
        seen.push({
          sessionId: payload.session.sessionId,
          text: payload.session.messages.map((message) => message.content).join("\n")
        });
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      disableStmAdmissionLlm: true,
      disableLtmConsolidationLlm: true
    }
  });
  await worker.runOnce();
  await worker.runOnce();

  assert.equal(seen.length, committed.sessions.length);
  assert.equal(seen.find((item) => item.sessionId === "session_a")?.text.includes("B prefers"), false);
  assert.equal(seen.find((item) => item.sessionId === "session_b")?.text.includes("A prefers"), false);
});

test("MCP exposes and returns the V3 batch structuredContent", async () => {
  const repository = new InMemoryContextEngineRepository();
  const mcp = createContextInventoryMcpServer(repository);
  const list = await mcp.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = list?.result?.tools as Array<{ name: string }>;
  assert.equal(tools.some((tool) => tool.name === "ingest_conversation_batch_document"), true);

  const document = buildConversationMarkdown(validConversationFixture.frontMatter, twoSessions());
  const response = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "ingest_conversation_batch_document",
      arguments: {
        document,
        idempotencyKey: "mcp-v3-batch",
        documentSha256: createHash("sha256").update(document, "utf8").digest("hex"),
        processingMode: "async"
      }
    }
  }, callerScope);
  const result = response?.result as { isError: boolean; structuredContent: { sessions: unknown[] } };
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.sessions.length, 2);
});

function twoSessions(): ConversationDocumentSession[] {
  return [
    { sessionId: "session_a", cursor: "cursor_a", messages: [{ role: "user", content: "A prefers TypeScript." }] },
    { sessionId: "session_b", cursor: "cursor_b", messages: [{ role: "user", content: "B prefers SQLite." }] }
  ];
}

function ingest(repository: InMemoryContextEngineRepository, document: string, idempotencyKey: string) {
  return createConversationIngestionService(repository).ingest({
    document,
    idempotencyKey,
    documentSha256: createHash("sha256").update(document, "utf8").digest("hex"),
    processingMode: "async"
  }, callerScope);
}

function rewriteConversationDocumentsWithLegacyIngestionConstraint(
  storePath: string,
  options: { ingestionOnly?: boolean } = {}
) {
  const db = new DatabaseSync(storePath);
  db.exec(`
    PRAGMA foreign_keys=OFF;
    PRAGMA legacy_alter_table=ON;
    CREATE TABLE conversation_documents__legacy_ingestion_v1 (
      document_id TEXT PRIMARY KEY,
      batch_ingestion_id TEXT UNIQUE,
      ingestion_id TEXT NOT NULL UNIQUE,
      schema_version TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      raw_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (batch_ingestion_id)
        REFERENCES conversation_batch_ingestions(batch_ingestion_id)
        ON DELETE CASCADE,
      FOREIGN KEY (ingestion_id)
        REFERENCES conversation_ingestions(ingestion_id)
        ON DELETE CASCADE
    );
    INSERT INTO conversation_documents__legacy_ingestion_v1 (
      document_id, batch_ingestion_id, ingestion_id, schema_version,
      sha256, byte_size, raw_markdown, created_at
    )
    SELECT
      document.document_id,
      document.batch_ingestion_id,
      COALESCE(
        document.ingestion_id,
        (
          SELECT ingestion.ingestion_id
          FROM conversation_ingestions AS ingestion
          WHERE ingestion.batch_ingestion_id = document.batch_ingestion_id
          ORDER BY ingestion.ingestion_id
          LIMIT 1
        )
      ),
      document.schema_version,
      document.sha256,
      document.byte_size,
      document.raw_markdown,
      document.created_at
    FROM conversation_documents AS document;
    DROP TABLE conversation_documents;
    ALTER TABLE conversation_documents__legacy_ingestion_v1
      RENAME TO conversation_documents;
    PRAGMA legacy_alter_table=OFF;
    PRAGMA foreign_keys=ON;
  `);
  if (options.ingestionOnly) {
    db.exec("UPDATE conversation_documents SET batch_ingestion_id = NULL;");
  }
  db.close();
}

interface ConversationDocumentsMigrationTestPreflight {
  documentCount: number;
  ingestionCount: number;
  batchIngestionCount: number;
}

function conversationDocumentsMigrationInternals(db: DatabaseSync) {
  const internals = Object.create(SqliteContextEngineRepository.prototype) as {
    preflightConversationDocumentsMigration(): ConversationDocumentsMigrationTestPreflight | undefined;
    rebuildConversationDocuments(preflight: ConversationDocumentsMigrationTestPreflight): void;
  };
  Object.defineProperty(internals, "db", { value: db });
  return internals;
}

async function assertCode(call: () => Promise<unknown>, code: string) {
  await assert.rejects(call, (caught: unknown) => {
    assert.equal(caught instanceof ConversationIngestionServiceError, true);
    assert.equal((caught as ConversationIngestionServiceError).toolError.code, code);
    return true;
  });
}
