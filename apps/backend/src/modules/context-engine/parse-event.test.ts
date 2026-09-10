import test from "node:test";
import assert from "node:assert/strict";
import { parseAndAdmitEvent } from "./parse-event.js";
import type { MemoryEvent } from "./domain.js";
import { estimateContextTokens } from "./token-estimator.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

const originalFetch = globalThis.fetch;

test("parseAndAdmitEvent promotes each admitted fact into its own STM with entities and graph nodes", async () => {
  const repository = new InMemoryContextEngineRepository();
  let admissionRequestCount = 0;
  const embeddingBatches: string[][] = [];

  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      if (isStmAdmissionRequest(body)) {
        admissionRequestCount += 1;
        const factIds = extractPromptFactIds(body.messages?.[1]?.content ?? "");
        return chatJson({
          decisions: factIds.map((factId) => {
            const rejected = factId === "fact_llm_fact_level_stm_2";
            return {
              result: rejected ? "reject" : "write_short_term",
              memoryDataType: "fact",
              importanceLevel: rejected ? "low" : "medium",
              confidenceLevel: "high",
              reason: rejected ? "test_rejected_fact" : "test_admitted_fact",
              matchedRules: [rejected ? "test_reject" : "test_admit"],
              sourceFactIds: [factId]
            };
          })
        });
      }

      return chatJson({
        facts: [
          {
            factType: "preference",
            factText: "用户偏好回答直接。",
            normalizedClaim: "用户偏好回答直接",
            confidenceLevel: "high",
            linkedSegmentIds: ["seg_fact_level_stm_item_1"],
            entityIds: ["user_preference"],
            validTimeStart: "2026-07-11T08:00:00.000Z",
            timeBasis: "source_time",
            timeConfidence: "high"
          },
          {
            factType: "task",
            factText: "项目任务需要明天提醒。",
            normalizedClaim: "项目任务需要明天提醒",
            confidenceLevel: "high",
            linkedSegmentIds: ["seg_fact_level_stm_item_1"],
            entityIds: ["project_task"],
            validTimeStart: "2026-07-11T09:00:00.000Z",
            timeBasis: "source_time",
            timeConfidence: "high"
          },
          {
            factType: "secret",
            factText: "不要写入 STM 的拒绝事实。",
            normalizedClaim: "拒绝事实",
            confidenceLevel: "high",
            linkedSegmentIds: ["seg_fact_level_stm_item_1"],
            entityIds: ["secret_entity"],
            validTimeStart: "2026-07-11T10:00:00.000Z",
            timeBasis: "source_time",
            timeConfidence: "high"
          }
        ]
      });
    };

    await parseAndAdmitEvent(repository, createEvent(), undefined, {
      llm: {
        apiKey: "test-key",
        baseUrl: "http://localhost:1234",
        model: "test-model"
      },
      embeddingClient: {
        dimensions: 3,
        fingerprint: "parse-event-batch-test:3",
        async embed(inputs) {
          embeddingBatches.push([...inputs]);
          return inputs.map((input, index) => ({
            input,
            embedding: [index + 1, 0, 0],
            source: "deterministic-test" as const
          }));
        }
      }
    });

    const snapshot = repository.getDebugSnapshot();
    assert.equal(snapshot.facts.length, 3);
    assert.equal(snapshot.factBatches?.length, 1);
    assert.equal(snapshot.factBatches?.[0]?.triggerType, "event");
    assert.equal(snapshot.factBatches?.[0]?.tenantId, "local");
    assert.equal(snapshot.factBatches?.[0]?.principalId, "tester");
    assert.deepEqual(snapshot.factBatches?.[0]?.newFactIds, [
      "fact_llm_fact_level_stm_0",
      "fact_llm_fact_level_stm_1",
      "fact_llm_fact_level_stm_2"
    ]);
    assert.equal(snapshot.timelineFusionTasks?.length, 1);
    assert.equal(snapshot.timelineFusionTasks?.[0]?.status, "pending");
    assert.deepEqual(snapshot.timelineFusionTasks?.[0]?.batchIds, [snapshot.factBatches![0]!.batchId]);
    assert.equal(snapshot.shortTermMemories.length, 2);
    assert.equal(admissionRequestCount, 1);
    assert.deepEqual(embeddingBatches, [[
      "用户偏好回答直接\n用户偏好回答直接。",
      "项目任务需要明天提醒\n项目任务需要明天提醒。"
    ]]);
    assert.deepEqual(
      snapshot.shortTermMemories.map((memory) => memory.memoryDataId).sort(),
      [
        "stm_fact_llm_fact_level_stm_0",
        "stm_fact_llm_fact_level_stm_1"
      ]
    );
    assert.deepEqual(
      snapshot.shortTermMemories.map((memory) => memory.sourceFactIds),
      [
        ["fact_llm_fact_level_stm_0"],
        ["fact_llm_fact_level_stm_1"]
      ]
    );
    assert.deepEqual(
      snapshot.shortTermMemories.map((memory) => memory.entityIds),
      [
        ["user_preference"],
        ["project_task"]
      ]
    );
    assert.ok(snapshot.shortTermMemories.every((memory) => memory.tenantId === "local"));
    assert.ok(snapshot.shortTermMemories.every((memory) => memory.principalId === "tester"));
    assert.ok(snapshot.shortTermMemories.every((memory) => memory.createdAt === memory.updatedAt));
    assert.equal(snapshot.shortTermMemories.some((memory) => memory.sourceFactIds.includes("fact_llm_fact_level_stm_2")), false);
    assert.equal(snapshot.graphMemoryNodes.filter((node) => node.ownerType === "stm").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseAndAdmitEvent chunks text segments with the shared 2000 token parser budget", async () => {
  const repository = new InMemoryContextEngineRepository();
  const content = [
    `user: ${"aaaa ".repeat(1500).trim()}.`,
    `assistant: ${"bbbb ".repeat(1500).trim()}.`
  ].join("\n");

  await parseAndAdmitEvent(repository, {
    ...createEvent(),
    eventId: "parser_2000_token_budget",
    eventSummary: "parser 2000 token budget test",
    multimodalData: [{
      itemId: "item_1",
      type: "text",
      format: "plain",
      content,
      ref: "parser-2000-token-budget",
      sourceRefs: [{ sourceRefId: "src_parser_2000_token_budget", sourceType: "manual_text", sourceId: "parser-2000-token-budget" }],
      timeBasis: "source_time",
      timeConfidence: "high"
    }]
  }, undefined, { llm: { apiKey: "" }, skipStmAdmission: true });

  const segments = repository.getDebugSnapshot().parsedSegments;
  assert.equal(segments.length, 2);
  assert.equal(segments.every((segment) => estimateContextTokens(segment.content) <= 2000), true);
  assert.equal(segments[0]?.segmentId, "seg_parser_2000_token_budget_item_1_chunk_1");
  assert.equal(segments[1]?.segmentId, "seg_parser_2000_token_budget_item_1_chunk_2");
  assert.equal(segments[0]?.content.startsWith("user: aaaa"), true);
  assert.equal(segments[1]?.content.includes("assistant: bbbb"), true);
});

