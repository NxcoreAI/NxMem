import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../../modules/health/server.js";
import { refreshLongTermMemoryIndex, refreshShortTermMemoryIndex } from "./indexing.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { searchContext } from "./search-context.js";

test("long term lifecycle reconciliation removes stale index entries when archived", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);
  const eventId = `lifecycle_${Date.now()}`;

  await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event: {
        eventId,
        eventType: "lifecycle_reconcile_event",
        eventDescription: "生命周期状态机测试",
        eventTime: new Date().toISOString(),
        sourceApp: "context-debug-frontend",
        sourceId: "lifecycle-reconcile",
        permissionSnapshot: {
          snapshotId: `ps_${eventId}`,
          tenantId: "local",
          principalId: "debug-user",
          sourceAclVersion: "v1",
          visibility: "private"
        },
        multimodalData: [
          {
            itemId: `item_${eventId}`,
            type: "text",
            format: "plain",
            content: "revised long term memory should remain indexed until archived",
            ref: "lifecycle-reconcile"
          }
        ],
        sourceRefs: [
          {
            sourceRefId: `src_${eventId}`,
            sourceType: "file",
            sourceId: "lifecycle-reconcile"
          }
        ]
      },
      idempotencyKey: eventId
    }
  });

  const createdSnapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  const sourceStm = createdSnapshot.shortTermMemories.find((item: { sourceFactIds?: string[] }) =>
    item.sourceFactIds?.some((factId) => factId.includes(eventId))
  );
  assert.ok(sourceStm);

  const dream = await server.inject({
    method: "POST",
    url: "/context/dreaming/run",
    headers: { "content-type": "application/json" },
    payload: {
      memoryDataIds: [sourceStm.memoryDataId]
    }
  });
  assert.equal(dream.statusCode, 200);

  const beforeUpdate = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  const ltm = beforeUpdate.longTermMemories.find((item: { memoryId: string }) => item.memoryId.startsWith("ltm_dream_"));
  assert.ok(ltm);
  await refreshLongTermMemoryIndex(repository, ltm);
  assert.equal(beforeUpdate.indexEntries.some((item: { ownerId: string }) => item.ownerId === ltm.memoryId), true);

  const reviseResponse = await server.inject({
    method: "PATCH",
    url: `/context/memories/ltm/${ltm.memoryId}`,
    headers: { "content-type": "application/json" },
    payload: {
      lifecycleStatus: "revised"
    }
  });
  assert.equal(reviseResponse.statusCode, 200);

  const revisedSnapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  assert.equal(revisedSnapshot.indexEntries.some((item: { ownerId: string }) => item.ownerId === ltm.memoryId), true);

  const archiveResponse = await server.inject({
    method: "PATCH",
    url: `/context/memories/ltm/${ltm.memoryId}`,
    headers: { "content-type": "application/json" },
    payload: {
      lifecycleStatus: "archived"
    }
  });
  assert.equal(archiveResponse.statusCode, 200);

  const archivedSnapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  assert.equal(archivedSnapshot.indexEntries.some((item: { ownerId: string }) => item.ownerId === ltm.memoryId), false);
  assert.equal(archivedSnapshot.textIndexEntries.some((item: { ownerId: string }) => item.ownerId === ltm.memoryId), false);
  assert.equal(archivedSnapshot.vectorIndexEntries.some((item: { ownerId: string }) => item.ownerId === ltm.memoryId), false);

  await server.close();
});

test("short term lifecycle update removes stale index entries when deleted", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);

  await repository.saveShortTermMemory({
    memoryDataId: "stm_delete_reconcile",
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "fact",
    memoryType: "fact",
    content: "短期记忆删除后不应继续保留可召回索引",
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "test",
    sourceFactIds: ["fact_delete_reconcile"],
    sourceRefs: [{ sourceRefId: "src_delete_reconcile", sourceType: "file", sourceId: "delete-reconcile" }],
    entityIds: ["entity_delete_reconcile"],
    matchedRules: [],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      actorWeight: "medium",
      sensitivity: "low",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible"
  });
  await refreshShortTermMemoryIndex(repository, repository.getDebugSnapshot().shortTermMemories[0]!);
  assert.equal(repository.getDebugSnapshot().indexEntries.some((item) => item.ownerId === "stm_delete_reconcile"), true);

  const deleteResponse = await server.inject({
    method: "PATCH",
    url: "/context/memories/stm/stm_delete_reconcile",
    headers: { "content-type": "application/json" },
    payload: {
      lifecycleStatus: "deleted"
    }
  });
  assert.equal(deleteResponse.statusCode, 200);

  const snapshot = repository.getDebugSnapshot();
  assert.equal(snapshot.shortTermMemories.find((item) => item.memoryDataId === "stm_delete_reconcile")?.lifecycleStatus, "deleted");
  assert.equal(snapshot.indexEntries.some((item) => item.ownerId === "stm_delete_reconcile"), false);
  assert.equal(snapshot.textIndexEntries.some((item) => item.ownerId === "stm_delete_reconcile"), false);
  assert.equal(snapshot.vectorIndexEntries.some((item) => item.ownerId === "stm_delete_reconcile"), false);
  assert.equal(snapshot.graphMemoryNodes.some((item) => item.ownerId === "stm_delete_reconcile"), false);
  assert.equal((await searchContext(repository, { q: "不应继续保留", layer: "stm", includeInactive: true })).results.length, 0);

  await server.close();
});

