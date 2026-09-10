import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { getContextEngineConfig } from "../../config.js";
import { extractDocumentContent } from "./document-extraction.js";
import type { MemoryEvent, MultimodalDataItem } from "./domain.js";
import type { ContextEngineService, WriteEventResult } from "./write-event.js";

export interface FileIngestionOptions {
  directory?: string;
}

export type FileIngestionBatchStage = "event" | "data_lake" | "fact" | "stm" | "index";

export interface FileIngestionBatchItemProgress {
  path: string;
  eventId: string;
  status: "remembered" | "failed";
  currentStage: FileIngestionBatchStage;
  completedStages: FileIngestionBatchStage[];
  progress: number;
  result?: WriteEventResult;
  error?: string;
  droppedReason?: string;
}

export interface FileIngestionBatchProgress {
  total: number;
  processed: number;
  remembered: number;
  failed: number;
  progress: number;
  items: FileIngestionBatchItemProgress[];
}

export interface FileIngestionItemResult {
  path: string;
  idempotencyKey: string;
  result: WriteEventResult;
  progress: FileIngestionBatchItemProgress;
}

export interface FileIngestionResult {
  directory: string;
  ingested: FileIngestionItemResult[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{
    path: string;
    idempotencyKey: string;
    error: string;
    progress: FileIngestionBatchItemProgress;
  }>;
  progress: FileIngestionBatchProgress;
}

const textExtensions = new Set([".txt", ".md", ".json"]);
const documentExtensions = new Set([".docx", ".xlsx", ".pptx"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function defaultInboxDirectory() {
  return getContextEngineConfig().ingestion.inboxDirectory;
}

export async function ingestFilesFromDirectory(
  service: ContextEngineService,
  options: FileIngestionOptions = {}
): Promise<FileIngestionResult> {
  const allowedDirectory = defaultInboxDirectory();
  const directory = resolveRequestedDirectory(options.directory, allowedDirectory);

  if (!isPathInside(directory, allowedDirectory)) {
    throw new Error(`directory must be inside ${allowedDirectory}`);
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const candidates: Array<{
    path: string;
    absolutePath: string;
    extension: string;
    idempotencyKey: string;
    event: MemoryEvent;
  }> = [];
  const ingested: FileIngestionItemResult[] = [];
  const failed: FileIngestionResult["failed"] = [];
  const skipped: FileIngestionResult["skipped"] = [];

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = relative(allowedDirectory, absolutePath);

    if (!entry.isFile()) {
      skipped.push({ path: relativePath, reason: "not_a_file" });
      continue;
    }

    const extension = extname(entry.name).toLowerCase();
    const fileStat = await stat(absolutePath);
    const idempotencyKey = `file:${relativePath}:${fileStat.mtimeMs}:${fileStat.size}`;
    const event = await createFileEvent(absolutePath, relativePath, extension);

    if (!event) {
      skipped.push({ path: relativePath, reason: "unsupported_extension" });
      continue;
    }

    candidates.push({
      path: relativePath,
      absolutePath,
      extension,
      idempotencyKey,
      event
    });
  }

  const totalItems = candidates.length;
  let processedCount = 0;
  let rememberedCount = 0;
  let failedCount = 0;

  for (const candidate of candidates) {
    try {
      const result = await service.writeEvent({ event: candidate.event, idempotencyKey: candidate.idempotencyKey, deferPipeline: true });
      processedCount += 1;
      if (result.accepted) rememberedCount += 1;
      const eventProgress = buildSuccessProgress(candidate.path, candidate.event.eventId, result);
      ingested.push({ path: candidate.path, idempotencyKey: candidate.idempotencyKey, result, progress: eventProgress });
    } catch (error) {
      processedCount += 1;
      failedCount += 1;
      const eventProgress = buildFailedProgress(candidate.path, candidate.event.eventId, error);
      failed.push({
        path: candidate.path,
        idempotencyKey: candidate.idempotencyKey,
        error: eventProgress.error ?? "ingestion_failed",
        progress: eventProgress
      });
    }
  }

  return {
    directory,
    ingested,
    skipped,
    failed,
    progress: buildBatchProgress({
      total: totalItems,
      processed: processedCount,
      remembered: rememberedCount,
      failed: failedCount,
      items: [...ingested.map((item) => item.progress), ...failed.map((item) => item.progress)]
    })
  };
}

function resolveRequestedDirectory(directory: string | undefined, allowedDirectory: string) {
  if (!directory) return allowedDirectory;
  if (isAbsolute(directory)) return resolve(directory);

  const projectRoot = resolve(allowedDirectory, "../..");
  return resolve(projectRoot, directory);
}

async function createFileEvent(
  absolutePath: string,
  relativePath: string,
  extension: string
): Promise<MemoryEvent | null> {
  const item = await createMultimodalDataItem(absolutePath, relativePath, extension);
  if (!item) return null;

  const now = new Date().toISOString();
  const safeId = relativePath.replace(/[^a-zA-Z0-9_-]/g, "_");

  return {
    eventId: `file_${safeId}`,
    eventType: "file_ingested",
    eventDescription: `Ingested file ${relativePath}`,
    eventTime: now,
    sourceApp: "local-file-ingestion",
    sourceId: relativePath,
    permissionSnapshot: {
      snapshotId: `ps_${safeId}`,
      tenantId: "local",
      principalId: "local-user",
      sourceAclVersion: "local-v1",
      visibility: "private"
    },
    multimodalData: [item],
    sourceRefs: [
      {
        sourceRefId: `src_${safeId}`,
        sourceType: "file",
        sourceId: relativePath
      }
    ]
  };
}

async function createMultimodalDataItem(
  absolutePath: string,
  relativePath: string,
  extension: string
): Promise<MultimodalDataItem | null> {
  const itemId = relativePath.replace(/[^a-zA-Z0-9_-]/g, "_");

  if (textExtensions.has(extension)) {
    return {
      itemId,
      type: "text",
      format: extension.slice(1),
      content: await readFile(absolutePath, "utf8"),
      ref: relativePath
    };
  }

  if (documentExtensions.has(extension)) {
    const extraction = await extractDocumentContent(absolutePath, extension);

    return {
      itemId,
      type: "document",
      format: extension.slice(1),
      ...(extraction.content ? { content: extraction.content } : {}),
      ref: relativePath
    };
  }

  if (imageExtensions.has(extension)) {
    return {
      itemId,
      type: "image",
      format: extension.slice(1),
      ref: relativePath
    };
  }

  return null;
}

function isPathInside(candidate: string, parent: string) {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function buildSuccessProgress(path: string, eventId: string, result: WriteEventResult): FileIngestionBatchItemProgress {
  return {
    eventId,
    path,
    status: "remembered",
    currentStage: "index",
    completedStages: ["event", "data_lake", "fact", "stm", "index"],
    progress: 100,
    result
  };
}

function buildFailedProgress(path: string, eventId: string, error: unknown): FileIngestionBatchItemProgress {
  return {
    eventId,
    path,
    status: "failed",
    currentStage: "event",
    completedStages: [],
    progress: 0,
    error: error instanceof Error ? error.message : "ingestion_failed",
    droppedReason: "pipeline_failed"
  };
}

function buildBatchProgress(input: {
  total: number;
  processed: number;
  remembered: number;
  failed: number;
  items: FileIngestionBatchItemProgress[];
}): FileIngestionBatchProgress {
  const total = input.total || input.items.length || 0;
  const progress = total > 0 ? Math.round((input.processed / total) * 100) : 0;
  return {
    total,
    processed: input.processed,
    remembered: input.remembered,
    failed: input.failed,
    progress,
    items: input.items
  };
}
