import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  LongMemEvalArtifactError,
  LongMemEvalArtifactStore,
  LongMemEvalResultWriter,
  LongMemEvalTraceWriter,
  createLongMemEvalDatasetIdentity,
  openLongMemEvalArtifactRun,
  scanLongMemEvalResultRecovery,
  type LongMemEvalDatasetIdentity,
  type LongMemEvalSampleIdentity
} from "./longmemeval-artifacts.js";

test("LongMemEval 500-sample artifact benchmark records append, recovery, memory, and lock metrics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "longmemeval-artifacts-benchmark-"));
  const datasetPath = join(directory, "synthetic-dataset.json");
  const resultPath = join(directory, "result.jsonl");
  const tracePath = join(directory, "trace.jsonl");
  const sampleCount = 500;
  await writeFile(datasetPath, JSON.stringify(Array.from({ length: sampleCount }, (_, index) => ({
    question_id: `benchmark-q${index + 1}`
  }))), "utf8");
  const datasetIdentity: LongMemEvalDatasetIdentity = await createLongMemEvalDatasetIdentity(datasetPath);
  const samples: LongMemEvalSampleIdentity[] = Array.from({ length: sampleCount }, (_, offset) => ({
    index: offset + 1,
    questionId: `benchmark-q${offset + 1}`
  }));
  const startMemory = process.memoryUsage().rss;
  let peakMemory = startMemory;
  const memorySampler = setInterval(() => {
    peakMemory = Math.max(peakMemory, process.memoryUsage().rss);
  }, 5);
  const appendStarted = performance.now();
  const resultWriter = await LongMemEvalResultWriter.open({ path: resultPath, truncate: true });
  const traceWriter = await LongMemEvalTraceWriter.open(tracePath);
  await Promise.all(samples.map(async (sample) => {
    const resultCommit = resultWriter.commit({
      result: {
        datasetPath,
        sampleIndex: sample.index,
        sampleCount,
        questionId: sample.questionId,
        questionType: "single-session-user",
        question: `Question ${sample.index}`,
        answer: "Alpha",
        hypothesis: "Alpha",
        judgment: { label: "correct", reason: "deterministic benchmark" },
        exactMatch: true
      },
      runId: "benchmark-run",
      modelRunId: "benchmark-model",
      datasetIdentity,
      sampleIdentity: sample
    });
    const traceCommit = traceWriter.append({
      runId: "benchmark-run",
      modelRunId: "benchmark-model",
      sample: {
        ...sample,
        count: sampleCount,
        questionType: "single-session-user",
        contextScopeId: `longmemeval:${sample.questionId}`
      },
      stage: "result_commit",
      operation: "append_result",
      stageExecutionId: `commit-${sample.index}`,
      status: "succeeded",
      stageAttempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedMs: 0,
      input: { sampleIndex: sample.index, resultCommitId: `benchmark-${sample.index}` },
      output: { committed: true }
    });
    await Promise.all([resultCommit, traceCommit]);
  }));
  await Promise.all([resultWriter.close(), traceWriter.close()]);
  const appendMs = performance.now() - appendStarted;

  const recoveryStarted = performance.now();
  const recovery = await scanLongMemEvalResultRecovery({
    resultPath,
    datasetIdentity,
    samples,
    modelRunId: "benchmark-model"
  });
  const recoveryMs = performance.now() - recoveryStarted;
  peakMemory = Math.max(peakMemory, process.memoryUsage().rss);
  const [resultStats, traceStats] = await Promise.all([stat(resultPath), stat(tracePath)]);

  const store = new LongMemEvalArtifactStore(directory);
  const lockedRun = await openLongMemEvalArtifactRun({
    store,
    runId: "lock-owner",
    resultBasename: "lock-result.jsonl",
    traceBasename: "lock-trace.jsonl"
  });
  let lockContentionRejected = false;
  try {
    await openLongMemEvalArtifactRun({
      store,
      runId: "lock-contender",
      resultBasename: "lock-result.jsonl",
      traceBasename: "lock-contender-trace.jsonl"
    });
  } catch (error) {
    lockContentionRejected = error instanceof LongMemEvalArtifactError && error.code === "RESULT_FILE_LOCKED";
  } finally {
    await lockedRun.close();
    clearInterval(memorySampler);
  }

  assert.equal(recovery.completedSamples.length, sampleCount);
  assert.equal(recovery.pendingSamples.length, 0);
  assert.equal(lockContentionRejected, true);
  const metrics = {
    sampleCount,
    appendMs: Number(appendMs.toFixed(2)),
    appendAvgMs: Number((appendMs / sampleCount).toFixed(4)),
    recoveryMs: Number(recoveryMs.toFixed(2)),
    resultBytes: resultStats.size,
    traceBytes: traceStats.size,
    peakRssBytes: peakMemory,
    peakMemoryDeltaBytes: Math.max(0, peakMemory - startMemory),
    lockContentionRejected
  };
  console.log(`LONGMEMEVAL_ARTIFACT_BENCHMARK ${JSON.stringify(metrics)}`);
});
