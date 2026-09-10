import {
  CONTEXT_CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_INGESTION_LIMITS,
  type ConversationDocumentFrontMatter,
  type ConversationDocumentMessage,
  type ConversationDocumentSession
} from "../domain.js";

const baseFrontMatter: ConversationDocumentFrontMatter = {
  schema_version: CONTEXT_CONVERSATION_SCHEMA_VERSION,
  batch_id: "batch_fixture_001"
};

const validMessages: ConversationDocumentMessage[] = [
  { role: "user", content: "我偏好使用 TypeScript。" },
  { role: "assistant", content: "收到，我会基于本 Session 提取事实。" }
];

const baseSession: ConversationDocumentSession = {
  sessionId: "session_fixture",
  cursor: "cursor_fixture_001",
  messages: validMessages
};

const extendedMessages: ConversationDocumentMessage[] = [
  {
    messageId: "msg_fixture_user",
    role: "user",
    content: "我计划明天去深圳。",
    createdAt: "2026-07-23T07:30:00.000Z"
  },
  {
    messageId: "msg_fixture_assistant",
    role: "assistant",
    content: "已记录。",
    createdAt: "2026-07-23T07:30:05.000Z",
    completedAt: "2026-07-23T07:30:06.500Z"
  }
];

const extendedSession: ConversationDocumentSession = {
  sessionId: "session_fixture_extended",
  cursor: "cursor_fixture_extended",
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
  messages: extendedMessages
};

export const validConversationFixture = {
  name: "valid",
  frontMatter: baseFrontMatter,
  session: baseSession,
  sessions: [baseSession],
  messages: validMessages,
  document: buildConversationMarkdown(baseFrontMatter, [baseSession])
} as const;

export const extendedConversationFixture = {
  name: "valid-extended",
  frontMatter: { ...baseFrontMatter, batch_id: "batch_fixture_extended" },
  session: extendedSession,
  sessions: [extendedSession],
  messages: extendedMessages,
  document: buildConversationMarkdown(
    { ...baseFrontMatter, batch_id: "batch_fixture_extended" },
    [extendedSession]
  )
} as const;

export const invalidMessageFixture = {
  name: "invalid-message-role",
  frontMatter: { ...baseFrontMatter, batch_id: "batch_fixture_invalid" },
  sessions: [{ ...baseSession, messages: [{ role: "human", content: "invalid fixture" }] }],
  expectedCodes: ["INVALID_MESSAGE_BLOCK"]
} as const;

export const invalidJsonConversationDocumentFixture = {
  name: "invalid-json",
  document: `${buildFrontMatter({ ...baseFrontMatter, batch_id: "batch_fixture_invalid_json" })}\n\n` +
    "```context-session\n{\"sessionId\":\"bad\",}\n```\n",
  expectedCode: "INVALID_SESSION_BLOCK"
} as const;

export const invalidTemporalConversationFixtures = {
  partialMessageTimestamp: {
    session: {
      sessionId: "session_invalid_partial",
      cursor: "cursor_invalid_partial",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      messages: [{ role: "user", content: "partial", messageId: "msg_partial" }]
    },
    expectedCode: "INVALID_MESSAGE_BLOCK"
  },
  mixedMessages: {
    session: {
      sessionId: "session_invalid_mixed",
      cursor: "cursor_invalid_mixed",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      messages: [
        { role: "user", content: "legacy" },
        {
          role: "assistant",
          content: "extended",
          messageId: "msg_extended",
          createdAt: "2026-07-23T07:30:00.000Z"
        }
      ]
    },
    expectedCode: "INVALID_SESSION_BLOCK"
  },
  duplicateMessageId: {
    session: {
      sessionId: "session_invalid_duplicate",
      cursor: "cursor_invalid_duplicate",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      messages: [
        {
          role: "user",
          content: "one",
          messageId: "msg_duplicate",
          createdAt: "2026-07-23T07:30:00.000Z"
        },
        {
          role: "assistant",
          content: "two",
          messageId: "msg_duplicate",
          createdAt: "2026-07-23T07:30:01.000Z"
        }
      ]
    },
    expectedCode: "INVALID_SESSION_BLOCK"
  },
  invalidTimezone: {
    session: {
      sessionId: "session_invalid_timezone",
      cursor: "cursor_invalid_timezone",
      timezone: "Mars/Olympus",
      locale: "zh-CN",
      messages: extendedMessages
    },
    expectedCode: "INVALID_SESSION_BLOCK"
  },
  invalidLocale: {
    session: {
      sessionId: "session_invalid_locale",
      cursor: "cursor_invalid_locale",
      timezone: "Asia/Shanghai",
      locale: "zh_CN",
      messages: extendedMessages
    },
    expectedCode: "INVALID_SESSION_BLOCK"
  },
  invalidTimestamp: {
    session: {
      sessionId: "session_invalid_timestamp",
      cursor: "cursor_invalid_timestamp",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      messages: [{
        role: "user",
        content: "invalid timestamp",
        messageId: "msg_invalid_timestamp",
        createdAt: "2026-07-23 07:30:00"
      }]
    },
    expectedCode: "INVALID_MESSAGE_BLOCK"
  },
  completedBeforeCreated: {
    session: {
      sessionId: "session_invalid_completed",
      cursor: "cursor_invalid_completed",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      messages: [{
        role: "assistant",
        content: "invalid completion",
        messageId: "msg_invalid_completed",
        createdAt: "2026-07-23T07:30:05.000Z",
        completedAt: "2026-07-23T07:30:04.000Z"
      }]
    },
    expectedCode: "INVALID_MESSAGE_BLOCK"
  },
  nonMonotonicMessages: {
    session: {
      sessionId: "session_invalid_order",
      cursor: "cursor_invalid_order",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      messages: [
        {
          role: "user",
          content: "later",
          messageId: "msg_later",
          createdAt: "2026-07-23T07:31:00.000Z"
        },
        {
          role: "assistant",
          content: "earlier",
          messageId: "msg_earlier",
          createdAt: "2026-07-23T07:30:00.000Z"
        }
      ]
    },
    expectedCode: "INVALID_SESSION_BLOCK"
  }
} as const;

export function buildOversizedConversationDocumentFixture() {
  const frontMatter = { ...baseFrontMatter, batch_id: "batch_fixture_oversized" };
  const sessions: ConversationDocumentSession[] = [{
    sessionId: "session_oversized",
    cursor: "cursor_oversized",
    messages: [{ role: "user", content: "x".repeat(CONVERSATION_INGESTION_LIMITS.directDocumentBytes) }]
  }];
  return {
    name: "oversized",
    frontMatter,
    sessions,
    document: buildConversationMarkdown(frontMatter, sessions),
    expectedCode: "DOCUMENT_TOO_LARGE"
  } as const;
}

export const conversationProtocolFixtures = [
  validConversationFixture,
  extendedConversationFixture,
  invalidMessageFixture,
  invalidJsonConversationDocumentFixture
] as const;

export function buildConversationMarkdown(
  frontMatter: ConversationDocumentFrontMatter,
  sessions: readonly ConversationDocumentSession[]
) {
  const blocks = sessions.map((session) =>
    `\`\`\`context-session\n${JSON.stringify(session, null, 2)}\n\`\`\``
  );
  return `${buildFrontMatter(frontMatter)}\n\n${blocks.join("\n\n")}\n`;
}

function buildFrontMatter(frontMatter: ConversationDocumentFrontMatter) {
  const entries = Object.entries(frontMatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${entries.join("\n")}\n---`;
}
