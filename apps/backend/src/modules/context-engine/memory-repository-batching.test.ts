import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";

const idCount = 33_000;
const selectedIndexes = [0, 16_500, idCount - 1];

test("SQLite bulk reads split ID lists that exceed the bind variable limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-repository-batching-"));
  const storePath = join(dir, "context.sqlite");
  new SqliteContextEngineRepository(storePath).close();

  const db = new DatabaseSync(storePath);
  db.exec("BEGIN IMMEDIATE;");
  try {
    const insertEvent = db.prepare(`
      INSERT INTO memory_events (
        event_id, event_type, event_summary, event_time, tenant_id,
        principal_id, source_acl_version, visibility
      ) VALUES (?, 'test', ?, '2026-08-01T00:00:00.000Z', 'tenant', 'principal', 'acl', 'private')
    `);
    const insertItem = db.prepare(`
      INSERT INTO multimodal_data_items (
        item_id, event_id, source_item_id, type, format, content
      ) VALUES (?, ?, ?, 'text', 'text/plain', ?)
    `);
    const insertSourceRef = db.prepare(`
      INSERT INTO source_refs (source_ref_id, source_type, source_id)
      VALUES (?, 'test', ?)
    `);
    const insertEventSourceRef = db.prepare(`
      INSERT INTO event_source_refs (event_id, source_ref_id) VALUES (?, ?)
    `);
    const insertSegment = db.prepare(`
      INSERT INTO parsed_segments (segment_id, event_id, modality, content, status, confidence)
      VALUES (?, ?, 'text', ?, 'parsed', 'high')
    `);
    const insertFact = db.prepare(`
      INSERT INTO fact_items (
        fact_id, fact_type, fact_text, normalized_claim, confidence_level,
        observed_at, time_basis, time_confidence, schema_version
      ) VALUES (?, 'test', ?, ?, 'high', '2026-08-01T00:00:00.000Z', 'source_time', 'high', 'test.v1')
    `);
    const insertFactVersion = db.prepare(`
      INSERT INTO fact_versions (
        fact_version_id, fact_id, tenant_id, principal_id, version,
        fact_text, normalized_claim, fact_type, confidence_level,
        source_fact_ids, update_reason, source_fingerprint, created_at
      ) VALUES (?, ?, 'tenant', 'principal', 1, ?, ?, 'test', 'high',
        ?, 'created', ?, '2026-08-01T00:00:00.000Z')
    `);
    const insertStm = db.prepare(`
      INSERT INTO short_term_memories (
        memory_data_id, tenant_id, principal_id, memory_data_type, memory_type,
        content, importance_level, confidence_level, admission_result,
        admission_reason, created_at, updated_at
      ) VALUES (?, 'tenant', 'principal', 'test', 'fact', ?, 'high', 'high',
        'write_short_term', 'test', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `);

    for (const index of selectedIndexes) {
      const eventId = indexedId("event", index);
      const sourceRefId = indexedId("source", index);
      insertEvent.run(eventId, `event ${index}`);
      insertItem.run(indexedId("item", index), eventId, indexedId("source-item", index), `item ${index}`);
      insertSourceRef.run(sourceRefId, indexedId("source-id", index));
      insertEventSourceRef.run(eventId, sourceRefId);
      insertSegment.run(indexedId("segment", index), eventId, `segment ${index}`);
      insertFact.run(indexedId("fact", index), `fact ${index}`, `fact ${index}`);
      insertFactVersion.run(
        indexedId("fact-version", index),
        indexedId("fact", index),
        `fact ${index}`,
        `fact ${index}`,
        JSON.stringify([indexedId("fact", index)]),
        indexedId("fingerprint", index)
      );
      insertStm.run(indexedId("stm", index), `stm ${index}`);
    }
    db.exec("COMMIT;");
  } catch (caught) {
    db.exec("ROLLBACK;");
    throw caught;
  } finally {
    db.close();
  }

  const repository = new SqliteContextEngineRepository(storePath, undefined, { loadCache: false });
  try {
    const eventIds = allIds("event");
    const segmentIds = allIds("segment");
    const factIds = allIds("fact");
    const stmIds = allIds("stm");

    const events = repository.getMemoryEventsByIds([...eventIds].reverse());
    assert.deepEqual(events.map((item) => item.eventId), selectedIds("event"));
    assert.deepEqual(events.map((item) => item.multimodalData[0]?.content), selectedIndexes.map((index) => `item ${index}`));
    assert.deepEqual(events.map((item) => item.sourceRefs?.[0]?.sourceId), selectedIds("source-id"));

    const segments = repository.getParsedSegmentsByIds([...segmentIds].reverse());
    assert.deepEqual(segments.map((item) => item.segmentId), selectedIds("segment"));

    const facts = repository.getFactItemsByIds([...factIds].reverse());
    assert.deepEqual(facts.map((item) => item.factId), selectedIds("fact"));

    const factVersions = repository.getFactVersionsByFactIds({
      tenantId: "tenant",
      principalId: "principal",
      factIds: [...factIds].reverse()
    });
    assert.deepEqual(factVersions.map((item) => item.factId), selectedIds("fact"));

    const memories = repository.getShortTermMemoriesByIds([...stmIds].reverse());
    assert.deepEqual(memories.map((item) => item.memoryDataId), selectedIds("stm"));

    assert.deepEqual(await repository.getConversationMessagesByRowIds(allIds("message")), []);
  } finally {
    repository.close();
  }
});

function allIds(prefix: string) {
  return Array.from({ length: idCount }, (_, index) => indexedId(prefix, index));
}

function selectedIds(prefix: string) {
  return selectedIndexes.map((index) => indexedId(prefix, index));
}

function indexedId(prefix: string, index: number) {
  return `${prefix}_${String(index).padStart(5, "0")}`;
}
