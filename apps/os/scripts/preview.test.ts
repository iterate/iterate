import { describe, expect, test } from "vitest";
import { DEFAULT_APPS_MODE } from "./preview.ts";
import {
  APPS,
  changedApps,
  MAX_PREVIEW_NAME_LENGTH,
  previewNameOfResource,
  previewPullRequestNumber,
  previewResourceName,
  previewWranglerConfig,
  renderPullRequestSection,
  RESIDENCY_SECTION_MARKERS,
  resolvePreviewName,
  slugifyPreviewName,
  splicePullRequestBody,
} from "./preview-config.ts";

describe("the preview name (cloudflare-os: pr<n>-<branch slug>)", () => {
  test.each([
    ["feature/foo", "123", "pr123-feature-foo"],
    ["Feature_Foo", "123", "pr123-feature-foo"],
    ["feature/foo", "", "feature-foo"],
    ["feature/foo", undefined, "feature-foo"],
    ["--", "7", "pr7-preview"],
  ])("%s with PR %s → %s", (name, prNumber, expected) => {
    expect(resolvePreviewName({ name, prNumber })).toBe(expected);
  });

  test("a long branch is truncated with a stable hash, inside the limit, number first", () => {
    const name = resolvePreviewName({
      name: "jonas/os-next-worker-previews-with-a-very-long-descriptive-branch-name",
      prNumber: "2750",
    });
    expect(name.length).toBeLessThanOrEqual(MAX_PREVIEW_NAME_LENGTH);
    expect(name).toMatch(/^pr2750-[a-z0-9-]+-[0-9a-f]{6}$/);
    expect(name).toBe(
      resolvePreviewName({
        name: "jonas/os-next-worker-previews-with-a-very-long-descriptive-branch-name",
        prNumber: "2750",
      }),
    );
    expect(slugifyPreviewName("a".repeat(40))).not.toBe(slugifyPreviewName("a".repeat(41)));
  });

  test("the number reads back out of the name; a bare slug has none", () => {
    expect(previewPullRequestNumber("pr123-feature-foo")).toBe(123);
    expect(previewPullRequestNumber("feature-foo")).toBeUndefined();
    expect(previewPullRequestNumber("pr-foo")).toBeUndefined();
  });
});

describe("the PR body's managed section", () => {
  const section = renderPullRequestSection({
    previewName: "pr123-feature-foo",
    url: "https://pr123-feature-foo-os-next-preview.iterate-dev-preview.workers.dev",
    deploymentId: "bd68a9bb-b323-47fd-bc6b-c4cae7b29c8c",
    dashboardUrl: "https://dash.cloudflare.com/x",
    apps: [
      {
        name: "dash",
        url: "https://pr123-feature-foo-dash-preview.iterate-dev-preview.workers.dev",
      },
    ],
  });

  test("names the URL, the deployment, the apps on top, and where the operations are", () => {
    expect(section).toContain(
      "https://pr123-feature-foo-os-next-preview.iterate-dev-preview.workers.dev",
    );
    expect(section).toContain("deployment `bd68a9bb`");
    expect(section).toContain(
      "| dash | https://pr123-feature-foo-dash-preview.iterate-dev-preview.workers.dev |",
    );
    expect(section).toContain("https://github.com/iterate/iterate/blob/main/apps/os/README.md");
    expect(section).not.toContain("depot ci dispatch");
  });

  test("appends to a body without one, keeping the author's text", () => {
    const body = splicePullRequestBody("What this PR does.\n", section);
    expect(body.startsWith("What this PR does.\n\n<!-- os-next-preview:begin -->\n")).toBe(true);
    expect(body.endsWith("\n<!-- os-next-preview:end -->\n")).toBe(true);
  });

  test("replaces an existing section in place, and only that", () => {
    const before = `Intro.\n\n<!-- os-next-preview:begin -->\nold\n<!-- os-next-preview:end -->\n\nOutro.\n`;
    const after = splicePullRequestBody(before, "new");
    expect(after).toBe(
      `Intro.\n\n<!-- os-next-preview:begin -->\nnew\n<!-- os-next-preview:end -->\n\nOutro.\n`,
    );
    expect(splicePullRequestBody(after, "newer")).not.toContain("new\n<!--");
  });

  test("an empty body becomes just the section", () => {
    expect(splicePullRequestBody("", "s")).toBe(
      "<!-- os-next-preview:begin -->\ns\n<!-- os-next-preview:end -->\n",
    );
  });

  test("the residency gate fills in its pending block inside the section, and a redeploy resets it", () => {
    const deployed = splicePullRequestBody("Intro.\n", section);
    expect(deployed).toContain("#### Residency gate: pending");
    const gated = splicePullRequestBody(
      deployed,
      "#### Residency gate: passed",
      RESIDENCY_SECTION_MARKERS,
    );
    expect(gated).not.toContain("pending");
    expect(gated).toContain(
      "<!-- os-next-preview-residency:begin -->\n#### Residency gate: passed\n<!-- os-next-preview-residency:end -->",
    );
    expect(gated.endsWith("\n<!-- os-next-preview:end -->\n")).toBe(true);
    expect(splicePullRequestBody(gated, section)).toBe(deployed);
  });
});

