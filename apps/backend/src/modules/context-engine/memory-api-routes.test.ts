import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { registerMemoryApiRoutes } from "./memory-api-routes.js";
import { createContextEngineService } from "./write-event.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

const configDir = await mkdtemp(join(tmpdir(), "mem-routes-test-"));
const configPath = join(configDir, "context-engine.json");
await writeFile(configPath, JSON.stringify({
  embedding: { protocol: "deterministic-test", model: "deterministic-test", dimensions: 512 }
}));
process.env.CONTEXT_ENGINE_CONFIG = configPath;
process.env.OPENAI_API_KEY = "test-key";

test.after(async () => {
  delete process.env.CONTEXT_ENGINE_CONFIG;
  delete process.env.OPENAI_API_KEY;
  await rm(configDir, { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;

async function setupApp() {
  const repository = new InMemoryContextEngineRepository();
  const service = createContextEngineService(repository);
  const app = fastify();
  registerMemoryApiRoutes(app, service, repository);
  await app.ready();
  return app;
}

function readAllowedSegmentIds(prompt: string): string[] {
  try {
    const start = prompt.indexOf("{");
    const parsed = JSON.parse(prompt.slice(start >= 0 ? start : 0)) as { allowedSegmentIds?: unknown };
    return Array.isArray(parsed.allowedSegmentIds) ? parsed.allowedSegmentIds.map(String) : [];
  } catch {
    return [];
  }
}

test("memory api add/search follows the add/search contract", async () => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { messages?: Array<{ content?: string }> } : {};
    const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? "";
    const payload = prompt.includes("STM")
      ? { result: "reject", reason: "test_reject_admission" }
      : {
          facts: [
            {
              factType: "text",
              factText: "The user lived in Paris for three years and speaks French.",
              normalizedClaim: "user lived in Paris for three years",
              confidenceLevel: "high",
              linkedSegmentIds: [readAllowedSegmentIds(prompt)[0]],
              entityIds: ["Paris"],
              timeBasis: "source_time",
              timeConfidence: "high"
            }
          ]
        };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const app = await setupApp();
  try {
    const health = await app.inject({ method: "GET", url: "/v1/memories/health" });
    assert.equal(health.statusCode, 200);

    const addBody = {
      request_id: "eval:run_test:conv-0:chunk-0",
      messages: [{ role: "user", timestamp: 1704067200000, content: "我在巴黎住了三年，会说法语。" }],
      user_id: "eval:run_test:conv-0",
      session_id: "eval:run_test:sample:0"
    };
    const add = await app.inject({ method: "POST", url: "/v1/memories/add", payload: addBody });
    assert.equal(add.statusCode, 200);
    assert.equal(add.json().success, true);
    assert.equal(add.json().request_id, addBody.request_id);
    assert.equal(add.json().user_id, addBody.user_id);
    assert.equal(add.json().session_id, addBody.session_id);

    const search = await app.inject({
      method: "POST",
      url: "/v1/memories/search",
      payload: { query: "用户住在哪里？会什么语言？", user_id: addBody.user_id, top_k: 100 }
    });
    assert.equal(search.statusCode, 200);
    const data = search.json().data;
    assert.equal(Array.isArray(data), true);
    assert.equal(data.length > 0, true);
    assert.equal(data.length <= 100, true);
    for (const item of data) {
      assert.equal(typeof item.id, "string");
      assert.equal(typeof item.content, "string");
      assert.notEqual(item.content.trim(), "");
    }

    const foreign = await app.inject({
      method: "POST",
      url: "/v1/memories/search",
      payload: { query: "用户住在哪里？", user_id: "eval:run_test:other-user", top_k: 100 }
    });
    assert.equal(foreign.statusCode, 200);
    assert.deepEqual(foreign.json().data, []);

    const optionsSearch = await app.inject({
      method: "POST",
      url: "/v1/memories/search",
      payload: {
        query: "Which answer best matches the memory?",
        options: ["A. Paris", "B. London"],
        user_id: addBody.user_id,
        top_k: 5
      }
    });
    assert.equal(optionsSearch.statusCode, 200);
    assert.equal(optionsSearch.json().data.length <= 5, true);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/memories/add",
      payload: { messages: [], user_id: "u", session_id: "s" }
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(typeof invalid.json().detail.reason, "string");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("memory api routes enforce the memory system key when configured", async () => {
  process.env.MEMORY_SYSTEM_KEY = "secret-key";
  const app = await setupApp();
  try {
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/memories/add",
      headers: { authorization: "Bearer wrong-key" },
      payload: { request_id: "r1", messages: [{ role: "user", content: "hi" }], user_id: "u1", session_id: "s1" }
    });
    assert.equal(rejected.statusCode, 401);

    const noHeader = await app.inject({
      method: "POST",
      url: "/v1/memories/search",
      payload: { query: "q", user_id: "u1", top_k: 5 }
    });
    assert.equal(noHeader.statusCode, 401);

    const healthNoAuth = await app.inject({ method: "GET", url: "/v1/memories/health" });
    assert.equal(healthNoAuth.statusCode, 200);
  } finally {
    delete process.env.MEMORY_SYSTEM_KEY;
    await app.close();
  }
});

test("accepted auth styles include bearer, token and x-api-key", async () => {
  process.env.MEMORY_SYSTEM_KEY = "secret-key";
  const app = await setupApp();
  try {
    for (const headers of [
      { authorization: "Bearer secret-key" },
      { authorization: "Token secret-key" },
      { "x-api-key": "secret-key" }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/memories/search",
        headers,
        payload: { query: "q", user_id: "nobody", top_k: 5 }
      });
      assert.equal(response.statusCode, 200, `expected 200 for ${JSON.stringify(headers)}`);
    }
  } finally {
    delete process.env.MEMORY_SYSTEM_KEY;
    await app.close();
  }
});
