import type { ShortTermMemory } from "./domain.js";

export type MemoryRegion = "semantic" | "affective";

// 双脑区路由键：affective 覆盖用户好恶/反馈（情感脑区），其余走 semantic（事实脑区）。
// 行为分叉不在此处——这里只回答"这条记忆属于哪个脑区"。
const AFFECTIVE_FACT_TYPES = new Set(["preference", "feedback"]);

export function memoryRegionForFactType(factType: string | undefined | null): MemoryRegion {
  return factType && AFFECTIVE_FACT_TYPES.has(factType) ? "affective" : "semantic";
}

export function isAffectiveShortTermMemory(memory: ShortTermMemory): boolean {
  return memory.structuredFacts?.facts.some((fact) => memoryRegionForFactType(fact.factType) === "affective") ?? false;
}
