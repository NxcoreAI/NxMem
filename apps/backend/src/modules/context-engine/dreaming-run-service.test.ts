import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DreamingRunCandidate, ShortTermMemory } from "./domain.js";
import {
  DreamingRunService,
  localDateAt,
  localDateTimeAtUtc,
  latestScheduledCutoffAt,
  nextScheduledCutoffAt
} from "./dreaming-run-service.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";

test("Beijing scheduled time resolves to the local 23:00 cutoff", () => {
  assert.equal(localDateAt("2026-08-05T15:00:00.000Z"), "2026-08-05");
  assert.equal(localDateTimeAtUtc("2026-08-05", 23, 0), "2026-08-05T15:00:00.000Z");
  assert.equal(latestScheduledCutoffAt("2026-08-05T14:59:59.999Z"), "2026-08-04T15:00:00.000Z");
  assert.equal(latestScheduledCutoffAt("2026-08-05T15:00:00.000Z"), "2026-08-05T15:00:00.000Z");
  assert.equal(nextScheduledCutoffAt("2026-08-05T15:00:00.000Z"), "2026-08-06T15:00:00.000Z");
});

test("startup materialization creates every missed 23:00 cutoff in order", async () => {
  const repository = new InMemoryContextEngineRepository();
  const service = createService(repository);
  await service.createScheduledRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    scheduledAt: "2026-08-05T15:00:00.000Z"
  });

  const results = await service.materializeScheduledRuns({
    tenantId: "tenant-a",
    principalId: "user-a",
    throughAt: "2026-08-08T15:30:00.000Z"
  });

  assert.deepEqual(
    results.filter((result) => result.created).map((result) => result.run.candidateCutoffAt),
    [
      "2026-08-06T15:00:00.000Z",
      "2026-08-07T15:00:00.000Z",
      "2026-08-08T15:00:00.000Z"
    ]
  );
});

test("manual creation first materializes the latest missing automatic cutoff", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-before-auto", {
    createdAt: "2026-08-05T14:59:59.999Z",
    updatedAt: "2026-08-05T14:59:59.999Z"
  }));
  await repository.saveShortTermMemory(createStm("stm-after-auto", {
    createdAt: "2026-08-05T15:00:00.000Z",
    updatedAt: "2026-08-05T15:00:00.000Z"
  }));
  const service = createService(repository);

  const manual = await service.createManualRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    requestedAt: "2026-08-05T15:00:01.000Z"
  });
  const runs = repository.listDreamingRuns({ tenantId: "tenant-a", principalId: "user-a" });

  assert.deepEqual(runs.map((run) => [run.triggerType, run.candidateCutoffAt]), [
    ["scheduled", "2026-08-05T15:00:00.000Z"],
    ["manual", "2026-08-05T15:00:01.000Z"]
  ]);
  assert.deepEqual(repository.listDreamingRunCandidates(runs[0]!.runId).map((item) => item.memoryDataId), ["stm-before-auto"]);
  assert.deepEqual(manual.candidates.map((item) => item.memoryDataId), ["stm-after-auto"]);
});

test("scheduled Run snapshots the half-open STM window and due reevaluations", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-before-cutoff", {
    createdAt: "2026-08-05T14:59:59.999Z",
    updatedAt: "2026-08-05T14:59:59.999Z"
  }));
  await repository.saveShortTermMemory(createStm("stm-at-cutoff", {
    createdAt: "2026-08-05T15:00:00.000Z",
    updatedAt: "2026-08-05T15:00:00.000Z"
  }));
  await repository.saveShortTermMemory(createStm("stm-observing-due", {
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    consolidationStatus: "observing",
    nextEvaluateAt: "2026-08-05T15:00:00.000Z"
  }));
  await repository.saveShortTermMemory(createStm("stm-retry-future", {
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    consolidationStatus: "retry_wait",
    nextEvaluateAt: "2026-08-06T15:00:00.000Z"
  }));

  const service = createService(repository);
  const result = await service.createScheduledRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    scheduledAt: "2026-08-05T15:00:00.000Z"
  });

  assert.equal(result.created, true);
  assert.equal(result.run.candidateWindowStartAt, "1970-01-01T00:00:00.000Z");
  assert.equal(result.run.candidateCutoffAt, "2026-08-05T15:00:00.000Z");
  assert.equal(result.run.scheduleKey, "2026-08-05T23:00:00+08:00");
  assert.deepEqual(
    result.candidates.map((candidate) => [candidate.memoryDataId, candidate.sourceType]),
    [
      ["stm-observing-due", "observing_due"],
      ["stm-before-cutoff", "new"]
    ]
  );
  assert.equal(result.run.candidateCount, 2);
});

