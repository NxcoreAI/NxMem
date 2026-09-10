import type { ConversationMessageRecord } from "./persistence.js";
import {
  containsDeterministicRelativeTimeExpression,
  resolveDeterministicTemporalRange
} from "../temporal-query.js";

export const CONVERSATION_VALID_TIME_BASES = ["absolute", "event_relative", "source_time"] as const;
export const CONVERSATION_TIME_CONFIDENCES = ["low", "medium", "high"] as const;

export type ConversationValidTimeBasis = typeof CONVERSATION_VALID_TIME_BASES[number];
export type ConversationTemporalConfidence = typeof CONVERSATION_TIME_CONFIDENCES[number];

export interface ConversationCandidateTemporalFields {
  validTimeStart?: string;
  validTimeEnd?: string;
  validTimeBasis?: ConversationValidTimeBasis;
  validTimeConfidence?: ConversationTemporalConfidence;
}

export function normalizeConversationCandidateMonthTemporal(input: {
  sourceMessageIds: readonly string[];
  evidenceQuotes: readonly string[];
  messages: readonly ConversationMessageRecord[];
  timezone?: string;
}): ConversationCandidateTemporalFields | undefined {
  if (!input.timezone) return undefined;
  const sourceIds = new Set(input.sourceMessageIds);
  const resolutions = input.messages.flatMap((message) => {
    if (!sourceIds.has(message.messageId)) return [];
    return input.evidenceQuotes.flatMap((quote) => {
      if (!message.content.includes(quote)) return [];
      const point = containsMonthRelativePoint(quote);
      const duration = point ? undefined : readAnchoredMonthDuration(quote);
      const expression = point ?? (duration ? `${duration} months ago` : undefined);
      if (!expression) return [];
      const range = resolveDeterministicTemporalRange(
        expression,
        message.createdAt,
        input.timezone as string,
        message.locale ?? "und"
      );
      if (!range) return [];
      return [{
        validTimeStart: range.startTime,
        ...(duration ? { validTimeEnd: new Date(message.createdAt).toISOString() } : {}),
        validTimeBasis: "event_relative" as const,
        validTimeConfidence: /\babout\b|(?:大约|约)/iu.test(quote) ? "medium" as const : "high" as const
      }];
    });
  });
  const unique = [...new Map(resolutions.map((item) => [
    `${item.validTimeStart}\u0000${item.validTimeEnd ?? ""}`,
    item
  ])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

export function validateConversationCandidateSources(input: {
  sourceMessageIds: readonly string[];
  evidenceQuotes: readonly string[];
  messages: readonly ConversationMessageRecord[];
  timezone?: string;
  temporal: ConversationCandidateTemporalFields;
}): { kind: "invalid" | "pending"; reason: string } | undefined {
  const messageById = latestMessageById(input.messages);
  const sourceMessages = input.sourceMessageIds.flatMap((messageId) => {
    const message = messageById.get(messageId);
    return message ? [message] : [];
  });
  if (sourceMessages.length !== input.sourceMessageIds.length) {
    return { kind: "invalid", reason: "source_message_id_not_found_in_ingestion" };
  }
  if (input.evidenceQuotes.some((quote) => !sourceMessages.some((message) => message.content.includes(quote)))) {
    return { kind: "invalid", reason: "evidence_quote_not_found_in_source_message" };
  }
  if (sourceMessages.some((message) => !input.evidenceQuotes.some((quote) => message.content.includes(quote)))) {
    return { kind: "invalid", reason: "source_message_missing_evidence_quote" };
  }

  const { validTimeStart, validTimeEnd, validTimeBasis } = input.temporal;
  if (validTimeEnd && !validTimeStart) {
    return { kind: "invalid", reason: "valid_time_end_requires_start" };
  }
  if (validTimeStart && validTimeEnd && Date.parse(validTimeEnd) < Date.parse(validTimeStart)) {
    return { kind: "invalid", reason: "valid_time_end_before_start" };
  }
  if ((validTimeBasis === "absolute" || validTimeBasis === "event_relative") && !validTimeStart) {
    return { kind: "pending", reason: "valid_time_basis_requires_start" };
  }
  const hasRelativeExpression = input.evidenceQuotes.some(containsRelativeTimeExpression);
  if (hasRelativeExpression && !validTimeStart) {
    return { kind: "pending", reason: "relative_expression_valid_time_missing" };
  }
  if (hasRelativeExpression && validTimeBasis !== "event_relative") {
    return { kind: "pending", reason: "relative_expression_requires_event_relative_basis" };
  }
  if (validTimeBasis !== "event_relative") return undefined;
  if (!input.timezone) {
    return { kind: "pending", reason: "event_relative_timezone_missing" };
  }

  const candidateTimestamp = validTimeStart ? Date.parse(validTimeStart) : Number.NaN;
  if (!Number.isFinite(candidateTimestamp)) {
    return { kind: "pending", reason: "event_relative_time_not_recomputable" };
  }

  const expectedRanges = sourceMessages.flatMap((message) => {
    const matchingQuotes = input.evidenceQuotes.filter((quote) => message.content.includes(quote));
    return matchingQuotes.flatMap((quote) => {
      try {
        const range = resolveDeterministicTemporalRange(
          quote,
          message.createdAt,
          input.timezone as string,
          message.locale ?? "und"
        );
        return range ? [range] : [];
      } catch {
        return [];
      }
    });
  });
  if (!expectedRanges.some((range) =>
    candidateTimestamp >= Date.parse(range.startTime) && candidateTimestamp < Date.parse(range.endTime)
  )) {
    return { kind: "pending", reason: "event_relative_time_not_recomputable" };
  }
  return undefined;
}

export function conversationEvidenceTimeRange(messages: readonly ConversationMessageRecord[]) {
  const ordered = [...messages].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.sequence - right.sequence
  );
  return {
    ...(ordered[0] ? { evidenceTimeStart: ordered[0].createdAt } : {}),
    ...(ordered.at(-1) ? { evidenceTimeEnd: ordered.at(-1)!.createdAt } : {}),
    evidenceTimeConfidence: lowestConversationTimeConfidence(messages.map((message) => message.timeConfidence))
  };
}

export function lowestConversationTimeConfidence(
  values: readonly ConversationTemporalConfidence[]
): ConversationTemporalConfidence {
  const ranks: Record<ConversationTemporalConfidence, number> = { low: 0, medium: 1, high: 2 };
  return [...values].sort((left, right) => ranks[left] - ranks[right])[0] ?? "low";
}

export function conversationMessageSourceRef(message: ConversationMessageRecord) {
  return {
    sourceRefId: message.conversationMessageRowId,
    sourceType: "conversation_message",
    sourceId: message.conversationMessageRowId,
    metadata: {
      messageId: message.messageId,
      sessionId: message.sessionId,
      ingestionId: message.ingestionId,
      revision: message.revision
    }
  } as const;
}

export function latestConversationMessagesById(messages: readonly ConversationMessageRecord[]) {
  return latestMessageById(messages);
}

function latestMessageById(messages: readonly ConversationMessageRecord[]) {
  const result = new Map<string, ConversationMessageRecord>();
  for (const message of messages) {
    const current = result.get(message.messageId);
    if (!current || message.revision > current.revision) result.set(message.messageId, message);
  }
  return result;
}

function containsRelativeTimeExpression(value: string) {
  return containsDeterministicRelativeTimeExpression(value) ||
    /(?:几|数)\s*(?:分钟|小时|天|周|个月|月|年)\s*(?:前|后)|\b(?:a few|several)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+(?:ago|later|from now)\b/iu.test(value);
}

function containsMonthRelativePoint(text: string) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const calendarMonth = normalized.match(/(?:上个月|last month)/iu);
  if (calendarMonth) return calendarMonth[0];
  const chinese = normalized.match(/[零〇一二两三四五六七八九十百千\d]+\s*(?:个月|月)\s*前/iu);
  if (chinese) return chinese[0];
  const english = normalized.match(/\b(?:an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+months?\s+ago\b/iu);
  return english?.[0];
}

function readAnchoredMonthDuration(text: string) {
  return text.match(/\b(?:have|has|'ve)\s+been\b[\s\S]{0,240}?\bfor\s+(?:about\s+)?(an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+months?\b/iu)?.[1];
}
