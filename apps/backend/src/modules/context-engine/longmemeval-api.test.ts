import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHealthServer } from "../../modules/health/server.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { getLongMemEvalStorePath, ingestLongMemEvalDataset } from "./longmemeval.js";
import { LONGMEMEVAL_DATA_DIRECTORY } from "./longmemeval-artifacts.js";

function createApiTestArtifacts(prefix: string) {
  const suffix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const resultFileName = `${suffix}-result.jsonl`;
  const traceFileName = `${suffix}-trace.jsonl`;
  return {
    resultFileName,
    traceFileName,
    async cleanup() {
      await Promise.all([
        rm(join(LONGMEMEVAL_DATA_DIRECTORY, resultFileName), { force: true }),
        rm(join(LONGMEMEVAL_DATA_DIRECTORY, traceFileName), { force: true }),
        rm(join(LONGMEMEVAL_DATA_DIRECTORY, `${resultFileName}.lock`), { force: true })
      ]);
    }
  };
}

const apiTestEvaluationOptions = {
  disableIngestLlm: true,
  skipStmAdmission: true,
  skipLtmDreaming: true,
  llm: {
    extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "" },
    judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "" }
  }
};

async function waitForLongMemEvalJob(server: ReturnType<typeof createHealthServer>, jobId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot: { result?: { status?: string; [key: string]: unknown } } = {};
  while (Date.now() < deadline) {
    snapshot = (await server.inject({
      method: "GET",
      url: `/context/evaluations/longmemeval/${jobId}`
    })).json() as typeof snapshot;
    if (["done", "error", "cancelled"].includes(snapshot.result?.status ?? "")) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return snapshot;
}

test("LongMemEval context pack preview requires a sample question id", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const response = await server.inject({
    method: "POST",
    url: "/context/evaluations/longmemeval/context-pack-preview",
    headers: { "content-type": "application/json" },
    payload: {
      datasetPath: "/tmp/longmemeval.json",
      task: "What did I mention?"
    }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "questionId is required");
});

test("LongMemEval job accepts managed artifacts, resume options, and independent concurrency", async (t) => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifacts = createApiTestArtifacts("api-options");
  t.after(() => artifacts.cleanup());
  try {
    const response = await server.inject({
      method: "POST",
      url: "/context/evaluations/longmemeval",
      payload: {
        datasetPath: `missing-${suffix}.json`,
        resultFileName: artifacts.resultFileName,
        traceFileName: artifacts.traceFileName,
        resume: true,
        retrySkipped: true,
        resumeLegacy: true,
        ingestSampleConcurrency: 2,
        ingestSessionConcurrency: 3,
        answerConcurrency: 4,
        judgeConcurrency: 5
      }
    });
    const snapshot = response.json().result as {
      resultPath: string;
      tracePath: string;
      resume: boolean;
      retrySkipped: boolean;
      resumeLegacy: boolean;
      effectiveConcurrency: Record<string, number>;
    };
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(snapshot.resultPath.endsWith(`apps/backend/data/${artifacts.resultFileName}`), true);
    assert.equal(snapshot.tracePath.endsWith(`apps/backend/data/${artifacts.traceFileName}`), true);
    assert.equal(snapshot.resume, true);
    assert.equal(snapshot.retrySkipped, true);
    assert.equal(snapshot.resumeLegacy, true);
    assert.deepEqual(snapshot.effectiveConcurrency, { model: 1, sample: 2, session: 3, answer: 4, judge: 5 });
  } finally {
    await server.close();
  }
});

test("LongMemEval job rejects unsafe artifact names and resume-only options", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  try {
    const unsafe = await server.inject({
      method: "POST",
      url: "/context/evaluations/longmemeval",
      payload: { datasetPath: "missing.json", resultFileName: "../outside.jsonl" }
    });
    const invalidResume = await server.inject({
      method: "POST",
      url: "/context/evaluations/longmemeval",
      payload: { datasetPath: "missing.json", retrySkipped: true }
    });
    const unsafeModelArtifact = await server.inject({
      method: "POST",
      url: "/context/evaluations/longmemeval",
      payload: {
        datasetPath: "missing.json",
        llmRuns: [{ runId: "unsafe", diagnosticsPath: "/tmp/model-result.jsonl", tracePath: "/tmp/model-trace.jsonl" }]
      }
    });
    assert.equal(unsafe.statusCode, 400);
    assert.match(unsafe.json().error, /basename/);
    assert.equal(invalidResume.statusCode, 400);
    assert.match(invalidResume.json().error, /require resume=true/);
    assert.equal(unsafeModelArtifact.statusCode, 400);
    assert.match(unsafeModelArtifact.json().error, /outside the data directory/);
  } finally {
    await server.close();
  }
});

