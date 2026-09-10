import assert from "node:assert/strict";
import test from "node:test";
import type { FactItem, TimelineFusionWindow } from "./domain.js";
import {
  areTimelineFusionFactTypesCompatible,
  filterAndGroupTimelineFusionCandidates
} from "./timeline-fusion-candidate-filter.js";

const window: TimelineFusionWindow = {
  basis: "evidence",
  startAt: "2026-08-07T07:00:00.000Z",
  endAt: "2026-08-07T09:00:00.000Z"
};

test("filters facts with unrelated entities and topics", () => {
  const result = filterAndGroupTimelineFusionCandidates({
    newFacts: [fact("fact_new", "Alice approved the Atlas launch", {
      factType: "event",
      entityIds: ["alice", "atlas"]
    })],
    candidateFacts: [fact("fact_history", "Bob ordered noodles for lunch", {
      factType: "text",
      entityIds: ["bob"]
    })],
    temporalWindow: window
  });

  assert.deepEqual(result.groups[0]?.candidateFactIds, []);
  assert.deepEqual(result.unrelatedCandidateFactIds, ["fact_history"]);
});

test("retains a compatible fact that shares an entity", () => {
  const result = filterAndGroupTimelineFusionCandidates({
    newFacts: [fact("fact_new", "Alice opened the Atlas review", {
      factType: "event",
      entityIds: ["alice"]
    })],
    candidateFacts: [fact("fact_history", "Alice presented the quarterly results", {
      factType: "document",
      entityIds: ["alice"]
    })],
    temporalWindow: window
  });

  assert.deepEqual(result.groups[0]?.candidateFactIds, ["fact_history"]);
  assert.ok(result.groups[0]?.reasonCodes.includes("shared_entity"));
});

test("retains strongly overlapping claims without entity IDs", () => {
  const result = filterAndGroupTimelineFusionCandidates({
    newFacts: [fact("fact_new", "Project Atlas launch is scheduled for Friday", {
      factType: "timeline"
    })],
    candidateFacts: [fact("fact_history", "The Atlas project launch schedule is Friday", {
      factType: "text"
    })],
    temporalWindow: window
  });

  assert.deepEqual(result.groups[0]?.candidateFactIds, ["fact_history"]);
  assert.ok(result.groups[0]?.reasonCodes.includes("topic_overlap"));
});

test("supports broad episodic types without treating open types as universally compatible", () => {
  assert.equal(areTimelineFusionFactTypesCompatible("event", "text"), true);
  assert.equal(areTimelineFusionFactTypesCompatible("document", "tool-result"), true);
  assert.equal(areTimelineFusionFactTypesCompatible("preference", "profile"), false);
  assert.equal(areTimelineFusionFactTypesCompatible("task", "preference"), false);

  const result = filterAndGroupTimelineFusionCandidates({
    newFacts: [fact("fact_new", "User prefers coffee without sugar", {
      factType: "preference",
      entityIds: ["user"]
    })],
    candidateFacts: [fact("fact_history", "User profile says coffee without sugar", {
      factType: "profile",
      entityIds: ["user"]
    })],
    temporalWindow: window
  });
  assert.deepEqual(result.groups[0]?.candidateFactIds, []);
});

test("deduplicates exact historical inputs without mutating source facts", () => {
  const first = fact("fact_history_1", "Atlas budget is 100000", {
    factType: "event",
    entityIds: ["atlas"],
    linkedSegmentIds: ["segment_1"]
  });
  const second = fact("fact_history_2", "Atlas budget is 100000", {
    factType: "event",
    entityIds: ["atlas"],
    linkedSegmentIds: ["segment_2"]
  });
  const result = filterAndGroupTimelineFusionCandidates({
    newFacts: [fact("fact_new", "Atlas budget review started", {
      factType: "event",
      entityIds: ["atlas"]
    })],
    candidateFacts: [second, first],
    temporalWindow: window
  });

  assert.deepEqual(result.groups[0]?.candidateFactIds, ["fact_history_1"]);
  assert.deepEqual(result.duplicateCandidateFactIds, ["fact_history_2"]);
  assert.equal(first.status, "active");
  assert.equal(second.status, "active");
});

test("splits unrelated new facts into independent topic groups", () => {
  const result = filterAndGroupTimelineFusionCandidates({
    newFacts: [
      fact("fact_lunch", "Bob ordered noodles for lunch", { factType: "text", entityIds: ["bob"] }),
      fact("fact_release", "Atlas release deployment started", {
        factType: "event",
        entityIds: ["atlas"]
      })
    ],
    candidateFacts: [],
    temporalWindow: window
  });

  assert.deepEqual(result.groups.map((group) => group.newFactIds), [
    ["fact_lunch"],
    ["fact_release"]
  ]);
});

test("does not use a weak temporal anchor as the only relation signal", () => {
  const result = filterAndGroupTimelineFusionCandidates({
    newFacts: [fact("fact_new", "Atlas deployment started", { factType: "event" })],
    candidateFacts: [fact("fact_history", "Bob ordered noodles", { factType: "text" })],
    temporalWindow: { ...window, basis: "weak_anchor" }
  });

  assert.deepEqual(result.groups[0]?.candidateFactIds, []);
  assert.deepEqual(result.groups[0]?.reasonCodes, ["weak_anchor"]);
});

function fact(
  factId: string,
  claim: string,
  overrides: Partial<FactItem> = {}
): FactItem {
  return {
    factId,
    factType: "event",
    factText: claim,
    normalizedClaim: claim,
    linkedEventIds: [`event_${factId}`],
    linkedSegmentIds: [],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-08-07T08:00:00.000Z",
    evidenceTimeStart: "2026-08-07T08:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-candidate-filter-test.v1",
    ...overrides
  };
}
