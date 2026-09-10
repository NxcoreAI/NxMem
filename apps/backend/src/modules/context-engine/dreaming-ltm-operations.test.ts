import test from "node:test";
import assert from "node:assert/strict";
import type { LongTermMemory } from "./domain.js";
import { createDreamingOperationEdge, decideDreamingLtmOperation } from "./dreaming-ltm-operations.js";

const incoming: LongTermMemory = {
  memoryId: "ltm-new",
  theoryClass: "procedural",
  memoryType: "preference",
  content: "用户偏好先给结论",
  sourceRefs: [],
  sourceMemoryDataIds: ["stm-1"],
  entityIds: ["user-1"],
  confidenceLevel: "high",
  recallWeight: "high",
  solidifyReason: "test",
  matchedRules: [],
  lifecycleStatus: "active"
};

function existing(content: string, memoryId = "ltm-old"): LongTermMemory {
  return { ...incoming, memoryId, content, sourceMemoryDataIds: ["stm-old"] };
}

test("decides create when no existing owner LTM matches", () => {
  assert.equal(decideDreamingLtmOperation({ memoryDataId: "stm-1", memory: incoming, existingMemories: [] }).operation, "create");
});

test("creates a new LTM and emits is_same_as for an exact normalized claim", () => {
  const old = existing("用户偏好先给结论。 ");
  const result = decideDreamingLtmOperation({ memoryDataId: "stm-1", memory: incoming, existingMemories: [old] });
  assert.equal(result.operation, "create");
  assert.equal(result.targetLtmId, old.memoryId);
  assert.equal(result.resultLtmId, incoming.memoryId);
  assert.equal(createDreamingOperationEdge(result)?.relationType, "is_same_as");
});

test("decides revise for the same typed entity and emits an updates edge", () => {
  const old = existing("用户偏好回答简洁");
  const result = decideDreamingLtmOperation({ memoryDataId: "stm-1", memory: incoming, existingMemories: [old] });
  assert.equal(result.operation, "revise");
  assert.equal(createDreamingOperationEdge(result)?.relationType, "updates");
});

test("decides conflict when a same-entity STM contains an explicit conflict signal", () => {
  const old = existing("用户偏好先给结论");
  const changed = { ...incoming, content: "用户改为偏好先给细节" };
  const result = decideDreamingLtmOperation({ memoryDataId: "stm-1", memory: changed, existingMemories: [old] });
  assert.equal(result.operation, "conflict");
  assert.equal(createDreamingOperationEdge(result)?.relationType, "conflicts_with");
});

test("prefers an explicit support relation over a generic same-subject update", () => {
  const old = existing("用户偏好先给结论");
  const supporting = { ...incoming, content: "用户再次确认并支持先给结论" };
  const result = decideDreamingLtmOperation({ memoryDataId: "stm-1", memory: supporting, existingMemories: [old] });
  const edge = createDreamingOperationEdge(result);
  assert.equal(result.operation, "create");
  assert.equal(edge?.relationType, "supports");
  assert.equal(edge?.fromId, supporting.memoryId);
  assert.equal(edge?.toId, old.memoryId);
});

test("uses related_to for the same entity with a different memory type", () => {
  const old = { ...existing("用户负责 Context 项目"), memoryType: "profile" };
  const result = decideDreamingLtmOperation({ memoryDataId: "stm-1", memory: incoming, existingMemories: [old] });
  assert.equal(result.operation, "create");
  assert.equal(createDreamingOperationEdge(result)?.relationType, "related_to");
});
