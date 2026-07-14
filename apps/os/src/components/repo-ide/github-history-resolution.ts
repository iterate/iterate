/**
 * Pure helpers for the GitHub panel's history-resolution mini-flow: detect
 * non-fast-forward rejections from push/sync, and build the agent prompt that
 * merges divergent histories in a sandbox.
 */

/**
 * Shallow window for force-pull from the UI. Full history clones can exceed
 * the DO isolate's memory (a ~21MB pack can inflate past 128MB); GitHub keeps
 * the full history so a later deeper sync can always widen the window.
 */
export const GITHUB_UI_FORCE_PULL_DEPTH = 50;

/** True when a push/sync failure is the non-fast-forward / diverged case the
 * resolution UI handles — not auth, network, or empty-repo failures. */
export function isGithubHistoryConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  // Canonical backend messages + isomorphic-git's own PushRejectedError text
  // (thrown before RepoDurableObject wraps pushed.ok rejections). Keep this
  // tight: loose substrings like bare "unrelated" false-positive on auth noise.
  return (
    lower.includes("non-fast-forward") ||
    lower.includes("not a simple fast-forward") ||
    lower.includes("not a fast-forward") ||
    lower.includes("push rejected") ||
    lower.includes("syncfromgithub is not a fast-forward") ||
    // GitHub compare statuses quoted in syncFromGithub's error.
    lower.includes('github says "diverged"') ||
    lower.includes('github says "behind"') ||
    lower.includes('github says "unrelated"')
  );
}

export type GithubHistoryResolutionChoice = "pull" | "push" | "agent";

export const GITHUB_HISTORY_RESOLUTION_OPTIONS: ReadonlyArray<{
  value: GithubHistoryResolutionChoice;
  label: string;
  description: string;
}> = [
  {
    value: "pull",
    label: "Use GitHub's version",
    description: "Replace this project's history with GitHub's main (force pull).",
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
    "Suggested approach (this sequence converges; do not invent a different push order):",
    "1. Inspect both sides: read files and recent log on `itx.repos.get(" +
      JSON.stringify(input.repoPath) +
      ")`, and inspect GitHub via `itx.integrations.github.get(...).octokit` if needed.",
    "2. Create a sandbox (`itx.sandboxes.create`) and materialize BOTH trees there so you can merge with real git tooling.",
    "3. Produce the integrated file tree (resolve conflicts intentionally — keep meaningful changes from both sides).",
    "4. Land it on the project with a publishable sequence:",
    "   a. Snapshot the merged tree (paths + contents) from the sandbox.",
    "   b. `await itx.repos.get(" +
      JSON.stringify(input.repoPath) +
      ").syncFromGithub({ force: true, depth: " +
      String(GITHUB_UI_FORCE_PULL_DEPTH) +
      " })` so the project head is an ancestor of (or equal to) GitHub's main.",
    "   c. `commitFiles` the merged tree on top of that head.",
    "   d. `pushToGithub()` — now a normal fast-forward mirror push.",
    "5. Summarize what you merged and any choices you made.",
    "",
    "Avoid force-pushing to GitHub unless the user explicitly asks after you present options. Prefer step 4's force-pull-then-commit so the mirror stays a normal fast-forward.",
  ].join("\n");
}
