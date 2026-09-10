import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createEmptyBackgroundSections,
  renderBackgroundMarkdown,
  type BackgroundSections
} from "./background-markdown.js";
import { maintainFixedBackground } from "./background-maintainer.js";
import type {
  BackgroundAnalysisOutput,
  BackgroundContextDocument,
  ShortTermMemory
} from "./domain.js";
import {
  analyzeBackground,
  type AnalyzeBackgroundMemoriesInput,
  type BackgroundAnalyzerLlmOptions,
  type BackgroundAnalyzerRunResult
} from "./llm-background-analyzer.js";
import {
  FileBackedContextEngineRepository,
  InMemoryContextEngineRepository,
  SqliteContextEngineRepository
} from "./persistence/memory-repository.js";
import { createSessionBackground } from "./session-background.js";

const SESSION_AT = "2026-07-22T12:00:00.000Z";
const NOW = "2026-07-22T12:01:00.000Z";

test("session background returns an empty dynamic section without calling LLM when no STM is pending", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  let analyzerCalls = 0;

  const first = await createSessionBackground(repository, request("session-empty"), {
    now: () => NOW,
    analyzer: fakeAnalyzer(async () => {
      analyzerCalls += 1;
      throw new Error("LLM must not be called");
    })
  });
  const replay = await createSessionBackground(repository, request("session-empty"), {
    now: () => "2026-07-22T12:30:00.000Z",
    analyzer: fakeAnalyzer(async () => {
      analyzerCalls += 1;
      throw new Error("LLM must not be called");
    })
  });

  assert.equal(analyzerCalls, 0);
  assert.equal(first.status, "ready");
  assert.equal(first.pendingStmCount, 0);
  assert.equal(first.watermarkLagSeconds, 0);
  assert.equal(first.cacheHit, false);
  assert.equal(first.referenceTime, NOW);
  assert.equal(first.dynamicWindowEnd, NOW);
  assert.equal(first.timezone, "Asia/Shanghai");
  assert.equal(first.locale, "zh-CN");
  assert.equal(first.localDate, "2026-07-22");
  assert.match(first.dynamicText, /本时间窗口没有新增信息/u);
  assert.deepEqual(replay, first);
  assert.equal(repository.getDebugSnapshot().backgroundDynamicCaches.length, 1);
  assert.equal(repository.getDebugSnapshot().sessionBackgroundSnapshots.length, 1);
});

test("legacy callers use receive time and the configured timezone priority", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());

  const result = await createSessionBackground(repository, request("session-legacy-temporal"), {
    now: () => NOW,
    principalTimezone: "America/New_York",
    tenantTimezone: "Asia/Tokyo",
    defaultTimezone: "Europe/Berlin",
    defaultLocale: "en-GB"
  });

  assert.equal(result.referenceTime, NOW);
  assert.equal(result.dynamicWindowEnd, NOW);
  assert.equal(result.timezone, "America/New_York");
  assert.equal(result.locale, "en-GB");
  assert.equal(result.localDate, "2026-07-22");
  assert.notEqual(result.dynamicWindowEnd, SESSION_AT);
});

test("different sessions reuse dynamic cache until fixed revision or latest cursor changes", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  await repository.saveShortTermMemory(createStm("stm-a", "2026-07-22T10:00:00.000Z"));
  let analyzerCalls = 0;
  const analyzer = fakeAnalyzer(async (input) => {
    analyzerCalls += 1;
    return resultFor(input);
  });

  const first = await createSessionBackground(repository, request("session-a"), {
    now: () => NOW,
    analyzer
  });
  const cached = await createSessionBackground(repository, request("session-b"), {
    now: () => NOW,
    analyzer
  });

  assert.equal(analyzerCalls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.dynamicCacheKey, first.dynamicCacheKey);
  assert.equal(cached.dynamicText, first.dynamicText);
  assert.deepEqual(cached.citations, [{
    sourceRefId: "source-stm-a",
    memoryDataId: "stm-a",
    layer: "stm"
  }]);

  await repository.saveShortTermMemory(createStm("stm-b", "2026-07-22T11:00:00.000Z"));
  const advanced = await createSessionBackground(repository, request("session-c"), {
    now: () => NOW,
    analyzer
  });
  assert.equal(analyzerCalls, 2);
  assert.notEqual(advanced.dynamicCacheKey, first.dynamicCacheKey);
  assert.deepEqual(advanced.sourceMemoryIds, ["stm-a", "stm-b"]);

  const revisionTwo = {
    ...createBackground(),
    backgroundId: "background-r2",
    fixedRevision: 2,
    fixedTextUpdatedAt: "2026-07-22T11:30:00.000Z",
    fixedWatermark: { updatedAt: "2026-07-22T11:00:00.000Z", memoryDataId: "stm-b" },
    latestStmCursor: { updatedAt: "2026-07-22T11:00:00.000Z", memoryDataId: "stm-b" },
    createdAt: "2026-07-22T11:30:00.000Z",
    updatedAt: "2026-07-22T11:30:00.000Z"
  } satisfies BackgroundContextDocument;
  await repository.saveBackgroundDocument(revisionTwo);
  const revised = await createSessionBackground(repository, request("session-d"), {
    now: () => NOW,
    analyzer
  });
  assert.equal(analyzerCalls, 2);
  assert.equal(revised.fixedRevision, 2);
  assert.notEqual(revised.dynamicCacheKey, advanced.dynamicCacheKey);
});

