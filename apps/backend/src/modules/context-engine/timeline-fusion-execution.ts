import { createHash } from "node:crypto";
import type {
  TimelineFusionExecution,
  TimelineFusionWindow
} from "./domain.js";

const WINDOW_BASES = new Set<TimelineFusionWindow["basis"]>([
  "evidence",
  "valid",
  "weak_anchor"
]);
const EXECUTION_STATUSES = new Set<TimelineFusionExecution["status"]>([
  "pending",
  "running",
  "succeeded",
  "failed"
]);

export interface CreateTimelineFusionExecutionInput {
  tenantId: string;
  principalId: string;
  contextScopeId?: string;
  taskIds: readonly string[];
  batchIds: readonly string[];
  newFactIds: readonly string[];
  temporalWindow: TimelineFusionWindow;
  fusionPolicyVersion: string;
  createdAt: string;
}

export class TimelineFusionExecutionError extends Error {
  constructor(
    readonly code:
      | "TIMELINE_FUSION_EXECUTION_INVALID"
      | "TIMELINE_FUSION_EXECUTION_NOT_FOUND"
      | "TIMELINE_FUSION_EXECUTION_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "TimelineFusionExecutionError";
  }
}

export function createTimelineFusionExecution(
  input: CreateTimelineFusionExecutionInput
): TimelineFusionExecution {
  const tenantId = requiredText(input.tenantId, "tenantId");
  const principalId = requiredText(input.principalId, "principalId");
  const contextScopeId = optionalText(input.contextScopeId);
  const taskIds = requiredIds(input.taskIds, "taskIds");
  const batchIds = requiredIds(input.batchIds, "batchIds");
  const newFactIds = requiredIds(input.newFactIds, "newFactIds");
  const temporalWindow = normalizeTimelineFusionWindow(input.temporalWindow);
  const fusionPolicyVersion = requiredText(input.fusionPolicyVersion, "fusionPolicyVersion");
  const createdAt = requiredInstant(input.createdAt, "createdAt");
  const fingerprint = createTimelineFusionFingerprint({
    tenantId,
    principalId,
    ...(contextScopeId ? { contextScopeId } : {}),
    newFactIds,
    temporalWindow,
    fusionPolicyVersion
  });
  return {
    executionId: `timeline_fusion_execution_${fingerprint.slice(-24)}`,
    fingerprint,
    tenantId,
    principalId,
    ...(contextScopeId ? { contextScopeId } : {}),
    taskIds,
    batchIds,
    newFactIds,
    temporalWindow,
    fusionPolicyVersion,
    status: "pending",
    resultFactIds: [],
    attempt: 0,
    createdAt,
    updatedAt: createdAt
  };
}

