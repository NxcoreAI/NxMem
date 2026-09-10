import type {
  ContextPipelineTask,
  LongTermMemory,
  MemoryChangeEvent,
  MemoryEvent,
  ShortTermMemory
} from "./domain.js";
import { runLlmDreaming } from "./llm-dreaming.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { buildTimelineAggregatedFactsWithLlm, summarizeAggregatedFacts } from "./timeline-aggregation.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import type { ContextEngineService } from "./write-event.js";
import { memoryEventSummary, multimodalContentToText, sourceRefsFromEvent } from "./memory-event-fields.js";

export interface ManualMemoryFlowInput {
  content?: string;
  eventType?: string;
  description?: string;
  sourceId?: string;
  eventTime?: string;
  visibility?: MemoryEvent["permissionSnapshot"]["visibility"];
  customFields?: MemoryEvent["customFields"];
  llm?: LlmFactFusionOptions;
}

export interface ManualMemoryFlowResult {
  stages: ManualMemoryFlowStage[];
  event: MemoryEvent;
  dataLake: {
    parsedSegments: number;
    facts: number;
    segments: Array<{
      segmentId: string;
      modality: string;
      status: string;
      confidence: string;
      content: string;
    }>;
    factItems: Array<{
      factId: string;
      status: string;
      confidenceLevel: string;
      factText: string;
      sourceEventIds: string[];
      sourceSegmentIds: string[];
      validTimeStart?: string;
      validTimeEnd?: string;
      timeBasis: string;
      timeConfidence: string;
    }>;
    sourceRefs: MemoryEvent["sourceRefs"];
  };
  timelineAggregation: {
    eventIds: string[];
    factIds: string[];
    summary: string;
    aggregatedFacts: Array<{
      aggregationId: string;
      factId: string;
      factType: string;
      factText: string;
      normalizedClaim: string;
      sourceEventIds: string[];
      sourceSegmentIds: string[];
      sourceFactIds: string[];
      sourceRefs: MemoryEvent["sourceRefs"];
      validTimeStart?: string;
      validTimeEnd?: string;
      timeBasis: string;
      timeConfidence: string;
    }>;
  };
  llmFactFusionTrace?: ReturnType<ContextEngineRepository["getDebugSnapshot"]>["llmFactFusionTraces"][number];
  longTermMemory: LongTermMemory;
  shortTermMemory: ShortTermMemory;
  tasks: ContextPipelineTask[];
  changeEvents: MemoryChangeEvent[];
}

export interface ManualMemoryFlowStage {
  stage: "event" | "data_lake" | "timeline_aggregation" | "ltm" | "stm";
  status: "started" | "succeeded";
  message: string;
  at: string;
  counts?: Record<string, number>;
  resourceIds?: string[];
}

export interface ManualMemoryFlowOptions {
  log?: (stage: ManualMemoryFlowStage) => void;
}

