import type {
  FactItem,
  FactVersion,
  MemoryEvent,
  TimelineFusionExecution,
  TimelineFusionTask
} from "./domain.js";
import type { EmbeddingClient } from "./embedding.js";
import type { LlmFactFusionOptions } from "./llm-fact-fusion.js";
import { admitFactsToMemoryPipeline } from "./parse-event.js";
import type { ContextEngineRepository } from "./persistence/repository.js";

const LOSSLESS_RELATION_PREFIXES = [
  "same_event:",
  "supports:",
  "supplements:",
  "updates:"
] as const;

export interface TimelineFusionDownstreamOptions {
  llm?: LlmFactFusionOptions;
  disableStmAdmissionLlm?: boolean;
  embeddingClient?: EmbeddingClient;
}

export interface TimelineFusionDownstreamResult {
  admittedFactIds: string[];
  suppressedAtomicFactIds: string[];
  archivedLongTermMemoryIds: string[];
}

/**
 * Reconciles the eventual timeline-fusion result with the eager atomic STM safety net.
 * Atomic facts remain in the Fact Store; only redundant downstream representations are removed.
 */
export async function reconcileTimelineFusionDownstream(
  repository: ContextEngineRepository,
  task: TimelineFusionTask,
  executions: readonly TimelineFusionExecution[],
  options: TimelineFusionDownstreamOptions = {}
): Promise<TimelineFusionDownstreamResult> {
  const successfulExecutions = executions.filter((execution) => execution.status === "succeeded");
  const resultFactIds = uniqueStrings([
    ...successfulExecutions.flatMap((execution) => execution.resultFactIds),
    ...(task.completionReason === "no_temporal_window" ? task.newFactIds : [])
  ]);
  if (!resultFactIds.length) return emptyResult();

  const resultFacts = (await repository.getFactItemsByIds(resultFactIds))
    .filter((fact) =>
      fact.tenantId === task.tenantId &&
      fact.principalId === task.principalId &&
      (fact.status === "active" || fact.status === "conflicted")
    );
  if (!resultFacts.length) return emptyResult();

  const versions = await repository.getFactVersions({
    tenantId: task.tenantId,
    principalId: task.principalId
  });
  const currentVersionByFactId = new Map(resultFacts.flatMap((fact) => {
    const current = currentFactVersion(fact, versions);
    return current ? [[fact.factId, current] as const] : [];
  }));
  const sourceFacts = await repository.getFactItemsByIds(uniqueStrings(
    [...currentVersionByFactId.values()].flatMap((version) => version.sourceFactIds)
  ));
  const sourceFactById = new Map(sourceFacts.map((fact) => [fact.factId, fact]));
  const newFactIds = new Set(successfulExecutions.flatMap((execution) => execution.newFactIds));
  const losslessResultFactIds = new Set(resultFacts.flatMap((fact) => {
    const version = currentVersionByFactId.get(fact.factId);
    return version && isLosslessMaterializedVersion(
      version,
      fact,
      version.sourceFactIds.flatMap((factId) => {
        const source = sourceFactById.get(factId);
        return source ? [source] : [];
      }),
      newFactIds
    ) ? [fact.factId] : [];
  }));
  const suppressedAtomicFactIds = uniqueStrings(resultFacts.flatMap((fact) => {
    if (!losslessResultFactIds.has(fact.factId)) return [];
    const version = currentVersionByFactId.get(fact.factId)!;
    return version.sourceFactIds.filter((sourceFactId) => sourceFactId !== fact.factId);
  }));

  const snapshot = repository.getDebugSnapshot();
  const existingByFactId = new Map(snapshot.shortTermMemories.flatMap((memory) =>
    memory.sourceFactIds.length === 1 ? [[memory.sourceFactIds[0]!, memory] as const] : []
  ));
  const factsToAdmit = resultFacts.filter((fact) => {
    const existing = existingByFactId.get(fact.factId);
    return !existing || !memoryRepresentsFact(existing, fact);
  });

  if (factsToAdmit.length) {
    const event = await buildDownstreamEvent(repository, task, factsToAdmit);
    await admitFactsToMemoryPipeline(repository, event, factsToAdmit, {
      ...(options.llm ? { llm: options.llm } : {}),
      ...(options.disableStmAdmissionLlm !== undefined
        ? { disableStmAdmissionLlm: options.disableStmAdmissionLlm }
        : {}),
      ...(options.embeddingClient ? { embeddingClient: options.embeddingClient } : {}),
      fallbackSourceRefs: uniqueSourceRefs(factsToAdmit.flatMap((fact) => fact.linkedSourceRefs))
    });
  }

  const admittedFactIds = resultFacts
    .filter((fact) => {
      const memory = repository.getDebugSnapshot().shortTermMemories
        .find((item) => item.memoryDataId === `stm_${fact.factId}`);
      return memory && memory.lifecycleStatus !== "rejected" && memory.lifecycleStatus !== "deleted";
    })
    .map((fact) => fact.factId);
  const admittedLosslessFactIds = new Set(admittedFactIds.filter((factId) =>
    losslessResultFactIds.has(factId)
  ));
  const safeToSuppress = suppressedAtomicFactIds.filter((sourceFactId) =>
    resultFacts.some((fact) => {
      if (!admittedLosslessFactIds.has(fact.factId)) return false;
      return currentVersionByFactId.get(fact.factId)?.sourceFactIds.includes(sourceFactId);
    })
  );

  const safeResultSourceRefIds = new Set(resultFacts.flatMap((fact) =>
    admittedLosslessFactIds.has(fact.factId)
      ? fact.linkedSourceRefs.map((ref) => ref.sourceRefId)
      : []
  ));
  const legacyFusedFactIds = repository.getDebugSnapshot().facts.flatMap((fact) => {
    if (resultFactIds.includes(fact.factId) || fact.schemaVersion !== "timeline-fused-fact.v1") return [];
    const sourceRefIds = fact.linkedSourceRefs.map((ref) => ref.sourceRefId);
    if (!sourceRefIds.length || !sourceRefIds.every((sourceRefId) => safeResultSourceRefIds.has(sourceRefId))) {
      return [];
    }
    return [fact.factId];
  });
  const downstreamRepresentationFactIds = uniqueStrings([...safeToSuppress, ...legacyFusedFactIds]);

  for (const factId of downstreamRepresentationFactIds) {
    const memoryDataId = `stm_${factId}`;
    await repository.deleteShortTermMemoryArtifacts(memoryDataId);
    await repository.deleteShortTermMemory(memoryDataId);
    await repository.saveMemoryChangeEvent({
      eventId: `mce_${task.taskId}_${factId}_stm_represented_by_fusion`,
      memoryDataId,
      changeType: "updated",
      storageLayer: "stm",
      reason: "timeline_fusion_atomic_stm_represented_by_lossless_current_fact",
      createdAt: task.completedAt ?? task.updatedAt
    });
  }

  const suppressedMemoryIds = new Set(downstreamRepresentationFactIds.map((factId) => `stm_${factId}`));
  const suppressedFactIds = new Set(downstreamRepresentationFactIds);
  const archivedLongTermMemoryIds: string[] = [];
  for (const memory of repository.getDebugSnapshot().longTermMemories) {
    if (memory.tenantId !== task.tenantId || memory.principalId !== task.principalId) continue;
    const onlySuppressedFacts = Boolean(memory.sourceFactIds?.length) &&
      memory.sourceFactIds!.every((factId) => suppressedFactIds.has(factId));
    const onlySuppressedMemories = Boolean(memory.sourceMemoryDataIds.length) &&
      memory.sourceMemoryDataIds.every((memoryDataId) => suppressedMemoryIds.has(memoryDataId));
    if (!onlySuppressedFacts && !onlySuppressedMemories) continue;
    if (memory.lifecycleStatus !== "archived") {
      await repository.replaceLongTermMemory({
        ...memory,
        lifecycleStatus: "archived",
        updatedAt: task.completedAt ?? task.updatedAt,
        matchedRules: uniqueStrings([
          ...memory.matchedRules,
          "timeline_fusion_atomic_representation_archived"
        ])
      });
    }
    await repository.deleteIndexBundle("ltm", memory.memoryId);
    archivedLongTermMemoryIds.push(memory.memoryId);
  }

  return {
    admittedFactIds: uniqueStrings(admittedFactIds),
    suppressedAtomicFactIds: uniqueStrings(safeToSuppress),
    archivedLongTermMemoryIds: uniqueStrings(archivedLongTermMemoryIds)
  };
}

