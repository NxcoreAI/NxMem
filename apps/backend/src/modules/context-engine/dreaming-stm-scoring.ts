import type {
  DreamingScoreFactors,
  DreamingStmEvaluation,
  LlmDreamingStmScore,
  ShortTermMemory
} from "./domain.js";
import type { MemoryReuseSignal } from "./persistence/repository.js";

export const DREAMING_SCORE_WEIGHTS: Record<keyof DreamingScoreFactors, number> = {
  stability: 0.18,
  reuseValue: 0.18,
  identityRelationValue: 0.12,
  actionCommitmentValue: 0.12,
  informationEntropy: 0.10,
  explicitWeight: 0.10,
  preferenceConsistency: 0.20
};

export interface ScoreDreamingStmOptions {
  now?: string;
  observeDelayMs?: number;
  reuseSignals?: MemoryReuseSignal[];
}

export function evaluateDreamingStms(
  scores: LlmDreamingStmScore[],
  memories: ShortTermMemory[],
  options: ScoreDreamingStmOptions = {}
): DreamingStmEvaluation[] {
  const memoryById = new Map(memories.map((memory) => [memory.memoryDataId, memory]));
  const now = options.now ?? new Date().toISOString();

  return scores.flatMap((score) => {
    const memory = memoryById.get(score.memoryDataId);
    if (!memory) return [];
    const deterministic = deterministicScores(memory, options.reuseSignals);
    const factors = clampFactors({
      ...deterministic,
      ...score.semanticScores,
      // Historical use is server-owned data and cannot be invented by the model.
      reuseValue: deterministic.reuseValue
    });
    const totalScore = weightedScore(factors);
    const decision = totalScore >= 6 ? "consolidate" : totalScore >= 4 ? "observe" : "drop";
    const factorReasons = {
      ...(score.scoreReasons ?? defaultReasons(factors)),
      reuseValue: `evidence=memory_retrieval_events; rationale=server_owned_reuse_score:${factors.reuseValue}`
    };
    const nextEvaluateAt = decision === "observe"
      ? new Date(Date.parse(now) + (options.observeDelayMs ?? observeDelayMs(memory))).toISOString()
      : undefined;
    return [{
      memoryDataId: memory.memoryDataId,
      factorScores: factors,
      factorReasons,
      totalScore,
      decision,
      decisionReason: decision === "consolidate"
        ? "stm_score_reached_consolidation_threshold"
        : decision === "observe"
          ? "stm_requires_changed_evidence_before_reevaluation"
          : "stm_score_below_observation_threshold",
      ...(nextEvaluateAt ? { nextEvaluateAt } : {}),
      evaluatedAt: now
    } satisfies DreamingStmEvaluation];
  });
}

export function weightedScore(factors: DreamingScoreFactors) {
  return Number((Object.entries(DREAMING_SCORE_WEIGHTS) as Array<[keyof DreamingScoreFactors, number]>)
    .reduce((sum, [key, weight]) => sum + factors[key] * weight, 0).toFixed(2));
}

function deterministicScores(memory: ShortTermMemory, reuseSignals: MemoryReuseSignal[] = []): DreamingScoreFactors {
  const reuseSignal = reuseSignals.find((signal) => signal.ownerType === "stm" && signal.ownerId === memory.memoryDataId);
  const highImportance = memory.importanceLevel === "critical" ? 2 : memory.importanceLevel === "high" ? 1 : 0;
  const tokenCount = new Set(memory.content.toLowerCase().split(/\s+/u).filter(Boolean)).size;
  return {
    stability: scale(memory.validTimeEnd ? 3 : 5 + highImportance),
    reuseValue: scale(Math.min(10, 1.5 + (reuseSignal?.reuseValue ?? 0) * 0.85)),
    identityRelationValue: scale(Math.min(10, memory.entityIds.length * 2)),
    actionCommitmentValue: scale(["task", "project", "workflow_pattern"].includes(memory.memoryType ?? "") ? 7 + highImportance : highImportance * 1.5),
    informationEntropy: scale(Math.min(10, 2 + tokenCount / 3 + memory.sourceFactIds.length)),
    explicitWeight: scale(Math.min(10, highImportance * 3 + (memory.userRetrievalWeight === undefined ? 0 : 2))),
    preferenceConsistency: scale(["preference", "workflow_pattern", "ai_persona"].includes(memory.memoryType ?? "")
      ? (memory.matchedRules.some((rule) => /explicit|confirm|remember|preference/u.test(rule)) ? 8 : 3)
      : 5)
  };
}

function clampFactors(factors: Partial<DreamingScoreFactors>): DreamingScoreFactors {
  return {
    stability: clamp(factors.stability),
    reuseValue: clamp(factors.reuseValue),
    identityRelationValue: clamp(factors.identityRelationValue),
    actionCommitmentValue: clamp(factors.actionCommitmentValue),
    informationEntropy: clamp(factors.informationEntropy),
    explicitWeight: clamp(factors.explicitWeight),
    preferenceConsistency: clamp(factors.preferenceConsistency)
  };
}

function defaultReasons(factors: DreamingScoreFactors) {
  return Object.fromEntries(Object.entries(factors).map(([key, value]) => [key, `server_feature_score:${value}`])) as Partial<Record<keyof DreamingScoreFactors, string>>;
}

function clamp(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.min(10, value!)) : 0;
}

function scale(value: number) {
  return Number(Math.max(0, Math.min(10, value)).toFixed(2));
}

function observeDelayMs(memory: ShortTermMemory) {
  const observeCount = memory.observeCount ?? 0;
  return Math.min(30, Math.max(1, 2 ** observeCount)) * 24 * 60 * 60 * 1000;
}
