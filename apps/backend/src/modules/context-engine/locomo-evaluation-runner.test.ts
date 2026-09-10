import test from "node:test";
import assert from "node:assert/strict";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { parseLocomoEvaluationDataset } from "./locomo-dataset.js";
import { evaluateLocomoQuestion, ingestLocomoSession, prepareLocomoConversation } from "./locomo-evaluation.js";
import { runLocomoEvaluation } from "./locomo-evaluation-runner.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

const identity = { runId: "test", datasetSha256: "fixture", configFingerprint: "config", storeFingerprint: "store", modelFingerprint: "model" };

test("runner retries session ingestion and evaluates two conversations without scope or gold leakage", async () => {
  const repository = new InMemoryContextEngineRepository();
  const conversations = fixtureConversations();
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  const lifecycle: string[] = [];
  let ingestAttempts = 0;
  const first = await prepareLocomoConversation(repository, conversations[0]!, {
    disableIngestLlm: true,
    embeddingClient,
    maxSessionAttempts: 2,
    sessionIngest: async (repo, event, options) => {
      ingestAttempts += 1;
      if (ingestAttempts === 1) throw new Error("retry once");
      await ingestLocomoSession(repo, event, options);
    }
  });
  assert.equal(first.status, "prepared");
  assert.equal(ingestAttempts, 2);

  const report = await runLocomoEvaluation({
    command: "full",
    repository,
    conversations,
    identity,
    prepareOptions: { disableIngestLlm: true, embeddingClient },
    questionOptions: {
      embeddingClient,
      generateAnswer: async (prompt) => {
        if (prompt.includes("Alice")) { await delay(20); return "dog"; }
        return "parrot";
      }
    },
    questionConcurrency: 2,
    operations: {
      prepareConversation: async (repo, conversation, options) => {
        lifecycle.push(`prepare:${conversation.conversationId}`);
        return prepareLocomoConversation(repo, conversation, options);
      },
      evaluateQuestion: async (repo, conversation, question, options) => {
        lifecycle.push(`question:${conversation.conversationId}:${question.questionId}`);
        return evaluateLocomoQuestion(repo, conversation, question, options);
      }
    }
  });
  assert.deepEqual(report.questions.map((item) => item.questionId), ["one:q1", "two:q1"]);
  assert.equal(report.questions.every((item) => item.status === "succeeded"), true);
  assert.equal(report.summary.pipeline.questionsEvaluated, 2);
  assert.equal(lifecycle.indexOf("question:one:one:q1") < lifecycle.indexOf("prepare:two"), true);
  const stored = JSON.stringify(repository.getDebugSnapshot());
  assert.doesNotMatch(stored, /oracle-only-secret|reference-only-secret/);
  assert.equal(repository.getDebugSnapshot().longTermMemories.length, 0);
  for (const result of report.questions) {
    if (result.status === "succeeded") {
      assert.equal(result.candidates.every((candidate) => candidate.sourceRefs.every((ref) => ref.metadata?.conversationId === result.conversationId)), true);
    }
  }
});

test("runner answers only categories 1-4 and filters out category 5", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  const conversation = parseLocomoEvaluationDataset([{
    sample_id: "mixed",
    conversation: {
      session_1: [{ dia_id: "D1:1", speaker: "Alice", text: "I adopted a dog." }],
      session_1_date_time: "1:00 pm on 1 May, 2023"
    },
    qa: [
      { question: "What did Alice adopt?", answer: "dog", evidence: ["D1:1"], category: 4 },
      { question: "What was not stated?", answer: "", evidence: [], category: 5 }
    ]
  }], { sha256: "fixture" }).conversations[0]!;
  const report = await runLocomoEvaluation({
    command: "full",
    repository,
    conversations: [conversation],
    identity,
    prepareOptions: { disableIngestLlm: true, embeddingClient },
    questionOptions: { embeddingClient, generateAnswer: async () => "dog" }
  });
  assert.deepEqual(report.questions.map((item) => item.questionId), ["mixed:q1"]);
  assert.deepEqual(report.questions.map((item) => item.category), [4]);
  assert.equal(report.summary.pipeline.questionsSelected, 1);
});

