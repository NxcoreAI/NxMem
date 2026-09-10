import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";

const FACT_VERSION_COLUMNS = [
  "fact_version_id",
  "fact_id",
  "tenant_id",
  "principal_id",
  "version",
  "previous_version_id",
  "fact_text",
  "normalized_claim",
  "fact_type",
  "evidence_time_start",
  "evidence_time_end",
  "valid_time_start",
  "valid_time_end",
  "confidence_level",
  "source_fact_ids",
  "linked_event_ids",
  "linked_segment_ids",
  "linked_source_refs",
  "update_reason",
  "conflict_refs",
  "source_fingerprint",
  "created_at"
];

const FACT_VERSION_INDEXES = [
  "idx_fact_versions_owner_evidence_time",
  "idx_fact_versions_owner_fact_version",
  "idx_fact_versions_owner_source_fingerprint",
  "idx_fact_versions_owner_valid_time",
  "idx_fact_versions_previous_version"
];

const FACT_ITEM_OWNER_INDEXES = [
  "idx_fact_items_owner_evidence_time",
  "idx_fact_items_owner_valid_time"
];

test("migrates an existing SQLite store to an empty, constrained fact_versions table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-fact-versions-"));
  const storePath = join(directory, "context.sqlite");

  try {
    createLegacyFactStore(storePath);

    new SqliteContextEngineRepository(storePath).close();
    let database = new DatabaseSync(storePath);
    database.exec("PRAGMA foreign_keys=ON;");

    assert.deepEqual(
      tableColumns(database, "fact_versions"),
      FACT_VERSION_COLUMNS
    );
    assert.deepEqual(
      explicitIndexes(database, "fact_versions"),
      FACT_VERSION_INDEXES
    );
    assert.ok(tableColumns(database, "fact_items").includes("tenant_id"));
    assert.ok(tableColumns(database, "fact_items").includes("principal_id"));
    assert.deepEqual(
      explicitIndexes(database, "fact_items").filter((index) => index.startsWith("idx_fact_items_owner_")),
      FACT_ITEM_OWNER_INDEXES
    );
    assert.deepEqual(
      foreignKeys(database, "fact_versions"),
      [
        { from: "fact_id", table: "fact_items", to: "fact_id", onDelete: "CASCADE" },
        {
          from: "previous_version_id",
          table: "fact_versions",
          to: "fact_version_id",
          onDelete: "CASCADE"
        }
      ]
    );
    assert.equal(rowCount(database, "fact_items"), 1);
    assert.equal(rowCount(database, "fact_versions"), 0);
    const owner = database.prepare(`
      SELECT tenant_id AS tenantId, principal_id AS principalId
      FROM fact_items WHERE fact_id = 'fact_review'
    `).get() as { tenantId: string; principalId: string };
    assert.equal(owner.tenantId, "tenant_1");
    assert.equal(owner.principalId, "principal_1");

    insertVersion(database, {
      factVersionId: "fact_version_review_v1",
      version: 1,
      previousVersionId: null,
      factText: "周五评审方案",
      updateReason: "created"
    });
    insertVersion(database, {
      factVersionId: "fact_version_review_v2",
      version: 2,
      previousVersionId: "fact_version_review_v1",
      factText: "周五评审方案，重点关注功耗和成本",
      updateReason: "supplemented"
    });
    assert.throws(
      () => insertVersion(database, {
        factVersionId: "fact_version_review_duplicate_v2",
        version: 2,
        previousVersionId: "fact_version_review_v1",
        factText: "重复版本",
        updateReason: "supplemented"
      }),
      /UNIQUE constraint failed/u
    );
    assert.throws(
      () => insertVersion(database, {
        factVersionId: "fact_version_review_orphan_v3",
        version: 3,
        previousVersionId: "fact_version_missing",
        factText: "无效前序版本",
        updateReason: "updated"
      }),
      /FOREIGN KEY constraint failed/u
    );
    database.close();

    new SqliteContextEngineRepository(storePath, undefined, { loadCache: false }).close();
    database = new DatabaseSync(storePath);
    assert.equal(rowCount(database, "fact_versions"), 2);
    assert.deepEqual(
      explicitIndexes(database, "fact_versions"),
      FACT_VERSION_INDEXES
    );
    database.close();

    const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
    await repository.clearAllContextData();
    repository.close();
    database = new DatabaseSync(storePath);
    assert.equal(rowCount(database, "fact_versions"), 0);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createLegacyFactStore(storePath: string) {
  const database = new DatabaseSync(storePath);
  database.exec(`
    CREATE TABLE fact_items (
      fact_id TEXT PRIMARY KEY,
      fact_type TEXT NOT NULL,
      fact_text TEXT NOT NULL,
      normalized_claim TEXT NOT NULL,
      confidence_level TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      observed_at TEXT NOT NULL,
      valid_time_start TEXT,
      valid_time_end TEXT,
      time_basis TEXT NOT NULL,
      time_confidence TEXT NOT NULL,
      schema_version TEXT NOT NULL
    );

    INSERT INTO fact_items (
      fact_id, fact_type, fact_text, normalized_claim, confidence_level,
      version, status, observed_at, valid_time_start, valid_time_end,
      time_basis, time_confidence, schema_version
    ) VALUES (
      'fact_review', 'event', '周五评审方案', '周五评审方案', 'high',
      1, 'active', '2026-08-07T06:00:00.000Z', NULL, NULL,
      'source_time', 'high', 'legacy-fact.v1'
    );

    CREATE TABLE fact_batches (
      batch_id TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      new_fact_ids TEXT NOT NULL,
      committed_at TEXT NOT NULL
    );

    INSERT INTO fact_batches (
      batch_id, trigger_type, tenant_id, principal_id, new_fact_ids, committed_at
    ) VALUES (
      'batch_review', 'backfill', 'tenant_1', 'principal_1', '["fact_review"]',
      '2026-08-07T06:10:00.000Z'
    );
  `);
  database.close();
}

function insertVersion(database: DatabaseSync, input: {
  factVersionId: string;
  version: number;
  previousVersionId: string | null;
  factText: string;
  updateReason: string;
}) {
  database.prepare(`
    INSERT INTO fact_versions (
      fact_version_id, fact_id, tenant_id, principal_id, version,
      previous_version_id, fact_text, normalized_claim, fact_type,
      confidence_level, update_reason, created_at
    , source_fingerprint) VALUES (?, 'fact_review', 'tenant_1', 'principal_1', ?, ?, ?, ?, 'event',
      'high', ?, '2026-08-07T06:30:00.000Z', ?)
  `).run(
    input.factVersionId,
    input.version,
    input.previousVersionId,
    input.factText,
    input.factText,
    input.updateReason,
    `source_${input.factVersionId}`
  );
}

function tableColumns(database: DatabaseSync, table: string) {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function explicitIndexes(database: DatabaseSync, table: string) {
  return (database.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    origin: string;
  }>)
    .filter((index) => index.origin === "c")
    .map((index) => index.name)
    .sort();
}

function foreignKeys(database: DatabaseSync, table: string) {
  return (database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }>)
    .map((key) => ({
      from: key.from,
      table: key.table,
      to: key.to,
      onDelete: key.on_delete
    }))
    .sort((left, right) => left.from.localeCompare(right.from));
}

function rowCount(database: DatabaseSync, table: string) {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count);
}
