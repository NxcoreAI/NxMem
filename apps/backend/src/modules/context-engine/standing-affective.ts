import type { ShortTermMemory } from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import type { ContextSearchResult } from "./search-context.js";
import { isAffectiveShortTermMemory } from "./memory-region.js";

export const STANDING_AFFECTIVE_LIMIT = 10;

// 情感脑区不等待 reinforcement：candidate_queue（79% 的偏好 STM 停留态）同样参与常驻注入。
// ponytail: 若 candidate_queue 噪声过大，再按 observeCount/准入分过滤。
const STANDING_AFFECTIVE_STATUSES = new Set(["active", "candidate_queue"]);

export interface StandingAffectiveScopeInput {
  tenantId: string;
  principalId: string;
  contextScopeId?: string;
}

export async function collectStandingAffectiveStmMemories(
  repository: ContextEngineRepository,
  input: StandingAffectiveScopeInput,
  excludeIds: Set<string>
): Promise<ShortTermMemory[]> {
  const scope = input.contextScopeId?.trim();
  if (!scope) return [];
  const owners = await repository.findMemoryOwnersByContextScopeId(scope, ["stm"]);
  const ids = owners.map((owner) => owner.ownerId).filter((id) => !excludeIds.has(id));
  if (!ids.length) return [];
  const memories = await repository.getShortTermMemoriesByIds(ids);
  return memories
    .filter((memory) => STANDING_AFFECTIVE_STATUSES.has(memory.lifecycleStatus))
    .filter(isAffectiveShortTermMemory)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, STANDING_AFFECTIVE_LIMIT);
}

export function standingShortTermSearchResult(memory: ShortTermMemory): ContextSearchResult {
  // 检索分全零：standing 条目不参与相关性竞争，由证据选择阶段保位注入。
  const scoreBreakdown: ContextSearchResult["scoreBreakdown"] = {
    keyword: 0, vector: 0, graph: 0, recency: 0, importance: 0, retrievalWeight: 0,
    userRetrievalWeight: 0, sourceReliability: 0, feedback: 0, diversity: 0,
    conflictPenalty: 0, permissionRiskPenalty: 0, stalenessPenalty: 0,
    route: { keyword: 0, vector: 0, graph: 0, time: 0, feedback: 0 }, rrf: 0
  };
  return {
    id: memory.memoryDataId,
    layer: "stm",
    content: memory.content,
    temporal: {
      ...(memory.evidenceTime ? { evidenceTime: memory.evidenceTime } : {}),
      ...(memory.validTime ? { validTime: memory.validTime } : {}),
      ...(memory.evidenceTimeStart ? { evidenceTimeStart: memory.evidenceTimeStart } : {}),
      ...(memory.evidenceTimeEnd ? { evidenceTimeEnd: memory.evidenceTimeEnd } : {}),
      ...(memory.validTimeStart ? { validTimeStart: memory.validTimeStart } : {}),
      ...(memory.validTimeEnd ? { validTimeEnd: memory.validTimeEnd } : {})
    },
    ...(memory.factSummary !== undefined ? { factSummary: memory.factSummary } : {}),
    ...(memory.summary !== undefined ? { summary: memory.summary } : {}),
    ...(memory.memoryType !== undefined ? { memoryType: memory.memoryType } : {}),
    status: memory.lifecycleStatus,
    score: 0,
    reason: "standing_affective_injection",
    sourceRefs: memory.sourceRefs,
    factIds: memory.sourceFactIds,
    factContext: { currentFacts: [], sourceFacts: [], conflicts: [] },
    memoryIds: [memory.memoryDataId],
    permissionStatus: "allowed",
    scoreBreakdown,
    relationEdges: []
  };
}
