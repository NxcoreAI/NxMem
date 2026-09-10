import type { LongTermMemory, ShortTermMemory } from "./domain.js";

export interface RetrievalWeightComponents {
  retrievalWeight: number;
  userRetrievalWeight: number;
  importance: number;
}

export function shortTermRetrievalWeight(level: ShortTermMemory["importanceLevel"]) {
  if (level === "critical") return 1;
  if (level === "high") return 0.8;
  if (level === "medium") return 0.5;
  return 0.2;
}

export function longTermRetrievalWeight(weight: LongTermMemory["recallWeight"]) {
  if (weight === "high") return 1;
  if (weight === "medium") return 0.6;
  return 0.3;
}

export function shortTermRetrievalWeights(memory: ShortTermMemory): RetrievalWeightComponents {
  return retrievalWeightComponents(memory, shortTermRetrievalWeight(memory.importanceLevel));
}

export function longTermRetrievalWeights(memory: LongTermMemory): RetrievalWeightComponents {
  return retrievalWeightComponents(memory, longTermRetrievalWeight(memory.recallWeight));
}

export function retrievalWeightComponents(
  memory: Pick<ShortTermMemory | LongTermMemory, "retrievalWeight" | "userRetrievalWeight">,
  fallbackSystemWeight: number
): RetrievalWeightComponents {
  const retrievalWeight = clampWeight(memory.retrievalWeight ?? fallbackSystemWeight);
  const userRetrievalWeight = clampWeight(memory.userRetrievalWeight ?? retrievalWeight);
  return {
    retrievalWeight,
    userRetrievalWeight,
    importance: Number((0.25 * retrievalWeight + 0.75 * userRetrievalWeight).toFixed(6))
  };
}

export function clampWeight(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
