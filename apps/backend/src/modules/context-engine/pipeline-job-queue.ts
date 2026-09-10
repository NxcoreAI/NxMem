export interface ContextPipelineQueueSnapshot {
  concurrency: number;
  running: number;
  queued: number;
}

export type PipelineJob = () => Promise<void>;

export class ContextPipelineQueue {
  private readonly queue: Array<{
    job: PipelineJob;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  enqueue(job: PipelineJob): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.drain();
    });
  }

  snapshot(): ContextPipelineQueueSnapshot {
    return {
      concurrency: this.concurrency,
      running: this.running,
      queued: this.queue.length
    };
  }

  private drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      if (!item) return;
      this.running += 1;
      void item.job()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }
}

const defaultQueue = new ContextPipelineQueue(readPositiveInteger(
  process.env.CONTEXT_PIPELINE_CONCURRENCY,
  2
));

export function enqueueContextPipelineJob(job: PipelineJob) {
  return defaultQueue.enqueue(job);
}

export function getSharedContextPipelineQueueSnapshot() {
  return defaultQueue.snapshot();
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
