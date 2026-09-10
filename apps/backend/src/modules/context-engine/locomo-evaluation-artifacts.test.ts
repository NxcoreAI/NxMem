import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocomoResultWriter,
  locomoQuestionKey,
  scanLocomoResults,
  type LocomoRunIdentity,
  type LocomoSkippedQuestionResult
} from "./locomo-evaluation-artifacts.js";

const identity: LocomoRunIdentity = {
  runId: "run-1",
  datasetSha256: "dataset",
  configFingerprint: "config",
  storeFingerprint: "store",
  modelFingerprint: "model"
};

test("LoCoMo JSONL commits are idempotent across run IDs and repair an incomplete tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locomo-artifacts-"));
  const path = join(directory, "results.jsonl");
  try {
    const result = skipped("temporary failure");
    const writer = await LocomoResultWriter.open({ path, truncate: true });
    assert.equal((await writer.commit(identity, result)).duplicate, false);
    assert.equal((await writer.commit({ ...identity, runId: "run-2" }, result)).duplicate, true);
    await writer.close();
    await appendFile(path, "{broken", "utf8");
    const scanned = await scanLocomoResults(path, withoutRunId(identity));
    assert.equal(scanned.ignoredIncompleteTail, true);
    assert.equal(scanned.terminals.size, 1);
    const repair = await LocomoResultWriter.open({ path });
    await repair.close();
    assert.equal((await scanLocomoResults(path)).ignoredIncompleteTail, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retrying a skipped LoCoMo result appends a new terminal while successful conflicts fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "locomo-retry-"));
  const path = join(directory, "results.jsonl");
  try {
    let writer = await LocomoResultWriter.open({ path, truncate: true });
    await writer.commit(identity, skipped("first failure"));
    await writer.close();
    writer = await LocomoResultWriter.open({ path });
    await writer.commit({ ...identity, runId: "run-2" }, skipped("second failure"));
    await writer.close();
    const recovery = await scanLocomoResults(path, withoutRunId(identity));
    assert.equal(recovery.terminals.get(locomoQuestionKey("c1", "c1:q1"))?.result.status, "skipped");
    assert.equal((recovery.terminals.get(locomoQuestionKey("c1", "c1:q1"))?.result as LocomoSkippedQuestionResult).reason, "second failure");
    await assert.rejects(() => scanLocomoResults(path, { ...withoutRunId(identity), modelFingerprint: "other" }), /modelFingerprint mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function skipped(reason: string): LocomoSkippedQuestionResult {
  return { status: "skipped", conversationId: "c1", questionId: "c1:q1", questionIndex: 0, category: 1, referenceAnswer: "answer", reason, stage: "question", elapsedMs: 1 };
}

function withoutRunId(value: LocomoRunIdentity) { const { runId: _runId, ...rest } = value; return rest; }
