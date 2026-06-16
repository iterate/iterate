/**
 * "There is no worker to load" is a normal state: the repo or worker.js may not
 * exist yet. Other load failures should still retry through the processor
 * checkpoint.
 */
const MISSING_PROJECT_WORKER_ERROR_NAMES: ReadonlySet<string> = new Set([
  "MissingProjectWorkerError",
  "RepoNotCreatedError",
  "RepoEmptyError",
]);

export function isMissingProjectWorkerError(error: unknown): boolean {
  return error instanceof Error && MISSING_PROJECT_WORKER_ERROR_NAMES.has(error.name);
}

export function isMissingProjectWorkerProcessEventError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('RPC receiver does not implement the method "processEvent"')
  );
}
