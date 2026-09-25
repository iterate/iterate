// scripts/preview-sweep.ts — THE SWEEP'S RULES, pure: which previews of the parent are stale, and
// which per-preview resources outlived their preview. scripts/preview.ts lists, looks up and
// deletes; this module decides; preview-sweep.test.ts is its table.
//
// A preview is STALE (deletePreview takes it and everything it owns) when
//   1. its last deploy is more than 7 days old, whatever its name;
//   2. it is named `pr<n>` and pull request #n is closed or does not exist;
//   3. it names no pull request (a branch, or a hand-picked name like `exp-…` or `soak`), its last
//      deploy is more than 24 h old, no open pull request's head branch slugifies to its name, and it
//      is no CI workflow's own (CI_WORKFLOW_PREVIEWS: `main`, `latency`, `real-model`). A quiet day
//      is no reason to make a workflow's next preview brand-new; rule 1 takes the preview of a
//      workflow that stopped.
// Anything else is kept. A GitHub lookup that failed never makes a preview stale: a PR state of
// "unknown", or no open-branch list, leaves rule 1 alone.
//
// A resource is an ORPHAN (deleted on its own) when all of these hold:
//   4. its name is `<parent>-<preview>-<suffix>` with a suffix of its kind (previewResourceSuffixes:
//      KV `itx-kv`, `oauth-kv`; R2 `files`; D1 `db`; Artifacts `repos`) and `<preview>` a name a
//      preview can have (lowercase letters and digits in hyphen-separated words, at most 28
//      characters). Nothing else ever is: not one the account has for something else
//      (preview-config.ts accountResourceNames: the parent's own `os-parent-files` and
//      `os-parent-db`, local dev's `os-dev-repos`), not `IterateDataResources-…`, not another worker's whose name begins
//      `<parent>-` (the former parent `os-preview`'s `os-preview-files`);
//   5. no listed preview, stale or kept, owns that exact name. The caller lists the previews AFTER
//      the resources: wrangler creates a preview before it provisions the preview's KV and R2, so a
//      first deploy in flight always shows its preview;
//   6. for a D1 or an Artifacts namespace, also: its pull request is closed or missing, or it was
//      created more than 24 h ago. The deploy creates these two BEFORE the preview exists;
//   7. it was not created before the parent worker was: a preview's resources come from a deploy
//      of that preview, which the parent's existence precedes. The legacy platform's preview slots
//      left `os-preview-<n>-repos` namespaces (2026-05 and 2026-07, tens of thousands of repos each)
//      whose names read as previews `1`…`18` of the then parent `os-preview`; they are older than
//      it, and no preview of it owns them. A resource with no creation stamp (KV) is judged on 4–6
//      alone.
//      When the parent's creation time is unknown (the scripts listing does not name it) or a stamp
//      does not parse, every stamped resource is kept: a failed lookup never deletes.
// scripts/preview.ts looks each orphan's preview up once more right before deleting it.
import {
  MAX_PREVIEW_NAME_LENGTH,
  PREVIEW_PARENT,
  previewNameOfResource,
  previewPullRequestNumber,
  previewResourceName,
  slugifyPreviewName,
  type PreviewResourceKind,
} from "./preview-config.ts";

/** What GitHub said about a pull request: "unknown" when the lookup failed. */
export type PullRequestState = "open" | "closed" | "missing" | "unknown";

/** One preview of the parent, from the Worker Previews listing (`deployed_on`). */
export type SweptPreview = { name: string; lastDeployedAt?: string };

/** THE CI WORKFLOWS' OWN PREVIEWS, by name: one per serialized workflow of main, redeployed in place
 *  by every run of it and deleted by none — Main OS e2e's `main` (.depot/workflows/main-os-e2e.yml),
 *  the latency guard's `latency` (os-latency.yml) and the real-model suite's `real-model`
 *  (os-real-model.yml), each deploy's readiness gate held past the window its previous version still
 *  answers in (docs/depot-ci.md#main-os-e2e-keeps-one-preview). */
export const CI_WORKFLOW_PREVIEWS: ReadonlySet<string> = new Set(["main", "latency", "real-model"]);

/** One row of an account listing: a KV namespace (id + title), an R2 bucket (id = name), a D1
 *  (uuid + name), an Artifacts namespace (id = name). `createdAt` where the listing has one. */
export type SweptResource = {
  kind: PreviewResourceKind;
  name: string;
  id: string;
  createdAt?: string;
};

export type PreviewSweepInput = {
  now: number;
  /** Every worker script on the account (rule 4: another worker whose name begins `<parent>-`). */
  workerNames: string[];
  /** The resources the account has for something other than a preview (rule 4;
   *  preview-config.ts accountResourceNames). */
  accountResourceNames: Set<string>;
  /** When the parent worker was created (the scripts listing's `created_on`; rule 7), or undefined
   *  when the listing does not name it, which keeps every resource that has a creation stamp. */
  parentCreatedAt: string | undefined;
  resourceSuffixes: Record<PreviewResourceKind, string[]>;
  previews: SweptPreview[];
  resources: SweptResource[];
  /** By PR number; a number missing here is "unknown". */
  pullRequestStates: ReadonlyMap<number, PullRequestState>;
  /** Every open pull request's head branch, or undefined when GitHub could not list them. */
  openPullRequestBranches: string[] | undefined;
};

