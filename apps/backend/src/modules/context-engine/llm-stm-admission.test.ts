import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FactItem, MemoryEvent } from "./domain.js";
import {
  evaluateShortTermAdmissionsWithLlm,
  evaluateShortTermAdmissionWithLlm
} from "./llm-stm-admission.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { sourceRefsFromEvent } from "./memory-event-fields.js";

const originalFetch = globalThis.fetch;

test("evaluateShortTermAdmissionWithLlm uses structured LLM STM decision", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = createEvent("用户确认上下文引擎方案要按 PRD 执行。");
  const facts = [createFact(event, "上下文引擎方案必须按 PRD 执行。")];
  const calls: string[] = [];

  try {
    globalThis.fetch = async (_input, init) => {
      calls.push(String((init as RequestInit | undefined)?.body ?? ""));
      return chatJson({
        result: "write_candidate",
        memoryDataType: "decision",
        importanceLevel: "high",
        confidenceLevel: "high",
        needUserConfirm: false,
        reason: "LLM 识别为方案约束决策",
        matchedRules: ["key_decision"],
        sourceFactIds: [facts[0]!.factId]
      });
    };

    const result = await evaluateShortTermAdmissionWithLlm(repository, event, facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(calls.length, 1);
    assert.equal(result.result, "write_candidate");
    assert.equal(result.lifecycleStatus, "candidate_queue");
    assert.equal(result.accessState, "visible");
    assert.equal(result.reason, "LLM 识别为方案约束决策");
    assert.deepEqual(result.matchedRules, ["key_decision", "llm_stm_admission"]);
    assert.equal(result.importanceLevel, "high");
    assert.equal(result.confidenceLevel, "high");
    assert.equal(repository.llmStmAdmissionTraces.length, 1);
    assert.equal(repository.llmStmAdmissionTraces[0]?.parsedDecision?.result, "write_candidate");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateShortTermAdmissionWithLlm keeps sensitive hard rules above LLM suggestions", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = createEvent("用户粘贴了一个 token。");
  const facts = [createFact(event, "用户的 token 是 secret-token-123。")];

  try {
    globalThis.fetch = async () =>
      chatJson({
        result: "write_high_priority",
        memoryDataType: "preference",
        importanceLevel: "critical",
        confidenceLevel: "high",
        reason: "LLM 错误地建议高优先级保存",
        matchedRules: ["explicit_remember"],
        sourceFactIds: [facts[0]!.factId]
      });

    const result = await evaluateShortTermAdmissionWithLlm(repository, event, facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(result.result, "pending_confirm");
    assert.equal(result.lifecycleStatus, "pending_confirm");
    assert.equal(result.accessState, "visible");
    assert.equal(result.reason, "high_sensitivity_pending_review");
    assert.equal(result.matchedRules.includes("hard_rule_sensitive_override"), true);
    assert.equal(repository.llmStmAdmissionTraces[0]?.parsedDecision?.result, "write_high_priority");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateShortTermAdmissionWithLlm falls back to rule admission without an API key", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = createEvent("普通项目状态更新。");
  const facts = [createFact(event, "项目状态更新为联调中。")];

  const result = await evaluateShortTermAdmissionWithLlm(repository, event, facts, { apiKey: "" });

  assert.equal(result.result, "write_high_priority");
  assert.equal(result.reason, "high_value_or_agent_confirmed_fact");
  assert.equal(repository.llmStmAdmissionTraces.length, 1);
  assert.equal(repository.llmStmAdmissionTraces[0]?.fallbackReason, "missing_api_key");
});

test("evaluateShortTermAdmissionsWithLlm judges every session fact in one request", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = createEvent("同一个 session 中有三条待判断事实。");
  const facts = [
    createFact(event, "用户偏好简洁回答。", "session_fact_1"),
    createFact(event, "这是一条重复且无独立价值的说明。", "session_fact_2"),
    createFact(event, "用户下周要完成项目评审。", "session_fact_3")
  ];
  let requestCount = 0;

  try {
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as {
        messages?: Array<{ content?: string }>;
      };
      const prompt = JSON.parse(body.messages?.[1]?.content ?? "{}") as {
        facts?: Array<{ factId?: string }>;
      };
      assert.deepEqual(prompt.facts?.map((fact) => fact.factId), facts.map((fact) => fact.factId));
      return chatJson({
        decisions: facts.map((fact, index) => ({
          result: index === 1 ? "reject" : "write_short_term",
          memoryDataType: index === 0 ? "preference" : index === 2 ? "task" : "fact",
          importanceLevel: index === 1 ? "low" : "medium",
          confidenceLevel: "high",
          reason: index === 1 ? "duplicate_in_session" : "useful_session_fact",
          matchedRules: [index === 1 ? "duplicate" : "useful_reference"],
          sourceFactIds: [fact.factId]
        }))
      });
    };

    const results = await evaluateShortTermAdmissionsWithLlm(repository, event, facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(requestCount, 1);
    assert.deepEqual(
      results.map(({ factId, decision }) => ({ factId, result: decision.result })),
      [
        { factId: "session_fact_1", result: "write_short_term" },
        { factId: "session_fact_2", result: "reject" },
        { factId: "session_fact_3", result: "write_short_term" }
      ]
    );
    assert.equal(repository.llmStmAdmissionTraces.length, 1);
    assert.equal(repository.llmStmAdmissionTraces[0]?.promptVersion, "stm-admission.openai-compatible.v2-session");
    assert.equal(repository.llmStmAdmissionTraces[0]?.parsedDecision?.factDecisions?.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateShortTermAdmissionsWithLlm cannot reject a meaningful quantitative fact", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = createEvent("The user bought a waterproof car cover for $120.");
  const fact = createFact(event, "The user bought a waterproof car cover for $120.", "fact_car_cover_price");

  try {
    globalThis.fetch = async () => chatJson({
      decisions: [{
        result: "reject",
        memoryDataType: "fact",
        importanceLevel: "low",
        confidenceLevel: "high",
        reason: "detail_without_independent_value",
        matchedRules: ["duplicate"],
        sourceFactIds: [fact.factId]
      }]
    });

    const [result] = await evaluateShortTermAdmissionsWithLlm(repository, event, [fact], {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(result?.decision.result, "write_candidate");
    assert.equal(result?.decision.importanceLevel, "high");
    assert.equal(result?.decision.lifecycleStatus, "candidate_queue");
    assert.equal(result?.decision.matchedRules.includes("hard_rule_quantitative_override"), true);
    assert.equal(repository.llmStmAdmissionTraces[0]?.overrideReason, "hard_rule_quantitative_override");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateShortTermAdmissionsWithLlm rejects incomplete per-fact responses in strict mode", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = createEvent("同一个 session 的准入结果不能遗漏事实。");
  const facts = [
    createFact(event, "事实一。", "coverage_fact_1"),
    createFact(event, "事实二。", "coverage_fact_2")
  ];

  try {
    globalThis.fetch = async () => chatJson({
      decisions: [{
        result: "write_short_term",
        memoryDataType: "fact",
        importanceLevel: "medium",
        confidenceLevel: "high",
        reason: "only_one_decision",
        matchedRules: ["useful_reference"],
        sourceFactIds: [facts[0]!.factId]
      }]
    });

    await assert.rejects(
      evaluateShortTermAdmissionsWithLlm(repository, event, facts, {
        apiKey: "test-key",
        baseUrl: "http://localhost:1234",
        model: "test-model",
        fallbackMode: "throw"
      }),
      /decisions_missing_facts:coverage_fact_2/
    );
    assert.match(
      repository.llmStmAdmissionTraces[0]?.fallbackReason ?? "",
      /decisions_missing_facts:coverage_fact_2/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateShortTermAdmissionWithLlm batches fact admission requests with concurrency", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = createEvent("多个事实需要分批判断 STM 准入。");
  const facts = Array.from({ length: 5 }, (_, index) => createFact(event, `事实 ${index + 1} 应进入记忆。`, `fact_${index + 1}`));
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const requestedFactIds: string[][] = [];

  try {
    globalThis.fetch = async (_input, init) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = JSON.parse(body.messages?.[1]?.content ?? "{}") as { facts?: Array<{ factId?: string }> };
      const sourceFactIds = (prompt.facts ?? []).map((fact) => fact.factId).filter((factId): factId is string => Boolean(factId));
      requestedFactIds.push(sourceFactIds);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeRequests -= 1;
      return chatJson({
        result: sourceFactIds.includes("fact_5") ? "write_high_priority" : "write_short_term",
        memoryDataType: "fact",
        importanceLevel: sourceFactIds.includes("fact_5") ? "high" : "medium",
        confidenceLevel: "high",
        reason: `batch:${sourceFactIds.join(",")}`,
        matchedRules: ["batch_rule"],
        sourceFactIds
      });
    };

    const result = await evaluateShortTermAdmissionWithLlm(repository, event, facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      batchSize: 2,
      batchConcurrency: 3
    });

    assert.equal(maxActiveRequests, 3);
    assert.deepEqual(requestedFactIds, [["fact_1", "fact_2"], ["fact_3", "fact_4"], ["fact_5"]]);
    assert.equal(result.result, "write_high_priority");
    assert.equal(result.importanceLevel, "high");
    assert.equal(repository.llmStmAdmissionTraces.length, 1);
    assert.deepEqual(repository.llmStmAdmissionTraces[0]?.parsedDecision?.sourceFactIds, facts.map((fact) => fact.factId));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createEvent(content: string): MemoryEvent {
  const eventId = `event_${randomUUID()}`;
  return {
    eventId,
    eventType: "manual_step_context_event",
    eventDescription: content,
    eventTime: "2026-06-18T08:30:00.000Z",
    sourceApp: "agent",
    sourceId: "llm-stm-admission-test",
    permissionSnapshot: {
      snapshotId: `ps_${eventId}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item1",
      type: "text",
      format: "plain",
      content,
      timeBasis: "source_time",
      timeConfidence: "high"
    }],
    sourceRefs: [{ sourceRefId: `src_${eventId}`, sourceType: "agent_memory", sourceId: "source" }]
  };
}

function createFact(event: MemoryEvent, factText: string, factId = `fact_${event.eventId}`): FactItem {
  return {
    factId,
    factType: "decision",
    factText,
    normalizedClaim: factText,
    linkedEventIds: [event.eventId],
    linkedSegmentIds: [`seg_${event.eventId}_item1`],
    linkedSourceRefs: sourceRefsFromEvent(event),
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: event.eventTime,
    validTimeStart: event.eventTime,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  };
}

function chatJson(payload: unknown) {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify(payload)
      }
    }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
