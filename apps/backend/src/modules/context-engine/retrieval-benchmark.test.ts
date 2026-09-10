import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateRetrievalBenchmark,
  readRetrievalBenchmarkCases,
  scoreTargetMetrics,
  type RetrievalBenchmarkCandidate
} from "./retrieval-benchmark.js";
import { parseRetrievalBenchmarkArgs } from "./retrieval-benchmark-cli.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { refreshShortTermMemoryIndex } from "./indexing.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";

test("parseRetrievalBenchmarkArgs accepts the pnpm argument separator", () => {
  const options = parseRetrievalBenchmarkArgs([
    "node",
    "retrieval-benchmark-cli.ts",
    "--",
    "--dataset",
    "fixtures/cases.json",
    "--limit",
    "50"
  ]);
  assert.equal(options.dataset, "fixtures/cases.json");
  assert.equal(options.limit, 50);
  assert.deepEqual(options.ks, [1, 5, 10, 20, 50]);
});

test("scoreTargetMetrics measures candidate-ranked fact and session recall", () => {
  const candidates: RetrievalBenchmarkCandidate[] = [
    candidate(1, { factIds: ["fact_noise"], sessionIds: ["session_noise"] }),
    candidate(2, { factIds: ["fact_a", "fact_b"], sessionIds: ["session_a"] }),
    candidate(3, { factIds: ["fact_c"], sessionIds: ["session_b"] })
  ];

  const [sessionAt2] = scoreTargetMetrics(candidates, ["session_a", "session_b"], "session", [2]);
  assert.ok(sessionAt2);
  assert.equal(sessionAt2.recallAtK, 0.5);
  assert.equal(sessionAt2.recallAnyAtK, 1);
  assert.equal(sessionAt2.recallAllAtK, 0);
  assert.equal(sessionAt2.precisionAtK, 0.5);
  assert.equal(sessionAt2.mrrAtK, 0.5);

  const [factAt2] = scoreTargetMetrics(candidates, ["fact_a", "fact_b"], "fact", [2]);
  assert.ok(factAt2);
  assert.equal(factAt2.matchedTargetCount, 2);
  assert.equal(factAt2.recallAtK, 1);
  assert.equal(factAt2.recallAllAtK, 1);
});

test("session NDCG stays bounded when several memory candidates map to one gold session", () => {
  const candidates = [
    candidate(1, { factIds: [], sessionIds: ["session_a"] }),
    candidate(2, { factIds: [], sessionIds: ["session_a"] }),
    candidate(3, { factIds: [], sessionIds: ["session_noise"] })
  ];
  const [metric] = scoreTargetMetrics(candidates, ["session_a"], "session", [3]);
  assert.ok(metric);
  assert.equal(metric.recallAtK, 1);
  assert.ok(metric.ndcgAtK <= 1);
  assert.equal(metric.ndcgAtK, 1);
});

test("readRetrievalBenchmarkCases maps LongMemEval gold sessions without answer content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retrieval-benchmark-"));
  const path = join(directory, "dataset.json");
  await writeFile(path, JSON.stringify([{
    question_id: "question_1",
    question_type: "multi-session",
    question: "Where did I go?",
    answer: "This must not be used by retrieval.",
    question_date: "2026-01-02",
    haystack_session_ids: ["session_a", "session_b"],
    answer_session_ids: ["session_b"]
  }]), "utf8");

  const [benchmarkCase] = await readRetrievalBenchmarkCases(path, "longmemeval");
  assert.ok(benchmarkCase);
  assert.equal(benchmarkCase.caseId, "question_1");
  assert.equal(benchmarkCase.query, "Where did I go?");
  assert.deepEqual(benchmarkCase.goldSessionIds, ["session_b"]);
  assert.deepEqual(benchmarkCase.goldFactIds, []);
  assert.equal(
    benchmarkCase.sessionSourceIds.session_b,
    "longmemeval_event_question_1_session_b"
  );
  assert.equal(benchmarkCase.sourceIds.includes("This must not be used by retrieval."), false);
});

test("readRetrievalBenchmarkCases supports generic JSONL fact and session gold", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retrieval-cases-"));
  const path = join(directory, "cases.jsonl");
  await writeFile(path, `${JSON.stringify({
    id: "case_1",
    query: "What is the preference?",
    gold: {
      factIds: ["fact_preference"],
      sessionIds: ["session_preference"]
    },
    sourceIds: ["source_preference"]
  })}\n`, "utf8");

  const [benchmarkCase] = await readRetrievalBenchmarkCases(path, "cases");
  assert.ok(benchmarkCase);
  assert.deepEqual(benchmarkCase.goldFactIds, ["fact_preference"]);
  assert.deepEqual(benchmarkCase.goldSessionIds, ["session_preference"]);
  assert.deepEqual(benchmarkCase.sourceIds, ["source_preference"]);
});

