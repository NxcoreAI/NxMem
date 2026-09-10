import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeConversationCandidateMonthTemporal,
  validateConversationCandidateSources
} from "./conversation-fact-temporal.js";
import type { ConversationMessageRecord } from "./persistence.js";

test("validates deterministic Chinese and English event-relative offsets", () => {
  const message = buildMessage("三个月前我开始跑步，after 2 hours I stopped.");

  assert.equal(validateConversationCandidateSources({
    sourceMessageIds: [message.messageId],
    evidenceQuotes: ["三个月前我开始跑步"],
    messages: [message],
    timezone: "Asia/Shanghai",
    temporal: {
      validTimeStart: "2026-04-25T00:00:00+08:00",
      validTimeBasis: "event_relative",
      validTimeConfidence: "high"
    }
  }), undefined);

  assert.equal(validateConversationCandidateSources({
    sourceMessageIds: [message.messageId],
    evidenceQuotes: ["after 2 hours I stopped"],
    messages: [message],
    timezone: "Asia/Shanghai",
    temporal: {
      validTimeStart: "2026-07-25T14:30:00+08:00",
      validTimeBasis: "event_relative",
      validTimeConfidence: "high"
    }
  }), undefined);
});

test("holds guessed ambiguous relative time for verification", () => {
  const message = buildMessage("几小时后提醒我提交报告。");
  assert.deepEqual(validateConversationCandidateSources({
    sourceMessageIds: [message.messageId],
    evidenceQuotes: [message.content],
    messages: [message],
    timezone: "Asia/Shanghai",
    temporal: {
      validTimeStart: "2026-07-25T15:30:00+08:00",
      validTimeBasis: "event_relative",
      validTimeConfidence: "high"
    }
  }), {
    kind: "pending",
    reason: "event_relative_time_not_recomputable"
  });
});

test("does not treat a stated duration as an event-relative occurrence time", () => {
  const message = buildMessage("这个项目会持续两周。");
  assert.equal(validateConversationCandidateSources({
    sourceMessageIds: [message.messageId],
    evidenceQuotes: [message.content],
    messages: [message],
    timezone: "Asia/Shanghai",
    temporal: {}
  }), undefined);
});

test("normalizes month-relative points from verbatim evidence quotes", () => {
  const message = buildMessage("It started about 3 months ago when I watched a comedy special.");
  assert.deepEqual(normalizeConversationCandidateMonthTemporal({
    sourceMessageIds: [message.messageId],
    evidenceQuotes: [message.content],
    messages: [message],
    timezone: "Asia/Shanghai"
  }), {
    validTimeStart: "2026-03-31T16:00:00.000Z",
    validTimeBasis: "event_relative",
    validTimeConfidence: "medium"
  });
});

test("normalizes present-perfect month durations as intervals", () => {
  const message = buildMessage("I have been watching stand-up regularly for 3 months.");
  const temporal = normalizeConversationCandidateMonthTemporal({
    sourceMessageIds: [message.messageId],
    evidenceQuotes: [message.content],
    messages: [message],
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(temporal, {
    validTimeStart: "2026-03-31T16:00:00.000Z",
    validTimeEnd: message.createdAt,
    validTimeBasis: "event_relative",
    validTimeConfidence: "high"
  });
  assert.equal(validateConversationCandidateSources({
    sourceMessageIds: [message.messageId],
    evidenceQuotes: [message.content],
    messages: [message],
    timezone: "Asia/Shanghai",
    temporal: temporal ?? {}
  }), undefined);
});

function buildMessage(content: string): ConversationMessageRecord {
  return {
    conversationMessageRowId: "conversation_message_1",
    ingestionId: "ingestion_1",
    documentId: "document_1",
    sessionId: "session_1",
    batchId: "batch_1",
    sourceApp: "test",
    tenantId: "tenant_1",
    principalId: "principal_1",
    messageId: "message_1",
    sequence: 1,
    role: "user",
    createdAt: "2026-07-25T04:30:00.000Z",
    status: "completed",
    contentType: "text/plain",
    content,
    branchId: "main",
    revision: 1,
    operation: "append",
    contentSha256: "sha256",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    timeConfidence: "high",
    storedAt: "2026-07-25T04:31:00.000Z"
  };
}
