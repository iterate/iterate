// A no-build userspace mini-app (Preact + capnweb from esm.sh, ONE HTML file) served by a project.
// Proves the "super simple mini-app" path end to end: publish a config worker that routes the `notes`
// routing slug to the app module in plain code, open it, and a note round-trips through the app's OWN capnweb API
// (backed by the project's itx.kv). SWAPPABLE via WORKER_BASE_URL like the other specs; the signed-in
// person and their project are the signed-in session fixture's, so it works local and deployed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { transformSync } from "esbuild";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";

test("a no-build mini-app served by a project persists a note through its own capnweb API", async ({
  page,
  baseURL,
  helpers,
}) => {
  const origin = new URL(baseURL!).origin;
  const { ingressRouting } = readOsPlaywrightAuthConfig();

  // A signed-in person who owns a fresh project (the platform has no dashboard: creating a project
  // is the OS app's or a script's — here the fixture's, over /api with the admin bearer).
  await using fixture = await helpers.createFixture("mini");
  const { project } = fixture;

  // Publish a config worker that serves the mini-app on the `notes` routing slug — the app module
  // beside a router that branches on x-iterate-routing-slug. (The fixture's operator handle here; a
  // project owner commits the same worker to their config repo.)
  const miniApp = transformSync(
    readFileSync(resolve(import.meta.dirname, "../../apps/os/examples/mini-app.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  ).code;
  const router = `import { WorkerEntrypoint } from "cloudflare:workers";
import MiniApp from "./mini-app.js";
export default class extends WorkerEntrypoint {
  fetch(request) {
    if (request.headers.get("x-iterate-routing-slug") === "notes")
      return new MiniApp(this.ctx, this.env).fetch(request);
    return new Response("Not found\\n", { status: 404 });
  }
}`;
  // after the project's own saga has published its seed, which would otherwise land after and win
  await fixture.itx.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  await fixture.itx.append({
    type: "events.iterate.com/itx/ingress-configured",
    payload: {
      target: [
        "itx",
        "workers",
        ["get", { source: { "worker.js": router, "mini-app.js": miniApp } }],
      ],
    },
  });

  // Open the app on its routing slug, in the deployment's own routing (PROJECT_INGRESS_ROUTING, as
  // the e2e suite spells it): notes--<project>.<hostname> under subdomains — `localhost` under the
  // local worker (scripts/dev.ts) — and <platform>/projects/<project>/notes/ under paths. Then prove
  // a note round-trips through /rpc.
  await page.goto(
    projectUrlOf(ingressRouting, origin, { project: project.slug, routingSlug: "notes" })!.href,
  );
  await page.getByRole("heading", { name: "Mini Notes" }).waitFor();
  await page
    .getByTestId("status")
    .filter({ hasText: /^live$/ })
    .waitFor();

  const note = `written on the mini-app: ${uniqueFixtureSlug("note")}`;
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
