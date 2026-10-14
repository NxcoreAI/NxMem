import { getContextEngineConfig, type ContextEngineConfig } from "../../config.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

// 远程 embedding API 同文本重复调用有 ~1e-3 浮点漂移（GPU 非确定），会顺着 vector 分
// 抖动检索排序。设 CONTEXT_ENGINE_EMBEDDING_CACHE_DIR 后同 (fingerprint, text) 永远复用
// 首次结果（进程内 + 磁盘），保证评测可复现。
// ponytail: 缓存按 key 前缀分 256 桶文件，写时只重写脏桶；曾经的单文件实现每次
// miss 都全量重写 512MB JSON，评测时把事件循环卡成 ~1 题/分钟。桶上限 256 个小文件，
// 单桶膨胀到影响写延迟时再换 sqlite。
const embeddingBuckets = new Map<string, Map<string, number[]>>();
const embeddingDirtyBuckets = new Set<string>();
let embeddingLegacyLoaded = false;

function embeddingCacheDir() {
  return process.env.CONTEXT_ENGINE_EMBEDDING_CACHE_DIR;
}

function bucketOf(key: string) {
  return key.slice(0, 2);
}

function bucketFile(dir: string, bucket: string) {
  return join(dir, `embedding-cache-${bucket}.json`);
}

function readEntries(file: string): Array<[string, number[]]> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>;
    return Object.entries(parsed).filter(([, v]) => Array.isArray(v));
  } catch {
    return [];
  }
}

function loadLegacyCacheOnce() {
  if (embeddingLegacyLoaded) return;
  embeddingLegacyLoaded = true;
  const dir = embeddingCacheDir();
  if (!dir) return;
  const legacy = join(dir, "embedding-cache.json");
  if (!existsSync(legacy)) return;
  for (const [key, value] of readEntries(legacy)) {
    const bucket = bucketOf(key);
    let map = embeddingBuckets.get(bucket);
    if (!map) embeddingBuckets.set(bucket, (map = new Map()));
    if (!map.has(key)) map.set(key, value);
  }
  try {
    renameSync(legacy, `${legacy}.migrated`);
  } catch {
    // ponytail: 迁移 rename 失败不致命，只是下次重启再迁一次
  }
  for (const bucket of embeddingBuckets.keys()) embeddingDirtyBuckets.add(bucket);
}

function bucketMap(bucket: string): Map<string, number[]> {
  loadLegacyCacheOnce();
  let map = embeddingBuckets.get(bucket);
  if (map) return map;
  map = new Map();
  embeddingBuckets.set(bucket, map);
  const dir = embeddingCacheDir();
  if (dir) {
    for (const [key, value] of readEntries(bucketFile(dir, bucket))) map.set(key, value);
  }
  return map;
}

function saveDirtyEmbeddingBuckets() {
  const dir = embeddingCacheDir();
  if (!dir || !embeddingDirtyBuckets.size) return;
  try {
    mkdirSync(dir, { recursive: true });
    for (const bucket of embeddingDirtyBuckets) {
      const map = embeddingBuckets.get(bucket);
      if (!map?.size) continue;
      writeFileSync(bucketFile(dir, bucket), JSON.stringify(Object.fromEntries(map)));
    }
    embeddingDirtyBuckets.clear();
  } catch {
    // ponytail: 缓存写失败不阻断检索
  }
}

// 供 cross-encoder-reranker 等其他非确定远程调用共用同一份磁盘缓存。
export function readRemoteScoreCache(key: string): number[] | undefined {
  return bucketMap(bucketOf(key)).get(key);
}

export function writeRemoteScoreCache(entries: Array<[string, number[]]>) {
  if (!entries.length || !embeddingCacheDir()) return;
  for (const [key, value] of entries) {
    bucketMap(bucketOf(key)).set(key, value);
    embeddingDirtyBuckets.add(bucketOf(key));
  }
  saveDirtyEmbeddingBuckets();
}

function embeddingCacheKey(fingerprint: string, input: string) {
  return createHash("sha256").update(`${fingerprint}\n${input}`).digest("hex");
}

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
      const keyOf = (input: string) => embeddingCacheKey(fingerprint, input);
      const misses = [...new Set(normalizedInputs.filter((input) => !bucketMap(bucketOf(keyOf(input))).has(keyOf(input))))];
      if (misses.length) {
        const batches = chunk(misses, config.batchSize);
        const fetched = (await Promise.all(batches.map((batch) => limiter.run(() =>
          requestRemoteEmbeddingBatch(batch, endpoint, config, options)
        )))).flat();
        for (const result of fetched) {
          const key = keyOf(result.input);
          bucketMap(bucketOf(key)).set(key, result.embedding);
          embeddingDirtyBuckets.add(bucketOf(key));
        }
        saveDirtyEmbeddingBuckets();
      }
      return normalizedInputs.map((input) => {
        const embedding = bucketMap(bucketOf(keyOf(input))).get(keyOf(input));
        if (!embedding) throw new Error(`Embedding returned no vector for: ${input.slice(0, 80)}`);
        return { input, embedding, source: "remote" as const };
      });
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
