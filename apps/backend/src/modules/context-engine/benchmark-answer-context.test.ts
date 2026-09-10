import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  renderBenchmarkAnswerContext,
  selectBenchmarkAnswerEvidenceWithinBudget,
  type BenchmarkAnswerEvidenceCandidate
} from "./benchmark-answer-context.js";
import type { ScoreBreakdown } from "./search-context.js";
import { longMemEvalSessionSourceId, scoreRanking } from "./longmemeval.js";

const scores: ScoreBreakdown = {
  keyword: 0, vector: 0, graph: 0, recency: 0, importance: 0, retrievalWeight: 0,
  userRetrievalWeight: 0, sourceReliability: 0, feedback: 0, diversity: 0,
  conflictPenalty: 0, permissionRiskPenalty: 0, stalenessPenalty: 0,
  route: { keyword: 0, vector: 0, graph: 0, time: 0, feedback: 0 }, rrf: 0
};

test("benchmark selector is gold-free, reranker ordered, deduplicated and budget bounded", () => {
  const sparse = candidate("sparse", 0.8, "short", ["fact-shared"]);
  const complete = candidate("complete", 0.9, "complete evidence", ["fact-shared"]);
  complete.temporal = { validTime: "2024-01-01T00:00:00.000Z" };
  complete.item.temporal = complete.temporal;
  const other = candidate("other", 0.7, "other numerical evidence 42", ["fact-other"]);
  const selection = selectBenchmarkAnswerEvidenceWithinBudget({
    question: "What is the total?",
    questionType: "multi-session",
    candidates: [sparse, other, complete],
    tokenBudget: 20_000,
    evidenceLimit: 2
  });
  assert.deepEqual(selection.selectedCandidates.map((item) => item.item.id), ["complete", "other"]);
  assert.equal(selection.rejected.some((item) => item.itemId === "sparse" && item.reason === "duplicate"), true);
  const prompt = renderBenchmarkAnswerContext("What is the total?", undefined, selection.selectedCandidates, "stable-pack", "multi-session");
  assert.match(prompt, /complete evidence/);
  assert.match(prompt, /other numerical evidence 42/);
});

test("benchmark selector drops complete evidence items instead of truncating over budget", () => {
  const oversized = candidate("oversized", 1, `begin ${"evidence ".repeat(1000)} end`, ["fact-large"]);
  const selection = selectBenchmarkAnswerEvidenceWithinBudget({
    question: "What happened?",
    questionType: "single-session-user",
    candidates: [oversized],
    tokenBudget: 100
  });
  assert.equal(selection.selectedCandidates.length, 0);
  assert.equal(selection.rejected[0]?.reason, "budget");
});

test("LongMemEval compatibility characterization stays stable through the shared selector", () => {
  const oldState = candidate("stm-old", 0.7, "Alice lived in Boston in 2022.", ["fact-old"]);
  oldState.sourceSessionIds = ["session-1"];
  oldState.sourceRoles = ["user"];
  oldState.temporal = { validTime: "2022-05-01T00:00:00.000Z", evidenceTime: "2022-05-02T00:00:00.000Z" };
  oldState.item.temporal = oldState.temporal;
  const newState = candidate("stm-new", 0.95, "Alice moved to Seattle in 2023.", ["fact-new"]);
  newState.sourceSessionIds = ["session-2"];
  newState.sourceRoles = ["user"];
  newState.temporal = { validTime: "2023-06-01T00:00:00.000Z", evidenceTime: "2023-06-02T00:00:00.000Z" };
  newState.item.temporal = newState.temporal;
  newState.relations = [{ edgeId: "edge-update", fromId: "stm-new", toId: "stm-old", relationType: "updates" }];
  const distractor = candidate("stm-noise", 0.1, "Bob likes chess.", ["fact-noise"]);
  const selection = selectBenchmarkAnswerEvidenceWithinBudget({
    question: "Where did Alice live before moving to Seattle?",
    questionType: "temporal-reasoning",
    referenceTime: "2024-01-01",
    candidates: [distractor, oldState, newState],
    tokenBudget: 20_000,
    evidenceLimit: 2
  });
  const prompt = renderBenchmarkAnswerContext(
    "Where did Alice live before moving to Seattle?",
    "2024-01-01",
    selection.selectedCandidates,
    "pack-characterization",
    "temporal-reasoning"
  );
  const ranking = scoreRanking(["session-1", "session-2"], ["session-2", "session-9", "session-1"], 3);

  assert.equal(longMemEvalSessionSourceId("question-7", "session-2"), "longmemeval_event_question-7_session-2");
  assert.deepEqual([distractor, oldState, newState].map((item) => item.item.id), ["stm-noise", "stm-old", "stm-new"]);
  assert.deepEqual(selection.selectedCandidates.map((item) => item.item.id), ["stm-new", "stm-old"]);
  assert.deepEqual(selection.selected.map(({ itemId, evidenceRole }) => ({ itemId, evidenceRole })), [
    { itemId: "stm-new", evidenceRole: "new_state" },
    { itemId: "stm-old", evidenceRole: "temporal_start" }
  ]);
  assert.equal(createHash("sha256").update(prompt).digest("hex"), "8f3cd0dd628b0cb3f004fa804aab24e4852d3c5648dad0e14c4cfac036197df0");
  assert.deepEqual(ranking, {
    k: 3,
    recallAtK: 1,
    recallAnyAtK: 1,
    recallAllAtK: 1,
    precisionAtK: 2 / 3,
    mrrAtK: 1,
    ndcgAtK: 0.8154648767857288,
    exactMatch: 0,
    judgeAccuracy: 0
  });
});

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
