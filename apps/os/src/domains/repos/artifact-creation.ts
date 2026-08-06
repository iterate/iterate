import { isRepoNotSeededError, RepoNotSeededError, RetryableRepoCreationError } from "./utils.ts";

// Healthy creates finish in about two seconds (live p99 2.1s). Keep the whole
// idempotent create/readback operation below the hosted callback's 20-second
// deadline so an Artifacts outlier returns to durable redelivery rather than
// pinning the callback until its transport fails.
const ARTIFACT_CREATION_DEADLINE_MS = 8_000;
const EXISTING_ARTIFACT_READY_INITIAL_RETRY_MS = 250;
const EXISTING_ARTIFACT_READY_MAX_RETRY_MS = 4_000;

export type GetOrCreateArtifactResult =
  | {
      created: true;
      initialWriteToken: string;
      lastPushAt: null;
    }
  | {
      created: false;
      initialWriteToken: null;
      lastPushAt: string | null;
    };

/**
 * Create an Artifacts repository idempotently and report whether it has
 * already received a push.
 *
 * A successful create returns the initial write token Cloudflare minted with
 * the repo. Preserve it: immediately calling get()+createToken() is both
 * redundant and a create/read consistency race.
 *
 * An ALREADY_EXISTS response can mean a prior attempt committed but its
 * response was lost. In that case the create plane may reserve the name
 * before get() can observe the repo. Wait here with bounded exponential
 * backoff rather than repeatedly hammering create and surfacing every
 * not-ready observation through the durable processor error path.
 */
export async function getOrCreateArtifact(
  artifacts: {
    create(
      name: string,
      input: { setDefaultBranch: string },
    ): Promise<Pick<ArtifactsCreateRepoResult, "token">>;
    get(name: string): Promise<{ lastPushAt: string | null }>;
  },
  name: string,
  input: { defaultBranch: string },
): Promise<GetOrCreateArtifactResult> {
  const deadlineAt = Date.now() + ARTIFACT_CREATION_DEADLINE_MS;
  try {
    const created = await beforeArtifactCreationDeadline(
      () => artifacts.create(name, { setDefaultBranch: input.defaultBranch }),
      deadlineAt,
      () => artifactCreationTimeout(name, undefined),
    );
    return {
      created: true,
      initialWriteToken: stripArtifactTokenExpiry(created.token),
      lastPushAt: null,
    };
  } catch (error) {
    if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
  }

  const existing = await waitForExistingArtifact(artifacts, name, deadlineAt);
  return { created: false, initialWriteToken: null, lastPushAt: existing.lastPushAt };
}

async function waitForExistingArtifact(
  artifacts: { get(name: string): Promise<{ lastPushAt: string | null }> },
  name: string,
  deadlineAt: number,
): Promise<{ lastPushAt: string | null }> {
  let lastError: unknown;
  let retryDelayMs = EXISTING_ARTIFACT_READY_INITIAL_RETRY_MS;

  for (;;) {
    try {
      return await beforeArtifactCreationDeadline(
        () => artifacts.get(name),
        deadlineAt,
        () => artifactReadTimeout(name, lastError),
      );
    } catch (error) {
      if (error instanceof RetryableRepoCreationError) throw error;
      if (!isRepoNotSeededError(error)) throw error;
      lastError = error;
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remainingMs)));
    retryDelayMs = Math.min(retryDelayMs * 2, EXISTING_ARTIFACT_READY_MAX_RETRY_MS);
  }

  throw new RepoNotSeededError(
    `Artifact ${name} did not become readable within ${ARTIFACT_CREATION_DEADLINE_MS}ms.`,
    { cause: lastError },
  );
}

async function beforeArtifactCreationDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  timeoutError: () => Error,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw timeoutError();

  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(timeoutError()), remainingMs);
  try {
    return await Promise.race([operation(), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function artifactCreationTimeout(name: string, cause: unknown): RetryableRepoCreationError {
  return new RetryableRepoCreationError(
    `Artifact ${name} did not finish creating within ${ARTIFACT_CREATION_DEADLINE_MS}ms.`,
    { cause },
  );
}

function artifactReadTimeout(name: string, cause: unknown): RepoNotSeededError {
  return new RepoNotSeededError(
    `Artifact ${name} did not become readable within ${ARTIFACT_CREATION_DEADLINE_MS}ms.`,
    { cause },
  );
}

export function stripArtifactTokenExpiry(token: string): string {
  return token.split("?expires=")[0] ?? token;
}
