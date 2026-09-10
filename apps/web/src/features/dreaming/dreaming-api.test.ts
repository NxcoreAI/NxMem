import assert from "node:assert/strict";
import test from "node:test";
import { controlDreamingRun, createDreamingRun, listDreamingRuns } from "./dreaming-api";

test("listDreamingRuns sends the owner and unwraps the result", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ ok: true, result: { items: [] } }), { status: 200 });
  };
  try {
    const result = await listDreamingRuns({ tenantId: "tenant-a", principalId: "user-a" });
    assert.deepEqual(result, { items: [] });
    assert.match(requestUrl, /tenantId=tenant-a/);
    assert.match(requestUrl, /principalId=user-a/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createDreamingRun posts owner data", async () => {
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    request = init;
    return new Response(JSON.stringify({ ok: true, result: { runId: "run-1" } }), { status: 202 });
  };
  try {
    const result = await createDreamingRun({ tenantId: "tenant-a", principalId: "user-a" });
    assert.equal(result.runId, "run-1");
    assert.equal(request?.method, "POST");
    assert.equal(request?.body, JSON.stringify({ tenantId: "tenant-a", principalId: "user-a" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("controlDreamingRun surfaces backend errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "DREAMING_RUN_NOT_PAUSABLE" }), { status: 409 });
  try {
    await assert.rejects(
      () => controlDreamingRun("run-1", "pause"),
      /DREAMING_RUN_NOT_PAUSABLE/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

