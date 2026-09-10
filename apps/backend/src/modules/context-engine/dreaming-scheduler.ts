import {
  DreamingRunService,
  nextScheduledCutoffAt,
  type DreamingRunCreationResult
} from "./dreaming-run-service.js";
import type { DreamingOwnerScope } from "./foreground-activity-gate.js";

export interface DreamingSchedulerOptions {
  timezone?: string;
  now?: () => string;
  listOwners: () => DreamingOwnerScope[] | Promise<DreamingOwnerScope[]>;
  onRunsCreated?: (owner: DreamingOwnerScope, runs: DreamingRunCreationResult[]) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

/** Materializes missed and future 23:00 Run snapshots; it never evaluates STM itself. */
export class DreamingScheduler {
  private readonly timezone: string;
  private readonly now: () => string;
  private readonly listOwners: DreamingSchedulerOptions["listOwners"];
  private readonly onRunsCreated?: DreamingSchedulerOptions["onRunsCreated"];
  private readonly onError: (error: unknown) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(
    private readonly runService: DreamingRunService,
    options: DreamingSchedulerOptions
  ) {
    this.timezone = options.timezone ?? "Asia/Shanghai";
    this.now = options.now ?? (() => new Date().toISOString());
    this.listOwners = options.listOwners;
    this.onRunsCreated = options.onRunsCreated;
    this.onError = options.onError ?? (() => undefined);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.tick(this.now());
    this.scheduleNextTick();
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    delete this.timer;
  }

  async tick(throughAt = this.now()) {
    const owners = deduplicateOwners(await this.listOwners());
    const created: DreamingRunCreationResult[] = [];
    for (const owner of owners) {
      const results = await this.runService.materializeScheduledRuns({ ...owner, throughAt });
      created.push(...results.filter((result) => result.created));
      if (results.some((result) => result.created)) await this.onRunsCreated?.(owner, results);
    }
    return created;
  }

  private scheduleNextTick() {
    if (!this.started) return;
    const now = this.now();
    const next = nextScheduledCutoffAt(now, this.timezone);
    const delayMs = Math.max(0, Date.parse(next) - Date.parse(now));
    this.timer = setTimeout(() => {
      void this.tick(this.now())
        .catch(this.onError)
        .finally(() => this.scheduleNextTick());
    }, delayMs);
    this.timer.unref?.();
  }
}

function deduplicateOwners(owners: DreamingOwnerScope[]) {
  const unique = new Map<string, DreamingOwnerScope>();
  for (const owner of owners) {
    if (!owner.tenantId.trim() || !owner.principalId.trim()) continue;
    unique.set(`${owner.tenantId}\u0000${owner.principalId}`, owner);
  }
  return [...unique.values()].sort((left, right) =>
    left.tenantId.localeCompare(right.tenantId) || left.principalId.localeCompare(right.principalId)
  );
}
