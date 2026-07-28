import { isRepoNotSeededError, RepoNotSeededError } from "./utils.ts";

// Keep this protocol-level readiness wait bounded so a still-broken repo
// returns to the durable redelivery lane instead of pinning the project frame
// indefinitely. Project.create() has a separate, tighter caller deadline.
const EXISTING_ARTIFACT_READY_TIMEOUT_MS = 45_000;
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
  try {
    const created = await artifacts.create(name, { setDefaultBranch: input.defaultBranch });
    return {
      created: true,
      initialWriteToken: stripArtifactTokenExpiry(created.token),
      lastPushAt: null,
    };
  } catch (error) {
    if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
  }

  const existing = await waitForExistingArtifact(artifacts, name);
  return { created: false, initialWriteToken: null, lastPushAt: existing.lastPushAt };
}

async function waitForExistingArtifact(
  artifacts: { get(name: string): Promise<{ lastPushAt: string | null }> },
  name: string,
): Promise<{ lastPushAt: string | null }> {
  const deadline = Date.now() + EXISTING_ARTIFACT_READY_TIMEOUT_MS;
  let lastError: unknown;
  let retryDelayMs = EXISTING_ARTIFACT_READY_INITIAL_RETRY_MS;

  for (;;) {
    try {
      return await artifacts.get(name);
    } catch (error) {
      if (!isRepoNotSeededError(error)) throw error;
      lastError = error;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remainingMs)));
    retryDelayMs = Math.min(retryDelayMs * 2, EXISTING_ARTIFACT_READY_MAX_RETRY_MS);
  }

  throw new RepoNotSeededError(
    `Artifact ${name} did not become readable within ${EXISTING_ARTIFACT_READY_TIMEOUT_MS}ms.`,
    { cause: lastError },
  );
}

export function stripArtifactTokenExpiry(token: string): string {
  return token.split("?expires=")[0] ?? token;
}
