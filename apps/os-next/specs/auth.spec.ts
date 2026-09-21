// Browser acceptance for the current OAuth contract. Google identity proof is covered separately;
// the sign-in page's password step (`login.password`, src/app-config.ts — the local worker's is
// scripts/dev.ts's, a deployment's is handed to the run as LOGIN_PASSWORD) is how these sign in.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- Bounded fixture setup; browser actions use the app's real WebSocket.
import { newHttpBatchRpcSession } from "capnweb";
import { transformSync } from "esbuild";
import { authorizationCodeRequest } from "iterate/next/oauth";
import type { IterateRpcTarget } from "../src/session.ts";

const claudeClient = "https://claude.ai/oauth/claude-code-client-metadata";
const stamp = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
const isLocal = (origin: string) => new URL(origin).hostname === "localhost";
const adminSecret = (origin: string) => {
  const secret = process.env.ADMIN_API_SECRET || (isLocal(origin) && "dev-admin-api-secret");
  if (!secret) throw new Error("ADMIN_API_SECRET is required for the deployed operator fixture");
  return secret;
};
/** The deployment's sign-in password: the local worker's (scripts/dev.ts), else the run's. */
const loginPassword = (origin: string) => {
  const password = process.env.LOGIN_PASSWORD || (isLocal(origin) && "dev");
  if (!password) throw new Error("LOGIN_PASSWORD is required to sign in to a deployed worker");
  return password;
};

/** Sign in on the page the way a person does: the email, the password, Sign in — the password
 *  field is on the first step where the page shows it at once, else behind Continue. */
