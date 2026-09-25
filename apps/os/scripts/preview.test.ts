import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  APPS,
  appPreviewOrigins,
  assertFreshInstall,
  changedApps,
  configTemplateNames,
  deployWithStatus,
  isDurableObjectClassNotExportedError,
  lastLines,
  MAX_PREVIEW_NAME_LENGTH,
  previewNameOfResource,
  previewPullRequestNumber,
  previewResourceName,
  previewWranglerConfig,
  renderPreviewStatus,
  renderPullRequestSection,
  resolvePreviewName,
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
  ["previewer", undefined, "previewer"],
])("the preview name: %s with PR %s → %s", (name, prNumber, expected) => {
  expect(resolvePreviewName({ name, prNumber })).toBe(expected);
});

test("the preview name: a long one is truncated with a stable hash, inside the limit", () => {
  const name = resolvePreviewName({
    name: "jonas/os-worker-previews-with-a-very-long-descriptive-branch-name",
  });
  expect(name.length).toBeLessThanOrEqual(MAX_PREVIEW_NAME_LENGTH);
  expect(name).toMatch(/^jonas-os-worker-[a-z0-9-]+-[0-9a-f]{6}$/);
  expect(slugifyPreviewName("a".repeat(40))).not.toBe(slugifyPreviewName("a".repeat(41)));
});

test("the preview name: one whose resources the account has for something else is refused", () => {
  expect(() => resolvePreviewName({ name: "dev" })).toThrow(
    "preview name dev would take os-dev-repos, which is not a preview's",
  );
  expect(() => resolvePreviewName({ name: "parent" })).toThrow(/would take os-parent-/);
  // the former parent's own stores, the legacy slots' namespaces, and the empty slug's fallback
  for (const name of ["preview", "preview-3", "--"])
    expect(() => resolvePreviewName({ name })).toThrow(
      /would take os-preview-.*, under the former parent os-preview's prefix/,
    );
  expect(() => resolvePreviewName({})).toThrow("a preview needs a PR number (--pr) or a name");
});

test("the preview name: a PR's number reads back out of it; any other name has none", () => {
  expect(previewPullRequestNumber("pr123")).toBe(123);
  expect(previewPullRequestNumber("pr123-feature-foo")).toBeUndefined();
  expect(previewPullRequestNumber("feature-foo")).toBeUndefined();
  expect(previewPullRequestNumber("pr-foo")).toBeUndefined();
});

const JOB = "https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a";
const DASH = "https://pr123-dash.iterate-dev-preview.workers.dev";
const deployed: PreviewStatus = {
  state: "deployed",
  commit: "ccccccccc0123456789",
  runUrl: JOB,
  at: new Date("2026-09-24T10:32:17Z"),
};

const section = renderPullRequestSection({
  previewName: "pr123",
  status: deployed,
  url: "https://pr123-os.iterate-dev-preview.workers.dev",
  deploymentId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
  dashboardUrl: "https://dash.cloudflare.com/x",
  apps: [
    {
      name: "dash",
      url: "https://pr123-dash.iterate-dev-preview.workers.dev",
    },
  ],
});

test("the PR body's managed section: names the URL, the deployment, the apps on top, and where the operations are", () => {
  expect(section).toContain("https://pr123-os.iterate-dev-preview.workers.dev");
  expect(section).toContain("deployment `bd68a9bb`");
  expect(section).toContain("| dash | https://pr123-dash.iterate-dev-preview.workers.dev |");
  expect(section).toContain("https://github.com/iterate/iterate/blob/main/apps/os/README.md");
  expect(section).not.toContain("depot ci dispatch");
  expect(section).not.toContain("Deployed from");
});

