import { expect, test } from "vitest";
import { PREVIEW_AND_DEV_ACCOUNT_ID } from "../../envs.ts";
import { readWranglerBase } from "../../core/os/scripts/generate-wrangler-config.ts";
import { accountWorkerNames, MAIN_ON_DEV } from "./preview-config.ts";
import {
  groupPreviewDeployments,
  newestPreviewDeployment,
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

test("a deployment's members: its eight workers, then core/os's KV (wrangler's names for the template's bindings), R2 bucket, D1 and Artifacts namespace", () => {
  expect(previewMemberSuffixes(kvBindings())).toEqual({
    worker: ["os", "dash", "agents", "notes", "docs", "admin", "voice", "kit"],
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
      // main on dev, prd-shaped names, local dev's, a name of no deployment's shape
      worker("os", 100),
      worker("dash", 100),
      d1("os-parent-db", 100),
      { kind: "kv", name: "os-pr3144-itx-kv", id: "k2" },
      { kind: "artifacts", name: "os-dev-repos", id: "os-dev-repos" },
      // a worker of the right shape but not a member's suffix
      worker("pr3144-a1b2c3d-wiki", 2),
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

test("a test-only run tests its prefix's newest deployment that has its core/os worker", () => {
  const deployments = group([
    worker("pr7-1111111-os", 5),
    worker("pr7-2222222-os", 1),
    worker("pr8-3333333-os", 0.5),
    // a newer push whose deploy failed before core/os uploaded
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
    const superseded = planSupersededCleanup(deployments, "pr7-2222222", new Set()).map(
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
  const superseded = (underTest: string[]) =>
    planSupersededCleanup(deployments, "main-2222222", new Set(underTest)).map(({ name }) => name);

  expect(superseded(["main-1111111", "main-2222222"])).toEqual(["main-0000000"]);
  expect(superseded(["main-2222222"])).toEqual(["main-1111111", "main-0000000"]);
});

test("a deployment the listing does not show yet supersedes nothing", () => {
  expect(
    planSupersededCleanup(group([worker("pr7-1111111-os", 2)]), "pr7-2222222", new Set()),
  ).toEqual([]);
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

test("only a deployment's worker is ever deleted; the ones envs.ts does not name are listed", () => {
  const workers = [
    ...accountWorkerNames(),
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
    "docs",
    "iterate-spa-preview",
    "kit",
    "notes",
    "os",
    "telemetry",
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
    { id: "n3", name: "LegacyDurableObject" },
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
    "• LegacyDurableObject (n3), worker unnamed",
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
