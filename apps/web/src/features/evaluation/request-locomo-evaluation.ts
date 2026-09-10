export interface LocomoEvaluationJob {
  jobId: string;
  datasetPath: string;
  command: "full" | "prepare" | "evaluate";
  profile: "locomo-fact-stm-v1";
  status: "queued" | "running" | "done" | "error" | "cancelled";
  totalConversations?: number;
  processedConversations?: number;
  totalQuestions?: number;
  processedQuestions?: number;
  progress?: number;
  currentConversationId?: string;
  currentQuestionId?: string;
  storePath?: string;
  summary?: {
    count: number;
    categoryScores: Record<string, { count: number; score: number }>;
    overallOfficialQaScore: number;
    perfectScoreRate: number;
    scorerVersion: string;
  };
  error?: string;
}

interface Response { ok: boolean; result?: LocomoEvaluationJob; error?: string }

export async function requestLocomoEvaluation(fetchImpl: typeof fetch, payload: {
  datasetPath: string;
  command: "full" | "prepare" | "evaluate";
  storePath?: string;
  sampleIds?: string[];
  sampleRange?: { start: number; end: number };
  questionLimit?: number;
  questionConcurrency?: number;
  llm?: {
    extraction?: { baseUrl?: string; model?: string; apiKey?: string };
    answer?: { baseUrl?: string; model?: string; apiKey?: string };
  };
  disableIngestLlm?: boolean;
  ci?: boolean;
}): Promise<Response> {
  return request(fetchImpl, "/context/evaluations/locomo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

export async function requestLocomoEvaluationJob(fetchImpl: typeof fetch, jobId: string): Promise<Response> {
  return request(fetchImpl, `/context/evaluations/locomo/${encodeURIComponent(jobId)}`);
}

export async function requestCancelLocomoEvaluation(fetchImpl: typeof fetch, jobId: string): Promise<Response> {
  return request(fetchImpl, `/context/evaluations/locomo/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

async function request(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetchImpl(url, init);
    return await response.json() as Response;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "LoCoMo evaluation request failed" };
  }
}
