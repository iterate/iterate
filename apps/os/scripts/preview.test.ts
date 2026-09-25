import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { osEnvs, PREVIEW_DEPLOYMENT_APPS, previewDeployment } from "../../../envs.ts";
import { viteWranglerConfig } from "./generate-wrangler-config.ts";
import {
  APPS,
  assertFreshInstall,
  configTemplateNames,
  deployWithStatus,
  lastLines,
  MAX_PREVIEW_PREFIX_LENGTH,
  previewDeploymentName,
  previewDeploymentUrls,
  previewPullRequestNumber,
  renderPreviewStatus,
  renderPullRequestSection,
  resolvePreviewPrefix,
  slugifyPreviewName,
  splicePreviewStatus,
  splicePreviewSuite,
  splicePullRequestBody,
  suiteLineMayBeOverwritten,
  templateQuickLaunches,
  type PreviewStatus,
  type PreviewSuiteStatus,
} from "./preview-config.ts";

test.each([
  ["feature/foo", "123", "pr123"],
  [undefined, "123", "pr123"],
  ["feature/foo", "", "feature-foo"],
  ["Feature_Foo", undefined, "feature-foo"],
  ["main", undefined, "main"],
  ["real-model", undefined, "real-model"],
])("a deployment's prefix: %s with PR %s → %s", (name, prNumber, expected) => {
  expect(resolvePreviewPrefix({ name, prNumber })).toBe(expected);
});

test("a deployment's prefix: a long one is truncated with a stable hash, inside the limit", () => {
  const prefix = resolvePreviewPrefix({
    name: "jonas/os-worker-previews-with-a-very-long-descriptive-branch-name",
  });
  expect(prefix.length).toBeLessThanOrEqual(MAX_PREVIEW_PREFIX_LENGTH);
  expect(prefix).toMatch(/^jonas-os-worker-[a-z0-9-]+-[0-9a-f]{6}$/);
  expect(slugifyPreviewName("a".repeat(40))).not.toBe(slugifyPreviewName("a".repeat(41)));
  expect(() => resolvePreviewPrefix({})).toThrow("a deployment needs a PR number (--pr) or a name");
});

test("a deployment's name is its prefix and the tested commit's first 7 digits: a new commit, a new set of workers", () => {
  const commit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  expect(previewDeploymentName("pr3144", commit)).toBe("pr3144-a1b2c3d");
  expect(previewDeploymentName("real-model", commit)).toBe("real-model-a1b2c3d");
  // the longest prefix still names every worker and resource under Cloudflare's 63 characters
  const longest = previewDeploymentName("a".repeat(MAX_PREVIEW_PREFIX_LENGTH), commit);
  expect(`${longest}-os-oauth-kv`.length).toBeLessThanOrEqual(63);
  expect(() => previewDeploymentName("pr3144", "not-a-commit")).toThrow(
    "pr3144-not-a-c is not a deployment name",
  );
});

test("a deployment is derived from its name alone: seven plain workers on the dev/preview account, apps/os's resources named after its worker", () => {
  expect(previewDeployment("pr3144-a1b2c3d")).toMatchObject({
    prefix: "pr3144",
    sha: "a1b2c3d",
    os: {
      workerName: "pr3144-a1b2c3d-os",
      baseUrl: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
      mcpBaseUrl: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev/mcp",
      dashBaseUrl: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      dopplerConfig: "preview",
      ingressRouting: { type: "paths" },
      testLinks: true,
      artifactsNamespace: "pr3144-a1b2c3d-os-repos",
      resourceNamePrefix: "pr3144-a1b2c3d-os",
    },
  });
  expect(previewDeploymentUrls("pr3144-a1b2c3d")).toEqual({
    os: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
    apps: {
      dash: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      agents: "https://pr3144-a1b2c3d-agents.iterate-dev-preview.workers.dev",
      notes: "https://pr3144-a1b2c3d-notes.iterate-dev-preview.workers.dev",
      admin: "https://pr3144-a1b2c3d-admin.iterate-dev-preview.workers.dev",
      voice: "https://pr3144-a1b2c3d-voice.iterate-dev-preview.workers.dev",
      kit: "https://pr3144-a1b2c3d-kit.iterate-dev-preview.workers.dev",
    },
  });
  // the envs.ts deployments, main on dev's workers and a bare prefix are none
  for (const name of ["preview", "prd", "os", "pr3144", "self-host"])
    expect(previewDeployment(name)).toBeUndefined();
});

