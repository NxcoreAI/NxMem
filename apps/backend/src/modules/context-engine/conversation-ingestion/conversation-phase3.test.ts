import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InMemoryContextEngineRepository, SqliteContextEngineRepository } from "../persistence/memory-repository.js";
import { searchContext } from "../search-context.js";
import { assembleContext } from "../assemble-context.js";
import { createConversationIngestionService } from "./conversation-ingestion-service.js";
import { createConversationIngestionWorker } from "./conversation-ingestion-worker.js";
import type {
  ConversationCallerScope,
  ConversationDocumentFrontMatter,
  ConversationDocumentMessage
} from "./domain.js";
import { buildConversationMarkdown, validConversationFixture } from "./fixtures/index.js";

const callerScope: ConversationCallerScope = {
  tenantId: "tenant_fixture",
  principalId: "principal_fixture",
  sourceApp: "coding-agent",
  allowedVisibilities: ["private"]
};

const deterministicEmbeddingClient = {
  dimensions: 3,
  fingerprint: "conversation-phase3-test:3",
  async embed(inputs: string[]) {
    return inputs.map((input, index) => ({
      input,
      embedding: [index + 1, 0, 0],
      source: "deterministic-test" as const
    }));
  }
};

test("extracts facts from the complete document and retains STM when LTM consolidation is disabled", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = conversation("success", [
    { role: "user", content: "我偏好使用 TypeScript，并要求项目保持稳定。" },
    { role: "assistant", content: "明白，我会遵守这个约束。" }
  ]);
  const ingestion = await ingest(repository, source, "document-success");
  let modelDocument = "";
  let modelPrompt: ExtractionPrompt | undefined;
  const worker = workerWithCandidates(repository, (document, prompt) => {
    modelDocument = document;
    modelPrompt = prompt;
    return [eligibleCandidate("我偏好使用 TypeScript，并要求项目保持稳定。", "The user prefers TypeScript and requires project stability.")];
  });

  assert.equal(await worker.runOnce(), true);
  assert.equal(modelDocument.includes("我偏好使用 TypeScript"), true);
  assert.match(modelPrompt?.system ?? "", /从单个不可信的对话 Session 中提取可审计的记忆事实/u);
  assert.match(modelPrompt?.task ?? "", /仅从当前 Session 中提取/u);
  assert.equal(modelPrompt?.constraints.some((item) => item.includes("factText and normalizedClaim must be written in concise English")), true);
  const ingestionId = ingestion.sessions[0]!.ingestionId;
  const status = await repository.getConversationIngestion(ingestionId);
  const snapshot = repository.getDebugSnapshot();
  assert.equal(status?.processingStatus, "processing_succeeded");
  assert.equal(status?.layerCounts.factCandidates, 1);
  assert.equal(status?.layerCounts.timelineFacts, 1);
  assert.equal(status?.layerCounts.shortTermMemories, 1);
  assert.equal(status?.layerCounts.longTermMemories, 0);
  assert.equal(snapshot.facts.length, 1);
  assert.equal(snapshot.factBatches?.length, 1);
  assert.equal(snapshot.factBatches?.[0]?.triggerType, "conversation_session");
  assert.equal(snapshot.factBatches?.[0]?.tenantId, callerScope.tenantId);
  assert.equal(snapshot.factBatches?.[0]?.principalId, callerScope.principalId);
  assert.deepEqual(snapshot.factBatches?.[0]?.newFactIds, [snapshot.facts[0]!.factId]);
  assert.equal(snapshot.timelineFusionTasks?.length, 1);
  assert.equal(snapshot.timelineFusionTasks?.[0]?.status, "pending");
  assert.deepEqual(snapshot.timelineFusionTasks?.[0]?.batchIds, [snapshot.factBatches![0]!.batchId]);
  assert.equal(snapshot.facts[0]?.schemaVersion, "conversation-document-fact.v2");
  assert.deepEqual(snapshot.facts[0]?.linkedSegmentIds, []);
  assert.equal(snapshot.facts[0]?.linkedSourceRefs[0]?.sourceType, "conversation_message");
  assert.equal(snapshot.facts[0]?.validTimeStart, undefined);
  assert.equal(snapshot.facts[0]?.evidenceTimeConfidence, "low");
  assert.deepEqual(snapshot.facts[0]?.sourceMessageIds, [repository.conversationMessages[0]?.messageId]);
  assert.equal(snapshot.memoryEvents[0]?.eventTime, repository.conversationMessages.at(-1)?.createdAt);
  assert.equal(snapshot.memoryEvents[0]?.customFields?.eventTimeConfidence, "low");
  assert.equal(snapshot.shortTermMemories.length, 1);
  assert.equal(snapshot.longTermMemories.length, 0);
  assert.equal(snapshot.indexEntries.some((entry) => entry.ownerType === "stm"), true);
  assert.equal(snapshot.indexEntries.some((entry) => entry.ownerType === "ltm"), false);
  assert.equal(snapshot.parsedSegments.length, 0);
  assert.equal(repository.conversationMessages.length, 2);
});

