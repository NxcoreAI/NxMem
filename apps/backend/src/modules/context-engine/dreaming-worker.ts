import type {
  DreamingReevaluationTier,
  DreamingRun,
  DreamingRunCandidate,
  DreamingStmDecision,
  DreamingStmEvaluation,
  ShortTermMemory,
  LongTermMemory,
  DreamingLtmOperation,
  DreamingCandidateDecision,
  LlmDreamingTrace,
  MemoryChangeEvent,
  RelationEdge
} from "./domain.js";
import {
  calculateDreamingNextEvaluateAt,
  selectDreamingReevaluationTier
} from "./dreaming-reevaluation-policy.js";
import {
  runLlmDreaming,
  createDreamingConsolidationKey,
  type LlmDreamingOptions,
  type LlmDreamingResult
} from "./llm-dreaming.js";
import {
  enqueueDreamingIndexRefresh,
  processDreamingOutbox,
  enqueueDreamingStmIndexRefresh
} from "./llm-dreaming.js";
import { createDreamingOperationEdge } from "./dreaming-ltm-operations.js";
import { reconcileMemoryGraphForLongTermMemory } from "./memory-graph.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

const DEFAULT_LEASE_DURATION_MS = 60_000;
const MAX_CYCLE_ATTEMPTS = 3;

export interface SingleStmEvaluationResult {
  evaluation: DreamingStmEvaluation;
  longTermMemory?: LongTermMemory;
  ltmOperation?: DreamingLtmOperation;
  trace?: LlmDreamingTrace;
  traceId?: string;
  resultLtmId?: string;
  reevaluationTier?: DreamingReevaluationTier;
}

export interface EvaluateSingleStmInput {
  repository: ContextEngineRepository;
  run: DreamingRun;
  candidate: DreamingRunCandidate;
  memory: ShortTermMemory;
  now: string;
  signal?: AbortSignal;
}

export type SingleStmEvaluator = (input: EvaluateSingleStmInput) => Promise<SingleStmEvaluationResult>;

export interface DreamingWorkerOptions {
  evaluator?: SingleStmEvaluator;
  llm?: Omit<LlmDreamingOptions, "memoryDataIds" | "tenantId" | "principalId" | "runId" | "policyVersion" | "now" | "signal">;
  timezone?: string;
  leaseDurationMs?: number;
  candidateLeaseDurationMs?: number;
  runLeaseDurationMs?: number;
  now?: () => string;
}

export interface ProcessDreamingRunInput {
  tenantId: string;
  principalId: string;
  workerId: string;
  now?: string;
  signal?: AbortSignal;
}

export interface ProcessDreamingRunResult {
  run: DreamingRun;
  processedCandidateCount: number;
  completed: boolean;
}

export class DreamingWorker {
  private readonly evaluator: SingleStmEvaluator;
  private readonly timezone: string;
  private readonly candidateLeaseDurationMs: number;
  private readonly runLeaseDurationMs: number;
  private readonly now: () => string;

  constructor(
    private readonly repository: ContextEngineRepository,
    options: DreamingWorkerOptions = {}
  ) {
    this.timezone = options.timezone ?? "Asia/Shanghai";
    this.candidateLeaseDurationMs = options.candidateLeaseDurationMs ?? options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.runLeaseDurationMs = options.runLeaseDurationMs ?? options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? (() => new Date().toISOString());
    this.evaluator = options.evaluator ?? ((input) => evaluateSingleStmWithLlm(input, options.llm));
  }

  async processNextRun(input: ProcessDreamingRunInput): Promise<ProcessDreamingRunResult | undefined> {
    const claimedAt = normalizeInstant(input.now ?? this.now());
    const run = await this.repository.claimNextDreamingRun({
      tenantId: input.tenantId,
      principalId: input.principalId,
      claimedBy: input.workerId,
      claimedAt,
      leaseExpiresAt: addMilliseconds(claimedAt, this.runLeaseDurationMs)
    });
    if (!run) return undefined;
    return this.processClaimedRun(run, input);
  }

