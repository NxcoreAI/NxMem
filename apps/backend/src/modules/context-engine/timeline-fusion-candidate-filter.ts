import type { FactItem, TimelineFusionWindow } from "./domain.js";
import { canonicalizeTimelineClaim } from "./timeline-aggregation.js";

export type TimelineFusionCandidateReasonCode =
  | "compatible_fact_type"
  | "exact_claim"
  | "shared_entity"
  | "topic_overlap"
  | "weak_anchor";

export interface TimelineFusionCandidateGroup {
  newFactIds: string[];
  candidateFactIds: string[];
  reasonCodes: TimelineFusionCandidateReasonCode[];
}

export interface TimelineFusionCandidateFilterResult {
  groups: TimelineFusionCandidateGroup[];
  duplicateCandidateFactIds: string[];
  unrelatedCandidateFactIds: string[];
}

const BROAD_EPISODIC_FACT_TYPES = new Set([
  "document",
  "event",
  "text",
  "timeline",
  "tool_result"
]);

const TOPIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "be",
  "been",
  "being",
  "for",
  "in",
  "is",
  "of",
  "on",
  "says",
  "that",
  "the",
  "this",
  "to",
  "user",
  "was",
  "were"
]);

const CJK_TOPIC_STOP_BIGRAMS = new Set(["本人", "用户", "自己", "这个", "那个", "当前", "目前"]);

export function filterAndGroupTimelineFusionCandidates(input: {
  newFacts: readonly FactItem[];
  candidateFacts: readonly FactItem[];
  temporalWindow: TimelineFusionWindow;
}): TimelineFusionCandidateFilterResult {
  const newFacts = stableUniqueFacts(input.newFacts);
  const duplicateCandidateFactIds: string[] = [];
  const unrelatedCandidateFactIds: string[] = [];
  const candidateFacts = deduplicateCandidateFacts(
    newFacts,
    input.candidateFacts,
    duplicateCandidateFactIds
  );
  const groups = newFacts.map((fact) => ({
    newFacts: [fact],
    candidateFacts: [] as FactItem[],
    reasons: new Set<TimelineFusionCandidateReasonCode>()
  }));

  for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
    for (let rightIndex = groups.length - 1; rightIndex > leftIndex; rightIndex -= 1) {
      const relation = findRelationBetweenGroups(groups[leftIndex]!, groups[rightIndex]!);
      if (!relation) continue;
      groups[leftIndex]!.newFacts.push(...groups[rightIndex]!.newFacts);
      addReasons(groups[leftIndex]!.reasons, relation);
      groups.splice(rightIndex, 1);
    }
  }

  for (const candidate of candidateFacts) {
    const matches = groups
      .map((group, index) => ({
        index,
        relation: findRelation(candidate, group.newFacts)
      }))
      .filter((match): match is { index: number; relation: TimelineFusionCandidateReasonCode[] } =>
        Boolean(match.relation)
      );
    if (!matches.length) {
      unrelatedCandidateFactIds.push(candidate.factId);
      continue;
    }

    const target = groups[matches[0]!.index]!;
    target.candidateFacts.push(candidate);
    addReasons(target.reasons, matches[0]!.relation);
    for (let matchIndex = matches.length - 1; matchIndex >= 1; matchIndex -= 1) {
      const matchedGroup = groups[matches[matchIndex]!.index]!;
      target.newFacts.push(...matchedGroup.newFacts);
      target.candidateFacts.push(...matchedGroup.candidateFacts);
      addReasons(target.reasons, matchedGroup.reasons);
      addReasons(target.reasons, matches[matchIndex]!.relation);
      groups.splice(matches[matchIndex]!.index, 1);
    }
  }

  return {
    groups: groups
      .map((group) => ({
        newFactIds: uniqueSorted(group.newFacts.map((fact) => fact.factId)),
        candidateFactIds: uniqueSorted(group.candidateFacts.map((fact) => fact.factId)),
        reasonCodes: uniqueSorted([
          ...group.reasons,
          ...(input.temporalWindow.basis === "weak_anchor" ? ["weak_anchor" as const] : [])
        ]) as TimelineFusionCandidateReasonCode[]
      }))
      .sort((left, right) => left.newFactIds[0]!.localeCompare(right.newFactIds[0]!)),
    duplicateCandidateFactIds: uniqueSorted(duplicateCandidateFactIds),
    unrelatedCandidateFactIds: uniqueSorted(unrelatedCandidateFactIds)
  };
}

export function areTimelineFusionFactTypesCompatible(leftType: string, rightType: string) {
  const left = normalizeFactType(leftType);
  const right = normalizeFactType(rightType);
  if (!left || !right) return false;
  if (left === right) return true;
  return BROAD_EPISODIC_FACT_TYPES.has(left) && BROAD_EPISODIC_FACT_TYPES.has(right);
}

function findRelationBetweenGroups(
  left: { newFacts: FactItem[] },
  right: { newFacts: FactItem[] }
) {
  for (const fact of left.newFacts) {
    const relation = findRelation(fact, right.newFacts);
    if (relation) return relation;
  }
  return undefined;
}

function findRelation(left: FactItem, rights: readonly FactItem[]) {
  for (const right of rights) {
    const relation = relationReasons(left, right);
    if (relation) return relation;
  }
  return undefined;
}

