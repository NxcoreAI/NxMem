import { randomUUID } from "node:crypto";
import { getContextEngineConfig, type ContextEngineConfig } from "../../config.js";
import type { DreamingRun, DreamingRunStatus } from "./domain.js";
import { DreamingRunService, type DreamingRunCreationResult } from "./dreaming-run-service.js";
import { DreamingScheduler } from "./dreaming-scheduler.js";
import { DreamingWorker } from "./dreaming-worker.js";
import {
  ForegroundActivityGate,
  dreamingOwnerKey,
  type DreamingOwnerScope
} from "./foreground-activity-gate.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

type StopStatus = "queued" | "paused" | "cancelled";

interface ActiveRun {
  runId: string;
  owner: DreamingOwnerScope;
  controller: AbortController;
  stopStatus?: StopStatus;
  pauseReason?: DreamingRun["pauseReason"];
}

export interface DreamingRuntimeOptions {
  config?: ContextEngineConfig["dreaming"];
  now?: () => string;
  workerId?: string;
  runService?: DreamingRunService;
  worker?: DreamingWorker;
  onError?: (error: unknown) => void;
}

export class DreamingRuntimeDisabledError extends Error {
  constructor() {
    super("DREAMING_RUNTIME_DISABLED");
    this.name = "DreamingRuntimeDisabledError";
  }
}

/** Coordinates durable Runs, one global Worker, scheduling, and foreground preemption. */
export class DreamingRuntime {
  readonly activityGate: ForegroundActivityGate;
  readonly runService: DreamingRunService;
  readonly scheduler: DreamingScheduler;

  private readonly config: ContextEngineConfig["dreaming"];
  private readonly now: () => string;
  private readonly workerId: string;
  private readonly worker: DreamingWorker;
  private readonly onError: (error: unknown) => void;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private started = false;
  private pumping = false;
  private pumpRequested = false;
  private pumpPromise?: Promise<void>;

  constructor(
    private readonly repository: ContextEngineRepository,
    options: DreamingRuntimeOptions = {}
  ) {
    this.config = options.config ?? getContextEngineConfig().dreaming;
    this.now = options.now ?? (() => new Date().toISOString());
    this.workerId = options.workerId ?? `dreaming-worker-${process.pid}-${randomUUID()}`;
    this.onError = options.onError ?? (() => undefined);
    this.runService = options.runService ?? new DreamingRunService(repository, {
      timezone: this.config.timezone,
      now: this.now
    });
    this.worker = options.worker ?? new DreamingWorker(repository, {
      timezone: this.config.timezone,
      candidateLeaseDurationMs: this.config.candidateLeaseMs,
      runLeaseDurationMs: this.config.runLeaseMs,
      now: this.now
    });
    this.activityGate = new ForegroundActivityGate({
      resumeIdleAfterMs: this.config.resumeIdleAfterMs,
      onBecameActive: (owner) => this.preemptForForeground(owner),
      onBecameIdle: (owner) => this.resumeAfterForeground(owner),
      onError: this.onError
    });
    this.scheduler = new DreamingScheduler(this.runService, {
      timezone: this.config.timezone,
      now: this.now,
      listOwners: () => this.listOwners(),
      onRunsCreated: () => this.kick(),
      onError: this.onError
    });
  }

