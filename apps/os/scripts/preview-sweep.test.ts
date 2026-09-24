import { expect, test } from "vitest";
import {
  accountResourceNames,
  previewResourceSuffixes,
  type PreviewResourceKind,
} from "./preview-config.ts";
import {
  planPreviewSweep,
  type PreviewSweepInput,
  type PullRequestState,
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
      workerNames: ["os", "os-preview"],
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
        parentCreatedAt: undefined,
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

const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const input = (overrides: Partial<PreviewSweepInput>): PreviewSweepInput => ({
  now: NOW,
  workerNames: ["os", "dash"],
  accountResourceNames: accountResourceNames(),
  // older than every resource the tables below stamp, but the legacy slots' (rule 7)
  parentCreatedAt: hoursAgo(1000),
  resourceSuffixes: { kv: ["itx-kv", "oauth-kv"], r2: ["files"], d1: ["db"], artifacts: ["repos"] },
  previews: [],
  resources: [],
  pullRequestStates: new Map(),
  openPullRequestBranches: [],
  ...overrides,
});
