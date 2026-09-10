import { getContextEngineConfig } from "../../config.js";
import {
  postOpenAiCompatibleJson,
  type OpenAiCompatibleRequestObserver
} from "./llm-request.js";
import {
  buildTimelineFusionRelationFallback,
  buildTimelineFusionRelationPrompt,
  parseTimelineFusionRelationResponseCompatible,
  timelineFusionRelationsJsonSchema,
  TimelineFusionRelationProtocolError,
  type TimelineFusionRelationInput,
  type TimelineFusionRelationResult
} from "./timeline-fusion-relations.js";

export type TimelineFusionRelationFallbackReason =
  | "missing_api_key"
  | "llm_request_failed"
  | "invalid_response"
  | "protected_details_lost";

export interface TimelineFusionRelationJudgmentOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  transport?: "fetch" | "openai-sdk-stream";
  observer?: OpenAiCompatibleRequestObserver;
  signal?: AbortSignal;
}

export interface TimelineFusionRelationJudgmentResult {
  status: "succeeded" | "fallback";
  responseFormat: "relations" | "legacy_groups" | "fallback";
  result: TimelineFusionRelationResult;
  fallbackReason?: TimelineFusionRelationFallbackReason;
  error?: string;
}

export async function judgeTimelineFusionRelationsWithLlm(
  input: TimelineFusionRelationInput,
  options: TimelineFusionRelationJudgmentOptions = {}
): Promise<TimelineFusionRelationJudgmentResult> {
  const prompt = buildTimelineFusionRelationPrompt(input);
  const fallback = buildTimelineFusionRelationFallback(input);
  const config = getContextEngineConfig();
  const apiKey = options.apiKey !== undefined ? options.apiKey.trim() : config.llm.apiKey;
  if (!apiKey) return fallbackResult(fallback, "missing_api_key");

  let response: unknown;
  try {
    response = await postOpenAiCompatibleJson({
      endpoint: `${normalizeBaseUrl(options.baseUrl ?? config.llm.baseUrl)}/chat/completions`,
      apiKey,
      operation: "timeline_fusion_relation_judgment",
      transport: options.transport ?? "openai-sdk-stream",
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      body: {
        model: options.model?.trim() || config.llm.model,
        messages: [
          {
            role: "system",
            content: "你是 Context 引擎的时间轴事实关系判断器。只返回严格 JSON，不输出 Markdown、解释或推理过程。"
          },
          { role: "user", content: prompt }
        ],
        response_format: {
          type: "json_schema",
          json_schema: timelineFusionRelationsJsonSchema
        },
        temperature: 0
      }
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return fallbackResult(fallback, "llm_request_failed", errorMessage(error));
  }

  try {
    const parsed = parseTimelineFusionRelationResponseCompatible(response, input);
    return {
      status: "succeeded",
      responseFormat: parsed.responseFormat,
      result: parsed.result
    };
  } catch (error) {
    if (
      error instanceof TimelineFusionRelationProtocolError &&
      error.code === "TIMELINE_FUSION_RELATION_DETAILS_LOST"
    ) {
      return fallbackResult(fallback, "protected_details_lost", error.message);
    }
    return fallbackResult(fallback, "invalid_response", errorMessage(error));
  }
}

function fallbackResult(
  result: TimelineFusionRelationResult,
  fallbackReason: TimelineFusionRelationFallbackReason,
  error?: string
): TimelineFusionRelationJudgmentResult {
  return {
    status: "fallback",
    responseFormat: "fallback",
    result,
    fallbackReason,
    ...(error ? { error } : {})
  };
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
