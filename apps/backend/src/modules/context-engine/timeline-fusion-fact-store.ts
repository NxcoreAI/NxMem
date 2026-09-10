import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  FactItem,
  FactVersion,
  SourceRef,
  TimelineFusionExecution
} from "./domain.js";
import type {
  TimelineFusionRelation,
  TimelineFusionRelationInput,
  TimelineFusionRelationResult
} from "./timeline-fusion-relations.js";

export interface TimelineFusionFactStoreMutation {
  facts: FactItem[];
  versions: FactVersion[];
  resultFactIds: string[];
}

export class TimelineFusionFactStoreError extends Error {
  constructor(
    readonly code:
      | "TIMELINE_FUSION_FACT_STORE_INVALID"
      | "TIMELINE_FUSION_FACT_STORE_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "TimelineFusionFactStoreError";
  }
}

export function buildTimelineFusionFactStoreMutation(input: {
  execution: TimelineFusionExecution;
  relationInput: TimelineFusionRelationInput;
  relationResult: TimelineFusionRelationResult;
  currentFacts: readonly FactItem[];
  currentVersions: readonly FactVersion[];
  now: string;
}): TimelineFusionFactStoreMutation {
  const now = requiredInstant(input.now, "now");
  const owner = {
    tenantId: requiredText(input.execution.tenantId, "execution.tenantId"),
    principalId: requiredText(input.execution.principalId, "execution.principalId")
  };
  const factById = new Map(input.currentFacts.map((fact) => [fact.factId, fact]));
  const inputFactIds = uniqueStrings(input.relationInput.facts.map((fact) => fact.factId));
  if (inputFactIds.some((factId) => !factById.has(factId))) {
    throw invalid("Relation input references facts that are not present in the Fact Store.");
  }
  if (!sameStrings(input.execution.newFactIds, input.relationInput.newFactIds)) {
    throw invalid("Execution new facts do not match relation input new facts.");
  }
  for (const fact of factById.values()) assertFactOwner(fact, owner);

  const versions = input.currentVersions
    .map(normalizeFactVersion)
    .sort(compareFactVersions);
  const newVersions: FactVersion[] = [];
  const changedFacts = new Map<string, FactItem>();
  const resultFactIds = new Set<string>();
  const newFactIdSet = new Set(input.relationInput.newFactIds);

  const allVersions = () => [...versions, ...newVersions];
  const effectiveFact = (factId: string) => changedFacts.get(factId) ?? factById.get(factId)!;
  const ensureInitialVersion = (factId: string) => {
    const fact = effectiveFact(factId);
    const existing = latestVersion(allVersions(), factId);
    if (existing) return existing;
    const sourceFingerprint = factVersionSourceFingerprint({
      tenantId: owner.tenantId,
      principalId: owner.principalId,
      operation: "created",
      sourceFactIds: [factId]
    });
    const initial = factVersionFromFact({
      fact,
      owner,
      version: Math.max(1, fact.version),
      sourceFactIds: [factId],
      updateReason: "created",
      conflictRefs: [],
      sourceFingerprint,
      createdAt: now
    });
    newVersions.push(initial);
    return initial;
  };
  const appendVersion = (fact: FactItem, relation: TimelineFusionRelation, conflictRefs: string[] = []) => {
    const previous = ensureInitialVersion(fact.factId);
    const sourceFingerprint = factVersionSourceFingerprint({
      tenantId: owner.tenantId,
      principalId: owner.principalId,
      executionFingerprint: input.execution.fingerprint,
      operation: `${relation.type}:${relation.reasonCode}`,
      sourceFactIds: relation.sourceFactIds,
      targetFactId: fact.factId
    });
    const existing = allVersions().find((version) => version.sourceFingerprint === sourceFingerprint);
    if (existing) return existing;
    const version = factVersionFromFact({
      fact,
      owner,
      version: previous.version + 1,
      previousVersionId: previous.factVersionId,
      sourceFactIds: relation.sourceFactIds,
      updateReason: `${relation.type}:${relation.reasonCode}`,
      conflictRefs,
      sourceFingerprint,
      createdAt: now
    });
    newVersions.push(version);
    return version;
  };

  for (const factId of input.relationInput.newFactIds) ensureInitialVersion(factId);

  for (const relation of input.relationResult.relations) {
    const sourceFacts = relation.sourceFactIds.map((factId) => effectiveFact(factId));
    if (sourceFacts.some((fact) => !fact)) throw invalid("Relation references a missing source fact.");
    const newSourceFacts = sourceFacts.filter((fact) => newFactIdSet.has(fact.factId));
    const historicalFacts = sourceFacts
      .filter((fact) => !newFactIdSet.has(fact.factId))
      .sort((left, right) => left.factId.localeCompare(right.factId));

    if (relation.type === "unrelated" || relation.type === "needs_review") {
      for (const fact of newSourceFacts) resultFactIds.add(fact.factId);
      continue;
    }

    if (relation.type === "conflicts") {
      for (const fact of sourceFacts) {
        const conflictRefs = relation.sourceFactIds.filter((factId) => factId !== fact.factId);
        const conflicted: FactItem = {
          ...fact,
          tenantId: owner.tenantId,
          principalId: owner.principalId,
          status: "conflicted",
          version: ensureInitialVersion(fact.factId).version + 1,
          observedAt: now
        };
        appendVersion(conflicted, relation, conflictRefs);
        changedFacts.set(conflicted.factId, conflicted);
        resultFactIds.add(conflicted.factId);
      }
      continue;
    }

    const target = historicalFacts[0] ?? sourceFacts[0]!;
    if (relation.type === "supports") {
      const supported = mergeFactSources(target, sourceFacts, owner, now, {
        factText: target.factText,
        normalizedClaim: target.normalizedClaim,
        confidenceLevel: maxConfidence(sourceFacts.map((fact) => fact.confidenceLevel)),
        version: ensureInitialVersion(target.factId).version + 1
      });
      appendVersion(supported, relation);
      changedFacts.set(supported.factId, supported);
      resultFactIds.add(supported.factId);
      continue;
    }

    if (!relation.factText || !relation.normalizedClaim) {
      throw invalid(`Relation ${relation.type} is missing materialized text.`);
    }
    const materializedTarget = historicalFacts[0]
      ? target
      : derivedFactTarget(sourceFacts, relation, owner, now);
    const previous = historicalFacts[0]
      ? ensureInitialVersion(materializedTarget.factId)
      : latestVersion(allVersions(), materializedTarget.factId);
    const materialized = mergeFactSources(materializedTarget, sourceFacts, owner, now, {
      factText: relation.factText,
      normalizedClaim: relation.normalizedClaim,
      confidenceLevel: relation.confidenceLevel,
      version: previous ? previous.version + 1 : 1,
      ...(relation.type === "updates" ? { preferNewValidTime: newFactIdSet } : {})
    });
    if (previous) {
      appendVersion(materialized, relation);
    } else {
      const sourceFingerprint = factVersionSourceFingerprint({
        tenantId: owner.tenantId,
        principalId: owner.principalId,
        executionFingerprint: input.execution.fingerprint,
        operation: `${relation.type}:${relation.reasonCode}`,
        sourceFactIds: relation.sourceFactIds,
        targetFactId: materialized.factId
      });
      newVersions.push(factVersionFromFact({
        fact: materialized,
        owner,
        version: 1,
        sourceFactIds: relation.sourceFactIds,
        updateReason: `${relation.type}:${relation.reasonCode}`,
        conflictRefs: [],
        sourceFingerprint,
        createdAt: now
      }));
    }
    changedFacts.set(materialized.factId, materialized);
    resultFactIds.add(materialized.factId);
  }

  for (const factId of input.relationResult.unusedFactIds) {
    if (newFactIdSet.has(factId)) resultFactIds.add(factId);
  }
  for (const factId of input.relationInput.newFactIds) {
    if (!input.relationResult.relations.some((relation) => relation.sourceFactIds.includes(factId))) {
      resultFactIds.add(factId);
    }
  }

  return {
    facts: [...changedFacts.values()].sort((left, right) => left.factId.localeCompare(right.factId)),
    versions: newVersions.sort(compareFactVersions),
    resultFactIds: [...resultFactIds].sort()
  };
}