test("the same session refreshes when the latest STM cursor advances", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  await repository.saveShortTermMemory(createStm("stm-same-session-a", "2026-07-22T10:00:00.000Z"));
  let analyzerCalls = 0;
  const analyzer = fakeAnalyzer(async (input) => {
    analyzerCalls += 1;
    return resultFor(input);
  });

  const first = await createSessionBackground(repository, request("session-watermark"), {
    now: () => NOW,
    analyzer
  });
  await repository.saveShortTermMemory(createStm("stm-same-session-b", "2026-07-22T11:00:00.000Z"));
  const advanced = await createSessionBackground(repository, request("session-watermark"), {
    now: () => NOW,
    analyzer
  });

  assert.equal(analyzerCalls, 2);
  assert.notEqual(advanced.snapshotId, first.snapshotId);
  assert.notEqual(advanced.dynamicCacheKey, first.dynamicCacheKey);
  assert.deepEqual(advanced.sourceMemoryIds, ["stm-same-session-a", "stm-same-session-b"]);
  assert.equal(repository.getDebugSnapshot().sessionBackgroundSnapshots.length, 2);
});

test("the same session refreshes after crossing midnight in its temporal timezone", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  let analyzerCalls = 0;
  const analyzer = fakeAnalyzer(async () => {
    analyzerCalls += 1;
    throw new Error("LLM must not be called");
  });

  const first = await createSessionBackground(repository, {
    ...request("session-midnight"),
    referenceTime: "2026-07-22T15:59:59.000Z",
    timezone: "Asia/Shanghai",
    locale: "zh-CN"
  }, { now: () => NOW, analyzer });
  const nextDay = await createSessionBackground(repository, {
    ...request("session-midnight"),
    referenceTime: "2026-07-22T16:00:01.000Z",
    timezone: "Asia/Shanghai",
    locale: "zh-CN"
  }, { now: () => NOW, analyzer });

  assert.equal(analyzerCalls, 0);
  assert.equal(first.localDate, "2026-07-22");
  assert.equal(nextDay.localDate, "2026-07-23");
  assert.equal(nextDay.dynamicWindowEnd, "2026-07-22T16:00:01.000Z");
  assert.notEqual(nextDay.snapshotId, first.snapshotId);
  assert.notEqual(nextDay.dynamicCacheKey, first.dynamicCacheKey);
  assert.equal(repository.getDebugSnapshot().sessionBackgroundSnapshots.length, 2);
});

test("session background sends a legacy hidden candidate STM to the dynamic background analyzer", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  await repository.saveShortTermMemory({
    ...createStm("stm-consolidated", "2026-07-22T10:00:00.000Z"),
    admissionResult: "write_candidate",
    lifecycleStatus: "consolidated",
    accessState: "hidden"
  });

  const result = await createSessionBackground(repository, request("session-consolidated"), {
    now: () => NOW,
    analyzer: fakeAnalyzer(async (input) => {
      assert.deepEqual(input.memories.map((memory) => memory.memoryDataId), ["stm-consolidated"]);
      return resultFor(input);
    })
  });

  assert.equal(result.processedMemoryCount, 1);
  assert.match(result.dynamicCacheKey, /^dynamic-background:stm-generated-v3:/u);
  assert.deepEqual(result.sourceMemoryIds, ["stm-consolidated"]);
  assert.deepEqual(result.citations, [{
    sourceRefId: "source-stm-consolidated",
    memoryDataId: "stm-consolidated",
    layer: "stm"
  }]);
  assert.match(result.dynamicText, /stm-consolidated/u);
});

