import { getContextEngineConfig } from "../../config.js";
import { createHash } from "node:crypto";
import { readRemoteScoreCache, writeRemoteScoreCache } from "./embedding.js";
import { postOpenAiCompatibleJson } from "./llm-request.js";

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
  originalRank: number;
}

export interface CrossEncoderReranker {
  readonly model: string;
  rerank(query: string, documents: RerankDocument[]): Promise<RerankResult[]>;
}

export function createCrossEncoderReranker(): CrossEncoderReranker | undefined {
  if (process.env.RERANKER_ENABLED === "false") return undefined;
  const config = getContextEngineConfig();
  const baseUrl = (process.env.RERANKER_BASE_URL ?? config.embedding.baseUrl)?.replace(/\/$/u, "");
  const apiKey = process.env.RERANKER_API_KEY ?? config.embedding.apiKey;
  if (!baseUrl || !apiKey) return undefined;
  const model = process.env.RERANKER_MODEL ?? "BAAI/bge-reranker-v2-m3";
  return createHttpCrossEncoderReranker({
    endpoint: `${baseUrl}/rerank`,
    apiKey,
    model,
    timeoutMs: Number(process.env.RERANKER_TIMEOUT_MS ?? 60_000)
  });
}

export function createHttpCrossEncoderReranker(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): CrossEncoderReranker {
  return {
    model: input.model,
    async rerank(query, documents) {
      if (!documents.length) return [];
      // rerank API 与 embedding 同样存在 GPU 浮点漂移，命中缓存保证评测可复现。
      const cacheKey = createHash("sha256")
        .update(`${input.model}\n${query}\n${documents.map((document) => document.text).join("\u0000")}`)
        .digest("hex");
      const cached = readRemoteScoreCache(cacheKey);
      if (cached) {
        return documents.map((document, index) => ({ id: document.id, score: cached[index] ?? 0, originalRank: index + 1 }));
      }
      const response = await postOpenAiCompatibleJson({
        endpoint: input.endpoint,
        apiKey: input.apiKey,
        operation: "cross_encoder_rerank",
        timeoutMs: input.timeoutMs ?? 60_000,
        maxAttempts: 3,
        retryDelayMs: 1_000,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        body: {
          model: input.model,
          query,
          documents: documents.map((document) => document.text),
          top_n: documents.length,
          return_documents: false
        }
      });
      const parsed = parseRerankResponse(response, documents);
      const scoresByRank = new Array<number>(documents.length).fill(0);
      for (const result of parsed) scoresByRank[result.originalRank - 1] = result.score;
      writeRemoteScoreCache([[cacheKey, scoresByRank]]);
      return parsed;
    }
  };
}

export function parseRerankResponse(value: unknown, documents: RerankDocument[]): RerankResult[] {
  if (!value || typeof value !== "object" || !("results" in value) || !Array.isArray(value.results)) {
    throw new Error("reranker response must contain a results array");
  }
  const seen = new Set<number>();
  const results = value.results.map((item) => {
    if (!item || typeof item !== "object") throw new Error("reranker result must be an object");
    const index = Number("index" in item ? item.index : Number.NaN);
    const score = Number("relevance_score" in item ? item.relevance_score : Number.NaN);
    if (!Number.isInteger(index) || index < 0 || index >= documents.length || !Number.isFinite(score) || seen.has(index)) {
      throw new Error("reranker result contains an invalid index or score");
    }
    seen.add(index);
    return { id: documents[index]!.id, score, originalRank: index + 1 };
  });
  if (results.length !== documents.length) throw new Error("reranker response omitted documents");
  return results.sort((left, right) => right.score - left.score || left.originalRank - right.originalRank);
}
