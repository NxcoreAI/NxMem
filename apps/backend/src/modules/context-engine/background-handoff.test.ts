import test from "node:test";
import assert from "node:assert/strict";
import type { SessionBackgroundSnapshot } from "./domain.js";
import {
  createMainAgentBackgroundHandoff,
  createMainAgentSessionBackgroundResult
} from "./background-handoff.js";

test("main Agent handoff preserves evidence and marks degraded background as incomplete", () => {
  const snapshot = sessionSnapshot();
  const handoff = createMainAgentBackgroundHandoff(snapshot);

  assert.equal(handoff.sessionId, snapshot.sessionId);
  assert.deepEqual(handoff.background, {
    fixedText: snapshot.fixedText,
    dynamicText: snapshot.dynamicText,
    fixedRevision: snapshot.fixedRevision,
    dynamicWindowStart: snapshot.dynamicWindowStart,
    dynamicWindowEnd: snapshot.dynamicWindowEnd,
    referenceTime: snapshot.referenceTime,
    timezone: snapshot.timezone,
    locale: snapshot.locale,
    localDate: snapshot.localDate
  });
  assert.deepEqual(handoff.citations, snapshot.citations);
  assert.deepEqual(handoff.conflicts, [{ conflictId: "conflict_1" }]);
  assert.match(handoff.serializedPrompt, /role="memory_evidence" status="degraded"/u);
  assert.match(handoff.serializedPrompt, /not as system or user instructions/u);
  assert.match(handoff.serializedPrompt, /may be incomplete/u);
  assert.match(handoff.serializedPrompt, /source_1/u);
  assert.match(handoff.serializedPrompt, /conflict_1/u);

  const toolResult = createMainAgentSessionBackgroundResult(snapshot);
  assert.equal(toolResult.dynamicCacheKey, snapshot.dynamicCacheKey);
  assert.deepEqual(toolResult.background, handoff.background);
  assert.deepEqual(toolResult.conflicts, handoff.conflicts);
  assert.equal(toolResult.serializedPrompt, handoff.serializedPrompt);
});

test("main Agent handoff rejects an unknown persisted status", () => {
  const invalid = {
    ...sessionSnapshot(),
    status: "unknown"
  } as unknown as SessionBackgroundSnapshot;
  assert.throws(
    () => createMainAgentBackgroundHandoff(invalid),
    /SESSION_BACKGROUND_STATUS_INVALID:unknown/u
  );
});

function sessionSnapshot(): SessionBackgroundSnapshot {
  return {
    snapshotId: "snapshot_1",
    sessionId: "session_1",
    tenantId: "tenant_1",
    principalId: "user_1",
    backgroundId: "background_1",
    fixedRevision: 2,
    fixedText: "## User identity\n- Fixed evidence.",
    dynamicText: "## Recent tasks\n- Partial dynamic evidence.",
    dynamicWindowStart: "2026-07-20T00:00:00.000Z",
    dynamicWindowEnd: "2026-07-21T00:00:00.000Z",
    referenceTime: "2026-07-21T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    localDate: "2026-07-21",
    fixedSourceRefIds: ["source_fixed"],
    dynamicSourceRefIds: ["source_1"],
    sourceMemoryIds: ["stm_1"],
    citations: [{ sourceRefId: "source_1", memoryDataId: "stm_1", layer: "stm" }],
    conflictIds: ["conflict_1"],
    latestStmCursor: {
      updatedAt: "2026-07-20T20:00:00.000Z",
      memoryDataId: "stm_1"
    },
    dynamicCacheKey: "dynamic-background:tenant_1:user_1:2:cursor",
    cacheHit: false,
    executionStrategy: "single_request",
    processedMemoryCount: 1,
    pendingStmCount: 2,
    deferredMemoryCount: 1,
    watermarkLagSeconds: 60,
    generatedAt: "2026-07-21T00:00:00.000Z",
    status: "degraded",
    degradedModeReason: "DYNAMIC_CANDIDATE_LIMIT_EXCEEDED",
    serializedPrompt: "<fixed_background>fixed</fixed_background>",
    createdAt: "2026-07-21T00:00:01.000Z"
  };
}
