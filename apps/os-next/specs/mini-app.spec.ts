// specs/mini-app.spec.ts — a no-build userspace mini-app (Preact + capnweb from esm.sh, ONE HTML file)
// served by a clean-room PROJECT. Proves the "super simple mini-app" path end to end: install the app
// worker on a project with ONE itx.provide, open its project host, and a note round-trips through the
// app's OWN capnweb API (backed by the project's itx.kv). SWAPPABLE via DEMO_BASE_URL like the other
// specs; sign-in is the page's password post, so it works local and deployed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { transformSync } from "esbuild";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- one bounded operator fixture installs the app; the app itself uses real browser RPC.
import { newHttpBatchRpcSession } from "capnweb";
import type { IterateRpcTarget } from "../src/session.ts";

const adminSecret = process.env.ADMIN_API_SECRET || "dev-admin-api-secret";
/** The deployment's sign-in password: the local worker's (scripts/dev.ts), else the run's. */
const loginPassword = process.env.LOGIN_PASSWORD || "dev";
const stamp = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

test("a no-build mini-app served by a project persists a note through its own capnweb API", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const email = `mini-${stamp()}@example.com`;
  const project = `mini-${stamp()}`;

  // Sign in — the page's own password post sets the session cookie (works local and deployed).
  const login = await page.request.post(`${origin}/login`, {
    headers: { Origin: origin },
    form: { email, password: loginPassword, next: "/" },
    maxRedirects: 0,
  });
  expect(login.status(), await login.text().catch(() => "")).toBe(302);

  // Create the project as that user, over /api with the admin bearer on the POST (the platform has no
  // dashboard: creating a project is the OS app's or a script's — here the fixture's).
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- bounded fixture setup
  using owner = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(`${origin}/api`, { headers: { authorization: `Bearer ${adminSecret}` } }),
  );
  // one pipelined round trip (an HTTP batch session ends with its first): create the project and
  // read its minted id — the project is addressed by it; `project` is its slug, its hosts' label
  const { projectId } = await owner
    .authenticate({ type: "admin-secret", secret: adminSecret, as: { email } })
    .projects.create({ project })
    .whoami();
  // The project's host: `<project>.<hostname>` — `localhost` under the local worker (scripts/dev.ts),
  // the deployment's subdomain routing otherwise (PROJECT_INGRESS_ROUTING, as the e2e suite spells it).
  const routing =
    new URL(origin).hostname === "localhost"
      ? { type: "subdomains", hostname: "localhost" }
      : (JSON.parse(process.env.PROJECT_INGRESS_ROUTING || "null") as {
          type: string;
          hostname?: string;
        } | null);
  const base = routing?.type === "subdomains" ? routing.hostname : undefined;
  test.skip(
    !base,
    "the deployment routes projects by paths or not at all; this spec dials a subdomain",
  );
  if (!base) return;
  const projectOrigin = new URL(origin);
  projectOrigin.hostname = `${project}.${base}`;

  // Install the mini-app as an app label — ONE rewrite rule. (An operator fixture here; a project
  // owner would run the same provide() through their own session.)
  const source = transformSync(
    readFileSync(resolve(import.meta.dirname, "../examples/mini-app.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  ).code;
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- bounded fixture setup
  using operator = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(`${origin}/api`, { headers: { authorization: `Bearer ${adminSecret}` } }),
  );
  await operator
    .authenticate({ type: "admin-secret", secret: adminSecret })
    .projects.get(projectId)
    .provide("itx.apps.notes", ["itx", "workers", ["get", { source: { "cap.js": source } }]]);

  // Open the app on notes--<project>.<base> and prove a note round-trips through /rpc.
  projectOrigin.hostname = `notes--${project}.${base}`;
  await page.goto(projectOrigin.origin);
  await page.getByRole("heading", { name: "Mini Notes" }).waitFor();
  await expect(page.getByTestId("status")).toHaveText("live");

  const note = `written on the mini-app: ${stamp()}`;
  await page.getByRole("textbox", { name: "New note" }).fill(note);
  await page.getByRole("textbox", { name: "New note" }).press("Enter");
  await page.getByTestId("notes").filter({ hasText: note }).waitFor();

  // Durable in the project's itx.kv — reload and it is still there.
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText("live");
  await page.getByTestId("notes").filter({ hasText: note }).waitFor();
});
