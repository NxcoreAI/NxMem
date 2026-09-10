import type {
  LongMemEvalEvaluationReport,
  LongMemEvalReport,
  LongMemEvalSampleReport
} from "./longmemeval.js";
import type { LongMemEvalJobSnapshot } from "./longmemeval-jobs.js";

export interface LongMemEvalSamplePage {
  jobId: string;
  datasetPath: string;
  totalSamples: number;
  page: number;
  pageSize: number;
  totalPages: number;
  samples: LongMemEvalSampleReport[];
}

export function readPrimaryLongMemEvalReport(report: LongMemEvalEvaluationReport | undefined): LongMemEvalReport | undefined {
  if (!report) return undefined;
  if (!("runs" in report)) return report;
  return report.runs.find((run) => run.report)?.report;
}

export function buildLongMemEvalSamplePage(
  job: LongMemEvalJobSnapshot,
  page: number,
  pageSize: number
): LongMemEvalSamplePage | undefined {
  const report = readPrimaryLongMemEvalReport(job.report);
  if (!report?.samples?.length) return undefined;

  const normalizedPageSize = Math.max(1, Math.floor(pageSize || 1));
  const totalSamples = report.samples.length;
  const totalPages = Math.max(1, Math.ceil(totalSamples / normalizedPageSize));
  const normalizedPage = Math.min(Math.max(1, Math.floor(page || 1)), totalPages);
  const start = (normalizedPage - 1) * normalizedPageSize;

  return {
    jobId: job.jobId,
    datasetPath: job.datasetPath,
    totalSamples,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalPages,
    samples: report.samples.slice(start, start + normalizedPageSize)
  };
}

export function stripLongMemEvalSamplesFromJob(
  job: LongMemEvalJobSnapshot
): Omit<LongMemEvalJobSnapshot, "report"> & { report?: unknown } {
  if (!job.report) return job;
  return {
    ...job,
    report: stripLongMemEvalSamples(job.report)
  };
}

function stripLongMemEvalSamples(report: LongMemEvalEvaluationReport): unknown {
  if (!("runs" in report)) {
    const { samples: _samples, ...rest } = report;
    return rest;
  }
  return {
    ...report,
    runs: report.runs.map((run) =>
      run.report
        ? {
            ...run,
            report: stripLongMemEvalSamples(run.report)
          }
        : run
    )
  };
}
