import { getContextEngineConfig } from "../../config.js";
import type { FactItem, LlmStmAdmissionTrace, MemoryEvent, ShortTermMemory } from "./domain.js";
import { evaluateShortTermAdmission, type AdmissionDecision } from "./admission-policy.js";
import { isLlmRequestRetryExhausted, postOpenAiCompatibleJson, postOpenAiCompatibleResponse, type OpenAiCompatibleRequestObserver } from "./llm-request.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { memoryEventSummary } from "./memory-event-fields.js";

export interface LlmStmAdmissionOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fallbackMode?: "allow" | "throw";
  transport?: "fetch" | "openai-sdk-stream";
  batchSize?: number;
  batchConcurrency?: number;
  observer?: OpenAiCompatibleRequestObserver;
  signal?: AbortSignal;
}

interface LlmStmAdmissionPayload {
  decisions?: unknown;
  result?: unknown;
  memoryDataType?: unknown;
  importanceLevel?: unknown;
  confidenceLevel?: unknown;
  ttl?: unknown;
  needUserConfirm?: unknown;
  reason?: unknown;
  matchedRules?: unknown;
  sourceFactIds?: unknown;
}

const promptVersion = "stm-admission.openai-compatible.v1";
const schemaVersion = "stm-admission-decision.v1";
const DEFAULT_STM_ADMISSION_BATCH_SIZE = 20;
const DEFAULT_STM_ADMISSION_BATCH_CONCURRENCY = 20;

export interface FactAdmissionDecision {
  factId: string;
  decision: AdmissionDecision;
}

