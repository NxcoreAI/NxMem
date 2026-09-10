import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublicContextEngineConfig,
  loadContextEngineConfig,
  saveContextEngineRuntimeConfig,
  reloadContextEngineConfig
} from "./config.js";
import { createHealthServer } from "./modules/health/server.js";

const testEmbeddingEnv = {
  EMBEDDING_PROTOCOL: "deterministic-test",
  EMBEDDING_MODEL: "deterministic-test",
  EMBEDDING_DIMENSIONS: "512"
};

test("loads context engine config from json and resolves project paths", async () => {
  const directory = join(tmpdir(), `context-config-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({
    server: { port: 4101, host: "0.0.0.0" },
    storage: { storePath: "tmp/store.json" },
    ingestion: { inboxDirectory: "tmp/inbox" },
    llm: {
      baseUrl: "https://llm.example.com/v1",
      model: "fusion-model",
      apiKeyEnv: "CUSTOM_LLM_KEY"
    }
  }));

  const config = loadContextEngineConfig(configPath, {
    ...testEmbeddingEnv,
    CUSTOM_LLM_KEY: "secret"
  });

  assert.equal(config.server.port, 4101);
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.storage.storePath, join(directory, "tmp/store.json"));
  assert.equal(config.ingestion.inboxDirectory, join(directory, "tmp/inbox"));
  assert.equal(config.llm.baseUrl, "https://llm.example.com/v1");
  assert.equal(config.llm.model, "fusion-model");
  assert.equal(config.llm.apiKey, "secret");
  assert.equal(config.llm.apiKeySource, "env");
  assert.equal(config.judgeLlm.baseUrl, "https://llm.example.com/v1");
  assert.equal(config.judgeLlm.model, "fusion-model");
  assert.equal(config.judgeLlm.apiKey, "secret");
});

test("Dreaming config is disabled by default and enforces product scheduling constraints", async () => {
  const directory = join(tmpdir(), `context-config-dreaming-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({}));
  assert.equal(loadContextEngineConfig(configPath, testEmbeddingEnv).dreaming.enabled, false);
  await writeFile(configPath, JSON.stringify({
    dreaming: {
      enabled: true,
      timezone: "Asia/Shanghai",
      schedule: "23:00",
      workerConcurrency: 1,
      maxAttemptsPerCycle: 3,
      reevaluationDays: [1, 3, 7],
      resumeIdleAfterMs: 25
    }
  }));

  const enabled = loadContextEngineConfig(configPath, testEmbeddingEnv);
  assert.equal(enabled.dreaming.enabled, true);
  assert.equal(enabled.dreaming.resumeIdleAfterMs, 25);
  assert.deepEqual(enabled.dreaming.reevaluationDays, [1, 3, 7]);
  assert.equal(createPublicContextEngineConfig(enabled).dreaming.enabled, true);

  await writeFile(configPath, JSON.stringify({ dreaming: { schedule: "22:00" } }));
  assert.throws(
    () => loadContextEngineConfig(configPath, testEmbeddingEnv),
    /dreaming\.schedule is fixed at 23:00/
  );
});