test("single-flight merges concurrent initialization for the same session and cache key", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  await repository.saveShortTermMemory(createStm("stm-flight", "2026-07-22T10:00:00.000Z"));
  let analyzerCalls = 0;
  let release!: () => void;
  let signalStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const analyzer = fakeAnalyzer(async (input) => {
    analyzerCalls += 1;
    signalStarted();
    await gate;
    return resultFor(input);
  });

  const first = createSessionBackground(repository, request("session-flight"), {
    now: () => NOW,
    analyzer
  });
  await started;
  const second = createSessionBackground(repository, request("session-flight"), {
    now: () => NOW,
    analyzer
  });
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(analyzerCalls, 1);
  assert.deepEqual(right, left);
  assert.equal(repository.getDebugSnapshot().backgroundDynamicCaches.length, 1);
  assert.equal(repository.getDebugSnapshot().sessionBackgroundSnapshots.length, 1);
});

test("forceRefresh bypasses the snapshot and cache while still creating a new snapshot", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  await repository.saveShortTermMemory(createStm("stm-refresh", "2026-07-22T10:00:00.000Z"));
  let analyzerCalls = 0;
  const analyzer = fakeAnalyzer(async (input) => {
    analyzerCalls += 1;
    return resultFor(input);
  });
  const first = await createSessionBackground(repository, request("session-refresh"), {
    now: () => NOW,
    analyzer
  });
  const refreshed = await createSessionBackground(repository, {
    ...request("session-refresh"),
    forceRefresh: true
  }, {
    now: () => NOW,
    analyzer
  });

  assert.equal(analyzerCalls, 2);
  assert.notEqual(refreshed.snapshotId, first.snapshotId);
  assert.equal(refreshed.dynamicCacheKey, first.dynamicCacheKey);
  assert.equal(refreshed.cacheHit, false);
  assert.equal(refreshed.referenceTime, NOW);
  assert.equal(refreshed.timezone, "Asia/Shanghai");
  assert.equal(repository.getDebugSnapshot().sessionBackgroundSnapshots.length, 2);
});

test("candidate overflow is degraded, persisted as deferred, and creates a fixed catch-up task", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  for (const [index, hour] of ["10", "10:10", "10:20"].entries()) {
    const timestamp = hour.includes(":")
      ? `2026-07-22T${hour}:00.000Z`
      : `2026-07-22T${hour}:00:00.000Z`;
    await repository.saveShortTermMemory(createStm(`stm-overflow-${index + 1}`, timestamp));
  }

  const result = await createSessionBackground(repository, {
    ...request("session-overflow"),
    maxDynamicCandidates: 2
  }, {
    now: () => NOW,
    analyzer: fakeAnalyzer(async (input) => {
      assert.deepEqual(input.memories.map((memory) => memory.memoryDataId), [
        "stm-overflow-1",
        "stm-overflow-2"
      ]);
      return resultFor(input);
    })
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.deferredMemoryCount, 1);
  assert.match(result.degradedModeReason ?? "", /DYNAMIC_CANDIDATE_LIMIT_EXCEEDED/u);
  const cache = repository.getBackgroundDynamicCache(result.dynamicCacheKey);
  assert.equal(cache?.deferredRanges.length, 1);
  assert.deepEqual(cache?.deferredRanges[0]?.throughInclusive, {
    updatedAt: "2026-07-22T10:20:00.000Z",
    memoryDataId: "stm-overflow-3"
  });
  const catchup = repository.getDebugSnapshot().backgroundMaintenanceTasks[0];
  assert.equal(catchup?.status, "queued");
  assert.match(catchup?.runId ?? "", /^background-catchup:/u);
  assert.equal(catchup?.deferredMemoryCount, 1);

  const caughtUp = await maintainFixedBackground(repository, {
    tenantId: "tenant-a",
    principalId: "user-a",
    runId: catchup!.runId,
    scheduledAt: catchup!.windowEnd
  }, {
    now: () => NOW,
    analyzer: fakeAnalyzer(async (input) => fixedResultFor(input))
  });
  assert.equal(caughtUp.status, "updated");
  assert.equal(caughtUp.deferredMemoryCount, 0);
  assert.equal(repository.getBackgroundMaintenanceTask("tenant-a", "user-a", catchup!.runId)?.deferredRanges.length, 0);
});

