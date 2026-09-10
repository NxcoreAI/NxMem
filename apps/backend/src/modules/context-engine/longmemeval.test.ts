import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getContextEngineConfig } from "../../config.js";
import { LongMemEvalStageRetryExhaustedError, buildLongMemEvalAnswerEvidenceText, buildLongMemEvalAnswerPrompt, buildLongMemEvalSelectedItemDetails, evaluateLongMemEvalDataset, evaluateLongMemEvalModelRuns, executeStageWithRetry, ingestLongMemEvalDataset, renderLongMemEvalAnswerContext, scoreRanking, selectLongMemEvalAnswerEvidenceWithinBudget, type LongMemEvalAnswerEvidenceCandidate } from "./longmemeval.js";
import type { FactItem, GraphMemoryNode, GraphMemoryOwnerType, GraphMemorySearchOptions, MemoryEvent, RelationEdge } from "./domain.js";
import {
  memoryOwnerTypeForId,
  type GraphMemoryNodePageQuery,
  type GraphMemoryStore,
  type GraphRelationEdgePageQuery,
  type GraphRelationSearchQuery
} from "./persistence/graph-store.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { DEFAULT_LLM_REQUEST_RETRY_DELAY_MS } from "./llm-request.js";
import { searchContext } from "./search-context.js";
import type { ScoreBreakdown } from "./search-context.js";
import type { ContextPackItem } from "./assemble-context.js";
import { parseAndAdmitEvent, type ParseAndAdmitStageObservation } from "./parse-event.js";
import {
  LongMemEvalArtifactError,
  LongMemEvalResultCommitConflictError,
  LongMemEvalResultWriter,
  createLongMemEvalDatasetIdentity,
  hashLongMemEvalResultPayload
} from "./longmemeval-artifacts.js";

const zeroScoreBreakdown: ScoreBreakdown = {
  keyword: 0,
  vector: 0,
  graph: 0,
  recency: 0,
  importance: 0,
  retrievalWeight: 0,
  userRetrievalWeight: 0,
  sourceReliability: 0,
  feedback: 0,
  diversity: 0,
  conflictPenalty: 0,
  permissionRiskPenalty: 0,
  stalenessPenalty: 0,
  route: { keyword: 0, vector: 0, graph: 0, time: 0, feedback: 0 },
  rrf: 0
};

test("stage retry reruns a recoverable outer attempt and preserves the successful output", async () => {
  let attempts = 0;
  const result = await executeStageWithRetry({
    stage: "answer",
    operation: "generate_hypothesis",
    execute: async ({ stageAttempt }) => {
      attempts += 1;
      if (stageAttempt === 1) throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      return "answer";
    }
  });
  assert.equal(result, "answer");
  assert.equal(attempts, 2);
});

test("stage retry stops after three recoverable outer attempts", async () => {
  let attempts = 0;
  await assert.rejects(
    executeStageWithRetry({
      stage: "ingestion",
      operation: "finalize_ingestion",
      execute: async () => {
        attempts += 1;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
    }),
    (error: unknown) => error instanceof LongMemEvalStageRetryExhaustedError && error.attempts === 3
  );
  assert.equal(attempts, 3);
});

test("stage retry does not rerun deterministic validation failures", async () => {
  let attempts = 0;
  await assert.rejects(
    executeStageWithRetry({
      stage: "judge",
      operation: "judge_hypothesis",
      execute: async () => {
        attempts += 1;
        throw new TypeError("invalid judge input");
      }
    }),
    /invalid judge input/
  );
  assert.equal(attempts, 1);
});

test("result commit exhaustion aborts the run before workers claim another sample", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ data: inputs.map((_, index) => ({
        index,
        embedding: [1, ...Array(Math.max(0, embeddingDimensions - 1)).fill(0)]
      })) });
    }
    const operation = readOpenAiOperation(body);
    return Response.json(buildLongMemEvalOperationChatResponse(body, operation, "Alpha"));
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-result-commit-abort-"));
  const filePath = join(dir, "sample.json");
  await writeFile(filePath, JSON.stringify(Array.from({ length: 4 }, (_, index) => ({
    question_id: `commit_abort_q${index + 1}`,
    question_type: "single-session-user",
    question: `What did I mention ${index + 1}?`,
    answer: "Alpha",
    answer_session_ids: [`commit_abort_s${index + 1}`],
    haystack_session_ids: [`commit_abort_s${index + 1}`],
    haystack_sessions: [[{ role: "user", content: "Alpha" }]]
  }))), "utf8");
  let commitAttempts = 0;
  const startedSamples: number[] = [];

  try {
    await assert.rejects(evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      ingestSampleConcurrency: 1,
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true,
      resultSinkOverride: {
        async commit() {
          commitAttempts += 1;
          throw Object.assign(new Error("disk temporarily unavailable"), { code: "EIO" });
        }
      },
      onSampleStage(event) {
        if (event.stage === "ingestion" && event.status === "started") startedSamples.push(event.sampleIndex);
      },
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    }), /stage attempts exhausted/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(commitAttempts, 3);
  assert.deepEqual(startedSamples, [1]);
});

test("evaluateLongMemEvalDataset resumes from the first uncommitted sample without clearing prior ingestion", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ data: inputs.map((_, index) => ({
        index,
        embedding: [1, ...Array(Math.max(0, embeddingDimensions - 1)).fill(0)]
      })) });
    }
    return Response.json(buildLongMemEvalOperationChatResponse(body, readOpenAiOperation(body), "Alpha"));
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-resume-interrupted-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "result.jsonl");
  await writeFile(filePath, JSON.stringify(Array.from({ length: 3 }, (_, index) => ({
    question_id: `resume_q${index + 1}`,
    question_type: "single-session-user",
    question: `What did I mention ${index + 1}?`,
    answer: "Alpha",
    answer_session_ids: [`resume_s${index + 1}`],
    haystack_session_ids: [`resume_s${index + 1}`],
    haystack_sessions: [[{ role: "user", content: `Alpha ${index + 1}` }]]
  }))), "utf8");
  const controller = new AbortController();

  try {
    await assert.rejects(evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      diagnosticsPath,
      runId: "resume-first-run",
      ingestSampleConcurrency: 1,
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true,
      signal: controller.signal,
      onSampleStage(event) {
        if (event.sampleIndex === 2 && event.stage === "ingestion" && event.status === "succeeded") {
          controller.abort();
        }
      },
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    }), /cancelled|aborted/iu);

    const firstRows = (await readFile(diagnosticsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(firstRows.map((row) => row.sampleIndex), [1]);
    const resumedStarts: number[] = [];
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      diagnosticsPath,
      runId: "resume-second-run",
      resume: true,
      ingestSampleConcurrency: 1,
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true,
      onSampleStage(event) {
        if (event.stage === "ingestion" && event.status === "started") resumedStarts.push(event.sampleIndex);
      },
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.deepEqual(resumedStarts, [2, 3]);
    assert.equal(report.recovery?.resumedFromRunId, "resume-first-run");
    assert.equal(report.recovery?.resumedSamples, 1);
    assert.equal(report.recovery?.committedSamples, 2);
    assert.equal(report.ingestion.ingestedSessions, 1);
    assert.equal(report.ingestion.skippedSessions, 1);
    const finalRows = (await readFile(diagnosticsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(finalRows.map((row) => row.sampleIndex), [1, 2, 3]);
    assert.deepEqual(finalRows.map((row) => row.runId), ["resume-first-run", "resume-second-run", "resume-second-run"]);
    assert.equal(new Set(finalRows.map((row) => row.resultCommitId)).size, 3);

    const tracePath = join(dir, "result.resume-second-run.trace.jsonl");
    const traceRows = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(traceRows.some((row) => row.stage === "run"), false);
    assert.equal(traceRows.every((row) => row.stage === "sample_summary"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resume repairs an incomplete tail and skips non-contiguous completed samples", async () => {
  const originalFetch = globalThis.fetch;
  installLongMemEvalSuccessFetch();
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-resume-non-contiguous-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "result.jsonl");
  const samples = buildResumeSamples("non_contiguous", 5);
  await writeFile(filePath, JSON.stringify(samples), "utf8");
  const datasetIdentity = await createLongMemEvalDatasetIdentity(filePath);
  const writer = await LongMemEvalResultWriter.open({ path: diagnosticsPath, truncate: true });
  for (const sampleIndex of [1, 2, 4, 5]) {
    await writer.commit({
      result: buildSeedResult(filePath, samples[sampleIndex - 1]!, sampleIndex, 5),
      runId: "non-contiguous-seed",
      modelRunId: "default",
      datasetIdentity,
      sampleIdentity: { index: sampleIndex, questionId: samples[sampleIndex - 1]!.question_id! }
    });
  }
  await writer.close();
  await writeFile(diagnosticsPath, '{"sampleIndex":3', { encoding: "utf8", flag: "a" });
  const startedSamples: number[] = [];

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ...longMemEvalResumeTestOptions(),
      diagnosticsPath,
      runId: "non-contiguous-resume",
      resume: true,
      onSampleStage(event) {
        if (event.stage === "ingestion" && event.status === "started") startedSamples.push(event.sampleIndex);
      }
    });
    assert.deepEqual(startedSamples, [3]);
    assert.equal(report.recovery?.resumedSamples, 4);
    assert.equal(report.recovery?.committedSamples, 1);
    assert.equal(report.recovery?.ignoredIncompleteTail, true);
    const rows = await readJsonlRows(diagnosticsPath);
    assert.deepEqual(rows.map((row) => row.sampleIndex), [1, 2, 4, 5, 3]);
    assert.equal(rows.every((row) => typeof row.resultCommitId === "string" && typeof row.payloadHash === "string"), true);
    assert.equal(rows.every((row) => typeof row.completedAt === "string"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resume treats skipped as complete unless retrySkipped is enabled", async () => {
  const originalFetch = globalThis.fetch;
  installLongMemEvalSuccessFetch();
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-resume-skipped-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "result.jsonl");
  const samples = buildResumeSamples("retry_skipped", 2);
  await writeFile(filePath, JSON.stringify(samples), "utf8");
  const datasetIdentity = await createLongMemEvalDatasetIdentity(filePath);
  const writer = await LongMemEvalResultWriter.open({ path: diagnosticsPath, truncate: true });
  await writer.commit({
    result: { ...buildSeedResult(filePath, samples[0]!, 1, 2), status: "skipped", skipped: true, skipReason: "seed_failure" },
    runId: "skipped-seed",
    modelRunId: "default",
    datasetIdentity,
    sampleIdentity: { index: 1, questionId: samples[0]!.question_id! }
  });
  await writer.commit({
    result: buildSeedResult(filePath, samples[1]!, 2, 2),
    runId: "skipped-seed",
    modelRunId: "default",
    datasetIdentity,
    sampleIdentity: { index: 2, questionId: samples[1]!.question_id! }
  });
  await writer.close();

  try {
    const defaultStarts: number[] = [];
    const completeReport = await evaluateLongMemEvalDataset(filePath, {
      ...longMemEvalResumeTestOptions(), diagnosticsPath, runId: "skipped-default-resume", resume: true,
      onSampleStage(event) {
        if (event.stage === "ingestion" && event.status === "started") defaultStarts.push(event.sampleIndex);
      }
    });
    assert.deepEqual(defaultStarts, []);
    assert.equal(completeReport.recovery?.resumedSamples, 2);
    assert.equal(completeReport.recovery?.committedSamples, 0);

    const retryStarts: number[] = [];
    const retryReport = await evaluateLongMemEvalDataset(filePath, {
      ...longMemEvalResumeTestOptions(), diagnosticsPath, runId: "skipped-retry-resume", resume: true, retrySkipped: true,
      onSampleStage(event) {
        if (event.stage === "ingestion" && event.status === "started") retryStarts.push(event.sampleIndex);
      }
    });
    assert.deepEqual(retryStarts, [1]);
    assert.equal(retryReport.recovery?.resumedSamples, 1);
    assert.equal(retryReport.recovery?.committedSamples, 1);
    const rows = await readJsonlRows(diagnosticsPath);
    assert.deepEqual(rows.map((row) => row.sampleIndex), [1, 2, 1]);
    assert.deepEqual(rows.map((row) => row.runId), ["skipped-seed", "skipped-seed", "skipped-retry-resume"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a new run truncates prior results and writes a separate trace", async () => {
  const originalFetch = globalThis.fetch;
  installLongMemEvalSuccessFetch();
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-new-run-artifacts-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "result.jsonl");
  const samples = buildResumeSamples("new_run", 1);
  await writeFile(filePath, JSON.stringify(samples), "utf8");
  await writeFile(diagnosticsPath, `${JSON.stringify({ legacy: "must be truncated" })}\n`, "utf8");

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ...longMemEvalResumeTestOptions(), diagnosticsPath, runId: "fresh-run"
    });
    assert.equal(report.recovery?.resume, false);
    assert.equal(report.recovery?.committedSamples, 1);
    const rows = await readJsonlRows(diagnosticsPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.runId, "fresh-run");
    assert.equal(rows[0]?.legacy, undefined);
    const traceRows = await readJsonlRows(join(dir, "result.fresh-run.trace.jsonl"));
    assert.equal(traceRows.some((row) => row.stage === "run"), false);
    assert.equal(traceRows.every((row) => row.stage === "sample_summary"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resume validates legacy, dataset, and conflicting terminal rows before starting workers", async () => {
  const originalFetch = globalThis.fetch;
  installLongMemEvalSuccessFetch();
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-resume-validation-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "result.jsonl");
  const samples = buildResumeSamples("resume_validation", 1);
  await writeFile(filePath, JSON.stringify(samples), "utf8");
  const initialDatasetIdentity = await createLongMemEvalDatasetIdentity(filePath);
  const legacyRow = buildSeedResult(initialDatasetIdentity.path, samples[0]!, 1, 1);
  await writeFile(diagnosticsPath, `${JSON.stringify(legacyRow)}\n`, "utf8");
  let started = 0;
  const options = {
    ...longMemEvalResumeTestOptions(), diagnosticsPath, resume: true,
    onSampleStage(event: { stage: string; status: string }) {
      if (event.stage === "ingestion" && event.status === "started") started += 1;
    }
  };

  try {
    await assert.rejects(
      evaluateLongMemEvalDataset(filePath, { ...options, runId: "legacy-rejected" }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "LEGACY_RESUME_REQUIRED"
    );
    assert.equal(started, 0);
    const legacyReport = await evaluateLongMemEvalDataset(filePath, { ...options, runId: "legacy-accepted", resumeLegacy: true });
    assert.equal(legacyReport.recovery?.resumedSamples, 1);
    assert.equal(legacyReport.recovery?.committedSamples, 0);
    assert.equal(started, 0);

    const datasetIdentity = await createLongMemEvalDatasetIdentity(filePath);
    const writer = await LongMemEvalResultWriter.open({ path: diagnosticsPath, truncate: true });
    await writer.commit({
      result: buildSeedResult(filePath, samples[0]!, 1, 1),
      runId: "identity-seed",
      modelRunId: "default",
      datasetIdentity,
      sampleIdentity: { index: 1, questionId: samples[0]!.question_id! }
    });
    await writer.close();
    await writeFile(filePath, JSON.stringify([{ ...samples[0], question: "Changed question" }]), "utf8");
    await assert.rejects(
      evaluateLongMemEvalDataset(filePath, { ...options, runId: "dataset-mismatch" }),
      (error: unknown) => error instanceof LongMemEvalArtifactError && error.code === "RESULT_DATASET_MISMATCH"
    );
    assert.equal(started, 0);

    await writeFile(filePath, JSON.stringify(samples), "utf8");
    const first = (await readJsonlRows(diagnosticsPath))[0]!;
    const conflicting: Record<string, unknown> = { ...first, hypothesis: "conflicting terminal" };
    delete conflicting.payloadHash;
    conflicting.payloadHash = hashLongMemEvalResultPayload(conflicting);
    await writeFile(diagnosticsPath, `${JSON.stringify(conflicting)}\n`, { encoding: "utf8", flag: "a" });
    await assert.rejects(
      evaluateLongMemEvalDataset(filePath, { ...options, runId: "terminal-conflict" }),
      LongMemEvalResultCommitConflictError
    );
    assert.equal(started, 0);
    await assert.rejects(readFile(`${diagnosticsPath}.lock`, "utf8"), (error: unknown) =>
      Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function buildResumeSamples(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    question_id: `${prefix}_q${index + 1}`,
    question_type: "single-session-user",
    question: `What did I mention ${index + 1}?`,
    answer: "Alpha",
    answer_session_ids: [`${prefix}_s${index + 1}`],
    haystack_session_ids: [`${prefix}_s${index + 1}`],
    haystack_sessions: [[{ role: "user", content: `Alpha ${index + 1}` }]]
  }));
}

function buildSeedResult(datasetPath: string, sample: ReturnType<typeof buildResumeSamples>[number], sampleIndex: number, sampleCount: number) {
  return {
    datasetPath,
    sampleIndex,
    sampleCount,
    questionId: sample.question_id,
    questionType: sample.question_type,
    question: sample.question,
    answer: sample.answer,
    hypothesis: "Alpha",
    exactMatch: true,
    judgment: { label: "correct", reason: "seed", raw: "yes" }
  };
}

function longMemEvalResumeTestOptions() {
  return {
    ks: [1],
    ingestSampleConcurrency: 1,
    disableIngestLlm: true,
    skipStmAdmission: true,
    skipLtmDreaming: true,
    logger: { info() {}, warn() {}, error() {} },
    llm: {
      extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
      judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
    }
  };
}

function installLongMemEvalSuccessFetch() {
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ data: inputs.map((_, index) => ({
        index,
        embedding: [1, ...Array(Math.max(0, embeddingDimensions - 1)).fill(0)]
      })) });
    }
    return Response.json(buildLongMemEvalOperationChatResponse(body, readOpenAiOperation(body), "Alpha"));
  }) as typeof fetch;
}

async function readJsonlRows(path: string) {
  const content = (await readFile(path, "utf8")).trim();
  return content ? content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

function answerEvidenceCandidate(
  id: string,
  overrides: Partial<LongMemEvalAnswerEvidenceCandidate> = {}
): LongMemEvalAnswerEvidenceCandidate {
  const { item: itemOverride, ...candidateOverrides } = overrides;
  const item = itemOverride ?? {
    id,
    layer: "stm",
    score: 0.5,
    content: `事实 ${id}`,
    compressedContent: `事实 ${id}`,
    sourceRefs: [{ sourceRefId: `src_${id}`, sourceType: "agent_memory", sourceId: `source_${id}` }],
    sourceMessageIds: [],
    factIds: [`fact_${id}`],
    memoryIds: [id],
    temporal: {}
  } satisfies ContextPackItem;
  return {
    item,
    scoreBreakdown: zeroScoreBreakdown,
    sourceSessionIds: [`session_${id}`],
    sourceRoles: ["user"],
    temporal: item.temporal,
    relations: [],
    facts: [] as FactItem[],
    evidenceText: item.content,
    relevanceScore: 0,
    estimatedTokens: 20,
    ...candidateOverrides
  };
}

function readChronologicalEvidenceBlock(prompt: string) {
  const start = prompt.indexOf("Chronological Evidence:");
  if (start < 0) return "";
  const end = prompt.indexOf("\n\nContext:", start);
  return prompt.slice(start, end >= 0 ? end : undefined);
}

function assertStageBarrier(events: Array<{ stage: string }>, before: string, after: string) {
  const firstAfterIndex = events.findIndex((item) => item.stage === after);
  const lastBeforeIndex = events.map((item, index) => (item.stage === before ? index : -1)).filter((index) => index >= 0).at(-1) ?? -1;
  assert.notEqual(firstAfterIndex, -1, `missing stage ${after}`);
  assert.notEqual(lastBeforeIndex, -1, `missing stage ${before}`);
  assert.equal(firstAfterIndex > lastBeforeIndex, true, `${after} started before all ${before} events completed`);
}

function readOpenAiOperation(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages[0] as { content?: unknown } | undefined;
  const user = messages[1] as { content?: unknown } | undefined;
  const content = typeof system?.content === "string" ? system.content : "";
  const userContent = typeof user?.content === "string" ? user.content : "";
  if (content.includes("事实抽取")) return "fact_fusion";
  if (content.includes("STM 准入")) return "stm_admission";
  if (content.includes("LongMemEval 答题证据选择器")) return "answer_evidence_selection";
  if (content.includes("Answer the question directly.")) return "answer";
  if (userContent.includes("Is the model response correct?")) return "judge";
  return body.input ? "responses" : "unknown";
}

function buildLongMemEvalIngestChatResponse(body: Record<string, unknown>, operation: string) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages[1] as { content?: unknown } | undefined;
  const prompt = typeof user?.content === "string" ? JSON.parse(user.content) as Record<string, unknown> : {};

  if (operation === "fact_fusion") {
    const evidence = Array.isArray(prompt.evidence) ? prompt.evidence : [];
    const firstEvidence = evidence[0] as { segmentId?: string; validTimeStart?: string; timeBasis?: string; timeConfidence?: string } | undefined;
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              facts: [
                {
                  factType: "text",
                  factText: "Alpha is the shared code word.",
                  normalizedClaim: "Alpha is the shared code word.",
                  confidenceLevel: "high",
                  linkedSegmentIds: [firstEvidence?.segmentId],
                  entityIds: ["alpha"],
                  validTimeStart: firstEvidence?.validTimeStart ?? "2023-01-01T00:00:00.000Z",
                  timeBasis: firstEvidence?.timeBasis ?? "source_time",
                  timeConfidence: firstEvidence?.timeConfidence ?? "high"
                }
              ]
            })
          }
        }
      ]
    };
  }

  const facts = Array.isArray(prompt.facts) ? prompt.facts : [];
  const fact = facts[0] as { factId?: string } | undefined;
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            result: "write_high_priority",
            memoryDataType: "fact",
            importanceLevel: "high",
            confidenceLevel: "high",
            needUserConfirm: false,
            reason: "benchmark session contains answer evidence",
            matchedRules: ["longmemeval_session_answer_evidence"],
            sourceFactIds: [fact?.factId].filter(Boolean)
          })
        }
      }
    ]
  };
}

