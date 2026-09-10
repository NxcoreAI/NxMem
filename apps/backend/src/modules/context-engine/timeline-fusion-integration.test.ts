import assert from "node:assert/strict";
import test from "node:test";
import type {
  FactItem,
  MemoryEvent,
  TimelineFusionTask
} from "./domain.js";
import { createFactBatchCommitted } from "./fact-batch.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { prepareTimelineFusionTask } from "./timeline-fusion-candidate-processor.js";
import { judgeTimelineFusionRelationsWithLlm } from "./timeline-fusion-relation-judgment.js";
import type { TimelineFusionRelationInput } from "./timeline-fusion-relations.js";
import { createTimelineFusionTask } from "./timeline-fusion-task.js";

const NOW = "2026-08-07T06:30:00.000Z";
const WINDOW_MS = 60 * 60 * 1_000;

test("recalls a related fact across events but keeps the dated fact atomic", async () => {
  const repository = new InMemoryContextEngineRepository();
  await commitBatch(repository, "history_review", [fact("fact_review", "event_review", {
    factText: "周五评审方案",
    normalizedClaim: "周五评审方案",
    entityIds: ["project_review"],
    evidenceTimeStart: "2026-08-07T06:00:00.000Z"
  })]);
  const task = await readyTask(repository, "new_review_detail", [fact(
    "fact_review_detail",
    "event_review_detail",
    {
      factText: "方案评审重点关注功耗和成本",
      normalizedClaim: "方案评审重点关注功耗和成本",
      entityIds: ["project_review"],
      evidenceTimeStart: "2026-08-07T06:20:00.000Z"
    }
  )]);

  const prepared = await prepareTimelineFusionTask(repository, task, {
    windowMs: WINDOW_MS,
    now: () => NOW
  });
  const relationInput = onlyRelationInput(prepared.windows);
  assert.deepEqual(relationInput.facts.map((item) => item.factId).sort(), [
    "fact_review",
    "fact_review_detail"
  ]);
  assert.notDeepEqual(
    relationInput.facts[0]?.linkedEventIds,
    relationInput.facts[1]?.linkedEventIds
  );

  const judgment = await judgeTimelineFusionRelationsWithLlm(relationInput, llmOptions({
    relations: [{
      type: "supplements",
      sourceFactIds: ["fact_review_detail", "fact_review"],
      factText: "周五进行方案评审，重点关注功耗和成本。",
      normalizedClaim: "周五方案评审关注功耗和成本",
      confidenceLevel: "high",
      reasonCode: "review_detail_added"
    }]
  }));

  assert.equal(judgment.status, "fallback");
  assert.equal(judgment.fallbackReason, "protected_details_lost");
  assert.deepEqual(judgment.result.relations, []);
  assert.deepEqual(judgment.result.unusedFactIds, ["fact_review", "fact_review_detail"]);
});

test("groups a committed batch and makes one LLM request per related group, not per fact", async () => {
  const repository = new InMemoryContextEngineRepository();
  await commitBatch(repository, "history_lunch", [fact("fact_lunch", "event_lunch", {
    factText: "Bob ordered noodles for lunch",
    normalizedClaim: "Bob ordered noodles for lunch",
    entityIds: ["bob"],
    evidenceTimeStart: "2026-08-07T06:22:00.000Z"
  })]);
  const task = await readyTask(repository, "batched_inputs", [
    fact("fact_review_time", "event_review_time", {
      factText: "Atlas review starts this afternoon",
      normalizedClaim: "Atlas review starts this afternoon",
      entityIds: ["atlas_review"],
      evidenceTimeStart: "2026-08-07T06:20:00.000Z"
    }),
    fact("fact_review_scope", "event_review_scope", {
      factText: "Atlas review covers power and cost",
      normalizedClaim: "Atlas review covers power and cost",
      entityIds: ["atlas_review"],
      evidenceTimeStart: "2026-08-07T06:25:00.000Z"
    }),
    fact("fact_weather", "event_weather", {
      factText: "Shanghai weather is rainy",
      normalizedClaim: "Shanghai weather is rainy",
      entityIds: ["shanghai_weather"],
      evidenceTimeStart: "2026-08-07T06:26:00.000Z"
    })
  ]);

  const prepared = await prepareTimelineFusionTask(repository, task, {
    windowMs: WINDOW_MS,
    now: () => NOW
  });
  assert.equal(prepared.windows.length, 2);
  const readyWindows = prepared.windows.filter((item) => item.relationInput);
  const skippedWindows = prepared.windows.filter((item) => !item.relationInput);
  assert.equal(readyWindows.length, 1);
  assert.deepEqual(readyWindows[0]?.newFactIds, ["fact_review_scope", "fact_review_time"]);
  assert.deepEqual(readyWindows[0]?.candidateFactIds, []);
  assert.deepEqual(skippedWindows.map((item) => item.newFactIds), [["fact_weather"]]);
  assert.equal(skippedWindows[0]?.decision, "no_candidate");
  assert.equal(
    readyWindows[0]?.relationInput?.facts.some((item) => item.factId === "fact_lunch"),
    false
  );

  let requestCount = 0;
  const judgments = await Promise.all(readyWindows.map((item) =>
    judgeTimelineFusionRelationsWithLlm(item.relationInput!, llmOptions({
      relations: [{
        type: "same_event",
        sourceFactIds: ["fact_review_scope", "fact_review_time"],
        factText: "Atlas review starts this afternoon and covers power and cost.",
        normalizedClaim: "Atlas review starts this afternoon covering power and cost",
        confidenceLevel: "high",
        reasonCode: "same_atlas_review"
      }]
    }, () => {
      requestCount += 1;
    }))
  ));

  assert.equal(requestCount, 1);
  assert.equal(judgments[0]?.result.relations[0]?.type, "same_event");
});

