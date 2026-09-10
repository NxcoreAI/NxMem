import test from "node:test";
import assert from "node:assert/strict";
import type { FactItem, MemoryEvent } from "./domain.js";
import { buildShortTermMemorySearchContent } from "./indexing.js";
import {
  buildShortTermMemoryPayload,
  mergeLongTermStructuredFacts,
  type LongTermStructuredCandidate
} from "./structured-memory.js";

const evidenceTime = "2023-05-20T02:57:00.000Z";

test("structured memory preserves the source LongMemEval timeAnchor", () => {
  const fact = buildFact();
  const stm = buildShortTermMemoryPayload(buildEvent(), [fact]);
  assert.equal(stm.structuredFacts.facts[0]?.timeAnchor, "three days ago");

  const candidate: LongTermStructuredCandidate = {
    memoryDataId: "stm_fact_course",
    content: stm.content,
    structuredFacts: stm.structuredFacts,
    confidenceLevel: "high",
    entityIds: [],
    sourceRefs: [],
    admissionResult: "write_short_term",
    admissionReason: "test",
    importanceLevel: "medium",
    evidenceTime,
    validTime: fact.validTime!
  };
  const merged = mergeLongTermStructuredFacts([candidate], {
    schemaVersion: "memory-structured-facts.v1",
    memoryKind: "long_term",
    facts: [{
      claim: fact.normalizedClaim,
      explanation: "Generated summary.",
      timeAnchor: "yesterday"
    }]
  });

  assert.equal(merged.facts[0]?.timeAnchor, "three days ago");
  assert.equal(merged.facts[0]?.validTime, fact.validTime);
});

test("structured memory uses lossless factText as its readable claim", () => {
  const fact = {
    ...buildFact(),
    factText: "During peak campaign seasons, the user works 10 additional hours per week.",
    normalizedClaim: "The user adapts to changing workloads."
  };

  const stm = buildShortTermMemoryPayload(buildEvent(), [fact]);

  assert.equal(stm.content, fact.factText);
  assert.equal(stm.structuredFacts.facts[0]?.claim, fact.factText);
});

test("STM search content indexes factText independently of normalized content", () => {
  const fact = {
    ...buildFact(),
    factText: "During peak seasons, the user works 10 additional hours per week.",
    normalizedClaim: "The user adapts to changing workloads."
  };
  const payload = buildShortTermMemoryPayload(buildEvent(), [fact]);
  const searchContent = buildShortTermMemorySearchContent({
    ...payload,
    memoryDataId: "stm_quantitative_search",
    tenantId: "tenant",
    principalId: "principal",
    memoryDataType: "fact",
    content: fact.normalizedClaim,
    sourceFactIds: [fact.factId],
    sourceRefs: [],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_candidate",
    admissionReason: "meaningful_quantitative_fact",
    matchedRules: ["meaningful_quantitative_fact"],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "medium",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "candidate_queue",
    createdAt: evidenceTime,
    updatedAt: evidenceTime
  }, [fact]);

  assert.match(searchContent, /10 additional hours per week/u);
});

function buildEvent(): MemoryEvent {
  return {
    eventId: "event_course",
    eventType: "longmemeval_session",
    eventTime: evidenceTime,
    sourceApp: "longmemeval",
    sourceId: "session_course",
    permissionSnapshot: {
      snapshotId: "permission_course",
      tenantId: "tenant",
      principalId: "principal",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [],
    sourceRefs: []
  };
}

function buildFact(): FactItem {
  return {
    factId: "fact_course",
    factType: "state_change",
    factText: "The user completed the course three days ago.",
    sourceClaim: "I completed the course three days ago.",
    normalizedClaim: "The user completed the course three days ago.",
    timeAnchor: "three days ago",
    linkedEventIds: ["event_course"],
    linkedSegmentIds: ["segment_course"],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: evidenceTime,
    evidenceTime,
    validTime: "2023-05-17T00:00:00.000Z",
    timeBasis: "event_relative",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  };
}