function buildLongMemEvalOperationChatResponse(
  body: Record<string, unknown>,
  operation: string,
  answer = "Alpha"
) {
  const serialized = JSON.stringify(body);
  if (operation === "answer" || serialized.includes("You are answering a LongMemEval question.")) {
    return buildChatCompletionTextResponse(answer);
  }
  if (operation === "judge" || serialized.includes("Is the model response correct?")) {
    return buildChatCompletionTextResponse("yes");
  }
  return buildLongMemEvalIngestChatResponse(body, operation);
}

function buildChatCompletionTextResponse(text: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text
        },
        finish_reason: "stop"
      }
    ]
  };
}

function buildLongMemEvalQaResponse(init: RequestInit | undefined, answer: string) {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
  const serialized = JSON.stringify(body);
  const text = serialized.includes("Is the model response correct?") ? "yes" : answer;
  return {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }]
      }
    ]
  };
}

function readLongMemEvalIngestEventId(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages[1] as { content?: unknown } | undefined;
  const prompt = typeof user?.content === "string" ? JSON.parse(user.content) as { event?: { eventId?: unknown } } : {};
  return typeof prompt.event?.eventId === "string" ? prompt.event.eventId : undefined;
}

class RecordingGraphMemoryStore implements GraphMemoryStore {
  readonly upserted: GraphMemoryNode[] = [];
  readonly relationEdges: RelationEdge[] = [];
  readonly textSearches: GraphMemorySearchOptions[] = [];
  readonly vectorSearches: GraphMemorySearchOptions[] = [];

  upsertGraphMemoryNode(node: GraphMemoryNode) {
    const index = this.upserted.findIndex((item) => item.ownerType === node.ownerType && item.ownerId === node.ownerId);
    if (index >= 0) {
      this.upserted[index] = node;
      return;
    }
    this.upserted.push(node);
  }

  deleteGraphMemoryNode(ownerType: GraphMemoryOwnerType, ownerId: string) {
    const index = this.upserted.findIndex((item) => item.ownerType === ownerType && item.ownerId === ownerId);
    if (index >= 0) this.upserted.splice(index, 1);
  }

  upsertGraphRelationEdge(edge: RelationEdge) {
    const index = this.relationEdges.findIndex((item) => item.edgeId === edge.edgeId);
    if (index >= 0) {
      this.relationEdges[index] = edge;
      return;
    }
    this.relationEdges.push(edge);
  }

  deleteGraphRelationEdges(_edgeIds: string[]) {}

  clearGraph() {
    this.upserted.length = 0;
  }

  searchGraphText(queryTokens: string[], options: GraphMemorySearchOptions = {}) {
    this.textSearches.push({ ...options });
    const tokens = queryTokens.map((token) => token.toLowerCase()).filter(Boolean);
    return this.filterNodes(options)
      .map((node) => {
        const content = node.content.toLowerCase();
        const matchedTerms = tokens.filter((token) => content.includes(token)).length;
        return {
          ownerType: node.ownerType,
          ownerId: node.ownerId,
          score: matchedTerms,
          matchedTerms
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score);
  }

  searchGraphVector(_queryVector: number[], options: GraphMemorySearchOptions = {}) {
    this.vectorSearches.push({ ...options });
    return this.filterNodes(options).map((node) => ({
      ownerType: node.ownerType,
      ownerId: node.ownerId,
      score: 0.5
    }));
  }

  getGraphRelationEdges(_ownerId: string) {
    return [];
  }

  searchGraphRelationEdges(query: GraphRelationSearchQuery) {
    const relationTypes = query.relationTypes ? new Set(query.relationTypes) : undefined;
    const ownerTypes = query.ownerTypes ? new Set(query.ownerTypes) : undefined;
    const evidenceQuery = query.q?.trim().toLowerCase();
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(0, query.limit ?? 50);
    return this.relationEdges
      .filter((edge) => !query.fromId || edge.fromId === query.fromId)
      .filter((edge) => !query.toId || edge.toId === query.toId)
      .filter((edge) => !relationTypes || relationTypes.has(edge.relationType))
      .filter((edge) => {
        if (!ownerTypes) return true;
        const fromOwnerType = memoryOwnerTypeForId(edge.fromId);
        const toOwnerType = memoryOwnerTypeForId(edge.toId);
        return Boolean((fromOwnerType && ownerTypes.has(fromOwnerType)) || (toOwnerType && ownerTypes.has(toOwnerType)));
      })
      .filter((edge) => !evidenceQuery || (edge.evidence ?? "").toLowerCase().includes(evidenceQuery))
      .slice(offset, offset + limit);
  }

  listGraphMemoryNodes(query: GraphMemoryNodePageQuery) {
    const rows = this.upserted
      .filter((node) => query.ownerTypes.includes(node.ownerType))
      .filter((node) => !query.after || node.ownerType > query.after.layer ||
        (node.ownerType === query.after.layer && node.ownerId > query.after.id))
      .sort((left, right) => left.ownerType.localeCompare(right.ownerType) || left.ownerId.localeCompare(right.ownerId))
      .slice(0, query.limit + 1);
    return { nodes: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }

  listGraphRelationEdges(query: GraphRelationEdgePageQuery) {
    const ownerTypesById = new Map(this.upserted.map((node) => [node.ownerId, node.ownerType]));
    const rows = this.relationEdges
      .filter((edge) => {
        const fromOwnerType = ownerTypesById.get(edge.fromId);
        const toOwnerType = ownerTypesById.get(edge.toId);
        return Boolean(fromOwnerType && toOwnerType &&
          query.ownerTypes.includes(fromOwnerType) && query.ownerTypes.includes(toOwnerType));
      })
      .filter((edge) => query.relationTypes.includes(edge.relationType))
      .filter((edge) => !query.after || edge.edgeId > query.after.id)
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId))
      .slice(0, query.limit + 1);
    return { edges: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }

  private filterNodes(options: GraphMemorySearchOptions) {
    const ownerTypes = new Set(options.ownerTypes ?? ["stm", "ltm"]);
    const ownerKeys = options.ownerKeys ? new Set(options.ownerKeys) : undefined;
    return this.upserted.filter((node) =>
      ownerTypes.has(node.ownerType) &&
      (!ownerKeys || ownerKeys.has(`${node.ownerType}:${node.ownerId}`))
    );
  }
}

class TransientSearchGraphMemoryStore extends RecordingGraphMemoryStore {
  searchAttempts = 0;

  override searchGraphVector(queryVector: number[], options: GraphMemorySearchOptions = {}) {
    this.searchAttempts += 1;
    if (this.searchAttempts <= 2) {
      throw new Error("Connection acquisition timed out in 60000 ms. Pool status: Active conn count = 100, Idle conn count = 0.");
    }
    return super.searchGraphVector(queryVector, options);
  }
}

test("scoreRanking computes standard retrieval metrics", () => {
  const metrics = scoreRanking(["gold_a", "gold_b"], ["noise", "gold_b", "gold_a", "extra"], 3);

  assert.equal(metrics.recallAtK, 1);
  assert.equal(metrics.recallAnyAtK, 1);
  assert.equal(metrics.recallAllAtK, 1);
  assert.equal(metrics.precisionAtK, 2 / 3);
  assert.equal(metrics.mrrAtK, 1 / 2);
  assert.equal(metrics.ndcgAtK.toFixed(3), "0.815");
});

test("evaluateLongMemEvalModelRuns runs multiple model configs with bounded concurrency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-model-runs-"));
  const filePath = join(dir, "sample.json");
  const resultPath = join(dir, "result.jsonl");
  const tracePath = join(dir, "trace.jsonl");
  const progressModels = new Set<string>();
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "Which word was mentioned?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [
          [
            { role: "user", content: "Alpha is the word." }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const report = await evaluateLongMemEvalModelRuns(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    modelConcurrency: 2,
    diagnosticsPath: resultPath,
    tracePath,
    disableIngestLlm: true,
    skipStmAdmission: true,
    skipLtmDreaming: true,
    onProgress: (progress) => {
      if (progress.modelRunId) progressModels.add(progress.modelRunId);
    },
    llmRuns: [
      { runId: "answerer-a", llm: { extraction: { model: "model-a" }, judge: { model: "judge-a" } } },
      { runId: "answerer-b", llm: { extraction: { model: "model-b" }, judge: { model: "judge-b" } } }
    ]
  });

  assert.equal(report.totalRuns, 2);
  assert.equal(report.completedRuns, 2);
  assert.equal(report.failedRuns, 0);
  assert.equal(report.modelConcurrency, 2);
  assert.deepEqual(report.runs.map((run) => run.runId), ["answerer-a", "answerer-b"]);
  assert.equal(report.runs.every((run) => run.report?.totalSamples === 1), true);
  assert.deepEqual(report.runs.map((run) => run.resultPath), [
    join(dir, "result.answerer-a.jsonl"),
    join(dir, "result.answerer-b.jsonl")
  ]);
  assert.deepEqual(report.runs.map((run) => run.tracePath), [
    join(dir, "trace.answerer-a.jsonl"),
    join(dir, "trace.answerer-b.jsonl")
  ]);
  assert.deepEqual([...progressModels].sort(), ["answerer-a", "answerer-b"]);
  const resultModels = await Promise.all(report.runs.map(async (run) =>
    (await readFile(run.resultPath!, "utf8")).trim().split("\n").map((line) => JSON.parse(line).modelRunId)
  ));
  assert.deepEqual(resultModels, [["answerer-a"], ["answerer-b"]]);
});

test("buildLongMemEvalSelectedItemDetails resolves fact stm and ltm items", async () => {
  const repository = new InMemoryContextEngineRepository();
  repository.facts.push({
    factId: "fact-1",
    factType: "text",
    factText: "Business Administration",
    normalizedClaim: "Business Administration",
    linkedEventIds: ["event-1"],
    linkedSegmentIds: ["segment-1"],
    linkedSourceRefs: [],
    entityIds: ["entity-1"],
    confidenceLevel: "high",
    version: 1,
    status: "active",
    observedAt: "2023-05-30T00:00:00.000Z",
    validTimeStart: "2023-05-30T00:00:00.000Z",
    timeBasis: "source_time",
    timeConfidence: "high",
    schemaVersion: "fact-item.v1"
  });
  repository.parsedSegments.push({
    segmentId: "segment-1",
    eventId: "event-1",
    modality: "text",
    content: "I studied Business Administration.",
    status: "parsed",
    confidence: "high"
  });
  repository.memoryEvents.push({
    eventId: "event-1",
    eventType: "conversation",
    eventTime: "2023-05-29T13:28:00.000Z",
    sourceId: "session-1",
    permissionSnapshot: {
      snapshotId: "permission-1",
      tenantId: "local",
      principalId: "longmemeval",
      sourceAclVersion: "1",
      visibility: "private"
    },
    multimodalData: []
  });
  repository.shortTermMemories.push({
    memoryDataId: "stm-1",
    tenantId: "local",
    principalId: "longmemeval",
    memoryDataType: "fact",
    memoryType: "fact",
    content: "user mentioned the degree",
    factSummary: "degree mentioned",
    summary: "degree mentioned",
    sourceFactIds: ["fact-1"],
    sourceRefs: [],
    entityIds: [],
    importanceLevel: "high",
    retrievalWeight: 0.7,
    userRetrievalWeight: 0.5,
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "benchmark",
    matchedRules: [],
    admissionSignals: {
      importance: "high",
      confidence: "high",
      freshness: "fresh",
      sensitivity: "low",
      actorWeight: "medium",
      permission: "private",
      conflict: "none"
    },
    accessState: "visible",
    lifecycleStatus: "active",
    createdAt: "2023-05-30T00:00:00.000Z",
    updatedAt: "2023-05-30T00:00:00.000Z"
  });
  repository.longTermMemories.push({
    memoryId: "ltm-1",
    theoryClass: "semantic",
    memoryType: "knowledge",
    content: "user graduated with Business Administration",
    factSummary: "Business Administration",
    summary: "Business Administration",
    confidenceLevel: "high",
    recallWeight: "high",
    retrievalWeight: 0.9,
    userRetrievalWeight: 0.9,
    solidifyReason: "dreaming",
    sourceRefs: [],
    sourceMemoryDataIds: ["stm-1"],
    entityIds: [],
    matchedRules: [],
    accessState: "visible",
    lifecycleStatus: "active"
  });

  const result = buildLongMemEvalSelectedItemDetails(repository.getDebugSnapshot(), "dataset.json", ["fact-1", "stm-1", "ltm-1", "missing"]);

  assert.deepEqual(result.selectedItemIds, ["fact-1", "stm-1", "ltm-1", "missing"]);
  assert.deepEqual(result.missingItemIds, ["missing"]);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0]?.layer, "fact");
  assert.equal(result.items[1]?.layer, "stm");
  assert.equal(result.items[2]?.layer, "ltm");
  assert.equal(result.items[1]?.sourceSegments[0]?.content, "I studied Business Administration.");
  assert.equal(result.items[2]?.sourceSegments[0]?.sourceId, "session-1");
});

test("ingestLongMemEvalDataset processes samples through the ordinary memory pipeline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-ingest-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "temporal-reasoning",
        question: "When did it happen?",
        answer: "Alpha",
        question_date: "2023/04/10 (Mon) 23:07",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "hello" },
            { role: "assistant", content: "world" }
          ],
          [
            { role: "user", content: "answer" },
            { role: "assistant", content: "Alpha" }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const repository = new InMemoryContextEngineRepository();
  const result = await ingestLongMemEvalDataset(repository, filePath, { llm: { apiKey: "" } });

  assert.equal(result.totalSamples, 1);
  assert.equal(result.totalSessions, 2);
  assert.equal(result.ingestedSessions, 2);
  assert.deepEqual(repository.memoryEvents.map((event) => event.eventId).sort(), [
    "longmemeval_event_q1_s1",
    "longmemeval_event_q1_s2"
  ]);
  assert.equal(repository.memoryEvents.every((event) => event.multimodalData.length === 1), true);
  assert.equal(repository.parsedSegments.length, 2);
  assert.equal(repository.facts.length, 2);
  assert.equal(repository.shortTermMemories.length, 2);
  assert.equal(repository.longTermMemories.length, 0);
  assert.equal(repository.llmFactFusionTraces.length, 2);
  assert.equal(repository.llmStmAdmissionTraces.length, 2);
  assert.equal(repository.pipelineTasks.some((task) => task.stage === "stm_index_refreshed"), true);
  assert.equal(repository.changeEvents.some((event) => event.reason === "memory_event_accepted"), true);
});

test("ingestLongMemEvalDataset ignores answer annotations and ingests the complete session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-answer-context-"));
  const labeledPath = join(dir, "labeled.json");
  const unlabeledPath = join(dir, "unlabeled.json");
  const session = [
    { role: "user", content: "I'm trying to organize my coupons and receipts." },
    { role: "assistant", content: "A binder with labeled sections can help." },
    {
      role: "user",
      content: "I've been using the Cartwheel app from Target and it has been helpful for household items."
    },
    { role: "assistant", content: "Target offers can be combined with an organized coupon system." },
    {
      role: "user",
      content: "I actually redeemed a $5 coupon on coffee creamer last Sunday.",
      has_answer: true
    }
  ];
  const buildSample = (input: {
    question: string;
    questionType: string;
    answer: string;
    answerSessionIds: string[];
    includeAnswerMarker: boolean;
  }) => [{
    question_id: "51a45a95",
    question_type: input.questionType,
    question: input.question,
    answer: input.answer,
    answer_session_ids: input.answerSessionIds,
    haystack_session_ids: ["answer_d61669c7"],
    haystack_dates: ["2023/05/29 (Mon) 13:28"],
    haystack_sessions: [[...session.slice(0, -1), {
      ...session.at(-1),
      has_answer: input.includeAnswerMarker
    }]]
  }];
  await writeFile(labeledPath, JSON.stringify(buildSample({
    question: "Where did I redeem a $5 coupon on coffee creamer?",
    questionType: "single-session-user",
    answer: "Target",
    answerSessionIds: ["answer_d61669c7"],
    includeAnswerMarker: true
  })), "utf8");
  await writeFile(unlabeledPath, JSON.stringify(buildSample({
    question: "A different evaluation question that must not affect ingestion",
    questionType: "multi-session",
    answer: "A different evaluation answer",
    answerSessionIds: ["different_session"],
    includeAnswerMarker: false
  })), "utf8");

  const labeledRepository = new InMemoryContextEngineRepository();
  const unlabeledRepository = new InMemoryContextEngineRepository();
  await ingestLongMemEvalDataset(labeledRepository, labeledPath, { llm: { apiKey: "" } });
  await ingestLongMemEvalDataset(unlabeledRepository, unlabeledPath, { llm: { apiKey: "" } });

  const expectedTranscript = session.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
  const labeledItemContent = labeledRepository.memoryEvents[0]?.multimodalData[0]?.content as Record<string, unknown> | undefined;
  const unlabeledItemContent = unlabeledRepository.memoryEvents[0]?.multimodalData[0]?.content as Record<string, unknown> | undefined;
  assert.equal(labeledItemContent?.text, expectedTranscript);
  assert.equal(labeledItemContent?.rawTranscript, expectedTranscript);
  assert.equal("question" in (labeledItemContent ?? {}), false);
  assert.equal("questionType" in (labeledItemContent ?? {}), false);
  assert.equal("sourceKind" in (labeledItemContent ?? {}), false);
  assert.deepEqual(labeledItemContent, unlabeledItemContent);
  assert.deepEqual(
    labeledRepository.parsedSegments.map((item) => ({ segmentId: item.segmentId, content: item.content })),
    unlabeledRepository.parsedSegments.map((item) => ({ segmentId: item.segmentId, content: item.content }))
  );
  assert.deepEqual(
    labeledRepository.facts.map((item) => ({ factId: item.factId, factText: item.factText, normalizedClaim: item.normalizedClaim })),
    unlabeledRepository.facts.map((item) => ({ factId: item.factId, factText: item.factText, normalizedClaim: item.normalizedClaim }))
  );
  assert.deepEqual(
    labeledRepository.shortTermMemories.map((item) => ({ memoryDataId: item.memoryDataId, content: item.content })),
    unlabeledRepository.shortTermMemories.map((item) => ({ memoryDataId: item.memoryDataId, content: item.content }))
  );
});

