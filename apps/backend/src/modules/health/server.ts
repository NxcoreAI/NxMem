import fastify from "fastify";
import {
  createPublicContextEngineConfig,
  saveContextEngineRuntimeConfig,
  getContextEngineConfig
} from "../../config.js";
import { createInMemoryContextEngineRepository } from "../context-engine/service-bootstrap.js";
import { registerContextEngineRoutes } from "../context-engine/routes.js";
import { createContextEngineService } from "../context-engine/write-event.js";
import type { ContextEngineRepository } from "../context-engine/persistence/repository.js";
import { sanitizeDebugSnapshot } from "../context-engine/debug-snapshot.js";
import { postOpenAiCompatibleJson, type OpenAiCompatibleRequestLogger } from "../context-engine/llm-request.js";
import { createFactsWithLlmFusion } from "../context-engine/llm-fact-fusion.js";
import { evaluateShortTermAdmissionWithLlm } from "../context-engine/llm-stm-admission.js";
import type { FactItem, MemoryEvent, ParsedSegment } from "../context-engine/domain.js";
import { multimodalContentToText, sourceRefsFromEvent } from "../context-engine/memory-event-fields.js";
import { createConversationIngestionWorker } from "../context-engine/conversation-ingestion/index.js";
import { DreamingRuntime } from "../context-engine/dreaming-runtime.js";
import { getTimelineFusionScheduler } from "../context-engine/timeline-fusion-scheduler.js";

export interface HealthServerOptions {
  dreamingRuntime?: DreamingRuntime;
}

export function createHealthServer(
  repository: ContextEngineRepository = createInMemoryContextEngineRepository(),
  options: HealthServerOptions = {}
) {
  const app = fastify({ logger: true });
  const dreamingRuntime = options.dreamingRuntime ?? new DreamingRuntime(repository);
  const timelineFusionScheduler = getTimelineFusionScheduler(repository, {
    onError: (error) => {
      app.log.error({ err: error }, "timeline fusion scheduler failed");
    }
  });
  const service = createContextEngineService(repository, {
    ...(dreamingRuntime.enabled ? { activityGate: dreamingRuntime.activityGate } : {})
  });
  const conversationWorker = createConversationIngestionWorker(repository, {
    ...(dreamingRuntime.enabled ? { activityGate: dreamingRuntime.activityGate } : {}),
    onError: (error) => {
      app.log.error({ err: error }, "conversation ingestion worker poll failed");
    }
  });
  conversationWorker.start();
  app.addHook("onReady", async () => {
    await timelineFusionScheduler.start();
    await dreamingRuntime.start();
  });
  app.addHook("onClose", async () => {
    conversationWorker.stop();
    timelineFusionScheduler.stop();
    await dreamingRuntime.stop();
  });

  app.get("/health", async () => {
    return { ok: true };
  });

  app.get("/context", async (request) => {
    return {
      ok: true,
      message: "Context API scaffold",
      path: request.url
    };
  });

  app.get("/context/config", async () => {
    return {
      ok: true,
      config: createPublicContextEngineConfig()
    };
  });

  app.put("/context/config", async (request, reply) => {
    const body = (request.body ?? {}) as {
      llm?: {
        baseUrl?: unknown;
        model?: unknown;
        apiKey?: unknown;
      };
      judgeLlm?: {
        baseUrl?: unknown;
        model?: unknown;
        apiKey?: unknown;
      };
    };

    try {
      const current = getContextEngineConfig();
      const llm = {
        baseUrl: typeof body.llm?.baseUrl === "string" ? body.llm.baseUrl : current.llm.baseUrl,
        model: typeof body.llm?.model === "string" ? body.llm.model : current.llm.model,
        ...(typeof body.llm?.apiKey === "string"
          ? { apiKey: body.llm.apiKey }
          : current.llm.apiKeySource === "runtime" && current.llm.apiKey
            ? { apiKey: current.llm.apiKey }
            : {})
      };
      const judgeLlm = {
        baseUrl: typeof body.judgeLlm?.baseUrl === "string" ? body.judgeLlm.baseUrl : current.judgeLlm.baseUrl,
        model: typeof body.judgeLlm?.model === "string" ? body.judgeLlm.model : current.judgeLlm.model,
        ...(typeof body.judgeLlm?.apiKey === "string"
          ? { apiKey: body.judgeLlm.apiKey }
          : current.judgeLlm.apiKeySource === "runtime" && current.judgeLlm.apiKey
            ? { apiKey: current.judgeLlm.apiKey }
            : {})
      };
      const next = saveContextEngineRuntimeConfig({
        llm,
        judgeLlm
      });

      return {
        ok: true,
        config: createPublicContextEngineConfig(next)
      };
    } catch (error) {
      reply.code(400);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "config update failed"
      };
    }
  });

  app.post("/context/config/llm/test", async (request, reply) => {
    const body = (request.body ?? {}) as {
      llm?: {
        baseUrl?: unknown;
        model?: unknown;
        apiKey?: unknown;
      };
      mode?: unknown;
    };

    const current = getContextEngineConfig();
    const baseUrl = typeof body.llm?.baseUrl === "string" && body.llm.baseUrl.trim()
      ? body.llm.baseUrl.trim()
      : current.llm.baseUrl;
    const model = typeof body.llm?.model === "string" && body.llm.model.trim()
      ? body.llm.model.trim()
      : current.llm.model;
    const apiKey = typeof body.llm?.apiKey === "string" && body.llm.apiKey.trim()
      ? body.llm.apiKey.trim()
      : current.llm.apiKey;

    if (!apiKey) {
      reply.code(400);
      return { ok: false, error: "LLM API key is required" };
    }

    const startedAt = Date.now();
    try {
      const mode = body.mode === "ingest" ? "ingest" : body.mode === "answer" ? "answer" : "chat";
      const testResult: LlmConfigTestResult = mode === "ingest"
        ? await testIngestLlm(repository, { baseUrl, model, apiKey })
        : await testChatCompletionLlm({ baseUrl, model, apiKey, mode, logger: request.log });
      return {
        ok: true,
        result: {
          mode,
          baseUrl,
          model,
          elapsedMs: Date.now() - startedAt,
          responsePreview: testResult.responsePreview.slice(0, 120),
          ...(testResult.factCount !== undefined ? { factCount: testResult.factCount } : {}),
          ...(testResult.admissionResult ? { admissionResult: testResult.admissionResult } : {}),
          ...(testResult.tokenUsage ? { tokenUsage: testResult.tokenUsage } : {})
        }
      };
    } catch (error) {
      reply.code(502);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "LLM test failed",
        result: {
          baseUrl,
          model,
          elapsedMs: Date.now() - startedAt
        }
      };
    }
  });

  app.get("/context/events", async () => {
    return {
      ok: true,
      items: sanitizeDebugSnapshot(repository.getDebugSnapshot())
    };
  });

  registerContextEngineRoutes(app, service, repository, dreamingRuntime);

  return app;
}

