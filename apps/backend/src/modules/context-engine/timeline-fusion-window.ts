import type {
  FactItem,
  MemoryEvent,
  TimelineFusionWindow
} from "./domain.js";

export const DEFAULT_TIMELINE_FUSION_WINDOW_MS = 2 * 60 * 60 * 1_000;
export const DEFAULT_TIMELINE_FUSION_CANDIDATE_LIMIT = 50;

export interface TimelineFusionWindowGroup {
  temporalWindow: TimelineFusionWindow;
  newFactIds: string[];
}

export interface BuildTimelineFusionWindowsOptions {
  windowMs?: number;
}

export interface TimelineFusionCandidateQuery {
  tenantId: string;
  principalId: string;
  contextScopeId?: string;
  temporalWindow: TimelineFusionWindow;
  excludeFactIds?: string[];
  limit?: number;
}

export function buildTimelineFusionWindows(
  facts: readonly FactItem[],
  events: readonly MemoryEvent[],
  options: BuildTimelineFusionWindowsOptions = {}
): TimelineFusionWindowGroup[] {
  const windowMs = nonNegativeInteger(
    options.windowMs ?? DEFAULT_TIMELINE_FUSION_WINDOW_MS,
    "windowMs"
  );
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const groups = facts.flatMap((fact) => windowsForFact(fact, eventById));
  return mergeTimelineFusionWindowGroups(groups, windowMs)
    .map((group) => ({
      ...group,
      temporalWindow: expandRange(group.temporalWindow, windowMs)
    }));
}

export function filterTimelineFusionFactCandidates(
  facts: readonly FactItem[],
  events: readonly MemoryEvent[],
  query: TimelineFusionCandidateQuery
) {
  const excludeFactIds = new Set(query.excludeFactIds ?? []);
  const limit = positiveInteger(query.limit ?? DEFAULT_TIMELINE_FUSION_CANDIDATE_LIMIT, "limit");
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  return facts
    .filter((fact) => !query.contextScopeId || fact.contextScopeId === query.contextScopeId)
    .filter((fact) => !excludeFactIds.has(fact.factId))
    .filter((fact) => fact.status === "active" || fact.status === "conflicted")
    .filter((fact) => fact.accessState !== "hidden" && fact.accessState !== "permission-invalid")
    .filter((fact) => {
      try {
        return factIntersectsTimelineFusionWindow(fact, query.temporalWindow, eventById);
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.factId.localeCompare(right.factId))
    .slice(0, limit);
}

export function factIntersectsTimelineFusionWindow(
  fact: FactItem,
  window: TimelineFusionWindow,
  eventById: ReadonlyMap<string, MemoryEvent>
) {
  const ranges = rangesForFact(fact, window.basis, eventById);
  return ranges.some((range) => rangesIntersect(range, window));
}

function windowsForFact(
  fact: FactItem,
  eventById: ReadonlyMap<string, MemoryEvent>
): TimelineFusionWindowGroup[] {
  const explicitRanges = [
    fact.validTimeStart && fact.validTimeBasis !== "source_time"
      ? rangeForAxis(fact.factId, "valid", fact.validTimeStart, fact.validTimeEnd)
      : undefined,
    fact.evidenceTimeStart
      ? rangeForAxis(fact.factId, "evidence", fact.evidenceTimeStart, fact.evidenceTimeEnd)
      : undefined
  ].filter((range): range is TimelineFusionWindow => Boolean(range));
  const ranges = explicitRanges.length
    ? explicitRanges
    : rangesForFact(fact, "weak_anchor", eventById);
  return ranges.map((range) => ({
    temporalWindow: range,
    newFactIds: [fact.factId]
  }));
}

function rangesForFact(
  fact: FactItem,
  basis: TimelineFusionWindow["basis"],
  eventById: ReadonlyMap<string, MemoryEvent>
): TimelineFusionWindow[] {
  if (basis === "valid") {
    return fact.validTimeStart && fact.validTimeBasis !== "source_time"
      ? [rangeForAxis(fact.factId, basis, fact.validTimeStart, fact.validTimeEnd)]
      : [];
  }
  if (basis === "evidence") {
    return fact.evidenceTimeStart
      ? [rangeForAxis(fact.factId, basis, fact.evidenceTimeStart, fact.evidenceTimeEnd)]
      : [];
  }
  return [...new Set(fact.linkedEventIds)]
    .map((eventId) => eventById.get(eventId))
    .filter((event): event is MemoryEvent => Boolean(event))
    .map((event) => rangeForAxis(fact.factId, basis, event.eventTime));
}

function rangeForAxis(
  factId: string,
  basis: TimelineFusionWindow["basis"],
  startValue: string,
  endValue?: string
): TimelineFusionWindow {
  const start = Date.parse(startValue);
  const end = Date.parse(endValue ?? startValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error(`timeline_fusion_fact_time_invalid:${factId}:${basis}`);
  }
  return {
    basis,
    startAt: new Date(start).toISOString(),
    endAt: new Date(Math.max(end, start + 1)).toISOString()
  };
}

function expandRange(range: TimelineFusionWindow, windowMs: number): TimelineFusionWindow {
  return {
    basis: range.basis,
    startAt: new Date(Date.parse(range.startAt) - windowMs).toISOString(),
    endAt: new Date(Date.parse(range.endAt) + windowMs).toISOString()
  };
}

function mergeTimelineFusionWindowGroups(groups: TimelineFusionWindowGroup[], windowMs: number) {
  const sorted = groups
    .map((group) => ({
      temporalWindow: group.temporalWindow,
      newFactIds: uniqueStrings(group.newFactIds)
    }))
    .sort((left, right) =>
      left.temporalWindow.basis.localeCompare(right.temporalWindow.basis) ||
      Date.parse(left.temporalWindow.startAt) - Date.parse(right.temporalWindow.startAt) ||
      Date.parse(left.temporalWindow.endAt) - Date.parse(right.temporalWindow.endAt)
    );
  const merged: TimelineFusionWindowGroup[] = [];
  for (const group of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.temporalWindow.basis === group.temporalWindow.basis &&
      Date.parse(group.temporalWindow.startAt) <= Date.parse(previous.temporalWindow.endAt) + windowMs
    ) {
      previous.temporalWindow.endAt = new Date(Math.max(
        Date.parse(previous.temporalWindow.endAt),
        Date.parse(group.temporalWindow.endAt)
      )).toISOString();
      previous.newFactIds = uniqueStrings([...previous.newFactIds, ...group.newFactIds]);
      continue;
    }
    merged.push({
      temporalWindow: { ...group.temporalWindow },
      newFactIds: [...group.newFactIds]
    });
  }
  return merged;
}

function rangesIntersect(left: TimelineFusionWindow, right: TimelineFusionWindow) {
  return Date.parse(left.startAt) < Date.parse(right.endAt) &&
    Date.parse(left.endAt) > Date.parse(right.startAt);
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`timeline_fusion_${field}_invalid`);
  }
  return value;
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`timeline_fusion_${field}_invalid`);
  }
  return value;
}