test("keeps same-topic conflicts distinct from same_event", async () => {
  const relationInput = await preparePair(
    fact("fact_old_schedule", "event_old_schedule", {
      factText: "方案评审安排在周五",
      normalizedClaim: "方案评审安排在周五",
      entityIds: ["project_review"],
      evidenceTimeStart: "2026-08-07T06:00:00.000Z"
    }),
    fact("fact_schedule_denial", "event_schedule_denial", {
      factText: "方案评审不会在周五进行",
      normalizedClaim: "方案评审不在周五进行",
      entityIds: ["project_review"],
      evidenceTimeStart: "2026-08-07T06:20:00.000Z"
    })
  );

  const judgment = await judgeTimelineFusionRelationsWithLlm(relationInput, llmOptions({
    relations: [{
      type: "conflicts",
      sourceFactIds: ["fact_schedule_denial", "fact_old_schedule"],
      factText: null,
      normalizedClaim: null,
      confidenceLevel: "high",
      reasonCode: "review_date_conflict"
    }]
  }));

  assert.equal(judgment.status, "succeeded");
  assert.equal(judgment.result.relations[0]?.type, "conflicts");
  assert.equal(judgment.result.relations.some((item) => item.type === "same_event"), false);
});

test("keeps old and new dated schedules atomic", async () => {
  const relationInput = await preparePair(
    fact("fact_friday_schedule", "event_friday_schedule", {
      factText: "方案评审安排在 2026-08-07",
      normalizedClaim: "方案评审日期为 2026-08-07",
      entityIds: ["project_review"],
      evidenceTimeStart: "2026-08-07T06:00:00.000Z"
    }),
    fact("fact_monday_schedule", "event_monday_schedule", {
      factText: "方案评审改为 2026-08-10",
      normalizedClaim: "方案评审日期更新为 2026-08-10",
      entityIds: ["project_review"],
      evidenceTimeStart: "2026-08-07T06:25:00.000Z"
    })
  );

  const judgment = await judgeTimelineFusionRelationsWithLlm(relationInput, llmOptions({
    relations: [{
      type: "updates",
      sourceFactIds: ["fact_monday_schedule", "fact_friday_schedule"],
      factText: "方案评审日期已更新为 2026-08-10。",
      normalizedClaim: "方案评审日期更新为 2026-08-10",
      confidenceLevel: "high",
      reasonCode: "review_date_updated"
    }]
  }));

  assert.equal(judgment.status, "fallback");
  assert.equal(judgment.fallbackReason, "protected_details_lost");
  assert.deepEqual(judgment.result.relations, []);
  assert.deepEqual(judgment.result.unusedFactIds, ["fact_friday_schedule", "fact_monday_schedule"]);
});

test("does not call the LLM when a weak time anchor is the only common signal", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveMemoryEvent(event("event_lunch", "2026-08-07T06:20:00.000Z"));
  await repository.saveMemoryEvent(event("event_deploy", "2026-08-07T06:25:00.000Z"));
  await commitBatch(repository, "weak_history", [fact("fact_lunch", "event_lunch", {
    factText: "Bob ordered noodles for lunch",
    normalizedClaim: "Bob ordered noodles for lunch",
    entityIds: ["bob"]
  })]);
  const task = await readyTask(repository, "weak_new", [fact("fact_deploy", "event_deploy", {
    factText: "Atlas deployment started",
    normalizedClaim: "Atlas deployment started",
    entityIds: ["atlas"]
  })]);

  const prepared = await prepareTimelineFusionTask(repository, task, {
    windowMs: WINDOW_MS,
    now: () => NOW
  });
  assert.equal(prepared.windows[0]?.temporalWindow.basis, "weak_anchor");
  assert.equal(prepared.windows[0]?.decision, "no_candidate");
  assert.equal(prepared.windows[0]?.relationInput, undefined);
});

