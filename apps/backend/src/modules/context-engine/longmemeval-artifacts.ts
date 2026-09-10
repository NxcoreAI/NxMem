import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LONGMEMEVAL_TRACE_SCHEMA_VERSION = 2 as const;
export const LONGMEMEVAL_DEFAULT_RESULT_BASENAME = "longmemeval-result.jsonl";
export const LONGMEMEVAL_REDACTED_VALUE = "[REDACTED]";

export type LongMemEvalTraceStage =
  | "run"
  | "sample_summary"
  | "sample_normalization"
  | "ingestion"
  | "timeline_aggregation"
  | "ltm"
  | "retrieval"
  | "context_pack"
  | "answer"
  | "judge"
  | "result_commit";

export type LongMemEvalTraceOperation =
  | "sample_facts"
  | "sample_stms"
  | "retrieval_candidates"
  | "context_pack_facts"
  | "run_lifecycle"
  | "normalize_sample"
  | "build_event"
  | "save_event"
  | "parse_event"
  | "fact_fusion"
  | "stm_admission"
  | "finalize_ingestion"
  | "aggregate_timeline"
  | "dream_ltm"
  | "search"
  | "assemble_context_pack"
  | "generate_hypothesis"
  | "judge_hypothesis"
  | "append_result"
  | "llm_request";

export type LongMemEvalTraceStatus = "started" | "retrying" | "succeeded" | "failed" | "skipped";

export interface LongMemEvalStructuredError {
  name: string;
  message: string;
  code?: string | number;
  stack?: string;
  cause?: unknown;
}

export interface LongMemEvalDatasetIdentity {
  path: string;
  sha256: string;
  sampleCount: number;
}

export interface LongMemEvalSampleIdentity {
  index: number;
  questionId: string;
}

export interface LongMemEvalTraceSample extends LongMemEvalSampleIdentity {
  count: number;
  questionType: string;
  contextScopeId: string;
}

export interface LongMemEvalTraceEvent {
  schemaVersion: typeof LONGMEMEVAL_TRACE_SCHEMA_VERSION;
  sequence: number;
  runId: string;
  modelRunId: string;
  sample?: LongMemEvalTraceSample;
  stage: LongMemEvalTraceStage;
  operation: LongMemEvalTraceOperation;
  stageExecutionId: string;
  status: LongMemEvalTraceStatus;
  attempt?: number;
  stageAttempt?: number;
  internalAttempt?: number;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  input?: unknown;
  output?: unknown;
  error?: LongMemEvalStructuredError;
  links?: Record<string, unknown>;
}

export type LongMemEvalTraceEventInput = Omit<LongMemEvalTraceEvent, "schemaVersion" | "sequence">;

export interface LongMemEvalResultRowExtension {
  runId: string;
  modelRunId: string;
  datasetIdentity: LongMemEvalDatasetIdentity;
  sampleIdentity: LongMemEvalSampleIdentity;
  resultCommitId: string;
  payloadHash: string;
  completedAt: string;
}

export type LongMemEvalResultRow = Record<string, unknown> & LongMemEvalResultRowExtension;

export interface LongMemEvalArtifactPaths {
  dataDirectory: string;
  resultPath: string;
  tracePath: string;
  lockPath: string;
  runId: string;
}

export interface LongMemEvalArtifactRun {
  paths: LongMemEvalArtifactPaths;
  resultWriter: LongMemEvalResultWriter;
  traceWriter: LongMemEvalTraceWriter;
  close(): Promise<void>;
}

export interface JsonlRecord<T = Record<string, unknown>> {
  lineNumber: number;
  value: T;
  byteStart: number;
  byteEnd: number;
}

export interface JsonlReadResult<T = Record<string, unknown>> {
  records: JsonlRecord<T>[];
  ignoredIncompleteTail: boolean;
  appendOffset: number;
  needsLeadingNewline: boolean;
}

export interface JsonlAppendReceipt {
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
}

export interface SerialJsonlWriterFaultInjection {
  afterWrite?: (input: { path: string; line: string; receipt: JsonlAppendReceipt }) => void | Promise<void>;
}

export interface LongMemEvalResultCommitReceipt extends JsonlAppendReceipt {
  resultCommitId: string;
  payloadHash: string;
  duplicate: boolean;
  recoveredAfterWriteError?: boolean;
}

export interface LongMemEvalRecoveryScanResult {
  completedKeys: Set<string>;
  completedSamples: LongMemEvalSampleIdentity[];
  pendingSamples: LongMemEvalSampleIdentity[];
  firstPendingSample?: LongMemEvalSampleIdentity;
  ignoredIncompleteTail: boolean;
  duplicateCommits: number;
  latestRunId?: string;
}

