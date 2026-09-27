import { expect, test } from "vitest";
import { PRD_ACCOUNT_ID, PREVIEW_AND_DEV_ACCOUNT_ID } from "../../../envs.ts";
import {
  accountResourceNames,
  accountWorkerNames,
  PREVIEW_PARENT,
  previewResourceSuffixes,
  type PreviewResourceKind,
} from "./preview-config.ts";
import {
  planPreviewSweep,
  renderWorkerlessNamespacesPage,
  workerlessNamespaces,
  type PreviewSweepInput,
  type PullRequestState,
  type SweptResource,
  type SweptWorker,
} from "./preview-sweep.ts";

const NOW = Date.parse("2026-09-23T12:00:00Z");

test("the suffixes are wrangler's names for the template's KV and R2 bindings, then the D1's and the Artifacts namespace's", () => {
  expect(previewResourceSuffixes()).toEqual({
    kv: ["itx-kv", "oauth-kv"],
    r2: ["files"],
    d1: ["db"],
    artifacts: ["repos"],
  });
});

test.each<{
  rule: string;
  preview: string;
  deployedHoursAgo?: number;
  pullRequest?: PullRequestState;
  openBranches?: string[] | "unknown";
  verdict: "stale" | "keep";
}>(
  // prettier-ignore
  [
    { rule: "1: deployed 8 days ago, PR open", preview: "pr7", deployedHoursAgo: 192, pullRequest: "open", verdict: "stale" },
    { rule: "1: deployed 8 days ago, its branch's PR open", preview: "fix-foo", deployedHoursAgo: 192, openBranches: ["fix/foo"], verdict: "stale" },
    { rule: "2: PR closed, deployed an hour ago", preview: "pr7", deployedHoursAgo: 1, pullRequest: "closed", verdict: "stale" },
    { rule: "2: PR does not exist", preview: "pr7", deployedHoursAgo: 1, pullRequest: "missing", verdict: "stale" },
    { rule: "PR open, deployed 6 days ago", preview: "pr7", deployedHoursAgo: 144, pullRequest: "open", verdict: "keep" },
    { rule: "PR lookup failed, deployed 6 days ago", preview: "pr7", deployedHoursAgo: 144, pullRequest: "unknown", verdict: "keep" },
    { rule: "3: no PR, deployed 25 h ago, no open branch of that name", preview: "exp-watchdog", deployedHoursAgo: 25, openBranches: ["fix/foo"], verdict: "stale" },
    { rule: "3: a PR's preview is pr<n>, so pr7-x names none", preview: "pr7-x", deployedHoursAgo: 25, pullRequest: "open", verdict: "stale" },
    { rule: "3: no PR, deployed 23 h ago", preview: "exp-watchdog", deployedHoursAgo: 23, verdict: "keep" },
    { rule: "3: no PR, deployed 2 days ago, an open PR's branch slugifies to it", preview: "fix-foo", deployedHoursAgo: 48, openBranches: ["fix/foo"], verdict: "keep" },
    { rule: "3: no PR, deployed 2 days ago, open branches unknown", preview: "fix-foo", deployedHoursAgo: 48, openBranches: "unknown", verdict: "keep" },
    { rule: "no deploy stamp", preview: "exp-watchdog", verdict: "keep" },
  ],
)(
  "which previews are stale (rules 1–3): $rule ⇒ $verdict",
  ({ preview, deployedHoursAgo, pullRequest, openBranches, verdict }) => {
    const plan = planPreviewSweep(
      input({
        previews: [
          {
            name: preview,
            lastDeployedAt: deployedHoursAgo === undefined ? undefined : hoursAgo(deployedHoursAgo),
          },
        ],
        pullRequestStates: new Map<number, PullRequestState>(pullRequest ? [[7, pullRequest]] : []),
        openPullRequestBranches: openBranches === "unknown" ? undefined : openBranches || [],
      }),
    );
    expect(plan).toMatchObject({ previews: [expect.objectContaining({ name: preview, verdict })] });
  },
);