test("dynamic failure uses the previous cache as stale and degrades when no cache exists", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  await repository.saveShortTermMemory(createStm("stm-old", "2026-07-22T10:00:00.000Z"));
  const stable = await createSessionBackground(repository, request("session-stable"), {
    now: () => NOW,
    analyzer: fakeAnalyzer(async (input) => resultFor(input))
  });
  await repository.saveShortTermMemory(createStm("stm-new", "2026-07-22T11:00:00.000Z"));

  const stale = await createSessionBackground(repository, {
    ...request("session-stale"),
    referenceTime: "2026-07-23T03:00:00.000Z",
    timezone: "America/Los_Angeles",
    locale: "en-US"
  }, {
    now: () => NOW,
    analyzer: fakeAnalyzer(async () => { throw new Error("LLM unavailable"); })
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.cacheHit, true);
  assert.equal(stale.dynamicText, stable.dynamicText);
  assert.equal(stale.dynamicWindowEnd, "2026-07-23T03:00:00.000Z");
  assert.equal(stale.referenceTime, "2026-07-23T03:00:00.000Z");
  assert.equal(stale.timezone, "America/Los_Angeles");
  assert.equal(stale.locale, "en-US");
  assert.equal(stale.localDate, "2026-07-22");
  assert.match(stale.degradedModeReason ?? "", /DYNAMIC_BACKGROUND_STALE:LLM unavailable/u);

  const emptyRepository = new InMemoryContextEngineRepository();
  await emptyRepository.saveBackgroundDocument(createBackground());
  await emptyRepository.saveShortTermMemory(createStm("stm-failure", "2026-07-22T10:00:00.000Z"));
  const degraded = await createSessionBackground(emptyRepository, {
    ...request("session-degraded"),
    referenceTime: "2026-07-23T03:00:00.000Z",
    timezone: "Asia/Tokyo",
    locale: "ja-JP"
  }, {
    now: () => NOW,
    analyzer: fakeAnalyzer(async () => { throw new Error("LLM unavailable"); })
  });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.cacheHit, false);
  assert.equal(degraded.deferredMemoryCount, 1);
  assert.equal(degraded.dynamicWindowEnd, "2026-07-23T03:00:00.000Z");
  assert.equal(degraded.timezone, "Asia/Tokyo");
  assert.equal(degraded.locale, "ja-JP");
  assert.equal(degraded.localDate, "2026-07-23");
  assert.match(degraded.degradedModeReason ?? "", /DYNAMIC_ANALYSIS_FAILED:LLM unavailable/u);
  assert.equal(emptyRepository.getDebugSnapshot().backgroundDynamicCaches.length, 0);
});

test("a missing fixed background produces an auditable degraded empty snapshot", async () => {
  const repository = new InMemoryContextEngineRepository();
  const result = await createSessionBackground(repository, request("session-no-fixed"), {
    now: () => NOW,
    analyzer: fakeAnalyzer(async () => { throw new Error("LLM must not be called"); })
  });

  assert.equal(result.fixedRevision, 0);
  assert.equal(result.status, "degraded");
  assert.equal(result.degradedModeReason, "FIXED_BACKGROUND_MISSING");
  assert.match(result.fixedText, /暂无已确认信息/u);
  assert.match(result.serializedPrompt, /<fixed_background revision="0">/u);
});

test("Session createdAt does not cap the real-time dynamic window", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  await repository.saveShortTermMemory(createStm("stm-boundary", SESSION_AT));
  const result = await createSessionBackground(repository, request("session-boundary"), {
    now: () => NOW,
    analyzer: fakeAnalyzer(async (input) => resultFor(input))
  });
  assert.equal(result.dynamicWindowEnd, NOW);
  assert.equal(result.pendingStmCount, 1);
  assert.deepEqual(result.latestStmCursor, {
    updatedAt: SESSION_AT,
    memoryDataId: "stm-boundary"
  });
  assert.deepEqual(result.sourceMemoryIds, ["stm-boundary"]);
});

