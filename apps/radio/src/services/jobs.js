import { id, log } from './store.js';

const jobs = new Map();
const TTL_MS = 1000 * 60 * 90;

/**
 * Kick off async work immediately and hand back a job id the browser can poll.
 * Used everywhere the UI says "we're working on it" and shows an animated SVG.
 */
export function startJob(kind, worker, meta = {}) {
  const jobId = id('job');
  const job = {
    jobId,
    kind,
    meta,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null
  };
  jobs.set(jobId, job);

  Promise.resolve()
    .then(() => worker())
    .then((result) => {
      job.status = 'done';
      job.result = result;
      job.finishedAt = Date.now();
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err?.message || 'Something went wrong.';
      job.finishedAt = Date.now();
      log.error(`job:${kind}`, err?.message || err, meta);
    });

  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(key);
  }
}, 1000 * 60 * 10).unref?.();
