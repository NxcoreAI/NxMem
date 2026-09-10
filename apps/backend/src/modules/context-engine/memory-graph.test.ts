import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembleContext } from "./assemble-context.js";
import type { LongTermMemory, ShortTermMemory } from "./domain.js";
import { reconcileMemoryGraphForLongTermMemory, reconcileMemoryGraphForShortTermMemory } from "./memory-graph.js";
import { parseAndAdmitEvent } from "./parse-event.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";

test("parseAndAdmitEvent automatically maintains STM graph relations", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = { sourceRefId: "src_auto_graph", sourceType: "file" as const, sourceId: "auto-graph" };

  await parseAndAdmitEvent(repository, {
    eventId: "auto_graph_1",
    eventType: "agent_context_memory_event",
    eventDescription: "自动图关系测试 1",
    eventTime: "2026-06-30T08:00:00.000Z",
    sourceApp: "test",
    sourceId: "auto-graph",
    permissionSnapshot: {
      snapshotId: "ps_auto_graph_1",
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{ itemId: "item_1", type: "text", format: "plain", content: "用户偏好回答直接" }],
    sourceRefs: [source]
  });
  await parseAndAdmitEvent(repository, {
    eventId: "auto_graph_2",
    eventType: "agent_context_memory_event",
    eventDescription: "自动图关系测试 2",
    eventTime: "2026-06-30T08:05:00.000Z",
    sourceApp: "test",
    sourceId: "auto-graph",
    permissionSnapshot: {
      snapshotId: "ps_auto_graph_2",
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{ itemId: "item_2", type: "text", format: "plain", content: "用户偏好回答直接并带例子" }],
    sourceRefs: [source]
  });

  const snapshot = repository.getDebugSnapshot();
  const firstStmId = snapshot.shortTermMemories.find((memory) => memory.sourceFactIds.some((factId) => factId.includes("auto_graph_1")))?.memoryDataId;
  const secondStmId = snapshot.shortTermMemories.find((memory) => memory.sourceFactIds.some((factId) => factId.includes("auto_graph_2")))?.memoryDataId;
  assert.ok(firstStmId);
  assert.ok(secondStmId);
  assert.ok(snapshot.relationEdges.some((edge) =>
    edge.fromId === firstStmId &&
    edge.toId === secondStmId &&
    edge.relationType === "same_source"
  ));
});

test("reconcileMemoryGraphForShortTermMemory creates STM-STM and STM-LTM edges", async () => {
  const repository = new InMemoryContextEngineRepository();
  const olderStm = createStm({
    memoryDataId: "stm_project_old",
    content: "张三负责旧项目排期",
    sourceFactIds: ["fact_project_schedule"],
    sourceRefId: "src_project",
    entityIds: ["person_zhangsan"],
    conflict: "none"
  });
  const ltm = createLtm({
    memoryId: "ltm_project_profile",
    content: "张三负责项目排期",
    sourceMemoryDataIds: ["stm_project_old"],
    sourceRefId: "src_project",
    entityIds: ["person_zhangsan"]
  });
  const newStm = createStm({
    memoryDataId: "stm_project_update",
    content: "张三加入新项目并更新排期",
    sourceFactIds: ["fact_project_schedule"],
    sourceRefId: "src_project",
    entityIds: ["person_zhangsan"],
    conflict: "known"
  });

  await repository.saveShortTermMemory(olderStm);
  await repository.saveLongTermMemory(ltm);
  await repository.saveShortTermMemory(newStm);

  await reconcileMemoryGraphForShortTermMemory(repository, newStm.memoryDataId);

  const edges = repository.getDebugSnapshot().relationEdges;
  assert.ok(edges.some((edge) =>
    edge.fromId === "stm_project_old" &&
    edge.toId === "stm_project_update" &&
    edge.relationType === "conflicts_with"
  ));
  assert.ok(edges.some((edge) =>
    edge.fromId === "ltm_project_profile" &&
    edge.toId === "stm_project_update" &&
    edge.relationType === "conflicts_with"
  ));
  assert.ok(edges.some((edge) =>
    edge.fromId === "stm_project_old" &&
    edge.toId === "stm_project_update" &&
    edge.relationType === "derived_from"
  ));
});

