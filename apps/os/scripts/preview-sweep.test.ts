import { expect, test } from "vitest";
import { readWranglerBase } from "./generate-wrangler-config.ts";
import {
  groupPreviewDeployments,
  newestPreviewDeployment,
  planPreviewSweep,
  planSupersededCleanup,
  previewMemberSuffixes,
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
test.each<{ scenario: string; previous: PreviewMember[]; deleted: boolean }>(
  // prettier-ignore
  [
    { scenario: "the previous deployment deployed, tested green or red", previous: [d1("pr7-1111111-os-db", 2), worker("pr7-1111111-os", 1.9), worker("pr7-1111111-dash", 1.9)], deleted: true },
    { scenario: "the previous push was cancelled halfway through deploying: a D1 and no workers", previous: [d1("pr7-1111111-os-db", 1)], deleted: true },
    { scenario: "the previous deploy failed after wrangler made its KV", previous: [d1("pr7-1111111-os-db", 1), { kind: "kv", name: "pr7-1111111-os-oauth-kv", id: "k" }], deleted: true },
    { scenario: "a half-deleted deployment with only KV left", previous: [{ kind: "kv", name: "pr7-1111111-os-itx-kv", id: "k" }], deleted: true },
    { scenario: "a later push's deployment, begun after this one", previous: [d1("pr7-3333333-os-db", 0.1)], deleted: false },
    { scenario: "another PR's deployment", previous: [worker("pr8-1111111-os", 2)], deleted: false },
  ],
)(
  "a ready deployment supersedes its prefix's older ones: $scenario ⇒ deleted: $deleted",
  ({ previous, deleted }) => {
    const deployments = group([
      d1("pr7-2222222-os-db", 0.5),
      worker("pr7-2222222-os", 0.4),
      worker("pr7-2222222-dash", 0.4),
      ...previous,
    ]);
    const superseded = planSupersededCleanup(deployments, "pr7-2222222").map(({ name }) => name);
    expect(superseded).toEqual(deleted ? ["pr7-1111111"] : []);
  },
);

test("a deployment the listing does not show yet supersedes nothing", () => {
  expect(planSupersededCleanup(group([worker("pr7-1111111-os", 2)]), "pr7-2222222")).toEqual([]);
});

test.each<{
  rule: string;
  deployment: string;
  createdHoursAgo?: number;
  pullRequest?: PullRequestState;
  openBranches?: string[] | "unknown";
  verdict: "stale" | "keep";
}>(
  // prettier-ignore
  [
    { rule: "1: created 8 days ago, PR open", deployment: "pr7-1111111", createdHoursAgo: 192, pullRequest: "open", verdict: "stale" },
    { rule: "1: created 8 days ago, its branch's PR open", deployment: "fix-foo-1111111", createdHoursAgo: 192, openBranches: ["fix/foo"], verdict: "stale" },
    { rule: "2: PR closed, created an hour ago", deployment: "pr7-1111111", createdHoursAgo: 1, pullRequest: "closed", verdict: "stale" },
    { rule: "2: PR does not exist", deployment: "pr7-1111111", createdHoursAgo: 1, pullRequest: "missing", verdict: "stale" },
    { rule: "PR open, created 6 days ago", deployment: "pr7-1111111", createdHoursAgo: 144, pullRequest: "open", verdict: "keep" },
    { rule: "PR lookup failed, created 6 days ago", deployment: "pr7-1111111", createdHoursAgo: 144, pullRequest: "unknown", verdict: "keep" },
    { rule: "4: no PR, created 25 h ago, no open branch of that name", deployment: "exp-watchdog-1111111", createdHoursAgo: 25, openBranches: ["fix/foo"], verdict: "stale" },
    { rule: "4: no PR, created 23 h ago", deployment: "exp-watchdog-1111111", createdHoursAgo: 23, verdict: "keep" },
    { rule: "4: no PR, created 2 days ago, an open PR's branch slugifies to it", deployment: "fix-foo-1111111", createdHoursAgo: 48, openBranches: ["fix/foo"], verdict: "keep" },
    { rule: "4: no PR, created 2 days ago, open branches unknown", deployment: "fix-foo-1111111", createdHoursAgo: 48, openBranches: "unknown", verdict: "keep" },
    { rule: "4: a CI workflow's own, created 30 h ago", deployment: "main-1111111", createdHoursAgo: 30, verdict: "keep" },
    { rule: "4: a branch's that begins `main-`", deployment: "main-branch-1111111", createdHoursAgo: 30, verdict: "stale" },
    { rule: "1: a CI workflow's own, created 8 days ago", deployment: "real-model-1111111", createdHoursAgo: 192, verdict: "stale" },
  ],
)(
  "which deployments are stale (rules 1, 2 and 4): $rule ⇒ $verdict",
  ({ deployment, createdHoursAgo, pullRequest, openBranches, verdict }) => {
    const plan = planPreviewSweep({
      now: NOW,
      deployments: group([
        createdHoursAgo === undefined
          ? { kind: "kv", name: `${deployment}-os-itx-kv`, id: "k" }
          : worker(`${deployment}-os`, createdHoursAgo),
      ]),
      pullRequestStates: new Map<number, PullRequestState>(pullRequest ? [[7, pullRequest]] : []),
      openPullRequestBranches: openBranches === "unknown" ? undefined : openBranches || [],
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
    openPullRequestBranches: [],
  });
  expect(plan).toMatchObject([
    { deployment: { name: "pr7-1111111" }, verdict: "keep" },
    { deployment: { name: "pr7-2222222" }, verdict: "stale" },
  ]);
});

test.each<{ rule: string; olderHoursAgo?: number; verdict: "stale" | "keep" }>(
  // prettier-ignore
  [
    { rule: "3: an older deployment of an open PR, 2 h old", olderHoursAgo: 2, verdict: "stale" },
    { rule: "3: an older deployment of an open PR with only KV left", verdict: "stale" },
    { rule: "an older deployment of an open PR, half an hour old: the cleanup job's to take", olderHoursAgo: 0.5, verdict: "keep" },
  ],
)(
  "the newest deployment of a prefix stays; an older one goes after an hour: $rule ⇒ $verdict",
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
      openPullRequestBranches: [],
    });
    expect(plan).toMatchObject([
      { deployment: { name: "pr7-2222222" }, verdict: "keep" },
      { deployment: { name: "pr7-1111111" }, verdict },
    ]);
  },
);

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
