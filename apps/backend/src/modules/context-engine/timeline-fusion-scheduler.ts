import type { FactBatchCommitted, TimelineFusionTask } from "./domain.js";
import { sameFactBatchCommit } from "./fact-batch.js";
import { enqueueContextPipelineJob, type PipelineJob } from "./pipeline-job-queue.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import {
  createTimelineFusionTask,
  mergeTimelineFusionTask
} from "./timeline-fusion-task.js";
import { processTimelineFusionTask } from "./timeline-fusion-processor.js";

export const DEFAULT_TIMELINE_FUSION_DEBOUNCE_MS = 20_000;
export const DEFAULT_TIMELINE_FUSION_MAX_WAIT_MS = 120_000;
export const DEFAULT_TIMELINE_FUSION_MAX_BATCH_COUNT = 16;
export const DEFAULT_TIMELINE_FUSION_MAX_NEW_FACT_COUNT = 128;

export interface TimelineFusionSchedulerOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  maxBatchCount?: number;
  maxNewFactCount?: number;
  now?: () => string;
  enqueueJob?: (job: PipelineJob) => Promise<void>;
  prepareReadyTask?: (task: TimelineFusionTask) => Promise<void>;
  onError?: (error: unknown) => void;
}

export class TimelineFusionScheduler {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxBatchCount: number;
  private readonly maxNewFactCount: number;
  private readonly now: () => string;
  private readonly enqueueJob: (job: PipelineJob) => Promise<void>;
  private readonly prepareReadyTask: (task: TimelineFusionTask) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private mutation: Promise<void> = Promise.resolve();
  private active = true;

