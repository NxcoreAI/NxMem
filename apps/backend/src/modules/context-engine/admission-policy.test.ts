import assert from "node:assert/strict";
import test from "node:test";
import { evaluateShortTermAdmission } from "./admission-policy.js";
import type { FactItem, MemoryEvent } from "./domain.js";

test("meaningful quantitative facts receive candidate admission and high importance", () => {
  for (const text of [
    "The user packed 5 pairs of shoes.",
    "The user brought 5 shoes in total.",
    "During peak seasons, the user works 10 additional hours per week.",
    "The waterproof car cover cost $120.",
    "The meeting is on May 8th."
  ]) {
    const decision = evaluateShortTermAdmission(event(), fact(text));
    assert.equal(decision.result, "write_candidate", text);
    assert.equal(decision.importanceLevel, "high", text);
    assert.equal(decision.matchedRules.includes("meaningful_quantitative_fact"), true, text);
  }
});

test("example numbers and bare list ordinals do not receive quantitative promotion", () => {
  for (const text of [
    "For example, a hypothetical budget could be $120.",
    "The assistant returned options 1, 2, and 3."
  ]) {
    const decision = evaluateShortTermAdmission(event(), fact(text));
    assert.equal(decision.importanceLevel, "medium", text);
    assert.equal(decision.matchedRules.includes("meaningful_quantitative_fact"), false, text);
  }
});

function event(): MemoryEvent {
  return {
    eventId: "event_quantitative_admission",
    eventType: "longmemeval_session",
    eventTime: "2026-08-26T08:00:00.000Z",
    sourceApp: "longmemeval",
    permissionSnapshot: {
      snapshotId: "permission_quantitative_admission",
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [],
    sourceRefs: []
  };
}

function fact(text: string): FactItem[] {
  return [{
    factId: `fact_${text.length}`,
    factType: "experience",
    factText: text,
    normalizedClaim: text,
    linkedEventIds: ["event_quantitative_admission"],
    linkedSegmentIds: ["segment_quantitative_admission"],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-08-26T08:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  }];
}
