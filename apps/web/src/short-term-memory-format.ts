interface ShortTermMemoryTrailInput {
  sourceFactIds?: unknown;
  admissionResult: string;
  admissionReason: string;
}

const shortTermMemoryTrailTranslations: Record<string, string> = {
  write_short_term: "写入短期记忆",
  write_candidate: "写入候选",
  write_high_priority: "高优先写入",
  pending_confirm: "待确认",
  reject: "拒绝"
};

export function formatShortTermMemoryTrail(memory: ShortTermMemoryTrailInput) {
  const sourceFactIds = Array.isArray(memory.sourceFactIds) ? memory.sourceFactIds : [];
  const sourceFactCount = sourceFactIds.length ? `${sourceFactIds.length} 条事实` : "无来源事实";
  return [
    sourceFactCount,
    `准入 ${shortTermMemoryTrailTranslations[memory.admissionResult] ?? memory.admissionResult}`,
    `原因 ${memory.admissionReason}`
  ].join(" · ");
}
