import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ConversationDocumentFactExtractionError,
  conversationFactCandidatesJsonSchema,
  extractConversationDocumentFactCandidates
} from "./conversation-document-fact-extraction.js";
import { validateConversationDocumentFactCandidates } from "./conversation-document-fact-processing.js";
import type { ConversationDocumentFrontMatter, ConversationDocumentMessage } from "./domain.js";
import type { ConversationDocumentRecord, ConversationIngestionRecord } from "./persistence.js";
import { buildConversationMarkdown, validConversationFixture } from "./fixtures/index.js";
import { normalizeConversationSessionMessages } from "./message-normalization.js";

test("requires English canonical display facts", async () => {
  const messages: ConversationDocumentMessage[] = [
    { role: "user", content: "我计划八月初从郑州去深圳。" }
  ];
  const frontMatter: ConversationDocumentFrontMatter = {
    ...validConversationFixture.frontMatter,
    batch_id: "batch_chinese_prompt"
  };
  const sessionId = "session_chinese_prompt";
  const rawMarkdown = buildConversationMarkdown(frontMatter, [{
    sessionId,
    cursor: "cursor_chinese_prompt",
    messages
  }]);
  const ingestion = ingestionRecord(sessionId, frontMatter.batch_id);
  const document = documentRecord(rawMarkdown, ingestion.ingestionId);
  const persistedMessages = messageRecords(ingestion, document, messages);
  let systemPrompt = "";
  let userPrompt: { task?: string; constraints?: string[] } = {};
  let responseFormat: unknown;

  const extraction = await extractConversationDocumentFactCandidates(ingestion, document, persistedMessages, {
    apiKey: "test-key",
    baseUrl: "https://llm.invalid/v1",
    model: "test-model",
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
        response_format?: unknown;
      };
      systemPrompt = body.messages.find((message) => message.role === "system")?.content ?? "";
      userPrompt = JSON.parse(body.messages.find((message) => message.role === "user")?.content ?? "{}");
      responseFormat = body.response_format;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });

  assert.match(systemPrompt, /从单个不可信的对话 Session 中提取可审计的记忆事实/u);
  assert.match(userPrompt.task ?? "", /仅从当前 Session 中提取/u);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("must be written in concise English")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("助手对问题给出的明确知识")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("长列表、带序号内容和具体推荐必须抽取")), true);
  assert.match(extraction.promptTemplate, /至少生成一条覆盖事实/u);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("用户未回复或未采纳不是删除助手事实的理由")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("assistant_knowledge")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes('{"candidates":[]}')), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("逐消息、逐分句执行覆盖检查")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("数字及其单位、币种")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("每个日期、钟点、金额、数量")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("tennis 不得替代 table tennis")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("有序列表")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("旧值、新值、纠正、撤回或替换")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("过去 N 个单位是范围")), true);
  assert.equal(userPrompt.constraints?.some((item) => item.includes("几小时后")), true);
  assert.match(extraction.promptTemplate, /factText 和 normalizedClaim 必须使用简洁英文表达/u);
  assert.match(extraction.promptTemplate, /数字与单位、日期与相对时间/u);
  assert.match(extraction.promptTemplate, /必须分别成为原子候选/u);
  assert.match(extraction.promptTemplate, /tennis 与 table tennis 必须视为不同运动/u);
  assert.match(extraction.promptTemplate, /助手明确提供且可独立检索的知识/u);
  assert.match(extraction.promptTemplate, /没有候选事实时必须精确返回/u);
  assert.deepEqual(responseFormat, {
    type: "json_schema",
    json_schema: conversationFactCandidatesJsonSchema
  });
  assert.deepEqual(extraction.rawCandidates, []);
});