export function normalizeFactVersion(version: FactVersion): FactVersion {
  const normalized: FactVersion = {
    factVersionId: requiredText(version.factVersionId, "factVersionId"),
    factId: requiredText(version.factId, "factId"),
    tenantId: requiredText(version.tenantId, "tenantId"),
    principalId: requiredText(version.principalId, "principalId"),
    version: positiveInteger(version.version, "version"),
    ...(version.previousVersionId
      ? { previousVersionId: requiredText(version.previousVersionId, "previousVersionId") }
      : {}),
    factText: requiredText(version.factText, "factText"),
    normalizedClaim: requiredText(version.normalizedClaim, "normalizedClaim"),
    factType: requiredText(version.factType, "factType"),
    ...(version.evidenceTimeStart ? { evidenceTimeStart: requiredInstant(version.evidenceTimeStart, "evidenceTimeStart") } : {}),
    ...(version.evidenceTimeEnd ? { evidenceTimeEnd: requiredInstant(version.evidenceTimeEnd, "evidenceTimeEnd") } : {}),
    ...(version.validTimeStart ? { validTimeStart: requiredInstant(version.validTimeStart, "validTimeStart") } : {}),
    ...(version.validTimeEnd ? { validTimeEnd: requiredInstant(version.validTimeEnd, "validTimeEnd") } : {}),
    confidenceLevel: version.confidenceLevel,
    sourceFactIds: uniqueStrings(version.sourceFactIds),
    linkedEventIds: uniqueStrings(version.linkedEventIds),
    linkedSegmentIds: uniqueStrings(version.linkedSegmentIds),
    linkedSourceRefs: uniqueSourceRefs(version.linkedSourceRefs),
    updateReason: requiredText(version.updateReason, "updateReason"),
    conflictRefs: uniqueStrings(version.conflictRefs),
    sourceFingerprint: requiredText(version.sourceFingerprint, "sourceFingerprint"),
    createdAt: requiredInstant(version.createdAt, "createdAt")
  };
  if (!normalized.sourceFactIds.length) throw invalid("sourceFactIds must not be empty.");
  if (normalized.evidenceTimeStart && normalized.evidenceTimeEnd &&
      Date.parse(normalized.evidenceTimeEnd) < Date.parse(normalized.evidenceTimeStart)) {
    throw invalid("evidence time range is invalid.");
  }
  if (normalized.validTimeStart && normalized.validTimeEnd &&
      Date.parse(normalized.validTimeEnd) < Date.parse(normalized.validTimeStart)) {
    throw invalid("valid time range is invalid.");
  }
  return normalized;
}

