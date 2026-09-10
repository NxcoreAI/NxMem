import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ContextEngineConfig } from "../../config.js";
import { LOCOMO_EVALUATION_PROFILE } from "./locomo-evaluation.js";
import { locomoGraphFingerprint } from "./locomo-repository.js";

export interface LocomoStoreManifestInput {
  config: ContextEngineConfig;
  datasetSha256: string;
  conversationIds: string[];
  embeddingFingerprint: string;
  ingestionModel: string;
  answerModel: string;
}

export function createLocomoStoreManifest(input: LocomoStoreManifestInput) {
  return {
    version: 1,
    profile: LOCOMO_EVALUATION_PROFILE,
    datasetSha256: input.datasetSha256,
    conversationIds: input.conversationIds,
    embeddingFingerprint: input.embeddingFingerprint,
    schemaFingerprint: fingerprint("locomo-native-result-schema.v1|context-engine-sqlite-schema"),
    rerankerFingerprint: rerankerFingerprint(input.config),
    promptFingerprint: fingerprint("benchmark-answer-context-v1|locomo-answer-prompt-v6-frozen|locomo-refusal-relaxed-v1"),
    graphFingerprint: locomoGraphFingerprint(input.config),
    ingestionModel: input.ingestionModel,
    answerModel: input.answerModel
  };
}

export function locomoStoreIdentity(manifest: ReturnType<typeof createLocomoStoreManifest>) {
  return locomoStoreFingerprint(manifest).slice(0, 16);
}

export function locomoStoreFingerprint(manifest: ReturnType<typeof createLocomoStoreManifest>) {
  return fingerprint(JSON.stringify(manifest));
}

export async function writeLocomoStoreManifest(storePath: string, manifest: ReturnType<typeof createLocomoStoreManifest>) {
  const path = `${storePath}.manifest.json`;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function assertLocomoStoreManifest(storePath: string, expected: ReturnType<typeof createLocomoStoreManifest>) {
  const path = `${storePath}.manifest.json`;
  let actual: unknown;
  try {
    actual = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read LoCoMo Store manifest ${path}: ${formatError(error)}`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("LoCoMo Store manifest does not match dataset, selected conversations, profile, embedding, reranker, graph, prompt, or model configuration");
  }
}

export async function assertLocomoStoreReusable(storePath: string, expected: ReturnType<typeof createLocomoStoreManifest>) {
  if (!await pathExists(storePath)) return;
  await assertLocomoStoreManifest(storePath, expected);
}

async function pathExists(path: string) {
  try { await stat(path); return true; } catch { return false; }
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function rerankerFingerprint(config: ContextEngineConfig) {
  const apiKey = process.env.RERANKER_API_KEY ?? config.embedding.apiKey ?? "";
  return fingerprint(JSON.stringify({
    enabled: process.env.RERANKER_ENABLED !== "false",
    baseUrl: (process.env.RERANKER_BASE_URL ?? config.embedding.baseUrl ?? "").replace(/\/$/u, ""),
    model: process.env.RERANKER_MODEL ?? "BAAI/bge-reranker-v2-m3",
    timeoutMs: Number(process.env.RERANKER_TIMEOUT_MS ?? 60_000),
    apiKeyFingerprint: apiKey ? fingerprint(apiKey) : "missing"
  }));
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
