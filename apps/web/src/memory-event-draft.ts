import { parseCustomFieldInput, type CustomFieldValue } from "./data-lake-search";

export type Visibility = "private" | "team" | "tenant" | "public";

export interface EventDraft {
  source: "PRD.md" | "方案.md" | "manual";
  eventType: string;
  description: string;
  content: string;
  eventTime: string;
  visibility: Visibility;
  customFields: string;
}

export interface SourceRef {
  sourceRefId: string;
  sourceType: string;
  sourceId: string;
  sourceUrl?: string;
}

export type JsonValue = CustomFieldValue;

export interface MemoryEventPayload {
  eventId: string;
  eventType: string;
  eventSummary: string;
  eventTime: string;
  sourceApp: string;
  sourceId: string;
  permissionSnapshot: {
    snapshotId: string;
    tenantId: string;
    principalId: string;
    sourceAclVersion: string;
    visibility: Visibility;
  };
  multimodalData: Array<{
    itemId: string;
    type: "text" | "document" | "image" | "audio" | "video" | "tool_result";
    format: string;
    content: Record<string, JsonValue>;
    ref: string;
    sourceRefs: SourceRef[];
    timeBasis: "absolute" | "event_relative" | "media_offset" | "source_time";
    timeConfidence: "low" | "medium" | "high";
  }>;
}

export function parseDraftCustomFields(text: string) {
  const parsed = parseCustomFieldInput(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.fields;
}

export function parseDraftMultimodalContent(text: string): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("content_not_object");
    }
    return parsed as Record<string, JsonValue>;
  } catch {
    throw new Error("内容必须是 JSON 对象，例如 {\"text\":\"记忆正文\"}。");
  }
}

export function buildDebugMemoryEvent(
  draft: EventDraft,
  input: {
    eventTime: string;
    safeId: string;
  }
): MemoryEventPayload {
  const content = parseDraftMultimodalContent(draft.content);
  const source: SourceRef = {
    sourceRefId: `src_${input.safeId}`,
    sourceType: "file",
    sourceId: draft.source
  };
  return {
    eventId: `debug_${input.safeId}`,
    eventType: draft.eventType,
    eventSummary: draft.description,
    eventTime: input.eventTime,
    sourceApp: "context-debug-frontend",
    sourceId: draft.source,
    permissionSnapshot: {
      snapshotId: `ps_${input.safeId}`,
      tenantId: "local",
      principalId: "debug-user",
      sourceAclVersion: "debug-v1",
      visibility: draft.visibility
    },
    multimodalData: [
      {
        itemId: `item_${input.safeId}`,
        type: "text",
        format: "json",
        content,
        ref: draft.source,
        sourceRefs: [source],
        timeBasis: "source_time",
        timeConfidence: "high"
      }
    ]
  };
}
