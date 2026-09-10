import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  maintainFixedBackground,
  mergeBackgroundStmRanges
} from "./background-maintainer.js";
import type { BackgroundMemoryCandidate } from "./background-stm-selector.js";
import {
  createEmptyBackgroundSections,
  renderBackgroundMarkdown,
  type BackgroundSections
} from "./background-markdown.js";
import type {
  BackgroundAnalysisOutput,
  BackgroundContextDocument,
  ShortTermMemory
} from "./domain.js";
import {
  analyzeBackground,
  estimateBackgroundAnalyzerInputTokens,
  type AnalyzeBackgroundMemoriesInput,
  type BackgroundAnalyzerLlmOptions,
  type BackgroundAnalyzerRunResult
} from "./llm-background-analyzer.js";
import {
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";

const SCHEDULED_AT = "2026-07-21T12:00:00.000Z";
const NOW = "2026-07-21T13:00:00.000Z";

test("fixed maintenance returns unchanged without STM or an LLM call", async () => {
  const repository = new InMemoryContextEngineRepository();
  let analyzerCalls = 0;

  const result = await maintainFixedBackground(repository, request("empty-run"), {
    now: () => NOW,
    analyzer: fakeAnalyzer(async () => {
      analyzerCalls += 1;
      throw new Error("LLM must not be called");
    })
  });

  assert.equal(result.status, "unchanged");
  assert.equal(result.fixedRevision, 0);
  assert.equal(result.scannedPageCount, 1);
  assert.equal(analyzerCalls, 0);
  assert.equal(repository.getLatestBackgroundDocument("tenant-a", "user-a"), undefined);
  assert.equal(repository.getBackgroundMaintenanceTask("tenant-a", "user-a", "empty-run")?.status, "succeeded");
});

test("fixed maintenance scans every page but sends all candidates in one LLM request", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-a", "2026-07-21T10:00:00.000Z"));
  await repository.saveShortTermMemory(createStm("stm-b", "2026-07-21T11:00:00.000Z"));
  let analyzerCalls = 0;

  const result = await maintainFixedBackground(repository, {
    ...request("single-run"),
    stmPageSize: 1
  }, {
    now: () => NOW,
    analyzer: fakeAnalyzer(async (input) => {
      analyzerCalls += 1;
      assert.deepEqual(input.memories.map((memory) => memory.memoryDataId), ["stm-a", "stm-b"]);
      return resultFor(input, "single_request");
    })
  });

  assert.equal(analyzerCalls, 1);
  assert.equal(result.scannedPageCount, 2);
  assert.equal(result.llmAnalysisCallCount, 1);
  assert.equal(result.fixedRevision, 1);
  assert.equal(result.status, "updated");
  assert.deepEqual(result.processedMemoryIds, ["stm-a", "stm-b"]);
  const background = repository.getLatestBackgroundDocument("tenant-a", "user-a");
  assert.deepEqual(background?.fixedWatermark, {
    updatedAt: "2026-07-21T11:00:00.000Z",
    memoryDataId: "stm-b"
  });
  assert.equal(background?.fixedRevision, 1);
});

test("an all-ignore result advances watermark and revision, then duplicate runId reuses the result", async () => {
  const repository = new InMemoryContextEngineRepository();
  const background = createBackground();
  await repository.saveBackgroundDocument(background);
  await repository.saveShortTermMemory(createStm("stm-ignore", "2026-07-21T10:00:00.000Z"));
  let analyzerCalls = 0;
  const analyzer = fakeAnalyzer(async (input) => {
    analyzerCalls += 1;
    return resultFor(input, "single_request", input.memories.map((memory) => memory.memoryDataId));
  });

  const first = await maintainFixedBackground(repository, request("ignore-run"), {
    now: () => NOW,
    analyzer
  });
  const second = await maintainFixedBackground(repository, request("ignore-run"), {
    now: () => NOW,
    analyzer
  });

  assert.equal(analyzerCalls, 1);
  assert.deepEqual(second, first);
  assert.equal(first.fixedText, background.fixedText);
  assert.equal(first.fixedRevision, 2);
  assert.notEqual(first.backgroundId, background.backgroundId);
  assert.equal(first.status, "updated");
  assert.deepEqual(first.ignoredMemoryIds, ["stm-ignore"]);
  assert.deepEqual(repository.getLatestBackgroundDocument("tenant-a", "user-a")?.fixedWatermark, {
    updatedAt: "2026-07-21T10:00:00.000Z",
    memoryDataId: "stm-ignore"
  });
  assert.equal(repository.getDebugSnapshot().backgroundDocuments.length, 2);
});