export async function evaluateShortTermAdmissionsWithLlm(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  facts: FactItem[],
  options: LlmStmAdmissionOptions = {}
): Promise<FactAdmissionDecision[]> {
  if (!facts.length) return [];

  const baselines = new Map(facts.map((fact) => [
    fact.factId,
    evaluateShortTermAdmission(event, [fact])
  ]));
  const aggregateBaseline = evaluateShortTermAdmission(event, facts);
  const config = getContextEngineConfig();
  const endpointBase = normalizeBaseUrl(options.baseUrl ?? config.llm.baseUrl);
  const endpoint = `${endpointBase}/chat/completions`;
  const model = options.model?.trim() || config.llm.model;
  const hasRequestApiKey = options.apiKey !== undefined;
  const requestApiKey = hasRequestApiKey ? options.apiKey?.trim() ?? "" : undefined;
  const apiKey = hasRequestApiKey ? requestApiKey : config.llm.apiKey;
  const keySource: LlmStmAdmissionTrace["keySource"] = requestApiKey
    ? "request"
    : apiKey
      ? "env"
      : "missing";
  const factInputs = buildFactInputs(facts);
  const prompt = buildSessionStmAdmissionPrompt(event, factInputs, baselines);

  let rawResponse: unknown;
  let parsedDecision: LlmStmAdmissionTrace["parsedDecision"];
  let fallbackReason: string | undefined;
  let overrideReason: string | undefined;
  let decisions = facts.map((fact) => ({ factId: fact.factId, decision: baselines.get(fact.factId)! }));

  if (!apiKey) {
    fallbackReason = "missing_api_key";
  } else {
    try {
      rawResponse = await callOpenAiCompatibleChatCompletion({
        endpoint,
        apiKey,
        model,
        prompt,
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.observer ? { observer: options.observer } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        logContext: { batchIndex: 1, batchCount: 1 }
      });
      const converted = convertSessionAdmissionDecisions(
        parseStmAdmissionResponse(rawResponse),
        facts,
        baselines
      );
      const mergedDecision = mergeBatchAdmissionDecisions(
        converted.map((item) => item.parsedDecision),
        aggregateBaseline,
        facts
      );
      parsedDecision = {
        ...mergedDecision,
        factDecisions: converted.map((item) => item.parsedDecision)
      };
      decisions = converted.map(({ factId, parsedDecision: payload }) => ({
        factId,
        decision: admissionDecisionFromPayload(payload, baselines.get(factId)!)
      }));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (isLlmRequestRetryExhausted(error)) throw error;
      rawResponse = rawResponse ?? serializeError(error);
      fallbackReason = error instanceof Error ? `llm_error:${error.message}` : "llm_error:unknown";
    }
  }

  decisions = decisions.map(({ factId, decision }) => {
    const baseline = baselines.get(factId)!;
    const overridden = applyHardRuleOverrides(decision, baseline);
    if (overridden !== decision) overrideReason = baseline.signals.sensitivity === "high"
      ? "hard_rule_sensitive_override"
      : "hard_rule_quantitative_override";
    return { factId, decision: overridden };
  });

  const trace: LlmStmAdmissionTrace = {
    traceId: `llm_stm_admission_${event.eventId}`,
    eventId: event.eventId,
    provider: "openai-compatible",
    endpoint,
    model,
    keySource,
    promptVersion: "stm-admission.openai-compatible.v2-session",
    schemaVersion,
    prompt,
    factInputs,
    ...(rawResponse === undefined ? {} : { rawResponse }),
    ...(parsedDecision ? { parsedDecision } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(overrideReason ? { overrideReason } : {}),
    createdAt: new Date().toISOString()
  };
  await repository.saveLlmStmAdmissionTrace(trace);

  if (fallbackReason && options.fallbackMode === "throw") {
    throw new Error(`stm_admission_fallback:${fallbackReason}`);
  }

  return decisions;
}

export async function evaluateShortTermAdmissionWithLlm(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  facts: FactItem[],
  options: LlmStmAdmissionOptions = {}
): Promise<AdmissionDecision> {
  const baseline = evaluateShortTermAdmission(event, facts);
  const config = getContextEngineConfig();
  const endpointBase = normalizeBaseUrl(options.baseUrl ?? config.llm.baseUrl);
  const endpoint = `${endpointBase}/chat/completions`;
  const model = options.model?.trim() || config.llm.model;
  const hasRequestApiKey = options.apiKey !== undefined;
  const requestApiKey = hasRequestApiKey ? options.apiKey?.trim() ?? "" : undefined;
  const apiKey = hasRequestApiKey ? requestApiKey : config.llm.apiKey;
  const keySource: LlmStmAdmissionTrace["keySource"] = requestApiKey
    ? "request"
    : apiKey
      ? "env"
      : "missing";
  const factInputs = buildFactInputs(facts);
  const prompt = buildStmAdmissionPrompt(event, factInputs, baseline);

  let rawResponse: unknown;
  let parsedDecision: LlmStmAdmissionTrace["parsedDecision"];
  let fallbackReason: string | undefined;
  let overrideReason: string | undefined;
  let decision = baseline;

  if (!apiKey) {
    fallbackReason = "missing_api_key";
  } else {
    try {
      const factBatches = chunkArray(facts, readPositiveInteger(options.batchSize, DEFAULT_STM_ADMISSION_BATCH_SIZE));
      const batchConcurrency = readPositiveInteger(options.batchConcurrency, DEFAULT_STM_ADMISSION_BATCH_CONCURRENCY);
      const batchResponses = await mapConcurrent(factBatches, batchConcurrency, async (batch, index) => {
        const batchFactInputs = buildFactInputs(batch);
        const batchBaseline = evaluateShortTermAdmission(event, batch);
        const batchPrompt = buildStmAdmissionPrompt(event, batchFactInputs, batchBaseline);
        const batchRawResponse = await callOpenAiCompatibleChatCompletion({
          endpoint,
          apiKey,
          model,
          prompt: batchPrompt,
          ...(options.transport ? { transport: options.transport } : {}),
          ...(options.observer ? { observer: options.observer } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          logContext: {
            batchIndex: index + 1,
            batchCount: factBatches.length
          }
        });
        const batchParsedDecision = convertLlmAdmissionDecision(parseStmAdmissionResponse(batchRawResponse), batchBaseline, batch);
        return { batchRawResponse, batchParsedDecision };
      });
      rawResponse = batchResponses.length === 1
        ? batchResponses[0]!.batchRawResponse
        : batchResponses.map(({ batchRawResponse }) => batchRawResponse);
      parsedDecision = batchResponses.length === 1
        ? batchResponses[0]!.batchParsedDecision
        : mergeBatchAdmissionDecisions(
          batchResponses.map(({ batchParsedDecision }) => batchParsedDecision),
          baseline,
          facts
        );
      decision = admissionDecisionFromPayload(parsedDecision, baseline);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (isLlmRequestRetryExhausted(error)) throw error;
      rawResponse = serializeError(error);
      fallbackReason = error instanceof Error ? `llm_error:${error.message}` : "llm_error:unknown";
      decision = baseline;
    }
  }

  const overridden = applyHardRuleOverrides(decision, baseline);
  if (overridden !== decision) {
    overrideReason = baseline.signals.sensitivity === "high"
      ? "hard_rule_sensitive_override"
      : "hard_rule_quantitative_override";
    decision = overridden;
  }

  const trace: LlmStmAdmissionTrace = {
    traceId: `llm_stm_admission_${event.eventId}`,
    eventId: event.eventId,
    provider: "openai-compatible",
    endpoint,
    model,
    keySource,
    promptVersion,
    schemaVersion,
    prompt,
    factInputs,
    ...(rawResponse === undefined ? {} : { rawResponse }),
    ...(parsedDecision ? { parsedDecision } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(overrideReason ? { overrideReason } : {}),
    createdAt: new Date().toISOString()
  };
  await repository.saveLlmStmAdmissionTrace(trace);

  if (fallbackReason && options.fallbackMode === "throw") {
    throw new Error(`stm_admission_fallback:${fallbackReason}`);
  }

  return decision;
}

function mergeBatchAdmissionDecisions(
  decisions: Array<NonNullable<LlmStmAdmissionTrace["parsedDecision"]>>,
  baseline: AdmissionDecision,
  facts: FactItem[]
): NonNullable<LlmStmAdmissionTrace["parsedDecision"]> {
  if (!decisions.length) {
    return {
      result: baseline.result,
      ...(baseline.memoryDataType ? { memoryDataType: baseline.memoryDataType } : {}),
      importanceLevel: baseline.importanceLevel,
      confidenceLevel: baseline.confidenceLevel,
      ...(baseline.ttl ? { ttl: baseline.ttl } : {}),
      ...(typeof baseline.needUserConfirm === "boolean" ? { needUserConfirm: baseline.needUserConfirm } : {}),
      reason: baseline.reason,
      matchedRules: baseline.matchedRules,
      sourceFactIds: facts.map((fact) => fact.factId)
    };
  }

  const selected = selectMergedAdmissionDecision(decisions);
  const sourceFactIds = unique([
    ...decisions.flatMap((decision) => decision.sourceFactIds),
    ...facts.map((fact) => fact.factId)
  ]);
  const matchedRules = unique([
    ...decisions.flatMap((decision) => decision.matchedRules),
    "llm_stm_admission_batched"
  ]);
  const reason = decisions.map((decision) => decision.reason).filter(Boolean).join(" | ");

  return {
    result: selected.result,
    ...(selected.memoryDataType ? { memoryDataType: selected.memoryDataType } : {}),
    importanceLevel: highestImportance(decisions.map((decision) => decision.importanceLevel ?? baseline.importanceLevel)),
    confidenceLevel: lowestConfidence(decisions.map((decision) => decision.confidenceLevel ?? baseline.confidenceLevel)),
    ...(selected.ttl ? { ttl: selected.ttl } : {}),
    ...(decisions.some((decision) => decision.needUserConfirm) ? { needUserConfirm: true } : {}),
    reason: reason || selected.reason || baseline.reason,
    matchedRules,
    sourceFactIds
  };
}

function selectMergedAdmissionDecision(decisions: Array<NonNullable<LlmStmAdmissionTrace["parsedDecision"]>>) {
  return [...decisions].sort((left, right) => admissionResultRank(right.result) - admissionResultRank(left.result))[0]!;
}

function admissionResultRank(result: ShortTermMemory["admissionResult"]) {
  switch (result) {
    case "pending_confirm":
      return 5;
    case "write_high_priority":
      return 4;
    case "write_candidate":
      return 3;
    case "write_short_term":
      return 2;
    case "reject":
      return 1;
  }
}

function highestImportance(values: ShortTermMemory["importanceLevel"][]) {
  const ranks: Record<ShortTermMemory["importanceLevel"], number> = { low: 1, medium: 2, high: 3, critical: 4 };
  return [...values].sort((left, right) => ranks[right] - ranks[left])[0] ?? "low";
}

function lowestConfidence(values: ShortTermMemory["confidenceLevel"][]) {
  const ranks: Record<ShortTermMemory["confidenceLevel"], number> = { low: 1, medium: 2, high: 3 };
  return [...values].sort((left, right) => ranks[left] - ranks[right])[0] ?? "low";
}

function buildFactInputs(facts: FactItem[]): LlmStmAdmissionTrace["factInputs"] {
  return facts.map((fact) => ({
    factId: fact.factId,
    factType: fact.factType,
    factText: fact.factText,
    ...(fact.sourceClaim ? { sourceClaim: fact.sourceClaim } : {}),
    normalizedClaim: fact.normalizedClaim,
    confidenceLevel: fact.confidenceLevel,
    ...(fact.evidenceTime ? { evidenceTime: fact.evidenceTime } : {}),
    ...(!fact.evidenceTime && fact.evidenceTimeStart ? { evidenceTimeStart: fact.evidenceTimeStart } : {}),
    ...(!fact.evidenceTime && fact.evidenceTimeEnd ? { evidenceTimeEnd: fact.evidenceTimeEnd } : {}),
    ...(!fact.evidenceTime ? { evidenceTimeConfidence: fact.evidenceTimeConfidence ?? "low" } : {}),
    ...(fact.validTime ? { validTime: fact.validTime } : {}),
    ...(!fact.validTime && fact.validTimeStart ? { validTimeStart: fact.validTimeStart } : {}),
    ...(!fact.validTime && fact.validTimeEnd ? { validTimeEnd: fact.validTimeEnd } : {}),
    ...(!fact.validTime ? { validTimeConfidence: fact.validTimeConfidence ?? fact.timeConfidence } : {}),
    sourceRefIds: fact.linkedSourceRefs.map((ref) => ref.sourceRefId)
  }));
}

function buildStmAdmissionPrompt(
  event: MemoryEvent,
  factInputs: LlmStmAdmissionTrace["factInputs"],
  baseline: AdmissionDecision
) {
  return JSON.stringify({
    instruction: "你是 Context 引擎的 STM 准入判断服务。请只返回严格 JSON，不要输出推理过程、解释、Markdown 或代码块。",
    task: "根据 FactItem、敏感等级和规则命中，判断事实是否应进入 STM。",
    outputSchema: {
      result: "reject | write_short_term | write_candidate | write_high_priority | pending_confirm",
      memoryDataType: "action | task | project | decision | preference | relationship | knowledge | event | fact",
      importanceLevel: "low | medium | high | critical",
      confidenceLevel: "low | medium | high",
      ttl: "optional number seconds",
      needUserConfirm: "boolean",
      reason: "string",
      matchedRules: ["rule_id"],
      sourceFactIds: ["fact_id"]
    },
    hardRules: [
      "sensitive_secret 必须 reject。",
      "sensitive_profile 必须 pending_confirm。",
      "低置信推断必须 reject 或 pending_confirm。",
      "与具体实体、事件、交易或状态绑定的金额、日期、时间、数量、比例、频率、时长、区间等有意义定量事实不得 reject；至少 write_candidate，importanceLevel 至少 high。",
      "输出必须包含 reason、matchedRules、sourceFactIds。",
      "不得引用输入 facts 之外的 sourceFactIds。"
    ],
    admissionRules: [
      "explicit_remember -> write_high_priority",
      "action_item/key_decision/stable_preference/project_fact/repeated_signal -> write_candidate",
      "active_task_context/useful_reference -> write_short_term",
      "temporary_tool_result -> write_short_term 或 reject",
      "small_talk/sensitive_secret -> reject",
      "sensitive_profile/low_confidence_inference -> pending_confirm 或 reject"
    ],
    event: {
      eventId: event.eventId,
      eventType: event.eventType,
      eventSummary: memoryEventSummary(event),
      eventTime: event.eventTime,
      sourceApp: event.sourceApp,
      sourceId: event.sourceId,
      visibility: event.permissionSnapshot.visibility
    },
    baselineDecision: {
      result: baseline.result,
      importanceLevel: baseline.importanceLevel,
      confidenceLevel: baseline.confidenceLevel,
      reason: baseline.reason,
      matchedRules: baseline.matchedRules,
      signals: baseline.signals
    },
    facts: factInputs
  }, null, 2);
}

function buildSessionStmAdmissionPrompt(
  event: MemoryEvent,
  factInputs: LlmStmAdmissionTrace["factInputs"],
  baselines: Map<string, AdmissionDecision>
) {
  return JSON.stringify({
    instruction: "你是 Context 引擎的 STM 准入判断服务。请只返回严格 JSON，不要输出推理过程、解释、Markdown 或代码块。",
    task: "在同一个 session 的完整事实集合中比较信息价值，并为每条 FactItem 分别判断是否进入 STM。",
    outputSchema: {
      decisions: [{
        sourceFactIds: ["必须且只能包含当前决策对应的一个 fact_id"],
        result: "reject | write_short_term | write_candidate | write_high_priority | pending_confirm",
        memoryDataType: "action | task | project | decision | preference | relationship | knowledge | event | fact",
        importanceLevel: "low | medium | high | critical",
        confidenceLevel: "low | medium | high",
        ttl: "optional number seconds",
        needUserConfirm: "boolean",
        reason: "string",
        matchedRules: ["rule_id"]
      }]
    },
    hardRules: [
      "decisions 必须覆盖输入 facts 中的每一个 factId，不能遗漏、重复或引用未知 factId。",
      "每个 decision 的 sourceFactIds 必须且只能包含一个输入 factId。",
      "必须逐条判断，不能用一个统一决策代替全部 Fact。",
      "sensitive_secret 必须 reject。",
      "sensitive_profile 必须 pending_confirm。",
      "低置信推断必须 reject 或 pending_confirm。",
      "同一 session 中重复、缺少独立检索价值、仅为寒暄或格式说明的 Fact 应 reject。",
      "与具体实体、事件、交易或状态绑定的金额、日期、时间、数量、比例、频率、时长、区间等有意义定量事实不得 reject；至少 write_candidate，importanceLevel 至少 high。",
      "输出必须包含 reason、matchedRules、sourceFactIds。"
    ],
    admissionRules: [
      "explicit_remember -> write_high_priority",
      "action_item/key_decision/stable_preference/project_fact/repeated_signal -> write_candidate",
      "active_task_context/useful_reference -> write_short_term",
      "temporary_tool_result -> write_short_term 或 reject",
      "small_talk/sensitive_secret -> reject",
      "sensitive_profile/low_confidence_inference -> pending_confirm 或 reject"
    ],
    event: {
      eventId: event.eventId,
      eventType: event.eventType,
      eventSummary: memoryEventSummary(event),
      eventTime: event.eventTime,
      sourceApp: event.sourceApp,
      sourceId: event.sourceId,
      visibility: event.permissionSnapshot.visibility
    },
    baselineDecisions: factInputs.map((fact) => {
      const baseline = baselines.get(fact.factId)!;
      return {
        factId: fact.factId,
        result: baseline.result,
        importanceLevel: baseline.importanceLevel,
        confidenceLevel: baseline.confidenceLevel,
        reason: baseline.reason,
        matchedRules: baseline.matchedRules,
        signals: baseline.signals
      };
    }),
    facts: factInputs
  }, null, 2);
}

async function callOpenAiCompatibleChatCompletion(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  prompt: string;
  transport?: "fetch" | "openai-sdk-stream";
  observer?: OpenAiCompatibleRequestObserver;
  signal?: AbortSignal;
  logContext?: Record<string, unknown>;
}) {
  const request = {
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    operation: "stm_admission",
    body: {
      model: input.model,
      messages: [
        {
          role: "system",
          content: "你是严格 JSON 输出的 STM 准入服务。不要输出推理过程。"
        },
        {
          role: "user",
          content: input.prompt
        }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    },
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.observer ? { observer: input.observer } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.logContext ? { logContext: input.logContext } : {})
  } as const;

  if (input.transport === "openai-sdk-stream") {
    return await postOpenAiCompatibleJson(request);
  }

  const response = await postOpenAiCompatibleResponse(request);
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { text };
  }

  if (!response.ok) {
    throw new Error(`http_${response.status}:${truncate(text, 240)}`);
  }

  return parsed;
}

function parseStmAdmissionResponse(rawResponse: unknown): LlmStmAdmissionPayload {
  if (!rawResponse || typeof rawResponse !== "object") {
    throw new Error("invalid_response_object");
  }

  const messageContent = extractMessageContent(rawResponse);
  const payload = typeof messageContent === "string" ? JSON.parse(messageContent) : messageContent;
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid_payload_object");
  }

  return payload as LlmStmAdmissionPayload;
}

