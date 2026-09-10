import type {
  MemoryEvent,
  MemoryChangeEvent
} from "./domain.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import { parseAndAdmitEvent } from "./parse-event.js";
import { enqueueEventPipeline, runEventPipeline } from "./context-pipeline-queue.js";
import {
  createPipelineTask,
  scheduleRetry,
  updatePipelineTask
} from "./pipeline-task.js";
import { sourceRefsFromEvent } from "./memory-event-fields.js";
import type { ForegroundActivityGate } from "./foreground-activity-gate.js";

export interface WriteEventInput {
  event: MemoryEvent;
  idempotencyKey: string;
  llm?: LlmFactFusionOptions;
  deferPipeline?: boolean;
  skipPipeline?: boolean;
}

export interface WriteEventResult {
  accepted: boolean;
  eventId: string;
  jobId: string;
  deduplicated: boolean;
  pipelineStatus?: "event_only" | "queued" | "succeeded";
}

export interface WriteAgentMemoryInput {
  content: string;
  idempotencyKey: string;
  tenantId?: string;
  principalId?: string;
  visibility?: MemoryEvent["permissionSnapshot"]["visibility"];
  sourceApp?: string;
  sourceId?: string;
  memoryType?: string;
  summary?: string;
  eventTime?: string;
  deferPipeline?: boolean;
  skipPipeline?: boolean;
}

export interface WriteAgentMemoryResult extends WriteEventResult {
  factIds: string[];
  memoryDataId?: string;
}

export interface ContextEngineService {
  writeEvent(input: WriteEventInput): Promise<WriteEventResult>;
  writeAgentMemory(input: WriteAgentMemoryInput): Promise<WriteAgentMemoryResult>;
  retryPipelineTask(taskId: string): Promise<WriteEventResult>;
}

