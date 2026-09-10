export interface QuantitativeCoverageMessage {
  messageId: string;
  content: string;
}

export function missingConversationQuantitativeFacts(
  messages: readonly QuantitativeCoverageMessage[],
  rawCandidates: readonly unknown[]
) {
  const candidateRecords = rawCandidates.filter(isRecord);
  return messages.flatMap((message) => {
    const expected = numericTokens(message.content);
    if (!expected.length) return [];
    const candidateText = candidateRecords
      .filter((candidate) => stringArray(candidate.sourceMessageIds).includes(message.messageId))
      .map((candidate) => [
        stringValue(candidate.factText),
        stringValue(candidate.normalizedClaim),
        stringValue(candidate.validTimeStart),
        stringValue(candidate.validTimeEnd)
      ].join(" "))
      .join(" ");
    const actual = new Set(numericTokens(candidateText));
    const missingTokens = expected.filter((token) => !actual.has(token));
    return missingTokens.length ? [{ messageId: message.messageId, missingTokens }] : [];
  });
}

function numericTokens(value: string) {
  return [...new Set((value.normalize("NFKC").match(/\d+(?:[.,]\d+)*/gu) ?? []).map(normalizeNumericToken))];
}

function normalizeNumericToken(value: string) {
  const compact = value.replace(/,/gu, "");
  const [integer = "0", decimal] = compact.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/u, "");
  return decimal === undefined ? normalizedInteger : `${normalizedInteger}.${decimal.replace(/0+$/u, "") || "0"}`;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
