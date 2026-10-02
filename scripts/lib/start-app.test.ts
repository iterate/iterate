import { expect, test } from "vitest";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { dashEnvs, docsEnvs, notesEnvs, voiceEnvs } from "../../envs.ts";
import { ownZones, startAppWorkerConfig } from "./start-app.ts";

test("a per-commit deployment's app is a worker of its own, signs in against that deployment's core/os and links to its apps", () => {
  const config = startAppWorkerConfig(
    {
      name: "notes",
      root: new URL("file:///apps/notes/"),
      dopplerProject: "notes",
      envs: notesEnvs,
    },
    "pr3144-a1b2c3d",
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(config).toMatchObject({
    name: "pr3144-a1b2c3d-notes",
    account_id: notesEnvs.preview.cloudflareAccountId,
    workers_dev: true,
  });
  expect(config).not.toHaveProperty("routes");
  // its own deployment's core/os and apps, none of main on dev's or prd's
  expect(startAppConfigOf({ ...config.vars })).toMatchObject({
    urls: {
      os: "https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev",
      dash: "https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev",
      notes: "https://pr3144-a1b2c3d-notes.iterate-dev-preview.workers.dev",
    },
    // what it installs in a project: the commit its packages are published at, which preview.ts hands it
    pkgPrNewRef: "0123456789abcdef0123456789abcdef01234567",
  });
});

test("a per-commit deployment's app refuses to build without the commit its packages are at", () => {
  expect(() =>
    startAppWorkerConfig(
      {
        name: "docs",
        root: new URL("file:///apps/docs/"),
        dopplerProject: "_shared",
        envs: docsEnvs,
      },
      "pr3144-a1b2c3d",
      undefined,
    ),
  ).toThrow("PUBLISHED_PACKAGE_COMMIT");
});

test("on workers.dev our own zones are our apps' hosts, not the accounts they share with anyone's worker", () => {
  const zones = ownZones();
  // a worker anyone deploys to these accounts (a self-host tried out on one) is not under any of them
  expect(zones.filter((zone) => zone.endsWith(".workers.dev"))).toEqual([
    "admin.iterate-dev-preview.workers.dev",
    "agents.iterate-dev-preview.workers.dev",
    "dash.iterate-dev-preview.workers.dev",
    "docs.iterate-dev-preview.workers.dev",
    "docs.iterate.workers.dev",
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
    { name: "dash", root: new URL("file:///apps/dash/"), dopplerProject: "dash", envs: dashEnvs },
    "prd",
    undefined,
  );
  expect(JSON.parse(vars.APP_CONFIG)).toMatchObject({
    urls: {
      os: "https://os.iterate.com",
      dash: "https://dash.iterate.com",
      agents: "https://agents.iterate.com",
      notes: "https://notes.iterate.com",
      admin: "https://admin.iterate.com",
      voice: "https://voice.iterate.com",
    },
    pkgPrNewRef: "main",
  });
});

test("main on dev (the app's `preview` build) signs in against main on dev's core/os and links to its other apps", () => {
  const { vars } = startAppWorkerConfig(
    { name: "dash", root: new URL("file:///apps/dash/"), dopplerProject: "dash", envs: dashEnvs },
    "preview",
    undefined,
  );
  expect(JSON.parse(vars.APP_CONFIG)).toMatchObject({
    urls: {
      os: "https://os.iterate-dev-preview.workers.dev",
      dash: "https://dash.iterate-dev-preview.workers.dev",
      agents: "https://agents.iterate-dev-preview.workers.dev",
      notes: "https://notes.iterate-dev-preview.workers.dev",
      admin: "https://admin.iterate-dev-preview.workers.dev",
      voice: "https://voice.iterate-dev-preview.workers.dev",
    },
  });
});

test("the app reads the config it is deployed with as written, and a laptop's .dev.vars names a local platform on top", () => {
  const { vars } = startAppWorkerConfig(
    {
      name: "voice",
      root: new URL("file:///apps/voice/"),
      dopplerProject: "voice",
      envs: voiceEnvs,
    },
    "prd",
    undefined,
  );
  expect(startAppConfigOf({ ...vars })).toMatchObject({
    urls: { os: "https://os.iterate.com", dash: "https://dash.iterate.com" },
    denyZones: ownZones(),
    posthogProjectKey: voiceEnvs.prd.posthogProjectKey,
  });
  // local dev starts from prd's config (no env) and overrides one key, keeping the rest
  const local = startAppWorkerConfig(
    { name: "dash", root: new URL("file:///apps/dash/"), dopplerProject: "dash", envs: dashEnvs },
    undefined,
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
    {
      name: "dash",
      root: new URL("../../apps/dash/", import.meta.url),
      dopplerProject: "dash",
      envs: dashEnvs,
    },
    "prd",
    undefined,
  );
  expect(dash.assets).toMatchObject({
    run_worker_first: ["/*", "!/assets/*", "!/client-logo.svg", "!/logos/*"],
  });
});
