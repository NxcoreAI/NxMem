import type {
  ContextPipelineTask,
  FactItem,
  MemoryChangeEvent,
  MemoryEvent,
  ParsedSegment,
  ShortTermMemory
} from "./domain.js";
import { refreshShortTermMemoryIndex } from "./indexing.js";
import { createFactsWithLlmFusion, type LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { runLlmDreaming } from "./llm-dreaming.js";
import { evaluateShortTermAdmissionWithLlm } from "./llm-stm-admission.js";
import { reconcileMemoryGraphForShortTermMemory } from "./memory-graph.js";
import { inferShortTermMemoryType, summarizeFactsForMemory } from "./memory-types.js";
import { createParserAdapter } from "./parser.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { buildShortTermMemoryExplanation, buildShortTermMemoryPayload } from "./structured-memory.js";
import { sourceRefsFromEvent } from "./memory-event-fields.js";

export type ManualStepAction = "event" | "data_lake" | "timeline_fusion" | "stm" | "ltm";

export interface ManualStepInput {
  action: ManualStepAction;
  eventId?: string;
  content?: string;
  eventType?: string;
  description?: string;
  sourceId?: string;
  eventTime?: string;
  visibility?: MemoryEvent["permissionSnapshot"]["visibility"];
  customFields?: MemoryEvent["customFields"];
  llm?: LlmFactFusionOptions;
}

export interface ManualStepResult {
  action: ManualStepAction;
  event?: MemoryEvent;
  parsedSegments: ParsedSegment[];
  facts: FactItem[];
  shortTermMemory?: ShortTermMemory;
  ltmResult?: Awaited<ReturnType<typeof runLlmDreaming>>;
  task: ContextPipelineTask;
  changeEvents: MemoryChangeEvent[];
}

export async function runManualStepFlow(
  repository: ContextEngineRepository,
  input: ManualStepInput
): Promise<ManualStepResult> {
  if (input.action === "ltm" && !input.eventId?.trim()) {
    return runSystemDreamingStep(repository, input);
  }

  const event = await resolveManualStepEvent(repository, input);
  const task = await saveStepTask(repository, event.eventId, input.action, `${input.action}_started`);

  if (input.action === "event") {
    const completedTask = await saveStepTask(repository, event.eventId, input.action, "raw_text_saved", "succeeded");
    return collectStepResult(repository, input.action, event, completedTask);
  }

  if (input.action === "data_lake") {
    await parseToDataLake(repository, event);
    await saveStepTask(repository, event.eventId, input.action, "data_lake_parsed", "succeeded");
    return collectStepResult(repository, input.action, event, task);
  }

  if (input.action === "timeline_fusion") {
    await ensureParsed(repository, event);
    await fuseTimelineFacts(repository, event, input.llm);
    await saveStepTask(repository, event.eventId, input.action, "timeline_fusion_completed", "succeeded");
    return collectStepResult(repository, input.action, event, task);
  }

  if (input.action === "stm") {
    await ensureFacts(repository, event, input.llm);
    const admissionResult = await admitShortTermMemory(repository, event, input.llm);
    await saveStepTask(repository, event.eventId, input.action, admissionResult === "reject" ? "stm_rejected" : "stm_admitted", "succeeded");
    return collectStepResult(repository, input.action, event, task);
  }

  await ensureShortTermMemory(repository, event, input.llm);
  const snapshot = repository.getDebugSnapshot();
  const stm = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === `stm_${event.eventId}`);
  if (!stm) throw new Error("short term memory was rejected or not created");
  const ltmResult = await runLlmDreaming(repository, {
    ...(stm ? { memoryDataIds: [stm.memoryDataId] } : {}),
    ...(input.llm ? input.llm : {})
  });
  await saveStepTask(repository, event.eventId, input.action, "ltm_dreaming_completed", "succeeded");
  return {
    ...(await collectStepResult(repository, input.action, event, task)),
    ltmResult
  };
}

async function runSystemDreamingStep(
  repository: ContextEngineRepository,
  input: ManualStepInput
): Promise<ManualStepResult> {
  const task = await saveStepTask(repository, "system_stm", "ltm", "ltm_dreaming_started");
  const ltmResult = await runLlmDreaming(repository, input.llm ? input.llm : {});
  await saveStepTask(repository, "system_stm", "ltm", "ltm_dreaming_completed", "succeeded");
  const snapshot = repository.getDebugSnapshot();
  const sourceStmIds = new Set(ltmResult.trace.sourceMemoryDataIds);
  const sourceFactIds = new Set(
    snapshot.shortTermMemories
      .filter((memory) => sourceStmIds.has(memory.memoryDataId))
      .flatMap((memory) => memory.sourceFactIds)
  );
  const eventIds = new Set(
    snapshot.facts
      .filter((fact) => sourceFactIds.has(fact.factId))
      .flatMap((fact) => fact.linkedEventIds)
  );
  const event = snapshot.memoryEvents.find((item) => eventIds.has(item.eventId));

  return {
    action: "ltm",
    ...(event ? { event } : {}),
    parsedSegments: event ? snapshot.parsedSegments.filter((segment) => segment.eventId === event.eventId) : [],
    facts: snapshot.facts.filter((fact) => fact.linkedEventIds.some((eventId) => eventIds.has(eventId))),
    task,
    changeEvents: ltmResult.changeEvents,
    ltmResult
  };
}

