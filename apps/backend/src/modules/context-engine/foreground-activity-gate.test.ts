import assert from "node:assert/strict";
import test from "node:test";
import { ForegroundActivityGate } from "./foreground-activity-gate.js";

test("foreground leases preempt once and resume only after every lease and idle debounce", async () => {
  const events: string[] = [];
  const owner = { tenantId: "tenant-a", principalId: "user-a" };
  const gate = new ForegroundActivityGate({
    resumeIdleAfterMs: 10,
    onBecameActive: () => { events.push("active"); },
    onBecameIdle: () => { events.push("idle"); }
  });

  const releaseFirst = await gate.acquire(owner);
  const releaseSecond = await gate.acquire(owner);
  assert.deepEqual(events, ["active"]);
  assert.equal(gate.isActive(owner), true);

  releaseFirst();
  await delay(15);
  assert.deepEqual(events, ["active"]);
  releaseSecond();
  await delay(5);
  const releaseThird = await gate.acquire(owner);
  await delay(15);
  assert.deepEqual(events, ["active", "active"]);
  releaseThird();
  await delay(15);

  assert.deepEqual(events, ["active", "active", "idle"]);
  assert.equal(gate.isActive(owner), false);
  gate.stop();
});

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
