import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selectLongMemEvalSamples,
  splitLongMemEvalSamples,
  writeLongMemEvalDataset
} from "./longmemeval-dataset.js";
import type { LongMemEvalSample } from "./longmemeval.js";

const samples: LongMemEvalSample[] = [
  { question_id: "q1", question_type: "a" },
  { question_id: "q2", question_type: "a" },
  { question_id: "q3", question_type: "b" },
  { question_id: "q4", question_type: "b" },
  { question_id: "q5", question_type: "c" }
];

test("selects question ids in original dataset order", () => {
  const selected = selectLongMemEvalSamples(samples, { questionIds: ["q4", "q1", "q4"] });
  assert.deepEqual(selected.map((sample) => sample.question_id), ["q1", "q4"]);
});

test("rejects missing question ids", () => {
  assert.throws(() => selectLongMemEvalSamples(samples, { questionIds: ["missing"] }), /question id not found/);
});

test("selects a 1-based inclusive range and rejects invalid bounds", () => {
  assert.deepEqual(
    selectLongMemEvalSamples(samples, { range: { start: 2, end: 4 } }).map((sample) => sample.question_id),
    ["q2", "q3", "q4"]
  );
  assert.throws(() => selectLongMemEvalSamples(samples, { range: { start: 0, end: 2 } }), /sample range/);
  assert.throws(() => selectLongMemEvalSamples(samples, { range: { start: 4, end: 3 } }), /sample range/);
  assert.throws(() => selectLongMemEvalSamples(samples, { range: { start: 1, end: 6 } }), /sample range/);
});

test("creates deterministic stratified subsets in original order", () => {
  const first = splitLongMemEvalSamples(samples, 0.5, 42);
  const second = splitLongMemEvalSamples(samples, 0.5, 42);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((sample) => sample.question_type).sort(), ["a", "b", "c"]);
  assert.deepEqual(first, samples.filter((sample) => first.includes(sample)));
});

test("validates split ratio and seed", () => {
  assert.throws(() => splitLongMemEvalSamples(samples, 0, 1), /ratio/);
  assert.throws(() => splitLongMemEvalSamples(samples, 1.1, 1), /ratio/);
  assert.throws(() => splitLongMemEvalSamples(samples, 0.5, 1.5), /seed/);
});

test("writes explicit subset files without marking them temporary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "longmemeval-dataset-test-"));
  const output = join(directory, "subset.json");
  const file = await writeLongMemEvalDataset(samples.slice(0, 2), output);
  assert.equal(file.temporary, false);
  assert.equal(file.path, output);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), samples.slice(0, 2));
});
