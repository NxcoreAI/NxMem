import type { FactItem, MemoryEvent, MultimodalDataItem, ParsedSegment } from "./domain.js";

export function findSourceItem(
  event: MemoryEvent,
  segment: ParsedSegment
): MultimodalDataItem | undefined {
  const suffix = segment.segmentId.slice(`seg_${event.eventId}_`.length);
  return event.multimodalData.find((item) => item.itemId === suffix);
}

export function fuseFactTime(
  event: MemoryEvent,
  item: MultimodalDataItem | undefined
): {
  validTimeStart: string;
  validTimeEnd?: string;
  timeBasis: NonNullable<MultimodalDataItem["timeBasis"]>;
  timeConfidence: NonNullable<MultimodalDataItem["timeConfidence"]>;
} {
  const timeBasis = item?.timeBasis ?? "source_time";
  const timeConfidence = item?.timeConfidence ?? "medium";
  const itemValidTimeStart = readItemTimeField(item, "validTimeStart");
  const itemValidTimeEnd = readItemTimeField(item, "validTimeEnd");

  return {
    validTimeStart: itemValidTimeStart ?? event.eventTime,
    ...(itemValidTimeEnd ? { validTimeEnd: itemValidTimeEnd } : {}),
    timeBasis,
    timeConfidence
  };
}

function readItemTimeField(item: MultimodalDataItem | undefined, field: "validTimeStart" | "validTimeEnd") {
  if (!item?.content || typeof item.content !== "object" || Array.isArray(item.content)) return undefined;
  const value = item.content[field];
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed;
}

export function normalizeClaim(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function validateFactItem(fact: FactItem): string | undefined {
  if (!fact.factId) return "fact_id_required";
  if (!fact.factText) return "fact_text_required";
  if (!fact.normalizedClaim) return "normalized_claim_required";
  if (!fact.linkedEventIds.length) return "linked_event_required";
  if (!fact.linkedSegmentIds.length) return "linked_segment_required";
  if (!fact.linkedSourceRefs.length) return "source_ref_required";
  if (!fact.observedAt || Number.isNaN(Date.parse(fact.observedAt))) return "observed_at_invalid";
  if (fact.validTimeStart && Number.isNaN(Date.parse(fact.validTimeStart))) {
    return "valid_time_start_invalid";
  }
  if (fact.validTimeEnd && Number.isNaN(Date.parse(fact.validTimeEnd))) {
    return "valid_time_end_invalid";
  }
  if (
    fact.validTimeStart
    && fact.validTimeEnd
    && Date.parse(fact.validTimeEnd) < Date.parse(fact.validTimeStart)
  ) {
    return "valid_time_end_before_start";
  }
  if (fact.evidenceTimeStart && Number.isNaN(Date.parse(fact.evidenceTimeStart))) {
    return "evidence_time_start_invalid";
  }
  if (fact.evidenceTimeEnd && Number.isNaN(Date.parse(fact.evidenceTimeEnd))) {
    return "evidence_time_end_invalid";
  }
  if (
    fact.evidenceTimeStart
    && fact.evidenceTimeEnd
    && Date.parse(fact.evidenceTimeEnd) < Date.parse(fact.evidenceTimeStart)
  ) {
    return "evidence_time_end_before_start";
  }
  if (fact.evidenceTime && Number.isNaN(Date.parse(fact.evidenceTime))) {
    return "evidence_time_invalid";
  }
  if (fact.validTime && Number.isNaN(Date.parse(fact.validTime))) {
    return "valid_time_invalid";
  }
  if (fact.events?.some((event) =>
    !event.eventKey.trim() || !event.label.trim() || Number.isNaN(Date.parse(event.validTime))
  )) {
    return "temporal_event_invalid";
  }
  if (
    !fact.validTime &&
    !fact.evidenceTime &&
    !fact.validTimeStart &&
    (!fact.evidenceTimeStart || Number.isNaN(Date.parse(fact.evidenceTimeStart)))
  ) {
    return "fact_temporal_anchor_invalid";
  }
  return undefined;
}