  constructor(
    private readonly repository: ContextEngineRepository,
    options: TimelineFusionSchedulerOptions = {}
  ) {
    this.debounceMs = nonNegativeInteger(
      options.debounceMs ?? process.env.CONTEXT_TIMELINE_FUSION_DEBOUNCE_MS,
      DEFAULT_TIMELINE_FUSION_DEBOUNCE_MS
    );
    this.maxWaitMs = nonNegativeInteger(
      options.maxWaitMs ?? process.env.CONTEXT_TIMELINE_FUSION_MAX_WAIT_MS,
      DEFAULT_TIMELINE_FUSION_MAX_WAIT_MS
    );
    this.maxBatchCount = positiveInteger(
      options.maxBatchCount ?? process.env.CONTEXT_TIMELINE_FUSION_MAX_BATCH_COUNT,
      DEFAULT_TIMELINE_FUSION_MAX_BATCH_COUNT
    );
    this.maxNewFactCount = positiveInteger(
      options.maxNewFactCount ?? process.env.CONTEXT_TIMELINE_FUSION_MAX_NEW_FACT_COUNT,
      DEFAULT_TIMELINE_FUSION_MAX_NEW_FACT_COUNT
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.enqueueJob = options.enqueueJob ?? enqueueContextPipelineJob;
    this.prepareReadyTask = options.prepareReadyTask ?? (async (task) => {
      await processTimelineFusionTask(this.repository, task, { now: this.now });
    });
    this.onError = options.onError ?? (() => undefined);
  }

  enqueue(batch: FactBatchCommitted): Promise<TimelineFusionTask> {
    const operation = this.mutation.then(() => this.enqueueInternal(batch));
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async start() {
    this.active = true;
    const pending = await this.repository.listTimelineFusionTasks({ statuses: ["pending", "ready", "running"] });
    const now = this.now();
    const due: Promise<void>[] = [];
    for (const task of pending) {
      if (task.status === "running") {
        const recovered: TimelineFusionTask = {
          ...task,
          status: "ready",
          updatedAt: now
        };
        await this.repository.saveTimelineFusionTask(recovered);
        due.push(this.dispatchReady(recovered).catch(this.onError));
        continue;
      }
      if (task.status === "ready") {
        due.push(this.dispatchReady(task).catch(this.onError));
        continue;
      }
      if (Date.parse(task.scheduledAt) <= Date.parse(now)) {
        due.push(this.dispatch(task.taskId).catch(this.onError));
      } else {
        this.arm(task);
      }
    }
    await Promise.all(due);
  }

  stop() {
    this.active = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async runDue() {
    await this.mutation;
    const now = this.now();
    const pending = await this.repository.listTimelineFusionTasks({ statuses: ["pending"] });
    await Promise.all(pending
      .filter((task) => Date.parse(task.scheduledAt) <= Date.parse(now))
      .map((task) => this.dispatch(task.taskId)));
  }

  snapshot() {
    return {
      debounceMs: this.debounceMs,
      maxWaitMs: this.maxWaitMs,
      maxBatchCount: this.maxBatchCount,
      maxNewFactCount: this.maxNewFactCount,
      armed: this.timers.size
    };
  }

  private async enqueueInternal(batch: FactBatchCommitted) {
    const persisted = await this.repository.getFactBatchCommitted(batch.batchId);
    if (!persisted || !sameFactBatchCommit(persisted, batch)) {
      throw new Error(`timeline_fusion_batch_not_committed:${batch.batchId}`);
    }

    const ownerTasks = await this.repository.listTimelineFusionTasks({
      tenantId: batch.tenantId,
      principalId: batch.principalId,
      ...(batch.contextScopeId ? { contextScopeId: batch.contextScopeId } : {})
    });
    const duplicate = ownerTasks.find((task) => task.batchIds.includes(batch.batchId));
    if (duplicate) {
      if (duplicate.status === "pending") this.arm(duplicate);
      return duplicate;
    }

    if (new Set(batch.newFactIds).size > this.maxNewFactCount) {
      throw new Error(`timeline_fusion_batch_fact_limit_exceeded:${batch.batchId}`);
    }
    const pending = ownerTasks
      .filter((task) => task.status === "pending" && sameContextScope(task, batch))
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.taskId.localeCompare(left.taskId)
      )
      .find((task) => canMergeTimelineFusionTask(
        task,
        batch,
        this.maxBatchCount,
        this.maxNewFactCount
      ));
    const now = this.now();
    const task = pending
      ? mergeTimelineFusionTask(pending, batch, now, this.debounceMs)
      : createTimelineFusionTask({
          batch,
          now,
          debounceMs: this.debounceMs,
          maxWaitMs: this.maxWaitMs
        });
    await this.repository.saveTimelineFusionTask(task);
    this.arm(task);
    return task;
  }

  private arm(task: TimelineFusionTask) {
    const existing = this.timers.get(task.taskId);
    if (existing) clearTimeout(existing);
    this.timers.delete(task.taskId);
    if (!this.active || task.status !== "pending") return;
    const delayMs = Math.max(0, Date.parse(task.scheduledAt) - Date.parse(this.now()));
    const timer = setTimeout(() => {
      this.timers.delete(task.taskId);
      void this.dispatch(task.taskId).catch(this.onError);
    }, delayMs);
    timer.unref();
    this.timers.set(task.taskId, timer);
  }

  private dispatch(taskId: string) {
    return this.enqueueJob(() => this.promoteWhenDue(taskId));
  }

  private dispatchReady(task: TimelineFusionTask) {
    return this.enqueueJob(() => this.prepareReadyTask(task));
  }

  private async promoteWhenDue(taskId: string) {
    const task = await this.repository.getTimelineFusionTask(taskId);
    if (!task || task.status !== "pending") return;
    const now = this.now();
    if (Date.parse(task.scheduledAt) > Date.parse(now)) {
      this.arm(task);
      return;
    }
    const readyTask: TimelineFusionTask = {
      ...task,
      status: "ready",
      readyAt: now,
      updatedAt: now
    };
    await this.repository.saveTimelineFusionTask(readyTask);
    await this.prepareReadyTask(readyTask);
  }
}

const schedulers = new WeakMap<ContextEngineRepository, TimelineFusionScheduler>();

export function getTimelineFusionScheduler(
  repository: ContextEngineRepository,
  options: TimelineFusionSchedulerOptions = {}
) {
  const existing = schedulers.get(repository);
  if (existing) return existing;
  const scheduler = new TimelineFusionScheduler(repository, options);
  schedulers.set(repository, scheduler);
  return scheduler;
}

export function enqueueFactBatchForTimelineFusion(
  repository: ContextEngineRepository,
  batch: FactBatchCommitted
) {
  return getTimelineFusionScheduler(repository).enqueue(batch);
}

function nonNegativeInteger(value: number | string | undefined, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value: number | string | undefined, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sameContextScope(task: TimelineFusionTask, batch: FactBatchCommitted) {
  return task.contextScopeId === batch.contextScopeId;
}

function canMergeTimelineFusionTask(
  task: TimelineFusionTask,
  batch: FactBatchCommitted,
  maxBatchCount: number,
  maxNewFactCount: number
) {
  return new Set([...task.batchIds, batch.batchId]).size <= maxBatchCount &&
    new Set([...task.newFactIds, ...batch.newFactIds]).size <= maxNewFactCount;
}