test("scheduled Run creation is idempotent under concurrent requests", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-concurrent"));
  const firstService = createService(repository);
  const secondService = createService(repository);

  const [first, second] = await Promise.all([
    firstService.createScheduledRun({
      tenantId: "tenant-a",
      principalId: "user-a",
      scheduledAt: "2026-08-05T15:00:00.000Z"
    }),
    secondService.createScheduledRun({
      tenantId: "tenant-a",
      principalId: "user-a",
      scheduledAt: "2026-08-05T15:00:00.000Z"
    })
  ]);

  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  assert.equal(first.run.runId, second.run.runId);
  assert.equal(repository.listDreamingRuns({ tenantId: "tenant-a", principalId: "user-a" }).length, 1);
});

test("a new Dreaming policy reevaluates retained terminal STM exactly once", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-old-policy-terminal", {
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    consolidationStatus: "consolidated",
    dreamingPolicyVersion: "dreaming-policy-old"
  }));

  const newPolicy = new DreamingRunService(repository, {
    policyVersion: "dreaming-policy-new",
    promptVersion: "dreaming-prompt-test",
    model: "dreaming-model-test"
  });
  const first = await newPolicy.createScheduledRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    scheduledAt: "2026-08-05T15:00:00.000Z"
  });
  assert.deepEqual(first.candidates.map((candidate) => candidate.memoryDataId), ["stm-old-policy-terminal"]);

  await repository.replaceShortTermMemory({
    ...repository.getShortTermMemory("stm-old-policy-terminal")!,
    dreamingPolicyVersion: "dreaming-policy-new"
  });
  const second = await newPolicy.createScheduledRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    scheduledAt: "2026-08-06T15:00:00.000Z"
  });
  assert.equal(second.candidates.length, 0);
});

test("manual Run advances from the last cutoff, merges due STM, and skips earlier active assignments", async () => {
  const repository = new InMemoryContextEngineRepository();
  const old = createStm("stm-assigned-old", {
    createdAt: "2026-08-05T14:00:00.000Z",
    updatedAt: "2026-08-05T14:00:00.000Z"
  });
  await repository.saveShortTermMemory(old);
  const service = createService(repository);
  const scheduled = await service.createScheduledRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    scheduledAt: "2026-08-05T15:00:00.000Z"
  });
  assert.equal(scheduled.candidates.length, 1);

  await repository.replaceShortTermMemory({
    ...old,
    consolidationStatus: "observing",
    nextEvaluateAt: "2026-08-05T16:00:00.000Z",
    updatedAt: "2026-08-05T16:00:00.000Z"
  });
  await repository.saveShortTermMemory(createStm("stm-manual-new", {
    createdAt: "2026-08-05T16:30:00.000Z",
    updatedAt: "2026-08-05T16:30:00.000Z"
  }));
  await repository.saveShortTermMemory(createStm("stm-manual-retry", {
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    consolidationStatus: "retry_wait",
    nextEvaluateAt: "2026-08-05T16:45:00.000Z",
    cycleAttemptCount: 3,
    totalAttemptCount: 5
  }));

  const manual = await service.createManualRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    requestedAt: "2026-08-05T17:00:00.000Z"
  });
  assert.equal(manual.run.candidateWindowStartAt, scheduled.run.candidateCutoffAt);
  assert.equal(manual.run.candidateCutoffAt, "2026-08-05T17:00:00.000Z");
  assert.deepEqual(
    manual.candidates.map((candidate) => [candidate.memoryDataId, candidate.sourceType]),
    [
      ["stm-manual-retry", "retry_due"],
      ["stm-manual-new", "new"]
    ]
  );
  assert.equal(manual.candidates[0]?.cycleAttemptCount, 0);
  assert.equal(manual.candidates[0]?.totalAttemptCount, 5);

  const replay = await service.createManualRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    requestedAt: "2026-08-05T17:00:00.000Z"
  });
  assert.equal(replay.created, false);
  assert.equal(replay.run.runId, manual.run.runId);
});

