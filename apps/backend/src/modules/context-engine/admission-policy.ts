import type { FactItem, MemoryEvent, ShortTermMemory } from "./domain.js";
import { memoryEventSummary } from "./memory-event-fields.js";
import { isMeaningfulQuantitativeFact } from "./quantitative-fact.js";

export interface AdmissionSignals {
  importance: "low" | "medium" | "high" | "critical";
  confidence: FactItem["confidenceLevel"];
  freshness: "stale" | "recent" | "fresh";
  sensitivity: "low" | "medium" | "high";
  actorWeight: "low" | "medium" | "high";
  conflict: "none" | "possible" | "known";
  permission: "private" | "shared" | "public";
}

export interface AdmissionDecision {
  result: ShortTermMemory["admissionResult"];
  memoryDataType?: string;
  reason: string;
  matchedRules: string[];
  importanceLevel: ShortTermMemory["importanceLevel"];
  confidenceLevel: ShortTermMemory["confidenceLevel"];
  ttl?: number;
  needUserConfirm?: boolean;
  lifecycleStatus: ShortTermMemory["lifecycleStatus"];
  accessState: NonNullable<ShortTermMemory["accessState"]>;
  signals: AdmissionSignals;
}

export function evaluateShortTermAdmission(
  event: MemoryEvent,
  facts: FactItem[]
): AdmissionDecision {
  const signals: AdmissionSignals = {
    importance: scoreImportance(event, facts),
    confidence: scoreConfidence(facts),
    freshness: scoreFreshness(event),
    sensitivity: scoreSensitivity(event, facts),
    actorWeight: scoreActorWeight(event),
    conflict: "none",
    permission: scorePermission(event)
  };
  const matchedRules = buildMatchedRules(signals, facts);
  const hasMeaningfulQuantitativeFact = facts.some(isMeaningfulQuantitativeFact);

  if (facts.length === 0) {
    return {
      result: "write_candidate",
      reason: "no_fact_created",
      matchedRules: ["unsupported_or_rejected_evidence"],
      importanceLevel: "low",
      confidenceLevel: "low",
      lifecycleStatus: "rejected",
      accessState: "visible",
      signals
    };
  }

  if (signals.sensitivity === "high") {
    return {
      result: "pending_confirm",
      reason: "high_sensitivity_pending_review",
      matchedRules,
      importanceLevel: "low",
      confidenceLevel: signals.confidence,
      lifecycleStatus: "pending_confirm",
      accessState: "visible",
      signals
    };
  }

  if (signals.importance === "critical" || signals.actorWeight === "high") {
    return {
      result: "write_high_priority",
      reason: "high_value_or_agent_confirmed_fact",
      matchedRules,
      importanceLevel: signals.importance === "critical" ? "critical" : "high",
      confidenceLevel: signals.confidence,
      lifecycleStatus: "active",
      accessState: "visible",
      signals
    };
  }

  if (hasMeaningfulQuantitativeFact) {
    return {
      result: "write_candidate",
      memoryDataType: "fact",
      reason: "meaningful_quantitative_fact",
      matchedRules,
      importanceLevel: "high",
      confidenceLevel: signals.confidence,
      lifecycleStatus: "candidate_queue",
      accessState: "visible",
      signals
    };
  }

  return {
    result: "write_short_term",
    reason: "admission_policy_passed",
    matchedRules,
    importanceLevel: signals.importance,
    confidenceLevel: signals.confidence,
    lifecycleStatus: "active",
    accessState: "visible",
    signals
  };
}

function scoreImportance(event: MemoryEvent, facts: FactItem[]): AdmissionSignals["importance"] {
  const text = `${event.eventType} ${memoryEventSummary(event)} ${facts
    .map((fact) => fact.factText)
    .join(" ")}`.toLowerCase();

  if (/\b(critical|must|必须|紧急|安全|删除|权限)\b/.test(text)) return "critical";
  if (facts.some(isMeaningfulQuantitativeFact)) return "high";
  if (/\b(preference|prefer|用户偏好|方案|prd|context|memory|agent)\b/.test(text)) return "high";
  if (facts.length > 0) return "medium";
  return "low";
}

function scoreConfidence(facts: FactItem[]): AdmissionSignals["confidence"] {
  if (!facts.length) return "low";
  if (facts.some((fact) => fact.confidenceLevel === "low")) return "low";
  if (facts.every((fact) => fact.confidenceLevel === "high")) return "high";
  return "medium";
}

function scoreFreshness(event: MemoryEvent): AdmissionSignals["freshness"] {
  const ageMs = Date.now() - Date.parse(event.eventTime);
  if (Number.isNaN(ageMs)) return "stale";
  if (ageMs < 60 * 60 * 1000) return "fresh";
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return "recent";
  return "stale";
}

function scoreSensitivity(event: MemoryEvent, facts: FactItem[]): AdmissionSignals["sensitivity"] {
  if (event.sourceApp === "longmemeval" || event.eventType.startsWith("longmemeval_")) return "low";
  const text = facts.map((fact) => fact.factText).join("\n").toLowerCase();
  if (/\b(password|secret|token|api[_ -]?key|credential|身份证|银行卡)\b/.test(text)) return "high";
  if (/\b(email|phone|address|private|confidential|隐私|地址|电话)\b/.test(text)) return "medium";
  return "low";
}

function scoreActorWeight(event: MemoryEvent): AdmissionSignals["actorWeight"] {
  if (event.sourceApp === "agent" || event.sourceApp === "context-debug-frontend") return "high";
  if (event.sourceApp) return "medium";
  return "low";
}

function scorePermission(event: MemoryEvent): AdmissionSignals["permission"] {
  if (event.permissionSnapshot.visibility === "public") return "public";
  if (event.permissionSnapshot.visibility === "team" || event.permissionSnapshot.visibility === "tenant") {
    return "shared";
  }
  return "private";
}

function buildMatchedRules(signals: AdmissionSignals, facts: FactItem[]) {
  return [
    "parser_adapter",
    "time_fusion",
    "fact_schema_v1",
    `importance:${signals.importance}`,
    `confidence:${signals.confidence}`,
    `freshness:${signals.freshness}`,
    `sensitivity:${signals.sensitivity}`,
    `actor_weight:${signals.actorWeight}`,
    `conflict:${signals.conflict}`,
    `permission:${signals.permission}`,
    facts.length > 0 ? "fact_required_passed" : "fact_required_failed",
    ...(facts.some(isMeaningfulQuantitativeFact) ? ["meaningful_quantitative_fact"] : [])
  ];
}