// A CI workflow's own preview (CI_WORKFLOW_PREVIEWS) is judged by rule 1 alone: kept through quiet
// days, taken once its workflow has stopped deploying it for a week.
test.each<{ preview: string; deployedHoursAgo?: number; verdict: "stale" | "keep" }>(
  // prettier-ignore
  [
    { preview: "main", deployedHoursAgo: 30, verdict: "keep" },
    { preview: "latency", deployedHoursAgo: 144, verdict: "keep" },
    { preview: "real-model", verdict: "keep" },
    { preview: "real-model", deployedHoursAgo: 192, verdict: "stale" },
    // rule 3 still takes a branch preview that begins `main-`, and a workflow's old per-run name
    { preview: "main-branch", deployedHoursAgo: 30, verdict: "stale" },
    { preview: "latency-94096387667921-1", deployedHoursAgo: 30, verdict: "stale" },
  ],
)(
  "a CI workflow's own preview, never judged by rule 3: $preview deployed $deployedHoursAgo h ago ⇒ $verdict",
  ({ preview, deployedHoursAgo, verdict }) => {
    const plan = planPreviewSweep(
      input({
        previews: [
          {
            name: preview,
            lastDeployedAt: deployedHoursAgo === undefined ? undefined : hoursAgo(deployedHoursAgo),
          },
        ],
      }),
    );
    expect(plan).toMatchObject({ previews: [expect.objectContaining({ name: preview, verdict })] });
  },
);

