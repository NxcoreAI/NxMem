import assert from "node:assert/strict";
import test from "node:test";
import {
  selectBackgroundMemories,
  type SelectBackgroundMemoriesRequest
} from "./background-stm-selector.js";
import type { ShortTermMemory } from "./domain.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { estimateContextTokens } from "./token-estimator.js";

test("background selector pages by owner and stable updatedAt/id cursor", async () => {
  const repository = new NoDebugSnapshotRepository();
  await saveAll(repository, [
    createStm({ memoryDataId: "stm_a", updatedAt: "2026-07-20T10:00:00.000Z" }),
    createStm({ memoryDataId: "stm_b", updatedAt: "2026-07-20T10:00:00.000Z" }),
    createStm({ memoryDataId: "stm_c", updatedAt: "2026-07-20T10:01:00.000Z" }),
    createStm({
      memoryDataId: "stm_other_user",
      principalId: "other-user",
      updatedAt: "2026-07-20T10:00:30.000Z"
    })
  ]);

  const first = await selectBackgroundMemories(repository, {
    ...request(),
    cursor: { updatedAt: "2026-07-20T10:00:00.000Z", memoryDataId: "stm_a" },
    limit: 1
  });
  assert.deepEqual(first.memories.map((memory) => memory.memoryDataId), ["stm_b"]);
  assert.deepEqual(first.nextCursor, {
    updatedAt: "2026-07-20T10:00:00.000Z",
    memoryDataId: "stm_b"
  });
  assert.equal(first.hasMore, true);

  const second = await selectBackgroundMemories(repository, {
    ...request(),
    cursor: first.nextCursor,
    limit: 2
  });
  assert.deepEqual(second.memories.map((memory) => memory.memoryDataId), ["stm_c"]);
  assert.equal(second.hasMore, false);
});

test("background selector advances the scanned cursor when a whole page is dropped", async () => {
  const repository = new NoDebugSnapshotRepository();
  await saveAll(repository, [
    createStm({
      memoryDataId: "stm_inactive",
      updatedAt: "2026-07-20T10:00:00.000Z",
      lifecycleStatus: "deleted"
    }),
    createStm({
      memoryDataId: "stm_permission",
      updatedAt: "2026-07-20T10:01:00.000Z",
      accessState: "permission-invalid"
    }),
    createStm({
      memoryDataId: "stm_missing_source",
      updatedAt: "2026-07-20T10:02:00.000Z",
      sourceRefs: []
    }),
    createStm({ memoryDataId: "stm_valid", updatedAt: "2026-07-20T10:03:00.000Z" })
  ]);

  const first = await selectBackgroundMemories(repository, { ...request(), limit: 3 });
  assert.deepEqual(first.memories, []);
  assert.deepEqual(first.dropped, [
    { memoryDataId: "stm_inactive", reason: "inactive" },
    { memoryDataId: "stm_permission", reason: "permission_invalid" },
    { memoryDataId: "stm_missing_source", reason: "missing_source" }
  ]);
  assert.deepEqual(first.nextCursor, {
    updatedAt: "2026-07-20T10:02:00.000Z",
    memoryDataId: "stm_missing_source"
  });
  assert.equal(first.hasMore, true);

  const second = await selectBackgroundMemories(repository, {
    ...request(),
    cursor: first.nextCursor,
    limit: 3
  });
  assert.deepEqual(second.memories.map((memory) => memory.memoryDataId), ["stm_valid"]);
});

test("background selector keeps every generated non-deleted STM eligible for background analysis", async () => {
  const repository = new NoDebugSnapshotRepository();
  await saveAll(repository, [
    createStm({
      memoryDataId: "stm_active",
      content: "用户正在处理 active STM 对应的工作。",
      updatedAt: "2026-07-20T10:00:00.000Z",
      lifecycleStatus: "active"
    }),
    createStm({
      memoryDataId: "stm_candidate_hidden",
      content: "用户正在处理 candidate STM 对应的工作。",
      updatedAt: "2026-07-20T10:00:30.000Z",
      admissionResult: "write_candidate",
      lifecycleStatus: "candidate_queue",
      accessState: "hidden"
    }),
    createStm({
      memoryDataId: "stm_consolidated",
      content: "用户正在处理 consolidated STM 对应的工作。",
      updatedAt: "2026-07-20T10:01:00.000Z",
      lifecycleStatus: "consolidated"
    }),
    createStm({
      memoryDataId: "stm_deleted",
      content: "用户已经删除的 STM 不应进入背景。",
      updatedAt: "2026-07-20T10:02:00.000Z",
      lifecycleStatus: "deleted"
    })
  ]);

  const result = await selectBackgroundMemories(repository, request());

  assert.deepEqual(result.memories.map((memory) => memory.memoryDataId), [
    "stm_consolidated",
    "stm_candidate_hidden",
    "stm_active"
  ]);
  assert.deepEqual(result.dropped, [
    { memoryDataId: "stm_deleted", reason: "inactive" }
  ]);
});

