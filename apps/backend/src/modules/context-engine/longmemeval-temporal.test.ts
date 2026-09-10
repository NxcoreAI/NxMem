import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactItem } from "./domain.js";
import {
  applyLongMemEvalFactTemporal,
  resolveLongMemEvalFactTemporal,
  resolveLongMemEvalTimeAnchor
} from "./longmemeval-temporal.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import {
  buildTimelineAggregatedFacts,
  materializeTimelineAggregatedFacts
} from "./timeline-aggregation.js";

const evidenceTime = "2023-05-20T10:00:00.000Z";

test("LongMemEval resolves explicit timeAnchor points without scanning fact text", () => {
  const temporal = resolveLongMemEvalTimeAnchor({
    evidenceTime,
    timeAnchor: "two months ago",
    factText: "The user started the course two months ago."
  });

  assert.deepEqual(temporal, {
    evidenceTime,
    validTime: "2023-03-01T00:00:00.000Z"
  });
});

test("LongMemEval explicit null timeAnchor does not scan canonical text", () => {
  const normalized = applyLongMemEvalFactTemporal({
    ...buildFact("fact_no_anchor", "The user completed the course three days ago."),
    timeAnchor: null
  }, evidenceTime);

  assert.equal(normalized.evidenceTime, evidenceTime);
  assert.equal(normalized.validTime, undefined);
  assert.equal(normalized.validTimeStart, undefined);
  assert.equal(normalized.validTimeEnd, undefined);
});

test("LongMemEval resolves result-driven relative weekdays", () => {
  assert.equal(resolveLongMemEvalTimeAnchor({
    evidenceTime,
    timeAnchor: "last Saturday"
  }).validTime, "2023-05-13T00:00:00.000Z");
  assert.equal(resolveLongMemEvalTimeAnchor({
    evidenceTime,
    timeAnchor: "next Tuesday"
  }).validTime, "2023-05-23T00:00:00.000Z");
});

test("LongMemEval resolves standalone month anchors using the evidence year", () => {
  assert.deepEqual(resolveLongMemEvalTimeAnchor({
    evidenceTime: "2023-10-15T19:23:00.000Z",
    timeAnchor: "in August"
  }), {
    evidenceTime: "2023-10-15T19:23:00.000Z",
    validTimeStart: "2023-08-01T00:00:00.000Z",
    validTimeEnd: "2023-09-01T00:00:00.000Z"
  });
  assert.deepEqual(resolveLongMemEvalTimeAnchor({
    evidenceTime: "2023-01-15T00:00:00.000Z",
    timeAnchor: "in August"
  }), {
    evidenceTime: "2023-01-15T00:00:00.000Z",
    validTimeStart: "2022-08-01T00:00:00.000Z",
    validTimeEnd: "2022-09-01T00:00:00.000Z"
  });
});

test("LongMemEval resolves weekend anchors as explicit intervals", () => {
  const temporal = resolveLongMemEvalTimeAnchor({
    evidenceTime: "2023-10-15T19:23:00.000Z",
    timeAnchor: "last weekend"
  });
  assert.equal(temporal.validTimeStart, "2023-10-07T00:00:00.000Z");
  assert.equal(temporal.validTimeEnd, "2023-10-09T00:00:00.000Z");
});

test("LongMemEval keeps present-perfect durations as ranges and vague anchors unresolved", () => {
  const duration = resolveLongMemEvalTimeAnchor({
    evidenceTime,
    timeAnchor: "for two months",
    factText: "The user has been taking the course for two months."
  });
  assert.equal(duration.validTime, undefined);
  assert.equal(duration.validTimeStart, "2023-03-01T00:00:00.000Z");
  assert.equal(duration.validTimeEnd, evidenceTime);

  assert.deepEqual(resolveLongMemEvalTimeAnchor({
    evidenceTime,
    timeAnchor: "a few days ago"
  }), { evidenceTime });
});

test("LongMemEval resolves explicit month and clock ranges", () => {
  const monthRange = resolveLongMemEvalTimeAnchor({
    evidenceTime,
    timeAnchor: "from March to May"
  });
  assert.equal(monthRange.validTimeStart, "2023-03-01T00:00:00.000Z");
  assert.equal(monthRange.validTimeEnd, "2023-06-01T00:00:00.000Z");

  const clockRange = resolveLongMemEvalTimeAnchor({
    evidenceTime,
    timeAnchor: "14:00-15:00"
  });
  assert.equal(clockRange.validTimeStart, "2023-05-20T14:00:00.000Z");
  assert.equal(clockRange.validTimeEnd, "2023-05-20T15:00:00.000Z");
});

