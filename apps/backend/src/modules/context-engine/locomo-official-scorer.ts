import type { LocomoCategory } from "./locomo-dataset.js";

export const LOCOMO_SCORER_VERSION = "locomo-official-3eb6f2c5";

export interface LocomoQuestionScore {
  score: number;
  normalizedReference: string;
  normalizedHypothesis: string;
  scorerVersion: string;
}

export function scoreLocomoQuestion(input: {
  category: LocomoCategory;
  referenceAnswer: string;
  hypothesis: string;
}): LocomoQuestionScore {
  const reference = input.category === 3 ? input.referenceAnswer.split(";", 1)[0]!.trim() : input.referenceAnswer;
  let score: number;
  if (input.category === 5) {
    const hypothesis = input.hypothesis.toLowerCase();
    score = hypothesis.includes("no information available") || hypothesis.includes("not mentioned") ? 1 : 0;
  } else if (input.category === 1) {
    const references = input.referenceAnswer.split(",");
    const hypotheses = input.hypothesis.split(",");
    score = references.reduce((sum, answer) =>
      sum + Math.max(0, ...hypotheses.map((prediction) => tokenF1(prediction, answer))), 0) / references.length;
  } else {
    score = tokenF1(input.hypothesis, reference);
  }
  return {
    score: round3(score),
    normalizedReference: normalizeLocomoAnswer(reference).join(" "),
    normalizedHypothesis: normalizeLocomoAnswer(input.hypothesis).join(" "),
    scorerVersion: LOCOMO_SCORER_VERSION
  };
}

export function summarizeLocomoScores(rows: Array<{ category: LocomoCategory; score: number }>) {
  const categoryScores = {} as Record<LocomoCategory, { count: number; score: number }>;
  for (const category of [1, 2, 3, 4, 5] as const) {
    const selected = rows.filter((row) => row.category === category);
    categoryScores[category] = {
      count: selected.length,
      score: selected.length ? selected.reduce((sum, row) => sum + row.score, 0) / selected.length : 0
    };
  }
  return {
    count: rows.length,
    categoryScores,
    overallOfficialQaScore: rows.length ? rows.reduce((sum, row) => sum + row.score, 0) / rows.length : 0,
    perfectScoreRate: rows.length ? rows.filter((row) => row.score === 1).length / rows.length : 0,
    scorerVersion: LOCOMO_SCORER_VERSION
  };
}

export function tokenF1(hypothesis: string, reference: string): number {
  const prediction = normalizeLocomoAnswer(hypothesis);
  const gold = normalizeLocomoAnswer(reference);
  if (prediction.length === 0 || gold.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of gold) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of prediction) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(token, remaining - 1);
    }
  }
  if (!overlap) return 0;
  const precision = overlap / prediction.length;
  const recall = overlap / gold.length;
  return (2 * precision * recall) / (precision + recall);
}

export function normalizeLocomoAnswer(value: string): string[] {
  const withoutPunctuation = value.toLowerCase().replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "");
  return withoutPunctuation.split(/\s+/).filter(Boolean).filter((token) => !["a", "an", "the", "and"].includes(token)).map(porterStem);
}

