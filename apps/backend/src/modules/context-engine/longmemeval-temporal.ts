import { createHash } from "node:crypto";
import type { FactItem } from "./domain.js";
import {
  containsDeterministicRelativeTimeExpression,
  resolveDeterministicTemporalRange
} from "./temporal-query.js";

export interface LongMemEvalFactTemporal {
  evidenceTime: string;
  validTime?: string;
  validTimeStart?: string;
  validTimeEnd?: string;
  events?: NonNullable<FactItem["events"]>;
}

export interface LongMemEvalTimeAnchorInput {
  evidenceTime: string;
  timeAnchor: string | null;
  factText?: string;
}

export function resolveLongMemEvalTimeAnchor(
  input: LongMemEvalTimeAnchorInput
): LongMemEvalFactTemporal {
  return resolveLongMemEvalTemporalExpression(
    input.timeAnchor ?? "",
    input.evidenceTime,
    input.factText ?? input.timeAnchor ?? "",
    false
  );
}

export function resolveLongMemEvalFactTemporal(
  text: string,
  evidenceTime: string
): LongMemEvalFactTemporal {
  return resolveLongMemEvalTemporalExpression(text, evidenceTime, text, true);
}

function resolveLongMemEvalTemporalExpression(
  expression: string,
  evidenceTime: string,
  factText: string,
  includeEvents: boolean
): LongMemEvalFactTemporal {
  const normalizedEvidenceTime = normalizeTimestamp(evidenceTime);
  if (!normalizedEvidenceTime) {
    throw new Error("LONGMEMEVAL_EVIDENCE_TIME_INVALID");
  }
  const normalizedText = expression.normalize("NFKC");
  if (!normalizedText.trim() || containsVagueRelativeTime(normalizedText)) {
    return { evidenceTime: normalizedEvidenceTime };
  }
  const anchoredDuration = resolveAnchoredDuration(normalizedText, factText, normalizedEvidenceTime);
  if (anchoredDuration) {
    return {
      evidenceTime: normalizedEvidenceTime,
      validTimeStart: anchoredDuration.startTime,
      validTimeEnd: anchoredDuration.endTime
    };
  }
  const explicitRange = resolveExplicitRange(normalizedText, normalizedEvidenceTime);
  if (explicitRange) {
    return {
      evidenceTime: normalizedEvidenceTime,
      validTimeStart: explicitRange.startTime,
      validTimeEnd: explicitRange.endTime
    };
  }
  const relativeWeekday = resolveRelativeWeekday(normalizedText, normalizedEvidenceTime);
  if (relativeWeekday) {
    return { evidenceTime: normalizedEvidenceTime, ...relativeWeekday };
  }
  const relativeWeekend = resolveRelativeWeekend(normalizedText, normalizedEvidenceTime);
  if (relativeWeekend) {
    return { evidenceTime: normalizedEvidenceTime, ...relativeWeekend };
  }
  const namedMonth = resolveStandaloneNamedMonth(normalizedText, normalizedEvidenceTime);
  if (namedMonth) {
    return {
      evidenceTime: normalizedEvidenceTime,
      validTimeStart: namedMonth.startTime,
      validTimeEnd: namedMonth.endTime
    };
  }
  const deterministicText = normalizeEnglishRelativeDirection(normalizedText);

  const numericDate = readNumericMonthDay(normalizedText, normalizedEvidenceTime);
  if (numericDate) {
    return {
      evidenceTime: normalizedEvidenceTime,
      validTime: numericDate,
      ...(includeEvents ? resolvedTemporalEvents(factText, normalizedEvidenceTime) : {})
    };
  }

  const resolved = resolveDeterministicTemporalRange(
    deterministicText,
    normalizedEvidenceTime,
    "UTC",
    "en-US"
  );
  const clockTime = readClockTime(normalizedText);
  if (resolved) {
    if (!clockTime && isCalendarPeriodExpression(deterministicText)) {
      return {
        evidenceTime: normalizedEvidenceTime,
        validTimeStart: resolved.startTime,
        validTimeEnd: resolved.endTime
      };
    }
    return {
      evidenceTime: normalizedEvidenceTime,
      validTime: clockTime
        ? applyUtcClock(resolved.startTime, clockTime)
        : resolved.startTime,
      ...(includeEvents ? resolvedTemporalEvents(factText, normalizedEvidenceTime) : {})
    };
  }
  if (clockTime) {
    return {
      evidenceTime: normalizedEvidenceTime,
      validTime: applyUtcClock(normalizedEvidenceTime, clockTime),
      ...(includeEvents ? resolvedTemporalEvents(factText, normalizedEvidenceTime) : {})
    };
  }
  return { evidenceTime: normalizedEvidenceTime };
}

