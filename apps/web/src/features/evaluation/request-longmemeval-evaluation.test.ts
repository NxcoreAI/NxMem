import test from "node:test";
import assert from "node:assert/strict";
import { buildLongMemEvalLlmTestPayload, requestCancelLongMemEvalJob, requestClearLongMemEvalDatabase, requestLongMemEvalEvaluation, requestLongMemEvalJob, requestLongMemEvalJobResults, requestLongMemEvalJsonlResults, requestLongMemEvalSamples, requestLongMemEvalSelectedItemDetails } from "./request-longmemeval-evaluation.js";

test("requestLongMemEvalEvaluation posts dataset path and k values", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return new Response(JSON.stringify({ ok: true, result: { totalSamples: 500, questionTypeCounts: {}, metrics: {} } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestLongMemEvalEvaluation(fetchImpl, {
    datasetPath: "../../datasets/LongMemEval/longmemeval_s_cleaned.json",
    ks: [1, 5],
    llm: {
      extraction: { model: "gpt-4o-mini" },
      judge: { model: "gpt-4.1-mini" }
    },
    modelOnlyEvaluation: true,
    enableLtmReinforcement: true,
    answerContextMode: "retrieval",
    disableIngestLlm: true,
    skipStmAdmission: true,
    skipLtmDreaming: true
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/context/evaluations/longmemeval");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    datasetPath: "../../datasets/LongMemEval/longmemeval_s_cleaned.json",
    ks: [1, 5],
    resultFileName: "longmemeval-result.jsonl",
    modelOnlyEvaluation: true,
    enableLtmReinforcement: true,
    answerContextMode: "retrieval",
    disableIngestLlm: true,
    skipStmAdmission: true,
    skipLtmDreaming: true,
    llm: {
      extraction: { model: "gpt-4o-mini" },
      judge: { model: "gpt-4.1-mini" }
    }
  });
  assert.equal(response.ok, true);
});

test("requestLongMemEvalEvaluation posts parallel model runs", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return new Response(JSON.stringify({ ok: true, result: { jobId: "job-1", status: "queued" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestLongMemEvalEvaluation(fetchImpl, {
    datasetPath: "longmemeval.json",
    ks: [1],
    modelConcurrency: 20,
    ingestSampleConcurrency: 4,
    ingestSessionConcurrency: 8,
    evalBatchSize: 6,
    llmRuns: [
      { runId: "gpt-4o-mini", llm: { extraction: { model: "gpt-4o-mini" }, judge: { model: "gpt-4.1-mini" } } },
      { runId: "gpt-4.1", llm: { extraction: { model: "gpt-4.1" }, judge: { model: "gpt-4.1-mini" } } }
    ]
  });

  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    datasetPath: "longmemeval.json",
    ks: [1],
    resultFileName: "longmemeval-result.jsonl",
    modelConcurrency: 20,
    ingestSampleConcurrency: 4,
    ingestSessionConcurrency: 8,
    evalBatchSize: 6,
    llmRuns: [
      { runId: "gpt-4o-mini", llm: { extraction: { model: "gpt-4o-mini" }, judge: { model: "gpt-4.1-mini" } } },
      { runId: "gpt-4.1", llm: { extraction: { model: "gpt-4.1" }, judge: { model: "gpt-4.1-mini" } } }
    ]
  });
});

test("buildLongMemEvalLlmTestPayload falls back judge settings to extraction settings", () => {
  assert.deepEqual(
    buildLongMemEvalLlmTestPayload({
      extractionBaseUrl: "https://extract.example.com/v1",
      extractionModel: "extract-model",
      extractionApiKey: "extract-key",
      judgeBaseUrl: "",
      judgeModel: "",
      judgeApiKey: ""
    }, "judge"),
    {
      baseUrl: "https://extract.example.com/v1",
      model: "extract-model",
      apiKey: "extract-key"
    }
  );
});

test("buildLongMemEvalLlmTestPayload uses extraction settings for ingest tests", () => {
  assert.deepEqual(
    buildLongMemEvalLlmTestPayload({
      extractionBaseUrl: " https://extract.example.com/v1 ",
      extractionModel: " extract-model ",
      extractionApiKey: " extract-key ",
      judgeBaseUrl: "https://judge.example.com/v1",
      judgeModel: "judge-model",
      judgeApiKey: "judge-key"
    }, "ingest"),
    {
      baseUrl: "https://extract.example.com/v1",
      model: "extract-model",
      apiKey: "extract-key"
    }
  );
});

test("buildLongMemEvalLlmTestPayload uses extraction settings for answer tests", () => {
  assert.deepEqual(
    buildLongMemEvalLlmTestPayload({
      extractionBaseUrl: " https://answer.example.com/v1 ",
      extractionModel: " answer-model ",
      extractionApiKey: " answer-key ",
      judgeBaseUrl: "https://judge.example.com/v1",
      judgeModel: "judge-model",
      judgeApiKey: "judge-key"
    }, "answer"),
    {
      baseUrl: "https://answer.example.com/v1",
      model: "answer-model",
      apiKey: "answer-key"
    }
  );
});

test("requestLongMemEvalJob fetches longmemeval job status", async () => {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push({ url: typeof url === "string" ? url : url.toString() });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        jobId: "job-1",
        datasetPath: "dataset.json",
        ks: [1],
        status: "running",
        progress: 42,
        batchIndex: 3,
        batchCount: 12,
        batchProgress: 25,
        batchMessage: "时间轴聚合批次",
        currentSampleIndex: 3,
        currentSampleCount: 500,
        activeSamples: [{
          sampleIndex: 3,
          questionId: "q3",
          questionType: "single-session-user",
          contextScopeId: "longmemeval:q3",
          modelRunId: "default",
          storeNamespace: "default",
          stage: "answer",
          status: "started",
          updatedAt: "2026-08-12T10:00:00.000Z"
        }],
        currentSessionIndex: 18,
        currentSessionCount: 80,
        currentSessionId: "sess_18",
        currentSessionDate: "2023-04-10"
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestLongMemEvalJob(fetchImpl, "job-1");

  assert.equal(calls[0]?.url, "/context/evaluations/longmemeval/job-1");
  assert.equal(response.ok, true);
  assert.equal(response.result?.progress, 42);
  assert.equal(response.result?.batchIndex, 3);
  assert.equal(response.result?.batchMessage, "时间轴聚合批次");
  assert.equal(response.result?.currentSampleIndex, 3);
  assert.equal(response.result?.activeSamples?.[0]?.questionId, "q3");
  assert.equal(response.result?.currentSessionDate, "2023-04-10");
});

test("requestLongMemEvalSamples fetches a paged sample list", async () => {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push({ url: typeof url === "string" ? url : url.toString() });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        jobId: "job-1",
        datasetPath: "dataset.json",
        totalSamples: 12,
        page: 2,
        pageSize: 5,
        totalPages: 3,
        samples: []
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestLongMemEvalSamples(fetchImpl, "job-1", 2, 5);

  assert.equal(calls[0]?.url, "/context/evaluations/longmemeval/job-1/samples?page=2&pageSize=5");
  assert.equal(response.ok, true);
  assert.equal(response.result?.page, 2);
  assert.equal(response.result?.pageSize, 5);
});

test("requestLongMemEvalJsonlResults fetches a paged JSONL result list", async () => {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push({ url: typeof url === "string" ? url : url.toString() });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        summary: {
          filePath: "data/result.jsonl",
          totalItems: 2,
          judgedItems: 2,
          correctItems: 1,
          incorrectItems: 1,
          accuracy: 0.5,
          exactMatchItems: 1,
          exactMatchAccuracy: 0.5,
          answerFallbacks: 0,
          questionTypeAccuracy: {},
          errorReasons: { wrong_answer: 1 },
          selection: { rowsWithSelection: 1, totalSelectedItems: 2, droppedReasons: {} }
        },
        page: 1,
        pageSize: 20,
        totalPages: 1,
        items: []
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestLongMemEvalJsonlResults(fetchImpl, "data/result.jsonl", 1, 20);

  assert.equal(calls[0]?.url, "/context/evaluations/longmemeval/jsonl-results?path=data%2Fresult.jsonl&page=1&pageSize=20");
  assert.equal(response.ok, true);
  assert.equal(response.result?.summary.accuracy, 0.5);
});

test("requestLongMemEvalEvaluation posts artifact, resume, and independent concurrency options", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true, result: { jobId: "job-resume", status: "queued" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  await requestLongMemEvalEvaluation(fetchImpl, {
    datasetPath: "dataset.json",
    ks: [1],
    resultFileName: "resume-result.jsonl",
    traceFileName: "resume-trace.jsonl",
    resume: true,
    retrySkipped: true,
    resumeLegacy: true,
    answerConcurrency: 3,
    judgeConcurrency: 2
  });

  assert.deepEqual(body, {
    datasetPath: "dataset.json",
    ks: [1],
    resultFileName: "resume-result.jsonl",
    traceFileName: "resume-trace.jsonl",
    resume: true,
    retrySkipped: true,
    resumeLegacy: true,
    answerConcurrency: 3,
    judgeConcurrency: 2
  });
});

test("requestLongMemEvalJobResults fetches running results with an optional model filter", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(typeof url === "string" ? url : url.toString());
    return new Response(JSON.stringify({ ok: true, result: { items: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  await requestLongMemEvalJobResults(fetchImpl, "job/one", 2, 50, "model a");

  assert.equal(calls[0], "/context/evaluations/longmemeval/job%2Fone/results?page=2&pageSize=50&modelRunId=model+a");
});

test("requestCancelLongMemEvalJob posts cancellation request", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        jobId: "job-1",
        datasetPath: "dataset.json",
        ks: [1],
        status: "cancelled"
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestCancelLongMemEvalJob(fetchImpl, "job-1");

  assert.equal(calls[0]?.url, "/context/evaluations/longmemeval/job-1/cancel");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(response.result?.status, "cancelled");
});

test("requestCancelLongMemEvalJob converts transport failures into errors", async () => {
  const fetchImpl = (async () => {
    throw new Error("socket hang up");
  }) as typeof fetch;

  const response = await requestCancelLongMemEvalJob(fetchImpl, "job-1");

  assert.equal(response.ok, false);
  assert.equal(response.error, "socket hang up");
});

test("requestClearLongMemEvalDatabase deletes the isolated evaluation database", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        storage: {
          storeDirectory: "/tmp/longmemeval",
          deletedFiles: ["/tmp/longmemeval/a.sqlite"]
        },
        graphStore: {
          status: "cleared",
          mode: "neo4j",
          database: "longmemeval"
        }
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestClearLongMemEvalDatabase(fetchImpl);

  assert.equal(calls[0]?.url, "/context/evaluations/longmemeval/database");
  assert.equal(calls[0]?.init?.method, "DELETE");
  assert.equal(response.result?.storage.deletedFiles.length, 1);
  assert.equal(response.result?.graphStore.status, "cleared");
});

test("requestLongMemEvalEvaluation surfaces api errors", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: false, error: "datasetPath is required" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const response = await requestLongMemEvalEvaluation(fetchImpl, {
    datasetPath: "",
    ks: [1]
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, "datasetPath is required");
});

test("requestLongMemEvalEvaluation converts transport failures into errors", async () => {
  const fetchImpl = (async () => {
    throw new Error("socket hang up");
  }) as typeof fetch;

  const response = await requestLongMemEvalEvaluation(fetchImpl, {
    datasetPath: "../../datasets/LongMemEval/longmemeval_s_cleaned.json",
    ks: [1]
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, "socket hang up");
});

test("requestLongMemEvalSelectedItemDetails posts dataset path and selected ids", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        datasetPath: "dataset.json",
        selectedItemIds: ["stm-1"],
        items: [{ id: "stm-1", layer: "stm", content: "hello", metadata: {} }],
        missingItemIds: []
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const response = await requestLongMemEvalSelectedItemDetails(fetchImpl, "dataset.json", "q1", ["stm-1"]);

  assert.equal(calls[0]?.url, "/context/evaluations/longmemeval/selected-items");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    datasetPath: "dataset.json",
    questionId: "q1",
    selectedItemIds: ["stm-1"]
  });
  assert.equal(response.ok, true);
  assert.equal(response.result?.items[0]?.id, "stm-1");
});
