import type { FactBatchCommitted, TimelineFusionTask } from "./domain.js";

const TIMELINE_FUSION_TASK_STATUSES = new Set<TimelineFusionTask["status"]>([
  "pending",
  "ready",
  "running",
  "succeeded",
  "failed"
]);
const TIMELINE_FUSION_COMPLETION_REASONS = new Set<NonNullable<TimelineFusionTask["completionReason"]>>([
  "no_candidate",
  "no_temporal_window"
]);

export interface CreateTimelineFusionTaskInput {
  batch: FactBatchCommitted;
  now: string;
  debounceMs: number;
  maxWaitMs: number;
}

export function createTimelineFusionTask(input: CreateTimelineFusionTaskInput): TimelineFusionTask {
  const now = requiredInstant(input.now, "now");
  const deadlineAt = addMilliseconds(now, nonNegativeInteger(input.maxWaitMs, "maxWaitMs"));
  const scheduledAt = earlierInstant(
    addMilliseconds(now, nonNegativeInteger(input.debounceMs, "debounceMs")),
    deadlineAt
  );
  return normalizeTimelineFusionTask({
    taskId: `timeline_fusion_${input.batch.batchId}`,
    tenantId: input.batch.tenantId,
    principalId: input.batch.principalId,
    ...(input.batch.contextScopeId ? { contextScopeId: input.batch.contextScopeId } : {}),
    batchIds: [input.batch.batchId],
    newFactIds: input.batch.newFactIds,
    status: "pending",
    scheduledAt,
    deadlineAt,
    createdAt: now,
    updatedAt: now
  });
}

export function mergeTimelineFusionTask(
  task: TimelineFusionTask,
  batch: FactBatchCommitted,
  now: string,
  debounceMs: number
): TimelineFusionTask {
  if (task.status !== "pending") throw new Error(`timeline_fusion_task_not_pending:${task.taskId}`);
  if (
    task.tenantId !== batch.tenantId ||
    task.principalId !== batch.principalId ||
    task.contextScopeId !== batch.contextScopeId
  ) {
    throw new Error(`timeline_fusion_task_scope_mismatch:${task.taskId}`);
  }
  const updatedAt = requiredInstant(now, "now");
  return normalizeTimelineFusionTask({
    ...task,
    batchIds: [...task.batchIds, batch.batchId],
    newFactIds: [...task.newFactIds, ...batch.newFactIds],
    scheduledAt: earlierInstant(
      addMilliseconds(updatedAt, nonNegativeInteger(debounceMs, "debounceMs")),
      task.deadlineAt
    ),
    updatedAt
  });
}

export function normalizeTimelineFusionTask(task: TimelineFusionTask): TimelineFusionTask {
  if (!TIMELINE_FUSION_TASK_STATUSES.has(task.status)) {
    throw new Error(`timeline_fusion_task_status_invalid:${String(task.status)}`);
  }
  if (task.completionReason && !TIMELINE_FUSION_COMPLETION_REASONS.has(task.completionReason)) {
    throw new Error(`timeline_fusion_task_completion_reason_invalid:${String(task.completionReason)}`);
  }
  if (task.completionReason && task.status !== "succeeded") {
    throw new Error(`timeline_fusion_task_completion_reason_before_success:${task.taskId}`);
  }
  const scheduledAt = requiredInstant(task.scheduledAt, "scheduledAt");
  const deadlineAt = requiredInstant(task.deadlineAt, "deadlineAt");
  if (Date.parse(scheduledAt) > Date.parse(deadlineAt)) {
    throw new Error(`timeline_fusion_task_schedule_after_deadline:${task.taskId}`);
  }
  const batchIds = uniqueStrings(task.batchIds);
  const newFactIds = uniqueStrings(task.newFactIds);
  const executionFingerprints = uniqueStrings(task.executionFingerprints ?? []);
  const contextScopeId = optionalText(task.contextScopeId);
  if (!batchIds.length || !newFactIds.length) {
    throw new Error(`timeline_fusion_task_empty:${task.taskId}`);
  }
  return {
    taskId: requiredText(task.taskId, "taskId"),
    tenantId: requiredText(task.tenantId, "tenantId"),
    principalId: requiredText(task.principalId, "principalId"),
    ...(contextScopeId ? { contextScopeId } : {}),
    batchIds,
    newFactIds,
    status: task.status,
    scheduledAt,
    deadlineAt,
    ...(task.readyAt ? { readyAt: requiredInstant(task.readyAt, "readyAt") } : {}),
    ...(executionFingerprints.length ? { executionFingerprints } : {}),
    ...(task.completionReason ? { completionReason: task.completionReason } : {}),
    ...(task.completedAt ? { completedAt: requiredInstant(task.completedAt, "completedAt") } : {}),
    ...(task.error ? { error: task.error } : {}),
    createdAt: requiredInstant(task.createdAt, "createdAt"),
    updatedAt: requiredInstant(task.updatedAt, "updatedAt")
  };
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function requiredText(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`timeline_fusion_task_${field}_required`);
  return normalized;
}

function requiredInstant(value: string, field: string) {
  const normalized = requiredText(value, field);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`timeline_fusion_task_${field}_invalid`);
  }
  return normalized;
}

function optionalText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`timeline_fusion_task_${field}_invalid`);
  }
  return value;
}

function addMilliseconds(instant: string, milliseconds: number) {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

function earlierInstant(left: string, right: string) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}
