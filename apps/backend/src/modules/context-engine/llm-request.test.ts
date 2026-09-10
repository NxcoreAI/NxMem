import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LLM_REQUEST_MAX_ATTEMPTS,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  isLlmRequestRetryExhausted,
  postOpenAiCompatibleJson,
  postOpenAiCompatibleResponse
} from "./llm-request.js";

const warnings: Array<{ message: string; fields: unknown }> = [];

async function main() {
  const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });

  let error: unknown;
  try {
    await postOpenAiCompatibleJson({
      endpoint: "http://example.com/v1/chat/completions",
      apiKey: "test-key",
      body: { model: "test-model" },
      timeoutMs: 5,
      maxAttempts: 1,
      operation: "dreaming",
      logger: {
        warn(fields: unknown, message: string) {
          warnings.push({ message, fields });
        }
      },
      fetchImpl
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof Error);
  assert.match(error.message, /timed out/i);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, "openai-compatible request timed out");
  assert.equal((warnings[0]?.fields as { operation?: string } | undefined)?.operation, "dreaming");
}

await main();

async function assertExternalAbortCancelsFetchRequest() {
  const controller = new AbortController();
  let signalWasAborted = false;
  const request = postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "test-key",
    body: { model: "test-model" },
    timeoutMs: 60_000,
    operation: "longmemeval",
    signal: controller.signal,
    fetchImpl: async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          signalWasAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
  });

  controller.abort();
  await assert.rejects(request, /longmemeval aborted/);
  assert.equal(signalWasAborted, true);
}

await assertExternalAbortCancelsFetchRequest();

async function assertChatCompletionsDisableThinking() {
  const originalBody = {
    model: "test-model",
    enable_thinking: true,
    thinking: { type: "enabled" }
  };
  let requestBody: Record<string, unknown> = {};

  await postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "test-key",
    body: originalBody,
    operation: "fact_extraction",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: "{}" } }] });
    }
  });

  assert.equal("enable_thinking" in requestBody, false);
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.equal(originalBody.enable_thinking, true);
  assert.deepEqual(originalBody.thinking, { type: "enabled" });
}

await assertChatCompletionsDisableThinking();

async function assertResponsesBodyIsUnchanged() {
  let requestBody: Record<string, unknown> = {};

  await postOpenAiCompatibleResponse({
    endpoint: "http://example.com/v1/responses",
    apiKey: "test-key",
    body: { model: "test-model" },
    operation: "response_test",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ output_text: "ok" });
    }
  });

  assert.equal("thinking" in requestBody, false);
}

await assertResponsesBodyIsUnchanged();

async function assertSdkStreamingChatCompletionAssemblesJson() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const encoder = new TextEncoder();
  const responseBody = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Al" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "pha" }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ];

  const result = await postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "test-key",
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "answer" }],
      temperature: 0
    },
    operation: "longmemeval",
    transport: "openai-sdk-stream",
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      });
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of responseBody) controller.enqueue(encoder.encode(chunk));
          controller.close();
        }
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  });

  assert.equal(requests[0]?.url, "http://example.com/v1/chat/completions");
  assert.equal(requests[0]?.body.stream, true);
  assert.equal("enable_thinking" in (requests[0]?.body ?? {}), false);
  assert.deepEqual(requests[0]?.body.thinking, { type: "disabled" });
  assert.equal((result as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content, "Alpha");
}

await assertSdkStreamingChatCompletionAssemblesJson();

async function assertSdkStreamingUsesDefaultTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const delays: number[] = [];
  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
      delays.push(Number(delay));
      queueMicrotask(() => callback());
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

    await assert.rejects(
      postOpenAiCompatibleJson({
        endpoint: "http://example.com/v1/chat/completions",
        apiKey: "test-key",
        body: { model: "test-model", messages: [{ role: "user", content: "answer" }] },
        operation: "longmemeval",
        transport: "openai-sdk-stream",
        maxAttempts: 1,
        fetchImpl: async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      }),
      /timed out after 180000ms/
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.equal(delays.includes(DEFAULT_LLM_REQUEST_TIMEOUT_MS), true);
}

