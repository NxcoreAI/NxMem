export const LONGMEMEVAL_FACT_TYPES = [
  "profile",
  "relationship",
  "preference",
  "goal",
  "plan",
  "task",
  "decision",
  "event",
  "experience",
  "transaction",
  "state",
  "state_change",
  "feedback",
  "knowledge",
  "recommendation",
  "answer",
  "other"
] as const;

export type LongMemEvalFactType = typeof LONGMEMEVAL_FACT_TYPES[number];

const LONGMEMEVAL_FACT_TYPE_SET = new Set<string>(LONGMEMEVAL_FACT_TYPES);

export function parseLongMemEvalFactType(value: unknown): LongMemEvalFactType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  return LONGMEMEVAL_FACT_TYPE_SET.has(normalized) ? normalized as LongMemEvalFactType : undefined;
}

export function fallbackLongMemEvalFactType(value: string): LongMemEvalFactType {
  return parseLongMemEvalFactType(value) ?? (value === "text" || value === "document" ? "knowledge" : "other");
}

export function normalizedAnchorText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function textContainsTimeAnchor(text: string, timeAnchor: string) {
  const normalizedText = normalizedAnchorText(text);
  const normalizedAnchor = normalizedAnchorText(timeAnchor);
  return Boolean(normalizedAnchor) && normalizedText.includes(normalizedAnchor);
}