export function createTimelineFusionFingerprint(input: {
  tenantId: string;
  principalId: string;
  contextScopeId?: string;
  newFactIds: readonly string[];
  temporalWindow: TimelineFusionWindow;
  fusionPolicyVersion: string;
}) {
  const contextScopeId = optionalText(input.contextScopeId);
  const canonical = JSON.stringify({
    tenantId: requiredText(input.tenantId, "tenantId"),
    principalId: requiredText(input.principalId, "principalId"),
    ...(contextScopeId ? { contextScopeId } : {}),
    newFactIds: requiredIds(input.newFactIds, "newFactIds"),
    temporalWindow: normalizeTimelineFusionWindow(input.temporalWindow),
    fusionPolicyVersion: requiredText(input.fusionPolicyVersion, "fusionPolicyVersion")
  });
  return `timeline_fusion_v1_${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function normalizeTimelineFusionExecution(
  execution: TimelineFusionExecution
): TimelineFusionExecution {
  if (!EXECUTION_STATUSES.has(execution.status)) {
    throw invalid(`Unsupported execution status: ${String(execution.status)}`);
  }
  if (execution.completionReason && execution.completionReason !== "no_candidate") {
    throw invalid(`Unsupported completion reason: ${String(execution.completionReason)}`);
  }
  if (execution.completionReason && execution.status !== "succeeded") {
    throw invalid("Execution completionReason requires succeeded status.");
  }
  const tenantId = requiredText(execution.tenantId, "tenantId");
  const principalId = requiredText(execution.principalId, "principalId");
  const contextScopeId = optionalText(execution.contextScopeId);
  const taskIds = requiredIds(execution.taskIds, "taskIds");
  const batchIds = requiredIds(execution.batchIds, "batchIds");
  const newFactIds = requiredIds(execution.newFactIds, "newFactIds");
  const temporalWindow = normalizeTimelineFusionWindow(execution.temporalWindow);
  const fusionPolicyVersion = requiredText(execution.fusionPolicyVersion, "fusionPolicyVersion");
  const fingerprint = createTimelineFusionFingerprint({
    tenantId,
    principalId,
    ...(contextScopeId ? { contextScopeId } : {}),
    newFactIds,
    temporalWindow,
    fusionPolicyVersion
  });
  if (execution.fingerprint !== fingerprint) {
    throw invalid("Execution fingerprint does not match its canonical fusion input.");
  }
  const attempt = nonNegativeInteger(execution.attempt, "attempt");
  const resultFactIds = normalizeIds(execution.resultFactIds);
  const createdAt = requiredInstant(execution.createdAt, "createdAt");
  const updatedAt = requiredInstant(execution.updatedAt, "updatedAt");
  const completedAt = execution.completedAt
    ? requiredInstant(execution.completedAt, "completedAt")
    : undefined;
  const leaseExpiresAt = execution.leaseExpiresAt
    ? requiredInstant(execution.leaseExpiresAt, "leaseExpiresAt")
    : undefined;
  if (execution.status === "succeeded" && !completedAt) {
    throw invalid("A succeeded execution requires completedAt.");
  }
  return {
    executionId: requiredText(execution.executionId, "executionId"),
    fingerprint,
    tenantId,
    principalId,
    ...(contextScopeId ? { contextScopeId } : {}),
    taskIds,
    batchIds,
    newFactIds,
    temporalWindow,
    fusionPolicyVersion,
    status: execution.status,
    resultFactIds,
    attempt,
    ...(execution.leaseOwner ? { leaseOwner: requiredText(execution.leaseOwner, "leaseOwner") } : {}),
    ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
    ...(execution.completionReason ? { completionReason: execution.completionReason } : {}),
    ...(execution.error ? { error: execution.error } : {}),
    createdAt,
    updatedAt,
    ...(completedAt ? { completedAt } : {})
  };
}

export function sameTimelineFusionReservation(
  left: TimelineFusionExecution,
  right: TimelineFusionExecution
) {
  return left.fingerprint === right.fingerprint &&
    left.executionId === right.executionId &&
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId &&
    left.contextScopeId === right.contextScopeId &&
    sameStrings(left.taskIds, right.taskIds) &&
    sameStrings(left.batchIds, right.batchIds) &&
    sameStrings(left.newFactIds, right.newFactIds) &&
    left.temporalWindow.basis === right.temporalWindow.basis &&
    left.temporalWindow.startAt === right.temporalWindow.startAt &&
    left.temporalWindow.endAt === right.temporalWindow.endAt &&
    left.fusionPolicyVersion === right.fusionPolicyVersion;
}

export function normalizeTimelineFusionWindow(window: TimelineFusionWindow): TimelineFusionWindow {
  if (!WINDOW_BASES.has(window.basis)) {
    throw invalid(`Unsupported temporal window basis: ${String(window.basis)}`);
  }
  const startAt = requiredInstant(window.startAt, "temporalWindow.startAt");
  const endAt = requiredInstant(window.endAt, "temporalWindow.endAt");
  if (Date.parse(startAt) > Date.parse(endAt)) {
    throw invalid("Temporal window startAt must not be after endAt.");
  }
  return { basis: window.basis, startAt, endAt };
}

function requiredIds(values: readonly string[], field: string) {
  const normalized = normalizeIds(values);
  if (!normalized.length) throw invalid(`${field} must contain at least one ID.`);
  return normalized;
}

function normalizeIds(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function requiredText(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw invalid(`${field} is required.`);
  return normalized;
}

function optionalText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function requiredInstant(value: string, field: string) {
  const normalized = requiredText(value, field);
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) throw invalid(`${field} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) throw invalid(`${field} must be a non-negative integer.`);
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(message: string) {
  return new TimelineFusionExecutionError("TIMELINE_FUSION_EXECUTION_INVALID", message);
}
