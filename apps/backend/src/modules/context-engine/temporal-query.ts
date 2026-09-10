export type TemporalSearchBasis = "evidence" | "valid" | "auto";
export type MatchedTemporalBasis = Exclude<TemporalSearchBasis, "auto">;

export interface TemporalSearchRange {
  startTime: string;
  endTime: string;
  basis?: TemporalSearchBasis;
}

export interface ResolvedTemporalQuery {
  range?: {
    startTime: string;
    endTime: string;
  };
  basis: TemporalSearchBasis;
  referenceTime: string;
  timezone: string;
  locale: string;
  confidence: "low" | "medium" | "high";
  source: "explicit" | "deterministic" | "semantic" | "none";
  resolutionError?: "semantic_resolver_failed";
}

export interface TemporalSemanticResolution {
  range: {
    startTime: string;
    endTime: string;
  };
  basis?: TemporalSearchBasis;
  confidence?: ResolvedTemporalQuery["confidence"];
}

export interface TemporalSemanticResolver {
  resolve(input: {
    text: string;
    referenceTime: string;
    timezone: string;
    locale: string;
    basis: TemporalSearchBasis;
  }): TemporalSemanticResolution | undefined | Promise<TemporalSemanticResolution | undefined>;
}

export interface ResolveTemporalQueryInput {
  text: string;
  referenceTime?: string;
  timezone?: string;
  locale?: string;
  timeRange?: TemporalSearchRange;
}

export interface ResolveTemporalQueryOptions {
  principalTimezone?: string;
  tenantTimezone?: string;
  defaultTimezone?: string;
  defaultLocale?: string;
  semanticResolver?: TemporalSemanticResolver;
  now?: () => Date;
}

