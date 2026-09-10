import type { LongTermMemory, ShortTermMemory } from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

export function isShortTermRecallEligible(memory: Pick<ShortTermMemory, "lifecycleStatus">) {
  return memory.lifecycleStatus !== "deleted";
}

export function isLongTermRecallEligible(memory: LongTermMemory) {
  return memory.lifecycleStatus === "active" || memory.lifecycleStatus === "revised" || memory.lifecycleStatus === "weakened";
}

export function longTermLifecycleChangeReason(status: LongTermMemory["lifecycleStatus"]) {
  if (status === "deleted") return "deleted";
  if (status === "archived") return "archived";
  if (status === "weakened") return "weakened";
  return "updated";
}

export async function reconcileLongTermLifecycle(
  repository: ContextEngineRepository,
  memory: LongTermMemory
) {
  if (!isLongTermRecallEligible(memory)) {
    await repository.deleteIndexBundle("ltm", memory.memoryId);
  }
}