export class LongMemEvalArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LongMemEvalArtifactError";
    this.code = code;
  }
}

export class LongMemEvalResultCommitConflictError extends LongMemEvalArtifactError {
  constructor(resultCommitId: string) {
    super("RESULT_COMMIT_CONFLICT", `LongMemEval result commit ${resultCommitId} already exists with a different payload`);
    this.name = "LongMemEvalResultCommitConflictError";
  }
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const LONGMEMEVAL_DATA_DIRECTORY = resolve(moduleDirectory, "../../../data");

export function createLongMemEvalRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/gu, "");
  return `longmemeval_${timestamp}_${randomUUID().slice(0, 8)}`;
}

export function defaultLongMemEvalTraceBasename(runId: string) {
  return `longmemeval-${validateRunId(runId)}-trace.jsonl`;
}

export class LongMemEvalArtifactStore {
  readonly dataDirectory: string;

  constructor(dataDirectory = LONGMEMEVAL_DATA_DIRECTORY) {
    this.dataDirectory = resolve(dataDirectory);
  }

  resolvePaths(input: { resultBasename?: string; traceBasename?: string; runId?: string } = {}): LongMemEvalArtifactPaths {
    const runId = input.runId ? validateRunId(input.runId) : createLongMemEvalRunId();
    const resultPath = this.resolveBasename(input.resultBasename ?? LONGMEMEVAL_DEFAULT_RESULT_BASENAME);
    const tracePath = this.resolveBasename(input.traceBasename ?? defaultLongMemEvalTraceBasename(runId));
    if (resultPath === tracePath) {
      throw new LongMemEvalArtifactError("ARTIFACT_PATH_COLLISION", "LongMemEval result and trace paths must be different");
    }
    return {
      dataDirectory: this.dataDirectory,
      resultPath,
      tracePath,
      lockPath: `${resultPath}.lock`,
      runId
    };
  }

  resolveBasename(value: string) {
    const basename = value.trim();
    if (!basename || basename !== value || isAbsolute(basename) || relative(".", basename) !== basename) {
      throw new LongMemEvalArtifactError("INVALID_ARTIFACT_BASENAME", "LongMemEval artifact path must be a basename");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u.test(basename) || extname(basename) !== ".jsonl") {
      throw new LongMemEvalArtifactError("INVALID_ARTIFACT_BASENAME", "LongMemEval artifact basename must end in .jsonl and contain only safe characters");
    }
    const path = resolve(this.dataDirectory, basename);
    if (dirname(path) !== this.dataDirectory) {
      throw new LongMemEvalArtifactError("ARTIFACT_PATH_ESCAPE", "LongMemEval artifact path must remain inside the data directory");
    }
    return path;
  }

  async acquireResultLock(resultPath: string, runId: string): Promise<LongMemEvalFileLock> {
    this.assertManagedPath(resultPath);
    return acquireLongMemEvalResultLock(resultPath, runId);
  }

  assertManagedPath(path: string) {
    const normalized = resolve(path);
    if (dirname(normalized) !== this.dataDirectory || extname(normalized) !== ".jsonl") {
      throw new LongMemEvalArtifactError("ARTIFACT_PATH_ESCAPE", `LongMemEval artifact is outside the data directory: ${path}`);
    }
  }
}