test("LongMemEval facts keep only evidenceTime when no real occurrence time can be resolved", () => {
  assert.deepEqual(
    resolveLongMemEvalFactTemporal("The user owns a blue bicycle.", evidenceTime),
    { evidenceTime }
  );
  assert.deepEqual(
    resolveLongMemEvalFactTemporal("The meeting lasted one hour.", evidenceTime),
    { evidenceTime }
  );
  assert.deepEqual(
    resolveLongMemEvalFactTemporal("The trip happened a few days later.", evidenceTime),
    { evidenceTime }
  );
  assert.deepEqual(
    resolveLongMemEvalFactTemporal("会议在几天后举行。", evidenceTime),
    { evidenceTime }
  );
});

test("LongMemEval facts resolve precise relative hours from evidenceTime", () => {
  assert.equal(
    resolveLongMemEvalFactTemporal("The call happened two hours later.", evidenceTime).validTime,
    "2023-05-20T12:00:00.000Z"
  );
  assert.equal(
    resolveLongMemEvalFactTemporal("The call happened 2 hours ago.", evidenceTime).validTime,
    "2023-05-20T08:00:00.000Z"
  );
});

test("LongMemEval facts resolve relative calendar days and weeks from evidenceTime", () => {
  assert.equal(
    resolveLongMemEvalFactTemporal("The appointment was two days before.", evidenceTime).validTime,
    "2023-05-18T00:00:00.000Z"
  );
  assert.equal(
    resolveLongMemEvalFactTemporal("The appointment is 两天后。", evidenceTime).validTime,
    "2023-05-22T00:00:00.000Z"
  );
  assert.equal(
    resolveLongMemEvalFactTemporal("The visit was two weeks before.", evidenceTime).validTime,
    "2023-05-06T00:00:00.000Z"
  );
  assert.equal(
    resolveLongMemEvalFactTemporal("The visit is 两周后。", evidenceTime).validTime,
    "2023-06-03T00:00:00.000Z"
  );
});

test("LongMemEval keeps relative calendar periods as ranges and relative offsets as points", () => {
  assert.equal(
    resolveLongMemEvalFactTemporal("The user started watching stand-up 3 months ago.", evidenceTime).validTime,
    "2023-02-01T00:00:00.000Z"
  );
  assert.deepEqual(
    resolveLongMemEvalFactTemporal("The user attended an open mic last month.", evidenceTime),
    {
      evidenceTime,
      validTimeStart: "2023-04-01T00:00:00.000Z",
      validTimeEnd: "2023-05-01T00:00:00.000Z"
    }
  );
  assert.deepEqual(
    resolveLongMemEvalFactTemporal("The user bought groceries last week.", evidenceTime),
    {
      evidenceTime,
      validTimeStart: "2023-05-08T00:00:00.000Z",
      validTimeEnd: "2023-05-15T00:00:00.000Z"
    }
  );

  const normalized = applyLongMemEvalFactTemporal(
    buildFact("fact_thrive", "The user spent around $150 at Thrive Market last month."),
    "2023-05-26T10:17:00.000Z"
  );
  assert.equal(normalized.validTime, undefined);
  assert.equal(normalized.validTimeStart, "2023-04-01T00:00:00.000Z");
  assert.equal(normalized.validTimeEnd, "2023-05-01T00:00:00.000Z");
  assert.equal(normalized.validTimeBasis, "event_relative");
  assert.equal(normalized.validTimeConfidence, "high");
});

test("LongMemEval normalization recovers a relative point from sourceClaim", () => {
  const normalized = applyLongMemEvalFactTemporal({
    ...buildFact("fact_standup", "User has been into stand-up comedy for about 3 months."),
    sourceClaim: "It started about 3 months ago when I watched a John Mulaney special."
  }, evidenceTime);

  assert.equal(normalized.validTime, "2023-02-01T00:00:00.000Z");
  assert.equal(normalized.validTimeStart, undefined);
  assert.equal(normalized.validTimeEnd, undefined);
  assert.equal(normalized.timeBasis, "event_relative");
});

test("LongMemEval present-perfect month durations remain intervals", () => {
  const normalized = applyLongMemEvalFactTemporal(
    buildFact("fact_duration", "The user has been watching stand-up regularly for 3 months."),
    evidenceTime
  );

  assert.equal(normalized.validTime, undefined);
  assert.equal(normalized.validTimeStart, "2023-02-01T00:00:00.000Z");
  assert.equal(normalized.validTimeEnd, evidenceTime);
  assert.equal(normalized.validTimeBasis, "event_relative");
});