test("LongMemEval context pack preview isolates samples that reuse a session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-preview-isolation-"));
  const datasetPath = join(dir, "sample.json");
  await writeFile(datasetPath, JSON.stringify([
    {
      question_id: "preview_q1",
      question_type: "single-session-user",
      question: "What play did I attend at the local community theater?",
      answer: "玻璃动物园",
      answer_session_ids: ["shared_session"],
      haystack_session_ids: ["shared_session"],
      haystack_dates: ["2023/05/29 (Mon) 09:00"],
      haystack_sessions: [[
        { role: "user", content: "我在本地社区剧院看了《玻璃动物园》。", has_answer: true }
      ]]
    },
    {
      question_id: "preview_q2",
      question_type: "single-session-user",
      question: "What other play did I see?",
      answer: "Hamlet",
      answer_session_ids: ["shared_session"],
      haystack_session_ids: ["shared_session"],
      haystack_dates: ["2023/05/30 (Tue) 09:00"],
      haystack_sessions: [[
        { role: "user", content: "I saw Hamlet on a different occasion.", has_answer: true }
      ]]
    }
  ]), "utf8");

  const resolvedDatasetPath = resolve(datasetPath);
  const storePath = getLongMemEvalStorePath(resolvedDatasetPath);
  try {
    const repository = new SqliteContextEngineRepository(storePath);
    try {
      await ingestLongMemEvalDataset(repository, resolvedDatasetPath, {
        llm: { apiKey: "" }
      });
    } finally {
      repository.close();
    }

    const server = createHealthServer(new InMemoryContextEngineRepository());
    const response = await server.inject({
      method: "POST",
      url: "/context/evaluations/longmemeval/context-pack-preview",
      headers: { "content-type": "application/json" },
      payload: {
        datasetPath: resolvedDatasetPath,
        questionId: "preview_q1",
        task: "ignored preview task",
        q: "玻璃动物园",
        includeInactive: true,
        llm: { apiKey: "" }
      }
    });

    assert.equal(response.statusCode, 200, response.body);
    const pack = response.json().result as {
      task: string;
      serializedPrompt: string;
      citations: Array<{ sourceId: string }>;
    };
    assert.equal(pack.task, "What play did I attend at the local community theater?");
    assert.equal(pack.serializedPrompt.includes("Hamlet"), false);
    assert.equal(pack.citations.every((citation) =>
      citation.sourceId.startsWith("longmemeval_event_preview_q1_")
    ), true);
  } finally {
    await Promise.all([
      rm(storePath, { force: true }),
      rm(`${storePath}-shm`, { force: true }),
      rm(`${storePath}-wal`, { force: true })
    ]);
  }
});

test("evaluates the LongMemEval fixture through the API", async (t) => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const artifacts = createApiTestArtifacts("api-evaluate");
  t.after(() => artifacts.cleanup());
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-api-"));
  const datasetPath = join(dir, "sample.json");
  await writeFile(
    datasetPath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s2",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "alpha" }
          ],
          [
            { role: "user", content: "beta" }
          ]
        ]
      },
      {
        question_id: "q2",
        question_type: "temporal-reasoning",
        question: "When?",
        answer: "t1",
        answer_session_ids: ["t1"],
        haystack_session_ids: ["t2", "t1"],
        haystack_sessions: [
          [
            { role: "user", content: "gamma" }
          ],
          [
            { role: "user", content: "delta" }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const response = await server.inject({
    method: "POST",
    url: "/context/evaluations/longmemeval",
    headers: { "content-type": "application/json" },
    payload: {
      datasetPath,
      ks: [1, 5],
      resultFileName: artifacts.resultFileName,
      traceFileName: artifacts.traceFileName,
      ...apiTestEvaluationOptions,
      llm: {
        ...apiTestEvaluationOptions.llm,
        judge: { ...apiTestEvaluationOptions.llm.judge, model: "gpt-4.1-mini" }
      }
    }
  });

  assert.equal(response.statusCode, 200);
  const json = response.json() as {
    ok?: boolean;
      result?: {
        jobId: string;
        status: string;
        totalSamples?: number;
        progress?: number;
        processedSteps?: number;
        batchIndex?: number;
        batchCount?: number;
        batchProgress?: number;
        batchMessage?: string;
      };
  };

  assert.equal(json.ok, true);
  assert.equal(typeof json.result?.jobId, "string");
  assert.equal(json.result?.status === "queued" || json.result?.status === "running", true);
  assert.equal(typeof json.result?.processedSteps === "number" || typeof json.result?.processedSteps === "undefined", true);

  let finalPayload = await waitForLongMemEvalJob(server, json.result!.jobId) as {
      result?: {
        status?: string;
        report?: {
          totalSamples: number;
          questionTypeCounts: Record<string, number>;
          ingestion?: { totalSessions: number };
          samples?: unknown[];
        };
        batchIndex?: number;
      };
    };
  finalPayload = (await server.inject({
    method: "GET",
    url: `/context/evaluations/longmemeval/${json.result?.jobId}`
  })).json() as typeof finalPayload;

  assert.equal(finalPayload?.result?.status, "done");
  assert.equal(finalPayload?.result?.report && "samples" in finalPayload.result.report, false);

  const samplesResponse = await server.inject({
    method: "GET",
    url: `/context/evaluations/longmemeval/${json.result?.jobId}/samples?page=2&pageSize=1`
  });
  const samplesPayload = samplesResponse.json() as {
    ok?: boolean;
    result?: {
      totalSamples: number;
      page: number;
      pageSize: number;
      totalPages: number;
      samples: Array<{ questionId: string }>;
    };
  };
  assert.equal(samplesResponse.statusCode, 200);
  assert.equal(samplesPayload.ok, true);
  assert.equal(samplesPayload.result?.totalSamples, 2);
  assert.equal(samplesPayload.result?.page, 2);
  assert.equal(samplesPayload.result?.pageSize, 1);
  assert.equal(samplesPayload.result?.totalPages, 2);
  assert.deepEqual(samplesPayload.result?.samples.map((sample) => sample.questionId), ["q2"]);

  await server.close();
});

test("accepts retrieval answer context mode through the API job", async (t) => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const artifacts = createApiTestArtifacts("api-retrieval");
  t.after(() => artifacts.cleanup());
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-api-retrieval-"));
  const datasetPath = join(dir, "sample.json");
  await writeFile(
    datasetPath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "Which word?",
        answer: "alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "alpha" }]]
      }
    ]),
    "utf8"
  );

  const response = await server.inject({
    method: "POST",
    url: "/context/evaluations/longmemeval",
    headers: { "content-type": "application/json" },
    payload: {
      datasetPath,
      ks: [1],
      resultFileName: artifacts.resultFileName,
      traceFileName: artifacts.traceFileName,
      ...apiTestEvaluationOptions,
      answerContextMode: "retrieval"
    }
  });

  assert.equal(response.statusCode, 200);
  const json = response.json() as { ok?: boolean; result?: { jobId?: string; answerContextMode?: string } };
  assert.equal(json.ok, true);
  assert.equal(json.result?.answerContextMode, "retrieval");

  await server.inject({
    method: "POST",
    url: `/context/evaluations/longmemeval/${json.result?.jobId}/cancel`
  });

  await server.close();
});

