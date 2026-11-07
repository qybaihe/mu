// Runs one job with its queue's timeout; a job that runs past it is aborted.
export async function runJob(job, queue, handler) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), queue.timeoutMs);
  try {
    return await handler(job, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function nextAttemptAt(now, attempt, queue) {
  return now + queue.backoffMs * 2 ** (attempt - 1);
}