test("same-session semantic fusion preserves original facts and admits only fused plus unused facts", async () => {
  const repository = new InMemoryContextEngineRepository();
  const messages: ConversationDocumentMessage[] = [
    { role: "user", content: "我喜欢在通勤时听有声书。" },
    { role: "user", content: "我使用 Audible。" },
    { role: "user", content: "我每天通勤单程 45 分钟，在通勤时听有声书。" },
    { role: "user", content: "我觉得有声书比电子书更容易记住，并开始做笔记。" },
    { role: "user", content: "我正在阅读《消失的爱人》。" },
    { role: "assistant", content: "我介绍了《夜莺》。" }
  ];
  const source = conversation("same-session-fusion", messages);
  const ingestion = await ingest(repository, source, "document-same-session-fusion");
  const normalizedClaims = [
    "The user likes listening to audiobooks while commuting.",
    "The user uses Audible.",
    "The user listens to audiobooks during a daily 45-minute one-way commute.",
    "The user remembers audiobooks better than ebooks and has started taking notes.",
    "The user is reading Gone Girl.",
    "The assistant introduced The Nightingale."
  ];

  const worker = workerWithCandidates(
    repository,
    () => messages.map((message, index) => eligibleCandidate(message.content, normalizedClaims[index]!)),
    undefined,
    (prompt) => {
      const facts = prompt.inputGroups.flatMap((group) => group.facts);
      const sourceFactIds = facts
        .filter((fact) => normalizedClaims.slice(0, 4).includes(fact.factText))
        .map((fact) => fact.factId);
      return [{
        factText: "The user listens to audiobooks on Audible during a daily 45-minute one-way commute, remembers them better than ebooks, and has started taking notes.",
        normalizedClaim: "The user listens to Audible during a daily 45-minute one-way commute, remembers audiobooks better than ebooks, and takes notes.",
        sourceFactIds,
        confidenceLevel: "high"
      }];
    },
    deterministicEmbeddingClient
  );

  assert.equal(await worker.runOnce(), true);

  const snapshot = repository.getDebugSnapshot();
  const originals = snapshot.facts.filter((fact) => fact.schemaVersion === "conversation-document-fact.v2");
  const fused = snapshot.facts.filter((fact) => fact.schemaVersion === "timeline-fused-fact.v1");
  const status = await repository.getConversationIngestion(ingestion.sessions[0]!.ingestionId);
  assert.equal(originals.length, 6);
  assert.equal(originals.every((fact) => fact.status === "active"), true);
  assert.equal(fused.length, 1);
  assert.match(fused[0]?.factText ?? "", /daily 45-minute one-way commute/u);
  assert.match(fused[0]?.factText ?? "", /Audible/u);
  assert.equal(status?.layerCounts.facts, 6);
  assert.equal(status?.layerCounts.timelineFacts, 3);
  assert.equal(status?.layerCounts.shortTermMemories, 3);
  assert.deepEqual(
    snapshot.shortTermMemories.map((memory) => memory.sourceFactIds[0]).sort(),
    [fused[0]!.factId, originals[4]!.factId, originals[5]!.factId].sort()
  );
  assert.equal(
    snapshot.shortTermMemories.some((memory) => originals.slice(0, 4).some((fact) => memory.sourceFactIds.includes(fact.factId))),
    false
  );
});

test("keeps invalid document quotes fact_pending without creating fallback facts", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = conversation("bad-quote", [{ role: "user", content: "我偏好简洁的 API。" }]);
  const ingestion = await ingest(repository, source, "document-bad-quote");
  const worker = workerWithCandidates(repository, () => [
    eligibleCandidate("这段话不在原始文档中", "The user prefers concise APIs.")
  ]);

  await worker.runOnce();
  const status = await repository.getConversationIngestion(ingestion.sessions[0]!.ingestionId);
  assert.equal(status?.processingStatus, "fact_pending");
  assert.equal(status?.lastError?.code, "FACT_OUTPUT_INVALID");
  assert.equal(repository.getDebugSnapshot().facts.length, 0);
  assert.equal(repository.getDebugSnapshot().shortTermMemories.length, 0);
  assert.equal(
    repository.getDebugSnapshot().llmFactFusionTraces[0]?.fallbackReason,
    "document_candidate_validation_failed:evidence_quote_not_found_in_source_message"
  );
  assert.deepEqual(
    repository.getDebugSnapshot().llmFactFusionTraces[0]?.temporal?.errorCodes,
    ["TEMPORAL_QUOTE_MISMATCH"]
  );
});

