import test from "node:test";
import assert from "node:assert/strict";
import { createContextEngineService } from "./write-event.js";
import type { MemoryEvent } from "./domain.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("writeEvent can acknowledge durable event writes before slow LLM pipeline finishes", async () => {
  const repository = new InMemoryContextEngineRepository();
  const service = createContextEngineService(repository);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    await delay(80);
    const body = init?.body ? JSON.parse(String(init.body)) as { messages?: Array<{ content?: string }> } : {};
    const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? "";
    const payload = prompt.includes("STM")
      ? {
          result: "write_high_priority",
          memoryDataType: "manual_memory_event",
          importanceLevel: "high",
          confidenceLevel: "high",
          reason: "test_llm_admission",
          matchedRules: ["test"],
          sourceFactIds: ["fact_seg_event_defer_item_event_defer"]
        }
      : {
          facts: [
            {
              factType: "text",
              factText: "延迟管线应快速确认事件入库，并在后台继续完成事实融合和STM准入。",
              normalizedClaim: "延迟管线快速确认事件入库",
              confidenceLevel: "high",
              linkedSegmentIds: ["seg_event_defer_item_event_defer"],
              entityIds: ["context_engine"],
              validTimeStart: "2026-07-03T08:00:00.000Z",
              timeBasis: "source_time",
              timeConfidence: "high"
            }
          ]
        };

    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const event = createTextEvent("event_defer");
    const startedAt = Date.now();
    const result = await service.writeEvent({
      event,
      idempotencyKey: "event_defer",
      deferPipeline: true,
      llm: {
        apiKey: "test-key",
        baseUrl: "https://llm.example/v1",
        model: "test-model"
      }
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.accepted, true);
    assert.equal(result.pipelineStatus, "queued");
    assert.equal(elapsedMs < 80, true);
    assert.equal(repository.getDebugSnapshot().memoryEvents.some((item) => item.eventId === "event_defer"), true);

    await waitFor(() => repository.getDebugSnapshot().shortTermMemories.some((item) =>
      item.sourceFactIds.includes("fact_seg_event_defer_item_event_defer")
    ));
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createTextEvent(eventId: string): MemoryEvent {
  return {
    eventId,
    eventType: "manual_memory_event",
    eventDescription: "延迟入库测试",
    eventTime: "2026-07-03T08:00:00.000Z",
    sourceApp: "test",
    sourceId: "defer-pipeline",
    permissionSnapshot: {
      snapshotId: `ps_${eventId}`,
      tenantId: "local",
      principalId: "tester",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: `item_${eventId}`,
        type: "text",
        format: "plain",
        content: "延迟管线应快速确认事件入库，并在后台继续完成事实融合和STM准入。",
        ref: "defer-pipeline",
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ],
    sourceRefs: [
      {
        sourceRefId: `src_${eventId}`,
        sourceType: "file",
        sourceId: "defer-pipeline"
      }
    ]
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  assert.equal(predicate(), true);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
