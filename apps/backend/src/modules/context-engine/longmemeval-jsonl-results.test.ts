import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLongMemEvalJsonlResultPage } from "./longmemeval-jsonl-results.js";

test("readLongMemEvalJsonlResultPage summarizes LongMemEval answer diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-jsonl-"));
  const filePath = join(dir, "result.jsonl");
  await writeFile(
    filePath,
    [
      JSON.stringify({
        questionId: "q1",
        questionType: "single-session-user",
        question: "Degree?",
        answer: "Business Administration",
        hypothesis: "Business Administration",
        exactMatch: true,
        judgment: { label: "correct", score: 1, reason: "exact_match" },
        answerContextMode: "context_pack",
        answerContext: {
          tokenBudget: { requested: 20000, used: 1280 },
          selectedItemIds: ["stm-1", "ltm-1"],
          selectedItems: [{
            id: "stm-1",
            layer: "stm",
            score: 0.84,
            sourceSessionIds: ["session-1"],
            factIds: ["fact-1"],
            temporal: { evidenceTime: "2023-05-29T13:28:00.000Z" }
          }],
          evidenceTrace: {
            failureClassification: { stage: "prompt_ready", basis: "literal_answer_match" }
          },
          droppedSummary: { token_budget_exceeded: 2 },
          dropped: [{ id: "stm-2", reason: "access_hidden" }]
        }
      }),
      JSON.stringify({
        question_id: "q2",
        question_type: "multi-session",
        question: "Commute?",
        answer: "45 minutes each way",
        response: "30 minutes",
        judgment: { label: "incorrect", score: 0, reason: "wrong_duration" },
        answerFallbackUsed: true,
        answerFallbackReason: "empty_answer_context",
        answerContext: {
          selectedItems: [{ id: "stm-3" }]
        }
      }),
      JSON.stringify({
        id: "q3",
        type: "multi-session",
        correct: false,
        reason: "missing_evidence"
      })
    ].join("\n"),
    "utf8"
  );

  const page = await readLongMemEvalJsonlResultPage({ filePath, page: 2, pageSize: 2 });

  assert.equal(page.page, 2);
  assert.equal(page.totalPages, 2);
  assert.deepEqual(page.items.map((item) => item.questionId), ["q3"]);
  assert.equal(page.summary.totalItems, 3);
  assert.equal(page.summary.judgedItems, 3);
  assert.equal(page.summary.correctItems, 1);
  assert.equal(page.summary.incorrectItems, 2);
  assert.equal(page.summary.accuracy, 1 / 3);
  assert.equal(page.summary.exactMatchAccuracy, 1 / 3);
  assert.equal(page.summary.answerFallbacks, 1);
  assert.deepEqual(page.summary.errorReasons, {
    wrong_duration: 1,
    missing_evidence: 1
  });
  assert.deepEqual(page.summary.selection, {
    rowsWithSelection: 2,
    totalSelectedItems: 3,
    droppedReasons: {
      token_budget_exceeded: 2,
      access_hidden: 1
    }
  });
  assert.equal(page.summary.questionTypeAccuracy["multi-session"]?.accuracy, 0);
  const allItems = await readLongMemEvalJsonlResultPage({ filePath, page: 1, pageSize: 20 });
  assert.equal(allItems.items[0]?.selectedItems[0]?.score, 0.84);
  assert.deepEqual(allItems.items[0]?.selectedItems[0]?.sourceSessionIds, ["session-1"]);
  assert.deepEqual(allItems.items[0]?.tokenBudget, { requested: 20000, used: 1280 });
  assert.equal(allItems.items[0]?.failureClassification?.stage, "prompt_ready");
});

test("readLongMemEvalJsonlResultPage tolerates an incomplete tail and groups latest model terminals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-jsonl-latest-"));
  const filePath = join(dir, "result.jsonl");
  const rows = [
    { runId: "run-1", modelRunId: "model-a", sampleIndex: 2, sampleIdentity: { index: 2, questionId: "q2" }, questionId: "q2", status: "skipped", correct: false },
    { runId: "run-1", modelRunId: "model-b", sampleIndex: 1, sampleIdentity: { index: 1, questionId: "q1" }, questionId: "q1", status: "success", correct: true },
    { runId: "run-2", modelRunId: "model-a", sampleIndex: 2, sampleIdentity: { index: 2, questionId: "q2" }, questionId: "q2", status: "success", correct: true },
    { runId: "run-2", modelRunId: "model-a", sampleIndex: 1, sampleIdentity: { index: 1, questionId: "q1" }, questionId: "q1", status: "success", correct: false }
  ];
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{"runId":"partial"`, "utf8");

  const page = await readLongMemEvalJsonlResultPage({ filePath, page: 1, pageSize: 20 });
  const filtered = await readLongMemEvalJsonlResultPage({ filePath, page: 1, pageSize: 20, modelRunId: "model-b" });

  assert.equal(page.summary.ignoredIncompleteTail, true);
  assert.equal(page.summary.totalItems, 3);
  assert.deepEqual(page.items.map((item) => `${item.modelRunId}:${item.sampleIndex}:${item.runId}`), [
    "model-a:1:run-2",
    "model-a:2:run-2",
    "model-b:1:run-1"
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(page.summary.modelGroups).map(([key, value]) => [key, value.totalItems])), {
    "model-a": 2,
    "model-b": 1
  });
  assert.deepEqual(filtered.items.map((item) => item.modelRunId), ["model-b"]);
});
