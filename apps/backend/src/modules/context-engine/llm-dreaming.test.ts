import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDreamingConsolidationKey, processDreamingOutbox, runLlmDreaming } from "./llm-dreaming.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import type { LongTermMemory, ShortTermMemory } from "./domain.js";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "./persistence/memory-repository.js";

const originalFetch = globalThis.fetch;
const embeddingClient = createDeterministicTestEmbeddingClient(512);

test("consolidation keys are stable per STM version and change for a new version", () => {
  const memory = createStm("stm_versioned_key", "版本化巩固键", ["versioned"]);
  const first = createDreamingConsolidationKey(memory, "policy-v1", memory.updatedAt);
  assert.equal(createDreamingConsolidationKey(memory, "policy-v1", memory.updatedAt), first);
  assert.notEqual(createDreamingConsolidationKey(memory, "policy-v1", "2026-01-02T00:00:00.000Z"), first);
});

test("missing dreaming model output schedules retry without creating LTM", async () => {
  const repository = new InMemoryContextEngineRepository();
  const memory = createStm("stm_dream_retry", "需要稍后重试的长期记忆", ["retry"]);
  await repository.saveShortTermMemory(memory);

  const result = await runLlmDreaming(repository, {
    embeddingClient,
    apiKey: "",
    memoryDataIds: [memory.memoryDataId],
    now: "2026-07-30T00:00:00.000Z"
  });

  assert.deepEqual(result.longTermMemories, []);
  assert.equal(result.fallbackReason, "missing_api_key");
  assert.equal(typeof result.retryAfter, "string");
  assert.equal(repository.getShortTermMemory(memory.memoryDataId)?.consolidationStatus, "retryable_failure");
  assert.equal(repository.pipelineTasks.at(-1)?.status, "retry_scheduled");
  assert.equal(repository.getDebugSnapshot().relationEdges.length, 0);
});