test("the apps on top are the deployment's six clients", () => {
  expect(APPS.map((app) => app.name).toSorted()).toEqual([...PREVIEW_DEPLOYMENT_APPS].toSorted());
});

test("a deployment's prefix: a PR's number reads back out of it; any other prefix has none", () => {
  expect(previewPullRequestNumber("pr123")).toBe(123);
  expect(previewPullRequestNumber("pr123-feature-foo")).toBeUndefined();
  expect(previewPullRequestNumber("feature-foo")).toBeUndefined();
  expect(previewPullRequestNumber("pr-foo")).toBeUndefined();
});

const JOB = "https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a";
const DASH = "https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev";
const deployed: PreviewStatus = {
  state: "deployed",
  commit: "ccccccccc0123456789",
  runUrl: JOB,
  at: new Date("2026-09-24T10:32:17Z"),
};

const section = renderPullRequestSection({
  deployment: "pr123-ccccccc",
  status: deployed,
  url: "https://pr123-ccccccc-os.iterate-dev-preview.workers.dev",
  versionId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
  dashboardUrl: "https://dash.cloudflare.com/x",
  apps: [
    {
      name: "dash",
      url: "https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev",
    },
  ],
});

test("the PR body's managed section: names the URL, the version, the apps on top, and where the operations are", () => {
  expect(section).toContain("https://pr123-ccccccc-os.iterate-dev-preview.workers.dev");
  expect(section).toContain("version `bd68a9bb`");
  expect(section).toContain(
    "| dash | https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev |",
  );
  expect(section).toContain("https://github.com/iterate/iterate/blob/main/apps/os/README.md");
  expect(section).not.toContain("depot ci dispatch");
  expect(section).not.toContain("Deployed from");
});

test("the PR body's managed section: names the commit the run deployed when the workflow resolved one; e2e is the status line's", () => {
  const withCommit = renderPullRequestSection({
    deployment: "pr123-ccccccc",
    status: deployed,
    url: "https://pr123-ccccccc-os.iterate-dev-preview.workers.dev",
    versionId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
    dashboardUrl: "https://dash.cloudflare.com/x",
    apps: [],
    testedCommit:
      "the merge commit `ccccccccc`: this PR's head `bbbbbbbbb` merged into main at `aaaaaaaaa`",
  });
  expect(withCommit).toContain(
    "Deployed from the merge commit `ccccccccc`: this PR's head `bbbbbbbbb` merged into main at `aaaaaaaaa`.",
  );
  expect(withCommit).not.toContain("tested");
});

