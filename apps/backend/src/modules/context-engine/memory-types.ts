import type { FactItem, LongTermMemory, MemoryEvent, ShortTermMemory } from "./domain.js";
import { memoryEventSummary } from "./memory-event-fields.js";

export const prdMemoryTypes = [
  "person_profile",
  "preference",
  "workflow_pattern",
  "relationship",
  "project",
  "task",
  "knowledge",
  "event",
  "fact",
  "ai_persona"
] as const;

export type PrdMemoryType = typeof prdMemoryTypes[number];

export const theoryClassByMemoryType = {
  person_profile: "semantic",
  preference: "procedural",
  workflow_pattern: "procedural",
  relationship: "semantic",
  project: "semantic",
  task: "prospective",
  knowledge: "semantic",
  event: "episodic",
  fact: "semantic",
  ai_persona: "procedural"
} as const satisfies Record<PrdMemoryType, LongTermMemory["theoryClass"]>;

export function theoryClassForMemoryType(memoryType: PrdMemoryType): LongTermMemory["theoryClass"] {
  return theoryClassByMemoryType[memoryType];
}

const factSummaryLimit = 20;
const factSummaryPlaceholder = "摘要待生成";

export function normalizePrdMemoryType(value: string | undefined, fallback: PrdMemoryType = "fact"): PrdMemoryType {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (isPrdMemoryType(normalized)) return normalized;

  if (normalized === "profile") return "person_profile";
  if (normalized === "constraint") return "preference";
  if (normalized === "project_context") return "project";
  if (normalized === "task_pattern") return "workflow_pattern";
  if (normalized === "timeline_aggregation") return "event";
  if (normalized === "dreaming_consolidation") return "knowledge";
  if (normalized === "agent_memory" || normalized.endsWith("_memory_event")) return "fact";

  return inferPrdMemoryType(normalized, fallback);
}

export function inferShortTermMemoryType(event: MemoryEvent, facts: FactItem[]): PrdMemoryType {
  const text = normalizeText([
    event.eventType,
    memoryEventSummary(event),
    ...facts.flatMap((fact) => [fact.factType, fact.factText, fact.sourceClaim ?? "", fact.normalizedClaim])
  ].filter(Boolean).join(" "));

  return inferPrdMemoryType(text, "fact");
}

export function inferLongTermMemoryType(candidates: Array<Pick<ShortTermMemory, "memoryType" | "memoryDataType" | "content" | "matchedRules">>): PrdMemoryType {
  const explicit = candidates.map((candidate) => candidate.memoryType).find(isPrdMemoryType);
  if (explicit) return explicit;
  const text = normalizeText(candidates.flatMap((candidate) => [
    candidate.memoryDataType,
    candidate.content,
    ...candidate.matchedRules
  ]).join(" "));
  return inferPrdMemoryType(text, "knowledge");
}

