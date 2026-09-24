import { describe, expect, test } from "vitest";
import { previewResourceSuffixes, type PreviewResourceKind } from "./preview-config.ts";
import {
  planPreviewSweep,
  supersededMainPreviews,
  type PreviewSweepInput,
  type PullRequestState,
} from "./preview-sweep.ts";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const input = (overrides: Partial<PreviewSweepInput>): PreviewSweepInput => ({
  now: NOW,
  workerNames: ["os-preview", "dash-preview"],
  // older than every resource the tables below stamp, but the legacy slots' (rule 7)
  parentCreatedAt: hoursAgo(1000),
  resourceSuffixes: { kv: ["itx-kv", "oauth-kv"], r2: ["files"], d1: ["db"], artifacts: ["repos"] },
  previews: [],
  resources: [],
  pullRequestStates: new Map(),
  openPullRequestBranches: [],
  ...overrides,
});

test("the suffixes are wrangler's names for the template's KV and R2 bindings, then the D1's and the Artifacts namespace's", () => {
  expect(previewResourceSuffixes()).toEqual({
    kv: ["itx-kv", "oauth-kv"],
    r2: ["files"],
    d1: ["db"],
    artifacts: ["repos"],
  });
});

describe("which previews are stale (rules 1–3)", () => {
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
      { rule: "1: deployed 8 days ago, PR open", preview: "pr7-x", deployedHoursAgo: 192, pullRequest: "open", verdict: "stale" },
      { rule: "1: deployed 8 days ago, its branch's PR open", preview: "fix-foo", deployedHoursAgo: 192, openBranches: ["fix/foo"], verdict: "stale" },
      { rule: "2: PR closed, deployed an hour ago", preview: "pr7-x", deployedHoursAgo: 1, pullRequest: "closed", verdict: "stale" },
      { rule: "2: PR does not exist", preview: "pr7-x", deployedHoursAgo: 1, pullRequest: "missing", verdict: "stale" },
      { rule: "PR open, deployed 6 days ago", preview: "pr7-x", deployedHoursAgo: 144, pullRequest: "open", verdict: "keep" },
      { rule: "PR lookup failed, deployed 6 days ago", preview: "pr7-x", deployedHoursAgo: 144, pullRequest: "unknown", verdict: "keep" },
      { rule: "3: no PR, deployed 25 h ago, no open branch of that name", preview: "exp-watchdog", deployedHoursAgo: 25, openBranches: ["fix/foo"], verdict: "stale" },
      { rule: "3: no PR, deployed 23 h ago", preview: "exp-watchdog", deployedHoursAgo: 23, verdict: "keep" },
      { rule: "3: no PR, deployed 2 days ago, an open PR's branch slugifies to it", preview: "fix-foo", deployedHoursAgo: 48, openBranches: ["fix/foo"], verdict: "keep" },
      { rule: "3: no PR, deployed 2 days ago, open branches unknown", preview: "fix-foo", deployedHoursAgo: 48, openBranches: "unknown", verdict: "keep" },
      { rule: "no deploy stamp", preview: "exp-watchdog", verdict: "keep" },
    ],
  )("$rule ⇒ $verdict", ({ preview, deployedHoursAgo, pullRequest, openBranches, verdict }) => {
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
    expect(plan.previews).toEqual([expect.objectContaining({ name: preview, verdict })]);
  });
});

