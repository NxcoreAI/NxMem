import type { ContextPipelineTask, MemoryEvent } from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

export const maxPipelineAttempts = 3;

export function createPipelineTask(event: MemoryEvent, attempt = 1): ContextPipelineTask {
  const now = new Date().toISOString();
  return {
    taskId: `ingest_${event.eventId}`,
    eventId: event.eventId,
    taskType: "ingest",
    status: "pending",
    attempt,
    maxAttempts: maxPipelineAttempts,
    retryable: true,
    stage: "created",
    createdAt: now,
    updatedAt: now
  };
}

export async function updatePipelineTask(
  repository: ContextEngineRepository,
  task: ContextPipelineTask,
  patch: Partial<Pick<ContextPipelineTask, "taskType" | "status" | "stage" | "error" | "retryAfter" | "retryable">>
): Promise<ContextPipelineTask> {
  const updated: ContextPipelineTask = {
    ...task,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await repository.savePipelineTask(updated);
  return updated;
}

export function scheduleRetry(task: ContextPipelineTask, error: unknown): ContextPipelineTask {
  const now = Date.now();
  const retryable = task.attempt < task.maxAttempts;
  return {
    ...task,
    status: retryable ? "retry_scheduled" : "failed",
    retryable,
    error: formatPipelineError(error),
    ...(retryable ? { retryAfter: new Date(now + task.attempt * 1_000).toISOString() } : {}),
    updatedAt: new Date(now).toISOString()
  };
}

export function formatPipelineError(error: unknown): string {
  return error instanceof Error ? error.message : "pipeline_task_failed";
}
