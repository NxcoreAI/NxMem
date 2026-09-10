import { createHash } from "node:crypto";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assembleContext } from "./assemble-context.js";
import type { FactItem, TimelineFusionTask } from "./domain.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { createFactBatchCommitted } from "./fact-batch.js";
import { SqliteContextEngineRepository } from "./persistence/memory-repository.js";
import { searchContext } from "./search-context.js";
import { filterAndGroupTimelineFusionCandidates } from "./timeline-fusion-candidate-filter.js";
import { processTimelineFusionTask } from "./timeline-fusion-processor.js";
import type { TimelineFusionRelationInput } from "./timeline-fusion-relations.js";
import { createTimelineFusionTask } from "./timeline-fusion-task.js";
import { buildTimelineFusionWindows } from "./timeline-fusion-window.js";

const embeddingClient = createDeterministicTestEmbeddingClient(64);
const maxAcceptanceFactLength = 600;

interface AcceptanceCase {
  newFact: FactItem;
  candidateFact: FactItem;
  basis: string;
  reasonCodes: string[];
}

interface CandidateScan {
  activeScopedFacts: number;
  windows: number;
  recalledCandidateFacts: number;
  relatedGroups: number;
  relatedPairs: number;
  byBasis: Record<string, number>;
  selected: AcceptanceCase;
}

const sourcePath = databaseArgument(process.argv.slice(2));
const sourceIntegrity = checkIntegrity(sourcePath);
if (sourceIntegrity !== "ok") {
  throw new Error(`Source database integrity check failed: ${sourceIntegrity}`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "context-engine-real-data-acceptance-"));
