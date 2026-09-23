import { describe, expect, test } from "vitest";
import { startAppPreviewConfig } from "./start-app.ts";

describe("a start app's preview config (a pure transform of the built wrangler.json)", () => {
  const built = {
    configPath: "/x/wrangler.jsonc",
    userConfigPath: "/x/wrangler.jsonc",
    topLevelName: "notes",
    definedEnvironments: ["preview", "prd"],
    targetEnvironment: "preview",
    account_id: "acct",
    name: "notes-preview",
    main: "index.js",
    compatibility_date: "2026-09-01",
    assets: { binding: "ASSETS", directory: "../client", run_worker_first: true },
    workers_dev: true,
    vars: {
      ITERATE_ORIGIN: "https://os.iterate.com",
      ITERATE_DENY_ZONES: "iterate.app,iterate.com",
    },
    durable_objects: { bindings: [{ name: "BROWSER_SESSION", class_name: "BrowserSession" }] },
    exports: { BrowserSession: { type: "durable-object", storage: "sqlite" } },
    observability: { enabled: true },
    no_bundle: true,
  };
  const config = startAppPreviewConfig(built, {
    issuer: "https://pr123-foo-os-next-preview.iterate-dev-preview.workers.dev",
  });

  test("the top level is the parent: the build's own fields, the class as a migrations entry, no exports, no vite bookkeeping", () => {
    expect(config).toMatchObject({
      name: "notes-preview",
      main: "index.js",
      preview_urls: true,
      migrations: [{ tag: "v1", new_sqlite_classes: ["BrowserSession"] }],
      assets: built.assets,
      vars: { ITERATE_ORIGIN: "https://os.iterate.com" },
    });
    for (const key of [
      "exports",
      "configPath",
      "userConfigPath",
      "topLevelName",
      "definedEnvironments",
      "targetEnvironment",
    ])
      expect(config).not.toHaveProperty(key);
  });

  test("the preview's own block: the session class, observability, and the worker's vars with the issuer swapped", () => {
    expect(config.previews).toEqual({
      observability: { enabled: true },
      durable_objects: built.durable_objects,
      vars: {
        ITERATE_ORIGIN: "https://pr123-foo-os-next-preview.iterate-dev-preview.workers.dev",
        ITERATE_DENY_ZONES: "iterate.app,iterate.com",
      },
    });
  });
});