export function applyLongMemEvalFactTemporal(
  fact: FactItem,
  evidenceTime: string
): FactItem {
  const temporalText = fact.sourceClaim && containsDeterministicRelativeTimeExpression(
    normalizeEnglishRelativeDirection(fact.sourceClaim)
  )
    ? fact.sourceClaim
    : fact.factText;
  const temporal = fact.timeAnchor !== undefined
    ? resolveLongMemEvalTimeAnchor({
      evidenceTime,
      timeAnchor: fact.timeAnchor ?? null,
      factText: fact.factText
    })
    : resolveLongMemEvalFactTemporal(temporalText, evidenceTime);
  const {
    evidenceTimeStart: _evidenceTimeStart,
    evidenceTimeEnd: _evidenceTimeEnd,
    evidenceTimeConfidence: _evidenceTimeConfidence,
    validTime: _validTime,
    validTimeStart: _validTimeStart,
    validTimeEnd: _validTimeEnd,
    validTimeBasis: _validTimeBasis,
    validTimeConfidence: _validTimeConfidence,
    ...factWithoutRangeTimes
  } = fact;
  const resolutionText = fact.timeAnchor ?? temporalText;
  const hasRelativeTime = containsDeterministicRelativeTimeExpression(
    normalizeEnglishRelativeDirection(resolutionText)
  ) || Boolean(temporal.validTimeStart);
  return {
    ...factWithoutRangeTimes,
    evidenceTime: temporal.evidenceTime,
    ...(temporal.validTime && (temporal.events?.length ?? 0) <= 1 ? { validTime: temporal.validTime } : {}),
    ...(temporal.validTimeStart ? { validTimeStart: temporal.validTimeStart } : {}),
    ...(temporal.validTimeEnd ? { validTimeEnd: temporal.validTimeEnd } : {}),
    ...(temporal.validTimeStart ? {
      validTimeBasis: hasRelativeTime ? "event_relative" as const : "absolute" as const
    } : {}),
    ...(temporal.validTimeStart ? { validTimeConfidence: "high" as const } : {}),
    ...(temporal.events?.length ? {
      events: temporal.events.map((event) => ({ ...event, sourceFactIds: [fact.factId] }))
    } : {}),
    timeBasis: temporal.validTime || temporal.validTimeStart
      ? hasRelativeTime ? "event_relative" : "absolute"
      : "source_time",
    timeConfidence: temporal.validTime || temporal.validTimeStart ? "high" : fact.timeConfidence
  };
}

