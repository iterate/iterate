import { expect, test } from "vitest";
import { PREVIEW_AND_DEV_ACCOUNT_ID } from "../../../envs.ts";
import { readWranglerBase } from "./generate-wrangler-config.ts";
import { accountResourceNames, accountWorkerNames, MAIN_ON_DEV } from "./preview-config.ts";
import {
  groupPreviewDeployments,
  newestPreviewDeployment,
  planFormerParents,
  planLegacyWorkerPreviewSweep,
  planPreviewSweep,
  planSupersededCleanup,
  previewMemberSuffixes,
  renderWorkerlessNamespacesPage,
  unmappedWorkers,
  workerlessNamespaces,
  type PreviewMember,
  type PullRequestState,
} from "./preview-sweep.ts";

const NOW = Date.parse("2026-09-25T12:00:00Z");

test("a deployment's members: its seven workers, then apps/os's KV (wrangler's names for the template's bindings), R2 bucket, D1 and Artifacts namespace", () => {
  expect(previewMemberSuffixes(kvBindings())).toEqual({
    worker: ["os", "dash", "agents", "notes", "admin", "voice", "kit"],
    kv: ["os-itx-kv", "os-oauth-kv"],
    r2: ["os-files"],
    d1: ["os-db"],
    artifacts: ["os-repos"],
  });
});

test("members group into deployments by name; nothing of another shape on the account is one", () => {
  const deployments = groupPreviewDeployments(
    [
      worker("pr3144-a1b2c3d-os", 2),
      worker("pr3144-a1b2c3d-dash", 2),
      { kind: "kv", name: "pr3144-a1b2c3d-os-oauth-kv", id: "k1" },
      d1("pr3144-a1b2c3d-os-db", 3),
      worker("real-model-0f0f0f0-os", 5),
      // main on dev, prd-shaped names, local dev's, the legacy Worker Previews' resources
      worker("os", 100),
      worker("dash", 100),
      d1("os-parent-db", 100),
      { kind: "kv", name: "os-pr3144-itx-kv", id: "k2" },
      { kind: "artifacts", name: "os-dev-repos", id: "os-dev-repos" },
      // a worker of the right shape but not a member's suffix
      worker("pr3144-a1b2c3d-docs", 2),
    ],
    suffixes(),
  );
  expect(deployments).toEqual([
    expect.objectContaining({
      name: "pr3144-a1b2c3d",
      prefix: "pr3144",
      firstCreatedAt: hoursAgo(3),
      newestCreatedAt: hoursAgo(2),
    }),
    expect.objectContaining({ name: "real-model-0f0f0f0", prefix: "real-model" }),
  ]);
  expect(deployments[0]!.members.map((member) => member.name)).toEqual([
    "pr3144-a1b2c3d-os",
    "pr3144-a1b2c3d-dash",
    "pr3144-a1b2c3d-os-oauth-kv",
    "pr3144-a1b2c3d-os-db",
  ]);
});

test("a test-only run tests its prefix's newest deployment that has its apps/os worker", () => {
  const deployments = group([
    worker("pr7-1111111-os", 5),
    worker("pr7-2222222-os", 1),
    worker("pr8-3333333-os", 0.5),
    // a newer push whose deploy failed before apps/os uploaded
    d1("pr7-4444444-os-db", 0.2),
    worker("pr7-4444444-dash", 0.2),
  ]);
  expect(newestPreviewDeployment(deployments, "pr7")).toMatchObject({ name: "pr7-2222222" });
  expect(newestPreviewDeployment(deployments, "pr9")).toBeUndefined();
});

// The second-push scenarios (docs/dev-environments.md): whatever the previous push's deployment
// left, the next ready deployment's cleanup takes it, and never one begun after it.
test.for<{ name: string; previous: PreviewMember[]; deleted: boolean }>(
  // prettier-ignore
  [
    { name: "the previous deployment deployed, tested green or red", previous: [d1("pr7-1111111-os-db", 2), worker("pr7-1111111-os", 1.9), worker("pr7-1111111-dash", 1.9)], deleted: true },
    { name: "the previous push was cancelled halfway through deploying: a D1 and no workers", previous: [d1("pr7-1111111-os-db", 1)], deleted: true },
    { name: "the previous deploy failed after wrangler made its KV", previous: [d1("pr7-1111111-os-db", 1), { kind: "kv", name: "pr7-1111111-os-oauth-kv", id: "k" }], deleted: true },
    { name: "a half-deleted deployment with only KV left", previous: [{ kind: "kv", name: "pr7-1111111-os-itx-kv", id: "k" }], deleted: true },
    { name: "a later push's deployment, begun after this one", previous: [d1("pr7-3333333-os-db", 0.1)], deleted: false },
    { name: "another PR's deployment", previous: [worker("pr8-1111111-os", 2)], deleted: false },
  ],
)(
  "a ready deployment supersedes its prefix's older ones: $name ⇒ deleted: $deleted",
  ({ previous, deleted }) => {
    const deployments = group([
      d1("pr7-2222222-os-db", 0.5),
      worker("pr7-2222222-os", 0.4),
      worker("pr7-2222222-dash", 0.4),
      ...previous,
    ]);
    const superseded = planSupersededCleanup(deployments, "pr7-2222222", new Set(), NOW).map(
      ({ name }) => name,
    );
    expect(superseded).toEqual(deleted ? ["pr7-1111111"] : []);
  },
);