export class TemporalQueryError extends Error {
  constructor(
    readonly code:
      | "TEMPORAL_RANGE_INVALID"
      | "TEMPORAL_REFERENCE_TIME_INVALID"
      | "TEMPORAL_TIMEZONE_INVALID"
      | "TEMPORAL_LOCALE_INVALID",
    message = code
  ) {
    super(message);
    this.name = "TemporalQueryError";
  }
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

type RelativeTemporalUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_LOCALE = "zh-CN";

const evidenceIntentPattern = /(?:聊过|聊了|说过|说了|提到|提过|消息|对话|讨论过|conversation|messages?|talked|said|mentioned)/iu;
const validIntentPattern = /(?:发生|生效|计划日期|什么时候去|哪天去|何时去|什么时候|哪天|何时|安排在|计划|出发|到期|截止|happen(?:ed)?|occur(?:red)?|effective|scheduled|when)/iu;

export async function resolveTemporalQuery(
  input: ResolveTemporalQueryInput,
  options: ResolveTemporalQueryOptions = {}
): Promise<ResolvedTemporalQuery> {
  const now = options.now?.() ?? new Date();
  const referenceTime = normalizeReferenceTime(input.referenceTime, now);
  const timezone = resolveTimezone(input.timezone, options);
  const locale = resolveLocale(input.locale, options.defaultLocale);
  const inferredBasis = inferTemporalSearchBasis(input.text);

  if (input.timeRange) {
    const range = normalizeTemporalRange(input.timeRange);
    return {
      range,
      basis: input.timeRange.basis ?? inferredBasis,
      referenceTime,
      timezone,
      locale,
      confidence: "high",
      source: "explicit"
    };
  }

  const deterministicRange = resolveDeterministicTemporalRange(input.text, referenceTime, timezone, locale);
  if (deterministicRange) {
    return {
      range: deterministicRange,
      basis: inferredBasis,
      referenceTime,
      timezone,
      locale,
      confidence: "high",
      source: "deterministic"
    };
  }

  if (options.semanticResolver) {
    try {
      const semantic = await options.semanticResolver.resolve({
        text: input.text,
        referenceTime,
        timezone,
        locale,
        basis: inferredBasis
      });
      if (semantic) {
        return {
          range: normalizeTemporalRange(semantic.range),
          basis: semantic.basis ?? inferredBasis,
          referenceTime,
          timezone,
          locale,
          confidence: semantic.confidence ?? "medium",
          source: "semantic"
        };
      }
    } catch {
      return {
        basis: inferredBasis,
        referenceTime,
        timezone,
        locale,
        confidence: "low",
        source: "none",
        resolutionError: "semantic_resolver_failed"
      };
    }
  }

  return {
    basis: inferredBasis,
    referenceTime,
    timezone,
    locale,
    confidence: "low",
    source: "none"
  };
}

export function inferTemporalSearchBasis(text: string): TemporalSearchBasis {
  const evidence = evidenceIntentPattern.test(text);
  const valid = validIntentPattern.test(text);
  if (evidence && !valid) return "evidence";
  if (valid && !evidence) return "valid";
  return "auto";
}

export function normalizeTemporalRange(range: Pick<TemporalSearchRange, "startTime" | "endTime">) {
  const start = parseTimestamp(range.startTime);
  const end = parseTimestamp(range.endTime);
  if (start === undefined || end === undefined || start >= end) {
    throw new TemporalQueryError("TEMPORAL_RANGE_INVALID");
  }
  return {
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString()
  };
}

export function isTemporalSearchBasis(value: unknown): value is TemporalSearchBasis {
  return value === "evidence" || value === "valid" || value === "auto";
}

export function parseTemporalSearchRange(value: unknown): TemporalSearchRange | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TemporalQueryError("TEMPORAL_RANGE_INVALID");
  }
  const input = value as { startTime?: unknown; endTime?: unknown; basis?: unknown };
  if (
    typeof input.startTime !== "string" ||
    typeof input.endTime !== "string" ||
    (input.basis !== undefined && !isTemporalSearchBasis(input.basis))
  ) {
    throw new TemporalQueryError("TEMPORAL_RANGE_INVALID");
  }
  const range = normalizeTemporalRange({ startTime: input.startTime, endTime: input.endTime });
  return {
    ...range,
    ...(input.basis ? { basis: input.basis } : {})
  };
}

export function temporalRangeIntersects(
  metadata: { startTime?: string; endTime?: string },
  range: { startTime: string; endTime: string }
) {
  const valueStart = parseTimestamp(metadata.startTime);
  if (valueStart === undefined) return false;
  const valueEnd = parseTimestamp(metadata.endTime);
  const queryStart = Date.parse(range.startTime);
  const queryEnd = Date.parse(range.endTime);
  if (valueEnd === undefined || valueEnd === valueStart) {
    return valueStart >= queryStart && valueStart < queryEnd;
  }
  return valueStart < queryEnd && valueEnd > queryStart;
}

export function startOfLocalDate(date: LocalDate, timezone: string) {
  assertIanaTimezone(timezone);
  const targetKey = localDateKey(date);
  const approximate = Date.UTC(date.year, date.month - 1, date.day);
  let low = approximate - 36 * 60 * 60 * 1000;
  let high = approximate + 36 * 60 * 60 * 1000;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateKey(localDateAt(new Date(middle), timezone)) < targetKey) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return new Date(low).toISOString();
}