// Which resources are orphans (rules 4–7): previews soak and pr2847 are listed, the former parent
// os-preview still exists, and the parent is 1000 h old.
test.each<{
  rule: string;
  kind: PreviewResourceKind;
  resource: string;
  createdHoursAgo?: number;
  pullRequest?: PullRequestState;
  orphanOf: string | false;
}>(
  // prettier-ignore
  [
      { rule: "5: a listed preview's KV", kind: "kv", resource: "os-soak-itx-kv", orphanOf: false },
      { rule: "5: a listed preview's R2", kind: "r2", resource: "os-pr2847-files", orphanOf: false },
      { rule: "5: a listed preview's D1, a week old", kind: "d1", resource: "os-soak-db", createdHoursAgo: 168, orphanOf: false },
      { rule: "4+5: a gone PR preview's KV", kind: "kv", resource: "os-pr2753-itx-kv", orphanOf: "pr2753" },
      { rule: "4+5: a gone hand-named preview's KV", kind: "kv", resource: "os-exp-final-oauth-kv", orphanOf: "exp-final" },
      { rule: "4+5: a gone preview's R2", kind: "r2", resource: "os-dopin-exp-fix-files", orphanOf: "dopin-exp-fix" },
      { rule: "4: the parent's own KV", kind: "kv", resource: "os-parent-itx", orphanOf: false },
      { rule: "4: the parent's own KV", kind: "kv", resource: "os-parent-oauth", orphanOf: false },
      { rule: "4: the parent's own R2, which reads as preview parent's", kind: "r2", resource: "os-parent-files", createdHoursAgo: 1, orphanOf: false },
      { rule: "4: the parent's own Artifacts namespace, which reads as preview parent's", kind: "artifacts", resource: "os-parent-repos", createdHoursAgo: 25, orphanOf: false },
      { rule: "4: local dev's Artifacts namespace, which reads as preview dev's", kind: "artifacts", resource: "os-dev-repos", createdHoursAgo: 25, orphanOf: false },
      { rule: "4: the parent's own D1, which reads as preview parent's", kind: "d1", resource: "os-parent-db", createdHoursAgo: 25, pullRequest: "missing", orphanOf: false },
      { rule: "4: local dev's D1, which reads as preview dev's", kind: "d1", resource: "os-dev-db", createdHoursAgo: 25, pullRequest: "missing", orphanOf: false },
      { rule: "4: local dev's R2, nothing between the parent and the suffix", kind: "r2", resource: "os-files", createdHoursAgo: 1, orphanOf: false },
      { rule: "4: a D1 without the preview suffix", kind: "d1", resource: "os-directory", createdHoursAgo: 999, orphanOf: false },
      { rule: "4: a legacy slot's KV, no preview suffix", kind: "kv", resource: "os-preview-3-project-directory", orphanOf: false },
      { rule: "4: a legacy slot's KV", kind: "kv", resource: "IterateDataResources-ProjectDirectory-preqef6upaz5pndf6rhwazvkkd", orphanOf: false },
      { rule: "7: an Artifacts namespace older than the parent", kind: "artifacts", resource: "os-3-repos", createdHoursAgo: 3000, orphanOf: false },
      { rule: "7: an R2 older than the parent", kind: "r2", resource: "os-3-files", createdHoursAgo: 3000, orphanOf: false },
      { rule: "7: a preview named 3's Artifacts namespace, younger than the parent", kind: "artifacts", resource: "os-3-repos", createdHoursAgo: 25, orphanOf: "3" },
      { rule: "4: the former parent's own R2, younger than the parent", kind: "r2", resource: "os-preview-files", createdHoursAgo: 1, orphanOf: false },
      { rule: "4: a former parent's preview's KV", kind: "kv", resource: "os-preview-pr1-x-itx-kv", orphanOf: false },
      { rule: "4: a KV with the R2 suffix", kind: "kv", resource: "os-exp-final-files", orphanOf: false },
      { rule: "4: an R2 with a KV suffix", kind: "r2", resource: "os-exp-final-itx-kv", orphanOf: false },
      { rule: "4: not a preview name (uppercase)", kind: "r2", resource: "os-Exp-files", orphanOf: false },
      { rule: "4: not a preview name (double hyphen)", kind: "r2", resource: "os-exp--x-files", orphanOf: false },
      { rule: "4: not a preview name (29 characters)", kind: "r2", resource: `os-${"a".repeat(29)}-files`, orphanOf: false },
      { rule: "6: a D1 of a closed PR, an hour old", kind: "d1", resource: "os-pr2846-db", createdHoursAgo: 1, pullRequest: "closed", orphanOf: "pr2846" },
      { rule: "6: a D1 of a missing PR, an hour old", kind: "d1", resource: "os-pr2846-db", createdHoursAgo: 1, pullRequest: "missing", orphanOf: "pr2846" },
      { rule: "6: a D1 of an open PR, an hour old (a deploy in flight)", kind: "d1", resource: "os-pr2846-db", createdHoursAgo: 1, pullRequest: "open", orphanOf: false },
      { rule: "6: a D1 of an open PR, 25 h old", kind: "d1", resource: "os-pr2846-db", createdHoursAgo: 25, pullRequest: "open", orphanOf: "pr2846" },
      { rule: "6: a hand-named preview's D1, an hour old", kind: "d1", resource: "os-exp-x-db", createdHoursAgo: 1, orphanOf: false },
      { rule: "6: a hand-named preview's D1, 25 h old", kind: "d1", resource: "os-exp-x-db", createdHoursAgo: 25, orphanOf: "exp-x" },
      { rule: "6: an Artifacts namespace of a closed PR", kind: "artifacts", resource: "os-pr2817-repos", createdHoursAgo: 1, pullRequest: "closed", orphanOf: "pr2817" },
      { rule: "6: an Artifacts namespace, PR lookup failed, no creation stamp", kind: "artifacts", resource: "os-pr2817-repos", pullRequest: "unknown", orphanOf: false },
    ],
)("$rule: $resource ⇒ $orphanOf", ({ kind, resource, createdHoursAgo, pullRequest, orphanOf }) => {
  const plan = planPreviewSweep(
    input({
      workers: [{ name: "os", createdAt: hoursAgo(1000) }, { name: "os-preview" }],
      previews: [
        { name: "soak", lastDeployedAt: hoursAgo(1) },
        { name: "pr2847", lastDeployedAt: hoursAgo(1) },
      ],
      resources: [
        {
          kind,
          name: resource,
          id: "id",
          createdAt: createdHoursAgo === undefined ? undefined : hoursAgo(createdHoursAgo),
        },
      ],
      pullRequestStates: new Map<number, PullRequestState>([
        [2847, "open"],
        [2846, pullRequest || "unknown"],
        [2817, pullRequest || "unknown"],
      ]),
    }),
  );
  expect(plan.orphans.map((orphan) => orphan.previewName)).toEqual(orphanOf ? [orphanOf] : []);
});