test("reconcileMemoryGraphForShortTermMemory creates alias, support, and part-of edges", async () => {
  const repository = new InMemoryContextEngineRepository();
  const base = createStm({
    memoryDataId: "stm_project_plan",
    content: "项目 Orion 包含检索模块、记忆图谱和调试前端",
    sourceFactIds: ["fact_project_plan"],
    sourceRefId: "src_project_plan",
    entityIds: ["project_orion", "module_retrieval", "module_memory_graph"],
    conflict: "none"
  });
  const alias = createStm({
    memoryDataId: "stm_project_alias",
    content: "项目 Orion alias 猎户座计划",
    sourceFactIds: ["fact_project_alias"],
    sourceRefId: "src_project_alias",
    entityIds: ["project_orion"],
    conflict: "none"
  });
  const support = createStm({
    memoryDataId: "stm_project_support",
    content: "检索模块已经完成，支持项目 Orion 的上线计划",
    sourceFactIds: ["fact_project_support"],
    sourceRefId: "src_project_support",
    entityIds: ["project_orion", "module_retrieval"],
    conflict: "none"
  });
  const part = createStm({
    memoryDataId: "stm_project_part",
    content: "检索模块是项目 Orion 的一部分",
    sourceFactIds: ["fact_project_part"],
    sourceRefId: "src_project_part",
    entityIds: ["project_orion", "module_retrieval"],
    conflict: "none"
  });

  await repository.saveShortTermMemory(base);
  await repository.saveShortTermMemory(alias);
  await repository.saveShortTermMemory(support);
  await repository.saveShortTermMemory(part);

  await reconcileMemoryGraphForShortTermMemory(repository, part.memoryDataId);

  const edges = repository.getDebugSnapshot().relationEdges;
  assert.ok(edges.some((edge) =>
    edge.fromId === "stm_project_alias" &&
    edge.toId === "stm_project_part" &&
    edge.relationType === "alias_of"
  ));
  assert.ok(edges.some((edge) =>
    ((edge.fromId === "stm_project_plan" && edge.toId === "stm_project_part") ||
      (edge.fromId === "stm_project_part" && edge.toId === "stm_project_plan")) &&
    edge.relationType === "supports"
  ));
  assert.ok(edges.some((edge) =>
    edge.fromId === "stm_project_part" &&
    edge.toId === "stm_project_plan" &&
    edge.relationType === "part_of"
  ));
});

test("SQLite persistence preserves STM graph relation inputs across repository restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stm-graph-persistence-"));
  const storePath = join(dir, "context.sqlite");
  const original = createStm({
    memoryDataId: "stm_persisted_graph_inputs",
    content: "持久化后的 STM 仍可参与图谱建链",
    sourceFactIds: ["fact_persisted_graph"],
    sourceRefId: "src_persisted_graph",
    entityIds: ["entity_persisted_graph"],
    conflict: "known"
  });
  const writer = new SqliteContextEngineRepository(storePath);
  await writer.saveShortTermMemory(original);

  const reader = new SqliteContextEngineRepository(storePath);
  const reloaded = reader.getDebugSnapshot().shortTermMemories.find((memory) =>
    memory.memoryDataId === original.memoryDataId
  );

  assert.deepEqual(reloaded?.sourceFactIds, original.sourceFactIds);
  assert.deepEqual(reloaded?.sourceRefs, original.sourceRefs);
  assert.deepEqual(reloaded?.entityIds, original.entityIds);
  assert.deepEqual(reloaded?.matchedRules, original.matchedRules);
  assert.equal(reloaded?.accessState, original.accessState);
});

