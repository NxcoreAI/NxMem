import assert from "node:assert/strict";
import test from "node:test";
import type { FactItem } from "./domain.js";
import {
  buildTimelineFusionRelationInput,
  buildTimelineFusionRelationPrompt,
  parseTimelineFusionRelationResponseCompatible,
  parseTimelineFusionRelationResponse,
  timelineFusionRelationsJsonSchema,
  TimelineFusionRelationProtocolError
} from "./timeline-fusion-relations.js";

const temporalWindow = {
  basis: "evidence" as const,
  startAt: "2026-08-07T07:00:00.000Z",
  endAt: "2026-08-07T09:00:00.000Z"
};

test("builds a stable prompt-ready relation input with effective fact fields", () => {
  const input = buildTimelineFusionRelationInput({
    newFacts: [fact("fact_new", "Atlas release started", {
      entityIds: ["atlas"],
      linkedEventIds: ["event_new"],
      sourceMessageIds: ["message_new"],
      evidenceTimeStart: "2026-08-07T08:10:00.000Z"
    })],
    candidateFacts: [fact("fact_history", "Atlas deployment is in progress", {
      factType: "document",
      entityIds: ["atlas"],
      linkedEventIds: ["event_history"],
      evidenceTimeStart: "2026-08-07T08:00:00.000Z"
    })],
    temporalWindow
  });

  assert.equal(input.schemaVersion, "timeline-fusion-relation-input.v1");
  assert.deepEqual(input.newFactIds, ["fact_new"]);
  assert.deepEqual(input.facts.map((item) => [item.factId, item.isNew]), [
    ["fact_new", true],
    ["fact_history", false]
  ]);
  assert.equal(input.facts[0]?.evidenceTimeStart, "2026-08-07T08:10:00.000Z");
  assert.deepEqual(input.facts[0]?.sourceMessageIds, ["message_new"]);
  assert.deepEqual(input.facts[0]?.sourceRefIds, []);
  assert.equal(input.facts[1]?.validTimeStart, null);

  const prompt = buildTimelineFusionRelationPrompt(input);
  assert.match(prompt, /时间接近只用于召回/u);
  assert.match(prompt, /same_event/u);
  assert.match(prompt, /needs_review/u);
  assert.match(prompt, /数字、单位、英文专名、否定词/u);
  assert.match(prompt, /不得使用 same_event、supplements 或 updates 物化合并/u);
  assert.match(prompt, /tennis 与 table tennis 不得判为同一实体/u);
  assert.match(prompt, /"isNew": true/u);
});

test("exposes a strict relations JSON schema", () => {
  assert.equal(timelineFusionRelationsJsonSchema.strict, true);
  assert.equal(timelineFusionRelationsJsonSchema.schema.additionalProperties, false);
  assert.deepEqual(timelineFusionRelationsJsonSchema.schema.required, ["relations"]);
  assert.equal(
    timelineFusionRelationsJsonSchema.schema.properties.relations.items.properties.sourceFactIds.uniqueItems,
    true
  );
});

test("parses multiple relation types and returns facts unused by the LLM", () => {
  const input = relationInput([
    fact("fact_new_event", "Atlas release started"),
    fact("fact_new_status", "Atlas budget changed")
  ], [
    fact("fact_history_event", "Atlas deployment is in progress"),
    fact("fact_history_status", "Atlas budget is 100000"),
    fact("fact_unused", "Atlas owner is Alice")
  ]);
  const response = chatResponse({
    relations: [
      {
        type: "same_event",
        sourceFactIds: ["fact_new_event", "fact_history_event"],
        factText: "Atlas release deployment has started and is in progress.",
        normalizedClaim: "Atlas release deployment is in progress",
        confidenceLevel: "high",
        reasonCode: "same_subject_complementary_evidence"
      },
      {
        type: "conflicts",
        sourceFactIds: ["fact_new_status", "fact_history_status"],
        factText: null,
        normalizedClaim: null,
        confidenceLevel: "medium",
        reasonCode: "incompatible_budget_values"
      }
    ]
  });

  const result = parseTimelineFusionRelationResponse(response, input);

  assert.equal(result.schemaVersion, "timeline-fusion-relations.v1");
  assert.equal(result.relations.length, 2);
  assert.equal(result.relations[0]?.type, "same_event");
  assert.equal(result.relations[1]?.factText, undefined);
  assert.deepEqual(result.unusedFactIds, ["fact_unused"]);
});

