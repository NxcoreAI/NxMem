import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../../modules/health/server.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("manually advances raw text to LTM step by step with configured event time", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const eventTime = "2026-06-18T08:30:00.000Z";

  const eventResponse = await server.inject({
    method: "POST",
    url: "/context/debug/manual-step",
    headers: { "content-type": "application/json" },
    payload: {
      action: "event",
      content: "Agent context 手动分步测试：先落原始文本，再进入数据湖、时间轴融合、STM 和 LTM。",
      eventType: "manual_step_context_event",
      description: "手动分步原始文本到 LTM",
      sourceId: "manual-step-test",
      eventTime
    }
  });
  assert.equal(eventResponse.statusCode, 200);
  const eventResult = eventResponse.json().result;
  assert.equal(eventResult.task.status, "succeeded");
  assert.equal(eventResult.task.stage, "raw_text_saved");
  let snapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  const createdEvent = snapshot.memoryEvents.find((event: { eventTime: string }) => event.eventTime === eventTime);
  assert.ok(createdEvent);
  const rawTextTask = snapshot.pipelineTasks.find((task: { taskId: string }) => task.taskId === eventResult.task.taskId);
  assert.equal(rawTextTask?.status, "succeeded");
  assert.equal(rawTextTask?.stage, "raw_text_saved");
  assert.equal(snapshot.parsedSegments.length, 0);
  assert.equal(snapshot.facts.length, 0);
  assert.equal(snapshot.shortTermMemories.length, 0);
  assert.equal(snapshot.longTermMemories.length, 0);

  const dataLakeResponse = await runStep(server, "data_lake");
  assert.equal(dataLakeResponse.statusCode, 200);
  snapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  assert.ok(snapshot.parsedSegments.length >= 1);

  const fusionResponse = await runStep(server, "timeline_fusion");
  assert.equal(fusionResponse.statusCode, 200);
  snapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  assert.ok(snapshot.facts.length >= 1);

  const stmResponse = await runStep(server, "stm");
  assert.equal(stmResponse.statusCode, 200);
  snapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  assert.ok(snapshot.shortTermMemories.length >= 1);

  const ltmResponse = await runStep(server, "ltm");
  assert.equal(ltmResponse.statusCode, 200);
  snapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  assert.ok(snapshot.longTermMemories.length >= 1);
  assert.ok(snapshot.llmDreamingTraces.length >= 1);
  assert.ok(ltmResponse.json().result.ltmResult.trace.sourceMemoryDataIds.length >= 1);

  await server.close();
});

test("manual stm step creates a missing tracked event from payload content", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const eventId = "manual_step_tracked_stm_event";

  const response = await server.inject({
    method: "POST",
    url: "/context/debug/manual-step",
    headers: { "content-type": "application/json" },
    payload: {
      action: "stm",
      eventId,
      content: "带稳定 eventId 的 STM 分步触发应先创建事件，再解析、融合并准入短期记忆。",
      eventType: "manual_step_tracked_stm",
      sourceId: "manual-step-tracked"
    }
  });

  assert.equal(response.statusCode, 200);
  const result = response.json().result;
  assert.equal(result.event.eventId, eventId);
  assert.equal(result.shortTermMemory.memoryDataId, `stm_${eventId}`);

  const snapshot = (await server.inject({ method: "GET", url: "/context/debug/snapshot" })).json().items;
  assert.ok(snapshot.memoryEvents.some((event: { eventId: string }) => event.eventId === eventId));
  assert.ok(snapshot.shortTermMemories.some((memory: { memoryDataId: string }) => memory.memoryDataId === `stm_${eventId}`));

  await server.close();
});

function runStep(server: Awaited<ReturnType<typeof createHealthServer>>, action: string) {
  return server.inject({
    method: "POST",
    url: "/context/debug/manual-step",
    headers: { "content-type": "application/json" },
    payload: {
      action
    }
  });
}
