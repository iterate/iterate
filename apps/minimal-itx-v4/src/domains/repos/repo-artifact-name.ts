type RepoArtifactNameParts = {
  projectId: string;
  path: string;
};

const SEPARATOR = "--";

function normalizeRepoPath(path: string): string {
  if (path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function assertProjectId(projectId: string): void {
  if (projectId.length === 0) throw new Error("Repo artifact projectId must be non-empty.");
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

export const RepoArtifactNameCodec = {
  stringify({ projectId, path }: RepoArtifactNameParts): string {
    assertProjectId(projectId);
    return `${projectId}${SEPARATOR}${base64UrlEncode(normalizeRepoPath(path))}`;
  },

  parse(name: string): RepoArtifactNameParts {
    const separatorIndex = name.lastIndexOf(SEPARATOR);
    if (separatorIndex <= 0 || separatorIndex === name.length - SEPARATOR.length) {
      throw new Error(`Repo artifact name must be "{projectId}${SEPARATOR}{path}", got "${name}".`);
    }

    const projectId = name.slice(0, separatorIndex);
    assertProjectId(projectId);

    const path = base64UrlDecode(name.slice(separatorIndex + SEPARATOR.length));
    if (!path.startsWith("/")) {
      throw new Error(`Repo artifact path must start with "/", got "${path}".`);
    }

    return { projectId, path };
  },
} as const;