test("a concurrent revision change is not overwritten and schedules the task for retry", async () => {
  const repository = new InMemoryContextEngineRepository();
  const base = createBackground();
  await repository.saveBackgroundDocument(base);
  await repository.saveShortTermMemory(createStm("stm-conflict", "2026-07-21T10:00:00.000Z"));

  await assert.rejects(
    maintainFixedBackground(repository, request("revision-run"), {
      now: () => NOW,
      analyzer: fakeAnalyzer(async (input) => {
        await repository.saveBackgroundDocument({
          ...base,
          fixedText: fixedText({ recentTasks: "- 其他维护器已经提交。" }),
          fixedRevision: 2,
          fixedTextUpdatedAt: "2026-07-21T12:30:00.000Z",
          updatedAt: "2026-07-21T12:30:00.000Z"
        });
        return resultFor(input, "single_request");
      })
    }),
    /REVISION_CONFLICT:1:2/
  );

  const latest = repository.getLatestBackgroundDocument("tenant-a", "user-a");
  assert.equal(latest?.fixedRevision, 2);
  assert.match(latest?.fixedText ?? "", /其他维护器已经提交/u);
  const task = repository.getBackgroundMaintenanceTask("tenant-a", "user-a", "revision-run");
  assert.equal(task?.status, "retry_scheduled");
  assert.equal(task?.claimedBy, undefined);
  assert.equal(task?.leaseExpiresAt, undefined);
});

test("an active owner lease rejects a second maintenance run", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-lease", "2026-07-21T10:00:00.000Z"));
  let releaseAnalyzer!: () => void;
  let signalStarted!: () => void;
  const analyzerGate = new Promise<void>((resolve) => { releaseAnalyzer = resolve; });
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const first = maintainFixedBackground(repository, request("lease-run-a"), {
    now: () => NOW,
    analyzer: fakeAnalyzer(async (input) => {
      signalStarted();
      await analyzerGate;
      return resultFor(input, "single_request");
    })
  });
  await started;

  await assert.rejects(
    maintainFixedBackground(repository, request("lease-run-b"), {
      now: () => NOW,
      analyzer: fakeAnalyzer(async (input) => resultFor(input, "single_request"))
    }),
    /BACKGROUND_MAINTENANCE_LEASE_UNAVAILABLE/
  );

  releaseAnalyzer();
  assert.equal((await first).status, "updated");
});

test("an expired worker cannot overwrite the task after another worker takes over", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm("stm-takeover", "2026-07-21T10:00:00.000Z"));
  let releaseFirst!: () => void;
  let signalFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
  const firstRun = maintainFixedBackground(repository, request("takeover-run"), {
    now: () => NOW,
    claimedBy: "worker-a",
    leaseDurationMs: 1_000,
    analyzer: fakeAnalyzer(async () => {
      signalFirstStarted();
      await firstGate;
      throw new Error("stale worker failed");
    })
  });
  const firstRejected = assert.rejects(firstRun, /stale worker failed/);
  await firstStarted;

  let releaseSecond!: () => void;
  let signalSecondStarted!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const secondStarted = new Promise<void>((resolve) => { signalSecondStarted = resolve; });
  const secondRun = maintainFixedBackground(repository, request("takeover-run"), {
    now: () => "2026-07-21T13:00:02.000Z",
    claimedBy: "worker-b",
    leaseDurationMs: 10_000,
    analyzer: fakeAnalyzer(async (input) => {
      signalSecondStarted();
      await secondGate;
      return resultFor(input, "single_request");
    })
  });
  await secondStarted;

  releaseFirst();
  await firstRejected;
  const takenOver = repository.getBackgroundMaintenanceTask("tenant-a", "user-a", "takeover-run");
  assert.equal(takenOver?.status, "running");
  assert.equal(takenOver?.claimedBy, "worker-b");

  releaseSecond();
  assert.equal((await secondRun).status, "updated");
});

