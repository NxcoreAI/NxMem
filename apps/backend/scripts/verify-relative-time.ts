import { resolveDeterministicTemporalRange } from "../src/modules/context-engine/temporal-query.js";
import { renderBenchmarkAnswerContext, type BenchmarkAnswerEvidenceCandidate } from "../src/modules/context-engine/benchmark-answer-context.js";

const day = (s: string) => s.slice(0, 10);
let failed = 0;
const check = (label: string, actual: string | undefined, expected: string) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(ok ? "OK  " : "FAIL", label, "->", actual, ok ? "" : `(expected ${expected})`);
};

// 2022-03-16 是周三
const ref = "2022-03-16T10:19:00.000Z";
const r = (text: string) => resolveDeterministicTemporalRange(text, ref, "UTC", "en");

check("last saturday", day(r("i received a piece of jewelry last saturday from whom?")?.startTime ?? ""), "2022-03-12");
check("last saturday (same weekday ref=thu)", day(r("last saturday")?.startTime ?? ""), "2022-03-12");
check("next monday", day(r("next monday")?.startTime ?? ""), "2022-03-21");
check("this friday", day(r("this friday")?.startTime ?? ""), "2022-03-11");
check("last wednesday (ref itself -> 7 back)", day(r("last wednesday")?.startTime ?? ""), "2022-03-09");
check("a couple of days ago", day(r("i cooked something a couple of days ago")?.startTime ?? ""), "2022-03-14");
check("couple weeks ago", day(r("a couple of weeks ago")?.startTime ?? ""), "2022-03-02");
check("last week still works", day(r("last week")?.startTime ?? ""), "2022-03-07");

// prompt header 时间换算行
const candidate: BenchmarkAnswerEvidenceCandidate = {
  item: { id: "x", layer: "stm", content: "aunt gave jewelry", compressedContent: "aunt gave jewelry", score: 1, sourceRefs: [], sourceMessageIds: [], factIds: [], memoryIds: ["x"], factContext: { currentFacts: [], sourceFacts: [], conflicts: [] }, temporal: {} },
  scoreBreakdown: {} as never, sourceSessionIds: ["s1"], sourceRoles: ["user"], temporal: { validTime: "2022-03-12T00:00:00.000Z" }, relations: [], facts: [], evidenceText: "aunt gave jewelry", relevanceScore: 0, estimatedTokens: 1
};
const out = renderBenchmarkAnswerContext("jewelry last saturday from whom?", ref, [candidate], "p1", "temporal-reasoning",
  { range: { startTime: "2022-03-12T00:00:00.000Z", endTime: "2022-03-13T00:00:00.000Z" }, source: "deterministic", referenceTime: ref });
check("header conversion note", out.includes("【时间换算】") && out.includes("2022-03-12") && out.includes("2022-03-16") ? "present" : out.slice(0, 100), "present");

if (failed) { console.error(failed + " checks failed"); process.exit(1); }
console.log("all checks passed");
