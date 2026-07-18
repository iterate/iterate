import type { Git } from "@cloudflare/shell/git";
import type { StatelessDynamicWorkerRef } from "../workers/schemas.ts";

type RepoArtifactNameParts = {
  projectId: string | null;
  path: string;
};

const SEPARATOR = "--";
const GLOBAL_REPO_ARTIFACT_PROJECT_ID = "global";

import { CONFIG_REPO_PATH } from "./paths.ts";

/**
 * The default project worker's build entry point. This shared filename keeps
 * the public `project.worker` alias and the seeded repo template pointed at
 * the same module.
 */
const PROJECT_WORKER_ENTRY_POINT = "worker.ts";

/**
 * Default masks for the default project worker's repo file source: build from
 * the whole repo, minus version control and generated/installed output. The
 * bundler only pulls modules reachable from the entry point, so a broad
 * include keeps user-added helper files importable without ref changes.
 */
const PROJECT_WORKER_SOURCE_EXCLUDE = [".git/**", "node_modules/**", "dist/**", "build/**"];

/**
 * THE canonical ref for a project's default worker: the seeded config repo,
 * built from `worker.ts`. Everything that dispatches into "the project
 * worker" — the `project.worker` itx alias, project ingress, and the
 * per-stream event delivery pump — shares this one recipe so they can never
 * point at different workers.
 */
export function defaultProjectWorkerRef(): StatelessDynamicWorkerRef {
  return {
    path: "/",
    source: {
      files: {
        exclude: PROJECT_WORKER_SOURCE_EXCLUDE,
        repoPath: CONFIG_REPO_PATH,
        type: "repo",
      },
      options: { entryPoint: PROJECT_WORKER_ENTRY_POINT },
    },
    type: "stateless",
  };
}

/**
 * The repo stream exists but its git data does not (yet): the Artifacts repo
 * was never created, or was created and awaits its seed commit. Every project
 * bootstrap has this window — the config repo's stream and its dependents
 * (the project worker feed) come alive before the seed lands — so callers
 * must be able to tell "not seeded YET, retry" from a real failure. Matched
 * by NAME because the error crosses Workers RPC (which preserves `error.name`
 * but not class identity).
 */
export class RepoNotSeededError extends Error {
  static readonly NAME = "RepoNotSeededError";
  override readonly name = RepoNotSeededError.NAME;
}

const ARTIFACTS_REPO_NOT_READY_CODES = new Set([
  "NOT_FOUND",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
]);
// The binding exposes both forms; 10200/10302/10303 are the documented
// numericCode values for the three string codes above.
const ARTIFACTS_REPO_NOT_READY_NUMERIC_CODES = new Set([10200, 10302, 10303]);
// Workers RPC can strip ArtifactsError's own code properties. Keep the
// fallback specific to the service's retryable repository-lifecycle wording.
const ARTIFACTS_REPO_NOT_READY_MESSAGE =
  /^Repository "[^"]+" is currently being (?:created|imported|forked)\. The repository is not yet available\. Retry after \d+ seconds\.$/;

function isArtifactsRepoNotReadyError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? error.message : undefined;
  const name = "name" in error ? error.name : undefined;
  const numericCode = "numericCode" in error ? error.numericCode : undefined;
  return (
    (typeof code === "string" && ARTIFACTS_REPO_NOT_READY_CODES.has(code)) ||
    (name === "ArtifactsError" &&
      ((typeof numericCode === "number" &&
        ARTIFACTS_REPO_NOT_READY_NUMERIC_CODES.has(numericCode)) ||
        (typeof message === "string" && ARTIFACTS_REPO_NOT_READY_MESSAGE.test(message))))
  );
}

export function isRepoNotSeededError(error: unknown): boolean {
  return (
    (error as { name?: string } | null)?.name === RepoNotSeededError.NAME ||
    isArtifactsRepoNotReadyError(error)
  );
}

/**
 * Wraps a branch-clone failure as {@link RepoNotSeededError} when it means
 * "the remote has no such ref/commits" — isomorphic-git's NotFoundError for a
 * ref (an empty Artifacts remote answers HEAD with a branch that has no
 * commits, observed as either "Could not find refs/heads/master" or "Could
 * not find main" depending on whether isomorphic-git resolves HEAD or an
 * explicitly requested branch), or the Artifacts repo itself missing or not
 * materialized yet (`NOT_FOUND`, `IMPORT_IN_PROGRESS`, or
 * `FORK_IN_PROGRESS` — created lazily by the bootstrap saga). Anything else
 * returns unchanged.
 */