test("ingestLongMemEvalDataset sends one ingest LLM request set per haystack session", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);

    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (String(url).endsWith("/chat/completions")) {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeRequests -= 1;
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const sessionIds = Array.from({ length: 25 }, (_, index) => `parallel_s${index + 1}`);
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-parallel-ingest-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "parallel_q1",
        question_type: "multi-session",
        question: "Which session mentioned Alpha?",
        answer: "Alpha",
        question_date: "2023/04/10 (Mon) 23:07",
        answer_session_ids: ["parallel_s25"],
        haystack_session_ids: sessionIds,
        haystack_sessions: sessionIds.map((sessionId, index) => [
          { role: "user", content: `${sessionId} says ${index === 24 ? "Alpha" : "noise"}.` }
        ])
      }
    ]),
    "utf8"
  );

  try {
    const repository = new InMemoryContextEngineRepository();
    const result = await ingestLongMemEvalDataset(repository, filePath, {
      llm: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
    });

    assert.equal(result.ingestedSessions, 25);
    assert.equal(repository.memoryEvents.length, 25);
    assert.equal(repository.parsedSegments.length, 25);
    assert.equal(repository.llmFactFusionTraces.length, 25);
    assert.equal(repository.llmStmAdmissionTraces.length, 25);
    assert.equal(maxActiveRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingestLongMemEvalDataset stores each haystack session as a dated MemoryEvent", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const operation = readOpenAiOperation(body);
    if (operation === "fact_fusion") {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const user = messages[1] as { content?: unknown } | undefined;
      const prompt = typeof user?.content === "string"
        ? JSON.parse(user.content) as { evidence?: Array<{ segmentId?: string; content?: string; validTimeStart?: string }> }
        : {};
      const evidence = prompt.evidence?.[0];
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              facts: [{
                factType: "text",
                factText: evidence?.content ?? "",
                normalizedClaim: evidence?.content ?? "",
                confidenceLevel: "high",
                linkedSegmentIds: [evidence?.segmentId],
                entityIds: ["alpha"],
                validTimeStart: evidence?.validTimeStart,
                timeBasis: "source_time",
                timeConfidence: "high"
              }]
            })
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-json-event-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "json_schema_q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        question_date: "2023/04/10 (Mon) 23:07",
        haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/05/20 (Sat) 02:57"],
        answer_session_ids: ["json_schema_s2"],
        haystack_session_ids: ["json_schema_s1", "json_schema_s2"],
        haystack_sessions: [
          [
            { role: "user", content: "The weather was cloudy." }
          ],
          [
            { role: "user", content: "The code word is Alpha.", has_answer: true },
            { role: "assistant", content: "Extra transcript context that should remain raw only." }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const repository = new InMemoryContextEngineRepository();
  try {
    await ingestLongMemEvalDataset(repository, filePath, {
      llm: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(repository.memoryEvents.map((event) => event.eventId).sort(), [
    "longmemeval_event_json_schema_q1_json_schema_s1",
    "longmemeval_event_json_schema_q1_json_schema_s2"
  ]);
  const event = repository.memoryEvents.find((item) => item.eventId === "longmemeval_event_json_schema_q1_json_schema_s2");
  assert.ok(event);
  assert.equal(event.eventSummary, "LongMemEval session json_schema_s2 for sample json_schema_q1");
  assert.equal(event.eventDescription, undefined);
  assert.equal(event.eventTime, "2023-05-20T02:57:00.000Z");
  assert.deepEqual(event.sourceRefs, [
    {
      sourceRefId: "src_longmemeval_event_json_schema_q1_json_schema_s2",
      sourceType: "agent_memory",
      sourceId: "longmemeval_event_json_schema_q1_json_schema_s2",
      metadata: { questionId: "json_schema_q1", sessionId: "json_schema_s2" }
    }
  ]);
  const item = event.multimodalData[0];
  assert.ok(item);
  assert.equal(item.itemId, "item_json_schema_q1_json_schema_s2");
  assert.equal(item.format, "json");
  assert.deepEqual(item.sourceRefs, [{
    sourceRefId: "src_longmemeval_event_json_schema_q1_json_schema_s2",
    sourceType: "agent_memory",
    sourceId: "longmemeval_event_json_schema_q1_json_schema_s2",
    metadata: { questionId: "json_schema_q1", sessionId: "json_schema_s2" }
  }]);
  assert.equal(item.customFields, undefined);
  assert.equal(typeof item.content, "object");
  const expectedRawTranscript = [
    "user: The code word is Alpha.",
    "assistant: Extra transcript context that should remain raw only."
  ].join("\n");
  const expectedFactSourceText = expectedRawTranscript;
  assert.equal((item.content as { text?: string }).text, expectedFactSourceText);
  assert.equal((item.content as { rawTranscript?: string }).rawTranscript, expectedRawTranscript);
  assert.equal((item.content as { sessionId?: string }).sessionId, "json_schema_s2");
  assert.equal((item.content as { validTimeStart?: string }).validTimeStart, undefined);
  const segment = repository.parsedSegments.find((entry) => entry.eventId === event.eventId);
  assert.ok(segment);
  assert.equal(segment.content, expectedFactSourceText);
  assert.equal(segment.customFields?.sessionId, "json_schema_s2");
  assert.equal(segment.customFields?.rawTranscript, expectedRawTranscript);
  assert.equal(segment.customFields?.validTimeStart, undefined);
  const fact = repository.facts.find((entry) => entry.linkedEventIds.includes(event.eventId));
  assert.ok(fact);
  assert.equal(fact.factText, expectedFactSourceText);
  assert.equal(fact.evidenceTime, "2023-05-20T02:57:00.000Z");
  assert.equal(fact.validTime, undefined);
  assert.equal(fact.validTimeStart, undefined);
  const stm = repository.shortTermMemories.find((memory) =>
    memory.memoryDataId === "stm_fact_llm_longmemeval_event_json_schema_q1_json_schema_s2_0"
  );
  assert.ok(stm);
  assert.equal(stm.content, expectedFactSourceText.replace(/\s+/gu, " "));
  assert.notEqual(stm.content, expectedRawTranscript);
});

test("ingestLongMemEvalDataset lets the parser be the single chunking boundary for unmarked sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-single-chunk-boundary-"));
  const filePath = join(dir, "sample.json");
  const firstTurn = "The first detail says my train commute takes 45 minutes each way.";
  const middleTurn = "This middle detail is unrelated filler about weekend errands. ".repeat(20);
  const finalTurn = "The final detail says I buy coffee creamer at Kroger with a $5 coupon.";
  const expectedRawTranscript = [
    `user: ${firstTurn}`,
    `assistant: ${middleTurn.trim()}`,
    `user: ${finalTurn}`
  ].join("\n");

  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "single_chunk_boundary_q1",
        question_type: "single-session-user",
        question: "Where did I buy coffee creamer?",
        answer: "Kroger",
        answer_session_ids: ["single_chunk_boundary_s1"],
        haystack_session_ids: ["single_chunk_boundary_s1"],
        haystack_sessions: [
          [
            { role: "user", content: firstTurn },
            { role: "assistant", content: middleTurn },
            { role: "user", content: finalTurn }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const repository = new InMemoryContextEngineRepository();
  await ingestLongMemEvalDataset(repository, filePath);

  const event = repository.memoryEvents.find((item) => item.eventId === "longmemeval_event_single_chunk_boundary_q1_single_chunk_boundary_s1");
  assert.ok(event);
  const item = event.multimodalData[0];
  assert.ok(item);
  assert.equal((item.content as { text?: string }).text, expectedRawTranscript);
  assert.equal((item.content as { rawTranscript?: string }).rawTranscript, expectedRawTranscript);
  assert.equal(repository.parsedSegments.some((segment) => segment.content.includes(finalTurn)), true);
  assert.equal(repository.parsedSegments.some((segment) => segment.content.includes("…")), false);
});

test("ingestLongMemEvalDataset skips existing LongMemEval session events without rebuilding derived memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-reconcile-existing-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "existing_graph_q1",
        question_type: "single-session-user",
        question: "Which note was repeated?",
        answer: "Blue Harbor",
        question_date: "2023/04/10 (Mon) 23:07",
        answer_session_ids: ["existing_shared"],
        haystack_session_ids: ["existing_shared"],
        haystack_sessions: [[{ role: "user", content: "Blue Harbor appeared in my notes.", has_answer: true }]]
      }
    ]),
    "utf8"
  );

  const graphStore = new RecordingGraphMemoryStore();
  const repository = new InMemoryContextEngineRepository(graphStore);
  await ingestLongMemEvalDataset(repository, filePath);
  const countsBefore = {
    parsedSegments: repository.parsedSegments.length,
    facts: repository.facts.length,
    shortTermMemories: repository.shortTermMemories.length,
    llmFactFusionTraces: repository.llmFactFusionTraces.length,
    llmStmAdmissionTraces: repository.llmStmAdmissionTraces.length,
    graphEdges: graphStore.relationEdges.length
  };

  const result = await ingestLongMemEvalDataset(repository, filePath);

  assert.equal(result.ingestedSessions, 0);
  assert.equal(result.skippedSessions, 1);
  assert.equal(repository.parsedSegments.length, countsBefore.parsedSegments);
  assert.equal(repository.facts.length, countsBefore.facts);
  assert.equal(repository.shortTermMemories.length, countsBefore.shortTermMemories);
  assert.equal(repository.llmFactFusionTraces.length, countsBefore.llmFactFusionTraces);
  assert.equal(repository.llmStmAdmissionTraces.length, countsBefore.llmStmAdmissionTraces);
  assert.equal(graphStore.relationEdges.length, countsBefore.graphEdges);
});

test("evaluateLongMemEvalDataset runs ingest LLM once per haystack session event", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  const calls: Array<{ url: string; operation: string }> = [];
  let responseCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);
    calls.push({ url: String(url), operation });

    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (String(url).endsWith("/chat/completions")) {
      if (operation === "answer" || operation === "judge") {
        responseCalls += 1;
        return new Response(JSON.stringify(buildChatCompletionTextResponse(operation === "answer" ? "Alpha" : "yes")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    responseCalls += 1;
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: responseCalls <= 2 ? "Alpha" : "yes" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-shared-session-llm-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "shared_q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        answer_session_ids: ["shared_s1"],
        haystack_session_ids: ["shared_s1"],
        haystack_sessions: [[{ role: "user", content: "The shared code word is Alpha.", has_answer: true }]]
      },
      {
        question_id: "shared_q2",
        question_type: "single-session-user",
        question: "Which word should you remember from the shared chat?",
        answer: "Alpha",
        answer_session_ids: ["shared_s1"],
        haystack_session_ids: ["shared_s1"],
        haystack_sessions: [[{ role: "user", content: "The duplicated sample also points at Alpha.", has_answer: true }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.filter((call) => call.url.endsWith("/chat/completions") && ["fact_fusion", "stm_admission"].includes(call.operation)).map((call) => call.operation),
    ["fact_fusion", "stm_admission", "fact_fusion", "stm_admission"]
  );
  assert.equal(calls.filter((call) => call.operation === "answer" || call.operation === "judge").length, 4);
});

test("evaluateLongMemEvalDataset persists session-level STM before timeline aggregation", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let responseCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);

    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (String(url).endsWith("/chat/completions")) {
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    responseCalls += 1;
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: responseCalls === 1 ? "Alpha" : "yes" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-no-sample-stm-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "no_timeline_q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        answer_session_ids: ["no_timeline_s1"],
        haystack_session_ids: ["no_timeline_s1"],
        haystack_sessions: [[{ role: "user", content: "The code word is Alpha.", has_answer: true }]]
      }
    ]),
    "utf8"
  );

  const graphStore = new RecordingGraphMemoryStore();
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const ownerIds = graphStore.upserted.map((node) => node.ownerId).sort();
  assert.equal(ownerIds.includes("stm_longmemeval_event_no_timeline_q1_no_timeline_s1"), true);
  assert.equal(ownerIds.includes("stm_longmemeval_event_no_timeline_q1"), false);
});

test("evaluateLongMemEvalDataset runs fact fusion and STM admission per haystack session before timeline aggregation", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  const calls: Array<{ url: string; operation: string; eventId?: string }> = [];
  let responseCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);
    const eventId = operation === "fact_fusion" || operation === "stm_admission"
      ? readLongMemEvalIngestEventId(body)
      : undefined;
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.push({
      url: String(url),
      operation,
      ...(eventId ? { eventId } : {})
    });

    if (String(url).endsWith("/chat/completions")) {
      const response = operation === "fact_fusion" || operation === "stm_admission"
        ? buildLongMemEvalIngestChatResponse(body, operation)
        : buildChatCompletionTextResponse(operation === "judge" ? "yes" : "Alpha");
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    responseCalls += 1;
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: responseCalls === 1 ? "Alpha" : "yes" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-nearby-fusion-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "nearby_q1",
        question_type: "multi-session",
        question: "What code word did I mention?",
        question_date: "2023/05/20 (Sat) 12:00",
        answer: "Alpha",
        answer_session_ids: ["near_a"],
        haystack_session_ids: ["near_a", "near_b", "far_c"],
        haystack_dates: [
          "2023/05/20 (Sat) 10:00",
          "2023/05/20 (Sat) 11:00",
          "2023/05/20 (Sat) 18:00"
        ],
        haystack_sessions: [
          [{ role: "user", content: "Alpha appears near the first session." }],
          [{ role: "assistant", content: "The nearby session is within an hour." }],
          [{ role: "user", content: "This isolated session is much later." }]
        ]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.filter((call) => call.operation === "fact_fusion").map((call) => call.eventId),
    [
      "longmemeval_event_nearby_q1_near_a",
      "longmemeval_event_nearby_q1_near_b",
      "longmemeval_event_nearby_q1_far_c"
    ]
  );
  assert.deepEqual(
    calls.filter((call) => call.operation === "stm_admission").map((call) => call.eventId),
    [
      "longmemeval_event_nearby_q1_near_a",
      "longmemeval_event_nearby_q1_near_b",
      "longmemeval_event_nearby_q1_far_c"
    ]
  );
});

test("evaluateLongMemEvalDataset admits session STM in the ordinary ingest pipeline", async () => {
  const originalFetch = globalThis.fetch;
  const operations: string[] = [];
  let activeAdmissionRequests = 0;
  let maxActiveAdmissionRequests = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);
    operations.push(operation);

    if (String(url).endsWith("/chat/completions")) {
      if (operation === "stm_admission") {
        activeAdmissionRequests += 1;
        maxActiveAdmissionRequests = Math.max(maxActiveAdmissionRequests, activeAdmissionRequests);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeAdmissionRequests -= 1;
      }
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-sample-stm-batch-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "First?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "Alpha is the first answer." }]]
      },
      {
        question_id: "q2",
        question_type: "multi-session",
        question: "Second?",
        answer: "Alpha",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s2"],
        haystack_sessions: [[{ role: "user", content: "Alpha is the second answer." }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      evalBatchSize: 2,
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.deepEqual(
      operations.filter((operation) => operation === "fact_fusion" || operation === "stm_admission"),
      ["fact_fusion", "stm_admission", "fact_fusion", "stm_admission"]
    );
    assert.equal(maxActiveAdmissionRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset can disable ingest LLM calls for benchmark runs", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  let responseCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const nextUrl = String(url);
    urls.push(nextUrl);
    if (nextUrl.endsWith("/chat/completions")) {
      throw new Error("ingest LLM should be disabled");
    }
    responseCalls += 1;
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: responseCalls === 1 ? "Alpha" : "yes" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-disable-ingest-llm-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "disable_ingest_q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        answer_session_ids: ["disable_ingest_s1"],
        haystack_session_ids: ["disable_ingest_s1"],
        haystack_sessions: [[{ role: "user", content: "The code word is Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      disableIngestLlm: true,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.some((url) => url.endsWith("/chat/completions")), false);
  assert.equal(urls.filter((url) => url.endsWith("/responses")).length, 2);
});

test("evaluateLongMemEvalDataset can skip STM admission without disabling fact fusion", async () => {
  const originalFetch = globalThis.fetch;
  const operations: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);
    if (String(url).endsWith("/chat/completions")) {
      operations.push(operation);
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-skip-stm-admission-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "skip_stm_q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        answer_session_ids: ["skip_stm_s1"],
        haystack_session_ids: ["skip_stm_s1"],
        haystack_sessions: [[{ role: "user", content: "The code word is Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      skipStmAdmission: true,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(operations, ["fact_fusion"]);
});

test("evaluateLongMemEvalDataset aborts in-flight LLM requests when cancelled", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requestStarted: (() => void) | undefined;
  const requestStartedPromise = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const requestAbortedPromise = new Promise<void>((resolve) => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestStarted?.();
      init?.signal?.addEventListener("abort", () => resolve(), { once: true });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch;
  });

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-cancel-inflight-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "cancel_q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "Alpha",
        answer_session_ids: ["cancel_s1"],
        haystack_session_ids: ["cancel_s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    const evaluation = evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      signal: controller.signal
    } as Parameters<typeof evaluateLongMemEvalDataset>[1] & { signal: AbortSignal });

    await Promise.race([
      requestStartedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("LongMemEval LLM request did not start")), 500))
    ]);
    controller.abort();

    await Promise.race([
      requestAbortedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("LongMemEval LLM request was not aborted")), 500))
    ]);
    await assert.rejects(
      Promise.race([
        evaluation,
        new Promise((_, reject) => setTimeout(() => reject(new Error("LongMemEval evaluation did not stop after cancellation")), 500))
      ]),
      /cancelled|aborted/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset cancellation stops sample workers from claiming new samples", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { input?: unknown } : {};
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-cancel-worker-claim-"));
  const filePath = join(dir, "sample.json");
  await writeFile(filePath, JSON.stringify(Array.from({ length: 4 }, (_, index) => ({
    question_id: `cancel_worker_q${index + 1}`,
    question_type: "single-session-user",
    question: `Question ${index + 1}?`,
    answer: "Alpha",
    answer_session_ids: [`cancel_worker_s${index + 1}`],
    haystack_session_ids: [`cancel_worker_s${index + 1}`],
    haystack_sessions: [[{ role: "user", content: `Alpha ${index + 1}.` }]]
  }))), "utf8");

  const startedSamples: number[] = [];
  try {
    await assert.rejects(evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      ingestSampleConcurrency: 2,
      signal: controller.signal,
      onSampleStage: (event) => {
        if (event.stage !== "ingestion" || event.status !== "started") return;
        startedSamples.push(event.sampleIndex);
        if (startedSamples.length === 2) controller.abort();
      }
    }), /cancelled|aborted/i);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(startedSamples.sort((a, b) => a - b), [1, 2]);
});

test("cancelled LongMemEval ingestion rolls back the unfinished session", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let factFusionStarted: (() => void) | undefined;
  const factFusionStartedPromise = new Promise<void>((resolve) => {
    factFusionStarted = resolve;
  });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/embeddings")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { input?: unknown } : {};
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    assert.equal(readOpenAiOperation(body), "fact_fusion");
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      factFusionStarted?.();
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-cancel-rollback-"));
  const filePath = join(dir, "sample.json");
  const storePath = join(dir, "context.sqlite");
  await writeFile(filePath, JSON.stringify([{
    question_id: "cancel_rollback_q1",
    question_type: "single-session-user",
    question: "What did I mention?",
    answer: "Alpha",
    answer_session_ids: ["cancel_rollback_s1"],
    haystack_session_ids: ["cancel_rollback_s1"],
    haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
  }]), "utf8");
  const repository = new SqliteContextEngineRepository(storePath);

  try {
    const ingestion = ingestLongMemEvalDataset(repository, filePath, {
      llm: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
      signal: controller.signal
    });

    await Promise.race([
      factFusionStartedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("LongMemEval fact fusion did not start")), 500))
    ]);
    controller.abort();
    await assert.rejects(ingestion, /cancelled|aborted/i);
  } finally {
    globalThis.fetch = originalFetch;
    repository.close();
  }

  const reopened = new SqliteContextEngineRepository(storePath);
  try {
    const snapshot = reopened.getDebugSnapshot();
    for (const [name, items] of Object.entries({
      memoryEvents: snapshot.memoryEvents,
      parsedSegments: snapshot.parsedSegments,
      facts: snapshot.facts,
      shortTermMemories: snapshot.shortTermMemories,
      longTermMemories: snapshot.longTermMemories,
      indexEntries: snapshot.indexEntries,
      textIndexEntries: snapshot.textIndexEntries,
      vectorIndexEntries: snapshot.vectorIndexEntries,
      graphMemoryNodes: snapshot.graphMemoryNodes,
      llmFactFusionTraces: snapshot.llmFactFusionTraces,
      llmStmAdmissionTraces: snapshot.llmStmAdmissionTraces,
      pipelineTasks: snapshot.pipelineTasks,
      changeEvents: snapshot.changeEvents
    })) {
      assert.equal(items.length, 0, `${name} should be empty after cancellation rollback`);
    }
  } finally {
    reopened.close();
  }
});

test("evaluateLongMemEvalDataset can evaluate model only after samples are already ingested", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; operation: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);
    calls.push({ url: String(url), operation });
    if (String(url).endsWith("/chat/completions")) {
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-model-only-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "model_only_q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        answer_session_ids: ["model_only_s1"],
        haystack_session_ids: ["model_only_s1"],
        haystack_sessions: [[{ role: "user", content: "The code word is Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
    calls.length = 0;

    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      modelOnlyEvaluation: true,
      enableLtmReinforcement: true,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => call.operation), ["answer", "judge"]);
});

test("evaluateLongMemEvalDataset streams a json array and aggregates official qa metrics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const serialized = JSON.stringify(body);
    const answer = serialized.includes("Which one first?") ? "Beta" : "Alpha";
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, answer)),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-eval-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "temporal-reasoning",
        question: "When did it happen?",
        answer: "Alpha",
        question_date: "2023/04/10 (Mon) 23:07",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "hello" },
            { role: "assistant", content: "world" }
          ],
          [
            { role: "user", content: "answer" },
            { role: "assistant", content: "Alpha" }
          ]
        ]
      },
      {
        question_id: "q2",
        question_type: "multi-session",
        question: "Which one first?",
        answer: "Beta",
        question_date: "2023/04/11 (Tue) 09:10",
        answer_session_ids: ["t3", "t1"],
        haystack_session_ids: ["t1", "t2", "t3"],
        haystack_sessions: [
          [{ role: "user", content: "t1" }],
          [{ role: "user", content: "t2" }],
          [{ role: "user", content: "t3" }]
        ]
      }
    ]),
    "utf8"
  );

  let report!: Awaited<ReturnType<typeof evaluateLongMemEvalDataset>>;
  try {
    report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1, 2, 3],
      graphStore: new RecordingGraphMemoryStore()
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(report.totalSamples, 2);
  assert.equal(report.questionTypeCounts["temporal-reasoning"], 1);
  assert.equal(report.questionTypeCounts["multi-session"], 1);
  assert.equal(report.questionTypeAccuracy["temporal-reasoning"]?.judgeAccuracy, 1);
  assert.equal(report.questionTypeAccuracy["multi-session"]?.judgeAccuracy, 1);
  assert.equal(report.ingestion.totalSessions, 5);
  assert.equal(report.samples.length, 2);
  assert.equal(report.metrics[1] !== undefined, true);
  assert.equal(report.metrics[2] !== undefined, true);
  assert.equal(report.judge.model.length > 0, true);
});