async function createRawTextEvent(repository: ContextEngineRepository, input: ManualStepInput) {
  const now = new Date().toISOString();
  const eventTime = parseEventTime(input.eventTime) ?? now;
  const safeId = (input.eventId ?? `manual_step_${Date.now()}_${Math.random().toString(16).slice(2)}`)
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const sourceId = input.sourceId?.trim() || "manual-step";
  const event: MemoryEvent = {
    eventId: safeId,
    eventType: input.eventType?.trim() || "manual_step_text_event",
    ...(input.description?.trim() ? { eventSummary: input.description.trim() } : {}),
    eventTime,
    sourceApp: "context-debug-frontend",
    sourceId,
    ...(input.customFields ? { customFields: input.customFields } : {}),
    permissionSnapshot: {
      snapshotId: `ps_${safeId}`,
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "debug-step-v1",
      visibility: input.visibility ?? "private"
    },
    multimodalData: [
      {
        itemId: `item_${safeId}`,
        type: "text",
        format: "plain",
        content: input.content?.trim() || "空文本事件",
        ref: sourceId,
        sourceRefs: [{
          sourceRefId: `src_${safeId}`,
          sourceType: "manual_text",
          sourceId
        }],
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ]
  };

  await repository.saveMemoryEvent(event);
  await repository.saveMemoryChangeEvent({
    eventId: `mce_step_${event.eventId}`,
    memoryDataId: event.eventId,
    changeType: "created",
    storageLayer: "fact",
    reason: "manual_step_raw_text_saved",
    createdAt: new Date().toISOString()
  });
  await saveStepTask(repository, event.eventId, "event", "raw_text_saved", "succeeded");
  return event;
}

async function parseToDataLake(repository: ContextEngineRepository, event: MemoryEvent) {
  const parser = createParserAdapter();
  const parsed = await parser.parse(event);
  for (const segment of parsed.segments) {
    await repository.saveParsedSegment(segment);
  }
  for (const item of parsed.unsupportedItems) {
    await repository.saveMemoryChangeEvent({
      eventId: `mce_step_${event.eventId}_${item.itemId}`,
      memoryDataId: event.eventId,
      changeType: "updated",
      storageLayer: "fact",
      reason: `unsupported_modality:${item.type}`,
      createdAt: new Date().toISOString()
    });
  }
}

async function fuseTimelineFacts(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  llm?: LlmFactFusionOptions
) {
  const segments = repository.getDebugSnapshot().parsedSegments.filter((segment) => segment.eventId === event.eventId);
  const fusion = await createFactsWithLlmFusion(repository, event, segments, llm);
  for (const fact of fusion.facts) {
    await repository.saveFactItem(fact);
  }
  for (const rejected of fusion.rejectedSegments) {
    await repository.saveMemoryChangeEvent({
      eventId: `mce_step_${event.eventId}_${rejected.segmentId}`,
      memoryDataId: event.eventId,
      changeType: "updated",
      storageLayer: "fact",
      reason: `fact_rejected:${rejected.reason}`,
      createdAt: new Date().toISOString()
    });
  }
}

async function admitShortTermMemory(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  llm?: LlmFactFusionOptions
): Promise<ShortTermMemory["admissionResult"]> {
  const snapshot = repository.getDebugSnapshot();
  const facts = snapshot.facts.filter((fact) => fact.linkedEventIds.includes(event.eventId));
  const parsedSegments = snapshot.parsedSegments.filter((segment) => segment.eventId === event.eventId);
  const admission = await evaluateShortTermAdmissionWithLlm(repository, event, facts, llm);
  if (admission.result === "reject") {
    await repository.saveMemoryChangeEvent({
      eventId: `mce_step_${event.eventId}_stm_rejected`,
      memoryDataId: event.eventId,
      changeType: parsedSegments.length ? "created" : "updated",
      storageLayer: "stm",
      reason: `manual_step_stm_rejected:${admission.reason}`,
      createdAt: new Date().toISOString()
    });
    return admission.result;
  }
  const memoryPayload = buildShortTermMemoryPayload(event, facts);
  const now = new Date().toISOString();
  const stm: ShortTermMemory = {
    memoryDataId: `stm_${event.eventId}`,
    tenantId: event.permissionSnapshot.tenantId,
    principalId: event.permissionSnapshot.principalId,
    createdAt: now,
    updatedAt: now,
    memoryDataType: admission.memoryDataType ?? event.eventType,
    memoryType: inferShortTermMemoryType(event, facts),
    content: memoryPayload.content,
    structuredFacts: memoryPayload.structuredFacts,
    factSummary: summarizeFactsForMemory(facts, memoryPayload.content),
    summary: buildShortTermMemoryExplanation(event, facts, admission.reason),
    sourceFactIds: facts.map((fact) => fact.factId),
    sourceRefs: sourceRefsFromEvent(event),
    entityIds: facts.flatMap((fact) => fact.entityIds),
    importanceLevel: admission.importanceLevel,
    confidenceLevel: admission.confidenceLevel,
    admissionResult: admission.result,
    admissionReason: admission.reason,
    matchedRules: [...admission.matchedRules, "manual_step_flow"],
    admissionSignals: admission.signals,
    lifecycleStatus: admission.lifecycleStatus,
    accessState: admission.accessState
  };

  await repository.replaceShortTermMemory(stm);
  await refreshShortTermMemoryIndex(repository, stm);
  await reconcileMemoryGraphForShortTermMemory(repository, stm.memoryDataId);
  await repository.saveMemoryChangeEvent({
    eventId: `mce_step_${event.eventId}_${stm.memoryDataId}`,
    memoryDataId: stm.memoryDataId,
    changeType: parsedSegments.length ? "created" : "updated",
    storageLayer: "stm",
    reason: `manual_step_stm_${stm.admissionResult}:${stm.admissionReason}`,
    createdAt: new Date().toISOString()
  });
  return admission.result;
}

async function ensureParsed(repository: ContextEngineRepository, event: MemoryEvent) {
  const exists = repository.getDebugSnapshot().parsedSegments.some((segment) => segment.eventId === event.eventId);
  if (!exists) await parseToDataLake(repository, event);
}

async function ensureFacts(repository: ContextEngineRepository, event: MemoryEvent, llm?: LlmFactFusionOptions) {
  await ensureParsed(repository, event);
  const exists = repository.getDebugSnapshot().facts.some((fact) => fact.linkedEventIds.includes(event.eventId));
  if (!exists) await fuseTimelineFacts(repository, event, llm);
}

async function ensureShortTermMemory(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  llm?: LlmFactFusionOptions
) {
  await ensureFacts(repository, event, llm);
  const exists = repository.getDebugSnapshot().shortTermMemories.some((memory) => memory.memoryDataId === `stm_${event.eventId}`);
  if (!exists) await admitShortTermMemory(repository, event, llm);
}

function findEvent(repository: ContextEngineRepository, eventId: string | undefined) {
  if (!eventId?.trim()) throw new Error("eventId is required for this step");
  const event = repository.getDebugSnapshot().memoryEvents.find((item) => item.eventId === eventId);
  if (!event) throw new Error("manual step event not found");
  return event;
}

async function resolveManualStepEvent(repository: ContextEngineRepository, input: ManualStepInput) {
  if (input.action === "event" || !input.eventId?.trim()) {
    return await createRawTextEvent(repository, input);
  }

  const event = repository.getDebugSnapshot().memoryEvents.find((item) => item.eventId === input.eventId);
  if (event) return event;
  if (input.content?.trim()) return await createRawTextEvent(repository, input);
  return findEvent(repository, input.eventId);
}

async function collectStepResult(
  repository: ContextEngineRepository,
  action: ManualStepAction,
  event: MemoryEvent,
  task: ContextPipelineTask
): Promise<ManualStepResult> {
  const snapshot = repository.getDebugSnapshot();
  const parsedSegments = snapshot.parsedSegments.filter((segment) => segment.eventId === event.eventId);
  const facts = snapshot.facts.filter((fact) => fact.linkedEventIds.includes(event.eventId));
  const shortTermMemory = snapshot.shortTermMemories.find((memory) => memory.memoryDataId === `stm_${event.eventId}`);
  const changeEvents = snapshot.changeEvents.filter((change) =>
    change.memoryDataId === event.eventId ||
    change.memoryDataId === shortTermMemory?.memoryDataId ||
    change.memoryId?.includes(event.eventId)
  );
  return {
    action,
    event,
    parsedSegments,
    facts,
    ...(shortTermMemory ? { shortTermMemory } : {}),
    task,
    changeEvents
  };
}

async function saveStepTask(
  repository: ContextEngineRepository,
  eventId: string,
  action: ManualStepAction,
  stage: string,
  status: ContextPipelineTask["status"] = "running"
) {
  const now = new Date().toISOString();
  const task: ContextPipelineTask = {
    taskId: `manual_step_${action}_${eventId}`,
    eventId,
    taskType: action === "event" ? "ingest" : action === "data_lake" ? "parse" : action === "timeline_fusion" ? "fusion" : action === "stm" ? "admission" : "dreaming",
    status,
    attempt: 1,
    maxAttempts: 1,
    retryable: false,
    stage,
    createdAt: now,
    updatedAt: now
  };
  await repository.savePipelineTask(task);
  return task;
}

function parseEventTime(value: string | undefined) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}