test("a new Run carries over unfinished candidates from a cancelled Run", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-carryover"));
  const service = createService(repository);
  const first = await service.createScheduledRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    scheduledAt: "2026-08-05T15:00:00.000Z"
  });
  await repository.saveDreamingRun({
    ...first.run,
    status: "cancelled",
    updatedAt: "2026-08-05T15:30:00.000Z"
  });

  const next = await service.createManualRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    requestedAt: "2026-08-05T17:00:00.000Z"
  });
  assert.deepEqual(
    next.candidates.map((candidate) => [candidate.memoryDataId, candidate.sourceType]),
    [["stm-carryover", "carryover"]]
  );
});

test("Run and candidate creation roll back together", async () => {
  class FailingRepository extends InMemoryContextEngineRepository {
    override async saveDreamingRunCandidate(candidate: DreamingRunCandidate) {
      await super.saveDreamingRunCandidate(candidate);
      throw new Error("forced_candidate_failure");
    }
  }
  const repository = new FailingRepository();
  await repository.saveShortTermMemory(createStm("stm-rollback"));
  const service = createService(repository);

  await assert.rejects(
    service.createScheduledRun({
      tenantId: "tenant-a",
      principalId: "user-a",
      scheduledAt: "2026-08-05T15:00:00.000Z"
    }),
    /forced_candidate_failure/
  );
  assert.equal(repository.dreamingRuns.length, 0);
  assert.equal(repository.dreamingRunCandidates.length, 0);
});

test("SQLite restart continues the owner window from the persisted cutoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dreaming-run-service-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    await writer.saveShortTermMemory(createStm("stm-first", {
      createdAt: "2026-08-05T14:00:00.000Z",
      updatedAt: "2026-08-05T14:00:00.000Z"
    }));
    const firstService = createService(writer);
    const first = await firstService.createScheduledRun({
      tenantId: "tenant-a",
      principalId: "user-a",
      scheduledAt: "2026-08-05T15:00:00.000Z"
    });
    await writer.saveShortTermMemory(createStm("stm-after-cutoff", {
      createdAt: "2026-08-05T16:00:00.000Z",
      updatedAt: "2026-08-05T16:00:00.000Z"
    }));
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath);
    const secondService = createService(reader);
    const second = await secondService.createManualRun({
      tenantId: "tenant-a",
      principalId: "user-a",
      requestedAt: "2026-08-05T17:00:00.000Z"
    });
    assert.equal(second.run.candidateWindowStartAt, first.run.candidateCutoffAt);
    assert.deepEqual(second.candidates.map((candidate) => candidate.memoryDataId), ["stm-after-cutoff"]);
    reader.close();

    const reopened = new SqliteContextEngineRepository(storePath);
    assert.equal(reopened.getDreamingRun(second.run.runId)?.candidateCount, 1);
    assert.deepEqual(
      reopened.listDreamingRunCandidates(second.run.runId).map((candidate) => candidate.memoryDataId),
      ["stm-after-cutoff"]
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Run cutoff cannot move behind an already persisted owner cutoff", async () => {
  const repository = new InMemoryContextEngineRepository();
  const service = createService(repository);
  await service.createManualRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    requestedAt: "2026-08-05T17:00:00.000Z"
  });
  await assert.rejects(
    service.createManualRun({
      tenantId: "tenant-a",
      principalId: "user-a",
      requestedAt: "2026-08-05T16:00:00.000Z"
    }),
    /DREAMING_RUN_CUTOFF_NOT_MONOTONIC/
  );
});

function createService(repository: InMemoryContextEngineRepository) {
  return new DreamingRunService(repository, {
    policyVersion: "dreaming-policy-test",
    promptVersion: "dreaming-prompt-test",
    model: "dreaming-model-test"
  });
}

function createStm(memoryDataId: string, overrides: Partial<ShortTermMemory> = {}): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "tenant-a",
    principalId: "user-a",
    createdAt: "2026-08-05T14:00:00.000Z",
    updatedAt: "2026-08-05T14:00:00.000Z",
    memoryDataType: "conversation_fact",
    memoryType: "fact",
    content: `STM ${memoryDataId}`,
    sourceFactIds: [`fact-${memoryDataId}`],
    sourceRefs: [{ sourceRefId: `source-${memoryDataId}`, sourceType: "conversation", sourceId: memoryDataId }],
    entityIds: [],
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_short_term",
    admissionReason: "test",
    matchedRules: ["test"],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "high",
      conflict: "none",
      permission: "private"
    },
    lifecycleStatus: "active",
    accessState: "visible",
    consolidationStatus: "unseen",
    ...overrides
  };
}