test("preserves every recalled fact through all LLM fallback paths", async () => {
  const relationInput = await preparePair(
    fact("fact_commute_history", "event_commute_history", {
      factText: "用户在通勤时使用 Audible 听有声书",
      normalizedClaim: "用户通勤使用 Audible 听有声书",
      entityIds: ["user_commute"],
      evidenceTimeStart: "2026-08-07T06:00:00.000Z"
    }),
    fact("fact_commute_new", "event_commute_new", {
      factText: "用户每天单程通勤 45 分钟",
      normalizedClaim: "用户每天单程通勤 45 分钟",
      entityIds: ["user_commute"],
      evidenceTimeStart: "2026-08-07T06:20:00.000Z"
    })
  );
  const expectedFactIds = ["fact_commute_history", "fact_commute_new"];

  const missingKey = await judgeTimelineFusionRelationsWithLlm(relationInput, {
    apiKey: "",
    fetchImpl: async () => {
      throw new Error("must_not_request");
    }
  });
  const requestFailure = await judgeTimelineFusionRelationsWithLlm(relationInput, {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234",
    transport: "fetch",
    maxAttempts: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      throw new Error("network_down");
    }
  });
  const invalidResponse = await judgeTimelineFusionRelationsWithLlm(relationInput, {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234",
    transport: "fetch",
    maxAttempts: 1,
    fetchImpl: async () => new Response("not-json", { status: 200 })
  });
  const protectedDetailsLost = await judgeTimelineFusionRelationsWithLlm(
    relationInput,
    llmOptions({
      relations: [{
        type: "supplements",
        sourceFactIds: ["fact_commute_new", "fact_commute_history"],
        factText: "用户通勤时听有声书。",
        normalizedClaim: "用户通勤听有声书",
        confidenceLevel: "high",
        reasonCode: "commute_detail_added"
      }]
    })
  );

  assert.deepEqual(
    [missingKey, requestFailure, invalidResponse, protectedDetailsLost].map((item) => ({
      status: item.status,
      reason: item.fallbackReason,
      relations: item.result.relations,
      unusedFactIds: item.result.unusedFactIds
    })),
    [
      "missing_api_key",
      "llm_request_failed",
      "invalid_response",
      "protected_details_lost"
    ].map((reason) => ({
      status: "fallback",
      reason,
      relations: [],
      unusedFactIds: expectedFactIds
    }))
  );
});

async function preparePair(historyFact: FactItem, newFact: FactItem) {
  const repository = new InMemoryContextEngineRepository();
  await commitBatch(repository, `history_${historyFact.factId}`, [historyFact]);
  const task = await readyTask(repository, `new_${newFact.factId}`, [newFact]);
  const prepared = await prepareTimelineFusionTask(repository, task, {
    windowMs: WINDOW_MS,
    now: () => NOW
  });
  return onlyRelationInput(prepared.windows);
}

async function readyTask(
  repository: InMemoryContextEngineRepository,
  sourceKey: string,
  facts: FactItem[]
) {
  const batch = await commitBatch(repository, sourceKey, facts);
  const pending = createTimelineFusionTask({
    batch,
    now: NOW,
    debounceMs: 0,
    maxWaitMs: 0
  });
  const ready: TimelineFusionTask = {
    ...pending,
    status: "ready",
    readyAt: NOW
  };
  await repository.saveTimelineFusionTask(ready);
  return ready;
}

async function commitBatch(
  repository: InMemoryContextEngineRepository,
  sourceKey: string,
  facts: FactItem[]
) {
  for (const item of facts) await repository.saveFactItem(item);
  return repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "event",
    sourceKey,
    tenantId: "tenant_1",
    principalId: "principal_1",
    factIds: facts.map((item) => item.factId),
    committedAt: NOW
  }));
}

function onlyRelationInput(
  windows: Array<{ relationInput?: TimelineFusionRelationInput }>
) {
  const inputs = windows.flatMap((item) => item.relationInput ? [item.relationInput] : []);
  assert.equal(inputs.length, 1);
  return inputs[0]!;
}

function llmOptions(payload: unknown, onRequest?: () => void) {
  return {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234",
    model: "test-model",
    transport: "fetch" as const,
    maxAttempts: 1,
    fetchImpl: async () => {
      onRequest?.();
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify(payload)
          }
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  };
}

function fact(
  factId: string,
  eventId: string,
  overrides: Partial<FactItem> = {}
): FactItem {
  return {
    factId,
    factType: "event",
    factText: factId,
    normalizedClaim: factId,
    linkedEventIds: [eventId],
    linkedSegmentIds: [`segment_${factId}`],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: NOW,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-integration-test.v1",
    ...overrides
  };
}

function event(eventId: string, eventTime: string): MemoryEvent {
  return {
    eventId,
    eventType: "timeline_fusion_integration_test",
    eventDescription: eventId,
    eventTime,
    sourceApp: "test",
    sourceId: eventId,
    permissionSnapshot: {
      snapshotId: `permission_${eventId}`,
      tenantId: "tenant_1",
      principalId: "principal_1",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [],
    sourceRefs: []
  };
}