interface LlmConfigTestResult {
  responsePreview: string;
  factCount?: number;
  admissionResult?: string;
  tokenUsage?: LlmConfigTokenUsage;
}

interface LlmConfigTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

async function testChatCompletionLlm(input: {
  baseUrl: string;
  model: string;
  apiKey: string;
  mode?: "chat" | "answer";
  logger?: OpenAiCompatibleRequestLogger;
}): Promise<LlmConfigTestResult> {
  const messages = input.mode === "answer"
    ? createLongMemEvalAnswerTestMessages()
    : [
        { role: "system", content: "Reply with exactly: ok" },
        { role: "user", content: "Connection test. Reply with exactly: ok" }
      ];
  if (input.mode === "answer") return await testLongMemEvalAnswerLlm(input, messages);
  const payload = await postOpenAiCompatibleJson({
    endpoint: `${normalizeBaseUrl(input.baseUrl)}/chat/completions`,
    apiKey: input.apiKey,
    operation: "llm_config_test",
    body: {
      model: input.model,
      messages,
      temperature: 0
    },
    ...(input.logger ? { logger: input.logger } : {}),
    logContext: { model: input.model, baseUrl: input.baseUrl }
  });

  const tokenUsage = extractOpenAiCompatibleTokenUsage(payload);
  return {
    responsePreview: extractOpenAiCompatibleText(payload) || "ok",
    ...(tokenUsage ? { tokenUsage } : {})
  };
}

async function testLongMemEvalAnswerLlm(
  input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    logger?: OpenAiCompatibleRequestLogger;
  },
  messages: Array<{ role: string; content: string }>
): Promise<LlmConfigTestResult> {
  const chatPayload = await postOpenAiCompatibleJson({
    endpoint: `${normalizeBaseUrl(input.baseUrl)}/chat/completions`,
    apiKey: input.apiKey,
    operation: "longmemeval_answer_config_test",
    body: {
      model: input.model,
      messages,
      temperature: 0
    },
    ...(input.logger ? { logger: input.logger } : {}),
    logContext: { model: input.model, baseUrl: input.baseUrl, mode: "answer" }
  });
  const tokenUsage = extractOpenAiCompatibleTokenUsage(chatPayload);
  return {
    responsePreview: extractOpenAiCompatibleText(chatPayload) || "ok",
    ...(tokenUsage ? { tokenUsage } : {})
  };
}

