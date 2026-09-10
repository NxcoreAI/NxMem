import type { CustomFieldValue } from "./data-lake-search";

interface ContextEventTitleInput {
  eventType: string;
  eventSummary?: string;
  eventDescription?: string;
  multimodalData?: Array<{
    content?: CustomFieldValue;
  }>;
}

export function formatContextEventTitle(event: ContextEventTitleInput): CustomFieldValue {
  const summary = event.eventSummary?.trim();
  if (summary) return summary;

  const content = event.multimodalData?.[0]?.content;
  const text = readTextContent(content);
  if (text) return text;
  if (content !== undefined) return content;

  return event.eventDescription?.trim() || event.eventType;
}

function readTextContent(content: CustomFieldValue | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object" || Array.isArray(content)) return "";

  const text = content.text;
  return typeof text === "string" ? text.trim() : "";
}