test("loads isolated LongMemEval storage and graph store config", async () => {
  const directory = join(tmpdir(), `context-config-longmemeval-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({
    graphStore: {
      mode: "neo4j",
      neo4j: {
        uri: "bolt://main.example.com:7687",
        username: "main",
        password: "main-secret",
        database: "neo4j",
        fulltextIndexName: "memory_node_fulltext",
        vectorIndexName: "memory_node_vector",
        vectorDimensions: 512
      }
    },
    longMemEval: {
      storage: {
        storeDirectory: "tmp/longmemeval"
      },
      graphStore: {
        mode: "neo4j",
        neo4j: {
          database: "longmemeval",
          fulltextIndexName: "longmemeval_memory_node_fulltext",
          vectorIndexName: "longmemeval_memory_node_vector"
        }
      }
    }
  }));

  const config = loadContextEngineConfig(configPath, testEmbeddingEnv);

  assert.equal(config.longMemEval.storage.storeDirectory, join(directory, "tmp/longmemeval"));
  assert.equal(config.longMemEval.graphStore.mode, "neo4j");
  assert.equal(config.longMemEval.graphStore.neo4j.uri, "bolt://main.example.com:7687");
  assert.equal(config.longMemEval.graphStore.neo4j.username, "main");
  assert.equal(config.longMemEval.graphStore.neo4j.password, "main-secret");
  assert.equal(config.longMemEval.graphStore.neo4j.database, "longmemeval");
  assert.equal(config.longMemEval.graphStore.neo4j.fulltextIndexName, "longmemeval_memory_node_fulltext");
  assert.equal(config.longMemEval.graphStore.neo4j.vectorIndexName, "longmemeval_memory_node_vector");
  assert.equal(config.longMemEval.graphStore.neo4j.vectorDimensions, 512);
});

test("environment variables override file config for deploy-time settings", async () => {
  const directory = join(tmpdir(), `context-config-env-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({
    server: { port: 4101 },
    llm: { baseUrl: "https://file.example.com/v1", model: "file-model" }
  }));

  const config = loadContextEngineConfig(configPath, {
    ...testEmbeddingEnv,
    PORT: "4202",
    OPENAI_BASE_URL: "https://env.example.com/v1",
    OPENAI_MODEL: "env-model",
    OPENAI_API_KEY: "env-secret"
  });

  assert.equal(config.server.port, 4202);
  assert.equal(config.llm.baseUrl, "https://env.example.com/v1");
  assert.equal(config.llm.model, "env-model");
  assert.equal(config.llm.apiKey, "env-secret");
  assert.equal(config.judgeLlm.baseUrl, "https://env.example.com/v1");
  assert.equal(config.judgeLlm.model, "env-model");
});

test("embedding model and dimensions are deployment settings and support 1024 dimensions", async () => {
  const directory = join(tmpdir(), `context-config-embedding-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({ graphStore: { mode: "local" } }));

  const config = loadContextEngineConfig(configPath, {
    EMBEDDING_PROTOCOL: "openai-compatible",
    EMBEDDING_BASE_URL: "https://embedding.example.com/v1",
    EMBEDDING_MODEL: "cross-language-model",
    EMBEDDING_API_KEY: "embedding-secret",
    EMBEDDING_DIMENSIONS: "1024"
  });

  assert.equal(config.embedding.protocol, "openai-compatible");
  assert.equal(config.embedding.model, "cross-language-model");
  assert.equal(config.embedding.dimensions, 1024);
  assert.equal(config.graphStore.neo4j.vectorDimensions, 1024);
  assert.equal(config.longMemEval.graphStore.neo4j.vectorDimensions, 1024);
});

test("loads all embedding settings from json without embedding environment variables", async () => {
  const directory = join(tmpdir(), `context-config-embedding-json-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({
    embedding: {
      protocol: "openai-compatible",
      baseUrl: "https://json-embedding.example.com/v1",
      model: "json-embedding-model",
      apiKey: "json-embedding-secret",
      dimensions: 1024,
      sendDimensions: false,
      timeoutMs: 45_000,
      maxAttempts: 4,
      retryDelayMs: 250,
      concurrency: 6,
      batchSize: 24
    },
    graphStore: { mode: "local" }
  }));

  const config = loadContextEngineConfig(configPath, {});

  assert.deepEqual(config.embedding, {
    protocol: "openai-compatible",
    baseUrl: "https://json-embedding.example.com/v1",
    model: "json-embedding-model",
    apiKeyEnv: "EMBEDDING_API_KEY",
    apiKey: "json-embedding-secret",
    apiKeySource: "config",
    dimensions: 1024,
    sendDimensions: false,
    timeoutMs: 45_000,
    maxAttempts: 4,
    retryDelayMs: 250,
    concurrency: 6,
    batchSize: 24
  });
  assert.equal(config.graphStore.neo4j.vectorDimensions, 1024);
  assert.equal(config.longMemEval.graphStore.neo4j.vectorDimensions, 1024);

  const publicConfig = createPublicContextEngineConfig(config);
  assert.equal(publicConfig.embedding.apiKeyConfigured, true);
  assert.equal("apiKey" in publicConfig.embedding, false);
});

