
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFactsWithLlmFusion } from "./llm-fact-fusion.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import type { MemoryEvent, ParsedSegment } from "./domain.js";
import { multimodalContentToText } from "./memory-event-fields.js";

const originalFetch = globalThis.fetch;

function buildFactFusionRetryFixture() {
  const event: MemoryEvent = {
    eventId: `event_${randomUUID()}`,
    contextScopeId: "longmemeval:scope_retry",
    eventType: "longmemeval_session",
    eventDescription: "session",
    eventTime: "2025-01-01T00:00:00.000Z",
    sourceApp: "longmemeval",
    sourceId: "source",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item1",
      type: "text",
      format: "plain",
      content: "user: I baked sourdough bread on Tuesday.",
      ref: "item1",
      timeBasis: "source_time",
      timeConfidence: "high"
    }],
    sourceRefs: [{
      sourceRefId: "src1",
      sourceType: "agent_memory",
      sourceId: "source",
      metadata: { sessionId: "session_retry" }
    }]
  };
  const segments: ParsedSegment[] = [{
    segmentId: `seg_${event.eventId}_item1`,
    eventId: event.eventId,
    modality: "text",
    content: multimodalContentToText(event.multimodalData[0]!.content),
    status: "parsed",
    confidence: "high"
  }];
  return { event, segments };
}