test("derives evidence, event-relative valid, and observed time from persisted extended messages", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = extendedConversation("relative-time", [{
    messageId: "msg_relative_user",
    role: "user",
    content: "我明天去深圳。",
    createdAt: "2026-07-23T15:30:00+08:00"
  }]);
  const ingestion = await ingest(repository, source, "document-relative-time");
  const observedAt = "2026-07-25T09:00:00.000Z";
  let capturedPrompt: ExtractionPrompt | undefined;

  await workerWithCandidates(repository, (_document, prompt) => {
    capturedPrompt = prompt;
    return [{
      ...eligibleCandidate("我明天去深圳。", "The user plans to travel to Shenzhen on July 24, 2026."),
      factType: "travel_plan",
      sourceMessageIds: [prompt.messages[0]!.messageId],
      validTimeStart: "2026-07-24T00:00:00+08:00",
      validTimeEnd: null,
      validTimeBasis: "event_relative",
      validTimeConfidence: "high"
    }];
  }, observedAt).runOnce();

  const message = (await repository.getConversationMessages(ingestion.sessions[0]!.ingestionId))[0]!;
  const fact = repository.getDebugSnapshot().facts[0]!;
  const event = repository.getDebugSnapshot().memoryEvents[0]!;
  assert.equal(capturedPrompt?.referenceTimezone, "Asia/Shanghai");
  assert.equal(capturedPrompt?.locale, "zh-CN");
  assert.deepEqual(capturedPrompt?.messages[0], {
    messageId: "msg_relative_user",
    role: "user",
    content: "我明天去深圳。",
    createdAt: "2026-07-23T15:30:00+08:00"
  });
  assert.equal(fact.evidenceTimeStart, message.createdAt);
  assert.equal(fact.evidenceTimeEnd, message.createdAt);
  assert.equal(fact.evidenceTimeConfidence, "high");
  assert.equal(fact.validTimeStart, "2026-07-24T00:00:00+08:00");
  assert.equal(fact.validTimeBasis, "event_relative");
  assert.equal(fact.validTimeConfidence, "high");
  assert.equal(fact.observedAt, observedAt);
  assert.equal(fact.linkedSourceRefs[0]?.sourceId, message.conversationMessageRowId);
  assert.equal(fact.linkedSourceRefs[0]?.metadata?.messageId, message.messageId);
  assert.equal(event.eventTime, message.createdAt);
  assert.equal(event.customFields?.eventTimeStart, message.createdAt);
  assert.equal(event.customFields?.eventTimeEnd, message.createdAt);
  assert.equal(event.customFields?.eventTimeConfidence, "high");
});

test("keeps valid time empty for source-time facts without semantic dates", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = extendedConversation("source-time", [{
    messageId: "msg_source_time",
    role: "user",
    content: "我偏好简洁的 API。",
    createdAt: "2026-07-23T16:00:00+08:00"
  }]);
  const ingestion = await ingest(repository, source, "document-source-time");

  await workerWithCandidates(repository, (_document, prompt) => [{
    ...eligibleCandidate("我偏好简洁的 API。", "The user prefers concise APIs."),
    sourceMessageIds: [prompt.messages[0]!.messageId],
    validTimeBasis: "source_time",
    validTimeConfidence: "low"
  }]).runOnce();

  const message = (await repository.getConversationMessages(ingestion.sessions[0]!.ingestionId))[0]!;
  const fact = repository.getDebugSnapshot().facts[0]!;
  assert.equal(fact.validTimeStart, undefined);
  assert.equal(fact.validTimeEnd, undefined);
  assert.equal(fact.evidenceTimeStart, message.createdAt);
  assert.equal(fact.evidenceTimeConfidence, "high");
  assert.equal(fact.timeBasis, "source_time");
  assert.equal(fact.timeConfidence, "low");
});

test("aggregates multiple source messages and preserves absolute valid time", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = extendedConversation("multi-source", [
    {
      messageId: "msg_multi_1",
      role: "user",
      content: "我计划 8 月 1 日去深圳。",
      createdAt: "2026-07-23T15:30:00+08:00"
    },
    {
      messageId: "msg_multi_2",
      role: "user",
      content: "从郑州出发。",
      createdAt: "2026-07-23T16:00:00+08:00"
    }
  ]);
  const ingestion = await ingest(repository, source, "document-multi-source");

  await workerWithCandidates(repository, (_document, prompt) => [{
    ...eligibleCandidate("我计划 8 月 1 日去深圳。", "The user plans to travel from Zhengzhou to Shenzhen on August 1, 2026."),
    factType: "travel_plan",
    sourceMessageIds: prompt.messages.map((message) => message.messageId),
    evidenceQuotes: ["我计划 8 月 1 日去深圳。", "从郑州出发。"],
    validTimeStart: "2026-08-01T00:00:00+08:00",
    validTimeEnd: null,
    validTimeBasis: "absolute",
    validTimeConfidence: "high"
  }]).runOnce();

  const messages = await repository.getConversationMessages(ingestion.sessions[0]!.ingestionId);
  const fact = repository.getDebugSnapshot().facts[0]!;
  assert.equal(fact.evidenceTimeStart, messages[0]!.createdAt);
  assert.equal(fact.evidenceTimeEnd, messages[1]!.createdAt);
  assert.deepEqual(fact.sourceMessageIds, ["msg_multi_1", "msg_multi_2"]);
  assert.deepEqual(
    fact.linkedSourceRefs.map((ref) => ref.sourceId),
    messages.map((message) => message.conversationMessageRowId)
  );
  assert.equal(fact.validTimeStart, "2026-08-01T00:00:00+08:00");
  assert.equal(fact.validTimeBasis, "absolute");
});

