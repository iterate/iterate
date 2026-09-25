import { expect, test } from "vitest";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { dashEnvs, kitEnvs, notesEnvs } from "../../envs.ts";
import { ownZones, startAppWorkerConfig } from "./start-app.ts";

test("a per-commit deployment's app is a worker of its own, signs in against that deployment's apps/os and links to its apps", () => {
  const config = startAppWorkerConfig(
    { name: "notes", root: new URL("file:///apps/notes/"), envs: notesEnvs },
    "pr3144-a1b2c3d",
  );
  expect(config).toMatchObject({
    name: "pr3144-a1b2c3d-notes",
    account_id: notesEnvs.preview.cloudflareAccountId,
    workers_dev: true,
  });
  expect(config).not.toHaveProperty("routes");
  // its own deployment's apps/os and apps, none of main on dev's or prd's
  expect(startAppConfigOf({ ...config.vars })).toMatchObject({
    urls: {
      os: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
      dash: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      notes: "https://pr3144-a1b2c3d-notes.iterate-dev-preview.workers.dev",
    },
  });
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

test("main on dev (the app's `preview` build) signs in against main on dev's apps/os and links to its other apps", () => {
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
  // a directory of public files is one rule
  const kit = startAppWorkerConfig(
    { name: "kit", root: new URL("../../apps/kit/", import.meta.url), envs: kitEnvs },
    "prd",
  );
  expect(kit.assets).toMatchObject({
    run_worker_first: expect.arrayContaining(["/*", "!/assets/*", "!/favicon.svg", "!/vendors/*"]),
  });
});