test("reports job errors when LongMemEval evaluation fails", async (t) => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const artifacts = createApiTestArtifacts("api-error");
  t.after(() => artifacts.cleanup());
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-api-error-"));
  const datasetPath = join(dir, "sample.json");
  await writeFile(
    datasetPath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s2",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "alpha" }
          ],
          [
            { role: "user", content: "beta" }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const response = await server.inject({
    method: "POST",
    url: "/context/evaluations/longmemeval",
    headers: { "content-type": "application/json" },
    payload: {
      datasetPath,
      ks: [1],
      resultFileName: artifacts.resultFileName,
      traceFileName: artifacts.traceFileName,
      ...apiTestEvaluationOptions
    }
  });

  assert.equal(response.statusCode, 200);
  const json = response.json() as { result?: { jobId?: string } };
  assert.equal(typeof json.result?.jobId, "string");

  const job = await waitForLongMemEvalJob(server, json.result?.jobId ?? "") as {
      result?: {
        status?: string;
        error?: string;
      };
    };

  assert.equal(job?.result?.status, "done");
  await server.close();
});

test("cancels a queued or running LongMemEval job through the API", async (t) => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const artifacts = createApiTestArtifacts("api-cancel");
  t.after(() => artifacts.cleanup());
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-api-cancel-"));
  const datasetPath = join(dir, "sample.json");
  await writeFile(
    datasetPath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s2",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [{ role: "user", content: "alpha" }],
          [{ role: "user", content: "beta" }]
        ]
      }
    ]),
    "utf8"
  );

  const response = await server.inject({
    method: "POST",
    url: "/context/evaluations/longmemeval",
    headers: { "content-type": "application/json" },
    payload: {
      datasetPath,
      ks: [1],
      resultFileName: artifacts.resultFileName,
      traceFileName: artifacts.traceFileName,
      ...apiTestEvaluationOptions
    }
  });
  const json = response.json() as { result?: { jobId?: string } };
  assert.equal(typeof json.result?.jobId, "string");

  const cancelResponse = await server.inject({
    method: "POST",
    url: `/context/evaluations/longmemeval/${json.result?.jobId}/cancel`
  });
  const cancelJson = cancelResponse.json() as { ok?: boolean; result?: { status?: string; error?: string } };

  assert.equal(cancelResponse.statusCode, 200);
  assert.equal(cancelJson.ok, true);
  assert.equal(cancelJson.result?.status, "cancelled");
  assert.equal(cancelJson.result?.error, "LongMemEval evaluation cancelled");

  await server.close();
});