export function sameFactVersion(left: FactVersion, right: FactVersion) {
  return isDeepStrictEqual(normalizeFactVersion(left), normalizeFactVersion(right));
}

function derivedFactTarget(
  sourceFacts: FactItem[],
  relation: TimelineFusionRelation,
  owner: { tenantId: string; principalId: string },
  now: string
): FactItem {
  const digest = digestValue({
    tenantId: owner.tenantId,
    principalId: owner.principalId,
    relationType: relation.type,
    sourceFactIds: uniqueStrings(relation.sourceFactIds)
  }).slice(0, 24);
  return {
    ...sourceFacts[0]!,
    factId: `fact_timeline_${digest}`,
    tenantId: owner.tenantId,
    principalId: owner.principalId,
    factText: relation.factText!,
    normalizedClaim: relation.normalizedClaim!,
    confidenceLevel: relation.confidenceLevel,
    version: 1,
    status: "active",
    observedAt: now,
    schemaVersion: "timeline-fusion-fact-store.v1"
  };
}

function mergeFactSources(
  target: FactItem,
  sourceFacts: FactItem[],
  owner: { tenantId: string; principalId: string },
  now: string,
  updates: {
    factText: string;
    normalizedClaim: string;
    confidenceLevel: FactItem["confidenceLevel"];
    version: number;
    preferNewValidTime?: ReadonlySet<string>;
  }
): FactItem {
  const validSources = updates.preferNewValidTime
    ? sourceFacts.filter((fact) => updates.preferNewValidTime!.has(fact.factId) && fact.validTimeStart)
    : sourceFacts.filter((fact) => fact.validTimeStart);
  const effectiveValidSources = validSources.length
    ? validSources
    : sourceFacts.filter((fact) => fact.validTimeStart);
  const validBasisFact = effectiveValidSources[0] ?? target;
  const validTimeBasis = validBasisFact.validTimeBasis
    ?? (validBasisFact.timeBasis === "media_offset" ? undefined : validBasisFact.timeBasis);
  const validRange = timeRange(effectiveValidSources, "validTimeStart", "validTimeEnd");
  const evidenceRange = timeRange(sourceFacts, "evidenceTimeStart", "evidenceTimeEnd");
  return {
    ...target,
    tenantId: owner.tenantId,
    principalId: owner.principalId,
    factText: updates.factText,
    normalizedClaim: updates.normalizedClaim,
    linkedEventIds: uniqueStrings(sourceFacts.flatMap((fact) => fact.linkedEventIds)),
    linkedSegmentIds: uniqueStrings(sourceFacts.flatMap((fact) => fact.linkedSegmentIds)),
    linkedSourceRefs: uniqueSourceRefs(sourceFacts.flatMap((fact) => fact.linkedSourceRefs)),
    entityIds: uniqueStrings(sourceFacts.flatMap((fact) => fact.entityIds)),
    confidenceLevel: updates.confidenceLevel,
    version: updates.version,
    status: target.status === "conflicted" ? "conflicted" : "active",
    observedAt: now,
    ...(evidenceRange.start ? { evidenceTimeStart: evidenceRange.start } : {}),
    ...(evidenceRange.end ? { evidenceTimeEnd: evidenceRange.end } : {}),
    evidenceTimeConfidence: minConfidence(sourceFacts.map((fact) => fact.evidenceTimeConfidence ?? "low")),
    sourceMessageIds: uniqueStrings(sourceFacts.flatMap((fact) => fact.sourceMessageIds ?? [])),
    ...(validRange.start ? { validTimeStart: validRange.start } : {}),
    ...(validRange.end ? { validTimeEnd: validRange.end } : {}),
    ...(validRange.start && validTimeBasis ? { validTimeBasis } : {}),
    validTimeConfidence: validRange.start
      ? minConfidence(effectiveValidSources.map((fact) => fact.validTimeConfidence ?? fact.timeConfidence))
      : "low",
    timeBasis: validRange.start ? validBasisFact.timeBasis : target.timeBasis,
    timeConfidence: validRange.start
      ? minConfidence(effectiveValidSources.map((fact) => fact.validTimeConfidence ?? fact.timeConfidence))
      : target.timeConfidence,
    schemaVersion: "timeline-fusion-fact-store.v1"
  };
}