export type PreviewSweepPlan = {
  previews: { name: string; verdict: "stale" | "keep"; reason: string }[];
  orphans: (SweptResource & { previewName: string; reason: string })[];
};

/** Rule 4: the preview a resource belongs to, or undefined for any resource that is not a
 *  preview's. */
export function previewNameOfSweptResource(
  resource: SweptResource,
  input: Pick<PreviewSweepInput, "workerNames" | "accountResourceNames" | "resourceSuffixes">,
) {
  if (input.accountResourceNames.has(resource.name)) return undefined;
  const parent = PREVIEW_PARENT.workerName;
  const ownedByAnotherWorker = input.workerNames.some(
    (workerName) =>
      workerName.startsWith(`${parent}-`) && resource.name.startsWith(`${workerName}-`),
  );
  if (ownedByAnotherWorker) return undefined;
  for (const suffix of input.resourceSuffixes[resource.kind]) {
    const previewName = previewNameOfResource(resource.name, suffix);
    if (
      previewName &&
      previewName.length <= MAX_PREVIEW_NAME_LENGTH &&
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(previewName)
    )
      return previewName;
  }
  return undefined;
}

export function planPreviewSweep(input: PreviewSweepInput): PreviewSweepPlan {
  const hoursSince = (stamp: string | undefined) =>
    stamp ? (input.now - Date.parse(stamp)) / 3_600_000 : NaN;
  const pullRequestState = (previewName: string) => {
    const number = previewPullRequestNumber(previewName);
    if (number === undefined) return undefined;
    return { number, state: input.pullRequestStates.get(number) || "unknown" };
  };

  const previews = input.previews.map(({ name, lastDeployedAt }) => {
    const hours = hoursSince(lastDeployedAt);
    const deployed = Number.isNaN(hours)
      ? "last deploy unknown"
      : `last deployed ${hours.toFixed(1)} h ago`;
    const pullRequest = pullRequestState(name);
    const stale = (reason: string) => ({ name, verdict: "stale" as const, reason });
    const keep = (reason: string) => ({ name, verdict: "keep" as const, reason });
    if (hours > 7 * 24) return stale(`${deployed}, more than 7 days`); // rule 1
    if (CI_WORKFLOW_PREVIEWS.has(name)) return keep(`a CI workflow's own, ${deployed}`);
    if (pullRequest?.state === "closed") return stale(`PR #${pullRequest.number} is closed`); // rule 2
    if (pullRequest?.state === "missing") return stale(`PR #${pullRequest.number} does not exist`);
    if (pullRequest) return keep(`PR #${pullRequest.number} is ${pullRequest.state}, ${deployed}`);
    if (!input.openPullRequestBranches) return keep(`open branches unknown, ${deployed}`);
    const openBranch = input.openPullRequestBranches.find(
      (branch) => slugifyPreviewName(branch) === name,
    );
    if (openBranch) return keep(`open PR branch ${openBranch}, ${deployed}`);
    if (hours > 24) return stale(`no PR and no open branch of that name, ${deployed}`); // rule 3
    return keep(`no PR, ${deployed}`);
  });

  // Rule 5: every name a listed preview owns, by any suffix of any kind.
  const allSuffixes = Object.values(input.resourceSuffixes).flat();
  const listedPreviewResourceNames = new Set(
    input.previews.flatMap(({ name }) =>
      allSuffixes.map((suffix) => previewResourceName(name, suffix)),
    ),
  );
  const orphans: PreviewSweepPlan["orphans"] = [];
  for (const resource of input.resources) {
    if (listedPreviewResourceNames.has(resource.name)) continue;
    const previewName = previewNameOfSweptResource(resource, input);
    if (!previewName) continue;
    // rule 7: a stamped resource goes on only when it provably postdates the parent (NaN, from an
    // unknown parent or a stamp that does not parse, compares false and keeps it)
    if (
      resource.createdAt &&
      !(hoursSince(resource.createdAt) <= hoursSince(input.parentCreatedAt))
    )
      continue;
    let reason = `preview ${previewName} does not exist`;
    if (resource.kind === "d1" || resource.kind === "artifacts") {
      // rule 6
      const pullRequest = pullRequestState(previewName);
      const hours = hoursSince(resource.createdAt);
      if (pullRequest?.state === "closed" || pullRequest?.state === "missing")
        reason += `, PR #${pullRequest.number} is ${pullRequest.state}`;
      else if (hours > 24) reason += `, created ${hours.toFixed(1)} h ago`;
      else continue;
    }
    orphans.push({ ...resource, previewName, reason });
  }
  return { previews, orphans };
}
