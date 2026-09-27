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
// A preview of a FORMER PARENT (preview-config.ts FORMER_PARENTS: `os-preview`, `dash-preview`, …)
// is STALE when
//   0. its last deploy is more than 24 h old, whatever its name. No deploy names a former parent, so
//      nothing else ever deletes it; the day is for a checkout that still deploys there. A preview
//      whose last deploy is unknown is kept. The Worker Preview goes, its Durable Object namespaces
//      with it; its KV, R2 and Artifacts namespaces are another worker's to rule 4.
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
//
// Every WORKER on the account is judged too, and only a preview's is ever deleted:
//   8. a PER-COMMIT DEPLOYMENT `<prefix>-<sha7>` (its workers `<name>-os` and `<name>-<app>`, and
//      apps/os's resources `<name>-os-<suffix>`, whichever still exist) goes whole, its workers'
//      Durable Object namespaces with them, when
//        a. its newest member was created more than 7 days ago, whatever its prefix;
//        b. its prefix is `pr<n>` and pull request #n is closed or does not exist;
//        c. it is not its prefix's newest deployment with an apps/os worker, and its newest member
//           is more than an hour old (a later push's, in flight, stays) or has no stamp;
//        d. its prefix names no pull request, is no CI workflow's (CI_WORKFLOW_PREVIEWS), no open
//           pull request's head branch slugifies to it, and its newest member is more than 24 h
//           old.
//      So an open PR's newest deployment, and Main OS e2e's, stay until a week idle, like rule 1.
//   9. a FORMER PARENT with no preview left on it goes: the worker, its Durable Object namespaces
//      with it, and every KV, R2, D1 and Artifacts namespace under its name — its own
//      (`<parent>-itx`, `-oauth`, `-files`, `-db`, `-repos`) and its previews'
//      (`<parent>-<preview>-<suffix>`), but never a legacy slot's (`os-preview-<n>-repos`, a number
//      where the preview's name would be; the legacy platform's, thousands of repos each). One still
//      holding a preview waits for rule 0. Rule 4 never reads a name under a former parent's prefix.
//  10. every other worker stays: envs.ts's deployments on this account (the parents `os` and each
//      app's among them) and any worker envs.ts does not name, which the plan lists for a person to
//      judge. The sweep runs on the dev/preview account alone (PREVIEW_PARENT's; prd is another).
import {
  APPS,
  FORMER_PARENTS,
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

/** One preview of a former parent (rule 0), named with the worker it hangs from. */
export type SweptFormerParentPreview = SweptPreview & { parent: string };

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

/** One worker script on the account, `createdAt` its `created_on`. */
export type SweptWorker = { name: string; createdAt?: string };

/** A per-commit deployment (rule 8): whichever of its workers and resources the account has. */
export type SweptDeployment = {
  name: string;
  prefix: string;
  workers: SweptWorker[];
  resources: SweptResource[];
};

export type PreviewSweepInput = {
  now: number;
  /** Every worker script on the account (rule 4: another worker whose name begins `<parent>-`;
   *  rule 7: when the parent was created, which an unlisted parent leaves unknown and every stamped
   *  resource kept; rules 8–10). */
  workers: SweptWorker[];
  /** envs.ts's workers on this account (rule 10; preview-config.ts accountWorkerNames). */
  deployedWorkerNames: ReadonlySet<string>;
  /** The resources the account has for something other than a preview (rule 4;
   *  preview-config.ts accountResourceNames). */
  accountResourceNames: Set<string>;
  resourceSuffixes: Record<PreviewResourceKind, string[]>;
  previews: SweptPreview[];
  /** Every preview of every former parent (rule 0). */
  formerParentPreviews: SweptFormerParentPreview[];
  resources: SweptResource[];
  /** By PR number; a number missing here is "unknown". */
  pullRequestStates: ReadonlyMap<number, PullRequestState>;
  /** Every open pull request's head branch, or undefined when GitHub could not list them. */
  openPullRequestBranches: string[] | undefined;
};

export type PreviewSweepPlan = {
  previews: { name: string; verdict: "stale" | "keep"; reason: string }[];
  formerParentPreviews: (SweptFormerParentPreview & {
    verdict: "stale" | "keep";
    reason: string;
  })[];
  orphans: (SweptResource & { previewName: string; reason: string })[];
  deployments: (SweptDeployment & { verdict: "stale" | "keep"; reason: string })[];
  /** Every former parent the account still has a worker or a resource of (rule 9). */
  formerParents: {
    name: string;
    worker: boolean;
    resources: SweptResource[];
    verdict: "stale" | "keep";
    reason: string;
  }[];
  /** The workers rule 10 keeps that envs.ts does not name, for a person to judge. */
  unmappedWorkers: string[];
};

/** A name a preview can have: lowercase letters and digits in hyphen-separated words, at most
 *  MAX_PREVIEW_NAME_LENGTH characters. */
const isPreviewName = (name: string) =>
  name.length <= MAX_PREVIEW_NAME_LENGTH && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);

