// scripts/preview-sweep.ts — WHICH PER-COMMIT DEPLOYMENTS GO, pure. scripts/preview.ts lists the
// account's workers, KV namespaces, R2 buckets, D1s and Artifacts namespaces; this module groups
// them into deployments by name and decides; preview-sweep.test.ts is its table.
//
// A DEPLOYMENT (envs.ts `previewDeployment`) is every worker and resource named
// `<prefix>-<sha7>-<member>`: the workers `…-os`, `…-dash`, `…-agents`, `…-notes`, `…-admin`,
// `…-voice`, `…-kit`, and apps/os's resources `…-os-oauth-kv`, `…-os-itx-kv`, `…-os-files`,
// `…-os-db`, `…-os-repos`. Nothing else on the account has that shape: main on dev is `os`,
// `os-parent-…`; prd lives on another account; local dev's are `os-dev-…`. A deployment is judged
// by its newest member's creation stamp (KV has none), so one half deployed or half deleted is
// judged like a whole one.
//
// SUPERSEDED (`planSupersededCleanup`, each run's cleanup job once its own deployment is ready):
// every other deployment of the same prefix whose members were all created before the current
// deployment's first one. A deployment created after that — a later push's, in flight — stays.
//
// STALE (`planPreviewSweep`, nightly) when
//   1. its newest member is more than 7 days old, whatever its prefix;
//   2. its prefix is `pr<n>` and pull request #n is closed or does not exist;
//   3. it is not its prefix's newest deployment with an apps/os worker (`newestPreviewDeployment`),
//      and its newest member is more than an hour old or it has no stamped member left;
//   4. its prefix names no pull request (a hand-picked name like `exp-…` or `soak`), no open pull
//      request's head branch slugifies to it, it is no CI workflow's own (CI_WORKFLOW_PREVIEWS),
//      and its newest member is more than 24 h old.
// Anything else is kept. A GitHub lookup that failed never makes a deployment stale: a PR state of
// "unknown", or no open-branch list, leaves rule 1 alone.
//
// A LEGACY WORKER PREVIEW (`planLegacyWorkerPreviewSweep`), one of main on dev's workers or of a
// former parent (preview-config.ts FORMER_PARENTS) from before per-commit deployments, is STALE
// once its last deploy is more than 24 h old, whatever its name: the day is for a checkout that
// still deploys one. One whose last deploy is unknown is kept.
//
// A FORMER PARENT (`planFormerParents`) with no Worker Preview left on it goes: the worker, its
// Durable Object namespaces with it, and every KV, R2, D1 and Artifacts namespace under its name —
// its own (`<parent>-itx`, `-oauth`, `-files`, `-db`, `-repos`) and its previews'
// (`<parent>-<preview>-<suffix>`), but never a legacy slot's (`os-preview-<n>-repos`, a number where
// the preview's name would be; the legacy platform's, thousands of repos each), nor one the account
// has for something else (preview-config.ts accountResourceNames). One still holding a preview
// waits for the legacy rule to take it.
//
// EVERY OTHER WORKER stays: envs.ts's on this account (preview-config.ts accountWorkerNames) and any
// worker envs.ts does not name (`unmappedWorkers`), which the plan lists for a person to judge.
//
// A DURABLE OBJECT NAMESPACE whose worker the account no longer has (`workerlessNamespaces`) is
// Cloudflare's: a worker's delete takes its namespaces, and the API deletes no namespace alone. The
// sweep pages it to #error-pulse each night it is still listed at the end of the run
// (renderWorkerlessNamespacesPage), since each counts toward the account's 500.
import { PREVIEW_DEPLOYMENT_APPS, previewDeployment } from "../../../envs.ts";
import { onCallMention } from "../../../scripts/ci/slack.ts";
import { FORMER_PARENTS, previewPullRequestNumber, slugifyPreviewName } from "./preview-config.ts";

/** What GitHub said about a pull request: "unknown" when the lookup failed. */
export type PullRequestState = "open" | "closed" | "missing" | "unknown";