test("accepts the July 23 message and August 1 Shenzhen temporal flow end to end", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = extendedConversation("shenzhen-acceptance", [{
    messageId: "msg_shenzhen_acceptance",
    role: "user",
    content: "我计划 8 月 1 日从郑州去深圳。",
    createdAt: "2026-07-23T15:30:00+08:00"
  }]);
  const ingestion = await ingest(repository, source, "document-shenzhen-acceptance");
  const observedAt = "2026-07-25T09:00:00.000Z";
  await workerWithCandidates(repository, (_document, prompt) => [{
    ...eligibleCandidate("我计划 8 月 1 日从郑州去深圳。", "The user plans to travel from Zhengzhou to Shenzhen on August 1, 2026."),
    factType: "travel_plan",
    sourceMessageIds: [prompt.messages[0]!.messageId],
    validTimeStart: "2026-08-01T00:00:00+08:00",
    validTimeEnd: null,
    validTimeBasis: "absolute",
    validTimeConfidence: "high"
  }], observedAt).runOnce();

  const ingestionId = ingestion.sessions[0]!.ingestionId;
  const message = (await repository.getConversationMessages(ingestionId))[0]!;
  const fact = repository.getDebugSnapshot().facts[0]!;
  assert.equal(message.createdAt, "2026-07-23T15:30:00+08:00");
  assert.equal(fact.evidenceTimeStart, message.createdAt);
  assert.equal(fact.validTimeStart, "2026-08-01T00:00:00+08:00");
  assert.equal(fact.observedAt, observedAt);

  const validSearch = await searchContext(repository, {
    q: "我什么时候去深圳",
    layer: "all",
    tenantId: callerScope.tenantId,
    principalId: callerScope.principalId,
    timeRange: {
      startTime: "2026-07-31T16:00:00.000Z",
      endTime: "2026-08-01T16:00:00.000Z",
      basis: "valid"
    }
  });
  assert.equal(validSearch.results.some((item) =>
    item.temporal.matchedBasis === "valid" && item.temporal.validTimeStart === fact.validTimeStart
  ), true);

  const evidenceSearch = await searchContext(repository, {
    q: "7 月 23 日我们聊了什么 深圳",
    layer: "evidence",
    tenantId: callerScope.tenantId,
    principalId: callerScope.principalId,
    timeRange: {
      startTime: "2026-07-22T16:00:00.000Z",
      endTime: "2026-07-23T16:00:00.000Z",
      basis: "evidence"
    }
  });
  assert.equal(evidenceSearch.results.length, 1);
  assert.equal(evidenceSearch.results[0]?.sourceRefs[0]?.metadata?.messageId, message.messageId);
  assert.equal(evidenceSearch.results[0]?.temporal.matchedBasis, "evidence");

  const pack = await assembleContext(repository, {
    task: "确认深圳出行计划",
    q: "深圳",
    tenantId: callerScope.tenantId,
    principalId: callerScope.principalId,
    referenceTime: observedAt,
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    tokenBudget: 800
  });
  assert.equal(pack.citations.some((citation) => citation.sourceId === message.conversationMessageRowId), true);
  assert.equal(pack.recentContext.some((item) => item.sourceMessageIds.includes(message.messageId)), true);
});

