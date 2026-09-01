import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { ITERATE_GITHUB_BOT_COMMIT_AUTHOR } from "../integrations/utils.ts";
import { readCheckoutFiles, repoContentHash } from "./checkout-files.ts";
import { stripArtifactTokenExpiry } from "./artifact-creation.ts";
import {
  classifyRepoAccessError,
  isRepoNotSeededError,
  RetryableRepoCreationError,
} from "./utils.ts";

const REPO_WRITE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
// Artifact creation is an at-least-once obligation. Concurrent first drives
// must produce the same root commit instead of racing two timestamped seeds.
const REPO_SEED_COMMIT_TIMESTAMP_SECONDS = 1_577_836_800;
const REPO_DIR = "/repo";

/**
 * The repo's git-over-HTTPS coordinates: the SERVER-returned remote URL and a
 * freshly minted write token. The remote must be used verbatim — Artifacts
 * stores repo names with its own casing (newer repos lowercased) and matches
 * git-wire URLs case-sensitively, so a URL rebuilt from the request-time name
 * can 403 against a perfectly healthy repo (live-observed 2026-09-01, when a
 * service change surfaced the mismatch fleet-wide).
 */
export async function artifactGitAccess(
  artifacts: Artifacts,
  name: string,
): Promise<{ remote: string; token: string }> {
  const repo = await artifacts.get(name);
  const { plaintext } = await repo.createToken("write", REPO_WRITE_TOKEN_TTL_SECONDS);
  return { remote: repo.remote, token: stripArtifactTokenExpiry(plaintext) };
}

/**
 * Seed an Artifact with one deterministic root commit.
 *
 * This is create-if-absent: a retry that discovers an existing branch returns
 * that branch unchanged, while simultaneous first drives produce the same
 * commit oid and never force-push over real history.
 */
export async function seedArtifactRepo(input: {
  branch: string;
  files: Array<{ content: string; path: string }>;
  remote: string;
  token: string;
}): Promise<{ commitOid: string; contentHash: string }> {
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, REPO_DIR);
  const credentials = { password: input.token, username: "x" };

  let cloned = false;
  try {
    await git.clone({
      branch: input.branch,
      depth: 1,
      singleBranch: true,
      url: input.remote,
      ...credentials,
    });
    cloned = true;
  } catch {
    await git.init({ defaultBranch: input.branch });
    await git.remote({ add: { name: "origin", url: input.remote } });
  }

  if (cloned) {
    const [head] = await git.log({ depth: 1, ref: input.branch }).catch((error: unknown) => {
      if (isRepoNotSeededError(classifyRepoAccessError(error, input.branch))) return [];
      throw error;
    });
    if (head) {
      return {
        commitOid: head.oid,
        contentHash: await repoContentHash(await readCheckoutFiles(filesystem, REPO_DIR)),
      };
    }
  }

  for (const file of input.files) {
    const dir = `${REPO_DIR}/${file.path}`.replace(/\/[^/]+$/, "");
    if (dir !== REPO_DIR && !(await filesystem.exists(dir))) {
      await filesystem.mkdir(dir, { recursive: true });
    }
    await filesystem.writeFile(`${REPO_DIR}/${file.path}`, file.content);
    await git.add({ filepath: file.path });
  }

  const identity = {
    email: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.email,
    name: ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name,
    timestamp: REPO_SEED_COMMIT_TIMESTAMP_SECONDS,
    timezoneOffset: 0,
  };
  await git.commit({ author: identity, message: "Seed project config" });
  try {
    await git.branch({ name: input.branch });
  } catch (error) {
    if (!String(error).match(/already exists/i)) throw error;
  }

  const [head] = await git.log({ depth: 1, ref: input.branch });
  if (!head) throw new Error(`Prepared repo has no head commit on ${input.branch}.`);
  const seeded = {
    commitOid: head.oid,
    contentHash: await repoContentHash(await readCheckoutFiles(filesystem, REPO_DIR)),
  };
  const pushed = await git.push({ ref: input.branch, remote: "origin", ...credentials });
  if (!pushed.ok) {
    throw new RetryableRepoCreationError(
      `Failed to push ${input.branch}: ${JSON.stringify(pushed.refs)}`,
    );
  }
  return seeded;
}