export function classifyRepoAccessError(error: unknown, branch?: string): unknown {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const missingRequestedBranch =
    branch !== undefined &&
    typeof message === "string" &&
    (message === `Could not find ${branch}.` || message === `Could not find ${branch}`);
  const notSeeded =
    isArtifactsRepoNotReadyError(error) ||
    (code === "NotFoundError" &&
      typeof message === "string" &&
      (message.includes("refs/") || missingRequestedBranch));
  if (!notSeeded) return error;
  return new RepoNotSeededError(
    `Repo has no commits yet (unseeded or still seeding): ${typeof message === "string" ? message : String(error)}`,
    { cause: error },
  );
}

/**
 * Whether `commitOid` is in a branch's ancestry in a complete local clone.
 *
 * @cloudflare/shell's git.log defaults to only 20 commits. Grow the walk until
 * the commit is found or the root is reached so a remote branch that advanced
 * beyond our recorded Artifacts head is accepted, while a stale or force-moved
 * branch is not confused with a descendant merely because the old object still
 * exists in the clone.
 */
export async function gitBranchContainsCommit(input: {
  branch: string;
  commitOid: string;
  git: Git;
}): Promise<boolean> {
  let depth = 32;
  for (;;) {
    const history = await input.git.log({ depth, ref: input.branch });
    if (history.some((commit) => commit.oid === input.commitOid)) return true;
    if (history.length < depth) return false;
    depth *= 2;
  }
}

function normalizeRepoPath(path: string): string {
  if (path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function assertProjectId(projectId: string): void {
  if (projectId.length === 0) throw new Error("Repo artifact projectId must be non-empty.");
  if (projectId === GLOBAL_REPO_ARTIFACT_PROJECT_ID) {
    throw new Error(
      `"${GLOBAL_REPO_ARTIFACT_PROJECT_ID}" is reserved for deployment-wide repo artifacts; use projectId null instead.`,
    );
  }
  if (/[/?#]/.test(projectId)) {
    throw new Error(`Repo artifact projectId contains illegal URL characters: "${projectId}".`);
  }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Standard base64 of raw bytes — the binary lane of `readFile` /
 * `commitFiles`. Not url-safe on purpose: these values travel inside JSON
 * bodies and data: URLs, matching the `files.put` string convention.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of {@link bytesToBase64}; throws a caller-friendly error on junk. */
export function base64ToBytes(base64: string): Uint8Array {
  try {
    return Uint8Array.from(atob(base64.trim()), (char) => char.charCodeAt(0));
  } catch {
    throw new Error("contentBase64 must be valid base64.");
  }
}

/**
 * Encodes repo artifact names for Cloudflare Artifacts.
 *
 * Project-scoped and deployment-wide repos share one Artifact namespace. The
 * codec keeps those two scopes unambiguous and makes repo Durable Object names,
 * tests, and e2e artifact lookups use the same reversible mapping.
 */
export const RepoArtifactNameCodec = {
  stringify({ projectId, path }: RepoArtifactNameParts): string {
    const artifactProjectId = projectId ?? GLOBAL_REPO_ARTIFACT_PROJECT_ID;
    if (projectId !== null) assertProjectId(projectId);
    return `${artifactProjectId}${SEPARATOR}${base64UrlEncode(normalizeRepoPath(path))}`;
  },

  parse(name: string): RepoArtifactNameParts {
    const separatorIndex = name.lastIndexOf(SEPARATOR);
    if (separatorIndex <= 0 || separatorIndex === name.length - SEPARATOR.length) {
      throw new Error(`Repo artifact name must be "{projectId}${SEPARATOR}{path}", got "${name}".`);
    }

    const artifactProjectId = name.slice(0, separatorIndex);
    const projectId =
      artifactProjectId === GLOBAL_REPO_ARTIFACT_PROJECT_ID ? null : artifactProjectId;
    if (projectId !== null) assertProjectId(projectId);

    const path = base64UrlDecode(name.slice(separatorIndex + SEPARATOR.length));
    if (!path.startsWith("/")) {
      throw new Error(`Repo artifact path must start with "/", got "${path}".`);
    }

    return { projectId, path };
  },
} as const;
