import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHealthServer } from "../health/server.js";
import { parseBackgroundMarkdown } from "./background-markdown.js";
import type { BackgroundContextDocument } from "./domain.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";

test("background documents are isolated by owner and revision", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground({ backgroundId: "background_a_1" }));
  await repository.saveBackgroundDocument(createBackground({
    backgroundId: "background_a_2",
    fixedRevision: 2,
    fixedText: "固定背景版本 2"
  }));
  await repository.saveBackgroundDocument(createBackground({
    backgroundId: "background_b_1",
    principalId: "user-b"
  }));

  assert.equal(repository.getLatestBackgroundDocument("tenant-a", "user-a")?.backgroundId, "background_a_2");
  assert.equal(repository.getLatestBackgroundDocument("tenant-a", "user-b")?.backgroundId, "background_b_1");
  assert.equal(repository.getLatestBackgroundDocument("tenant-a", "missing"), undefined);

  await assert.rejects(
    repository.saveBackgroundDocument(createBackground({ backgroundId: "background_a_duplicate", fixedRevision: 2 })),
    /BACKGROUND_REVISION_CONFLICT:tenant-a:user-a:2/
  );
  await assert.rejects(
    repository.saveBackgroundDocument(createBackground({ backgroundId: "background_a_1", principalId: "user-b" })),
    /BACKGROUND_OWNER_CONFLICT:background_a_1/
  );
});

test("background HTTP endpoints use owner scope and reuse a revision for dynamic-only updates", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const headersA = backgroundHeaders("tenant-a", "user-a");
  const headersB = backgroundHeaders("tenant-a", "user-b");

  try {
    const defaultA = await server.inject({ method: "GET", url: "/context/background", headers: headersA });
    assert.equal(
      Object.keys(parseBackgroundMarkdown(defaultA.json().result.fixedText)).length,
      4
    );

    const firstA = await server.inject({
      method: "POST",
      url: "/context/background",
      headers: headersA,
      payload: {
        fixedText: "用户 A 的固定背景",
        dynamicText: "用户 A 的第一段动态背景",
        fixedWatermark: { updatedAt: "2026-07-20T10:00:00.000Z", memoryDataId: "stm-a" },
        latestStmCursor: { updatedAt: "2026-07-20T10:01:00.000Z", memoryDataId: "stm-b" },
        dynamicWindowStart: "2026-07-20T10:00:00.000Z",
        dynamicWindowEnd: "2026-07-20T10:01:00.000Z",
        dynamicSourceMemoryIds: ["stm-a", "stm-b"],
        dynamicCacheKey: "cache-a-r1",
        updateSuggestion: {
          status: "pending",
          summary: "建议更新最近任务",
          targetSections: ["recentTasks"]
        }
      }
    });
    assert.equal(firstA.statusCode, 200);
    const firstDocument = firstA.json().result as BackgroundContextDocument;
    assert.equal(firstDocument.fixedRevision, 1);

    const firstB = await server.inject({
      method: "POST",
      url: "/context/background",
      headers: headersB,
      payload: { fixedText: "用户 B 的固定背景", dynamicText: "用户 B 的动态背景" }
    });
    assert.equal(firstB.statusCode, 200);

    const dynamicUpdateA = await server.inject({
      method: "POST",
      url: "/context/background",
      headers: headersA,
      payload: {
        dynamicText: "用户 A 的第二段动态背景",
        dynamicWindowStart: "2026-07-20T10:00:00.000Z",
        dynamicWindowEnd: "2026-07-20T10:02:00.000Z"
      }
    });
    const dynamicDocument = dynamicUpdateA.json().result as BackgroundContextDocument;
    assert.equal(dynamicUpdateA.statusCode, 200);
    assert.equal(dynamicDocument.backgroundId, firstDocument.backgroundId);
    assert.equal(dynamicDocument.fixedRevision, firstDocument.fixedRevision);

    const readA = await server.inject({ method: "GET", url: "/context/background", headers: headersA });
    const readB = await server.inject({ method: "GET", url: "/context/background", headers: headersB });
    assert.equal(readA.json().result.dynamicText, "用户 A 的第二段动态背景");
    assert.equal(readB.json().result.fixedText, "用户 B 的固定背景");

    const fixedUpdateA = await server.inject({
      method: "POST",
      url: "/context/background",
      headers: headersA,
      payload: { fixedText: "用户 A 的固定背景版本 2" }
    });
    const fixedDocument = fixedUpdateA.json().result as BackgroundContextDocument;
    assert.equal(fixedDocument.fixedRevision, 2);
    assert.notEqual(fixedDocument.backgroundId, firstDocument.backgroundId);
    assert.equal(
      parseBackgroundMarkdown(fixedDocument.dynamicText).recentTasks,
      "- 本时间窗口没有新增信息。"
    );
    assert.deepEqual(fixedDocument.dynamicSourceMemoryIds, []);
    assert.equal(fixedDocument.dynamicCacheKey, undefined);
    assert.equal(fixedDocument.dynamicWindowStart, fixedDocument.fixedTextUpdatedAt);

    const watermarkUpdateA = await server.inject({
      method: "POST",
      url: "/context/background",
      headers: headersA,
      payload: {
        fixedWatermark: { updatedAt: "2026-07-20T10:02:00.000Z", memoryDataId: "stm-c" }
      }
    });
    const watermarkDocument = watermarkUpdateA.json().result as BackgroundContextDocument;
    assert.equal(watermarkDocument.fixedText, fixedDocument.fixedText);
    assert.equal(watermarkDocument.fixedRevision, 3);

    const incompleteOwner = await server.inject({
      method: "GET",
      url: "/context/background",
      headers: { "x-context-tenant-id": "tenant-a" }
    });
    assert.equal(incompleteOwner.statusCode, 400);
  } finally {
    await server.close();
  }
});