test("evaluateLongMemEvalDataset scores retrieval from selected context rather than haystack order", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "The answer is Blue Harbor.")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-actual-retrieval-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "actual_q1",
        question_type: "single-session-user",
        question: "Which harbor did I mention?",
        answer: "Blue Harbor",
        question_date: "2023/04/10 (Mon) 23:07",
        answer_session_ids: ["answer_s2"],
        haystack_session_ids: ["noise_s1", "answer_s2"],
        haystack_sessions: [
          [
            { role: "user", content: "I like red bicycles." },
            { role: "assistant", content: "Noted." }
          ],
          [
            { role: "user", content: "I mentioned Blue Harbor last week.", has_answer: true },
            { role: "assistant", content: "I will remember Blue Harbor." }
          ]
        ]
      }
    ]),
    "utf8"
  );

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      ingestSampleConcurrency: 2,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.equal(report.samples[0]?.retrieval[0]?.recallAtK, 1);
    assert.equal(report.samples[0]?.retrieval[0]?.recallAllAtK, 1);
    assert.equal(report.metrics[1]?.recallAtK, 1);
    assert.equal(report.metrics[1]?.recallAllAtK, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset uses the graph-backed STM/LTM store for LongMemEval retrieval", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Blue Harbor")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const graphStore = new RecordingGraphMemoryStore();
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-graph-store-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "graph_q1",
        question_type: "single-session-user",
        question: "Which harbor did I mention?",
        answer: "Blue Harbor",
        question_date: "2023/04/10 (Mon) 23:07",
        answer_session_ids: ["answer_s2"],
        haystack_session_ids: ["noise_s1", "answer_s2"],
        haystack_sessions: [
          [
            { role: "user", content: "I like red bicycles." },
            { role: "assistant", content: "Noted." }
          ],
          [
            { role: "user", content: "I mentioned Blue Harbor last week.", has_answer: true },
            { role: "assistant", content: "I will remember Blue Harbor." }
          ]
        ]
      }
    ]),
    "utf8"
  );

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.equal(report.samples[0]?.retrieval[0]?.recallAnyAtK, 1);
    assert.equal(graphStore.upserted.some((node) => node.ownerType === "stm"), true);
    assert.equal(graphStore.vectorSearches.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset attributes compressed answer snippets to their source session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Blue Harbor")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const longAnswerSession = [
    "I was reviewing old travel notes and cleaning up unrelated reminders.",
    "The harbor I mentioned was Blue Harbor, which stood out because of the bright marina lights.",
    ...Array.from({ length: 30 }, (_, index) => `Extra planning detail ${index} about hotels, train schedules, snacks, and luggage.`)
  ].join(" ");
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-compressed-source-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "compressed_q1",
        question_type: "single-session-user",
        question: "Which harbor did I mention?",
        answer: "Blue Harbor",
        question_date: "2023/04/10 (Mon) 23:07",
        answer_session_ids: ["answer_long_s2"],
        haystack_session_ids: ["noise_long_s1", "answer_long_s2"],
        haystack_sessions: [
          [{ role: "user", content: "I like red bicycles and green notebooks." }],
          [{ role: "user", content: longAnswerSession, has_answer: true }]
        ]
      }
    ]),
    "utf8"
  );

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.equal(report.samples[0]?.retrieval[0]?.recallAnyAtK, 1);
    assert.equal(report.metrics[1]?.recallAnyAtK, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset adds chronological evidence ordered by session date", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-chronological-evidence-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "timeline_q1",
        question_type: "temporal-reasoning",
        question: "What was my launch code before I changed it?",
        answer: "Alpha",
        question_date: "2023/04/20 (Thu) 09:00",
        answer_session_ids: ["early_s1", "late_s2"],
        haystack_session_ids: ["late_s2", "early_s1"],
        haystack_dates: ["2023/04/12 (Wed) 10:00", "2023/04/01 (Sat) 10:00"],
        haystack_sessions: [
          [{ role: "user", content: "I changed my launch code to Beta after the first launch.", has_answer: true }],
          [{ role: "user", content: "My launch code was Alpha before the change.", has_answer: true }]
        ]
      }
    ]),
    "utf8"
  );

  const infos: Array<{ fields: Record<string, unknown>; message: string }> = [];
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [2],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      logger: {
        info(fields: Record<string, unknown>, message: string) {
          if (message === "longmemeval llm request context") infos.push({ fields, message });
        },
        warn() {},
        error() {}
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const answer = infos.find((item) => item.fields.stage === "answer");
  const promptPreview = String(answer?.fields.promptPreview ?? "");
  assert.equal(promptPreview.includes("Chronological Evidence"), true);
  assert.equal(promptPreview.indexOf("[2023/04/01 (Sat) 10:00] early_s1") < promptPreview.indexOf("[2023/04/12 (Wed) 10:00] late_s2"), true);
});

test("evaluateLongMemEvalDataset includes question date in answer prompt for temporal calculations", async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  let responseCount = 0;
  globalThis.fetch = (async (_url, init) => {
    responseCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input?: Array<{ role: string; content: string }>;
      messages?: Array<{ role: string; content: string }>;
    };
    const userPrompt = [...(body.input ?? []), ...(body.messages ?? [])]
      .find((item) => item.role === "user")?.content;
    if (userPrompt) prompts.push(userPrompt);
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(init?.body ?? "").includes("Is the model response correct?") ? "yes" : "4" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-question-date-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "temporal_date_q1",
        question_type: "temporal-reasoning",
        question: "How many weeks ago did I meet up with my aunt and receive the crystal chandelier?",
        answer: "4",
        question_date: "2023/04/29 (Sat) 09:00",
        answer_session_ids: ["answer_s1"],
        haystack_session_ids: ["answer_s1"],
        haystack_dates: ["2023/04/01 (Sat) 09:00"],
        haystack_sessions: [
          [{ role: "user", content: "I met up with my aunt and received the crystal chandelier.", has_answer: true }]
        ]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts[0]?.includes("Question Date: 2023/04/29 (Sat) 09:00"), true);
});

test("evaluateLongMemEvalDataset keeps highly relevant answer evidence when earlier noisy sessions exceed evidence budget", async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  let responseCount = 0;
  globalThis.fetch = (async (_url, init) => {
    responseCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input?: Array<{ role: string; content: string }>;
      messages?: Array<{ role: string; content: string }>;
    };
    const userPrompt = [...(body.input ?? []), ...(body.messages ?? [])]
      .find((item) => item.role === "user")?.content;
    if (userPrompt) prompts.push(userPrompt);
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(init?.body ?? "").includes("Is the model response correct?") ? "yes" : "Blue Harbor" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-relevant-evidence-budget-"));
  const filePath = join(dir, "sample.json");
  const noisySessions = Array.from({ length: 8 }, (_, index) => ({
    id: `noise_${index}`,
    date: `2023/04/0${index + 1} (Sat) 09:00`,
    session: [
      {
        role: "user",
        content: `This is an unrelated harbor logistics note ${index}. `.repeat(90)
      }
    ]
  }));
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "relevant_budget_q1",
        question_type: "single-session-user",
        question: "Which harbor did I mention?",
        answer: "Blue Harbor",
        question_date: "2023/04/20 (Thu) 09:00",
        answer_session_ids: ["answer_late"],
        haystack_session_ids: [...noisySessions.map((item) => item.id), "answer_late"],
        haystack_dates: [...noisySessions.map((item) => item.date), "2023/04/19 (Wed) 09:00"],
        haystack_sessions: [
          ...noisySessions.map((item) => item.session),
          [{ role: "user", content: "I mentioned Blue Harbor during yesterday's planning.", has_answer: true }]
        ]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.some((prompt) =>
    prompt.includes("You are answering a LongMemEval question.") && prompt.includes("Blue Harbor")
  ), true);
});

test("evaluateLongMemEvalDataset does not let earlier noisy sessions crowd out later answer evidence", async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  let responseCount = 0;
  globalThis.fetch = (async (_url, init) => {
    responseCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input?: Array<{ role: string; content: string }>;
      messages?: Array<{ role: string; content: string }>;
    };
    const userPrompt = [...(body.input ?? []), ...(body.messages ?? [])]
      .find((item) => item.role === "user")?.content;
    if (userPrompt) prompts.push(userPrompt);
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(init?.body ?? "").includes("Is the model response correct?") ? "yes" : "The Glass Menagerie" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-late-answer-budget-"));
  const filePath = join(dir, "sample.json");
  const noisySessions = Array.from({ length: 8 }, (_, index) => ({
    id: `noise_${index}`,
    date: `2023/05/2${index} (Sat) 09:00`,
    session: [
      {
        role: "user",
        content: `I attended community events and theater-adjacent planning meetings ${index}. `.repeat(80)
      }
    ]
  }));
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "late_answer_q1",
        question_type: "single-session-user",
        question: "What play did I attend at the local community theater?",
        answer: "The Glass Menagerie",
        question_date: "2023/05/30 (Tue) 22:53",
        answer_session_ids: ["answer_late"],
        haystack_session_ids: [...noisySessions.map((item) => item.id), "answer_late"],
        haystack_dates: [...noisySessions.map((item) => item.date), "2023/05/29 (Mon) 09:00"],
        haystack_sessions: [
          ...noisySessions.map((item) => item.session),
          [
            {
              role: "user",
              content: "The play I attended at the local community theater was The Glass Menagerie.",
              has_answer: true
            }
          ]
        ]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.some((prompt) =>
    prompt.includes("You are answering a LongMemEval question.") && prompt.includes("The Glass Menagerie")
  ), true);
});

test("evaluateLongMemEvalDataset skips ingestion for session events already stored by a previous run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-skip-rerun-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "clean_q1",
        question_type: "single-session-user",
        question: "What was mentioned?",
        answer: "Alpha",
        question_date: "2023/04/10 (Mon) 23:07",
        answer_session_ids: ["clean_s1"],
        haystack_session_ids: ["clean_s1"],
        haystack_sessions: [
          [
            { role: "user", content: "I mentioned Alpha." },
            { role: "assistant", content: "Noted." }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const graphStore = new RecordingGraphMemoryStore();
  const first = await evaluateLongMemEvalDataset(filePath, { ks: [1], graphStore });
  const second = await evaluateLongMemEvalDataset(filePath, { ks: [1], graphStore });

  assert.equal(first.ingestion.ingestedSessions, 1);
  assert.equal(first.ingestion.skippedSessions, 0);
  assert.equal(second.ingestion.ingestedSessions, 0);
  assert.equal(second.ingestion.skippedSessions, 1);
});

test("evaluateLongMemEvalDataset emits sample level progress across ingest timeline ltm answer and judge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-progress-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s2",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "alpha" }
          ],
          [
            { role: "user", content: "beta" }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const stages: string[] = [];
  const report = await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    onProgress: (progress) => {
      stages.push(progress.stage);
    }
  });

  assert.equal(report.totalSamples, 1);
  assert.equal(stages.includes("ingest"), true);
  assert.equal(stages.includes("timeline_aggregation"), true);
  assert.equal(stages.includes("answer"), true);
  assert.equal(stages.includes("judge"), true);
  assertStageBarrier(stages.map((stage) => ({ stage })), "ingest", "timeline_aggregation");
  assertStageBarrier(stages.map((stage) => ({ stage })), "timeline_aggregation", "answer");
  assertStageBarrier(stages.map((stage) => ({ stage })), "answer", "judge");
});

test("evaluateLongMemEvalDataset ingests session events without background pipeline wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-ingest-no-stm-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What degree did I graduate with?",
        answer: "Bachelor",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I graduated with a Bachelor degree." }]]
      }
    ]),
    "utf8"
  );

  const ingestStages: Array<string | undefined> = [];
  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    onProgress: (progress) => {
      if (progress.stage === "ingest") {
        ingestStages.push(progress.ingestStage);
      }
    }
  });

  assert.equal(ingestStages.includes("pipeline_wait"), false);
  assert.equal(ingestStages.includes("save_event"), true);
  assert.equal(ingestStages.includes("finalize"), true);
});

test("evaluateLongMemEvalDataset emits finalize progress when sample ingestion completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-finalize-progress-"));
  const filePath = join(dir, "sample.json");
  const longTranscript = Array.from({ length: 120 }, (_, index) => `token_${index}`).join(" ");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What degree did I graduate with?",
        answer: "Bachelor",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: longTranscript }]]
      }
    ]),
    "utf8"
  );

  const finalizeProgress: Array<{ stageProgress?: number; stageMessage?: string }> = [];
  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    onProgress: (progress) => {
      if (progress.stage === "ingest" && progress.ingestStage === "finalize") {
        const item: { stageProgress?: number; stageMessage?: string } = {};
        if (typeof progress.stageProgress === "number") item.stageProgress = progress.stageProgress;
        if (typeof progress.stageMessage === "string") item.stageMessage = progress.stageMessage;
        finalizeProgress.push(item);
      }
    }
  });

  assert.equal(finalizeProgress.length, 1);
  assert.equal(finalizeProgress[0]?.stageMessage, "haystack session 入库完成");
  assert.equal(typeof finalizeProgress[0]?.stageProgress, "number");
});

test("ingest and retrieval isolate repeated session ids across LongMemEval questions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-dedupe-session-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "First",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [{ role: "user", content: "alpha shared session" }],
          [{ role: "user", content: "alpha shared session" }]
        ]
      },
      {
        question_id: "q2",
        question_type: "multi-session",
        question: "Second",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "beta" }]]
      }
    ]),
    "utf8"
  );

  const repository = new InMemoryContextEngineRepository();
  const result = await ingestLongMemEvalDataset(repository, filePath, { llm: { apiKey: "" } });

  assert.equal(result.totalSessions, 3);
  assert.equal(result.ingestedSessions, 3);
  assert.deepEqual(repository.memoryEvents.map((event) => event.eventId).sort(), [
    "longmemeval_event_q1_s1",
    "longmemeval_event_q1_s2",
    "longmemeval_event_q2_s1"
  ]);
  assert.deepEqual(repository.memoryEvents.map((event) => event.sourceRefs?.[0]?.sourceId).sort(), [
    "longmemeval_event_q1_s1",
    "longmemeval_event_q1_s2",
    "longmemeval_event_q2_s1"
  ]);
  assert.deepEqual(repository.memoryEvents.map((event) => event.multimodalData[0]?.itemId).sort(), [
    "item_q1_s1",
    "item_q1_s2",
    "item_q2_s1"
  ]);
  assert.deepEqual(repository.memoryEvents.map((event) => event.contextScopeId).sort(), [
    "longmemeval:q1",
    "longmemeval:q1",
    "longmemeval:q2"
  ]);
  assert.equal(repository.facts.length > 0, true);
  assert.equal(repository.facts.every((fact) => fact.contextScopeId === (
    fact.linkedEventIds[0]?.includes("_q1_") ? "longmemeval:q1" : "longmemeval:q2"
  )), true);
  assert.equal(repository.timelineFusionTasks.length, 0);

  const q1Search = await searchContext(repository, {
    q: "shared session",
    layer: "all",
    tenantId: "local",
    principalId: "longmemeval",
    contextScopeId: "longmemeval:q1",
    includeInactive: true
  });
  const q2Search = await searchContext(repository, {
    q: "shared session",
    layer: "all",
    tenantId: "local",
    principalId: "longmemeval",
    contextScopeId: "longmemeval:q2",
    includeInactive: true
  });
  const memorySources = repository.getDebugSnapshot().shortTermMemories.map((memory) => ({
    id: memory.memoryDataId,
    content: memory.content,
    sources: memory.sourceRefs.map((source) => source.sourceId)
  }));
  assert.equal(q1Search.results.length > 0, true, JSON.stringify(memorySources));
  assert.equal(q2Search.results.length > 0, true, JSON.stringify(memorySources));
  assert.equal(q1Search.results.every((item) => item.sourceRefs.some((source) => source.sourceId.startsWith("longmemeval_event_q1_"))), true);
  assert.equal(q1Search.results.some((item) => item.sourceRefs.some((source) => source.sourceId === "longmemeval_event_q1_s1")), true);
  assert.equal(q1Search.results.some((item) => item.sourceRefs.some((source) => source.sourceId === "longmemeval_event_q1_s2")), true);
  assert.equal(q2Search.results.every((item) => item.sourceRefs.some((source) => source.sourceId === "longmemeval_event_q2_s1")), true);
  assert.equal(q1Search.results.some((item) => item.sourceRefs.some((source) => source.sourceId === "longmemeval_event_q2_s1")), false);
  assert.equal(q2Search.results.some((item) => item.sourceRefs.some((source) => source.sourceId === "longmemeval_event_q1_s1")), false);
});

test("evaluateLongMemEvalDataset completes each sample pipeline before starting the next sample", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const operation = readOpenAiOperation(body);
    const text = operation === "judge" ? "yes" : "Alpha";
    return new Response(JSON.stringify(buildChatCompletionTextResponse(text)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-per-sample-stage-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "result.jsonl");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s2",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "alpha" }
          ],
          [
            { role: "user", content: "beta" }
          ]
        ]
      },
      {
        question_id: "q2",
        question_type: "multi-session",
        question: "Which session next?",
        answer: "t2",
        answer_session_ids: ["t2"],
        haystack_session_ids: ["t1", "t2"],
        haystack_sessions: [
          [
            { role: "user", content: "gamma" }
          ],
          [
            { role: "user", content: "delta" }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const events: Array<{ sampleIndex: number; stage: string; status: string; reason?: string }> = [];
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      diagnosticsPath,
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true,
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      onSampleStage: (event) => {
        events.push(event);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const q1 = events.filter((event) => event.sampleIndex === 1);
  assert.deepEqual(q1.map(({ stage, status }) => `${stage}:${status}`), [
    "ingestion:started",
    "stm_admission:skipped",
    "ingestion:succeeded",
    "timeline_aggregation:started",
    "timeline_aggregation:succeeded",
    "ltm:skipped",
    "answer:started",
    "answer:succeeded",
    "judge:started",
    "judge:succeeded",
    "result_commit:started",
    "result_commit:succeeded"
  ]);
  assert.equal(q1.find((event) => event.stage === "stm_admission")?.reason, "stm_admission_skipped");
  assert.equal(q1.find((event) => event.stage === "ltm")?.reason, "ltm_dreaming_skipped");
  const q1Commit = events.findIndex((event) => event.sampleIndex === 1 && event.stage === "result_commit" && event.status === "succeeded");
  const q2Ingest = events.findIndex((event) => event.sampleIndex === 2 && event.stage === "ingestion" && event.status === "started");
  assert.equal(q2Ingest > q1Commit, true);
  const rows = (await readFile(diagnosticsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sampleIndex: number });
  assert.deepEqual(rows.map((row) => row.sampleIndex), [1, 2]);
});

test("evaluateLongMemEvalDataset keeps two complete sample pipelines isolated by question scope", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  const answerPrompts: string[] = [];
  let activeAnswers = 0;
  let maxActiveAnswers = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const operation = readOpenAiOperation(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const user = messages[1] as { content?: unknown } | undefined;
    const prompt = typeof user?.content === "string" ? user.content : "";
    if (operation === "answer" && !prompt.includes("Is the model response correct?")) {
      answerPrompts.push(prompt);
      activeAnswers += 1;
      maxActiveAnswers = Math.max(maxActiveAnswers, activeAnswers);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeAnswers -= 1;
    }
    const text = operation === "judge"
      ? "yes"
      : prompt.includes("ALPHA_SCOPE_ONLY") ? "ALPHA_SCOPE_ONLY" : "BETA_SCOPE_ONLY";
    return new Response(JSON.stringify(buildChatCompletionTextResponse(text)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-two-scope-pipelines-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "result.jsonl");
  await writeFile(filePath, JSON.stringify([
    {
      question_id: "scope_q1",
      question_type: "single-session-user",
      question: "What is the alpha-only value?",
      answer: "ALPHA_SCOPE_ONLY",
      answer_session_ids: ["shared_session"],
      haystack_session_ids: ["shared_session"],
      haystack_sessions: [[{ role: "user", content: "The alpha-only value is ALPHA_SCOPE_ONLY." }]]
    },
    {
      question_id: "scope_q2",
      question_type: "single-session-user",
      question: "What is the beta-only value?",
      answer: "BETA_SCOPE_ONLY",
      answer_session_ids: ["shared_session"],
      haystack_session_ids: ["shared_session"],
      haystack_sessions: [[{ role: "user", content: "The beta-only value is BETA_SCOPE_ONLY." }]]
    }
  ]), "utf8");

  try {
    const graphStore = new RecordingGraphMemoryStore();
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      storeNamespace: "two_scope_test",
      modelRunId: "scope-model",
      graphStore,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
    answerPrompts.length = 0;
    maxActiveAnswers = 0;

    const activeSampleSnapshots: number[][] = [];
    const processedSampleCounts: number[] = [];
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      diagnosticsPath,
      storeNamespace: "two_scope_test",
      modelRunId: "scope-model",
      modelOnlyEvaluation: true,
      answerOnlyEvaluation: true,
      ingestSampleConcurrency: 2,
      answerConcurrency: 2,
      judgeConcurrency: 2,
      graphStore,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      onProgress: (progress) => {
        activeSampleSnapshots.push(progress.activeSamples.map((sample) => sample.sampleIndex));
        processedSampleCounts.push(progress.processedSamples);
      }
    });
    assert.deepEqual(report.samples.map((sample) => sample.hypothesis), ["ALPHA_SCOPE_ONLY", "BETA_SCOPE_ONLY"]);
    assert.deepEqual(report.samples.map((sample) => sample.retrieval[0]?.recallAtK), [1, 1]);
    assert.equal(activeSampleSnapshots.some((indices) => indices.includes(1) && indices.includes(2)), true);
    assert.equal(processedSampleCounts.every((count, index) => index === 0 || count >= processedSampleCounts[index - 1]!), true);
    assert.equal(processedSampleCounts.at(-1), 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(answerPrompts.length, 2);
  assert.equal(maxActiveAnswers, 2);
  const alphaPrompt = answerPrompts.find((prompt) => prompt.includes("What is the alpha-only value?"));
  const betaPrompt = answerPrompts.find((prompt) => prompt.includes("What is the beta-only value?"));
  assert.equal(alphaPrompt?.includes("ALPHA_SCOPE_ONLY"), true);
  assert.equal(alphaPrompt?.includes("BETA_SCOPE_ONLY"), false);
  assert.equal(betaPrompt?.includes("BETA_SCOPE_ONLY"), true);
  assert.equal(betaPrompt?.includes("ALPHA_SCOPE_ONLY"), false);

  const rows = (await readFile(diagnosticsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    questionId: string;
    hypothesis: string;
    timelineSummaryPreview: string;
    answerRankedSessionIds: string[];
    answerContext: { scope: { questionId: string; contextScopeId: string; modelRunId: string; storeNamespace: string }; selectedItems: Array<{ sourceIds: string[] }> };
    contextPack: { scope: { questionId: string; contextScopeId: string; modelRunId: string; storeNamespace: string }; selectedItems: Array<{ sourceIds: string[] }> };
    scope: { questionId: string; contextScopeId: string; modelRunId: string; storeNamespace: string };
  });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const own = row.questionId === "scope_q1"
      ? { value: "ALPHA_SCOPE_ONLY", other: "BETA_SCOPE_ONLY" }
      : { value: "BETA_SCOPE_ONLY", other: "ALPHA_SCOPE_ONLY" };
    assert.equal(row.hypothesis, own.value);
    assert.equal(row.timelineSummaryPreview.includes(own.value), true);
    assert.equal(row.timelineSummaryPreview.includes(own.other), false);
    assert.deepEqual(row.answerRankedSessionIds, ["shared_session"]);
    assert.deepEqual(row.scope, {
      questionId: row.questionId,
      contextScopeId: `longmemeval:${row.questionId}`,
      modelRunId: "scope-model",
      storeNamespace: "two_scope_test"
    });
    assert.deepEqual(row.answerContext.scope, row.scope);
    assert.deepEqual(row.contextPack.scope, row.scope);
    const sourceIds = row.answerContext.selectedItems.flatMap((item) => item.sourceIds);
    assert.equal(sourceIds.length > 0, true);
    assert.equal(sourceIds.every((sourceId) => sourceId.startsWith(`longmemeval_event_${row.questionId}_`)), true);
  }
});

test("evaluateLongMemEvalDataset reports dreaming as skipped even when LTM reinforcement is requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-ingest-stage-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What degree did I graduate with?",
        answer: "Bachelor",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I graduated with a Bachelor degree." }]]
      }
    ]),
    "utf8"
  );

  const batchEvents: Array<{ stage: string; batchIndex: number | undefined; batchCount: number | undefined; batchMessage: string | undefined }> = [];
  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    enableLtmReinforcement: true,
    onProgress: (progress) => {
      batchEvents.push({
        stage: progress.stage,
        batchIndex: progress.batchIndex,
        batchCount: progress.batchCount,
        batchMessage: progress.batchMessage
      });
    }
  });

  assert.equal(batchEvents.some((item) => item.stage === "ingest" && item.batchMessage === "样本入库批次"), true);
  assert.equal(batchEvents.some((item) => item.stage === "timeline_aggregation"), true);
  assert.equal(batchEvents.some((item) => item.stage === "ltm" && item.batchMessage === "跳过 LTM 做梦"), true);
  assert.equal(batchEvents.some((item) => item.stage === "ltm" && item.batchMessage?.includes("候选")), false);
});

