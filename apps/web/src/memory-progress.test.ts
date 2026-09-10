import test from "node:test";
import assert from "node:assert/strict";
import { buildManualStepProgress, buildProgressStages, translateMemoryProgressStage } from "./memory-progress.js";

test("buildProgressStages maps the ingestion flow to ordered stages", () => {
  const stages = buildProgressStages({
    event: { eventType: "solution_memory_flow_event" },
    dataLake: { parsedSegments: 2, facts: 1 },
    timelineAggregation: { aggregatedFacts: [{}, {}] },
    longTermMemory: { memoryId: "ltm_1" },
    shortTermMemory: { memoryDataId: "stm_1" }
  });

  assert.deepEqual(stages.map((stage) => stage.stage), [
    "event",
    "data_lake",
    "timeline_aggregation",
    "ltm",
    "stm"
  ]);
  assert.equal(stages.at(-1)?.percent, 100);
  assert.equal(stages[2]?.details, "2 条聚合事实");
});

test("translateMemoryProgressStage returns the expected label", () => {
  assert.equal(translateMemoryProgressStage("timeline_aggregation"), "时间轴聚合");
});

test("buildManualStepProgress reports STM completion at 100 percent", () => {
  const active = buildManualStepProgress("stm");
  assert.equal(active.current.stage, "stm");
  assert.equal(active.current.percent, 78);
  assert.equal(active.steps.find((step) => step.stage === "stm")?.status, "active");

  const completed = buildManualStepProgress("stm", true);
  assert.equal(completed.current.stage, "done");
  assert.equal(completed.current.percent, 100);
  assert.equal(completed.current.details, "STM 已写入并建立可召回索引");
  assert.equal(completed.steps.find((step) => step.stage === "stm")?.status, "complete");
});