export function createContextEngineService(
  repository: ContextEngineRepository,
  options: { activityGate?: ForegroundActivityGate } = {}
): ContextEngineService {
  const idempotencyCache = new Map<string, WriteEventResult>();
  const agentMemoryCache = new Map<string, WriteAgentMemoryResult>();

  return {
    async writeEvent(input) {
      assertMemoryEvent(input.event);
      const owner = {
        tenantId: input.event.permissionSnapshot.tenantId,
        principalId: input.event.permissionSnapshot.principalId
      };
      return withActivity(options.activityGate, owner, async () => {
      const cached = idempotencyCache.get(input.idempotencyKey);
      if (cached) {
        return { ...cached, deduplicated: true };
      }

      let task = createPipelineTask(input.event);
      await repository.savePipelineTask(task);

      await repository.saveMemoryEvent(input.event);
      task = await updatePipelineTask(repository, task, {
        taskType: "ingest",
        status: "running",
        stage: "event_saved"
      });

      const jobId = `ingest_${input.event.eventId}`;
      const result: WriteEventResult = {
        accepted: true,
        eventId: input.event.eventId,
        jobId,
        deduplicated: false,
        pipelineStatus: input.skipPipeline ? "event_only" : input.deferPipeline ? "queued" : "succeeded"
      };

      idempotencyCache.set(input.idempotencyKey, result);

      const changeEvent: MemoryChangeEvent = {
        eventId: `mce_${input.event.eventId}`,
        memoryDataId: input.event.eventId,
        changeType: "created",
        storageLayer: "fact",
        reason: "memory_event_accepted",
        createdAt: new Date().toISOString()
      };
      await repository.saveMemoryChangeEvent(changeEvent);

      if (input.skipPipeline) {
        await updatePipelineTask(repository, task, {
          taskType: "ingest",
          status: "succeeded",
          stage: "event_only"
        });
        return result;
      }

      if (input.deferPipeline) {
        await enqueueEventPipeline(repository, input.event, task, input.llm, false, options.activityGate);
        return result;
      }

      await runEventPipeline(repository, input.event, task, input.llm, true);

      return result;
      });
    },

    async retryPipelineTask(taskId) {
      const snapshot = repository.getDebugSnapshot();
      const task = snapshot.pipelineTasks.find((item) => item.taskId === taskId);
      if (!task) throw new Error("pipeline task not found");
      if (task.status !== "failed" && task.status !== "retry_scheduled") {
        throw new Error("pipeline task is not in a retryable state");
      }
      if (!task.retryable) throw new Error("pipeline task is not retryable");
      const event = snapshot.memoryEvents.find((item) => item.eventId === task.eventId);
      if (!event) throw new Error("pipeline task event not found");

      const retryTask = {
        ...createPipelineTask(event, task.attempt + 1),
        taskId: task.taskId,
        createdAt: task.createdAt,
        stage: "retry_started"
      };
      await repository.savePipelineTask(retryTask);

      try {
        await parseAndAdmitEvent(repository, event, retryTask);
      } catch (error) {
        await repository.savePipelineTask(scheduleRetry(retryTask, error));
        throw error;
      }

      return {
        accepted: true,
        eventId: event.eventId,
        jobId: task.taskId,
        deduplicated: false
      };
    },

    async writeAgentMemory(input) {
      const cached = agentMemoryCache.get(input.idempotencyKey);
      if (cached) {
        return { ...cached, deduplicated: true };
      }

      assertAgentMemoryInput(input);

      const safeId = input.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      const eventId = `agent_memory_${safeId}`;
      const now = input.eventTime ?? new Date().toISOString();
      const sourceId = input.sourceId ?? "agent-memory";
      const event: MemoryEvent = {
        eventId,
        eventType: input.memoryType ?? "agent_memory",
        ...(input.summary ? { eventSummary: input.summary } : {}),
        eventTime: now,
        sourceApp: input.sourceApp ?? "agent",
        sourceId,
        permissionSnapshot: {
          snapshotId: `ps_${eventId}`,
          tenantId: input.tenantId ?? "local",
          principalId: input.principalId ?? "agent",
          sourceAclVersion: "agent-memory-v1",
          visibility: input.visibility ?? "private"
        },
        multimodalData: [
          {
            itemId: `item_${eventId}`,
            type: "text",
            format: "json",
            content: {
              text: input.content
            },
            ref: sourceId,
            sourceRefs: [{
              sourceRefId: `src_${eventId}`,
              sourceType: "agent_memory",
              sourceId
            }],
            timeBasis: "source_time",
            timeConfidence: "high"
          }
        ],
        sourceRefs: [
          {
            sourceRefId: `src_${eventId}`,
            sourceType: "agent_memory",
            sourceId
          }
        ]
      };

      const writeResult = await this.writeEvent({
        event,
        idempotencyKey: `agent:${input.idempotencyKey}`,
        ...(typeof input.skipPipeline === "boolean" ? { skipPipeline: input.skipPipeline } : {}),
        ...(typeof input.deferPipeline === "boolean" ? { deferPipeline: input.deferPipeline } : {})
      });
      const snapshot = repository.getDebugSnapshot();
      const factIds = snapshot.facts
        .filter((fact) => fact.linkedEventIds.includes(eventId))
        .map((fact) => fact.factId);
      const factIdSet = new Set(factIds);
      const memory = snapshot.shortTermMemories.find((item) =>
        item.sourceFactIds.some((factId) => factIdSet.has(factId))
      );
      const result: WriteAgentMemoryResult = {
        ...writeResult,
        factIds,
        ...(memory ? { memoryDataId: memory.memoryDataId } : {})
      };

      agentMemoryCache.set(input.idempotencyKey, result);

      return result;
    }
  };
}

function withActivity<T>(
  gate: ForegroundActivityGate | undefined,
  owner: { tenantId: string; principalId: string },
  callback: () => Promise<T>
) {
  return gate ? gate.run(owner, callback) : callback();
}

function assertMemoryEvent(event: MemoryEvent): void {
  if (!event.eventId) throw new Error("eventId is required");
  if (!event.eventType) throw new Error("eventType is required");
  if (!event.eventTime) throw new Error("eventTime is required");
  if (!event.permissionSnapshot) {
    throw new Error("permissionSnapshot is required");
  }
  if (!event.multimodalData?.length) {
    throw new Error("multimodalData is required");
  }
  if (!sourceRefsFromEvent(event).length) {
    throw new Error("sourceRefs is required");
  }
}

function assertAgentMemoryInput(input: WriteAgentMemoryInput): void {
  if (!input.idempotencyKey?.trim()) throw new Error("idempotencyKey is required");
  if (!input.content?.trim()) throw new Error("content is required");
  if (input.eventTime && Number.isNaN(Date.parse(input.eventTime))) {
    throw new Error("eventTime must be an ISO timestamp");
  }
}