// Porter stemming algorithm used by the official scorer's NLTK PorterStemmer.
export function porterStem(word: string): string {
  const irregular = new Map<string, string>([
    ["sky", "sky"], ["skies", "sky"], ["dying", "die"], ["lying", "lie"], ["tying", "tie"],
    ["news", "news"], ["innings", "inning"], ["inning", "inning"], ["outings", "outing"], ["outing", "outing"],
    ["cannings", "canning"], ["canning", "canning"], ["howe", "howe"], ["proceed", "proceed"],
    ["exceed", "exceed"], ["succeed", "succeed"]
  ]);
  const lower = word.toLowerCase();
  const irregularStem = irregular.get(lower);
  if (irregularStem) return irregularStem;
  if (lower.length <= 2) return lower;
  let w = lower;
  const consonant = (index: number): boolean => {
    const char = w[index]!;
    if ("aeiou".includes(char)) return false;
    if (char === "y") return index === 0 ? true : !consonant(index - 1);
    return true;
  };
  const measure = (stem: string) => {
    const prior = w;
    w = stem;
    let count = 0;
    for (let i = 1; i < w.length; i += 1) if (consonant(i) && !consonant(i - 1)) count += 1;
    w = prior;
    return count;
  };
  const hasVowel = (stem: string) => {
    const prior = w;
    w = stem;
    const result = [...w].some((_, index) => !consonant(index));
    w = prior;
    return result;
  };
  const cvc = (stem: string) => {
    const prior = w;
    w = stem;
    const i = stem.length - 1;
    const result = stem.length === 2
      ? !consonant(0) && consonant(1)
      : stem.length >= 3 && consonant(i) && !consonant(i - 1) && consonant(i - 2) && !"wxy".includes(stem[i]!);
    w = prior;
    return result;
  };
  const replace = (suffix: string, replacement: string, minimumMeasure = 0) => {
    if (!w.endsWith(suffix)) return false;
    const stem = w.slice(0, -suffix.length);
    if (measure(stem) <= minimumMeasure) return false;
    w = stem + replacement;
    return true;
  };
  if (w.endsWith("ies") && w.length === 4) w = `${w.slice(0, -3)}ie`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) { /* unchanged */ }
  else if (w.endsWith("s")) w = w.slice(0, -1);
  if (w.endsWith("ied")) w = `${w.slice(0, -3)}${w.length === 4 ? "ie" : "i"}`;
  else if (w.endsWith("eed")) replace("eed", "ee", 0);
  else {
    const suffix = w.endsWith("ed") ? "ed" : w.endsWith("ing") ? "ing" : undefined;
    if (suffix) {
      const stem = w.slice(0, -suffix.length);
      if (hasVowel(stem)) {
        w = stem;
        if (/(at|bl|iz)$/.test(w)) w += "e";
        else if (/([^aeiou])\1$/.test(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
        else if (measure(w) === 1 && cvc(w)) w += "e";
      }
    }
  }
  if (w.endsWith("y") && w.length > 2) {
    const stem = w.slice(0, -1);
    const prior = w;
    w = stem;
    const precededByConsonant = consonant(stem.length - 1);
    w = prior;
    if (precededByConsonant) w = `${stem}i`;
  }
  const applyStep2 = (): void => {
    if (w.endsWith("alli") && measure(w.slice(0, -4)) > 0) {
      w = `${w.slice(0, -4)}al`;
      applyStep2();
      return;
    }
    const step2: Array<[string, string]> = [["ational","ate"],["tional","tion"],["enci","ence"],["anci","ance"],["izer","ize"],["bli","ble"],["alli","al"],["entli","ent"],["eli","e"],["ousli","ous"],["ization","ize"],["ation","ate"],["ator","ate"],["alism","al"],["iveness","ive"],["fulness","ful"],["ousness","ous"],["aliti","al"],["iviti","ive"],["biliti","ble"],["fulli","ful"]];
    for (const [suffix, replacement] of step2) if (replace(suffix, replacement, 0)) return;
    if (w.endsWith("logi") && measure(w.slice(0, -3)) > 0) w = `${w.slice(0, -4)}log`;
  };
  applyStep2();
  const step3: Array<[string, string]> = [["icate","ic"],["ative",""],["alize","al"],["iciti","ic"],["ical","ic"],["ful",""],["ness",""]];
  for (const [suffix, replacement] of step3) if (replace(suffix, replacement, 0)) break;
  for (const suffix of ["al","ance","ence","er","ic","able","ible","ant","ement","ment","ent","ion","ou","ism","ate","iti","ous","ive","ize"]) {
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    if (measure(stem) > 1 && (suffix !== "ion" || /[st]$/.test(stem))) w = stem;
    break;
  }
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !cvc(stem))) w = stem;
  }
  if (w.endsWith("ll") && measure(w) > 1) w = w.slice(0, -1);
  return w;
}

function round3(value: number) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
