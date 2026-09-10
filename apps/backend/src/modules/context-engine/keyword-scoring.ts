const synonymGroups = [
  ["father", "dad"],
  ["mother", "mom"],
  ["gift", "present"],
  ["buy", "purchase"],
  ["job", "work"],
  ["trip", "travel"]
] as const;

const synonyms = buildSynonymMap(synonymGroups);

export interface KeywordCorpusStats {
  documentCount: number;
  documentFrequency: ReadonlyMap<string, number>;
}

export interface KeywordScoreDetails {
  score: number;
  weightedCoverage: number;
  similarCoverage: number;
}

export function buildKeywordCorpusStats(contents: string[], queryTokens: string[]): KeywordCorpusStats {
  const uniqueQueryTokens = uniqueTokens(queryTokens);
  const documentFrequency = new Map(uniqueQueryTokens.map((token) => [token, 0]));
  for (const content of contents) {
    const normalized = normalizeKeywordText(content);
    for (const token of uniqueQueryTokens) {
      if (hasExactToken(normalized, token)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
  }
  return { documentCount: contents.length, documentFrequency };
}

export function scoreKeywordMatch(
  content: string,
  queryTokens: string[],
  corpusStats?: KeywordCorpusStats
): KeywordScoreDetails {
  const tokens = uniqueTokens(queryTokens);
  if (!tokens.length) return { score: 0.5, weightedCoverage: 0.5, similarCoverage: 0.5 };

  const normalizedContent = normalizeKeywordText(content);
  const weights = tokens.map((token) => idfWeight(token, corpusStats));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let exactWeight = 0;
  let similarWeight = 0;

  for (const [index, token] of tokens.entries()) {
    const weight = weights[index] ?? 1;
    if (hasExactToken(normalizedContent, token)) {
      exactWeight += weight;
      continue;
    }
    if (hasSimilarToken(normalizedContent, token)) similarWeight += weight;
  }

  const weightedCoverage = totalWeight > 0 ? exactWeight / totalWeight : 0;
  const similarCoverage = totalWeight > 0 ? similarWeight / totalWeight : 0;
  return {
    score: clamp01(0.7 * weightedCoverage + 0.3 * similarCoverage),
    weightedCoverage,
    similarCoverage
  };
}

function normalizeKeywordText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function uniqueTokens(tokens: string[]) {
  return [...new Set(tokens.map(normalizeKeywordText).filter(Boolean))];
}

function idfWeight(token: string, stats: KeywordCorpusStats | undefined) {
  if (!stats || stats.documentCount <= 0) return 1;
  const frequency = stats.documentFrequency.get(token) ?? 0;
  return Math.log((stats.documentCount + 1) / (frequency + 1)) + 1;
}

function hasExactToken(content: string, token: string) {
  if (containsHan(token)) return content.includes(token);
  return lexicalTokens(content).includes(token);
}

function hasSimilarToken(content: string, queryToken: string) {
  if (containsHan(queryToken)) return false;
  const contentTokens = lexicalTokens(content);
  const queryStem = stemEnglishToken(queryToken);
  const alternatives: readonly string[] = synonyms.get(queryToken) ?? [];
  return contentTokens.some((token) =>
    (token !== queryToken && stemEnglishToken(token) === queryStem) || alternatives.includes(token)
  );
}

function lexicalTokens(value: string): string[] {
  return value.match(/[a-z0-9]+/g) ?? [];
}

function containsHan(value: string) {
  return /\p{Script=Han}/u.test(value);
}

function stemEnglishToken(value: string) {
  if (value.length >= 6 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length >= 5 && value.endsWith("ied")) return `${value.slice(0, -3)}y`;
  if (value.length >= 5 && value.endsWith("sed")) return value.slice(0, -1);
  if (value.length >= 5 && value.endsWith("ed")) return value.slice(0, -2);
  if (value.length >= 5 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length >= 4 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function buildSynonymMap(groups: ReadonlyArray<readonly string[]>): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const group of groups) {
    for (const token of group) {
      result.set(token, group.filter((candidate) => candidate !== token));
    }
  }
  return result;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
