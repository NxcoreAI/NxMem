import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SerialJsonlWriter, readJsonlRecords } from "./longmemeval-artifacts.js";
import type { LocomoQuestionResult } from "./locomo-evaluation.js";

export const LOCOMO_RESULT_SCHEMA_VERSION = 1 as const;
export const LOCOMO_TRACE_SCHEMA_VERSION = 1 as const;

export interface LocomoRunIdentity {
  runId: string;
  datasetSha256: string;
  configFingerprint: string;
  storeFingerprint: string;
  modelFingerprint: string;
}

export interface LocomoSkippedQuestionResult {
  status: "skipped";
  conversationId: string;
  questionId: string;
  questionIndex: number;
  category: 1 | 2 | 3 | 4 | 5;
  referenceAnswer: string;
  reason: string;
  stage: "conversation_prepare" | "question";
  elapsedMs: number;
}

export type LocomoQuestionTerminal = LocomoQuestionResult | LocomoSkippedQuestionResult;

// summary/jobs 快照用的精简投影：去掉 candidates、selectedItems、serializedPrompt、answerPrompt、
// evidenceSelection 等大字段（完整明细已在 results.jsonl 逐行保存，避免整批序列化超过 V8 字符串上限）
export type LocomoQuestionTerminalSummary = LocomoSkippedQuestionResult | {
  status: "succeeded";
  conversationId: string;
  questionId: string;
  questionIndex: number;
  category: LocomoQuestionResult["category"];
  referenceAnswer: string;
  hypothesis: string;
  official: LocomoQuestionResult["official"];
  judge: LocomoQuestionResult["judge"];
  evidence: LocomoQuestionResult["evidence"];
  fallbackUsed: LocomoQuestionResult["fallbackUsed"];
  elapsedMs: number;
};

export function projectLocomoQuestionTerminal(result: LocomoQuestionTerminal): LocomoQuestionTerminalSummary {
  if (result.status === "skipped") return result;
  const {
    candidates: _candidates,
    selectedItems: _selectedItems,
    dropped: _dropped,
    serializedPrompt: _serializedPrompt,
    answerPrompt: _answerPrompt,
    evidenceSelection: _evidenceSelection,
    ...summary
  } = result;
  return summary;
}

export interface LocomoResultRow {
  schemaVersion: typeof LOCOMO_RESULT_SCHEMA_VERSION;
  identity: LocomoRunIdentity;
  questionKey: string;
  commitId: string;
  payloadHash: string;
  completedAt: string;
  result: LocomoQuestionTerminal;
}

export interface LocomoRecoveryState {
  terminals: Map<string, LocomoResultRow>;
  ignoredIncompleteTail: boolean;
  duplicates: number;
}

export class LocomoResultWriter {
  readonly path: string;
  #writer: SerialJsonlWriter;
  #commits: Map<string, LocomoResultRow>;
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, writer: SerialJsonlWriter, commits: Map<string, LocomoResultRow>) {
    this.path = path;
    this.#writer = writer;
    this.#commits = commits;
  }

  static async open(input: { path: string; truncate?: boolean }) {
    const recovery = input.truncate
      ? { terminals: new Map<string, LocomoResultRow>(), ignoredIncompleteTail: false, duplicates: 0 }
      : await scanLocomoResults(input.path);
    const writer = await SerialJsonlWriter.open({ path: input.path, truncate: input.truncate === true });
    return new LocomoResultWriter(input.path, writer, recovery.terminals);
  }

  commit(identity: LocomoRunIdentity, result: LocomoQuestionTerminal) {
    return this.#enqueue(async () => {
      const questionKey = locomoQuestionKey(result.conversationId, result.questionId);
      const commitId = createCommitId(identity, questionKey);
      const completedAt = new Date().toISOString();
      const unsigned = { schemaVersion: LOCOMO_RESULT_SCHEMA_VERSION, identity, questionKey, commitId, result };
      const payloadHash = resultPayloadHash(identity, questionKey, commitId, result);
      const existing = this.#commits.get(questionKey);
      if (existing) {
        if (existing.commitId !== commitId) {
          throw new Error(`LoCoMo result conflict for ${questionKey}`);
        }
        if (existing.payloadHash === payloadHash) return { duplicate: true, row: existing };
        if (existing.result.status === "succeeded") throw new Error(`LoCoMo result conflict for ${questionKey}`);
      }
      const row: LocomoResultRow = { ...unsigned, payloadHash, completedAt };
      await this.#writer.append(row);
      this.#commits.set(questionKey, row);
      return { duplicate: false, row };
    });
  }

  close() { return this.#enqueue(() => this.#writer.close()); }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class LocomoTraceWriter {
  #writer: SerialJsonlWriter;
  #sequence = 0;

  private constructor(writer: SerialJsonlWriter) { this.#writer = writer; }

  static async open(path: string, truncate = true) {
    return new LocomoTraceWriter(await SerialJsonlWriter.open({ path, truncate }));
  }

  append(input: {
    identity: LocomoRunIdentity;
    stage: "run" | "prepare" | "question" | "result_commit";
    status: "started" | "succeeded" | "failed" | "skipped";
    conversationId?: string;
    questionId?: string;
    attempt?: number;
    elapsedMs?: number;
    detail?: unknown;
  }) {
    this.#sequence += 1;
    return this.#writer.append({
      schemaVersion: LOCOMO_TRACE_SCHEMA_VERSION,
      sequence: this.#sequence,
      timestamp: new Date().toISOString(),
      ...input
    });
  }

  close() { return this.#writer.close(); }
}