  async processRun(runId: string, input: Omit<ProcessDreamingRunInput, "tenantId" | "principalId"> & {
    tenantId: string;
    principalId: string;
  }): Promise<ProcessDreamingRunResult | undefined> {
    const existing = await this.repository.getDreamingRun(runId);
    if (!existing || existing.tenantId !== input.tenantId || existing.principalId !== input.principalId) return undefined;
    const requestedNow = normalizeInstant(input.now ?? this.now());
    let run = existing;
    if (run.status === "queued" || (run.status === "running" && run.leaseExpiresAt !== undefined && run.leaseExpiresAt <= requestedNow)) {
      const claimed = await this.repository.claimNextDreamingRun({
        tenantId: input.tenantId,
        principalId: input.principalId,
        claimedBy: input.workerId,
        claimedAt: requestedNow,
        leaseExpiresAt: addMilliseconds(requestedNow, this.runLeaseDurationMs)
      });
      if (!claimed || claimed.runId !== runId) return undefined;
      run = claimed;
    } else if (run.status !== "running" || run.leaseOwner !== input.workerId) {
      return undefined;
    }
    return this.processClaimedRun(run, input);
  }

  private async processClaimedRun(run: DreamingRun, input: ProcessDreamingRunInput) {
    let currentRun = run;
    let processedCandidateCount = 0;
    while (true) {
      const now = normalizeInstant(this.now());
      await this.repository.saveDreamingRun({
        ...currentRun,
        leaseOwner: input.workerId,
        leaseExpiresAt: addMilliseconds(now, this.runLeaseDurationMs),
        updatedAt: now
      });
      const candidate = await this.repository.claimNextDreamingRunCandidate({
        runId: currentRun.runId,
        claimedBy: input.workerId,
        claimedAt: now,
        leaseExpiresAt: addMilliseconds(now, this.candidateLeaseDurationMs)
      });
      if (!candidate) break;
      processedCandidateCount += 1;
      const interrupted = await this.processCandidate(currentRun, candidate, input);
      currentRun = await this.repository.getDreamingRun(currentRun.runId) ?? currentRun;
      if (interrupted || input.signal?.aborted) break;
    }

    const candidates = await this.repository.listDreamingRunCandidates(currentRun.runId);
    const completed = candidates.every((candidate) => isTerminalCandidateStatus(candidate.status));
    const now = normalizeInstant(this.now());
    const refreshed = summarizeRun(currentRun, candidates, now, completed ? { completedAt: now } : {});
    const nextRun: DreamingRun = {
      ...refreshed,
      ...(completed ? { status: "completed" as const } : {
        status: "running" as const,
        leaseOwner: input.workerId,
        leaseExpiresAt: addMilliseconds(now, this.runLeaseDurationMs)
      })
    };
    if (completed) {
      delete nextRun.leaseOwner;
      delete nextRun.leaseExpiresAt;
    }
    await this.repository.saveDreamingRun(nextRun);
    return {
      run: await this.repository.getDreamingRun(currentRun.runId) ?? refreshed,
      processedCandidateCount,
      completed
    };
  }

  private async processCandidate(
    run: DreamingRun,
    claimedCandidate: DreamingRunCandidate,
    input: ProcessDreamingRunInput
  ): Promise<boolean> {
    const now = normalizeInstant(this.now());
    const memory = await this.repository.getShortTermMemory(claimedCandidate.memoryDataId);
    const previousCycleAttemptCount = claimedCandidate.cycleAttemptCount;
    const previousTotalAttemptCount = claimedCandidate.totalAttemptCount;
    const cycleAttemptCount = previousCycleAttemptCount + 1;
    const totalAttemptCount = previousTotalAttemptCount + 1;
    const preparedCandidate: DreamingRunCandidate = {
      ...claimedCandidate,
      cycleAttemptCount,
      totalAttemptCount,
      updatedAt: now
    };
    await this.repository.saveDreamingRunCandidate(preparedCandidate);
    if (memory) {
      await this.repository.replaceShortTermMemory({
        ...memory,
        consolidationStatus: "evaluating",
        cycleAttemptCount,
        totalAttemptCount,
        latestDreamingRunId: run.runId,
        dreamingPolicyVersion: run.policyVersion,
        lastEvaluatedAt: now,
        updatedAt: now
      });
    }

    try {
      if (!memory) throw new DreamingCandidateUnavailableError("stm_missing");
      if (memory.tenantId !== run.tenantId || memory.principalId !== run.principalId) {
        throw new DreamingCandidateUnavailableError("owner_mismatch");
      }
      if (memory.lifecycleStatus === "deleted" || memory.accessState === "permission-invalid") {
        throw new DreamingCandidateUnavailableError(memory.accessState === "permission-invalid" ? "permission_invalid" : "stm_deleted");
      }
      const result = await this.evaluator({
        repository: this.repository,
        run,
        candidate: preparedCandidate,
        memory,
        now,
        ...(input.signal ? { signal: input.signal } : {})
      });
      if (!result.evaluation || result.evaluation.memoryDataId !== memory.memoryDataId) {
        throw new Error("DREAMING_SINGLE_STM_EVALUATION_INVALID");
      }
      await commitSingleDreamingResult(this.repository, {
        run,
        candidate: preparedCandidate,
        memory,
        result,
        timezone: this.timezone,
        now
      });
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) {
        await restoreInterruptedCandidate(this.repository, run, claimedCandidate, memory, now);
        return true;
      }
      await commitSingleDreamingFailure(this.repository, {
        run,
        candidate: preparedCandidate,
        ...(memory ? { memory } : {}),
        error,
        now,
        timezone: this.timezone,
        unavailable: error instanceof DreamingCandidateUnavailableError
      });
    }
    return false;
  }
}