function resolveAnchoredDuration(timeAnchor: string, factText: string, evidenceTime: string) {
  if (!/\b(?:have|has|'ve)\s+been\b/iu.test(factText)) return undefined;
  const match = timeAnchor.match(/\bfor\s+(?:about\s+)?(an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(minutes?|hours?|days?|weeks?|months?|years?)\b/iu);
  if (!match?.[1] || !match[2]) return undefined;
  const start = resolveDeterministicTemporalRange(
    `${match[1]} ${match[2]} ago`,
    evidenceTime,
    "UTC",
    "en-US"
  );
  if (!start) return undefined;
  return {
    startTime: start.startTime,
    endTime: evidenceTime
  };
}

function resolveExplicitRange(text: string, evidenceTime: string) {
  const clockRange = text.match(/\b([01]?\d|2[0-3])[:：]([0-5]\d)\s*(?:-|–|—|to)\s*([01]?\d|2[0-3])[:：]([0-5]\d)\b/iu);
  if (clockRange) {
    const start = applyUtcClock(evidenceTime, { hour: Number(clockRange[1]), minute: Number(clockRange[2]) });
    let end = applyUtcClock(evidenceTime, { hour: Number(clockRange[3]), minute: Number(clockRange[4]) });
    if (Date.parse(end) <= Date.parse(start)) {
      end = new Date(Date.parse(end) + 24 * 60 * 60 * 1000).toISOString();
    }
    return { startTime: start, endTime: end };
  }

  const namedDate = "(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,\\s*\\d{4})?)?";
  const namedRange = text.match(new RegExp(
    `\\b(?:from\\s+|between\\s+)(${namedDate})\\s+(?:to|through|until|and)\\s+(${namedDate})\\b`,
    "iu"
  ));
  if (namedRange) {
    const startText = (namedRange[1] ?? "").trim();
    const endText = (namedRange[2] ?? "").trim();
    const start = resolveNamedMonthOrDate(startText, evidenceTime) ?? resolveSingleTemporalClause(startText, evidenceTime);
    const end = resolveNamedMonthOrDate(endText, evidenceTime) ?? resolveSingleTemporalClause(endText, evidenceTime);
    if (start && end && Date.parse(end) >= Date.parse(start)) {
      return {
        startTime: start,
        endTime: exclusiveRangeEnd(endText, end)
      };
    }
  }

  const relativeRange = /\b(?:during|over)\s+(?:the\s+)?(?:past|last)\b/iu.test(text)
    ? resolveDeterministicTemporalRange(text, evidenceTime, "UTC", "en-US")
    : undefined;
  if (relativeRange && Date.parse(relativeRange.endTime) > Date.parse(relativeRange.startTime)) {
    return relativeRange;
  }
  return undefined;
}

function resolveNamedMonthOrDate(text: string, evidenceTime: string) {
  const match = text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{1,2})(?:st|nd|rd|th)?)?(?:,\s*(\d{4}))?$/iu);
  if (!match?.[1]) return undefined;
  const months: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11
  };
  const month = months[match[1].toLocaleLowerCase()];
  if (month === undefined) return undefined;
  const reference = new Date(evidenceTime);
  const year = match[3] ? Number(match[3]) : reference.getUTCFullYear();
  const day = match[2] ? Number(match[2]) : 1;
  const value = new Date(Date.UTC(year, month, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month || value.getUTCDate() !== day) {
    return undefined;
  }
  return value.toISOString();
}

function exclusiveRangeEnd(text: string, resolved: string) {
  const date = new Date(resolved);
  if (/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b(?!\s+\d)/iu.test(text)) {
    date.setUTCMonth(date.getUTCMonth() + 1, 1);
  } else {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString();
}

function resolveRelativeWeekday(text: string, evidenceTime: string) {
  const match = text.match(/\b(last|this|next)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/iu);
  if (!match?.[1] || !match[2]) return undefined;
  const weekdays: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };
  const target = weekdays[match[2].toLocaleLowerCase()];
  if (target === undefined) return undefined;
  const reference = new Date(evidenceTime);
  const current = reference.getUTCDay();
  const direction = match[1].toLocaleLowerCase();
  const delta = direction === "last"
    ? -(((current - target + 7) % 7) || 7)
    : direction === "next"
      ? ((target - current + 7) % 7) || 7
      : target - current;
  return { validTime: new Date(Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate() + delta
  )).toISOString() };
}

function resolveRelativeWeekend(text: string, evidenceTime: string) {
  const match = text.match(/\b(last|this|next)\s+weekend\b/iu);
  if (!match?.[1]) return undefined;
  const reference = new Date(evidenceTime);
  const day = reference.getUTCDay();
  const direction = match[1].toLocaleLowerCase();
  const currentSaturdayDelta = 6 - day;
  const offset = direction === "last"
    ? (day === 0 ? -8 : currentSaturdayDelta - 7)
    : direction === "next"
      ? currentSaturdayDelta + 7
      : currentSaturdayDelta;
  const start = new Date(Date.UTC(
    reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() + offset
  ));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 2);
  return { validTimeStart: start.toISOString(), validTimeEnd: end.toISOString() };
}

function resolveStandaloneNamedMonth(text: string, evidenceTime: string) {
  const match = text.match(/\b(?:in|during|throughout|around)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/iu)
    ?? text.match(/^\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s*$/iu);
  if (!match?.[1]) return undefined;
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const month = monthNames.indexOf(match[1].toLocaleLowerCase());
  if (month < 0) return undefined;
  const reference = new Date(evidenceTime);
  let year = reference.getUTCFullYear();
  if (month > reference.getUTCMonth()) year -= 1;
  return {
    startTime: new Date(Date.UTC(year, month, 1)).toISOString(),
    endTime: new Date(Date.UTC(year, month + 1, 1)).toISOString()
  };
}