test("rejects cross-session message IDs and holds unrecomputable relative time for verification", async () => {
  const crossSessionRepository = new InMemoryContextEngineRepository();
  const crossSessionSource = extendedConversation("cross-session", [{
    messageId: "msg_current_session",
    role: "user",
    content: "我明天去深圳。",
    createdAt: "2026-07-23T15:30:00+08:00"
  }]);
  const crossSessionIngestion = await ingest(crossSessionRepository, crossSessionSource, "document-cross-session");
  await workerWithCandidates(crossSessionRepository, () => [{
    ...eligibleCandidate("我明天去深圳。", "The user plans to travel to Shenzhen tomorrow."),
    sourceMessageIds: ["msg_from_other_session"]
  }]).runOnce();
  assert.equal(
    (await crossSessionRepository.getConversationIngestion(crossSessionIngestion.sessions[0]!.ingestionId))?.processingStatus,
    "fact_pending"
  );
  assert.match(
    crossSessionRepository.getDebugSnapshot().llmFactFusionTraces[0]?.fallbackReason ?? "",
    /source_message_id_not_found_in_ingestion/u
  );
  assert.deepEqual(
    crossSessionRepository.getDebugSnapshot().llmFactFusionTraces[0]?.temporal?.errorCodes,
    ["TEMPORAL_SOURCE_NOT_FOUND"]
  );

  const pendingRepository = new InMemoryContextEngineRepository();
  const pendingSource = extendedConversation("relative-pending", [{
    messageId: "msg_relative_pending",
    role: "user",
    content: "我明天去深圳。",
    createdAt: "2026-07-23T15:30:00+08:00"
  }]);
  const pendingIngestion = await ingest(pendingRepository, pendingSource, "document-relative-pending");
  await workerWithCandidates(pendingRepository, (_document, prompt) => [{
    ...eligibleCandidate("我明天去深圳。", "The user plans to travel to Shenzhen on July 25, 2026."),
    sourceMessageIds: [prompt.messages[0]!.messageId],
    validTimeStart: "2026-07-25T00:00:00+08:00",
    validTimeBasis: "event_relative",
    validTimeConfidence: "high"
  }]).runOnce();
  const pendingStatus = await pendingRepository.getConversationIngestion(pendingIngestion.sessions[0]!.ingestionId);
  assert.equal(pendingStatus?.processingStatus, "processing_succeeded");
  assert.equal(pendingStatus?.layerCounts.factPending, 1);
  assert.equal(pendingRepository.getDebugSnapshot().facts.length, 0);
});

test("persists English canonical fact text", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = conversation("english-fact", [{ role: "user", content: "我计划八月初从郑州去深圳。" }]);
  const ingestion = await ingest(repository, source, "document-english-fact");
  const worker = workerWithCandidates(repository, () => [{
    ...eligibleCandidate("我计划八月初从郑州去深圳。", "User plans to travel from Zhengzhou to Shenzhen in early August."),
    factText: "User plans to travel from Zhengzhou to Shenzhen in early August."
  }]);

  await worker.runOnce();

  const status = await repository.getConversationIngestion(ingestion.sessions[0]!.ingestionId);
  assert.equal(status?.processingStatus, "processing_succeeded");
  assert.equal(repository.getDebugSnapshot().facts.length, 1);
  assert.equal(repository.getDebugSnapshot().facts[0]?.factText, "User plans to travel from Zhengzhou to Shenzhen in early August.");
});

test("persists auditable assistant knowledge into searchable memory", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = conversation("assistant-knowledge", [{
    role: "assistant",
    content: "酋长队和美洲虎队有 12 场比赛在箭头体育场举行。"
  }]);
  const ingestion = await ingest(repository, source, "document-assistant-knowledge");
  await workerWithCandidates(repository, () => [{
    ...eligibleCandidate(
      "酋长队和美洲虎队有 12 场比赛在箭头体育场举行。",
      "The Chiefs and Jaguars played 12 games at Arrowhead Stadium."
    ),
    factType: "assistant_knowledge",
    epistemicStatus: "agent_inferred",
    subject: "堪萨斯城酋长队与杰克逊维尔美洲虎队"
  }]).runOnce();

  const status = await repository.getConversationIngestion(ingestion.sessions[0]!.ingestionId);
  const snapshot = repository.getDebugSnapshot();
  assert.equal(status?.processingStatus, "processing_succeeded");
  assert.equal(status?.layerCounts.factCandidates, 1);
  assert.equal(snapshot.facts.length, 1);
  assert.equal(snapshot.facts[0]?.factType, "assistant_knowledge");
  assert.equal(snapshot.shortTermMemories.length, 1);
  assert.equal(snapshot.indexEntries.some((entry) =>
    entry.ownerType === "stm" && entry.content.includes("Arrowhead Stadium")
  ), true);
});

test("keeps assistant user-profile inference as evidence-only and sensitive secrets out of active memory", async () => {
  const inferredRepository = new InMemoryContextEngineRepository();
  const inferredSource = conversation("inferred", [{ role: "assistant", content: "用户一定喜欢深色模式。" }]);
  const inferredIngestion = await ingest(inferredRepository, inferredSource, "document-inferred");
  await workerWithCandidates(inferredRepository, () => [{
    ...eligibleCandidate("用户一定喜欢深色模式。", "The user likes dark mode."),
    epistemicStatus: "agent_inferred"
  }]).runOnce();
  const inferredStatus = await inferredRepository.getConversationIngestion(inferredIngestion.sessions[0]!.ingestionId);
  assert.equal(inferredStatus?.processingStatus, "processing_succeeded");
  assert.equal(inferredStatus?.layerCounts.factCandidates, 1);
  assert.equal(inferredRepository.getDebugSnapshot().facts.length, 0);

  const secretRepository = new InMemoryContextEngineRepository();
  const secretSource = conversation("secret", [{ role: "user", content: "我的 password 是 super-secret-123。" }]);
  const secretIngestion = await ingest(secretRepository, secretSource, "document-secret");
  await workerWithCandidates(secretRepository, () => [
    eligibleCandidate("我的 password 是 super-secret-123。", "The user's password is super-secret-123.")
  ]).runOnce();
  assert.equal(secretRepository.getDebugSnapshot().facts.length, 0);
  assert.equal((await secretRepository.getConversationIngestion(secretIngestion.sessions[0]!.ingestionId))?.layerCounts.sensitivePendingConfirmation, 1);
});

