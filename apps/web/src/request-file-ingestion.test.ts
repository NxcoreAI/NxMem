import test from "node:test";
import assert from "node:assert/strict";
import { requestFileIngestion } from "./features/import/request-file-ingestion.js";

test("requestFileIngestion posts to the ingest endpoint with an empty payload", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return new Response(JSON.stringify({ ok: true, result: { progress: { total: 0, processed: 0, remembered: 0, failed: 0, progress: 0, items: [] } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestFileIngestion(fetchImpl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/context/ingest/files");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal(calls[0]?.init?.body, "{}");
  assert.equal(response.ok, true);
});
