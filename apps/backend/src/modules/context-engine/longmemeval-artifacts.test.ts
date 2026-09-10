import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  LONGMEMEVAL_DATA_DIRECTORY,
  LONGMEMEVAL_DEFAULT_RESULT_BASENAME,
  LONGMEMEVAL_REDACTED_VALUE,
  LONGMEMEVAL_TRACE_SCHEMA_VERSION,
  LongMemEvalArtifactError,
  LongMemEvalArtifactStore,
  LongMemEvalResultCommitConflictError,
  LongMemEvalResultWriter,
  LongMemEvalTraceWriter,
  SerialJsonlWriter,
  createLongMemEvalDatasetIdentity,
  createLongMemEvalResultCommitId,
  hashLongMemEvalResultPayload,
  openLongMemEvalArtifactRun,
  readJsonlRecords,
  safeJsonStringify,
  scanLongMemEvalResultRecovery,
  type LongMemEvalDatasetIdentity,
  type LongMemEvalSampleIdentity
} from "./longmemeval-artifacts.js";
import { readLongMemEvalJsonlResultPage } from "./longmemeval-jsonl-results.js";

async function withTemporaryDirectory<T>(prefix: string, run: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createDataset(directory: string, questionIds = ["q1", "q2", "q3"]) {
  const path = join(directory, "dataset.json");
  await writeFile(path, JSON.stringify(questionIds.map((questionId) => ({ question_id: questionId }))), "utf8");
  return {
    path,
    identity: await createLongMemEvalDatasetIdentity(path),
    samples: questionIds.map((questionId, index) => ({ index: index + 1, questionId }))
  };
}

function resultPayload(questionId: string, skipped = false) {
  return {
    questionId,
    questionType: "single-session-user",
    question: `Question ${questionId}`,
    answer: `Answer ${questionId}`,
    hypothesis: skipped ? "" : `Answer ${questionId}`,
    ...(skipped ? { status: "skipped", skipped: true, skipReason: "retry_exhausted" } : {}),
    judgment: { label: skipped ? "incorrect" : "correct", score: skipped ? 0 : 1, reason: skipped ? "retry_exhausted" : "exact_match" }
  };
}

function commitInput(input: {
  datasetIdentity: LongMemEvalDatasetIdentity;
  sampleIdentity: LongMemEvalSampleIdentity;
  runId?: string;
  modelRunId?: string;
  skipped?: boolean;
}) {
  return {
    result: resultPayload(input.sampleIdentity.questionId, input.skipped),
    runId: input.runId ?? "run_a",
    modelRunId: input.modelRunId ?? "default",
    datasetIdentity: input.datasetIdentity,
    sampleIdentity: input.sampleIdentity,
    completedAt: "2026-08-12T00:00:00.000Z"
  };
}

test("LongMemEval artifact paths stay in the fixed data root and reject traversal", async () => {
  assert.equal(LONGMEMEVAL_DATA_DIRECTORY, resolve("data"));
  const store = new LongMemEvalArtifactStore();
  const paths = store.resolvePaths({ runId: "run_1" });
  assert.equal(paths.resultPath, join(LONGMEMEVAL_DATA_DIRECTORY, LONGMEMEVAL_DEFAULT_RESULT_BASENAME));
  assert.equal(paths.tracePath, join(LONGMEMEVAL_DATA_DIRECTORY, "longmemeval-run_1-trace.jsonl"));

  for (const invalid of ["../outside.jsonl", "nested/result.jsonl", "/tmp/result.jsonl", "result.json", " result.jsonl"] as const) {
    assert.throws(() => store.resolveBasename(invalid), (error: unknown) =>
      error instanceof LongMemEvalArtifactError && error.code === "INVALID_ARTIFACT_BASENAME"
    );
  }
  assert.throws(
    () => store.resolvePaths({ runId: "run_1", resultBasename: "same.jsonl", traceBasename: "same.jsonl" }),
    (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "ARTIFACT_PATH_COLLISION"
  );
});

test("LongMemEval result locks are exclusive and artifact files use owner-only permissions", async () => {
  await withTemporaryDirectory("longmemeval-artifact-lock-", async (directory) => {
    const store = new LongMemEvalArtifactStore(directory);
    const paths = store.resolvePaths({ runId: "run_lock" });
    const lock = await store.acquireResultLock(paths.resultPath, paths.runId);
    try {
      await assert.rejects(
        store.acquireResultLock(paths.resultPath, "run_other"),
        (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "RESULT_FILE_LOCKED"
      );
      const writer = await SerialJsonlWriter.open({ path: paths.resultPath, truncate: true });
      await writer.append({ ok: true });
      await writer.close();
      assert.equal((await stat(paths.resultPath)).mode & 0o777, 0o600);
      assert.equal((await stat(paths.lockPath)).mode & 0o777, 0o600);
    } finally {
      await lock.release();
    }
    await assert.rejects(stat(paths.lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const reacquired = await store.acquireResultLock(paths.resultPath, "run_after_release");
    await reacquired.release();
  });
});

test("artifact runs acquire the result lock before truncating a new run", async () => {
  await withTemporaryDirectory("longmemeval-artifact-run-", async (directory) => {
    const store = new LongMemEvalArtifactStore(directory);
    const resultPath = store.resolveBasename("shared.jsonl");
    await writeFile(resultPath, '{"preserved":true}\n', "utf8");
    const active = await openLongMemEvalArtifactRun({
      store,
      runId: "active",
      resultBasename: "shared.jsonl",
      traceBasename: "active-trace.jsonl",
      resume: true
    });
    try {
      await assert.rejects(
        openLongMemEvalArtifactRun({
          store,
          runId: "blocked",
          resultBasename: "shared.jsonl",
          traceBasename: "blocked-trace.jsonl"
        }),
        (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "RESULT_FILE_LOCKED"
      );
      assert.equal(await readFile(resultPath, "utf8"), '{"preserved":true}\n');
    } finally {
      await active.close();
    }

    const fresh = await openLongMemEvalArtifactRun({
      store,
      runId: "fresh",
      resultBasename: "shared.jsonl",
      traceBasename: "fresh-trace.jsonl"
    });
    try {
      assert.equal(await readFile(resultPath, "utf8"), "");
    } finally {
      await fresh.close();
    }

    await writeFile(resultPath, '{"preservedAfterTraceConflict":true}\n', "utf8");
    await writeFile(store.resolveBasename("conflict-trace.jsonl"), "", "utf8");
    await assert.rejects(openLongMemEvalArtifactRun({
      store,
      runId: "trace_conflict",
      resultBasename: "shared.jsonl",
      traceBasename: "conflict-trace.jsonl"
    }), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
    assert.equal(await readFile(resultPath, "utf8"), '{"preservedAfterTraceConflict":true}\n');
  });
});

test("artifact runs reclaim dead-process locks and reject symbolic-link targets", async () => {
  await withTemporaryDirectory("longmemeval-artifact-stale-lock-", async (directory) => {
    const store = new LongMemEvalArtifactStore(directory);
    const paths = store.resolvePaths({ runId: "recovered", resultBasename: "result.jsonl", traceBasename: "trace.jsonl" });
    await writeFile(paths.lockPath, `${JSON.stringify({ runId: "dead", pid: 2_147_483_647 })}\n`, { mode: 0o600 });
    const lock = await store.acquireResultLock(paths.resultPath, paths.runId);
    await lock.release();

    const outside = join(directory, "outside.txt");
    await writeFile(outside, "must remain intact\n", "utf8");
    await symlink(outside, paths.resultPath);
    await assert.rejects(
      openLongMemEvalArtifactRun({
        store,
        runId: "symlink",
        resultBasename: "result.jsonl",
        traceBasename: "symlink-trace.jsonl"
      }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "ARTIFACT_SYMLINK_REJECTED"
    );
    assert.equal(await readFile(outside, "utf8"), "must remain intact\n");
  });
});

test("safe JSON serialization redacts credentials and preserves complete business content", () => {
  const prompt = "完整 prompt ".repeat(2_000);
  const circular: Record<string, unknown> = {
    apiKey: "api-secret",
    "x-api-key": "header-secret",
    Authorization: "Bearer auth-secret",
    nested: {
      access_token: "access-secret",
      cookie: "session-secret",
      prompt,
      endpoint: "https://url-user:url-password@example.com/v1?api_key=query-secret&ordinary=visible"
    },
    count: 9n,
    error: Object.assign(new Error("request failed"), { code: "ECONNRESET" })
  };
  circular.self = circular;
  (circular.error as Error & { cause?: unknown }).cause = circular.error;
  const serialized = safeJsonStringify(circular);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  const nested = parsed.nested as Record<string, unknown>;
  const error = parsed.error as Record<string, unknown>;
  assert.equal(parsed.apiKey, LONGMEMEVAL_REDACTED_VALUE);
  assert.equal(parsed.Authorization, LONGMEMEVAL_REDACTED_VALUE);
  assert.equal(nested.access_token, LONGMEMEVAL_REDACTED_VALUE);
  assert.equal(nested.cookie, LONGMEMEVAL_REDACTED_VALUE);
  assert.equal(nested.prompt, prompt);
  assert.equal(new URL(String(nested.endpoint)).searchParams.get("api_key"), LONGMEMEVAL_REDACTED_VALUE);
  assert.equal(new URL(String(nested.endpoint)).searchParams.get("ordinary"), "visible");
  assert.equal(decodeURIComponent(new URL(String(nested.endpoint)).username), LONGMEMEVAL_REDACTED_VALUE);
  assert.equal(decodeURIComponent(new URL(String(nested.endpoint)).password), LONGMEMEVAL_REDACTED_VALUE);
  assert.equal(String(nested.endpoint).includes(LONGMEMEVAL_REDACTED_VALUE), true);
  assert.equal(parsed.count, "9");
  assert.equal(parsed.self, "[Circular]");
  assert.equal(error.name, "Error");
  assert.equal(error.message, "request failed");
  assert.equal(error.code, "ECONNRESET");
  assert.equal(error.cause, "[Circular]");
  for (const secret of ["api-secret", "header-secret", "auth-secret", "access-secret", "session-secret", "query-secret", "url-user", "url-password"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("serial JSONL and trace writers keep concurrent lines intact and sequences monotonic", async () => {
  await withTemporaryDirectory("longmemeval-artifact-writer-", async (directory) => {
    const resultPath = join(directory, "result.jsonl");
    const writer = await SerialJsonlWriter.open({ path: resultPath, truncate: true });
    const receipts = await Promise.all(Array.from({ length: 100 }, (_, index) => writer.append({ index, text: `value-${index}` })));
    await writer.close();
    assert.deepEqual(receipts.map((receipt) => receipt.lineNumber), Array.from({ length: 100 }, (_, index) => index + 1));
    const scanned = await readJsonlRecords(resultPath, { missingAsEmpty: false });
    assert.equal(scanned.records.length, 100);
    assert.deepEqual(scanned.records.map((record) => record.value.index), Array.from({ length: 100 }, (_, index) => index));

    const tracePath = join(directory, "trace.jsonl");
    const trace = await LongMemEvalTraceWriter.open(tracePath);
    await Promise.all(Array.from({ length: 25 }, (_, index) => trace.append({
      runId: "run_trace",
      modelRunId: "default",
      stage: "ingestion",
      operation: "save_event",
      stageExecutionId: `stage-${index}`,
      status: "succeeded",
      attempt: 1,
      stageAttempt: 1,
      internalAttempt: 1,
      startedAt: "2026-08-12T00:00:00.000Z",
      finishedAt: "2026-08-12T00:00:00.001Z",
      elapsedMs: 1,
      input: { index },
      output: { saved: true }
    })));
    await trace.close();
    const traceRecords = await readJsonlRecords(tracePath, { missingAsEmpty: false });
    assert.deepEqual(traceRecords.records.map((record) => record.value.sequence), Array.from({ length: 25 }, (_, index) => index + 1));
    assert.equal(traceRecords.records.every((record) => record.value.schemaVersion === LONGMEMEVAL_TRACE_SCHEMA_VERSION), true);
  });
});

test("JSONL readers ignore one incomplete tail and reject a corrupted middle line", async () => {
  await withTemporaryDirectory("longmemeval-artifact-tail-", async (directory) => {
    const path = join(directory, "result.jsonl");
    await writeFile(path, '{"id":1}\n{"id":2', "utf8");
    const scanned = await readJsonlRecords(path, { missingAsEmpty: false });
    assert.deepEqual(scanned.records.map((record) => record.value.id), [1]);
    assert.equal(scanned.ignoredIncompleteTail, true);

    const writer = await SerialJsonlWriter.open({ path });
    await writer.append({ id: 3 });
    await writer.close();
    const repaired = await readJsonlRecords(path, { missingAsEmpty: false });
    assert.deepEqual(repaired.records.map((record) => record.value.id), [1, 3]);

    await writeFile(path, '{"id":1}\nnot-json\n{"id":3}\n', "utf8");
    await assert.rejects(
      readJsonlRecords(path, { missingAsEmpty: false }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "INVALID_JSONL_LINE"
    );
    await writeFile(path, '{"id":1}\n[]', "utf8");
    await assert.rejects(
      readJsonlRecords(path, { missingAsEmpty: false }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "INVALID_JSONL_LINE"
    );
  });
});

test("result writer removes a partially written tail before the next commit retry", async () => {
  await withTemporaryDirectory("longmemeval-artifact-partial-write-", async (directory) => {
    const dataset = await createDataset(directory, ["q1", "q2"]);
    const path = join(directory, "result.jsonl");
    let failOnce = true;
    const writer = await LongMemEvalResultWriter.open({
      path,
      truncate: true,
      faultInjection: {
        async afterWrite({ receipt }) {
          if (!failOnce) return;
          failOnce = false;
          const partial = await readFile(path);
          await writeFile(path, partial.subarray(0, receipt.byteStart + 12));
          throw new Error("simulated partial write");
        }
      }
    });
    const input = commitInput({ datasetIdentity: dataset.identity, sampleIdentity: dataset.samples[0]! });
    await assert.rejects(writer.commit(input), /simulated partial write/u);
    const retried = await writer.commit(input);
    assert.equal(retried.duplicate, false);
    await writer.close();
    const scanned = await readJsonlRecords(path, { missingAsEmpty: false });
    assert.equal(scanned.records.length, 1);
    assert.equal(scanned.records[0]?.value.questionId, "q1");
  });
});

test("result commits are deterministic, concurrent-safe, and recover an acknowledged write error", async () => {
  await withTemporaryDirectory("longmemeval-artifact-commit-", async (directory) => {
    const dataset = await createDataset(directory, ["q1", "q2"]);
    const path = join(directory, "result.jsonl");
    let failAcknowledgement = true;
    const writer = await LongMemEvalResultWriter.open({
      path,
      truncate: true,
      afterAppend() {
        if (!failAcknowledgement) return;
        failAcknowledgement = false;
        throw new Error("simulated acknowledgement loss");
      }
    });
    const input = commitInput({ datasetIdentity: dataset.identity, sampleIdentity: dataset.samples[0]! });
    assert.equal(createLongMemEvalResultCommitId(input), createLongMemEvalResultCommitId(input));

    const first = await writer.commit(input);
    assert.equal(first.duplicate, true);
    assert.equal(first.recoveredAfterWriteError, true);
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => writer.commit(input)));
    assert.equal(concurrent.every((receipt) => receipt.duplicate), true);
    await assert.rejects(
      writer.commit({ ...input, result: { ...input.result, hypothesis: "different" } }),
      LongMemEvalResultCommitConflictError
    );
    const second = await writer.commit(commitInput({
      datasetIdentity: dataset.identity,
      sampleIdentity: dataset.samples[1]!
    }));
    assert.equal(second.lineNumber, 2);
    assert.equal(second.byteStart > first.byteStart, true);
    await writer.close();

    const scanned = await readJsonlRecords(path, { missingAsEmpty: false });
    assert.equal(scanned.records.length, 2);
    assert.equal(scanned.records[0]?.value.resultCommitId, first.resultCommitId);
    assert.equal(scanned.records[0]?.value.payloadHash, first.payloadHash);
    const page = await readLongMemEvalJsonlResultPage({ filePath: path, page: 1, pageSize: 20 });
    assert.equal(page.summary.totalItems, 2);
    assert.equal(page.items[0]?.questionId, "q1");
  });
});

test("recovery scans non-contiguous completion, skipped policy, duplicate commits, and incomplete tails", async () => {
  await withTemporaryDirectory("longmemeval-artifact-recovery-", async (directory) => {
    const dataset = await createDataset(directory);
    const path = join(directory, "result.jsonl");
    const writer = await LongMemEvalResultWriter.open({ path, truncate: true });
    await writer.commit(commitInput({ datasetIdentity: dataset.identity, sampleIdentity: dataset.samples[0]! }));
    await writer.commit(commitInput({ datasetIdentity: dataset.identity, sampleIdentity: dataset.samples[2]!, skipped: true }));
    await writer.close();
    const rows = (await readFile(path, "utf8")).trim().split("\n");
    await writeFile(path, `${rows[0]}\n${rows[0]}\n${rows[1]}\n{"partial":`, "utf8");

    const defaultRecovery = await scanLongMemEvalResultRecovery({
      resultPath: path,
      datasetIdentity: dataset.identity,
      samples: dataset.samples,
      modelRunId: "default"
    });
    assert.deepEqual(defaultRecovery.completedSamples, [dataset.samples[0], dataset.samples[2]]);
    assert.deepEqual(defaultRecovery.pendingSamples, [dataset.samples[1]]);
    assert.deepEqual(defaultRecovery.firstPendingSample, dataset.samples[1]);
    assert.equal(defaultRecovery.duplicateCommits, 1);
    assert.equal(defaultRecovery.ignoredIncompleteTail, true);

    const retrySkipped = await scanLongMemEvalResultRecovery({
      resultPath: path,
      datasetIdentity: dataset.identity,
      samples: dataset.samples,
      modelRunId: "default",
      retrySkipped: true
    });
    assert.deepEqual(retrySkipped.completedSamples, [dataset.samples[0]]);
    assert.deepEqual(retrySkipped.pendingSamples, [dataset.samples[1], dataset.samples[2]]);
  });
});

test("recovery uses the latest run terminal and rejects two terminals in the same run", async () => {
  await withTemporaryDirectory("longmemeval-artifact-run-terminal-", async (directory) => {
    const dataset = await createDataset(directory, ["q1"]);
    const path = join(directory, "result.jsonl");
    const writer = await LongMemEvalResultWriter.open({ path, truncate: true });
    await writer.commit(commitInput({
      datasetIdentity: dataset.identity,
      sampleIdentity: dataset.samples[0]!,
      runId: "run_old",
      skipped: true
    }));
    await writer.commit(commitInput({
      datasetIdentity: dataset.identity,
      sampleIdentity: dataset.samples[0]!,
      runId: "run_new"
    }));
    await writer.close();
    const recovered = await scanLongMemEvalResultRecovery({
      resultPath: path,
      datasetIdentity: dataset.identity,
      samples: dataset.samples,
      modelRunId: "default",
      retrySkipped: true
    });
    assert.deepEqual(recovered.completedSamples, dataset.samples);
    assert.equal(recovered.latestRunId, "run_new");

    const rows = (await readFile(path, "utf8")).trim().split("\n");
    const duplicateTerminal = JSON.parse(rows[1]!) as Record<string, unknown>;
    delete duplicateTerminal.resultCommitId;
    delete duplicateTerminal.payloadHash;
    duplicateTerminal.hypothesis = "conflicting terminal";
    await writeFile(path, `${rows.join("\n")}\n${JSON.stringify(duplicateTerminal)}\n`, "utf8");
    await assert.rejects(
      scanLongMemEvalResultRecovery({
        resultPath: path,
        datasetIdentity: dataset.identity,
        samples: dataset.samples,
        modelRunId: "default"
      }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "DUPLICATE_SAMPLE_TERMINAL"
    );
  });
});

test("recovery rejects dataset changes, question conflicts, legacy rows, and conflicting terminals", async () => {
  await withTemporaryDirectory("longmemeval-artifact-recovery-errors-", async (directory) => {
    const dataset = await createDataset(directory, ["q1"]);
    const path = join(directory, "result.jsonl");
    const writer = await LongMemEvalResultWriter.open({ path, truncate: true });
    await writer.commit(commitInput({ datasetIdentity: dataset.identity, sampleIdentity: dataset.samples[0]! }));
    await writer.close();

    const changedDataset = { ...dataset.identity, sha256: "f".repeat(64) };
    await assert.rejects(
      scanLongMemEvalResultRecovery({ resultPath: path, datasetIdentity: changedDataset, samples: dataset.samples, modelRunId: "default" }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "RESULT_DATASET_MISMATCH"
    );
    await assert.rejects(
      scanLongMemEvalResultRecovery({ resultPath: path, datasetIdentity: dataset.identity, samples: [{ index: 1, questionId: "different" }], modelRunId: "default" }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "RESULT_SAMPLE_MISMATCH"
    );

    await writeFile(path, `${JSON.stringify({
      datasetPath: dataset.identity.path,
      sampleIndex: 1,
      questionId: "q1",
      questionType: "single-session-user",
      question: "Question q1",
      answer: "Answer q1",
      hypothesis: "Answer q1"
    })}\n`, "utf8");
    await assert.rejects(
      scanLongMemEvalResultRecovery({ resultPath: path, datasetIdentity: dataset.identity, samples: dataset.samples, modelRunId: "default" }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "LEGACY_RESUME_REQUIRED"
    );
    const legacy = await scanLongMemEvalResultRecovery({
      resultPath: path,
      datasetIdentity: dataset.identity,
      samples: dataset.samples,
      modelRunId: "default",
      resumeLegacy: true
    });
    assert.deepEqual(legacy.completedSamples, dataset.samples);

    const input = commitInput({ datasetIdentity: dataset.identity, sampleIdentity: dataset.samples[0]! });
    const commitId = createLongMemEvalResultCommitId(input);
    const first = {
      ...input.result,
      runId: input.runId,
      modelRunId: input.modelRunId,
      datasetIdentity: input.datasetIdentity,
      sampleIdentity: input.sampleIdentity,
      resultCommitId: commitId,
      completedAt: input.completedAt
    };
    const second = { ...first, hypothesis: "conflict" };
    await writeFile(path, [
      JSON.stringify({ ...first, payloadHash: hashLongMemEvalResultPayload(first) }),
      JSON.stringify({ ...second, payloadHash: hashLongMemEvalResultPayload(second) })
    ].join("\n") + "\n", "utf8");
    await assert.rejects(
      scanLongMemEvalResultRecovery({ resultPath: path, datasetIdentity: dataset.identity, samples: dataset.samples, modelRunId: "default" }),
      LongMemEvalResultCommitConflictError
    );
  });
});