/** THE CI WORKFLOWS' OWN PREFIXES: Main OS e2e's `main` (.depot/workflows/main-os-e2e.yml), the
 *  latency guard's `latency` (os-latency.yml) and the real-model suite's `real-model`
 *  (os-real-model.yml). Each deploys a fresh deployment per run and deletes the one before it once
 *  the new one is ready; a quiet day is no reason for the sweep to take its newest (rule 4). */
export const CI_WORKFLOW_PREVIEWS: ReadonlySet<string> = new Set(["main", "latency", "real-model"]);

export type PreviewMemberKind = "worker" | "kv" | "r2" | "d1" | "artifacts";

/** One row of an account listing: a worker (id = name), a KV namespace (id + title), an R2 bucket
 *  (id = name), a D1 (uuid + name), an Artifacts namespace (id = name). `createdAt` where the
 *  listing has one. */
export type PreviewMember = {
  kind: PreviewMemberKind;
  name: string;
  id: string;
  createdAt?: string;
};

/** A deployment as the account holds it right now: whichever of its members exist. */
export type PreviewDeploymentListing = {
  name: string;
  prefix: string;
  members: PreviewMember[];
  /** its first and newest members' creation stamps, when any member has one */
  firstCreatedAt?: string;
  newestCreatedAt?: string;
};

/** The suffix of each member a deployment has, by kind: the workers, then apps/os's resources, the
 *  KV named as wrangler provisions it (`<worker>-<binding lowercased, _ → ->`). */
export function previewMemberSuffixes(kvBindings: string[]): Record<PreviewMemberKind, string[]> {
  return {
    worker: ["os", ...PREVIEW_DEPLOYMENT_APPS],
    kv: kvBindings.map((binding) => `os-${binding.toLowerCase().replaceAll("_", "-")}`),
    r2: ["os-files"],
    d1: ["os-db"],
    artifacts: ["os-repos"],
  };
}

/** The deployment a member's name places it in, or undefined for anything that is not a member of
 *  one. */
function previewDeploymentOfMember(
  member: Pick<PreviewMember, "kind" | "name">,
  suffixes: Record<PreviewMemberKind, string[]>,
) {
  for (const suffix of suffixes[member.kind]) {
    if (!member.name.endsWith(`-${suffix}`)) continue;
    const deployment = previewDeployment(member.name.slice(0, -suffix.length - 1));
    if (deployment) return deployment;
  }
  return undefined;
}

/** Every deployment the listed members make up, each with its first and newest stamps. */
export function groupPreviewDeployments(
  members: PreviewMember[],
  suffixes: Record<PreviewMemberKind, string[]>,
): PreviewDeploymentListing[] {
  const byName = new Map<string, PreviewDeploymentListing>();
  for (const member of members) {
    const deployment = previewDeploymentOfMember(member, suffixes);
    if (!deployment) continue;
    const listing = byName.get(deployment.name) || {
      name: deployment.name,
      prefix: deployment.prefix,
      members: [],
    };
    listing.members.push(member);
    byName.set(deployment.name, listing);
  }
  return [...byName.values()].map((listing) => {
    const stamps = listing.members
      .map((member) => member.createdAt)
      // a missing stamp parses as NaN too
      .filter((stamp): stamp is string => !Number.isNaN(Date.parse(stamp || "")))
      .toSorted((a, b) => Date.parse(a) - Date.parse(b));
    return { ...listing, firstCreatedAt: stamps[0], newestCreatedAt: stamps.at(-1) };
  });
}

/** The newest deployment of `prefix` that has its apps/os worker, by its newest member: the one a
 *  test-only run tests, and the one the sweep keeps (rule 3). A push whose deploy failed or was
 *  cancelled before apps/os uploaded leaves a newer deployment without it, which never displaces
 *  the last one that deployed — the one the PR body still links. */
export function newestPreviewDeployment(deployments: PreviewDeploymentListing[], prefix: string) {
  return deployments
    .filter(
      (deployment) =>
        deployment.prefix === prefix &&
        deployment.newestCreatedAt &&
        deployment.members.some(
          (member) => member.kind === "worker" && member.name === `${deployment.name}-os`,
        ),
    )
    .toSorted((a, b) => Date.parse(b.newestCreatedAt!) - Date.parse(a.newestCreatedAt!))[0];
}