test("parses Responses API output text without relaxing the payload contract", () => {
  const input = relationInput(
    [fact("fact_new", "Atlas release started")],
    [fact("fact_history", "Lunch order was placed")]
  );
  const result = parseTimelineFusionRelationResponse({
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          relations: [{
            type: "unrelated",
            sourceFactIds: ["fact_new", "fact_history"],
            factText: null,
            normalizedClaim: null,
            confidenceLevel: "high",
            reasonCode: "different_subject_and_topic"
          }]
        })
      }]
    }]
  }, input);

  assert.equal(result.relations[0]?.type, "unrelated");
  assert.deepEqual(result.unusedFactIds, []);
});

test("rejects unknown fact IDs and relations that omit a new fact", () => {
  const input = relationInput(
    [fact("fact_new", "Atlas release started")],
    [fact("fact_history_1", "Atlas release prepared"), fact("fact_history_2", "Atlas release approved")]
  );

  assertProtocolError(() => parseTimelineFusionRelationResponse({
    relations: [nonMaterializingRelation("supports", ["fact_new", "fact_missing"])]
  }, input), /unknown fact ID/u);
  assertProtocolError(() => parseTimelineFusionRelationResponse({
    relations: [nonMaterializingRelation("supports", ["fact_history_1", "fact_history_2"])]
  }, input), /at least one new fact/u);
});

test("rejects duplicate IDs within and across relations", () => {
  const input = relationInput(
    [fact("fact_new_1", "Atlas release started"), fact("fact_new_2", "Atlas status changed")],
    [fact("fact_history_1", "Atlas release prepared"), fact("fact_history_2", "Atlas status pending")]
  );

  assertProtocolError(() => parseTimelineFusionRelationResponse({
    relations: [nonMaterializingRelation("supports", ["fact_new_1", "fact_new_1"])]
  }, input), /must not contain duplicates/u);
  assertProtocolError(() => parseTimelineFusionRelationResponse({
    relations: [
      nonMaterializingRelation("supports", ["fact_new_1", "fact_history_1"]),
      nonMaterializingRelation("conflicts", ["fact_new_2", "fact_history_1"])
    ]
  }, input), /reuses a fact/u);
});

test("enforces relation-specific fused text fields", () => {
  const input = relationInput(
    [fact("fact_new", "Atlas release started")],
    [fact("fact_history", "Atlas release prepared")]
  );

  assertProtocolError(() => parseTimelineFusionRelationResponse({
    relations: [nonMaterializingRelation("same_event", ["fact_new", "fact_history"])]
  }, input), /requires factText/u);
  assertProtocolError(() => parseTimelineFusionRelationResponse({
    relations: [{
      ...nonMaterializingRelation("supports", ["fact_new", "fact_history"]),
      factText: "Atlas release is supported by both facts",
      normalizedClaim: "Atlas release is supported"
    }]
  }, input), /must use null factText/u);
});

test("rejects legacy groups and unsupported response fields", () => {
  const input = relationInput(
    [fact("fact_new", "Atlas release started")],
    [fact("fact_history", "Atlas release prepared")]
  );

  assertProtocolError(() => parseTimelineFusionRelationResponse({ groups: [] }, input), /unsupported fields/u);
  assertProtocolError(() => parseTimelineFusionRelationResponse({
    relations: [{
      ...nonMaterializingRelation("supports", ["fact_new", "fact_history"]),
      explanation: "not allowed"
    }]
  }, input), /unsupported fields/u);
});

test("compatibility parser converts a valid legacy group to same_event", () => {
  const input = relationInput(
    [fact("fact_new", "用户通勤时使用 Audible")],
    [fact("fact_history", "用户在通勤时使用 Audible 听有声书")]
  );
  const parsed = parseTimelineFusionRelationResponseCompatible({
    groups: [{
      factText: "用户通勤时使用Audible听有声书。",
      normalizedClaim: "用户通勤时使用Audible听有声书",
      sourceFactIds: ["fact_new", "fact_history"],
      confidenceLevel: "high"
    }]
  }, input);

  assert.equal(parsed.responseFormat, "legacy_groups");
  assert.equal(parsed.result.relations[0]?.type, "same_event");
  assert.equal(parsed.result.relations[0]?.reasonCode, "legacy_group_same_event");
  assert.deepEqual(parsed.result.unusedFactIds, []);
});

test("compatibility parser still uses strict relations validation", () => {
  const input = relationInput(
    [fact("fact_new", "Atlas release started")],
    [fact("fact_history", "Atlas deployment is in progress")]
  );
  const parsed = parseTimelineFusionRelationResponseCompatible(chatResponse({
    relations: [{
      type: "same_event",
      sourceFactIds: ["fact_new", "fact_history"],
      factText: "Atlas release deployment started and is in progress.",
      normalizedClaim: "Atlas release deployment started and is in progress",
      confidenceLevel: "high",
      reasonCode: "same_release_event"
    }]
  }), input);

  assert.equal(parsed.responseFormat, "relations");
  assert.equal(parsed.result.relations[0]?.type, "same_event");
});