test.each<{
  label: string;
  kind: PreviewResourceKind;
  resource: string;
  createdHoursAgo?: number;
  orphanOf: string | false;
}>(
  // prettier-ignore
  [
    { label: "an old Artifacts namespace", kind: "artifacts", resource: "os-3-repos", createdHoursAgo: 3000, orphanOf: false },
    { label: "an old R2", kind: "r2", resource: "os-3-files", createdHoursAgo: 3000, orphanOf: false },
    { label: "a gone preview's day-old D1", kind: "d1", resource: "os-exp-x-db", createdHoursAgo: 25, orphanOf: false },
    { label: "a gone preview's KV, which has no stamp (rules 4–6 alone)", kind: "kv", resource: "os-exp-final-itx-kv", orphanOf: "exp-final" },
  ],
)(
  "7: the parent's creation time unknown keeps every stamped resource: $label",
  ({ kind, resource, createdHoursAgo, orphanOf }) => {
    const plan = planPreviewSweep(
      input({
        workers: [{ name: "os" }],
        resources: [
          {
            kind,
            name: resource,
            id: "id",
            createdAt: createdHoursAgo === undefined ? undefined : hoursAgo(createdHoursAgo),
          },
        ],
      }),
    );
    expect(plan.orphans.map((orphan) => orphan.previewName)).toEqual(orphanOf ? [orphanOf] : []);
  },
);

// Rule 0: a former parent's previews go once idle a day, whatever their name or PR, and whether or
// not a preview of `os` has the same name.
test.for<{
  name: string;
  parent: string;
  preview: string;
  deployedHoursAgo?: number;
  verdict: "stale" | "keep";
}>(
  // prettier-ignore
  [
    { name: "a legacy PR-and-branch name, a day idle", parent: "os-preview", preview: "pr3061-worker-bundler", deployedHoursAgo: 25, verdict: "stale" },
    { name: "a CI workflow's name, a day idle", parent: "os-preview", preview: "latency", deployedHoursAgo: 25, verdict: "stale" },
    { name: "the name of a preview of os whose PR is open, a day idle", parent: "os-preview", preview: "pr7", deployedHoursAgo: 25, verdict: "stale" },
    { name: "an app's former parent", parent: "dash-preview", preview: "pr3061-worker-bundler", deployedHoursAgo: 60, verdict: "stale" },
    { name: "deployed 23 h ago", parent: "os-preview", preview: "soak", deployedHoursAgo: 23, verdict: "keep" },
    { name: "last deploy unknown", parent: "kit-preview", preview: "soak", verdict: "keep" },
  ],
)(
  "0: a former parent's preview, $name ⇒ $verdict",
  ({ parent, preview, deployedHoursAgo, verdict }) => {
    const plan = planPreviewSweep(
      input({
        previews: [{ name: "pr7", lastDeployedAt: hoursAgo(1) }],
        formerParentPreviews: [
          {
            parent,
            name: preview,
            lastDeployedAt: deployedHoursAgo === undefined ? undefined : hoursAgo(deployedHoursAgo),
          },
        ],
        pullRequestStates: new Map([[7, "open"]]),
        openPullRequestBranches: ["latency", "soak"],
      }),
    );
    expect(plan).toMatchObject({
      previews: [expect.objectContaining({ name: "pr7", verdict: "keep" })],
      formerParentPreviews: [expect.objectContaining({ parent, name: preview, verdict })],
    });
  },
);