export async function evaluateSingleStmWithLlm(
  input: EvaluateSingleStmInput,
  options: DreamingWorkerOptions["llm"] = {}
): Promise<SingleStmEvaluationResult> {
  const result: LlmDreamingResult = await runLlmDreaming(input.repository, {
    ...(options ?? {}),
    memoryDataIds: [input.memory.memoryDataId],
    tenantId: input.run.tenantId,
    principalId: input.run.principalId,
    runId: input.run.runId,
    policyVersion: input.run.policyVersion,
    now: input.now,
    maxAttempts: 1,
    persistResults: false,
    ...(input.signal ? { signal: input.signal } : {})
  });
  const evaluation = result.stmEvaluations?.find((item) => item.memoryDataId === input.memory.memoryDataId);
  if (result.fallbackReason || !evaluation) {
    throw new Error(`DREAMING_SINGLE_STM_FAILED:${result.fallbackReason ?? "evaluation_missing"}`);
  }
  const ltm = result.longTermMemories.find((item) => item.sourceMemoryDataIds.includes(input.memory.memoryDataId));
  return {
    evaluation,
    ...(result.longTermMemories[0] ? { longTermMemory: result.longTermMemories[0] } : {}),
    ...(result.ltmOperations?.[0] ? { ltmOperation: result.ltmOperations[0] } : {}),
    trace: result.trace,
    ...(result.trace.traceId ? { traceId: result.trace.traceId } : {}),
    ...(ltm?.memoryId ? { resultLtmId: ltm.memoryId } : {}),
    ...(evaluation.decision === "observe" ? { reevaluationTier: selectDreamingReevaluationTier(evaluation) } : {})
  };
}