test("background selector deduplicates exact content, merges sources, and sorts by priority", async () => {
  const repository = new NoDebugSnapshotRepository();
  await saveAll(repository, [
    createStm({
      memoryDataId: "stm_duplicate_low",
      content: "用户正在推进   Context Engine。",
      updatedAt: "2026-07-20T10:00:00.000Z",
      importanceLevel: "low",
      confidenceLevel: "medium",
      sourceRefs: [source("src_low")]
    }),
    createStm({
      memoryDataId: "stm_duplicate_high",
      content: "用户正在推进 Context Engine。",
      updatedAt: "2026-07-20T10:01:00.000Z",
      importanceLevel: "high",
      confidenceLevel: "high",
      sourceRefs: [source("src_high")]
    }),
    createStm({
      memoryDataId: "stm_critical",
      content: "用户明确要求今天提交 PRD。",
      updatedAt: "2026-07-20T09:59:00.000Z",
      importanceLevel: "critical"
    })
  ]);

  const result = await selectBackgroundMemories(repository, request());
  assert.deepEqual(result.memories.map((memory) => memory.memoryDataId), [
    "stm_critical",
    "stm_duplicate_high"
  ]);
  assert.deepEqual(
    result.memories[1]?.sourceRefs.map((item) => item.sourceRefId).sort(),
    ["src_high", "src_low"]
  );
  assert.equal(
    result.estimatedTokens,
    result.memories.reduce((sum, memory) => sum + estimateContextTokens(memory.content), 0)
  );
});

test("background selector validates its bounded page contract", async () => {
  const repository = new NoDebugSnapshotRepository();
  await assert.rejects(
    selectBackgroundMemories(repository, { ...request(), limit: 0 }),
    /BACKGROUND_STM_LIMIT_INVALID:0/
  );
  await assert.rejects(
    selectBackgroundMemories(repository, {
      ...request(),
      windowStart: "2026-07-20T11:00:00.000Z",
      windowEnd: "2026-07-20T10:00:00.000Z"
    }),
    /BACKGROUND_STM_WINDOW_INVALID/
  );
});

class NoDebugSnapshotRepository extends InMemoryContextEngineRepository {
  override getDebugSnapshot(): never {
    throw new Error("background selector must not use getDebugSnapshot");
  }
}

function request(): SelectBackgroundMemoriesRequest {
  return {
    tenantId: "local",
    principalId: "debug-user",
    windowStart: "2026-07-20T09:00:00.000Z",
    windowEnd: "2026-07-20T11:00:00.000Z"
  };
}

function createStm(overrides: Partial<ShortTermMemory>): ShortTermMemory {
  const updatedAt = overrides.updatedAt ?? "2026-07-20T10:00:00.000Z";
  return {
    memoryDataId: "stm_default",
    tenantId: "local",
    principalId: "debug-user",
    memoryDataType: "manual_memory_event",
    memoryType: "fact",
    content: "默认背景记忆。",
    sourceFactIds: ["fact_default"],
    sourceRefs: [source("src_default")],
    entityIds: [],
    importanceLevel: "medium",
    confidenceLevel: "medium",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "medium",
      confidence: "medium",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "medium",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible",
    ...overrides,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt
  };
}

function source(id: string) {
  return { sourceRefId: id, sourceType: "file", sourceId: id };
}

async function saveAll(repository: InMemoryContextEngineRepository, memories: ShortTermMemory[]) {
  for (const memory of memories) await repository.saveShortTermMemory(memory);
}
