import type {
  TimelineFusionExecution,
  TimelineFusionTask
} from "./domain.js";
import { createTimelineFusionExecution } from "./timeline-fusion-execution.js";
import { filterAndGroupTimelineFusionCandidates } from "./timeline-fusion-candidate-filter.js";
import {
  buildTimelineFusionRelationInput,
  type TimelineFusionRelationInput
} from "./timeline-fusion-relations.js";
import {
  buildTimelineFusionWindows,
  DEFAULT_TIMELINE_FUSION_CANDIDATE_LIMIT,
  DEFAULT_TIMELINE_FUSION_WINDOW_MS,
  type TimelineFusionWindowGroup
} from "./timeline-fusion-window.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

export const DEFAULT_TIMELINE_FUSION_POLICY_VERSION = "timeline-fusion.v1";

export interface TimelineFusionCandidateProcessorOptions {
  windowMs?: number;
  candidateLimit?: number;
  fusionPolicyVersion?: string;
  now?: () => string;
}

export interface TimelineFusionPreparedWindow extends TimelineFusionWindowGroup {
  candidateFactIds: string[];
  decision: "no_candidate" | "candidates_ready";
  relationInput?: TimelineFusionRelationInput;
  execution: TimelineFusionExecution;
}

export interface TimelineFusionPreparationResult {
  task: TimelineFusionTask;
  windows: TimelineFusionPreparedWindow[];
}

export async function prepareTimelineFusionTask(
  repository: ContextEngineRepository,
  task: TimelineFusionTask,
  options: TimelineFusionCandidateProcessorOptions = {}
): Promise<TimelineFusionPreparationResult> {
  if (task.status !== "ready") {
    throw new Error(`timeline_fusion_task_not_ready:${task.taskId}`);
  }
  const now = options.now ?? (() => new Date().toISOString());
  try {
    const facts = await repository.getFactItemsByIds(task.newFactIds);
    const foundFactIds = new Set(facts.map((fact) => fact.factId));
    const missingFactIds = task.newFactIds.filter((factId) => !foundFactIds.has(factId));
    if (missingFactIds.length) {
      throw new Error(`timeline_fusion_task_facts_missing:${missingFactIds.join(",")}`);
    }
    const eventIds = [...new Set(facts.flatMap((fact) => fact.linkedEventIds))];
    const events = await repository.getMemoryEventsByIds(eventIds);
    const windows = buildTimelineFusionWindows(facts, events, {
      windowMs: nonNegativeInteger(
        options.windowMs ?? process.env.CONTEXT_TIMELINE_FUSION_WINDOW_MS,
        DEFAULT_TIMELINE_FUSION_WINDOW_MS
      )
    });
    if (!windows.length) {
      const completed = await completeTask(repository, task, now(), "no_temporal_window", []);
      return { task: completed, windows: [] };
    }

    const prepared: TimelineFusionPreparedWindow[] = [];
    for (const window of windows) {
      const candidateFacts = await repository.findTimelineFusionFactCandidates({
        tenantId: task.tenantId,
        principalId: task.principalId,
        ...(task.contextScopeId ? { contextScopeId: task.contextScopeId } : {}),
        temporalWindow: window.temporalWindow,
        excludeFactIds: task.newFactIds,
        limit: positiveInteger(
          options.candidateLimit ?? process.env.CONTEXT_TIMELINE_FUSION_CANDIDATE_LIMIT,
          DEFAULT_TIMELINE_FUSION_CANDIDATE_LIMIT
        )
      });
      const newFactsById = new Map(facts.map((fact) => [fact.factId, fact]));
      const filtered = filterAndGroupTimelineFusionCandidates({
        newFacts: window.newFactIds.map((factId) => newFactsById.get(factId)!),
        candidateFacts,
        temporalWindow: window.temporalWindow
      });
      const factById = new Map([...facts, ...candidateFacts].map((fact) => [fact.factId, fact]));
      for (const group of filtered.groups) {
        const createdAt = now();
        let execution = await repository.reserveTimelineFusionExecution(createTimelineFusionExecution({
          tenantId: task.tenantId,
          principalId: task.principalId,
          ...(task.contextScopeId ? { contextScopeId: task.contextScopeId } : {}),
          taskIds: [task.taskId],
          batchIds: task.batchIds,
          newFactIds: group.newFactIds,
          temporalWindow: window.temporalWindow,
          fusionPolicyVersion: options.fusionPolicyVersion ?? DEFAULT_TIMELINE_FUSION_POLICY_VERSION,
          createdAt
        }));
        const noCandidate = group.newFactIds.length === 1 && group.candidateFactIds.length === 0;
        if (noCandidate && execution.status === "pending") {
          execution = {
            ...execution,
            status: "succeeded",
            resultFactIds: execution.newFactIds,
            completionReason: "no_candidate",
            updatedAt: createdAt,
            completedAt: createdAt
          };
          await repository.saveTimelineFusionExecution(execution);
        }
        const effectiveNoCandidate = noCandidate ||
          (execution.status === "succeeded" && execution.completionReason === "no_candidate");
        const relationInput = effectiveNoCandidate
          ? undefined
          : buildTimelineFusionRelationInput({
              newFacts: group.newFactIds.map((factId) => factById.get(factId)!),
              candidateFacts: group.candidateFactIds.map((factId) => factById.get(factId)!),
              temporalWindow: window.temporalWindow
            });
        prepared.push({
          ...window,
          newFactIds: group.newFactIds,
          candidateFactIds: group.candidateFactIds,
          decision: effectiveNoCandidate ? "no_candidate" : "candidates_ready",
          ...(relationInput ? { relationInput } : {}),
          execution
        });
      }
    }

    const fingerprints = prepared.map((item) => item.execution.fingerprint);
    const allNoCandidate = prepared.every((item) =>
      item.execution.status === "succeeded" && item.execution.completionReason === "no_candidate"
    );
    const updatedAt = now();
    const updatedTask: TimelineFusionTask = allNoCandidate
      ? {
          ...task,
          status: "succeeded",
          executionFingerprints: fingerprints,
          completionReason: "no_candidate",
          completedAt: updatedAt,
          updatedAt
        }
      : {
          ...task,
          executionFingerprints: fingerprints,
          updatedAt
        };
    await repository.saveTimelineFusionTask(updatedTask);
    return { task: updatedTask, windows: prepared };
  } catch (error) {
    const completedAt = now();
    await repository.saveTimelineFusionTask({
      ...task,
      status: "failed",
      completedAt,
      error: error instanceof Error ? error.message : String(error),
      updatedAt: completedAt
    });
    throw error;
  }
}

async function completeTask(
  repository: ContextEngineRepository,
  task: TimelineFusionTask,
  completedAt: string,
  completionReason: NonNullable<TimelineFusionTask["completionReason"]>,
  executionFingerprints: string[]
) {
  const completed: TimelineFusionTask = {
    ...task,
    status: "succeeded",
    completionReason,
    executionFingerprints,
    completedAt,
    updatedAt: completedAt
  };
  await repository.saveTimelineFusionTask(completed);
  return completed;
}

function nonNegativeInteger(value: number | string | undefined, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value: number | string | undefined, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