test("reconcileMemoryGraphForLongTermMemory creates source and LTM-LTM graph edges idempotently", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm({
    memoryDataId: "stm_preference_direct",
    content: "用户偏好回答直接并带例子",
    sourceFactIds: ["fact_preference_direct"],
    sourceRefId: "src_preference",
    entityIds: ["user_preference"],
    conflict: "none"
  });
  const existingLtm = createLtm({
    memoryId: "ltm_preference_old",
    content: "用户偏好回答直接",
    sourceMemoryDataIds: ["stm_preference_direct"],
    sourceRefId: "src_preference",
    entityIds: ["user_preference"]
  });
  const newLtm = createLtm({
    memoryId: "ltm_preference_updated",
    content: "用户偏好回答直接，更新为需要带具体例子",
    sourceMemoryDataIds: ["stm_preference_direct"],
    sourceRefId: "src_preference",
    entityIds: ["user_preference"]
  });

  await repository.saveShortTermMemory(stm);
  await repository.saveLongTermMemory(existingLtm);
  await repository.saveLongTermMemory(newLtm);

  await reconcileMemoryGraphForLongTermMemory(repository, newLtm.memoryId);
  const firstEdges = repository.getDebugSnapshot().relationEdges;
  await reconcileMemoryGraphForLongTermMemory(repository, newLtm.memoryId);
  const secondEdges = repository.getDebugSnapshot().relationEdges;

  assert.equal(secondEdges.length, firstEdges.length);
  assert.ok(secondEdges.some((edge) =>
    edge.fromId === "ltm_preference_updated" &&
    edge.toId === "stm_preference_direct" &&
    edge.relationType === "derived_from"
  ));
  assert.ok(secondEdges.some((edge) =>
    edge.fromId === "ltm_preference_old" &&
    edge.toId === "ltm_preference_updated" &&
    edge.relationType === "updates"
  ));
});

test("assembleContext includes graph conflict edges from search candidates", async () => {
  const repository = new InMemoryContextEngineRepository();
  const oldMemory = createStm({
    memoryDataId: "stm_deadline_old",
    content: "项目截止时间是周五",
    sourceFactIds: ["fact_deadline"],
    sourceRefId: "src_deadline",
    entityIds: ["project_deadline"],
    conflict: "none"
  });
  const newMemory = createStm({
    memoryDataId: "stm_deadline_new",
    content: "项目截止时间更新为下周一",
    sourceFactIds: ["fact_deadline"],
    sourceRefId: "src_deadline",
    entityIds: ["project_deadline"],
    conflict: "known"
  });

  await repository.saveShortTermMemory(oldMemory);
  await repository.saveShortTermMemory(newMemory);
  await refreshShortTermMemoryIndex(repository, oldMemory);
  await refreshShortTermMemoryIndex(repository, newMemory);
  await reconcileMemoryGraphForShortTermMemory(repository, newMemory.memoryDataId);

  const pack = await assembleContext(repository, {
    task: "确认项目截止时间",
    q: "项目截止时间",
    tokenBudget: 1000
  });

  assert.ok(pack.conflicts.some((conflict) =>
    conflict.fromId === "stm_deadline_new" &&
    conflict.toId === "stm_deadline_old"
  ));
});

function createStm(input: {
  memoryDataId: string;
  content: string;
  sourceFactIds: string[];
  sourceRefId: string;
  entityIds: string[];
  conflict: ShortTermMemory["admissionSignals"]["conflict"];
}): ShortTermMemory {
  return {
    memoryDataId: input.memoryDataId,
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "manual_memory_event",
    content: input.content,
    sourceFactIds: input.sourceFactIds,
    sourceRefs: [{ sourceRefId: input.sourceRefId, sourceType: "file", sourceId: input.sourceRefId }],
    entityIds: input.entityIds,
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "memory_graph_test",
    matchedRules: ["memory_graph_test"],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: input.conflict,
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible"
  };
}

function createLtm(input: {
  memoryId: string;
  content: string;
  sourceMemoryDataIds: string[];
  sourceRefId: string;
  entityIds: string[];
}): LongTermMemory {
  return {
    memoryId: input.memoryId,
    theoryClass: "semantic",
    memoryType: "preference",
    content: input.content,
    summary: input.content,
    sourceRefs: [{ sourceRefId: input.sourceRefId, sourceType: "file", sourceId: input.sourceRefId }],
    sourceMemoryDataIds: input.sourceMemoryDataIds,
    entityIds: input.entityIds,
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "memory_graph_test",
    matchedRules: ["memory_graph_test"],
    lifecycleStatus: "active",
    accessState: "visible"
  };
}