// Which resources are orphans (rules 4–7): previews soak and pr2847-x are listed, a worker
// os-preview-2 exists, and the parent is 1000 h old.
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
      { rule: "5: a listed preview's KV", kind: "kv", resource: "os-preview-soak-itx-kv", orphanOf: false },
      { rule: "5: a listed preview's R2", kind: "r2", resource: "os-preview-pr2847-x-files", orphanOf: false },
      { rule: "5: a listed preview's D1, a week old", kind: "d1", resource: "os-preview-soak-db", createdHoursAgo: 168, orphanOf: false },
      { rule: "4+5: a gone PR preview's KV", kind: "kv", resource: "os-preview-pr2753-os-next-worker-24fdd3-itx-kv", orphanOf: "pr2753-os-next-worker-24fdd3" },
      { rule: "4+5: a gone hand-named preview's KV", kind: "kv", resource: "os-preview-exp-final-oauth-kv", orphanOf: "exp-final" },
      { rule: "4+5: a gone preview's R2", kind: "r2", resource: "os-preview-dopin-exp-fix-files", orphanOf: "dopin-exp-fix" },
      { rule: "4: the parent's own KV", kind: "kv", resource: "os-preview-itx", orphanOf: false },
      { rule: "4: the parent's own KV", kind: "kv", resource: "os-preview-oauth", orphanOf: false },
      { rule: "4: the parent's own R2", kind: "r2", resource: "os-preview-files", orphanOf: false },
      { rule: "4: the parent's own D1", kind: "d1", resource: "os-preview-directory", createdHoursAgo: 999, orphanOf: false },
      { rule: "4: the parent's own Artifacts namespace", kind: "artifacts", resource: "os-preview-repos", createdHoursAgo: 999, orphanOf: false },
      { rule: "4: a legacy slot's KV, no preview suffix", kind: "kv", resource: "os-preview-3-project-directory", orphanOf: false },
      { rule: "4: a legacy slot's KV", kind: "kv", resource: "IterateDataResources-ProjectDirectory-preqef6upaz5pndf6rhwazvkkd", orphanOf: false },
      { rule: "7: a legacy slot's Artifacts namespace, older than the parent", kind: "artifacts", resource: "os-preview-3-repos", createdHoursAgo: 3000, orphanOf: false },
      { rule: "7: a legacy slot's R2, older than the parent", kind: "r2", resource: "os-preview-3-files", createdHoursAgo: 3000, orphanOf: false },
      { rule: "7: a preview named 3's Artifacts namespace, younger than the parent", kind: "artifacts", resource: "os-preview-3-repos", createdHoursAgo: 25, orphanOf: "3" },
      { rule: "4: another worker's, whose name begins with the parent's", kind: "r2", resource: "os-preview-2-files", orphanOf: false },
      { rule: "4: another worker's, whose name begins with the parent's", kind: "kv", resource: "os-preview-2-pr1-x-itx-kv", orphanOf: false },
      { rule: "4: a KV with the R2 suffix", kind: "kv", resource: "os-preview-exp-final-files", orphanOf: false },
      { rule: "4: an R2 with a KV suffix", kind: "r2", resource: "os-preview-exp-final-itx-kv", orphanOf: false },
      { rule: "4: not a preview name (uppercase)", kind: "r2", resource: "os-preview-Exp-files", orphanOf: false },
      { rule: "4: not a preview name (double hyphen)", kind: "r2", resource: "os-preview-exp--x-files", orphanOf: false },
      { rule: "4: not a preview name (29 characters)", kind: "r2", resource: `os-preview-${"a".repeat(29)}-files`, orphanOf: false },
      { rule: "6: a D1 of a closed PR, an hour old", kind: "d1", resource: "os-preview-pr2846-x-db", createdHoursAgo: 1, pullRequest: "closed", orphanOf: "pr2846-x" },
      { rule: "6: a D1 of a missing PR, an hour old", kind: "d1", resource: "os-preview-pr2846-x-db", createdHoursAgo: 1, pullRequest: "missing", orphanOf: "pr2846-x" },
      { rule: "6: a D1 of an open PR, an hour old (a deploy in flight)", kind: "d1", resource: "os-preview-pr2846-x-db", createdHoursAgo: 1, pullRequest: "open", orphanOf: false },
      { rule: "6: a D1 of an open PR, 25 h old", kind: "d1", resource: "os-preview-pr2846-x-db", createdHoursAgo: 25, pullRequest: "open", orphanOf: "pr2846-x" },
      { rule: "6: a hand-named preview's D1, an hour old", kind: "d1", resource: "os-preview-exp-x-db", createdHoursAgo: 1, orphanOf: false },
      { rule: "6: a hand-named preview's D1, 25 h old", kind: "d1", resource: "os-preview-exp-x-db", createdHoursAgo: 25, orphanOf: "exp-x" },
      { rule: "6: an Artifacts namespace of a closed PR", kind: "artifacts", resource: "os-preview-pr2817-x-repos", createdHoursAgo: 1, pullRequest: "closed", orphanOf: "pr2817-x" },
      { rule: "6: an Artifacts namespace, PR lookup failed, no creation stamp", kind: "artifacts", resource: "os-preview-pr2817-x-repos", pullRequest: "unknown", orphanOf: false },
    ],
)("$rule: $resource ⇒ $orphanOf", ({ kind, resource, createdHoursAgo, pullRequest, orphanOf }) => {
  const plan = planPreviewSweep(
    input({
      workerNames: ["os-preview", "os-preview-2"],
      previews: [
        { name: "soak", lastDeployedAt: hoursAgo(1) },
        { name: "pr2847-x", lastDeployedAt: hoursAgo(1) },
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
    { label: "a legacy slot's Artifacts namespace", kind: "artifacts", resource: "os-preview-3-repos", createdHoursAgo: 3000, orphanOf: false },
    { label: "a legacy slot's R2", kind: "r2", resource: "os-preview-3-files", createdHoursAgo: 3000, orphanOf: false },
    { label: "a gone preview's day-old D1", kind: "d1", resource: "os-preview-exp-x-db", createdHoursAgo: 25, orphanOf: false },
    { label: "a gone preview's KV, which has no stamp (rules 4–6 alone)", kind: "kv", resource: "os-preview-exp-final-itx-kv", orphanOf: "exp-final" },
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
      previews: [{ name: "pr7-x", lastDeployedAt: hoursAgo(1) }],
      resources: [
        { kind: "kv", name: "os-preview-pr7-x-itx-kv", id: "k" },
        { kind: "r2", name: "os-preview-pr7-x-files", id: "os-preview-pr7-x-files" },
      ],
      pullRequestStates: new Map([[7, "closed"]]),
    }),
  );
  expect(plan).toMatchObject({
    previews: [expect.objectContaining({ name: "pr7-x", verdict: "stale" })],
    orphans: [],
  });
});

test.each<[string, string[], string, string[]]>([
  // a cancelled run's leftover goes; the run's own stays
  ["one superseded", ["main-44db0e6", "main-7ea6741"], "main-7ea6741", ["main-44db0e6"]],
  [
    "several",
    ["main-aaaaaaa", "main-bbbbbbb", "main-ccccccc"],
    "main-ccccccc",
    ["main-aaaaaaa", "main-bbbbbbb"],
  ],
  // PR previews and hand-named ones are never main's, even when they begin `main-`
  ["PR and branch previews", ["pr7-x", "main-branch", "main", "soak"], "main-7ea6741", []],
  ["only the run's own", ["main-7ea6741"], "main-7ea6741", []],
])("main's superseded throwaway previews: %s", (_label, names, current, superseded) => {
  expect(supersededMainPreviews(names, current)).toEqual(superseded);
});