test("scores each STM independently and deterministically projects only consolidated STM", async () => {
  const repository = new InMemoryContextEngineRepository();
  const preference = createStm("stm_score_preference", "用户希望回答先给结论。", ["answer_style"]);
  preference.memoryType = "preference";
  const project = createStm("stm_score_project", "项目 Orion 使用 Neo4j。", ["project_orion"]);
  project.memoryType = "project";
  await repository.saveShortTermMemory(preference);
  await repository.saveShortTermMemory(project);

  let requestCount = 0;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      return scoreResponse([
        scoreItem(preference.memoryDataId, 5),
        {
          ...scoreItem(project.memoryDataId, 10),
          content: "模型试图改写的内容不会被采用",
          sourceMemoryDataIds: [preference.memoryDataId, project.memoryDataId]
        }
      ]);
    }
    return classificationResponseForRequest(init, "task");
  };

  try {
    const result = await runLlmDreaming(repository, {
      embeddingClient,
      apiKey: "test-key",
      baseUrl: "https://llm.example/v1",
      model: "test-model",
      memoryDataIds: [preference.memoryDataId, project.memoryDataId],
      now: "2026-07-30T00:00:00.000Z"
    });

    assert.equal(result.stmEvaluations?.length, 2);
    assert.equal(result.stmEvaluations?.find((item) => item.memoryDataId === preference.memoryDataId)?.decision, "observe");
    assert.equal(result.stmEvaluations?.find((item) => item.memoryDataId === project.memoryDataId)?.decision, "consolidate");
    assert.equal(result.longTermMemories.length, 1);
    assert.equal(result.longTermMemories[0]?.content, project.content);
    assert.deepEqual(result.longTermMemories[0]?.sourceMemoryDataIds, [project.memoryDataId]);
    assert.equal(result.longTermMemories[0]?.memoryType, "task");
    assert.equal(result.longTermMemories[0]?.theoryClass, "prospective");
    assert.equal(result.longTermMemories[0]?.matchedRules.includes("llm_ltm_classification"), true);
    assert.equal(requestCount, 2);
    assert.equal(repository.getShortTermMemory(preference.memoryDataId)?.consolidationStatus, "observing");
    assert.equal(repository.getShortTermMemory(project.memoryDataId), undefined);
    assert.equal(result.updatedShortTermMemories.some((memory) => memory.memoryDataId === project.memoryDataId), false);
    assert.ok(repository.getDebugSnapshot().changeEvents.some((event) =>
      event.memoryDataId === project.memoryDataId &&
      event.changeType === "deleted" &&
      event.reason === "dreaming_consolidated_to_ltm"
    ));
    const prompt = JSON.parse(result.trace.prompt) as {
      rubricVersion: string;
      scoringProtocol: string[];
      hardCaps: string[];
    };
    assert.equal(prompt.rubricVersion, "stm-ltm-seven-factor-rubric.v1");
    assert.equal(prompt.scoringProtocol.some((item) => item.includes("七个维度独立评分")), true);
    assert.equal(prompt.scoringProtocol.some((item) => item.includes("reuseValue") && item.includes("固定返回 0")), true);
    assert.equal(prompt.hardCaps.some((item) => item.includes("preferenceConsistency") && item.includes("必须为 5")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects legacy model-authored memories instead of persisting them", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm_legacy_output", "原始 STM 内容", ["legacy"]);
  await repository.saveShortTermMemory(stm);
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ memories: [{ content: "模型创作内容" }] }) } }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const result = await runLlmDreaming(repository, {
      embeddingClient,
      apiKey: "test-key",
      baseUrl: "https://llm.example/v1",
      model: "test-model",
      memoryDataIds: [stm.memoryDataId]
    });
    assert.equal(result.longTermMemories.length, 0);
    assert.equal(result.fallbackReason, "llm_returned_incomplete_stm_scores");
    assert.equal(repository.getDebugSnapshot().longTermMemories.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects rubric output with incomplete reasons or model-authored reuse value", async () => {
  const cases = [
    {
      id: "incomplete_reasons",
      mutate: (item: ReturnType<typeof scoreItem>) => ({
        ...item,
        scoreReasons: { stability: "evidence=test; rationale=test" }
      }),
      rejectedReason: "seven_factor_score_reasons_required"
    },
    {
      id: "model_reuse_value",
      mutate: (item: ReturnType<typeof scoreItem>) => ({
        ...item,
        scores: { ...item.scores, reuseValue: 8 }
      }),
      rejectedReason: "seven_factor_scores_required"
    }
  ];

  for (const item of cases) {
    const repository = new InMemoryContextEngineRepository();
    const stm = createStm(`stm_${item.id}`, "严格 rubric 输出才能进入 LTM。", [item.id]);
    await repository.saveShortTermMemory(stm);
    globalThis.fetch = async () => scoreResponse([item.mutate(scoreItem(stm.memoryDataId, 8))]);

    try {
      const result = await runLlmDreaming(repository, {
        embeddingClient,
        apiKey: "test-key",
        baseUrl: "https://llm.example/v1",
        model: "test-model",
        memoryDataIds: [stm.memoryDataId]
      });
      assert.equal(result.longTermMemories.length, 0);
      assert.equal(result.fallbackReason, "llm_returned_incomplete_stm_scores");
      assert.equal(result.trace.rejectedCandidates[0]?.reason, item.rejectedReason);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("drop retains the STM without creating an LTM", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm_drop_release_compat", "无需长期保留", ["drop"]);
  await repository.saveShortTermMemory(stm);
  globalThis.fetch = async () => scoreResponse([scoreItem(stm.memoryDataId, 0)]);
  try {
    const result = await runLlmDreaming(repository, {
      embeddingClient,
      apiKey: "test-key",
      baseUrl: "https://llm.example/v1",
      model: "test-model",
      memoryDataIds: [stm.memoryDataId]
    });
    assert.equal(result.stmEvaluations?.[0]?.decision, "drop");
    assert.equal(result.longTermMemories.length, 0);
    assert.equal(repository.getShortTermMemory(stm.memoryDataId)?.consolidationStatus, "dropped");
    assert.equal(repository.getShortTermMemory(stm.memoryDataId)?.lifecycleStatus, "active");
    assert.ok(repository.getDebugSnapshot().changeEvents.some((event) =>
      event.memoryDataId === stm.memoryDataId &&
      event.changeType === "updated" &&
      event.reason === "dreaming_ltm_skipped_stm_retained"
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("creates a new equivalent owner LTM and relates it without rewriting the old record", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm_reinforce", "用户偏好先给结论。", ["answer_style"]);
  stm.memoryType = "preference";
  const oldStm = createStm("stm_old", "用户偏好先给结论", ["answer_style"]);
  await repository.saveShortTermMemory(stm);
  await repository.saveShortTermMemory(oldStm);
  const existing: LongTermMemory = {
    memoryId: "ltm_existing_preference",
    theoryClass: "procedural",
    memoryType: "preference",
    content: oldStm.content,
    sourceRefs: oldStm.sourceRefs,
    sourceMemoryDataIds: [oldStm.memoryDataId],
    entityIds: oldStm.entityIds,
    confidenceLevel: "medium",
    recallWeight: "medium",
    solidifyReason: "existing",
    matchedRules: ["existing"],
    lifecycleStatus: "active"
  };
  await repository.replaceLongTermMemory(existing);
  globalThis.fetch = async () => scoreResponse([scoreItem(stm.memoryDataId, 10)]);

  try {
    const result = await runLlmDreaming(repository, {
      embeddingClient,
      apiKey: "test-key",
      baseUrl: "https://llm.example/v1",
      model: "test-model",
      memoryDataIds: [stm.memoryDataId]
    });
    assert.equal(result.ltmOperations?.[0]?.operation, "create");
    assert.equal(result.ltmOperations?.[0]?.relationType, "is_same_as");
    assert.equal(repository.getDebugSnapshot().longTermMemories.length, 2);
    assert.equal(repository.getDebugSnapshot().longTermMemories.find((memory) => memory.memoryId === existing.memoryId)?.content, oldStm.content);
    assert.deepEqual(repository.getDebugSnapshot().longTermMemories.find((memory) => memory.sourceMemoryDataIds.includes(stm.memoryDataId))?.sourceMemoryDataIds, [stm.memoryDataId]);
    assert.equal(result.longTermMemories[0]?.memoryType, "preference");
    assert.equal(result.longTermMemories[0]?.theoryClass, "procedural");
    assert.equal(result.longTermMemories[0]?.matchedRules.includes("ltm_classification_fallback"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a terminal STM is not projected again under the same Dreaming policy", async () => {
  const repository = new InMemoryContextEngineRepository();
  const stm = createStm("stm_idempotent", "项目 Orion 使用 Neo4j。", ["project_orion"]);
  await repository.saveShortTermMemory(stm);
  globalThis.fetch = async () => scoreResponse([scoreItem(stm.memoryDataId, 10)]);
  try {
    const first = await runLlmDreaming(repository, {
      embeddingClient,
      apiKey: "test-key", baseUrl: "https://llm.example/v1", model: "test-model",
      memoryDataIds: [stm.memoryDataId], runId: "run-idempotent-1"
    });
    const firstLtm = first.longTermMemories[0]!;
    const second = await runLlmDreaming(repository, {
      embeddingClient,
      apiKey: "test-key", baseUrl: "https://llm.example/v1", model: "test-model",
      memoryDataIds: [stm.memoryDataId], runId: "run-idempotent-2"
    });
    assert.equal(second.fallbackReason, "no_dreaming_candidates");
    assert.equal(second.longTermMemories.length, 0);
    assert.equal(repository.getDebugSnapshot().longTermMemories.length, 1);
    assert.equal(repository.getDebugSnapshot().longTermMemories[0]?.version, firstLtm.version);
    assert.equal(repository.getShortTermMemory(stm.memoryDataId), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SQLite preserves STM evaluations and deterministic LTM metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dreaming-stm-score-"));
  const repository = new SqliteContextEngineRepository(join(dir, "store.sqlite"));
  const stm = createStm("stm_sqlite_reliability", "项目 Orion 使用 Neo4j。", ["project_orion"]);
  await repository.saveShortTermMemory(stm);
  globalThis.fetch = async () => scoreResponse([scoreItem(stm.memoryDataId, 10)]);
  try {
    const result = await runLlmDreaming(repository, {
      embeddingClient,
      apiKey: "test-key", baseUrl: "https://llm.example/v1", model: "test-model", memoryDataIds: [stm.memoryDataId]
    });
    const ltm = result.longTermMemories[0]!;
    assert.equal(ltm.content, stm.content);
    assert.equal(typeof ltm.consolidationKey, "string");
    assert.equal(repository.getDebugSnapshot().pipelineTasks.at(-1)?.checkpoint, "completed");
    const reopened = new SqliteContextEngineRepository(join(dir, "store.sqlite"));
    assert.equal(reopened.getDebugSnapshot().llmDreamingTraces[0]?.stmEvaluations?.[0]?.memoryDataId, stm.memoryDataId);
    assert.equal(reopened.getDebugSnapshot().longTermMemories[0]?.content, stm.content);
    reopened.close();
  } finally {
    repository.close();
    globalThis.fetch = originalFetch;
  }
});

test("dreaming transaction rolls back deterministic projection when a commit step fails", async () => {
  class FailingRepository extends InMemoryContextEngineRepository {
    override async saveMemoryChangeEvent() { throw new Error("forced_dreaming_commit_failure"); }
  }
  const repository = new FailingRepository();
  const stm = createStm("stm_transaction_rollback", "事务失败时不应留下 LTM。", ["rollback"]);
  await repository.saveShortTermMemory(stm);
  globalThis.fetch = async () => scoreResponse([scoreItem(stm.memoryDataId, 10)]);
  try {
    await assert.rejects(() => runLlmDreaming(repository, {
      embeddingClient,
      apiKey: "test-key", baseUrl: "https://llm.example/v1", model: "test-model", memoryDataIds: [stm.memoryDataId]
    }), /forced_dreaming_commit_failure/u);
    assert.equal(repository.getDebugSnapshot().longTermMemories.length, 0);
    assert.equal(repository.getDebugSnapshot().changeEvents.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed dreaming outbox records remain retryable", async () => {
  class FailingIndexRepository extends InMemoryContextEngineRepository {
    override async saveIndexEntry() { throw new Error("forced_index_failure"); }
  }
  const repository = new FailingIndexRepository();
  const memory = createStm("stm_outbox_retry", "索引失败后 Outbox 应可重试。", ["outbox"]);
  const now = new Date().toISOString();
  await repository.saveDreamingOutbox({
    outboxId: "outbox-test", operation: "refresh_stm_index", ownerId: memory.memoryDataId,
    payload: { memory }, status: "pending", attempts: 0, createdAt: now, updatedAt: now
  });
  await processDreamingOutbox(repository, now);
  const record = repository.getDebugSnapshot().dreamingOutbox[0]!;
  assert.equal(record.status, "failed");
  assert.equal(record.attempts, 1);
  assert.match(record.lastError ?? "", /forced_index_failure/u);
});

function scoreItem(memoryDataId: string, score: number) {
  return {
    memoryDataId,
    scores: {
      stability: score,
      reuseValue: 0,
      identityRelationValue: score,
      actionCommitmentValue: score,
      informationEntropy: score,
      explicitWeight: score,
      preferenceConsistency: score
    },
    scoreReasons: {
      stability: "evidence=test; rationale=test",
      reuseValue: "evidence=server_owned; rationale=placeholder_only",
      identityRelationValue: "evidence=test; rationale=test",
      actionCommitmentValue: "evidence=test; rationale=test",
      informationEntropy: "evidence=test; rationale=test",
      explicitWeight: "evidence=test; rationale=test",
      preferenceConsistency: "evidence=test; rationale=test"
    }
  };
}

function scoreResponse(scores: unknown[]) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ scores }) } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function classificationResponseForRequest(init: RequestInit | undefined, memoryType: string) {
  const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
  const prompt = JSON.parse(body.messages[1]!.content) as { memories: Array<{ memoryId: string }> };
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          classifications: prompt.memories.map((memory) => ({ memoryId: memory.memoryId, memoryType }))
        })
      }
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function createStm(memoryDataId: string, content: string, entityIds: string[]): ShortTermMemory {
  return {
    memoryDataId,
    tenantId: "local",
    principalId: "debug-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryDataType: "manual_memory_event",
    memoryType: "project",
    content,
    sourceFactIds: [`fact_${memoryDataId}`],
    sourceRefs: [{ sourceRefId: `src_${memoryDataId}`, sourceType: "file", sourceId: memoryDataId }],
    entityIds,
    importanceLevel: "high",
    confidenceLevel: "high",
    admissionResult: "write_high_priority",
    admissionReason: "dreaming_test",
    matchedRules: ["dreaming_test"],
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