function convertLlmAdmissionDecision(
  payload: LlmStmAdmissionPayload,
  baseline: AdmissionDecision,
  facts: FactItem[]
): NonNullable<LlmStmAdmissionTrace["parsedDecision"]> {
  const result = parseAdmissionResult(payload.result);
  if (!result) throw new Error("result_required");

  const knownFactIds = new Set(facts.map((fact) => fact.factId));
  const sourceFactIds = parseStringArray(payload.sourceFactIds).filter((factId) => knownFactIds.has(factId));
  const matchedRules = unique([...parseStringArray(payload.matchedRules), "llm_stm_admission"]);
  const reason = typeof payload.reason === "string" && payload.reason.trim()
    ? payload.reason.trim()
    : baseline.reason;
  const memoryDataType = parseMemoryDataType(payload.memoryDataType);
  const ttl = parsePositiveNumber(payload.ttl);

  return {
    result,
    ...(memoryDataType ? { memoryDataType } : {}),
    importanceLevel: parseImportance(payload.importanceLevel) ?? baseline.importanceLevel,
    confidenceLevel: parseConfidence(payload.confidenceLevel) ?? baseline.confidenceLevel,
    ...(ttl ? { ttl } : {}),
    ...(typeof payload.needUserConfirm === "boolean" ? { needUserConfirm: payload.needUserConfirm } : {}),
    reason,
    matchedRules,
    sourceFactIds: sourceFactIds.length ? sourceFactIds : facts.map((fact) => fact.factId)
  };
}