export async function scanLocomoResults(path: string, expected?: Omit<LocomoRunIdentity, "runId">): Promise<LocomoRecoveryState> {
  const scanned = await readJsonlRecords(path, { missingAsEmpty: true });
  const terminals = new Map<string, LocomoResultRow>();
  let duplicates = 0;
  for (const record of scanned.records) {
    const row = validateRow(record.value as unknown as LocomoResultRow, record.lineNumber);
    if (expected) validateIdentity(row.identity, expected, record.lineNumber);
    const existing = terminals.get(row.questionKey);
    if (existing) {
      if (existing.commitId !== row.commitId) {
        throw new Error(`conflicting LoCoMo result rows for ${row.questionKey}`);
      }
      if (existing.payloadHash === row.payloadHash) duplicates += 1;
      else if (existing.result.status === "succeeded") throw new Error(`conflicting LoCoMo result rows for ${row.questionKey}`);
      else terminals.set(row.questionKey, row);
      continue;
    }
    terminals.set(row.questionKey, row);
  }
  return { terminals, ignoredIncompleteTail: scanned.ignoredIncompleteTail, duplicates };
}

export function createLocomoRunId(now = new Date()) {
  return `locomo_${now.toISOString().replace(/[-:.TZ]/gu, "")}_${randomUUID().slice(0, 8)}`;
}

export function locomoQuestionKey(conversationId: string, questionId: string) {
  return `${conversationId}\u0000${questionId}`;
}

export async function atomicWriteLocomoSummary(path: string, summary: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function createCommitId(identity: LocomoRunIdentity, questionKey: string) {
  return `locomo_commit_${hash({
    datasetSha256: identity.datasetSha256,
    configFingerprint: identity.configFingerprint,
    storeFingerprint: identity.storeFingerprint,
    modelFingerprint: identity.modelFingerprint,
    questionKey
  }).slice(0, 24)}`;
}

function validateRow(value: LocomoResultRow, lineNumber: number) {
  if (!value || value.schemaVersion !== LOCOMO_RESULT_SCHEMA_VERSION || !value.identity || !value.result) {
    throw new Error(`invalid LoCoMo result row at line ${lineNumber}`);
  }
  const expectedKey = locomoQuestionKey(value.result.conversationId, value.result.questionId);
  if (value.questionKey !== expectedKey || value.commitId !== createCommitId(value.identity, value.questionKey)) {
    throw new Error(`invalid LoCoMo result identity at line ${lineNumber}`);
  }
  if (value.payloadHash !== resultPayloadHash(value.identity, value.questionKey, value.commitId, value.result)) {
    throw new Error(`invalid LoCoMo result payload hash at line ${lineNumber}`);
  }
  return value;
}

function validateIdentity(actual: LocomoRunIdentity, expected: Omit<LocomoRunIdentity, "runId">, lineNumber: number) {
  for (const key of ["datasetSha256", "configFingerprint", "storeFingerprint", "modelFingerprint"] as const) {
    if (actual[key] !== expected[key]) throw new Error(`LoCoMo result ${key} mismatch at line ${lineNumber}`);
  }
}

function hash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function resultPayloadHash(identity: LocomoRunIdentity, questionKey: string, commitId: string, result: LocomoQuestionTerminal) {
  return hash({
    schemaVersion: LOCOMO_RESULT_SCHEMA_VERSION,
    identity: {
      datasetSha256: identity.datasetSha256,
      configFingerprint: identity.configFingerprint,
      storeFingerprint: identity.storeFingerprint,
      modelFingerprint: identity.modelFingerprint
    },
    questionKey,
    commitId,
    result
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
