export interface FileIngestionBatchItemProgress {
  path: string;
  eventId: string;
  status: "remembered" | "failed";
  currentStage: "event" | "data_lake" | "fact" | "stm" | "index";
  completedStages: Array<"event" | "data_lake" | "fact" | "stm" | "index">;
  progress: number;
  result?: {
    accepted: boolean;
    eventId: string;
    jobId: string;
    deduplicated: boolean;
  };
  error?: string;
  droppedReason?: string;
}

export interface FileIngestionBatchProgress {
  total: number;
  processed: number;
  remembered: number;
  failed: number;
  progress: number;
  items: FileIngestionBatchItemProgress[];
}

export interface FileIngestionResponse {
  ok?: boolean;
  result?: {
    directory: string;
    ingested: Array<{
      path: string;
      idempotencyKey: string;
      result: {
        accepted: boolean;
        eventId: string;
        jobId: string;
        deduplicated: boolean;
      };
      progress: FileIngestionBatchItemProgress;
    }>;
    skipped: Array<{ path: string; reason: string }>;
    failed: Array<{
      path: string;
      idempotencyKey: string;
      error: string;
      progress: FileIngestionBatchItemProgress;
    }>;
    progress: FileIngestionBatchProgress;
  };
  error?: string;
}

export async function requestFileIngestion(fetchImpl: typeof fetch = fetch): Promise<FileIngestionResponse> {
  const response = await fetchImpl("/context/ingest/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });

  return response.json();
}
