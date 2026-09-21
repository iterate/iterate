import { describe, expect, test } from "vitest";
import { previewResourceName, previewWranglerConfig } from "./generate-wrangler-config.ts";
import {
  APPS,
  changedApps,
  MAX_PREVIEW_NAME_LENGTH,
  previewPullRequestNumber,
  renderPullRequestSection,
  resolvePreviewName,
  slugifyPreviewName,
  splicePullRequestBody,
} from "./preview.ts";

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
    prNumber: "123",
    branch: "feature/foo",
    apps: [
      {
        name: "dash",
        url: "https://pr123-feature-foo-dash-preview.iterate-dev-preview.workers.dev",
      },
    ],
  });

  test("names the URL, the deployment and every operation, collapsed", () => {
    expect(section).toContain(
      "https://pr123-feature-foo-os-next-preview.iterate-dev-preview.workers.dev",
    );
    expect(section).toContain("deployment `bd68a9bb`");
    expect(section).toContain(
      "| dash | https://pr123-feature-foo-dash-preview.iterate-dev-preview.workers.dev |",
    );
    expect(section).toContain("--input apps=all");
    expect(section).toContain("<details>");
    for (const action of ["reset", "e2e", "deploy", "delete"]) {
      expect(section).toContain(`--input pull-request-number=123 --input action=${action}`);
      expect(section).toContain(`pnpm preview ${action} --pr 123 --name feature/foo`);
    }
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
});

describe("the preview's wrangler config (a pure transform of wrangler.base.jsonc, cloudflare-os style)", () => {
  const template = {
    main: "src/worker.ts",
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
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
    },
    r2_buckets: [{ binding: "FILES", bucket_name: "os-next-files" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: "project-worker-repos" }],
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

  test("the top level is the parent worker plus the classes as a legacy migrations entry", () => {
    expect(config.name).toBe("os-next-preview");
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
});

describe("which apps on top a change touches (cloudflare-os previews all; ours only the changed)", () => {
  test.each<[string, string[], string[]]>([
    ["nothing", ["apps/os-next/src/worker.ts", "docs/x.md"], []],
    ["one app", ["apps/dash/src/routes/index.tsx"], ["dash"]],
    ["two apps", ["apps/notes/src/worker.ts", "apps/voice/README.md"], ["notes", "voice"]],
    ["the SDK: every app", ["packages/iterate/src/next/app.ts"], APPS.map((app) => app.name)],
    ["the shared UI: every app", ["packages/ui/src/button.tsx"], APPS.map((app) => app.name)],
    ["envs.ts: every app", ["envs.ts"], APPS.map((app) => app.name)],
    ["a look-alike path is not an app", ["apps/dashboard/x.ts", "packages/iterate-docs/x.md"], []],
  ])("%s", (_, paths, expected) => {
    expect(changedApps(paths).map((app) => app.name)).toEqual(expected);
  });
});
