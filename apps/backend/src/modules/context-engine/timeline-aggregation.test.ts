import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../../modules/health/server.js";
import {
  buildTimelineAggregatedFacts,
  buildTimelineAggregatedFactsWithLlm,
  materializeTimelineAggregatedFacts,
  summarizeAggregatedFacts
} from "./timeline-aggregation.js";
import type { FactItem, MemoryEvent } from "./domain.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

const originalFetch = globalThis.fetch;

test("manual flow exposes aggregated facts with source events", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);

  const first = await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event: buildEvent("agg_event_1", "2026-06-18T08:00:00.000Z", "跨事件聚合测试：共享结论"),
      idempotencyKey: "agg_event_1"
    }
  });
  assert.equal(first.statusCode, 200);

  const second = await server.inject({
    method: "POST",
    url: "/context/events",
    headers: { "content-type": "application/json" },
    payload: {
      event: buildEvent("agg_event_2", "2026-06-18T08:30:00.000Z", "跨事件聚合测试：共享结论"),
      idempotencyKey: "agg_event_2"
    }
  });
  assert.equal(second.statusCode, 200);

  const manualFlow = await server.inject({
    method: "POST",
    url: "/context/debug/manual-flow",
    headers: { "content-type": "application/json" },
    payload: {
      content: "跨事件聚合测试：共享结论",
      sourceId: "aggregation-test",
      eventTime: "2026-06-18T09:00:00.000Z"
    }
  });

  assert.equal(manualFlow.statusCode, 200);
  const result = manualFlow.json().result as {
    timelineAggregation: {
      aggregatedFacts: Array<{
        sourceEventIds: string[];
        sourceFactIds: string[];
      }>;
    };
  };

  assert.equal(result.timelineAggregation.aggregatedFacts.length > 0, true);
  assert.equal(result.timelineAggregation.aggregatedFacts.some((fact) => fact.sourceEventIds.length > 1), true);
  assert.equal(result.timelineAggregation.aggregatedFacts.some((fact) => fact.sourceFactIds.length > 1), true);

  await server.close();
});

test("manual flow keeps timeline facts, STM, and LTM as separate lifecycle layers", async () => {
  const repository = new InMemoryContextEngineRepository();
  const server = createHealthServer(repository);

  const manualFlow = await server.inject({
    method: "POST",
    url: "/context/debug/manual-flow",
    headers: { "content-type": "application/json" },
    payload: {
      content: "PRD 要求时间轴融合先形成事实，S4 再准入短期记忆，做梦流程最后把高价值 STM 巩固为 LTM。",
      eventType: "manual_flow_layering_event",
      description: "验证 STM 和 LTM 不直接复制时间轴聚合内容",
      sourceId: "manual-flow-layering-test",
      eventTime: "2026-06-18T10:00:00.000Z",
      llm: {
        apiKey: ""
      }
    }
  });

  assert.equal(manualFlow.statusCode, 200);
  const result = manualFlow.json().result as {
    stages: Array<{ stage: string }>;
    timelineAggregation: { summary: string; factIds: string[] };
    shortTermMemory: {
      memoryDataId: string;
      content: string;
      structuredFacts?: {
        schemaVersion?: string;
        memoryKind?: string;
        facts?: Array<{ factId: string; claim: string; explanation?: string }>;
      };
      sourceFactIds: string[];
      matchedRules: string[];
    };
    longTermMemory: {
      memoryId: string;
      content: string;
      structuredFacts?: {
        schemaVersion?: string;
        memoryKind?: string;
        facts?: Array<{ sourceMemoryDataId: string; claim: string; explanation?: string }>;
      };
      sourceMemoryDataIds: string[];
      matchedRules: string[];
    };
  };

  assert.deepEqual(result.stages.map((stage) => stage.stage), [
    "event",
    "event",
    "data_lake",
    "timeline_aggregation",
    "stm",
    "stm",
    "ltm",
    "ltm"
  ]);
  assert.notEqual(result.shortTermMemory.content, result.timelineAggregation.summary);
  assert.deepEqual(result.shortTermMemory.sourceFactIds, result.timelineAggregation.factIds);
  assert.equal(result.shortTermMemory.content.trim().startsWith("{"), false);
  const structuredStm = result.shortTermMemory.structuredFacts;
  assert.ok(structuredStm);
  assert.equal(structuredStm.schemaVersion, "memory-structured-facts.v1");
  assert.equal(structuredStm.memoryKind, "short_term");
  assert.deepEqual(structuredStm.facts?.map((fact) => fact.factId), result.timelineAggregation.factIds);
  assert.equal(structuredStm.facts?.every((fact) => fact.claim && fact.explanation), true);
  assert.equal(result.shortTermMemory.matchedRules.includes("write_event_bootstrap"), true);
  assert.notEqual(result.longTermMemory.content, result.timelineAggregation.summary);
  const structuredLtm = result.longTermMemory.structuredFacts;
  assert.ok(structuredLtm);
  assert.equal(structuredLtm.schemaVersion, "memory-structured-facts.v1");
  assert.equal(structuredLtm.memoryKind, "long_term");
  assert.deepEqual(structuredLtm.facts?.map((fact) => fact.sourceMemoryDataId), [result.shortTermMemory.memoryDataId]);
  assert.equal(structuredLtm.facts?.every((fact) => fact.claim && fact.explanation), true);
  assert.deepEqual(result.longTermMemory.sourceMemoryDataIds, [result.shortTermMemory.memoryDataId]);
  assert.equal(result.longTermMemory.matchedRules.includes("deterministic_fallback"), true);

  await server.close();
});

