import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FactItem } from "./domain.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";

test("SQLite persists original and normalized fact claims across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-fact-source-claim-"));
  const storePath = join(directory, "context.sqlite");
  const fact = createFact();

  try {
    const writer = new SqliteContextEngineRepository(storePath);
    await writer.saveFactItem(fact);
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath);
    const [persisted] = await reader.getFactItemsByIds([fact.factId]);
    assert.equal(persisted?.sourceClaim, fact.sourceClaim);
    assert.equal(persisted?.normalizedClaim, fact.normalizedClaim);
    reader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createFact(): FactItem {
  return {
    factId: "fact_bike_chain_cost",
    factType: "timeline",
    factText: "用户更换了自行车链条，花费25美元。",
    sourceClaim: "I replaced the bike chain and it cost me $25.",
    normalizedClaim: "用户更换了自行车链条，花费25美元。",
    linkedEventIds: ["event_bike_chain_cost"],
    linkedSegmentIds: ["segment_bike_chain_cost"],
    linkedSourceRefs: [{
      sourceRefId: "source_bike_chain_cost",
      sourceType: "conversation_message",
      sourceId: "message_bike_chain_cost"
    }],
    entityIds: ["bike_chain"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-01-15T00:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact.v1",
    accessState: "visible"
  };
}
