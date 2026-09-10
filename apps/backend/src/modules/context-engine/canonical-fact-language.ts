export function englishCanonicalFactValidationError(
  factText: string,
  normalizedClaim: string
): "fact_text_must_be_english" | "normalized_claim_must_be_english" | undefined {
  if (containsHanText(factText)) return "fact_text_must_be_english";
  if (containsHanText(normalizedClaim)) return "normalized_claim_must_be_english";
  return undefined;
}

export function isEnglishCanonicalFactText(factText: string, normalizedClaim: string) {
  return englishCanonicalFactValidationError(factText, normalizedClaim) === undefined;
}

function containsHanText(value: string) {
  return /\p{Script=Han}/u.test(value);
}