function factVersionFromFact(input: {
  fact: FactItem;
  owner: { tenantId: string; principalId: string };
  version: number;
  previousVersionId?: string;
  sourceFactIds: string[];
  updateReason: string;
  conflictRefs: string[];
  sourceFingerprint: string;
  createdAt: string;
}): FactVersion {
  return normalizeFactVersion({
    factVersionId: `fact_version_${digestValue(input.sourceFingerprint).slice(0, 32)}`,
    factId: input.fact.factId,
    tenantId: input.owner.tenantId,
    principalId: input.owner.principalId,
    version: input.version,
    ...(input.previousVersionId ? { previousVersionId: input.previousVersionId } : {}),
    factText: input.fact.factText,
    normalizedClaim: input.fact.normalizedClaim,
    factType: input.fact.factType,
    ...(input.fact.evidenceTimeStart ? { evidenceTimeStart: input.fact.evidenceTimeStart } : {}),
    ...(input.fact.evidenceTimeEnd ? { evidenceTimeEnd: input.fact.evidenceTimeEnd } : {}),
    ...(input.fact.validTimeStart ? { validTimeStart: input.fact.validTimeStart } : {}),
    ...(input.fact.validTimeEnd ? { validTimeEnd: input.fact.validTimeEnd } : {}),
    confidenceLevel: input.fact.confidenceLevel,
    sourceFactIds: input.sourceFactIds,
    linkedEventIds: input.fact.linkedEventIds,
    linkedSegmentIds: input.fact.linkedSegmentIds,
    linkedSourceRefs: input.fact.linkedSourceRefs,
    updateReason: input.updateReason,
    conflictRefs: input.conflictRefs,
    sourceFingerprint: input.sourceFingerprint,
    createdAt: input.createdAt
  });
}