// Main OS e2e runs every main commit, and runs overlap: the cleanup of a newer commit's run must not
// take the deployment an older commit's run is still testing. The next cleanup takes it.
test("a deployment a run still in progress tests is never superseded, and goes once that run has ended", () => {
  const deployments = group([
    worker("main-1111111-os", 0.2),
    worker("main-0000000-os", 1),
    worker("main-2222222-os", 0.1),
  ]);
  // an hour on, past the grace a PR run reusing a main deployment gets
  const superseded = (underTest: string[]) =>
    planSupersededCleanup(deployments, "main-2222222", new Set(underTest), NOW + 3_600_000).map(
      ({ name }) => name,
    );

  expect(superseded(["main-1111111", "main-2222222"])).toEqual(["main-0000000"]);
  expect(superseded(["main-2222222"])).toEqual(["main-1111111", "main-0000000"]);
});

test("a deployment the listing does not show yet supersedes nothing", () => {
  expect(
    planSupersededCleanup(group([worker("pr7-1111111-os", 2)]), "pr7-2222222", new Set(), NOW),
  ).toEqual([]);
});

test.for([
  {
    name: "a newer one created 20 minutes ago: a PR run may be testing against it",
    newerHoursAgo: 0.33,
    deleted: false,
  },
  { name: "a newer one created an hour ago", newerHoursAgo: 1, deleted: true },
])("an older main deployment, $name ⇒ deleted: $deleted", ({ newerHoursAgo, deleted }) => {
  const deployments = group([
    worker("main-1111111-os", 5),
    worker("main-2222222-os", newerHoursAgo),
    worker("main-3333333-os", 0.1),
  ]);
  const superseded = planSupersededCleanup(deployments, "main-3333333", new Set(), NOW);
  expect(superseded.map(({ name }) => name)).toEqual(deleted ? ["main-1111111"] : []);
});

test.for<{
  name: string;
  deployment: string;
  createdHoursAgo?: number;
  pullRequest?: PullRequestState;
  verdict: "stale" | "keep";
}>(
  // prettier-ignore
  [
    { name: "1: created 8 days ago, PR open", deployment: "pr7-1111111", createdHoursAgo: 192, pullRequest: "open", verdict: "stale" },
    { name: "2: PR closed, created an hour ago", deployment: "pr7-1111111", createdHoursAgo: 1, pullRequest: "closed", verdict: "stale" },
    { name: "2: PR does not exist", deployment: "pr7-1111111", createdHoursAgo: 1, pullRequest: "missing", verdict: "stale" },
    { name: "PR open, created 6 days ago", deployment: "pr7-1111111", createdHoursAgo: 144, pullRequest: "open", verdict: "keep" },
    { name: "PR lookup failed, created 6 days ago", deployment: "pr7-1111111", createdHoursAgo: 144, pullRequest: "unknown", verdict: "keep" },
    { name: "4: no PR, created 25 h ago", deployment: "exp-watchdog-1111111", createdHoursAgo: 25, verdict: "stale" },
    { name: "4: no PR, created 23 h ago", deployment: "exp-watchdog-1111111", createdHoursAgo: 23, verdict: "keep" },
    { name: "4: a branch's name, created 2 days ago: only `pr<n>` is a PR's", deployment: "fix-foo-1111111", createdHoursAgo: 48, verdict: "stale" },
    { name: "4: a CI workflow's own, created 30 h ago", deployment: "main-1111111", createdHoursAgo: 30, verdict: "keep" },
    { name: "4: a branch's that begins `main-`", deployment: "main-branch-1111111", createdHoursAgo: 30, verdict: "stale" },
    { name: "1: a CI workflow's own, created 8 days ago", deployment: "real-model-1111111", createdHoursAgo: 192, verdict: "stale" },
  ],
)(
  "which deployments are stale (rules 1, 2 and 4): $name ⇒ $verdict",
  ({ deployment, createdHoursAgo, pullRequest, verdict }) => {
    const plan = planPreviewSweep({
      now: NOW,
      deployments: group([
        createdHoursAgo === undefined
          ? { kind: "kv", name: `${deployment}-os-itx-kv`, id: "k" }
          : worker(`${deployment}-os`, createdHoursAgo),
      ]),
      pullRequestStates: new Map<number, PullRequestState>(pullRequest ? [[7, pullRequest]] : []),
    });
    expect(plan).toMatchObject([{ deployment: { name: deployment }, verdict }]);
  },
);

