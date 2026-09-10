import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgressReporter, formatHelp, formatProgress, parseArgs } from "./longmemeval-cli.js";
import { clearLongMemEvalData } from "./longmemeval.js";
import { getContextEngineConfig } from "../../config.js";
import type { LongMemEvalProgress } from "./longmemeval.js";

test("formatProgress renders sample, session, batch, and stage message", () => {
  assert.equal(
    formatProgress(makeProgress({
      stage: "ingest",
      ingestStage: "finalize",
      stageProgress: 50,
      stageMessage: "haystack session 入库完成",
      currentSampleIndex: 2,
      currentSampleCount: 4,
      currentSessionIndex: 3,
      currentSessionCount: 8,
      batchIndex: 2,
      batchCount: 4
    })),
    "[longmemeval] ingest /finalize 50.0% sample 2/4 session 3/8 batch 2/4 - haystack session 入库完成"
  );
});

test("createProgressReporter writes distinct progress lines when enabled", () => {
  const lines: string[] = [];
  const reporter = createProgressReporter({
    enabled: true,
    write: (line) => lines.push(line)
  });

  assert.ok(reporter);
  const progress = makeProgress({ stage: "answer", stageMessage: "hypothesis_generated" });
  reporter(progress);
  reporter(progress);
  reporter(makeProgress({ stage: "judge", stageMessage: "correct" }));

  assert.deepEqual(lines, [
    "[longmemeval] answer 10.0% sample 1/10 - hypothesis_generated\n",
    "[longmemeval] judge 10.0% sample 1/10 - correct\n"
  ]);
});

test("createProgressReporter returns undefined when disabled", () => {
  assert.equal(createProgressReporter({ enabled: false }), undefined);
});

test("parseArgs supports sample ranges and CI result files", () => {
  const options = parseArgs([
    "node",
    "longmemeval-cli.ts",
    "sample",
    "--dataset",
    "dataset.json",
    "--sample-range",
    "101-120",
    "--ci",
    "--result",
    "result.json"
  ]);
  assert.equal(options.command, "sample");
  assert.deepEqual(options.sampleRange, { start: 101, end: 120 });
  assert.equal(options.json, true);
  assert.equal(options.progress, false);
  assert.equal(options.result, "result.json");
});

test("parseArgs treats a single sample range index as one sample", () => {
  const options = parseArgs(["node", "longmemeval-cli.ts", "sample", "--sample-range", "1"]);
  assert.deepEqual(options.sampleRange, { start: 1, end: 1 });
});

test("parseArgs requires explicit seed for CI split", () => {
  assert.throws(
    () => parseArgs(["node", "longmemeval-cli.ts", "split", "--ratio", "0.1", "--ci"]),
    /requires --seed/
  );
});

test("parseArgs validates ratio and range before evaluation", () => {
  assert.throws(
    () => parseArgs(["node", "longmemeval-cli.ts", "split", "--ratio", "0"]),
    /ratio must satisfy/
  );
  assert.throws(
    () => parseArgs(["node", "longmemeval-cli.ts", "sample", "--sample-range", "3-2"]),
    /sample-range must satisfy/
  );
});

test("parseArgs preserves legacy positional dataset usage", () => {
  const options = parseArgs(["node", "longmemeval-cli.ts", "dataset.json", "--json"]);
  assert.equal(options.command, "eval");
  assert.equal(options.dataset, "dataset.json");
  assert.equal(options.json, true);
  assert.equal(options.skipLtmDreaming, true);
});

test("parseArgs supports resume artifacts and all evaluation concurrency flags", () => {
  const options = parseArgs([
    "node", "longmemeval-cli.ts", "dataset.json",
    "--resume", "--retry-skipped", "--resume-legacy",
    "--result-file", "resume-result.jsonl",
    "--trace-file", "resume-trace.jsonl",
    "--model-concurrency", "2",
    "--ingest-sample-concurrency", "3",
    "--ingest-session-concurrency", "4",
    "--answer-concurrency", "5",
    "--judge-concurrency", "6"
  ]);

  assert.equal(options.resume, true);
  assert.equal(options.retrySkipped, true);
  assert.equal(options.resumeLegacy, true);
  assert.equal(options.resultFileName, "resume-result.jsonl");
  assert.equal(options.traceFileName, "resume-trace.jsonl");
  assert.equal(options.modelConcurrency, 2);
  assert.equal(options.ingestSampleConcurrency, 3);
  assert.equal(options.ingestSessionConcurrency, 4);
  assert.equal(options.answerConcurrency, 5);
  assert.equal(options.judgeConcurrency, 6);
});

test("parseArgs rejects resume-only flags without resume and conflicting result options", () => {
  assert.throws(
    () => parseArgs(["node", "longmemeval-cli.ts", "dataset.json", "--retry-skipped"]),
    /require --resume/
  );
  assert.throws(
    () => parseArgs(["node", "longmemeval-cli.ts", "dataset.json", "--diagnostics", "result.jsonl", "--result-file", "result.jsonl"]),
    /cannot be used together/
  );
});

test("parseArgs supports strict and fallback LLM modes", () => {
  assert.equal(
    parseArgs(["node", "longmemeval-cli.ts", "dataset.json", "--strict-llm"]).allowLlmFallback,
    false
  );
  assert.equal(
    parseArgs(["node", "longmemeval-cli.ts", "dataset.json", "--strict-llm", "--allow-llm-fallback"]).allowLlmFallback,
    true
  );
});

test("parseArgs rejects unsafe clear and selector conflicts", () => {
  assert.throws(
    () => parseArgs(["node", "longmemeval-cli.ts", "sample", "--question-id", "q1", "--sample-range", "1-2"]),
    /cannot be used together/
  );
  assert.throws(
    () => parseArgs(["node", "longmemeval-cli.ts", "clear-db", "--dataset", "dataset.json"]),
    /does not accept/
  );
});

test("formatHelp documents streaming artifacts, recovery, selectors, and five concurrency layers", () => {
  const help = formatHelp();
  for (const option of [
    "--question-id", "--sample-range", "--ratio",
    "--result-file", "--trace-file", "--resume", "--retry-skipped", "--resume-legacy",
    "--model-concurrency", "--ingest-sample-concurrency", "--ingest-session-concurrency",
    "--answer-concurrency", "--judge-concurrency", "--model-only", "--answer-only"
  ]) {
    assert.equal(help.includes(option), true, `${option} should be documented`);
  }
});

test("clearLongMemEvalData clears local evaluation storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "longmemeval-clear-test-"));
  const file = join(directory, "store.sqlite");
  await writeFile(file, "test", "utf8");
  const config = getContextEngineConfig();
  const result = await clearLongMemEvalData({
    ...config,
    longMemEval: {
      ...config.longMemEval,
      storage: { storeDirectory: directory },
      graphStore: { ...config.longMemEval.graphStore, mode: "local" }
    }
  });
  assert.deepEqual(result.graphStore.status, "skipped");
  assert.deepEqual(result.storage.deletedFiles, [file]);
  await assert.rejects(() => access(file));
});

function makeProgress(overrides: Partial<LongMemEvalProgress>): LongMemEvalProgress {
  return {
    stage: "ingest",
    stageProgress: 10,
    processedSamples: 1,
    totalSamples: 10,
    processedSessions: 1,
    totalSessions: 10,
    processedSteps: 1,
    totalSteps: 10,
    questionTypeCounts: {},
    activeSamples: [],
    resumedSamples: 0,
    committedSamples: 1,
    currentSampleIndex: 1,
    currentSampleCount: 10,
    ...overrides
  };
}
