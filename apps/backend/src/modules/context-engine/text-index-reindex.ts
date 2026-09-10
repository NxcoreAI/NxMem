import { buildTextIndexEntry } from "./indexing.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

export interface TextIndexReindexResult {
  shortTermMemories: number;
  longTermMemories: number;
  total: number;
}

export async function reindexMemoryTextIndexes(
  repository: ContextEngineRepository,
  onProgress?: (processed: number, total: number) => void
): Promise<TextIndexReindexResult> {
  const entries = repository.getDebugSnapshot().indexEntries
    .filter((entry) => entry.ownerType === "stm" || entry.ownerType === "ltm");
  let processed = 0;
  for (const entry of entries) {
    await repository.deleteTextIndexEntry(entry.indexId);
    await repository.saveTextIndexEntry(buildTextIndexEntry(entry));
    processed += 1;
    onProgress?.(processed, entries.length);
  }
  return {
    shortTermMemories: entries.filter((entry) => entry.ownerType === "stm").length,
    longTermMemories: entries.filter((entry) => entry.ownerType === "ltm").length,
    total: entries.length
  };
}