test("LongMemEval absolute points use validTime and explicit clock ranges remain intervals", () => {
  assert.equal(
    resolveLongMemEvalFactTemporal("The conference starts on 2023-06-02.", evidenceTime).validTime,
    "2023-06-02T00:00:00.000Z"
  );
  assert.equal(
    resolveLongMemEvalFactTemporal("I finished reading on January 31, 2023.", evidenceTime).validTime,
    "2023-01-31T00:00:00.000Z"
  );
  const range = resolveLongMemEvalFactTemporal(
    "The meeting is from 14:00-15:00 and lasts one hour.",
    evidenceTime
  );
  assert.equal(range.validTime, undefined);
  assert.equal(range.validTimeStart, "2023-05-20T14:00:00.000Z");
  assert.equal(range.validTimeEnd, "2023-05-20T15:00:00.000Z");
});

test("LongMemEval facts preserve distinct event-level times inside one item", () => {
  const temporal = resolveLongMemEvalFactTemporal(
    "I set up the new router on January 15, 2023. I set up the smart thermostat on February 10, 2023.",
    evidenceTime
  );

  assert.equal(temporal.events?.length, 2);
  assert.deepEqual(temporal.events?.map((event) => [event.label, event.validTime]), [
    ["I set up the new router on January 15, 2023.", "2023-01-15T00:00:00.000Z"],
    ["I set up the smart thermostat on February 10, 2023.", "2023-02-10T00:00:00.000Z"]
  ]);
  assert.notEqual(temporal.events?.[0]?.eventKey, temporal.events?.[1]?.eventKey);

  const normalized = applyLongMemEvalFactTemporal(
    buildFact("fact_devices", "I set up the new router on January 15, 2023. I set up the smart thermostat on February 10, 2023."),
    evidenceTime
  );
  assert.equal(normalized.validTime, undefined);
  assert.deepEqual(normalized.events?.map((event) => event.sourceFactIds), [["fact_devices"], ["fact_devices"]]);
});

test("LongMemEval event mapping handles the real router and thermostat date shapes", () => {
  const temporal = resolveLongMemEvalFactTemporal(
    "I finally set up my smart thermostat on 2/10. I recently got a new router on January 15th.",
    "2023-03-28T15:46:00.000Z"
  );

  assert.deepEqual(temporal.events?.map((event) => event.validTime), [
    "2023-02-10T00:00:00.000Z",
    "2023-01-15T00:00:00.000Z"
  ]);
});

test("LongMemEval normalization preserves explicit intervals and removes stale evidence ranges", () => {
  const normalized = applyLongMemEvalFactTemporal({
    ...buildFact("fact_range", "The meeting is from 14:00-15:00 and lasts one hour."),
    timeAnchor: "14:00-15:00",
    evidenceTimeStart: "2023-05-20T10:00:00.000Z",
    evidenceTimeEnd: "2023-05-20T11:00:00.000Z",
    evidenceTimeConfidence: "high",
    validTime: "2023-05-20T14:00:00.000Z",
    validTimeStart: "2023-05-20T14:00:00.000Z",
    validTimeEnd: "2023-05-20T15:00:00.000Z",
    validTimeBasis: "absolute",
    validTimeConfidence: "high"
  }, evidenceTime);

  assert.equal(normalized.evidenceTime, evidenceTime);
  assert.equal(normalized.validTime, undefined);
  assert.equal(normalized.evidenceTimeStart, undefined);
  assert.equal(normalized.evidenceTimeEnd, undefined);
  assert.equal(normalized.validTimeStart, "2023-05-20T14:00:00.000Z");
  assert.equal(normalized.validTimeEnd, "2023-05-20T15:00:00.000Z");
  assert.match(normalized.factText, /14:00-15:00/);
  assert.match(normalized.factText, /one hour/);
});

test("LongMemEval temporal normalization prefers factText over an incomplete sourceClaim", () => {
  const normalized = applyLongMemEvalFactTemporal({
    ...buildFact("fact_fact_text_anchor", "The user set up a smart thermostat one month ago."),
    sourceClaim: "The user set up a smart thermostat and found it helpful.",
    validTimeStart: "2023-05-20T00:00:00.000Z",
    validTimeEnd: "2023-05-20T00:00:00.000Z",
    validTimeBasis: "absolute",
    validTimeConfidence: "high"
  }, evidenceTime);

  assert.equal(normalized.evidenceTime, evidenceTime);
  assert.equal(normalized.validTime, "2023-04-01T00:00:00.000Z");
  assert.equal(normalized.evidenceTimeStart, undefined);
  assert.equal(normalized.evidenceTimeEnd, undefined);
  assert.equal(normalized.validTimeStart, undefined);
  assert.equal(normalized.validTimeEnd, undefined);
});

