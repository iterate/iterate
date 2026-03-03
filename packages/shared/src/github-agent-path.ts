type RepoLike = {
  owner: string;
  name: string;
};

export function toPathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

export function buildDefaultGitHubPrAgentPath(repo: RepoLike, prNumber: number): string {
  return `/github/${toPathSegment(repo.owner)}/${toPathSegment(repo.name)}/pr-${prNumber}`;
}

export function normalizeAgentPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return null;
  if (/\s/.test(trimmed)) return null;
  if (!/^\/[a-zA-Z0-9._~/-]+$/.test(trimmed)) return null;
  const segments = trimmed.split("/").slice(1);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return trimmed;
}
