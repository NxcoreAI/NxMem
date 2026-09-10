import { createHash } from "node:crypto";
import { getContextEngineConfig } from "../../config.js";
import {
  DREAMING_SCORING_PROMPT_VERSION
} from "./dreaming-score-prompt.js";
import type {
  DreamingRun,
  DreamingRunCandidate,
  DreamingRunCandidateSourceType,
  ShortTermMemory
} from "./domain.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const INITIAL_DREAMING_WINDOW_START = "1970-01-01T00:00:00.000Z";
const DEFAULT_POLICY_VERSION = "dreaming-stm-score.v2";
const ownerLocks = new Map<string, Promise<void>>();

export interface DreamingRunServiceOptions {
  timezone?: string;
  policyVersion?: string;
  promptVersion?: string;
  model?: string;
  now?: () => string;
}

export interface CreateScheduledDreamingRunRequest {
  tenantId: string;
  principalId: string;
  scheduledAt?: string;
}

export interface CreateManualDreamingRunRequest {
  tenantId: string;
  principalId: string;
  requestedAt?: string;
}

export interface MaterializeScheduledDreamingRunsRequest {
  tenantId: string;
  principalId: string;
  throughAt?: string;
}

export interface DreamingRunCreationResult {
  run: DreamingRun;
  candidates: DreamingRunCandidate[];
  created: boolean;
}

/** Creates durable Run/candidate snapshots without starting Dreaming work. */
export class DreamingRunService {
  private readonly timezone: string;
  private readonly policyVersion: string;
  private readonly promptVersion: string;
  private readonly model: string;
  private readonly now: () => string;

