// scripts/preview-reuse.ts — WHAT A PR RUN DEPLOYS, AND WHAT IT REUSES, pure. A PR run deploys its
// head (`pr<n>-<sha7>`), and every deployment is named for the commit it was built from, so a head
// whose ancestor has a live deployment can reuse whatever it has not changed since. scripts/preview.ts
// lists the account's deployments and asks GitHub how far back each one's commit is and what
// changed since; this module picks the plan (envs.ts `PreviewPlan`); preview-reuse.test.ts is its
// table.
//   1. The candidates: every FULL deployment (apps/os and every app its own workers,
//      `isFullDeployment`) of the PR's and of main's (Main OS e2e deploys each pushed commit), but
//      the run's own name: a re-run of a commit deploys it again.
//   2. Of those whose commit is an ancestor of the head, the nearest, as a walk back from the head
//      would reach it first. The units the diff from it to the head changes
//      (scripts/ci/preview-units.ts `changedUnits`) are the ones it cannot serve; the machinery
//      changes all of them. A commit that merges main in is a commit like any other, usually one
//      that changes a lot.
//   3. When the nearest's apps/os is unchanged, the run reuses it: it deploys only the apps it
//      changed, as a PARTIAL deployment linked to that one's apps/os and other apps. Otherwise, or
//      with no candidate, it deploys a full one, as every run did before.
// A partial deployment is never a candidate, so what a plan reuses is always a full deployment with
// no plan of its own behind it. Only PR runs reuse: main, the latency guard, the real-model suite and
// a soak each measure a deployment of their own.
import type { PreviewPlan } from "../../../envs.ts";
import type { PreviewUnit } from "../../../scripts/ci/preview-units.ts";
import type { PreviewDeploymentListing } from "./preview-sweep.ts";

/** Whether `deployment` has apps/os and each of `apps` as its own workers: one a run may reuse. */
function isFullDeployment(deployment: PreviewDeploymentListing, apps: string[]) {
  const workers = new Set(
    deployment.members.filter(({ kind }) => kind === "worker").map(({ name }) => name),
  );
  return ["os", ...apps].every((member) => workers.has(`${deployment.name}-${member}`));
}

/** Rule 1: the deployments the run's `deployment` may reuse, for preview.ts to place in the head's
 *  history. */
export function reuseCandidates(
  deployments: PreviewDeploymentListing[],
  deployment: string,
  prefix: string,
  apps: string[],
) {
  return deployments.filter(
    (candidate) =>
      [prefix, "main"].includes(candidate.prefix) &&
      candidate.name !== deployment &&
      isFullDeployment(candidate, apps),
  );
}

/** A candidate placed in the head's history: how many commits back its commit is and the units the
 *  head changes since, or why it is not placed (not an ancestor, a diff GitHub cannot list). */
export type ReuseCandidate =
  | { name: string; commitsBack: number; changed: PreviewUnit[] }
  | { name: string; commitsBack: undefined; unplaced: string };

/** Rules 2 and 3: the run's plan, and one line per candidate saying why it was or was not reused. */
export function planReuse(input: {
  deployment: string;
  apps: string[];
  candidates: ReuseCandidate[];
}): { plan: PreviewPlan; reasons: string[] } {
  const full: PreviewPlan = {
    deployment: input.deployment,
    reuses: undefined,
    deploys: ["os", ...input.apps],
  };
  const reasons = input.candidates.flatMap((candidate) =>
    candidate.commitsBack === undefined ? [`${candidate.name}: ${candidate.unplaced}`] : [],
  );
  const nearest = input.candidates
    .flatMap((candidate) => (candidate.commitsBack === undefined ? [] : [candidate]))
    .toSorted((a, b) => a.commitsBack - b.commitsBack)[0];
  if (!nearest) {
    reasons.push(`no ancestor has a full deployment: ${input.deployment} deploys everything`);
    return { plan: full, reasons };
  }
  const where = `${nearest.name}, ${nearest.commitsBack} commit(s) back`;
  if (nearest.changed.includes("os")) {
    reasons.push(`${where}: apps/os changed since, so ${input.deployment} deploys everything`);
    return { plan: full, reasons };
  }
  const changed: string[] = nearest.changed;
  const deploys = input.apps.filter((app) => changed.includes(app));
  reasons.push(
    `${where}: reused; ${deploys.length > 0 ? `${deploys.join(", ")} changed since, deployed as ${input.deployment}` : "nothing it serves changed since"}`,
  );
  return { plan: { deployment: input.deployment, reuses: nearest.name, deploys }, reasons };
}