export async function commitSingleDreamingResult(
  repository: ContextEngineRepository,
  input: {
    run: DreamingRun;
    candidate: DreamingRunCandidate;
    memory: ShortTermMemory;
    result: SingleStmEvaluationResult;
    timezone: string;
    now: string;
  }
) {
  const decision = input.result.evaluation.decision;
  const tier = decision === "observe"
    ? input.result.reevaluationTier ?? selectDreamingReevaluationTier(input.result.evaluation)
    : undefined;
  const nextEvaluateAt = tier
    ? calculateDreamingNextEvaluateAt(input.run.candidateCutoffAt, tier, input.timezone)
    : undefined;
  const traceId = input.result.trace?.traceId ?? input.result.traceId ?? `dream_worker_trace_${input.candidate.runCandidateId}`;
  const decisionId = `dream_final_decision_${input.candidate.runCandidateId}`;
  await repository.withDreamingTransaction(async () => {
    const current = await repository.getShortTermMemory(input.memory.memoryDataId) ?? input.memory;
    const updated: ShortTermMemory = {
      ...current,
      consolidationStatus: decision === "consolidate" ? "consolidated" : decision === "observe" ? "observing" : "dropped",
      ...(decision === "consolidate" ? { lifecycleStatus: "consolidated" as const } : {}),
      lastEvaluatedAt: input.result.evaluation.evaluatedAt,
      cycleAttemptCount: input.candidate.cycleAttemptCount,
      totalAttemptCount: input.candidate.totalAttemptCount,
      latestDreamingRunId: input.run.runId,
      dreamingPolicyVersion: input.run.policyVersion,
      latestDecisionId: decisionId,
      updatedAt: input.result.evaluation.evaluatedAt,
      ...(decision === "observe" ? {
        observeCount: (input.memory.observeCount ?? 0) + 1,
        ...(tier ? { reevaluationTier: tier } : {}),
        ...(nextEvaluateAt ? { nextEvaluateAt } : {})
      } : {})
    };
    if (decision !== "observe") {
      delete updated.nextEvaluateAt;
      delete updated.reevaluationTier;
    }
    delete updated.reevaluationReason;
    delete updated.lastDreamingError;
    if (input.result.trace) await repository.saveLlmDreamingTrace(input.result.trace);
    await repository.saveDreamingCandidateDecision(createFinalDreamingDecision({
      decisionId,
      traceId,
      decision,
      ...(nextEvaluateAt ? { nextEvaluateAt } : {}),
      run: input.run,
      candidate: input.candidate,
      memory: current,
      evaluatedAt: input.result.evaluation.evaluatedAt
    }));
    let resultLtmId = input.result.resultLtmId;
    if (decision === "consolidate") {
      const ltm = input.result.longTermMemory;
      if (!ltm) throw new Error("DREAMING_LTM_PROJECTION_MISSING");
      const consolidationKey = createDreamingConsolidationKey(
        current,
        input.run.policyVersion,
        input.candidate.stmVersion
      );
      const existingCommitted = repository.getDebugSnapshot().longTermMemories.find((memory) =>
        memory.consolidationKey === consolidationKey
      );
      const operation = input.result.ltmOperation;
      const target = operation?.targetLtmId
        ? await repository.getLongTermMemory(operation.targetLtmId)
        : undefined;
      const operationMemory: LongTermMemory = existingCommitted ?? {
        ...ltm,
        tenantId: current.tenantId,
        principalId: current.principalId,
        consolidationKey,
        version: operation?.relationType === "updates" ? (target?.version ?? 1) + 1 : 1,
        ...(operation?.relationType === "updates" && target ? { previousVersionId: target.memoryId } : {}),
        consolidationScore: input.result.evaluation.totalScore,
        consolidationFactors: input.result.evaluation.factorScores,
        policyVersion: input.run.policyVersion,
        promptVersion: input.run.promptVersion,
        ...(input.run.model ? { model: input.run.model } : {}),
        sourceFactIds: current.sourceFactIds,
        sourceMemoryDataIds: [current.memoryDataId],
        createdAt: ltm.createdAt ?? input.result.evaluation.evaluatedAt,
        updatedAt: input.result.evaluation.evaluatedAt,
        lastMaintainedAt: input.result.evaluation.evaluatedAt
      };
      resultLtmId = operationMemory.memoryId;
      if (!existingCommitted) {
        await repository.replaceLongTermMemory(operationMemory);
        const committedOperation = operation ? { ...operation, resultLtmId: operationMemory.memoryId } : undefined;
        const operationEdge = committedOperation ? createDreamingOperationEdge(committedOperation) : undefined;
        if (operationEdge) await repository.saveRelationEdge(operationEdge);
        await reconcileMemoryGraphForLongTermMemory(repository, operationMemory.memoryId);
        await repository.saveMemoryChangeEvent(createDreamingChangeEvent({
          memoryId: operationMemory.memoryId,
          memoryDataId: current.memoryDataId,
          changeType: operation?.relationType === "updates"
            ? "revised"
            : operation?.relationType === "conflicts_with" ? "relation_changed" : "created",
          storageLayer: "ltm",
          reason: "dreaming_consolidated_new_ltm"
        }));
        await enqueueDreamingIndexRefresh(repository, operationMemory);
        if (operation?.relationType === "updates" && target && target.lifecycleStatus !== "revised") {
          const revisedTarget: LongTermMemory = {
            ...target,
            lifecycleStatus: "revised",
            updatedAt: input.result.evaluation.evaluatedAt,
            lastMaintainedAt: input.result.evaluation.evaluatedAt
          };
          await repository.replaceLongTermMemory(revisedTarget);
          await enqueueDreamingIndexRefresh(repository, revisedTarget);
        }
      }
    }
    if (decision !== "observe") {
      await repository.saveMemoryChangeEvent(createDreamingChangeEvent({
        memoryDataId: current.memoryDataId,
        changeType: decision === "consolidate" ? "deleted" : "updated",
        storageLayer: "stm",
        reason: decision === "consolidate"
          ? "dreaming_consolidated_to_ltm"
          : "dreaming_ltm_skipped_stm_retained"
      }));
    }
    await repository.replaceShortTermMemory(updated);

    const completedCandidate = clearCandidateLease({
      ...input.candidate,
      status: decision === "consolidate" ? "consolidated" : decision === "observe" ? "observing" : "dropped",
      ...(tier ? { reevaluationTier: tier } : {}),
      ...(nextEvaluateAt ? { nextEvaluateAt } : {}),
      decisionId,
      traceId,
      ...(resultLtmId ? { resultLtmId } : {}),
      completedAt: input.result.evaluation.evaluatedAt,
      updatedAt: input.now
    });
    if (decision !== "observe") {
      delete completedCandidate.nextEvaluateAt;
      delete completedCandidate.reevaluationTier;
    }
    delete completedCandidate.lastError;
    await repository.saveDreamingRunCandidate(completedCandidate);
    if (decision === "consolidate") {
      await repository.deleteShortTermMemoryArtifacts(current.memoryDataId);
      await repository.deleteShortTermMemory(current.memoryDataId);
    } else if (decision === "observe") {
      await enqueueDreamingStmIndexRefresh(repository, updated);
    }
    const candidates = await repository.listDreamingRunCandidates(input.run.runId);
    const runPatch: Partial<Pick<DreamingRun, "checkpoint" | "lastError">> = {
      checkpoint: completedCandidate.runCandidateId
    };
    const currentRun = await repository.getDreamingRun(input.run.runId);
    if (currentRun?.lastError) delete currentRun.lastError;
    await repository.saveDreamingRun(summarizeRun(currentRun ?? input.run, candidates, input.now, runPatch));
  });
  await processDreamingOutbox(repository, input.now);
}

