import type {
  FactItem,
  LongTermMemory,
  MemoryTemporalMetadata,
  ShortTermMemory,
  StructuredMemoryFact,
  TemporalConfidence
} from "./domain.js";

export type NormalizedMemoryTemporalMetadata = Required<Pick<
  MemoryTemporalMetadata,
  "evidenceTimeConfidence" | "validTimeConfidence"
>> & Omit<MemoryTemporalMetadata, "evidenceTimeConfidence" | "validTimeConfidence">;

export interface MemoryTemporalRange {
  startTime: string;
  endTime: string;
  basis: "evidence" | "valid";
}

const confidenceRank: Record<TemporalConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3
};

export function temporalMetadataFromFact(fact: FactItem): NormalizedMemoryTemporalMetadata {
  const hasSingleEvidenceTime = Boolean(fact.evidenceTime);
  const hasSingleValidTime = Boolean(fact.validTime);
  return normalizeMemoryTemporalMetadata({
    ...(fact.evidenceTime ? { evidenceTime: fact.evidenceTime } : {}),
    ...(!hasSingleEvidenceTime && fact.evidenceTimeStart ? { evidenceTimeStart: fact.evidenceTimeStart } : {}),
    ...(!hasSingleEvidenceTime && fact.evidenceTimeEnd ? { evidenceTimeEnd: fact.evidenceTimeEnd } : {}),
    evidenceTimeConfidence: fact.evidenceTimeConfidence ?? "low",
    ...(fact.validTime ? { validTime: fact.validTime } : {}),
    ...(fact.events?.length ? { events: normalizeTemporalEvents(fact.events) } : {}),
    ...(!hasSingleValidTime && fact.validTimeStart ? { validTimeStart: fact.validTimeStart } : {}),
    ...(!hasSingleValidTime && fact.validTimeEnd ? { validTimeEnd: fact.validTimeEnd } : {}),
    validTimeConfidence: fact.validTimeConfidence ?? fact.timeConfidence ?? "low"
  });
}

export function aggregateMemoryTemporalMetadata(
  sources: readonly MemoryTemporalMetadata[]
): NormalizedMemoryTemporalMetadata {
  const evidenceSources = sources
    .map(normalizeMemoryTemporalMetadata)
    .filter((source) => source.evidenceTime || source.evidenceTimeStart);
  const validSources = sources
    .map(normalizeMemoryTemporalMetadata)
    .filter((source) => source.validTime || source.validTimeStart);

  return {
    ...aggregateAxis(evidenceSources, "evidence"),
    ...aggregateAxis(validSources, "valid"),
    ...aggregateTemporalEvents(sources)
  } as NormalizedMemoryTemporalMetadata;
}

export function normalizeMemoryTemporalMetadata(
  metadata: MemoryTemporalMetadata
): NormalizedMemoryTemporalMetadata {
  const evidenceTime = validTimestamp(metadata.evidenceTime);
  const validTime = validTimestamp(metadata.validTime);
  const evidence = normalizeAxis(
    metadata.evidenceTimeStart,
    metadata.evidenceTimeEnd,
    metadata.evidenceTimeConfidence
  );
  const valid = normalizeAxis(
    metadata.validTimeStart,
    metadata.validTimeEnd,
    metadata.validTimeConfidence
  );
  return {
    ...(evidenceTime ? { evidenceTime } : {}),
    ...(evidence.start ? { evidenceTimeStart: evidence.start } : {}),
    ...(evidence.end ? { evidenceTimeEnd: evidence.end } : {}),
    evidenceTimeConfidence: evidenceTime ? metadata.evidenceTimeConfidence ?? "low" : evidence.confidence,
    ...(validTime ? { validTime } : {}),
    ...(metadata.events?.length ? { events: normalizeTemporalEvents(metadata.events) } : {}),
    ...(valid.start ? { validTimeStart: valid.start } : {}),
    ...(valid.end ? { validTimeEnd: valid.end } : {}),
    validTimeConfidence: validTime ? metadata.validTimeConfidence ?? "low" : valid.confidence
  };
}

function aggregateTemporalEvents(sources: readonly MemoryTemporalMetadata[]) {
  const events = normalizeTemporalEvents(sources.flatMap((source) => source.events ?? []));
  return events.length ? { events } : {};
}

function normalizeTemporalEvents(events: NonNullable<MemoryTemporalMetadata["events"]>) {
  const byIdentity = new Map<string, NonNullable<MemoryTemporalMetadata["events"]>[number]>();
  for (const event of events) {
    const validTime = validTimestamp(event.validTime);
    if (!event.eventKey.trim() || !event.label.trim() || !validTime) continue;
    const evidenceTime = validTimestamp(event.evidenceTime);
    const normalized = {
      eventKey: event.eventKey.trim(),
      label: event.label.trim(),
      validTime,
      ...(evidenceTime ? { evidenceTime } : {}),
      ...(event.sourceFactIds?.length ? { sourceFactIds: [...new Set(event.sourceFactIds.filter(Boolean))] } : {})
    };
    byIdentity.set(`${normalized.eventKey}\u0000${normalized.validTime}`, normalized);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.validTime.localeCompare(right.validTime) || left.eventKey.localeCompare(right.eventKey)
  );
}