const sqliteFts5Available = hasSqliteFts5();

test("SQLite persists background cursor, window, owner, and revision fields", {
  skip: sqliteFts5Available ? false : "Node SQLite does not provide fts5"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-document-sqlite-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const expected = createBackground({
      dynamicCacheKey: "background-cache-key",
      dynamicSourceMemoryIds: ["stm-a", "stm-b"],
      fixedWatermark: { updatedAt: "2026-07-20T09:00:00.000Z", memoryDataId: "stm-a" },
      latestStmCursor: { updatedAt: "2026-07-20T10:00:00.000Z", memoryDataId: "stm-b" }
    });
    await writer.saveBackgroundDocument(expected);
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    const actual = reader.getLatestBackgroundDocument("tenant-a", "user-a");
    assert.deepEqual(actual, expected);
    reader.close();

    const db = new DatabaseSync(storePath, { readOnly: true });
    const indexes = db.prepare("PRAGMA index_list(background_context_documents)").all() as Array<{
      name: string;
      unique: number;
    }>;
    assert.equal(indexes.some((index) => index.name === "idx_background_owner"), true);
    assert.equal(indexes.some((index) => index.name === "idx_background_owner_revision" && index.unique === 1), true);
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite migrates a legacy background row using source ownership", {
  skip: sqliteFts5Available ? false : "Node SQLite does not provide fts5"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-document-migration-"));
  const storePath = join(directory, "context.sqlite");
  try {
    createLegacyBackgroundDatabase(storePath);
    const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    const migrated = repository.getLatestBackgroundDocument("tenant-legacy", "user-legacy");
    assert.equal(migrated?.backgroundId, "background_legacy");
    assert.equal(migrated?.fixedRevision, 1);
    assert.deepEqual(migrated?.fixedWatermark, {
      updatedAt: "1970-01-01T00:00:00.000Z",
      memoryDataId: ""
    });
    assert.deepEqual(migrated?.dynamicSourceMemoryIds, []);
    repository.close();

    const db = new DatabaseSync(storePath, { readOnly: true });
    const columns = db.prepare("PRAGMA table_info(background_context_documents)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    for (const name of [
      "tenant_id",
      "principal_id",
      "fixed_revision",
      "fixed_watermark_json",
      "dynamic_window_start",
      "dynamic_window_end",
      "latest_stm_cursor_json"
    ]) {
      assert.equal(columns.find((column) => column.name === name)?.notnull, 1, name);
    }
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createBackground(overrides: Partial<BackgroundContextDocument>): BackgroundContextDocument {
  return {
    backgroundId: "background_a_1",
    tenantId: "tenant-a",
    principalId: "user-a",
    fixedText: "固定背景版本 1",
    dynamicText: "动态背景",
    fixedRevision: 1,
    fixedTextUpdatedAt: "2026-07-20T09:00:00.000Z",
    fixedWatermark: { updatedAt: "2026-07-20T09:00:00.000Z", memoryDataId: "stm-a" },
    dynamicWindowStart: "2026-07-20T09:00:00.000Z",
    dynamicWindowEnd: "2026-07-20T10:00:00.000Z",
    dynamicSourceMemoryIds: ["stm-a"],
    latestStmCursor: { updatedAt: "2026-07-20T10:00:00.000Z", memoryDataId: "stm-b" },
    sourceRefIds: ["source-a"],
    conflictIds: ["conflict-a"],
    updateSuggestion: {
      status: "pending",
      summary: "建议审阅最近任务",
      targetSections: ["recentTasks"]
    },
    createdAt: "2026-07-20T09:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides
  };
}

function backgroundHeaders(tenantId: string, principalId: string) {
  return {
    "content-type": "application/json",
    "x-context-tenant-id": tenantId,
    "x-context-principal-id": principalId
  };
}

function hasSqliteFts5() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE fts5_probe USING fts5(content)");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function createLegacyBackgroundDatabase(storePath: string) {
  const db = new DatabaseSync(storePath);
  db.exec(`
    CREATE TABLE memory_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_summary TEXT,
      event_description TEXT,
      event_time TEXT NOT NULL,
      source_app TEXT,
      source_id TEXT,
      data_source TEXT,
      custom_fields TEXT NOT NULL DEFAULT '{}',
      tenant_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      source_acl_version TEXT NOT NULL,
      visibility TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE event_source_refs (
      event_id TEXT NOT NULL,
      source_ref_id TEXT NOT NULL,
      PRIMARY KEY (event_id, source_ref_id)
    );
    CREATE TABLE background_context_documents (
      background_id TEXT PRIMARY KEY,
      fixed_text TEXT NOT NULL,
      dynamic_text TEXT NOT NULL,
      source_ref_ids TEXT NOT NULL,
      conflict_ids TEXT NOT NULL,
      degraded_mode_reason TEXT,
      update_suggestion_status TEXT,
      update_suggestion_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO memory_events (
      event_id, event_type, event_time, tenant_id, principal_id,
      source_acl_version, visibility, created_at
    ) VALUES (
      'event_legacy', 'manual_memory_event', '2026-07-19T08:00:00.000Z',
      'tenant-legacy', 'user-legacy', 'v1', 'private', '2026-07-19T08:00:00.000Z'
    );
    INSERT INTO event_source_refs (event_id, source_ref_id)
      VALUES ('event_legacy', 'source-legacy');
    INSERT INTO background_context_documents (
      background_id, fixed_text, dynamic_text, source_ref_ids, conflict_ids,
      update_suggestion_status, update_suggestion_summary, created_at, updated_at
    ) VALUES (
      'background_legacy', '旧固定背景', '旧动态背景', '["source-legacy"]', '[]',
      'pending', '旧更新建议', '2026-07-19T08:00:00.000Z', '2026-07-20T08:00:00.000Z'
    );
  `);
  db.close();
}
