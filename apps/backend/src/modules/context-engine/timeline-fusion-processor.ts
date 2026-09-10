import type {
  TimelineFusionExecution,
  TimelineFusionTask
} from "./domain.js";
import {
  prepareTimelineFusionTask,
  type TimelineFusionCandidateProcessorOptions,
  type TimelineFusionPreparationResult
} from "./timeline-fusion-candidate-processor.js";
import { buildTimelineFusionFactStoreMutation } from "./timeline-fusion-fact-store.js";
import {
  judgeTimelineFusionRelationsWithLlm,
  type TimelineFusionRelationJudgmentOptions,
  type TimelineFusionRelationJudgmentResult
} from "./timeline-fusion-relation-judgment.js";
import type { TimelineFusionRelationInput } from "./timeline-fusion-relations.js";
import type { ContextEngineRepository } from "./persistence/repository.js";
import {
  reconcileTimelineFusionDownstream,
  type TimelineFusionDownstreamOptions
} from "./timeline-fusion-downstream.js";

export interface TimelineFusionProcessorOptions extends TimelineFusionCandidateProcessorOptions {
  judgment?: TimelineFusionRelationJudgmentOptions;
  judgeRelations?: (
    input: TimelineFusionRelationInput
  ) => Promise<TimelineFusionRelationJudgmentResult>;
  downstream?: TimelineFusionDownstreamOptions | false;
}

export interface TimelineFusionProcessingResult extends TimelineFusionPreparationResult {
  task: TimelineFusionTask;
  executions: TimelineFusionExecution[];
}

export async function processTimelineFusionTask(
  repository: ContextEngineRepository,
  task: TimelineFusionTask,
  options: TimelineFusionProcessorOptions = {}
): Promise<TimelineFusionProcessingResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const preparation = await prepareTimelineFusionTask(repository, task, options);
  if (preparation.task.status === "succeeded") {
    const executions = preparation.windows.map((window) => window.execution);
    if (options.downstream !== false) {
      await reconcileTimelineFusionDownstream(
        repository,
        preparation.task,
        executions,
        options.downstream
      );
    }
    return {
      ...preparation,
      executions
    };
  }

  const runningAt = now();
  const runningTask: TimelineFusionTask = {
    ...preparation.task,
    status: "running",
    updatedAt: runningAt
  };
  await repository.saveTimelineFusionTask(runningTask);

  const executions: TimelineFusionExecution[] = [];
  try {
    for (const window of preparation.windows) {
      if (window.execution.status === "succeeded") {
        executions.push(window.execution);
        continue;
      }
      if (!window.relationInput) {
        throw new Error(`timeline_fusion_relation_input_missing:${window.execution.fingerprint}`);
      }

      const runningExecution = toRunningExecution(window.execution, now());
      await repository.saveTimelineFusionExecution(runningExecution);
      try {
        const judgment = options.judgeRelations
          ? await options.judgeRelations(window.relationInput)
          : await judgeTimelineFusionRelationsWithLlm(window.relationInput, options.judgment);
        const factIds = window.relationInput.facts.map((fact) => fact.factId);
        const currentFacts = await repository.getFactItemsByIds(factIds);
        const currentVersions = await repository.getFactVersions({
          tenantId: runningExecution.tenantId,
          principalId: runningExecution.principalId
        });
        const completedAt = now();
        const mutation = buildTimelineFusionFactStoreMutation({
          execution: runningExecution,
          relationInput: window.relationInput,
          relationResult: judgment.result,
          currentFacts,
          currentVersions,
          now: completedAt
        });
        const committed = await repository.commitTimelineFusionFactStore({
          execution: runningExecution,
          facts: mutation.facts,
          versions: mutation.versions,
          resultFactIds: mutation.resultFactIds,
          completedAt
        });
        executions.push(committed.execution);
      } catch (error) {
        await repository.saveTimelineFusionExecution(toFailedExecution(runningExecution, error, now()));
        throw error;
      }
    }

    const completedAt = now();
    const completedTask: TimelineFusionTask = {
      ...runningTask,
      status: "succeeded",
      executionFingerprints: executions.map((execution) => execution.fingerprint),
      completedAt,
      updatedAt: completedAt
    };
    if (options.downstream !== false) {
      await reconcileTimelineFusionDownstream(
        repository,
        completedTask,
        executions,
        options.downstream
      );
    }
    await repository.saveTimelineFusionTask(completedTask);
    return { ...preparation, task: completedTask, executions };
  } catch (error) {
    const completedAt = now();
    await repository.saveTimelineFusionTask({
      ...runningTask,
      status: "failed",
      error: errorMessage(error),
      completedAt,
      updatedAt: completedAt
    });
    throw error;
  }
}

function toRunningExecution(
  execution: TimelineFusionExecution,
  updatedAt: string
): TimelineFusionExecution {
  const {
    completedAt: _completedAt,
    completionReason: _completionReason,
    error: _error,
    ...pending
  } = execution;
  return {
    ...pending,
    status: "running",
    resultFactIds: [],
    attempt: execution.attempt + 1,
    updatedAt
  };
}

function toFailedExecution(
  execution: TimelineFusionExecution,
  error: unknown,
  completedAt: string
): TimelineFusionExecution {
  return {
    ...execution,
    status: "failed",
    error: errorMessage(error),
    completedAt,
    updatedAt: completedAt
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
