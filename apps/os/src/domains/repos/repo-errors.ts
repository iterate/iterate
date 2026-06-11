// Typed "the repo has nothing for you" states. Workers RPC preserves
// `error.name` across the repo-DO hop, so callers classify by name (see
// also isMissingProjectWorkerError in ~/domains/projects/
// project-worker-runtime.ts), never by message substring.

/** The repo row does not exist yet — nothing has created it. */
export class RepoNotCreatedError extends Error {
  override readonly name = "RepoNotCreatedError";
}

/** The repo exists but the requested branch has no commits. */
export class RepoEmptyError extends Error {
  override readonly name = "RepoEmptyError";
}

export function isRepoAlreadyExistsError(error: unknown) {
  return error instanceof Error && /Repo .* already exists\./.test(error.message);
}

export function isRepoNotCreatedError(error: unknown) {
  return error instanceof Error && error.name === "RepoNotCreatedError";
}

export function isRepoNotFoundError(error: unknown) {
  return error instanceof Error && /Repo .* not found\./.test(error.message);
}
