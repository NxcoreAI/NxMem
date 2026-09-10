import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  LocomoDatasetError,
  parseLocomoEvaluationDataset,
  readLocomoEvaluationDataset
} from "./locomo-dataset.js";

test("reads the pinned LoCoMo dataset with stable identities and counts", async () => {
  const dataset = await readLocomoEvaluationDataset(resolve(process.cwd(), "../../data/locomo/locomo10.json"));
  assert.equal(dataset.sha256, "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4");
  assert.deepEqual(dataset.stats.categories, { 1: 282, 2: 321, 3: 96, 4: 841, 5: 446 });
  assert.equal(dataset.stats.conversations, 10);
  assert.equal(dataset.stats.sessions, 272);
  assert.equal(dataset.stats.turns, 5_882);
  assert.equal(dataset.stats.questions, 1_986);
  assert.equal(dataset.stats.questionsWithoutEvidence, 4);
  assert.equal(dataset.conversations[0]!.principalId, "locomo:conv-26");
  assert.equal(dataset.conversations[0]!.contextScopeId, `locomo:${dataset.sha256}:conv-26`);
  assert.equal(dataset.conversations[0]!.questions[1]!.referenceAnswer, "2022");
  assert.deepEqual(dataset.conversations[0]!.questions[37]!.goldDiaIds, ["D8:6", "D9:17"]);
});

test("sorts sessions numerically and retains captions outside text", () => {
  const dataset = parseLocomoEvaluationDataset([sample({
    session_10: [{ dia_id: "D10:1", speaker: "A", text: "photo", blip_caption: "a red bike", img_url: "https://example.test/a.jpg" }],
    session_10_date_time: "1:05 pm on 10 May, 2023",
    session_2: [{ dia_id: "D2:1", speaker: "B", text: "hello" }],
    session_2_date_time: "12:00 am on 2 May, 2023"
  })], { sha256: "abc" });
  assert.deepEqual(dataset.conversations[0]!.sessions.map((session) => session.sessionId), ["session_2", "session_10"]);
  assert.equal(dataset.conversations[0]!.sessions[1]!.turns[0]!.caption, "a red bike");
  assert.deepEqual(dataset.conversations[0]!.sessions[1]!.turns[0]!.imageUrls, ["https://example.test/a.jpg"]);
  assert.equal(dataset.conversations[0]!.questions[0]!.referenceTime, "2023-05-10T13:05:00.000Z");
});

test("rejects invalid dates, duplicate dia IDs, categories and answer objects", () => {
  const invalidDate = sample({ session_1: [turn("D1:1")], session_1_date_time: "not a date" });
  assert.throws(() => parseLocomoEvaluationDataset([invalidDate]), LocomoDatasetError);
  const duplicate = sample({ session_1: [turn("D1:1"), turn("D1:1")], session_1_date_time: "1:00 pm on 1 May, 2023" });
  assert.throws(() => parseLocomoEvaluationDataset([duplicate]), /duplicate dia_id/);
  const badCategory = sample(undefined, [{ question: "q", answer: "a", evidence: [], category: 6 }]);
  assert.throws(() => parseLocomoEvaluationDataset([badCategory]), /category must be 1..5/);
  const badAnswer = sample(undefined, [{ question: "q", answer: { nested: true }, evidence: [], category: 1 }]);
  assert.throws(() => parseLocomoEvaluationDataset([badAnswer]), /answer must be/);
});

function sample(conversation: Record<string, unknown> = {
  session_1: [turn("D1:1")],
  session_1_date_time: "1:00 pm on 1 May, 2023"
}, qa: unknown[] = [{ question: "q", answer: 2, evidence: ["(D1:1; D2:3)"], category: 1 }]) {
  return { sample_id: "sample/id", conversation, qa, observation: { ignored: true } };
}

function turn(diaId: string) {
  return { dia_id: diaId, speaker: "A", text: "hello" };
}