function convertSessionAdmissionDecisions(
  payload: LlmStmAdmissionPayload,
  facts: FactItem[],
  baselines: Map<string, AdmissionDecision>
): Array<{
  factId: string;
  parsedDecision: NonNullable<LlmStmAdmissionTrace["parsedDecision"]>;
}> {
  if (!Array.isArray(payload.decisions)) {
    return facts.map((fact) => ({
      factId: fact.factId,
      parsedDecision: convertLlmAdmissionDecision(payload, baselines.get(fact.factId)!, [fact])
    }));
  }

  const factById = new Map(facts.map((fact) => [fact.factId, fact]));
  const converted = new Map<string, NonNullable<LlmStmAdmissionTrace["parsedDecision"]>>();
  for (const [index, item] of payload.decisions.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`decision_${index}_object_required`);
    }
    const decisionPayload = item as LlmStmAdmissionPayload;
    const sourceFactIds = parseStringArray(decisionPayload.sourceFactIds);
    if (sourceFactIds.length !== 1) throw new Error(`decision_${index}_single_source_fact_required`);
    const factId = sourceFactIds[0]!;
    const fact = factById.get(factId);
    if (!fact) throw new Error(`decision_${index}_source_fact_not_found:${factId}`);
    if (converted.has(factId)) throw new Error(`decision_${index}_duplicate_source_fact:${factId}`);
    converted.set(
      factId,
      convertLlmAdmissionDecision(decisionPayload, baselines.get(factId)!, [fact])
    );
  }
  const missingFactIds = facts.map((fact) => fact.factId).filter((factId) => !converted.has(factId));
  if (missingFactIds.length) throw new Error(`decisions_missing_facts:${missingFactIds.join(",")}`);
  return facts.map((fact) => ({ factId: fact.factId, parsedDecision: converted.get(fact.factId)! }));
}

