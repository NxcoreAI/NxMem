import test from "node:test";
import assert from "node:assert/strict";
import { embedTexts } from "./embedding.js";
import type { ContextEngineConfig } from "../../config.js";

type EmbeddingConfig = ContextEngineConfig["embedding"];

test("OpenAI-compatible embeddings send model, batch input, dimensions, and bearer auth", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    });
    return embeddingResponse([
      { index: 1, embedding: vector(1024, 2) },
      { index: 0, embedding: vector(1024, 1) }
    ]);
  }) as typeof fetch;

  try {
    const results = await embedTexts(["first", "second"], config({ dimensions: 1024 }));
    assert.equal(requests[0]?.url, "https://embedding.example.com/v1/embeddings");
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer secret");
    assert.equal(requests[0]?.body.model, "cross-language-model");
    assert.equal(requests[0]?.body.dimensions, 1024);
    assert.deepEqual(requests[0]?.body.input, ["first", "second"]);
    assert.equal(results[0]?.embedding[0], 1);
    assert.equal(results[1]?.embedding[0], 2);
    assert.equal(results.every((item) => item.source === "remote"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adapter embeddings use /api/embeddings without requiring auth or dimensions in the request", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    request = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    };
    return embeddingResponse([{ index: 0, embedding: vector(512, 3) }]);
  }) as typeof fetch;

  try {
    const adapterConfig = config({
      protocol: "adapter",
      baseUrl: "http://127.0.0.1:3000",
      dimensions: 512,
      apiKeySource: "missing"
    });
    delete adapterConfig.apiKey;
    const results = await embedTexts(["设备离线"], adapterConfig);
    assert.equal(request?.url, "http://127.0.0.1:3000/api/embeddings");
    assert.equal(request?.headers.get("authorization"), null);
    assert.equal("dimensions" in (request?.body ?? {}), false);
    assert.equal(results[0]?.embedding.length, 512);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote embeddings accept configured 512, 1024, and 1536 dimensional models", async () => {
  const originalFetch = globalThis.fetch;
  let activeDimensions = 512;
  globalThis.fetch = (async () => embeddingResponse([{ index: 0, embedding: vector(activeDimensions, 1) }])) as typeof fetch;
  try {
    for (const dimensions of [512, 1024, 1536]) {
      activeDimensions = dimensions;
      const [result] = await embedTexts([`dimension-${dimensions}`], config({ dimensions }));
      assert.equal(result?.embedding.length, dimensions);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote embeddings can omit the dimensions request parameter but still validate the response", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return embeddingResponse([{ index: 0, embedding: vector(1024, 1) }]);
  }) as typeof fetch;
  try {
    const [result] = await embedTexts(["fixed-dimension-model"], config({ dimensions: 1024, sendDimensions: false }));
    assert.equal("dimensions" in body, false);
    assert.equal(result?.embedding.length, 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote embedding failures exhaust retries without falling back to deterministic vectors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("network down");
  }) as typeof fetch;
  try {
    await assert.rejects(
      embedTexts(["固件升级完成"], config({ maxAttempts: 2, retryDelayMs: 0 })),
      /retry attempts exhausted after 2 attempts/
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote embedding retries 429 and 5xx responses before succeeding", async () => {
  const originalFetch = globalThis.fetch;
  const statuses = [429, 503, 200];
  let calls = 0;
  globalThis.fetch = (async () => {
    const status = statuses[calls++] ?? 200;
    return status === 200
      ? embeddingResponse([{ index: 0, embedding: vector(512, 1) }])
      : new Response("temporary", { status });
  }) as typeof fetch;
  try {
    const [result] = await embedTexts(["retry me"], config({ maxAttempts: 3, retryDelayMs: 0 }));
    assert.equal(result?.embedding.length, 512);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote embedding does not retry authentication failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  try {
    await assert.rejects(embedTexts(["auth"], config({ maxAttempts: 3, retryDelayMs: 0 })), /http_401/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote embedding applies the configured timeout without fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  try {
    await assert.rejects(
      embedTexts(["timeout"], config({ timeoutMs: 1, maxAttempts: 1, retryDelayMs: 0 })),
      /timed out/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote embedding rejects count, dimension, and non-finite response errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => embeddingResponse([])) as typeof fetch;
    await assert.rejects(embedTexts(["alpha"], config({ dimensions: 512 })), /count mismatch/);

    globalThis.fetch = (async () => embeddingResponse([{ index: 0, embedding: vector(1024, 1) }])) as typeof fetch;
    await assert.rejects(embedTexts(["alpha"], config({ dimensions: 512 })), /dimension mismatch/);

    const invalid = vector(512, 1) as Array<number | null>;
    invalid[17] = null;
    globalThis.fetch = (async () => embeddingResponse([{ index: 0, embedding: invalid }])) as typeof fetch;
    await assert.rejects(embedTexts(["alpha"], config({ dimensions: 512 })), /non-finite value/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function config(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    protocol: "openai-compatible",
    baseUrl: "https://embedding.example.com/v1",
    model: "cross-language-model",
    apiKeyEnv: "EMBEDDING_API_KEY",
    apiKey: "secret",
    apiKeySource: "env",
    dimensions: 512,
    sendDimensions: true,
    timeoutMs: 60_000,
    maxAttempts: 3,
    retryDelayMs: 0,
    concurrency: 4,
    batchSize: 32,
    ...overrides
  };
}

function vector(dimensions: number, value: number) {
  return Array.from({ length: dimensions }, (_, index) => index === 0 ? value : 0);
}

function embeddingResponse(data: Array<{ index: number; embedding: unknown }>) {
  return new Response(JSON.stringify({ object: "list", data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
