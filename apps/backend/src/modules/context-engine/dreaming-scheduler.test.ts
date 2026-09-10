import assert from "node:assert/strict";
import test from "node:test";
import { DreamingRunService } from "./dreaming-run-service.js";
import { DreamingScheduler } from "./dreaming-scheduler.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("Scheduler materializes startup backfill and notifies Runtime to pump created Runs", async () => {
  const repository = new InMemoryContextEngineRepository();
  const runService = new DreamingRunService(repository, { now: () => "2026-08-08T15:30:00.000Z" });
  await runService.createScheduledRun({
    tenantId: "tenant-a",
    principalId: "user-a",
    scheduledAt: "2026-08-05T15:00:00.000Z"
  });
  let notificationCount = 0;
  const scheduler = new DreamingScheduler(runService, {
    now: () => "2026-08-08T15:30:00.000Z",
    listOwners: () => [{ tenantId: "tenant-a", principalId: "user-a" }],
    onRunsCreated: () => { notificationCount += 1; }
  });

  const created = await scheduler.tick();
  assert.deepEqual(created.map((result) => result.run.candidateCutoffAt), [
    "2026-08-06T15:00:00.000Z",
    "2026-08-07T15:00:00.000Z",
    "2026-08-08T15:00:00.000Z"
  ]);
  assert.equal(notificationCount, 1);
  scheduler.stop();
});
