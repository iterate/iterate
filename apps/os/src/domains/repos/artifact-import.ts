import { isRepoNotSeededError, RepoNotSeededError } from "./utils.ts";

const READY_ATTEMPTS = 120;
const READY_RETRY_MS = 1_000;

async function waitForArtifactReady(
  artifacts: Pick<Artifacts, "get">,
  name: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1) {
    try {
      await artifacts.get(name);
      return;
    } catch (error) {
      if (!isRepoNotSeededError(error)) throw error;
      lastError = error;
    }

    if (attempt < READY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
    }
  }

  throw new RepoNotSeededError(`Artifact ${name} was not ready after ${READY_ATTEMPTS} attempts.`, {
    cause: lastError,
  });
}

/**
 * Ask Cloudflare Artifacts to clone a public GitHub repository directly.
 * The deterministic target name makes a completed retry equivalent to
 * success; the repo processor owns all further orchestration.
 */
export async function importGithubArtifact(
  artifacts: Pick<Artifacts, "get" | "import">,
  input: { branch: string; depth?: number; name: string; owner: string; repo: string },
): Promise<void> {
  try {
    await artifacts.import({
      source: {
        branch: input.branch,
        // Cloudflare documents depth as optional. Omitting it imports the
        // full history without transferring it through this Worker.
        // https://developers.cloudflare.com/artifacts/api/workers-binding/#importparams
        ...(input.depth === undefined ? {} : { depth: input.depth }),
        url: `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}.git`,
      },
      target: { name: input.name },
    });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ALREADY_EXISTS") throw error;
  }

  // import() can be retried after its side effect committed but before the
  // caller observed the response. Never equate a reserved name with a ready
  // repository: get() is the Artifacts readiness barrier.
  await waitForArtifactReady(artifacts, input.name);
}
