import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocomoDataset,
  evaluateLocomoFactRetrieval,
  locomoPrincipalId,
  locomoObservationFactId,
  locomoSessionEventId,
  locomoUtteranceSegmentId,
  prepareLocomoRetrievalStore,
  type LocomoSample
} from "./locomo-retrieval-benchmark.js";
import { createDeterministicTestEmbeddingClient } from "./embedding.js";
import { refreshLongTermMemoryIndex } from "./indexing.js";
import { InMemoryContextEngineRepository } from "./persistence/memory-repository.js";
import { parseLocomoRetrievalArgs } from "./locomo-retrieval-benchmark-cli.js";

test("LoCoMo CLI defaults to STM/LTM retrieval with memory reranking", () => {
  const defaults = parseLocomoRetrievalArgs(["node", "locomo", "evaluate"]);
  assert.equal(defaults.memoryOnly, true);
  assert.equal(defaults.memoryReranker, true);
  assert.equal(defaults.skipDreaming, true);

  const historical = parseLocomoRetrievalArgs([
    "node",
    "locomo",
    "evaluate",
    "--fact-retrieval",
    "--no-memory-reranker"
  ]);
  assert.equal(historical.memoryOnly, false);
  assert.equal(historical.memoryReranker, false);
});

function fixture(): LocomoSample {
  return {
    sample_id: "conv-test",
    conversation: {
      speaker_a: "Caroline",
      speaker_b: "Melanie",
      session_1_date_time: "1:56 pm on 8 May, 2023",
      session_1: [{
        speaker: "Caroline",
        dia_id: "D1:3",
        text: "I went to an LGBTQ support group yesterday."
      }]
    },
    qa: [{
      question: "When did Caroline go to the LGBTQ support group?",
      answer: "7 May 2023",
      evidence: ["D1:3"],
      category: 2
    }],
    observation: {
      session_1_observation: {
        Caroline: [["Caroline went to an LGBTQ support group.", "D1:3"]]
      }
    }
  };
}

test("LoCoMo adapter creates session events with utterance-level gold provenance", () => {
  const dataset = buildLocomoDataset([fixture()]);
  assert.equal(dataset.events.length, 1);
  assert.equal(dataset.events[0]?.eventId, locomoSessionEventId("conv-test", "session_1"));
  assert.equal(dataset.events[0]?.multimodalData.length, 1);
  assert.equal(dataset.cases.length, 1);
  assert.equal(dataset.facts.length, 1);
  assert.equal(dataset.facts[0]?.goldFactId, locomoObservationFactId(
    "conv-test",
    "Caroline went to an LGBTQ support group.",
    ["D1:3"]
  ));
  assert.equal(dataset.cases[0]?.goldFacts[0]?.goldFactId, dataset.facts[0]?.goldFactId);
  assert.deepEqual(dataset.cases[0]?.goldFacts[0]?.evidenceSegmentIds, [
    locomoUtteranceSegmentId("conv-test", "session_1", "D1:3")
  ]);
  assert.equal(dataset.cases[0]?.principalId, locomoPrincipalId("conv-test"));
});

test("LoCoMo adapter disambiguates observations sharing one evidence utterance", () => {
  const sample = fixture();
  sample.conversation.session_1 = [{
    speaker: "Caroline",
    dia_id: "D1:3",
    text: "I started transitioning and gave a speech at school."
  }];
  sample.qa = [{
    question: "When did Caroline give a speech at school?",
    answer: "Yesterday",
    evidence: ["D1:3"]
  }];
  sample.observation = {
    session_1_observation: {
      Caroline: [
        ["Caroline started transitioning.", "D1:3"],
        ["Caroline gave a speech at a school.", "D1:3"]
      ]
    }
  };
  const dataset = buildLocomoDataset([sample]);
  assert.deepEqual(dataset.cases[0]?.goldFacts.map((fact) => fact.claim), [
    "Caroline gave a speech at a school."
  ]);
});

