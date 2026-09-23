// scripts/preview-sweep.ts — THE SWEEP'S RULES, pure: which previews of the parent are stale, and
// which per-preview resources outlived their preview. scripts/preview.ts lists, looks up and
// deletes; this module decides; preview-sweep.test.ts is its table.
//
// A preview is STALE (deletePreview takes it and everything it owns) when
//   1. its last deploy is more than 7 days old, whatever its name;
//   2. it is named `pr<n>-…` and pull request #n is closed or does not exist;
//   3. it names no pull request (a branch, or a hand-picked name like `exp-…` or `soak`), its last
//      deploy is more than 24 h old, and no open pull request's head branch slugifies to its name.
// Anything else is kept. A GitHub lookup that failed never makes a preview stale: a PR state of
// "unknown", or no open-branch list, leaves rule 1 alone.
//
// A resource is an ORPHAN (deleted on its own) when all of these hold:
//   4. its name is `<parent>-<preview>-<suffix>` with a suffix of its kind (previewResourceSuffixes:
//      KV `itx-kv`, `oauth-kv`; R2 `files`; D1 `db`; Artifacts `repos`) and `<preview>` a name a
//      preview can have (lowercase letters and digits in hyphen-separated words, at most 28
//      characters). Nothing else ever is: not the parent's own (`os-next-preview-files`), not the
//      legacy slots' (`os-preview-3-files`, `IterateDataResources-…`), not another worker's whose
//      name begins `<parent>-` (a former `os-next-preview-2`'s `os-next-preview-2-files`);
//   5. no listed preview, stale or kept, owns that exact name. The caller lists the previews AFTER
//      the resources: wrangler creates a preview before it provisions the preview's KV and R2, so a
//      first deploy in flight always shows its preview;
//   6. for a D1 or an Artifacts namespace, also: its pull request is closed or missing, or it was
//      created more than 24 h ago. The deploy creates these two BEFORE the preview exists.
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
  input: Pick<PreviewSweepInput, "workerNames" | "resourceSuffixes">,
): string | undefined {
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

/** Main's throwaway previews (.depot/workflows/main-os-e2e.yml names each `main-<short sha>`) that
 *  are not `current`: a superseded run's. Depot's cancel-in-progress cancels a superseded run's
 *  queued jobs, its `always()` delete included (observed 2026-09-23 on main-44db0e6), so each run
 *  deletes these before it deploys; the nightly sweep's rule 3 is the backstop. Pure. */
export function supersededMainPreviews(previewNames: string[], current: string): string[] {
  return previewNames.filter((name) => /^main-[0-9a-f]{7}$/.test(name) && name !== current);
}
