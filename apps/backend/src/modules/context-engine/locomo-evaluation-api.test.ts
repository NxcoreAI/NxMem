import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHealthServer } from "../../modules/health/server.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";

test("LoCoMo API rejects an empty dataset path", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const response = await server.inject({ method: "POST", url: "/context/evaluations/locomo", payload: {} });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "datasetPath is required");
  await server.close();
});

test("LoCoMo API creates, reads, and cancels a dedicated job", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const directory = await mkdtemp(join(tmpdir(), "locomo-api-"));
  const datasetPath = join(directory, "locomo.json");
  await writeFile(datasetPath, JSON.stringify([{
    sample_id: "conv-api",
    conversation: {
      session_1: [{ dia_id: "D1:1", speaker: "A", text: "hello" }],
      session_1_date_time: "1:00 pm on 1 May, 2023"
    },
    qa: [{ question: "What was said?", answer: "hello", evidence: ["D1:1"], category: 4 }]
  }]));
  const created = await server.inject({
    method: "POST",
    url: "/context/evaluations/locomo",
    payload: { datasetPath, command: "full", sampleIds: ["conv-api"], ci: true }
  });
  assert.equal(created.statusCode, 200);
  const jobId = created.json().result.jobId as string;
  assert.match(jobId, /^locomo_/);
  const status = await server.inject({ method: "GET", url: `/context/evaluations/locomo/${jobId}` });
  assert.equal(status.statusCode, 200);
  const cancelled = await server.inject({ method: "POST", url: `/context/evaluations/locomo/${jobId}/cancel` });
  assert.equal(cancelled.statusCode, 200);
  assert.ok(["cancelled", "error", "done"].includes(cancelled.json().result.status));
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

test("LoCoMo API rejects LongMemEval structure before creating a job", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const directory = await mkdtemp(join(tmpdir(), "locomo-format-"));
  const datasetPath = join(directory, "longmemeval.json");
  await writeFile(datasetPath, JSON.stringify([{ question_id: "q1", haystack_sessions: [[]] }]));
  const response = await server.inject({ method: "POST", url: "/context/evaluations/locomo", payload: { datasetPath } });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /conversation must be an object/);
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

test("LoCoMo API accepts the shared extraction and answer model configuration", async () => {
  const server = createHealthServer(new InMemoryContextEngineRepository());
  const directory = await mkdtemp(join(tmpdir(), "locomo-model-api-"));
  const datasetPath = join(directory, "locomo.json");
  await writeFile(datasetPath, JSON.stringify([{
    sample_id: "conv-model",
    conversation: {
      session_1: [{ dia_id: "D1:1", speaker: "A", text: "hello" }],
      session_1_date_time: "1:00 pm on 1 May, 2023"
    },
    qa: [{ question: "What was said?", answer: "hello", evidence: ["D1:1"], category: 4 }]
  }]));
  const response = await server.inject({
    method: "POST",
    url: "/context/evaluations/locomo",
    payload: {
      datasetPath,
      command: "prepare",
      llm: {
        extraction: { baseUrl: "https://extract.example/v1", model: "fact-model", apiKey: "extract-secret" },
        answer: { baseUrl: "https://answer.example/v1", model: "answer-model", apiKey: "answer-secret" }
      },
      disableIngestLlm: true
    }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.json().result.jobId, /^locomo_/);
  await server.close();
  await rm(directory, { recursive: true, force: true });
});
