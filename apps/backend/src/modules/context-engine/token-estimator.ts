export function estimateContextTokens(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;

  const asciiTokens = normalized.match(/[A-Za-z0-9_]+/gu) ?? [];
  const cjkChars = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const nonAsciiNonCjkChars = normalized.replace(/[\x00-\x7F\u3400-\u9fff\uf900-\ufaff]/gu, "").length;
  const punctuation = normalized.match(/[^\sA-Za-z0-9_\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const asciiCost = asciiTokens.reduce((sum, token) => sum + Math.max(1, Math.ceil(token.length / 4)), 0);

  return Math.max(1, Math.ceil(asciiCost + cjkChars + nonAsciiNonCjkChars + punctuation * 0.5));
}
