import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDreamingScoringPrompt,
  DREAMING_SCORING_PROMPT_VERSION,
  DREAMING_SCORING_REFERENCE_DOCUMENT,
  DREAMING_SCORING_RUBRIC_VERSION
} from "./dreaming-score-prompt.js";

test("dreaming scoring prompt carries the versioned seven-factor rubric", () => {
  const prompt = JSON.parse(buildDreamingScoringPrompt([{
    memoryDataId: "stm_prompt_test",
    memoryDataType: "fact",
    memoryType: "preference",
    content: "用户要求以后回答先给结论。",
    importanceLevel: "high",
    confidenceLevel: "high",
    lifecycleStatus: "active",
    matchedRules: ["explicit_preference"],
    sourceFactIds: ["fact_prompt_test"],
    entityIds: [],
    admissionResult: "write_high_priority",
    admissionReason: "explicit preference"
  }])) as {
    rubricVersion: string;
    referenceDocument: string;
    dimensions: Record<string, { anchors: Record<string, string> }>;
    hardCaps: string[];
    calibrationExamples: unknown[];
    outputSchema: { scores: Array<{ scores: Record<string, string>; scoreReasons: Record<string, string> }> };
  };

  assert.equal(DREAMING_SCORING_PROMPT_VERSION, "ltm-dreaming-stm-score.v2");
  assert.equal(prompt.rubricVersion, DREAMING_SCORING_RUBRIC_VERSION);
  assert.equal(prompt.referenceDocument, DREAMING_SCORING_REFERENCE_DOCUMENT);
  assert.deepEqual(Object.keys(prompt.dimensions).sort(), [
    "actionCommitmentValue",
    "explicitWeight",
    "identityRelationValue",
    "informationEntropy",
    "preferenceConsistency",
    "reuseValue",
    "stability"
  ]);
  assert.equal(prompt.dimensions.stability?.anchors[10]?.includes("永久"), true);
  assert.equal(prompt.dimensions.reuseValue?.anchors[0]?.includes("服务端"), true);
  assert.equal(prompt.hardCaps.some((item) => item.includes("actionCommitmentValue") && item.includes("4")), true);
  assert.equal(prompt.calibrationExamples.length, 4);
  assert.equal(prompt.outputSchema.scores[0]?.scores.reuseValue, "must be 0");
  assert.equal(prompt.outputSchema.scores[0]?.scoreReasons.reuseValue, "evidence=server_owned; rationale=placeholder_only");
});