test("single-request failure preserves the fixed document and watermark", async () => {
  const repository = new InMemoryContextEngineRepository();
  const background = createBackground();
  await repository.saveBackgroundDocument(background);
  await repository.saveShortTermMemory(createStm("stm-failure", "2026-07-21T10:00:00.000Z"));

  await assert.rejects(
    maintainFixedBackground(repository, request("failure-run"), {
      now: () => NOW,
      analyzer: fakeAnalyzer(async () => { throw new Error("temporary LLM failure"); })
    }),
    /temporary LLM failure/
  );

  assert.deepEqual(repository.getLatestBackgroundDocument("tenant-a", "user-a"), background);
  const task = repository.getBackgroundMaintenanceTask("tenant-a", "user-a", "failure-run");
  assert.equal(task?.status, "retry_scheduled");
  assert.equal(task?.checkpointCursor, undefined);
});

test("hierarchical retry reuses completed batches and resumes after the checkpoint", async () => {
  const repository = new InMemoryContextEngineRepository();
  const firstMemory = createStm("stm-batch-a", "2026-07-21T10:00:00.000Z", "甲".repeat(300));
  const secondMemory = createStm("stm-batch-b", "2026-07-21T11:00:00.000Z", "乙".repeat(300));
  await repository.saveShortTermMemory(firstMemory);
  await repository.saveShortTermMemory(secondMemory);
  const maxInputTokens = hierarchicalLimit([candidate(firstMemory), candidate(secondMemory)]);

  await assert.rejects(
    maintainFixedBackground(repository, { ...request("batch-run"), maxInputTokens }, {
      now: () => NOW,
      analyzer: fakeAnalyzer(async (input, analyzerOptions) => {
        assert.equal(analyzerOptions.forceHierarchical, true);
        await analyzerOptions.onBatchCompleted?.({
          batchIndex: 1,
          memories: [input.memories[0]!],
          output: outputFor(input.existingSections, ["stm-batch-a"]),
          estimatedTokens: 700
        });
        throw new Error("second batch failed");
      })
    }),
    /second batch failed/
  );

  const failedTask = repository.getBackgroundMaintenanceTask("tenant-a", "user-a", "batch-run");
  assert.equal(failedTask?.status, "retry_scheduled");
  assert.deepEqual(failedTask?.checkpointCursor, {
    updatedAt: "2026-07-21T10:00:00.000Z",
    memoryDataId: "stm-batch-a"
  });
  assert.equal(repository.getBackgroundMaintenanceBatches(failedTask!.taskId).length, 1);
  assert.equal(repository.getLatestBackgroundDocument("tenant-a", "user-a"), undefined);

  const retried = await maintainFixedBackground(repository, { ...request("batch-run"), maxInputTokens }, {
    now: () => NOW,
    analyzer: fakeAnalyzer(async (input, analyzerOptions) => {
      assert.deepEqual(input.memories.map((memory) => memory.memoryDataId), ["stm-batch-b"]);
      assert.equal(analyzerOptions.completedBatches?.length, 1);
      await analyzerOptions.onBatchCompleted?.({
        batchIndex: 2,
        memories: input.memories,
        output: outputFor(input.existingSections, ["stm-batch-b"]),
        estimatedTokens: 700
      });
      return resultFor(input, "hierarchical_batch", [], ["stm-batch-a", "stm-batch-b"], 2);
    })
  });

  assert.equal(retried.status, "updated");
  assert.equal(retried.executionStrategy, "hierarchical_batch");
  assert.deepEqual(retried.processedMemoryIds, ["stm-batch-a", "stm-batch-b"]);
  assert.equal(retried.llmAnalysisCallCount, 3);
  const succeededTask = repository.getBackgroundMaintenanceTask("tenant-a", "user-a", "batch-run");
  assert.equal(succeededTask?.status, "succeeded");
  assert.equal(repository.getBackgroundMaintenanceBatches(succeededTask!.taskId).length, 2);
});