export async function acquireLongMemEvalResultLock(resultPath: string, runId: string): Promise<LongMemEvalFileLock> {
  const normalizedResultPath = resolve(resultPath);
  await mkdir(dirname(normalizedResultPath), { recursive: true });
  const lockPath = `${normalizedResultPath}.lock`;
  let handle: FileHandle;
  try {
    handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (readErrorCode(error) === "EEXIST") {
      if (await removeStaleLock(lockPath)) return acquireLongMemEvalResultLock(normalizedResultPath, runId);
      throw new LongMemEvalArtifactError("RESULT_FILE_LOCKED", `LongMemEval result file is already locked: ${normalizedResultPath}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ runId, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    return new LongMemEvalFileLock(lockPath, handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
}

export const longMemEvalArtifactStore = new LongMemEvalArtifactStore();

export async function openLongMemEvalArtifactRun(input: {
  resultBasename?: string;
  traceBasename?: string;
  runId?: string;
  resume?: boolean;
  store?: LongMemEvalArtifactStore;
} = {}): Promise<LongMemEvalArtifactRun> {
  const store = input.store ?? longMemEvalArtifactStore;
  const paths = store.resolvePaths(input);
  const lock = await store.acquireResultLock(paths.resultPath, paths.runId);
  let resultWriter: LongMemEvalResultWriter | undefined;
  let traceWriter: LongMemEvalTraceWriter | undefined;
  try {
    traceWriter = await LongMemEvalTraceWriter.open(paths.tracePath);
    resultWriter = await LongMemEvalResultWriter.open({ path: paths.resultPath, truncate: input.resume !== true });
  } catch (error) {
    await resultWriter?.close().catch(() => undefined);
    await traceWriter?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
  const openedResultWriter = resultWriter;
  const openedTraceWriter = traceWriter;
  let closed = false;
  return {
    paths,
    resultWriter: openedResultWriter,
    traceWriter: openedTraceWriter,
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([
        openedResultWriter.close(),
        openedTraceWriter.close()
      ]);
      await lock.release();
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    }
  };
}

export class LongMemEvalFileLock {
  readonly path: string;
  #handle: FileHandle | undefined;

  constructor(path: string, handle: FileHandle) {
    this.path = path;
    this.#handle = handle;
  }

  async release() {
    const handle = this.#handle;
    if (!handle) return;
    this.#handle = undefined;
    await handle.close();
    await unlink(this.path).catch((error) => {
      if (readErrorCode(error) !== "ENOENT") throw error;
    });
  }
}

export class SerialJsonlWriter {
  readonly path: string;
  #handle: FileHandle;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #lineNumber: number;
  #byteOffset: number;
  #needsLeadingNewline: boolean;
  #afterAppend?: (receipt: JsonlAppendReceipt) => void | Promise<void>;
  #faultInjection?: SerialJsonlWriterFaultInjection;

  private constructor(input: {
    path: string;
    handle: FileHandle;
    lineNumber: number;
    byteOffset: number;
    needsLeadingNewline: boolean;
    afterAppend?: (receipt: JsonlAppendReceipt) => void | Promise<void>;
    faultInjection?: SerialJsonlWriterFaultInjection;
  }) {
    this.path = input.path;
    this.#handle = input.handle;
    this.#lineNumber = input.lineNumber;
    this.#byteOffset = input.byteOffset;
    this.#needsLeadingNewline = input.needsLeadingNewline;
    if (input.afterAppend) this.#afterAppend = input.afterAppend;
    if (input.faultInjection) this.#faultInjection = input.faultInjection;
  }

  static async open(input: {
    path: string;
    truncate?: boolean;
    exclusive?: boolean;
    afterAppend?: (receipt: JsonlAppendReceipt) => void | Promise<void>;
    faultInjection?: SerialJsonlWriterFaultInjection;
  }) {
    await mkdir(dirname(input.path), { recursive: true });
    let lineNumber = 0;
    let byteOffset = 0;
    let needsLeadingNewline = false;
    if (!input.truncate && !input.exclusive) {
      const scanned = await readJsonlRecords(input.path, { missingAsEmpty: true });
      lineNumber = scanned.records.length;
      byteOffset = scanned.appendOffset;
      needsLeadingNewline = scanned.needsLeadingNewline;
      if (scanned.ignoredIncompleteTail) {
        const repairHandle = await openNoFollow(input.path, constants.O_RDWR);
        try {
          await repairHandle.truncate(scanned.appendOffset);
          await repairHandle.sync();
        } finally {
          await repairHandle.close();
        }
      }
    }
    const flags = constants.O_WRONLY
      | constants.O_CREAT
      | (input.exclusive ? constants.O_EXCL : 0)
      | (input.truncate ? constants.O_TRUNC : constants.O_APPEND);
    const handle = await openNoFollow(input.path, flags, 0o600);
    await handle.chmod(0o600);
    if (input.truncate || input.exclusive) {
      lineNumber = 0;
      byteOffset = 0;
      needsLeadingNewline = false;
    }
    return new SerialJsonlWriter({
      path: input.path,
      handle,
      lineNumber,
      byteOffset,
      needsLeadingNewline,
      ...(input.afterAppend ? { afterAppend: input.afterAppend } : {}),
      ...(input.faultInjection ? { faultInjection: input.faultInjection } : {})
    });
  }

  append(value: unknown): Promise<JsonlAppendReceipt> {
    return this.#enqueue(async () => {
      if (this.#closed) throw new LongMemEvalArtifactError("WRITER_CLOSED", `JSONL writer is closed: ${this.path}`);
      const serialized = safeJsonStringify(value);
      const prefix = this.#needsLeadingNewline ? "\n" : "";
      const line = `${prefix}${serialized}\n`;
      const byteLength = Buffer.byteLength(line);
      const receipt = {
        lineNumber: this.#lineNumber + 1,
        byteStart: this.#byteOffset + Buffer.byteLength(prefix),
        byteEnd: this.#byteOffset + byteLength
      };
      await this.#handle.writeFile(line, "utf8");
      await this.#faultInjection?.afterWrite?.({ path: this.path, line, receipt });
      await this.#handle.sync();
      this.#lineNumber += 1;
      this.#byteOffset += byteLength;
      this.#needsLeadingNewline = false;
      await this.#afterAppend?.(receipt);
      return receipt;
    });
  }

  flush(): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#closed) await this.#handle.sync();
    });
  }

  repairIncompleteTail(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed) throw new LongMemEvalArtifactError("WRITER_CLOSED", `JSONL writer is closed: ${this.path}`);
      const scanned = await readJsonlRecords(this.path, { missingAsEmpty: false });
      if (scanned.ignoredIncompleteTail) {
        await this.#handle.truncate(scanned.appendOffset);
        await this.#handle.sync();
        await this.#handle.close();
        this.#handle = await openNoFollow(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
      }
      this.#lineNumber = scanned.records.length;
      this.#byteOffset = scanned.appendOffset;
      this.#needsLeadingNewline = scanned.needsLeadingNewline;
    });
  }

  refreshState(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed) throw new LongMemEvalArtifactError("WRITER_CLOSED", `JSONL writer is closed: ${this.path}`);
      const scanned = await readJsonlRecords(this.path, { missingAsEmpty: false });
      this.#lineNumber = scanned.records.length;
      this.#byteOffset = scanned.appendOffset;
      this.#needsLeadingNewline = scanned.needsLeadingNewline;
    });
  }

  close(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      this.#closed = true;
      await this.#handle.sync();
      await this.#handle.close();
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class LongMemEvalTraceWriter {
  readonly path: string;
  #writer: SerialJsonlWriter;
  #sequence = 0;
  #onceKeys = new Set<string>();

  private constructor(writer: SerialJsonlWriter) {
    this.path = writer.path;
    this.#writer = writer;
  }

  static async open(path: string) {
    return new LongMemEvalTraceWriter(await SerialJsonlWriter.open({ path, exclusive: true }));
  }

  append(event: LongMemEvalTraceEventInput) {
    this.#sequence += 1;
    const value: LongMemEvalTraceEvent = {
      ...event,
      schemaVersion: LONGMEMEVAL_TRACE_SCHEMA_VERSION,
      sequence: this.#sequence
    };
    return this.#writer.append(value);
  }

  appendOnce(key: string, event: LongMemEvalTraceEventInput) {
    if (this.#onceKeys.has(key)) return Promise.resolve(undefined);
    this.#onceKeys.add(key);
    return this.append(event).catch((error) => {
      this.#onceKeys.delete(key);
      throw error;
    });
  }

  close() {
    return this.#writer.close();
  }
}

export class LongMemEvalResultWriter {
  readonly path: string;
  #writer: SerialJsonlWriter;
  #commits = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();

  private constructor(writer: SerialJsonlWriter, commits: Map<string, string>) {
    this.path = writer.path;
    this.#writer = writer;
    this.#commits = commits;
  }

  static async open(input: {
    path: string;
    truncate?: boolean;
    afterAppend?: (receipt: JsonlAppendReceipt) => void | Promise<void>;
    faultInjection?: SerialJsonlWriterFaultInjection;
  }) {
    const records = input.truncate
      ? { records: [] as JsonlRecord[], ignoredIncompleteTail: false, appendOffset: 0, needsLeadingNewline: false }
      : await readJsonlRecords(input.path, { missingAsEmpty: true });
    const commits = buildResultCommitIndex(records.records);
    const writer = await SerialJsonlWriter.open(input);
    return new LongMemEvalResultWriter(writer, commits);
  }

  async commit(input: {
    result: Record<string, unknown>;
    runId: string;
    modelRunId: string;
    datasetIdentity: LongMemEvalDatasetIdentity;
    sampleIdentity: LongMemEvalSampleIdentity;
    completedAt?: string;
  }): Promise<LongMemEvalResultCommitReceipt> {
    return this.#enqueue(async () => {
      validateDatasetIdentity(input.datasetIdentity);
      validateSampleIdentity(input.sampleIdentity);
      const resultCommitId = createLongMemEvalResultCommitId(input);
      const baseRow = {
        ...input.result,
        runId: input.runId,
        modelRunId: input.modelRunId,
        datasetIdentity: input.datasetIdentity,
        sampleIdentity: input.sampleIdentity,
        resultCommitId,
        completedAt: input.completedAt ?? new Date().toISOString()
      };
      const payloadHash = hashLongMemEvalResultPayload(baseRow);
      const row: LongMemEvalResultRow = { ...baseRow, payloadHash };
      const existingHash = this.#commits.get(resultCommitId);
      if (existingHash !== undefined) return duplicateReceipt(resultCommitId, payloadHash, existingHash);

      try {
        const receipt = await this.#writer.append(row);
        this.#commits.set(resultCommitId, payloadHash);
        return { ...receipt, resultCommitId, payloadHash, duplicate: false };
      } catch (error) {
        await this.#refreshCommitIndex();
        const recoveredHash = this.#commits.get(resultCommitId);
        if (recoveredHash !== undefined) {
          await this.#writer.refreshState();
          const receipt = duplicateReceipt(resultCommitId, payloadHash, recoveredHash);
          return { ...receipt, recoveredAfterWriteError: true };
        }
        await this.#writer.repairIncompleteTail();
        throw error;
      }
    });
  }

  close() {
    return this.#enqueue(() => this.#writer.close());
  }

  async #refreshCommitIndex() {
    const scanned = await readJsonlRecords(this.path, { missingAsEmpty: false });
    this.#commits = buildResultCommitIndex(scanned.records);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function createLongMemEvalDatasetIdentity(datasetPath: string): Promise<LongMemEvalDatasetIdentity> {
  const path = await realpath(resolve(datasetPath));
  const content = await readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new LongMemEvalArtifactError("INVALID_DATASET", `LongMemEval dataset is not valid JSON: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new LongMemEvalArtifactError("INVALID_DATASET", "LongMemEval dataset must be a JSON array");
  }
  return {
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    sampleCount: parsed.length
  };
}

export function createLongMemEvalResultCommitId(input: {
  runId: string;
  modelRunId: string;
  datasetIdentity: LongMemEvalDatasetIdentity;
  sampleIdentity: LongMemEvalSampleIdentity;
}) {
  validateDatasetIdentity(input.datasetIdentity);
  validateSampleIdentity(input.sampleIdentity);
  const canonical = stableJsonStringify({
    runId: input.runId,
    modelRunId: input.modelRunId,
    datasetIdentity: input.datasetIdentity,
    sampleIdentity: input.sampleIdentity
  });
  return `result_${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function hashLongMemEvalResultPayload(row: Record<string, unknown>) {
  const payload = { ...row };
  delete payload.payloadHash;
  delete payload.completedAt;
  return createHash("sha256").update(stableJsonStringify(payload), "utf8").digest("hex");
}

export async function scanLongMemEvalResultRecovery(input: {
  resultPath: string;
  datasetIdentity: LongMemEvalDatasetIdentity;
  samples: LongMemEvalSampleIdentity[];
  modelRunId: string;
  retrySkipped?: boolean;
  resumeLegacy?: boolean;
}): Promise<LongMemEvalRecoveryScanResult> {
  validateDatasetIdentity(input.datasetIdentity);
  const expectedSamples = new Map<number, LongMemEvalSampleIdentity>();
  for (const sample of input.samples) {
    validateSampleIdentity(sample);
    if (expectedSamples.has(sample.index)) {
      throw new LongMemEvalArtifactError("DUPLICATE_SAMPLE_INDEX", `LongMemEval sample index ${sample.index} is duplicated`);
    }
    expectedSamples.set(sample.index, sample);
  }

  const scanned = await readJsonlRecords(input.resultPath, { missingAsEmpty: true });
  const commits = new Map<string, string>();
  const runSamples = new Map<string, { commitId?: string; payloadHash: string }>();
  const latestBySample = new Map<string, { runId: string; skipped: boolean; lineNumber: number }>();
  let duplicateCommits = 0;
  let latestRunId: string | undefined;

  for (const record of scanned.records) {
    const row = record.value;
    const strong = readStrongResultIdentity(row);
    const identity = strong ?? readLegacyResultIdentity(row, input.datasetIdentity, input.resumeLegacy === true, record.lineNumber);
    assertDatasetMatches(identity.datasetIdentity, input.datasetIdentity, record.lineNumber);
    const expected = expectedSamples.get(identity.sampleIdentity.index);
    if (!expected || expected.questionId !== identity.sampleIdentity.questionId) {
      throw new LongMemEvalArtifactError(
        "RESULT_SAMPLE_MISMATCH",
        `LongMemEval result line ${record.lineNumber} does not match dataset sample ${identity.sampleIdentity.index}`
      );
    }

    const modelRunId = identity.modelRunId;
    const sampleKey = longMemEvalSampleCompletionKey(modelRunId, identity.sampleIdentity);
    const payloadHash = typeof row.payloadHash === "string" && row.payloadHash
      ? row.payloadHash
      : hashLongMemEvalResultPayload(row);
    const computedHash = hashLongMemEvalResultPayload(row);
    if (typeof row.payloadHash === "string" && row.payloadHash !== computedHash) {
      throw new LongMemEvalArtifactError("RESULT_PAYLOAD_HASH_MISMATCH", `LongMemEval result line ${record.lineNumber} has an invalid payload hash`);
    }

    if (identity.resultCommitId) {
      const priorHash = commits.get(identity.resultCommitId);
      if (priorHash !== undefined) {
        if (priorHash !== payloadHash) throw new LongMemEvalResultCommitConflictError(identity.resultCommitId);
        duplicateCommits += 1;
        continue;
      }
      commits.set(identity.resultCommitId, payloadHash);
    }

    const runSampleKey = `${identity.runId}\u0000${sampleKey}`;
    const priorRunSample = runSamples.get(runSampleKey);
    if (priorRunSample) {
      throw new LongMemEvalArtifactError(
        "DUPLICATE_SAMPLE_TERMINAL",
        `LongMemEval run ${identity.runId} contains conflicting terminal rows for sample ${identity.sampleIdentity.index}`
      );
    }
    runSamples.set(runSampleKey, { ...(identity.resultCommitId ? { commitId: identity.resultCommitId } : {}), payloadHash });
    if (modelRunId === input.modelRunId) {
      latestBySample.set(sampleKey, {
        runId: identity.runId,
        skipped: row.skipped === true || row.status === "skipped",
        lineNumber: record.lineNumber
      });
      latestRunId = identity.runId;
    }
  }

  const completedKeys = new Set<string>();
  const completedSamples: LongMemEvalSampleIdentity[] = [];
  const pendingSamples: LongMemEvalSampleIdentity[] = [];
  for (const sample of input.samples) {
    const key = longMemEvalSampleCompletionKey(input.modelRunId, sample);
    const terminal = latestBySample.get(key);
    if (terminal && (!terminal.skipped || input.retrySkipped !== true)) {
      completedKeys.add(key);
      completedSamples.push(sample);
    } else {
      pendingSamples.push(sample);
    }
  }
  return {
    completedKeys,
    completedSamples,
    pendingSamples,
    ...(pendingSamples[0] ? { firstPendingSample: pendingSamples[0] } : {}),
    ignoredIncompleteTail: scanned.ignoredIncompleteTail,
    duplicateCommits,
    ...(latestRunId ? { latestRunId } : {})
  };
}

export function longMemEvalSampleCompletionKey(modelRunId: string, sample: LongMemEvalSampleIdentity) {
  return `${modelRunId}\u0000${sample.index}\u0000${sample.questionId}`;
}

export async function readJsonlRecords<T extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  options: { missingAsEmpty: boolean }
): Promise<JsonlReadResult<T>> {
  let content: Buffer;
  try {
    content = await readFileNoFollow(path);
  } catch (error) {
    if (options.missingAsEmpty && readErrorCode(error) === "ENOENT") {
      return { records: [], ignoredIncompleteTail: false, appendOffset: 0, needsLeadingNewline: false };
    }
    throw error;
  }
  const records: JsonlRecord<T>[] = [];
  let lineStart = 0;
  let lineNumber = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x0a) continue;
    lineNumber += 1;
    parseCompleteJsonlLine(content.subarray(lineStart, index), lineNumber, lineStart, index + 1, records);
    lineStart = index + 1;
  }
  if (lineStart === content.length) {
    return { records, ignoredIncompleteTail: false, appendOffset: content.length, needsLeadingNewline: false };
  }

  const tail = content.subarray(lineStart);
  const trimmed = tail.toString("utf8").trim();
  if (!trimmed) {
    return { records, ignoredIncompleteTail: true, appendOffset: lineStart, needsLeadingNewline: false };
  }
  let tailValue: unknown;
  try {
    tailValue = JSON.parse(trimmed);
  } catch {
    return { records, ignoredIncompleteTail: true, appendOffset: lineStart, needsLeadingNewline: false };
  }
  if (!isRecord(tailValue)) {
    throw new LongMemEvalArtifactError("INVALID_JSONL_LINE", `LongMemEval JSONL line ${lineNumber + 1} must be a JSON object`);
  }
  records.push({ lineNumber: lineNumber + 1, value: tailValue as T, byteStart: lineStart, byteEnd: content.length });
  return { records, ignoredIncompleteTail: false, appendOffset: content.length, needsLeadingNewline: true };
}

export function safeJsonStringify(value: unknown) {
  return JSON.stringify(sanitizeJsonValue(value));
}

export function sanitizeJsonValue(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>());
}

export function toLongMemEvalStructuredError(error: unknown): LongMemEvalStructuredError {
  if (error instanceof Error) return sanitizeJsonValue(error) as LongMemEvalStructuredError;
  return { name: "Error", message: String(error) };
}

function parseCompleteJsonlLine<T extends Record<string, unknown>>(
  bytes: Buffer,
  lineNumber: number,
  byteStart: number,
  byteEnd: number,
  records: JsonlRecord<T>[]
) {
  const trimmed = bytes.toString("utf8").trim();
  if (!trimmed) return;
  const value = parseJsonObject(trimmed, lineNumber);
  records.push({ lineNumber, value: value as T, byteStart, byteEnd });
}

function parseJsonObject(serialized: string, lineNumber: number) {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new LongMemEvalArtifactError("INVALID_JSONL_LINE", `LongMemEval JSONL line ${lineNumber} is invalid: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) {
    throw new LongMemEvalArtifactError("INVALID_JSONL_LINE", `LongMemEval JSONL line ${lineNumber} must be a JSON object`);
  }
  return value;
}

function sanitizeValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return typeof value === "string" ? redactUrls(value) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      const withCode = value as Error & { code?: unknown; cause?: unknown };
      return {
        name: value.name,
        message: value.message,
        ...(typeof withCode.code === "string" || typeof withCode.code === "number" ? { code: withCode.code } : {}),
        ...(value.stack ? { stack: value.stack } : {}),
        ...(withCode.cause !== undefined ? { cause: sanitizeValue(withCode.cause, ancestors) } : {})
      };
    }
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, ancestors));
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? LONGMEMEVAL_REDACTED_VALUE : sanitizeValue(child, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function redactUrls(value: string) {
  return value.replace(/https?:\/\/[^\s"'<>]+/gu, (candidate) => {
    const punctuation = candidate.match(/[),.;!?]+$/u)?.[0] ?? "";
    const urlText = punctuation ? candidate.slice(0, -punctuation.length) : candidate;
    try {
      const url = new URL(urlText);
      if (url.username) url.username = LONGMEMEVAL_REDACTED_VALUE;
      if (url.password) url.password = LONGMEMEVAL_REDACTED_VALUE;
      for (const key of [...url.searchParams.keys()]) {
        if (isSensitiveKey(key)) url.searchParams.set(key, LONGMEMEVAL_REDACTED_VALUE);
      }
      return `${url.toString().replaceAll("%5BREDACTED%5D", LONGMEMEVAL_REDACTED_VALUE)}${punctuation}`;
    } catch {
      return candidate;
    }
  });
}

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized.endsWith("apikey")
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password");
}

