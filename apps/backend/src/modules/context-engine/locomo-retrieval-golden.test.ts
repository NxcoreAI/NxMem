import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const datasetSha256 = "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4";

const goldens = [
  {
    file: "locomo-fact-retrieval-first-50.json",
    storeFingerprint: "0132d727d6657233920111b339ef7b8433a28985810bccf7fdee6ce63d7c101e",
    dataset: { sampleCount: 10, caseCount: 50, evaluableCaseCount: 50, skippedCaseCount: 0, goldFactCount: 77 },
    metrics: [
      [1, 0.02, 0.02, 0.02],
      [5, 0.14, 0.06133333333333334, 0.08071130243223998],
      [8, 0.16666666666666669, 0.07133333333333333, 0.09381574864132983],
      [10, 0.18666666666666668, 0.07333333333333333, 0.0995970451676876],
      [20, 0.2333333333333333, 0.07668859649122807, 0.11785811231171434],
      [50, 0.31733333333333336, 0.0817808777753757, 0.14514253440994204],
      [100, 0.35233333333333333, 0.0817808777753757, 0.15269700056991328]
    ]
  },
  {
    file: "locomo-fact-retrieval-first-200-current.json",
    storeFingerprint: "b4415a0102ea7c7642f27c6396d5889cac5dff6819901392853855a61daf069c",
    dataset: { sampleCount: 10, caseCount: 200, evaluableCaseCount: 200, skippedCaseCount: 0, goldFactCount: 253 },
    metrics: [
      [1, 0.5741666666666666, 0.62, 0.62],
      [5, 0.7195833333333335, 0.6796666666666665, 0.6737930469141135],
      [10, 0.7764166666666665, 0.6878511904761905, 0.6948440024436886],
      [20, 0.8403333333333333, 0.6911073232323229, 0.7132208467811771],
      [50, 0.8849999999999999, 0.6919491172775273, 0.7232932685267689],
      [100, 0.9570833333333333, 0.6928326621663246, 0.736390123863944]
    ]
  }
] as const;

test("fixed LoCoMo retrieval reports retain dataset, store and metric goldens", async () => {
  const dataset = await readFile(resolve("../../data/locomo/locomo10.json"));
  assert.equal(createHash("sha256").update(dataset).digest("hex"), datasetSha256);

  for (const golden of goldens) {
    const raw = JSON.parse(await readFile(resolve("../../data/locomo/results", golden.file), "utf8"));
    const report = raw.report;
    assert.equal(report.schemaVersion, "locomo-fact-retrieval.v3");
    assert.deepEqual(report.dataset, golden.dataset);
    const storeIdentity = JSON.stringify({
      schemaVersion: report.schemaVersion,
      retrieval: report.retrieval,
      selection: report.selection,
      store: report.store
    });
    assert.equal(createHash("sha256").update(storeIdentity).digest("hex"), golden.storeFingerprint);
    assert.deepEqual(
      report.metrics.all.map((metric: Record<string, number>) => [metric.k, metric.recallAtK, metric.mrrAtK, metric.ndcgAtK]),
      golden.metrics
    );
  }
});
