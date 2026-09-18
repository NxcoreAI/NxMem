import test from "node:test";
import assert from "node:assert/strict";
import type { ShortTermMemory } from "./domain.js";
import { isAffectiveShortTermMemory, memoryRegionForFactType } from "./memory-region.js";
import {
  STANDING_AFFECTIVE_LIMIT,
  collectStandingAffectiveStmMemories,
  standingShortTermSearchResult
} from "./standing-affective.js";
import { selectBenchmarkAnswerEvidenceWithinBudget, type BenchmarkAnswerEvidenceCandidate } from "./benchmark-answer-context.js";
import type { ScoreBreakdown } from "./search-context.js";

const scores: ScoreBreakdown = {
  keyword: 0, vector: 0, graph: 0, recency: 0, importance: 0, retrievalWeight: 0,
  userRetrievalWeight: 0, sourceReliability: 0, feedback: 0, diversity: 0,
  conflictPenalty: 0, permissionRiskPenalty: 0, stalenessPenalty: 0,
  route: { keyword: 0, vector: 0, graph: 0, time: 0, feedback: 0 }, rrf: 0
};

test("memory region routes preference/feedback to affective, rest to semantic", () => {
  assert.equal(memoryRegionForFactType("preference"), "affective");
  assert.equal(memoryRegionForFactType("feedback"), "affective");
  assert.equal(memoryRegionForFactType("knowledge"), "semantic");
  assert.equal(memoryRegionForFactType(undefined), "semantic");
});

test("stm memory is affective when any structured fact carries an affective factType", () => {
  const affective = { ...baseStm("stm_1"), structuredFacts: { schemaVersion: "memory-structured-facts.v1" as const, memoryKind: "short_term" as const, facts: [{ claim: "likes quinoa", explanation: "", factType: "preference" }] } };
  const semantic = { ...baseStm("stm_2"), structuredFacts: { schemaVersion: "memory-structured-facts.v1" as const, memoryKind: "short_term" as const, facts: [{ claim: "bought a rug", explanation: "", factType: "event" }] } };
  assert.equal(isAffectiveShortTermMemory(affective), true);
  assert.equal(isAffectiveShortTermMemory(semantic), false);
});

test("collectStandingAffectiveStmMemories scopes, filters, sorts and limits", async () => {
  const memories = [
    { ...baseStm("stm_old"), createdAt: "2026-01-01T00:00:00.000Z", structuredFacts: pref("likes tea") },
    { ...baseStm("stm_new"), createdAt: "2026-02-01T00:00:00.000Z", structuredFacts: pref("likes quinoa") },
    { ...baseStm("stm_inactive"), lifecycleStatus: "expired", structuredFacts: pref("stale") },
    { ...baseStm("stm_semantic"), structuredFacts: { schemaVersion: "memory-structured-facts.v1" as const, memoryKind: "short_term" as const, facts: [{ claim: "event", explanation: "", factType: "event" }] } },
    { ...baseStm("stm_excluded"), structuredFacts: pref("already ranked") }
  ];
  const repository = {
    findMemoryOwnersByContextScopeId: async () => memories.map((memory) => ({ ownerType: "stm" as const, ownerId: memory.memoryDataId, score: 1 })),
    getShortTermMemoriesByIds: async (ids: string[]) => memories.filter((memory) => ids.includes(memory.memoryDataId))
  };
  const collected = await collectStandingAffectiveStmMemories(
    repository as never,
    { tenantId: "local", principalId: "longmemeval", contextScopeId: "scope_1" },
    new Set(["stm_excluded"])
  );
  assert.deepEqual(collected.map((memory) => memory.memoryDataId), ["stm_new", "stm_old"]);
});

test("collectStandingAffectiveStmMemories returns empty without scope", async () => {
  const collected = await collectStandingAffectiveStmMemories({ findMemoryOwnersByContextScopeId: async () => [] } as never, { tenantId: "t", principalId: "p" }, new Set());
  assert.deepEqual(collected, []);
});

test("standing candidates stay selected ahead of higher-relevance competition", () => {
  const standing = candidate("stm_standing", 0, "user prefers quinoa and roasted vegetables", []);
  const strong = candidate("stm_strong", 0.9, "direct numerical evidence 42", []);
  const selection = selectBenchmarkAnswerEvidenceWithinBudget({
    question: "any suggestions for meal prep?",
    questionType: "single-session-preference",
    candidates: [strong, standing],
    tokenBudget: 20_000,
    evidenceLimit: 1,
    standingItemIds: new Set(["stm_standing"])
  });
  assert.ok(selection.selectedCandidates.some((item) => item.item.id === "stm_standing"));
});

test("standingShortTermSearchResult marks reason and zero scores", () => {
  const result = standingShortTermSearchResult({ ...baseStm("stm_x"), structuredFacts: pref("likes tea") });
  assert.equal(result.reason, "standing_affective_injection");
  assert.equal(result.layer, "stm");
  assert.equal(result.score, 0);
});

function pref(claim: string) {
  return { schemaVersion: "memory-structured-facts.v1" as const, memoryKind: "short_term" as const, facts: [{ claim, explanation: "", factType: "preference" }] };
}

function baseStm(id: string): ShortTermMemory {
  return {
    memoryDataId: id,
    tenantId: "local",
    principalId: "longmemeval",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "fact",
    content: "content",
    sourceFactIds: [],
    sourceRefs: [],
    entityIds: [],
    importanceLevel: "medium",
    confidenceLevel: "medium",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: [],
    admissionSignals: { importance: "medium", confidence: "medium", freshness: "fresh", sensitivity: "low", actorWeight: "medium", conflict: "none", permission: "private" },
    lifecycleStatus: "active",
    consolidationStatus: "unseen",
    observeCount: 0
  };
}

function candidate(id: string, reranker: number, text: string, factIds: string[]): BenchmarkAnswerEvidenceCandidate {
  return {
    item: {
      id, layer: "stm", content: text, compressedContent: text, score: reranker,
      sourceRefs: [], sourceMessageIds: [], factIds, memoryIds: [id], factContext: {
        currentFacts: [], sourceFacts: [], conflicts: []
      }, temporal: {}
    },
    scoreBreakdown: { ...scores, reranker },
    sourceSessionIds: [], sourceRoles: ["unknown"], temporal: {}, relations: [], facts: [],
    evidenceText: text, relevanceScore: 0, estimatedTokens: 1
  };
}

assert.ok(STANDING_AFFECTIVE_LIMIT > 0);
