import test from "node:test";
import assert from "node:assert/strict";
import { searchContext } from "./search-context.js";
import { refreshLongTermMemoryIndex } from "./indexing.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("long term lifecycle controls recall eligibility", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveLongTermMemory({
    memoryId: "ltm_active",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "active long term memory",
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    sourceRefs: [],
    sourceMemoryDataIds: [],
    entityIds: []
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);
  await repository.saveLongTermMemory({
    memoryId: "ltm_revised",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "revised long term memory",
    confidenceLevel: "medium",
    recallWeight: "medium",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "revised",
    sourceRefs: [],
    sourceMemoryDataIds: [],
    entityIds: []
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[1]!);
  await repository.saveLongTermMemory({
    memoryId: "ltm_archived",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "archived long term memory",
    confidenceLevel: "medium",
    recallWeight: "medium",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "archived",
    sourceRefs: [],
    sourceMemoryDataIds: [],
    entityIds: []
  });

  const activeOnly = await searchContext(repository, { q: "long term memory", layer: "ltm" });
  assert.deepEqual(activeOnly.results.map((item) => item.id).sort(), ["ltm_active", "ltm_revised"]);
  assert.equal(activeOnly.results.some((item) => item.id === "ltm_archived"), false);
});
