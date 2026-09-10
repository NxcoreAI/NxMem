import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../../modules/health/server.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("deletes an event context tree from the debug snapshot", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const eventId = `delete_tree_${Date.now()}`;
  const event = {
    eventId,
    eventType: "manual_memory_event",
    eventDescription: "删除上下文树测试",
    eventTime: new Date().toISOString(),
    sourceApp: "test",
    sourceId: "delete-demo",
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
        content: "删除这条上下文数据后，派生事实和记忆都应消失。",
        ref: "delete-demo"
      }
    ],
    sourceRefs: [
      {
        sourceRefId: `src_${eventId}`,
        sourceType: "file",
        sourceId: "delete-demo"
      }
    ]
  };

  const createResponse = await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event,
      idempotencyKey: eventId
    }
  });
  assert.equal(createResponse.statusCode, 200);

  const before = await server.inject({ method: "GET", url: "/context/debug/snapshot" });
  const beforeItems = before.json().items as {
    memoryEvents: Array<{ eventId: string }>;
    parsedSegments: Array<{ eventId: string }>;
    facts: Array<{ linkedEventIds: string[] }>;
    shortTermMemories: Array<{ memoryDataId: string }>;
    longTermMemories: Array<{ sourceMemoryDataIds: string[] }>;
    llmFactFusionTraces: Array<{ eventId: string }>;
  };
  assert.ok(beforeItems.memoryEvents.some((item) => item.eventId === eventId));

  const deleteResponse = await server.inject({
    method: "DELETE",
    url: `/context/events/${eventId}`
  });
  assert.equal(deleteResponse.statusCode, 200);

  const after = await server.inject({ method: "GET", url: "/context/debug/snapshot" });
  const afterItems = after.json().items as {
    memoryEvents: Array<{ eventId: string }>;
    parsedSegments: Array<{ eventId: string }>;
    facts: Array<{ linkedEventIds: string[] }>;
    shortTermMemories: Array<{ memoryDataId: string }>;
    longTermMemories: Array<{ sourceMemoryDataIds: string[] }>;
    llmFactFusionTraces: Array<{ eventId: string }>;
    indexEntries: Array<{ ownerId: string }>;
  };

  assert.equal(afterItems.memoryEvents.some((item) => item.eventId === eventId), false);
  assert.equal(afterItems.parsedSegments.some((item) => item.eventId === eventId), false);
  assert.equal(afterItems.facts.some((item) => item.linkedEventIds.includes(eventId)), false);
  assert.equal(afterItems.shortTermMemories.some((item) => item.memoryDataId === `stm_${eventId}`), false);
  assert.equal(afterItems.longTermMemories.some((item) => item.sourceMemoryDataIds.includes(`stm_${eventId}`)), false);
  assert.equal(afterItems.llmFactFusionTraces.some((item) => item.eventId === eventId), false);
  assert.equal(afterItems.indexEntries.some((item) => item.ownerId.includes(eventId)), false);

  await server.close();
});

test("clears all context debug data", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const eventId = `clear_all_${Date.now()}`;
  const event = {
    eventId,
    eventType: "manual_memory_event",
    eventDescription: "清空上下文数据测试",
    eventTime: new Date().toISOString(),
    sourceApp: "test",
    sourceId: "clear-demo",
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
        content: "一键清空后，所有上下文调试数据都应为空。",
        ref: "clear-demo"
      }
    ],
    sourceRefs: [
      {
        sourceRefId: `src_${eventId}`,
        sourceType: "file",
        sourceId: "clear-demo"
      }
    ]
  };

  const createResponse = await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event,
      idempotencyKey: eventId
    }
  });
  assert.equal(createResponse.statusCode, 200);

  const clearResponse = await server.inject({
    method: "DELETE",
    url: "/context/debug/data"
  });
  assert.equal(clearResponse.statusCode, 200);
  assert.ok(clearResponse.json().result.deleted.memoryEvents >= 1);

  const snapshotResponse = await server.inject({ method: "GET", url: "/context/debug/snapshot" });
  const items = snapshotResponse.json().items as Record<string, unknown[]>;
  for (const [key, value] of Object.entries(items)) {
    assert.equal(value.length, 0, `${key} should be empty`);
  }

  await server.close();
});
