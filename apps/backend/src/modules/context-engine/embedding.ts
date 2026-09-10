import { getContextEngineConfig, type ContextEngineConfig } from "../../config.js";
import { postOpenAiCompatibleJson } from "./llm-request.js";

export interface EmbeddingVectorResult {
  input: string;
  embedding: number[];
  source: "remote" | "deterministic-test";
}

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
}

export interface EmbeddingClient {
  readonly dimensions: number;
  readonly fingerprint: string;
  embed(inputs: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingVectorResult[]>;
}

type EmbeddingConfig = ContextEngineConfig["embedding"];

const requestLimiters = new Map<string, AsyncLimiter>();

export function createEmbeddingClient(config: EmbeddingConfig = getContextEngineConfig().embedding): EmbeddingClient {
  if (config.protocol === "deterministic-test") {
    return createDeterministicTestEmbeddingClient(config.dimensions);
  }

  const endpoint = embeddingEndpoint(config);
  const fingerprint = embeddingFingerprint(config);
  const limiter = embeddingLimiter(fingerprint, config.concurrency);
  return {
    dimensions: config.dimensions,
    fingerprint,
    async embed(inputs, options = {}) {
      const normalizedInputs = normalizeEmbeddingInputs(inputs);
      const batches = chunk(normalizedInputs, config.batchSize);
      const results = await Promise.all(batches.map((batch) => limiter.run(() =>
        requestRemoteEmbeddingBatch(batch, endpoint, config, options)
      )));
      return results.flat();
    }
  };
}

export function createDeterministicTestEmbeddingClient(dimensions: number): EmbeddingClient {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error("Deterministic test embedding dimensions must be a positive integer");
  }
  return {
    dimensions,
    fingerprint: `deterministic-test:${dimensions}`,
    async embed(inputs) {
      return normalizeEmbeddingInputs(inputs).map((input) => ({
        input,
        embedding: createDeterministicTestVector(input, dimensions),
        source: "deterministic-test" as const
      }));
    }
  };
}

export async function embedTexts(
  inputs: string[],
  embeddingConfig: EmbeddingConfig = getContextEngineConfig().embedding,
  requestOptions: EmbeddingRequestOptions & { maxAttempts?: number; retryDelayMs?: number } = {}
) {
  const client = createEmbeddingClient({
    ...embeddingConfig,
    ...(requestOptions.maxAttempts !== undefined ? { maxAttempts: requestOptions.maxAttempts } : {}),
    ...(requestOptions.retryDelayMs !== undefined ? { retryDelayMs: requestOptions.retryDelayMs } : {})
  });
  return client.embed(inputs, requestOptions);
}

export async function probeEmbedding(
  client: EmbeddingClient = createEmbeddingClient(),
  signal?: AbortSignal
) {
  const [result] = await client.embed(["context engine embedding readiness probe"], signal ? { signal } : {});
  if (!result) throw new Error("Embedding readiness probe returned no vector");
  return {
    fingerprint: client.fingerprint,
    dimensions: result.embedding.length
  };
}

export function embeddingFingerprint(config: Pick<EmbeddingConfig, "protocol" | "model" | "dimensions">) {
  return `${config.protocol}:${config.model}:${config.dimensions}`;
}

async function requestRemoteEmbeddingBatch(
  inputs: string[],
  endpoint: string,
  config: EmbeddingConfig,
  options: EmbeddingRequestOptions
): Promise<EmbeddingVectorResult[]> {
  const input = inputs.length === 1 ? inputs[0]! : inputs;
  const body = {
    model: config.model,
    input,
    ...(config.protocol === "openai-compatible" && config.sendDimensions
      ? { dimensions: config.dimensions }
      : {})
  };
  const payload = await postOpenAiCompatibleJson({
    endpoint,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    operation: "embedding",
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    retryDelayMs: config.retryDelayMs,
    body,
    ...(options.signal ? { signal: options.signal } : {})
  });
  return validateEmbeddingResponse(payload, inputs, config.dimensions);
}

function validateEmbeddingResponse(payload: unknown, inputs: string[], dimensions: number): EmbeddingVectorResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Embedding response must contain a data array");
  }
  if (payload.data.length !== inputs.length) {
    throw new Error(`Embedding response count mismatch: expected ${inputs.length}, got ${payload.data.length}`);
  }

  const byIndex = new Map<number, unknown>();
  for (const [position, item] of payload.data.entries()) {
    if (!isRecord(item)) throw new Error(`Embedding response item ${position} must be an object`);
    const index = typeof item.index === "number" && Number.isInteger(item.index) ? item.index : position;
    if (index < 0 || index >= inputs.length || byIndex.has(index)) {
      throw new Error(`Embedding response contains invalid or duplicate index ${index}`);
    }
    byIndex.set(index, item.embedding);
  }

  return inputs.map((input, index) => {
    const rawVector = byIndex.get(index);
    if (!Array.isArray(rawVector)) throw new Error(`Embedding response item ${index} has no vector`);
    if (rawVector.length !== dimensions) {
      throw new Error(`Embedding dimension mismatch at index ${index}: expected ${dimensions}, got ${rawVector.length}`);
    }
    const embedding = rawVector.map((value, vectorIndex) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Embedding response item ${index} contains a non-finite value at ${vectorIndex}`);
      }
      return value;
    });
    return { input, embedding, source: "remote" as const };
  });
}

function embeddingEndpoint(config: EmbeddingConfig) {
  const baseUrl = config.baseUrl?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Remote embedding base URL is required");
  if (config.protocol === "adapter") {
    return baseUrl.endsWith("/api/embeddings") ? baseUrl : `${baseUrl}/api/embeddings`;
  }
  return baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
}

function normalizeEmbeddingInputs(inputs: string[]) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("Embedding input must not be empty");
  return inputs.map((input, index) => {
    if (typeof input !== "string" || !input.trim()) throw new Error(`Embedding input ${index} must be a non-empty string`);
    return input.trim();
  });
}

function createDeterministicTestVector(text: string, dimensions: number) {
  const vector = new Array(dimensions).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]/gu) ?? [];
  for (const token of tokens.length ? tokens : text.toLowerCase().split(/\s+/).filter(Boolean)) {
    vector[hashToken(token) % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function hashToken(token: string) {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface AsyncLimiter {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

function embeddingLimiter(key: string, concurrency: number) {
  const cacheKey = `${key}:${concurrency}`;
  const existing = requestLimiters.get(cacheKey);
  if (existing) return existing;
  const limiter = createAsyncLimiter(concurrency);
  requestLimiters.set(cacheKey, limiter);
  return limiter;
}

function createAsyncLimiter(concurrency: number): AsyncLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run<T>(operation: () => Promise<T>) {
      if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
      else active += 1;
      try {
        return await operation();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    }
  };
}