  constructor(
    private readonly repository: ContextEngineRepository,
    options: DreamingRunServiceOptions = {}
  ) {
    this.timezone = options.timezone ?? DEFAULT_TIMEZONE;
    validateTimezone(this.timezone);
    this.policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;
    this.promptVersion = options.promptVersion ?? DREAMING_SCORING_PROMPT_VERSION;
    this.model = options.model ?? getContextEngineConfig().llm.model;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createScheduledRun(request: CreateScheduledDreamingRunRequest): Promise<DreamingRunCreationResult> {
    const scheduledAt = normalizeInstant(request.scheduledAt ?? this.now(), "scheduledAt");
    const localDate = localDateAt(scheduledAt, this.timezone);
    const cutoffAt = localDateTimeAtUtc(localDate, 23, 0, this.timezone);
    return this.withOwnerLock(request.tenantId, request.principalId, () =>
      this.repository.withDreamingTransaction(() => this.createRun({
        tenantId: request.tenantId,
        principalId: request.principalId,
        triggerType: "scheduled",
        requestedAt: scheduledAt,
        candidateCutoffAt: cutoffAt,
        scheduleKey: `${localDate}T23:00:00${timezoneOffsetSuffix(this.timezone, cutoffAt)}`
      }))
    );
  }

  async createManualRun(request: CreateManualDreamingRunRequest): Promise<DreamingRunCreationResult> {
    const requestedAt = normalizeInstant(request.requestedAt ?? this.now(), "requestedAt");
    return this.withOwnerLock(request.tenantId, request.principalId, () =>
      this.repository.withDreamingTransaction(async () => {
        await this.materializeScheduledRunsUnlocked({
          tenantId: request.tenantId,
          principalId: request.principalId,
          throughAt: requestedAt
        });
        return this.createRun({
          tenantId: request.tenantId,
          principalId: request.principalId,
          triggerType: "manual",
          requestedAt,
          candidateCutoffAt: requestedAt
        });
      })
    );
  }

  async materializeScheduledRuns(
    request: MaterializeScheduledDreamingRunsRequest
  ): Promise<DreamingRunCreationResult[]> {
    const throughAt = normalizeInstant(request.throughAt ?? this.now(), "throughAt");
    return this.withOwnerLock(request.tenantId, request.principalId, () =>
      this.repository.withDreamingTransaction(() => this.materializeScheduledRunsUnlocked({
        tenantId: request.tenantId,
        principalId: request.principalId,
        throughAt
      }))
    );
  }

  private async createRun(input: {
    tenantId: string;
    principalId: string;
    triggerType: DreamingRun["triggerType"];
    requestedAt: string;
    candidateCutoffAt: string;
    scheduleKey?: string;
  }): Promise<DreamingRunCreationResult> {
    const ownerRuns = await this.repository.listDreamingRuns({
      tenantId: input.tenantId,
      principalId: input.principalId
    });
    const runId = createRunId(input);
    const existing = ownerRuns.find((run) => run.runId === runId || (
      input.triggerType === "scheduled" &&
      run.triggerType === "scheduled" &&
      run.scheduleKey === input.scheduleKey
    ));
    if (existing) {
      return {
        run: existing,
        candidates: await this.repository.listDreamingRunCandidates(existing.runId),
        created: false
      };
    }

    const latestRun = ownerRuns
      .filter((run) => run.candidateCutoffAt <= input.candidateCutoffAt)
      .sort(compareRunCutoffs)
      .at(-1);
    const futureRun = ownerRuns.find((run) => run.candidateCutoffAt > input.candidateCutoffAt);
    if (futureRun) {
      throw new Error(`DREAMING_RUN_CUTOFF_NOT_MONOTONIC:${futureRun.runId}`);
    }

    const windowStart = latestRun?.candidateCutoffAt ?? INITIAL_DREAMING_WINDOW_START;
    const assignedMemoryIds = await this.findAssignedMemoryIds(ownerRuns);
    const carryoverMemoryIds = await this.findCarryoverMemoryIds(ownerRuns, assignedMemoryIds);
    const [newMemories, dueMemories, carryoverMemories] = await Promise.all([
      this.repository.listDreamingShortTermMemoriesInWindow({
        tenantId: input.tenantId,
        principalId: input.principalId,
        windowStart,
        cutoffAt: input.candidateCutoffAt,
        policyVersion: this.policyVersion
      }),
      this.repository.listDueDreamingShortTermMemories({
        tenantId: input.tenantId,
        principalId: input.principalId,
        cutoffAt: input.candidateCutoffAt,
        policyVersion: this.policyVersion
      }),
      this.repository.getShortTermMemoriesByIds([...carryoverMemoryIds])
    ]);
    const candidates = buildCandidates({
      runId,
      requestedAt: input.requestedAt,
      policyVersion: this.policyVersion,
      assignedMemoryIds,
      newMemories,
      dueMemories,
      carryoverMemories
    });

    const run: DreamingRun = {
      runId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      triggerType: input.triggerType,
      ...(input.scheduleKey ? { scheduleKey: input.scheduleKey } : {}),
      status: "queued",
      requestedAt: input.requestedAt,
      candidateWindowStartAt: windowStart,
      candidateCutoffAt: input.candidateCutoffAt,
      policyVersion: this.policyVersion,
      promptVersion: this.promptVersion,
      model: this.model,
      candidateCount: candidates.length,
      processedCount: 0,
      consolidatedCount: 0,
      observingCount: 0,
      droppedCount: 0,
      retryWaitCount: 0,
      skippedCount: 0,
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt
    };
    await this.repository.saveDreamingRun(run);
    for (const candidate of candidates) {
      await this.repository.saveDreamingRunCandidate(candidate);
    }
    return { run, candidates, created: true };
  }

  private async materializeScheduledRunsUnlocked(input: {
    tenantId: string;
    principalId: string;
    throughAt: string;
  }) {
    const latestEligibleCutoff = latestScheduledCutoffAt(input.throughAt, this.timezone);
    const ownerRuns = await this.repository.listDreamingRuns({
      tenantId: input.tenantId,
      principalId: input.principalId
    });
    const latestRun = ownerRuns.sort(compareRunCutoffs).at(-1);
    const cutoffs = latestRun
      ? scheduledCutoffsAfter(latestRun.candidateCutoffAt, latestEligibleCutoff, this.timezone)
      : [latestEligibleCutoff];
    const results: DreamingRunCreationResult[] = [];
    for (const cutoffAt of cutoffs) {
      const localDate = localDateAt(cutoffAt, this.timezone);
      results.push(await this.createRun({
        tenantId: input.tenantId,
        principalId: input.principalId,
        triggerType: "scheduled",
        requestedAt: cutoffAt,
        candidateCutoffAt: cutoffAt,
        scheduleKey: `${localDate}T23:00:00${timezoneOffsetSuffix(this.timezone, cutoffAt)}`
      }));
    }
    return results;
  }

  private async findAssignedMemoryIds(runs: DreamingRun[]) {
    const activeRunStatuses = new Set<DreamingRun["status"]>([
      "queued",
      "waiting_for_idle",
      "running",
      "pausing",
      "paused"
    ]);
    const assigned = new Set<string>();
    for (const run of runs) {
      if (!activeRunStatuses.has(run.status)) continue;
      const candidates = await this.repository.listDreamingRunCandidates(run.runId);
      for (const candidate of candidates) {
        if (candidate.status === "pending" || candidate.status === "processing") {
          assigned.add(candidate.memoryDataId);
        }
      }
    }
    return assigned;
  }

  private async findCarryoverMemoryIds(runs: DreamingRun[], assignedMemoryIds: Set<string>) {
    const carryover = new Set<string>();
    for (const run of runs) {
      if (run.status !== "cancelled" && run.status !== "failed") continue;
      const candidates = await this.repository.listDreamingRunCandidates(run.runId);
      for (const candidate of candidates) {
        if ((candidate.status === "pending" || candidate.status === "processing") && !assignedMemoryIds.has(candidate.memoryDataId)) {
          carryover.add(candidate.memoryDataId);
        }
      }
    }
    return carryover;
  }

  private async withOwnerLock<T>(tenantId: string, principalId: string, callback: () => Promise<T>) {
    const key = `${tenantId}:${principalId}`;
    const previous = ownerLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    ownerLocks.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (ownerLocks.get(key) === current) ownerLocks.delete(key);
    }
  }
}