test("conversation question concurrency retains original QA result order", async () => {
  const repository = new InMemoryContextEngineRepository();
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  const conversation = parseLocomoEvaluationDataset([{
    sample_id: "ordered",
    conversation: {
      session_1: [{ dia_id: "D1:1", speaker: "Alice", text: "I adopted a dog and named it Pip." }],
      session_1_date_time: "1:00 pm on 1 May, 2023"
    },
    qa: [
      { question: "What did Alice adopt?", answer: "dog", evidence: ["D1:1"], category: 4 },
      { question: "What was its name?", answer: "Pip", evidence: ["D1:1"], category: 4 }
    ]
  }], { sha256: "fixture" }).conversations[0]!;
  const completed: string[] = [];
  const report = await runLocomoEvaluation({
    command: "full",
    repository,
    conversations: [conversation],
    identity,
    prepareOptions: { disableIngestLlm: true, embeddingClient },
    questionOptions: { embeddingClient },
    questionConcurrency: 2,
    operations: {
      evaluateQuestion: async (repo, current, question, options) => {
        if (question.questionIndex === 0) await delay(20);
        const result = await evaluateLocomoQuestion(repo, current, question, {
          ...options,
          generateAnswer: async () => question.questionIndex === 0 ? "dog" : "Pip"
        });
        completed.push(question.questionId);
        return result;
      }
    }
  });
  assert.deepEqual(completed, ["ordered:q2", "ordered:q1"]);
  assert.deepEqual(report.questions.map((item) => item.questionId), ["ordered:q1", "ordered:q2"]);
});

test("runner isolates question failures and skips every question in a failed conversation", async () => {
  const repository = new InMemoryContextEngineRepository();
  const conversations = fixtureConversations();
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  const report = await runLocomoEvaluation({
    command: "full",
    repository,
    conversations,
    identity,
    prepareOptions: { disableIngestLlm: true, embeddingClient },
    questionOptions: { embeddingClient, generateAnswer: async () => "dog" },
    maxQuestionAttempts: 2,
    operations: {
      prepareConversation: async (repo, conversation, options) => conversation.conversationId === "one"
        ? { conversationId: "one", contextScopeId: conversation.contextScopeId, status: "failed", sessionsPrepared: 0, facts: 0, shortTermMemories: 0, error: "forced preparation failure" }
        : prepareLocomoConversation(repo, conversation, options),
      evaluateQuestion: async (repo, conversation, question, options) => {
        if (conversation.conversationId === "two") throw new Error("forced answer failure");
        return evaluateLocomoQuestion(repo, conversation, question, options);
      }
    }
  });
  assert.deepEqual(report.questions.map((item) => [item.conversationId, item.status, item.status === "skipped" ? item.stage : "ok"]), [
    ["one", "skipped", "conversation_prepare"],
    ["two", "skipped", "question"]
  ]);
  assert.equal(report.summary.pipeline.questionsSkipped, 2);
});

function fixtureConversations() {
  return parseLocomoEvaluationDataset([
    {
      sample_id: "one",
      conversation: { session_1: [{ dia_id: "D1:1", speaker: "Alice", text: "I adopted a dog." }], session_1_date_time: "1:00 pm on 1 May, 2023" },
      qa: [{ question: "What did Alice adopt?", answer: "dog", evidence: ["D1:1"], category: 4 }],
      observation: { "D1:1": ["oracle-only-secret"] }
    },
    {
      sample_id: "two",
      conversation: { session_1: [{ dia_id: "D2:1", speaker: "Bob", text: "I adopted a parrot." }], session_1_date_time: "2:00 pm on 2 May, 2023" },
      qa: [{ question: "What did Bob adopt?", answer: "parrot", evidence: ["D2:1"], category: 4 }],
      observation: { "D2:1": ["reference-only-secret"] }
    }
  ], { sha256: "fixture" }).conversations;
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
