/**
 * Pure helpers for the GitHub panel's history-resolution mini-flow: detect
 * non-fast-forward rejections from push/sync, and build the agent prompt that
 * merges divergent histories in a sandbox.
 */

/** True when a push/sync failure is the non-fast-forward / diverged case the
 * resolution UI handles — not auth, network, or empty-repo failures. */
export function isGithubHistoryConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("non-fast-forward") ||
    lower.includes("is not a fast-forward") ||
    lower.includes("not a fast-forward") ||
    lower.includes('"diverged"') ||
    lower.includes('"behind"') ||
    lower.includes('"unrelated"') ||
    lower.includes("diverged") ||
    lower.includes("unrelated")
  );
}

export type GithubHistoryResolutionChoice = "pull" | "push" | "agent";

export const GITHUB_HISTORY_RESOLUTION_OPTIONS: ReadonlyArray<{
  value: GithubHistoryResolutionChoice;
  label: string;
  description: string;
  /** Default selection when histories diverge after a connect/sync. */
  default?: boolean;
}> = [
  {
    value: "pull",
    label: "Use GitHub's version",
    description: "Replace this project's history with GitHub's main (force pull).",
    default: true,
  },
  {
    value: "push",
    label: "Force push to GitHub",
    description: "Overwrite GitHub's main with this project's history.",
  },
  {
    value: "agent",
    label: "Ask an agent to merge",
    description: "Open an agent that merges both sides in a sandbox, then updates the project.",
  },
];

/** One-shot merge agent path under `/agents/web/…`. Segments are lowercase —
 * project agent stream routes parse `_splat` with StreamPath, which rejects
 * uppercase (e.g. the `T` in ISO timestamps). */
export function githubHistoryMergeAgentPath(repoPath: string): string {
  const repoSlug =
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
  return `/agents/web/github-merge-${repoSlug}-${stamp}`;
}

/** First message for the merge agent: enough context to pull both sides into a
 * sandbox, merge, and land the result on the project repo's main. */
export function githubHistoryMergeAgentInstructions(input: {
  owner: string;
  repo: string;
  repoPath: string;
}): string {
  return [
    `The project repo at ${input.repoPath} is linked to GitHub ${input.owner}/${input.repo}, but the histories have diverged (non-fast-forward).`,
    "Your job: merge both sides carefully and leave the project on a single coherent main that also mirrors back to GitHub.",
    "",
    "Suggested approach:",
    "1. Inspect both sides: read files and recent log on `itx.repos.get(" +
      JSON.stringify(input.repoPath) +
      ")`, and inspect GitHub via `itx.integrations.github.get(...).octokit` if needed.",
    "2. Create a sandbox (`itx.sandboxes.create`) and clone or materialize both histories there so you can run real git merge tooling.",
    "3. Resolve conflicts intentionally — keep the meaningful config/product changes from both sides; do not blindly discard either history.",
    "4. Commit the merged tree to the project repo with `commitFiles` (or equivalent), then `pushToGithub()` so the mirror is current.",
    "5. Summarize what you merged and any choices you made.",
    "",
    "Do not force-push to GitHub unless the user explicitly asks after you present options. Prefer a merge commit (or clean integrated tree) on the project side, then a normal mirror push.",
  ].join("\n");
}
