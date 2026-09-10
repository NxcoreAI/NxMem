import type { ContextPipelineTask, MemoryChangeEvent, MemoryEvent } from "./domain.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { parseAndAdmitEvent, type ParseAndAdmitOptions } from "./parse-event.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { scheduleRetry, updatePipelineTask } from "./pipeline-task.js";
import type { ForegroundActivityGate } from "./foreground-activity-gate.js";
import {
  enqueueContextPipelineJob,
  getSharedContextPipelineQueueSnapshot
} from "./pipeline-job-queue.js";
export type { ContextPipelineQueueSnapshot } from "./pipeline-job-queue.js";

export async function enqueueEventPipeline(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  task: ContextPipelineTask,
  options: ParseAndAdmitOptions | LlmFactFusionOptions | undefined,
  throwOnError = false,
  activityGate?: ForegroundActivityGate
): Promise<{ completion: Promise<void> }> {
  const queuedTask = await updatePipelineTask(repository, task, {
    taskType: "ingest",
    status: "pending",
    stage: "queued"
  });
  const owner = {
    tenantId: event.permissionSnapshot.tenantId,
    principalId: event.permissionSnapshot.principalId
  };
  return {
    completion: enqueueContextPipelineJob(() => activityGate
      ? activityGate.run(owner, () => runEventPipeline(repository, event, queuedTask, normalizePipelineOptions(options), throwOnError))
      : runEventPipeline(repository, event, queuedTask, normalizePipelineOptions(options), throwOnError))
  };
}

export async function runEventPipeline(
  repository: ContextEngineRepository,
  event: MemoryEvent,
  task: ContextPipelineTask,
  options: ParseAndAdmitOptions | LlmFactFusionOptions | undefined,
  throwOnError: boolean
) {
  try {
    await parseAndAdmitEvent(repository, event, task, normalizePipelineOptions(options));
  } catch (error) {
    const failedTask = scheduleRetry(task, error);
    await repository.savePipelineTask(failedTask);
    const changeEvent: MemoryChangeEvent = {
      eventId: `mce_${event.eventId}_pipeline_failed`,
      memoryDataId: event.eventId,
      changeType: "updated",
      storageLayer: "fact",
      reason: `pipeline_failed:${failedTask.error}`,
      createdAt: new Date().toISOString()
    };
    await repository.saveMemoryChangeEvent(changeEvent);
    if (throwOnError) throw error;
  }
}

export function getContextPipelineQueueSnapshot() {
  return getSharedContextPipelineQueueSnapshot();
}

function normalizePipelineOptions(options: ParseAndAdmitOptions | LlmFactFusionOptions | undefined): ParseAndAdmitOptions {
  if (!options) return {};
  const parseOptions = options as ParseAndAdmitOptions;
  if (
    parseOptions.llm !== undefined ||
    parseOptions.disableFactFusionLlm !== undefined ||
    parseOptions.disableStmAdmissionLlm !== undefined
  ) {
    return parseOptions;
  }
  return { llm: options as LlmFactFusionOptions };
}