function chatCompletion(content: string) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content } }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("createFactsWithLlmFusion retries empty message content up to a fifth attempt", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  let calls = 0;

  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.[1]?.content ?? "";
      assert.match(prompt, /factSequence/u);
      assert.match(prompt, /从 1 开始连续递增/u);
      assert.match(prompt, /抽取对话中的所有独立原子事实，完整覆盖复合句、并列句及附带信息，并在主语可由上下文明确推断时补全主语而非跳过/u);
      calls += 1;
      if (calls < 5) return chatCompletion("");
      return chatCompletion(JSON.stringify({
        facts: [{
          factSequence: 1,
          factType: "event",
          timeAnchor: "Tuesday",
          factText: "The user baked sourdough bread on Tuesday.",
          normalizedClaim: "The user baked sourdough bread on Tuesday.",
          confidenceLevel: "high",
          linkedSegmentIds: [segments[0]!.segmentId]
        }]
      }));
    };

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(calls, 5);
    assert.equal(result.trace.fallbackReason, undefined);
    assert.equal(result.facts[0]?.factText, "The user baked sourdough bread on Tuesday.");
    assert.equal(result.facts[0]?.timeAnchor, "Tuesday");
    assert.equal(result.facts[0]?.contextScopeId, "longmemeval:scope_retry");
    assert.equal(result.facts[0]?.sessionId, "session_retry");
    assert.equal(result.facts[0]?.factSequence, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion semantically retries empty LongMemEval facts", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  let calls = 0;

  try {
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.[1]?.content ?? "";
      if (calls === 1) return chatCompletion(JSON.stringify({ facts: [] }));
      assert.match(prompt, /这是语义抽取重试/u);
      return chatCompletion(JSON.stringify({
        facts: [{
          factSequence: 1,
          factType: "event",
          timeAnchor: "Tuesday",
          factText: "The user baked sourdough bread on Tuesday.",
          normalizedClaim: "The user baked sourdough bread on Tuesday.",
          confidenceLevel: "high",
          linkedSegmentIds: [segments[0]!.segmentId]
        }]
      }));
    };

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      emptyFactsMode: "allow",
      semanticRetryMaxAttempts: 2
    });

    assert.equal(calls, 2);
    assert.equal(result.trace.fallbackReason, undefined);
    assert.equal(result.facts[0]?.factText, "The user baked sourdough bread on Tuesday.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion marks exhausted LongMemEval semantic retries as degraded fallback", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  let calls = 0;

  try {
    globalThis.fetch = async () => {
      calls += 1;
      return chatCompletion(JSON.stringify({ facts: [] }));
    };

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "allow",
      emptyFactsMode: "allow",
      semanticRetryMaxAttempts: 2
    });

    assert.equal(calls, 3);
    assert.equal(result.trace.fallbackReason, "semantic_retry_exhausted:llm_returned_no_valid_facts");
    assert.match(result.facts[0]?.factId ?? "", /^fact_seg_/u);
    assert.equal(
      result.rejectedSegments.some((item) =>
        item.reason === "fallback:semantic_retry_exhausted:llm_returned_no_valid_facts"
      ),
      true
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion accepts empty LongMemEval facts for non-durable user requests", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  event.multimodalData[0]!.content = "user: Can you explain how sourdough fermentation works?";
  segments[0]!.content = multimodalContentToText(event.multimodalData[0]!.content);
  let calls = 0;

  try {
    globalThis.fetch = async () => {
      calls += 1;
      return chatCompletion(JSON.stringify({ facts: [] }));
    };

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      emptyFactsMode: "allow",
      semanticRetryMaxAttempts: 2
    });

    assert.equal(calls, 1);
    assert.deepEqual(result.facts, []);
    assert.equal(result.trace.fallbackReason, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion rejects unknown LongMemEval fact types", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();

  try {
    globalThis.fetch = async () => chatCompletion(JSON.stringify({
      facts: [{
        factType: "fitness_routine",
        timeAnchor: null,
        factText: "The user exercises regularly.",
        normalizedClaim: "The user exercises regularly.",
        confidenceLevel: "high",
        linkedSegmentIds: [segments[0]!.segmentId]
      }]
    }));

    await assert.rejects(createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    }), /fact_fusion_fallback:llm_returned_no_valid_facts/u);
    assert.equal(
      repository.llmFactFusionTraces[0]?.rejectedSegments[0]?.reason,
      "longmemeval_fact_type_invalid"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion retains LongMemEval facts when anchors are not copied from evidence", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();

  try {
    globalThis.fetch = async () => chatCompletion(JSON.stringify({
      facts: [{
        factType: "event",
        timeAnchor: "Wednesday",
        factText: "The user baked sourdough bread on Wednesday.",
        normalizedClaim: "The user baked sourdough bread on Wednesday.",
        linkedSegmentIds: [segments[0]!.segmentId]
      }]
    }));

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });
    assert.equal(result.facts[0]?.factText, "The user baked sourdough bread on Wednesday.");
    assert.equal(result.facts[0]?.timeAnchor, "Wednesday");
    assert.deepEqual(result.rejectedSegments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion accepts normalized temporal paraphrases when evidence, sourceClaim, and factText retain the anchor", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  segments[0]!.content = "user: I got a peace lily and a succulent from the nursery two weeks ago.";

  try {
    globalThis.fetch = async () => chatCompletion(JSON.stringify({
      facts: [{
        factType: "event",
        timeAnchor: "two weeks ago",
        factText: "The user got a peace lily and a succulent from the nursery two weeks ago.",
        normalizedClaim: "The user acquired a peace lily and a succulent two weeks before the conversation.",
        sourceClaim: "I got a peace lily and a succulent from the nursery two weeks ago.",
        linkedSegmentIds: [segments[0]!.segmentId]
      }]
    }));

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });

    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.timeAnchor, "two weeks ago");
    assert.equal(
      result.facts[0]?.normalizedClaim,
      "The user acquired a peace lily and a succulent two weeks before the conversation."
    );
    assert.equal(result.rejectedSegments.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion retains LongMemEval facts when sourceClaim omits the anchor", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();

  try {
    globalThis.fetch = async () => chatCompletion(JSON.stringify({
      facts: [{
        factType: "event",
        timeAnchor: "Tuesday",
        factText: "The user baked sourdough bread on Tuesday.",
        normalizedClaim: "The user baked sourdough bread earlier in the week.",
        sourceClaim: "The user baked sourdough bread.",
        linkedSegmentIds: [segments[0]!.segmentId]
      }]
    }));

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });
    assert.equal(result.facts[0]?.factText, "The user baked sourdough bread on Tuesday.");
    assert.equal(result.facts[0]?.timeAnchor, "Tuesday");
    assert.deepEqual(result.rejectedSegments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion retains LongMemEval facts when factText paraphrases the anchor", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  segments[0]!.content = "user: I just got back from a follow-up appointment with dermatologist Dr. Lee.";

  try {
    globalThis.fetch = async () => chatCompletion(JSON.stringify({
      facts: [{
        factType: "event",
        timeAnchor: "just",
        factText: "The user recently returned from a follow-up appointment with dermatologist Dr. Lee.",
        normalizedClaim: "The user recently visited dermatologist Dr. Lee for a follow-up appointment.",
        sourceClaim: "I just got back from a follow-up appointment with dermatologist Dr. Lee.",
        linkedSegmentIds: [segments[0]!.segmentId]
      }]
    }));

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });

    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.timeAnchor, "just");
    assert.match(result.facts[0]?.factText ?? "", /Dr\. Lee/u);
    assert.deepEqual(result.rejectedSegments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion preserves LongMemEval temporal facts without an extracted anchor", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();

  try {
    globalThis.fetch = async () => chatCompletion(JSON.stringify({
      facts: [{
        factType: "event",
        timeAnchor: null,
        factText: "The user baked sourdough bread on Tuesday.",
        normalizedClaim: "The user baked sourdough bread on Tuesday.",
        linkedSegmentIds: [segments[0]!.segmentId]
      }]
    }));

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });

    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.factText, "The user baked sourdough bread on Tuesday.");
    assert.equal(result.facts[0]?.timeAnchor, null);
    assert.equal(result.facts[0]?.evidenceTime, event.eventTime);
    assert.equal(result.facts[0]?.validTime, undefined);
    assert.deepEqual(result.rejectedSegments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion accepts event-level splitting for independent time anchors", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  segments[0]!.content = "user: I started the course two months ago and completed it three days ago.";

  try {
    globalThis.fetch = async () => chatCompletion(JSON.stringify({
      facts: [
        {
          factType: "event",
          timeAnchor: "two months ago",
          factText: "The user started the course two months ago.",
          normalizedClaim: "The user started the course two months ago.",
          linkedSegmentIds: [segments[0]!.segmentId]
        },
        {
          factType: "state_change",
          timeAnchor: "three days ago",
          factText: "The user completed the course three days ago.",
          normalizedClaim: "The user completed the course three days ago.",
          linkedSegmentIds: [segments[0]!.segmentId]
        }
      ]
    }));

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });
    assert.deepEqual(result.facts.map((fact) => ({
      factType: fact.factType,
      timeAnchor: fact.timeAnchor,
      validTime: fact.validTime
    })), [
      { factType: "event", timeAnchor: "two months ago", validTime: "2024-11-01T00:00:00.000Z" },
      { factType: "state_change", timeAnchor: "three days ago", validTime: "2024-12-29T00:00:00.000Z" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion accepts model output when a numeric claim is omitted", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  segments[0]!.content = "user: I bought 50 pounds of layer feed and 20 pounds of organic scratch grains.";
  let calls = 0;

  try {
    globalThis.fetch = async () => {
      calls += 1;
      const factText = "The user bought 50 pounds of layer feed.";
      return chatCompletion(JSON.stringify({
        facts: [{
          factType: "transaction",
          timeAnchor: null,
          factText,
          normalizedClaim: factText,
          confidenceLevel: "high",
          linkedSegmentIds: [segments[0]!.segmentId]
        }]
      }));
    };

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(calls, 1);
    assert.match(result.facts[0]?.factText ?? "", /50 pounds/u);
    assert.doesNotMatch(result.facts[0]?.factText ?? "", /20 pounds/u);
    assert.equal(result.trace.fallbackReason, undefined);
    assert.equal(result.trace.promptVersion, "fact-fusion.openai-compatible.v11");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion falls back after five empty message responses", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  let calls = 0;

  try {
    globalThis.fetch = async () => {
      calls += 1;
      return chatCompletion("");
    };

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(calls, 5);
    assert.equal(result.trace.fallbackReason, "llm_error:empty_message_content");
    assert.equal(result.facts[0]?.factId, `fact_${segments[0]!.segmentId}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion rejects non-English canonical fact text", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();

  try {
    globalThis.fetch = async () => chatCompletion(JSON.stringify({
      facts: [{
        factType: "event",
        timeAnchor: null,
        factText: "用户周二烤了酸面包。",
        normalizedClaim: "用户周二烤了酸面包",
        confidenceLevel: "high",
        linkedSegmentIds: [segments[0]!.segmentId]
      }]
    }));

    await assert.rejects(
      createFactsWithLlmFusion(repository, event, segments, {
        apiKey: "test-key",
        baseUrl: "http://localhost:1234",
        model: "test-model",
        fallbackMode: "throw"
      }),
      /fact_fusion_fallback:llm_returned_no_valid_facts/u
    );
    assert.equal(repository.llmFactFusionTraces[0]?.rejectedSegments[0]?.reason, "fact_text_must_be_english");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion requests a provider-compatible token budget with JSON object output", async () => {
  const repository = new InMemoryContextEngineRepository();
  const { event, segments } = buildFactFusionRetryFixture();
  let requestBody = "";

  try {
    globalThis.fetch = async (_input, init) => {
      requestBody = String((init as RequestInit | undefined)?.body ?? "");
      return chatCompletion(JSON.stringify({
        facts: [{
          factType: "event",
          timeAnchor: "Tuesday",
          factText: "The user baked sourdough bread on Tuesday.",
          linkedSegmentIds: [segments[0]!.segmentId]
        }]
      }));
    };

    await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    const request = JSON.parse(requestBody) as { max_tokens?: number; response_format?: unknown };
    assert.equal(request.max_tokens, 65536);
    assert.deepEqual(request.response_format, { type: "json_object" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion splits oversized evidence into multiple LLM requests", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event: MemoryEvent = {
    eventId: `event_${randomUUID()}`,
    eventType: "longmemeval_session",
    eventDescription: "session",
    eventTime: "2025-01-01T00:00:00.000Z",
    sourceApp: "longmemeval",
    sourceId: "source",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: "item1",
        type: "text",
        format: "plain",
        content: "x ".repeat(13000),
        ref: "item1",
        timeBasis: "source_time",
        timeConfidence: "high"
      },
      {
        itemId: "item2",
        type: "text",
        format: "plain",
        content: "y ".repeat(13000),
        ref: "item2",
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ],
    sourceRefs: [{ sourceRefId: "src1", sourceType: "agent_memory", sourceId: "source" }]
  };

  const segments: ParsedSegment[] = event.multimodalData.map((item) => ({
    segmentId: `seg_${event.eventId}_${item.itemId}`,
    eventId: event.eventId,
    modality: item.type,
    content: multimodalContentToText(item.content),
    status: "parsed",
    confidence: "medium"
  }));

  const calls: string[] = [];
  try {
    globalThis.fetch = async (_input, init) => {
      calls.push(String((init as RequestInit | undefined)?.body ?? ""));
      return new Response(JSON.stringify({ facts: [{ factText: "fact", linkedSegmentIds: [segments[0]!.segmentId] }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(calls.length > 1, true);
    assert.equal(result.trace.alignedEvidence.length, 2);
    assert.equal(Array.isArray(result.trace.rawResponse), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion requests minimal sufficient facts with benchmark-safe exceptions", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event: MemoryEvent = {
    eventId: `event_${randomUUID()}`,
    eventType: "timeline_session",
    eventDescription: "dinner session",
    eventTime: "2026-06-18T18:00:00.000Z",
    sourceApp: "manual",
    sourceId: "dinner-session",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: "item1",
        type: "text",
        format: "plain",
        content: "我正在吃牛排",
        ref: "item1",
        timeBasis: "source_time",
        timeConfidence: "high"
      },
      {
        itemId: "item2",
        type: "text",
        format: "plain",
        content: "我和李雷吃晚饭",
        ref: "item2",
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ],
    sourceRefs: [{ sourceRefId: "src1", sourceType: "agent_memory", sourceId: "dinner-session" }]
  };
  const segments: ParsedSegment[] = event.multimodalData.map((item) => ({
    segmentId: `seg_${event.eventId}_${item.itemId}`,
    eventId: event.eventId,
    modality: item.type,
    content: multimodalContentToText(item.content),
    status: "parsed",
    confidence: "high"
  }));

  let requestBody = "";
  try {
    globalThis.fetch = async (_input, init) => {
      requestBody = String((init as RequestInit | undefined)?.body ?? "");
      return new Response(JSON.stringify({ facts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    const request = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
    const prompt = request.messages.at(-1)?.content ?? "";
    const payload = JSON.parse(prompt) as {
      task: string;
      selectionPolicy: string[];
      selectionExamples: string[];
      constraints: string[];
      coverageChecklist?: unknown;
      outputSchema?: unknown;
    };
    assert.match(payload.task, /最小、充分、无重复且可审计/);
    assert.match(payload.task, /不是枚举每个可陈述主张/);
    assert.equal(payload.coverageChecklist, undefined);
    assert.equal(payload.outputSchema, undefined);
    assert.equal(payload.selectionPolicy.length, 7);
    assert.equal(payload.selectionPolicy.some((item) => item.includes("先保证强制事实完整覆盖")), true);
    assert.equal(payload.selectionPolicy.some((item) => item.includes("最小充分事实")), true);
    assert.equal(payload.selectionPolicy.some((item) => item.includes("事实性数字主张")), true);
    assert.equal(payload.selectionPolicy.some((item) => item.includes("未回答的纯查询参数、假设/示例数字和列表序号")), true);
    assert.equal(payload.selectionPolicy.some((item) => item.includes("同时关联问题与答案证据")), true);
    assert.equal(payload.selectionPolicy.some((item) => item.includes("用户未采纳不影响 assistant 事实保留")), true);
    assert.equal(payload.selectionPolicy.some((item) => item.includes("未被用户采用")), false);
    assert.equal(payload.selectionExamples.length, 4);
    assert.equal(payload.selectionExamples.some((item) => item.includes("Chicago") && item.includes("3 天时长")), true);
    assert.equal(payload.selectionExamples.some((item) => item.includes("两条可分别求和的交易事实")), true);
    assert.equal(payload.selectionExamples.some((item) => item.includes("50 美元是用户约束") && item.includes("用户 10 天前去打球了")), true);
    assert.match(prompt, /sourceClaim 使用证据原始语言/u);
    assert.match(prompt, /factText 与 normalizedClaim 使用简洁英文/u);
    assert.match(prompt, /旧值、新值、纠正、撤回或替换/u);
    assert.match(prompt, /数字和单位、日期和相对时间/u);
    assert.match(prompt, /不得编造或自行补算 count、sum、diff、duration、order 或排名/u);
    assert.match(prompt, /不确定相对时间/u);
    assert.doesNotMatch(prompt, /每个可独立验证和检索的主张必须单独输出/u);
    assert.doesNotMatch(prompt, /列表中每个具有独立检索价值的条目可以分别成为事实/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion extracts factual answers supplied by the assistant", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event: MemoryEvent = {
    eventId: `event_${randomUUID()}`,
    eventType: "longmemeval_single-session-assistant",
    eventDescription: "NFL historical results",
    eventTime: "2023-05-28T04:27:00.000Z",
    sourceApp: "longmemeval",
    sourceId: "answer_sharegpt_i9adwQn_0",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item1",
      type: "text",
      format: "plain",
      content: "assistant: Of the 23 games played between the Kansas City Chiefs and the Jacksonville Jaguars, 12 games were played at Arrowhead Stadium.",
      ref: "item1",
      timeBasis: "source_time",
      timeConfidence: "high"
    }],
    sourceRefs: [{ sourceRefId: "src1", sourceType: "agent_memory", sourceId: "answer_sharegpt_i9adwQn_0" }]
  };
  const segments: ParsedSegment[] = [{
    segmentId: `seg_${event.eventId}_item1`,
    eventId: event.eventId,
    modality: "text",
    content: multimodalContentToText(event.multimodalData[0]!.content),
    status: "parsed",
    confidence: "high"
  }];

  let requestBody = "";
  try {
    globalThis.fetch = async (_input, init) => {
      requestBody = String((init as RequestInit | undefined)?.body ?? "");
      return new Response(JSON.stringify({
        facts: [{
          factType: "knowledge",
          timeAnchor: null,
          factText: "Of 23 games between the Chiefs and Jaguars, 12 were played at Arrowhead Stadium.",
          normalizedClaim: "Chiefs and Jaguars played 23 games, including 12 at Arrowhead Stadium",
          confidenceLevel: "high",
          linkedSegmentIds: [segments[0]!.segmentId],
          validTimeStart: event.eventTime,
          timeBasis: "source_time",
          timeConfidence: "high"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    const request = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
    const prompt = request.messages.at(-1)?.content ?? "";
    assert.match(prompt, /同一 assistant 回答主题按语义选择 answer、knowledge 或 recommendation/u);
    assert.match(prompt, /factType 只能是以下枚举之一/u);
    assert.match(prompt, /timeAnchor/u);
    assert.doesNotMatch(prompt, /未被用户采用/u);
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.factType, "knowledge");
    assert.equal(result.facts[0]?.factText, "Of 23 games between the Chiefs and Jaguars, 12 were played at Arrowhead Stadium.");
    assert.deepEqual(result.facts[0]?.linkedSegmentIds, [segments[0]!.segmentId]);
    assert.equal(result.trace.promptVersion, "fact-fusion.openai-compatible.v11");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion rejects fallback when strict fallback mode is requested", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event: MemoryEvent = {
    eventId: `event_${randomUUID()}`,
    eventType: "longmemeval_session",
    eventDescription: "session",
    eventTime: "2025-01-01T00:00:00.000Z",
    sourceApp: "longmemeval",
    sourceId: "source",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: "item1",
        type: "text",
        format: "plain",
        content: "user: The code word is Alpha.",
        ref: "item1",
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ],
    sourceRefs: [{ sourceRefId: "src1", sourceType: "agent_memory", sourceId: "source" }]
  };
  const segments: ParsedSegment[] = [{
    segmentId: `seg_${event.eventId}_item1`,
    eventId: event.eventId,
    modality: "text",
    content: "user: The code word is Alpha.",
    status: "parsed",
    confidence: "high"
  }];

  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ facts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });

    await assert.rejects(
      createFactsWithLlmFusion(repository, event, segments, {
        apiKey: "test-key",
        baseUrl: "http://localhost:1234",
        model: "test-model",
        fallbackMode: "throw"
      }),
      /fact_fusion_fallback:llm_returned_no_valid_facts/
    );

    assert.equal(repository.llmFactFusionTraces.length, 1);
    assert.equal(repository.llmFactFusionTraces[0]?.fallbackReason, "llm_returned_no_valid_facts");
    assert.deepEqual(repository.llmFactFusionTraces[0]?.parsedFacts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion preserves distinct nearby facts for second-layer fusion", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event: MemoryEvent = {
    eventId: `event_${randomUUID()}`,
    eventType: "timeline_session",
    eventDescription: "steak dinner",
    eventTime: "2026-06-18T08:00:00.000Z",
    sourceApp: "manual",
    sourceId: "steak-session",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: "item1",
        type: "text",
        format: "plain",
        content: "现在用户和张三吃牛排",
        ref: "item1",
        timeBasis: "source_time",
        timeConfidence: "high"
      },
      {
        itemId: "item2",
        type: "text",
        format: "plain",
        content: "我正在吃牛排",
        ref: "item2",
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ],
    sourceRefs: [{ sourceRefId: "src1", sourceType: "agent_memory", sourceId: "steak-session" }]
  };
  const segments: ParsedSegment[] = event.multimodalData.map((item) => ({
    segmentId: `seg_${event.eventId}_${item.itemId}`,
    eventId: event.eventId,
    modality: item.type,
    content: multimodalContentToText(item.content),
    status: "parsed",
    confidence: "high"
  }));

  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        facts: [
          {
            factType: "event",
            timeAnchor: null,
            factText: "The user is eating steak with Zhang San.",
            normalizedClaim: "The user is eating steak with Zhang San.",
            confidenceLevel: "high",
            linkedSegmentIds: [segments[0]!.segmentId],
            validTimeStart: "2026-06-18T08:00:00.000Z",
            timeBasis: "source_time",
            timeConfidence: "high"
          },
          {
            factType: "other",
            timeAnchor: null,
            factText: "The user is eating steak.",
            normalizedClaim: "The user is eating steak.",
            confidenceLevel: "high",
            linkedSegmentIds: [segments[1]!.segmentId],
            validTimeStart: "2026-06-18T08:30:00.000Z",
            timeBasis: "source_time",
            timeConfidence: "high"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(result.facts.length, 2);
    assert.equal(result.facts[0]?.factText, "The user is eating steak with Zhang San.");
    assert.equal(result.facts[1]?.factText, "The user is eating steak.");
    assert.deepEqual(result.facts.map((fact) => fact.linkedSegmentIds), [
      [segments[0]!.segmentId],
      [segments[1]!.segmentId]
    ]);
    assert.deepEqual(result.trace.parsedFacts.map((fact) => fact.factId), result.facts.map((fact) => fact.factId));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion preserves source-language claims alongside normalized claims", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event: MemoryEvent = {
    eventId: `event_${randomUUID()}`,
    eventType: "expense_session",
    eventTime: "2023-04-20T08:00:00.000Z",
    sourceApp: "manual",
    sourceId: "bike-expense-session",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item1",
      type: "text",
      format: "plain",
      content: "I replaced the bike chain and it cost me $25.",
      ref: "item1",
      timeBasis: "source_time",
      timeConfidence: "high"
    }],
    sourceRefs: [{ sourceRefId: "src1", sourceType: "agent_memory", sourceId: "bike-expense-session" }]
  };
  const segments: ParsedSegment[] = [{
    segmentId: `seg_${event.eventId}_item1`,
    eventId: event.eventId,
    modality: "text",
    content: "I replaced the bike chain and it cost me $25.",
    status: "parsed",
    confidence: "high"
  }];

  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        facts: [{
          factType: "profile",
          timeAnchor: null,
          factText: "The user spent $25 replacing a bicycle chain.",
          sourceClaim: "I replaced the bike chain and it cost me $25.",
          normalizedClaim: "The user spent $25 replacing a bicycle chain.",
          confidenceLevel: "high",
          linkedSegmentIds: [segments[0]!.segmentId],
          validTimeStart: "2023-04-20T08:00:00.000Z",
          timeBasis: "absolute",
          timeConfidence: "high"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(result.facts[0]?.sourceClaim, "I replaced the bike chain and it cost me $25.");
    assert.equal(result.facts[0]?.normalizedClaim, "The user spent $25 replacing a bicycle chain.");
    assert.match(result.trace.prompt, /sourceClaim 使用证据原始语言/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion accepts LLM-synthesized nearby food and dinner fact", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event: MemoryEvent = {
    eventId: `event_${randomUUID()}`,
    eventType: "timeline_session",
    eventDescription: "dinner session",
    eventTime: "2026-06-18T18:00:00.000Z",
    sourceApp: "manual",
    sourceId: "dinner-session",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: "item1",
        type: "text",
        format: "plain",
        content: "我正在吃牛排",
        ref: "item1",
        timeBasis: "source_time",
        timeConfidence: "high"
      },
      {
        itemId: "item2",
        type: "text",
        format: "plain",
        content: "我和李雷吃晚饭",
        ref: "item2",
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ],
    sourceRefs: [{ sourceRefId: "src1", sourceType: "agent_memory", sourceId: "dinner-session" }]
  };
  const segments: ParsedSegment[] = event.multimodalData.map((item) => ({
    segmentId: `seg_${event.eventId}_${item.itemId}`,
    eventId: event.eventId,
    modality: item.type,
    content: multimodalContentToText(item.content),
    status: "parsed",
    confidence: "high"
  }));

  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        facts: [
          {
            factType: "event",
            timeAnchor: null,
            factText: "The user ate a steak dinner with Li Lei.",
            normalizedClaim: "The user ate a steak dinner with Li Lei.",
            confidenceLevel: "high",
            linkedSegmentIds: [
              segments[0]!.segmentId,
              segments[1]!.segmentId
            ],
            validTimeStart: "2026-06-18T18:00:00.000Z",
            timeBasis: "source_time",
            timeConfidence: "high"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.factText, "The user ate a steak dinner with Li Lei.");
    assert.equal(result.facts[0]?.normalizedClaim, "The user ate a steak dinner with Li Lei.");
    assert.deepEqual(result.facts[0]?.linkedSegmentIds, [
      segments[0]!.segmentId,
      segments[1]!.segmentId
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion drops an unresolvable LongMemEval deadline range", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = buildTemporalTestEvent();
  const segments = buildTemporalTestSegments(event);

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      facts: [{
        factType: "task",
        timeAnchor: "2月底前",
        factText: "The user plans to finish The Office by the end of February.",
        normalizedClaim: "The user plans to finish The Office by the end of February.",
        sourceClaim: "用户计划在2月底前看完《The Office》。",
        confidenceLevel: "medium",
        linkedSegmentIds: [segments[0]!.segmentId],
        validTimeStart: event.eventTime,
        validTimeEnd: "2023-02-28T23:59:59.000Z",
        timeBasis: "source_time",
        timeConfidence: "medium"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });

    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.evidenceTime, event.eventTime);
    assert.equal(result.facts[0]?.validTime, undefined);
    assert.equal(result.facts[0]?.evidenceTimeStart, undefined);
    assert.equal(result.facts[0]?.validTimeStart, undefined);
    assert.equal(result.facts[0]?.validTimeEnd, undefined);
    assert.equal(result.rejectedSegments.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion retains LongMemEval facts with an explicit contradictory interval", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = buildTemporalTestEvent();
  const segments = buildTemporalTestSegments(event);

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      facts: [
        {
          factType: "event",
          timeAnchor: "2月底前",
          factText: "The Office deadline at the end of February has an explicitly contradictory time interval.",
          normalizedClaim: "The Office deadline at the end of February has a contradictory interval.",
          sourceClaim: "用户计划在2月底前看完《The Office》。",
          confidenceLevel: "high",
          linkedSegmentIds: [segments[0]!.segmentId],
          validTimeStart: "2023-04-20T00:00:00.000Z",
          validTimeEnd: "2023-04-10T00:00:00.000Z",
          timeBasis: "absolute",
          timeConfidence: "high"
        },
        {
          factType: "profile",
          timeAnchor: null,
          factText: "The user likes comedy.",
          normalizedClaim: "The user likes comedy.",
          confidenceLevel: "high",
          linkedSegmentIds: [segments[0]!.segmentId],
          validTimeStart: event.eventTime,
          timeBasis: "source_time",
          timeConfidence: "high"
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });

    assert.deepEqual(result.facts.map((fact) => fact.factText), [
      "The Office deadline at the end of February has an explicitly contradictory time interval.",
      "The user likes comedy."
    ]);
    assert.deepEqual(result.rejectedSegments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion retains a lone LongMemEval fact with contradictory temporal metadata", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = buildTemporalTestEvent();
  const segments = buildTemporalTestSegments(event);

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      facts: [{
        factType: "event",
        timeAnchor: "2月底前",
        factText: "The Office deadline at the end of February has an explicitly contradictory time interval.",
        normalizedClaim: "The Office deadline at the end of February has a contradictory interval.",
        sourceClaim: "用户计划在2月底前看完《The Office》。",
        confidenceLevel: "high",
        linkedSegmentIds: [segments[0]!.segmentId],
        validTimeStart: "2023-04-20T00:00:00.000Z",
        validTimeEnd: "2023-04-10T00:00:00.000Z",
        timeBasis: "absolute",
        timeConfidence: "high"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw",
      emptyFactsMode: "allow"
    });

    assert.equal(result.facts.length, 1);
    assert.equal(
      result.facts[0]?.factText,
      "The Office deadline at the end of February has an explicitly contradictory time interval."
    );
    assert.equal(result.trace.fallbackReason, undefined);
    assert.deepEqual(result.rejectedSegments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createFactsWithLlmFusion retains an ambiguous inverted interval without valid time", async () => {
  const repository = new InMemoryContextEngineRepository();
  const event = buildTemporalTestEvent();
  const segments = buildTemporalTestSegments(event);

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      facts: [{
        factType: "task",
        timeAnchor: "2月底前",
        factText: "The user plans to finish The Office by the end of February, with ambiguous timing metadata.",
        normalizedClaim: "The user plans to finish The Office by the end of February with ambiguous timing metadata.",
        sourceClaim: "用户计划在2月底前看完《The Office》。",
        confidenceLevel: "medium",
        linkedSegmentIds: [segments[0]!.segmentId],
        validTimeStart: "2023-04-20T00:00:00.000Z",
        validTimeEnd: "2023-04-10T00:00:00.000Z",
        timeConfidence: "medium"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await createFactsWithLlmFusion(repository, event, segments, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      fallbackMode: "throw"
    });

    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.validTimeStart, undefined);
    assert.equal(result.facts[0]?.validTimeEnd, undefined);
    assert.equal(result.facts[0]?.evidenceTime, event.eventTime);
    assert.equal(result.facts[0]?.validTime, undefined);
    assert.equal(result.facts[0]?.evidenceTimeStart, undefined);
    assert.equal(result.facts[0]?.timeConfidence, "low");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function buildTemporalTestEvent(): MemoryEvent {
  return {
    eventId: `event_${randomUUID()}`,
    eventType: "longmemeval_session",
    eventDescription: "temporal session",
    eventTime: "2023-05-29T06:52:00.000Z",
    sourceApp: "longmemeval",
    sourceId: "temporal-source",
    permissionSnapshot: {
      snapshotId: `ps_${randomUUID()}`,
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "item1",
      type: "text",
      format: "plain",
      content: "用户计划在2月底前看完《The Office》，并且喜欢喜剧。",
      ref: "item1",
      timeBasis: "source_time",
      timeConfidence: "medium"
    }],
    sourceRefs: [{ sourceRefId: "src1", sourceType: "agent_memory", sourceId: "temporal-source" }]
  };
}

function buildTemporalTestSegments(event: MemoryEvent): ParsedSegment[] {
  return [{
    segmentId: `seg_${event.eventId}_item1`,
    eventId: event.eventId,
    modality: "text",
    content: multimodalContentToText(event.multimodalData[0]!.content),
    status: "parsed",
    confidence: "medium"
  }];
}
