import type { TemporalErrorCode } from "./domain.js";
import type { ConversationProtocolValidationIssue } from "./conversation-ingestion/markdown-protocol.js";
import { TemporalQueryError } from "./temporal-query.js";

const temporalProtocolPath = /(?:messageId|createdAt|completedAt|timezone|locale|temporal)/u;

export function classifyConversationProtocolIssues(
  issues: readonly ConversationProtocolValidationIssue[]
): TemporalErrorCode[] {
  return uniqueTemporalErrorCodes(issues.flatMap((issue) =>
    temporalProtocolPath.test(issue.path) || /(?:timestamp|timezone|locale|temporal|message ID)/iu.test(issue.message)
      ? ["TEMPORAL_PROTOCOL_INVALID" as const]
      : []
  ));
}

export function classifyTemporalValidationReason(reason: string): TemporalErrorCode | undefined {
  if (/(?:source_message|linked_segment|evidence_window).*(?:not_found|missing|outside|do_not_match)/u.test(reason)) {
    return "TEMPORAL_SOURCE_NOT_FOUND";
  }
  if (/(?:quote|evidence_quote).*(?:not_found|mismatch|missing)/u.test(reason)) {
    return "TEMPORAL_QUOTE_MISMATCH";
  }
  if (/(?:temporal_metadata_missing|valid_time_.*requires_start|time_not_recomputable)/u.test(reason)) {
    return "TEMPORAL_METADATA_MISSING";
  }
  return undefined;
}

export function classifyTemporalError(error: unknown): TemporalErrorCode | undefined {
  if (error instanceof TemporalQueryError) {
    return error.code === "TEMPORAL_RANGE_INVALID"
      ? "TEMPORAL_RANGE_INVALID"
      : "TEMPORAL_PROTOCOL_INVALID";
  }
  if (error instanceof Error && error.message === "TEMPORAL_METADATA_MISSING") {
    return "TEMPORAL_METADATA_MISSING";
  }
  return undefined;
}

export function temporalDropReasonErrorCode(reason: string): TemporalErrorCode | undefined {
  return reason === "temporal_metadata_missing" ? "TEMPORAL_METADATA_MISSING" : undefined;
}

export function temporalErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(/[\r\n\t]+/gu, " ").slice(0, 240);
  }
  return "Unknown temporal processing error.";
}

export function uniqueTemporalErrorCodes(values: readonly TemporalErrorCode[]) {
  return [...new Set(values)];
}