/** `<prefix>-<sha7>`, the prefix a preview name. */
const DEPLOYMENT_NAME = /^(?<prefix>[a-z0-9]+(?:-[a-z0-9]+)*)-[0-9a-f]{7}$/;

/** Rule 8: every per-commit deployment the account's workers and resources make up, by name — a
 *  worker `<name>-os` or `<name>-<app>`, a resource `<name>-os-<suffix>` of its kind. envs.ts's
 *  own workers are never one. */
export function groupPreviewDeployments(
  input: Pick<
    PreviewSweepInput,
    "workers" | "deployedWorkerNames" | "resources" | "resourceSuffixes"
  >,
) {
  const byName = new Map<string, SweptDeployment>();
  const deploymentOf = (memberName: string, suffixes: string[]) => {
    const suffix = suffixes.find((candidate) => memberName.endsWith(`-${candidate}`));
    if (!suffix) return undefined;
    const name = memberName.slice(0, -suffix.length - 1);
    const prefix = DEPLOYMENT_NAME.exec(name)?.groups?.prefix;
    if (!prefix || !isPreviewName(prefix)) return undefined;
    const deployment = byName.get(name) || { name, prefix, workers: [], resources: [] };
    byName.set(name, deployment);
    return deployment;
  };
  const workerSuffixes = ["os", ...APPS.map((app) => app.name)];
  for (const worker of input.workers)
    if (!input.deployedWorkerNames.has(worker.name))
      deploymentOf(worker.name, workerSuffixes)?.workers.push(worker);
  for (const resource of input.resources)
    deploymentOf(
      resource.name,
      input.resourceSuffixes[resource.kind].map((suffix) => `os-${suffix}`),
    )?.resources.push(resource);
  return [...byName.values()];
}

/** An OS deployment's own resources, `<worker>-<suffix>` (preview-config.ts accountResourceNames). */
const OWN_RESOURCE_SUFFIXES = ["oauth", "itx", "files", "db", "repos"];

/** Rule 9: whether a resource is under the former parent's name — its own or one of its
 *  previews' — and not a legacy slot's. */
function isFormerParentResource(
  parent: string,
  resource: SweptResource,
  resourceSuffixes: PreviewSweepInput["resourceSuffixes"],
) {
  if (!resource.name.startsWith(`${parent}-`)) return false;
  const rest = resource.name.slice(parent.length + 1);
  if (OWN_RESOURCE_SUFFIXES.includes(rest)) return true;
  return resourceSuffixes[resource.kind].some((suffix) => {
    const previewName = rest.endsWith(`-${suffix}`) ? rest.slice(0, -suffix.length - 1) : "";
    return isPreviewName(previewName) && !/^\d+$/.test(previewName);
  });
}

/** Rule 4: the preview a resource belongs to, or undefined for any resource that is not a
 *  preview's. */
export function previewNameOfSweptResource(
  resource: SweptResource,
  input: Pick<PreviewSweepInput, "workers" | "accountResourceNames" | "resourceSuffixes">,
) {
  if (input.accountResourceNames.has(resource.name)) return undefined;
  const parent = PREVIEW_PARENT.workerName;
  const ownedByAnotherWorker = [...input.workers.map(({ name }) => name), ...FORMER_PARENTS].some(
    (workerName) =>
      workerName.startsWith(`${parent}-`) && resource.name.startsWith(`${workerName}-`),
  );
  if (ownedByAnotherWorker) return undefined;
  for (const suffix of input.resourceSuffixes[resource.kind]) {
    const previewName = previewNameOfResource(resource.name, suffix);
    if (previewName && isPreviewName(previewName)) return previewName;
  }
  return undefined;
}

