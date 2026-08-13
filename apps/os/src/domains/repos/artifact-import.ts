import type { StreamEventInput } from "iterate/processors";
import { isRepoNotSeededError, RepoNotSeededError } from "./utils.ts";

const READY_ATTEMPTS = 120;
const READY_RETRY_MS = 1_000;

async function waitForArtifactReady(
  artifacts: Pick<Artifacts, "get">,
  name: string,
): Promise<ArtifactsRepo> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1) {
    try {
      return await artifacts.get(name);
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
  await importGithubArtifactRepo(artifacts, input);
}

/**
 * Import a public repo, then capture its initial push directly. Cloudflare's
 * server-side import completes before the Worker can observe that first push,
 * so read the authoritative Artifacts head and append the equivalent fact.
 */
export async function importGithubArtifactWithInitialPushCapture(
  artifacts: Pick<Artifacts, "get" | "import">,
  input: { branch: string; depth?: number; name: string; owner: string; repo: string },
  effects: {
    append(event: StreamEventInput): Promise<unknown>;
    namespace: string;
  },
): Promise<void> {
  const repo = await importGithubArtifactRepo(artifacts, input);

  // log() is deployed and documented, but the pinned workers-types release
  // has not yet published the three Artifacts content-read methods.
  // https://developers.cloudflare.com/artifacts/api/workers-binding/#log-opts
  const history = await (
    repo as ArtifactsRepo & {
      log(options: { limit: number; ref: string }): Promise<Array<{ hash: string }>>;
    }
  ).log({ ref: input.branch, limit: 1 });
  const commitOid = history[0]?.hash;
  if (typeof commitOid !== "string" || !/^[0-9a-f]{40}$/i.test(commitOid)) {
    throw new Error(`Imported Artifact ${input.name} has no valid ${input.branch} head.`);
  }

  await effects.append({
    type: "events.iterate.com/repo/cloudflare-artifact-event-received",
    idempotencyKey: `artifact-import-initial-push:${commitOid}`,
    payload: {
      artifactName: input.name,
      body: {
        type: "cf.artifacts.repo.pushed",
        source: {
          namespace: effects.namespace,
          repoName: input.name,
          type: "artifacts.repo",
        },
        payload: {
          after: commitOid,
          before: "0".repeat(40),
          ref: `refs/heads/${input.branch}`,
        },
      },
      cloudflareEventType: "cf.artifacts.repo.pushed",
      namespace: effects.namespace,
    },
  });
}

async function importGithubArtifactRepo(
  artifacts: Pick<Artifacts, "get" | "import">,
  input: { branch: string; depth?: number; name: string; owner: string; repo: string },
): Promise<ArtifactsRepo> {
  try {
    await artifacts.import({
      source: {
        branch: input.branch,
        // Cloudflare documents depth as optional. Omitting it imports the
        // full history without transferring it through this Worker.
        // https://developers.cloudflare.com/artifacts/api/workers-binding/#importparams
        ...(Number.isFinite(input.depth) && { depth: input.depth }),
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
  return await waitForArtifactReady(artifacts, input.name);
}