function createLongMemEvalAnswerTestMessages() {
  const prompt = [
    "You are answering a LongMemEval question.",
    "",
    "Question: What degree did I graduate with?",
    "",
    "Use the provided context to answer concisely.",
    "",
    "Chronological Evidence:",
    "",
    "[2021/06/12] user: I graduated from Northeastern with a degree in Business Administration.",
    "[2021/08/03] assistant: Congratulations on completing your Business Administration program.",
    "[2022/01/15] user: I am updating my resume and want the education section to mention Business Administration.",
    "",
    "Context:",
    "The answer appears in the user's prior education discussion. Return only the degree name."
  ].join("\n");
  return [
    { role: "system", content: "Answer the question directly." },
    { role: "user", content: prompt }
  ];
}

async function testIngestLlm(
  repository: ContextEngineRepository,
  llm: { baseUrl: string; model: string; apiKey: string }
): Promise<LlmConfigTestResult> {
  const event = createLlmTestEvent();
  const segments = createLlmTestSegments(event);
  const fusion = await createFactsWithLlmFusion(repository, event, segments, llm);
  const facts = fusion.facts.length ? fusion.facts : [createFallbackLlmTestFact(event)];
  const admission = await evaluateShortTermAdmissionWithLlm(repository, event, facts, llm);

  return {
    responsePreview: `${fusion.facts.length} facts, admission ${admission.result}`,
    factCount: fusion.facts.length,
    admissionResult: admission.result
  };
}

function createLlmTestEvent(): MemoryEvent {
  const now = new Date().toISOString();
  return {
    eventId: `llm_test_${Date.now()}`,
    eventType: "llm_ingest_test",
    eventSummary: "LLM ingest connectivity test",
    eventTime: now,
    sourceApp: "context-debug-frontend",
    sourceId: "llm-ingest-test",
    permissionSnapshot: {
      snapshotId: `ps_llm_test_${Date.now()}`,
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "debug-v1",
      visibility: "private"
    },
    multimodalData: [
      {
        itemId: "item1",
        type: "text",
        format: "json",
        content: {
          text: "请记住：Context 引擎入库 LLM 连通性测试的代码词是 Alpha。"
        },
        sourceRefs: [{ sourceRefId: "src_llm_ingest_test", sourceType: "agent_memory", sourceId: "llm-ingest-test" }],
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ]
  };
}

function createLlmTestSegments(event: MemoryEvent): ParsedSegment[] {
  return [{
    segmentId: `seg_${event.eventId}_item1`,
    eventId: event.eventId,
    modality: "text",
    content: multimodalContentToText(event.multimodalData[0]?.content),
    status: "parsed",
    confidence: "high"
  }];
}

function createFallbackLlmTestFact(event: MemoryEvent): FactItem {
  return {
    factId: `fact_${event.eventId}`,
    factType: "text",
    factText: "Context 引擎入库 LLM 连通性测试的代码词是 Alpha。",
    normalizedClaim: "context engine ingest llm test code word is alpha",
    linkedEventIds: [event.eventId],
    linkedSegmentIds: [`seg_${event.eventId}_item1`],
    linkedSourceRefs: sourceRefsFromEvent(event),
    entityIds: ["context-engine", "alpha"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: event.eventTime,
    validTimeStart: event.eventTime,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  };
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function extractOpenAiCompatibleText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const responsesPayload = payload as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
  const outputTexts = responsesPayload.output
    ?.filter((item) => item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean) ?? [];
  if (outputTexts.length) return outputTexts.join("");

  const chatPayload = payload as { choices?: Array<{ message?: { content?: string } }> };
  return chatPayload.choices?.[0]?.message?.content?.trim() ?? "";
}

function extractOpenAiCompatibleTokenUsage(payload: unknown): LlmConfigTokenUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const usageRecord = usage as Record<string, unknown>;
  const promptTokens = readNumber(usageRecord.prompt_tokens) ?? readNumber(usageRecord.input_tokens);
  const completionTokens = readNumber(usageRecord.completion_tokens) ?? readNumber(usageRecord.output_tokens);
  const totalTokens = readNumber(usageRecord.total_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