function admissionDecisionFromPayload(
  payload: NonNullable<LlmStmAdmissionTrace["parsedDecision"]>,
  baseline: AdmissionDecision
): AdmissionDecision {
  const lifecycleStatus = lifecycleStatusForResult(payload.result);
  return {
    result: payload.result,
    ...(payload.memoryDataType ? { memoryDataType: payload.memoryDataType } : {}),
    reason: payload.reason,
    matchedRules: payload.matchedRules,
    importanceLevel: payload.importanceLevel ?? baseline.importanceLevel,
    confidenceLevel: payload.confidenceLevel ?? baseline.confidenceLevel,
    ...(payload.ttl ? { ttl: payload.ttl } : {}),
    ...(typeof payload.needUserConfirm === "boolean" ? { needUserConfirm: payload.needUserConfirm } : {}),
    lifecycleStatus,
    accessState: "visible",
    signals: baseline.signals
  };
}

function applyHardRuleOverrides(
  decision: AdmissionDecision,
  baseline: AdmissionDecision
): AdmissionDecision {
  if (baseline.signals.sensitivity === "high") {
    return {
      ...baseline,
      matchedRules: unique([...baseline.matchedRules, "hard_rule_sensitive_override", "llm_stm_admission"])
    };
  }
  if (!baseline.matchedRules.includes("meaningful_quantitative_fact")) return decision;
  const needsResultUpgrade = decision.result === "reject" || decision.result === "write_short_term";
  const needsImportanceUpgrade = decision.importanceLevel === "low" || decision.importanceLevel === "medium";
  if (!needsResultUpgrade && !needsImportanceUpgrade) return decision;
  return {
    ...decision,
    result: needsResultUpgrade ? "write_candidate" : decision.result,
    reason: "meaningful_quantitative_fact",
    importanceLevel: "high",
    lifecycleStatus: needsResultUpgrade ? "candidate_queue" : decision.lifecycleStatus,
    matchedRules: unique([...decision.matchedRules, "meaningful_quantitative_fact", "hard_rule_quantitative_override", "llm_stm_admission"])
  };
}

