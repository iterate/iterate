import { expect, test } from "vitest";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { dashEnvs, kitEnvs } from "../../envs.ts";
import { ownZones, startAppPreviewConfig, startAppWorkerConfig } from "./start-app.ts";

// ── a start app's preview config (a pure transform of the built wrangler.json) ──
test("the top level is the parent: the build's own fields, the class as a migrations entry, no exports, no vite bookkeeping", () => {
  const { built, config } = previewConfig();
  expect(config).toMatchObject({
    name: "notes",
    main: "index.js",
    preview_urls: true,
    migrations: [{ tag: "v1", new_sqlite_classes: ["BrowserSession"] }],
    assets: built.assets,
    vars: built.vars,
  });
  for (const key of ["exports", "topLevelName"]) expect(config).not.toHaveProperty(key);
});

test("the preview's own block: the session class, observability, and the worker's config with its urls replaced by this PR's", () => {
  const { built, config } = previewConfig();
  // oxlint-disable-next-line iterate/prefer-object-property-match -- the preview block is exact: a stray key would deploy with the preview
  expect(config.previews).toEqual({
    observability: { enabled: true },
    durable_objects: built.durable_objects,
    vars: { APP_CONFIG: expect.any(String) },
  });
  // prd's notes origin is gone, not kept beside this PR's dash: the preview names only its own apps
  expect(JSON.parse((config.previews as { vars: { APP_CONFIG: string } }).vars.APP_CONFIG)).toEqual(
    {
      urls: {
        os: "https://pr123-os.iterate-dev-preview.workers.dev",
        dash: "https://pr123-dash.iterate-dev-preview.workers.dev",
      },
      denyZones: ["iterate.app", "iterate.com"],
    },
  );
});

test("on workers.dev our own zones are our apps' hosts, not the accounts they share with anyone's worker", () => {
  const zones = ownZones();
  // a worker anyone deploys to these accounts (a self-host tried out on one) is not under any of them
  expect(zones.filter((zone) => zone.endsWith(".workers.dev"))).toEqual([
    "admin.iterate-dev-preview.workers.dev",
    "agents.iterate-dev-preview.workers.dev",
    "dash.iterate-dev-preview.workers.dev",
    "kit.iterate-dev-preview.workers.dev",
    "notes.iterate-dev-preview.workers.dev",
    "os.iterate-dev-preview.workers.dev",
    "voice.iterate-dev-preview.workers.dev",
  ]);
  // elsewhere, still the whole zone: our origins' and our project wildcard's
  expect(zones).toEqual(expect.arrayContaining(["iterate.com", "iterate.app"]));
});

test("a deployed app links to the other apps at their prd origins from envs.ts, as it signs in against prd's issuer", () => {
  const { vars } = startAppWorkerConfig(
    { name: "dash", root: new URL("file:///apps/dash/"), envs: dashEnvs },
    "prd",
  );
  expect(JSON.parse(vars.APP_CONFIG)).toMatchObject({
    urls: {
      os: "https://os.iterate.com",
      dash: "https://dash.iterate.com",
      agents: "https://agents.iterate.com",
      notes: "https://notes.iterate.com",
      admin: "https://admin.iterate.com",
      voice: "https://voice.iterate.com",
      kit: "https://k.iterate.com",
    },
  });
});

test("a preview parent (the app's `preview` build, main on the dev/preview account) signs in against the platform's parent and links to the other parents", () => {
  const { vars } = startAppWorkerConfig(
    { name: "dash", root: new URL("file:///apps/dash/"), envs: dashEnvs },
    "preview",
  );
  expect(JSON.parse(vars.APP_CONFIG)).toMatchObject({
    urls: {
      os: "https://os.iterate-dev-preview.workers.dev",
      dash: "https://dash.iterate-dev-preview.workers.dev",
      agents: "https://agents.iterate-dev-preview.workers.dev",
      notes: "https://notes.iterate-dev-preview.workers.dev",
      admin: "https://admin.iterate-dev-preview.workers.dev",
      voice: "https://voice.iterate-dev-preview.workers.dev",
      kit: "https://kit.iterate-dev-preview.workers.dev",
    },
  });
});

test("the app reads the config it is deployed with as written, and a laptop's .dev.vars names a local platform on top", () => {
  const { vars } = startAppWorkerConfig(
    { name: "kit", root: new URL("file:///apps/kit/"), envs: kitEnvs },
    "prd",
  );
  expect(startAppConfigOf({ ...vars })).toMatchObject({
    urls: { os: "https://os.iterate.com", dash: "https://dash.iterate.com" },
    denyZones: ownZones(),
    posthogProjectKey: kitEnvs.prd.posthogProjectKey,
  });
  // local dev starts from prd's config (no env) and overrides one key, keeping the rest
  const local = startAppWorkerConfig(
    { name: "dash", root: new URL("file:///apps/dash/"), envs: dashEnvs },
    undefined,
  ).vars;
  expect(
    startAppConfigOf({
      ...local,
      APP_CONFIG_URLS__OS: "http://localhost:8788",
      APP_CONFIG_URLS__NOTES: "http://localhost:5174",
    }),
  ).toMatchObject({
    urls: {
      os: "http://localhost:8788",
      notes: "http://localhost:5174",
      agents: "https://agents.iterate.com",
    },
    denyZones: ownZones(),
    posthogProjectKey: "",
  });
});

test("every request starts the app's Worker but its static files: vite's /assets/ and each entry of its public/ directory", () => {
  const dash = startAppWorkerConfig(
    { name: "dash", root: new URL("../../apps/dash/", import.meta.url), envs: dashEnvs },
    "prd",
  );
  expect(dash.assets).toMatchObject({
    run_worker_first: ["/*", "!/assets/*", "!/client-logo.svg"],
  });
  // a directory of public files is one rule; kit's public/ also holds the gitignored voice-install.json once built
  const kit = startAppWorkerConfig(
    { name: "kit", root: new URL("../../apps/kit/", import.meta.url), envs: kitEnvs },
    "prd",
  );
  expect(kit.assets).toMatchObject({
    run_worker_first: expect.arrayContaining(["/*", "!/assets/*", "!/favicon.svg", "!/vendors/*"]),
  });
});

/** The built wrangler.json of a start app, and its preview config for PR 123. */
function previewConfig() {
  const built = {
    topLevelName: "notes",
    account_id: "acct",
    name: "notes",
    main: "index.js",
    compatibility_date: "2026-09-01",
    assets: { binding: "ASSETS", directory: "../client", run_worker_first: true },
    workers_dev: true,
    vars: {
      APP_CONFIG: JSON.stringify({
        urls: { os: "https://os.iterate.com", notes: "https://notes.iterate.com" },
        denyZones: ["iterate.app", "iterate.com"],
      }),
    },
    durable_objects: { bindings: [{ name: "BROWSER_SESSION", class_name: "BrowserSession" }] },
    exports: { BrowserSession: { type: "durable-object", storage: "sqlite" } },
    observability: { enabled: true },
    no_bundle: true,
  };
  const config = startAppPreviewConfig(built, {
    issuer: "https://pr123-os.iterate-dev-preview.workers.dev",
    appOrigins: { dash: "https://pr123-dash.iterate-dev-preview.workers.dev" },
  });

  return { built, config };
}