test("reference time accepts RFC3339 offsets and temporal identifiers are validated", async () => {
  const repository = new InMemoryContextEngineRepository();
  await repository.saveBackgroundDocument(createBackground());
  const normalized = await createSessionBackground(repository, {
    ...request("session-offset"),
    referenceTime: "2026-07-22T20:01:00+08:00",
    timezone: "Asia/Shanghai",
    locale: "zh-CN"
  }, { now: () => NOW });
  assert.equal(normalized.referenceTime, NOW);
  assert.equal(normalized.dynamicWindowEnd, NOW);

  await assert.rejects(
    createSessionBackground(repository, {
      ...request("session-invalid-reference"),
      referenceTime: "2026-07-22"
    }, { now: () => NOW }),
    /SESSION_BACKGROUND_REFERENCE_TIME_INVALID/u
  );
  await assert.rejects(
    createSessionBackground(repository, {
      ...request("session-invalid-timezone"),
      timezone: "Mars/Olympus"
    }, { now: () => NOW }),
    /SESSION_BACKGROUND_TIMEZONE_INVALID/u
  );
  await assert.rejects(
    createSessionBackground(repository, {
      ...request("session-invalid-locale"),
      locale: "invalid_locale"
    }, { now: () => NOW }),
    /SESSION_BACKGROUND_LOCALE_INVALID/u
  );
});

