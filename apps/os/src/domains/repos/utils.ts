import type { StatelessDynamicWorkerRef } from "../workers/schemas.ts";

type RepoArtifactNameParts = {
  projectId: string | null;
  path: string;
};

const SEPARATOR = "--";
const GLOBAL_REPO_ARTIFACT_PROJECT_ID = "global";

/**
 * The project's config repo — an ordinary repo at an ordinary `/repos/*`
 * path, seeded during project bootstrap and the source the default project
 * worker builds from. Keeping the path here lets project creation, project
 * processors, and worker refs share the same address instead of each baking
 * in their own literal. Its events reach the project stream `/` through the
 * `cross-post:/` subscription the bootstrap saga arms on this repo's stream.
 */
export const CONFIG_REPO_PATH = "/repos/config";

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
