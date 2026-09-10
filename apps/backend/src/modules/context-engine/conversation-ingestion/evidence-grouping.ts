import { createHash } from "node:crypto";
import type { ParsedSegment } from "../domain.js";
import { estimateContextTokens } from "../token-estimator.js";
import type {
  ConversationEvidenceGroupMemberRecord,
  ConversationEvidenceGroupRecord,
  ConversationExtractionWindowRecord,
  ConversationIngestionRecord,
  ConversationMessageRecord,
  ConversationMessageSegmentRecord
} from "./persistence.js";

export const DEFAULT_CONVERSATION_EXTRACTION_WINDOW_TOKENS = 12_000;

export interface ConversationEvidenceGroupingResult {
  groups: ConversationEvidenceGroupRecord[];
  windows: ConversationExtractionWindowRecord[];
}

export function groupConversationEvidence(
  ingestion: ConversationIngestionRecord,
  messages: readonly ConversationMessageRecord[],
  messageSegments: readonly ConversationMessageSegmentRecord[],
  parsedSegments: readonly ParsedSegment[],
  existingGroups: readonly ConversationEvidenceGroupRecord[],
  options: { now?: string; maxWindowTokens?: number } = {}
): ConversationEvidenceGroupingResult {
  const now = options.now ?? new Date().toISOString();
  const maxWindowTokens = normalizeWindowLimit(options.maxWindowTokens);
  const messageByRowId = new Map(messages.map((message) => [message.conversationMessageRowId, message]));
  const segmentById = new Map(parsedSegments.map((segment) => [segment.segmentId, segment]));
  const segmentsByMessageRowId = groupSegmentsByMessage(messageSegments);
  const workingGroups = new Map(existingGroups.map((group) => [group.groupId, cloneGroup(group)]));
  const touchedGroupIds = new Set<string>();

  for (const message of [...messages].sort(compareMessages)) {
    const records = segmentsByMessageRowId.get(message.conversationMessageRowId) ?? [];
    if (!records.length) continue;
    let group = findRelatedGroup(message, [...workingGroups.values()]);
    if (!group) {
      group = createGroup(ingestion, message, now);
      workingGroups.set(group.groupId, group);
    } else if (!touchedGroupIds.has(group.groupId) && requiresReopen(group)) {
      const reopened = cloneGroup(group);
      delete reopened.sealedAt;
      group = {
        ...reopened,
        version: group.version + 1,
        status: "reopened",
        boundaryReason: "explicit_relation_reopened",
        updatedAt: now
      };
      workingGroups.set(group.groupId, group);
    }

    if (!group) continue;
    appendMessageMembers(group, message, records, segmentById);
    group.updatedAt = now;
    touchedGroupIds.add(group.groupId);
  }

  const touchedGroups = [...touchedGroupIds]
    .map((groupId) => workingGroups.get(groupId))
    .filter((group): group is ConversationEvidenceGroupRecord => Boolean(group))
    .map((group) => finalizeGroupBoundary(group, messageByRowId, now));

  const windows = touchedGroups.flatMap((group) =>
    buildConversationExtractionWindows(group, segmentById, { now, maxWindowTokens })
  );
  return { groups: touchedGroups, windows };
}

export function buildConversationExtractionWindows(
  group: ConversationEvidenceGroupRecord,
  segmentById: ReadonlyMap<string, ParsedSegment>,
  options: { now?: string; maxWindowTokens?: number } = {}
): ConversationExtractionWindowRecord[] {
  const now = options.now ?? new Date().toISOString();
  const maxWindowTokens = normalizeWindowLimit(options.maxWindowTokens);
  const messageBuckets = new Map<string, ConversationEvidenceGroupMemberRecord[]>();
  for (const member of [...group.members].sort((left, right) => left.memberOrder - right.memberOrder)) {
    const bucket = messageBuckets.get(member.conversationMessageRowId) ?? [];
    bucket.push(member);
    messageBuckets.set(member.conversationMessageRowId, bucket);
  }

  const memberWindows: ConversationEvidenceGroupMemberRecord[][] = [];
  let current: ConversationEvidenceGroupMemberRecord[] = [];
  let currentTokens = 0;
  for (const members of messageBuckets.values()) {
    const messageTokens = members.reduce((sum, member) =>
      sum + estimateContextTokens(segmentById.get(member.segmentId)?.content ?? ""), 0);
    if (current.length && currentTokens + messageTokens > maxWindowTokens) {
      memberWindows.push(current);
      current = [];
      currentTokens = 0;
    }
    if (messageTokens > maxWindowTokens && members.length > 1) {
      for (const member of members) {
        const segmentTokens = estimateContextTokens(segmentById.get(member.segmentId)?.content ?? "");
        if (current.length && currentTokens + segmentTokens > maxWindowTokens) {
          memberWindows.push(current);
          current = [];
          currentTokens = 0;
        }
        current.push(member);
        currentTokens += segmentTokens;
      }
      continue;
    }
    current.push(...members);
    currentTokens += messageTokens;
  }
  if (current.length) memberWindows.push(current);

  return memberWindows.map((members, windowIndex) => {
    const segmentIds = members.map((member) => member.segmentId);
    const messageIds = [...new Set(members.map((member) => member.messageId))];
    return {
      windowId: `cwin_${stableId(`${group.groupId}:${group.version}:${windowIndex}:${segmentIds.join(":")}`)}`,
      groupId: group.groupId,
      groupVersion: group.version,
      windowIndex,
      tokenCount: members.reduce((sum, member) =>
        sum + estimateContextTokens(segmentById.get(member.segmentId)?.content ?? ""), 0),
      messageIds,
      segmentIds,
      createdAt: now
    };
  });
}