export function resolveDeterministicTemporalRange(
  text: string,
  referenceTime: string,
  timezone: string,
  locale: string
) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase(locale);
  const referenceDate = localDateAt(new Date(referenceTime), timezone);
  const explicitDate = parseExplicitLocalDate(normalized, referenceDate);
  if (explicitDate) return localDateRange(explicitDate, timezone);

  if (/(?:前天|day before yesterday)/iu.test(normalized)) {
    return localDateRange(addLocalDays(referenceDate, -2), timezone);
  }
  if (/(?:昨天|昨日|yesterday)/iu.test(normalized)) {
    return localDateRange(addLocalDays(referenceDate, -1), timezone);
  }
  if (/(?:今天|今日|today)/iu.test(normalized)) {
    return localDateRange(referenceDate, timezone);
  }
  if (/(?:后天|day after tomorrow)/iu.test(normalized)) {
    return localDateRange(addLocalDays(referenceDate, 2), timezone);
  }
  if (/(?:明天|tomorrow)/iu.test(normalized)) {
    return localDateRange(addLocalDays(referenceDate, 1), timezone);
  }
  if (/(?:上周|last week)/iu.test(normalized)) {
    const thisWeek = startOfIsoWeek(referenceDate);
    return localDateSpan(addLocalDays(thisWeek, -7), addLocalDays(thisWeek, 0), timezone);
  }
  if (/(?:本周|这周|this week)/iu.test(normalized)) {
    const start = startOfIsoWeek(referenceDate);
    return localDateSpan(start, addLocalDays(start, 7), timezone);
  }
  if (/(?:下周|next week)/iu.test(normalized)) {
    const start = addLocalDays(startOfIsoWeek(referenceDate), 7);
    return localDateSpan(start, addLocalDays(start, 7), timezone);
  }

  const calendarPeriod = parseCalendarPeriod(normalized);
  if (calendarPeriod) {
    return calendarPeriodRange(referenceDate, timezone, calendarPeriod.unit, calendarPeriod.offset);
  }

  const relativeRange = parseRelativeRange(normalized);
  if (relativeRange) {
    return relativeRangeFromReference(referenceTime, referenceDate, timezone, relativeRange);
  }

  const relativePoint = parseRelativePoint(normalized);
  if (relativePoint) {
    return relativePointFromReference(referenceTime, referenceDate, timezone, relativePoint);
  }

  const anchoredMonthDuration = parseAnchoredMonthDuration(normalized);
  if (anchoredMonthDuration) {
    const start = addLocalMonths({ ...referenceDate, day: 1 }, -anchoredMonthDuration);
    return normalizeTemporalRange({
      startTime: startOfLocalDate(start, timezone),
      endTime: referenceTime
    });
  }

  const recentDays = normalized.match(/(?:最近|近|过去)\s*([一二两三四五六七八九十\d]+)\s*天|last\s+(\d+)\s+days?/iu);
  if (recentDays) {
    const count = parsePositiveDayCount(recentDays[1] ?? recentDays[2]);
    if (count) {
      return localDateSpan(
        addLocalDays(referenceDate, -(count - 1)),
        addLocalDays(referenceDate, 1),
        timezone
      );
    }
  }

  return undefined;
}

export function containsDeterministicRelativeTimeExpression(text: string) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  return /(?:前天|昨天|今天|明天|后天|本周|这周|上周|下周|本月|这个月|上个月|下个月|今年|去年|明年|过去|最近|接下来|未来|[零〇一二两三四五六七八九十百千\d]+\s*(?:分钟|小时|天|周|星期|个月|月|年)\s*[前后]|day before yesterday|yesterday|today|tomorrow|day after tomorrow|this week|last week|next week|this month|last month|next month|this year|last year|next year|past\s+\S+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)|last\s+\S+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)|next\s+\S+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)|\S+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+(?:ago|later|from now)|after\s+\S+\s+(?:minutes?|hours?|days?|weeks?|months?|years?))/iu.test(normalized);
}

function parseCalendarPeriod(text: string): { unit: "month" | "year"; offset: -1 | 0 | 1 } | undefined {
  const periods: Array<{ pattern: RegExp; unit: "month" | "year"; offset: -1 | 0 | 1 }> = [
    { pattern: /(?:上个月|last month)/iu, unit: "month", offset: -1 },
    { pattern: /(?:本月|这个月|this month)/iu, unit: "month", offset: 0 },
    { pattern: /(?:下个月|next month)/iu, unit: "month", offset: 1 },
    { pattern: /(?:去年|last year)/iu, unit: "year", offset: -1 },
    { pattern: /(?:今年|this year)/iu, unit: "year", offset: 0 },
    { pattern: /(?:明年|next year)/iu, unit: "year", offset: 1 }
  ];
  const match = periods.find((period) => period.pattern.test(text));
  return match ? { unit: match.unit, offset: match.offset } : undefined;
}

