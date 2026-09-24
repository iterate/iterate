// Browser acceptance for the current OAuth contract. Google identity proof is covered separately;
// the sign-in page's password step (`login.password`, src/app-config.ts — the local worker's is
// scripts/dev.ts's, a deployment's is handed to the run as LOGIN_PASSWORD) is how these sign in.
import { createServer } from "node:http";
import { listenOnFetchSafePort } from "@iterate-com/shared/test-support/fetch-safe-port";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { newHttpBatchRpcSession } from "capnweb";
import { authorizationCodeRequest } from "iterate/next/oauth";
import type { IterateApi } from "iterate/next/api";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { claudeClient, signInWithPassword } from "../test-support/issuer.ts";
import { test } from "../test-support/test.ts";

test("first Claude consent creates the organization and project on the consent page before granting MCP access", async ({
  page,
  context,
  baseURL,
  operator,
}) => {
  const origin = new URL(baseURL!).origin;
  const { ingressRouting, mcpBaseUrl: resource } = readOsPlaywrightAuthConfig();
  const email = `${uniqueFixtureSlug("consent")}@example.com`;
  // the organization the onboarding step makes with the first project
  const firstOrg = "First consent studio";
  const project = uniqueFixtureSlug("consent");
  const otherProject = uniqueFixtureSlug("unselected");
  const thirdProject = uniqueFixtureSlug("third");
  const choice = `${project} in ${firstOrg}`;
  const otherChoice = `${otherProject} in Second studio`;
  const thirdChoice = `${thirdProject} in ${firstOrg}`;
  const projectAccess = "Read and make changes in the projects you grant it";
  const accountAccess = "See and end your sessions, and mint personal access tokens";
  const future = "All my projects, now and future";
  /** A checkbox on the consent page, by its label, optionally in a given state. */
  const checkbox = (name: string, state: { checked?: boolean; disabled?: boolean } = {}) =>
    page.getByRole("checkbox", { name, exact: true, ...state });
  /** The element with keyboard focus, when it is `locator`. */
  const focused = (locator: ReturnType<Page["locator"]>) => locator.and(page.locator(":focus"));
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
  // Chromium refuses the same bad ports fetch does (ERR_UNSAFE_PORT) when it follows the redirect.
  const redirectUri = `http://127.0.0.1:${await listenOnFetchSafePort(listener)}/callback`;
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
  const takenSlug = uniqueFixtureSlug("taken");
  using _taken = await operator.projects.create({ project: takenSlug });
  try {
    await page.goto(flow.url.href);
    await signInWithPassword(page, email);
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
    // with where it will live. Review permissions makes both and opens the review step.
    expect(await page.getByRole("button", { name: "Authorize", exact: true }).count()).toBe(0);
    // Both start filled from the email's domain — the organization
    // (example.com → "Example"), the slug from the organization, following it until edited
    const orgField = page.getByRole("textbox", { name: "Organization name", exact: true });
    const projectField = page.getByRole("textbox", { name: "Project slug", exact: true });
    expect(await orgField.inputValue()).toBe("Example");
    expect(await projectField.inputValue()).toBe("example");
    await orgField.fill(firstOrg);
    expect(await projectField.inputValue()).toBe("first-consent-studio");
    await projectField.fill(`Consent Studio ${project}`);
    expect(await projectField.inputValue()).toBe(`consent-studio-${project}`);
    // where the project will live, in the deployment's own routing: a subdomain under the
    // hostname, or a path on this origin — a local worker routes by subdomain under localhost; a
    // deployed target says so with PROJECT_INGRESS_ROUTING, as the e2e suite does (specs/setup.ts)
    if (ingressRouting?.type === "subdomains")
      await page
        .getByText(
          `Your project will be hosted at consent-studio-${project}.${ingressRouting.hostname}`,
        )
        .waitFor();
    else if (ingressRouting?.type === "paths")
      await page
        .getByText(`Your project will be hosted at ${origin}/projects/consent-studio-${project}/`)
        .waitFor();
    // A refused first try — a slug another organization holds, refused after the organization is
    // made — answers with that organization: the retry offers it, chosen, rather than naming a
    // second one (the inventory at the end counts one).
    await projectField.fill(takenSlug);
    await page.getByRole("button", { name: "Review permissions", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: /already taken/ })
      .waitFor();
    await focused(page.getByRole("alert")).waitFor();
    const madeOrg = page.getByRole("combobox", { name: "Organization", exact: true });
    expect(await madeOrg.locator("option:checked").textContent()).toBe(firstOrg);
    expect(await orgField.count()).toBe(0);
    await projectField.fill(project);
    await page.getByRole("button", { name: "Review permissions", exact: true }).click();
    await page
      .getByRole("heading", { name: "Claude Code wants to access your account", exact: true })
      .waitFor();
    // the client's heading stands on every step; the permissions step's own heading is what the
    // project, once created, opens ("Creating project…" shows meanwhile)
    await page.getByRole("heading", { name: "Review permissions", exact: true }).waitFor();
    // Task-based consent: `iterate` is fixed, the account permission is optional — untick it; the
    // choice survives every round trip below and the grant carries `iterate` alone.
    await checkbox(projectAccess, { checked: true, disabled: true }).waitFor();
    await checkbox(accountAccess, { checked: true }).uncheck();
    await page.getByRole("button", { name: "Edit selected projects", exact: true }).click();
    const review = page.getByRole("button", { name: "Review permissions", exact: true });
    await checkbox(choice, { checked: true }).waitFor();
    expect(await page.getByText("null", { exact: true }).count()).toBe(0);
    // The either/or: one checkbox for every project now and later, else the projects ticked —
    // grants start with all current and future projects.
    await checkbox(future, { checked: true }).waitFor();
    await checkbox(choice, { disabled: true }).waitFor();
    await checkbox(future).uncheck();
    await checkbox(choice).uncheck();
    await page
      .getByRole("button", { name: "Review permissions", exact: true, disabled: true })
      .waitFor();
    // A second project in a NEW organization, named inside "New project" — the one place the
    // consent flow creates one. Refreshing the directory must preserve the choices made so far.
    // Review never creates the unfinished draft. Editing again keeps it available.
    await checkbox(choice).check();
    await page.getByRole("button", { name: "New project", exact: true }).click();
    await focused(projectField).waitFor();
    await page.getByRole("button", { name: "New project", exact: true }).click();
    await focused(page.getByRole("button", { name: "New project", exact: true })).waitFor();
    await page.getByRole("button", { name: "New project", exact: true }).click();
    await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(otherProject);
    await review.click();
    await focused(page.getByRole("heading", { name: "Review permissions", exact: true })).waitFor();
    expect(
      await page.getByRole("region", { name: "Selected projects" }).textContent(),
    ).not.toContain(otherProject);
    await page.getByRole("button", { name: "Edit selected projects", exact: true }).click();
    expect(
      await page.getByRole("textbox", { name: "Project slug", exact: true }).inputValue(),
    ).toBe(otherProject);
    await checkbox(choice).uncheck();
    // the new organization's name field opens for "New organization…" alone
    const organization = page.getByRole("textbox", { name: "Organization name", exact: true });
    expect(await organization.count()).toBe(0);
    await page
      .getByRole("combobox", { name: "Organization", exact: true })
      .selectOption({ label: "New organization…" });
    await organization.fill("Second studio");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await checkbox(otherChoice, { checked: true }).waitFor();
    await checkbox(choice, { checked: false }).waitFor();
    await page
      .getByRole("group", { name: "Projects it may reach" })
      .filter({ hasText: firstOrg })
      .waitFor();
    await page
      .getByRole("group", { name: "Projects it may reach" })
      .filter({ hasText: "Second studio" })
      .waitFor();
    await checkbox(choice).check();
    await checkbox(otherChoice).uncheck();
    await checkbox(future).check();
    await checkbox(choice, { checked: true }).waitFor();
    await checkbox(otherChoice, { checked: true, disabled: true }).waitFor();
    // A create while "all" is chosen re-renders the parked list; the new project goes into the
    // FIRST organization; each project keeps its own choice when all is switched off.
    await page.getByRole("button", { name: "New project", exact: true }).click();
    await page.getByRole("textbox", { name: "Project slug", exact: true }).fill(thirdProject);
    await page
      .getByRole("combobox", { name: "Organization", exact: true })
      .selectOption({ label: firstOrg });
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await checkbox(thirdChoice, { checked: true, disabled: true }).waitFor();
    await checkbox(future).uncheck();
    await checkbox(choice, { checked: true }).waitFor();
    await checkbox(thirdChoice, { checked: true }).waitFor();
    await checkbox(otherChoice, { checked: false }).waitFor();
    await checkbox(thirdChoice).uncheck();
    expect(new URL(page.url()).search).toBe(flow.url.search);
    await review.click();
    await checkbox(accountAccess, { checked: false }).waitFor();
    await page
      .getByRole("region", { name: "Selected projects" })
      .filter({ hasText: project })
      .waitFor();
    expect(
      await page.getByRole("region", { name: "Selected projects" }).textContent(),
    ).not.toContain(otherProject);
    // The consent page is server-rendered: its reads and actions are server functions and one
    // form post, so it opens no /api socket.
    expect(sockets.filter((url) => new URL(url).pathname === "/api")).toHaveLength(0);
    await page.screenshot({ path: test.info().outputPath("first-consent.png"), fullPage: true });
    await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
    await page
      .getByRole("heading", { name: "Claude authorization completed", exact: true })
      .waitFor();
    const result = await callback;
    expect(result.searchParams.get("state")).toBe(expectedState);
    expect(result.searchParams.get("iss")).toBe(origin);
    expect(result.searchParams.get("error")).toBeNull();
    const exchange = await fetch(`${origin}/oauth2/token`, {
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
    // oxlint-disable-next-line iterate/no-capnweb-http-batch -- One bounded inventory assertion after the UI flow.
    using api = newHttpBatchRpcSession<IterateApi>(new Request(`${origin}/api`, { headers }));
    const session = api.authenticate({ type: "from-server-cookie" });
    const [inventory, orgs, listed] = await Promise.all([
      session.grants.list(),
      session.organizations.list(),
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
    expect(reached.result).toMatchObject({ isError: false });
    expect(reached.result.content[0].text).toContain(idOf(project));
    const denied = await mcp(resource, tokens.access_token, "run", {
      project: idOf(otherProject),
      script: "async (itx) => itx.whoami()",
    });
    expect(denied.result).toMatchObject({ isError: true });
    expect(errors).toEqual([]);
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
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
  expect(response, body).toMatchObject({ status: 200 });
  const message = body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(message ? message.slice(6) : body);
}