test("compatibility parser rejects lossy legacy groups", () => {
  const input = relationInput(
    [fact("fact_new", "用户每天通勤单程 45 分钟时使用 Audible")],
    [fact("fact_history", "用户在通勤时使用 Audible 听有声书")]
  );

  assert.throws(
    () => parseTimelineFusionRelationResponseCompatible({
      groups: [{
        factText: "用户通勤时使用Audible听有声书。",
        normalizedClaim: "用户通勤使用Audible听有声书",
        sourceFactIds: ["fact_new", "fact_history"],
        confidenceLevel: "high"
      }]
    }, input),
    (error: unknown) => error instanceof TimelineFusionRelationProtocolError &&
      error.code === "TIMELINE_FUSION_RELATION_DETAILS_LOST"
  );
});

test("keeps quantitative updates atomic instead of materializing a merged fact", () => {
  const input = relationInput(
    [fact("fact_new", "Atlas budget is 120 USD")],
    [fact("fact_history", "Atlas budget was 100 USD")]
  );
  assert.throws(
    () => parseTimelineFusionRelationResponseCompatible({
      relations: [{
        type: "updates",
        sourceFactIds: ["fact_new", "fact_history"],
        factText: "Atlas budget is now 120 USD.",
        normalizedClaim: "Atlas budget is 120 USD",
        confidenceLevel: "high",
        reasonCode: "new_budget_value"
      }]
    }, input),
    (error: unknown) => error instanceof TimelineFusionRelationProtocolError &&
      error.code === "TIMELINE_FUSION_RELATION_DETAILS_LOST" &&
      /atomic quantitative or temporal fact/u.test(error.message)
  );
});

test("does not merge nested but distinct entity names", () => {
  const input = relationInput(
    [fact("fact_table_tennis", "The user plays table tennis with friends.", { entityIds: ["table_tennis"] })],
    [fact("fact_tennis", "The user plays tennis with friends.", { entityIds: ["tennis"] })]
  );

  assert.throws(
    () => parseTimelineFusionRelationResponseCompatible({
      relations: [{
        type: "same_event",
        sourceFactIds: ["fact_table_tennis", "fact_tennis"],
        factText: "The user plays tennis and table tennis with friends.",
        normalizedClaim: "The user plays tennis and table tennis with friends",
        confidenceLevel: "high",
        reasonCode: "similar_sport_name"
      }]
    }, input),
    (error: unknown) => error instanceof TimelineFusionRelationProtocolError &&
      error.code === "TIMELINE_FUSION_RELATION_DETAILS_LOST" &&
      /distinct nested entity names/u.test(error.message)
  );
});

test("rejects invalid relation input before building a prompt", () => {
  assert.throws(
    () => buildTimelineFusionRelationInput({
      newFacts: [fact("fact_new", "Atlas release started")],
      candidateFacts: [],
      temporalWindow
    }),
    (error: unknown) => error instanceof TimelineFusionRelationProtocolError &&
      error.code === "TIMELINE_FUSION_RELATION_INPUT_INVALID"
  );
});

function relationInput(newFacts: FactItem[], candidateFacts: FactItem[]) {
  return buildTimelineFusionRelationInput({ newFacts, candidateFacts, temporalWindow });
}

function nonMaterializingRelation(type: string, sourceFactIds: string[]) {
  return {
    type,
    sourceFactIds,
    factText: null,
    normalizedClaim: null,
    confidenceLevel: "medium",
    reasonCode: "test_relation_reason"
  };
}

function chatResponse(payload: unknown) {
  return {
    choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }]
  };
}

function assertProtocolError(action: () => unknown, message: RegExp) {
  assert.throws(action, (error: unknown) =>
    error instanceof TimelineFusionRelationProtocolError &&
    error.code === "TIMELINE_FUSION_RELATION_RESPONSE_INVALID" &&
    message.test(error.message)
  );
}

function fact(factId: string, claim: string, overrides: Partial<FactItem> = {}): FactItem {
  return {
    factId,
    factType: "event",
    factText: claim,
    normalizedClaim: claim,
    linkedEventIds: [`event_${factId}`],
    linkedSegmentIds: [`segment_${factId}`],
    linkedSourceRefs: [],
    entityIds: ["atlas"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-08-07T08:30:00.000Z",
    evidenceTimeStart: "2026-08-07T08:00:00.000Z",
    evidenceTimeConfidence: "high",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "timeline-fusion-relations-test.v1",
    ...overrides
  };
}
