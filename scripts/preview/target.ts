import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { makeDefaultWorkflowRunUrl } from "./github.ts";
import { CloudflarePreviewState } from "./state.ts";

/** Identity and source repository for one preview execution. */
export type PreviewRun = {
  githubToken: string;
  repositoryFullName: string;
  workflowRunUrl: string | null;
  headSha: string;
  branch: string;
  holder: string;
  /** Reporting metadata only; deployment and lease policy do not depend on it. */
  pullRequestNumber: number | null;
};

/** Inputs shared by preview commands, regardless of where they came from. */
export type PreviewTarget = {
  run: PreviewRun;
  report: PreviewReport;
  /** A null comparison base selects the full fleet. */
  baseSha: string | null;
  requestedEnvironment: string | null;
  /** Seed a review login when humans will use this deployment. */
  reviewProject: string | null;
};

/** State lives in the process; publishing a report never reads older state back. */
export class PreviewReport {
  state: CloudflarePreviewState;
  private publish: (state: CloudflarePreviewState) => Promise<void>;

  constructor(
    state: CloudflarePreviewState,
    publish: (state: CloudflarePreviewState) => Promise<void>,
  ) {
    this.state = state;
    this.publish = publish;
  }

  async update(update: (state: CloudflarePreviewState) => CloudflarePreviewState) {
    this.state = CloudflarePreviewState.parse(update(this.state));
    await this.publish(this.state);
    return this.state;
  }
}

export function createMainPreview(input: {
  commit: string;
  requireCleanCheckout: boolean;
  githubToken: string;
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
}): PreviewTarget {
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
  // Build output must not prevent the later erase/cleanup command from stopping costs.
  if (input.requireCleanCheckout && git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error(
      "Main preview has uncommitted changes; commit them before deploying a pinned revision.",
    );
  }
  // The fixed main holder is serialized by this workflow's concurrency
  // group across all jobs in the called workflow. A local invocation would
  // bypass that lock and could erase CI.
  if (
    !input.environment.DEPOT_JOB_URL ||
    input.environment.GITHUB_WORKFLOW !== "Main Preview (Depot CI)"
  ) {
    throw new Error(
      "Run main previews through the serialized cloudflare-main-preview.yml Depot workflow; use depot ci dispatch instead of invoking preview commands with --commit locally.",
    );
  }
  // Dispatching this workflow on a feature branch is useful for validation,
  // but those results must never replace the dashboard's main baseline.
  const branch =
    input.environment.GITHUB_HEAD_REF ||
    input.environment.GITHUB_REF_NAME ||
    git("branch", "--show-current");
  if (!branch) throw new Error("Main preview needs a branch name for result provenance.");
  const run: PreviewRun = {
    githubToken: input.githubToken,
    repositoryFullName: input.environment.GITHUB_REPOSITORY || "iterate/iterate",
    workflowRunUrl: makeDefaultWorkflowRunUrl(input.environment) || null,
    headSha,
    branch,
    holder: "main-preview",
    pullRequestNumber: null,
  };
  const directory = join(input.repositoryRoot, "test-results");
  const file = join(directory, "main-preview-state.json");
  const identity = {
    headSha,
    branch,
    jobUrl: input.environment.DEPOT_JOB_URL,
    attempt: input.environment.GITHUB_RUN_ATTEMPT || "1",
  };
  const previous = existsSync(file)
    ? z
        .object({
          headSha: z.string(),
          branch: z.string(),
          jobUrl: z.string(),
          attempt: z.string(),
          state: CloudflarePreviewState,
        })
        .parse(JSON.parse(readFileSync(file, "utf8")))
    : null;
  // Commands in one job share state. A new run/attempt starts fresh, even
  // when the baked workspace still contains another run's report.
  const state =
    previous &&
    previous.headSha === headSha &&
    previous.branch === branch &&
    previous.jobUrl === identity.jobUrl &&
    previous.attempt === identity.attempt
      ? previous.state
      : CloudflarePreviewState.parse({});
  const report = new PreviewReport(state, async (state) => {
    await mkdir(directory, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify({ ...identity, state }, null, 2));
    await rename(`${file}.tmp`, file);
  });
  return { run, report, baseSha: null, requestedEnvironment: null, reviewProject: null };
}
