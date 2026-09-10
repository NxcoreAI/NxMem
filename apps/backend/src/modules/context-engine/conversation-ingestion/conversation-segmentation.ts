import { createHash } from "node:crypto";
import type { MemoryEvent, ParsedSegment } from "../domain.js";
import type {
  ConversationIngestionRecord,
  ConversationMessageRecord,
  ConversationMessageSegmentRecord
} from "./persistence.js";
import { conversationMessageSourceRef } from "./conversation-fact-temporal.js";

export const DEFAULT_CONVERSATION_MESSAGE_CHUNK_CHARS = 8_000;

export interface ConversationSegmentationResult {
  event: MemoryEvent;
  segments: ParsedSegment[];
  messageSegments: ConversationMessageSegmentRecord[];
}

interface ContentSlice {
  content: string;
  startOffset: number;
  endOffset: number;
}

export function segmentConversationMessages(
  ingestion: ConversationIngestionRecord,
  messages: readonly ConversationMessageRecord[],
  options: { maxChunkChars?: number; now?: string } = {}
): ConversationSegmentationResult {
  const maxChunkChars = normalizeChunkLimit(options.maxChunkChars);
  const now = options.now ?? new Date().toISOString();
  const eventId = `conversation_batch_${stableId(ingestion.ingestionId)}`;
  const segments: ParsedSegment[] = [];
  const messageSegments: ConversationMessageSegmentRecord[] = [];

  for (const message of messages) {
    const chunks = splitConversationMessageContent(message.content, maxChunkChars);
    chunks.forEach((chunk, chunkIndex) => {
      const segmentId = conversationSegmentId(ingestion, message, chunkIndex, chunk);
      const conversationFields = {
        ingestionId: ingestion.ingestionId,
        batchId: ingestion.batchId,
        sessionId: ingestion.sessionId,
        messageId: message.messageId,
        conversationMessageRowId: message.conversationMessageRowId,
        sequence: message.sequence,
        role: message.role,
        branchId: message.branchId,
        revision: message.revision,
        operation: message.operation,
        chunkIndex,
        chunkCount: chunks.length,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset
      };
      segments.push({
        segmentId,
        eventId,
        modality: message.role === "tool" ? "tool_result" : "text",
        content: chunk.content,
        status: "parsed",
        confidence: "high",
        dataSource: {
          sourceApp: ingestion.sourceApp,
          sourceId: message.messageId,
          sourceName: ingestion.sessionId,
          sourceType: "conversation_message",
          syncCursor: ingestion.committedCursor,
          syncVersion: String(message.revision)
        },
        customFields: conversationFields
      });
      messageSegments.push({
        segmentId,
        ingestionId: ingestion.ingestionId,
        conversationMessageRowId: message.conversationMessageRowId,
        messageId: message.messageId,
        sequence: message.sequence,
        role: message.role,
        branchId: message.branchId,
        chunkIndex,
        chunkCount: chunks.length,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        createdAt: now
      });
    });
  }

  return {
    event: buildConversationBatchEvent(ingestion, messages, eventId),
    segments,
    messageSegments
  };
}

export function splitConversationMessageContent(
  content: string,
  maxChunkChars = DEFAULT_CONVERSATION_MESSAGE_CHUNK_CHARS
): ContentSlice[] {
  const limit = normalizeChunkLimit(maxChunkChars);
  if (content.length <= limit) {
    return [{ content, startOffset: 0, endOffset: content.length }];
  }

  const chunks: ContentSlice[] = [];
  let startOffset = 0;
  while (startOffset < content.length) {
    const hardEnd = Math.min(content.length, startOffset + limit);
    const endOffset = hardEnd === content.length
      ? hardEnd
      : findPreferredBoundary(content, startOffset, hardEnd, limit);
    chunks.push({
      content: content.slice(startOffset, endOffset),
      startOffset,
      endOffset
    });
    startOffset = endOffset;
  }
  return chunks;
}

function buildConversationBatchEvent(
  ingestion: ConversationIngestionRecord,
  messages: readonly ConversationMessageRecord[],
  eventId: string
): MemoryEvent {
  return {
    eventId,
    eventType: "conversation_batch_captured",
    eventSummary: `Conversation batch ${ingestion.batchId} captured for session ${ingestion.sessionId}.`,
    eventTime: ingestion.committedAt,
    sourceApp: ingestion.sourceApp,
    sourceId: ingestion.sessionId,
    dataSource: {
      sourceApp: ingestion.sourceApp,
      sourceId: ingestion.sessionId,
      sourceName: ingestion.batchId,
      sourceType: "conversation_batch",
      syncCursor: ingestion.committedCursor
    },
    permissionSnapshot: {
      snapshotId: `conversation_permission_${stableId(`${ingestion.tenantId}:${ingestion.principalId}:${ingestion.visibility}`)}`,
      tenantId: ingestion.tenantId,
      principalId: ingestion.principalId,
      sourceAclVersion: `conversation_ingestion:${ingestion.ingestionId}`,
      visibility: ingestion.visibility
    },
    multimodalData: messages.map((message) => ({
      itemId: `conversation_message_${stableId(message.conversationMessageRowId)}`,
      type: message.role === "tool" ? "tool_result" as const : "text" as const,
      format: "conversation-message.v1",
      content: {
        text: message.content,
        messageId: message.messageId,
        sequence: message.sequence,
        role: message.role,
        status: message.status,
        branchId: message.branchId,
        revision: message.revision,
        operation: message.operation,
        createdAt: message.createdAt,
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {})
      },
      sourceRefs: [conversationMessageSourceRef(message)],
      timeBasis: "source_time" as const,
      timeConfidence: message.timeConfidence
    }))
  };
}

function conversationSegmentId(
  ingestion: ConversationIngestionRecord,
  message: ConversationMessageRecord,
  chunkIndex: number,
  chunk: ContentSlice
) {
  return `cseg_${stableId([
    ingestion.tenantId,
    ingestion.principalId,
    ingestion.sessionId,
    message.messageId,
    message.revision,
    chunkIndex,
    chunk.startOffset,
    chunk.endOffset,
    stableId(chunk.content)
  ].join(":"))}`;
}

function findPreferredBoundary(content: string, startOffset: number, hardEnd: number, limit: number) {
  const minimumEnd = startOffset + Math.floor(limit * 0.55);
  const slice = content.slice(startOffset, hardEnd);
  for (const marker of ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " "]) {
    const localIndex = slice.lastIndexOf(marker);
    if (localIndex < 0) continue;
    const candidate = startOffset + localIndex + marker.length;
    if (candidate >= minimumEnd) return candidate;
  }
  return hardEnd;
}

function normalizeChunkLimit(value: number | undefined) {
  return Number.isInteger(value) && (value ?? 0) > 0
    ? value as number
    : DEFAULT_CONVERSATION_MESSAGE_CHUNK_CHARS;
}

function stableId(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}
