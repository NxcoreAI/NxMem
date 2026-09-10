import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cancelLongMemEvalJob, createLongMemEvalJob, getLongMemEvalJob } from "./longmemeval-jobs.js";
import { getLongMemEvalStorePath } from "./longmemeval.js";
import { longMemEvalArtifactStore } from "./longmemeval-artifacts.js";
import { getContextEngineConfig } from "../../config.js";

test("LongMemEval job exposes startup progress before the first evaluation callback", () => {
  const snapshot = createLongMemEvalJob({
    datasetPath: "missing-longmemeval-dataset.json",
    ks: [1, 5]
  });

  assert.equal(snapshot.status === "queued" || snapshot.status === "running", true);
  assert.equal(snapshot.stage, "ingest");
  assert.equal(snapshot.progress, 1);
  assert.equal(snapshot.stageProgress, 1);
  assert.equal(snapshot.stageMessage, "counting_samples");
  assert.equal(snapshot.allowLlmFallback, true);
});

test("LongMemEval job keeps strict LLM mode when fallback is explicitly disabled", () => {
  const snapshot = createLongMemEvalJob({
    datasetPath: "missing-strict-longmemeval-dataset.json",
    ks: [1, 5],
    allowLlmFallback: false
  });

  assert.equal(snapshot.allowLlmFallback, false);
});

test("LongMemEval job exposes managed artifacts, recovery options, and effective concurrency", () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const snapshot = createLongMemEvalJob({
    datasetPath: `missing-${suffix}.json`,
    ks: [1],
    resultBasename: `job-${suffix}.jsonl`,
    traceBasename: `job-${suffix}-trace.jsonl`,
    resume: true,
    retrySkipped: true,
    resumeLegacy: true,
    modelConcurrency: 7,
    ingestSampleConcurrency: 3,
    ingestSessionConcurrency: 4,
    answerConcurrency: 5,
    judgeConcurrency: 2,
    llmRuns: [{ runId: "model/a" }, { runId: "model-b" }]
  });

  assert.equal(snapshot.resultPath?.endsWith(`apps/backend/data/job-${suffix}.jsonl`), true);
  assert.equal(snapshot.tracePath?.endsWith(`apps/backend/data/job-${suffix}-trace.jsonl`), true);
  assert.equal(snapshot.resume, true);
  assert.equal(snapshot.retrySkipped, true);
  assert.equal(snapshot.resumeLegacy, true);
  assert.deepEqual(snapshot.effectiveConcurrency, { model: 2, sample: 3, session: 4, answer: 5, judge: 2 });
  assert.deepEqual(snapshot.modelArtifacts?.map((artifact) => artifact.modelRunId), ["model_a", "model-b"]);
  assert.equal(snapshot.modelArtifacts?.[0]?.resultPath?.endsWith(`job-${suffix}.model_a.jsonl`), true);
  assert.equal(snapshot.modelArtifacts?.[1]?.tracePath?.endsWith(`job-${suffix}-trace.model-b.jsonl`), true);
});

test("LongMemEval jobs reject concurrent writes to the same result artifact", async () => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), "longmemeval-job-lock-"));
  const datasetPath = join(directory, "sample.json");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const resultBasename = `job-lock-${suffix}.jsonl`;
  const firstTraceBasename = `job-lock-${suffix}-first-trace.jsonl`;
  const secondTraceBasename = `job-lock-${suffix}-second-trace.jsonl`;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let requestStarted: (() => void) | undefined;
  const requestStartedPromise = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/embeddings")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { input?: unknown } : {};
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({
        data: inputs.map((_, index) => ({
          index,
          embedding: [1, ...Array(Math.max(0, embeddingDimensions - 1)).fill(0)]
        }))
      });
    }
    requestStarted?.();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }) as typeof fetch;
  await writeFile(datasetPath, JSON.stringify([{
    question_id: "job_lock_q1",
    question_type: "single-session-user",
    question: "Which word?",
    answer: "Alpha",
    answer_session_ids: ["job_lock_s1"],
    haystack_session_ids: ["job_lock_s1"],
    haystack_sessions: [[{ role: "user", content: "Alpha" }]]
  }]), "utf8");

  const first = createLongMemEvalJob({
    datasetPath,
    ks: [1],
    resultBasename,
    traceBasename: firstTraceBasename,
    disableIngestLlm: true,
    skipStmAdmission: true,
    skipLtmDreaming: true
  });
  try {
    await Promise.race([
      requestStartedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("first LongMemEval job did not reach an in-flight request")), 2_000))
    ]);
    const second = createLongMemEvalJob({
      datasetPath,
      ks: [1],
      resultBasename,
      traceBasename: secondTraceBasename,
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true
    });
    const secondFinal = await waitForJobStatus(second.jobId, ["error"], 2_000);
    assert.match(secondFinal.error ?? "", /already locked/);
    assert.equal(cancelLongMemEvalJob(first.jobId)?.status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
    cancelLongMemEvalJob(first.jobId);
    const artifactPaths = [
      longMemEvalArtifactStore.resolveBasename(resultBasename),
      longMemEvalArtifactStore.resolveBasename(firstTraceBasename),
      longMemEvalArtifactStore.resolveBasename(secondTraceBasename)
    ];
    const storePath = getLongMemEvalStorePath(datasetPath);
    await Promise.all([
      ...artifactPaths.flatMap((path) => [path, `${path}.lock`]).map((path) => unlink(path).catch(() => undefined)),
      ...[storePath, `${storePath}-shm`, `${storePath}-wal`].map((path) => unlink(path).catch(() => undefined))
    ]);
  }
});

async function waitForJobStatus(
  jobId: string,
  statuses: Array<NonNullable<ReturnType<typeof getLongMemEvalJob>>["status"]>,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = getLongMemEvalJob(jobId);
    if (snapshot && statuses.includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`LongMemEval job ${jobId} did not reach ${statuses.join("/")}`);
}