await assertSdkStreamingUsesDefaultTimeout();

async function assertDefaultTimeoutIsThreeMinutes() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const delays: number[] = [];
  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
      delays.push(Number(delay));
      queueMicrotask(() => callback());
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

    await assert.rejects(
      postOpenAiCompatibleResponse({
        endpoint: "http://example.com/v1/responses",
        apiKey: "test-key",
        body: { model: "test-model" },
        operation: "llm_test",
        maxAttempts: 1,
        fetchImpl: async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      }),
      /timed out after 180000ms/
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.deepEqual(delays, [DEFAULT_LLM_REQUEST_TIMEOUT_MS]);
}

await assertDefaultTimeoutIsThreeMinutes();

async function assertJsonRequestRetriesRetryableHttpFailures() {
  let attempts = 0;
  const result = await postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "test-key",
    body: { model: "test-model" },
    operation: "longmemeval",
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("temporary overload", { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
}

await assertJsonRequestRetriesRetryableHttpFailures();

async function assertStreamingRequestRetriesTransportFailures() {
  let attempts = 0;
  const result = await postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "test-key",
    body: { model: "test-model", messages: [{ role: "user", content: "answer" }] },
    operation: "longmemeval",
    transport: "openai-sdk-stream",
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      return new Response(JSON.stringify({ choices: [{ message: { content: "Alpha" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.equal((result as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content, "Alpha");
  assert.equal(attempts, 2);
}

await assertStreamingRequestRetriesTransportFailures();

test("LLM requests use ten attempts as the global maximum", () => {
  assert.equal(DEFAULT_LLM_REQUEST_MAX_ATTEMPTS, 10);
});

test("non-streaming JSON requests do not nest retry loops", async () => {
  let attempts = 0;
  await assert.rejects(
    postOpenAiCompatibleJson({
      endpoint: "http://example.com/v1/chat/completions",
      apiKey: "test-key",
      body: { model: "test-model" },
      operation: "non_stream_exhaustion",
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return new Response("still unavailable", { status: 503 });
      }
    }),
    (error: unknown) => isLlmRequestRetryExhausted(error) && error.attempts === 2
  );
  assert.equal(attempts, 2);
});

test("streaming requests expose the same retry exhaustion error", async () => {
  let attempts = 0;
  await assert.rejects(
    postOpenAiCompatibleJson({
      endpoint: "http://example.com/v1/chat/completions",
      apiKey: "test-key",
      body: { model: "test-model", messages: [{ role: "user", content: "answer" }] },
      operation: "stream_exhaustion",
      transport: "openai-sdk-stream",
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error("socket connection reset");
      }
    }),
    (error: unknown) => isLlmRequestRetryExhausted(error) && error.attempts === 2
  );
  assert.equal(attempts, 2);
});

test("request timeouts are retried and then marked exhausted", async () => {
  let attempts = 0;
  await assert.rejects(
    postOpenAiCompatibleResponse({
      endpoint: "http://example.com/v1/responses",
      apiKey: "test-key",
      body: { model: "test-model" },
      operation: "timeout_exhaustion",
      timeoutMs: 5,
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async (_url, init) => {
        attempts += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
    }),
    (error: unknown) => isLlmRequestRetryExhausted(error) && error.attempts === 2 && /timed out/i.test(error.lastError)
  );
  assert.equal(attempts, 2);
});

test("caller overrides cannot exceed the ten-attempt maximum", async () => {
  let attempts = 0;
  await assert.rejects(
    postOpenAiCompatibleResponse({
      endpoint: "http://example.com/v1/responses",
      apiKey: "test-key",
      body: { model: "test-model" },
      operation: "retry_cap",
      maxAttempts: 99,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return new Response("temporary", { status: 503 });
      }
    }),
    (error: unknown) => isLlmRequestRetryExhausted(error) && error.attempts === 10
  );
  assert.equal(attempts, 10);
});

test("transient conflict and premature connection failures use the unified retry loop", async () => {
  let attempts = 0;
  const result = await postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "test-key",
    body: { model: "test-model" },
    operation: "network_recovery",
    maxAttempts: 3,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("request conflict", { status: 409 });
      if (attempts === 2) {
        const error = new TypeError("terminated");
        Object.assign(error, { code: "ERR_STREAM_PREMATURE_CLOSE" });
        throw error;
      }
      return Response.json({ ok: true });
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 3);
});

test("observer exposes each transport attempt with prepared body, aggregate response, and usage", async () => {
  const observations: Array<Parameters<NonNullable<Parameters<typeof postOpenAiCompatibleJson>[0]["observer"]>>[0]> = [];
  let attempts = 0;
  const result = await postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "secret-key",
    body: { model: "trace-model", enable_thinking: true, messages: [{ role: "user", content: "hello" }] },
    operation: "trace_attempts",
    maxAttempts: 2,
    retryDelayMs: 0,
    observer: (observation) => observations.push(observation),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("temporary", { status: 503 });
      return Response.json({
        choices: [{ message: { content: "complete answer" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 }
      });
    }
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    choices: [{ message: { content: "complete answer" } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 }
  });
  const started = observations.filter((item) => item.status === "started");
  assert.deepEqual(started.map((item) => item.internalAttempt), [1, 2]);
  assert.deepEqual(started[0]?.requestBody, {
    model: "trace-model",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "disabled" }
  });
  const succeeded = observations.find((item) => item.status === "succeeded");
  assert.equal(succeeded?.internalAttempt, 2);
  assert.deepEqual(succeeded?.usage, { prompt_tokens: 3, completion_tokens: 2 });
  assert.deepEqual(succeeded?.response, result);
});

test("streaming observer records one aggregate response instead of token chunks", async () => {
  const observations: Array<Parameters<NonNullable<Parameters<typeof postOpenAiCompatibleJson>[0]["observer"]>>[0]> = [];
  const result = await postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "secret-key",
    body: { model: "stream-model", messages: [{ role: "user", content: "hello" }] },
    operation: "trace_stream",
    transport: "openai-sdk-stream",
    maxAttempts: 1,
    observer: (observation) => observations.push(observation),
    fetchImpl: async () => Response.json({
      choices: [{ message: { content: "aggregated response" } }],
      usage: { total_tokens: 8 }
    })
  });

  const succeeded = observations.filter((item) => item.status === "succeeded");
  assert.equal(succeeded.length, 1);
  assert.deepEqual(succeeded[0]?.response, result);
  assert.equal((succeeded[0]?.response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content, "aggregated response");
});

test("429 rate limit failures are retried with exponential backoff", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await postOpenAiCompatibleJson({
    endpoint: "http://example.com/v1/chat/completions",
    apiKey: "test-key",
    body: { model: "test-model" },
    operation: "rate_limit_backoff",
    maxAttempts: 3,
    retryDelayMs: 100,
    logger: {
      warn(fields: unknown, _message: string) {
        const delayMs = (fields as { delayMs?: number }).delayMs;
        if (delayMs !== undefined) delays.push(delayMs);
      }
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return new Response("rate limited", { status: 429 });
      return Response.json({ choices: [{ message: { content: "Recovered" } }] });
    }
  });

  assert.equal((result as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content, "Recovered");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("429 retries honor retry-after header when present", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    postOpenAiCompatibleJson({
      endpoint: "http://example.com/v1/chat/completions",
      apiKey: "test-key",
      body: { model: "test-model" },
      operation: "rate_limit_retry_after",
      maxAttempts: 2,
      retryDelayMs: 100,
      logger: {
        warn(fields: unknown, _message: string) {
          const delayMs = (fields as { delayMs?: number }).delayMs;
          if (delayMs !== undefined) delays.push(delayMs);
        }
      },
      fetchImpl: async () => {
        attempts += 1;
        return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
      }
    }),
    (error: unknown) => isLlmRequestRetryExhausted(error) && error.attempts === 2
  );
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1_000]);
});