  get enabled() {
    return this.config.enabled;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) return;
    await this.recoverForegroundPausedRuns();
    await this.scheduler.start();
    this.kick();
  }

  async stop() {
    this.started = false;
    this.scheduler.stop();
    this.activityGate.stop();
    for (const active of this.activeRuns.values()) {
      active.stopStatus = "queued";
      active.controller.abort();
    }
    await this.pumpPromise;
  }

  async createManualRun(owner: DreamingOwnerScope): Promise<DreamingRunCreationResult> {
    this.assertEnabled();
    const result = await this.runService.createManualRun({ ...owner, requestedAt: this.now() });
    this.kick();
    return result;
  }

  async getRun(runId: string, owner: DreamingOwnerScope) {
    const run = await this.repository.getDreamingRun(runId);
    if (!run || !sameOwner(run, owner)) return undefined;
    return {
      run,
      candidates: await this.repository.listDreamingRunCandidates(runId)
    };
  }

  async listRuns(owner: DreamingOwnerScope, statuses?: DreamingRunStatus[]) {
    return this.repository.listDreamingRuns({
      ...owner,
      ...(statuses?.length ? { statuses } : {})
    });
  }

  async pauseRun(runId: string, owner: DreamingOwnerScope) {
    this.assertEnabled();
    const run = await this.requireOwnedRun(runId, owner);
    if (isTerminalRun(run)) throw new Error(`DREAMING_RUN_NOT_PAUSABLE:${run.status}`);
    const active = this.activeRuns.get(dreamingOwnerKey(owner));
    if (active?.runId === runId) {
      active.stopStatus = "paused";
      active.pauseReason = "manual";
      await this.savePausing(run, "manual");
      active.controller.abort();
      return await this.repository.getDreamingRun(runId) ?? run;
    }
    const paused = await this.savePaused(run, "manual");
    const claimedAfterPause = this.activeRuns.get(dreamingOwnerKey(owner));
    if (claimedAfterPause?.runId === runId) {
      claimedAfterPause.stopStatus = "paused";
      claimedAfterPause.pauseReason = "manual";
      claimedAfterPause.controller.abort();
    }
    return paused;
  }

  async resumeRun(runId: string, owner: DreamingOwnerScope) {
    this.assertEnabled();
    const run = await this.requireOwnedRun(runId, owner);
    if (run.status !== "paused" && run.status !== "waiting_for_idle" && run.status !== "pausing") {
      throw new Error(`DREAMING_RUN_NOT_RESUMABLE:${run.status}`);
    }
    const resumed = clearRunLease({
      ...run,
      status: "queued",
      updatedAt: this.now()
    });
    delete resumed.pausedAt;
    delete resumed.pauseReason;
    await this.repository.saveDreamingRun(resumed);
    this.kick();
    return resumed;
  }

  async cancelRun(runId: string, owner: DreamingOwnerScope) {
    this.assertEnabled();
    const run = await this.requireOwnedRun(runId, owner);
    if (isTerminalRun(run)) throw new Error(`DREAMING_RUN_NOT_CANCELLABLE:${run.status}`);
    const active = this.activeRuns.get(dreamingOwnerKey(owner));
    if (active?.runId === runId) {
      active.stopStatus = "cancelled";
      active.controller.abort();
    }
    const cancelled = clearRunLease({
      ...run,
      status: "cancelled",
      updatedAt: this.now()
    });
    delete cancelled.pauseReason;
    await this.repository.saveDreamingRun(cancelled);
    const claimedAfterCancel = this.activeRuns.get(dreamingOwnerKey(owner));
    if (claimedAfterCancel?.runId === runId) {
      claimedAfterCancel.stopStatus = "cancelled";
      claimedAfterCancel.controller.abort();
    }
    this.kick();
    return cancelled;
  }

  async waitForIdle() {
    await this.pumpPromise;
  }

  kick() {
    if (!this.started || !this.enabled) return;
    this.pumpRequested = true;
    if (this.pumping) return;
    this.pumpPromise = Promise.resolve().then(() => this.pump()).catch(this.onError);
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.started && this.enabled && this.pumpRequested) {
        this.pumpRequested = false;
        const excludedOwners = new Set<string>();
        let next = this.nextRunnableRun(excludedOwners);
        while (next && this.started) {
          if (this.activityGate.isActive(next)) {
            excludedOwners.add(dreamingOwnerKey(next));
            next = this.nextRunnableRun(excludedOwners);
            continue;
          }
          await this.processRun(next);
          next = this.nextRunnableRun(excludedOwners);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private nextRunnableRun(excludedOwners = new Set<string>()): (DreamingRun & DreamingOwnerScope) | undefined {
    const now = this.now();
    return this.repository.getDebugSnapshot().dreamingRuns
      .filter((run) => !excludedOwners.has(dreamingOwnerKey(run)))
      .filter((run) => run.status === "queued" || (
        run.status === "running" && Boolean(run.leaseExpiresAt && run.leaseExpiresAt <= now)
      ))
      .sort((left, right) =>
        left.candidateCutoffAt.localeCompare(right.candidateCutoffAt) || left.runId.localeCompare(right.runId)
      )[0];
  }

  private async processRun(run: DreamingRun) {
    const owner = { tenantId: run.tenantId, principalId: run.principalId };
    const key = dreamingOwnerKey(owner);
    const active: ActiveRun = {
      runId: run.runId,
      owner,
      controller: new AbortController()
    };
    this.activeRuns.set(key, active);
    try {
      await this.worker.processRun(run.runId, {
        ...owner,
        workerId: this.workerId,
        signal: active.controller.signal
      });
    } catch (error) {
      const current = await this.repository.getDreamingRun(run.runId);
      if (current && !active.controller.signal.aborted) {
        await this.repository.saveDreamingRun(clearRunLease({
          ...current,
          status: "failed",
          lastError: errorMessage(error),
          updatedAt: this.now()
        }));
      }
      this.onError(error);
    } finally {
      this.activeRuns.delete(key);
      await this.finalizeStop(active);
    }
  }

  private async preemptForForeground(_owner: DreamingOwnerScope) {
    if (!this.enabled) return;
    for (const active of this.activeRuns.values()) {
      const run = await this.repository.getDreamingRun(active.runId);
      if (!run || isTerminalRun(run)) continue;
      active.stopStatus = "paused";
      active.pauseReason = "foreground_activity";
      const preemptTimer = setTimeout(() => active.controller.abort(), this.config.preemptWithinMs);
      preemptTimer.unref?.();
      try {
        await this.savePausing(run, "foreground_activity");
      } finally {
        clearTimeout(preemptTimer);
        active.controller.abort();
      }
    }
  }

  private async resumeAfterForeground(_owner: DreamingOwnerScope) {
    if (!this.enabled) return;
    const runs = await this.repository.listDreamingRuns({
      statuses: ["paused", "pausing", "waiting_for_idle"]
    });
    for (const run of runs) {
      if (run.pauseReason !== "foreground_activity") continue;
      const resumed = clearRunLease({ ...run, status: "queued", updatedAt: this.now() });
      delete resumed.pausedAt;
      delete resumed.pauseReason;
      await this.repository.saveDreamingRun(resumed);
    }
    this.kick();
  }

  private async recoverForegroundPausedRuns() {
    const runs = await this.repository.listDreamingRuns({ statuses: ["paused", "pausing", "waiting_for_idle"] });
    for (const run of runs) {
      if (run.pauseReason !== "foreground_activity") continue;
      const resumed = clearRunLease({ ...run, status: "queued", updatedAt: this.now() });
      delete resumed.pausedAt;
      delete resumed.pauseReason;
      await this.repository.saveDreamingRun(resumed);
    }
  }

  private async finalizeStop(active: ActiveRun) {
    if (!active.stopStatus) return;
    const run = await this.repository.getDreamingRun(active.runId);
    if (!run || run.status === "completed") return;
    if (active.stopStatus === "paused") {
      await this.savePaused(run, active.pauseReason ?? "manual");
      return;
    }
    const next = clearRunLease({
      ...run,
      status: active.stopStatus,
      updatedAt: this.now()
    });
    delete next.pauseReason;
    await this.repository.saveDreamingRun(next);
  }

  private async savePausing(run: DreamingRun, pauseReason: NonNullable<DreamingRun["pauseReason"]>) {
    const pausing = {
      ...run,
      status: "pausing" as const,
      pauseReason,
      updatedAt: this.now()
    };
    await this.repository.saveDreamingRun(pausing);
    return pausing;
  }

  private async savePaused(run: DreamingRun, pauseReason: NonNullable<DreamingRun["pauseReason"]>) {
    const paused = clearRunLease({
      ...run,
      status: "paused" as const,
      pausedAt: this.now(),
      pauseReason,
      updatedAt: this.now()
    });
    await this.repository.saveDreamingRun(paused);
    return paused;
  }

  private listOwners() {
    const snapshot = this.repository.getDebugSnapshot();
    const owners = new Map<string, DreamingOwnerScope>();
    for (const item of [...snapshot.shortTermMemories, ...snapshot.dreamingRuns]) {
      const owner = { tenantId: item.tenantId, principalId: item.principalId };
      owners.set(dreamingOwnerKey(owner), owner);
    }
    return [...owners.values()];
  }

  private async requireOwnedRun(runId: string, owner: DreamingOwnerScope) {
    const run = await this.repository.getDreamingRun(runId);
    if (!run || !sameOwner(run, owner)) throw new Error("DREAMING_RUN_NOT_FOUND");
    return run;
  }

  private assertEnabled() {
    if (!this.enabled) throw new DreamingRuntimeDisabledError();
  }
}

function clearRunLease<T extends DreamingRun>(run: T): T {
  const cleared = { ...run };
  delete cleared.leaseOwner;
  delete cleared.leaseExpiresAt;
  return cleared;
}

function sameOwner(run: DreamingRun, owner: DreamingOwnerScope) {
  return run.tenantId === owner.tenantId && run.principalId === owner.principalId;
}

function isTerminalRun(run: DreamingRun) {
  return run.status === "completed" || run.status === "cancelled" || run.status === "failed";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