function parseRelativeRange(text: string) {
  const chinese = text.match(/(?:最近|近|过去|接下来|未来)\s*([零〇一二两三四五六七八九十百千\d]+)\s*(分钟|小时|天|周|星期|个月|月|年)/iu);
  if (chinese) {
    const count = parsePositiveQuantity(chinese[1]);
    const unit = parseRelativeUnit(chinese[2]);
    if (count && unit && isReasonableRelativeQuantity(count, unit)) {
      return { count, unit, direction: /(?:接下来|未来)/u.test(chinese[0]) ? 1 as const : -1 as const };
    }
  }

  const english = text.match(/\b(past|last|next)\s+(an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(minutes?|hours?|days?|weeks?|months?|years?)\b/iu);
  if (!english) return undefined;
  const count = parsePositiveQuantity(english[2]);
  const unit = parseRelativeUnit(english[3]);
  if (!count || !unit || !isReasonableRelativeQuantity(count, unit)) return undefined;
  return { count, unit, direction: english[1]?.toLocaleLowerCase() === "next" ? 1 as const : -1 as const };
}

function parseRelativePoint(text: string) {
  const chinese = text.match(/([零〇一二两三四五六七八九十百千\d]+)\s*(分钟|小时|天|周|星期|个月|月|年)\s*(前|后)/iu);
  if (chinese) {
    const count = parsePositiveQuantity(chinese[1]);
    const unit = parseRelativeUnit(chinese[2]);
    if (count && unit && isReasonableRelativeQuantity(count, unit)) {
      return { count, unit, direction: chinese[3] === "前" ? -1 as const : 1 as const };
    }
  }

  const suffix = text.match(/\b(an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(minutes?|hours?|days?|weeks?|months?|years?)\s+(ago|later|from now)\b/iu);
  const prefix = text.match(/\bafter\s+(an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(minutes?|hours?|days?|weeks?|months?|years?)\b/iu);
  const match = suffix ?? prefix;
  if (!match) return undefined;
  const count = parsePositiveQuantity(match[1]);
  const unit = parseRelativeUnit(match[2]);
  if (!count || !unit || !isReasonableRelativeQuantity(count, unit)) return undefined;
  return {
    count,
    unit,
    direction: suffix?.[3]?.toLocaleLowerCase() === "ago" ? -1 as const : 1 as const
  };
}

function parseAnchoredMonthDuration(text: string) {
  const match = text.match(/\b(?:have|has|'ve)\s+been\b[\s\S]{0,240}?\bfor\s+(?:about\s+)?(an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+months?\b/iu);
  const count = parsePositiveQuantity(match?.[1]);
  return count && isReasonableRelativeQuantity(count, "month") ? count : undefined;
}

function relativeRangeFromReference(
  referenceTime: string,
  referenceDate: LocalDate,
  timezone: string,
  relative: { count: number; unit: RelativeTemporalUnit; direction: -1 | 1 }
) {
  if (relative.unit === "minute" || relative.unit === "hour") {
    const referenceMs = Date.parse(referenceTime);
    const durationMs = relative.count * (relative.unit === "minute" ? 60_000 : 3_600_000);
    return normalizeTemporalRange(relative.direction < 0
      ? { startTime: new Date(referenceMs - durationMs).toISOString(), endTime: new Date(referenceMs).toISOString() }
      : { startTime: new Date(referenceMs).toISOString(), endTime: new Date(referenceMs + durationMs).toISOString() });
  }

  if (relative.direction < 0) {
    const shifted = shiftLocalDateByUnit(referenceDate, relative.unit, -relative.count);
    const start = relative.unit === "day"
      ? addLocalDays(referenceDate, -(relative.count - 1))
      : relative.unit === "week"
        ? addLocalDays(referenceDate, -(relative.count * 7 - 1))
        : addLocalDays(shifted, 1);
    return localDateSpan(start, addLocalDays(referenceDate, 1), timezone);
  }
  const end = shiftLocalDateByUnit(referenceDate, relative.unit, relative.count);
  return localDateSpan(referenceDate, end, timezone);
}

function relativePointFromReference(
  referenceTime: string,
  referenceDate: LocalDate,
  timezone: string,
  relative: { count: number; unit: RelativeTemporalUnit; direction: -1 | 1 }
) {
  const signedCount = relative.count * relative.direction;
  if (relative.unit === "minute" || relative.unit === "hour") {
    const unitMs = relative.unit === "minute" ? 60_000 : 3_600_000;
    const start = Date.parse(referenceTime) + signedCount * unitMs;
    return normalizeTemporalRange({
      startTime: new Date(start).toISOString(),
      endTime: new Date(start + unitMs).toISOString()
    });
  }
  if (relative.unit === "month") {
    const start = addLocalMonths({ ...referenceDate, day: 1 }, signedCount);
    return localDateSpan(start, addLocalMonths(start, 1), timezone);
  }
  return localDateRange(shiftLocalDateByUnit(referenceDate, relative.unit, signedCount), timezone);
}

function calendarPeriodRange(
  referenceDate: LocalDate,
  timezone: string,
  unit: "month" | "year",
  offset: -1 | 0 | 1
) {
  if (unit === "month") {
    const shifted = addLocalMonths({ ...referenceDate, day: 1 }, offset);
    const start = { ...shifted, day: 1 };
    return localDateSpan(start, addLocalMonths(start, 1), timezone);
  }
  const start = { year: referenceDate.year + offset, month: 1, day: 1 };
  return localDateSpan(start, { year: start.year + 1, month: 1, day: 1 }, timezone);
}

function shiftLocalDateByUnit(date: LocalDate, unit: RelativeTemporalUnit, count: number) {
  if (unit === "day") return addLocalDays(date, count);
  if (unit === "week") return addLocalDays(date, count * 7);
  if (unit === "month") return addLocalMonths(date, count);
  if (unit === "year") return addLocalYears(date, count);
  return date;
}

function addLocalMonths(date: LocalDate, months: number): LocalDate {
  const monthIndex = date.year * 12 + date.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

function addLocalYears(date: LocalDate, years: number): LocalDate {
  const year = date.year + years;
  return { year, month: date.month, day: Math.min(date.day, daysInMonth(year, date.month)) };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseRelativeUnit(value: string | undefined): RelativeTemporalUnit | undefined {
  if (!value) return undefined;
  const normalized = value.toLocaleLowerCase();
  if (/^(?:分钟|minutes?)$/u.test(normalized)) return "minute";
  if (/^(?:小时|hours?)$/u.test(normalized)) return "hour";
  if (/^(?:天|days?)$/u.test(normalized)) return "day";
  if (/^(?:周|星期|weeks?)$/u.test(normalized)) return "week";
  if (/^(?:个月|月|months?)$/u.test(normalized)) return "month";
  if (/^(?:年|years?)$/u.test(normalized)) return "year";
  return undefined;
}

function isReasonableRelativeQuantity(count: number, unit: RelativeTemporalUnit) {
  const maximum: Record<RelativeTemporalUnit, number> = {
    minute: 525_600,
    hour: 87_600,
    day: 3_650,
    week: 520,
    month: 1_200,
    year: 200
  };
  return Number.isInteger(count) && count > 0 && count <= maximum[unit];
}

function parseExplicitLocalDate(text: string, referenceDate: LocalDate): LocalDate | undefined {
  const iso = text.match(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/u);
  if (iso) return validLocalDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const chinese = text.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/u);
  if (chinese) {
    return validLocalDate(Number(chinese[1] ?? referenceDate.year), Number(chinese[2]), Number(chinese[3]));
  }

  const english = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/iu);
  if (english) {
    const month = englishMonthNumber(english[1]);
    return month
      ? validLocalDate(Number(english[3] ?? referenceDate.year), month, Number(english[2]))
      : undefined;
  }
  return undefined;
}

function englishMonthNumber(value: string | undefined) {
  if (!value) return undefined;
  const months: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12
  };
  return months[value.toLocaleLowerCase()];
}

function localDateRange(date: LocalDate, timezone: string) {
  return localDateSpan(date, addLocalDays(date, 1), timezone);
}

function localDateSpan(start: LocalDate, end: LocalDate, timezone: string) {
  const startTime = startOfLocalDate(start, timezone);
  const endTime = startOfLocalDate(end, timezone);
  return normalizeTemporalRange({ startTime, endTime });
}

function startOfIsoWeek(date: LocalDate) {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return addLocalDays(date, -((weekday + 6) % 7));
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function localDateAt(instant: Date, timezone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  return {
    year: Number(partValue(parts, "year")),
    month: Number(partValue(parts, "month")),
    day: Number(partValue(parts, "day"))
  };
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function validLocalDate(year: number, month: number, day: number): LocalDate | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return undefined;
  return { year, month, day };
}

function localDateKey(date: LocalDate) {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function normalizeReferenceTime(value: string | undefined, now: Date) {
  if (value === undefined) {
    if (!Number.isFinite(now.getTime())) throw new TemporalQueryError("TEMPORAL_REFERENCE_TIME_INVALID");
    return now.toISOString();
  }
  const timestamp = parseTimestamp(value);
  if (timestamp === undefined) throw new TemporalQueryError("TEMPORAL_REFERENCE_TIME_INVALID");
  return new Date(timestamp).toISOString();
}

function resolveTimezone(value: string | undefined, options: ResolveTemporalQueryOptions) {
  const timezone = firstNonEmpty(
    value,
    options.principalTimezone,
    options.tenantTimezone,
    options.defaultTimezone,
    DEFAULT_TIMEZONE
  )!;
  assertIanaTimezone(timezone);
  return timezone;
}

function assertIanaTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new TemporalQueryError("TEMPORAL_TIMEZONE_INVALID");
  }
}

function resolveLocale(value: string | undefined, fallback: string | undefined) {
  const locale = firstNonEmpty(value, fallback, DEFAULT_LOCALE)!;
  try {
    return new Intl.Locale(locale).toString();
  } catch {
    throw new TemporalQueryError("TEMPORAL_LOCALE_INVALID");
  }
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function parseTimestamp(value: string | undefined) {
  if (!value || !hasRfc3339Offset(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasRfc3339Offset(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}

function parsePositiveDayCount(value: string | undefined) {
  const count = parsePositiveQuantity(value);
  return count && count <= 366 ? count : undefined;
}

function parsePositiveQuantity(value: string | undefined) {
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) {
    const count = Number(value);
    return Number.isSafeInteger(count) && count > 0 ? count : undefined;
  }
  const english: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20
  };
  const englishCount = english[value.toLocaleLowerCase()];
  if (englishCount) return englishCount;

  if (!/^[零〇一二两三四五六七八九十百千]+$/u.test(value)) return undefined;
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  };
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of value) {
    if (character === "十" || character === "百" || character === "千") {
      const unit = character === "十" ? 10 : character === "百" ? 100 : 1_000;
      section += (digit || 1) * unit;
      digit = 0;
      continue;
    }
    digit = digits[character] ?? 0;
  }
  total += section + digit;
  return total > 0 ? total : undefined;
}