test("long term downgrade lowers recall while remaining recall eligible", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);

  await repository.saveLongTermMemory({
    memoryId: "ltm_soft_and_state_downgrade",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "用户偏好：软降权后仍可召回，状态降权后退出普通召回",
    confidenceLevel: "high",
    recallWeight: "high",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    sourceRefs: [{ sourceRefId: "src_downgrade", sourceType: "file", sourceId: "downgrade-demo" }],
    sourceMemoryDataIds: ["stm_downgrade"],
    entityIds: ["entity_downgrade"]
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const softResponse = await server.inject({
    method: "PATCH",
    url: "/context/memories/ltm/ltm_soft_and_state_downgrade",
    headers: { "content-type": "application/json" },
    payload: {
      recallWeight: "medium"
    }
  });
  assert.equal(softResponse.statusCode, 200);

  const softSnapshot = repository.getDebugSnapshot();
  const softened = softSnapshot.longTermMemories.find((item) => item.memoryId === "ltm_soft_and_state_downgrade");
  const softenedGraphNode = softSnapshot.graphMemoryNodes.find((item) => item.ownerId === "ltm_soft_and_state_downgrade");
  assert.equal(softened?.lifecycleStatus, "active");
  assert.equal(softened?.recallWeight, "medium");
  assert.equal(softened?.retrievalWeight, 1);
  assert.equal(softened?.userRetrievalWeight, 0.6);
  assert.equal(softenedGraphNode?.retrievalWeight, 1);

  const softSearch = await searchContext(repository, { q: "软降权", layer: "ltm" });
  assert.equal(softSearch.results.some((item) => item.id === "ltm_soft_and_state_downgrade"), true);
  const softenedResult = softSearch.results.find((item) => item.id === "ltm_soft_and_state_downgrade");
  assert.equal(softenedResult?.scoreBreakdown.retrievalWeight, 1);
  assert.equal(softenedResult?.scoreBreakdown.userRetrievalWeight, 0.6);
  assert.equal(softenedResult?.scoreBreakdown.importance, 0.7);

  const stateResponse = await server.inject({
    method: "PATCH",
    url: "/context/memories/ltm/ltm_soft_and_state_downgrade",
    headers: { "content-type": "application/json" },
    payload: {
      lifecycleStatus: "weakened"
    }
  });
  assert.equal(stateResponse.statusCode, 200);

  const stateSnapshot = repository.getDebugSnapshot();
  assert.equal(stateSnapshot.longTermMemories.find((item) => item.memoryId === "ltm_soft_and_state_downgrade")?.lifecycleStatus, "weakened");
  assert.equal(stateSnapshot.indexEntries.some((item) => item.ownerId === "ltm_soft_and_state_downgrade"), true);
  assert.equal(stateSnapshot.graphMemoryNodes.some((item) => item.ownerId === "ltm_soft_and_state_downgrade"), true);

  const weakenedSearch = await searchContext(repository, { q: "软降权", layer: "ltm" });
  const weakenedResult = weakenedSearch.results.find((item) => item.id === "ltm_soft_and_state_downgrade");
  assert.ok(weakenedResult);
  assert.equal(weakenedResult.status, "weakened");
  assert.equal(weakenedResult.scoreBreakdown.retrievalWeight, 1);
  assert.equal(weakenedResult.scoreBreakdown.userRetrievalWeight, 0.6);
  assert.equal(weakenedResult.scoreBreakdown.importance, 0.7);

  await server.close();
});

test("manual archive can be restored while delete remains terminal", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);

  await repository.saveLongTermMemory({
    memoryId: "ltm_restore_archive",
    theoryClass: "semantic",
    memoryType: "profile",
    content: "用户偏好：归档后可以由用户撤销恢复",
    confidenceLevel: "high",
    recallWeight: "medium",
    solidifyReason: "test",
    matchedRules: [],
    lifecycleStatus: "active",
    sourceRefs: [{ sourceRefId: "src_restore", sourceType: "file", sourceId: "restore-demo" }],
    sourceMemoryDataIds: ["stm_restore"],
    entityIds: ["entity_restore"]
  });
  await refreshLongTermMemoryIndex(repository, repository.getDebugSnapshot().longTermMemories[0]!);

  const archiveResponse = await server.inject({
    method: "PATCH",
    url: "/context/memories/ltm/ltm_restore_archive",
    headers: { "content-type": "application/json" },
    payload: {
      lifecycleStatus: "archived"
    }
  });
  assert.equal(archiveResponse.statusCode, 200);
  assert.equal((await searchContext(repository, { q: "归档后可以", layer: "ltm" })).results.length, 0);

  const restoreResponse = await server.inject({
    method: "PATCH",
    url: "/context/memories/ltm/ltm_restore_archive",
    headers: { "content-type": "application/json" },
    payload: {
      lifecycleStatus: "active"
    }
  });
  assert.equal(restoreResponse.statusCode, 200);
  assert.equal(repository.getDebugSnapshot().indexEntries.some((item) => item.ownerId === "ltm_restore_archive"), true);
  assert.equal((await searchContext(repository, { q: "归档后可以", layer: "ltm" })).results.some((item) => item.id === "ltm_restore_archive"), true);

  const deleteResponse = await server.inject({
    method: "PATCH",
    url: "/context/memories/ltm/ltm_restore_archive",
    headers: { "content-type": "application/json" },
    payload: {
      lifecycleStatus: "deleted"
    }
  });
  assert.equal(deleteResponse.statusCode, 200);

  const restoreDeletedResponse = await server.inject({
    method: "PATCH",
    url: "/context/memories/ltm/ltm_restore_archive",
    headers: { "content-type": "application/json" },
    payload: {
      lifecycleStatus: "active"
    }
  });
  assert.equal(restoreDeletedResponse.statusCode, 400);
  assert.equal((await searchContext(repository, { q: "归档后可以", layer: "ltm", includeInactive: true })).results.length, 0);

  await server.close();
});