test("the PR body's managed section: on a PR the heading, every app and every config template carry a one-click `Sign in ↗`, and the section says as whom", () => {
  const dash = "https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev";
  const notes = "https://pr123-ccccccc-notes.iterate-dev-preview.workers.dev";
  const os = "https://pr123-ccccccc-os.iterate-dev-preview.workers.dev";
  const signIn = {
    heading: `${os}/.auth/test-link?t=heading`,
    apps: { dash: `${os}/.auth/test-link?t=dash`, notes: `${os}/.auth/test-link?t=notes` },
    templates: [
      { name: "default", link: `${os}/.auth/test-link?t=default`, fromHead: "bbbbbbbbb0123456" },
      { name: "with-agents", link: `${os}/.auth/test-link?t=with-agents` },
    ],
    email: "pr123@preview.iterate.test",
    project: "pr123",
    seeded: true,
  };
  const render = (seeded: boolean) =>
    renderPullRequestSection({
      deployment: "pr123-ccccccc",
      status: deployed,
      url: os,
      versionId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
      dashboardUrl: "https://dash.cloudflare.com/x",
      apps: [
        { name: "dash", url: dash },
        { name: "notes", url: notes },
      ],
      signIn: { ...signIn, seeded },
    });
  expect(render(true)).toMatchInlineSnapshot(`
    "### OS preview: \`pr123-ccccccc\`

    <!-- os-preview-status:begin -->
    Status: **deployed** on \`ccccccccc\` · [CI job ↗](https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a) · updated 2026-09-24 10:32 UTC
    <!-- os-preview-status:end -->

    **https://pr123-ccccccc-os.iterate-dev-preview.workers.dev** · [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=heading) · version \`bd68a9bb\` · [Cloudflare dashboard](https://dash.cloudflare.com/x) · deleted once the next push's deployment is ready, or when this PR closes

    | App on top, signed in against this deployment | | |
    | --- | --- | --- |
    | dash | https://pr123-ccccccc-dash.iterate-dev-preview.workers.dev | [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=dash) |
    | notes | https://pr123-ccccccc-notes.iterate-dev-preview.workers.dev | [Sign in ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=notes) |

    New project from template: [default at this PR's \`bbbbbbbbb\` ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=default) · [with-agents ↗](https://pr123-ccccccc-os.iterate-dev-preview.workers.dev/.auth/test-link?t=with-agents)

    \`Sign in ↗\` signs you in as \`pr123@preview.iterate.test\` with project \`pr123\`, no password and no Allow page: the link is signed for this deployment only and expires in 14 days; every push mints a fresh one.

    Every push deploys a fresh set of workers, with data of its own. E2e, delete and the laptop commands: [apps/os/README.md](https://github.com/iterate/iterate/blob/main/apps/os/README.md)."
  `);
  expect(render(false)).toContain(
    "Seeding `pr123` failed this run (the deploy log says why), so the apps ask for consent.",
  );
  expect(section).not.toContain("Sign in");
});

test("the PR body's managed section: appends to a body without one, keeping the author's text", () => {
  const body = splicePullRequestBody("What this PR does.\n", section);
  expect(body.startsWith("What this PR does.\n\n<!-- os-preview:begin -->\n")).toBe(true);
  expect(body.endsWith("\n<!-- os-preview:end -->\n")).toBe(true);
});

test("the PR body's managed section: replaces an existing section in place, and only that", () => {
  const before = `Intro.\n\n<!-- os-preview:begin -->\nold\n<!-- os-preview:end -->\n\nOutro.\n`;
  const after = splicePullRequestBody(before, "new");
  expect(after).toBe(
    `Intro.\n\n<!-- os-preview:begin -->\nnew\n<!-- os-preview:end -->\n\nOutro.\n`,
  );
  expect(splicePullRequestBody(after, "newer")).not.toContain("new\n<!--");
});

test("the PR body's managed section: an empty body becomes just the section", () => {
  expect(splicePullRequestBody("", "s")).toBe(
    "<!-- os-preview:begin -->\ns\n<!-- os-preview:end -->\n",
  );
});

// ── the status line, nested in the managed section ──