function createFinalDreamingDecision(input: {
  decisionId: string;
  traceId: string;
  decision: DreamingStmDecision;
  nextEvaluateAt?: string;
  run: DreamingRun;
  candidate: DreamingRunCandidate;
  memory: ShortTermMemory;
  evaluatedAt: string;
}): DreamingCandidateDecision {
  return {
    decisionId: input.decisionId,
    runId: input.run.runId,
    candidateFingerprint: input.candidate.candidateFingerprint,
    memoryDataId: input.memory.memoryDataId,
    tenantId: input.memory.tenantId,
    principalId: input.memory.principalId,
    decision: input.decision === "consolidate" ? "accepted" : input.decision,
    reasonCodes: [],
    sourceFactIds: input.memory.sourceFactIds,
    sourceRefs: input.memory.sourceRefs,
    permissionSnapshotIds: [],
    policyVersion: input.run.policyVersion,
    traceId: input.traceId,
    evaluatedAt: input.evaluatedAt,
    ...(input.nextEvaluateAt ? { nextEvaluateAt: input.nextEvaluateAt } : {}),
    createdAt: input.evaluatedAt
  };
}

function createDreamingChangeEvent(input: Omit<MemoryChangeEvent, "eventId" | "createdAt">): MemoryChangeEvent {
  return {
    ...input,
    eventId: `mce_dreaming_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString()
  };
}

async function commitSingleDreamingFailure(
  repository: ContextEngineRepository,
  input: {
    run: DreamingRun;
    candidate: DreamingRunCandidate;
    memory?: ShortTermMemory;
    error: unknown;
    now: string;
    timezone: string;
    unavailable: boolean;
  }
) {
  const message = errorMessage(input.error);
  const terminal = input.candidate.cycleAttemptCount >= MAX_CYCLE_ATTEMPTS;
  await repository.withDreamingTransaction(async () => {
    const currentMemory = input.memory
      ? await repository.getShortTermMemory(input.memory.memoryDataId) ?? input.memory
      : undefined;
    const tier: DreamingReevaluationTier = "NEXT_DAY";
    const nextEvaluateAt = calculateDreamingNextEvaluateAt(input.run.candidateCutoffAt, tier, input.timezone);
    if (currentMemory) {
      const updated = {
        ...currentMemory,
        cycleAttemptCount: input.candidate.cycleAttemptCount,
        totalAttemptCount: input.candidate.totalAttemptCount,
        lastDreamingError: message,
        latestDreamingRunId: input.run.runId,
        dreamingPolicyVersion: input.run.policyVersion,
        lastEvaluatedAt: input.now,
        updatedAt: input.now,
        ...(terminal ? {
          consolidationStatus: "retry_wait" as const,
          reevaluationTier: tier,
          nextEvaluateAt
        } : { consolidationStatus: "evaluating" as const })
      };
      await repository.replaceShortTermMemory(updated);
    }
    const candidateStatus = terminal
      ? input.unavailable ? "skipped" : "retry_wait"
      : "pending";
    const candidate = clearCandidateLease({
      ...input.candidate,
      status: candidateStatus,
      ...(terminal ? { reevaluationTier: tier, nextEvaluateAt } : {}),
      lastError: message,
      ...(terminal ? { completedAt: input.now } : {}),
      updatedAt: input.now
    });
    await repository.saveDreamingRunCandidate(candidate);
    const candidates = await repository.listDreamingRunCandidates(input.run.runId);
    const runForSummary = await repository.getDreamingRun(input.run.runId) ?? input.run;
    const runPatch: Partial<Pick<DreamingRun, "checkpoint" | "lastError">> = { lastError: message };
    if (terminal) runPatch.checkpoint = candidate.runCandidateId;
    await repository.saveDreamingRun(summarizeRun(runForSummary, candidates, input.now, runPatch));
  });
}

async function restoreInterruptedCandidate(
  repository: ContextEngineRepository,
  run: DreamingRun,
  candidate: DreamingRunCandidate,
  memory: ShortTermMemory | undefined,
  now: string
) {
  await repository.withDreamingTransaction(async () => {
    await repository.saveDreamingRunCandidate(clearCandidateLease({
      ...candidate,
      status: "pending",
      updatedAt: now
    }));
    if (memory) {
      await repository.replaceShortTermMemory({
        ...memory,
        updatedAt: now
      });
    }
    await repository.saveDreamingRun({ ...run, updatedAt: now });
  });
}

function summarizeRun(
  run: DreamingRun,
  candidates: DreamingRunCandidate[],
  updatedAt: string,
  patch: Partial<Pick<DreamingRun, "checkpoint" | "lastError" | "completedAt" | "leaseOwner" | "leaseExpiresAt">> = {}
): DreamingRun {
  const terminal = candidates.filter((candidate) => isTerminalCandidateStatus(candidate.status));
  return {
    ...run,
    candidateCount: candidates.length,
    processedCount: terminal.length,
    consolidatedCount: candidates.filter((candidate) => candidate.status === "consolidated").length,
    observingCount: candidates.filter((candidate) => candidate.status === "observing").length,
    droppedCount: candidates.filter((candidate) => candidate.status === "dropped").length,
    retryWaitCount: candidates.filter((candidate) => candidate.status === "retry_wait").length,
    skippedCount: candidates.filter((candidate) => candidate.status === "skipped").length,
    ...patch,
    updatedAt
  };
}

function clearCandidateLease(candidate: DreamingRunCandidate) {
  const cleared = { ...candidate };
  delete cleared.leaseOwner;
  delete cleared.leaseExpiresAt;
  return cleared;
}

function isTerminalCandidateStatus(status: DreamingRunCandidate["status"]) {
  return status === "consolidated" || status === "observing" || status === "dropped" || status === "retry_wait" || status === "skipped";
}

class DreamingCandidateUnavailableError extends Error {
  constructor(reason: string) {
    super(`DREAMING_CANDIDATE_UNAVAILABLE:${reason}`);
    this.name = "DreamingCandidateUnavailableError";
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.message === "This operation was aborted");
}

function normalizeInstant(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("INVALID_DREAMING_WORKER_TIME");
  return new Date(parsed).toISOString();
}

function addMilliseconds(instant: string, milliseconds: number) {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}