/** The deployments `current` supersedes: the same prefix, every stamped member created before
 *  `current`'s first one, or no stamped member left (a half-deleted one). Undefined `current`
 *  stamps (its members not listed yet) supersede nothing. */
export function planSupersededCleanup(
  deployments: PreviewDeploymentListing[],
  currentName: string,
) {
  const current = deployments.find((deployment) => deployment.name === currentName);
  if (!current?.firstCreatedAt) return [];
  const since = Date.parse(current.firstCreatedAt);
  return deployments.filter(
    (deployment) =>
      deployment.prefix === current.prefix &&
      deployment.name !== current.name &&
      (!deployment.newestCreatedAt || Date.parse(deployment.newestCreatedAt) < since),
  );
}

export type PreviewSweepInput = {
  now: number;
  deployments: PreviewDeploymentListing[];
  /** By PR number; a number missing here is "unknown". */
  pullRequestStates: ReadonlyMap<number, PullRequestState>;
  /** Every open pull request's head branch, or undefined when GitHub could not list them. */
  openPullRequestBranches: string[] | undefined;
};

type PreviewSweepVerdict = {
  deployment: PreviewDeploymentListing;
  verdict: "stale" | "keep";
  reason: string;
};

export function planPreviewSweep(input: PreviewSweepInput): PreviewSweepVerdict[] {
  const newestOfPrefix = new Map<string, string>();
  for (const prefix of new Set(input.deployments.map((deployment) => deployment.prefix))) {
    const newest = newestPreviewDeployment(input.deployments, prefix);
    if (newest) newestOfPrefix.set(prefix, newest.name);
  }
  return input.deployments.map((deployment) => {
    const { name, prefix } = deployment;
    // NaN without a stamp, which every comparison below reads as "not old"
    const hours = deployment.newestCreatedAt
      ? (input.now - Date.parse(deployment.newestCreatedAt)) / 3_600_000
      : NaN;
    const created = Number.isNaN(hours)
      ? "no member with a creation stamp"
      : `newest member created ${hours.toFixed(1)} h ago`;
    const stale = (reason: string): PreviewSweepVerdict => ({
      deployment,
      verdict: "stale",
      reason,
    });
    const keep = (reason: string): PreviewSweepVerdict => ({ deployment, verdict: "keep", reason });
    if (hours > 7 * 24) return stale(`${created}, more than 7 days`); // rule 1
    const number = previewPullRequestNumber(prefix);
    const state =
      number === undefined ? undefined : input.pullRequestStates.get(number) || "unknown";
    if (state === "closed" || state === "missing") return stale(`PR #${number} is ${state}`); // rule 2
    const newest = newestOfPrefix.get(prefix) === name;
    if (!newest && !(hours <= 1)) return stale(`not ${prefix}'s newest deployment, ${created}`); // rule 3
    if (state) return keep(`PR #${number} is ${state}, ${created}`);
    if (CI_WORKFLOW_PREVIEWS.has(prefix)) return keep(`a CI workflow's own, ${created}`);
    if (!input.openPullRequestBranches) return keep(`open branches unknown, ${created}`);
    const openBranch = input.openPullRequestBranches.find(
      (branch) => slugifyPreviewName(branch) === prefix,
    );
    if (openBranch) return keep(`open PR branch ${openBranch}, ${created}`);
    if (hours > 24) return stale(`no PR and no open branch of that name, ${created}`); // rule 4
    return keep(`no PR, ${created}`);
  });
}

/** A Worker Preview from before per-commit deployments, named with the worker it hangs from. */
export type LegacyWorkerPreview = { worker: string; name: string; lastDeployedAt?: string };

export function planLegacyWorkerPreviewSweep(
  now: number,
  previews: LegacyWorkerPreview[],
): (LegacyWorkerPreview & { verdict: "stale" | "keep"; reason: string })[] {
  return previews.map((preview) => {
    // NaN without a stamp, which compares false and keeps it
    const hours = preview.lastDeployedAt
      ? (now - Date.parse(preview.lastDeployedAt)) / 3_600_000
      : NaN;
    return {
      ...preview,
      verdict: hours > 24 ? "stale" : "keep",
      reason: Number.isNaN(hours)
        ? "last deploy unknown"
        : `last deployed ${hours.toFixed(1)} h ago`,
    };
  });
}

