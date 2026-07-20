export type GithubArtifactImportRecord = { artifactId: string | null; sourceUrl: string };

export function isGithubArtifactImportRecord(value: unknown): value is GithubArtifactImportRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.artifactId === null || typeof record.artifactId === "string") &&
    typeof record.sourceUrl === "string"
  );
}

export function publicGithubRemoteUrl(owner: string, repo: string): string {
  const cleanOwner = owner.trim();
  const cleanRepo = repo.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(cleanOwner) || !/^[A-Za-z0-9_.-]+$/.test(cleanRepo)) {
    throw new Error("GitHub owner and repo must contain only URL-safe repository characters.");
  }
  return `https://github.com/${cleanOwner}/${cleanRepo}.git`;
}

export function artifactSourceMatchesGithub(
  source: string | null,
  owner: string,
  repo: string,
): boolean {
  if (source === null) return false;
  const expectedPath = `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
  const normalized = source.toLowerCase().replace(/\.git$/, "");
  return (
    normalized === `github:${expectedPath}` || normalized.endsWith(`github.com/${expectedPath}`)
  );
}

export async function importPublicGithubSnapshotToArtifact(input: {
  artifacts: Artifacts;
  name: string;
  owner: string;
  prior: unknown;
  repo: string;
  save: (record: GithubArtifactImportRecord) => void;
}): Promise<{ imported: true }> {
  const sourceUrl = publicGithubRemoteUrl(input.owner, input.repo);
  const requested = { artifactId: null as string | null, sourceUrl };

  if (isGithubArtifactImportRecord(input.prior)) {
    if (input.prior.sourceUrl !== sourceUrl) {
      throw new Error(
        `Repo Artifact import is already claimed by ${input.prior.sourceUrl}; refusing to adopt ${sourceUrl}.`,
      );
    }
    requested.artifactId = input.prior.artifactId;
  } else {
    try {
      await input.artifacts.get(input.name);
      throw new Error(
        `Repo Artifact "${input.name}" already exists without a matching GitHub import claim.`,
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
    }
    // Intent precedes the external create. If the RPC response is lost,
    // ALREADY_EXISTS on retry is recoverable only through this claim.
    input.save(requested);
  }

  try {
    const imported = await input.artifacts.import({
      source: { branch: "main", depth: 1, url: sourceUrl },
      target: { name: input.name },
    });
    requested.artifactId = imported.id;
    input.save(requested);
  } catch (error) {
    if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
    const existing = await input.artifacts.get(input.name);
    if (requested.artifactId !== null && existing.id !== requested.artifactId) {
      throw new Error(
        `Repo Artifact import identity changed from ${requested.artifactId} to ${existing.id}; refusing to adopt it.`,
      );
    }
    if (!artifactSourceMatchesGithub(existing.source, input.owner, input.repo)) {
      throw new Error(
        `Repo Artifact "${input.name}" exists, but its source does not match ${sourceUrl}.`,
      );
    }
    requested.artifactId = existing.id;
    input.save(requested);
  }

  return { imported: true };
}