test("timeline aggregation merges nearby facts even when text differs", () => {
  const facts: FactItem[] = [
    buildFact("fact_1", "2026-06-18T08:00:00.000Z", "我去吃饭了"),
    buildFact("fact_2", "2026-06-18T08:45:00.000Z", "我今天吃过饭"),
    buildFact("fact_3", "2026-06-18T12:30:00.000Z", "我去吃饭了")
  ];

  const aggregatedFacts = buildTimelineAggregatedFacts(facts);

  assert.equal(aggregatedFacts.length, 2);
  assert.equal(aggregatedFacts.some((fact) => fact.sourceFactIds.length === 2), true);
  assert.equal(aggregatedFacts.some((fact) => fact.sourceFactIds.includes("fact_1") && fact.sourceFactIds.includes("fact_2")), true);
  assert.equal(aggregatedFacts.some((fact) => fact.sourceFactIds.includes("fact_3")), true);
});

test("timeline aggregation merges first-person and user claims for nearby eating events", () => {
  const facts: FactItem[] = [
    buildFact("fact_1", "2026-06-18T08:00:00.000Z", "现在用户和张三吃牛排"),
    buildFact("fact_2", "2026-06-18T08:30:00.000Z", "我正在吃牛排")
  ];

  const aggregatedFacts = buildTimelineAggregatedFacts(facts);

  assert.equal(aggregatedFacts.length, 1);
  assert.deepEqual(aggregatedFacts[0]?.sourceFactIds, ["fact_1", "fact_2"]);
  assert.equal(aggregatedFacts[0]?.factText, "现在用户和张三吃牛排");
});

test("timeline aggregation fallback does not infer meal relations with hard-coded term rules", () => {
  const facts: FactItem[] = [
    buildFact("fact_1", "2026-06-18T18:00:00.000Z", "我正在吃牛排"),
    buildFact("fact_2", "2026-06-18T18:30:00.000Z", "我和李雷吃晚饭")
  ];

  const aggregatedFacts = buildTimelineAggregatedFacts(facts);

  assert.equal(aggregatedFacts.length, 2);
});