test("the PR body's managed section: names the commit the run deployed when the workflow resolved one; e2e is the status line's", () => {
  const withCommit = renderPullRequestSection({
    previewName: "pr123",
    status: deployed,
    url: "https://pr123-os.iterate-dev-preview.workers.dev",
    deploymentId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
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
  const dash = "https://pr123-dash.iterate-dev-preview.workers.dev";
  const notes = "https://pr123-notes.iterate-dev-preview.workers.dev";
  const os = "https://pr123-os.iterate-dev-preview.workers.dev";
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
      previewName: "pr123",
      status: deployed,
      url: os,
      deploymentId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
      dashboardUrl: "https://dash.cloudflare.com/x",
      apps: [
        { name: "dash", url: dash },
        { name: "notes", url: notes },
      ],
      signIn: { ...signIn, seeded },
    });
  expect(render(true)).toMatchInlineSnapshot(`
    "### OS preview: \`pr123\`

    <!-- os-preview-status:begin -->
    Status: **deployed** on \`ccccccccc\` · [CI job ↗](https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a) · updated 2026-09-24 10:32 UTC
    <!-- os-preview-status:end -->

    **https://pr123-os.iterate-dev-preview.workers.dev** · [Sign in ↗](https://pr123-os.iterate-dev-preview.workers.dev/.auth/test-link?t=heading) · deployment \`bd68a9bb\` · [Cloudflare dashboard](https://dash.cloudflare.com/x) · deleted when this PR closes

    | App on top, signed in against this preview | | |
    | --- | --- | --- |
    | dash | https://pr123-dash.iterate-dev-preview.workers.dev | [Sign in ↗](https://pr123-os.iterate-dev-preview.workers.dev/.auth/test-link?t=dash) |
    | notes | https://pr123-notes.iterate-dev-preview.workers.dev | [Sign in ↗](https://pr123-os.iterate-dev-preview.workers.dev/.auth/test-link?t=notes) |

    New project from template: [default at this PR's \`bbbbbbbbb\` ↗](https://pr123-os.iterate-dev-preview.workers.dev/.auth/test-link?t=default) · [with-agents ↗](https://pr123-os.iterate-dev-preview.workers.dev/.auth/test-link?t=with-agents)

    \`Sign in ↗\` signs you in as \`pr123@preview.iterate.test\` with project \`pr123\`, no password and no Allow page: the link is signed for this preview only and expires in 14 days; every push mints a fresh one.

    Every push redeploys it in place. Reset, e2e, delete and the laptop commands: [apps/os/README.md](https://github.com/iterate/iterate/blob/main/apps/os/README.md)."
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

const template = {
  main: "index.js",
  no_bundle: true,
  compatibility_date: "2026-09-01",
  compatibility_flags: ["nodejs_compat"],
  assets: { directory: "../client", binding: "ASSETS", run_worker_first: true },
  limits: { cpu_ms: 1 },
  worker_loaders: [{ binding: "LOADER" }],
  ai: { binding: "AI" },
  browser: { binding: "BROWSER" },
  send_email: [{ name: "EMAIL" }],
  version_metadata: { binding: "CF_VERSION_METADATA" },
  durable_objects: {
    bindings: [{ name: "ITERATE_CONTEXT", class_name: "IterateContextDurableObject" }],
  },
  exports: {
    IterateContextDurableObject: { type: "durable-object", storage: "sqlite" },
    BrowserSession: { type: "durable-object", storage: "sqlite" },
    AgentDurableObject: { type: "durable-object", state: "deleted" },
  },
  r2_buckets: [{ binding: "FILES", bucket_name: "os-files" }],
  artifacts: [{ binding: "ARTIFACTS", namespace: "os-dev-repos" }],
  kv_namespaces: [
    { binding: "ITX_KV", id: "1" },
    { binding: "OAUTH_KV", id: "2" },
  ],
};
const config = previewWranglerConfig({ template, previewName: "pr123" });

test("the preview's wrangler config (a pure transform of Vite's built config): the top level provisions live classes, excluding deleted exports, as a legacy migrations entry", () => {
  expect(config).toMatchObject({
    name: "os",
    main: "index.js",
    no_bundle: true,
    assets: template.assets,
    migrations: [
      { tag: "v1", new_sqlite_classes: ["IterateContextDurableObject", "BrowserSession"] },
    ],
  });
  expect(config).not.toHaveProperty("exports");
  expect(config).not.toHaveProperty("vars");
  expect(config).not.toHaveProperty("kv_namespaces");
});

test("the preview's wrangler config (a pure transform of Vite's built config): KV and R2 are binding-only (auto-provisioned per preview); the Artifacts namespace is the preview's own", () => {
  // oxlint-disable-next-line iterate/prefer-object-property-match -- binding-only is the point: a copied id must fail
  expect(config.previews.kv_namespaces).toEqual([{ binding: "ITX_KV" }, { binding: "OAUTH_KV" }]);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- binding-only is the point: a copied id must fail
  expect(config.previews.r2_buckets).toEqual([{ binding: "FILES" }]);
  expect(config.previews).not.toHaveProperty("d1_databases");
  expect(config.previews).toMatchObject({
    artifacts: [{ binding: "ARTIFACTS", namespace: "os-pr123-repos" }],
  });
});

test("the preview's wrangler config (a pure transform of Vite's built config): vars are the preview's own origin, projects as paths, the one-click sign-in links on and one test admin; the secrets are the parent's Previews settings", () => {
  expect(config.previews).toMatchObject({
    vars: {
      APP_CONFIG_URLS__OS: "https://pr123-os.iterate-dev-preview.workers.dev",
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: "preview.iterate.test",
      APP_CONFIG_ADMINS: JSON.stringify(["admin@preview.iterate.test"]),
    },
  });
  expect(previewResourceName("pr123", "db")).toBe("os-pr123-db");
});

test("the preview's wrangler config (a pure transform of Vite's built config): a deployed Dash is available to secret collection link generation", () => {
  const dashOrigin = "https://pr123-dash.iterate-dev-preview.workers.dev";
  const withDash = previewWranglerConfig({
    template,
    previewName: "pr123",
    dashOrigin,
  });
  expect(withDash.previews.vars).toMatchObject({ APP_CONFIG_URLS__DASH: dashOrigin });
  expect(config.previews.vars.APP_CONFIG_URLS__DASH).toBeUndefined();
});

test("a preview's apps link to each other at this PR's preview of each one's parent, the URLs the PR body lists", () => {
  expect(appPreviewOrigins(APPS, "pr123")).toEqual({
    dash: "https://pr123-dash.iterate-dev-preview.workers.dev",
    agents: "https://pr123-agents.iterate-dev-preview.workers.dev",
    notes: "https://pr123-notes.iterate-dev-preview.workers.dev",
    voice: "https://pr123-voice.iterate-dev-preview.workers.dev",
    kit: "https://pr123-kit.iterate-dev-preview.workers.dev",
    admin: "https://pr123-admin.iterate-dev-preview.workers.dev",
  });
});

test("an app the preview run does not deploy is named nowhere, never at its production origin", () => {
  const dashOnly = appPreviewOrigins(changedApps(["apps/dash/src/apps.ts"]), "pr123");
  expect(dashOnly).toEqual({
    dash: "https://pr123-dash.iterate-dev-preview.workers.dev",
  });
  expect(appPreviewOrigins([], "pr123")).toEqual({});
});

test("which apps on top a preview run deploys: the apps on top are the six clients", () => {
  expect(APPS.map((app) => app.name)).toEqual(["dash", "agents", "notes", "voice", "kit", "admin"]);
});

test.each<[string, string[], string[]]>([
  ["nothing", ["apps/os/src/worker.ts", "docs/x.md"], []],
  ["one app", ["apps/dash/src/routes/index.tsx"], ["dash"]],
  ["two apps", ["apps/notes/src/server.ts", "apps/voice/README.md"], ["notes", "voice"]],
  ["the SDK: every app", ["packages/iterate/src/app.ts"], APPS.map((app) => app.name)],
  ["the shared UI: every app", ["packages/ui/src/button.tsx"], APPS.map((app) => app.name)],
  ["envs.ts: every app", ["envs.ts"], APPS.map((app) => app.name)],
  ["shared utilities: every app", ["packages/shared/src/slugify.ts"], APPS.map((app) => app.name)],
  ...["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].map(
    (file): [string, string[], string[]] => [file, [file], APPS.map((app) => app.name)],
  ),
  ["a look-alike path is not an app", ["apps/dashboard/x.ts", "packages/iterate-docs/x.md"], []],
])("which apps on top a preview run deploys: %s", (_, paths, expected) => {
  expect(changedApps(paths).map((app) => app.name)).toEqual(expected);
});

test.each<[string, string, string | undefined]>([
  ["os-pr123-repos", "repos", "pr123"],
  ["os-pr123-db", "db", "pr123"],
  ["os-soak-repos", "repos", "soak"],
  // nothing between the parent and the suffix: local dev's R2 bucket
  ["os-files", "files", undefined],
  // another binding's resource
  ["os-pr123-db", "repos", undefined],
  // not the parent's prefix
  ["iterate-spa-preview-repos", "repos", undefined],
  // other resources read as preview names too; the sweep leaves them (preview-sweep.ts rule 4:
  // those envs.ts and wrangler.base.jsonc name, and those of another worker whose name begins `os-`)
  ["os-dev-repos", "repos", "dev"],
  ["os-parent-repos", "repos", "parent"],
  ["os-preview-repos", "repos", "preview"],
  ["os-prd-project-repos", "repos", "prd-project"],
])(
  "the preview a resource name encodes (previewResourceName's inverse; the sweep's orphan passes): %s as %s → %s",
  (resourceName, binding, expected) => {
    expect(previewNameOfResource(resourceName, binding)).toBe(expected);
  },
);

test("the preview a resource name encodes (previewResourceName's inverse; the sweep's orphan passes): round-trips previewResourceName", () => {
  expect(previewNameOfResource(previewResourceName("pr7", "repos"), "repos")).toBe("pr7");
  expect(previewNameOfResource(previewResourceName("exp-x", "db"), "db")).toBe("exp-x");
});

test.each([
  // #2895's deploy after #2888 added ControlPlaneDurableObject (2026-09-23)
  {
    output:
      "A request to the Cloudflare API (/accounts/x/workers/workers/os-preview/previews/y/deployments) failed.\n  Cannot create binding for class 'ControlPlaneDurableObject' that is not exported by the script. [code: 10061]",
    recreate: true,
  },
  {
    output: "Cannot create binding for class 'X' that is not exported by the script.",
    recreate: true,
  },
  { output: "This Worker does not exist on your account. [code: 10007]", recreate: false },
  { output: "Authentication error [code: 10000]", recreate: false },
])(
  "Cloudflare 10061 (a Durable Object class the preview lacks) is recognised: $recreate",
  ({ output, recreate }) => {
    expect(isDurableObjectClassNotExportedError(output)).toBe(recreate);
  },
);

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
    previewName: "pr123",
    status: deployed,
    url: "https://pr123-os.iterate-dev-preview.workers.dev",
    deploymentId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
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
