import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  normalizeLocomoAnswer,
  porterStem,
  scoreLocomoQuestion,
  summarizeLocomoScores,
  tokenF1
} from "./locomo-official-scorer.js";

const execFileAsync = promisify(execFile);

test("normalizes punctuation, articles, conjunction and Porter stems", () => {
  assert.deepEqual(normalizeLocomoAnswer("The runners, were RUNNING and jumped!"), ["runner", "were", "run", "jump"]);
  assert.equal(porterStem("relational"), "relat");
  assert.equal(porterStem("ponies"), "poni");
  assert.equal(porterStem("ties"), "tie");
  assert.equal(porterStem("dying"), "die");
  assert.equal(porterStem("enjoy"), "enjoy");
  assert.deepEqual(normalizeLocomoAnswer("It's Alice_Bob's."), ["it", "alicebob"]);
});

test("token F1 uses multiset overlap", () => {
  assert.equal(tokenF1("cat cat dog", "cat dog dog"), 2 / 3);
  assert.equal(tokenF1("blue red", "red blue"), 1);
  assert.equal(tokenF1("", ""), 0);
});

test("scores category 1 as reference-answer best-match average", () => {
  const score = scoreLocomoQuestion({
    category: 1,
    referenceAnswer: "pottery, camping, painting, swimming",
    hypothesis: "swimming, pottery, painting"
  });
  assert.equal(score.score, 0.75);
});

test("scores category 2 and 4 with ordinary token F1", () => {
  assert.equal(scoreLocomoQuestion({ category: 2, referenceAnswer: "7 May 2023", hypothesis: "May 7, 2023" }).score, 1);
  assert.equal(scoreLocomoQuestion({ category: 4, referenceAnswer: "mental health", hypothesis: "health" }).score, 0.667);
});

test("truncates only the category 3 reference at its first semicolon", () => {
  assert.equal(scoreLocomoQuestion({
    category: 3,
    referenceAnswer: "National park; she likes the outdoors",
    hypothesis: "national park"
  }).score, 1);
});

test("category 5 follows exact official refusal phrase matching", () => {
  assert.equal(scoreLocomoQuestion({ category: 5, referenceAnswer: "", hypothesis: "No Information Available." }).score, 1);
  assert.equal(scoreLocomoQuestion({ category: 5, referenceAnswer: "", hypothesis: "It was not mentioned in the conversation." }).score, 1);
  assert.equal(scoreLocomoQuestion({ category: 5, referenceAnswer: "", hypothesis: "I cannot determine that." }).score, 0);
});

test("summary is naturally weighted and reports perfect score rate separately", () => {
  const summary = summarizeLocomoScores([
    { category: 1, score: 1 },
    { category: 1, score: 0.5 },
    { category: 2, score: 0 }
  ]);
  assert.equal(summary.categoryScores[1].score, 0.75);
  assert.equal(summary.overallOfficialQaScore, 0.5);
  assert.equal(summary.perfectScoreRate, 1 / 3);
});

test("TypeScript scores match the pinned upstream Python contract for every category", async () => {
  const fixturePath = resolve("src/modules/context-engine/fixtures/locomo-official-predictions.json");
  const referencePath = resolve("src/modules/context-engine/fixtures/locomo-official-reference.py");
  const rows = JSON.parse(await readFile(fixturePath, "utf8")) as Array<{
    id: string;
    category: 1 | 2 | 3 | 4 | 5;
    answer: string;
    prediction: string;
  }>;
  const { stdout } = await execFileAsync("python3", [referencePath, fixturePath]);
  const expected = JSON.parse(stdout) as {
    scores: Array<{ id: string; score: number }>;
    categories: Record<string, { count: number; score: number }>;
    overall: number;
  };
  const actual = rows.map((row) => ({
    id: row.id,
    category: row.category,
    score: scoreLocomoQuestion({
      category: row.category,
      referenceAnswer: row.answer,
      hypothesis: row.prediction
    }).score
  }));
  assert.deepEqual(actual.map(({ id, score }) => ({ id, score })), expected.scores);
  const summary = summarizeLocomoScores(actual);
  assert.deepEqual(summary.categoryScores, expected.categories);
  assert.equal(summary.overallOfficialQaScore, expected.overall);
});
