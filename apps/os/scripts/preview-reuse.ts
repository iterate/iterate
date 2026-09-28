// scripts/preview-reuse.ts — WHAT A PR RUN DEPLOYS, AND WHAT IT REUSES, pure. A PR run deploys its
// head (`pr<n>-<sha7>`), and every deployment is named for the commit it was built from, so a head
// whose ancestor has a live deployment of the same code can test that one instead of deploying
// again. scripts/preview.ts lists the account's deployments and asks GitHub how far back each one's
// commit is and what changed since; this module picks the plan; preview-reuse.test.ts is its table.
//   1. The candidates: every FULL deployment (apps/os and every app its own workers,
//      `isFullDeployment`) of the PR's and of main's (Main OS e2e deploys each pushed commit), but
//      the run's own name: a re-run of a commit deploys it again.
//   2. Of those whose commit is an ancestor of the head, the nearest, as a walk back from the head
//      would reach it first. A commit that merges main in is a commit like any other, usually one
//      that changes a lot.
//   3. When the head changes no unit since (scripts/ci/preview-units.ts `changedUnits`: only tests,
//      docs and the like), the run deploys nothing and tests that deployment. Otherwise, or with no
//      candidate, it deploys all of itself, as every run did before.
// Only PR runs reuse: main, the latency guard, the real-model suite and a soak each measure a
// deployment of their own.
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

/** WHAT A PR RUN TESTS: its own deployment `deployment`, or, when it `reuses` one, that earlier
 *  deployment, having deployed nothing. */
export type PreviewPlan = { deployment: string; reuses: string | undefined };

/** A candidate placed in the head's history: how many commits back its commit is and the units the
 *  head changes since, or why it is not placed (not an ancestor, a diff GitHub cannot list). */
export type ReuseCandidate =
  | { name: string; commitsBack: number; changed: PreviewUnit[] }
  | { name: string; commitsBack: undefined; unplaced: string };

/** Rules 2 and 3: the run's plan, and one line per candidate saying why it was or was not reused. */
export function planReuse(input: { deployment: string; candidates: ReuseCandidate[] }): {
  plan: PreviewPlan;
  reasons: string[];
} {
  const full: PreviewPlan = { deployment: input.deployment, reuses: undefined };
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
  if (nearest.changed.length > 0) {
    reasons.push(
      `${where}: ${nearest.changed.join(", ")} changed since, so ${input.deployment} deploys everything`,
    );
    return { plan: full, reasons };
  }
  reasons.push(`${where}: reused; nothing it serves changed since, so nothing deploys`);
  return { plan: { deployment: input.deployment, reuses: nearest.name }, reasons };
}