test("file-backed repository reloads dynamic cache and the idempotent session snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-background-file-"));
  const storePath = join(directory, "context.json");
  try {
    const writer = new FileBackedContextEngineRepository(storePath);
    await writer.saveBackgroundDocument(createBackground());
    await writer.saveShortTermMemory(createStm("stm-file-session", "2026-07-22T10:00:00.000Z"));
    const expected = await createSessionBackground(writer, request("session-file"), {
      now: () => NOW,
      analyzer: fakeAnalyzer(async (input) => resultFor(input))
    });

    const reader = new FileBackedContextEngineRepository(storePath);
    const replay = await createSessionBackground(reader, request("session-file"), {
      now: () => NOW,
      analyzer: fakeAnalyzer(async () => { throw new Error("LLM must not be called"); })
    });
    assert.deepEqual(replay, expected);
    assert.equal(reader.getBackgroundDynamicCache(expected.dynamicCacheKey)?.dynamicText, expected.dynamicText);
    assert.equal(reader.getDebugSnapshot().sessionBackgroundSnapshots.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const sqliteFts5Available = hasSqliteFts5();

test("SQLite reloads dynamic cache and an idempotent session snapshot", {
  skip: sqliteFts5Available ? false : "Node SQLite does not provide fts5"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-background-sqlite-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    await writer.saveBackgroundDocument(createBackground());
    await writer.saveShortTermMemory(createStm("stm-sqlite-session", "2026-07-22T10:00:00.000Z"));
    const expected = await createSessionBackground(writer, request("session-sqlite"), {
      now: () => NOW,
      analyzer: fakeAnalyzer(async (input) => resultFor(input))
    });
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath);
    const replay = await createSessionBackground(reader, request("session-sqlite"), {
      now: () => NOW,
      analyzer: fakeAnalyzer(async () => { throw new Error("LLM must not be called"); })
    });
    assert.deepEqual(replay, expected);
    assert.equal(reader.getBackgroundDynamicCache(expected.dynamicCacheKey)?.dynamicText, expected.dynamicText);
    assert.equal(reader.getDebugSnapshot().sessionBackgroundSnapshots.length, 1);
    reader.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function request(sessionId: string) {
  return {
    sessionId,
    tenantId: "tenant-a",
    principalId: "user-a",
    createdAt: SESSION_AT
  };
}

function createBackground(): BackgroundContextDocument {
  return {
    backgroundId: "background-r1",
    tenantId: "tenant-a",
    principalId: "user-a",
    fixedText: renderBackgroundMarkdown({
      identity: "- 用户是一名后端工程师。",
      relationships: "- 暂无已确认信息。",
      recentTasks: "- 正在实现 Context Engine。",
      aiSoul: "- 回答应简洁并给出依据。"
    }, "fixed"),
    dynamicText: renderBackgroundMarkdown(createEmptyBackgroundSections("dynamic"), "dynamic"),
    fixedRevision: 1,
    fixedTextUpdatedAt: "2026-07-22T09:00:00.000Z",
    fixedWatermark: { updatedAt: "2026-07-22T09:00:00.000Z", memoryDataId: "stm-fixed" },
    dynamicWindowStart: "2026-07-22T09:00:00.000Z",
    dynamicWindowEnd: "2026-07-22T09:00:00.000Z",
    dynamicSourceMemoryIds: [],
    latestStmCursor: { updatedAt: "2026-07-22T09:00:00.000Z", memoryDataId: "stm-fixed" },
    sourceRefIds: ["source-fixed"],
    conflictIds: [],
    createdAt: "2026-07-22T09:00:00.000Z",
    updatedAt: "2026-07-22T09:00:00.000Z"
  };
}

function createStm(memoryDataId: string, updatedAt: string): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "tenant-a",
    principalId: "user-a",
    createdAt: updatedAt,
    updatedAt,
    memoryDataType: "manual_memory_event",
    memoryType: "fact",
    content: `用户正在处理 ${memoryDataId} 对应的工作。`,
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

function fakeAnalyzer(
  implementation: (
    input: AnalyzeBackgroundMemoriesInput,
    options: BackgroundAnalyzerLlmOptions
  ) => Promise<BackgroundAnalyzerRunResult>
): typeof analyzeBackground {
  return (async (input, options = {}) => implementation(input, options)) as typeof analyzeBackground;
}

function resultFor(input: AnalyzeBackgroundMemoriesInput): BackgroundAnalyzerRunResult {
  const memoryIds = input.memories.map((memory) => memory.memoryDataId);
  const output = dynamicOutput(memoryIds);
  return {
    output,
    markdown: renderBackgroundMarkdown(Object.fromEntries(
      Object.entries(output.sections).map(([key, section]) => [key, section.text])
    ) as BackgroundSections, "dynamic"),
    executionStrategy: "single_request",
    estimatedInputTokens: 500,
    estimatedInputTokenUsage: 500,
    llmCallCount: 1,
    batchCount: 1,
    calls: []
  };
}

function fixedResultFor(input: AnalyzeBackgroundMemoriesInput): BackgroundAnalyzerRunResult {
  const memoryIds = input.memories.map((memory) => memory.memoryDataId);
  const unchanged = (key: keyof BackgroundSections) => ({
    text: input.existingSections[key],
    sourceMemoryIds: [],
    confidence: "low" as const,
    changed: false
  });
  const output: BackgroundAnalysisOutput = {
    sections: {
      identity: unchanged("identity"),
      relationships: unchanged("relationships"),
      recentTasks: {
        text: `- 固定背景已处理 ${memoryIds.join("、")}。`,
        sourceMemoryIds: memoryIds,
        confidence: "high",
        changed: true
      },
      aiSoul: unchanged("aiSoul")
    },
    ignoredMemoryIds: [],
    conflicts: [],
    summary: "固定背景补跑完成。"
  };
  return {
    output,
    markdown: renderBackgroundMarkdown(Object.fromEntries(
      Object.entries(output.sections).map(([key, section]) => [key, section.text])
    ) as BackgroundSections, "fixed"),
    executionStrategy: "single_request",
    estimatedInputTokens: 600,
    estimatedInputTokenUsage: 600,
    llmCallCount: 1,
    batchCount: 1,
    calls: []
  };
}

function dynamicOutput(memoryIds: string[]): BackgroundAnalysisOutput {
  const empty = createEmptyBackgroundSections("dynamic");
  const unchanged = (key: keyof BackgroundSections) => ({
    text: empty[key],
    sourceMemoryIds: [],
    confidence: "low" as const,
    changed: false
  });
  return {
    sections: {
      identity: unchanged("identity"),
      relationships: unchanged("relationships"),
      recentTasks: {
        text: `- 本次会话新增 ${memoryIds.join("、")} 对应的任务信息。`,
        sourceMemoryIds: memoryIds,
        confidence: "high",
        changed: true
      },
      aiSoul: unchanged("aiSoul")
    },
    ignoredMemoryIds: [],
    conflicts: [],
    summary: "会话背景分析完成。"
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
