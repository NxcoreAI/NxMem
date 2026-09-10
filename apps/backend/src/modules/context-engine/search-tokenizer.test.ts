import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeSearchDocument, tokenizeSearchText } from "./search-tokenizer.js";

test("multilingual tokenizer keeps Chinese words instead of individual characters", () => {
  assert.deepEqual(tokenizeSearchText("深圳出差安排"), ["深圳", "出差", "安排"]);
});

test("query tokens are normalized and deduplicated while document frequency is preserved", () => {
  assert.deepEqual(tokenizeSearchText("Gift gift 深圳"), ["gift", "深圳"]);
  assert.deepEqual(tokenizeSearchDocument("Gift gift 深圳"), ["gift", "gift", "深圳"]);
});