test("evaluateLongMemEvalDataset yields between timeline aggregation samples", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-timeline-yield-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "First?",
        answer: "alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "alpha" }]]
      },
      {
        question_id: "q2",
        question_type: "single-session-user",
        question: "Second?",
        answer: "beta",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s2"],
        haystack_sessions: [[{ role: "user", content: "beta" }]]
      }
    ]),
    "utf8"
  );

  let yieldedAfterFirstTimelineSample = false;
  let secondTimelineSampleObservedAfterYield = false;

  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    onProgress: (progress) => {
      if (progress.stage !== "timeline_aggregation") return;
      if (progress.currentSampleIndex === 1) {
        setImmediate(() => {
          yieldedAfterFirstTimelineSample = true;
        });
      }
      if (progress.currentSampleIndex === 2) {
        secondTimelineSampleObservedAfterYield = yieldedAfterFirstTimelineSample;
      }
    }
  });

  assert.equal(secondTimelineSampleObservedAfterYield, true);
});

test("evaluateLongMemEvalDataset keeps ingest request context logs off by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-parser-log-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What degree did I graduate with?",
        answer: "Bachelor",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I graduated with a Bachelor degree." }]]
      }
    ]),
    "utf8"
  );

  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    logger: {
      info(fields: Record<string, unknown>, message: string) {
        if (message === "longmemeval llm request context" && fields.stage === "ingest") logs.push({ message, fields });
      },
      warn() {},
      error() {}
    }
  });

  assert.equal(logs.length, 0);
});

test("evaluateLongMemEvalDataset can opt into ingest request context logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-save-log-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What degree did I graduate with?",
        answer: "Bachelor",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I graduated with a Bachelor degree." }]]
      }
    ]),
    "utf8"
  );

  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    logIngestRequestContext: true,
    logger: {
      info(fields: Record<string, unknown>, message: string) {
        if (message === "longmemeval llm request context" && fields.stage === "ingest") {
          logs.push({ message, fields });
        }
      },
      warn() {},
      error() {}
    }
  });

  assert.equal(logs.some((item) => item.fields.phase === "sample_timeline_event_input"), true);
  assert.equal(logs.some((item) => item.fields.phase === "sample_timeline_event_saved"), true);
  assert.equal(logs.some((item) => item.fields.phase === "parser_input"), false);
  assert.equal(logs.some((item) => item.fields.phase === "parser_output"), false);
});

test("evaluateLongMemEvalDataset does not dream when LTM reinforcement is requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-ltm-filter-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s1",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [{ role: "user", content: "alpha" }],
          [{ role: "user", content: "beta" }]
        ]
      }
    ]),
    "utf8"
  );

  const events: Array<Record<string, unknown>> = [];
  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    enableLtmReinforcement: true,
    logger: {
      info(fields: Record<string, unknown>, message: string) {
        if (message === "longmemeval llm request context" && fields.stage === "ltm") {
          events.push(fields);
        }
      },
      warn() {},
      error() {}
    }
  });

  assert.deepEqual(events, []);
});

test("evaluateLongMemEvalDataset does not dream for populated or empty source sessions", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);

    if (String(url).endsWith("/chat/completions")) {
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    responseCalls += 1;
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: responseCalls % 2 === 1 ? "Alpha" : "yes" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-ltm-empty-source-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "source_q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "Alpha",
        answer_session_ids: ["source_s1"],
        haystack_session_ids: ["source_s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      },
      {
        question_id: "empty_source_q2",
        question_type: "single-session-user",
        question: "What source sessions are available?",
        answer: "none",
        answer_session_ids: [],
        haystack_session_ids: [],
        haystack_sessions: []
      }
    ]),
    "utf8"
  );

  const events: Array<Record<string, unknown>> = [];
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      enableLtmReinforcement: true,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      logger: {
        info(fields: Record<string, unknown>, message: string) {
          if (message === "longmemeval llm request context" && fields.stage === "ltm") {
            events.push(fields);
          }
        },
        warn() {},
        error() {}
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(events, []);
});

test("evaluateLongMemEvalDataset always skips ltm reinforcement requests", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; operation: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);
    calls.push({ url: String(url), operation });
    if (String(url).endsWith("/chat/completions")) {
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Alpha" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-skip-ltm-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => call.operation),
    ["fact_fusion", "stm_admission", "answer", "judge"]
  );
});

test("evaluateLongMemEvalDataset skips ltm dreaming when reinforcement is enabled", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; operation: string }> = [];
  const ltmRequestContexts: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const dimensions = getContextEngineConfig().embedding.dimensions;
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(dimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const operation = readOpenAiOperation(body);
    calls.push({ url: String(url), operation });
    if (String(url).endsWith("/chat/completions")) {
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-skip-ltm-dreaming-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "skip_ltm_q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "Alpha",
        answer_session_ids: ["skip_ltm_s1"],
        haystack_session_ids: ["skip_ltm_s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      enableLtmReinforcement: true,
      logger: {
        info(fields: Record<string, unknown>, message: string) {
          if (message === "longmemeval llm request context" && fields.stage === "ltm") {
            ltmRequestContexts.push(fields);
          }
        },
        warn() {},
        error() {}
      },
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(ltmRequestContexts, []);
  assert.equal(calls.some((call) => call.operation === "fact_fusion"), true);
  assert.equal(calls.some((call) => call.operation === "stm_admission"), true);
  assert.equal(calls.some((call) => call.operation === "answer"), true);
});

test("evaluateLongMemEvalDataset answer-only mode skips LTM progress and dreaming requests", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; operation: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const dimensions = getContextEngineConfig().embedding.dimensions;
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(dimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const serialized = JSON.stringify(body);
    const operation = serialized.includes("Is the model response correct?")
      ? "judge"
      : serialized.includes("You are answering a LongMemEval question.")
        ? "answer"
        : readOpenAiOperation(body);
    calls.push({ url: String(url), operation });
    if (String(url).endsWith("/chat/completions") && (operation === "fact_fusion" || operation === "stm_admission")) {
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, operation === "judge" ? "yes" : "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-answer-only-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "answer_only_q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "Alpha",
        answer_session_ids: ["answer_only_s1"],
        haystack_session_ids: ["answer_only_s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      }
    ]),
    "utf8"
  );

  const progressStages: string[] = [];
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
    calls.length = 0;

    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      modelOnlyEvaluation: true,
      answerOnlyEvaluation: true,
      enableLtmReinforcement: true,
      onProgress: (progress) => {
        progressStages.push(progress.stage);
      },
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(progressStages.includes("ltm"), false);
  assert.equal(progressStages.includes("judge"), true);
  assert.deepEqual(calls.filter((call) => call.operation !== "unknown").map((call) => call.operation), ["answer"]);
  assert.equal(calls.some((call) => call.operation === "fact_fusion" || call.operation === "stm_admission"), false);
});

test("evaluateLongMemEvalDataset answer-only starts without preflight scanning completed ingest", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; operation: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const serialized = JSON.stringify(body);
    const operation = serialized.includes("Is the model response correct?")
      ? "judge"
      : serialized.includes("You are answering a LongMemEval question.")
        ? "answer"
        : readOpenAiOperation(body);
    calls.push({ url: String(url), operation });
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, operation === "judge" ? "yes" : "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-answer-only-no-preflight-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "answer_only_no_preflight_q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "Alpha",
        answer_session_ids: ["answer_only_no_preflight_s1"],
        haystack_session_ids: ["answer_only_no_preflight_s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      modelOnlyEvaluation: true,
      answerOnlyEvaluation: true,
      answerContextMode: "retrieval",
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.equal(report.totalSamples, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => call.operation),
    ["answer", "judge"]
  );
});

test("evaluateLongMemEvalDataset writes sample diagnostics jsonl", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/embeddings")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { input?: unknown } : {};
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/chat/completions")) {
      return new Response(JSON.stringify(buildChatCompletionTextResponse("Alpha")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-diagnostics-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "diagnostics.jsonl");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "diag_q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "Alpha",
        answer_session_ids: ["diag_s1"],
        haystack_session_ids: ["diag_s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      diagnosticsPath,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const lines = (await readFile(diagnosticsPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const diagnostic = JSON.parse(lines[0]!) as {
    questionId: string;
    answer: string;
    hypothesis: string;
    timelineHasAnswer: boolean;
    promptHasAnswer: boolean;
    contextPack: {
      tokenBudget: { requested: number };
      selectedItemIds: string[];
      droppedSummary: Record<string, number>;
    };
    answerContext: {
      evidenceTrace: {
        retrievalCallCount: number;
        retrievalLimit: number;
        retrievedItemIds: string[];
        selected: Array<{ itemId: string }>;
        rejected: Array<{ itemId: string; reason: string }>;
        renderedPromptHasTemporalMetadata: boolean;
      };
    };
  };
  assert.equal(diagnostic.questionId, "diag_q1");
  assert.equal(diagnostic.answer, "Alpha");
  assert.equal(diagnostic.hypothesis, "Alpha");
  assert.equal(diagnostic.timelineHasAnswer, true);
  assert.equal(diagnostic.promptHasAnswer, true);
  assert.equal(diagnostic.contextPack.tokenBudget.requested, 20000);
  assert.equal(Array.isArray(diagnostic.contextPack.selectedItemIds), true);
  assert.equal(diagnostic.answerContext.evidenceTrace.retrievalLimit, 100);
  assert.equal(diagnostic.answerContext.evidenceTrace.retrievalCallCount, 1);
  assert.equal(Array.isArray(diagnostic.answerContext.evidenceTrace.retrievedItemIds), true);
  assert.equal(Array.isArray(diagnostic.answerContext.evidenceTrace.selected), true);
  assert.equal(Array.isArray(diagnostic.answerContext.evidenceTrace.rejected), true);
});

test("LongMemEval summary trace records only Facts, STMs, retrieval candidates, and Context Pack Facts", async () => {
  const originalFetch = globalThis.fetch;
  installLongMemEvalSuccessFetch();
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-substage-trace-"));
  const baselineDatasetPath = join(dir, "baseline.json");
  const tracedDatasetPath = join(dir, "traced.json");
  const tracePath = join(dir, "trace.jsonl");
  const sample = [{
    question_id: "substage_trace_q1",
    question_type: "single-session-user",
    question: "Which word was mentioned?",
    answer: "Alpha",
    answer_session_ids: ["substage_trace_s1"],
    haystack_session_ids: ["substage_trace_s1"],
    haystack_sessions: [[{ role: "user", content: "Alpha was mentioned." }]]
  }];
  await Promise.all([
    writeFile(baselineDatasetPath, JSON.stringify(sample), "utf8"),
    writeFile(tracedDatasetPath, JSON.stringify(sample), "utf8")
  ]);
  const baselineRows: Record<string, unknown>[] = [];
  const tracedRows: Record<string, unknown>[] = [];

  try {
    const commonOptions = {
      ks: [1, 3],
      skipLtmDreaming: true,
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    };
    const baseline = await evaluateLongMemEvalDataset(baselineDatasetPath, {
      ...commonOptions,
      resultSinkOverride: { async commit(row) { baselineRows.push(row); return undefined; } }
    });
    const traced = await evaluateLongMemEvalDataset(tracedDatasetPath, {
      ...commonOptions,
      graphStore: new RecordingGraphMemoryStore(),
      tracePath,
      resultSinkOverride: { async commit(row) { tracedRows.push(row); return undefined; } }
    });

    assert.deepEqual(traced.metrics, baseline.metrics);
    assert.deepEqual(traced.samples.map(({ hypothesis, judgment, retrieval }) => ({ hypothesis, judgment, retrieval })),
      baseline.samples.map(({ hypothesis, judgment, retrieval }) => ({ hypothesis, judgment, retrieval })));
    assert.deepEqual(
      tracedRows.map(readStableLongMemEvalResultFields),
      baselineRows.map(readStableLongMemEvalResultFields)
    );

    const traceRows = await readJsonlRows(tracePath);
    const allowedOperations = new Set(["sample_facts", "sample_stms", "retrieval_candidates", "context_pack_facts"]);
    assert.equal(traceRows.every((row) => row.stage === "sample_summary" && allowedOperations.has(String(row.operation))), true);
    assert.equal(traceRows.every((row) => row.input === undefined), true);
    assert.equal(traceRows.length <= 4, true);
    for (const operation of allowedOperations) {
      assert.equal(traceRows.filter((row) => row.operation === operation).length <= 1, true);
    }
    const candidateRow = traceRows.find((row) => row.operation === "retrieval_candidates");
    const packRow = traceRows.find((row) => row.operation === "context_pack_facts");
    const candidates = (candidateRow?.output as { candidates?: unknown[] } | undefined)?.candidates ?? [];
    const selected = (packRow?.output as { selected?: unknown[] } | undefined)?.selected ?? [];
    assert.equal(candidates.length <= 100, true);
    assert.equal(selected.length <= 6, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fact fusion and STM admission observers attribute persistence failures to the exact substage", async () => {
  const event = buildObservedParseEvent();
  const factObservations: ParseAndAdmitStageObservation[] = [];
  class FactWriteFailureRepository extends InMemoryContextEngineRepository {
    override async saveFactItem() {
      throw Object.assign(new Error("fact persistence unavailable"), { code: "EIO" });
    }
  }
  await assert.rejects(
    parseAndAdmitEvent(new FactWriteFailureRepository(), event, undefined, {
      llm: { apiKey: "" },
      skipStmAdmission: true,
      stageObserver: (observation) => { factObservations.push(observation); }
    }),
    /fact persistence unavailable/
  );
  assertObservedSubstageFailure(factObservations, "fact_fusion", "fact persistence unavailable");
  assert.equal(factObservations.some((observation) => observation.operation === "stm_admission"), false);

  const stmObservations: ParseAndAdmitStageObservation[] = [];
  class StmWriteFailureRepository extends InMemoryContextEngineRepository {
    override async saveShortTermMemory() {
      throw Object.assign(new Error("stm persistence unavailable"), { code: "EIO" });
    }
  }
  await assert.rejects(
    parseAndAdmitEvent(new StmWriteFailureRepository(), event, undefined, {
      llm: { apiKey: "" },
      stageObserver: (observation) => { stmObservations.push(observation); }
    }),
    /stm persistence unavailable/
  );
  assert.deepEqual(
    stmObservations.filter((observation) => observation.operation === "fact_fusion").map((observation) => observation.status),
    ["started", "succeeded"]
  );
  assertObservedSubstageFailure(stmObservations, "stm_admission", "stm persistence unavailable");
});

test("LongMemEval trace attributes answer-context failures to retrieval before Context Pack", async () => {
  const originalFetch = globalThis.fetch;
  installLongMemEvalSuccessFetch();
  class DeterministicSearchFailureGraphStore extends RecordingGraphMemoryStore {
    override searchGraphVector(): Array<{ ownerType: GraphMemoryOwnerType; ownerId: string; score: number }> {
      throw new TypeError("invalid retrieval query");
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-retrieval-failure-trace-"));
  const datasetPath = join(dir, "dataset.json");
  const tracePath = join(dir, "trace.jsonl");
  await writeFile(datasetPath, JSON.stringify([{
    question_id: "retrieval_failure_q1",
    question_type: "single-session-user",
    question: "Which word was mentioned?",
    answer: "Alpha",
    answer_session_ids: ["retrieval_failure_s1"],
    haystack_session_ids: ["retrieval_failure_s1"],
    haystack_sessions: [[{ role: "user", content: "Alpha was mentioned." }]]
  }]), "utf8");
  const resultRows: Record<string, unknown>[] = [];

  try {
    const report = await evaluateLongMemEvalDataset(datasetPath, {
      ks: [1],
      graphStore: new DeterministicSearchFailureGraphStore(),
      tracePath,
      skipLtmDreaming: true,
      resultSinkOverride: { async commit(row) { resultRows.push(row); return undefined; } },
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
    assert.equal(report.samples[0]?.skipped, true);
    assert.equal(resultRows[0]?.failureStage, "answer");

    const traceRows = await readJsonlRows(tracePath);
    assert.equal(traceRows.some((row) => row.operation === "retrieval_candidates" || row.operation === "context_pack_facts"), false);
    assert.equal(traceRows.every((row) => ["sample_facts", "sample_stms"].includes(String(row.operation))), true);
    assert.equal(traceRows.every((row) => row.input === undefined), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function readStableLongMemEvalResultFields(row: Record<string, unknown>) {
  return {
    hypothesis: row.hypothesis,
    judgment: row.judgment,
    exactMatch: row.exactMatch,
    answerRankedSessionIds: row.answerRankedSessionIds,
    answerContextMode: row.answerContextMode
  };
}

function buildObservedParseEvent(): MemoryEvent {
  return {
    eventId: "observed_parse_event",
    eventType: "test_event",
    eventSummary: "Observed parse event",
    eventTime: "2026-08-13T00:00:00.000Z",
    sourceApp: "test",
    sourceId: "observed-parse-event",
    permissionSnapshot: {
      snapshotId: "ps_observed_parse_event",
      tenantId: "local",
      principalId: "tester",
      sourceAclVersion: "v1",
      visibility: "private"
    },
    multimodalData: [{
      itemId: "observed_item",
      type: "text",
      format: "plain",
      content: "The user prefers concise answers.",
      ref: "observed-parse-event",
      sourceRefs: [{ sourceRefId: "src_observed_parse_event", sourceType: "manual_text", sourceId: "observed-parse-event" }],
      timeBasis: "source_time",
      timeConfidence: "high"
    }],
    sourceRefs: [{ sourceRefId: "src_observed_parse_event", sourceType: "manual_text", sourceId: "observed-parse-event" }]
  };
}

function assertObservedSubstageFailure(
  observations: ParseAndAdmitStageObservation[],
  operation: ParseAndAdmitStageObservation["operation"],
  message: string
) {
  const rows = observations.filter((observation) => observation.operation === operation);
  assert.deepEqual(rows.map((observation) => observation.status), ["started", "failed"]);
  assert.equal(rows[0]?.stageExecutionId, rows[1]?.stageExecutionId);
  assert.notEqual(rows[0]?.input, undefined);
  assert.match((rows[1]?.error as Error).message, new RegExp(message));
  assert.equal(typeof rows[1]?.elapsedMs, "number");
}


test("deterministic answer evidence selection uses complete bilingual source text in reranker order", () => {
  const completeContent = `用户在当地社区剧院观看的戏剧是《玻璃动物园》。${"补充细节。".repeat(280)}完整结尾。`;
  const candidates = [
    ...Array.from({ length: 40 }, (_, index) => answerEvidenceCandidate(`candidate_noise_${index}`, {
      evidenceText: `irrelevant daily note ${index}`,
      relevanceScore: 1,
      item: {
        ...answerEvidenceCandidate(`candidate_noise_${index}`).item,
        score: 0.9 - index / 1000,
        content: `用户记录了一条无关的日常事实 ${index}。`,
        compressedContent: `用户记录了一条无关的日常事实 ${index}。`
      }
    })),
    answerEvidenceCandidate("candidate_answer", {
      evidenceText: `${completeContent}\nThe play attended at the local community theater was The Glass Menagerie.`,
      relevanceScore: 20,
      scoreBreakdown: { ...zeroScoreBreakdown, reranker: 0.89 },
      item: {
        ...answerEvidenceCandidate("candidate_answer").item,
        score: 0.7,
        content: completeContent,
        compressedContent: "不得使用这个截断版本"
      }
    })
  ];

  const result = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "What play did I attend at the local community theater?",
    answer: "The Glass Menagerie",
    questionType: "single-session-user",
    candidates,
    tokenBudget: 100000
  });
  const prompt = renderLongMemEvalAnswerContext(
    "What play did I attend at the local community theater?",
    undefined,
    result.selectedCandidates,
    "pack_test"
  );

  assert.equal(result.selectedCandidates.some((candidate) => candidate.item.id === "candidate_answer"), true);
  assert.equal(result.selectedCandidates.length, 20);
  assert.equal(result.rejected.some((item) => item.reason === "lower_priority"), true);
  assert.equal(prompt.includes(completeContent), true);
  assert.equal(prompt.includes("The play attended at the local community theater was The Glass Menagerie."), true);
  assert.equal(prompt.includes("完整结尾。"), true);
  assert.equal(prompt.includes("不得使用这个截断版本"), false);
});

test("answer evidence selection keeps cross-encoder relevance as the primary order", () => {
  const lexicalMatch = answerEvidenceCandidate("fact_lexical", {
    relevanceScore: 5,
    scoreBreakdown: { ...zeroScoreBreakdown, reranker: 0.1 }
  });
  const semanticAnswer = answerEvidenceCandidate("fact_semantic", {
    relevanceScore: 0,
    scoreBreakdown: { ...zeroScoreBreakdown, reranker: 0.9 }
  });

  const selection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "What did father send?",
    answer: "a watch",
    questionType: "single-session-user",
    candidates: [lexicalMatch, semanticAnswer],
    tokenBudget: 20_000
  });

  assert.deepEqual(selection.selectedCandidates.map((candidate) => candidate.item.id), [
    "fact_semantic",
    "fact_lexical"
  ]);
});

test("answer evidence selection falls back to question relevance without reranker scores", () => {
  const retrievalLeader = answerEvidenceCandidate("fact_retrieval_leader", {
    relevanceScore: 0,
    item: {
      ...answerEvidenceCandidate("fact_retrieval_leader").item,
      score: 0.9
    }
  });
  const questionMatch = answerEvidenceCandidate("fact_question_match", {
    relevanceScore: 10,
    item: {
      ...answerEvidenceCandidate("fact_question_match").item,
      score: 0.1
    }
  });

  const selection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "What is the total amount spent on luxury items?",
    answer: "$2,500",
    questionType: "multi-session",
    candidates: [retrievalLeader, questionMatch],
    tokenBudget: 20_000
  });

  assert.deepEqual(selection.selectedCandidates.map((candidate) => candidate.item.id), [
    "fact_question_match",
    "fact_retrieval_leader"
  ]);
});

test("answer evidence selection keeps reranker top 20 despite dense support relations", () => {
  const candidates = Array.from({ length: 25 }, (_, index) => {
    const rank = index + 1;
    const id = `rank_${String(rank).padStart(2, "0")}`;
    return answerEvidenceCandidate(id, {
      scoreBreakdown: { ...zeroScoreBreakdown, reranker: 1 - index / 100 },
      relevanceScore: rank > 20 ? 100 : 0,
      relations: rank > 12
        ? [{ edgeId: `edge_${id}`, fromId: `fact_${id}`, toId: "fact_rank_01", relationType: "supports" }]
        : []
    });
  });

  const selection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "What facts answer this question?",
    answer: "gold answer must not affect ranking",
    questionType: "multi-session",
    candidates,
    tokenBudget: 20_000
  });
  const selectionWithDifferentGold = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "What facts answer this question?",
    answer: "a completely different diagnostic gold answer",
    questionType: "multi-session",
    candidates,
    tokenBudget: 20_000
  });

  assert.deepEqual(
    selection.selectedCandidates.map((candidate) => candidate.item.id),
    candidates.slice(0, 20).map((candidate) => candidate.item.id)
  );
  assert.deepEqual(
    selectionWithDifferentGold.selectedCandidates.map((candidate) => candidate.item.id),
    selection.selectedCandidates.map((candidate) => candidate.item.id)
  );
  assert.equal(selection.rejected.filter((item) => item.reason === "lower_priority").length, 5);
});

