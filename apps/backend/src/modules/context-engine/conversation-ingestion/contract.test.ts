import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_INGESTION_LIMITS,
  createConversationIngestionToolError
} from "./domain.js";
import {
  contextConversationMarkdownProtocol,
  validateConversationBatch,
  validateConversationCursor,
  validateConversationFrontMatter,
  validateConversationMessage,
  validateDirectConversationDocumentSize
} from "./markdown-protocol.js";
import { parseConversationMarkdownDocument } from "./markdown-stream-parser.js";
import {
  conversationIngestionToolContracts,
  ingestConversationDocumentInputSchema
} from "./tool-descriptors.js";
import {
  buildOversizedConversationDocumentFixture,
  extendedConversationFixture,
  invalidMessageFixture,
  invalidTemporalConversationFixtures,
  validConversationFixture
} from "./fixtures/index.js";

test("freezes the minimal V3 multi-Session contract", () => {
  assert.equal(CONTEXT_CONVERSATION_SCHEMA_VERSION, "context-conversation-md.v3");
  assert.equal(contextConversationMarkdownProtocol.sessions.fenceLanguage, "context-session");
  assert.deepEqual(contextConversationMarkdownProtocol.frontMatter.schema.required, ["schema_version", "batch_id"]);
  assert.deepEqual(contextConversationMarkdownProtocol.sessions.schema.required, ["sessionId", "cursor", "messages"]);
});

test("validates and parses all Sessions without changing role/content", () => {
  const result = validateConversationBatch(validConversationFixture.frontMatter, validConversationFixture.sessions);
  assert.equal(result.ok, true);
  const parsed = parseConversationMarkdownDocument(validConversationFixture.document);
  assert.deepEqual(parsed.sessions, validConversationFixture.sessions);
});

test("validates and parses the extended V3 temporal Session", () => {
  const result = validateConversationBatch(
    extendedConversationFixture.frontMatter,
    extendedConversationFixture.sessions
  );
  assert.equal(result.ok, true);
  assert.equal(result.value?.sessions[0]?.timezone, "Asia/Shanghai");
  assert.equal(result.value?.sessions[0]?.locale, "zh-CN");
  assert.equal(result.value?.sessions[0]?.messages[0]?.messageId, "msg_fixture_user");
  assert.equal(result.value?.sessions[0]?.messages[1]?.completedAt, "2026-07-23T07:30:06.500Z");

  const parsed = parseConversationMarkdownDocument(extendedConversationFixture.document);
  assert.deepEqual(parsed.sessions, extendedConversationFixture.sessions);
});

test("rejects extra fields, duplicate Sessions, and unsupported schemas", () => {
  const invalidMessage = validateConversationMessage(invalidMessageFixture.sessions[0]?.messages[0]);
  assert.equal(invalidMessage.ok, false);
  assert.equal(validateConversationMessage({ role: "user", content: "hello", messageId: "legacy" }).ok, false);
  assert.equal(validateConversationFrontMatter({
    ...validConversationFixture.frontMatter,
    schema_version: "context-conversation-md.v2"
  }).issues[0]?.code, "UNSUPPORTED_SCHEMA_VERSION");
  assert.equal(validateConversationBatch(
    validConversationFixture.frontMatter,
    [validConversationFixture.session, validConversationFixture.session]
  ).issues.some((item) => item.code === "INVALID_SESSION_BLOCK"), true);
});

test("rejects incomplete or mixed temporal message formats", () => {
  const fixtures = Object.values(invalidTemporalConversationFixtures);
  for (const fixture of fixtures) {
    const result = validateConversationBatch(
      validConversationFixture.frontMatter,
      [fixture.session]
    );
    assert.equal(result.ok, false, fixture.session.sessionId);
    assert.equal(
      result.issues.some((issue) => issue.code === fixture.expectedCode),
      true,
      `${fixture.session.sessionId}: ${result.issues.map((issue) => issue.message).join("; ")}`
    );
  }
});

test("keeps equal message timestamps stable in document order", () => {
  const session = {
    ...extendedConversationFixture.session,
    sessionId: "session_equal_timestamps",
    cursor: "cursor_equal_timestamps",
    messages: extendedConversationFixture.messages.map((message) => ({
      ...message,
      createdAt: "2026-07-23T07:30:00.000Z"
    }))
  };
  const result = validateConversationBatch(validConversationFixture.frontMatter, [session]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value?.sessions[0]?.messages.map((message) => message.messageId), [
    "msg_fixture_user",
    "msg_fixture_assistant"
  ]);
});

test("keeps cursor and document limits deterministic", () => {
  assert.equal(validateConversationCursor("cursor_1", "cursor_1").length, 0);
  assert.equal(validateConversationCursor("cursor_2", "cursor_1")[0]?.code, "CURSOR_MISMATCH");
  const oversized = buildOversizedConversationDocumentFixture();
  assert.equal(Buffer.byteLength(oversized.document, "utf8") > CONVERSATION_INGESTION_LIMITS.directDocumentBytes, true);
  assert.equal(validateDirectConversationDocumentSize(oversized.document)[0]?.code, "DOCUMENT_TOO_LARGE");
});

test("publishes the V3 tools and async-only request", () => {
  assert.deepEqual(conversationIngestionToolContracts.map((tool) => tool.name), [
    "ingest_conversation_batch_document",
    "get_conversation_ingestion_status"
  ]);
  assert.deepEqual(ingestConversationDocumentInputSchema.required, [
    "document", "idempotencyKey", "documentSha256", "processingMode"
  ]);
  assert.equal(createConversationIngestionToolError(
    "ingest_conversation_batch_document", "CURSOR_MISMATCH"
  ).code, "CURSOR_MISMATCH");
});
