import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHealthServer } from "../../modules/health/server.js";
import { getLongMemEvalStorePath } from "./longmemeval.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { longMemEvalArtifactStore } from "./longmemeval-artifacts.js";

test("parses LongMemEval JSONL result pages through the API", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const basename = `api-jsonl-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
  const resultPath = longMemEvalArtifactStore.resolveBasename(basename);
  try {
    await writeFile(
      resultPath,
      [
      JSON.stringify({
        questionId: "q1",
        questionType: "single-session-user",
        question: "What degree?",
        answer: "Business Administration",
        hypothesis: "Business Administration",
        exactMatch: true,
        judgment: { label: "correct", score: 1, reason: "exact_match" },
        answerContext: { selectedItemIds: ["stm-1"], droppedSummary: { token_budget_exceeded: 1 } }
      }),
      JSON.stringify({
        questionId: "q2",
        questionType: "single-session-user",
        question: "How long?",
        answer: "45 minutes each way",
        hypothesis: "30 minutes",
        judgment: { label: "incorrect", score: 0, reason: "wrong_answer" }
      })
      ].join("\n"),
      "utf8"
    );

  const response = await server.inject({
    method: "GET",
    url: `/context/evaluations/longmemeval/jsonl-results?path=${encodeURIComponent(resultPath)}&page=1&pageSize=1`
  });
  const json = response.json() as {
    ok?: boolean;
    result?: {
      page: number;
      totalPages: number;
      summary: {
        totalItems: number;
        accuracy?: number;
        errorReasons: Record<string, number>;
        selection: { totalSelectedItems: number };
      };
      items: Array<{ questionId: string }>;
    };
  };

  assert.equal(response.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.result?.page, 1);
  assert.equal(json.result?.totalPages, 2);
  assert.equal(json.result?.summary.totalItems, 2);
  assert.equal(json.result?.summary.accuracy, 0.5);
  assert.deepEqual(json.result?.summary.errorReasons, { wrong_answer: 1 });
  assert.equal(json.result?.summary.selection.totalSelectedItems, 1);
  assert.deepEqual(json.result?.items.map((item) => item.questionId), ["q1"]);

  } finally {
    await server.close();
    await unlink(resultPath).catch(() => undefined);
  }
});

test("rejects unmanaged JSONL result paths", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  try {
    const response = await server.inject({
      method: "GET",
      url: `/context/evaluations/longmemeval/jsonl-results?path=${encodeURIComponent("/tmp/outside.jsonl")}`
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /outside the data directory/);
  } finally {
    await server.close();
  }
});

test("reads flushed job results and selects the requested model artifact", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await server.inject({
    method: "POST",
    url: "/context/evaluations/longmemeval",
    payload: {
      datasetPath: `missing-${suffix}.json`,
      resultFileName: `job-results-${suffix}.jsonl`,
      traceFileName: `job-results-${suffix}-trace.jsonl`,
      llmRuns: [{ runId: "model-a" }, { runId: "model-b" }]
    }
  });
  const snapshot = response.json().result as {
    jobId: string;
    modelArtifacts: Array<{ modelRunId: string; resultPath: string }>;
  };
  const artifact = snapshot.modelArtifacts.find((item) => item.modelRunId === "model-b")!;
  try {
    await writeFile(artifact.resultPath, `${JSON.stringify({
      runId: "run-b",
      modelRunId: "model-b",
      sampleIndex: 1,
      sampleIdentity: { index: 1, questionId: "q1" },
      questionId: "q1",
      correct: true
    })}\n`, "utf8");
    const pageResponse = await server.inject({
      method: "GET",
      url: `/context/evaluations/longmemeval/${snapshot.jobId}/results?page=1&pageSize=10&modelRunId=model-b`
    });
    assert.equal(pageResponse.statusCode, 200, pageResponse.body);
    assert.deepEqual(pageResponse.json().result.items.map((item: { modelRunId: string }) => item.modelRunId), ["model-b"]);
  } finally {
    await server.close();
    await Promise.all(snapshot.modelArtifacts.map((item) => unlink(item.resultPath).catch(() => undefined)));
  }
});

test("looks up LongMemEval selected item details through the API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "longmemeval-selected-items-"));
  const datasetPath = resolve(join(directory, "dataset.json"));
  await writeFile(datasetPath, JSON.stringify([{
    question_id: "q1",
    question_type: "single-session-user",
    question: "What degree?",
    answer: "Business Administration",
    answer_session_ids: ["s1"],
    haystack_session_ids: ["s1"],
    haystack_sessions: [[{ role: "user", content: "I studied Business Administration." }]]
  }]), "utf8");
  const storePath = getLongMemEvalStorePath(datasetPath);
  const repository = new SqliteContextEngineRepository(storePath);
  await repository.saveFactItem({
    factId: "fact-1",
    factType: "text",
    factText: "Business Administration",
    normalizedClaim: "Business Administration",
    linkedEventIds: [],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2023-05-30T00:00:00.000Z",
    validTimeStart: "2023-05-30T00:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  });
  repository.close();
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const response = await server.inject({
    method: "POST",
    url: "/context/evaluations/longmemeval/selected-items",
    payload: {
      datasetPath,
      questionId: "q1",
      selectedItemIds: ["fact-1", "missing"]
    }
  });
  const json = response.json() as {
    ok?: boolean;
    result?: {
      datasetPath: string;
      questionId: string;
      question: string;
      selectedItemIds: string[];
      items: Array<{ id: string; layer: string }>;
      missingItemIds: string[];
    };
  };

  assert.equal(response.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.result?.datasetPath, datasetPath);
  assert.equal(json.result?.questionId, "q1");
  assert.deepEqual(json.result?.selectedItemIds, ["fact-1", "missing"]);
  assert.deepEqual(json.result?.items.map((item) => `${item.layer}:${item.id}`), ["fact:fact-1"]);
  assert.deepEqual(json.result?.missingItemIds, ["missing"]);

  await server.close();
  await Promise.all([
    rm(storePath, { force: true }),
    rm(`${storePath}-shm`, { force: true }),
    rm(`${storePath}-wal`, { force: true })
  ]);
});