function isCalendarPeriodExpression(text: string) {
  return /(?:上周|本周|这周|下周|上个月|本月|这个月|下个月|去年|今年|明年|last week|this week|next week|last month|this month|next month|last year|this year|next year)/iu.test(text);
}

function resolvedTemporalEvents(text: string, evidenceTime: string) {
  const clauses = temporalEventClauses(text);
  const events = clauses.flatMap((label) => {
    const resolved = resolveSingleTemporalClause(label, evidenceTime);
    if (!resolved) return [];
    return [{
      eventKey: stableTemporalEventKey(label),
      label,
      validTime: resolved,
      evidenceTime
    }];
  });
  const uniqueEvents = [...new Map(events.map((event) => [
    `${event.eventKey}\u0000${event.validTime}`,
    event
  ])).values()];
  return uniqueEvents.length ? { events: uniqueEvents } : {};
}

function resolveSingleTemporalClause(text: string, evidenceTime: string) {
  if (containsVagueRelativeTime(text)) return undefined;
  const numericDate = readNumericMonthDay(text, evidenceTime);
  if (numericDate) return numericDate;
  const deterministicText = normalizeEnglishRelativeDirection(text);
  const resolved = resolveDeterministicTemporalRange(deterministicText, evidenceTime, "UTC", "en-US");
  const clockTime = readClockTime(text);
  if (resolved) return clockTime ? applyUtcClock(resolved.startTime, clockTime) : resolved.startTime;
  return clockTime ? applyUtcClock(evidenceTime, clockTime) : undefined;
}

function readNumericMonthDay(text: string, evidenceTime: string) {
  const match = text.match(/(?<!\d)(1[0-2]|0?[1-9])\s*\/\s*(3[01]|[12]\d|0?[1-9])(?:\s*\/\s*(\d{4}))?(?!\d)/u);
  if (!match) return undefined;
  const evidenceDate = new Date(evidenceTime);
  const year = match[3] ? Number(match[3]) : evidenceDate.getUTCFullYear();
  const month = Number(match[1]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return undefined;
  return date.toISOString();
}

function temporalEventClauses(text: string) {
  const normalized = text
    .replace(/\\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .trim();
  if (!normalized) return [];
  const clauses = normalized
    .split(/(?:\n+|(?<=[.!?。！？;；])\s+|\s*[;；]\s*)/u)
    .map((clause) => clause.replace(/^[\s*#>-]+|\s+$/gu, "").replace(/\s+/gu, " "))
    .filter(Boolean);
  return clauses.length ? clauses : [normalized];
}

function stableTemporalEventKey(label: string) {
  const normalized = label.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  const slug = normalized
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48) || "event";
  return `${slug}_${createHash("sha256").update(normalized).digest("hex").slice(0, 10)}`;
}

export function longMemEvalFactTimelineTime(
  fact: Pick<FactItem, "evidenceTime" | "validTime" | "observedAt">
) {
  return fact.validTime ?? fact.evidenceTime ?? fact.observedAt;
}

function normalizeTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function containsVagueRelativeTime(text: string) {
  return /(?:几|数)\s*(?:分钟|小时|天|周|个月|月|年)\s*(?:前|后)|\b(?:a few|several)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+(?:ago|later|from now|before|after)\b/iu.test(text);
}

function normalizeEnglishRelativeDirection(text: string) {
  return text
    .replace(/\b((?:an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:minutes?|hours?|days?|weeks?|months?|years?))\s+before\b/giu, "$1 ago")
    .replace(/\b((?:an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:minutes?|hours?|days?|weeks?|months?|years?))\s+after\b/giu, "$1 later");
}

function readClockTime(text: string) {
  const match = text.match(/(?:^|\D)([01]?\d|2[0-3])[:：]([0-5]\d)(?:\s*(am|pm))?/iu);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3]?.toLocaleLowerCase();
  if (period === "am" && hour === 12) hour = 0;
  if (period === "pm" && hour < 12) hour += 12;
  return { hour, minute };
}

function applyUtcClock(dateTime: string, clock: { hour: number; minute: number }) {
  const date = new Date(dateTime);
  date.setUTCHours(clock.hour, clock.minute, 0, 0);
  return date.toISOString();
}
