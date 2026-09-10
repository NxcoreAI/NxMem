import { createHash } from "node:crypto";
import type {
  ConversationDocumentSession,
  ConversationTemporalMode
} from "./domain.js";
import type { ConversationMessageRecord } from "./persistence.js";

export interface NormalizeConversationSessionMessagesInput {
  session: ConversationDocumentSession;
  ingestionId: string;
  documentId: string;
  documentSha256: string;
  batchId: string;
  sourceApp: string;
  tenantId: string;
  principalId: string;
  committedAt: string;
  storedAt?: string;
}

export function conversationSessionTemporalMode(
  session: ConversationDocumentSession
): ConversationTemporalMode {
  return session.messages.every((message) => message.messageId && message.createdAt)
    ? "extended"
    : "legacy";
}

export function normalizeConversationSessionMessages(
  input: NormalizeConversationSessionMessagesInput
): ConversationMessageRecord[] {
  const temporalMode = conversationSessionTemporalMode(input.session);
  const storedAt = input.storedAt ?? input.committedAt;
  return input.session.messages.map((message, messageOrder) => {
    const messageId = temporalMode === "extended"
      ? message.messageId as string
      : createLegacyConversationMessageId({
          documentSha256: input.documentSha256,
          sessionId: input.session.sessionId,
          messageOrder
        });
    const revision = 1;
    const createdAt = temporalMode === "extended"
      ? message.createdAt as string
      : input.committedAt;
    return {
      conversationMessageRowId: createConversationMessageRowId({
        tenantId: input.tenantId,
        sourceApp: input.sourceApp,
        principalId: input.principalId,
        sessionId: input.session.sessionId,
        messageId,
        revision
      }),
      ingestionId: input.ingestionId,
      documentId: input.documentId,
      sessionId: input.session.sessionId,
      batchId: input.batchId,
      sourceApp: input.sourceApp,
      tenantId: input.tenantId,
      principalId: input.principalId,
      messageId,
      sequence: messageOrder + 1,
      role: message.role,
      createdAt,
      status: "completed",
      contentType: "text/markdown",
      content: message.content,
      branchId: "main",
      revision,
      operation: "append",
      contentSha256: sha256(message.content),
      ...(message.completedAt ? { completedAt: message.completedAt } : {}),
      ...(temporalMode === "extended" && input.session.timezone
        ? { timezone: input.session.timezone }
        : {}),
      ...(temporalMode === "extended" && input.session.locale
        ? { locale: input.session.locale }
        : {}),
      timeConfidence: temporalMode === "extended" ? "high" : "low",
      storedAt,
      createdAtStored: storedAt
    };
  });
}

export function createConversationMessageRowId(input: {
  tenantId: string;
  sourceApp: string;
  principalId: string;
  sessionId: string;
  messageId: string;
  revision: number;
}) {
  return `conversation_message_${sha256([
    input.tenantId,
    input.sourceApp,
    input.principalId,
    input.sessionId,
    input.messageId,
    String(input.revision)
  ].join("|"))}`;
}

export function createLegacyConversationMessageId(input: {
  documentSha256: string;
  sessionId: string;
  messageOrder: number;
}) {
  return `legacy_message_${sha256([
    input.documentSha256,
    input.sessionId,
    String(input.messageOrder)
  ].join("|"))}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