function lifecycleStatusForResult(result: ShortTermMemory["admissionResult"]): AdmissionDecision["lifecycleStatus"] {
  if (result === "pending_confirm") return "pending_confirm";
  if (result === "reject") return "rejected";
  if (result === "write_candidate") return "candidate_queue";
  return "active";
}

function parseAdmissionResult(value: unknown): ShortTermMemory["admissionResult"] | undefined {
  return value === "reject" ||
    value === "write_short_term" ||
    value === "write_candidate" ||
    value === "write_high_priority" ||
    value === "pending_confirm"
    ? value
    : undefined;
}

function parseImportance(value: unknown): ShortTermMemory["importanceLevel"] | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "critical" ? value : undefined;
}

function parseConfidence(value: unknown): ShortTermMemory["confidenceLevel"] | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function parseMemoryDataType(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function parsePositiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function extractMessageContent(rawResponse: unknown): unknown {
  if (!rawResponse || typeof rawResponse !== "object") return rawResponse;
  const choices = (rawResponse as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return rawResponse;
  const first = choices[0] as { message?: { content?: unknown } };
  return first.message?.content ?? rawResponse;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/u, "");
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function chunkArray<T>(items: T[], batchSize: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    output.push(items.slice(index, index + batchSize));
  }
  return output;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function readPositiveInteger(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { error };
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}