test("answer evidence selection retains cross-session count facts in reranker order", () => {
  const tennis = answerEvidenceCandidate("tennis", {
    sourceSessionIds: ["session_tennis"],
    evidenceText: "The user played tennis.",
    scoreBreakdown: { ...zeroScoreBreakdown, reranker: 0.95 }
  });
  const swimming = answerEvidenceCandidate("competitive_swimming", {
    sourceSessionIds: ["session_swimming"],
    evidenceText: "The user did competitive swimming.",
    scoreBreakdown: { ...zeroScoreBreakdown, reranker: 0.94 }
  });
  const noise = Array.from({ length: 20 }, (_, index) => answerEvidenceCandidate(`sport_noise_${index}`, {
    scoreBreakdown: { ...zeroScoreBreakdown, reranker: 0.8 - index / 100 }
  }));

  const selection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "How many competitive sports did I do?",
    answer: "2",
    questionType: "multi-session",
    candidates: [tennis, swimming, ...noise],
    tokenBudget: 20_000
  });

  assert.deepEqual(selection.selectedCandidates.slice(0, 2).map((candidate) => candidate.item.id), [
    "tennis",
    "competitive_swimming"
  ]);
});

test("answer evidence selection retains wedding and age operands without heuristic promotion", () => {
  const candidates = Array.from({ length: 15 }, (_, index) => answerEvidenceCandidate(`candidate_${index + 1}`, {
    evidenceText: index === 0
      ? "Rachel is getting married next year."
      : index === 4
        ? "I am currently 32 years old."
        : `Unrelated memory ${index + 1}.`,
    scoreBreakdown: { ...zeroScoreBreakdown, reranker: 0.95 - index / 100 }
  }));

  const selection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "How old will I be when Rachel gets married?",
    answer: "33",
    questionType: "temporal-reasoning multi-session",
    candidates,
    tokenBudget: 20_000
  });

  assert.equal(selection.selectedCandidates[0]?.item.id, "candidate_1");
  assert.equal(selection.selectedCandidates[4]?.item.id, "candidate_5");
  assert.equal(selection.selectedCandidates[4]?.evidenceText, "I am currently 32 years old.");
});

test("answer evidence renders the same complete FactItem text used for ranking", () => {
  const item = answerEvidenceCandidate("hostel_summary").item;
  const summaryItem = {
    ...item,
    content: "The assistant recommended five budget hostels in Amsterdam.",
    compressedContent: "The assistant recommended five budget hostels in Amsterdam."
  };
  const fact = {
    factId: "fact_hostel_summary",
    factText: "The five options were Stayokay, ClinkNOORD, The Bulldog, International Budget Hostel, and Amsterdam Hostel Centre.",
    normalizedClaim: "five amsterdam hostel recommendations include international budget hostel",
    sourceClaim: "International Budget Hostel is near the Red Light District."
  } as FactItem;
  const evidenceText = buildLongMemEvalAnswerEvidenceText(summaryItem, [fact]);
  const candidate = answerEvidenceCandidate("hostel_summary", {
    item: summaryItem,
    facts: [fact],
    evidenceText,
    relevanceScore: 20
  });
  const selection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "Which hostel near the Red Light District did you recommend?",
    answer: "International Budget Hostel",
    questionType: "single-session-assistant",
    candidates: [candidate],
    tokenBudget: 2000
  });
  const prompt = renderLongMemEvalAnswerContext(
    "Which hostel near the Red Light District did you recommend?",
    undefined,
    selection.selectedCandidates,
    "pack_hostel"
  );

  assert.equal(evidenceText.includes("International Budget Hostel"), true);
  assert.equal(prompt.includes(evidenceText), true);
});

test("answer context renders each fact sequence with its source session and fact text", () => {
  const candidate = answerEvidenceCandidate("profile_update", {
    sourceSessionIds: ["session_profile"],
    facts: [
      {
        factId: "fact_profile_old",
        sessionId: "session_profile",
        factSequence: 2,
        factText: "The user's preferred color was blue.",
        normalizedClaim: "The user's preferred color was blue."
      } as FactItem,
      {
        factId: "fact_profile_new",
        sessionId: "session_profile",
        factSequence: 5,
        factText: "The user's preferred color is now green.",
        normalizedClaim: "The user's preferred color is now green."
      } as FactItem
    ]
  });

  const context = renderLongMemEvalAnswerContext(
    "What is the user's current preferred color?",
    undefined,
    [candidate],
    "pack_sequence"
  );

  assert.match(context, /Session session_profile, factSequence 2: The user's preferred color was blue\./u);
  assert.match(context, /Session session_profile, factSequence 5: The user's preferred color is now green\./u);
});

test("count evidence keeps same-session facts as separate candidates", () => {
  const first = answerEvidenceCandidate("count_first", {
    sourceSessionIds: ["session_a"],
    item: {
      ...answerEvidenceCandidate("count_first").item,
      temporal: { validTime: "2023-05-16T00:00:00.000Z" }
    },
    temporal: { validTime: "2023-05-16T00:00:00.000Z" },
    facts: [{ linkedEventIds: ["event_a"] } as FactItem]
  });
  const supporting = answerEvidenceCandidate("count_supporting", {
    sourceSessionIds: ["session_a"],
    item: {
      ...answerEvidenceCandidate("count_supporting").item,
      temporal: { validTime: "2023-05-16T00:00:00.000Z" }
    },
    temporal: { validTime: "2023-05-16T00:00:00.000Z" },
    facts: [{ linkedEventIds: ["event_a"] } as FactItem]
  });
  const secondEvent = answerEvidenceCandidate("count_second", {
    sourceSessionIds: ["session_b"],
    item: {
      ...answerEvidenceCandidate("count_second").item,
      temporal: { validTime: "2023-05-20T00:00:00.000Z" }
    },
    temporal: { validTime: "2023-05-20T00:00:00.000Z" },
    facts: [{ linkedEventIds: ["event_b"] } as FactItem]
  });

  const candidates = [first, supporting, secondEvent];
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0]?.item.content, first.item.content);
  assert.equal(candidates[1]?.item.content, supporting.item.content);

  const prompt = renderLongMemEvalAnswerContext(
    "How many times did I bake something in the past two weeks?",
    "2023-05-30T00:00:00.000Z",
    candidates,
    "pack_count",
    "multi-session"
  );
  assert.match(prompt, /【计数规则】先枚举/u);
  assert.doesNotMatch(prompt, /证据分组：Session\/Event/u);
  assert.doesNotMatch(prompt, /聚合成员：/u);

  const stateCandidate = answerEvidenceCandidate("state_age", {
    sourceSessionIds: ["session_age"],
    evidenceText: "User is 32 years old.",
    relevanceScore: 5
  });
  const stateSelection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "How old am I?",
    answer: "32",
    questionType: "single-session-user",
    candidates: [stateCandidate],
    tokenBudget: 2000
  });
  assert.doesNotMatch(
    renderLongMemEvalAnswerContext("How old am I?", undefined, stateSelection.selectedCandidates, "pack_state", "single-session-user"),
    /计数规则/u
  );
  assert.doesNotMatch(
    renderLongMemEvalAnswerContext("How many books do I own?", undefined, [], "pack_books", "multi-session"),
    /计数规则/u
  );
  assert.doesNotMatch(
    renderLongMemEvalAnswerContext("How many times did I bake?", undefined, [], "pack_single", "single-session-user"),
    /计数规则/u
  );
});

test("count evidence does not merge explicit cross-session relations at answer time", () => {
  const first = answerEvidenceCandidate("cross_session_first", {
    sourceSessionIds: ["session_a"],
    facts: [{ linkedEventIds: ["event_a"] } as FactItem],
    relations: [{ edgeId: "edge_cross_session", fromId: "fact_cross_session_first", toId: "fact_cross_session_second", relationType: "is_same_as" }]
  });
  const duplicate = answerEvidenceCandidate("cross_session_second", {
    sourceSessionIds: ["session_b"],
    facts: [{ linkedEventIds: ["event_b"] } as FactItem],
    relations: [{ edgeId: "edge_cross_session", fromId: "fact_cross_session_first", toId: "fact_cross_session_second", relationType: "is_same_as" }]
  });
  const candidates = [first, duplicate];

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0]?.sourceSessionIds, ["session_a"]);
  assert.deepEqual(candidates[1]?.sourceSessionIds, ["session_b"]);
});

test("answer evidence keeps long facts intact regardless of source type", () => {
  const longContent = "长文本".repeat(500);
  const ordinary = answerEvidenceCandidate("stm_ordinary", {
    item: { ...answerEvidenceCandidate("stm_ordinary").item, content: longContent, compressedContent: longContent }
  }).item;
  const segment = answerEvidenceCandidate("stm_fact_seg_123", {
    item: { ...answerEvidenceCandidate("stm_fact_seg_123").item, content: longContent, compressedContent: longContent }
  }).item;
  const timeline = answerEvidenceCandidate("stm_fact_timeline_fused_123", {
    item: { ...answerEvidenceCandidate("stm_fact_timeline_fused_123").item, content: longContent, compressedContent: longContent }
  }).item;

  const candidates = [
    answerEvidenceCandidate("stm_ordinary", { item: ordinary, relevanceScore: 10 }),
    answerEvidenceCandidate("stm_fact_seg_123", { item: segment, relevanceScore: 10 }),
    answerEvidenceCandidate("stm_fact_timeline_fused_123", { item: timeline, relevanceScore: 10 })
  ];
  const selection = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "What was recorded?",
    answer: "recorded",
    questionType: "single-session-user",
    candidates,
    tokenBudget: 20_000
  });
  assert.deepEqual(selection.selectedCandidates.map((candidate) => candidate.item.id).sort(), candidates.map((candidate) => candidate.item.id).sort());
  assert.deepEqual(selection.selectedCandidates.map((candidate) => candidate.item.content), [longContent, longContent, longContent]);
});

test("answer evidence deduplicates by source fact and drops complete items whole when over budget", () => {
  const sparse = answerEvidenceCandidate("stm_sparse", {
    item: {
      ...answerEvidenceCandidate("stm_sparse").item,
      factIds: ["fact_shared"],
      content: "共享事实的简略版本。",
      compressedContent: "共享事实的简略版本。"
    }
  });
  const completeText = `共享事实的完整版本。${"完整证据。".repeat(300)}结尾标记。`;
  const complete = answerEvidenceCandidate("stm_complete", {
    sourceRoles: ["user"],
    sourceSessionIds: ["session_complete"],
    item: {
      ...answerEvidenceCandidate("stm_complete").item,
      factIds: ["fact_shared"],
      content: completeText,
      compressedContent: "不得使用摘要",
      temporal: { validTime: "2024-01-01T00:00:00.000Z" }
    },
    temporal: { validTime: "2024-01-01T00:00:00.000Z" }
  });

  const deduped = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "What was the shared fact?",
    answer: "shared fact",
    questionType: "single-session-user",
    candidates: [sparse, complete],
    tokenBudget: 5000
  });
  assert.deepEqual(deduped.selectedCandidates.map((candidate) => candidate.item.id), ["stm_complete"]);
  assert.equal(deduped.rejected.some((item) => item.itemId === "stm_sparse" && item.reason === "duplicate"), true);

  const budgeted = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "What was the shared fact?",
    answer: "shared fact",
    questionType: "single-session-user",
    candidates: [complete],
    tokenBudget: 100
  });
  const prompt = renderLongMemEvalAnswerContext("What was the shared fact?", undefined, budgeted.selectedCandidates, "pack_budget");
  assert.equal(budgeted.selectedCandidates.length, 0);
  assert.equal(budgeted.rejected.some((item) => item.itemId === "stm_complete" && item.reason === "budget"), true);
  assert.equal(prompt.includes("完整证据。"), false);
  assert.equal(prompt.includes("结尾标记。"), false);
});

test("answer evidence keeps temporal endpoints, numeric operands, source roles and update order", () => {
  const update: RelationEdge = {
    edgeId: "edge_update",
    fromId: "stm_new",
    toId: "stm_old",
    relationType: "updates"
  };
  const conflict: RelationEdge = {
    edgeId: "edge_conflict",
    fromId: "stm_third",
    toId: "stm_new",
    relationType: "conflicts_with"
  };
  const oldCandidate = answerEvidenceCandidate("stm_old", {
    sourceSessionIds: ["session_old"],
    sourceRoles: ["user"],
    relations: [update],
    evidenceText: "old budget amount $10",
    relevanceScore: 4,
    item: {
      ...answerEvidenceCandidate("stm_old").item,
      content: "旧预算是 10 美元。",
      compressedContent: "旧预算是 10 美元。",
      temporal: {
        validTime: "2023-05-01T00:00:00.000Z",
        evidenceTime: "2023-05-01T08:00:00.000Z"
      }
    },
    temporal: {
      validTime: "2023-05-01T00:00:00.000Z",
      evidenceTime: "2023-05-01T08:00:00.000Z"
    }
  });
  const newCandidate = answerEvidenceCandidate("stm_new", {
    sourceSessionIds: ["session_new"],
    sourceRoles: ["assistant"],
    relations: [update],
    evidenceText: "new budget amount $20",
    relevanceScore: 4,
    item: {
      ...answerEvidenceCandidate("stm_new").item,
      content: "新预算是 20 美元。",
      compressedContent: "新预算是 20 美元。",
      temporal: {
        validTime: "2023-05-03T00:00:00.000Z",
        evidenceTime: "2023-05-03T08:00:00.000Z"
      }
    },
    temporal: {
      validTime: "2023-05-03T00:00:00.000Z",
      evidenceTime: "2023-05-03T08:00:00.000Z"
    }
  });
  const thirdCandidate = answerEvidenceCandidate("stm_third", {
    sourceSessionIds: ["session_third"],
    relations: [conflict],
    evidenceText: "third budget amount $30",
    relevanceScore: 4,
    item: {
      ...answerEvidenceCandidate("stm_third").item,
      content: "第三笔金额是 30 美元。",
      compressedContent: "第三笔金额是 30 美元。"
    }
  });

  const result = selectLongMemEvalAnswerEvidenceWithinBudget({
    question: "From the first budget to the latest one, what was the total amount across all sessions?",
    answer: "$60",
    questionType: "temporal-reasoning multi-session",
    candidates: [oldCandidate, newCandidate, thirdCandidate],
    tokenBudget: 4000
  });
  const prompt = renderLongMemEvalAnswerContext(
    "From the first budget to the latest one, what was the total amount across all sessions?",
    "2023-05-04T00:00:00.000Z",
    result.selectedCandidates,
    "pack_temporal"
  );

  assert.equal(result.selectedCandidates.length, 3);
  assert.equal(result.selected.some((item) => item.evidenceRole === "old_state"), true);
  assert.equal(result.selected.some((item) => item.evidenceRole === "new_state"), true);
  assert.equal(result.selected.some((item) => item.evidenceRole === "calculation_operand"), true);
  assert.equal(prompt.includes("事实发生时间：2023-05-01T00:00:00.000Z"), true);
  assert.equal(prompt.includes("消息发送时间：2023-05-03T08:00:00.000Z"), true);
  assert.equal(prompt.includes("来源角色：user"), true);
  assert.equal(prompt.includes("来源角色：assistant"), true);
  assert.equal(prompt.includes("更新了 ["), true);
  assert.equal(prompt.includes("被 ["), true);
  assert.equal(prompt.includes("冲突"), true);
});

