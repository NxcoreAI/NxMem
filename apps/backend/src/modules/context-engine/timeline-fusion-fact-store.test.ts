import assert from "node:assert/strict";
import test from "node:test";
import type { FactItem } from "./domain.js";
import { createTimelineFusionExecution } from "./timeline-fusion-execution.js";
import { buildTimelineFusionFactStoreMutation } from "./timeline-fusion-fact-store.js";
import {
  buildTimelineFusionRelationInput,
  type TimelineFusionRelation,
  type TimelineFusionRelationResult
} from "./timeline-fusion-relations.js";

const NOW = "2026-08-07T08:30:00.000Z";

test("materializes support, supplement, update, conflict, create, and preserve decisions", () => {
  const cases: Array<{
    name: string;
    relation: TimelineFusionRelation;
    newFacts: FactItem[];
    historyFacts: FactItem[];
    verify: (mutation: ReturnType<typeof buildMutation>) => void;
  }> = [
    {
      name: "support",
      relation: relation("supports", ["fact_new", "fact_history"]),
      newFacts: [fact("fact_new", "Atlas review is confirmed", "2026-08-07T08:20:00.000Z")],
      historyFacts: [fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z")],
      verify: (mutation) => {
        assert.deepEqual(mutation.resultFactIds, ["fact_history"]);
        assert.equal(mutation.facts[0]?.factText, "Atlas review is Friday");
        assert.equal(mutation.facts[0]?.version, 2);
        assert.deepEqual(mutation.versions.filter((item) => item.factId === "fact_history").map((item) => item.version), [1, 2]);
      }
    },
    {
      name: "supplement",
      relation: relation("supplements", ["fact_new", "fact_history"], "Atlas review is Friday and covers cost."),
      newFacts: [fact("fact_new", "Atlas review covers cost", "2026-08-07T08:20:00.000Z")],
      historyFacts: [fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z")],
      verify: (mutation) => {
        assert.equal(mutation.facts[0]?.factText, "Atlas review is Friday and covers cost.");
        const versions = mutation.versions.filter((item) => item.factId === "fact_history");
        assert.equal(versions[0]?.factText, "Atlas review is Friday");
        assert.equal(versions[1]?.previousVersionId, versions[0]?.factVersionId);
      }
    },
    {
      name: "update",
      relation: relation("updates", ["fact_new", "fact_history"], "Atlas review moved to Monday."),
      newFacts: [fact("fact_new", "Atlas review moved to Monday", "2026-08-07T08:20:00.000Z", "2026-08-10T01:00:00.000Z")],
      historyFacts: [fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z", "2026-08-07T01:00:00.000Z")],
      verify: (mutation) => {
        assert.equal(mutation.facts[0]?.validTimeStart, "2026-08-10T01:00:00.000Z");
        assert.equal(mutation.versions.find((item) => item.factId === "fact_history" && item.version === 1)?.validTimeStart, "2026-08-07T01:00:00.000Z");
      }
    },
    {
      name: "conflict",
      relation: relation("conflicts", ["fact_new", "fact_history"]),
      newFacts: [fact("fact_new", "Atlas review is not Friday", "2026-08-07T08:20:00.000Z")],
      historyFacts: [fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z")],
      verify: (mutation) => {
        assert.deepEqual(mutation.resultFactIds, ["fact_history", "fact_new"]);
        assert.ok(mutation.facts.every((item) => item.status === "conflicted"));
        assert.deepEqual(mutation.versions.filter((item) => item.version === 2).map((item) => item.conflictRefs), [["fact_new"], ["fact_history"]]);
      }
    },
    {
      name: "create",
      relation: relation("same_event", ["fact_new", "fact_new_2"], "Atlas review is Friday and covers cost."),
      newFacts: [
        fact("fact_new", "Atlas review is Friday", "2026-08-07T08:20:00.000Z"),
        fact("fact_new_2", "Atlas review covers cost", "2026-08-07T08:21:00.000Z")
      ],
      historyFacts: [],
      verify: (mutation) => {
        assert.equal(mutation.facts.length, 1);
        assert.match(mutation.facts[0]!.factId, /^fact_timeline_/u);
        assert.deepEqual(mutation.resultFactIds, [mutation.facts[0]!.factId]);
        assert.equal(mutation.versions.length, 3);
      }
    },
    {
      name: "preserve",
      relation: relation("unrelated", ["fact_new", "fact_history"]),
      newFacts: [fact("fact_new", "Weather is rainy", "2026-08-07T08:20:00.000Z")],
      historyFacts: [fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z")],
      verify: (mutation) => {
        assert.deepEqual(mutation.facts, []);
        assert.deepEqual(mutation.resultFactIds, ["fact_new"]);
        assert.deepEqual(mutation.versions.map((item) => item.factId), ["fact_new"]);
      }
    }
  ];

  for (const item of cases) {
    assert.doesNotThrow(() => item.verify(buildMutation(item.newFacts, item.historyFacts, item.relation)), item.name);
  }
});

test("uses stable source fingerprints and does not mutate an existing version", () => {
  const newFact = fact("fact_new", "Atlas review covers cost", "2026-08-07T08:20:00.000Z");
  const history = fact("fact_history", "Atlas review is Friday", "2026-08-07T08:00:00.000Z");
  const relationValue = relation("supplements", ["fact_new", "fact_history"], "Atlas review is Friday and covers cost.");
  const first = buildMutation([newFact], [history], relationValue);
  const second = buildMutation([newFact], [history], relationValue);

  assert.deepEqual(second.versions, first.versions);
  assert.equal(first.versions.find((item) => item.factId === "fact_history" && item.version === 1)?.factText, history.factText);
});

function buildMutation(newFacts: FactItem[], historyFacts: FactItem[], relationValue: TimelineFusionRelation) {
  const relationInput = buildTimelineFusionRelationInput({
    newFacts,
    candidateFacts: historyFacts,
    temporalWindow: {
      basis: "evidence",
      startAt: "2026-08-07T07:30:00.000Z",
      endAt: "2026-08-07T09:00:00.000Z"
    }
  });
  const relationResult: TimelineFusionRelationResult = {
    schemaVersion: "timeline-fusion-relations.v1",
    relations: [relationValue],
    unusedFactIds: relationInput.facts
      .map((item) => item.factId)
      .filter((factId) => !relationValue.sourceFactIds.includes(factId))
  };
  const execution = createTimelineFusionExecution({
    tenantId: "tenant_1",
    principalId: "principal_1",
    taskIds: ["task_1"],
    batchIds: ["batch_1"],
    newFactIds: newFacts.map((item) => item.factId),
    temporalWindow: relationInput.temporalWindow,
    fusionPolicyVersion: "timeline-fusion.v1",
    createdAt: NOW
  });
  return buildTimelineFusionFactStoreMutation({
    execution,
    relationInput,
    relationResult,
    currentFacts: [...newFacts, ...historyFacts],
    currentVersions: [],
    now: NOW
  });
}

function relation(
  type: TimelineFusionRelation["type"],
  sourceFactIds: string[],
  factText?: string
): TimelineFusionRelation {
  return {
    type,
    sourceFactIds,
    ...(factText ? { factText, normalizedClaim: factText.toLowerCase() } : {}),
    confidenceLevel: "high",
    reasonCode: `${type}_test`
  };
}

function fact(
  factId: string,
  factText: string,
  evidenceTimeStart: string,
  validTimeStart?: string
): FactItem {
  return {
    factId,
    tenantId: "tenant_1",
    principalId: "principal_1",
    factType: "project_event",
    factText,
    normalizedClaim: factText.toLowerCase(),
    linkedEventIds: [`event_${factId}`],
    linkedSegmentIds: [`segment_${factId}`],
    linkedSourceRefs: [],
    entityIds: ["atlas_review"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: evidenceTimeStart,
    evidenceTimeStart,
    evidenceTimeEnd: evidenceTimeStart,
    evidenceTimeConfidence: "high",
    ...(validTimeStart
      ? {
          validTimeStart,
          validTimeEnd: validTimeStart,
          validTimeBasis: "absolute" as const,
          validTimeConfidence: "high" as const,
          timeBasis: "absolute" as const
        }
      : { timeBasis: "source_time" as const }),
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-fact-store-test.v1"
  };
}
