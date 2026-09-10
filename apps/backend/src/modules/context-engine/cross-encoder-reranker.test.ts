import test from "node:test";
import assert from "node:assert/strict";
import { createHttpCrossEncoderReranker, parseRerankResponse } from "./cross-encoder-reranker.js";

test("reranker response maps model scores back to candidate ids", () => {
  const documents = [{ id: "weak", text: "sister sent a gift" }, { id: "answer", text: "father sent a watch" }];
  assert.deepEqual(parseRerankResponse({ results: [
    { index: 1, relevance_score: 0.92 },
    { index: 0, relevance_score: 0.08 }
  ] }, documents), [
    { id: "answer", score: 0.92, originalRank: 2 },
    { id: "weak", score: 0.08, originalRank: 1 }
  ]);
});

test("HTTP reranker sends query and all documents", async () => {
  let body: Record<string, unknown> | undefined;
  const reranker = createHttpCrossEncoderReranker({
    endpoint: "https://reranker.test/v1/rerank",
    apiKey: "test-key",
    model: "multilingual-test",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ results: [
        { index: 0, relevance_score: 0.7 },
        { index: 1, relevance_score: 0.2 }
      ] }), { status: 200 });
    }
  });
  const result = await reranker.rerank("what did father send", [
    { id: "a", text: "father sent a watch" },
    { id: "b", text: "sister sent flowers" }
  ]);
  assert.equal(body?.model, "multilingual-test");
  assert.deepEqual(body?.documents, ["father sent a watch", "sister sent flowers"]);
  assert.deepEqual(result.map((item) => item.id), ["a", "b"]);
});

test("reranker rejects incomplete responses so callers can fall back", () => {
  assert.throws(() => parseRerankResponse({ results: [{ index: 0, relevance_score: 1 }] }, [
    { id: "a", text: "a" },
    { id: "b", text: "b" }
  ]), /omitted documents/u);
});
