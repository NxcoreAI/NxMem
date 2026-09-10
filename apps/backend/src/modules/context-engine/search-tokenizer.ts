const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });

export function tokenizeSearchText(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  for (const part of wordSegmenter.segment(normalized)) {
    if (!part.isWordLike) continue;
    const token = part.segment.trim();
    if (token && /[\p{L}\p{N}]/u.test(token)) tokens.push(token);
  }
  return [...new Set(tokens)];
}

export function tokenizeSearchDocument(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  for (const part of wordSegmenter.segment(normalized)) {
    if (!part.isWordLike) continue;
    const token = part.segment.trim();
    if (token && /[\p{L}\p{N}]/u.test(token)) tokens.push(token);
  }
  return tokens;
}
