// scripts/os/preview-sweep.ts — WHICH PER-COMMIT DEPLOYMENTS GO, pure but for the Slack writes at its
// end. scripts/os/preview.ts lists the account's workers, KV namespaces, R2 buckets, D1s and
// Artifacts namespaces; this module groups them into deployments by name and decides;
// preview-sweep.test.ts is its table.
//
// A DEPLOYMENT (envs.ts `previewDeployment`) is every worker and resource named
// `<prefix>-<sha7>-<member>`: the workers `…-os`, `…-dash`, `…-agents`, `…-notes`, `…-admin`,
// `…-voice`, and core/os's resources `…-os-oauth-kv`, `…-os-itx-kv`, `…-os-files`,
// `…-os-db`, `…-os-repos`. Nothing else on the account has that shape: main on dev is `os`,
// `os-parent-…`; prd lives on another account; local dev's are `os-dev-…`. A deployment is judged
// by its newest member's creation stamp (KV has none), so one half deployed or half deleted is
// judged like a whole one.
//
// SUPERSEDED (`planSupersededCleanup`, each run's cleanup job once its own deployment is ready):
// every other deployment of the same prefix whose members were all created before the current
// deployment's first one. A deployment created after that — a later push's, in flight — stays, and
// so does one a run of its CI workflow still in progress tests: Main OS e2e runs every main commit,
// so an older commit's run may still be testing its deployment. What stays, a later cleanup or the
// sweep takes.
//
// STALE (`planPreviewSweep`, nightly) when
//   1. its newest member is more than 7 days old, whatever its prefix;
//   2. its prefix is `pr<n>` and pull request #n is closed or does not exist;
//   3. it is not its prefix's newest deployment with an core/os worker (`newestPreviewDeployment`),
//      and its newest member is more than an hour old or it has no stamped member left;
//   4. its prefix names no pull request (a hand-picked name like `exp-…` or `soak`), it is no CI
//      workflow's own (CI_WORKFLOW_PREVIEWS), and its newest member is more than 24 h old.
// Anything else is kept. A GitHub lookup that failed never makes a deployment stale: rule 2 takes
// GitHub's "closed" or "missing", never "unknown".
//
// EVERY OTHER WORKER stays: envs.ts's on this account (preview-config.ts accountWorkerNames) and any
// worker envs.ts does not name (`unmappedWorkers`), which the plan lists for a person to judge.
//
// A DURABLE OBJECT NAMESPACE whose worker the account no longer has (`workerlessNamespaces`) is
// Cloudflare's: a worker's delete takes its namespaces, and the API deletes no namespace alone. The
// sweep keeps one #error-pulse page for them while any is still listed at the end of a run
// (renderWorkerlessNamespacesPage), since each counts toward the account's 500.
//
// THE SWEEP'S #ERROR-PULSE SIDE (`keepSweepPages`, this module's one write, through the Slack
// client it is given): one page per kind of namespace Cloudflare left, in today's dashboard thread
// and not sent to the channel, and the dashboard's "preview sweep" row.
import type { WebClient } from "@slack/web-api";
import { PREVIEW_DEPLOYMENT_APPS, previewDeployment } from "../../envs.ts";
import { setRow, type RowState } from "../ci/dashboard.ts";
import { keepPage, pageText, slackChannelIds } from "../ci/slack.ts";
import { previewPullRequestNumber } from "./preview-config.ts";

/** What GitHub said about a pull request: "unknown" when the lookup failed. */
export type PullRequestState = "open" | "closed" | "missing" | "unknown";

/** THE CI WORKFLOWS' OWN PREFIXES, each with its workflow's `name:`: Main OS e2e's `main`
 *  (.depot/workflows/main-os-e2e.yml), the latency guard's `latency` (os-latency.yml) and the
 *  real-model suite's `real-model` (os-real-model.yml). Each deploys a fresh deployment per run and
 *  deletes the ones before it once the new one is ready, but none a run of that workflow still in
 *  progress tests; a quiet day is no reason for the sweep to take its newest (rule 4). */
export const CI_WORKFLOW_PREVIEWS: ReadonlyMap<string, string> = new Map([
  ["main", "Main OS e2e"],
  ["latency", "OS latency"],
  ["real-model", "OS real model"],
]);

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

/** The suffix of each member a deployment has, by kind: the workers, then core/os's resources, the
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

/** The newest deployment of `prefix` that has its core/os worker, by its newest member: the one a
 *  test-only run tests, and the one the sweep keeps (rule 3). A push whose deploy failed or was
 *  cancelled before core/os uploaded leaves a newer deployment without it, which never displaces
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
 *  `current`'s first one, or no stamped member left (a half-deleted one), and not `underTest`, the
 *  deployments a run still in progress tests. Undefined `current` stamps (its members not listed
 *  yet) supersede nothing. */
