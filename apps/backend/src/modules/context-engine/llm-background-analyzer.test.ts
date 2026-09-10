import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundMemoryCandidate } from "./background-stm-selector.js";
import { createEmptyBackgroundSections, type BackgroundSections } from "./background-markdown.js";
import {
  analyzeBackground,
  estimateBackgroundAnalyzerInputTokens,
  parseBackgroundAnalyzerOutput,
  type AnalyzeBackgroundInput,
  type AnalyzeBackgroundOutput
} from "./llm-background-analyzer.js";

test("background analyzer sends every candidate in one request when input fits", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const memories = [candidate("stm-a"), candidate("stm-b"), candidate("stm-c")];
  const result = await analyzeBackground({
    ...baseInput(),
    memories
  }, {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234/v1",
    model: "test-model",
    fetchImpl: createAnalyzerFetch(requests)
  });

  assert.equal(result.executionStrategy, "single_request");
  assert.equal(result.llmCallCount, 1);
  assert.equal(result.batchCount, 1);
  const prompt = userPrompt(requests[0]!);
  assert.equal(prompt.phase, "background_analysis");
  assert.equal((prompt.memories as unknown[]).length, 3);
  assert.equal((prompt.execution as { strategy?: unknown }).strategy, "single_request");
  assert.deepEqual(result.output.sections.recentTasks.sourceMemoryIds, ["stm-a", "stm-b", "stm-c"]);
  assert.match(result.markdown, /## 📋 最近任务/u);
});

test("background analyzer accepts generated candidate STM as valid background evidence", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const memory = {
    ...candidate("stm-candidate"),
    lifecycleStatus: "candidate_queue" as const
  };

  const result = await analyzeBackground({
    ...baseInput(),
    mode: "dynamic_session",
    memories: [memory]
  }, {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234/v1",
    model: "test-model",
    fetchImpl: createAnalyzerFetch(requests)
  });

  const prompt = userPrompt(requests[0]!);
  assert.equal((prompt.memories as Array<{ lifecycle_status: string }>)[0]?.lifecycle_status, "candidate_queue");
  assert.deepEqual(result.output.sections.recentTasks.sourceMemoryIds, ["stm-candidate"]);
});

test("background analyzer groups over-limit memories and globally merges batch results", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const memories = Array.from({ length: 5 }, (_, index) => candidate(
    `stm-${index + 1}`,
    `候选 ${index + 1}：${"背景上下文信息".repeat(80)}`
  ));
  const twoMemoryTokens = estimateBackgroundAnalyzerInputTokens(batchInput(memories.slice(0, 2)));
  const threeMemoryTokens = estimateBackgroundAnalyzerInputTokens(batchInput(memories.slice(0, 3)));
  assert.ok(threeMemoryTokens > twoMemoryTokens);
  const maxInputTokens = Math.floor((twoMemoryTokens + threeMemoryTokens) / 2);

  const result = await analyzeBackground({ ...baseInput(), memories }, {
    apiKey: "test-key",
    baseUrl: "http://localhost:1234/v1",
    model: "test-model",
    maxInputTokens,
    fetchImpl: createAnalyzerFetch(requests)
  });

  assert.equal(result.executionStrategy, "hierarchical_batch");
  assert.equal(result.batchCount, 3);
  assert.equal(result.llmCallCount, 4);
  const prompts = requests.map(userPrompt);
  const analysisPrompts = prompts.filter((prompt) => prompt.phase === "background_analysis");
  assert.deepEqual(analysisPrompts.map((prompt) => (prompt.memories as unknown[]).length), [2, 2, 1]);
  assert.equal(prompts.at(-1)?.phase, "hierarchical_merge");
  assert.deepEqual(
    result.output.sections.recentTasks.sourceMemoryIds.sort(),
    memories.map((memory) => memory.memoryDataId).sort()
  );
});

