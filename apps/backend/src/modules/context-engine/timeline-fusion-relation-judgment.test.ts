import assert from "node:assert/strict";
import test from "node:test";
import type { FactItem } from "./domain.js";
import { judgeTimelineFusionRelationsWithLlm } from "./timeline-fusion-relation-judgment.js";
import { buildTimelineFusionRelationInput } from "./timeline-fusion-relations.js";

test("calls the LLM with the relations schema and parses a relations response", async () => {
  let requestBody = "";
  const result = await judgeTimelineFusionRelationsWithLlm(input(), {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234/",
    model: "test-model",
    transport: "fetch",
    maxAttempts: 1,
    fetchImpl: async (_request, init) => {
      requestBody = String(init?.body ?? "");
      return jsonResponse({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              relations: [{
                type: "supports",
                sourceFactIds: ["fact_new", "fact_history"],
                factText: null,
                normalizedClaim: null,
                confidenceLevel: "high",
                reasonCode: "same_claim_additional_evidence"
              }]
            })
          }
        }]
      });
    }
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.responseFormat, "relations");
  assert.equal(result.result.relations[0]?.type, "supports");
  const body = JSON.parse(requestBody) as {
    model: string;
    response_format: { type: string; json_schema: { name: string; strict: boolean } };
    messages: Array<{ content: string }>;
  };
  assert.equal(body.model, "test-model");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "timeline_fusion_relations");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.match(body.messages.at(-1)?.content ?? "", /needs_review/u);
});

test("falls back from a legacy group that merges a quantitative fact", async () => {
  const result = await judgeTimelineFusionRelationsWithLlm(input(
    "用户每天通勤单程 45 分钟时使用 Audible",
    "用户在通勤时使用 Audible 听有声书"
  ), {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234",
    transport: "fetch",
    maxAttempts: 1,
    fetchImpl: async () => jsonResponse({
      groups: [{
        factText: "用户每天单程通勤45分钟时使用Audible听有声书。",
        normalizedClaim: "用户每天单程通勤45分钟使用Audible听有声书",
        sourceFactIds: ["fact_new", "fact_history"],
        confidenceLevel: "high"
      }]
    })
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.responseFormat, "fallback");
  assert.equal(result.fallbackReason, "protected_details_lost");
  assert.deepEqual(result.result.relations, []);
  assert.deepEqual(result.result.unusedFactIds, ["fact_history", "fact_new"]);
});

test("missing API key falls back without making a request", async () => {
  let requested = false;
  const result = await judgeTimelineFusionRelationsWithLlm(input(), {
    apiKey: "",
    fetchImpl: async () => {
      requested = true;
      throw new Error("must_not_call");
    }
  });

  assert.equal(requested, false);
  assert.equal(result.status, "fallback");
  assert.equal(result.fallbackReason, "missing_api_key");
  assert.equal(result.responseFormat, "fallback");
  assert.deepEqual(result.result.relations, []);
  assert.deepEqual(result.result.unusedFactIds, ["fact_history", "fact_new"]);
});

test("request failure falls back and preserves every input fact", async () => {
  const result = await judgeTimelineFusionRelationsWithLlm(input(), {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234",
    transport: "fetch",
    maxAttempts: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      throw new Error("network_down");
    }
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.fallbackReason, "llm_request_failed");
  assert.deepEqual(result.result.unusedFactIds, ["fact_history", "fact_new"]);
  assert.match(result.error ?? "", /network_down/u);
});

test("invalid JSON falls back instead of treating facts as unrelated", async () => {
  const result = await judgeTimelineFusionRelationsWithLlm(input(), {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234",
    transport: "fetch",
    maxAttempts: 1,
    fetchImpl: async () => new Response("not-json", {
      status: 200,
      headers: { "content-type": "text/plain" }
    })
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.fallbackReason, "invalid_response");
  assert.deepEqual(result.result.relations, []);
  assert.deepEqual(result.result.unusedFactIds, ["fact_history", "fact_new"]);
});

test("lossy fused text receives a distinct stable fallback reason", async () => {
  const result = await judgeTimelineFusionRelationsWithLlm(input(
    "用户每天通勤单程 45 分钟时使用 Audible",
    "用户在通勤时使用 Audible 听有声书"
  ), {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234",
    transport: "fetch",
    maxAttempts: 1,
    fetchImpl: async () => jsonResponse({
      relations: [{
        type: "same_event",
        sourceFactIds: ["fact_new", "fact_history"],
        factText: "用户通勤时使用Audible听有声书。",
        normalizedClaim: "用户通勤使用Audible听有声书",
        confidenceLevel: "high",
        reasonCode: "same_commute_event"
      }]
    })
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.fallbackReason, "protected_details_lost");
  assert.deepEqual(result.result.unusedFactIds, ["fact_history", "fact_new"]);
});

function input(
  newClaim = "Atlas release started",
  historyClaim = "Atlas release has started"
) {
  return buildTimelineFusionRelationInput({
    newFacts: [fact("fact_new", newClaim)],
    candidateFacts: [fact("fact_history", historyClaim)],
    temporalWindow: {
      basis: "evidence",
      startAt: "2026-08-07T07:00:00.000Z",
      endAt: "2026-08-07T09:00:00.000Z"
    }
  });
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function fact(factId: string, claim: string): FactItem {
  return {
    factId,
    factType: "event",
    factText: claim,
    normalizedClaim: claim,
    linkedEventIds: [`event_${factId}`],
    linkedSegmentIds: [`segment_${factId}`],
    linkedSourceRefs: [],
    entityIds: ["atlas"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-08-07T08:30:00.000Z",
    evidenceTimeStart: "2026-08-07T08:00:00.000Z",
    evidenceTimeConfidence: "high",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-relation-judgment-test.v1"
  };
}
