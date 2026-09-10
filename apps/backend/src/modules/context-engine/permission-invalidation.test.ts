import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../../modules/health/server.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("permission invalidation hides related memory from search", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const eventId = `permission_${Date.now()}`;

  await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event: {
        eventId,
        eventType: "permission_test_event",
        eventDescription: "权限失效测试",
        eventTime: new Date().toISOString(),
        sourceApp: "test",
        sourceId: "permission-demo",
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
            content: "permission invalidation should hide this content",
            ref: "permission-demo"
          }
        ],
        sourceRefs: [
          {
            sourceRefId: `src_${eventId}`,
            sourceType: "file",
            sourceId: "permission-demo"
          }
        ]
      },
      idempotencyKey: eventId
    }
  });

  const searchBefore = await server.inject({ method: "GET", url: "/context/search?q=permission%20invalidation&layer=stm" });
  assert.equal(searchBefore.statusCode, 200);
  assert.equal(searchBefore.json().results.length > 0, true);

  const invalidate = await server.inject({
    method: "POST",
    url: "/context/permissions/invalidate",
    headers: { "content-type": "application/json" },
    payload: {
      sourceRefIds: [`src_${eventId}`],
      reason: "source access revoked"
    }
  });
  assert.equal(invalidate.statusCode, 200);

  const searchAfter = await server.inject({ method: "GET", url: "/context/search?q=permission%20invalidation&layer=stm" });
  assert.equal(searchAfter.statusCode, 200);
  assert.equal(searchAfter.json().results.length, 0);

  await server.close();
});
