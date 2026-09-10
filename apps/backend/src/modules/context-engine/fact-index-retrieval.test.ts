import test from "node:test";
import assert from "node:assert/strict";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { refreshFactIndexes } from "./indexing.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { searchContext } from "./search-context.js";
import type { FactItem } from "./domain.js";

test("Fact indexes include claim variants and search returns the Fact itself", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(16);
  const matching = createFact("fact_shenzhen_hotel", "owner-a", "深圳出差住在希尔顿", "The Shenzhen trip hotel is Hilton");
  const otherOwner = createFact("fact_other_owner", "owner-b", "深圳出差住在万豪", "The Shenzhen trip hotel is Marriott");
  await repository.saveFactItem(matching);
  await repository.saveFactItem(otherOwner);
  await refreshFactIndexes(repository, [matching, otherOwner], embeddingClient);

  const indexed = repository.getDebugSnapshot().indexEntries.find((entry) => entry.ownerId === matching.factId);
  assert.match(indexed?.content ?? "", /深圳出差住在希尔顿/u);
  assert.match(indexed?.content ?? "", /The Shenzhen trip hotel is Hilton/u);
  assert.equal(repository.getDebugSnapshot().vectorIndexEntries.find((entry) => entry.ownerId === matching.factId)?.vector.length, 16);

  const response = await searchContext(repository, {
    q: "深圳出差酒店",
    layer: "fact",
    tenantId: "local",
    principalId: "owner-a"
  }, { embeddingClient, recordShadow: false, recordRetrieval: false });

  assert.equal(response.results[0]?.id, matching.factId);
  assert.equal(response.results[0]?.layer, "fact");
  assert.deepEqual(response.results[0]?.factIds, [matching.factId]);
  assert.equal(response.results.some((result) => result.id === otherOwner.factId), false);
});

function createFact(factId: string, principalId: string, factText: string, sourceClaim: string): FactItem {
  return {
    factId,
    tenantId: "local",
    principalId,
    factType: "event",
    factText,
    sourceClaim,
    normalizedClaim: factText,
    linkedEventIds: [`event_${factId}`],
    linkedSegmentIds: [`segment_${factId}`],
    linkedSourceRefs: [{ sourceRefId: `src_${factId}`, sourceType: "agent_memory", sourceId: factId }],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-08-01T00:00:00.000Z",
    evidenceTimeStart: "2026-08-01T00:00:00.000Z",
    evidenceTimeConfidence: "high",
    validTimeStart: "2026-08-01T00:00:00.000Z",
    validTimeBasis: "absolute",
    validTimeConfidence: "high",
    timeBasis: "absolute",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  };
}
