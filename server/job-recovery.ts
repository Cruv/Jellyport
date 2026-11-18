import type { Job } from './service.js';

/** Retain completed account results and remove progress that can no longer advance. */
export function finishJob(job: Job, finishedAt: string): void {
  job.results ??= [];
  for (const result of job.results) {
    if (result.status !== 'running') continue;
    result.status = 'interrupted';
    result.error ??= 'This account did not finish. Check its completed changes before retrying.';
  }
  job.progress = {
    processed: job.progress?.processed ?? job.results.length,
    total: job.progress?.total ?? job.results.length,
  };
  job.finished_at = finishedAt;
  job.updated_at = finishedAt;
  job.elapsed_ms = Math.max(0, Date.parse(finishedAt) - Date.parse(job.created_at)) || 0;
  if (job.preview_timing) job.workflow_elapsed_ms = job.preview_timing.elapsed_ms + job.elapsed_ms;
}