test("accepts English fact text before persistence", () => {
  const messages: ConversationDocumentMessage[] = [
    { role: "user", content: "我计划八月初从郑州去深圳。" }
  ];
  const frontMatter: ConversationDocumentFrontMatter = {
    ...validConversationFixture.frontMatter,
    batch_id: "batch_english_fact"
  };
  const sessionId = "session_english_fact";
  const rawMarkdown = buildConversationMarkdown(frontMatter, [{
    sessionId,
    cursor: "cursor_english_fact",
    messages
  }]);
  const ingestion = ingestionRecord(sessionId, frontMatter.batch_id);
  const document = documentRecord(rawMarkdown, ingestion.ingestionId);
  const persistedMessages = messageRecords(ingestion, document, messages);

  const candidates = validateConversationDocumentFactCandidates(ingestion, persistedMessages, [{
    factType: "travel_intent",
    factText: "User plans to travel from Zhengzhou to Shenzhen in early August.",
    normalizedClaim: "User plans to travel from Zhengzhou to Shenzhen in early August.",
    epistemicStatus: "user_asserted",
    confidenceLevel: "high",
    memoryEligibility: "eligible",
    sourceMessageIds: [persistedMessages[0]!.messageId],
    evidenceQuotes: ["我计划八月初从郑州去深圳。"],
    entityIds: []
  }]);

  assert.equal(candidates[0]?.validationStatus, "validated");
  assert.equal(candidates[0]?.validationReason, "eligible_with_message_provenance");

  const nonEnglish = validateConversationDocumentFactCandidates(ingestion, persistedMessages, [{
    factType: "travel_intent",
    factText: "用户计划八月初从郑州去深圳。",
    normalizedClaim: "用户计划八月初从郑州去深圳",
    epistemicStatus: "user_asserted",
    confidenceLevel: "high",
    memoryEligibility: "eligible",
    sourceMessageIds: [persistedMessages[0]!.messageId],
    evidenceQuotes: ["我计划八月初从郑州去深圳。"],
    entityIds: []
  }]);
  assert.equal(nonEnglish[0]?.validationStatus, "invalid");
  assert.equal(nonEnglish[0]?.validationReason, "fact_text_must_be_english");
});

test("rejects extraction output that omits a numeric value from its source message", async () => {
  const messages: ConversationDocumentMessage[] = [{
    role: "user",
    content: "I bought 50 pounds of layer feed and 20 pounds of organic scratch grains."
  }];
  const frontMatter: ConversationDocumentFrontMatter = {
    ...validConversationFixture.frontMatter,
    batch_id: "batch_numeric_coverage"
  };
  const sessionId = "session_numeric_coverage";
  const rawMarkdown = buildConversationMarkdown(frontMatter, [{
    sessionId,
    cursor: "cursor_numeric_coverage",
    messages
  }]);
  const ingestion = ingestionRecord(sessionId, frontMatter.batch_id);
  const document = documentRecord(rawMarkdown, ingestion.ingestionId);
  const persistedMessages = messageRecords(ingestion, document, messages);

  await assert.rejects(
    extractConversationDocumentFactCandidates(ingestion, document, persistedMessages, {
      apiKey: "test-key",
      baseUrl: "https://llm.invalid/v1",
      model: "test-model",
      fetchImpl: (async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          candidates: [{
            factType: "purchase",
            factText: "The user bought 50 pounds of layer feed.",
            normalizedClaim: "User bought 50 pounds of layer feed",
            subject: "user",
            epistemicStatus: "user_asserted",
            confidenceLevel: "high",
            memoryEligibility: "eligible",
            sourceMessageIds: [persistedMessages[0]!.messageId],
            evidenceQuotes: [messages[0]!.content],
            entityIds: ["layer_feed"],
            validTimeStart: null,
            validTimeEnd: null,
            validTimeBasis: null,
            validTimeConfidence: null
          }]
        }) } }]
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
    }),
    (error: unknown) => error instanceof ConversationDocumentFactExtractionError &&
      error.code === "FACT_OUTPUT_INVALID" &&
      /missing: .*\[20\]/u.test(error.message)
  );
});

