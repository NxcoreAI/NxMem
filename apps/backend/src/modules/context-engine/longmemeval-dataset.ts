import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { LongMemEvalSample } from "./longmemeval.js";

export interface LongMemEvalDatasetSelection {
  sourcePath: string;
  totalSamples: number;
  selectedSamples: number;
  questionTypeCounts: Record<string, number>;
  selection: "all" | "question_id" | "range" | "ratio";
  questionIds?: string[];
  sampleRange?: { start: number; end: number };
  ratio?: number;
  seed?: number;
  outputPath?: string;
}

export interface LongMemEvalDatasetFile {
  path: string;
  temporary: boolean;
  cleanup: () => Promise<void>;
}

export async function readLongMemEvalDatasetSamples(datasetPath: string): Promise<LongMemEvalSample[]> {
  const parsed = JSON.parse(await readFile(datasetPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LongMemEval dataset must be a JSON array");
  if (parsed.some((sample) => !sample || typeof sample !== "object" || Array.isArray(sample))) {
    throw new Error("LongMemEval dataset samples must be JSON objects");
  }
  return parsed as LongMemEvalSample[];
}

export function selectLongMemEvalSamples(
  samples: LongMemEvalSample[],
  input: { questionIds?: string[]; range?: { start: number; end: number } }
): LongMemEvalSample[] {
  if (input.questionIds?.length && input.range) throw new Error("--question-id and --sample-range cannot be used together");
  if (input.range) {
    const { start, end } = input.range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > samples.length) {
      throw new Error(`sample range must satisfy 1 <= start <= end <= ${samples.length}`);
    }
    return samples.slice(start - 1, end);
  }
  if (input.questionIds?.length) {
    const ids = new Set(input.questionIds.map((id) => id.trim()).filter(Boolean));
    if (!ids.size) throw new Error("at least one question id is required");
    const found = samples.filter((sample) => ids.has(String(sample.question_id ?? "")));
    const foundIds = new Set(found.map((sample) => String(sample.question_id ?? "")));
    const missing = [...ids].filter((id) => !foundIds.has(id));
    if (missing.length) throw new Error(`question id not found: ${missing.join(", ")}`);
    return found;
  }
  return samples.slice();
}

export function splitLongMemEvalSamples(samples: LongMemEvalSample[], ratio: number, seed: number): LongMemEvalSample[] {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new Error("ratio must satisfy 0 < ratio <= 1");
  if (!Number.isInteger(seed)) throw new Error("seed must be an integer");
  const byType = new Map<string, LongMemEvalSample[]>();
  for (const sample of samples) {
    const type = String(sample.question_type ?? "unknown");
    const group = byType.get(type) ?? [];
    group.push(sample);
    byType.set(type, group);
  }
  const selected = new Set<LongMemEvalSample>();
  const random = seededRandom(seed);
  for (const group of byType.values()) {
    const shuffled = group.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const count = ratio === 1 ? group.length : Math.max(1, Math.floor(group.length * ratio));
    for (const sample of shuffled.slice(0, count)) selected.add(sample);
  }
  return samples.filter((sample) => selected.has(sample));
}

export function buildLongMemEvalSelectionMetadata(
  sourcePath: string,
  samples: LongMemEvalSample[],
  options: Omit<LongMemEvalDatasetSelection, "samples" | "sourcePath" | "totalSamples" | "selectedSamples" | "questionTypeCounts">
): LongMemEvalDatasetSelection {
  const questionTypeCounts: Record<string, number> = {};
  for (const sample of samples) {
    const type = String(sample.question_type ?? "unknown");
    questionTypeCounts[type] = (questionTypeCounts[type] ?? 0) + 1;
  }
  return { ...options, sourcePath, totalSamples: samples.length, selectedSamples: samples.length, questionTypeCounts };
}

export async function writeLongMemEvalDataset(
  samples: LongMemEvalSample[],
  outputPath?: string
): Promise<LongMemEvalDatasetFile> {
  if (outputPath) {
    const path = resolve(outputPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(samples, null, 2)}\n`, "utf8");
    return { path, temporary: false, cleanup: async () => undefined };
  }
  const directory = await mkdtemp(join(tmpdir(), "longmemeval-cli-"));
  const path = join(directory, "dataset.json");
  await writeFile(path, `${JSON.stringify(samples, null, 2)}\n`, "utf8");
  return { path, temporary: true, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