test("an indivisible over-limit STM is persisted as a deferred cursor range", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveShortTermMemory(createStm(
    "stm-huge",
    "2026-07-21T10:00:00.000Z",
    "无法拆分的背景内容".repeat(500)
  ));
  let analyzerCalls = 0;

  const result = await maintainFixedBackground(repository, {
    ...request("deferred-run"),
    maxInputTokens: 1
  }, {
    now: () => NOW,
    analyzer: fakeAnalyzer(async () => {
      analyzerCalls += 1;
      throw new Error("LLM must not be called");
    })
  });

  assert.equal(analyzerCalls, 0);
  assert.equal(result.status, "degraded");
  assert.equal(result.fixedRevision, 0);
  assert.deepEqual(result.deferredMemoryIds, ["stm-huge"]);
  const task = repository.getBackgroundMaintenanceTask("tenant-a", "user-a", "deferred-run");
  assert.equal(task?.deferredRanges.length, 1);
  assert.deepEqual(task?.deferredRanges[0]?.throughInclusive, {
    updatedAt: "2026-07-21T10:00:00.000Z",
    memoryDataId: "stm-huge"
  });
  assert.equal(repository.getLatestBackgroundDocument("tenant-a", "user-a"), undefined);
});

test("deferred cursor ranges merge without double-counting retries", () => {
  const range = {
    afterExclusive: { updatedAt: "2026-07-21T09:00:00.000Z", memoryDataId: "stm-a" },
    throughInclusive: { updatedAt: "2026-07-21T10:00:00.000Z", memoryDataId: "stm-b" },
    estimatedCount: 2
  };
  assert.deepEqual(mergeBackgroundStmRanges([range, range]), [range]);
});

const sqliteFts5Available = hasSqliteFts5();

test("SQLite atomically persists the successful document/task pair and reloads it", {
  skip: sqliteFts5Available ? false : "Node SQLite does not provide fts5"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-maintainer-sqlite-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    await writer.saveShortTermMemory(createStm("stm-sqlite", "2026-07-21T10:00:00.000Z"));
    const result = await maintainFixedBackground(writer, request("sqlite-run"), {
      now: () => NOW,
      analyzer: fakeAnalyzer(async (input) => resultFor(input, "single_request"))
    });
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath);
    assert.equal(reader.getLatestBackgroundDocument("tenant-a", "user-a")?.fixedRevision, result.fixedRevision);
    const task = reader.getBackgroundMaintenanceTask("tenant-a", "user-a", "sqlite-run");
    assert.equal(task?.status, "succeeded");
    assert.deepEqual(task?.result, result);
    assert.equal(reader.getDebugSnapshot().backgroundMaintenanceTasks.length, 1);
    reader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function request(runId: string) {
  return {
    tenantId: "tenant-a",
    principalId: "user-a",
    runId,
    scheduledAt: SCHEDULED_AT
  };
}

function createBackground(): BackgroundContextDocument {
  const text = fixedText();
  return {
    backgroundId: "background-a",
    tenantId: "tenant-a",
    principalId: "user-a",
    fixedText: text,
    dynamicText: renderBackgroundMarkdown(createEmptyBackgroundSections("dynamic"), "dynamic"),
    fixedRevision: 1,
    fixedTextUpdatedAt: "2026-07-21T09:00:00.000Z",
    fixedWatermark: { updatedAt: "2026-07-21T09:00:00.000Z", memoryDataId: "stm-old" },
    dynamicWindowStart: "2026-07-21T09:00:00.000Z",
    dynamicWindowEnd: "2026-07-21T09:00:00.000Z",
    dynamicSourceMemoryIds: [],
    latestStmCursor: { updatedAt: "2026-07-21T09:00:00.000Z", memoryDataId: "stm-old" },
    sourceRefIds: [],
    conflictIds: [],
    createdAt: "2026-07-21T09:00:00.000Z",
    updatedAt: "2026-07-21T09:00:00.000Z"
  };
}

function fixedText(overrides: Partial<BackgroundSections> = {}) {
  return renderBackgroundMarkdown({
    identity: "- 用户是一名后端工程师。",
    relationships: "- 暂无已确认信息。",
    recentTasks: "- 正在实现 Context Engine。",
    aiSoul: "- 回答应简洁且给出依据。",
    ...overrides
  }, "fixed");
}

function createStm(memoryDataId: string, updatedAt: string, content = `用户正在推进 ${memoryDataId}。`): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "tenant-a",
    principalId: "user-a",
    createdAt: updatedAt,
    updatedAt,
    memoryDataType: "manual_memory_event",
    memoryType: "fact",
    content,
    sourceFactIds: [`fact-${memoryDataId}`],
    sourceRefs: [{ sourceRefId: `source-${memoryDataId}`, sourceType: "file", sourceId: memoryDataId }],
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
    accessState: "visible"
  };
}

