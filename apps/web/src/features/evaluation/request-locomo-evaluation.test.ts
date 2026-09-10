import test from "node:test";
import assert from "node:assert/strict";
import { requestCancelLocomoEvaluation, requestLocomoEvaluation, requestLocomoEvaluationJob } from "./request-locomo-evaluation.js";

test("LoCoMo evaluation client uses dedicated native endpoints", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ ok: true, result: { jobId: "locomo-1", status: "queued" } }), {
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  await requestLocomoEvaluation(fetchImpl, {
    datasetPath: "../../data/locomo/locomo10.json",
    command: "full",
    sampleIds: ["conv-26"],
    questionLimit: 5,
    llm: {
      extraction: { baseUrl: "https://extract.example/v1", model: "fact-model", apiKey: "extract-secret" },
      answer: { baseUrl: "https://answer.example/v1", model: "answer-model", apiKey: "answer-secret" }
    },
    disableIngestLlm: false
  });
  await requestLocomoEvaluationJob(fetchImpl, "locomo-1");
  await requestCancelLocomoEvaluation(fetchImpl, "locomo-1");
  assert.equal(calls[0]?.url, "/context/evaluations/locomo");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    datasetPath: "../../data/locomo/locomo10.json",
    command: "full",
    sampleIds: ["conv-26"],
    questionLimit: 5,
    llm: {
      extraction: { baseUrl: "https://extract.example/v1", model: "fact-model", apiKey: "extract-secret" },
      answer: { baseUrl: "https://answer.example/v1", model: "answer-model", apiKey: "answer-secret" }
    },
    disableIngestLlm: false
  });
  assert.equal(calls[1]?.url, "/context/evaluations/locomo/locomo-1");
  assert.equal(calls[2]?.url, "/context/evaluations/locomo/locomo-1/cancel");
});