test("runtime embedding json overrides main json and main json overrides environment fallback", async () => {
  const directory = join(tmpdir(), `context-config-embedding-runtime-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  const runtimeConfigPath = join(directory, "context-engine.runtime.json");
  await writeFile(configPath, JSON.stringify({
    embedding: {
      protocol: "openai-compatible",
      baseUrl: "https://main-embedding.example.com/v1",
      model: "main-model",
      apiKey: "main-secret",
      dimensions: 1024,
      concurrency: 6
    },
    graphStore: { mode: "local" }
  }));
  await writeFile(runtimeConfigPath, JSON.stringify({
    embedding: {
      protocol: "adapter",
      baseUrl: "https://runtime-adapter.example.com",
      model: "runtime-model",
      apiKey: "runtime-secret",
      dimensions: 1536,
      sendDimensions: false,
      batchSize: 16
    }
  }));

  const config = loadContextEngineConfig(configPath, {
    EMBEDDING_PROTOCOL: "deterministic-test",
    EMBEDDING_MODEL: "env-model",
    EMBEDDING_DIMENSIONS: "512",
    EMBEDDING_CONCURRENCY: "99"
  });

  assert.equal(config.embedding.protocol, "adapter");
  assert.equal(config.embedding.baseUrl, "https://runtime-adapter.example.com");
  assert.equal(config.embedding.model, "runtime-model");
  assert.equal(config.embedding.apiKey, "runtime-secret");
  assert.equal(config.embedding.apiKeySource, "runtime");
  assert.equal(config.embedding.dimensions, 1536);
  assert.equal(config.embedding.sendDimensions, false);
  assert.equal(config.embedding.batchSize, 16);
  assert.equal(config.embedding.concurrency, 6);
});

test("embedding configuration rejects missing deployment values and graph dimension conflicts", async () => {
  const directory = join(tmpdir(), `context-config-embedding-invalid-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({
    graphStore: { mode: "local", neo4j: { vectorDimensions: 512 } }
  }));

  assert.throws(
    () => loadContextEngineConfig(configPath, {}),
    /EMBEDDING_MODEL/
  );
  assert.throws(
    () => loadContextEngineConfig(configPath, {
      EMBEDDING_PROTOCOL: "adapter",
      EMBEDDING_BASE_URL: "http://127.0.0.1:3000",
      EMBEDDING_MODEL: "adapter-model",
      EMBEDDING_DIMENSIONS: "1024"
    }),
    /vectorDimensions must equal embedding\.dimensions/
  );
});

