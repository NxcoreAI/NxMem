import type { DataLakeCustomFields, DataLakeCustomFieldValue, MemoryEvent, MultimodalDataItem, SourceRef } from "./domain.js";

export function memoryEventSummary(event: Pick<MemoryEvent, "eventSummary" | "eventDescription" | "eventType">): string {
  return event.eventSummary?.trim() || event.eventDescription?.trim() || event.eventType;
}

export function multimodalContentToText(content: MultimodalDataItem["content"]): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined || content === null) return "";
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content.map(multimodalContentToText).filter(Boolean).join("\n");
  }

  for (const key of ["text", "content", "body", "transcript", "summary"] as const) {
    const value = content[key];
    const text = multimodalContentToText(value);
    if (text) return text;
  }

  return collectJsonText(content).join("\n").trim();
}

export function multimodalContentToStorage(content: MultimodalDataItem["content"]): string | null {
  if (content === undefined || content === null) return null;
  return typeof content === "string" ? content : JSON.stringify(content);
}

export function multimodalContentPreview(content: MultimodalDataItem["content"], limit = 500): string {
  return multimodalContentToText(content).slice(0, limit);
}

export function sourceRefsFromEvent(event: Pick<MemoryEvent, "sourceRefs" | "multimodalData">): SourceRef[] {
  const refs = [
    ...(event.sourceRefs ?? []),
    ...(event.multimodalData ?? []).flatMap(sourceRefsFromItem)
  ];
  return uniqueSourceRefs(refs);
}

export function normalizeMemoryEventSourceRefs(event: MemoryEvent): MemoryEvent {
  const multimodalData = event.multimodalData.map((item) => {
    const itemSourceRefs = sourceRefsFromItem(item);
    const { sourceRef: _sourceRef, sourceRefs: _sourceRefs, ...rest } = item as MultimodalDataItem & { sourceRef?: SourceRef };
    return {
      ...rest,
      ...(itemSourceRefs.length ? { sourceRefs: itemSourceRefs } : {})
    };
  });
  const normalizedEvent = {
    ...event,
    multimodalData
  };

  return {
    ...normalizedEvent,
    sourceRefs: sourceRefsFromEvent(normalizedEvent)
  };
}

export function primarySourceRefForEvent(event: Pick<MemoryEvent, "sourceRefs" | "multimodalData">): SourceRef | undefined {
  return sourceRefsFromEvent(event)[0];
}

export function primarySourceRefForItem(event: Pick<MemoryEvent, "sourceRefs" | "multimodalData">, item?: MultimodalDataItem): SourceRef | undefined {
  return sourceRefsFromItem(item).at(0) ?? primarySourceRefForEvent(event);
}

export function sourceRefsFromItem(item: MultimodalDataItem | undefined): SourceRef[] {
  if (!item) return [];
  const legacyItem = item as MultimodalDataItem & { sourceRef?: SourceRef };
  return uniqueSourceRefs([
    ...(legacyItem.sourceRef ? [legacyItem.sourceRef] : []),
    ...(item.sourceRefs ?? [])
  ]);
}

export function customFieldsFromMultimodalContent(content: MultimodalDataItem["content"]): DataLakeCustomFields | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const fields = Object.fromEntries(
    Object.entries(content)
      .filter(([key]) => key.trim().length > 0)
      .filter(([, value]) => isDataLakeCustomFieldValue(value))
  ) as DataLakeCustomFields;
  return Object.keys(fields).length ? fields : undefined;
}

export function mergeDataLakeFields(...items: Array<DataLakeCustomFields | undefined>): DataLakeCustomFields | undefined {
  const merged = Object.assign({}, ...items.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
}

function uniqueSourceRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const unique: SourceRef[] = [];
  for (const ref of refs) {
    if (!ref?.sourceRefId || seen.has(ref.sourceRefId)) continue;
    seen.add(ref.sourceRefId);
    unique.push(ref);
  }
  return unique;
}

function collectJsonText(value: DataLakeCustomFieldValue): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (value === null) return [];
  if (Array.isArray(value)) return value.flatMap(collectJsonText);
  return Object.values(value).flatMap(collectJsonText);
}

function isDataLakeCustomFieldValue(value: unknown): value is DataLakeCustomFieldValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return true;
  if (Array.isArray(value)) return value.every(isDataLakeCustomFieldValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isDataLakeCustomFieldValue);
  return false;
}
