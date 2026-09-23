// specs/os/mini-app.spec.ts — a no-build userspace mini-app (Preact + capnweb from esm.sh, ONE HTML
// file) served by a project. Proves the "super simple mini-app" path end to end: install the app
// worker on a project with ONE itx.provide, open its project host, and a note round-trips through the
// app's OWN capnweb API (backed by the project's itx.kv). SWAPPABLE via DEMO_BASE_URL like the other
// specs; the signed-in person and their project are the forged-session fixture's, so it works local
// and deployed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- one bounded operator fixture installs the app; the app itself uses real browser RPC.
import { newHttpBatchRpcSession } from "capnweb";
import type { IterateApi } from "iterate/next/api";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";

test("a no-build mini-app served by a project persists a note through its own capnweb API", async ({
  page,
  baseURL,
  helpers,
}) => {
  const origin = new URL(baseURL!).origin;
  const { adminApiSecret, ingressRouting } = readOsPlaywrightAuthConfig();
  // The project's host: `<project>.<hostname>` — `localhost` under the local worker (scripts/dev.ts),
  // the deployment's subdomain routing otherwise (PROJECT_INGRESS_ROUTING, as the e2e suite spells it).
  const base = ingressRouting?.type === "subdomains" ? ingressRouting.hostname : undefined;
  test.skip(
    !base,
    "the deployment routes projects by paths or not at all; this spec dials a subdomain",
  );
  if (!base) return;

  // A signed-in person who owns a fresh project (the platform has no dashboard: creating a project
  // is the OS app's or a script's — here the fixture's, over /api with the admin bearer).
  await using fixture = await helpers.createFixture("mini");
  const { project } = fixture;

  // Install the mini-app as an app label — ONE rewrite rule. (An operator fixture here; a project
  // owner would run the same provide() through their own session.)
  const source = transformSync(
    readFileSync(resolve(import.meta.dirname, "../../apps/os/examples/mini-app.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  ).code;
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- bounded fixture setup
  using operator = newHttpBatchRpcSession<IterateApi>(
    new Request(`${origin}/api`, { headers: { authorization: `Bearer ${adminApiSecret}` } }),
  );
  await operator
    .authenticate({ type: "admin-secret", secret: adminApiSecret })
    .projects.get(project.id)
    .provide("itx.apps.notes", ["itx", "workers", ["get", { source: { "cap.js": source } }]]);

  // Open the app on notes--<project>.<base> and prove a note round-trips through /rpc.
  const appOrigin = new URL(origin);
  appOrigin.hostname = `notes--${project.slug}.${base}`;
  await page.goto(appOrigin.origin);
  await page.getByRole("heading", { name: "Mini Notes" }).waitFor();
  await page
    .getByTestId("status")
    .filter({ hasText: /^live$/ })
    .waitFor();

  const note = `written on the mini-app: ${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  await page.getByRole("textbox", { name: "New note" }).fill(note);
  await page.getByRole("textbox", { name: "New note" }).press("Enter");
  await page.getByTestId("notes").filter({ hasText: note }).waitFor();

  // Durable in the project's itx.kv — reload and it is still there.
  await page.reload();
  await page
    .getByTestId("status")
    .filter({ hasText: /^live$/ })
    .waitFor();
  await page.getByTestId("notes").filter({ hasText: note }).waitFor();
});