describe("the preview's wrangler config (a pure transform of Vite's built config)", () => {
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
    r2_buckets: [{ binding: "FILES", bucket_name: "os-next-files" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: "os-next-dev-repos" }],
    d1_databases: [{ binding: "DB", database_name: "x", database_id: "y" }],
    kv_namespaces: [
      { binding: "ITX_KV", id: "1" },
      { binding: "OAUTH_KV", id: "2" },
    ],
    rules: [{ type: "ESModule", globs: ["**/*.js"] }],
  };
  const config = previewWranglerConfig({
    template,
    previewName: "pr123-feature-foo",
    d1DatabaseId: "d1-id",
  });

  test("the top level provisions live classes, excluding deleted exports, as a legacy migrations entry", () => {
    expect(config.name).toBe("os-next-preview");
    expect(config.main).toBe("index.js");
    expect(config.no_bundle).toBe(true);
    expect(config.assets).toEqual(template.assets);
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["IterateContextDurableObject", "BrowserSession"] },
    ]);
    expect(config).not.toHaveProperty("exports");
    expect(config).not.toHaveProperty("vars");
    expect(config.rules).toEqual([{ type: "ESModule", globs: ["**/*.js"] }]);
    expect(config).not.toHaveProperty("kv_namespaces");
  });

  test("KV and R2 are binding-only (auto-provisioned per preview); D1 and Artifacts are the preview's own", () => {
    expect(config.previews.kv_namespaces).toEqual([{ binding: "ITX_KV" }, { binding: "OAUTH_KV" }]);
    expect(config.previews.r2_buckets).toEqual([{ binding: "FILES" }]);
    expect(config.previews.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "os-next-preview-pr123-feature-foo-db",
        database_id: "d1-id",
      },
    ]);
    expect(config.previews.artifacts).toEqual([
      { binding: "ARTIFACTS", namespace: "os-next-preview-pr123-feature-foo-repos" },
    ]);
  });

  test("vars are the preview's own origin and projects as paths; the secrets are the parent's Previews settings", () => {
    expect(config.previews.vars).toEqual({
      APP_CONFIG_URLS__OS:
        "https://pr123-feature-foo-os-next-preview.iterate-dev-preview.workers.dev",
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
    });
    expect(previewResourceName("pr123-feature-foo", "db")).toBe(
      "os-next-preview-pr123-feature-foo-db",
    );
  });

  test("a deployed Dash is available to secret collection link generation", () => {
    const dashOrigin = "https://pr123-feature-foo-dash-preview.iterate-dev-preview.workers.dev";
    const withDash = previewWranglerConfig({
      template,
      previewName: "pr123-feature-foo",
      d1DatabaseId: "d1-id",
      dashOrigin,
    });
    expect(withDash.previews.vars.APP_CONFIG_URLS__DASH).toBe(dashOrigin);
    expect(config.previews.vars.APP_CONFIG_URLS__DASH).toBeUndefined();
  });
});

describe("which apps on top a preview run deploys", () => {
  test("all clients are selected by default, even when only os-next changes", () => {
    expect(DEFAULT_APPS_MODE).toBe("all");
    expect(APPS.map((app) => app.name)).toEqual(["dash", "agents", "notes", "voice"]);
  });

  test.each<[string, string[], string[]]>([
    ["nothing", ["apps/os/src/worker.ts", "docs/x.md"], []],
    ["one app", ["apps/dash/src/routes/index.tsx"], ["dash"]],
    ["two apps", ["apps/notes/src/worker.ts", "apps/voice/README.md"], ["notes", "voice"]],
    ["the SDK: every app", ["packages/iterate/src/next/app.ts"], APPS.map((app) => app.name)],
    ["the shared UI: every app", ["packages/ui/src/button.tsx"], APPS.map((app) => app.name)],
    ["envs.ts: every app", ["envs.ts"], APPS.map((app) => app.name)],
    ["shared utilities: every app", ["packages/shared/src/config.ts"], APPS.map((app) => app.name)],
    ...["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].map(
      (file): [string, string[], string[]] => [file, [file], APPS.map((app) => app.name)],
    ),
    ["a look-alike path is not an app", ["apps/dashboard/x.ts", "packages/iterate-docs/x.md"], []],
  ])("%s", (_, paths, expected) => {
    expect(changedApps(paths).map((app) => app.name)).toEqual(expected);
  });
});

describe("the preview a resource name encodes (previewResourceName's inverse; the sweep's orphan passes)", () => {
  test.each<[string, string, string | undefined]>([
    ["os-next-preview-pr123-feature-foo-repos", "repos", "pr123-feature-foo"],
    ["os-next-preview-pr123-feature-foo-db", "db", "pr123-feature-foo"],
    ["os-next-preview-soak-repos", "repos", "soak"],
    // the parent's own namespace is nobody's preview
    ["os-next-preview-repos", "repos", undefined],
    // another binding's resource
    ["os-next-preview-pr123-feature-foo-db", "repos", undefined],
    // another worker's
    ["os-preview-1-repos", "repos", undefined],
    ["project-worker-prd-repos", "repos", undefined],
    // a former parent's: it reads as a preview name; the sweep leaves it while a worker of that name
    // exists (preview-sweep.ts rule 4)
    ["os-next-preview-2-pr1-x-repos", "repos", "2-pr1-x"],
  ])("%s as %s → %s", (resourceName, binding, expected) => {
    expect(previewNameOfResource(resourceName, binding)).toBe(expected);
  });

  test("round-trips previewResourceName", () => {
    expect(previewNameOfResource(previewResourceName("pr7-x", "repos"), "repos")).toBe("pr7-x");
    expect(previewNameOfResource(previewResourceName("pr7-x", "db"), "db")).toBe("pr7-x");
  });
});
