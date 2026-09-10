import { createHash } from "node:crypto";
import type {
  DreamingCandidateDecision,
  DreamingCandidateDecisionType,
  DreamingCandidateReasonCode,
  FactItem,
  ShortTermMemory
} from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

export interface DreamingCandidateGateOptions {
  runId?: string;
  tenantId?: string;
  principalId?: string;
  memoryDataIds?: string[];
  now?: string;
  policyVersion?: string;
  retryAfter?: string;
}

export interface DreamingCandidateGateResult {
  runId: string;
  policyVersion: string;
  decisions: DreamingCandidateDecision[];
  accepted: ShortTermMemory[];
}

const DEFAULT_POLICY_VERSION = "dreaming-gate.v1";

export async function gateDreamingCandidates(
  repository: ContextEngineRepository,
  options: DreamingCandidateGateOptions = {}
): Promise<DreamingCandidateGateResult> {
  const now = options.now ?? new Date().toISOString();
  const runId = options.runId ?? `dreaming_run_${hash([options.tenantId, options.principalId, now].join("|"))}`;
  const policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;
  const requested = new Set(options.memoryDataIds ?? []);
  const snapshot = repository.getDebugSnapshot();
  const memories = snapshot.shortTermMemories
    .filter((memory) => requested.size
      ? requested.has(memory.memoryDataId) && !hasTerminalDreamingDecision(memory, policyVersion)
      : isDueForDreaming(memory, now, policyVersion))
    .sort((left, right) => left.memoryDataId.localeCompare(right.memoryDataId));
  const decisions: DreamingCandidateDecision[] = [];
  const accepted: ShortTermMemory[] = [];

  for (const memory of memories) {
    const sourceFacts = snapshot.facts.filter((fact) => memory.sourceFactIds.includes(fact.factId));
    const decision = evaluateDreamingCandidate(memory, sourceFacts, {
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options.principalId !== undefined ? { principalId: options.principalId } : {}),
      now,
      runId,
      policyVersion,
      ...(options.retryAfter !== undefined ? { retryAfter: options.retryAfter } : {})
    });
    decisions.push(decision);
    if (decision.decision === "accepted") {
      accepted.push(memory);
      await repository.replaceShortTermMemory({
        ...memory,
        consolidationStatus: "evaluating",
        lastEvaluatedAt: decision.evaluatedAt,
        latestDecisionId: decision.decisionId,
        dreamingPolicyVersion: policyVersion,
        updatedAt: decision.evaluatedAt
      });
      continue;
    }

    const status = decision.decision === "observe"
      ? "observing"
      : decision.decision === "retryable_failure"
        ? "retryable_failure"
        : "dropped";
    await repository.replaceShortTermMemory({
      ...memory,
      consolidationStatus: status,
      lastEvaluatedAt: decision.evaluatedAt,
      ...(decision.decision === "observe" ? { observeCount: (memory.observeCount ?? 0) + 1 } : {}),
      latestDecisionId: decision.decisionId,
      dreamingPolicyVersion: policyVersion,
      ...(decision.nextEvaluateAt ? { nextEvaluateAt: decision.nextEvaluateAt } : {}),
      updatedAt: decision.evaluatedAt
    });
  }

  for (const decision of decisions) {
    await repository.saveDreamingCandidateDecision(decision);
  }

  return { runId, policyVersion, decisions, accepted };
}

