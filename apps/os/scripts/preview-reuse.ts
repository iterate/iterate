// scripts/preview-reuse.ts — WHAT A PR RUN DEPLOYS, AND WHAT IT REUSES, pure. scripts/preview.ts
// lists the account's deployments and diffs each candidate's tested commit against the run's; this
// module picks the plan (envs.ts `PreviewPlan`); preview-reuse.test.ts is its table.
//
// A pull request's run reuses what its commit has not changed since an earlier deployment made it:
//   1. The candidates, in order: the PR's own newest FULL deployment (apps/os and every app its own
//      workers, `isFullDeployment`), then main's newest full one (Main OS e2e's, one per pushed
//      commit). Never the run's own name: a re-run of a commit deploys it again, as before.
//   2. A candidate's tested commit is the sha7 its name ends in. The units the diff from it to the
//      run's commit changes (scripts/ci/preview-units.ts `changedUnits`) are the ones it cannot
//      serve; the machinery changes all of them.
//   3. The first candidate whose apps/os is unchanged is reused: the run deploys only the apps it
//      changed, as a PARTIAL deployment linked to that candidate's apps/os and other apps. None: the
//      run deploys a full one, as every run did before.
// A partial deployment is never a candidate, so what a plan reuses is always a full deployment with
// no plan of its own behind it. Only PR runs reuse: main, the latency guard, the real-model suite and
// a soak each measure a deployment of their own.
import { previewDeployment, type PreviewPlan } from "../../../envs.ts";
import type { PreviewUnit } from "../../../scripts/ci/preview-units.ts";
import type { PreviewDeploymentListing } from "./preview-sweep.ts";

/** Whether `deployment` has apps/os and each of `apps` as its own workers: one a run may reuse. */
function isFullDeployment(deployment: PreviewDeploymentListing, apps: string[]) {
  const workers = new Set(
    deployment.members.filter(({ kind }) => kind === "worker").map(({ name }) => name),
  );
  return ["os", ...apps].every((member) => workers.has(`${deployment.name}-${member}`));
}

/** Rule 1: the full deployments the run's `deployment` may reuse, in the order it tries them. */
export function reuseCandidates(
  deployments: PreviewDeploymentListing[],
  deployment: string,
  apps: string[],
) {
  const newestFull = (prefix: string) =>
    deployments
      .filter(
        (candidate) =>
          candidate.prefix === prefix &&
          candidate.name !== deployment &&
          candidate.newestCreatedAt &&
          isFullDeployment(candidate, apps),
      )
      .toSorted((a, b) => Date.parse(b.newestCreatedAt!) - Date.parse(a.newestCreatedAt!))[0];
  const { prefix } = previewDeployment(deployment)!;
  return [newestFull(prefix), newestFull("main")].filter((candidate) => !!candidate);
}

/** A candidate and the units the run's commit changes since its tested commit, or why they are not
 *  known (its commit could not be resolved or fetched). */
export type ReuseCandidate =
  | { name: string; changed: PreviewUnit[] }
  | { name: string; changed: undefined; unknown: string };

/** Rules 2 and 3: the run's plan, and one line per candidate saying why it was or was not reused. */
export function planReuse(input: {
  deployment: string;
  apps: string[];
  candidates: ReuseCandidate[];
}): { plan: PreviewPlan; reasons: string[] } {
  const reasons: string[] = [];
  for (const candidate of input.candidates) {
    if (!candidate.changed) {
      reasons.push(`${candidate.name}: not reused, ${candidate.unknown}`);
      continue;
    }
    if (candidate.changed.includes("os")) {
      reasons.push(`${candidate.name}: not reused, this commit changes apps/os since`);
      continue;
    }
    const changed: string[] = candidate.changed;
    const deploys = input.apps.filter((app) => changed.includes(app));
    reasons.push(
      `${candidate.name}: reused; ${deploys.length > 0 ? `this commit changes ${deploys.join(", ")} since, deployed as ${input.deployment}` : "this commit changes nothing it serves since"}`,
    );
    return { plan: { deployment: input.deployment, reuses: candidate.name, deploys }, reasons };
  }
  reasons.push(`nothing to reuse: ${input.deployment} deploys apps/os and every app`);
  return {
    plan: { deployment: input.deployment, reuses: undefined, deploys: ["os", ...input.apps] },
    reasons,
  };
}