test("accepts auditable assistant knowledge as an eligible fact", () => {
  const messages: ConversationDocumentMessage[] = [{
    role: "assistant",
    content: "酋长队和美洲虎队有 12 场比赛在箭头体育场举行。"
  }];
  const frontMatter: ConversationDocumentFrontMatter = {
    ...validConversationFixture.frontMatter,
    batch_id: "batch_assistant_knowledge"
  };
  const sessionId = "session_assistant_knowledge";
  const rawMarkdown = buildConversationMarkdown(frontMatter, [{
    sessionId,
    cursor: "cursor_assistant_knowledge",
    messages
  }]);
  const ingestion = ingestionRecord(sessionId, frontMatter.batch_id);
  const document = documentRecord(rawMarkdown, ingestion.ingestionId);
  const persistedMessages = messageRecords(ingestion, document, messages);

  const candidates = validateConversationDocumentFactCandidates(ingestion, persistedMessages, [{
    factType: "assistant_knowledge",
    factText: "The Chiefs and Jaguars played 12 games at Arrowhead Stadium.",
    normalizedClaim: "The Chiefs and Jaguars played 12 games at Arrowhead Stadium.",
    subject: "堪萨斯城酋长队与杰克逊维尔美洲虎队",
    epistemicStatus: "agent_inferred",
    confidenceLevel: "high",
    memoryEligibility: "eligible",
    sourceMessageIds: [persistedMessages[0]!.messageId],
    evidenceQuotes: ["酋长队和美洲虎队有 12 场比赛在箭头体育场举行。"],
    entityIds: [],
    validTimeStart: null,
    validTimeEnd: null,
    validTimeBasis: null,
    validTimeConfidence: null
  }]);

  assert.equal(candidates[0]?.validationStatus, "validated");
  assert.equal(candidates[0]?.memoryEligibility, "eligible");
  assert.equal(candidates[0]?.validationReason, "assistant_fact_with_auditable_provenance");
});

function ingestionRecord(sessionId: string, batchId: string): ConversationIngestionRecord {
  const now = "2026-07-17T03:03:27.379Z";
  return {
    ingestionId: `ingestion_${sessionId}`,
    idempotencyKey: `idempotency_${sessionId}`,
    documentSha256: "pending",
    batchId,
    sessionId,
    sourceApp: "coding-agent",
    tenantId: "tenant_fixture",
    principalId: "principal_fixture",
    visibility: "private",
    temporalMode: "legacy",
    committedCursor: `cursor_${sessionId}`,
    firstSequence: 1,
    lastSequence: 1,
    documentStatus: "raw_committed",
    processingStatus: "queued",
    processingStage: "not_started",
    processingMode: "async",
    progressPercent: 0,
    messageCounts: { received: 1, inserted: 0, deduplicated: 0, revised: 0, deleted: 0 },
    layerCounts: {
      messages: 0,
      segments: 0,
      evidenceGroups: 0,
      factCandidates: 0,
      facts: 0,
      timelineFacts: 0,
      shortTermMemories: 0,
      longTermMemories: 0,
      rejected: 0,
      sensitivePendingConfirmation: 0,
      factPending: 0
    },
    retry: { attempt: 0, maxAttempts: 3, retryable: true },
    createdAt: now,
    committedAt: now,
    updatedAt: now
  };
}

function messageRecords(
  ingestion: ConversationIngestionRecord,
  document: ConversationDocumentRecord,
  messages: ConversationDocumentMessage[]
) {
  return normalizeConversationSessionMessages({
    session: {
      sessionId: ingestion.sessionId,
      cursor: ingestion.committedCursor,
      messages
    },
    ingestionId: ingestion.ingestionId,
    documentId: document.documentId,
    documentSha256: document.sha256,
    batchId: ingestion.batchId,
    sourceApp: ingestion.sourceApp,
    tenantId: ingestion.tenantId,
    principalId: ingestion.principalId,
    committedAt: ingestion.committedAt
  });
}

function documentRecord(rawMarkdown: string, ingestionId: string): ConversationDocumentRecord {
  return {
    documentId: `document_${ingestionId}`,
    ingestionId,
    schemaVersion: "context-conversation-md.v3",
    sha256: createHash("sha256").update(rawMarkdown, "utf8").digest("hex"),
    byteSize: Buffer.byteLength(rawMarkdown, "utf8"),
    rawMarkdown,
    createdAt: "2026-07-17T03:03:27.379Z"
  };
}