function stableJsonStringify(value: unknown) {
  return JSON.stringify(sortJsonValue(sanitizeJsonValue(value)));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

function buildResultCommitIndex(records: JsonlRecord[]) {
  const commits = new Map<string, string>();
  for (const record of records) {
    const commitId = typeof record.value.resultCommitId === "string" ? record.value.resultCommitId : undefined;
    if (!commitId) continue;
    const computedHash = hashLongMemEvalResultPayload(record.value);
    const payloadHash = typeof record.value.payloadHash === "string" ? record.value.payloadHash : computedHash;
    if (payloadHash !== computedHash) {
      throw new LongMemEvalArtifactError("RESULT_PAYLOAD_HASH_MISMATCH", `LongMemEval result line ${record.lineNumber} has an invalid payload hash`);
    }
    const existing = commits.get(commitId);
    if (existing !== undefined && existing !== payloadHash) throw new LongMemEvalResultCommitConflictError(commitId);
    commits.set(commitId, payloadHash);
  }
  return commits;
}

function duplicateReceipt(resultCommitId: string, payloadHash: string, existingHash: string): LongMemEvalResultCommitReceipt {
  if (existingHash !== payloadHash) throw new LongMemEvalResultCommitConflictError(resultCommitId);
  return { lineNumber: 0, byteStart: 0, byteEnd: 0, resultCommitId, payloadHash, duplicate: true };
}

function readStrongResultIdentity(row: Record<string, unknown>) {
  if (!isRecord(row.datasetIdentity) || !isRecord(row.sampleIdentity)) return undefined;
  const datasetIdentity = {
    path: String(row.datasetIdentity.path ?? ""),
    sha256: String(row.datasetIdentity.sha256 ?? ""),
    sampleCount: Number(row.datasetIdentity.sampleCount)
  };
  const sampleIdentity = {
    index: Number(row.sampleIdentity.index),
    questionId: String(row.sampleIdentity.questionId ?? "")
  };
  validateDatasetIdentity(datasetIdentity);
  validateSampleIdentity(sampleIdentity);
  return {
    datasetIdentity,
    sampleIdentity,
    runId: String(row.runId ?? ""),
    modelRunId: String(row.modelRunId ?? "default"),
    resultCommitId: typeof row.resultCommitId === "string" ? row.resultCommitId : undefined
  };
}

function readLegacyResultIdentity(
  row: Record<string, unknown>,
  currentDataset: LongMemEvalDatasetIdentity,
  resumeLegacy: boolean,
  lineNumber: number
) {
  if (!resumeLegacy) {
    throw new LongMemEvalArtifactError(
      "LEGACY_RESUME_REQUIRED",
      `LongMemEval result line ${lineNumber} has no strong identity; set resumeLegacy=true to use weak validation`
    );
  }
  const datasetPath = typeof row.datasetPath === "string" ? resolve(row.datasetPath) : "";
  const sampleIdentity = {
    index: Number(row.sampleIndex),
    questionId: String(row.questionId ?? row.question_id ?? "")
  };
  validateSampleIdentity(sampleIdentity);
  if (!datasetPath || datasetPath !== currentDataset.path) {
    throw new LongMemEvalArtifactError("RESULT_DATASET_MISMATCH", `LongMemEval legacy result line ${lineNumber} has a different dataset path`);
  }
  return {
    datasetIdentity: currentDataset,
    sampleIdentity,
    runId: String(row.runId ?? "legacy"),
    modelRunId: String(row.modelRunId ?? "default"),
    resultCommitId: typeof row.resultCommitId === "string" ? row.resultCommitId : undefined
  };
}

function assertDatasetMatches(actual: LongMemEvalDatasetIdentity, expected: LongMemEvalDatasetIdentity, lineNumber: number) {
  if (resolve(actual.path) !== expected.path || actual.sha256 !== expected.sha256 || actual.sampleCount !== expected.sampleCount) {
    throw new LongMemEvalArtifactError("RESULT_DATASET_MISMATCH", `LongMemEval result line ${lineNumber} belongs to a different dataset`);
  }
}

function validateDatasetIdentity(identity: LongMemEvalDatasetIdentity) {
  if (!identity.path || !isAbsolute(identity.path) || !/^[a-f0-9]{64}$/u.test(identity.sha256) || !Number.isInteger(identity.sampleCount) || identity.sampleCount < 0) {
    throw new LongMemEvalArtifactError("INVALID_DATASET_IDENTITY", "LongMemEval dataset identity is invalid");
  }
}

function validateSampleIdentity(identity: LongMemEvalSampleIdentity) {
  if (!Number.isInteger(identity.index) || identity.index < 1 || !identity.questionId) {
    throw new LongMemEvalArtifactError("INVALID_SAMPLE_IDENTITY", "LongMemEval sample identity is invalid");
  }
}

function validateRunId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new LongMemEvalArtifactError("INVALID_RUN_ID", "LongMemEval run ID contains unsafe characters");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readErrorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function readFileNoFollow(path: string) {
  const handle = await openNoFollow(path, constants.O_RDONLY);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function openNoFollow(path: string, flags: number, mode?: number) {
  try {
    return await open(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
  } catch (error) {
    if (readErrorCode(error) === "ELOOP") {
      throw new LongMemEvalArtifactError("ARTIFACT_SYMLINK_REJECTED", `LongMemEval artifact must not be a symbolic link: ${path}`);
    }
    throw error;
  }
}

async function removeStaleLock(lockPath: string) {
  let metadata: unknown;
  try {
    metadata = JSON.parse((await readFileNoFollow(lockPath)).toString("utf8"));
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return true;
    if (error instanceof LongMemEvalArtifactError) throw error;
    return false;
  }
  const pid = isRecord(metadata) ? Number(metadata.pid) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return readErrorCode(error) !== "ESRCH";
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