async function signIn(page: Page, origin: string, email: string, _next = "/") {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  const password = page.getByRole("textbox", { name: "Password", exact: true });
  if (!(await password.isVisible()))
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  await password.fill(loginPassword(origin));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function cookieHeaders(context: BrowserContext, origin: string) {
  return {
    Origin: origin,
    Cookie: (await context.cookies(origin)).map(({ name, value }) => `${name}=${value}`).join("; "),
  };
}

async function mcp(origin: string, token: string, name: string, args = {}) {
  const response = await fetch(origin, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const message = body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(message ? message.slice(6) : body);
}

test("first Claude consent creates the organization and project on the consent page before granting MCP access", async ({
  page,
  context,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const resource = process.env.MCP_BASE_URL || `${origin}/mcp`;
  const email = `consent-${stamp()}@example.com`;
  // the organization the onboarding step makes with the first project
  const firstOrg = "First consent studio";
  const project = `consent-${stamp()}`;
  const otherProject = `unselected-${stamp()}`;
  const thirdProject = `third-${stamp()}`;
  let receiveCallback!: (url: URL) => void;
  const callback = new Promise<URL>((resolve) => {
    receiveCallback = resolve;
  });
  const listener = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<h1>Claude authorization completed</h1>");
    receiveCallback(url);
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/callback`;
  const flow = await authorizationCodeRequest({
    issuer: origin,
    clientId: claudeClient,
    redirectUri,
    resources: [resource, `${origin}/api`],
    scopes: ["iterate", "account"],
  });
  // Repeated resource keys and '+' form encoding must survive the page's form round trips.
  const expectedState = `${flow.state} + OAuth state`;
  flow.url.searchParams.set("state", expectedState);
  const sockets: string[] = [];
  const errors: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  // a slug the deployment's own organization holds — the onboarding step's refused first try below
  const takenSlug = `taken-${stamp()}`;
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- bounded fixture setup
  using operator = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(`${origin}/api`, { headers: { authorization: `Bearer ${adminSecret(origin)}` } }),
  );
  using _taken = await operator
    .authenticate({ type: "admin-secret", secret: adminSecret(origin) })
    .projects.create({ project: takenSlug });
  try {
    await page.goto(flow.url.href);
    await signIn(page, origin, email, flow.url.pathname + flow.url.search);
    await Promise.race([
      page.getByRole("heading", { name: "Create a project", exact: true }).waitFor(),
      callback.then((url) => {
        throw new Error(
          `Authorization ended before consent: ${url.searchParams.get("error")}: ${url.searchParams.get("error_description")}`,
        );
      }),
    ]);
    expect(new URL(page.url()).search).toBe(flow.url.search);
    // the page with no projects has optional parts left out — none may render as the text "null"
    expect(await page.getByText("null", { exact: true }).count()).toBe(0);
    // The onboarding step, before consent, for a person with no project yet: the organization's
    // name and the first project's slug — typed "Consent Studio …", it reads consent-studio-… —
    // with where it will live. Continue makes both and the consent page follows.
    expect(await page.getByRole("button", { name: "Approve", exact: true }).count()).toBe(0);
    // both start filled the way apps/auth fills them — the organization from the email's domain
    // (example.com → "Example"), the slug from the organization, following it until edited
    const orgField = page.getByRole("textbox", { name: "Organization name", exact: true });
    const projectField = page.getByRole("textbox", { name: "Project slug", exact: true });
    expect(await orgField.inputValue()).toBe("Example");
    expect(await projectField.inputValue()).toBe("example");
    await orgField.fill(firstOrg);
    expect(await projectField.inputValue()).toBe("first-consent-studio");
    await projectField.fill(`Consent Studio ${project}`);
    expect(await projectField.inputValue()).toBe(`consent-studio-${project}`);
    // where the project will live, in the deployment's own routing (public/authorize.js): a subdomain
    // under the hostname, or a path on this origin — a local worker routes by subdomain under
    // localhost; a deployed target says so with PROJECT_INGRESS_ROUTING, as the e2e lane does
    const routing = isLocal(origin)
      ? { type: "subdomains", hostname: "localhost" }
      : (JSON.parse(process.env.PROJECT_INGRESS_ROUTING || "null") as {
          type: string;
          hostname?: string;
        } | null);
    if (routing?.type === "subdomains")
      await page
        .getByText(`Your project will be hosted at consent-studio-${project}.${routing.hostname}`)
        .waitFor();
    else if (routing?.type === "paths")
      await page
        .getByText(`Your project will be hosted at ${origin}/projects/consent-studio-${project}/`)
        .waitFor();
    // A refused first try — a slug another organization holds, refused after the organization is
    // made — answers with that organization: the retry offers it, chosen, rather than naming a
    // second one (the inventory at the end counts one).
    await projectField.fill(takenSlug);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: /already taken/ })
      .waitFor();
    const madeOrg = page.getByRole("combobox", { name: "Organization", exact: true });
    expect(await madeOrg.locator("option:checked").textContent()).toBe(firstOrg);
    expect(await orgField.isVisible()).toBe(false);
    await projectField.fill(project);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "Authorize Claude Code", exact: true }).waitFor();
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    // Task-based consent: `iterate` is fixed, the account permission is optional — untick it; the
    // choice survives every round trip below and the grant carries `iterate` alone.
    const projectAccess = page.getByRole("checkbox", {
      name: "Read and make changes in the projects you grant it",
      exact: true,
    });
    expect(await projectAccess.isChecked()).toBe(true);
    expect(await projectAccess.isDisabled()).toBe(true);
    const accountAccess = page.getByRole("checkbox", {
      name: "See and end your sessions, and mint personal access tokens",
      exact: true,
    });
    expect(await accountAccess.isChecked()).toBe(true);
    await accountAccess.uncheck();
    const choice = page.getByRole("checkbox", { name: `${project} in ${firstOrg}`, exact: true });
    await choice.waitFor();
    expect(await choice.isChecked()).toBe(true);
    // The either/or: one checkbox for every project now and later, else the projects ticked —
    // a Claude grant starts with the ticked ones.
    const future = page.getByRole("checkbox", {
      name: "All my projects, now and future",
      exact: true,
    });
    expect(await future.isChecked()).toBe(false);
    await choice.uncheck();
    expect(await approve.isDisabled()).toBe(true);
    // A second project in a NEW organization, named inside "New project" — the one place the
    // consent flow creates one. Refreshing the directory must preserve the choices made so far.
    await page.getByRole("button", { name: "New project", exact: true }).click();
    await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(otherProject);
    // the new organization's name field opens for "New organization…" alone
    const organization = page.getByRole("textbox", { name: "Organization name", exact: true });
    expect(await organization.isVisible()).toBe(false);
    await page
      .getByRole("combobox", { name: "Organization", exact: true })
      .selectOption({ label: "New organization…" });
    await organization.fill("Second studio");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const otherChoice = page.getByRole("checkbox", {
      name: `${otherProject} in Second studio`,
      exact: true,
    });
    await otherChoice.waitFor();
    expect(await otherChoice.isChecked()).toBe(true);
    expect(await choice.isChecked()).toBe(false);
    await page.getByRole("region", { name: firstOrg, exact: true }).waitFor();
    await page.getByRole("region", { name: "Second studio", exact: true }).waitFor();
    await page
      .getByRole("status")
      .filter({ hasText: /^1 selected$/ })
      .waitFor();
    await choice.check();
    await otherChoice.uncheck();
    await future.check();
    expect(await choice.isChecked()).toBe(true);
    expect(await otherChoice.isChecked()).toBe(true);
    expect(await otherChoice.isDisabled()).toBe(true);
    // with "all" ticked the checkbox says it: the count is hidden
    await page.getByRole("status").waitFor({ state: "hidden" });
    // A create while "all" is chosen re-renders the parked list; the new project goes into the
    // FIRST organization, so the boxes' order (grouped by organization) differs from the projects'
    // creation order — the ticks must come back to the right boxes.
    await page.getByRole("button", { name: "New project", exact: true }).click();
    await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(thirdProject);
    await page
      .getByRole("combobox", { name: "Organization", exact: true })
      .selectOption({ label: firstOrg });
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const thirdChoice = page.getByRole("checkbox", {
      name: `${thirdProject} in ${firstOrg}`,
      exact: true,
    });
    await thirdChoice.waitFor();
    expect(await thirdChoice.isChecked()).toBe(true);
    expect(await thirdChoice.isDisabled()).toBe(true);
    await future.uncheck();
    expect(await choice.isChecked()).toBe(true);
    expect(await thirdChoice.isChecked()).toBe(true);
    expect(await otherChoice.isChecked()).toBe(false);
    await page
      .getByRole("status")
      .filter({ hasText: /^2 selected$/ })
      .waitFor();
    await thirdChoice.uncheck();
    await page
      .getByRole("status")
      .filter({ hasText: /^1 selected$/ })
      .waitFor();
    expect(new URL(page.url()).search).toBe(flow.url.search);
    expect(await accountAccess.isChecked()).toBe(false);
    // The consent page is a capnweb client of /api like any app: ONE socket for the whole flow,
    // the session cookie riding its handshake — no JSON sibling, no form post.
    expect(sockets.filter((url) => new URL(url).pathname === "/api")).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath("first-consent.png"), fullPage: true });
    await approve.click();
    await page
      .getByRole("heading", { name: "Claude authorization completed", exact: true })
      .waitFor();
    const result = await callback;
    expect(result.searchParams.get("state")).toBe(expectedState);
    expect(result.searchParams.get("iss")).toBe(origin);
    expect(result.searchParams.get("error")).toBeNull();
    const exchange = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: claudeClient,
        redirect_uri: redirectUri,
        code: result.searchParams.get("code")!,
        code_verifier: flow.verifier,
        resource,
      }),
    });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    const tokens = (await exchange.json()) as { access_token: string };
    // The inventory, in one batch (an HTTP batch session ends with its first round trip): the
    // issuer grant and the Claude grant are the only two sessions created; the onboarding step's
    // refused first try made ONE organization, not one per try; and the projects' minted ids, by
    // which alone a project is addressed (the page showed their slugs).
    const headers = await cookieHeaders(context, origin);
    // eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded inventory assertion after the UI flow.
    using api = newHttpBatchRpcSession<IterateRpcTarget>(new Request(`${origin}/api`, { headers }));
    const session = api.authenticate({ type: "from-server-cookie" });
    const [inventory, orgs, listed] = await Promise.all([
      session.grants.list(),
      session.orgs(),
      session.projects.list(),
    ]);
    expect(inventory.items).toHaveLength(2);
    expect(inventory.items.filter((item) => item.current)).toHaveLength(1);
    expect(orgs.map((org) => org.name).sort()).toEqual([firstOrg, "Second studio"]);
    const idOf = (slug: string) => listed.find((candidate) => candidate.slug === slug)!.id;
    expect(idOf(project)).toMatch(/^prj_[0-9a-f]{32}$/);
    // The one MCP tool is `run`: the Claude grant reaches the CONSENTED project (a run there succeeds
    // and itx.whoami() names it, by id) and no other (a run in the unselected project is refused).
    const reached = await mcp(resource, tokens.access_token, "run", {
      project: idOf(project),
      script: "async (itx) => itx.whoami()",
    });
    expect(reached.result.isError).toBe(false);
    expect(reached.result.content[0].text).toContain(idOf(project));
    const denied = await mcp(resource, tokens.access_token, "run", {
      project: idOf(otherProject),
      script: "async (itx) => itx.whoami()",
    });
    expect(denied.result.isError).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the Notes app works on its own origin and through a project config worker", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !process.env.NOTES_BASE_URL,
    "This acceptance case needs the independently deployed Notes worker",
  );
  const origin = new URL(baseURL!).origin;
  const notesOrigin = new URL(process.env.NOTES_BASE_URL!).origin;
  const email = `notes-${stamp()}@example.com`;
  const project = `notes-${stamp()}`;
  const note = `Written on the independent app: ${stamp()}`;
  // the note's textbox is named by the file it edits (apps/notes/src/routes/_auth/notes.tsx)
  const noteFile = "/repos/config/notes/log.md";
  await page.goto(`${origin}/login`);
  await signIn(page, origin, email);
  await page.getByRole("textbox", { name: "New project" }).fill(project);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: "open", exact: true }).waitFor();
  const projectOrigin = new URL(
    (await page.getByRole("link", { name: "open", exact: true }).getAttribute("href"))!,
  ).origin;
  // The notes app on this project is served at the app-slug host notes--<project>.<base> (the edge
  // hands the config worker x-iterate-app: notes), not the apex — the apex has no app label.
  const appOrigin = projectOrigin.replace(`${project}.`, `notes--${project}.`);
  const source = transformSync(
    readFileSync(resolve(import.meta.dirname, "../../../apps/notes/config-worker.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  ).code;
  // Install the repository's actual config-worker source, preserving its auth.require gate.
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- One operator fixture installs the proxy; all app interactions are real browser RPC.
  using operator = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(`${origin}/api`, { headers: { authorization: `Bearer ${adminSecret(origin)}` } }),
  );
  const projectContext = operator
    .authenticate({ type: "admin-secret", secret: adminSecret(origin) })
    .projects.get(project);
  // Both rules in ONE batch (an HTTP-batch session is one-shot): install the config worker, and point
  // the `notes` app label at it — so notes--<project>.<base> reaches the config worker with the app
  // slug in x-iterate-app (the apps/os header), and it fetches through to the Notes worker.
  await Promise.all([
    projectContext.append({
      type: "events.iterate.com/project/ingress-configured",
      payload: { target: ["itx", "workers", ["get", { source: { "cap.js": source } }]] },
    }),
    projectContext.provide("itx.apps.notes", [
      "itx",
      "workers",
      ["get", { source: { "cap.js": source } }],
    ]),
  ]);
  await page.goto(notesOrigin);
  await page.getByRole("link", { name: "Log in with iterate", exact: true }).click();
  await page
    .getByRole("heading", { name: `Authorize ${new URL(notesOrigin).host}`, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("textbox", { name: noteFile, exact: true }).fill(note);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Committed / })
    .waitFor();
  await page.reload();
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(note);
  await page.goto(`${appOrigin}/notes`);
  await page
    .getByRole("heading", { name: `Authorize ${new URL(appOrigin).host}`, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(note);
  await page
    .getByRole("textbox", { name: noteFile, exact: true })
    .fill(`${note}; edited through the project proxy`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Committed / })
    .waitFor();
  await page.goto(`${notesOrigin}/notes`);
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(
    `${note}; edited through the project proxy`,
  );
  await page.goto(`${origin}/sessions`);
  const appSession = page.getByRole("row").filter({ hasText: new URL(appOrigin).host });
  await appSession.getByRole("button", { name: "Log out", exact: true }).click();
  await page.goto(`${appOrigin}/notes`);
  await page
    .getByRole("heading", { name: `Authorize ${new URL(appOrigin).host}`, exact: true })
    .waitFor();
  // The independently granted Notes session remains usable after proxy revocation.
  await page.goto(`${notesOrigin}/notes`);
  await page.getByRole("textbox", { name: noteFile, exact: true }).waitFor();
  const cookies = await context.cookies();
  expect(
    cookies
      .filter((cookie) => cookie.name.startsWith("__Host-itx-session"))
      .every((cookie) => cookie.httpOnly && cookie.secure),
  ).toBe(true);
});