export function planPreviewSweep(input: PreviewSweepInput): PreviewSweepPlan {
  const hoursSince = (stamp: string | undefined) =>
    stamp ? (input.now - Date.parse(stamp)) / 3_600_000 : NaN;
  const lastDeploy = (hours: number) =>
    Number.isNaN(hours) ? "last deploy unknown" : `last deployed ${hours.toFixed(1)} h ago`;
  const pullRequestState = (previewName: string) => {
    const number = previewPullRequestNumber(previewName);
    if (number === undefined) return undefined;
    return { number, state: input.pullRequestStates.get(number) || "unknown" };
  };

  const parentCreatedAt = input.workers.find(
    ({ name }) => name === PREVIEW_PARENT.workerName,
  )?.createdAt;

  const previews = input.previews.map(({ name, lastDeployedAt }) => {
    const hours = hoursSince(lastDeployedAt);
    const deployed = lastDeploy(hours);
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

  const formerParentPreviews: PreviewSweepPlan["formerParentPreviews"] =
    input.formerParentPreviews.map((preview) => {
      const hours = hoursSince(preview.lastDeployedAt);
      return {
        ...preview,
        // rule 0: NaN, an unknown last deploy, compares false and keeps it
        verdict: hours > 24 ? "stale" : "keep",
        reason: `former parent ${preview.parent}, ${lastDeploy(hours)}`,
      };
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
    if (resource.createdAt && !(hoursSince(resource.createdAt) <= hoursSince(parentCreatedAt)))
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

  // Rule 8. A deployment's age is its newest member's: one half deployed or half deleted is judged
  // like a whole one.
  const newestStamp = (deployment: SweptDeployment) => {
    // a KV namespace has no stamp; NaN when no member has one
    const stamps = [...deployment.workers, ...deployment.resources]
      .map(({ createdAt }) => Date.parse(createdAt || ""))
      .filter((stamp) => !Number.isNaN(stamp));
    return stamps.length > 0 ? Math.max(...stamps) : NaN;
  };
  const grouped = groupPreviewDeployments(input);
  const newestOfPrefix = new Map<string, SweptDeployment>();
  for (const deployment of grouped) {
    const stamp = newestStamp(deployment);
    const current = newestOfPrefix.get(deployment.prefix);
    const deployed = deployment.workers.some(({ name }) => name === `${deployment.name}-os`);
    // NaN, no stamp, compares false: such a deployment is never its prefix's newest
    if (deployed && stamp > (current ? newestStamp(current) : -Infinity))
      newestOfPrefix.set(deployment.prefix, deployment);
  }
  const deployments = grouped.map((deployment) => {
    const { prefix } = deployment;
    const hours = (input.now - newestStamp(deployment)) / 3_600_000;
    const created = Number.isNaN(hours)
      ? "no member with a creation stamp"
      : `newest member created ${hours.toFixed(1)} h ago`;
    const stale = (reason: string) => ({ ...deployment, verdict: "stale" as const, reason });
    const keep = (reason: string) => ({ ...deployment, verdict: "keep" as const, reason });
    if (hours > 7 * 24) return stale(`${created}, more than 7 days`); // 8a
    const pullRequest = pullRequestState(prefix);
    if (pullRequest?.state === "closed" || pullRequest?.state === "missing")
      return stale(`PR #${pullRequest.number} is ${pullRequest.state}`); // 8b
    const newest = newestOfPrefix.get(prefix);
    if (newest !== deployment && !(hours <= 1))
      return stale(
        `${newest ? `superseded by ${newest.name}` : `no deployment of ${prefix} has its apps/os worker`}, ${created}`,
      ); // 8c
    if (pullRequest) return keep(`PR #${pullRequest.number} is ${pullRequest.state}, ${created}`);
    if (CI_WORKFLOW_PREVIEWS.has(prefix)) return keep(`a CI workflow's own, ${created}`);
    if (!input.openPullRequestBranches) return keep(`open branches unknown, ${created}`);
    const openBranch = input.openPullRequestBranches.find(
      (branch) => slugifyPreviewName(branch) === prefix,
    );
    if (openBranch) return keep(`open PR branch ${openBranch}, ${created}`);
    if (hours > 24) return stale(`no PR and no open branch of that name, ${created}`); // 8d
    return keep(`no PR, ${created}`);
  });

  const formerParents: PreviewSweepPlan["formerParents"] = FORMER_PARENTS.flatMap((parent) => {
    const worker = input.workers.some(({ name }) => name === parent);
    const resources = input.resources.filter((resource) =>
      isFormerParentResource(parent, resource, input.resourceSuffixes),
    );
    if (!worker && resources.length === 0) return [];
    const left = input.formerParentPreviews.filter((preview) => preview.parent === parent).length;
    return [
      {
        name: parent,
        worker,
        resources,
        // rule 9
        verdict: left > 0 ? "keep" : "stale",
        reason: left > 0 ? `${left} preview(s) left on it` : "no preview left on it",
      },
    ];
  });

  // Rule 10
  const deploymentWorkers = new Set(
    grouped.flatMap((deployment) => deployment.workers.map(({ name }) => name)),
  );
  const unmappedWorkers = input.workers
    .map(({ name }) => name)
    .filter(
      (name) =>
        !input.deployedWorkerNames.has(name) &&
        !FORMER_PARENTS.includes(name) &&
        !deploymentWorkers.has(name),
    );
  return { previews, formerParentPreviews, orphans, deployments, formerParents, unmappedWorkers };
}
