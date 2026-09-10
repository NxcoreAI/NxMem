import { randomUUID } from "node:crypto";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { createParserAdapter } from "./parser.js";
import type { ContextPipelineTask, MemoryEvent, MemoryChangeEvent, ShortTermMemory, FactItem } from "./domain.js";
import { createFactsWithLlmFusion, type LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { updatePipelineTask } from "./pipeline-task.js";
import {
  evaluateShortTermAdmissionsWithLlm,
  type FactAdmissionDecision
} from "./llm-stm-admission.js";
import { refreshShortTermMemoryIndexes } from "./indexing.js";
import type { EmbeddingClient } from "./embedding.js";
import { reconcileMemoryGraphForShortTermMemory } from "./memory-graph.js";
import { inferShortTermMemoryType, summarizeFactsForMemory } from "./memory-types.js";
import { buildShortTermMemoryExplanation, buildShortTermMemoryPayload } from "./structured-memory.js";
import { aggregateMemoryTemporalMetadata, temporalMetadataFromFact } from "./memory-temporal.js";
import {
  buildTimelineAggregatedFactsWithLlm,
  materializeTimelineAggregatedFacts
} from "./timeline-aggregation.js";
import { createFactBatchCommitted } from "./fact-batch.js";
import { enqueueFactBatchForTimelineFusion } from "./timeline-fusion-scheduler.js";

export type ParseAndAdmitStageOperation = "fact_fusion" | "stm_admission";

export interface ParseAndAdmitStageObservation {
  operation: ParseAndAdmitStageOperation;
  stageExecutionId: string;
  status: "started" | "succeeded" | "failed" | "skipped";
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  input: unknown;
  output?: unknown;
  error?: unknown;
}

export type ParseAndAdmitStageObserver = (
  observation: ParseAndAdmitStageObservation
) => void | Promise<void>;

export type ParseAndAdmitOptions = {
  llm?: LlmFactFusionOptions;
  disableFactFusionLlm?: boolean;
  disableStmAdmissionLlm?: boolean;
  skipStmAdmission?: boolean;
  skipTimelineFusion?: boolean;
  embeddingClient?: EmbeddingClient;
  stageObserver?: ParseAndAdmitStageObserver;
};

export type AdmitFactsToMemoryOptions = Pick<
  ParseAndAdmitOptions,
  "llm" | "disableStmAdmissionLlm" | "skipStmAdmission" | "embeddingClient"
> & {
  task?: ContextPipelineTask;
  fallbackSourceRefs: ShortTermMemory["sourceRefs"];
};

export async function parseAndAdmitEvent(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  task?: ContextPipelineTask,
  options: ParseAndAdmitOptions = {}
) {
  const parser = createParserAdapter();
  if (task) {
    task = await updatePipelineTask(repository, task, {
      taskType: "parse",
      status: "running",
      stage: "parse_started"
    });
  }
  const parsed = await parser.parse(event);

  for (const segment of parsed.segments) {
    await repository.saveParsedSegment(segment);
  }

  if (task) {
    task = await updatePipelineTask(repository, task, {
      taskType: "fusion",
      status: "running",
      stage: "fusion_started"
    });
  }
  const factFusion = await observeParseAndAdmitStage(options.stageObserver, "fact_fusion", {
    event,
    parsedSegments: parsed.segments,
    unsupportedItems: parsed.unsupportedItems,
    disableFactFusionLlm: options.disableFactFusionLlm === true,
    skipTimelineFusion: options.skipTimelineFusion === true
  }, async () => {
    const fusion = await createFactsWithLlmFusion(
      repository,
      event,
      parsed.segments,
      options.disableFactFusionLlm ? disableLlm(options.llm) : options.llm
    );
    const persistedFactIds: string[] = [];
    for (const fact of fusion.facts) {
      await repository.saveFactItem(fact);
      persistedFactIds.push(fact.factId);
    }

    let factBatch;
    if (fusion.facts.length) {
      factBatch = await repository.saveFactBatchCommitted(createFactBatchCommitted({
        triggerType: "event",
        sourceKey: event.eventId,
        tenantId: event.permissionSnapshot.tenantId,
        principalId: event.permissionSnapshot.principalId,
        ...(event.contextScopeId ? { contextScopeId: event.contextScopeId } : {}),
        factIds: fusion.facts.map((fact) => fact.factId),
        committedAt: new Date().toISOString()
      }));
      if (options.skipTimelineFusion !== true) {
        await enqueueFactBatchForTimelineFusion(repository, factBatch);
      }
    }

    const timelineLlm = options.disableFactFusionLlm ? disableLlm(options.llm) : options.llm;
    const aggregatedFacts = await buildTimelineAggregatedFactsWithLlm(fusion.facts, timelineLlm);
    const factsForAdmission = materializeTimelineAggregatedFacts(
      fusion.facts,
      aggregatedFacts,
      new Date().toISOString()
    );
    const originalFactIds = new Set(fusion.facts.map((fact) => fact.factId));
    for (const fact of factsForAdmission) {
      if (!originalFactIds.has(fact.factId)) {
        await repository.saveFactItem(fact);
        persistedFactIds.push(fact.factId);
      }
    }

    const changeEvents: MemoryChangeEvent[] = [];
    for (const rejected of fusion.rejectedSegments) {
      const changeEvent: MemoryChangeEvent = {
        eventId: `mce_${event.eventId}_${rejected.segmentId}`,
        memoryDataId: event.eventId,
        changeType: "updated",
        storageLayer: "fact",
        reason: `fact_rejected:${rejected.reason}`,
        createdAt: new Date().toISOString()
      };
      await repository.saveMemoryChangeEvent(changeEvent);
      changeEvents.push(changeEvent);
    }

    for (const item of parsed.unsupportedItems) {
      const changeEvent: MemoryChangeEvent = {
        eventId: `mce_${event.eventId}_${item.itemId}`,
        memoryDataId: event.eventId,
        changeType: "updated",
        storageLayer: "fact",
        reason: `unsupported_modality:${item.type}`,
        createdAt: new Date().toISOString()
      };
      await repository.saveMemoryChangeEvent(changeEvent);
      changeEvents.push(changeEvent);
    }
    return { fusion, aggregatedFacts, factsForAdmission, persistedFactIds, factBatch, changeEvents };
  });

  await observeParseAndAdmitStage(options.stageObserver, "stm_admission", {
    event,
    facts: factFusion.factsForAdmission,
    fallbackSourceRefs: parsed.sourceRefs,
    disableStmAdmissionLlm: options.disableStmAdmissionLlm === true,
    skipped: options.skipStmAdmission === true
  }, () => admitFactsToMemoryPipeline(repository, event, factFusion.factsForAdmission, {
    ...(options.llm ? { llm: options.llm } : {}),
    ...(options.disableStmAdmissionLlm !== undefined
      ? { disableStmAdmissionLlm: options.disableStmAdmissionLlm }
      : {}),
    ...(options.skipStmAdmission !== undefined ? { skipStmAdmission: options.skipStmAdmission } : {}),
    ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
    ...(task ? { task } : {}),
    fallbackSourceRefs: parsed.sourceRefs
  }), options.skipStmAdmission === true ? "skipped" : "succeeded");

  return parsed;
}

export async function admitFactsToMemoryPipeline(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  facts: readonly FactItem[],
  options: AdmitFactsToMemoryOptions
) {
  let task = options.task;
  if (task) {
    task = await updatePipelineTask(repository, task, {
      taskType: "admission",
      status: "running",
      stage: "admission_started"
    });
  }
  if (options.skipStmAdmission === true) {
    await repository.saveMemoryChangeEvent({
      eventId: `mce_${event.eventId}_stm_admission_skipped`,
      memoryDataId: event.eventId,
      changeType: "updated",
      storageLayer: "stm",
      reason: "stm_admission_skipped",
      createdAt: new Date().toISOString()
    });
    if (task) {
      await updatePipelineTask(repository, task, {
        taskType: "index",
        status: "succeeded",
        stage: "stm_admission_skipped_no_index",
        retryable: false
      });
    }
    return { admittedCount: 0, admissionResults: [], admittedMemories: [] };
  }
  if (task) {
    task = await updatePipelineTask(repository, task, {
      taskType: "index",
      status: "running",
      stage: "index_refresh_started"
    });
  }

  const admissionResults = await evaluateShortTermAdmissionsWithLlm(
    repository,
    event,
    [...facts],
    options.disableStmAdmissionLlm ? disableLlm(options.llm) : options.llm
  );
  const admissionByFactId = new Map(admissionResults.map((item) => [item.factId, item.decision]));
  const admittedMemories: ShortTermMemory[] = [];
  for (const fact of facts) {
    const admission = admissionByFactId.get(fact.factId);
    if (!admission) throw new Error(`STM admission omitted fact ${fact.factId}`);
    if (admission.result === "reject") {
      await repository.saveMemoryChangeEvent({
        eventId: `mce_${event.eventId}_${fact.factId}_stm_rejected`,
        memoryDataId: fact.factId,
        changeType: "updated",
        storageLayer: "stm",
        reason: `stm_rejected:${admission.reason}`,
        createdAt: new Date().toISOString()
      });
      continue;
    }

    const stm = buildShortTermMemoryFromFact(event, fact, admission, options.fallbackSourceRefs);
    await repository.saveShortTermMemory(stm);
    admittedMemories.push(stm);
  }

  await refreshShortTermMemoryIndexes(
    repository,
    admittedMemories,
    options.embeddingClient
  );
  for (const stm of admittedMemories) {
    await reconcileMemoryGraphForShortTermMemory(repository, stm.memoryDataId);
    await repository.saveMemoryChangeEvent({
      eventId: `mce_${event.eventId}_${stm.memoryDataId}`,
      memoryDataId: stm.memoryDataId,
      changeType: "created",
      storageLayer: "stm",
      reason: `stm_${stm.admissionResult}:${stm.admissionReason}`,
      createdAt: new Date().toISOString()
    });
  }
  const admittedCount = admittedMemories.length;

  if (task) {
    await updatePipelineTask(repository, task, {
      taskType: "index",
      status: "succeeded",
      stage: admittedCount > 0 ? "stm_index_refreshed" : "stm_rejected_no_index",
      retryable: false
    });
  }

  return { admittedCount, admissionResults, admittedMemories };
}

async function observeParseAndAdmitStage<T>(
  observer: ParseAndAdmitStageObserver | undefined,
  operation: ParseAndAdmitStageOperation,
  input: unknown,
  execute: () => Promise<T>,
  successStatus: "succeeded" | "skipped" = "succeeded"
): Promise<T> {
  if (!observer) return execute();
  const stageExecutionId = `${operation}_${randomUUID()}`;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  await observer({ operation, stageExecutionId, status: "started", startedAt, input });
  try {
    const output = await execute();
    await observer({
      operation,
      stageExecutionId,
      status: successStatus,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      input,
      output
    });
    return output;
  } catch (error) {
    await observer({
      operation,
      stageExecutionId,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      input,
      error
    });
    throw error;
  }
}

function disableLlm(options?: LlmFactFusionOptions): LlmFactFusionOptions {
  return {
    ...(options ?? {}),
    apiKey: ""
  };
}

function buildShortTermMemoryFromFact(
  event: MemoryEvent,
  fact: FactItem,
  admission: FactAdmissionDecision["decision"],
  fallbackSourceRefs: ShortTermMemory["sourceRefs"]
): ShortTermMemory {
  const facts = [fact];
  const memoryPayload = buildShortTermMemoryPayload(event, facts);
  const temporalMetadata = aggregateMemoryTemporalMetadata(facts.map(temporalMetadataFromFact));
  const sourceRefs = fact.linkedSourceRefs.length ? fact.linkedSourceRefs : fallbackSourceRefs;
  const now = new Date().toISOString();
  return {
    memoryDataId: `stm_${fact.factId}`,
    tenantId: event.permissionSnapshot.tenantId,
    principalId: event.permissionSnapshot.principalId,
    createdAt: now,
    updatedAt: now,
    memoryDataType: admission.memoryDataType ?? event.eventType,
    memoryType: inferShortTermMemoryType(event, facts),
    content: memoryPayload.content,
    structuredFacts: memoryPayload.structuredFacts,
    ...temporalMetadata,
    factSummary: summarizeFactsForMemory(facts, memoryPayload.content),
    summary: buildShortTermMemoryExplanation(event, facts, admission.reason),
    sourceFactIds: [fact.factId],
    sourceRefs,
    entityIds: fact.entityIds,
    importanceLevel: admission.importanceLevel,
    confidenceLevel: admission.confidenceLevel,
    admissionResult: admission.result,
    admissionReason: admission.reason,
    matchedRules: [...admission.matchedRules, "fact_level_stm", "write_event_bootstrap"],
    admissionSignals: {
      ...admission.signals,
      conflict: fact.status === "conflicted" ? "known" : admission.signals.conflict
    },
    lifecycleStatus: admission.lifecycleStatus,
    accessState: admission.accessState
  };
}
