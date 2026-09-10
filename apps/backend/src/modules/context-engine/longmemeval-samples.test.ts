import test from "node:test";
import assert from "node:assert/strict";
import { buildLongMemEvalSamplePage, stripLongMemEvalSamplesFromJob } from "./longmemeval-samples.js";
import type { LongMemEvalJobSnapshot } from "./longmemeval-jobs.js";

function buildJob(): LongMemEvalJobSnapshot {
  return {
    jobId: "job-1",
    datasetPath: "dataset.json",
    ks: [1],
    status: "done",
    report: {
      datasetPath: "dataset.json",
      totalSamples: 3,
      questionTypeCounts: { "multi-session": 3 },
      questionTypeAccuracy: { "multi-session": { total: 3, judgeAccuracy: 1, exactMatch: 1 } },
      ingestion: { totalSessions: 3, ingestedSessions: 3, skippedSessions: 0 },
      answerGeneration: { totalHypotheses: 3, answered: 3, failed: 0, skipped: 0, answerRate: 1, fallbackUsed: false },
      judge: { totalJudged: 3, judged: 3, skipped: 0, accuracy: 1, fallbackUsed: false, model: "judge", baseUrl: "https://example.com" },
      metrics: {},
      samples: [1, 2, 3].map((index) => ({
        questionId: `q${index}`,
        questionType: "multi-session",
        question: `question ${index}`,
        answer: `answer ${index}`,
        hypothesis: `hypothesis ${index}`,
        judgment: {
          label: "correct" as const,
          score: 1,
          reason: "ok",
          model: "judge",
          baseUrl: "https://example.com"
        },
        retrieval: []
      }))
    }
  };
}

test("buildLongMemEvalSamplePage returns only the requested samples", () => {
  const page = buildLongMemEvalSamplePage(buildJob(), 2, 2);

  assert.equal(page?.page, 2);
  assert.equal(page?.pageSize, 2);
  assert.equal(page?.totalSamples, 3);
  assert.equal(page?.totalPages, 2);
  assert.deepEqual(page?.samples.map((sample) => sample.questionId), ["q3"]);
});

test("stripLongMemEvalSamplesFromJob removes heavy samples from job summaries", () => {
  const summary = stripLongMemEvalSamplesFromJob(buildJob()) as { report?: { samples?: unknown[]; totalSamples?: number } };

  assert.equal(summary.report?.totalSamples, 3);
  assert.equal("samples" in (summary.report ?? {}), false);
});
