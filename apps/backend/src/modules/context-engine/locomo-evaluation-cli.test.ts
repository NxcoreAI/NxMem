import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { reloadContextEngineConfig } from "../../config.js";
import { parseLocomoEvaluationArgs, runLocomoEvaluationCli, type LocomoEvaluationCliOptions } from "./locomo-evaluation-cli.js";
import { readJsonlRecords } from "./longmemeval-artifacts.js";

const execFileAsync = promisify(execFile);

test("LoCoMo CLI full equals prepare plus read-only evaluate and separates stdout from progress", async () => {
  const directory = await setup();
  try {
    const dataset = join(directory, "fixture.json");
    const fullStore = join(directory, "full.sqlite");
    const splitStore = join(directory, "split.sqlite");
    const fullIo = captureIo();
    const full = await runLocomoEvaluationCli(options(dataset, fullStore, directory, "full"), fullIo.io);
    await runLocomoEvaluationCli(options(dataset, splitStore, directory, "prepare"), captureIo().io);
    const splitIo = captureIo();
    const evaluateOptions = options(dataset, splitStore, directory, "evaluate");
    evaluateOptions.json = false;
    const evaluate = await runLocomoEvaluationCli(evaluateOptions, splitIo.io);
    assert.deepEqual(full.questions.map(questionProjection), evaluate.questions.map(questionProjection));
    assert.deepEqual(full.summary, evaluate.summary);
    assert.equal(fullIo.stdout.length, 1);
    assert.equal(fullIo.stderr.some((line) => line.includes("locomo-progress")), true);
    assert.equal(splitIo.stdout.length, 1);
    const parsed = JSON.parse(fullIo.stdout[0]!);
    assert.equal(parsed.version, 2);
    assert.match(splitIo.stdout[0]!, /LoCoMo evaluation finished/);
    assert.match(splitIo.stdout[0]!, /LLM judge J-score/);
    assert.doesNotMatch(splitIo.stdout[0]!, /manifest|compatible-mode/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("LoCoMo CLI resumes valid terminals and rejects fingerprint mismatch", async () => {
  const directory = await setup();
  try {
    const dataset = join(directory, "fixture.json");
    const store = join(directory, "resume.sqlite");
    const first = options(dataset, store, directory, "full");
    first.questionLimit = 1;
    await runLocomoEvaluationCli(first, captureIo().io);
    const resumed = options(dataset, store, directory, "full");
    resumed.resume = true;
    const output = await runLocomoEvaluationCli(resumed, captureIo().io);
    assert.equal(output.resumedQuestions, 1);
    assert.equal(output.committedQuestions, 1);
    const resultPath = resumed.result!;
    const records = await readJsonlRecords(resultPath, { missingAsEmpty: false });
    assert.equal(records.records.length, 2);
    const changedDataset = join(directory, "changed.json");
    const raw = JSON.parse(await readFile(dataset, "utf8"));
    raw[0].conversation.session_1[0].text = "changed source";
    await writeFile(changedDataset, JSON.stringify(raw), "utf8");
    await assert.rejects(
      () => runLocomoEvaluationCli(options(changedDataset, store, directory, "evaluate"), captureIo().io),
      /manifest does not match/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("LoCoMo CLI writes the Store manifest before later startup work can fail", async () => {
  const directory = await setup();
  try {
    const dataset = join(directory, "fixture.json");
    const store = join(directory, "interrupted.sqlite");
    const input = options(dataset, store, directory, "full");
    input.result = directory;
    await assert.rejects(() => runLocomoEvaluationCli(input, captureIo().io));
    const manifest = JSON.parse(await readFile(`${store}.manifest.json`, "utf8"));
    assert.equal(manifest.profile, "locomo-fact-stm-v1");
    assert.deepEqual(manifest.conversationIds, ["cli-one"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("LoCoMo CLI validates resume flags and process exit codes", async () => {
  assert.throws(() => parseLocomoEvaluationArgs(["node", "cli", "--retry-skipped"]), /requires --resume/);
  assert.equal(parseLocomoEvaluationArgs(["node", "cli", "clean"]).command, "clean");
  assert.equal(parseLocomoEvaluationArgs(["node", "cli", "clean", "--yes"]).yes, true);
  assert.throws(() => parseLocomoEvaluationArgs(["node", "cli", "clean", "--all", "--store-path", "x"]), /cannot be combined/);
  assert.throws(() => parseLocomoEvaluationArgs(["node", "cli", "clean", "--all", "--results-only"]), /cannot be combined/);
  assert.throws(() => parseLocomoEvaluationArgs(["node", "cli", "clean", "--resume"]), /does not accept resume options/);
  const cli = resolve("src/modules/context-engine/locomo-evaluation-cli.ts");
  await assert.rejects(
    () => execFileAsync(process.execPath, ["--import", "tsx", cli, "--unknown"], { cwd: resolve("."), env: process.env }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 2)
  );
  const help = await execFileAsync(process.execPath, ["--import", "tsx", cli, "--help"], { cwd: resolve("."), env: process.env });
  assert.equal(help.stderr.includes("eval:locomo"), true);
});

test("LoCoMo CLI clean deletes stores and artifacts behind --yes", async () => {
  const directory = await setup();
  try {
    const dataset = join(directory, "fixture.json");
    const store = join(directory, "clean-me.sqlite");
    await runLocomoEvaluationCli(options(dataset, store, directory, "full"), captureIo().io);
    const storeArtifacts = ["", ".manifest.json", ".results.jsonl", ".trace.jsonl", ".summary.json"].map((suffix) => `${store}${suffix}`);
    for (const path of storeArtifacts) assert.equal(await fileExists(path), true, `${path} should exist after full run`);

    // 无 --yes 拒删
    await assert.rejects(() => runLocomoEvaluationCli(options(dataset, store, directory, "clean"), captureIo().io), /without --yes/);

    // --results-only 保留 store 主文件，只清产物
    const resultsOnly = options(dataset, store, directory, "clean");
    resultsOnly.cleanResultsOnly = true;
    resultsOnly.yes = true;
    await runLocomoEvaluationCli(resultsOnly, captureIo().io);    assert.equal(await fileExists(store), true, "store should survive --results-only");
    for (const suffix of [".manifest.json", ".results.jsonl", ".trace.jsonl", ".summary.json"]) {
      assert.equal(await fileExists(`${store}${suffix}`), false, `${suffix} should be deleted`);
    }

    // 全量 clean 删除 store 主文件
    const fullClean = options(dataset, store, directory, "clean");
    fullClean.yes = true;
    await runLocomoEvaluationCli(fullClean, captureIo().io);
    for (const path of storeArtifacts) assert.equal(await fileExists(path), false, `${path} should be deleted`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fileExists(path: string) {
  try { await stat(path); return true; } catch { return false; }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "locomo-cli-"));
  const dataset = join(directory, "fixture.json");
  await writeFile(dataset, JSON.stringify([
    {
      sample_id: "cli-one",
      conversation: { session_1: [{ dia_id: "D1:1", speaker: "Alice", text: "I adopted a dog." }], session_1_date_time: "1:00 pm on 1 May, 2023" },
      qa: [
        { question: "What did Alice adopt?", answer: "dog", evidence: ["D1:1"], category: 4 },
        { question: "Who adopted a dog?", answer: "Alice", evidence: ["D1:1"], category: 4 }
      ]
    }
  ]), "utf8");
  process.env.EMBEDDING_PROTOCOL = "deterministic-test";
  process.env.EMBEDDING_MODEL = "deterministic-test";
  process.env.EMBEDDING_DIMENSIONS = "32";
  process.env.RERANKER_ENABLED = "false";
  process.env.LONGMEMEVAL_GRAPH_STORE = "local";
  reloadContextEngineConfig(undefined, process.env);
  return directory;
}

function options<C extends "full" | "prepare" | "evaluate" | "clean">(dataset: string, storePath: string, directory: string, command: C): LocomoEvaluationCliOptions & { command: C } {
  return {
    command, dataset, storePath, sampleIds: [], questionConcurrency: 2, questionAttempts: 2,
    resume: false, retrySkipped: false, cleanAll: false, cleanResultsOnly: false, yes: false, ci: true, json: true,
    result: join(directory, `${storePath.split("/").at(-1)}.results.jsonl`),
    trace: join(directory, `${storePath.split("/").at(-1)}.trace.jsonl`),
    summary: join(directory, `${storePath.split("/").at(-1)}.summary.json`)
  };
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) } };
}

function questionProjection(value: { status: string; questionId: string; category: number; hypothesis?: string; official?: { score: number }; evidence?: unknown }) {
  return { status: value.status, questionId: value.questionId, category: value.category, hypothesis: value.hypothesis, score: value.official?.score, evidence: value.evidence };
}