function relationReasons(left: FactItem, right: FactItem): TimelineFusionCandidateReasonCode[] | undefined {
  if (!areTimelineFusionFactTypesCompatible(left.factType, right.factType)) return undefined;
  const reasons: TimelineFusionCandidateReasonCode[] = ["compatible_fact_type"];
  if (claimsAreExact(left, right)) reasons.push("exact_claim");
  if (sharesEntity(left, right)) reasons.push("shared_entity");
  if (haveTimelineFusionTopicOverlap(left, right)) reasons.push("topic_overlap");
  return reasons.length > 1 ? reasons : undefined;
}

function deduplicateCandidateFacts(
  newFacts: readonly FactItem[],
  candidateFacts: readonly FactItem[],
  duplicateFactIds: string[]
) {
  const seenFactIds = new Set(newFacts.map((fact) => fact.factId));
  const seenClaims = new Set(newFacts.flatMap(exactClaimKeys));
  const seenSegments = new Set(newFacts.flatMap(sourceSegmentKeys));
  const unique: FactItem[] = [];
  for (const candidate of stableUniqueFacts(candidateFacts)) {
    const claims = exactClaimKeys(candidate);
    const segments = sourceSegmentKeys(candidate);
    const duplicate = seenFactIds.has(candidate.factId) ||
      claims.some((claim) => seenClaims.has(claim)) ||
      segments.some((segment) => seenSegments.has(segment));
    if (duplicate) {
      duplicateFactIds.push(candidate.factId);
      continue;
    }
    unique.push(candidate);
    seenFactIds.add(candidate.factId);
    for (const claim of claims) seenClaims.add(claim);
    for (const segment of segments) seenSegments.add(segment);
  }
  return unique;
}

function stableUniqueFacts(facts: readonly FactItem[]) {
  const byId = new Map<string, FactItem>();
  for (const fact of [...facts].sort((left, right) => left.factId.localeCompare(right.factId))) {
    if (!byId.has(fact.factId)) byId.set(fact.factId, fact);
  }
  return [...byId.values()];
}

function claimsAreExact(left: FactItem, right: FactItem) {
  const rightClaims = new Set(exactClaimKeys(right));
  return exactClaimKeys(left).some((claim) => rightClaims.has(claim));
}

function haveTimelineFusionTopicOverlap(left: FactItem, right: FactItem) {
  return topicClaimValues(left).some((leftClaim) =>
    topicClaimValues(right).some((rightClaim) => claimsShareTopic(leftClaim, rightClaim))
  );
}

function topicClaimValues(fact: FactItem) {
  return uniqueSorted([fact.sourceClaim ?? "", fact.normalizedClaim, fact.factText].filter(Boolean));
}

function claimsShareTopic(leftValue: string, rightValue: string) {
  const leftCanonical = canonicalizeTimelineClaim(leftValue);
  const rightCanonical = canonicalizeTimelineClaim(rightValue);
  if (!leftCanonical || !rightCanonical) return false;
  if (leftCanonical === rightCanonical) return true;
  const shorterLength = Math.min(leftCanonical.length, rightCanonical.length);
  if (
    shorterLength >= 6 &&
    (leftCanonical.includes(rightCanonical) || rightCanonical.includes(leftCanonical))
  ) {
    return true;
  }

  const leftWords = topicWords(leftValue);
  const rightWords = topicWords(rightValue);
  const sharedWords = intersection(leftWords, rightWords);
  if (sharedWords.size >= 2 && sharedWords.size / Math.min(leftWords.size, rightWords.size) >= 0.5) {
    return true;
  }
  if (
    sharedWords.size === 1 &&
    Math.min(leftWords.size, rightWords.size) <= 2 &&
    [...sharedWords][0]!.length >= 5
  ) {
    return true;
  }

  const leftBigrams = cjkTopicBigrams(leftValue);
  const rightBigrams = cjkTopicBigrams(rightValue);
  const sharedBigrams = intersection(leftBigrams, rightBigrams);
  return sharedBigrams.size >= 2 &&
    sharedBigrams.size / Math.min(leftBigrams.size, rightBigrams.size) >= 0.45;
}

function topicWords(value: string) {
  return new Set((value.normalize("NFKC").toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map(stemTopicWord)
    .filter((word) => word.length >= 2 && !TOPIC_STOP_WORDS.has(word)));
}

function stemTopicWord(value: string) {
  if (value.length >= 6 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length >= 5 && value.endsWith("ed")) return value.slice(0, -2);
  if (value.length >= 5 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length >= 4 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function cjkTopicBigrams(value: string) {
  const characters = value.normalize("NFKC").match(/\p{Script=Han}/gu) ?? [];
  const bigrams = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    const bigram = `${characters[index]}${characters[index + 1]}`;
    if (!CJK_TOPIC_STOP_BIGRAMS.has(bigram)) bigrams.add(bigram);
  }
  return bigrams;
}

function intersection<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
  const shared = new Set<T>();
  for (const value of left) {
    if (right.has(value)) shared.add(value);
  }
  return shared;
}

function exactClaimKeys(fact: FactItem) {
  return uniqueSorted([fact.normalizedClaim, fact.factText]
    .map(canonicalizeTimelineClaim)
    .filter(Boolean));
}

function sourceSegmentKeys(fact: FactItem) {
  return uniqueSorted(fact.linkedSegmentIds.filter(Boolean));
}

function sharesEntity(left: FactItem, right: FactItem) {
  const rightEntities = new Set(right.entityIds);
  return left.entityIds.some((entityId) => rightEntities.has(entityId));
}

function normalizeFactType(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function addReasons(
  target: Set<TimelineFusionCandidateReasonCode>,
  source: Iterable<TimelineFusionCandidateReasonCode>
) {
  for (const reason of source) target.add(reason);
}

function uniqueSorted<T extends string>(values: readonly T[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