test("preserves the document and processing result across SQLite restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-document-phase3-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const writer = new SqliteContextEngineRepository(storePath);
    const source = conversation("sqlite", [{ role: "user", content: "我偏好稳定的事实 ID。" }]);
    const ingestion = await ingest(writer, source, "document-sqlite");
    await workerWithCandidates(writer, () => [
      eligibleCandidate("我偏好稳定的事实 ID。", "The user prefers stable fact IDs.")
    ]).runOnce();
    writer.close();

    const reader = new SqliteContextEngineRepository(storePath);
    const ingestionId = ingestion.sessions[0]!.ingestionId;
    assert.equal((await reader.getConversationDocument(ingestionId))?.rawMarkdown, source.document);
    assert.equal((await reader.getConversationMessages(ingestionId)).length, 1);
    assert.equal(reader.conversationMessages.length, 1);
    assert.equal((await reader.getConversationIngestion(ingestionId))?.processingStatus, "processing_succeeded");
    const restoredFact = reader.getDebugSnapshot().facts[0];
    assert.equal(restoredFact?.linkedSourceRefs[0]?.sourceType, "conversation_message");
    assert.equal(restoredFact?.validTimeStart, undefined);
    assert.equal(restoredFact?.evidenceTimeStart, (await reader.getConversationMessages(ingestionId))[0]?.createdAt);
    assert.equal(restoredFact?.evidenceTimeConfidence, "low");
    assert.equal(restoredFact?.sourceMessageIds?.length, 1);
    assert.equal(reader.getDebugSnapshot().factBatches?.length, 1);
    assert.deepEqual(reader.getDebugSnapshot().factBatches?.[0]?.newFactIds, [restoredFact!.factId]);
    assert.equal(reader.getDebugSnapshot().timelineFusionTasks?.length, 1);
    reader.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rebuilds legacy fact_items idempotently so valid time can be null", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-fact-temporal-migration-"));
  const storePath = join(directory, "context.sqlite");
  try {
    const legacy = new DatabaseSync(storePath);
    legacy.exec(`
      CREATE TABLE fact_items (
        fact_id TEXT PRIMARY KEY,
        fact_type TEXT NOT NULL,
        fact_text TEXT NOT NULL,
        normalized_claim TEXT NOT NULL,
        linked_event_ids TEXT NOT NULL DEFAULT '[]',
        linked_segment_ids TEXT NOT NULL DEFAULT '[]',
        linked_source_refs TEXT NOT NULL DEFAULT '[]',
        entity_ids TEXT NOT NULL DEFAULT '[]',
        confidence_level TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        observed_at TEXT NOT NULL,
        valid_time_start TEXT NOT NULL,
        valid_time_end TEXT,
        time_basis TEXT NOT NULL,
        time_confidence TEXT NOT NULL,
        schema_version TEXT NOT NULL
      );
      INSERT INTO fact_items VALUES (
        'legacy_fact', 'preference', '用户偏好 TypeScript', '用户偏好 TypeScript',
        '[]', '[]', '[]', '[]', 'high', 1, 'active',
        '2026-07-20T00:00:00.000Z', '2026-07-19T00:00:00.000Z', NULL,
        'source_time', 'high', 'fact-item.v1'
      );
    `);
    legacy.close();

    const first = new SqliteContextEngineRepository(storePath);
    const migrated = first.getDebugSnapshot().facts[0];
    assert.equal(migrated?.factId, "legacy_fact");
    assert.equal(migrated?.validTimeStart, "2026-07-19T00:00:00.000Z");
    assert.equal(migrated?.validTimeBasis, "source_time");
    assert.equal(migrated?.validTimeConfidence, "high");
    assert.equal(migrated?.evidenceTimeStart, undefined);
    first.close();

    const second = new SqliteContextEngineRepository(storePath);
    assert.equal(second.getDebugSnapshot().facts.filter((fact) => fact.factId === "legacy_fact").length, 1);
    second.close();

    const verification = new DatabaseSync(storePath);
    const validColumn = verification.prepare("PRAGMA table_info(fact_items)").all()
      .find((column) => (column as { name?: string }).name === "valid_time_start") as { notnull?: number } | undefined;
    assert.equal(validColumn?.notnull, 0);
    verification.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps committed raw evidence pending when no extraction LLM is configured", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = conversation("no-llm", [{ role: "user", content: "我偏好明确的错误信息。" }]);
  const ingestion = await ingest(repository, source, "document-no-llm");
  const worker = createConversationIngestionWorker(repository, {
    workerId: "document-no-llm-worker",
    phase3: { apiKey: "" }
  });
  await worker.runOnce();
  const ingestionId = ingestion.sessions[0]!.ingestionId;
  assert.equal((await repository.getConversationIngestion(ingestionId))?.processingStatus, "fact_pending");
  assert.equal((await repository.getConversationDocument(ingestionId))?.rawMarkdown, source.document);
  assert.equal(repository.getDebugSnapshot().facts.length, 0);
});