function currentFactVersion(fact: FactItem, versions: readonly FactVersion[]) {
  const candidates = versions
    .filter((version) => version.factId === fact.factId)
    .sort((left, right) => left.version - right.version || left.factVersionId.localeCompare(right.factVersionId));
  return candidates.find((version) => version.version === fact.version) ?? candidates.at(-1);
}

function isLosslessMaterializedVersion(
  version: FactVersion,
  currentFact: FactItem,
  sourceFacts: readonly FactItem[],
  newFactIds: ReadonlySet<string>
) {
  if (version.sourceFactIds.length < 2 || sourceFacts.length !== version.sourceFactIds.length) return false;
  if (version.conflictRefs.length > 0 || !LOSSLESS_RELATION_PREFIXES.some((prefix) =>
    version.updateReason.startsWith(prefix)
  )) return false;
  const protectedSources = version.updateReason.startsWith("updates:")
    ? sourceFacts.filter((fact) => newFactIds.has(fact.factId))
    : sourceFacts;
  if (!protectedSources.length) return false;
  const output = `${currentFact.factText}\n${currentFact.normalizedClaim}`.normalize("NFKC").toLocaleLowerCase();
  return protectedDetailTokens(protectedSources).every((token) => output.includes(token.toLocaleLowerCase())) &&
    protectedSources.every((source) => hasSemanticCoverage(source, output));
}

