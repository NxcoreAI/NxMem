import { renderBenchmarkAnswerContext, type BenchmarkAnswerEvidenceCandidate } from "../src/modules/context-engine/benchmark-answer-context.js";

const mk = (id: string, validTime: string | undefined, evidenceTime: string | undefined, sessions: string[], text: string): BenchmarkAnswerEvidenceCandidate => ({
  item: { id, layer: "stm", content: text, compressedContent: text, score: 1, sourceRefs: [], sourceMessageIds: [], factIds: [], memoryIds: [id], factContext: { currentFacts: [], sourceFacts: [], conflicts: [] }, temporal: {} },
  scoreBreakdown: {} as never, sourceSessionIds: sessions, sourceRoles: ["user"], temporal: { ...(validTime ? { validTime } : {}), ...(evidenceTime ? { evidenceTime } : {}) }, relations: [], facts: [], evidenceText: text, relevanceScore: 0, estimatedTokens: 1
});

const temporal = [mk("t3", "2026-03-01", undefined, ["s2"], "late"), mk("t1", "2026-01-01", undefined, ["s1"], "early"), mk("t2", undefined, "2026-02-01", ["s1"], "mid by evidence")];
const outT = renderBenchmarkAnswerContext("when?", "2026-04-01", temporal, "p1", "temporal-reasoning");
const idxT = [...outT.matchAll(/item:(t\d)/g)].map((m) => m[1]);
console.log("temporal order:", idxT.join(","), idxT.join(",") === "t1,t2,t3" ? "OK" : "FAIL");
console.log("temporal note:", outT.includes("证据排列") && outT.includes("从早到晚") ? "OK" : "FAIL");

const calc = [mk("c3", "2026-01-05", undefined, ["sB"], "30 dollars"), mk("c1", "2026-02-01", undefined, ["sA"], "10 dollars"), mk("c2", "2026-01-01", undefined, ["sB"], "20 dollars")];
const outC = renderBenchmarkAnswerContext("How much in total?", undefined, calc, "p2", "multi-session");
const idxC = [...outC.matchAll(/item:(c\d)/g)].map((m) => m[1]);
console.log("calc order:", idxC.join(","), idxC.join(",") === "c1,c2,c3" ? "OK" : "FAIL", "| note:", outC.includes("来源会话分组") ? "OK" : "FAIL");

const plain = renderBenchmarkAnswerContext("what?", undefined, calc, "p3", "single-session-user");
console.log("plain keeps order:", [...plain.matchAll(/item:(c\d)/g)].map((m) => m[1]).join(",") === "c3,c1,c2" ? "OK" : "FAIL", "| no note:", plain.includes("证据排列") ? "FAIL" : "OK");
