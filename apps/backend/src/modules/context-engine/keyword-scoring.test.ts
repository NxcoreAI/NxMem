import test from "node:test";
import assert from "node:assert/strict";
import { buildKeywordCorpusStats, scoreKeywordMatch } from "./keyword-scoring.js";

test("keyword score distinguishes partial from complete coverage", () => {
  const tokens = ["father", "gift"];
  const stats = buildKeywordCorpusStats([
    "her father sent a gift",
    "her sister sent a gift"
  ], tokens);

  const complete = scoreKeywordMatch("her father sent a gift", tokens, stats);
  const partial = scoreKeywordMatch("her sister sent a gift", tokens, stats);

  assert.equal(complete.score, 0.7);
  assert.ok(partial.score > 0);
  assert.ok(partial.score < complete.score);
});

test("keyword score gives rare exact terms more weight", () => {
  const tokens = ["common", "rare"];
  const stats = buildKeywordCorpusStats([
    "common rare",
    "common value",
    "common value"
  ], tokens);

  const rare = scoreKeywordMatch("rare", tokens, stats);
  const common = scoreKeywordMatch("common", tokens, stats);

  assert.ok(rare.weightedCoverage > common.weightedCoverage);
  assert.ok(rare.score > common.score);
});

test("similar coverage supplements but does not duplicate exact coverage", () => {
  const inflection = scoreKeywordMatch("she purchased flowers", ["purchase"]);
  const synonym = scoreKeywordMatch("dad sent flowers", ["father"]);
  const exact = scoreKeywordMatch("father sent flowers", ["father"]);

  assert.equal(inflection.weightedCoverage, 0);
  assert.equal(inflection.similarCoverage, 1);
  assert.equal(inflection.score, 0.3);
  assert.equal(synonym.score, 0.3);
  assert.equal(exact.weightedCoverage, 1);
  assert.equal(exact.similarCoverage, 0);
  assert.equal(exact.score, 0.7);
});

test("exact lexical matching avoids substring false positives", () => {
  assert.equal(scoreKeywordMatch("a vacation memory", ["cat"]).score, 0);
});