export function summarizeFactsForMemory(facts: FactItem[], fallback: string) {
  const claims = facts
    .map((fact) => fact.normalizedClaim || fact.factText)
    .map((claim) => claim.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return truncateSummary(claims.length ? claims.join("；") : fallback);
}

export function summarizeStructuredFacts(memory: Pick<ShortTermMemory | LongTermMemory, "structuredFacts" | "content" | "summary">) {
  const claims = memory.structuredFacts?.facts
    .map((fact) => fact.claim)
    .map((claim) => claim.replace(/\s+/g, " ").trim())
    .filter(Boolean) ?? [];
  return truncateSummary(claims.length ? claims.join("；") : memory.content || memory.summary || "");
}

function inferPrdMemoryType(text: string, fallback: PrdMemoryType): PrdMemoryType {
  const normalized = normalizeText(text);
  if (/(偏好|preference|prefer|喜欢|讨厌|不要|以后|习惯|风格|禁忌)/u.test(normalized)) return "preference";
  if (/(项目|prd|方案|context|engine|产品|roadmap|project)/u.test(normalized)) return "knowledge";
  if (/(流程|workflow|pattern|步骤|结构|方法|惯用)/u.test(normalized)) return "workflow_pattern";
  if (/(ai persona|ai_persona|助手|名字|性格|灵魂|协作规则)/u.test(normalized)) return "ai_persona";
  if (/(任务|待办|截止|提醒|承诺|action|todo|deadline|remind)/u.test(normalized)) return "task";
  if (/(关系|合伙人|同事|朋友|relationship|partner|manager|负责人)/u.test(normalized)) return "relationship";
  if (/(身份|职业|画像|profile|用户是谁|专业领域)/u.test(normalized)) return "person_profile";
  if (/(会议|发生|event|timeline|今天|昨天|明天|时间轴)/u.test(normalized)) return "event";
  return fallback;
}

export function isPrdMemoryType(value: string | undefined): value is PrdMemoryType {
  return Boolean(value && (prdMemoryTypes as readonly string[]).includes(value));
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function truncateSummary(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const compact = normalizeSummaryText(normalized);
  const candidate = compressSummaryLabel(compact);
  return normalizeFactSummary(candidate.length <= factSummaryLimit ? candidate : "");
}

export function normalizeFactSummary(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized || normalized === factSummaryPlaceholder) return "";
  return normalized;
}

function normalizeSummaryText(value: string) {
  return value
    .replace(/^(上下文引擎|系统|系统应|系统需|系统需要|记忆引擎|上下文引擎需|上下文引擎应)/u, "")
    .replace(/^(本次会议|会议|本次讨论|讨论)(主要)?(讨论了|讨论|围绕|关于|介绍了|明确了|确认了|梳理了)?/u, "")
    .replace(/^(支持|需支持|应支持|要支持|可以|能够|需要)/u, "")
    .replace(/(、|和|及|与).*/u, "")
    .replace(/(的|地|得)$/u, "")
    .replace(/[：:，,。.!！？?；;]+$/u, "")
    .trim();
}

function compressSummaryLabel(value: string) {
  const clause = value.split(/[；。！？!?;,\n、]/u).map((item) => item.trim()).find(Boolean) ?? value;
  const keyPhrase = extractKeyPhrase(clause);
  if (keyPhrase) return keyPhrase;

  const segments = segmentWords(clause);
  const filtered = segments.filter((segment) => segment && !isSummaryStopWord(segment));
  const bounded = joinSegmentsUntilLimit(filtered, factSummaryLimit);
  if (bounded) return bounded;

  const chineseChunks = clause.match(/[\u4e00-\u9fff]{2,}/gu) ?? [];
  const chineseChunk = chineseChunks[0];
  if (chineseChunk) {
    const chunk = stripSummaryStopWords(chineseChunk);
    const chunkPhrase = extractKeyPhrase(chunk);
    if (chunkPhrase) return chunkPhrase;
    const boundedChunk = joinSegmentsUntilLimit(segmentWords(chunk), factSummaryLimit);
    if (boundedChunk) return boundedChunk;
  }

  const technicalToken = segments.find((segment) => isTechnicalToken(segment));
  if (technicalToken) return technicalToken.length <= factSummaryLimit ? technicalToken : "技术标识";

  return firstBoundedSegment(segmentWords(clause), factSummaryLimit);
}

function extractKeyPhrase(value: string) {
  const patterns = [
    /([\u4e00-\u9fff]{0,8}(?:预算控制|召回控制|压缩控制|权限控制))/u,
    /([\u4e00-\u9fff]{2,16}(?:架构升级|产品架构|上线风险|会议纪要))/u,
    /([\u4e00-\u9fff]{2,12}(?:事件捕获|来源引用|上下文包检索|句子抽取))/u,
    /([\u4e00-\u9fff]{2,12}(?:控制|预算|摘要|召回|压缩|归档|降权|删除|权限|引用|冲突|检索|索引|记忆|上下文包|上下文|事实|来源|任务|偏好|流程|策略))/u,
    /([\u4e00-\u9fff]{2,8}(?:控制|预算|摘要|召回|压缩|归档|降权|删除|权限|引用|冲突|检索|索引|记忆|事实|来源|任务|偏好|流程|策略))/u
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern)?.[1]?.trim();
    if (match) {
      const stripped = stripLeadingSummaryStopWords(match);
      const cleaned = stripSummaryGlueWords(stripped);
      if (cleaned.length <= factSummaryLimit) return cleaned;
    }
  }
  return undefined;
}

function segmentWords(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    return [...segmenter.segment(value)].map((item) => item.segment.trim()).filter((segment): segment is string => Boolean(segment));
  }
  return value.split(/[\s]+/u).map((item) => item.trim()).filter(Boolean);
}

function isSummaryStopWord(value: string) {
  return [
    "该",
    "此",
    "这个",
    "那个",
    "本次",
    "会议",
    "讨论",
    "讨论了",
    "围绕",
    "关于",
    "主要",
    "了",
    "的",
    "包",
    "实现",
    "方案",
    "实现方案",
    "包含",
    "支持",
    "描述",
    "说明",
    "补充",
    "解释",
    "系统",
    "上下文",
    "引擎",
    "核心",
    "高价值",
    "技术",
    "知识",
    "属于",
    "值得",
    "保留",
    "用于",
    "需要",
    "能够",
    "可以",
    "应",
    "需",
    "必须",
    "优先"
  ].includes(value);
}

function stripSummaryStopWords(value: string) {
  return segmentWords(value).filter((segment) => !isSummaryStopWord(segment)).join("");
}

function isTechnicalToken(value: string) {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(value) || /^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value);
}

function joinSegmentsUntilLimit(segments: string[], limit: number) {
  let result = "";
  for (const segment of segments) {
    if (!segment) continue;
    if ((result + segment).length > limit) {
      return result;
    }
    result += segment;
  }
  return result || undefined;
}

function firstBoundedSegment(segments: string[], limit: number) {
  const segment = segments.find((item) => item.length <= limit);
  if (segment) return segment;
  return "";
}

function stripLeadingSummaryStopWords(value: string) {
  let result = value;
  for (const prefix of ["上下文包", "上下文", "系统", "包"]) {
    if (result.startsWith(prefix) && result.length > prefix.length + 1) {
      result = result.slice(prefix.length);
    }
  }
  return result;
}

function stripSummaryGlueWords(value: string) {
  return value.replace(/的(?=[\u4e00-\u9fff])/gu, "").trim();
}
