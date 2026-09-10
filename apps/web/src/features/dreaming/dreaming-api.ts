export type DreamingRunStatus =
  | "queued"
  | "waiting_for_idle"
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export type DreamingCandidateStatus =
  | "pending"
  | "processing"
  | "consolidated"
  | "observing"
  | "dropped"
  | "retry_wait"
  | "skipped";

export interface DreamingRunSummary {
  runId: string;
  triggerType: "scheduled" | "manual";
  status: DreamingRunStatus;
  candidateWindowStartAt: string;
  candidateCutoffAt: string;
  candidateCount: number;
  processedCount: number;
  consolidatedCount: number;
  observingCount: number;
  droppedCount: number;
  retryWaitCount: number;
  skippedCount: number;
  pauseReason?: "foreground_activity" | "manual";
  actualStartedAt?: string;
  pausedAt?: string;
  completedAt?: string;
}

export interface DreamingRun extends DreamingRunSummary {
  tenantId: string;
  principalId: string;
  requestedAt: string;
  checkpoint?: string;
  policyVersion: string;
  promptVersion: string;
  model?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DreamingRunCandidate {
  runCandidateId: string;
  runId: string;
  memoryDataId: string;
  stmVersion: string;
  candidateFingerprint: string;
  sourceType: "new" | "observing_due" | "retry_due" | "carryover";
  status: DreamingCandidateStatus;
  cycleAttemptCount: number;
  totalAttemptCount: number;
  reevaluationTier?: "NEXT_DAY" | "THREE_DAYS" | "SEVEN_DAYS";
  nextEvaluateAt?: string;
  decisionId?: string;
  traceId?: string;
  resultLtmId?: string;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface DreamingRunDetails {
  run: DreamingRun;
  candidates: DreamingRunCandidate[];
}

export interface DreamingOwner {
  tenantId: string;
  principalId: string;
}

export const DEFAULT_DREAMING_OWNER: DreamingOwner = {
  tenantId: "local",
  principalId: "debug-user"
};

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? `Dreaming 请求失败 (${response.status})`);
  }
  return (data.result ?? data) as T;
}

function ownerQuery(owner: DreamingOwner) {
  const params = new URLSearchParams({ tenantId: owner.tenantId, principalId: owner.principalId });
  return params.toString();
}

export function listDreamingRuns(owner = DEFAULT_DREAMING_OWNER) {
  return request<{ items: DreamingRunSummary[] }>(`/context/dreaming/runs?${ownerQuery(owner)}`);
}

export function getDreamingRun(runId: string, owner = DEFAULT_DREAMING_OWNER) {
  return request<DreamingRunDetails>(`/context/dreaming/runs/${encodeURIComponent(runId)}?${ownerQuery(owner)}`);
}

export function createDreamingRun(owner = DEFAULT_DREAMING_OWNER) {
  return request<DreamingRunSummary>("/context/dreaming/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(owner)
  });
}

export function controlDreamingRun(runId: string, action: "pause" | "resume" | "cancel", owner = DEFAULT_DREAMING_OWNER) {
  return request<DreamingRunSummary>(`/context/dreaming/runs/${encodeURIComponent(runId)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(owner)
  });
}

