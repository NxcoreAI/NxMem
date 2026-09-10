import test from "node:test";
import assert from "node:assert/strict";

function formatAuditPayload(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

test("formatAuditPayload stringifies object prompts", () => {
  const payload = {
    instruction: "follow schema",
    constraints: ["one", "two"]
  };

  assert.equal(formatAuditPayload(payload), JSON.stringify(payload, null, 2));
});

test("formatAuditPayload preserves strings", () => {
  assert.equal(formatAuditPayload("plain text"), "plain text");
});