test("LongMemEval timeline sorts by validTime and falls back to evidenceTime", () => {
  const facts = [
    {
      ...buildFact("fact_evidence_only", "The user bought a notebook."),
      evidenceTime: "2023-05-02T00:00:00.000Z"
    },
    {
      ...buildFact("fact_with_valid", "The user attended a concert."),
      evidenceTime: "2023-05-03T00:00:00.000Z",
      validTime: "2023-05-01T00:00:00.000Z"
    }
  ];

  const timeline = buildTimelineAggregatedFacts(facts);
  assert.deepEqual(timeline.map((fact) => fact.factId), ["fact_with_valid", "fact_evidence_only"]);
});

test("timeline fusion preserves the union of source event mappings", () => {
  const sourceFacts = [
    {
      ...buildFact("fact_rachel", "I started working with Rachel on February 15, 2022."),
      evidenceTime,
      validTime: "2022-02-15T00:00:00.000Z",
      events: [{
        eventKey: "rachel_started",
        label: "started working with Rachel",
        validTime: "2022-02-15T00:00:00.000Z",
        sourceFactIds: ["fact_rachel"]
      }]
    },
    {
      ...buildFact("fact_house", "I found a house I loved on March 1, 2022."),
      evidenceTime,
      validTime: "2022-03-01T00:00:00.000Z",
      events: [{
        eventKey: "house_found",
        label: "found a house I loved",
        validTime: "2022-03-01T00:00:00.000Z",
        sourceFactIds: ["fact_house"]
      }]
    }
  ];
  sourceFacts[1]!.linkedEventIds = sourceFacts[0]!.linkedEventIds;
  const fused = materializeTimelineAggregatedFacts(sourceFacts, [{
    aggregationId: "timeline_test",
    factId: "fact_timeline_test",
    factType: "episodic",
    factText: "The user started working with Rachel and later found a house they loved.",
    normalizedClaim: "The user started working with Rachel and later found a house they loved.",
    sourceEventIds: sourceFacts[0]!.linkedEventIds,
    sourceFactIds: sourceFacts.map((fact) => fact.factId),
    sourceSegmentIds: sourceFacts.flatMap((fact) => fact.linkedSegmentIds),
    sourceRefs: [],
    evidenceTime,
    events: sourceFacts.flatMap((fact) => fact.events ?? []),
    sourceMessageIds: [],
    timeBasis: "absolute",
    timeConfidence: "high"
  }], evidenceTime);
  assert.equal(fused[0]?.validTime, undefined);
  assert.deepEqual(fused[0]?.events?.map((event) => event.eventKey), ["rachel_started", "house_found"]);
});

test("SQLite restores LongMemEval evidenceTime, validTime, and event mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "longmemeval-temporal-"));
  const storePath = join(directory, "context-store.json");
  const fact = {
    ...buildFact("fact_persisted", "The user called two hours later."),
    sessionId: "session_persisted",
    factSequence: 2,
    timeAnchor: "two hours later",
    evidenceTime,
    validTime: "2023-05-20T12:00:00.000Z",
    events: [{
      eventKey: "nightingale_finished",
      label: "Finished The Nightingale",
      validTime: "2023-05-20T12:00:00.000Z",
      evidenceTime,
      sourceFactIds: ["fact_persisted"]
    }]
  };

  const writer = new SqliteContextEngineRepository(storePath);
  await writer.saveFactItem(fact);
  writer.close();

  const reader = new SqliteContextEngineRepository(storePath);
  try {
    const restored = reader.getDebugSnapshot().facts.find((item) => item.factId === fact.factId);
    assert.equal(restored?.evidenceTime, evidenceTime);
    assert.equal(restored?.validTime, "2023-05-20T12:00:00.000Z");
    assert.equal(restored?.timeAnchor, "two hours later");
    assert.equal(restored?.sessionId, "session_persisted");
    assert.equal(restored?.factSequence, 2);
    assert.deepEqual(restored?.events, fact.events);
  } finally {
    reader.close();
  }
});

test("SQLite restores an absent LongMemEval anchor as explicit null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "longmemeval-null-anchor-"));
  const storePath = join(directory, "context-store.json");
  const writer = new SqliteContextEngineRepository(storePath);
  await writer.saveFactItem({
    ...buildFact("fact_without_anchor", "The user owns a blue bicycle."),
    timeAnchor: null,
    evidenceTime
  });
  writer.close();

  const reader = new SqliteContextEngineRepository(storePath);
  try {
    const [restored] = reader.getFactItemsByIds(["fact_without_anchor"]);
    assert.equal(restored?.timeAnchor, null);
  } finally {
    reader.close();
  }
});

function buildFact(factId: string, factText: string): FactItem {
  return {
    factId,
    factType: "episodic",
    factText,
    sourceClaim: factText,
    normalizedClaim: factText.toLocaleLowerCase(),
    linkedEventIds: [`event_${factId}`],
    linkedSegmentIds: [`segment_${factId}`],
    linkedSourceRefs: [],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: evidenceTime,
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  };
}
