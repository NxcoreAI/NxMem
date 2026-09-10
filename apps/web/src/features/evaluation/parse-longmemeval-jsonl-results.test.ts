import test from "node:test";
import assert from "node:assert/strict";
import { parseLongMemEvalJsonlText } from "./parse-longmemeval-jsonl-results.js";

test("parseLongMemEvalJsonlText builds summary and paged items from selected file text", () => {
  const page = parseLongMemEvalJsonlText({
    fileName: "selected-result.jsonl",
    page: 2,
    pageSize: 1,
    text: [
      JSON.stringify({
        questionId: "q1",
        questionType: "single-session-user",
        answer: "Business Administration",
        hypothesis: "Business Administration",
        exactMatch: true,
        judgment: { label: "correct", score: 1, reason: "exact_match" },
        answerContext: {
          tokenBudget: { requested: 20000, used: 1240 },
          selectedItemIds: ["stm-1", "ltm-1"],
          selectedItems: [{
            id: "stm-1",
            layer: "stm",
            score: 0.82,
            sourceIds: ["event-1"],
            sourceSessionIds: ["session-1"],
            sourceRoles: ["user"],
            factIds: ["fact-1"],
            memoryIds: ["stm-1"],
            relationTypes: ["supports"],
            temporal: { evidenceTime: "2023-05-29T13:28:00.000Z" }
          }],
          evidenceTrace: {
            failureClassification: { stage: "prompt_ready", basis: "literal_answer_match" }
          },
          droppedSummary: { token_budget_exceeded: 2 }
        }
      }),
      JSON.stringify({
        question_id: "q2",
        question_type: "single-session-user",
        answer: "45 minutes each way",
        response: "30 minutes",
        judgment: { label: "incorrect", score: 0, reason: "wrong_answer" }
      })
    ].join("\n")
  });

  assert.equal(page.summary.filePath, "selected-result.jsonl");
  assert.equal(page.summary.totalItems, 2);
  assert.equal(page.summary.accuracy, 0.5);
  assert.equal(page.summary.selection.totalSelectedItems, 2);
  assert.deepEqual(page.summary.errorReasons, { wrong_answer: 1 });
  assert.equal(page.allItems?.[0]?.selectedItems[0]?.score, 0.82);
  assert.deepEqual(page.allItems?.[0]?.selectedItems[0]?.sourceSessionIds, ["session-1"]);
  assert.equal(page.allItems?.[0]?.selectedItems[1]?.layer, "unknown");
  assert.deepEqual(page.allItems?.[0]?.tokenBudget, { requested: 20000, used: 1240 });
  assert.equal(page.allItems?.[0]?.failureClassification?.stage, "prompt_ready");
  assert.equal(page.page, 2);
  assert.deepEqual(page.items.map((item) => item.questionId), ["q2"]);
  assert.equal(page.allItems?.length, 2);
  assert.deepEqual(page.allItems?.filter((item) => item.correct === false).map((item) => item.errorReason), ["wrong_answer"]);
});

test("parseLongMemEvalJsonlText ignores an incomplete tail and keeps the latest terminal per model sample", () => {
  const rows = [
    { runId: "run-1", modelRunId: "model-a", sampleIndex: 2, sampleIdentity: { index: 2, questionId: "q2" }, questionId: "q2", status: "skipped", correct: false },
    { runId: "run-1", modelRunId: "model-b", sampleIndex: 1, sampleIdentity: { index: 1, questionId: "q1" }, questionId: "q1", status: "success", correct: true },
    { runId: "run-2", modelRunId: "model-a", sampleIndex: 2, sampleIdentity: { index: 2, questionId: "q2" }, questionId: "q2", status: "success", correct: true },
    { runId: "run-2", modelRunId: "model-a", sampleIndex: 1, sampleIdentity: { index: 1, questionId: "q1" }, questionId: "q1", status: "success", correct: false }
  ];
  const page = parseLongMemEvalJsonlText({
    fileName: "live.jsonl",
    page: 1,
    pageSize: 20,
    text: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{"runId":"partial"`
  });

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
});