test("public config exposes frontend defaults without leaking secrets", async () => {
  const directory = join(tmpdir(), `context-config-public-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  await writeFile(configPath, JSON.stringify({
    embedding: {
      protocol: "deterministic-test",
      model: "deterministic-test",
      dimensions: 512
    }
  }));
  const config = loadContextEngineConfig(configPath, {
    OPENAI_BASE_URL: "https://frontend-default.example.com/v1",
    OPENAI_MODEL: "frontend-model",
    OPENAI_API_KEY: "must-not-leak"
  });

  const publicConfig = createPublicContextEngineConfig(config);

  assert.equal(publicConfig.llm.baseUrl, "https://frontend-default.example.com/v1");
  assert.equal(publicConfig.llm.model, "frontend-model");
  assert.equal(publicConfig.llm.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(publicConfig.llm.apiKeyConfigured, true);
  assert.equal("apiKey" in publicConfig.llm, false);
  assert.equal(publicConfig.judgeLlm.apiKeyConfigured, true);
  assert.equal(publicConfig.embedding.dimensions, 512);
  assert.equal(publicConfig.embedding.apiKeyConfigured, false);
  assert.equal("apiKey" in publicConfig.embedding, false);
});

test("runtime config persists llm api key and reloads from disk", async () => {
  const directory = join(tmpdir(), `context-config-runtime-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  const runtimeConfigPath = join(directory, "context-engine.runtime.json");
  await writeFile(configPath, JSON.stringify({
    llm: {
      baseUrl: "https://file.example.com/v1",
      model: "file-model",
      apiKeyEnv: "CUSTOM_LLM_KEY"
    }
  }));

  const saved = saveContextEngineRuntimeConfig({
    llm: {
      baseUrl: "https://runtime.example.com/v1",
      model: "runtime-model",
      apiKey: "runtime-secret"
    }
  }, configPath, testEmbeddingEnv);

  const runtimeRaw = await readFile(runtimeConfigPath, "utf8");
  assert.equal(runtimeRaw.includes("runtime-secret"), true);
  assert.equal(saved.llm.baseUrl, "https://runtime.example.com/v1");
  assert.equal(saved.llm.model, "runtime-model");
  assert.equal(saved.llm.apiKey, "runtime-secret");
  assert.equal(saved.llm.apiKeySource, "runtime");

  const reloaded = reloadContextEngineConfig(configPath, testEmbeddingEnv);
  assert.equal(reloaded.llm.apiKey, "runtime-secret");
  assert.equal(reloaded.llm.apiKeySource, "runtime");

  const publicConfig = createPublicContextEngineConfig(reloaded);
  assert.equal(publicConfig.llm.apiKeyConfigured, true);
  assert.equal(publicConfig.judgeLlm.apiKeyConfigured, true);
});

test("runtime config merges embedding settings without dropping llm or judge settings", async () => {
  const directory = join(tmpdir(), `context-config-runtime-embedding-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "context-engine.json");
  const runtimeConfigPath = join(directory, "context-engine.runtime.json");
  await writeFile(configPath, JSON.stringify({ graphStore: { mode: "local" } }));
  await writeFile(runtimeConfigPath, JSON.stringify({
    llm: { model: "runtime-llm", apiKey: "llm-secret" },
    judgeLlm: { model: "runtime-judge", apiKey: "judge-secret" }
  }));

  saveContextEngineRuntimeConfig({
    embedding: {
      protocol: "openai-compatible",
      baseUrl: "https://runtime-embedding.example.com/v1",
      model: "runtime-embedding",
      apiKey: "embedding-secret",
      dimensions: 1024,
      sendDimensions: true,
      timeoutMs: 60_000,
      maxAttempts: 3,
      retryDelayMs: 1_000,
      concurrency: 4,
      batchSize: 32
    }
  }, configPath, {});
  saveContextEngineRuntimeConfig({
    llm: { baseUrl: "https://runtime-llm.example.com/v1" }
  }, configPath, {});

  const runtimeRaw = JSON.parse(await readFile(runtimeConfigPath, "utf8")) as Record<string, Record<string, unknown>>;
  assert.equal(runtimeRaw.embedding?.model, "runtime-embedding");
  assert.equal(runtimeRaw.embedding?.dimensions, 1024);
  assert.equal(runtimeRaw.embedding?.apiKey, "embedding-secret");
  assert.equal(runtimeRaw.llm?.model, "runtime-llm");
  assert.equal(runtimeRaw.llm?.baseUrl, "https://runtime-llm.example.com/v1");
  assert.equal(runtimeRaw.judgeLlm?.model, "runtime-judge");

  const reloaded = reloadContextEngineConfig(configPath, {});
  assert.equal(reloaded.embedding.model, "runtime-embedding");
  assert.equal(reloaded.embedding.apiKeySource, "runtime");
  assert.equal(reloaded.llm.model, "runtime-llm");
  assert.equal(reloaded.judgeLlm.model, "runtime-judge");
});

test("health server tests LLM connectivity with request payload override", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: typeof url === "string" ? url : url.toString(),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    });
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "ok"
        }
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const server = createHealthServer();
  try {
    const response = await server.inject({
      method: "POST",
      url: "/context/config/llm/test",
      headers: { "content-type": "application/json" },
      payload: {
        llm: {
          baseUrl: "https://llm.example.com/v1",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    });

    assert.equal(response.statusCode, 200);
    const json = response.json() as { ok?: boolean; result?: { model?: string; baseUrl?: string; responsePreview?: string; elapsedMs?: number } };
    assert.equal(json.ok, true);
    assert.equal(json.result?.model, "test-model");
    assert.equal(json.result?.baseUrl, "https://llm.example.com/v1");
    assert.equal(json.result?.responsePreview, "ok");
    assert.equal(typeof json.result?.elapsedMs, "number");
    assert.equal(requests[0]?.url, "https://llm.example.com/v1/chat/completions");
    assert.equal(requests[0]?.body.model, "test-model");
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("health server tests ingest LLM through fact fusion and STM admission", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({
      url: typeof url === "string" ? url : url.toString(),
      body
    });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const user = messages[1] as { content?: unknown } | undefined;
    const promptText = typeof user?.content === "string" ? user.content : "{}";
    const prompt = JSON.parse(promptText) as {
      instruction?: string;
      evidence?: Array<{ segmentId?: string; validTimeStart?: string }>;
      facts?: Array<{ factId?: string }>;
    };
    if (prompt.instruction?.includes("事实融合器")) {
      const segmentId = prompt.evidence?.[0]?.segmentId ?? "seg_unknown";
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              facts: [{
                factType: "text",
                factText: "入库 LLM 测试代码词是 Alpha。",
                normalizedClaim: "ingest llm test code word is alpha",
                confidenceLevel: "high",
                linkedSegmentIds: [segmentId],
                entityIds: ["alpha"],
                validTimeStart: prompt.evidence?.[0]?.validTimeStart ?? "2026-07-06T00:00:00.000Z",
                timeBasis: "source_time",
                timeConfidence: "high"
              }]
            })
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            result: "write_high_priority",
            memoryDataType: "fact",
            importanceLevel: "high",
            confidenceLevel: "high",
            needUserConfirm: false,
            reason: "ingest llm test",
            matchedRules: ["explicit_remember"],
            sourceFactIds: prompt.facts?.[0]?.factId ? [prompt.facts[0].factId] : []
          })
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const server = createHealthServer();
  try {
    const response = await server.inject({
      method: "POST",
      url: "/context/config/llm/test",
      headers: { "content-type": "application/json" },
      payload: {
        mode: "ingest",
        llm: {
          baseUrl: "https://llm.example.com/v1",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    });

    assert.equal(response.statusCode, 200);
    const json = response.json() as { ok?: boolean; result?: { mode?: string; factCount?: number; admissionResult?: string } };
    assert.equal(json.ok, true);
    assert.equal(json.result?.mode, "ingest");
    assert.equal(json.result?.factCount, 1);
    assert.equal(json.result?.admissionResult, "write_high_priority");
    assert.equal(requests.length, 2);
    assert.equal(requests.every((item) => item.url === "https://llm.example.com/v1/chat/completions"), true);
    assert.equal(requests.every((item) => item.body.response_format && typeof item.body.response_format === "object"), true);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("health server tests LongMemEval answer LLM and returns token usage", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({
      url: typeof url === "string" ? url : url.toString(),
      body
    });
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Alpha"
        }
      }],
      usage: {
        prompt_tokens: 31,
        completion_tokens: 4,
        total_tokens: 35
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const server = createHealthServer();
  try {
    const response = await server.inject({
      method: "POST",
      url: "/context/config/llm/test",
      headers: { "content-type": "application/json" },
      payload: {
        mode: "answer",
        llm: {
          baseUrl: "https://llm.example.com/v1",
          model: "answer-model",
          apiKey: "test-key"
        }
      }
    });

    assert.equal(response.statusCode, 200);
    const json = response.json() as {
      ok?: boolean;
      result?: {
        mode?: string;
        responsePreview?: string;
        tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      };
    };
    assert.equal(json.ok, true);
    assert.equal(json.result?.mode, "answer");
    assert.equal(json.result?.responsePreview, "Alpha");
    assert.deepEqual(json.result?.tokenUsage, {
      promptTokens: 31,
      completionTokens: 4,
      totalTokens: 35
    });
    assert.equal(requests[0]?.url, "https://llm.example.com/v1/chat/completions");
    const messages = requests[0]?.body.messages as Array<{ content?: string }> | undefined;
    assert.equal(messages?.some((message) => message.content?.includes("LongMemEval question")), true);
    assert.equal("reasoning" in (requests[0]?.body ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});