export function localDateAt(instant: string, timezone = DEFAULT_TIMEZONE) {
  validateTimezone(timezone);
  const parts = zonedParts(normalizeInstant(instant, "instant"), timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localDateTimeAtUtc(localDate: string, hour: number, minute: number, timezone = DEFAULT_TIMEZONE) {
  validateTimezone(timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(localDate) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`INVALID_LOCAL_DATE_TIME:${localDate}`);
  }
  const [yearText, monthText, dayText] = localDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const nominalUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const nominalParts = zonedParts(new Date(nominalUtcMs).toISOString(), timezone);
  const nominalAsUtcMs = Date.UTC(
    Number(nominalParts.year),
    Number(nominalParts.month) - 1,
    Number(nominalParts.day),
    Number(nominalParts.hour),
    Number(nominalParts.minute),
    Number(nominalParts.second),
    0
  );
  const offsetMs = nominalAsUtcMs - nominalUtcMs;
  return new Date(nominalUtcMs - offsetMs).toISOString();
}

export function latestScheduledCutoffAt(instant: string, timezone = DEFAULT_TIMEZONE) {
  const normalized = normalizeInstant(instant, "instant");
  const localDate = localDateAt(normalized, timezone);
  const sameDayCutoff = localDateTimeAtUtc(localDate, 23, 0, timezone);
  return sameDayCutoff <= normalized
    ? sameDayCutoff
    : localDateTimeAtUtc(addLocalDays(localDate, -1), 23, 0, timezone);
}

export function nextScheduledCutoffAt(instant: string, timezone = DEFAULT_TIMEZONE) {
  const normalized = normalizeInstant(instant, "instant");
  const localDate = localDateAt(normalized, timezone);
  const sameDayCutoff = localDateTimeAtUtc(localDate, 23, 0, timezone);
  return sameDayCutoff > normalized
    ? sameDayCutoff
    : localDateTimeAtUtc(addLocalDays(localDate, 1), 23, 0, timezone);
}

function scheduledCutoffsAfter(startExclusive: string, endInclusive: string, timezone: string) {
  const cutoffs: string[] = [];
  let cutoff = nextScheduledCutoffAt(startExclusive, timezone);
  while (cutoff <= endInclusive) {
    cutoffs.push(cutoff);
    cutoff = localDateTimeAtUtc(addLocalDays(localDateAt(cutoff, timezone), 1), 23, 0, timezone);
  }
  return cutoffs;
}

function addLocalDays(localDate: string, days: number) {
  const [yearText, monthText, dayText] = localDate.split("-");
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + days));
  return date.toISOString().slice(0, 10);
}

