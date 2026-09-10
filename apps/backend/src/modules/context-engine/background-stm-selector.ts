import { createHash } from "node:crypto";
import type { BackgroundStmCursor, ShortTermMemory, SourceRef } from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { estimateContextTokens } from "./token-estimator.js";
import { isShortTermRecallEligible } from "./lifecycle.js";

export type { BackgroundStmCursor } from "./domain.js";

export interface BackgroundMemoryCandidate {
  memoryDataId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  sourceRefs: SourceRef[];
  confidenceLevel: ShortTermMemory["confidenceLevel"];
  importanceLevel: ShortTermMemory["importanceLevel"];
  lifecycleStatus: ShortTermMemory["lifecycleStatus"];
}

export interface SelectBackgroundMemoriesRequest {
  tenantId: string;
  principalId: string;
  windowStart: string;
  windowEnd: string;
  cursor?: BackgroundStmCursor;
  includeInactive?: boolean;
  limit?: number;
}

export type BackgroundMemoryDropReason =
  | "inactive"
  | "permission_invalid"
  | "missing_source"
  | "outside_window";

export interface SelectBackgroundMemoriesResponse {
  windowStart: string;
  windowEnd: string;
  memories: BackgroundMemoryCandidate[];
  nextCursor?: BackgroundStmCursor;
  hasMore: boolean;
  estimatedTokens: number;
  dropped: Array<{
    memoryDataId: string;
    reason: BackgroundMemoryDropReason;
  }>;
}

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;
export function isBackgroundStmLifecycleEligible(status: ShortTermMemory["lifecycleStatus"]) {
  return isShortTermRecallEligible({ lifecycleStatus: status });
}

export async function selectBackgroundMemories(
  repository: ContextEngineRepository,
  request: SelectBackgroundMemoriesRequest
): Promise<SelectBackgroundMemoriesResponse> {
  const query = normalizeRequest(request);
  const page = await repository.selectShortTermMemoriesForBackground(query);
  const dropped: SelectBackgroundMemoriesResponse["dropped"] = [];
  const eligible: ShortTermMemory[] = [];

  for (const memory of page.memories) {
    const reason = backgroundMemoryDropReason(memory, query, Boolean(request.includeInactive));
    if (reason) {
      dropped.push({ memoryDataId: memory.memoryDataId, reason });
      continue;
    }
    eligible.push(memory);
  }

  const memories = deduplicateCandidates(eligible).sort(compareCandidatePriority);
  return {
    windowStart: query.windowStart,
    windowEnd: query.windowEnd,
    memories,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
    estimatedTokens: memories.reduce((sum, memory) => sum + estimateContextTokens(memory.content), 0),
    dropped
  };
}

function normalizeRequest(request: SelectBackgroundMemoriesRequest) {
  const tenantId = request.tenantId.trim();
  const principalId = request.principalId.trim();
  if (!tenantId) throw new Error("BACKGROUND_STM_TENANT_REQUIRED");
  if (!principalId) throw new Error("BACKGROUND_STM_PRINCIPAL_REQUIRED");
  assertIsoTimestamp(request.windowStart, "BACKGROUND_STM_WINDOW_START_INVALID");
  assertIsoTimestamp(request.windowEnd, "BACKGROUND_STM_WINDOW_END_INVALID");
  if (request.windowStart > request.windowEnd) throw new Error("BACKGROUND_STM_WINDOW_INVALID");
  if (request.cursor) {
    assertIsoTimestamp(request.cursor.updatedAt, "BACKGROUND_STM_CURSOR_INVALID");
  }

  const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`BACKGROUND_STM_LIMIT_INVALID:${limit}`);
  }
  return {
    tenantId,
    principalId,
    windowStart: request.windowStart,
    windowEnd: request.windowEnd,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    limit
  };
}

function backgroundMemoryDropReason(
  memory: ShortTermMemory,
  window: { windowStart: string; windowEnd: string },
  includeInactive: boolean
): BackgroundMemoryDropReason | undefined {
  if (memory.updatedAt < window.windowStart || memory.updatedAt >= window.windowEnd) return "outside_window";
  if (!includeInactive && !isBackgroundStmLifecycleEligible(memory.lifecycleStatus)) return "inactive";
  if (memory.accessState === "permission-invalid") {
    return "permission_invalid";
  }
  if (!memory.sourceRefs.some((source) => source.sourceRefId.trim() && source.sourceId.trim())) {
    return "missing_source";
  }
  return undefined;
}

function deduplicateCandidates(memories: ShortTermMemory[]) {
  const byContentHash = new Map<string, BackgroundMemoryCandidate>();
  for (const memory of memories) {
    const candidate = toCandidate(memory);
    const key = contentHash(memory.content);
    const existing = byContentHash.get(key);
    if (!existing) {
      byContentHash.set(key, candidate);
      continue;
    }

    const preferred = compareCandidatePriority(existing, candidate) <= 0 ? existing : candidate;
    byContentHash.set(key, {
      ...preferred,
      sourceRefs: mergeSourceRefs(existing.sourceRefs, candidate.sourceRefs)
    });
  }
  return [...byContentHash.values()];
}

function toCandidate(memory: ShortTermMemory): BackgroundMemoryCandidate {
  return {
    memoryDataId: memory.memoryDataId,
    content: memory.content,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    sourceRefs: [...memory.sourceRefs],
    confidenceLevel: memory.confidenceLevel,
    importanceLevel: memory.importanceLevel,
    lifecycleStatus: memory.lifecycleStatus
  };
}

function compareCandidatePriority(left: BackgroundMemoryCandidate, right: BackgroundMemoryCandidate) {
  const importanceOrder = importanceRank(right.importanceLevel) - importanceRank(left.importanceLevel);
  if (importanceOrder) return importanceOrder;
  const confidenceOrder = confidenceRank(right.confidenceLevel) - confidenceRank(left.confidenceLevel);
  if (confidenceOrder) return confidenceOrder;
  const freshnessOrder = right.updatedAt.localeCompare(left.updatedAt);
  return freshnessOrder || left.memoryDataId.localeCompare(right.memoryDataId);
}

function mergeSourceRefs(left: SourceRef[], right: SourceRef[]) {
  return [...new Map([...left, ...right].map((source) => [source.sourceRefId, source])).values()];
}

function contentHash(content: string) {
  const normalized = content.replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function importanceRank(value: BackgroundMemoryCandidate["importanceLevel"]) {
  return { low: 1, medium: 2, high: 3, critical: 4 }[value];
}

function confidenceRank(value: BackgroundMemoryCandidate["confidenceLevel"]) {
  return { low: 1, medium: 2, high: 3 }[value];
}

function assertIsoTimestamp(value: string, code: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
}