export async function runManualMemoryFlow(
  service: ContextEngineService,
  repository: ContextEngineRepository,
  input: ManualMemoryFlowInput = {},
  options: ManualMemoryFlowOptions = {}
): Promise<ManualMemoryFlowResult> {
  const stages: ManualMemoryFlowStage[] = [];
  const recordStage = (stage: Omit<ManualMemoryFlowStage, "at">) => {
    const item: ManualMemoryFlowStage = {
      ...stage,
      at: new Date().toISOString()
    };
    stages.push(item);
    options.log?.(item);
  };

  const now = parseEventTime(input.eventTime) ?? new Date().toISOString();
  const safeId = `manual_flow_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const sourceId = input.sourceId ?? "方案.md";
  const content = input.content?.trim() || defaultSolutionFlowContent;
  const event: MemoryEvent = {
    eventId: safeId,
    eventType: input.eventType ?? "solution_memory_flow_event",
    eventSummary: input.description ?? "手动触发方案流程：事件到数据湖、时间轴聚合、短期记忆准入、长期记忆巩固。",
    eventTime: now,
    sourceApp: "context-debug-frontend",
    sourceId,
    ...(input.customFields ? { customFields: input.customFields } : {}),
    permissionSnapshot: {
      snapshotId: `ps_${safeId}`,
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "debug-flow-v1",
      visibility: input.visibility ?? "private"
    },
    multimodalData: [
      {
        itemId: `item_${safeId}`,
        type: "text",
        format: "plain",
        content,
        ref: sourceId,
        sourceRefs: [{
          sourceRefId: `src_${safeId}`,
          sourceType: "file",
          sourceId
        }],
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ]
  };

  recordStage({
    stage: "event",
    status: "started",
    message: "开始写入 MemoryEvent",
    resourceIds: [event.eventId]
  });
  await service.writeEvent({ event, idempotencyKey: safeId, ...(input.llm ? { llm: input.llm } : {}) });
  recordStage({
    stage: "event",
    status: "succeeded",
    message: "MemoryEvent 已写入并完成基础摄入",
    resourceIds: [event.eventId]
  });

  const afterIngest = repository.getDebugSnapshot();
  const facts = afterIngest.facts.filter((fact) => fact.linkedEventIds.includes(event.eventId));
  const parsedSegments = afterIngest.parsedSegments.filter((segment) => segment.eventId === event.eventId);
  const llmFactFusionTrace = afterIngest.llmFactFusionTraces.find((trace) => trace.eventId === event.eventId);
  const factIds = new Set(facts.map((fact) => fact.factId));
  const sourceStm = afterIngest.shortTermMemories.find((memory) =>
    memory.sourceFactIds.some((factId) => factIds.has(factId))
  );
  const aggregatedFacts = await buildTimelineAggregatedFactsWithLlm(afterIngest.facts, input.llm);
  const relevantAggregatedFacts = aggregatedFacts.filter((item) => item.sourceEventIds.includes(event.eventId));
  recordStage({
    stage: "data_lake",
    status: "succeeded",
    message: "数据湖解析证据已生成",
    counts: {
      parsedSegments: parsedSegments.length,
      facts: facts.length
    },
    resourceIds: [
      ...parsedSegments.map((segment) => segment.segmentId),
      ...facts.map((fact) => fact.factId)
    ]
  });

  const timelineAggregation = {
    eventIds: [...new Set(relevantAggregatedFacts.flatMap((item) => item.sourceEventIds))],
    factIds: [...new Set(relevantAggregatedFacts.flatMap((item) => item.sourceFactIds))],
    summary: summarizeAggregatedFacts(relevantAggregatedFacts, event),
    aggregatedFacts
  };
  recordStage({
    stage: "timeline_aggregation",
    status: "succeeded",
    message: "时间轴聚合已完成",
    counts: {
      events: timelineAggregation.eventIds.length,
      facts: timelineAggregation.factIds.length
    },
    resourceIds: timelineAggregation.eventIds
  });

  recordStage({
    stage: "stm",
    status: "started",
    message: "开始确认 S4 短期记忆准入结果",
    resourceIds: timelineAggregation.factIds
  });
  if (!sourceStm) {
    throw new Error("manual flow expected STM admission result");
  }
  recordStage({
    stage: "stm",
    status: "succeeded",
    message: "短期记忆已由 S4 准入并可立即检索",
    resourceIds: [sourceStm.memoryDataId]
  });

  recordStage({
    stage: "ltm",
    status: "started",
    message: "开始通过做梦流程将短期记忆巩固为长期记忆",
    resourceIds: [sourceStm.memoryDataId]
  });
  const dreaming = await runLlmDreaming(repository, {
    memoryDataIds: [sourceStm.memoryDataId],
    ...(input.llm ? input.llm : {})
  });
  const ltm = dreaming.longTermMemories[0];
  if (!ltm) {
    throw new Error("manual flow expected LTM dreaming result");
  }
  recordStage({
    stage: "ltm",
    status: "succeeded",
    message: "长期记忆已由做梦流程创建或强化",
    resourceIds: [ltm.memoryId]
  });

  const snapshot = repository.getDebugSnapshot();
  return {
    stages,
    event,
    dataLake: {
      parsedSegments: parsedSegments.length,
      facts: facts.length,
      segments: parsedSegments.map((segment) => ({
        segmentId: segment.segmentId,
        modality: segment.modality,
        status: segment.status,
        confidence: segment.confidence,
        content: segment.content
      })),
      factItems: facts.map((fact) => ({
        factId: fact.factId,
        status: fact.status,
        confidenceLevel: fact.confidenceLevel,
        factText: fact.factText,
        sourceEventIds: fact.linkedEventIds,
        sourceSegmentIds: fact.linkedSegmentIds,
        ...(fact.validTimeStart ? { validTimeStart: fact.validTimeStart } : {}),
        ...(fact.validTimeEnd ? { validTimeEnd: fact.validTimeEnd } : {}),
        timeBasis: fact.timeBasis,
        timeConfidence: fact.timeConfidence
      })),
      sourceRefs: sourceRefsFromEvent(event)
    },
    timelineAggregation,
    ...(llmFactFusionTrace ? { llmFactFusionTrace } : {}),
    longTermMemory: ltm,
    shortTermMemory: sourceStm,
    tasks: snapshot.pipelineTasks.filter((task) => task.eventId === event.eventId),
    changeEvents: snapshot.changeEvents.filter((change) =>
      change.memoryDataId === event.eventId ||
      change.memoryDataId === sourceStm?.memoryDataId ||
      change.memoryId === ltm.memoryId
    )
  };
}

function buildTimelineSummary(event: MemoryEvent, factTexts: string[]) {
  const evidence = factTexts.length ? factTexts.join("\n") : event.multimodalData
    .map((item) => multimodalContentToText(item.content))
    .filter(Boolean)
    .join("\n");
  return [
    `时间轴聚合事件：${memoryEventSummary(event)}`,
    `事件时间：${event.eventTime}`,
    `来源：${event.sourceId ?? event.sourceApp ?? event.eventId}`,
    `聚合证据：${evidence}`
  ].join("\n");
}

const defaultSolutionFlowContent =
  "方案流程要求从事件写入开始，保留数据湖解析证据，按事件时间做时间轴聚合，将高价值聚合结果巩固为长期记忆，并回灌为短期记忆供 Agent 召回。";

function parseEventTime(value: string | undefined) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}