export function planSupersededCleanup(
  deployments: PreviewDeploymentListing[],
  currentName: string,
  underTest: ReadonlySet<string>,
) {
  const current = deployments.find((deployment) => deployment.name === currentName);
  if (!current?.firstCreatedAt) return [];
  const since = Date.parse(current.firstCreatedAt);
  return deployments.filter(
    (deployment) =>
      deployment.prefix === current.prefix &&
      deployment.name !== current.name &&
      !underTest.has(deployment.name) &&
      (!deployment.newestCreatedAt || Date.parse(deployment.newestCreatedAt) < since),
  );
}

export type PreviewSweepInput = {
  now: number;
  deployments: PreviewDeploymentListing[];
  /** By PR number; a number missing here is "unknown". */
  pullRequestStates: ReadonlyMap<number, PullRequestState>;
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
    const state = number ? input.pullRequestStates.get(number) || "unknown" : undefined;
    if (state === "closed" || state === "missing") return stale(`PR #${number} is ${state}`); // rule 2
    const newest = newestOfPrefix.get(prefix) === name;
    if (!newest && !(hours <= 1)) return stale(`not ${prefix}'s newest deployment, ${created}`); // rule 3
    if (state) return keep(`PR #${number} is ${state}, ${created}`);
    if (CI_WORKFLOW_PREVIEWS.has(prefix)) return keep(`a CI workflow's own, ${created}`);
    if (hours > 24) return stale(`no PR, ${created}`); // rule 4
    return keep(`no PR, ${created}`);
  });
}

/** The workers that are neither envs.ts's nor a deployment's member: kept, and listed for a person
 *  to judge. */
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
  return workers.filter((name) => !deployedWorkerNames.has(name) && !members.has(name));
}

/** One Durable Object namespace on the account, `script` the worker whose class it holds. */
export type SweptNamespace = { id: string; name: string; script?: string };

/** The Durable Object namespaces whose worker the account no longer has. */
export function workerlessNamespaces(namespaces: SweptNamespace[], workers: string[]) {
  return namespaces.filter(({ script }) => !workers.includes(script || ""));
}

/** The first words after the count on the sweep's page for the workerless namespaces, by which the
 *  next night's sweep finds it open (scripts/ci/slack.ts `keepPage`). */
export const WORKERLESS_PAGE_MARKER = "Durable Object namespace(s) outlived their worker";

/** The sweep's page for the workerless namespaces: what to escalate. Pure. */
export function renderWorkerlessNamespacesPage(
  namespaces: SweptNamespace[],
  input: { jobUrl: string | undefined; testRun: boolean },
) {
  return pageText({
    what: `preview sweep: ${namespaces.length} ${WORKERLESS_PAGE_MARKER}`,
    impact: "each counts toward the account's 500 Durable Object namespaces",
    action:
      "escalate to Cloudflare with these ids: a worker's delete takes its namespaces, and the API deletes no namespace alone. The sweep checks again each night.",
    details: namespaces.map(
      ({ id, name, script }) => `• ${name} (${id}), worker ${script || "unnamed"}`,
    ),
    link: input.jobUrl || null,
    testRun: input.testRun,
  });
}

/** How far back the sweep looks for its own open pages: a page stays open, edited each night, until
 *  Cloudflare deletes what it names, and a Cloudflare escalation takes weeks. */
const PAGE_LOOKBACK_HOURS = 30 * 24;

/** One kind of namespace Cloudflare left: its page's marker, and the page this run renders given the
 *  open page's text, with how many namespaces it names; undefined once none is left. */
export type SweepIncident = {
  marker: string;
  render: (
    openText: string | undefined,
  ) => Promise<{ text: string; namespaces: number } | undefined>;
};

/**
 * A sweep on main's #error-pulse side: each incident's page kept (scripts/ci/slack.ts `keepPage`),
 * a reply in today's dashboard thread not sent to the channel, which the first night that finds
 * none left resolves; then the dashboard's "preview sweep" row, grey with how many namespaces the
 * pages name, green when they name none. A page or row Slack refused leaves the others to be kept;
 * resolves to what failed, for the run to fail on.
 */
export async function keepSweepPages(
  slack: WebClient,
  input: { incidents: SweepIncident[]; now: Date },
) {
  const { now } = input;
  const failures: string[] = [];
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let stuck = 0;
  for (const { marker, render } of input.incidents) {
    await keepPage(slack, {
      marker,
      sinceHours: PAGE_LOOKBACK_HOURS,
      now,
      render: async (openText) => {
        const page = await render(openText);
        if (!page) return undefined;
        console.log(page.text);
        stuck += page.namespaces;
        return page.text;
      },
      why: "Cloudflare deleted them",
      broadcast: false,
    })
      .then((step) => console.log(`#error-pulse page "${marker}": ${step}`))
      .catch((error: unknown) =>
        failures.push(`keeping the #error-pulse page: ${describe(error)}`),
      );
  }
  const row: { state: RowState; text: string } =
    stuck > 0
      ? { state: "grey", text: `${stuck} namespaces stuck (Cloudflare)` }
      : { state: "green", text: "no namespaces stuck" };
  await setRow(slack, {
    channel: slackChannelIds["#error-pulse"],
    now,
    signal: "preview sweep",
    ...row,
  }).catch((error: unknown) => failures.push(`setting the dashboard's row: ${describe(error)}`));
  return failures;
}