test("the sweep keeps the last deployment that deployed while a newer push's deploy failed, and takes the failed one after an hour", () => {
  const plan = planPreviewSweep({
    now: NOW,
    deployments: group([
      worker("pr7-1111111-os", 5),
      d1("pr7-2222222-os-db", 2),
      worker("pr7-2222222-dash", 2),
    ]),
    pullRequestStates: new Map([[7, "open"]]),
  });
  expect(plan).toMatchObject([
    { deployment: { name: "pr7-1111111" }, verdict: "keep" },
    { deployment: { name: "pr7-2222222" }, verdict: "stale" },
  ]);
});

test.for([
  { name: "a newer one created half an hour ago", newerHoursAgo: 0.5, verdict: "keep" },
  { name: "a newer one created 2 h ago", newerHoursAgo: 2, verdict: "stale" },
])("an older main deployment, created 5 h ago, $name ⇒ $verdict", ({ newerHoursAgo, verdict }) => {
  const plan = planPreviewSweep({
    now: NOW,
    deployments: group([worker("main-1111111-os", 5), worker("main-2222222-os", newerHoursAgo)]),
    pullRequestStates: new Map(),
  });
  expect(plan).toMatchObject([
    { deployment: { name: "main-1111111" }, verdict },
    { verdict: "keep" },
  ]);
});

test.for<{ name: string; olderHoursAgo?: number; verdict: "stale" | "keep" }>(
  // prettier-ignore
  [
    { name: "3: an older deployment of an open PR, 2 h old", olderHoursAgo: 2, verdict: "stale" },
    { name: "3: an older deployment of an open PR with only KV left", verdict: "stale" },
    { name: "an older deployment of an open PR, half an hour old: the cleanup job's to take", olderHoursAgo: 0.5, verdict: "keep" },
  ],
)(
  "the newest deployment of a prefix stays; an older one goes after an hour: $name ⇒ $verdict",
  ({ olderHoursAgo, verdict }) => {
    const plan = planPreviewSweep({
      now: NOW,
      deployments: group([
        worker("pr7-2222222-os", 0.2),
        olderHoursAgo === undefined
          ? { kind: "kv", name: "pr7-1111111-os-itx-kv", id: "k" }
          : worker("pr7-1111111-os", olderHoursAgo),
      ]),
      pullRequestStates: new Map([[7, "open"]]),
    });
    expect(plan).toMatchObject([
      { deployment: { name: "pr7-2222222" }, verdict: "keep" },
      { deployment: { name: "pr7-1111111" }, verdict },
    ]);
  },
);

// A Worker Preview from before per-commit deployments, on main on dev's workers or a former parent,
// goes once idle a day, whatever its name or PR.
test.for<{
  name: string;
  worker: string;
  preview: string;
  deployedHoursAgo?: number;
  verdict: "stale" | "keep";
}>(
  // prettier-ignore
  [
    { name: "an open PR's, a day idle", worker: "os", preview: "pr7", deployedHoursAgo: 25, verdict: "stale" },
    { name: "a CI workflow's name on a former parent, a day idle", worker: "os-preview", preview: "latency", deployedHoursAgo: 25, verdict: "stale" },
    { name: "an app's former parent", worker: "dash-preview", preview: "pr3061-worker-bundler", deployedHoursAgo: 60, verdict: "stale" },
    { name: "deployed 23 h ago, by a checkout from before per-commit deployments", worker: "os", preview: "pr7", deployedHoursAgo: 23, verdict: "keep" },
    { name: "last deploy unknown", worker: "kit-preview", preview: "soak", verdict: "keep" },
  ],
)("a legacy Worker Preview: $name ⇒ $verdict", ({ worker, preview, deployedHoursAgo, verdict }) => {
  const lastDeployedAt = deployedHoursAgo === undefined ? undefined : hoursAgo(deployedHoursAgo);
  expect(
    planLegacyWorkerPreviewSweep(NOW, [{ worker, name: preview, lastDeployedAt }]),
  ).toMatchObject([{ worker, name: preview, verdict }]);
});