test.for<{
  name: string;
  status: Partial<PreviewStatus> | Pick<PreviewSuiteStatus, "suite" | "state" | "error">;
  expected: string;
}>([
  {
    name: "deploying",
    status: { state: "deploying" },
    expected: `Status: **deploying** on \`ccccccccc\` · [CI job ↗](${JOB}) · updated 2026-09-24 10:32 UTC`,
  },
  {
    name: "deployed",
    status: { state: "deployed" },
    expected: `Status: **deployed** on \`ccccccccc\` · [CI job ↗](${JOB}) · updated 2026-09-24 10:32 UTC`,
  },
  {
    name: "a suite's line names the suite by its check",
    status: { suite: "e2e", state: "passed" },
    expected: `E2E tests: **passed** on \`ccccccccc\` · [CI job ↗](${JOB}) · updated 2026-09-24 10:32 UTC`,
  },
  {
    name: "a failed suite",
    status: { suite: "specs", state: "failed" },
    expected: `Browser specs: **failed** on \`ccccccccc\` · [CI job ↗](${JOB}) · updated 2026-09-24 10:32 UTC`,
  },
  {
    name: "from a laptop there is no CI job to link",
    status: { state: "deploying", runUrl: undefined },
    expected: "Status: **deploying** on `ccccccccc` · updated 2026-09-24 10:32 UTC",
  },
  {
    name: "deploy failed: the summary, the output's tail folded, the links below called the last good deploy's",
    status: {
      state: "deploy failed",
      error: `wrangler preview failed with exit code 1\n\x1b[31m${numberedLines(1, 60)}\x1b[0m`,
    },
    expected: [
      `Status: **deploy failed** on \`ccccccccc\` · [CI job ↗](${JOB}) · updated 2026-09-24 10:32 UTC`,
      "",
      "The links below, if any, are the last successful deploy's.",
      "",
      "`wrangler preview failed with exit code 1`",
      "",
      "<details><summary>Error output (tail)</summary>",
      "",
      "```",
      numberedLines(21, 60),
      "```",
      "",
      "</details>",
    ].join("\n"),
  },
  {
    name: "a fence in the output gets a longer fence; a backtick in the summary cannot close its code span",
    status: { suite: "specs", state: "failed", error: "`build` failed\n```\nsyntax error\n```" },
    expected: [
      `Browser specs: **failed** on \`ccccccccc\` · [CI job ↗](${JOB}) · updated 2026-09-24 10:32 UTC`,
      "",
      "`'build' failed`",
      "",
      "<details><summary>Error output (tail)</summary>",
      "",
      "````",
      "```\nsyntax error\n```",
      "````",
      "",
      "</details>",
    ].join("\n"),
  },
])("the status line: $name", ({ status, expected }) => {
  // The fixture's fields are one type's or the other's; the spread picks by `suite`.
  expect(renderPreviewStatus({ ...deployed, ...status } as PreviewStatus)).toBe(expected);
});

test("the status splice rewrites the status line alone: the author's text and the rest of the section stay byte for byte", () => {
  const author = "What this PR does.\n\n";
  const outro = "\n\nReviewer notes below.\n";
  const body = `${author}${splicePullRequestBody("", deployedSection()).trimEnd()}${outro}`;
  const after = splicePreviewStatus(body, { ...deployed, state: "deploy failed", error: "boom" });
  const statusBlock = /<!-- os-preview-status:begin -->[\s\S]*?<!-- os-preview-status:end -->/;
  expect(after.replace(statusBlock, "")).toBe(body.replace(statusBlock, ""));
  expect(after).toContain(
    `<!-- os-preview-status:begin -->\nStatus: **deploy failed** on \`ccccccccc\` · [CI job ↗](${JOB}) · updated 2026-09-24 10:32 UTC\n\nThe links below, if any, are the last successful deploy's.\n\n\`boom\`\n<!-- os-preview-status:end -->`,
  );
  expect(after).not.toContain("**deployed**");
  expect(splicePreviewStatus(after, deployed)).toBe(body);
});

test("the status splice puts a status line at the top of a section written without one", () => {
  const before = "Intro.\n\n<!-- os-preview:begin -->\nold\n<!-- os-preview:end -->\n";
  expect(splicePreviewStatus(before, { ...deployed, runUrl: undefined })).toBe(
    "Intro.\n\n<!-- os-preview:begin -->\n<!-- os-preview-status:begin -->\nStatus: **deployed** on `ccccccccc` · updated 2026-09-24 10:32 UTC\n<!-- os-preview-status:end -->\nold\n<!-- os-preview:end -->\n",
  );
});

test("the status splice makes a body without a section (the first deploy failed) the status line alone", () => {
  expect(
    splicePreviewStatus("What this PR does.", {
      ...deployed,
      state: "deploying",
      runUrl: undefined,
    }),
  ).toBe(
    "What this PR does.\n\n<!-- os-preview:begin -->\n<!-- os-preview-status:begin -->\nStatus: **deploying** on `ccccccccc` · updated 2026-09-24 10:32 UTC\n<!-- os-preview-status:end -->\n<!-- os-preview:end -->\n",
  );
});

// ── each suite's line, under the status line ──