function createGroup(
  ingestion: ConversationIngestionRecord,
  message: ConversationMessageRecord,
  now: string
): ConversationEvidenceGroupRecord {
  return {
    groupId: `ceg_${stableId(`${ingestion.tenantId}:${ingestion.sourceApp}:${ingestion.principalId}:${ingestion.sessionId}:${message.branchId}:${message.messageId}`)}`,
    tenantId: ingestion.tenantId,
    sourceApp: ingestion.sourceApp,
    principalId: ingestion.principalId,
    sessionId: ingestion.sessionId,
    branchId: message.branchId,
    version: 1,
    status: "open",
    boundaryReason: "awaiting_more_messages",
    firstSequence: message.sequence,
    lastSequence: message.sequence,
    tokenCount: 0,
    members: [],
    createdAt: now,
    updatedAt: now
  };
}

function findRelatedGroup(
  message: ConversationMessageRecord,
  groups: ConversationEvidenceGroupRecord[]
) {
  const sameBranch = groups.filter((group) => group.branchId === message.branchId);
  const relatedMessageIds = new Set([
    message.messageId,
    ...(message.replyToMessageId ? [message.replyToMessageId] : []),
    ...(message.parentMessageId ? [message.parentMessageId] : [])
  ]);
  const explicit = sameBranch
    .filter((group) => group.members.some((member) =>
      relatedMessageIds.has(member.messageId) ||
      Boolean(message.toolCallId && member.toolCallId === message.toolCallId)
    ))
    .sort((left, right) => right.version - left.version || right.lastSequence - left.lastSequence)[0];
  if (explicit) return explicit;
  return sameBranch
    .filter((group) => group.status === "open" || group.status === "reopened")
    .sort((left, right) => right.lastSequence - left.lastSequence)[0];
}

function appendMessageMembers(
  group: ConversationEvidenceGroupRecord,
  message: ConversationMessageRecord,
  records: ConversationMessageSegmentRecord[],
  segmentById: ReadonlyMap<string, ParsedSegment>
) {
  const knownSegmentIds = new Set(group.members.map((member) => member.segmentId));
  for (const record of records) {
    if (knownSegmentIds.has(record.segmentId)) continue;
    group.members.push({
      ingestionId: record.ingestionId,
      conversationMessageRowId: record.conversationMessageRowId,
      messageId: record.messageId,
      segmentId: record.segmentId,
      sequence: record.sequence,
      role: record.role,
      branchId: record.branchId,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      memberOrder: group.members.length
    });
    group.tokenCount += estimateContextTokens(segmentById.get(record.segmentId)?.content ?? "");
    knownSegmentIds.add(record.segmentId);
  }
  group.members.sort((left, right) =>
    left.sequence - right.sequence || left.segmentId.localeCompare(right.segmentId)
  ).forEach((member, memberOrder) => {
    member.memberOrder = memberOrder;
  });
  group.firstSequence = Math.min(...group.members.map((member) => member.sequence));
  group.lastSequence = Math.max(...group.members.map((member) => member.sequence));
}

function finalizeGroupBoundary(
  group: ConversationEvidenceGroupRecord,
  messageByRowId: ReadonlyMap<string, ConversationMessageRecord>,
  now: string
): ConversationEvidenceGroupRecord {
  const groupMessageRowIds = new Set(group.members.map((member) => member.conversationMessageRowId));
  const lastMessage = [...messageByRowId.values()]
    .filter((message) => groupMessageRowIds.has(message.conversationMessageRowId))
    .sort(compareMessages)
    .at(-1);
  if (lastMessage?.role === "assistant" && !lastMessage.toolCallId) {
    return {
      ...group,
      status: "sealed" as const,
      boundaryReason: lastMessage.status === "completed" ? "assistant_completed" : "assistant_terminal",
      sealedAt: now,
      updatedAt: now
    };
  }
  const unsealed = cloneGroup(group);
  delete unsealed.sealedAt;
  return {
    ...unsealed,
    status: group.status === "reopened" ? "reopened" as const : "open" as const,
    boundaryReason: group.status === "reopened" ? "reopened_awaiting_completion" : "awaiting_more_messages",
    updatedAt: now
  };
}

function groupSegmentsByMessage(records: readonly ConversationMessageSegmentRecord[]) {
  const grouped = new Map<string, ConversationMessageSegmentRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.conversationMessageRowId) ?? [];
    bucket.push(record);
    bucket.sort((left, right) => left.chunkIndex - right.chunkIndex);
    grouped.set(record.conversationMessageRowId, bucket);
  }
  return grouped;
}

function compareMessages(left: ConversationMessageRecord, right: ConversationMessageRecord) {
  return left.sequence - right.sequence || left.revision - right.revision || left.messageId.localeCompare(right.messageId);
}

function requiresReopen(group: ConversationEvidenceGroupRecord) {
  return group.status === "sealed" || group.status === "processed" || group.status === "failed";
}

function cloneGroup(group: ConversationEvidenceGroupRecord): ConversationEvidenceGroupRecord {
  return { ...group, members: group.members.map((member) => ({ ...member })) };
}

function normalizeWindowLimit(value: number | undefined) {
  return Number.isInteger(value) && (value ?? 0) > 0
    ? value as number
    : DEFAULT_CONVERSATION_EXTRACTION_WINDOW_TOKENS;
}

function stableId(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}