/** The deployments' resources of `parent`'s name alone: its own (`<parent>-files`, …) and its
 *  previews' (`<parent>-<preview>-<suffix>`, a suffix of apps/os's `suffixes` less its `os-`), a
 *  legacy slot's (`<parent>-<n>-…`) never. */
function isFormerParentResource(
  parent: string,
  resource: Pick<PreviewMember, "kind" | "name">,
  suffixes: Record<PreviewMemberKind, string[]>,
) {
  if (!resource.name.startsWith(`${parent}-`)) return false;
  const rest = resource.name.slice(parent.length + 1);
  if (["oauth", "itx", "files", "db", "repos"].includes(rest)) return true;
  return suffixes[resource.kind].some((memberSuffix) => {
    const suffix = memberSuffix.replace(/^os-/, "");
    const previewName = rest.endsWith(`-${suffix}`) ? rest.slice(0, -suffix.length - 1) : "";
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(previewName) && !/^\d+$/.test(previewName);
  });
}

/** Every former parent the account still has a worker or a resource of, and whether it goes. */
export function planFormerParents(input: {
  workers: string[];
  /** envs.ts's workers on this account: a former parent envs.ts deploys again is not one */
  deployedWorkerNames: ReadonlySet<string>;
  accountResourceNames: ReadonlySet<string>;
  resources: PreviewMember[];
  suffixes: Record<PreviewMemberKind, string[]>;
  /** by former parent, how many Worker Previews it still holds */
  previewsLeft: ReadonlyMap<string, number>;
}): {
  name: string;
  worker: boolean;
  resources: PreviewMember[];
  verdict: "stale" | "keep";
  reason: string;
}[] {
  return FORMER_PARENTS.flatMap((parent) => {
    if (input.deployedWorkerNames.has(parent)) return [];
    const worker = input.workers.includes(parent);
    const resources = input.resources.filter(
      (resource) =>
        !input.accountResourceNames.has(resource.name) &&
        isFormerParentResource(parent, resource, input.suffixes),
    );
    if (!worker && resources.length === 0) return [];
    const left = input.previewsLeft.get(parent) || 0;
    return [
      {
        name: parent,
        worker,
        resources,
        verdict: left > 0 ? "keep" : "stale",
        reason: left > 0 ? `${left} Worker Preview(s) left on it` : "no Worker Preview left on it",
      },
    ];
  });
}

/** The workers that are neither envs.ts's, a former parent nor a deployment's member: kept, and
 *  listed for a person to judge. */
export function unmappedWorkers(
  workers: string[],
  deployedWorkerNames: ReadonlySet<string>,
  deployments: PreviewDeploymentListing[],
) {
  const members = new Set(
    deployments.flatMap((deployment) =>
      deployment.members.filter(({ kind }) => kind === "worker").map(({ name }) => name),
    ),
  );
  return workers.filter(
    (name) =>
      !deployedWorkerNames.has(name) && !FORMER_PARENTS.includes(name) && !members.has(name),
  );
}

/** One Durable Object namespace on the account, `script` the worker whose class it holds. */
export type SweptNamespace = { id: string; name: string; script?: string };

/** The Durable Object namespaces whose worker the account no longer has. */
export function workerlessNamespaces(namespaces: SweptNamespace[], workers: string[]) {
  return namespaces.filter(({ script }) => !workers.includes(script || ""));
}

/** The sweep's page for the workerless namespaces: what to escalate, and to whom. */
export function renderWorkerlessNamespacesPage(
  namespaces: SweptNamespace[],
  jobUrl: string | undefined,
) {
  return [
    `🚨 preview sweep: ${namespaces.length} Durable Object namespace(s) outlived their worker ${onCallMention}`,
    ...namespaces.map(({ id, name, script }) => `• ${name} (${id}), worker ${script || "unnamed"}`),
    "A Cloudflare fault, not a commit's: a worker's delete takes its namespaces, and the API deletes no namespace alone. Each counts toward the account's 500: escalate them to Cloudflare with these ids. The sweep checks again each night.",
    jobUrl && `<${jobUrl}|sweep run>`,
  ]
    .filter(Boolean)
    .join("\n");
}