try {
  const fallbackPath = await copySqliteBundle(sourcePath, join(temporaryRoot, "fallback"));
  const successPath = await copySqliteBundle(sourcePath, join(temporaryRoot, "success"));

  const fallbackRepository = new SqliteContextEngineRepository(fallbackPath);
  const baseline = summarizeRepository(fallbackRepository);
  const scan = await scanCandidates(fallbackRepository);
  fallbackRepository.close();

  const fallback = await runFallbackAcceptance(fallbackPath, scan.selected.newFact.factId);
  const success = await runSuccessAcceptance(successPath, scan.selected.newFact.factId);

  process.stdout.write(`${JSON.stringify({
    source: {
      database: basename(sourcePath),
      integrity: sourceIntegrity,
      ...baseline
    },
    candidates: {
      activeScopedFacts: scan.activeScopedFacts,
      windows: scan.windows,
      recalledCandidateFacts: scan.recalledCandidateFacts,
      relatedGroups: scan.relatedGroups,
      relatedPairs: scan.relatedPairs,
      byBasis: scan.byBasis,
      selected: {
        newFactHash: hashId(scan.selected.newFact.factId),
        candidateFactHash: hashId(scan.selected.candidateFact.factId),
        newFactTextLength: scan.selected.newFact.factText.length,
        candidateFactTextLength: scan.selected.candidateFact.factText.length,
        basis: scan.selected.basis,
        reasonCodes: scan.selected.reasonCodes
      }
    },
    fallback,
    success,
    liveLlm: {
      configured: Boolean(process.env.OPENAI_API_KEY),
      exercised: false,
      reason: "Acceptance never sends real facts to an external model; live model quality requires explicit credentials and approval."
    }
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runFallbackAcceptance(databasePath: string, selectedFactId: string) {
  const repository = new SqliteContextEngineRepository(databasePath);
  try {
    const before = repository.getDebugSnapshot();
    const factCountBefore = before.facts.length;
    const stmCountBefore = before.shortTermMemories.length;
    const versionCountBefore = factVersionsOf(before).length;
    const beforeFacts = factContentById(before.facts);
    const beforeStm = new Map(before.shortTermMemories.map((memory) => [memory.memoryDataId, memory.content]));
    const task = await readyTask(repository, selectedFactId, "acceptance_fallback");
    const processed = await processTimelineFusionTask(repository, task, {
      judgment: {
        apiKey: "",
        fetchImpl: async () => {
          throw new Error("fallback_acceptance_must_not_call_external_llm");
        }
      },
      downstream: {
        disableStmAdmissionLlm: true,
        embeddingClient
      }
    });
    const after = repository.getDebugSnapshot();
    const inputFactIds = uniqueStrings(processed.windows.flatMap((window) =>
      window.relationInput?.facts.map((fact) => fact.factId) ?? window.newFactIds
    ));
    const allInputFactsPreserved = inputFactIds.every((factId) =>
      beforeFacts.get(factId) === after.facts.find((fact) => fact.factId === factId)?.factText
    );
    const existingStmPreserved = [...beforeStm].every(([memoryId, content]) =>
      after.shortTermMemories.find((memory) => memory.memoryDataId === memoryId)?.content === content
    );
    assertAcceptance(allInputFactsPreserved, "Fallback changed an input Fact.");
    assertAcceptance(existingStmPreserved, "Fallback removed or changed an existing STM.");

    return {
      passed: true,
      taskStatus: processed.task.status,
      executionCount: processed.executions.length,
      inputFactCount: inputFactIds.length,
      allInputFactsPreserved,
      existingStmPreserved,
      factCountBefore,
      factCountAfter: after.facts.length,
      stmCountBefore,
      stmCountAfter: after.shortTermMemories.length,
      versionsCreated: factVersionsOf(after).length - versionCountBefore
    };
  } finally {
    repository.close();
  }
}

async function runSuccessAcceptance(databasePath: string, selectedFactId: string) {
  const repository = new SqliteContextEngineRepository(databasePath);
  const before = repository.getDebugSnapshot();
  const versionCountBefore = factVersionsOf(before).length;
  const originalFacts = factContentById(before.facts);
  const task = await readyTask(repository, selectedFactId, "acceptance_success");
  let judgmentCount = 0;
  let selectedSourceFactIds: string[] = [];
  const processed = await processTimelineFusionTask(repository, task, {
    judgeRelations: async (input) => {
      judgmentCount += 1;
      const relation = losslessAcceptanceRelation(input);
      selectedSourceFactIds = relation.sourceFactIds;
      return {
        status: "succeeded",
        responseFormat: "relations",
        result: {
          schemaVersion: "timeline-fusion-relations.v1",
          relations: [relation],
          unusedFactIds: input.facts
            .map((fact) => fact.factId)
            .filter((factId) => !relation.sourceFactIds.includes(factId))
        }
      };
    },
    downstream: {
      disableStmAdmissionLlm: true,
      embeddingClient
    }
  });
  const after = repository.getDebugSnapshot();
  const materializedVersions = factVersionsOf(after).filter((version) =>
    version.updateReason.startsWith("supplements:acceptance_lossless_concat")
  );
  const materializedVersion = materializedVersions.at(-1);
  assertAcceptance(judgmentCount === 1, `Expected one judgment, received ${judgmentCount}.`);
  assertAcceptance(Boolean(materializedVersion), "Acceptance relation did not create a materialized FactVersion.");
  const targetFactId = materializedVersion!.factId;
  const targetFact = after.facts.find((fact) => fact.factId === targetFactId);
  assertAcceptance(Boolean(targetFact), "Materialized current Fact is missing.");
  const tenantId = targetFact!.tenantId;
  const principalId = targetFact!.principalId;
  assertAcceptance(Boolean(tenantId && principalId), "Materialized current Fact owner is missing.");

  const sourceVersions = await repository.getFactVersionsByFactIds({
    tenantId: tenantId!,
    principalId: principalId!,
    factIds: selectedSourceFactIds
  });
  const originalTextsAuditable = selectedSourceFactIds.every((factId) =>
    sourceVersions.some((version) =>
      version.factId === factId && version.factText === originalFacts.get(factId)
    )
  );
  const atomicFactsRetained = selectedSourceFactIds.every((factId) =>
    after.facts.some((fact) => fact.factId === factId)
  );
  assertAcceptance(originalTextsAuditable, "An original Fact text is missing from the version audit chain.");
  assertAcceptance(atomicFactsRetained, "An atomic Fact was deleted after successful fusion.");

  const queryFact = processed.windows
    .flatMap((window) => window.relationInput?.facts ?? [])
    .find((fact) => fact.factId === selectedFactId);
  assertAcceptance(Boolean(queryFact), "Selected Fact was missing from the relation input.");
  const search = await searchContext(repository, {
    q: queryFact!.normalizedClaim,
    tenantId: tenantId!,
    principalId: principalId!,
    limit: 20
  }, {
    embeddingClient,
    recordRetrieval: false,
    recordShadow: false
  });
  const searchResult = search.results.find((result) => result.factIds.includes(targetFactId));
  assertAcceptance(Boolean(searchResult), "Fused current Fact was not returned by search_context.");
  const searchSourceFactsPresent = selectedSourceFactIds.every((factId) =>
    searchResult!.factContext.sourceFacts.some((fact) => fact.factId === factId)
  );
  assertAcceptance(searchSourceFactsPresent, "Search result omitted source Fact provenance.");

  const pack = await assembleContext(repository, {
    task: queryFact!.normalizedClaim,
    q: queryFact!.normalizedClaim,
    tenantId: tenantId!,
    principalId: principalId!,
    tokenBudget: 1200,
    recordRetrieval: false,
    embeddingClient
  });
  const packItems = [
    ...pack.profileContext,
    ...pack.taskContext,
    ...pack.recentContext,
    ...pack.constraints
  ];
  const packItem = packItems.find((item) => item.factIds.includes(targetFactId));
  assertAcceptance(Boolean(packItem), "Fused current Fact was not included in the Context Pack.");
  const packSourceFactsPresent = selectedSourceFactIds.every((factId) =>
    packItem!.factContext?.sourceFacts.some((fact) => fact.factId === factId)
  );
  assertAcceptance(packSourceFactsPresent, "Context Pack omitted source Fact provenance.");

  const versionsBeforeReplay = factVersionsOf(after).length;
  const storedTask = await repository.getTimelineFusionTask(task.taskId);
  const replayTask = toReadyTask(storedTask!);
  await repository.saveTimelineFusionTask(replayTask);
  let replayJudgmentCount = 0;
  await processTimelineFusionTask(repository, replayTask, {
    judgeRelations: async () => {
      replayJudgmentCount += 1;
      throw new Error("Idempotent replay must not judge relations again.");
    },
    downstream: {
      disableStmAdmissionLlm: true,
      embeddingClient
    }
  });
  const versionsAfterReplay = factVersionsOf(repository.getDebugSnapshot()).length;
  assertAcceptance(replayJudgmentCount === 0, "Idempotent replay called relation judgment again.");
  assertAcceptance(versionsAfterReplay === versionsBeforeReplay, "Idempotent replay created duplicate versions.");
  const expectedTemporal = temporalSnapshot(targetFact!);
  repository.close();

  const restarted = new SqliteContextEngineRepository(databasePath, undefined, { loadCache: false });
  try {
    const [restoredFact] = await restarted.getFactItemsByIds([targetFactId]);
    assertAcceptance(Boolean(restoredFact), "Current Fact was not restored after SQLite restart.");
    const temporalPreservedAfterRestart = JSON.stringify(temporalSnapshot(restoredFact!)) ===
      JSON.stringify(expectedTemporal);
    assertAcceptance(temporalPreservedAfterRestart, "SQLite restart changed Fact temporal metadata.");

    return {
      passed: true,
      taskStatus: processed.task.status,
      judgmentCount,
      sourceFactCount: selectedSourceFactIds.length,
      sourceFactHashes: selectedSourceFactIds.map(hashId),
      targetFactHash: hashId(targetFactId),
      targetVersion: targetFact!.version,
      versionsCreated: factVersionsOf(after).length - versionCountBefore,
      atomicFactsRetained,
      originalTextsAuditable,
      fusedStmPresent: after.shortTermMemories.some((memory) =>
        memory.sourceFactIds.includes(targetFactId)
      ),
      searchReturnedCurrentFact: Boolean(searchResult),
      searchSourceFactsPresent,
      contextPackReturnedCurrentFact: Boolean(packItem),
      contextPackSourceFactsPresent: Boolean(packSourceFactsPresent),
      replayJudgmentCount,
      replayCreatedVersions: versionsAfterReplay - versionsBeforeReplay,
      temporalPreservedAfterRestart
    };
  } finally {
    restarted.close();
  }
}

function losslessAcceptanceRelation(input: TimelineFusionRelationInput) {
  const newFact = input.facts.find((fact) => fact.isNew);
  const candidateFact = input.facts.find((fact) => !fact.isNew);
  if (!newFact || !candidateFact) {
    throw new Error("Acceptance requires one new Fact and one historical candidate.");
  }
  return {
    type: "supplements" as const,
    sourceFactIds: [newFact.factId, candidateFact.factId].sort(),
    factText: `${candidateFact.factText}；${newFact.factText}`,
    normalizedClaim: `${candidateFact.normalizedClaim}；${newFact.normalizedClaim}`,
    confidenceLevel: "high" as const,
    reasonCode: "acceptance_lossless_concat"
  };
}

async function scanCandidates(repository: SqliteContextEngineRepository): Promise<CandidateScan> {
  const facts = repository.getDebugSnapshot().facts
    .filter((fact) => fact.status === "active" && fact.tenantId && fact.principalId)
    .sort((left, right) => left.factId.localeCompare(right.factId));
  const factById = new Map(facts.map((fact) => [fact.factId, fact]));
  let windows = 0;
  let recalledCandidateFacts = 0;
  let relatedGroups = 0;
  const related: Array<AcceptanceCase & { score: number }> = [];
  const byBasis: Record<string, number> = {};

  for (const fact of facts) {
    const events = await repository.getMemoryEventsByIds(fact.linkedEventIds);
    for (const window of buildTimelineFusionWindows([fact], events, {})) {
      windows += 1;
      const candidates = await repository.findTimelineFusionFactCandidates({
        tenantId: fact.tenantId!,
        principalId: fact.principalId!,
        temporalWindow: window.temporalWindow,
        excludeFactIds: [fact.factId],
        limit: 50
      });
      recalledCandidateFacts += candidates.length;
      const filtered = filterAndGroupTimelineFusionCandidates({
        newFacts: [fact],
        candidateFacts: candidates,
        temporalWindow: window.temporalWindow
      });
      for (const group of filtered.groups) {
        const suitableCandidates = group.candidateFactIds.flatMap((candidateFactId) => {
          const candidateFact = factById.get(candidateFactId);
          if (!candidateFact || fact.factText.length > maxAcceptanceFactLength ||
              candidateFact.factText.length > maxAcceptanceFactLength) return [];
          return [candidateFact];
        });
        if (suitableCandidates.length) relatedGroups += 1;
        for (const candidateFact of suitableCandidates) {
          const basis = window.temporalWindow.basis;
          byBasis[basis] = (byBasis[basis] ?? 0) + 1;
          related.push({
            newFact: fact,
            candidateFact,
            basis,
            reasonCodes: group.reasonCodes,
            score: relationScore(basis, group.reasonCodes, fact, candidateFact)
          });
        }
      }
    }
  }

  const selected = related.sort((left, right) =>
    right.score - left.score ||
    left.newFact.factText.length + left.candidateFact.factText.length -
      right.newFact.factText.length - right.candidateFact.factText.length ||
    left.newFact.factId.localeCompare(right.newFact.factId)
  )[0];
  if (!selected) throw new Error("No bounded real-data fusion candidate was found.");
  return {
    activeScopedFacts: facts.length,
    windows,
    recalledCandidateFacts,
    relatedGroups,
    relatedPairs: related.length,
    byBasis,
    selected
  };
}

function relationScore(
  basis: string,
  reasonCodes: readonly string[],
  left: FactItem,
  right: FactItem
) {
  return (basis === "valid" || basis === "evidence" ? 100 : 0) +
    (reasonCodes.includes("entity_overlap") ? 20 : 0) +
    (reasonCodes.includes("claim_overlap") ? 10 : 0) +
    (reasonCodes.includes("topic_overlap") ? 5 : 0) -
    (left.factText.length + right.factText.length) / 10_000;
}

async function readyTask(
  repository: SqliteContextEngineRepository,
  factId: string,
  sourceKey: string
) {
  const [fact] = await repository.getFactItemsByIds([factId]);
  if (!fact?.tenantId || !fact.principalId) throw new Error(`Fact owner is missing: ${hashId(factId)}`);
  const now = new Date().toISOString();
  const batch = await repository.saveFactBatchCommitted(createFactBatchCommitted({
    triggerType: "manual_correction",
    sourceKey,
    tenantId: fact.tenantId,
    principalId: fact.principalId,
    factIds: [factId],
    committedAt: now
  }));
  const pending = createTimelineFusionTask({ batch, now, debounceMs: 0, maxWaitMs: 0 });
  const task: TimelineFusionTask = {
    ...pending,
    status: "ready",
    readyAt: now,
    updatedAt: now
  };
  await repository.saveTimelineFusionTask(task);
  return task;
}

function toReadyTask(task: TimelineFusionTask): TimelineFusionTask {
  const {
    completedAt: _completedAt,
    completionReason: _completionReason,
    error: _error,
    ...rest
  } = task;
  const now = new Date().toISOString();
  return { ...rest, status: "ready", readyAt: now, updatedAt: now };
}

function summarizeRepository(repository: SqliteContextEngineRepository) {
  const snapshot = repository.getDebugSnapshot();
  const owners = new Set(snapshot.facts.map((fact) => `${fact.tenantId ?? ""}\u0000${fact.principalId ?? ""}`));
  return {
    facts: snapshot.facts.length,
    factVersions: factVersionsOf(snapshot).length,
    shortTermMemories: snapshot.shortTermMemories.length,
    longTermMemories: snapshot.longTermMemories.length,
    events: snapshot.memoryEvents.length,
    owners: owners.size,
    evidenceTimedFacts: snapshot.facts.filter((fact) => fact.evidenceTimeStart).length,
    validTimedFacts: snapshot.facts.filter((fact) => fact.validTimeStart).length
  };
}

async function copySqliteBundle(source: string, targetDirectory: string) {
  const actualDirectory = await mkdtemp(`${targetDirectory}-`);
  const target = join(actualDirectory, basename(source));
  await copyFile(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await access(`${source}${suffix}`);
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    await copyFile(`${source}${suffix}`, `${target}${suffix}`);
  }
  return target;
}

function checkIntegrity(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: unknown }>;
    return rows.map((row) => String(row.integrity_check ?? "")).join(",");
  } finally {
    database.close();
  }
}

function databaseArgument(args: string[]) {
  const index = args.indexOf("--database");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error("Usage: timeline-fusion-real-data-acceptance --database <sqlite-path>");
  return resolve(value);
}

function factContentById(facts: readonly FactItem[]) {
  return new Map(facts.map((fact) => [fact.factId, fact.factText]));
}

function factVersionsOf(snapshot: ReturnType<SqliteContextEngineRepository["getDebugSnapshot"]>) {
  return snapshot.factVersions ?? [];
}

function temporalSnapshot(fact: FactItem) {
  return {
    evidenceTimeStart: fact.evidenceTimeStart,
    evidenceTimeEnd: fact.evidenceTimeEnd,
    validTimeStart: fact.validTimeStart,
    validTimeEnd: fact.validTimeEnd,
    observedAt: fact.observedAt
  };
}

function hashId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function assertAcceptance(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
