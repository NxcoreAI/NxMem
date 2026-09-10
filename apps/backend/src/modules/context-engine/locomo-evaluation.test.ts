import test from "node:test";
import assert from "node:assert/strict";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { buildLocomoSessionEvent, evaluateLocomoQuestion, ingestLocomoSession, prepareLocomoConversation } from "./locomo-evaluation.js";
import { buildLocomoRunSummary } from "./locomo-evaluation-runner.js";
import { parseLocomoEvaluationDataset } from "./locomo-dataset.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { parseLocomoEvaluationArgs } from "./locomo-evaluation-cli.js";

test("native session events contain conversation only and preserve dia IDs", () => {
  const conversation = fixtureConversation();
  const event = buildLocomoSessionEvent(conversation, conversation.sessions[0]!);
  const serialized = JSON.stringify(event);
  assert.equal(event.contextScopeId, conversation.contextScopeId);
  assert.equal(event.permissionSnapshot.principalId, conversation.principalId);
  assert.equal(event.multimodalData[0]!.sourceRefs?.[0]?.metadata?.diaId, "D1:1");
  assert.match(serialized, /Alice: I adopted a dog/);
  assert.doesNotMatch(serialized, /gold answer|category|evidence|observation/i);
});

test("prepares each session once through Fact and STM without LTM", async () => {
  const repository = new InMemoryContextEngineRepository();
  const conversation = fixtureConversation();
  const first = await prepareLocomoConversation(repository, conversation, {
    disableIngestLlm: true,
    embeddingClient: createDeterministicTestEmbeddingClient(32)
  });
  assert.equal(first.status, "prepared");
  assert.equal(first.sessionsPrepared, 1);
  assert.equal(repository.getDebugSnapshot().memoryEvents.length, 1);
  assert.equal(repository.getDebugSnapshot().longTermMemories.length, 0);
  const second = await prepareLocomoConversation(repository, conversation, {
    disableIngestLlm: true,
    embeddingClient: createDeterministicTestEmbeddingClient(32)
  });
  assert.equal(second.status, "prepared");
  assert.equal(repository.getDebugSnapshot().memoryEvents.length, 1);
});