test("LoCoMo Fact corpus includes distractors and reuses stable IDs across questions", () => {
  const sample = fixture();
  sample.conversation.session_1 = [
    ...sample.conversation.session_1 as LocomoSample["conversation"][string] & unknown[],
    { speaker: "Melanie", dia_id: "D1:4", text: "I painted a lake sunrise." }
  ];
  sample.qa.push({
    question: "Where did Caroline go?",
    answer: "An LGBTQ support group",
    evidence: ["D1:3"]
  });
  sample.observation = {
    session_1_observation: {
      Caroline: [["Caroline went to an LGBTQ support group.", "D1:3"]],
      Melanie: [["Melanie painted a lake sunrise.", "D1:4"]]
    }
  };
  const dataset = buildLocomoDataset([sample]);
  assert.equal(dataset.facts.length, 2);
  assert.equal(dataset.cases[0]?.goldFacts[0]?.goldFactId, dataset.cases[1]?.goldFacts[0]?.goldFactId);
  assert.equal(dataset.cases.some((item) => item.goldFacts.some((fact) => fact.claim.includes("lake sunrise"))), false);
  assert.equal(dataset.facts.some((fact) => fact.claim.includes("lake sunrise")), true);
});

test("LoCoMo observation Facts go directly through current STM admission and indexing", async () => {
  const repository = new InMemoryContextEngineRepository();
  const dataset = buildLocomoDataset([fixture()]);
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  const preparation = await prepareLocomoRetrievalStore(repository, dataset, {
    admissionOptions: {
      disableStmAdmissionLlm: true,
      embeddingClient
    }
  });
  const snapshot = repository.getDebugSnapshot();
  assert.equal(preparation.ingestedEventCount, 1);
  assert.deepEqual(preparation.validity, {
    fullPipelineCompleted: false,
    reasons: ["stm_admission_fallback", "dreaming_skipped"]
  });
  assert.deepEqual(preparation.dreaming, {
    enabled: false,
    batchCount: 0,
    candidateCount: 0,
    generatedLongTermMemoryCount: 0
  });
  assert.equal(snapshot.memoryEvents.length, 1);
  assert.equal(snapshot.facts.length, 1);
  assert.equal(snapshot.facts[0]?.factId, dataset.facts[0]?.goldFactId);
  assert.equal(snapshot.facts[0]?.factText, "Caroline went to an LGBTQ support group.");
  assert.equal(snapshot.facts[0]?.linkedSegmentIds[0], locomoUtteranceSegmentId("conv-test", "session_1", "D1:3"));
  assert.equal(snapshot.llmFactFusionTraces.length, 0);
  assert.equal(snapshot.shortTermMemories.length, 1);
  assert.equal(snapshot.indexEntries.some((entry) => entry.ownerType === "stm"), true);
});

