import assert from "node:assert/strict";
import test from "node:test";
import { missingConversationQuantitativeFacts } from "./quantitative-fact-coverage.js";

test("reports every source numeric value omitted from extracted facts", () => {
  const missing = missingConversationQuantitativeFacts([{
    messageId: "message_feed",
    content: "I bought 50 pounds of layer feed and 20 pounds of organic scratch grains."
  }], [{
    sourceMessageIds: ["message_feed"],
    factText: "The user bought 50 pounds of layer feed.",
    normalizedClaim: "User bought 50 pounds of layer feed",
    validTimeStart: null,
    validTimeEnd: null
  }]);

  assert.deepEqual(missing, [{ messageId: "message_feed", missingTokens: ["20"] }]);
});

test("accepts normalized date components in valid time fields", () => {
  const missing = missingConversationQuantitativeFacts([{
    messageId: "message_party",
    content: "The gift arrived on 4/20 before the party on 4/22."
  }], [
    {
      sourceMessageIds: ["message_party"],
      factText: "The gift arrived on April 20.",
      normalizedClaim: "Gift arrived on April 20",
      validTimeStart: "2022-04-20T00:00:00.000Z",
      validTimeEnd: null
    },
    {
      sourceMessageIds: ["message_party"],
      factText: "The party occurred on April 22.",
      normalizedClaim: "Party occurred on April 22",
      validTimeStart: "2022-04-22T00:00:00.000Z",
      validTimeEnd: null
    }
  ]);

  assert.deepEqual(missing, []);
});