function protectedDetailTokens(facts: readonly FactItem[]) {
  const text = facts.map((fact) => `${fact.factText}\n${fact.normalizedClaim}`).join("\n").normalize("NFKC");
  return uniqueStrings([
    ...(text.match(/\d+(?:[.:：]\d+)?(?:\.\d+)?/gu) ?? []),
    ...(text.match(/[A-Za-z][A-Za-z0-9._+-]*/gu) ?? []),
    ...(text.match(/每天|每日|每周|每月|每年|单程|往返|至少|至多|最多|最少|超过|不足|之前|之后|以前|以后|不|未|没有|无需|禁止|不能/gu) ?? []),
    ...(text.match(/分钟|小时|公里|千米|公斤|美元|人民币|元|天|周|月|年/gu) ?? []),
    ...(text.match(/\b(?:not|never|no)\b/giu) ?? [])
  ]);
}

function hasSemanticCoverage(source: FactItem, normalizedOutput: string) {
  const sourceClaim = canonicalClaim(source.normalizedClaim || source.factText).replace(/^用户/gu, "");
  const outputClaim = canonicalClaim(normalizedOutput);
  if (!sourceClaim) return false;
  if (outputClaim.includes(sourceClaim)) return true;
  const sourceBigrams = chineseBigrams(sourceClaim);
  if (sourceBigrams.length) {
    const outputBigrams = new Set(chineseBigrams(outputClaim));
    const overlap = sourceBigrams.filter((token) => outputBigrams.has(token)).length;
    return overlap / sourceBigrams.length >= 0.45;
  }
  const sourceTerms = sourceClaim.split(/\s+/u).filter((term) => term.length > 1);
  return sourceTerms.length > 0 && sourceTerms.filter((term) => outputClaim.includes(term)).length / sourceTerms.length >= 0.6;
}

function canonicalClaim(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/gu, " ").trim();
}

function chineseBigrams(value: string) {
  const text = value.replace(/[^\u3400-\u9fff]/gu, "");
  const result: string[] = [];
  for (let index = 0; index < text.length - 1; index += 1) result.push(text.slice(index, index + 2));
  return uniqueStrings(result);
}

function memoryRepresentsFact(
  memory: ReturnType<ContextEngineRepository["getDebugSnapshot"]>["shortTermMemories"][number],
  fact: FactItem
) {
  const structured = memory.structuredFacts?.facts.find((item) => item.factId === fact.factId);
  const memorySourceRefIds = uniqueStrings(memory.sourceRefs.map((ref) => ref.sourceRefId));
  const factSourceRefIds = uniqueStrings(fact.linkedSourceRefs.map((ref) => ref.sourceRefId));
  return memory.sourceFactIds.length === 1 &&
    memory.sourceFactIds[0] === fact.factId &&
    structured?.claim === (fact.normalizedClaim || fact.factText) &&
    memory.content.includes(fact.normalizedClaim || fact.factText) &&
    structured.confidenceLevel === fact.confidenceLevel &&
    sameStrings(memorySourceRefIds, factSourceRefIds) &&
    memory.evidenceTimeStart === fact.evidenceTimeStart &&
    memory.evidenceTimeEnd === fact.evidenceTimeEnd &&
    memory.validTimeStart === fact.validTimeStart &&
    memory.validTimeEnd === fact.validTimeEnd &&
    memory.admissionSignals.conflict === (fact.status === "conflicted" ? "known" : "none");
}

async function buildDownstreamEvent(
  repository: ContextEngineRepository,
  task: TimelineFusionTask,
  facts: readonly FactItem[]
): Promise<MemoryEvent> {
  const linkedEvents = await repository.getMemoryEventsByIds(uniqueStrings(
    facts.flatMap((fact) => fact.linkedEventIds)
  ));
  const first = linkedEvents[0];
  const sourceRefs = uniqueSourceRefs(facts.flatMap((fact) => fact.linkedSourceRefs));
  const eventTime = latestTimestamp(facts.flatMap((fact) => [
    fact.evidenceTimeEnd,
    fact.evidenceTimeStart,
    fact.observedAt
  ])) ?? task.updatedAt;
  const event: MemoryEvent = {
    eventId: `timeline_fusion_downstream_${task.taskId}`,
    eventType: "timeline_fusion_result",
    eventSummary: facts.map((fact) => fact.factText).join("\n"),
    eventTime,
    ...(first?.sourceApp ? { sourceApp: first.sourceApp } : { sourceApp: "context-engine" }),
    ...(first?.sourceId ? { sourceId: first.sourceId } : {}),
    permissionSnapshot: {
      snapshotId: `permission_timeline_fusion_${task.taskId}`,
      tenantId: task.tenantId,
      principalId: task.principalId,
      sourceAclVersion: first?.permissionSnapshot.sourceAclVersion ?? "timeline-fusion.v1",
      visibility: first?.permissionSnapshot.visibility ?? "private"
    },
    multimodalData: [],
    sourceRefs
  };
  await repository.saveMemoryEvent(event);
  return event;
}

function uniqueSourceRefs(refs: FactItem["linkedSourceRefs"]) {
  const byId = new Map(refs.map((ref) => [ref.sourceRefId, ref]));
  return [...byId.values()].sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId));
}

function latestTimestamp(values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function emptyResult(): TimelineFusionDownstreamResult {
  return {
    admittedFactIds: [],
    suppressedAtomicFactIds: [],
    archivedLongTermMemoryIds: []
  };
}