test("5: a stale preview's resources are not orphans — deletePreview takes them with it", () => {
  const plan = planPreviewSweep(
    input({
      previews: [{ name: "pr7", lastDeployedAt: hoursAgo(1) }],
      resources: [
        { kind: "kv", name: "os-pr7-itx-kv", id: "k" },
        { kind: "r2", name: "os-pr7-files", id: "os-pr7-files" },
      ],
      pullRequestStates: new Map([[7, "closed"]]),
    }),
  );
  expect(plan).toMatchObject({
    previews: [expect.objectContaining({ name: "pr7", verdict: "stale" })],
    orphans: [],
  });
});

test("4: once the former parent's worker is gone, nothing under its prefix reads as a preview of os's", () => {
  const plan = planPreviewSweep(
    input({
      resources: [
        { kind: "artifacts", name: "os-preview-1-repos", id: "a", createdAt: hoursAgo(1) },
        { kind: "r2", name: "os-preview-soak-files", id: "b", createdAt: hoursAgo(1) },
        { kind: "kv", name: "os-preview-soak-itx-kv", id: "c" },
      ],
    }),
  );
  expect(plan).toMatchObject({ orphans: [] });
});

// Rule 8: per-commit deployments, each `[name, its members created hours ago, its workers]`. Every
// deployment below has the D1 and R2 bucket apps/os's deploy creates, and the workers named.
test.for<{
  rule: string;
  deployments: [name: string, createdHoursAgo: number | undefined, workers?: string[]][];
  pullRequest?: PullRequestState;
  openBranches?: string[];
  verdicts: Record<string, "stale" | "keep">;
}>(
  // prettier-ignore
  [
    { rule: "an open PR's only deployment", deployments: [["pr7-aaaaaaa", 30]], pullRequest: "open", verdicts: { "pr7-aaaaaaa": "keep" } },
    { rule: "8a: an open PR's newest, 8 days old", deployments: [["pr7-aaaaaaa", 192]], pullRequest: "open", verdicts: { "pr7-aaaaaaa": "stale" } },
    { rule: "8b: its PR closed, an hour old", deployments: [["pr7-aaaaaaa", 1]], pullRequest: "closed", verdicts: { "pr7-aaaaaaa": "stale" } },
    { rule: "8b: its PR does not exist", deployments: [["pr7-aaaaaaa", 1]], pullRequest: "missing", verdicts: { "pr7-aaaaaaa": "stale" } },
    { rule: "8c: an open PR's earlier commit, 2 h old", deployments: [["pr7-aaaaaaa", 3], ["pr7-bbbbbbb", 2]], pullRequest: "open", verdicts: { "pr7-aaaaaaa": "stale", "pr7-bbbbbbb": "keep" } },
    { rule: "8c: an earlier commit, PR lookup failed", deployments: [["pr7-aaaaaaa", 3], ["pr7-bbbbbbb", 2]], pullRequest: "unknown", verdicts: { "pr7-aaaaaaa": "stale", "pr7-bbbbbbb": "keep" } },
    { rule: "8c: an earlier commit under an hour old", deployments: [["pr7-aaaaaaa", 0.5], ["pr7-bbbbbbb", 0.2]], pullRequest: "open", verdicts: { "pr7-aaaaaaa": "keep", "pr7-bbbbbbb": "keep" } },
    { rule: "8c: a later push in flight, apps/os not uploaded yet", deployments: [["pr7-aaaaaaa", 3], ["pr7-bbbbbbb", 0.2, ["dash"]]], pullRequest: "open", verdicts: { "pr7-aaaaaaa": "keep", "pr7-bbbbbbb": "keep" } },
    { rule: "8c: a later push that failed before apps/os", deployments: [["pr7-aaaaaaa", 3], ["pr7-bbbbbbb", 2, []]], pullRequest: "open", verdicts: { "pr7-aaaaaaa": "keep", "pr7-bbbbbbb": "stale" } },
    { rule: "8c: a leftover with no stamped member", deployments: [["pr7-aaaaaaa", undefined]], pullRequest: "open", verdicts: { "pr7-aaaaaaa": "stale" } },
    { rule: "Main OS e2e's newest, a quiet day", deployments: [["main-aaaaaaa", 50], ["main-bbbbbbb", 30]], verdicts: { "main-aaaaaaa": "stale", "main-bbbbbbb": "keep" } },
    { rule: "8d: a hand-named prefix idle a day", deployments: [["exp-x-aaaaaaa", 25]], verdicts: { "exp-x-aaaaaaa": "stale" } },
    { rule: "8d: a hand-named prefix an open PR's branch slugifies to", deployments: [["exp-x-aaaaaaa", 25]], openBranches: ["exp/x"], verdicts: { "exp-x-aaaaaaa": "keep" } },
    { rule: "8d: a hand-named prefix, 23 h old", deployments: [["exp-x-aaaaaaa", 23]], verdicts: { "exp-x-aaaaaaa": "keep" } },
  ],
)("8: $rule", ({ deployments, pullRequest, openBranches, verdicts }) => {
  const plan = planPreviewSweep(
    input({
      workers: [
        { name: "os", createdAt: hoursAgo(1000) },
        ...deployments.flatMap(([name, createdHoursAgo, workers = ["os", "dash"]]) =>
          workers.map((worker): SweptWorker => ({
            name: `${name}-${worker}`,
            createdAt: stamp(createdHoursAgo),
          })),
        ),
      ],
      resources: deployments.flatMap(([name, createdHoursAgo]): SweptResource[] => [
        { kind: "d1", name: `${name}-os-db`, id: `${name}-db`, createdAt: stamp(createdHoursAgo) },
        { kind: "kv", name: `${name}-os-itx-kv`, id: `${name}-kv` },
        {
          kind: "r2",
          name: `${name}-os-files`,
          id: `${name}-os-files`,
          createdAt: stamp(createdHoursAgo),
        },
      ]),
      pullRequestStates: new Map<number, PullRequestState>(pullRequest ? [[7, pullRequest]] : []),
      openPullRequestBranches: openBranches || [],
    }),
  );
  expect(Object.fromEntries(plan.deployments.map(({ name, verdict }) => [name, verdict]))).toEqual(
    verdicts,
  );
  // a deployment's resources are its own, never rule 4's orphans
  expect(plan).toMatchObject({ orphans: [] });
});