test("context pack answer stage uses scoped STM without raw evidence or LTM", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  const prompts: string[] = [];
  const operations: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);
    operations.push(operation);

    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (String(url).endsWith("/chat/completions")) {
      if (operation === "answer") {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const user = messages[1] as { content?: unknown } | undefined;
        if (typeof user?.content === "string") prompts.push(user.content);
        return new Response(JSON.stringify(buildChatCompletionTextResponse("Orion Harbor")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (operation === "judge") {
        return new Response(JSON.stringify(buildChatCompletionTextResponse("yes")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (operation === "fact_fusion") {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const user = messages[1] as { content?: unknown } | undefined;
        const prompt = typeof user?.content === "string" ? JSON.parse(user.content) as { evidence?: Array<{ segmentId?: string; content?: string }> } : {};
        const evidence = prompt.evidence?.[0];
        const factText = evidence?.content?.includes("Orion Harbor")
          ? "The project codename is Orion Harbor."
          : "A different project codename had no final decision.";
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  facts: [
                    {
                      factType: "user_fact",
                      factText,
                      normalizedClaim: factText,
                      confidenceLevel: "high",
                      linkedSegmentIds: [evidence?.segmentId],
                      entityIds: ["project_codename"],
                      validTimeStart: "2023-01-01T00:00:00.000Z",
                      timeBasis: "source_time",
                      timeConfidence: "high"
                    }
                  ]
                })
              }
            }
          ]
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-key-evidence-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "key_evidence_q1",
        question_type: "single-session-user",
        question: "What project codename did I mention?",
        answer: "Orion Harbor",
        answer_session_ids: ["key_evidence_s1"],
        haystack_session_ids: ["key_evidence_s1", "key_evidence_s2"],
        haystack_sessions: [
          [
            { role: "user", content: "Before the meeting I wrote a checklist." },
            { role: "user", content: "The project codename is Orion Harbor, and it should stay private.", has_answer: true },
            { role: "assistant", content: "I will remember Orion Harbor as the project codename." }
          ],
          [
            { role: "user", content: "We discussed a different project codename with no final decision." }
          ]
        ]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      answerContextMode: "context_pack",
      skipLtmDreaming: true,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(operations.includes("answer_evidence_selection"), false);
  const answerPrompt = prompts.find((prompt) => prompt.includes("You are answering a LongMemEval question."));
  assert.ok(answerPrompt);
  assert.equal(answerPrompt.includes("【答题关键证据】"), false);
  assert.equal(answerPrompt.includes("【答题证据】"), true);
  assert.equal(answerPrompt.includes("The project codename is Orion Harbor."), true);
  assert.equal(answerPrompt.includes("【Context Pack】"), true);
  assert.equal(answerPrompt.match(/【Context Pack】/gu)?.length, 1);
  assert.equal(answerPrompt.includes("事实发生时间："), true);
  assert.equal(answerPrompt.includes("消息发送时间："), true);
  assert.equal(answerPrompt.includes("来源角色：user"), true);
});

test("evaluateLongMemEvalDataset does not emit ltm request context through the logger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-logger-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s2",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [{ role: "user", content: "alpha" }],
          [{ role: "user", content: "beta" }]
        ]
      }
    ]),
    "utf8"
  );

  const infos: Array<{ message: string; fields: Record<string, unknown> }> = [];
  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    enableLtmReinforcement: true,
    logger: {
      info(fields: Record<string, unknown>, message: string) {
        infos.push({ fields, message });
      },
      warn() {},
      error() {}
    }
  });

  assert.equal(infos.some((item) => item.message === "longmemeval llm request context" && item.fields.operation === "longmemeval"), true);
  assert.equal(infos.some((item) => item.message === "longmemeval llm request context" && item.fields.stage === "ltm"), false);
});

test("evaluateLongMemEvalDataset logs timeline answer and judge request context", async () => {
  const originalFetch = globalThis.fetch;
  let responseCount = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ memories: [] }) } }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    responseCount += 1;
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(init?.body ?? "").includes("Is the model response correct?") ? "yes" : "Alpha" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-observable-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "SECRET_GOLD_ANSWER",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      }
    ]),
    "utf8"
  );

  const infos: Array<{ message: string; fields: Record<string, unknown> }> = [];
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      },
      logger: {
        info(fields: Record<string, unknown>, message: string) {
          if (message === "longmemeval llm request context") infos.push({ fields, message });
        },
        warn() {},
        error() {}
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const timeline = infos.find((item) => item.fields.stage === "timeline_aggregation");
  const answer = infos.find((item) => item.fields.stage === "answer");
  const judge = infos.find((item) => item.fields.stage === "judge");
  assert.equal(typeof timeline?.fields.factCount, "number");
  assert.equal(typeof answer?.fields.contextPackId, "string");
  assert.equal(Array.isArray(answer?.fields.selectedItemIds), true);
  assert.equal(String(answer?.fields.promptPreview ?? "").includes("SECRET_GOLD_ANSWER"), false);
  assert.equal(String(judge?.fields.hypothesisPreview ?? ""), "Alpha");
});

test("evaluateLongMemEvalDataset continues ingest when fact fusion LLM body read terminates", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === DEFAULT_LLM_REQUEST_RETRY_DELAY_MS) {
      queueMicrotask(() => callback(...args));
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  let factFusionCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith("/chat/completions")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const operation = readOpenAiOperation(body);
      if (operation === "fact_fusion") {
        factFusionCalls += 1;
        if (factFusionCalls === 1) throw new TypeError("terminated");
        return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify(buildChatCompletionTextResponse(operation === "judge" ? "yes" : "Alpha")),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (target.endsWith("/responses")) {
      return new Response(
        JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-fusion-terminated-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What did I mention?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
      }
    ]),
    "utf8"
  );

  try {
    const result = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      skipStmAdmission: true,
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    });

    assert.equal(factFusionCalls, 2);
    assert.equal(result.totalSamples, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("evaluateLongMemEvalDataset keeps sensitive benchmark timeline evidence visible for answer context", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith("/chat/completions")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const operation = readOpenAiOperation(body);
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation, "16GB")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "16GB")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-visible-sensitive-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "sensitive_q1",
        question_type: "single-session-user",
        question: "How much RAM did I upgrade my laptop to?",
        answer: "16GB",
        answer_session_ids: ["sensitive_s1"],
        haystack_session_ids: ["sensitive_s1"],
        haystack_sessions: [
          [
            { role: "user", content: "I used my password manager notes while upgrading my laptop RAM to 16GB." },
            { role: "assistant", content: "Your laptop RAM upgrade to 16GB is noted." }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const infos: Array<{ fields: Record<string, unknown>; message: string }> = [];
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      logger: {
        info(fields: Record<string, unknown>, message: string) {
          if (message === "longmemeval llm request context") infos.push({ fields, message });
        },
        warn() {},
        error() {}
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const answer = infos.find((item) => item.fields.stage === "answer");
  const selectedItemIds = answer?.fields.selectedItemIds as string[] | undefined;
  const dropped = answer?.fields.dropped as Array<{ id: string; reason: string }> | undefined;

  assert.equal(selectedItemIds?.includes("stm_longmemeval_event_sensitive_q1_sensitive_s1"), true);
  assert.equal(
    dropped?.some((item) => item.id === "stm_longmemeval_event_sensitive_q1_sensitive_s1" && item.reason === "search:access_hidden"),
    false
  );
});

test("evaluateLongMemEvalDataset compacts timeline evidence before answer context packing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith("/chat/completions")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const operation = readOpenAiOperation(body);
      return new Response(JSON.stringify(buildLongMemEvalOperationChatResponse(body, operation, "Kroger")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Kroger")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const irrelevantTurn = {
    role: "user",
    content:
      "from 1539 to 1542 this spaniard traveled widely throughout the southeastern region of north america. " +
      "What are some effective communication strategies for managing conflict in friendships?"
  };
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-compact-evidence-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "compact_q1",
        question_type: "single-session-user",
        question: "Where did I redeem a $5 coupon on coffee creamer?",
        answer: "Kroger",
        answer_session_ids: ["compact_s1"],
        haystack_session_ids: ["compact_s1"],
        haystack_sessions: [
          [
            ...Array.from({ length: 80 }, () => irrelevantTurn),
            {
              role: "user",
              content: "I redeemed a $5 coupon on coffee creamer at Kroger yesterday."
            },
            {
              role: "assistant",
              content: "You redeemed the $5 coffee creamer coupon at Kroger."
            }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const infos: Array<{ fields: Record<string, unknown>; message: string }> = [];
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      logger: {
        info(fields: Record<string, unknown>, message: string) {
          if (message === "longmemeval llm request context") infos.push({ fields, message });
        },
        warn() {},
        error() {}
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const answer = infos.find((item) => item.fields.stage === "answer");
  const promptPreview = String(answer?.fields.promptPreview ?? "");
  const dropped = answer?.fields.dropped as Array<{ id: string; reason: string }> | undefined;
  const compressionSteps = answer?.fields.compressionSteps as Array<{ id: string; beforeTokens: number }> | undefined;

  assert.equal(promptPreview.includes("coffee creamer"), true);
  assert.equal(promptPreview.includes("Kroger"), true);
  assert.equal(promptPreview.includes("Hernando de Soto"), false);
  assert.equal(dropped?.some((item) => item.id === "stm_longmemeval_event_compact_q1_compact_s1"), false);
  assert.equal((compressionSteps?.[0]?.beforeTokens ?? 0) < 1000, true);
});

test("evaluateLongMemEvalDataset keeps the most query-relevant timeline chunks within budget", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "45 minutes each way")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const distractor = {
    role: "assistant",
    content:
      "This is a long daily work planning note about calendar cleanup, task batching, and project routines. " +
      "It repeats long daily work details without mentioning commute duration. ".repeat(8)
  };
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-relevant-budget-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "relevant_budget_q1",
        question_type: "single-session-user",
        question: "How long is my daily commute to work?",
        answer: "45 minutes each way",
        answer_session_ids: ["relevant_budget_s1"],
        haystack_session_ids: ["relevant_budget_s1"],
        haystack_sessions: [
          [
            ...Array.from({ length: 10 }, () => distractor),
            {
              role: "user",
              content: "I've been listening to audiobooks during my daily commute to work, which takes 45 minutes each way."
            }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const infos: Array<{ fields: Record<string, unknown>; message: string }> = [];
  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      logger: {
        info(fields: Record<string, unknown>, message: string) {
          if (message === "longmemeval llm request context") infos.push({ fields, message });
        },
        warn() {},
        error() {}
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const answer = infos.find((item) => item.fields.stage === "answer");
  const promptPreview = String(answer?.fields.promptPreview ?? "");
  assert.equal(promptPreview.includes("45 minutes each way"), true);
});

test("evaluateLongMemEvalDataset emits session and date progress metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-progress-meta-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s2",
        question_date: "2023-04-10",
        haystack_dates: ["2023-04-08", "2023-04-09"],
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "alpha" }
          ],
          [
            { role: "user", content: "beta" }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const ingestMetadata: Array<{ sampleIndex?: number; sessionIndex?: number; sessionDate?: string }> = [];
  await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore(),
    onProgress: (progress) => {
      if (progress.stage === "ingest") {
        const item: { sampleIndex?: number; sessionIndex?: number; sessionDate?: string } = {};
        if (typeof progress.currentSampleIndex === "number") item.sampleIndex = progress.currentSampleIndex;
        if (typeof progress.currentSessionIndex === "number") item.sessionIndex = progress.currentSessionIndex;
        if (typeof progress.currentSessionDate === "string") item.sessionDate = progress.currentSessionDate;
        ingestMetadata.push(item);
      }
    }
  });

  assert.equal(ingestMetadata.some((item) => item.sampleIndex === 1), true);
  assert.equal(ingestMetadata.some((item) => item.sessionIndex === 1), true);
  assert.equal(ingestMetadata.some((item) => item.sessionDate === "2023-04-08"), true);
});

test("judge prompt stays direct and does not ask for intermediate reasoning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-prompt-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "s2",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "alpha" }
          ],
          [
            { role: "user", content: "beta" }
          ]
        ]
      }
    ]),
    "utf8"
  );

  const report = await evaluateLongMemEvalDataset(filePath, {
    ks: [1],
    graphStore: new RecordingGraphMemoryStore()
  });
  assert.equal(report.samples[0]?.judgment.reason.includes("intermediate reasoning"), false);
});

test("longmemeval qa sends chat completion requests", async () => {
  const payloads: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    payloads.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null
    });
    return new Response(
      JSON.stringify(buildChatCompletionTextResponse("Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-response-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "Which session?",
        answer: "Alpha",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [
            { role: "user", content: "alpha" }
          ],
          [
            { role: "user", content: "beta" }
          ]
        ]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(payloads.length >= 2, true);
  const qaPayload = payloads.find((payload) => payload.url.endsWith("/chat/completions"));
  assert.equal(Boolean(qaPayload), true);
  assert.equal(payloads.some((payload) => payload.url.endsWith("/responses")), false);
  assert.equal(Array.isArray((qaPayload?.body as { messages?: unknown }).messages), true);
});

test("evaluateLongMemEvalDataset answers through chat completions only", async () => {
  const payloads: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    payloads.push({ url: String(url), body });
    if (String(url).endsWith("/chat/completions")) {
      const operation = readOpenAiOperation(body);
      if (operation === "fact_fusion" || operation === "stm_admission") {
        return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify(buildChatCompletionTextResponse("Alpha")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`unexpected request:${String(url)}`);
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-chat-answer-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned the code word Alpha during planning." }]]
      }
    ]),
    "utf8"
  );

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    });

    assert.equal(report.samples[0]?.hypothesis, "Alpha");
    assert.notEqual(report.samples[0]?.answerFallbackUsed, true);
    assert.equal(payloads.some((payload) => payload.url.endsWith("/chat/completions")), true);
    assert.equal(payloads.some((payload) => payload.url.endsWith("/responses")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset retries transient answer LLM transport failures", async () => {
  const originalFetch = globalThis.fetch;
  let answerAttempts = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (!String(url).endsWith("/chat/completions")) {
      throw new Error(`unexpected request:${String(url)}`);
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const user = messages[1] as { content?: unknown } | undefined;
    const userContent = typeof user?.content === "string" ? user.content : "";
    const operation = userContent.includes("Is the model response correct?") ? "judge" : readOpenAiOperation(body);
    if (operation === "fact_fusion" || operation === "stm_admission") {
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (operation === "answer") {
      answerAttempts += 1;
      if (answerAttempts === 1) throw new Error("socket hang up");
      return new Response(JSON.stringify(buildChatCompletionTextResponse("Alpha")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify(buildChatCompletionTextResponse("yes")), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-answer-retry-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned the code word Alpha during planning." }]]
      }
    ]),
    "utf8"
  );

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    });

    assert.equal(report.samples[0]?.hypothesis, "Alpha");
    assert.notEqual(report.samples[0]?.answerFallbackUsed, true);
    assert.equal(answerAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset can answer directly from retrieval results", async () => {
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  let responseCount = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> & { input?: Array<{ content?: string }> } : {};
    if (String(url).endsWith("/chat/completions")) {
      const operation = readOpenAiOperation(body);
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    const prompt = body.input?.[1]?.content ?? "";
    if (prompt.includes("You are answering a LongMemEval question.")) {
      prompts.push(prompt);
    }
    responseCount += 1;
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(init?.body ?? "").includes("Is the model response correct?") ? "yes" : "Alpha" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-retrieval-answer-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "diagnostics.jsonl");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "retrieval_q1",
        question_type: "single-session-user",
        question: "What code word did I mention?",
        answer: "Alpha",
        answer_session_ids: ["retrieval_s1"],
        haystack_session_ids: ["retrieval_s1"],
        haystack_sessions: [[{ role: "user", content: "I mentioned the code word Alpha during planning." }]]
      }
    ]),
    "utf8"
  );

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      diagnosticsPath,
      answerContextMode: "retrieval",
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.includes("【Context Pack】"), false);
  assert.equal(prompts[0]?.includes("【Retrieval Results】"), true);
  assert.equal(prompts[0]?.includes("I mentioned the code word Alpha during planning."), true);

  const diagnostic = JSON.parse((await readFile(diagnosticsPath, "utf8")).trim()) as {
    answerContextMode?: string;
    answerContext?: { selectedItemIds?: string[] };
    contextPack?: unknown;
  };
  assert.equal(diagnostic.answerContextMode, "retrieval");
  assert.equal(diagnostic.contextPack, undefined);
  assert.equal(diagnostic.answerContext?.selectedItemIds?.includes("stm_longmemeval_event_retrieval_q1_retrieval_s1"), true);
});

