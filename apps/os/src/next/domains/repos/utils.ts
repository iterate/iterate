type RepoArtifactNameParts = {
  projectId: string | null;
  path: string;
};

const SEPARATOR = "--";
const GLOBAL_REPO_ARTIFACT_PROJECT_ID = "global";

/**
 * The project repo intentionally lives at the project stream root. Keeping the
 * path here lets project creation, project processors, and worker refs share the
 * same default repo address instead of each baking in their own `"/"` literal.
 */
export const PROJECT_REPO_PATH = "/";

/**
 * Minimal ITX currently uses one default repo-backed worker source. This shared
 * filename keeps the public `project.worker` alias and the seeded repo template
 * pointed at the same module while the broader repo/workers model is still
 * being proven.
 */
export const PROJECT_WORKER_SOURCE_PATH = "worker.js";

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