test("LoCoMo evaluation ranks gold Facts through returned STM and LTM", async () => {
  const repository = new InMemoryContextEngineRepository();
  const dataset = buildLocomoDataset([fixture()]);
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  await prepareLocomoRetrievalStore(repository, dataset, {
    skipDreaming: true,
    admissionOptions: {
      disableStmAdmissionLlm: true,
      embeddingClient
    }
  });
  const stm = repository.getDebugSnapshot().shortTermMemories[0]!;
  const ltm = {
    memoryId: "ltm_locomo_test",
    tenantId: stm.tenantId,
    principalId: stm.principalId,
    theoryClass: "episodic" as const,
    memoryType: "event",
    content: stm.content,
    sourceRefs: stm.sourceRefs,
    sourceMemoryDataIds: [stm.memoryDataId],
    sourceFactIds: stm.sourceFactIds,
    entityIds: [],
    confidenceLevel: "high" as const,
    recallWeight: "high" as const,
    solidifyReason: "test",
    matchedRules: ["test"],
    lifecycleStatus: "active" as const
  };
  await repository.saveLongTermMemory(ltm);
  await refreshLongTermMemoryIndex(repository, ltm, embeddingClient);

  const report = await evaluateLocomoFactRetrieval(repository, dataset, {
    embeddingClient,
    factCandidatesEnabled: false,
    memoryReranker: {
      model: "test-memory-reranker",
      async rerank(_query, documents) {
        return documents.map((document, index) => ({
          id: document.id,
          score: 1 - index / Math.max(1, documents.length),
          originalRank: index + 1
        }));
      }
    },
    limit: 100,
    ks: [1, 100]
  });
  assert.equal(report.schemaVersion, "locomo-fact-retrieval.v3");
  assert.equal(report.retrieval.factCandidatesEnabled, false);
  assert.equal(report.retrieval.memoryRerankerEnabled, true);
  assert.equal(report.retrieval.memoryRerankerModel, "test-memory-reranker");
  assert.equal(report.retrieval.memoryRerankerFallbackCaseCount, 0);
  assert.equal(report.dataset.evaluableCaseCount, 1);
  assert.equal(report.cases[0]?.goldFacts[0]?.goldFactId, dataset.facts[0]?.goldFactId);
  assert.equal(report.cases[0]?.candidates[0]?.matchedGoldFactIds[0], dataset.facts[0]?.goldFactId);
  assert.equal(report.metrics.all[1]?.recallAtK, 1);
  assert.equal((report.metrics.stm[1]?.recallAtK ?? 0) + (report.metrics.ltm[1]?.recallAtK ?? 0), 1);
  assert.equal(report.cases[0]?.candidates.some((candidate) => candidate.layer === "fact"), false);
  assert.equal(report.selection.evidenceLimit, 20);
  assert.equal(report.cases[0]?.selection.selectedCandidates.length, 1);
  assert.equal(report.cases[0]?.selection.selectedCandidates[0]?.matchedGoldFactIds[0], dataset.facts[0]?.goldFactId);
  assert.equal(report.cases[0]?.selection.selectedCandidates[0]?.retrievalRank, 1);
  assert.equal(report.cases[0]?.selection.selectedCandidates[0]?.selectionRank, 1);
  assert.equal(report.selectionMetrics.all.at(-1)?.recallAtK, 1);
  assert.deepEqual(report.funnel, {
    goldFactCount: 1,
    retrievedGoldFactCount: 1,
    selectedGoldFactCount: 1,
    selectedFromRetrievedRate: 1,
    casesWithAnyRetrieved: 1,
    casesWithAnySelected: 1
  });
  assert.equal(report.cases[0]?.diagnostics[0]?.status, "retrieved");
  assert.equal(report.cases[0]?.diagnostics[0]?.selectionStatus, "selected");
  assert.deepEqual(report.cases[0]?.diagnostics[0]?.selectionRanks, [1]);
  assert.equal(
    (report.cases[0]?.diagnostics[0]?.stmCandidateRanks.length ?? 0) +
      (report.cases[0]?.diagnostics[0]?.ltmCandidateRanks.length ?? 0),
    1
  );
  assert.match(report.cases[0]?.diagnostics[0]?.droppedOwnerReasons[0] ?? "", /duplicate_of:/u);
});

test("LoCoMo evaluation separates Top-100 retrieval from final evidence selection", async () => {
  const repository = new InMemoryContextEngineRepository();
  const dataset = buildLocomoDataset([fixture()]);
  const embeddingClient = createDeterministicTestEmbeddingClient(32);
  await prepareLocomoRetrievalStore(repository, dataset, {
    skipDreaming: true,
    admissionOptions: {
      disableStmAdmissionLlm: true,
      embeddingClient
    }
  });

  const report = await evaluateLocomoFactRetrieval(repository, dataset, {
    embeddingClient,
    limit: 100,
    ks: [100],
    selectionKs: [8],
    selectionTokenBudget: 100
  });

  assert.equal(report.metrics.all[0]?.recallAtK, 1);
  assert.equal(report.selectionMetrics.all[0]?.recallAtK, 0);
  assert.equal(report.cases[0]?.diagnostics[0]?.selectionStatus, "retrieved_not_selected");
  assert.equal(report.cases[0]?.diagnostics[0]?.selectionRejectionReasons.some((reason) => reason.endsWith(":budget")), true);
  assert.equal(report.funnel.retrievedGoldFactCount, 1);
  assert.equal(report.funnel.selectedGoldFactCount, 0);
  assert.equal(report.funnel.selectedFromRetrievedRate, 0);
});