function createEvent(): MemoryEvent {
  return {
    eventId: "fact_level_stm",
    eventType: "manual_memory_event",
    eventSummary: "fact level STM test",
    eventTime: "2026-07-11T08:00:00.000Z",
    sourceApp: "test",
    sourceId: "fact-level-stm",
    permissionSnapshot: {
      snapshotId: "ps_fact_level_stm",
      tenantId: "local",
      principalId: "tester",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item_1",
      type: "text",
      format: "plain",
      content: "用户偏好回答直接。项目任务需要明天提醒。拒绝事实。",
      ref: "fact-level-stm",
      sourceRefs: [{ sourceRefId: "src_fact_level_stm", sourceType: "manual_text", sourceId: "fact-level-stm" }],
      timeBasis: "source_time",
      timeConfidence: "high"
    }],
    sourceRefs: [{ sourceRefId: "src_fact_level_stm", sourceType: "manual_text", sourceId: "fact-level-stm" }]
  };
}

function extractPromptFactIds(prompt: string) {
  try {
    const payload = JSON.parse(prompt) as { facts?: Array<{ factId?: string }> };
    return payload.facts?.map((fact) => fact.factId).filter((factId): factId is string => Boolean(factId)) ?? [];
  } catch {
    return [];
  }
}

function isStmAdmissionRequest(body: { messages?: Array<{ content?: string }> }) {
  try {
    const payload = JSON.parse(body.messages?.[1]?.content ?? "{}") as { task?: string };
    return typeof payload.task === "string" && payload.task.includes("STM");
  } catch {
    return false;
  }
}

function chatJson(payload: unknown) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