test("treats an explicit empty candidates array as a successful extraction", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = conversation("empty-candidates", [{ role: "user", content: "深圳天气怎么样？" }]);
  const ingestion = await ingest(repository, source, "document-empty-candidates");

  await workerWithCandidates(repository, () => []).runOnce();

  const status = await repository.getConversationIngestion(ingestion.sessions[0]!.ingestionId);
  const trace = repository.getDebugSnapshot().llmFactFusionTraces[0];
  assert.equal(status?.processingStatus, "processing_succeeded");
  assert.equal(status?.layerCounts.factCandidates, 0);
  assert.equal(status?.layerCounts.facts, 0);
  assert.equal(repository.getDebugSnapshot().factBatches?.length, 0);
  assert.equal(repository.getDebugSnapshot().timelineFusionTasks?.length, 0);
  assert.equal(status?.lastError, undefined);
  assert.equal(trace?.fallbackReason, undefined);
  assert.match(trace?.traceId ?? "", /_attempt_1$/u);
  assert.deepEqual(trace?.parsedFacts, []);
});

test("persists missing candidates responses for each retry attempt", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = conversation("missing-candidates", [{ role: "user", content: "深圳天气怎么样？" }]);
  const ingestion = await ingest(repository, source, "document-missing-candidates");
  const rawResponse = {
    choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [] }) } }]
  };
  let currentTime = "2026-07-22T03:00:00.000Z";
  const worker = createConversationIngestionWorker(repository, {
    workerId: "document-missing-candidates-worker",
    now: () => currentTime,
    phase3: {
      apiKey: "test-key",
      baseUrl: "https://llm.invalid/v1",
      fetchImpl: fixedExtractionResponse(rawResponse),
      pendingRetryDelayMs: 1_000,
      disableStmAdmissionLlm: true,
      disableLtmConsolidationLlm: true
    }
  });

  assert.equal(await worker.runOnce(), true);
  currentTime = "2026-07-22T03:00:02.000Z";
  assert.equal(await worker.runOnce(), true);

  const status = await repository.getConversationIngestion(ingestion.sessions[0]!.ingestionId);
  const traces = repository.getDebugSnapshot().llmFactFusionTraces;
  assert.equal(status?.processingStatus, "fact_pending");
  assert.equal(status?.lastError?.code, "FACT_OUTPUT_INVALID");
  assert.equal(traces.length, 2);
  assert.deepEqual(traces.map((trace) => trace.traceId).sort(), [
    `llm_document_fusion_${ingestion.sessions[0]!.ingestionId}_attempt_1`,
    `llm_document_fusion_${ingestion.sessions[0]!.ingestionId}_attempt_2`
  ]);
  for (const trace of traces) {
    assert.deepEqual(trace.rawResponse, rawResponse);
    assert.match(trace.fallbackReason ?? "", /response must contain a candidates array/u);
    assert.deepEqual(trace.parsedFacts, []);
  }
});

test("persists invalid JSON response content with a parse-specific failure reason", async () => {
  const repository = new InMemoryContextEngineRepository();
  const source = conversation("invalid-json", [{ role: "user", content: "奥特曼投票结果如何？" }]);
  const ingestion = await ingest(repository, source, "document-invalid-json");
  const rawResponse = {
    choices: [{ message: { role: "assistant", content: "not-json" } }]
  };
  const worker = createConversationIngestionWorker(repository, {
    workerId: "document-invalid-json-worker",
    phase3: {
      apiKey: "test-key",
      baseUrl: "https://llm.invalid/v1",
      fetchImpl: fixedExtractionResponse(rawResponse),
      disableStmAdmissionLlm: true,
      disableLtmConsolidationLlm: true
    }
  });

  assert.equal(await worker.runOnce(), true);

  const status = await repository.getConversationIngestion(ingestion.sessions[0]!.ingestionId);
  const trace = repository.getDebugSnapshot().llmFactFusionTraces[0];
  assert.equal(status?.processingStatus, "fact_pending");
  assert.equal(status?.lastError?.code, "FACT_OUTPUT_INVALID");
  assert.deepEqual(trace?.rawResponse, rawResponse);
  assert.match(trace?.fallbackReason ?? "", /response content is not valid JSON/u);
});