test("timeline aggregation asks LLM to synthesize nearby complementary facts", async () => {
  const facts: FactItem[] = [
    {
      ...buildFact("fact_1", "2026-07-06T11:43:00.000Z", "用户现在正在吃牛排。", "text"),
      normalizedClaim: "用户正在吃牛排",
      linkedEventIds: ["event_same_session"]
    },
    {
      ...buildFact("fact_2", "2026-07-06T11:43:00.000Z", "我现在和David吃晚饭。", "text"),
      normalizedClaim: "我现在和David吃晚饭。",
      linkedEventIds: ["event_same_session"]
    }
  ];
  let requestBody = "";
  const encoder = new TextEncoder();

  try {
    globalThis.fetch = async (_input, init) => {
      requestBody = String((init as RequestInit | undefined)?.body ?? "");
      const content = JSON.stringify({
        groups: [
          {
            factText: "The user is having a steak dinner with David.",
            normalizedClaim: "The user is having a steak dinner with David.",
            sourceFactIds: ["fact_1", "fact_2"],
            confidenceLevel: "high"
          }
        ]
      });
      const chunks = [content.slice(0, 24), content.slice(24, 61), content.slice(61)];
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`));
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunk } }] })}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };

    const aggregatedFacts = await buildTimelineAggregatedFactsWithLlm(facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model"
    });

    assert.equal(aggregatedFacts.length, 1);
    assert.deepEqual(aggregatedFacts[0]?.sourceFactIds, ["fact_1", "fact_2"]);
    assert.match(aggregatedFacts[0]?.factId ?? "", /^fact_timeline_fused_/u);
    assert.equal(aggregatedFacts[0]?.factText, "The user is having a steak dinner with David.");
    assert.equal(aggregatedFacts[0]?.normalizedClaim, "The user is having a steak dinner with David.");

    const request = JSON.parse(requestBody) as { messages: Array<{ content: string }>; stream?: boolean };
    assert.equal(request.stream, true);
    const prompt = request.messages.at(-1)?.content ?? "";
    assert.match(prompt, /判断哪些事实描述同一时间轴事件/);
    assert.match(prompt, /互相补充且不冲突/);
    assert.match(prompt, /factText and normalizedClaim must be written in concise English/u);
    assert.match(prompt, /entityIds 判断实体一致性/u);
    assert.match(prompt, /数字及其单位\/币种/u);
    assert.match(prompt, /旧值和新值/u);
    assert.match(prompt, /sourceMessageIds/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timeline aggregation fallback keeps complementary facts separate without LLM synthesis", () => {
  const facts: FactItem[] = [
    {
      ...buildFact("fact_1", "2026-07-06T11:43:00.000Z", "用户现在正在吃牛排。", "text"),
      normalizedClaim: "用户正在吃牛排"
    },
    {
      ...buildFact("fact_2", "2026-07-06T11:43:00.000Z", "我现在和David吃晚饭。", "text"),
      normalizedClaim: "我现在和David吃晚饭。"
    }
  ];

  const aggregatedFacts = buildTimelineAggregatedFacts(facts);

  assert.equal(aggregatedFacts.length, 2);
  assert.equal(aggregatedFacts.some((fact) => fact.factText.includes("牛排")), true);
  assert.equal(aggregatedFacts.some((fact) => fact.factText.includes("David") && fact.factText.includes("晚饭")), true);
});

test("same-session LLM fusion combines complementary commute facts and leaves unused facts unchanged", async () => {
  const eventId = "event_commute_session";
  const facts = [
    "用户喜欢在通勤时听有声书",
    "用户使用 Audible",
    "用户每天通勤单程 45 分钟，在通勤时听有声书",
    "用户觉得有声书比电子书更容易记住，并开始做笔记",
    "用户正在阅读《消失的爱人》",
    "助理介绍了《夜莺》"
  ].map((factText, index) => ({
    ...buildFact(`fact_commute_${index + 1}`, "2026-07-06T11:43:00.000Z", factText, index === 1 ? "tool_result" : "preference"),
    linkedEventIds: [eventId]
  }));

  try {
    globalThis.fetch = async () => chatCompletion({
      groups: [{
        factText: "The user listens to audiobooks on Audible during a daily 45-minute one-way commute, finds them easier to remember than ebooks, and has started taking notes.",
        normalizedClaim: "The user listens to Audible during a daily 45-minute one-way commute, remembers audiobooks better than ebooks, and takes notes.",
        sourceFactIds: ["fact_commute_1", "fact_commute_2", "fact_commute_3", "fact_commute_4"],
        confidenceLevel: "high"
      }]
    });

    const aggregated = await buildTimelineAggregatedFactsWithLlm(facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      transport: "fetch"
    });
    const materialized = materializeTimelineAggregatedFacts(facts, aggregated, "2026-07-06T12:00:00.000Z");

    assert.equal(materialized.length, 3);
    const fused = materialized.find((fact) => fact.factId.startsWith("fact_timeline_fused_"));
    assert.match(fused?.factText ?? "", /daily 45-minute one-way commute/u);
    assert.match(fused?.factText ?? "", /Audible/u);
    assert.deepEqual(
      materialized.filter((fact) => !fact.factId.startsWith("fact_timeline_fused_")).map((fact) => fact.factText),
      ["用户正在阅读《消失的爱人》", "助理介绍了《夜莺》"]
    );
    assert.equal(fused?.schemaVersion, "timeline-fused-fact.v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-session LLM fusion falls back to every original fact when no API key is configured", async () => {
  const facts = [
    { ...buildFact("fact_fallback_1", "2026-07-06T11:43:00.000Z", "用户使用 Audible"), linkedEventIds: ["event_fallback"] },
    { ...buildFact("fact_fallback_2", "2026-07-06T11:44:00.000Z", "用户每天通勤单程 45 分钟"), linkedEventIds: ["event_fallback"] }
  ];

  const aggregated = await buildTimelineAggregatedFactsWithLlm(facts, { apiKey: "" });

  assert.deepEqual(aggregated.map((fact) => fact.factId), ["fact_fallback_1", "fact_fallback_2"]);
  assert.deepEqual(aggregated.map((fact) => fact.sourceFactIds), [["fact_fallback_1"], ["fact_fallback_2"]]);
});

test("same-session LLM fusion rejects a lossy group and falls back to originals", async () => {
  const facts = [
    { ...buildFact("fact_lossy_1", "2026-07-06T11:43:00.000Z", "用户使用 Audible"), linkedEventIds: ["event_lossy"] },
    { ...buildFact("fact_lossy_2", "2026-07-06T11:44:00.000Z", "用户每天通勤单程 45 分钟"), linkedEventIds: ["event_lossy"] }
  ];

  try {
    globalThis.fetch = async () => chatCompletion({
      groups: [{
        factText: "The user uses Audible during a daily one-way commute.",
        normalizedClaim: "The user uses Audible during a daily one-way commute.",
        sourceFactIds: ["fact_lossy_1", "fact_lossy_2"],
        confidenceLevel: "high"
      }]
    });

    const aggregated = await buildTimelineAggregatedFactsWithLlm(facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      transport: "fetch"
    });

    assert.deepEqual(aggregated.map((fact) => fact.factId), ["fact_lossy_1", "fact_lossy_2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-session LLM fusion rejects lost units, negation, list order, and old/new state", async () => {
  const facts = [
    {
      ...buildFact("fact_detail_1", "2026-07-06T11:43:00.000Z", "The user does not like cilantro."),
      linkedEventIds: ["event_detail"]
    },
    {
      ...buildFact("fact_detail_2", "2026-07-06T11:44:00.000Z", "The user walks 5 kilometers daily."),
      linkedEventIds: ["event_detail"]
    },
    {
      ...buildFact("fact_detail_3", "2026-07-06T11:45:00.000Z", "The ranked choices are: first Alpha, second Beta."),
      linkedEventIds: ["event_detail"]
    },
    {
      ...buildFact("fact_detail_4", "2026-07-06T11:46:00.000Z", "The user previously preferred tea and now prefers coffee."),
      linkedEventIds: ["event_detail"]
    }
  ];

  try {
    globalThis.fetch = async () => chatCompletion({
      groups: [{
        factText: "The user likes cilantro, walks 5 daily, ranks Beta before Alpha, and prefers coffee.",
        normalizedClaim: "The user likes cilantro, walks 5 daily, ranks Beta before Alpha, and prefers coffee.",
        sourceFactIds: facts.map((fact) => fact.factId),
        confidenceLevel: "high"
      }]
    });

    const aggregated = await buildTimelineAggregatedFactsWithLlm(facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      transport: "fetch"
    });

    assert.deepEqual(aggregated.map((fact) => fact.factId), facts.map((fact) => fact.factId));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-session LLM fusion rejects a numeric fact that loses its unit or relative date", async () => {
  const facts = [
    {
      ...buildFact("fact_purchase_1", "2026-07-06T11:43:00.000Z", "The user bought 20 pounds of organic scratch grains last month."),
      linkedEventIds: ["event_purchase"]
    },
    {
      ...buildFact("fact_purchase_2", "2026-07-06T11:44:00.000Z", "The purchase improved egg quality."),
      linkedEventIds: ["event_purchase"]
    }
  ];

  try {
    globalThis.fetch = async () => chatCompletion({
      groups: [{
        factText: "The user bought 20 organic scratch grains and observed improved egg quality.",
        normalizedClaim: "User bought 20 organic scratch grains and observed improved egg quality.",
        sourceFactIds: facts.map((fact) => fact.factId),
        confidenceLevel: "high"
      }]
    });

    const aggregated = await buildTimelineAggregatedFactsWithLlm(facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      transport: "fetch"
    });

    assert.deepEqual(aggregated.map((fact) => fact.factId), facts.map((fact) => fact.factId));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-session LLM fusion requires quantitative details in both output fields", async () => {
  const facts = [
    {
      ...buildFact("fact_hours_1", "2026-07-06T11:43:00.000Z", "During peak seasons, the user works 10 additional hours per week."),
      linkedEventIds: ["event_hours"]
    },
    {
      ...buildFact("fact_hours_2", "2026-07-06T11:44:00.000Z", "The user adapts to changing workloads."),
      linkedEventIds: ["event_hours"]
    }
  ];

  try {
    globalThis.fetch = async () => chatCompletion({
      groups: [{
        factText: "During peak seasons, the user works 10 additional hours per week and adapts to changing workloads.",
        normalizedClaim: "The user adapts to changing workloads during peak seasons.",
        sourceFactIds: facts.map((fact) => fact.factId),
        confidenceLevel: "high"
      }]
    });

    const aggregated = await buildTimelineAggregatedFactsWithLlm(facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      transport: "fetch"
    });

    assert.deepEqual(aggregated.map((fact) => fact.factId), facts.map((fact) => fact.factId));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-session LLM fusion falls back to originals on an invalid response", async () => {
  const facts = [
    { ...buildFact("fact_invalid_1", "2026-07-06T11:43:00.000Z", "用户使用 Audible"), linkedEventIds: ["event_invalid"] },
    { ...buildFact("fact_invalid_2", "2026-07-06T11:44:00.000Z", "用户每天通勤单程 45 分钟"), linkedEventIds: ["event_invalid"] }
  ];

  try {
    globalThis.fetch = async () => new Response("not-json", {
      status: 200,
      headers: { "content-type": "text/plain" }
    });
    const aggregated = await buildTimelineAggregatedFactsWithLlm(facts, {
      apiKey: "test-key",
      baseUrl: "http://localhost:1234",
      model: "test-model",
      transport: "fetch"
    });

    assert.deepEqual(aggregated.map((fact) => fact.factId), ["fact_invalid_1", "fact_invalid_2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timeline aggregation fallback does not merge only because factText contains meal terms", () => {
  const facts: FactItem[] = [
    {
      ...buildFact("fact_1", "2026-07-06T11:43:00.000Z", "用户现在正在吃牛排。", "text"),
      normalizedClaim: "用户正在吃牛排"
    },
    {
      ...buildFact("fact_2", "2026-07-06T11:43:00.000Z", "用户现在和David一起吃晚饭。", "text"),
      normalizedClaim: "user having dinner with david"
    }
  ];

  const aggregatedFacts = buildTimelineAggregatedFacts(facts);

  assert.equal(aggregatedFacts.length, 2);
});

test("timeline aggregation does not merge unrelated nearby facts", () => {
  const facts: FactItem[] = [
    buildFact("fact_1", "2026-06-18T08:00:00.000Z", "我正在吃牛排"),
    buildFact("fact_2", "2026-06-18T08:30:00.000Z", "项目进入联调")
  ];

  const aggregatedFacts = buildTimelineAggregatedFacts(facts);

  assert.equal(aggregatedFacts.length, 2);
});

test("timeline aggregation does not treat the pronoun 用户 as the event verb 用", () => {
  const timestamp = "2023-04-20T08:00:00.000Z";
  const facts: FactItem[] = [
    buildFact("fact_tune_up", timestamp, "用户于4月20日将自行车送去调试，原因是齿轮卡住。", "profile"),
    buildFact("fact_chain", timestamp, "用户更换了自行车链条，花费25美元。", "profile"),
    buildFact("fact_lights", timestamp, "用户安装了新的自行车灯，花费40美元。", "profile")
  ];

  const aggregatedFacts = buildTimelineAggregatedFacts(facts);

  assert.equal(aggregatedFacts.length, 3);
  assert.equal(aggregatedFacts.some((fact) => fact.factText.includes("25美元")), true);
  assert.equal(aggregatedFacts.some((fact) => fact.factText.includes("40美元")), true);
});

test("timeline aggregation merges broad episodic fact types when claims overlap", () => {
  const facts: FactItem[] = [
    buildFact("fact_1", "2026-06-18T08:00:00.000Z", "用户和张三吃牛排", "timeline"),
    buildFact("fact_2", "2026-06-18T08:30:00.000Z", "我正在吃牛排", "text")
  ];

  const aggregatedFacts = buildTimelineAggregatedFacts(facts);

  assert.equal(aggregatedFacts.length, 1);
  assert.deepEqual(aggregatedFacts[0]?.sourceFactIds, ["fact_1", "fact_2"]);
});

test("timeline aggregation tolerates legacy facts without source refs", () => {
  const legacyFact: Partial<FactItem> = buildFact("fact_legacy", "2026-06-18T08:00:00.000Z", "legacy fact") as FactItem & {
    linkedSourceRefs?: FactItem["linkedSourceRefs"];
  };
  delete legacyFact.linkedSourceRefs;

  const aggregatedFacts = buildTimelineAggregatedFacts([legacyFact as FactItem]);

  assert.equal(aggregatedFacts.length, 1);
  assert.deepEqual(aggregatedFacts[0]?.sourceRefs, []);
});

test("timeline summary includes provided aggregated facts even when event ids differ", () => {
  const event = buildEvent("grouped_event", "2026-06-18T09:00:00.000Z", "Grouped question");
  const aggregatedFacts = buildTimelineAggregatedFacts([
    buildFact("fact_session_1", "2026-06-18T08:00:00.000Z", "session evidence should be visible")
  ]);

  const summary = summarizeAggregatedFacts(aggregatedFacts, event);

  assert.equal(summary.includes("session evidence should be visible"), true);
});

function buildEvent(eventId: string, eventTime: string, content: string): MemoryEvent {
  return {
    eventId,
    eventType: "aggregation_demo_event",
    eventDescription: content,
    eventTime,
    sourceApp: "test",
    sourceId: "aggregation-demo",
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
        content,
        ref: "aggregation-demo"
      }
    ],
    sourceRefs: [
      {
        sourceRefId: `src_${eventId}`,
        sourceType: "file",
        sourceId: "aggregation-demo"
      }
    ]
  };
}

function buildFact(
  factId: string,
  validTimeStart: string,
  factText: string,
  factType = "timeline"
): FactItem {
  return {
    factId,
    factType,
    factText,
    normalizedClaim: factText,
    linkedEventIds: [factId.replace("fact", "event")],
    linkedSegmentIds: [factId.replace("fact", "seg")],
    linkedSourceRefs: [{ sourceRefId: `src_${factId}`, sourceType: "file", sourceId: "timeline-demo" }],
    entityIds: [],
    confidenceLevel: "medium",
    version: 1,
    status: "active",
    observedAt: validTimeStart,
    validTimeStart,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  };
}

function chatCompletion(payload: unknown) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