export function evaluateDreamingCandidate(
  memory: ShortTermMemory,
  sourceFacts: FactItem[],
  options: {
    tenantId?: string;
    principalId?: string;
    now: string;
    runId: string;
    policyVersion: string;
    retryAfter?: string;
  }
): DreamingCandidateDecision {
  const reasonCodes: DreamingCandidateReasonCode[] = [];
  if (options.tenantId !== undefined && memory.tenantId !== options.tenantId) reasonCodes.push("OWNER_MISMATCH");
  if (options.principalId !== undefined && memory.principalId !== options.principalId) reasonCodes.push("OWNER_MISMATCH");
  if (["deleted", "rejected", "pending_confirm"].includes(memory.lifecycleStatus)) reasonCodes.push("LIFECYCLE_INVALID");
  if (hasTerminalDreamingDecision(memory, options.policyVersion)) reasonCodes.push("CONSOLIDATION_ALREADY_COMPLETE");
  if (
    memory.consolidationStatus === "observing" &&
    !memory.reevaluationReason &&
    (!memory.nextEvaluateAt || memory.nextEvaluateAt > options.now)
  ) {
    reasonCodes.push("NOT_DUE_FOR_REEVALUATION");
  }
  if (
    (memory.consolidationStatus === "retryable_failure" || memory.consolidationStatus === "retry_wait") &&
    ((memory.nextEvaluateAt && memory.nextEvaluateAt > options.now) || (options.retryAfter && options.retryAfter > options.now))
  ) {
    reasonCodes.push("RETRY_NOT_DUE");
  }
  if (memory.accessState && memory.accessState !== "visible") reasonCodes.push("ACCESS_HIDDEN");
  if (!memory.sourceRefs.length && !memory.sourceFactIds.length) reasonCodes.push("SOURCE_MISSING");
  if (memory.sourceFactIds.length && sourceFacts.length > 0 && sourceFacts.length !== new Set(memory.sourceFactIds).size) reasonCodes.push("SOURCE_UNRESOLVED");
  if (sourceFacts.some((fact) => fact.status === "rejected" || fact.accessState && fact.accessState !== "visible")) {
    reasonCodes.push("SOURCE_UNRESOLVED");
  }
  if (memory.admissionSignals.sensitivity === "high" && memory.sourceRefs.some((ref) => ref.metadata?.sensitiveAuthorized === false)) {
    reasonCodes.push("SENSITIVE_AUTHORIZATION_REQUIRED");
  }
  if (memory.confidenceLevel === "low") reasonCodes.push("LOW_CONFIDENCE");

  const uniqueReasons = [...new Set(reasonCodes)];
  const decision: DreamingCandidateDecisionType = uniqueReasons.length
    ? uniqueReasons.includes("SOURCE_UNRESOLVED") || uniqueReasons.includes("SOURCE_MISSING")
      ? "drop"
      : uniqueReasons.includes("NOT_DUE_FOR_REEVALUATION") || uniqueReasons.includes("LOW_CONFIDENCE") || uniqueReasons.includes("RETRY_NOT_DUE")
        ? "observe"
        : uniqueReasons.includes("OWNER_MISMATCH") || uniqueReasons.includes("LIFECYCLE_INVALID") || uniqueReasons.includes("ACCESS_HIDDEN") || uniqueReasons.includes("SENSITIVE_AUTHORIZATION_REQUIRED")
          ? "drop"
          : "observe"
    : "accepted";
  const fingerprint = hash([
    memory.tenantId,
    memory.principalId,
    memory.memoryDataId,
    memory.updatedAt,
    options.policyVersion
  ].join("|"));
  const evaluatedAt = options.now;
  return {
    decisionId: `dream_decision_${hash(`${fingerprint}:${options.runId}`)}`,
    runId: options.runId,
    candidateFingerprint: fingerprint,
    memoryDataId: memory.memoryDataId,
    tenantId: memory.tenantId,
    principalId: memory.principalId,
    decision,
    reasonCodes: uniqueReasons,
    sourceFactIds: memory.sourceFactIds,
    sourceRefs: memory.sourceRefs,
    permissionSnapshotIds: [],
    policyVersion: options.policyVersion,
    traceId: `dream_gate_trace_${hash(`${fingerprint}:${evaluatedAt}`)}`,
    evaluatedAt,
    ...(decision === "observe" ? { nextEvaluateAt: new Date(Date.parse(evaluatedAt) + 24 * 60 * 60 * 1000).toISOString() } : {}),
    createdAt: evaluatedAt
  };
}

function isDueForDreaming(memory: ShortTermMemory, now: string, policyVersion: string) {
  if (["deleted", "rejected", "pending_confirm"].includes(memory.lifecycleStatus)) return false;
  if (hasTerminalDreamingDecision(memory, policyVersion)) return false;
  if (memory.consolidationStatus === "observing" && !memory.reevaluationReason && (!memory.nextEvaluateAt || memory.nextEvaluateAt > now)) return false;
  if (
    (memory.consolidationStatus === "retryable_failure" || memory.consolidationStatus === "retry_wait") &&
    memory.nextEvaluateAt && memory.nextEvaluateAt > now
  ) return false;
  return memory.lifecycleStatus === "active" || memory.lifecycleStatus === "expired" || memory.lifecycleStatus === "candidate_queue";
}

function hasTerminalDreamingDecision(memory: ShortTermMemory, policyVersion: string) {
  return (memory.consolidationStatus === "consolidated" || memory.consolidationStatus === "dropped") &&
    memory.dreamingPolicyVersion === policyVersion &&
    !memory.reevaluationReason;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