export function memoryTemporalEnvelopeIntersects(
  memory: MemoryTemporalMetadata,
  range: MemoryTemporalRange
) {
  assertTemporalRange(range);
  return temporalAxisIntersects(memory, range);
}

export function memoryMatchesTemporalRange(
  memory: Pick<ShortTermMemory | LongTermMemory, keyof MemoryTemporalMetadata | "structuredFacts">,
  range: MemoryTemporalRange
) {
  if (!memoryTemporalEnvelopeIntersects(memory, range)) return false;
  const structuredFacts = memory.structuredFacts?.facts ?? [];
  const factsWithAxis = structuredFacts.filter((fact) => temporalAxisStart(fact, range.basis));
  if (!factsWithAxis.length) return true;
  return factsWithAxis.some((fact) => temporalAxisIntersects(fact, range));
}

export function copyTemporalMetadata<T extends StructuredMemoryFact>(
  target: T,
  source: MemoryTemporalMetadata
): T {
  const normalized = normalizeMemoryTemporalMetadata(source);
  return {
    ...target,
    ...normalized
  };
}

function aggregateAxis(
  sources: NormalizedMemoryTemporalMetadata[],
  basis: MemoryTemporalRange["basis"]
) {
  const singleValues = uniqueTimestamps(sources
    .map((source) => basis === "evidence" ? source.evidenceTime : source.validTime)
    .filter((value): value is string => Boolean(value)));
  const rangeSources = sources.filter((source) =>
    basis === "evidence" ? !source.evidenceTime : !source.validTime
  );
  const starts = rangeSources
    .map((source) => temporalAxisStart(source, basis))
    .filter((value): value is string => Boolean(value));
  const confidence = weakestTemporalConfidence(sources.map((source) =>
    basis === "evidence" ? source.evidenceTimeConfidence : source.validTimeConfidence
  ));
  const single = singleValues.length === 1 ? singleValues[0] : undefined;
  if (!starts.length) {
    return basis === "evidence"
      ? { ...(single ? { evidenceTime: single } : {}), evidenceTimeConfidence: confidence }
      : { ...(single ? { validTime: single } : {}), validTimeConfidence: confidence };
  }

  const ends = rangeSources.map((source) => temporalAxisEnd(source, basis) ?? temporalAxisStart(source, basis)!);
  const start = earliestTimestamp(starts);
  const end = latestTimestamp(ends);
  return basis === "evidence"
    ? {
      ...(single ? { evidenceTime: single } : {}),
      evidenceTimeStart: start,
      evidenceTimeEnd: end,
      evidenceTimeConfidence: confidence
    }
    : {
      ...(single ? { validTime: single } : {}),
      validTimeStart: start,
      validTimeEnd: end,
      validTimeConfidence: confidence
    };
}

function normalizeAxis(
  start: string | undefined,
  end: string | undefined,
  confidence: TemporalConfidence | undefined
) {
  const normalizedStart = validTimestamp(start);
  const normalizedEnd = validTimestamp(end);
  if (normalizedEnd && !normalizedStart) {
    throw new Error("MEMORY_TEMPORAL_END_WITHOUT_START");
  }
  if (normalizedStart && normalizedEnd && Date.parse(normalizedEnd) < Date.parse(normalizedStart)) {
    throw new Error("MEMORY_TEMPORAL_END_BEFORE_START");
  }
  return {
    ...(normalizedStart ? { start: normalizedStart } : {}),
    ...(normalizedEnd ? { end: normalizedEnd } : {}),
    confidence: normalizedStart ? confidence ?? "low" : "low"
  };
}

function temporalAxisIntersects(metadata: MemoryTemporalMetadata, range: MemoryTemporalRange) {
  const start = temporalAxisStart(metadata, range.basis);
  if (!start) return false;
  const end = temporalAxisEnd(metadata, range.basis);
  const queryStart = Date.parse(range.startTime);
  const queryEnd = Date.parse(range.endTime);
  const valueStart = Date.parse(start);
  if (!end || end === start) return valueStart >= queryStart && valueStart < queryEnd;
  return valueStart < queryEnd && Date.parse(end) > queryStart;
}

function temporalAxisStart(metadata: MemoryTemporalMetadata, basis: MemoryTemporalRange["basis"]) {
  return basis === "evidence"
    ? metadata.evidenceTime ?? metadata.evidenceTimeStart
    : metadata.validTime ?? metadata.validTimeStart;
}

function temporalAxisEnd(metadata: MemoryTemporalMetadata, basis: MemoryTemporalRange["basis"]) {
  return basis === "evidence"
    ? metadata.evidenceTime ?? metadata.evidenceTimeEnd
    : metadata.validTime ?? metadata.validTimeEnd;
}

function uniqueTimestamps(values: string[]) {
  return [...new Set(values)];
}

function weakestTemporalConfidence(values: TemporalConfidence[]) {
  return [...values].sort((left, right) => confidenceRank[left] - confidenceRank[right])[0] ?? "low";
}

function earliestTimestamp(values: string[]) {
  return [...values].sort((left, right) => Date.parse(left) - Date.parse(right))[0]!;
}

function latestTimestamp(values: string[]) {
  return [...values].sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
}

function validTimestamp(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function assertTemporalRange(range: MemoryTemporalRange) {
  const start = Date.parse(range.startTime);
  const end = Date.parse(range.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("MEMORY_TEMPORAL_QUERY_RANGE_INVALID");
  }
}