function candidate(memory: ShortTermMemory): BackgroundMemoryCandidate {
  return {
    memoryDataId: memory.memoryDataId,
    content: memory.content,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    sourceRefs: memory.sourceRefs,
    confidenceLevel: memory.confidenceLevel,
    importanceLevel: memory.importanceLevel,
    lifecycleStatus: memory.lifecycleStatus
  };
}

function fakeAnalyzer(
  implementation: (
    input: AnalyzeBackgroundMemoriesInput,
    options: BackgroundAnalyzerLlmOptions
  ) => Promise<BackgroundAnalyzerRunResult>
): typeof analyzeBackground {
  return (async (input, options = {}) => implementation(input, options)) as typeof analyzeBackground;
}

function resultFor(
  input: AnalyzeBackgroundMemoriesInput,
  strategy: "single_request" | "hierarchical_batch",
  ignoredMemoryIds: string[] = [],
  sourceMemoryIds = input.memories
    .map((memory) => memory.memoryDataId)
    .filter((id) => !ignoredMemoryIds.includes(id)),
  llmCallCount = 1
): BackgroundAnalyzerRunResult {
  const output = outputFor(input.existingSections, sourceMemoryIds, ignoredMemoryIds);
  return {
    output,
    markdown: renderBackgroundMarkdown(Object.fromEntries(
      Object.entries(output.sections).map(([key, section]) => [key, section.text])
    ) as BackgroundSections, "fixed"),
    executionStrategy: strategy,
    estimatedInputTokens: 500,
    estimatedInputTokenUsage: llmCallCount * 500,
    llmCallCount,
    batchCount: strategy === "single_request" ? 1 : 2,
    calls: []
  };
}

function outputFor(
  existingSections: BackgroundSections,
  sourceMemoryIds: string[],
  ignoredMemoryIds: string[] = []
): BackgroundAnalysisOutput {
  const unchanged = (key: keyof BackgroundSections) => ({
    text: existingSections[key],
    sourceMemoryIds: [],
    confidence: "low" as const,
    changed: false
  });
  return {
    sections: {
      identity: unchanged("identity"),
      relationships: unchanged("relationships"),
      recentTasks: sourceMemoryIds.length
        ? {
            text: `- 正在推进 ${sourceMemoryIds.join("、")}。`,
            sourceMemoryIds,
            confidence: "high",
            changed: true
          }
        : unchanged("recentTasks"),
      aiSoul: unchanged("aiSoul")
    },
    ignoredMemoryIds,
    conflicts: [],
    summary: "测试分析完成。"
  };
}

function hierarchicalLimit(memories: BackgroundMemoryCandidate[]) {
  const existingSections = createEmptyBackgroundSections("fixed");
  const one = analyzerInput([memories[0]!], existingSections, "hierarchical_batch");
  const all = analyzerInput(memories, existingSections, "single_request");
  const oneTokens = estimateBackgroundAnalyzerInputTokens(one);
  const allTokens = estimateBackgroundAnalyzerInputTokens(all);
  assert.ok(allTokens > oneTokens);
  return Math.floor((oneTokens + allTokens) / 2);
}

function analyzerInput(
  memories: BackgroundMemoryCandidate[],
  existingSections: BackgroundSections,
  strategy: "single_request" | "hierarchical_batch"
) {
  return {
    mode: "fixed_maintenance" as const,
    existingSections,
    memories,
    windowStart: "1970-01-01T00:00:00.000Z",
    windowEnd: SCHEDULED_AT,
    execution: {
      strategy,
      memoryCount: memories.length,
      ...(strategy === "hierarchical_batch" ? { batchIndex: 1, isLastBatch: true } : {}),
      estimatedTokens: 0
    }
  };
}

function hasSqliteFts5() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE fts5_probe USING fts5(content)");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