// A former parent with no Worker Preview left goes, with everything under its name but a legacy
// slot's and the account's own.
test.for<{
  name: string;
  workers: string[];
  previewsLeft: number;
  expected: { name: string; worker: boolean; verdict: "stale" | "keep" }[];
}>(
  // prettier-ignore
  [
    { name: "no Worker Preview left: the worker and everything under its name go", workers: ["os", "os-preview"], previewsLeft: 0, expected: [{ name: "os-preview", worker: true, verdict: "stale" }] },
    { name: "a Worker Preview left: the legacy rule first", workers: ["os", "os-preview"], previewsLeft: 1, expected: [{ name: "os-preview", worker: true, verdict: "keep" }] },
    { name: "the worker gone, its resources left: tried again", workers: ["os"], previewsLeft: 0, expected: [{ name: "os-preview", worker: false, verdict: "stale" }] },
    { name: "an app's former parent, which has no resources", workers: ["os", "os-preview", "dash-preview"], previewsLeft: 0, expected: [{ name: "os-preview", worker: true, verdict: "stale" }, { name: "dash-preview", worker: true, verdict: "stale" }] },
  ],
)("a former parent: $name", ({ workers, previewsLeft, expected }) => {
  const plan = planFormerParents({
    workers,
    deployedWorkerNames: accountWorkerNames(),
    accountResourceNames: accountResourceNames(),
    resources: [...osPreviewResources(), ...notOsPreviewResources()],
    suffixes: suffixes(),
    previewsLeft: new Map([["os-preview", previewsLeft]]),
  });
  expect(plan).toMatchObject(
    expected.map((parent) => ({
      ...parent,
      resources: parent.name === "os-preview" ? osPreviewResources() : [],
    })),
  );
});

test("a deployment whose prefix begins with a former parent's name keeps its resources: they are the deployment's, not the former parent's", () => {
  const deployment: PreviewMember[] = [
    d1("os-preview-foo-a1b2c3d-os-db", 2),
    { kind: "kv", name: "os-preview-foo-a1b2c3d-os-oauth-kv", id: "k" },
    { kind: "r2", name: "os-preview-foo-a1b2c3d-os-files", id: "os-preview-foo-a1b2c3d-os-files" },
    {
      kind: "artifacts",
      name: "os-preview-foo-a1b2c3d-os-repos",
      id: "os-preview-foo-a1b2c3d-os-repos",
    },
  ];
  const plan = planFormerParents({
    workers: ["os", "os-preview", "os-preview-foo-a1b2c3d-os"],
    deployedWorkerNames: accountWorkerNames(),
    accountResourceNames: accountResourceNames(),
    resources: [...osPreviewResources(), ...deployment],
    suffixes: suffixes(),
    previewsLeft: new Map(),
  });
  expect(plan).toMatchObject([{ name: "os-preview", resources: osPreviewResources() }]);
});

test("a former parent envs.ts deploys again, and a resource the account has for something else, are never a former parent's", () => {
  const plan = planFormerParents({
    workers: ["os", "os-preview", "dash-preview"],
    deployedWorkerNames: new Set([...accountWorkerNames(), "dash-preview"]),
    accountResourceNames: new Set([...accountResourceNames(), "os-preview-files"]),
    resources: osPreviewResources(),
    suffixes: suffixes(),
    previewsLeft: new Map(),
  });
  expect(plan).toMatchObject([
    {
      name: "os-preview",
      resources: osPreviewResources().filter(({ name }) => name !== "os-preview-files"),
    },
  ]);
});

test("only a deployment's or a former parent's worker is ever deleted; the ones envs.ts does not name are listed", () => {
  const workers = [
    ...accountWorkerNames(),
    "os-preview",
    "pr7-aaaaaaa-os",
    "iterate",
    "do-alarm-held-repro",
    "captun",
  ];
  const deployments = group(workers.map((name) => worker(name, 200)));
  expect(unmappedWorkers(workers, accountWorkerNames(), deployments)).toEqual([
    "iterate",
    "do-alarm-held-repro",
    "captun",
  ]);
});

test("the sweep deletes on the dev/preview account, and envs.ts's workers there are main on dev's and CI's", () => {
  expect(MAIN_ON_DEV).toMatchObject({ cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID });
  expect([...accountWorkerNames()].toSorted()).toEqual([
    "admin",
    "agents",
    "ci-reports",
    "dash",
    "iterate-spa-preview",
    "kit",
    "notes",
    "os",
    "voice",
  ]);
});

