import { randomUUID } from "node:crypto";
import type { ContextEngineRepository } from "../persistence/repository.js";
import type { ForegroundActivityGate } from "../foreground-activity-gate.js";
import {
  hasConversationFactExtractionLlm
} from "./conversation-fact-extraction.js";
import {
  processConversationIngestionPhase3,
  type ConversationPhase3ProcessingOptions
} from "./conversation-phase3-processor.js";

export interface ConversationIngestionWorker {
  runOnce(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createConversationIngestionWorker(
  repository: ContextEngineRepository,
  options: {
    workerId?: string;
    pollIntervalMs?: number;
    now?: () => string;
    phase3?: ConversationPhase3ProcessingOptions;
    activityGate?: ForegroundActivityGate;
    onError?: (error: unknown) => void;
  } = {}
): ConversationIngestionWorker {
  const workerId = options.workerId ?? `conversation_document_${randomUUID()}`;
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? process.env.CONTEXT_CONVERSATION_PHASE2_POLL_MS,
    500
  );
  const now = options.now ?? (() => new Date().toISOString());
  const onError = options.onError ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function runOnce() {
    const claimedAt = now();
    const job = await repository.claimNextConversationIngestionJob(workerId, claimedAt, {
      includeFactPending: hasConversationFactExtractionLlm(options.phase3)
    });
    if (!job) return false;
    const claimedIngestion = await repository.getConversationIngestion(job.ingestionId);
    const releaseActivity = claimedIngestion && options.activityGate
      ? await options.activityGate.acquire({
          tenantId: claimedIngestion.tenantId,
          principalId: claimedIngestion.principalId
        })
      : undefined;
    try {
      await processConversationIngestionPhase3(repository, job.ingestionId, {
        ...(options.phase3 ?? {}),
        now: claimedAt
      });
    } catch (caught) {
      const failedAt = now();
      const ingestion = claimedIngestion ?? await repository.getConversationIngestion(job.ingestionId);
      const lastError = {
        code: "INVALID_MESSAGE_BLOCK" as const,
        message: caught instanceof Error ? caught.message : "Conversation Phase 2 processing failed.",
        occurredAt: failedAt
      };
      if (ingestion) {
        await repository.updateConversationIngestionProcessing(job.ingestionId, {
          processingStatus: "processing_failed",
          processingStage: job.stage,
          progressPercent: ingestion.progressPercent,
          layerCounts: ingestion.layerCounts,
          retry: {
            attempt: job.attempt,
            maxAttempts: job.maxAttempts,
            retryable: false
          },
          lastError,
          updatedAt: failedAt
        });
      }
      await repository.saveConversationIngestionJob({
        ...job,
        status: "failed",
        retryable: false,
        lastError,
        completedAt: failedAt,
        updatedAt: failedAt
      });
    } finally {
      releaseActivity?.();
    }
    return true;
  }

  async function drainOne() {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void drainOne().catch((error) => {
          try {
            onError(error);
          } catch {
            // Error reporting must not create another unhandled rejection.
          }
        });
      }, pollIntervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    }
  };
}

function positiveInteger(value: number | string | undefined, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