test("the two suites' jobs write their own lines, in either order, under the status line: E2E tests first", () => {
  const body = `Intro.\n\n${splicePullRequestBody("", deployedSection())}`;
  const write = (
    text: string,
    suite: PreviewSuiteStatus["suite"],
    state: PreviewSuiteStatus["state"],
  ) => splicePreviewSuite(text, { ...deployed, runUrl: undefined, suite, state });
  const expected = body.replace(
    "<!-- os-preview-status:end -->",
    `<!-- os-preview-status:end -->\n${suiteLine("e2e", "passed")}\n${suiteLine("specs", "failed")}`,
  );
  expect(write(write(body, "e2e", "passed"), "specs", "failed")).toBe(expected);
  expect(write(write(body, "specs", "failed"), "e2e", "passed")).toBe(expected);
  // a suite's rerun rewrites its line alone
  expect(write(expected, "specs", "passed")).toBe(
    expected.replace(suiteLine("specs", "failed"), suiteLine("specs", "passed")),
  );
  // a new deploy drops both, which were the previous deploy's; its later writes keep that
  const deploying = splicePreviewStatus(expected, { ...deployed, state: "deploying" });
  expect(deploying).not.toContain("os-preview-e2e");
  expect(deploying).not.toContain("os-preview-specs");
  expect(splicePreviewStatus(deploying, deployed)).toBe(body);
});

// Both suites' jobs write at once. Only the first to finish, which finds no line of the other for
// its commit, waits to look again; the second finds the first's and writes over nothing.
test("a suite's line may be overwritten until the other suite's line names the same commit", () => {
  const e2e = { ...deployed, runUrl: undefined, suite: "e2e" as const, state: "passed" as const };
  const body = `Intro.\n\n${splicePullRequestBody("", deployedSection())}`;
  expect(suiteLineMayBeOverwritten(splicePreviewSuite(body, e2e), e2e)).toBe(true);
  const withSpecs = splicePreviewSuite(body, { ...e2e, suite: "specs", state: "failed" });
  expect(suiteLineMayBeOverwritten(splicePreviewSuite(withSpecs, e2e), e2e)).toBe(false);
  // the other suite's line from an earlier commit is an earlier run's: its job may still write
  const olderSpecs = splicePreviewSuite(body, {
    ...e2e,
    suite: "specs",
    commit: "ddddddddd0123",
  });
  expect(suiteLineMayBeOverwritten(splicePreviewSuite(olderSpecs, e2e), e2e)).toBe(true);
});

test("a suite's line without a status line goes at the top of the section, or is the section", () => {
  expect(
    splicePreviewSuite("Intro.\n\n<!-- os-preview:begin -->\nold\n<!-- os-preview:end -->\n", {
      ...deployed,
      runUrl: undefined,
      suite: "e2e",
      state: "passed",
    }),
  ).toBe(
    `Intro.\n\n<!-- os-preview:begin -->\n${suiteLine("e2e", "passed")}\nold\n<!-- os-preview:end -->\n`,
  );
  expect(suiteLine("specs", "passed")).toBe(
    "<!-- os-preview-specs:begin -->\nBrowser specs: **passed** on `ccccccccc` · updated 2026-09-24 10:32 UTC\n<!-- os-preview-specs:end -->",
  );
});

