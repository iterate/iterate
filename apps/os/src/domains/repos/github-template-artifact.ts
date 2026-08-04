import { getOrImportGithubArtifact } from "./artifact-import.ts";
import {
  GithubTemplateSourceError,
  createGithubTemplateSource,
  type GithubTemplateFile,
  type ResolvedGithubTemplateSource,
} from "./github-template-source.ts";
import { RepoNotSeededError } from "./utils.ts";

const DELETE_POLL_ATTEMPTS = 60;
const DELETE_POLL_INTERVAL_MS = 500;

async function deleteTemporaryArtifact(
  artifacts: Pick<Artifacts, "delete" | "get">,
  name: string,
  options: {
    pollAttempts?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const deleted = await artifacts.delete(name);
  if (!deleted) return;

  const pollAttempts = options.pollAttempts ?? DELETE_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DELETE_POLL_INTERVAL_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    try {
      await artifacts.get(name);
    } catch (error) {
      // The Artifacts client rejects with an undocumented optional `code`.
      // This read-only structural cast is the narrowest usable view: the
      // binding exports no error type, and every other value yields undefined.
      const code = (error as { code?: unknown } | null | undefined)?.code;
      if (code === "NOT_FOUND") return;
      // IMPORT_IN_PROGRESS still means the deterministic temporary repo
      // exists. Its queued deletion has not become visible yet.
      if (code !== "IMPORT_IN_PROGRESS") throw error;
    }
    if (attempt + 1 < pollAttempts) await sleep(pollIntervalMs);
  }
  throw new RepoNotSeededError(
    `Timed out waiting for temporary template Artifact ${JSON.stringify(name)} to be deleted.`,
  );
}

/** Materialize a resolved public template without cloning its pack into the
 * Worker. Cloudflare imports the source server-side into a deterministic
 * temporary Artifact so its immutable commit tree can be inspected. Branches
 * use a depth-one import; tags and commit SHAs omit branch/depth so every
 * advertised ref is available without GitHub REST API rate limits. The
 * temporary repo is gone before bytes are returned, making cleanup part of
 * the creation obligation. */
type ArtifactContentRepo = ArtifactsRepo & {
  log(options: { limit: number; ref: string }): Promise<
    Array<{
      hash: string;
      treeHash: string;
    }>
  >;
  readTree(hash: string): Promise<unknown>;
};

export async function readGithubTemplateFiles(input: {
  artifacts: Pick<Artifacts, "delete" | "get" | "import">;
  source: ResolvedGithubTemplateSource;
  sourceAdapter?: ReturnType<typeof createGithubTemplateSource>;
  temporaryArtifactName: string;
  cleanup?: Parameters<typeof deleteTemporaryArtifact>[2];
}): Promise<GithubTemplateFile[]> {
  const sourceAdapter = input.sourceAdapter ?? createGithubTemplateSource();

  try {
    // getOrImportGithubArtifact preserves the underlying Artifacts repo
    // capability, whose runtime API includes log/readTree. The generated
    // ArtifactsRepo type omits those content methods, so there is no typed
    // narrowing available; this cast only exposes the two methods used here.
    const repo = (await getOrImportGithubArtifact(input.artifacts, {
      ...(input.source.branch === undefined ? {} : { branch: input.source.branch, depth: 1 }),
      name: input.temporaryArtifactName,
      owner: input.source.owner,
      repo: input.source.repo,
    })) as ArtifactContentRepo;
    const [head] = await repo.log({ limit: 1, ref: input.source.commitSha });
    if (
      head === undefined ||
      !/^[0-9a-f]{40}$/i.test(head.hash) ||
      !/^[0-9a-f]{40}$/i.test(head.treeHash)
    ) {
      throw new GithubTemplateSourceError(
        `Imported template Artifact does not contain commit ${input.source.commitSha}.`,
        { retryable: true },
      );
    }
    if (head.hash !== input.source.commitSha) {
      throw new GithubTemplateSourceError(
        `Imported template Artifact resolved ${input.source.commitSha} to unexpected commit ${head.hash}.`,
        { retryable: true },
      );
    }
    return await sourceAdapter.files(input.source, {
      readTree: (hash) => repo.readTree(hash),
      rootTreeHash: head.treeHash,
    });
  } finally {
    // Await both the delete request and its visibility. A crash before this
    // point leaves a deterministic import that recovery adopts; a successful
    // return leaves no temporary source repository behind.
    await deleteTemporaryArtifact(input.artifacts, input.temporaryArtifactName, input.cleanup);
  }
}
