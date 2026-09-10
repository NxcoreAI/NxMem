import type { DreamingReevaluationTier, DreamingStmEvaluation } from "./domain.js";
import { localDateAt, localDateTimeAtUtc } from "./dreaming-run-service.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

const tierDays: Record<DreamingReevaluationTier, number> = {
  NEXT_DAY: 1,
  THREE_DAYS: 3,
  SEVEN_DAYS: 7
};

export function calculateDreamingNextEvaluateAt(
  candidateCutoffAt: string,
  tier: DreamingReevaluationTier,
  timezone = DEFAULT_TIMEZONE
) {
  const anchorDate = localDateAt(candidateCutoffAt, timezone);
  const targetDate = addCalendarDays(anchorDate, tierDays[tier]);
  return localDateTimeAtUtc(targetDate, 23, 0, timezone);
}

export function selectDreamingReevaluationTier(
  evaluation: Pick<DreamingStmEvaluation, "decision" | "totalScore">
): DreamingReevaluationTier {
  if (evaluation.decision !== "observe") {
    throw new Error(`DREAMING_REEVALUATION_TIER_NOT_APPLICABLE:${evaluation.decision}`);
  }
  if (evaluation.totalScore >= 5.3) return "NEXT_DAY";
  if (evaluation.totalScore >= 4.6) return "THREE_DAYS";
  return "SEVEN_DAYS";
}

function addCalendarDays(localDate: string, days: number) {
  const [yearText, monthText, dayText] = localDate.split("-");
  const shifted = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + days));
  return shifted.toISOString().slice(0, 10);
}
