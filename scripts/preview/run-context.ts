import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { makeDefaultWorkflowRunUrl, type PullRequestPreviewContext } from "./github.ts";
import { CloudflarePreviewState } from "./state.ts";

/** The shared runner knows its revision, lease holder and report destination. */
export type PreviewRunContext = {
  githubToken: string;
  repositoryFullName: string;
  workflowRunUrl: string | null;
  headSha: string;
  branch: string;
  holder: string;
  pullRequest: PullRequestPreviewContext | null;
  readState: () => Promise<{ state: CloudflarePreviewState }>;
  updateState: (
    update: (state: CloudflarePreviewState) => CloudflarePreviewState,
  ) => Promise<{ state: CloudflarePreviewState }>;
};

export function createMainRunContext(input: {
  commit: string;
  githubToken: string;
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
}): PreviewRunContext {
  const headSha = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(input.commit);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: input.repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("rev-parse", "HEAD") !== headSha) {
    throw new Error(
      "--commit must be the exact checked-out commit; refusing to mislabel a deployment.",
    );
  }
  if (git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error(
      "Main preview has uncommitted changes; commit them before deploying a pinned revision.",
    );
  }
  // Dispatching this workflow on a feature branch is useful for validation,
  // but those results must never replace the dashboard's main baseline.
  const branch =
    input.environment.GITHUB_HEAD_REF ||
    input.environment.GITHUB_REF_NAME ||
    git("branch", "--show-current");
  if (!branch) throw new Error("Main preview needs a branch name for result provenance.");
  let state = CloudflarePreviewState.parse({});
  return {
    githubToken: input.githubToken,
    repositoryFullName: input.environment.GITHUB_REPOSITORY || "iterate/iterate",
    workflowRunUrl: makeDefaultWorkflowRunUrl(input.environment) || null,
    headSha,
    branch,
    holder: "main-preview",
    pullRequest: null,
    readState: async () => ({ state }),
    updateState: async (update) => {
      state = CloudflarePreviewState.parse(update(state));
      const directory = join(input.repositoryRoot, "test-results");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "main-preview-state.json"),
        JSON.stringify({ headSha, branch, state }, null, 2),
      );
      return { state };
    },
  };
}