test("evaluateLongMemEvalDataset retrieves across every sample session without answer annotation boosts", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/embeddings")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { input?: unknown } : {};
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (String(url).endsWith("/chat/completions")) {
      return new Response(JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "yes" }]
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-all-session-retrieval-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "diagnostics.jsonl");
  await writeFile(filePath, JSON.stringify([
    {
      question_id: "retrieval_all_q1",
      question_type: "single-session-user",
      question: "What code word did I mention during planning?",
      answer: "Alpha",
      answer_session_ids: ["session_b"],
      haystack_session_ids: ["session_a", "session_b"],
      haystack_dates: ["2023/05/29 (Mon) 10:00", "2023/05/29 (Mon) 11:00"],
      haystack_sessions: [
        [{ role: "user", content: "I mentioned the code word Alpha during planning.", has_answer: false }],
        [{ role: "user", content: "I bought oranges after lunch.", has_answer: true }]
      ]
    }
  ]), "utf8");

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      answerContextMode: "retrieval",
      diagnosticsPath,
      disableIngestLlm: true,
      skipLtmDreaming: true,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.equal(report.samples.length, 1);
    const diagnostic = JSON.parse((await readFile(diagnosticsPath, "utf8")).trim()) as {
      answerRankedSessionIds?: string[];
    };
    assert.equal(diagnostic.answerRankedSessionIds?.[0], "session_a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset generates answers concurrently within eval batches", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let activeAnswerRequests = 0;
  let maxActiveAnswerRequests = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> & { input?: Array<{ content?: string }> } : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const operation = readOpenAiOperation(body);
    if (String(url).endsWith("/chat/completions") && operation !== "answer") {
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (operation === "answer") {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const user = messages[1] as { content?: unknown } | undefined;
      const prompt = typeof user?.content === "string" ? user.content : "";
      activeAnswerRequests += 1;
      maxActiveAnswerRequests = Math.max(maxActiveAnswerRequests, activeAnswerRequests);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeAnswerRequests -= 1;
      const answer = prompt.includes("Question: First?") ? "Alpha" : "Beta";
      return new Response(JSON.stringify(buildChatCompletionTextResponse(answer)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify(buildLongMemEvalQaResponse(init, "yes")), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-answer-batch-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "First?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "Alpha is the first answer." }]]
      },
      {
        question_id: "q2",
        question_type: "multi-session",
        question: "Second?",
        answer: "Beta",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s2"],
        haystack_sessions: [[{ role: "user", content: "Beta is the second answer." }]]
      }
    ]),
    "utf8"
  );

  try {
    const options = {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      evalBatchSize: 2,
      ingestSampleConcurrency: 2,
      answerContextMode: "retrieval" as const,
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true,
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    };
    const report = await evaluateLongMemEvalDataset(filePath, options);

    assert.deepEqual(report.samples.map((sample) => sample.questionId), ["q1", "q2"]);
    assert.equal(maxActiveAnswerRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset bounds answer and judge concurrency independently", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let activeAnswerRequests = 0;
  let maxActiveAnswerRequests = 0;
  let activeJudgeRequests = 0;
  let maxActiveJudgeRequests = 0;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const user = messages[1] as { content?: unknown } | undefined;
    const prompt = typeof user?.content === "string" ? user.content : "";
    if (prompt.includes("You are answering a LongMemEval question.")) {
      activeAnswerRequests += 1;
      maxActiveAnswerRequests = Math.max(maxActiveAnswerRequests, activeAnswerRequests);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeAnswerRequests -= 1;
      return new Response(JSON.stringify(buildChatCompletionTextResponse("Alpha")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (prompt.includes("Is the model response correct?")) {
      activeJudgeRequests += 1;
      maxActiveJudgeRequests = Math.max(maxActiveJudgeRequests, activeJudgeRequests);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeJudgeRequests -= 1;
      return new Response(JSON.stringify(buildChatCompletionTextResponse("yes")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    const operation = readOpenAiOperation(body);
    return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-answer-judge-concurrency-"));
  const filePath = join(dir, "sample.json");
  const samples = Array.from({ length: 6 }, (_, index) => {
    const id = `q${index + 1}`;
    const sessionId = `s${index + 1}`;
    return {
      question_id: id,
      question_type: "single-session-user",
      question: `Question ${index + 1}?`,
      answer: "Alpha",
      answer_session_ids: [sessionId],
      haystack_session_ids: [sessionId],
      haystack_sessions: [[{ role: "user", content: `Alpha evidence ${index + 1}.` }]]
    };
  });
  await writeFile(filePath, JSON.stringify(samples), "utf8");

  try {
    await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      evalBatchSize: 5,
      ingestSampleConcurrency: 5,
      answerConcurrency: 5,
      judgeConcurrency: 1,
      answerContextMode: "retrieval",
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true,
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    } as Parameters<typeof evaluateLongMemEvalDataset>[1] & { answerConcurrency: number; judgeConcurrency: number });

    assert.equal(maxActiveAnswerRequests, 5);
    assert.equal(maxActiveJudgeRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset bounds concurrent sample pipelines by ingestSampleConcurrency", async () => {
  const originalFetch = globalThis.fetch;
  let activeIngestRequests = 0;
  let maxActiveIngestRequests = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> & { input?: Array<{ content?: string }> } : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const dimensions = getContextEngineConfig().embedding.dimensions;
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(dimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/chat/completions")) {
      const operation = readOpenAiOperation(body);
      if (operation === "fact_fusion") {
        activeIngestRequests += 1;
        maxActiveIngestRequests = Math.max(maxActiveIngestRequests, activeIngestRequests);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeIngestRequests -= 1;
      }
      if (operation === "answer") {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Alpha" }, finish_reason: "stop" }] })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "yes" }]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-ingest-sample-concurrency-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "First?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1"],
        haystack_sessions: [[{ role: "user", content: "Alpha is the first answer." }]]
      },
      {
        question_id: "q2",
        question_type: "multi-session",
        question: "Second?",
        answer: "Beta",
        answer_session_ids: ["s2"],
        haystack_session_ids: ["s2"],
        haystack_sessions: [[{ role: "user", content: "Beta is the second answer." }]]
      }
    ]),
    "utf8"
  );

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      ingestSampleConcurrency: 2,
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    });

    assert.equal(report.ingestion.ingestedSessions, 2);
    assert.equal(maxActiveIngestRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset ingests sessions within a sample concurrently", async () => {
  const originalFetch = globalThis.fetch;
  let activeIngestRequests = 0;
  let maxActiveIngestRequests = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> & { input?: Array<{ content?: string }> } : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const dimensions = getContextEngineConfig().embedding.dimensions;
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(dimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/chat/completions")) {
      const operation = readOpenAiOperation(body);
      if (operation === "fact_fusion") {
        activeIngestRequests += 1;
        maxActiveIngestRequests = Math.max(maxActiveIngestRequests, activeIngestRequests);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeIngestRequests -= 1;
      }
      if (operation === "answer") {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Alpha" }, finish_reason: "stop" }] })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify(buildLongMemEvalQaResponse(init, "Alpha")),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-ingest-session-concurrency-"));
  const filePath = join(dir, "sample.json");
  await writeFile(
    filePath,
    JSON.stringify([
      {
        question_id: "q1",
        question_type: "multi-session",
        question: "First?",
        answer: "Alpha",
        answer_session_ids: ["s1"],
        haystack_session_ids: ["s1", "s2"],
        haystack_sessions: [
          [{ role: "user", content: "Alpha is the first answer." }],
          [{ role: "user", content: "Beta is supporting context." }]
        ]
      }
    ]),
    "utf8"
  );

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      ingestSessionConcurrency: 2,
      llm: {
        extraction: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        },
        judge: {
          baseUrl: "http://example.com",
          model: "test-model",
          apiKey: "test-key"
        }
      }
    });

    assert.equal(report.ingestion.ingestedSessions, 2);
    assert.equal(maxActiveIngestRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("longmemeval qa prompt does not include the gold answer", () => {
  const prompt = buildLongMemEvalAnswerPrompt({
    question: "Which phrase should be recalled?",
    serializedPrompt: "Relevant memory says beta context.",
    answer: "SECRET_GOLD_ANSWER_SHOULD_NOT_BE_IN_QA_PROMPT"
  });
  assert.equal(prompt.includes("SECRET_GOLD_ANSWER_SHOULD_NOT_BE_IN_QA_PROMPT"), false);
  assert.equal(prompt.includes("Relevant memory says beta context."), true);
  assert.match(prompt, /Do not treat different entities as the same/u);
  assert.match(prompt, /Across different Sessions/u);
  assert.match(prompt, /without inventing or overstating/u);
  assert.match(prompt, /deduplicate qualifying items/u);
});

test("longmemeval qa prompt explains how fact sequence resolves same-session updates", () => {
  const prompt = buildLongMemEvalAnswerPrompt({
    question: "What is the current value?",
    serializedPrompt: "Session session_a, factSequence 2: The current value is green."
  });

  assert.match(prompt, /larger factSequence/u);
  assert.match(prompt, /values from different Sessions are not directly comparable/u);
  assert.match(prompt, /Across different Sessions/u);
});

test("longmemeval qa prompt prefers the later dated fact for cross-session updates", () => {
  const prompt = buildLongMemEvalAnswerPrompt({
    question: "How many stars do I currently need to reach Gold level?",
    serializedPrompt: [
      "Session older, evidenceTime 2023-07-11: The user needs 125 stars.",
      "Session newer, evidenceTime 2023-07-30: The user needs 120 stars."
    ].join("\n")
  });

  assert.match(prompt, /Across different Sessions, determine recency from validTime, evidenceTime, and explicit relationships/u);
  assert.match(prompt, /treat the chronologically later applicable fact as the latest fact to prioritize when answering/u);
});

test("longmemeval qa prompt preserves evidence reasoning safeguards", () => {
  const prompt = buildLongMemEvalAnswerPrompt({
    question: "How many qualifying events occurred?",
    serializedPrompt: "Context evidence"
  });

  assert.match(prompt, /Prefer direct evidence/u);
  assert.match(prompt, /related facts and paraphrases without inventing or overstating/u);
  assert.match(prompt, /required subject, action, and action state/u);
  assert.match(prompt, /Mentions, recommendations, possibilities, plans, and completed actions are not interchangeable/u);
  assert.match(prompt, /evidence is insufficient or ambiguous/u);
  assert.match(prompt, /For counts, list, justify, and deduplicate qualifying items first/u);
  assert.match(prompt, /general examples only to understand the reasoning method/u);
  assert.match(prompt, /Count the repeated purchase once/u);
  assert.match(prompt, /three distinct attended dinners/u);
  assert.match(prompt, /two bikes, not three actions/u);
  assert.match(prompt, /Subject and action-state filtering/u);
  assert.match(prompt, /assistant only suggested grapefruit and yuzu mixers, the count is three, not five/u);
  assert.match(prompt, /50 - 33 = 17 months = 1 year 5 months/u);
  assert.match(prompt, /Do not import outside prices or guess the missing operand/u);
});

test("longmemeval qa prompt includes the event-relative duration example", () => {
  const prompt = buildLongMemEvalAnswerPrompt({
    question: "How many days ago did I attend the baking class when I made a birthday cake?",
    questionDate: "2022/04/15",
    serializedPrompt: "The class was March 20. The cake was made April 10."
  });

  assert.match(prompt, /Event-relative duration/u);
  assert.match(prompt, /April 10 - March 20 = 21 days, not the Question Date/u);
});

test("evaluateLongMemEvalDataset skips a sample when one session fails before the sample barrier", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let unstartedSessionWasRequested = false;
  let answerWasRequested = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const serialized = JSON.stringify(body);
    const operation = readOpenAiOperation(body);
    if (serialized.includes("UNSTARTED_SESSION")) unstartedSessionWasRequested = true;
    if (operation === "fact_fusion" && serialized.includes("FAIL_SESSION")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (operation === "fact_fusion" || operation === "stm_admission") {
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (operation === "answer") answerWasRequested = true;
    return new Response(JSON.stringify(buildLongMemEvalQaResponse(init, "yes")), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-session-barrier-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "diagnostics.jsonl");
  await writeFile(filePath, JSON.stringify([{
    question_id: "session_barrier_q1",
    question_type: "multi-session",
    question: "What should be recalled?",
    answer: "nothing",
    answer_session_ids: ["failed"],
    haystack_session_ids: ["failed", "unstarted"],
    haystack_sessions: [
      [{ role: "user", content: "FAIL_SESSION" }],
      [{ role: "user", content: "UNSTARTED_SESSION" }]
    ]
  }]), "utf8");

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      diagnosticsPath,
      ingestSessionConcurrency: 1,
      allowLlmFallback: false,
      graphStore: new RecordingGraphMemoryStore(),
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
    assert.equal(report.samples[0]?.skipped, true);
    assert.match(report.samples[0]?.skipReason ?? "", /^sample_error:ingest:/u);
    assert.equal(unstartedSessionWasRequested, false);
    assert.equal(answerWasRequested, false);
    const diagnostics = (await readFile(diagnosticsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { failureStage?: string });
    assert.equal(diagnostics.some((item) => item.failureStage === "ingest"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset repairs reversed source-time facts and continues the sample", async () => {
  const originalFetch = globalThis.fetch;
  let unstartedSessionWasIngested = false;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/embeddings")) {
      const embeddingBody = typeof init?.body === "string"
        ? JSON.parse(init.body) as { input?: unknown }
        : {};
      const inputs = Array.isArray(embeddingBody.input) ? embeddingBody.input : [embeddingBody.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const operation = readOpenAiOperation(body);
    if (operation === "fact_fusion") {
      if (JSON.stringify(body).includes("SHOULD_NOT_BE_INGESTED")) unstartedSessionWasIngested = true;
      const response = buildLongMemEvalIngestChatResponse(body, operation);
      if (JSON.stringify(body).includes("The event occurred on May 14")) {
        const message = response.choices[0]!.message;
        const content = JSON.parse(message.content) as { facts: Array<Record<string, unknown>> };
        content.facts[0]!.validTimeStart = "2023-05-21T14:57:00.000Z";
        content.facts[0]!.validTimeEnd = "2023-05-14T00:00:00.000Z";
        message.content = JSON.stringify(content);
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (operation === "stm_admission") {
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (operation === "answer") {
      return new Response(JSON.stringify(buildChatCompletionTextResponse("SECOND_SAMPLE_COMPLETED")), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "yes" }] }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-temporal-skip-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "diagnostics.jsonl");
  await writeFile(filePath, JSON.stringify([
    {
      question_id: "temporal_error_q1",
      question_type: "multi-session",
      question: "BROKEN_TEMPORAL_SAMPLE",
      answer: "unavailable",
      answer_session_ids: ["temporal_error_s1"],
      haystack_session_ids: ["temporal_error_s1", "temporal_error_s1_unstarted"],
      haystack_sessions: [
        [{ role: "user", content: "The event occurred on May 14." }],
        [{ role: "user", content: "SHOULD_NOT_BE_INGESTED" }]
      ],
      haystack_dates: ["2023/05/21 (Sun) 14:57", "2023/05/22 (Mon) 09:00"]
    },
    {
      question_id: "temporal_error_q2",
      question_type: "single-session-user",
      question: "SECOND_SAMPLE_MUST_COMPLETE",
      answer: "SECOND_SAMPLE_COMPLETED",
      answer_session_ids: ["temporal_error_s2"],
      haystack_session_ids: ["temporal_error_s2"],
      haystack_sessions: [[{ role: "user", content: "The second sample is valid." }]],
      haystack_dates: ["2023/05/22 (Mon) 10:00"]
    }
  ]), "utf8");

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      diagnosticsPath,
      answerContextMode: "retrieval",
      ingestSessionConcurrency: 1,
      skipLtmDreaming: true,
      allowLlmFallback: false,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.equal(report.samples[0]?.skipped, undefined);
    assert.equal(report.samples[0]?.hypothesis, "SECOND_SAMPLE_COMPLETED");
    assert.equal(report.samples[1]?.skipped, undefined);
    assert.equal(report.samples[1]?.hypothesis, "SECOND_SAMPLE_COMPLETED");
    assert.equal(report.answerGeneration.skipped, 0);
    assert.equal(report.ingestion.ingestedSessions, 3);
    assert.equal(report.ingestion.skippedSessions, 0);
    assert.equal(unstartedSessionWasIngested, true);
    const diagnostics = (await readFile(diagnosticsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const repaired = diagnostics.find((item) => item.questionId === "temporal_error_q1");
    assert.ok(repaired);
    assert.equal(repaired?.failureStage, undefined);
    assert.equal(repaired?.failureReason, undefined);

    const rerun = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      diagnosticsPath,
      answerContextMode: "retrieval",
      ingestSessionConcurrency: 1,
      skipLtmDreaming: true,
      allowLlmFallback: false,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });
    assert.equal(rerun.samples[0]?.skipped, undefined);
    assert.equal(rerun.samples[1]?.skipped, undefined);
    assert.equal(rerun.ingestion.skippedSessions, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset marks an exhausted sample and continues with the next sample", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let failedSampleCalls = 0;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === DEFAULT_LLM_REQUEST_RETRY_DELAY_MS) {
      queueMicrotask(() => callback(...args));
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const operation = readOpenAiOperation(body);
    const serialized = JSON.stringify(body);
    if (operation === "answer" && serialized.includes("FIRST_SAMPLE_MUST_SKIP")) {
      failedSampleCalls += 1;
      return new Response("temporary upstream failure", { status: 503 });
    }
    const text = operation === "judge" ? "yes" : "SECOND_SAMPLE_COMPLETED";
    return new Response(JSON.stringify(buildChatCompletionTextResponse(text)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-retry-skip-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "diagnostics.jsonl");
  const tracePath = join(dir, "trace.jsonl");
  const visibleResultCounts: Array<{ questionId: string; count: number }> = [];
  await writeFile(filePath, JSON.stringify([
    {
      question_id: "retry_skip_q1",
      question_type: "single-session-user",
      question: "FIRST_SAMPLE_MUST_SKIP",
      apiKey: "must-not-appear-in-trace",
      answer: "unavailable",
      answer_session_ids: ["retry_skip_s1"],
      haystack_session_ids: ["retry_skip_s1"],
      haystack_sessions: [[{ role: "user", content: "first sample" }]]
    },
    {
      question_id: "retry_skip_q2",
      question_type: "single-session-user",
      question: "SECOND_SAMPLE_MUST_COMPLETE",
      answer: "SECOND_SAMPLE_COMPLETED",
      answer_session_ids: ["retry_skip_s2"],
      haystack_session_ids: ["retry_skip_s2"],
      haystack_sessions: [[{ role: "user", content: "second sample" }]]
    }
  ]), "utf8");

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      diagnosticsPath,
      tracePath,
      runId: "retry-skip-trace-run",
      ingestSampleConcurrency: 2,
      answerConcurrency: 2,
      judgeConcurrency: 2,
      answerContextMode: "retrieval",
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true,
      allowLlmFallback: false,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      },
      onSampleStage: async (event) => {
        if (event.stage !== "result_commit" || event.status !== "succeeded") return;
        visibleResultCounts.push({
          questionId: event.questionId,
          count: (await readJsonlRows(diagnosticsPath)).length
        });
      }
    });

    assert.equal(failedSampleCalls, 30);
    assert.equal(report.samples[0]?.skipped, true);
    assert.match(report.samples[0]?.skipReason ?? "", /stage attempts exhausted/);
    assert.equal(report.samples[1]?.skipped, undefined);
    assert.equal(report.samples[1]?.hypothesis, "SECOND_SAMPLE_COMPLETED");
    assert.equal(report.answerGeneration.skipped, 1);
    assert.equal(report.judge.skipped, 1);
    assert.equal(visibleResultCounts.length, 2);
    assert.equal(visibleResultCounts.every((item) => item.count === 2), true);
    assert.deepEqual(new Set(visibleResultCounts.map((item) => item.questionId)), new Set(["retry_skip_q1", "retry_skip_q2"]));
    const diagnostics = (await readFile(diagnosticsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const answerFailure = diagnostics.find((item) => item.questionId === "retry_skip_q1");
    assert.equal(diagnostics.length, 2);
    assert.equal(answerFailure?.failureStage, "answer");
    assert.equal(answerFailure?.status, "skipped");
    assert.equal(answerFailure?.skipped, true);
    assert.match(String(answerFailure?.skipReason ?? ""), /stage attempts exhausted/);
    const traceText = await readFile(tracePath, "utf8");
    assert.equal(traceText.includes("must-not-appear-in-trace"), false);
    assert.equal(traceText.includes("[REDACTED]"), false);
    assert.equal(traceText.includes("FIRST_SAMPLE_MUST_SKIP"), false);
    const traceRows = traceText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const allowedOperations = new Set(["sample_facts", "sample_stms", "retrieval_candidates", "context_pack_facts"]);
    assert.equal(traceRows.every((row) => row.stage === "sample_summary" && allowedOperations.has(String(row.operation))), true);
    assert.equal(traceRows.every((row) => row.input === undefined), true);
    assert.equal(traceRows.some((row) => row.operation === "llm_request" || row.operation === "append_result"), false);
    const rowsBySample = new Map<string, Record<string, unknown>[]>();
    for (const row of traceRows) {
      const questionId = String((row.sample as { questionId?: string } | undefined)?.questionId ?? "");
      rowsBySample.set(questionId, [...(rowsBySample.get(questionId) ?? []), row]);
    }
    assert.equal(rowsBySample.get("retry_skip_q2")?.length, 3);
    assert.equal(rowsBySample.get("retry_skip_q1")?.length, 3);
    const factsOutput = rowsBySample.get("retry_skip_q2")?.find((row) => row.operation === "sample_facts")?.output as { facts?: unknown[] } | undefined;
    const stmsOutput = rowsBySample.get("retry_skip_q2")?.find((row) => row.operation === "sample_stms")?.output as { stms?: unknown[] } | undefined;
    assert.equal(Array.isArray(factsOutput?.facts), true);
    assert.equal(Array.isArray(stmsOutput?.stms), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("evaluateLongMemEvalDataset records and skips a non-retryable answer error", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  let answerTransportCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) })) });
    }
    answerTransportCalls += 1;
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "longmemeval-answer-error-diagnostic-"));
  const filePath = join(dir, "sample.json");
  const diagnosticsPath = join(dir, "diagnostics.jsonl");
  await writeFile(filePath, JSON.stringify([
    {
      question_id: "answer_error_q1",
      question_type: "single-session-user",
      question: "What did I mention?",
      answer: "Alpha",
      answer_session_ids: ["answer_error_s1"],
      haystack_session_ids: ["answer_error_s1"],
      haystack_sessions: [[{ role: "user", content: "I mentioned Alpha." }]]
    }
  ]), "utf8");

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore: new RecordingGraphMemoryStore(),
      diagnosticsPath,
      answerContextMode: "retrieval",
      disableIngestLlm: true,
      skipStmAdmission: true,
      skipLtmDreaming: true,
      allowLlmFallback: false,
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.equal(report.samples[0]?.skipped, true);
    assert.match(report.samples[0]?.skipReason ?? "", /^sample_error:answer:answer_fallback:/);
    const diagnostic = JSON.parse((await readFile(diagnosticsPath, "utf8")).trim()) as Record<string, unknown>;
    assert.equal(diagnostic.questionId, "answer_error_q1");
    assert.equal(diagnostic.failureStage, "answer");
    assert.equal(diagnostic.status, "skipped");
    assert.equal(diagnostic.skipped, true);
    assert.match(String(diagnostic.failureReason ?? ""), /^sample_error:answer:answer_fallback:/);
    assert.equal(answerTransportCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset retries transient answer context storage failures", async () => {
  const originalFetch = globalThis.fetch;
  const embeddingDimensions = getContextEngineConfig().embedding.dimensions;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (String(url).endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ data: inputs.map((_, index) => ({ index, embedding: Array(embeddingDimensions).fill(0) })) });
    }
    const operation = readOpenAiOperation(body);
    if (operation === "fact_fusion" || operation === "stm_admission") {
      return new Response(JSON.stringify(buildLongMemEvalIngestChatResponse(body, operation)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const text = operation === "judge" ? "yes" : "RECOVERED_ANSWER";
    return new Response(JSON.stringify(buildChatCompletionTextResponse(text)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const graphStore = new TransientSearchGraphMemoryStore();
  const warnings: Array<Record<string, unknown>> = [];
  const dir = await mkdtemp(join(tmpdir(), "longmemeval-context-retry-"));
  const filePath = join(dir, "sample.json");
  await writeFile(filePath, JSON.stringify([{
    question_id: "context_retry_q1",
    question_type: "single-session-user",
    question: "What is the recovered answer?",
    answer: "RECOVERED_ANSWER",
    answer_session_ids: ["context_retry_s1"],
    haystack_session_ids: ["context_retry_s1"],
    haystack_sessions: [[{ role: "user", content: "RECOVERED_ANSWER" }]]
  }]), "utf8");

  try {
    const report = await evaluateLongMemEvalDataset(filePath, {
      ks: [1],
      graphStore,
      answerContextMode: "retrieval",
      skipLtmDreaming: true,
      allowLlmFallback: false,
      logger: {
        info() {},
        warn(fields) { warnings.push(fields); },
        error() {}
      },
      llm: {
        extraction: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" },
        judge: { baseUrl: "http://example.com", model: "test-model", apiKey: "test-key" }
      }
    });

    assert.equal(report.samples[0]?.skipped, undefined, report.samples[0]?.skipReason);
    assert.equal(graphStore.searchAttempts, 3);
    assert.equal(warnings.length, 2);
    assert.equal(report.samples[0]?.hypothesis, "RECOVERED_ANSWER");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluateLongMemEvalDataset reads the repository dataset fixture", async () => {
  const report = await evaluateLongMemEvalDataset("../../datasets/LongMemEval/longmemeval_s_cleaned.json", {
    ks: [1, 5],
    graphStore: new RecordingGraphMemoryStore()
  });

  assert.equal(report.totalSamples, 500);
  assert.equal(report.questionTypeCounts["multi-session"], 133);
  assert.equal(report.questionTypeCounts["temporal-reasoning"], 133);
  assert.equal(report.questionTypeCounts["knowledge-update"], 78);
  assert.equal(report.questionTypeCounts["single-session-user"], 70);
  assert.equal(report.questionTypeCounts["single-session-assistant"], 56);
  assert.equal(report.questionTypeCounts["single-session-preference"], 30);
  assert.equal(report.metrics[1] !== undefined, true);
  assert.equal(report.metrics[5] !== undefined, true);
});
