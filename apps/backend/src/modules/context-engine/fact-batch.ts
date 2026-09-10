import { createHash } from "node:crypto";
import type { FactBatchCommitted } from "./domain.js";

const FACT_BATCH_TRIGGER_TYPES = new Set<FactBatchCommitted["triggerType"]>([
  "event",
  "conversation_session",
  "ingestion_job",
  "manual_correction",
  "backfill"
]);

export interface CreateFactBatchCommittedInput {
  triggerType: FactBatchCommitted["triggerType"];
  sourceKey: string;
  tenantId: string;
  principalId: string;
  contextScopeId?: string;
  factIds: readonly string[];
  committedAt: string;
}

export class FactBatchCommitError extends Error {
  constructor(
    readonly code: "FACT_BATCH_INVALID" | "FACT_BATCH_FACTS_MISSING" | "FACT_BATCH_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "FactBatchCommitError";
  }
}

export function createFactBatchCommitted(input: CreateFactBatchCommittedInput): FactBatchCommitted {
  const triggerType = requiredTriggerType(input.triggerType);
  const sourceKey = requiredText(input.sourceKey, "sourceKey");
  const tenantId = requiredText(input.tenantId, "tenantId");
  const principalId = requiredText(input.principalId, "principalId");
  const contextScopeId = optionalText(input.contextScopeId);
  const committedAt = requiredIsoTimestamp(input.committedAt, "committedAt");
  const newFactIds = normalizeFactIds(input.factIds);
  if (!newFactIds.length) {
    throw new FactBatchCommitError("FACT_BATCH_INVALID", "Fact batch must contain at least one fact ID.");
  }

  const stableKey = JSON.stringify(contextScopeId
    ? [triggerType, tenantId, principalId, contextScopeId, sourceKey]
    : [triggerType, tenantId, principalId, sourceKey]);
  const digest = createHash("sha256").update(stableKey, "utf8").digest("hex").slice(0, 24);
  return {
    batchId: `fact_batch_${digest}`,
    triggerType,
    tenantId,
    principalId,
    ...(contextScopeId ? { contextScopeId } : {}),
    newFactIds,
    committedAt
  };
}

export function normalizeFactBatchCommitted(batch: FactBatchCommitted): FactBatchCommitted {
  const newFactIds = normalizeFactIds(batch.newFactIds);
  const contextScopeId = optionalText(batch.contextScopeId);
  if (!newFactIds.length) {
    throw new FactBatchCommitError("FACT_BATCH_INVALID", "Fact batch must contain at least one fact ID.");
  }
  return {
    batchId: requiredText(batch.batchId, "batchId"),
    triggerType: requiredTriggerType(batch.triggerType),
    tenantId: requiredText(batch.tenantId, "tenantId"),
    principalId: requiredText(batch.principalId, "principalId"),
    ...(contextScopeId ? { contextScopeId } : {}),
    newFactIds,
    committedAt: requiredIsoTimestamp(batch.committedAt, "committedAt")
  };
}

function requiredTriggerType(value: FactBatchCommitted["triggerType"]) {
  if (!FACT_BATCH_TRIGGER_TYPES.has(value)) {
    throw new FactBatchCommitError("FACT_BATCH_INVALID", `Unsupported triggerType: ${String(value)}`);
  }
  return value;
}

export function sameFactBatchCommit(
  left: FactBatchCommitted,
  right: FactBatchCommitted
) {
  return left.batchId === right.batchId &&
    left.triggerType === right.triggerType &&
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId &&
    left.contextScopeId === right.contextScopeId &&
    left.newFactIds.length === right.newFactIds.length &&
    left.newFactIds.every((factId, index) => factId === right.newFactIds[index]);
}

function normalizeFactIds(factIds: readonly string[]) {
  return [...new Set(factIds.map((factId) => factId.trim()).filter(Boolean))].sort();
}

function requiredText(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new FactBatchCommitError("FACT_BATCH_INVALID", `${field} is required.`);
  }
  return normalized;
}

function optionalText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function requiredIsoTimestamp(value: string, field: string) {
  const normalized = requiredText(value, field);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new FactBatchCommitError("FACT_BATCH_INVALID", `${field} must be an ISO timestamp.`);
  }
  return normalized;
}