test("evaluateRetrievalBenchmark attributes real search candidates to gold facts and sessions", async () => {
  const repository = new InMemoryContextEngineRepository();
  const sourceRef = {
    sourceRefId: "src_session_a",
    sourceType: "agent_memory",
    sourceId: "source_session_a",
    metadata: { sessionId: "session_a" }
  };
  await repository.saveFactItem({
    factId: "fact_blue_harbor",
    factType: "event",
    factText: "The user visited Blue Harbor.",
    normalizedClaim: "the user visited blue harbor",
    linkedEventIds: ["event_session_a"],
    linkedSegmentIds: ["segment_session_a"],
    linkedSourceRefs: [sourceRef],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-01-01T00:00:00.000Z",
    validTimeStart: "2026-01-01T00:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  });
  await repository.saveShortTermMemory({
    memoryDataId: "stm_blue_harbor",
    tenantId: "local",
    principalId: "benchmark-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "event",
    content: "The user visited Blue Harbor.",
    sourceFactIds: ["fact_blue_harbor"],
    sourceRefs: [sourceRef],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active"
  });
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  await refreshShortTermMemoryIndex(
    repository,
    repository.getDebugSnapshot().shortTermMemories[0]!,
    embeddingClient
  );

  const report = await evaluateRetrievalBenchmark(repository, [{
    caseId: "case_blue_harbor",
    query: "Where did the user visit?",
    goldFactIds: ["fact_blue_harbor"],
    goldSessionIds: ["session_a"],
    sourceIds: ["source_session_a"],
    sessionSourceIds: { session_a: "source_session_a" },
    tenantId: "local",
    principalId: "benchmark-user"
  }], {
    limit: 100,
    ks: [1, 100],
    embeddingClient
  });

  assert.equal(report.metrics.fact[0]?.recallAtK, 1);
  assert.equal(report.metrics.session[0]?.recallAtK, 1);
  assert.equal(report.cases[0]?.candidates[0]?.id, "stm_blue_harbor");
  assert.deepEqual(report.cases[0]?.candidates[0]?.factIds, ["fact_blue_harbor"]);
  assert.deepEqual(report.cases[0]?.candidates[0]?.sessionIds, ["session_a"]);
  assert.deepEqual(report.diagnosticCounts, {
    retrieved: 2,
    not_in_top_k: 0,
    filtered_before_top_k: 0,
    memory_not_indexed: 0,
    source_not_ingested: 0,
    fact_not_generated: 0,
    fact_not_admitted: 0,
    memory_not_generated: 0
  });
});

test("SQLite retrieval stores can be reopened read-only without migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retrieval-readonly-"));
  const storePath = join(directory, "store.sqlite");
  const writer = new SqliteContextEngineRepository(storePath);
  await writer.saveFactItem({
    factId: "fact_readonly",
    factType: "test",
    factText: "Read-only fact",
    normalizedClaim: "read-only fact",
    linkedEventIds: ["event_readonly"],
    linkedSegmentIds: ["segment_readonly"],
    linkedSourceRefs: [{ sourceRefId: "src_readonly", sourceType: "file", sourceId: "readonly" }],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-01-01T00:00:00.000Z",
    validTimeStart: "2026-01-01T00:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  });
  writer.close();

  const reader = new SqliteContextEngineRepository(storePath, undefined, {
    loadCache: true,
    readOnly: true
  });
  assert.equal(reader.getDebugSnapshot().facts.some((fact) => fact.factId === "fact_readonly"), true);
  reader.close();
});

function candidate(
  rank: number,
  targets: Pick<RetrievalBenchmarkCandidate, "factIds" | "sessionIds">
): RetrievalBenchmarkCandidate {
  return {
    rank,
    id: `stm_${rank}`,
    layer: "stm",
    score: 1 / rank,
    scoreBreakdown: {
      keyword: 0,
      vector: 0,
      graph: 0,
      recency: 0,
      importance: 0,
      retrievalWeight: 0,
      userRetrievalWeight: 0,
      sourceReliability: 0,
      feedback: 0,
      diversity: 0,
      conflictPenalty: 0,
      permissionRiskPenalty: 0,
      stalenessPenalty: 0,
      route: { keyword: 0, vector: 0, graph: 0, time: 0, feedback: 0 },
      rrf: 0
    },
    factIds: targets.factIds,
    sessionIds: targets.sessionIds,
    reason: "test",
    status: "active"
  };
}