test.for([
  {
    name: "a Durable Object namespace whose worker is gone is paged with its id, what to escalate, and the run",
    testRun: false,
    firstLine:
      "🚨 preview sweep: 2 Durable Object namespace(s) outlived their worker <@U067G4QRFK2> <@U099JH9TAF2>",
  },
  {
    name: "a test run's workerless page is 🧪 and mentions nobody",
    testRun: true,
    firstLine:
      "🧪 TEST RUN — 🚨 preview sweep: 2 Durable Object namespace(s) outlived their worker",
  },
])("$name", ({ testRun, firstLine }) => {
  const namespaces = [
    { id: "n1", name: "os_ProjectDurableObject", script: "os" },
    { id: "n2", name: "os-preview_ProjectDurableObject", script: "os-preview" },
    { id: "n3", name: "os_pr7_ProjectDurableObject", script: "os" },
    { id: "n4", name: "LegacyDurableObject" },
  ];
  const workerless = workerlessNamespaces(namespaces, ["os", "dash"]);
  // exact: the page is what the on-call reads
  expect(
    renderWorkerlessNamespacesPage(workerless, {
      jobUrl: "https://depot.dev/orgs/x/workflows/y",
      testRun,
    }).split("\n"),
  ).toEqual([
    firstLine,
    "Impact: each counts toward the account's 500 Durable Object namespaces",
    "Do: escalate to Cloudflare with these ids: a worker's delete takes its namespaces, and the API deletes no namespace alone. The sweep checks again each night.",
    "• os-preview_ProjectDurableObject (n2), worker os-preview",
    "• LegacyDurableObject (n4), worker unnamed",
    "<https://depot.dev/orgs/x/workflows/y|run>",
  ]);
});

function hoursAgo(hours: number) {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

function worker(name: string, createdHoursAgo: number): PreviewMember {
  return { kind: "worker", name, id: name, createdAt: hoursAgo(createdHoursAgo) };
}

function d1(name: string, createdHoursAgo: number): PreviewMember {
  return { kind: "d1", name, id: `uuid-${name}`, createdAt: hoursAgo(createdHoursAgo) };
}

function kvBindings() {
  return readWranglerBase().kv_namespaces.map(({ binding }: { binding: string }) => binding);
}

function suffixes() {
  return previewMemberSuffixes(kvBindings());
}

function group(members: PreviewMember[]) {
  return groupPreviewDeployments(members, suffixes());
}

/** The former parent `os-preview`'s own resources and its previews', which a former parent's
 *  delete takes. */
function osPreviewResources(): PreviewMember[] {
  return [
    { kind: "kv", name: "os-preview-itx", id: "k1" },
    { kind: "kv", name: "os-preview-oauth", id: "k2" },
    { kind: "r2", name: "os-preview-files", id: "os-preview-files", createdAt: hoursAgo(100) },
    {
      kind: "artifacts",
      name: "os-preview-repos",
      id: "os-preview-repos",
      createdAt: hoursAgo(100),
    },
    { kind: "kv", name: "os-preview-soak-itx-kv", id: "k3" },
    {
      kind: "r2",
      name: "os-preview-soak-files",
      id: "os-preview-soak-files",
      createdAt: hoursAgo(90),
    },
    {
      kind: "artifacts",
      name: "os-preview-pr3061-worker-bundler-repos",
      id: "os-preview-pr3061-worker-bundler-repos",
      createdAt: hoursAgo(90),
    },
  ];
}

/** Resources that read as `os-preview-…` but are not its: the legacy platform's slots, a name of no
 *  suffix of its kind, and `os`'s own and its previews'. */
function notOsPreviewResources(): PreviewMember[] {
  return [
    {
      kind: "artifacts",
      name: "os-preview-1-repos",
      id: "os-preview-1-repos",
      createdAt: hoursAgo(3000),
    },
    {
      kind: "artifacts",
      name: "os-preview-16-repos",
      id: "os-preview-16-repos",
      createdAt: hoursAgo(1500),
    },
    { kind: "kv", name: "os-preview-3-project-directory", id: "k4" },
    { kind: "r2", name: "os-preview-soak-itx-kv", id: "os-preview-soak-itx-kv" },
    { kind: "r2", name: "os-parent-files", id: "os-parent-files", createdAt: hoursAgo(90) },
    { kind: "r2", name: "os-pr7-files", id: "os-pr7-files", createdAt: hoursAgo(1) },
  ];
}