function workerWithCandidates(
  repository: InMemoryContextEngineRepository,
  buildCandidates: (document: string, prompt: ExtractionPrompt) => unknown[],
  now?: string,
  buildTimelineGroups?: (prompt: TimelineAggregationPrompt) => unknown[],
  embeddingClient?: typeof deterministicEmbeddingClient
) {
  return createConversationIngestionWorker(repository, {
    workerId: "document-phase3-worker",
    ...(now ? { now: () => now } : {}),
    phase3: {
      apiKey: "test-key",
      baseUrl: "https://llm.invalid/v1",
      fetchImpl: extractionFetch(buildCandidates, buildTimelineGroups),
      transport: "fetch",
      disableStmAdmissionLlm: true,
      disableLtmConsolidationLlm: true,
      ...(embeddingClient ? { embeddingClient } : {})
    }
  });
}

interface ExtractionPrompt {
  system: string;
  task: string;
  constraints: string[];
  messages: Array<{ messageId: string; role: string; content: string; createdAt: string }>;
  referenceTimezone: string;
  locale: string;
}

interface TimelineAggregationPrompt {
  inputGroups: Array<{
    groupId: string;
    facts: Array<{ factId: string; factText: string; normalizedClaim: string }>;
  }>;
}

function extractionFetch(
  buildCandidates: (document: string, prompt: ExtractionPrompt) => unknown[],
  buildTimelineGroups?: (prompt: TimelineAggregationPrompt) => unknown[]
): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const payload = JSON.parse(request.messages.find((message) => message.role === "user")!.content) as {
      inputGroups?: TimelineAggregationPrompt["inputGroups"];
      task: string;
      constraints: string[];
      session: {
        referenceTimezone: string;
        locale: string;
        messages: Array<{ messageId: string; role: string; content: string; createdAt: string }>;
      };
    };
    if (Array.isArray(payload.inputGroups)) {
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({
          groups: buildTimelineGroups?.({ inputGroups: payload.inputGroups }) ?? []
        }) } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const candidates = buildCandidates(payload.session.messages.map((message) => message.content).join("\n"), {
      system,
      task: payload.task,
      constraints: payload.constraints,
      messages: payload.session.messages,
      referenceTimezone: payload.session.referenceTimezone,
      locale: payload.session.locale
    }).map((candidate) => attachCandidateSources(candidate, payload.session.messages));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify({
        candidates
      }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function fixedExtractionResponse(rawResponse: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(rawResponse), {
    status: 200,
    headers: { "content-type": "application/json" }
  })) as typeof fetch;
}

function eligibleCandidate(evidenceQuote: string, normalizedClaim: string) {
  return {
    factType: "stable_preference",
    factText: normalizedClaim,
    normalizedClaim,
    subject: "principal:principal_fixture",
    epistemicStatus: "user_asserted",
    confidenceLevel: "high",
    memoryEligibility: "eligible",
    evidenceQuotes: [evidenceQuote],
    entityIds: [],
    validTimeStart: null,
    validTimeEnd: null,
    validTimeBasis: null,
    validTimeConfidence: null
  };
}

function attachCandidateSources(
  candidate: unknown,
  messages: Array<{ messageId: string; content: string }>
) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const record = candidate as Record<string, unknown>;
  if (Array.isArray(record.sourceMessageIds) && record.sourceMessageIds.length) return candidate;
  const quotes = Array.isArray(record.evidenceQuotes)
    ? record.evidenceQuotes.filter((quote): quote is string => typeof quote === "string")
    : [];
  const matchingMessageIds = messages
    .filter((message) => quotes.some((quote) => message.content.includes(quote)))
    .map((message) => message.messageId);
  return {
    ...record,
    sourceMessageIds: matchingMessageIds.length ? matchingMessageIds : messages.slice(0, 1).map((message) => message.messageId)
  };
}

function conversation(name: string, messages: ConversationDocumentMessage[]) {
  const frontMatter: ConversationDocumentFrontMatter = {
    ...validConversationFixture.frontMatter,
    batch_id: `batch_${name}`
  };
  const sessions = [{ sessionId: `session_${name}`, cursor: `cursor_${name}`, messages }];
  return { frontMatter, messages, sessions, document: buildConversationMarkdown(frontMatter, sessions) };
}

function extendedConversation(name: string, messages: ConversationDocumentMessage[]) {
  const frontMatter: ConversationDocumentFrontMatter = {
    ...validConversationFixture.frontMatter,
    batch_id: `batch_${name}`
  };
  const sessions = [{
    sessionId: `session_${name}`,
    cursor: `cursor_${name}`,
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    messages
  }];
  return { frontMatter, messages, sessions, document: buildConversationMarkdown(frontMatter, sessions) };
}

async function ingest(
  repository: InMemoryContextEngineRepository,
  source: ReturnType<typeof conversation>,
  idempotencyKey: string
) {
  return createConversationIngestionService(repository).ingest({
    document: source.document,
    idempotencyKey,
    documentSha256: createHash("sha256").update(source.document, "utf8").digest("hex"),
    processingMode: "async"
  }, callerScope);
}