test("the deploy's status writes: `deploy failed` goes out only once `deploying` has landed, whenever the steps throw (the PR body's last write wins)", async () => {
  const { events, write, release } = recordedStatusWrites();
  const failure = new Error("wrangler preview failed with exit code 1");
  const deploy = deployWithStatus(write, async () => {
    events.push("steps");
    throw failure;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(events).toEqual(["write deploying", "steps"]);
  release();
  await expect(deploy).rejects.toBe(failure);
  expect(events).toEqual([
    "write deploying",
    "steps",
    "landed deploying",
    "write deploy failed",
    "landed deploy failed",
  ]);
});

test("the deploy's status writes: the steps run beside the `deploying` write and are handed it, so their section lands after it", async () => {
  const { events, write, release } = recordedStatusWrites();
  const deploy = deployWithStatus(write, async (deploying) => {
    events.push("steps");
    await deploying;
    events.push("section");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(events).toEqual(["write deploying", "steps"]);
  release();
  await deploy;
  expect(events).toEqual(["write deploying", "steps", "landed deploying", "section"]);
});

test("lastLines keeps the tail and strips colour codes", () => {
  expect(lastLines("a\nb\n\x1b[1;31mc\x1b[0m\n\n", 2)).toBe("b\nc");
});

// ── template quick-launch links: the Dash's New project sheet, one click ──

test("every configs/ directory is a config template", () => {
  expect(configTemplateNames(path.resolve(import.meta.dirname, "../../.."))).toEqual(
    expect.arrayContaining(["default", "with-agents"]),
  );
});

test.for([
  {
    name: "a template this PR changes is the PR head's copy, an unchanged one its name",
    changedPaths: ["configs/default/AGENTS.md", "configs/with-agents-v2/x.md"],
    expected: [
      {
        name: "default",
        fromHead: "bbbbbbbbb0123456",
        next: `${DASH}/projects?new=1&template=github%3Aiterate%2Fiterate%23bbbbbbbbb0123456%26path%3Aconfigs%2Fdefault`,
      },
      { name: "with-agents", next: `${DASH}/projects?new=1&template=with-agents` },
    ],
  },
  {
    name: "a PR that changes no template links each by name",
    changedPaths: ["apps/os/src/worker.ts", "configs/README.md"],
    expected: [
      { name: "default", next: `${DASH}/projects?new=1&template=default` },
      { name: "with-agents", next: `${DASH}/projects?new=1&template=with-agents` },
    ],
  },
])("template quick-launch: $name", ({ changedPaths, expected }) => {
  expect(
    templateQuickLaunches({
      dashUrl: DASH,
      templates: ["default", "with-agents"],
      changedPaths,
      headSha: "bbbbbbbbb0123456",
    }),
  ).toEqual(expected);
});

test("template quick-launch: the Dash reads the PR head's reference back out of the link", () => {
  const [link] = templateQuickLaunches({
    dashUrl: DASH,
    templates: ["default"],
    changedPaths: ["configs/default/AGENTS.md"],
    headSha: "bbbbbbbbb0123456",
  });
  expect(Object.fromEntries(new URL(link!.next).searchParams)).toEqual({
    new: "1",
    template: "github:iterate/iterate#bbbbbbbbb0123456&path:configs/default",
  });
});

// ── a deployment's wrangler config: the one prd's goes through (generate-wrangler-config.ts) ──

test("a deployment's apps/os config: its own worker, KV binding-only for wrangler to provision, the D1 by name for the deploy to create and migrate, R2 and Artifacts named after its worker, no routes", () => {
  const config = viteWranglerConfig("pr3144-a1b2c3d", { localDev: false, port: "0" });
  expect(config).toMatchObject({
    name: "pr3144-a1b2c3d-os",
    account_id: osEnvs.preview!.cloudflareAccountId,
    workers_dev: true,
    routes: [],
    r2_buckets: [{ binding: "FILES", bucket_name: "pr3144-a1b2c3d-os-files" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: "pr3144-a1b2c3d-os-repos" }],
  });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- binding-only is the point: a copied id must fail
  expect(config.kv_namespaces).toEqual([{ binding: "OAUTH_KV" }, { binding: "ITX_KV" }]);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- no id: wrangler finds the D1 by name
  expect(config.d1_databases).toEqual([
    {
      binding: "DB",
      database_name: "pr3144-a1b2c3d-os-db",
      migrations_dir: "src/control-plane/db/migrations",
    },
  ]);
});

test("a deployment's apps/os config: vars are its own origin, its dash, projects as paths, the one-click sign-in links on and one test admin", () => {
  expect(viteWranglerConfig("pr3144-a1b2c3d", { localDev: false, port: "0" })).toMatchObject({
    vars: {
      APP_CONFIG_URLS__OS: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
      APP_CONFIG_URLS__DASH: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: "preview.iterate.test",
      APP_CONFIG_ADMINS: JSON.stringify(["admin@preview.iterate.test"]),
    },
  });
});

test("an envs.ts deployment's config still names its resources by id, and turns no test links on", () => {
  const config = viteWranglerConfig("prd", { localDev: false, port: "0" });
  expect(config).toMatchObject({
    kv_namespaces: [
      { binding: "OAUTH_KV", id: osEnvs.prd!.resources.oauthKvId },
      { binding: "ITX_KV", id: osEnvs.prd!.resources.itxKvId },
    ],
    d1_databases: [{ database_name: "os-prd-db", database_id: osEnvs.prd!.resources.dbId }],
  });
  expect(config.vars).not.toHaveProperty("APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN");
  expect(() => viteWranglerConfig("pr3144", { localDev: false, port: "0" })).toThrow(
    'apps/os: unknown env "pr3144"',
  );
});

// Preview OS deploys of #2934, #2939 and #2943 (2026-09-24): the PR head's older lockfile, then
// the merge commit's, rewrote pnpm-lock.yaml over node_modules baked from that same content.
test("the fresh-install check: a lockfile rewritten after the install, byte-identical to the one installed, passes", () => {
  expect(
    freshInstallCheck({ lockfile: ["main", later], installed: ["main", earlier] }),
  ).not.toThrow();
});

test("the fresh-install check: a lockfile changed since the install fails", () => {
  expect(freshInstallCheck({ lockfile: ["main", later], installed: ["pr", earlier] })).toThrow(
    "pnpm-lock.yaml is newer than node_modules and differs from node_modules/.pnpm/lock.yaml",
  );
});

test("the fresh-install check: no install fails", () => {
  expect(freshInstallCheck({ lockfile: ["main", earlier] })).toThrow("has no copy in");
});

// pnpm's installed lockfile can differ benignly (a filtered install): the mtime rule decides.
test("the fresh-install check: an install newer than a differing lockfile passes, as it always has on a laptop", () => {
  expect(
    freshInstallCheck({
      lockfile: ["main", earlier],
      installed: ["filtered", later],
    }),
  ).not.toThrow();
});

const earlier = new Date("2026-09-24T00:00:00Z");
const later = new Date("2026-09-24T00:42:00Z");
/** A checkout: its lockfile, and node_modules as pnpm leaves it (`.modules.yaml`, and the
 *  lockfile it installed from as `.pnpm/lock.yaml`), each file with its mtime. */
function freshInstallCheck(input: { lockfile: [string, Date]; installed?: [string, Date] }) {
  const root = mkdtempSync(path.join(tmpdir(), "preview-fresh-install-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), input.lockfile[0]);
  utimesSync(path.join(root, "pnpm-lock.yaml"), input.lockfile[1], input.lockfile[1]);
  if (input.installed) {
    mkdirSync(path.join(root, "node_modules", ".pnpm"), { recursive: true });
    for (const file of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"]) {
      writeFileSync(path.join(root, file), input.installed[0]);
      utimesSync(path.join(root, file), input.installed[1], input.installed[1]);
    }
  }
  return () => assertFreshInstall(root);
}

/** `line <from>` … `line <to>`, one per line: a command's output. */
function numberedLines(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`).join("\n");
}

/** A deployed section with no apps and no sign-in: what a status splice lands in. */
function deployedSection() {
  return renderPullRequestSection({
    deployment: "pr123-ccccccc",
    status: deployed,
    url: "https://pr123-ccccccc-os.iterate-dev-preview.workers.dev",
    versionId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
    dashboardUrl: "https://dash.cloudflare.com/x",
    apps: [],
  });
}

/** A status write that records when it starts and lands; `deploying` lands only when released. */
function recordedStatusWrites() {
  const events: string[] = [];
  let release = () => {};
  const landed = new Promise<void>((resolve) => (release = resolve));
  const write = async ({ state }: { state: string }) => {
    events.push(`write ${state}`);
    if (state === "deploying") await landed;
    events.push(`landed ${state}`);
  };
  return { events, write, release };
}

/** A suite's line alone, as its block in the section. */
function suiteLine(suite: PreviewSuiteStatus["suite"], state: PreviewSuiteStatus["state"]) {
  return splicePreviewSuite("", { ...deployed, runUrl: undefined, suite, state })
    .replace("<!-- os-preview:begin -->\n", "")
    .replace("\n<!-- os-preview:end -->\n", "");
}
