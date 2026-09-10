import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDreamingCandidate, gateDreamingCandidates } from "./dreaming-candidate-gate.js";
import type { FactItem, ShortTermMemory } from "./domain.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("dreaming candidate gate accepts visible, sourced STM and records evaluating state", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = createMemory({
    memoryDataId: "stm-gate-accepted",
    sourceFactIds: ["fact-1"],
    sourceRefs: [{ sourceRefId: "source-1", sourceType: "file", sourceId: "file-1" }]
  });
  await repository.saveShortTermMemory(memory);
  await repository.saveFactItem(createFact());

  const result = await gateDreamingCandidates(repository, {
    tenantId: "tenant-1",
    principalId: "user-1",
    now: "2026-07-30T00:00:00.000Z"
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.decisions[0]?.decision, "accepted");
  assert.equal(repository.getShortTermMemory(memory.memoryDataId)?.consolidationStatus, "evaluating");
  assert.equal(repository.dreamingCandidateDecisions.length, 1);
});

test("dreaming candidate gate rejects owner and permission failures without calling LLM", () => {
  const memory = createMemory({
    memoryDataId: "stm-gate-rejected",
    tenantId: "other-tenant",
    accessState: "permission-invalid"
  });
  const decision = evaluateDreamingCandidate(memory, [], {
    tenantId: "tenant-1",
    principalId: "user-1",
    now: "2026-07-30T00:00:00.000Z",
    runId: "run-1",
    policyVersion: "dreaming-gate.v1"
  });

  assert.equal(decision.decision, "drop");
  assert.deepEqual(decision.reasonCodes, ["OWNER_MISMATCH", "ACCESS_HIDDEN"]);
});

test("dreaming candidate gate observes an STM until its next evaluation time", () => {
  const memory = createMemory({
    memoryDataId: "stm-gate-observe",
    consolidationStatus: "observing",
    nextEvaluateAt: "2026-07-31T00:00:00.000Z"
  });
  const decision = evaluateDreamingCandidate(memory, [], {
    tenantId: "tenant-1",
    principalId: "user-1",
    now: "2026-07-30T00:00:00.000Z",
    runId: "run-1",
    policyVersion: "dreaming-gate.v1"
  });

  assert.equal(decision.decision, "observe");
  assert.deepEqual(decision.reasonCodes, ["NOT_DUE_FOR_REEVALUATION"]);
  assert.equal(decision.nextEvaluateAt, "2026-07-31T00:00:00.000Z");
});

test("observing STM can be reevaluated after nextEvaluateAt without changed input", () => {
  const memory = createMemory({
    consolidationStatus: "observing",
    nextEvaluateAt: "2026-07-29T00:00:00.000Z"
  });
  const unchanged = evaluateDreamingCandidate(memory, [], {
    tenantId: "tenant-1",
    principalId: "user-1",
    now: "2026-07-30T00:00:00.000Z",
    runId: "run-unchanged",
    policyVersion: "dreaming-gate.v1"
  });
  const changed = evaluateDreamingCandidate({ ...memory, reevaluationReason: "user_confirmation" }, [], {
    tenantId: "tenant-1",
    principalId: "user-1",
    now: "2026-07-30T00:00:00.000Z",
    runId: "run-changed",
    policyVersion: "dreaming-gate.v1"
  });

  assert.equal(unchanged.decision, "accepted");
  assert.deepEqual(unchanged.reasonCodes, []);
  assert.equal(changed.decision, "accepted");
});

test("terminal STM is skipped for the same policy and can be reconsidered by a new policy", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = createMemory({
    consolidationStatus: "dropped",
    dreamingPolicyVersion: "dreaming-gate.v1"
  });
  await repository.saveShortTermMemory(memory);
  await repository.saveFactItem(createFact());

  const samePolicy = await gateDreamingCandidates(repository, {
    memoryDataIds: [memory.memoryDataId],
    now: "2026-07-30T00:00:00.000Z",
    policyVersion: "dreaming-gate.v1"
  });
  assert.equal(samePolicy.accepted.length, 0);
  assert.equal(samePolicy.decisions.length, 0);
  assert.equal(repository.getShortTermMemory(memory.memoryDataId)?.consolidationStatus, "dropped");

  const newPolicy = await gateDreamingCandidates(repository, {
    memoryDataIds: [memory.memoryDataId],
    now: "2026-07-30T00:01:00.000Z",
    policyVersion: "dreaming-gate.v2"
  });
  assert.equal(newPolicy.accepted.length, 1);
  assert.equal(newPolicy.decisions[0]?.decision, "accepted");
});

function createMemory(overrides: Partial<ShortTermMemory> = {}): ShortTermMemory {
  return {
    memoryDataId: "stm-gate-default",
    tenantId: "tenant-1",
    principalId: "user-1",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    memoryDataType: "fact",
    content: "用户正在推进一个项目。",
    sourceFactIds: ["fact-1"],
    sourceRefs: [{ sourceRefId: "source-1", sourceType: "file", sourceId: "file-1" }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "test",
    matchedRules: [],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "medium",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible",
    ...overrides
  };
}

function createFact(): FactItem {
  return {
    factId: "fact-1",
    factType: "fact",
    factText: "用户正在推进一个项目。",
    normalizedClaim: "用户推进项目",
    linkedEventIds: [],
    linkedSegmentIds: [],
    linkedSourceRefs: [{ sourceRefId: "source-1", sourceType: "file", sourceId: "file-1" }],
    entityIds: [],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2026-07-29T00:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact.v1"
  };
}