test("8: a deployment is every worker and resource of its name, and nothing else is one", () => {
  const plan = planPreviewSweep(
    input({
      workers: [
        { name: "os", createdAt: hoursAgo(1000) },
        ...["os", "dash", "agents", "notes", "admin", "voice", "kit"].map((app) => ({
          name: `pr7-aaaaaaa-${app}`,
          createdAt: hoursAgo(2),
        })),
        ...["ci-reports", "iterate-spa-preview", "do-alarm-held-repro", "iterate"].map((name) => ({
          name,
        })),
      ],
      resources: [
        { kind: "kv", name: "pr7-aaaaaaa-os-itx-kv", id: "k1" },
        { kind: "kv", name: "pr7-aaaaaaa-os-oauth-kv", id: "k2" },
        { kind: "r2", name: "pr7-aaaaaaa-os-files", id: "pr7-aaaaaaa-os-files" },
        { kind: "d1", name: "pr7-aaaaaaa-os-db", id: "d" },
        { kind: "artifacts", name: "pr7-aaaaaaa-os-repos", id: "pr7-aaaaaaa-os-repos" },
        // a Worker Preview's, and names of other shapes
        { kind: "r2", name: "os-pr7-files", id: "os-pr7-files" },
        { kind: "r2", name: "pr7-aaaaaaa-dash-files", id: "pr7-aaaaaaa-dash-files" },
        { kind: "r2", name: "pr7-aaaaaa-os-files", id: "pr7-aaaaaa-os-files" },
      ],
      pullRequestStates: new Map([[7, "closed"]]),
    }),
  );
  expect(plan).toMatchObject({
    deployments: [
      {
        name: "pr7-aaaaaaa",
        prefix: "pr7",
        verdict: "stale",
        reason: "PR #7 is closed",
        workers: ["os", "dash", "agents", "notes", "admin", "voice", "kit"].map((app) => ({
          name: `pr7-aaaaaaa-${app}`,
        })),
        resources: ["os-itx-kv", "os-oauth-kv", "os-files", "os-db", "os-repos"].map((suffix) => ({
          name: `pr7-aaaaaaa-${suffix}`,
        })),
      },
    ],
    // the Worker Preview's is rule 4's; the other two shapes are nobody's
    orphans: [{ name: "os-pr7-files", previewName: "pr7" }],
  });
});