test("re-prepares a session whose ingest task is stuck in a non-terminal state", async () => {
  const repository = new InMemoryContextEngineRepository();
  const conversation = fixtureConversation();
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  // 模拟上次运行中断：事件已保存但 ingest task 卡在 running（LLM 抖动抛错后留下的僵尸状态）
  const event = buildLocomoSessionEvent(conversation, conversation.sessions[0]!);
  await repository.saveMemoryEvent(event);
  await repository.savePipelineTask({
    taskId: `ingest_${event.eventId}`,
    eventId: event.eventId,
    taskType: "ingest",
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    retryable: true,
    stage: "admission_started",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const result = await prepareLocomoConversation(repository, conversation, {
    disableIngestLlm: true,
    embeddingClient
  });
  assert.equal(result.status, "prepared");
  assert.equal(result.facts > 0, true);
  const task = repository.getDebugSnapshot().pipelineTasks.find((item) => item.eventId === event.eventId);
  assert.equal(task?.status, "succeeded", "stuck task should be re-run to success");
});

test("ingestLocomoSession marks the task failed when the pipeline throws", async () => {
  const repository = new InMemoryContextEngineRepository();
  const conversation = fixtureConversation();
  const event = buildLocomoSessionEvent(conversation, conversation.sessions[0]!);
  // embedding client 抛错 → ingest 中途失败
  const failingEmbedding = {
    fingerprint: "test",
    dimensions: 32,
    embed: async () => { throw new Error("embedding unavailable"); },
    embedBatch: async () => { throw new Error("embedding unavailable"); }
  } as unknown as ReturnType<typeof createDeterministicTestEmbeddingClient>;
  await assert.rejects(
    () => ingestLocomoSession(repository, event, { embeddingClient: failingEmbedding }),
    /embedding unavailable/
  );
  const task = repository.getDebugSnapshot().pipelineTasks.find((item) => item.eventId === event.eventId);
  assert.equal(task?.status, "failed", "failed ingest should leave a terminal failed task, not a zombie running");
  assert.match(task?.error ?? "", /embedding unavailable/);
});

test("CLI rejects LTM flags and conflicting sample selectors", () => {
  assert.throws(() => parseLocomoEvaluationArgs(["node", "cli", "full", "--enable-ltm"]), /not valid/);
  assert.throws(() => parseLocomoEvaluationArgs(["node", "cli", "--sample-id", "a", "--sample-range", "1:2"]), /cannot be combined/);
  assert.equal(parseLocomoEvaluationArgs(["node", "cli", "prepare", "--ci"]).command, "prepare");
  assert.equal(parseLocomoEvaluationArgs(["node", "cli", "--json"]).json, true);
  assert.equal(parseLocomoEvaluationArgs(["node", "cli"]).json, false);
});

test("question evaluation is scope-isolated and does not put evaluator sidecar in the prompt", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  const first = fixtureConversation();
  const second = parseLocomoEvaluationDataset([{
    sample_id: "native-2",
    conversation: {
      session_1: [{ dia_id: "D2:1", speaker: "Bob", text: "I adopted a parrot." }],
      session_1_date_time: "2:00 pm on 2 May, 2023"
    },
    qa: [{ question: "What did Bob adopt?", answer: "parrot", evidence: ["D2:1"], category: 4 }]
  }], { sha256: "fixture-hash" }).conversations[0]!;
  for (const conversation of [first, second]) {
    const prepared = await prepareLocomoConversation(repository, conversation, { disableIngestLlm: true, embeddingClient });
    assert.equal(prepared.status, "prepared");
  }
  let answerPrompt = "";
  const judged = await evaluateLocomoQuestion(repository, first, first.questions[0]!, {
    embeddingClient,
    generateAnswer: async (prompt) => {
      answerPrompt = prompt;
      return "dog";
    },
    generateJudge: async () => JSON.stringify({ reasoning: "dog matches gold", label: "CORRECT" })
  });
  const result = judged;
  assert.equal(result.judge.status, "judged");
  if (result.judge.status === "judged") {
    assert.equal(result.judge.label, "CORRECT");
    assert.equal(result.judge.score, 1);
  }
  assert.equal(result.candidates.every((candidate) =>
    candidate.sourceRefs.every((ref) => ref.metadata?.conversationId === first.conversationId)
  ), true);
  assert.equal(result.candidates.every((candidate) => candidate.layer === "fact" || candidate.layer === "stm"), true);
  assert.equal(result.selectedItems.every((candidate) => candidate.layer === "fact" || candidate.layer === "stm"), true);
  assert.equal(result.serializedPrompt.includes("【Context Pack】"), true);
  assert.equal(result.serializedPrompt.includes("D1:1"), true);
  assert.equal(result.tokenUsage.requested, 20_000);
  assert.equal(result.tokenUsage.used <= result.tokenUsage.requested, true);
  assert.equal(Array.isArray(result.citations), true);
  assert.equal(Array.isArray(result.conflicts), true);
  assert.equal(result.evidenceSelection.selected.length, result.selectedItems.length);
  assert.equal(result.evidence.factExtractionRecall, 1);
  assert.equal(result.evidence.stmAdmissionRecall, 1);
  assert.equal(result.evidence.retrievalRecall, 1);
  assert.equal(result.evidence.packRecall, 1);
  assert.doesNotMatch(answerPrompt, /gold answer|oracle observation|category/i);
  assert.match(answerPrompt, /No information available/);
});

test("run summary aggregates LLM judge J-scores per category", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  const first = fixtureConversation();
  const second = parseLocomoEvaluationDataset([{
    sample_id: "native-2",
    conversation: {
      session_1: [{ dia_id: "D2:1", speaker: "Bob", text: "I adopted a parrot." }],
      session_1_date_time: "2:00 pm on 2 May, 2023"
    },
    qa: [{ question: "What did Bob adopt?", answer: "parrot", evidence: ["D2:1"], category: 4 }]
  }], { sha256: "fixture-hash" }).conversations[0]!;
  for (const conversation of [first, second]) {
    await prepareLocomoConversation(repository, conversation, { disableIngestLlm: true, embeddingClient });
  }
  const answer = async () => "dog";
  const firstResult = await evaluateLocomoQuestion(repository, first, first.questions[0]!, {
    embeddingClient,
    generateAnswer: answer,
    generateJudge: async () => JSON.stringify({ reasoning: "dog matches gold", label: "CORRECT" })
  });
  const secondResult = await evaluateLocomoQuestion(repository, second, second.questions[0]!, {
    embeddingClient,
    generateAnswer: async () => "a cat",
    generateJudge: async () => JSON.stringify({ reasoning: "a cat does not match parrot", label: "WRONG" })
  });
  const summary = buildLocomoRunSummary([firstResult, secondResult], [], 2);
  assert.equal(summary.llmJudge.judged, 2);
  assert.equal(summary.llmJudge.correct, 1);
  assert.equal(summary.llmJudge.jScore, 0.5);
  assert.equal(summary.llmJudge.categoryJScores[1]!.jScore, 1);
  assert.equal(summary.llmJudge.categoryJScores[4]!.jScore, 0);
});

function fixtureConversation() {
  return parseLocomoEvaluationDataset([{
    sample_id: "native-1",
    conversation: {
      session_1: [{ dia_id: "D1:1", speaker: "Alice", text: "I adopted a dog." }],
      session_1_date_time: "1:00 pm on 1 May, 2023"
    },
    qa: [{ question: "What did Alice adopt?", answer: "gold answer", evidence: ["D1:1"], category: 1 }],
    observation: { "D1:1": ["oracle observation"] }
  }], { sha256: "fixture-hash" }).conversations[0]!;
}
