/** Detect non-FF push/sync failures for the GitHub panel resolution UI. */
export function isGithubHistoryConflictError(error: unknown): boolean {
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    m.includes("non-fast-forward") ||
    m.includes("not a simple fast-forward") ||
    m.includes("not a fast-forward") ||
    m.includes("push rejected") ||
    m.includes("syncfromgithub is not a fast-forward") ||
    m.includes('github says "diverged"') ||
    m.includes('github says "behind"') ||
    m.includes('github says "unrelated"')
  );
}

/** Shallow force-pull window so large histories fit the DO isolate. */
export const GITHUB_UI_FORCE_PULL_DEPTH = 50;

export function githubHistoryMergeAgentPath(repoPath: string): string {
  const slug =
    repoPath
      .replace(/^\/repos\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo";
  const stamp = new Date()
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/agents/web/github-merge-${slug}-${stamp}`;
}

export function githubHistoryMergeAgentInstructions(input: {
  owner: string;
  repo: string;
  repoPath: string;
}): string {
  return [
    `${input.repoPath} is linked to ${input.owner}/${input.repo} but histories diverged.`,
    "Merge both sides carefully, then land a single coherent main that mirrors to GitHub.",
    "",
    "1. Inspect both trees (repo log/files + GitHub via itx.integrations.github).",
    "2. Sandbox-merge with real git tooling.",
    "3. Publish: snapshot merged files →",
    `   syncFromGithub({ force: true, depth: ${GITHUB_UI_FORCE_PULL_DEPTH} }) →`,
    "   commitFiles(merged tree) → pushToGithub().",
    "Do not force-push to GitHub unless the user asks.",
  ].join("\n");
}