// Rule 9: a former parent with no preview left goes, with everything under its name but a legacy
// slot's.
const OS_PREVIEW_RESOURCES: SweptResource[] = [
  { kind: "kv", name: "os-preview-itx", id: "k1" },
  { kind: "kv", name: "os-preview-oauth", id: "k2" },
  { kind: "r2", name: "os-preview-files", id: "os-preview-files", createdAt: hoursAgo(100) },
  { kind: "artifacts", name: "os-preview-repos", id: "os-preview-repos", createdAt: hoursAgo(100) },
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
const NOT_OS_PREVIEWS: SweptResource[] = [
  // the legacy platform's slots, and a name of no suffix of its kind
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
  // os's own and its previews'
  { kind: "r2", name: "os-parent-files", id: "os-parent-files", createdAt: hoursAgo(90) },
  { kind: "r2", name: "os-pr7-files", id: "os-pr7-files", createdAt: hoursAgo(1) },
];

test.for<{
  rule: string;
  workers: string[];
  previewsLeft: string[];
  expected: { name: string; worker: boolean; verdict: "stale" | "keep" }[];
}>(
  // prettier-ignore
  [
    { rule: "no preview left: the worker and everything under its name go", workers: ["os", "os-preview"], previewsLeft: [], expected: [{ name: "os-preview", worker: true, verdict: "stale" }] },
    { rule: "a preview left: rule 0 first", workers: ["os", "os-preview"], previewsLeft: ["soak"], expected: [{ name: "os-preview", worker: true, verdict: "keep" }] },
    { rule: "the worker gone, its resources left: tried again", workers: ["os"], previewsLeft: [], expected: [{ name: "os-preview", worker: false, verdict: "stale" }] },
    { rule: "an app's former parent, which has no resources", workers: ["os", "os-preview", "dash-preview"], previewsLeft: [], expected: [{ name: "os-preview", worker: true, verdict: "stale" }, { name: "dash-preview", worker: true, verdict: "stale" }] },
  ],
)("9: a former parent, $rule", ({ workers, previewsLeft, expected }) => {
  const plan = planPreviewSweep(
    input({
      workers: workers.map((name) => ({ name, createdAt: hoursAgo(name === "os" ? 80 : 120) })),
      formerParentPreviews: previewsLeft.map((name) => ({
        parent: "os-preview",
        name,
        lastDeployedAt: hoursAgo(1),
      })),
      previews: [{ name: "pr7", lastDeployedAt: hoursAgo(1) }],
      pullRequestStates: new Map([[7, "open"]]),
      resources: [...OS_PREVIEW_RESOURCES, ...NOT_OS_PREVIEWS],
    }),
  );
  expect(plan).toMatchObject({
    formerParents: expected.map((parent) => ({
      ...parent,
      resources: parent.name === "os-preview" ? OS_PREVIEW_RESOURCES : [],
    })),
    orphans: [],
  });
});

test("9: a former parent envs.ts deploys again, and a resource the account has for something else, are never rule 9's", () => {
  const plan = planPreviewSweep(
    input({
      workers: [
        { name: "os", createdAt: hoursAgo(1000) },
        { name: "os-preview" },
        { name: "dash-preview" },
      ],
      deployedWorkerNames: new Set([...accountWorkerNames(), "dash-preview"]),
      accountResourceNames: new Set([...accountResourceNames(), "os-preview-files"]),
      resources: OS_PREVIEW_RESOURCES,
    }),
  );
  expect(plan).toMatchObject({
    formerParents: [
      {
        name: "os-preview",
        resources: OS_PREVIEW_RESOURCES.filter(({ name }) => name !== "os-preview-files"),
      },
    ],
  });
});

test("10: only a preview's worker is ever deleted; the ones envs.ts does not name are listed", () => {
  const plan = planPreviewSweep(
    input({
      workers: [
        ...accountWorkerNames(),
        "os-preview",
        "pr7-aaaaaaa-os",
        "iterate",
        "do-alarm-held-repro",
        "captun",
      ].map((name) => ({ name, createdAt: hoursAgo(200) })),
      pullRequestStates: new Map([[7, "closed"]]),
    }),
  );
  expect(plan).toMatchObject({ unmappedWorkers: ["iterate", "do-alarm-held-repro", "captun"] });
  const deleted = [
    ...plan.deployments
      .filter(({ verdict }) => verdict === "stale")
      .flatMap(({ workers }) => workers),
    ...plan.formerParents.filter(({ verdict }) => verdict === "stale"),
  ].map(({ name }) => name);
  expect(deleted).toEqual(["pr7-aaaaaaa-os", "os-preview"]);
});

test("the sweep deletes on the dev/preview account, and envs.ts's workers there are the parents and CI's", () => {
  expect(PREVIEW_PARENT).toMatchObject({ cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID });
  expect(PREVIEW_AND_DEV_ACCOUNT_ID).not.toBe(PRD_ACCOUNT_ID);
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

test("11: a Durable Object namespace whose worker is gone is paged with its id, what to escalate, and the run", () => {
  const namespaces = [
    { id: "n1", name: "os_ProjectDurableObject", script: "os" },
    { id: "n2", name: "os-preview_ProjectDurableObject", script: "os-preview" },
    { id: "n3", name: "os_pr7_ProjectDurableObject", script: "os" },
    { id: "n4", name: "LegacyDurableObject" },
  ];
  const workerless = workerlessNamespaces(namespaces, [{ name: "os" }, { name: "dash" }]);
  expect(workerless.map(({ id }) => id)).toEqual(["n2", "n4"]);
  expect(
    renderWorkerlessNamespacesPage(workerless, "https://depot.dev/orgs/x/workflows/y").split("\n"),
  ).toEqual([
    "🚨 preview sweep: 2 Durable Object namespace(s) outlived their worker <@U067G4QRFK2>",
    "• os-preview_ProjectDurableObject (n2), worker os-preview",
    "• LegacyDurableObject (n4), worker unnamed",
    "A Cloudflare fault, not a commit's: a worker's delete takes its namespaces, and the API deletes no namespace alone. Each counts toward the account's 500: escalate them to Cloudflare with these ids. The sweep checks again each night.",
    "<https://depot.dev/orgs/x/workflows/y|sweep run>",
  ]);
});

// declarations, hoisted: the rule 9 table's rows are stamped when the module loads
function hoursAgo(hours: number) {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

function stamp(hours: number | undefined) {
  return hours === undefined ? undefined : hoursAgo(hours);
}

const input = (overrides: Partial<PreviewSweepInput>): PreviewSweepInput => ({
  now: NOW,
  // the parent older than every resource the tables below stamp, but the legacy slots' (rule 7)
  workers: [{ name: "os", createdAt: hoursAgo(1000) }, { name: "dash" }],
  deployedWorkerNames: accountWorkerNames(),
  accountResourceNames: accountResourceNames(),
  resourceSuffixes: { kv: ["itx-kv", "oauth-kv"], r2: ["files"], d1: ["db"], artifacts: ["repos"] },
  previews: [],
  formerParentPreviews: [],
  resources: [],
  pullRequestStates: new Map(),
  openPullRequestBranches: [],
  ...overrides,
});