test("background analyzer returns a complete no-change dynamic document without calling LLM", async () => {
  const result = await analyzeBackground({
    ...baseInput(),
    mode: "dynamic_session",
    memories: []
  }, {
    apiKey: "",
    fetchImpl: async () => {
      throw new Error("LLM must not be called");
    }
  });

  assert.equal(result.llmCallCount, 0);
  assert.equal(result.output.sections.identity.changed, false);
  assert.match(result.markdown, /本时间窗口没有新增信息。/u);
  assert.equal((result.markdown.match(/^## /gmu) ?? []).length, 4);
});

test("background analyzer rejects unknown sources, unaccounted memories, and fixed-text copies", () => {
  const memory = candidate("stm-a");
  const input = { ...baseInput(), mode: "dynamic_session" as const, memories: [memory] };
  const unknownSource = wireOutput(["stm-unknown"], input.existingSections, "dynamic_session");
  assert.throws(
    () => parseBackgroundAnalyzerOutput(unknownSource, input),
    /BACKGROUND_ANALYZER_SOURCE_MEMORY_UNKNOWN/
  );

  const unaccounted = wireOutput([], input.existingSections, "dynamic_session");
  assert.throws(
    () => parseBackgroundAnalyzerOutput(unaccounted, input),
    /BACKGROUND_ANALYZER_MEMORY_UNACCOUNTED:stm-a/
  );

  const repeatedFixed = wireOutput(["stm-a"], input.existingSections, "dynamic_session");
  (repeatedFixed.sections.recentTasks as { text: string }).text = input.existingSections.recentTasks;
  assert.throws(
    () => parseBackgroundAnalyzerOutput(repeatedFixed, input),
    /BACKGROUND_ANALYZER_DYNAMIC_REPEATS_FIXED:recentTasks/
  );
});

test("background analyzer allows one memory to affect multiple sections", () => {
  const memory = candidate("stm-a");
  const input = { ...baseInput(), memories: [memory] };
  const response = wireOutput(["stm-a"], input.existingSections, "fixed_maintenance");
  (response.sections as Record<string, {
    text: string;
    source_memory_ids: string[];
    confidence: string;
    changed: boolean;
  }>).identity = {
    text: "用户是一名正在实现 Context Engine 的后端工程师。",
    source_memory_ids: ["stm-a"],
    confidence: "high",
    changed: true
  };

  const output = parseBackgroundAnalyzerOutput(response, input);
  assert.deepEqual(output.sections.identity.sourceMemoryIds, ["stm-a"]);
  assert.deepEqual(output.sections.recentTasks.sourceMemoryIds, ["stm-a"]);
});

test("background analyzer rejects an indivisible memory instead of truncating it", async () => {
  await assert.rejects(
    analyzeBackground({ ...baseInput(), memories: [candidate("stm-huge", "内容".repeat(200))] }, {
      apiKey: "test-key",
      maxInputTokens: 1,
      fetchImpl: async () => {
        throw new Error("LLM must not be called");
      }
    }),
    /BACKGROUND_ANALYZER_MEMORY_EXCEEDS_MAX_INPUT:stm-huge/
  );
});

function baseInput(): {
  mode: "fixed_maintenance";
  existingSections: BackgroundSections;
  windowStart: string;
  windowEnd: string;
} {
  return {
    mode: "fixed_maintenance",
    existingSections: {
      identity: "- 用户是一名后端工程师。",
      relationships: "- 暂无已确认信息。",
      recentTasks: "- 正在推进 Context Engine。",
      aiSoul: "- 回答应沿用用户的技术方案主线。"
    },
    windowStart: "2026-07-20T09:00:00.000Z",
    windowEnd: "2026-07-20T11:00:00.000Z"
  };
}

function batchInput(memories: BackgroundMemoryCandidate[]): AnalyzeBackgroundInput {
  return {
    ...baseInput(),
    memories,
    execution: {
      strategy: "hierarchical_batch",
      memoryCount: memories.length,
      batchIndex: 1,
      isLastBatch: false,
      estimatedTokens: 0
    }
  };
}

function candidate(memoryDataId: string, content = `用户正在处理 ${memoryDataId} 对应的背景任务。`): BackgroundMemoryCandidate {
  return {
    memoryDataId,
    content,
    createdAt: "2026-07-20T09:30:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    sourceRefs: [{ sourceRefId: `source-${memoryDataId}`, sourceType: "agent_memory", sourceId: memoryDataId }],
    confidenceLevel: "high",
    importanceLevel: "high",
    lifecycleStatus: "active"
  };
}

function createAnalyzerFetch(requests: Array<Record<string, unknown>>): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    const prompt = userPrompt(request);
    const mode = prompt.mode as "fixed_maintenance" | "dynamic_session";
    const existingSections = prompt.existing_sections as BackgroundSections;
    const memoryIds = prompt.phase === "background_analysis"
      ? (prompt.memories as Array<{ memory_id: string }>).map((memory) => memory.memory_id)
      : memoryIdsFromBatchResults(prompt.batch_results as Array<Record<string, unknown>>);
    const output = wireOutput(memoryIds, existingSections, mode);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(output) } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

function wireOutput(
  memoryIds: string[],
  existingSections: BackgroundSections,
  mode: "fixed_maintenance" | "dynamic_session"
) {
  const unchanged = (key: keyof BackgroundSections) => ({
    text: existingSections[key],
    source_memory_ids: [],
    confidence: "low",
    changed: false
  });
  return {
    sections: {
      identity: unchanged("identity"),
      relationships: unchanged("relationships"),
      recentTasks: memoryIds.length
        ? {
            text: mode === "dynamic_session"
              ? `本窗口新增 ${memoryIds.join("、")} 对应的任务信息。`
              : `正在推进 ${memoryIds.join("、")} 对应的任务。`,
            source_memory_ids: memoryIds,
            confidence: "high",
            changed: true
          }
        : unchanged("recentTasks"),
      aiSoul: unchanged("aiSoul")
    },
    ignored_memory_ids: [],
    conflicts: [],
    summary: "背景分析完成。"
  };
}

function userPrompt(request: Record<string, unknown>) {
  const messages = request.messages as Array<{ role: string; content: string }>;
  return JSON.parse(messages.find((message) => message.role === "user")!.content) as Record<string, unknown>;
}

function memoryIdsFromBatchResults(results: Array<Record<string, unknown>>) {
  const ids = new Set<string>();
  for (const result of results) {
    const sections = result.sections as Record<string, { source_memory_ids?: string[] }>;
    for (const section of Object.values(sections)) {
      for (const id of section.source_memory_ids ?? []) ids.add(id);
    }
    for (const id of result.ignored_memory_ids as string[] ?? []) ids.add(id);
    for (const conflict of result.conflicts as Array<{ memory_data_ids?: string[] }> ?? []) {
      for (const id of conflict.memory_data_ids ?? []) ids.add(id);
    }
  }
  return [...ids];
}