function buildCandidates(input: {
  runId: string;
  requestedAt: string;
  policyVersion: string;
  assignedMemoryIds: Set<string>;
  newMemories: ShortTermMemory[];
  dueMemories: ShortTermMemory[];
  carryoverMemories: ShortTermMemory[];
}) {
  const selected = new Map<string, { memory: ShortTermMemory; sourceType: DreamingRunCandidateSourceType }>();
  for (const memory of input.carryoverMemories) {
    if (input.assignedMemoryIds.has(memory.memoryDataId)) continue;
    selected.set(memory.memoryDataId, { memory, sourceType: "carryover" });
  }
  for (const memory of input.dueMemories) {
    if (input.assignedMemoryIds.has(memory.memoryDataId) || selected.has(memory.memoryDataId)) continue;
    selected.set(memory.memoryDataId, {
      memory,
      sourceType: memory.consolidationStatus === "observing" ? "observing_due" : "retry_due"
    });
  }
  for (const memory of input.newMemories) {
    if (input.assignedMemoryIds.has(memory.memoryDataId) || selected.has(memory.memoryDataId)) continue;
    selected.set(memory.memoryDataId, { memory, sourceType: "new" });
  }
  return [...selected.values()]
    .sort((left, right) => left.memory.createdAt.localeCompare(right.memory.createdAt) || left.memory.memoryDataId.localeCompare(right.memory.memoryDataId))
    .map(({ memory, sourceType }) => {
      const candidateFingerprint = createCandidateFingerprint(memory, input.policyVersion);
      return {
        runCandidateId: `dreaming_candidate_${hashStable(`${input.runId}|${memory.memoryDataId}|${candidateFingerprint}`).slice(0, 24)}`,
        runId: input.runId,
        memoryDataId: memory.memoryDataId,
        stmVersion: memory.updatedAt,
        candidateFingerprint,
        sourceType,
        status: "pending",
        cycleAttemptCount: sourceType === "carryover" ? memory.cycleAttemptCount ?? 0 : 0,
        totalAttemptCount: memory.totalAttemptCount ?? 0,
        createdAt: input.requestedAt,
        updatedAt: input.requestedAt
      } satisfies DreamingRunCandidate;
    });
}

function createCandidateFingerprint(memory: ShortTermMemory, policyVersion: string) {
  return hashStable(`${memory.memoryDataId}|${memory.updatedAt}|${policyVersion}`);
}

function createRunId(input: {
  tenantId: string;
  principalId: string;
  triggerType: DreamingRun["triggerType"];
  candidateCutoffAt: string;
}) {
  return `dreaming_run_${hashStable(`${input.tenantId}|${input.principalId}|${input.triggerType}|${input.candidateCutoffAt}`).slice(0, 24)}`;
}

function hashStable(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function compareRunCutoffs(left: DreamingRun, right: DreamingRun) {
  return left.candidateCutoffAt.localeCompare(right.candidateCutoffAt) || left.runId.localeCompare(right.runId);
}

function normalizeInstant(value: string, field: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`INVALID_DREAMING_${field.toUpperCase()}`);
  return new Date(parsed).toISOString();
}

function validateTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`INVALID_DREAMING_TIMEZONE:${timezone}`);
  }
}

function zonedParts(instant: string, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return {
    year: String(parts.year),
    month: String(parts.month),
    day: String(parts.day),
    hour: String(parts.hour),
    minute: String(parts.minute),
    second: String(parts.second)
  };
}

function timezoneOffsetSuffix(timezone: string, instant: string) {
  const parts = zonedParts(instant, timezone);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((localAsUtc - Date.parse(instant)) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