function factVersionSourceFingerprint(input: {
  tenantId: string;
  principalId: string;
  operation: string;
  sourceFactIds: string[];
  executionFingerprint?: string;
  targetFactId?: string;
}) {
  return `fact_source_v1_${digestValue({
    tenantId: input.tenantId,
    principalId: input.principalId,
    operation: input.operation,
    sourceFactIds: uniqueStrings(input.sourceFactIds),
    executionFingerprint: input.executionFingerprint ?? null,
    targetFactId: input.targetFactId ?? null
  })}`;
}

function latestVersion(versions: readonly FactVersion[], factId: string) {
  return versions
    .filter((version) => version.factId === factId)
    .sort(compareFactVersions)
    .at(-1);
}

function compareFactVersions(left: FactVersion, right: FactVersion) {
  return left.factId.localeCompare(right.factId) ||
    left.version - right.version ||
    left.factVersionId.localeCompare(right.factVersionId);
}

function assertFactOwner(
  fact: FactItem,
  owner: { tenantId: string; principalId: string }
) {
  if (fact.tenantId !== owner.tenantId || fact.principalId !== owner.principalId) {
    throw invalid(`Fact owner does not match execution scope: ${fact.factId}.`);
  }
}

function timeRange(
  facts: FactItem[],
  startKey: "evidenceTimeStart" | "validTimeStart",
  endKey: "evidenceTimeEnd" | "validTimeEnd"
) {
  const starts = facts.flatMap((fact) => fact[startKey] ? [fact[startKey]!] : []);
  const ends = facts.flatMap((fact) => {
    const end = fact[endKey] ?? fact[startKey];
    return end ? [end] : [];
  });
  return {
    start: starts.sort()[0],
    end: ends.sort().at(-1)
  };
}

function uniqueSourceRefs(refs: readonly SourceRef[]) {
  const byId = new Map<string, SourceRef>();
  for (const ref of [...refs].sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId))) {
    if (!byId.has(ref.sourceRefId)) byId.set(ref.sourceRefId, ref);
  }
  return [...byId.values()];
}

function maxConfidence(values: FactItem["confidenceLevel"][]) {
  return [...values].sort((left, right) => confidenceRank(right) - confidenceRank(left))[0] ?? "low";
}

function minConfidence(values: FactItem["confidenceLevel"][]) {
  return [...values].sort((left, right) => confidenceRank(left) - confidenceRank(right))[0] ?? "low";
}

function confidenceRank(value: FactItem["confidenceLevel"]) {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function digestValue(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const normalizedLeft = uniqueStrings(left);
  const normalizedRight = uniqueStrings(right);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function requiredText(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw invalid(`${field} is required.`);
  return normalized;
}

function requiredInstant(value: string, field: string) {
  const normalized = requiredText(value, field);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw invalid(`${field} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 1) throw invalid(`${field} must be a positive integer.`);
  return value;
}

function invalid(message: string) {
  return new TimelineFusionFactStoreError("TIMELINE_FUSION_FACT_STORE_INVALID", message);
}
