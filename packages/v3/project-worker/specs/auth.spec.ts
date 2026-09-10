// auth.spec.ts — TODAY'S AUTH BUILD, END TO END, IN A REAL BROWSER (docs/plan-auth-one-lane-2026-09-09.md
// rev 3; BUILD-LOG 2026-09-09, the six "auth" entries): the console's login and account page; a project
// created there and opened onto its host; the host cookie becoming an app's principal;
// `authenticate({ type: "from-server-cookie" })` over capnweb from the platform origin, and refused
// from a project host's; the OAuth code + PKCE flow an MCP client runs, with project selection at
// consent; the project secret as a device's bearer; logout; and the cross-site negatives the security
// rounds pinned. Every test is self-contained — a fresh email, a fresh DNS-safe project — and the
// browser context's cookies ARE the identity. Node opens capnweb sessions to /api with the admin
// secret only to set fixtures up (an echo app on the project, the project's API key, the user's
// projects) — never to stand in for the browser.
//
//   DEMO_BASE_URL=https://project-worker.iterate.workers.dev \
//   ADMIN_API_SECRET=<the deployment's APP_CONFIG_ADMIN_API_SECRET> \
//   pnpm exec playwright test specs/auth.spec.ts
//
// SELECTORS are roles and accessible names only — the console is being rebuilt as a TanStack Start app
// while this is written, and the rebuild must keep them: the email textbox (named "email"), the
// sign-in button ("continue" / "sign in"), the project-name textbox ("project" / "slug"), the
// "create" button, one "open" link per project whose href is the project host's `/.itx/session`,
// the consent's one checkbox per project (named by the project id) and its "approve" button, the
// "log out" button. The paths stay: `/` (the account page, or the login form signed out), `/login`,
// `/projects` (the create form's POST), `/authorize`, `/.itx/session` on a project host.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { newWebSocketRpcSession } from "capnweb";

// ── the accessible names the console must keep ──
const EMAIL_FIELD = /e-?mail|you@example\.com/i; // a labelled "Email" field, or today's placeholder-named one
const SIGN_IN = /sign in|continue|log in/i;
const PROJECT_FIELD = /project|slug/i;
const CREATE = /create/i;
const OPEN = /open/i;
const APPROVE = /approve|allow|authorize/i;
const LOG_OUT = /log ?out|sign out/i;

const SESSION_COOKIE = "__Host-itx-control-plane-session";
/** A hostname with the base URL's port (a local worker has one; the deployment has none). The `__Host-`
 *  cookies need a secure origin, and Chromium counts `localhost` (not `127.0.0.1`) as one — so a local
 *  run points DEMO_BASE_URL at `http://localhost:<port>`. */
const hostWithPort = (hostname: string, baseURL: string): string => {
  const { port } = new URL(baseURL);
  return port ? `${hostname}:${port}` : hostname;
};
const PROJECT_SESSION_COOKIE = "__Host-itx-project-session";

// ── the deployment under test ──

/** The base project hosts hang under (`<app>--<project>.<base>`, `<project>.<base>`):
 *  PROJECT_HOSTNAME_BASE, else wrangler.jsonc's `APP_CONFIG_PROJECT_HOSTNAME_BASE` (the deployed
 *  worker's), else `localhost` (a local `wrangler dev`, whose hosts Chromium resolves to loopback). */
function projectHostnameBase(baseURL: string): string {
  if (process.env.PROJECT_HOSTNAME_BASE) return process.env.PROJECT_HOSTNAME_BASE;
  if (/^(localhost|127\.0\.0\.1)$/.test(new URL(baseURL).hostname)) return "localhost";
  const raw = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8");
  const match = /"APP_CONFIG_PROJECT_HOSTNAME_BASE"\s*:\s*"([^"]+)"/.exec(raw);
  if (!match)
    throw new Error(
      "wrangler.jsonc names no APP_CONFIG_PROJECT_HOSTNAME_BASE — set PROJECT_HOSTNAME_BASE",
    );
  return match[1]!;
}

/** `<scheme>://<host>[:port]<path>` on the deployment's scheme and port (a deployed worker: https, no port). */
function projectHostUrl(baseURL: string, host: string, path = "/"): string {
  const { protocol, port } = new URL(baseURL);
  return `${protocol}//${host}${port ? `:${port}` : ""}${path}`;
}

const adminApiSecret = (): string => {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret)
    throw new Error(
      "ADMIN_API_SECRET unset — the deployment's APP_CONFIG_ADMIN_API_SECRET, which the fixtures are set up with",
    );
  return secret;
};

const stamp = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** A fresh user per test — the demo login verifies nothing, so an email IS a user. */
const freshEmail = (tag: string): string => `spec-${tag}-${stamp()}@example.com`;
/** A fresh project per test — one DNS label, its id IS its slug IS its host label. */
const freshProject = (tag: string): string => `spec-${tag}-${stamp()}`;

// ── node-side fixtures over /api (the admin secret; `as` = the user's own session without a login) ──

const openSessions: any[] = [];
function apiSession(baseURL: string): any {
  const url = new URL("/api", baseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const session = newWebSocketRpcSession(url.toString()) as any;
  openSessions.push(session);
  return session;
}
test.afterEach(() => {
  heldRuleHandles.length = 0;
  for (const session of openSessions.splice(0)) {
    try {
      session[Symbol.dispose]?.();
    } catch {
      /* already gone */
    }
  }
});

/** The project's root context on an admin session — as the admin (every project) or as the user
 *  `as` names (their projects). */
const itxOf = (baseURL: string, project: string, as?: { email: string }): any =>
  apiSession(baseURL)
    .authenticate({ type: "admin-secret", secret: adminApiSecret(), ...(as && { as }) })
    .projects.get(project);

/** Create `project` as the user `email` — their first project makes their org, as the console's
 *  form does; the console lists it from then on. */
const createProjectAs = (baseURL: string, email: string, project: string): Promise<unknown> =>
  apiSession(baseURL)
    .authenticate({ type: "admin-secret", secret: adminApiSecret(), as: { email } })
    .projects.create({ project });

/** The fixture app: `itx.apps.echo` — a loaded worker whose `fetch` answers `/page` with a blank HTML
 *  document (a page ON a project host, for the cross-origin rows) and everything else with the
 *  request it was handed as JSON (its headers: `x-itx-principal` is the stamp the host derived,
 *  `cookie` and a platform bearer must be gone). CORS-open, so the platform origin's page can
 *  fetch it with a bearer (the device row). */
const ECHO_SOURCE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/page")
      return new Response("<!doctype html><title>echo page</title><p>a page on a project host</p>", {
        headers: { "content-type": "text/html; charset=utf-8", ...CORS },
      });
    return Response.json(
      { url: request.url, method: request.method, headers: Object.fromEntries(request.headers) },
      { headers: CORS },
    );
  }
}`,
};
/** What the echo app answers with. */
type Echo = { url: string; method: string; headers: Record<string, string> };
const principalOf = (echo: Echo): unknown =>
  echo.headers["x-itx-principal"] === undefined
    ? null
    : JSON.parse(echo.headers["x-itx-principal"]);

/** Provide the echo app on `project` (the admin session). The handle is HELD for the test: disposing
 *  it — or the session's end, which disposes every stub it holds — removes the rule. */
const heldRuleHandles: unknown[] = [];
async function provideEcho(baseURL: string, project: string): Promise<void> {
  heldRuleHandles.push(
    await itxOf(baseURL, project).provide("itx.apps.echo", [
      "itx",
      "workers",
      ["get", { source: ECHO_SOURCE }],
    ]),
  );
}

// ── the browser side ──

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("textbox", { name: EMAIL_FIELD }).fill(email);
  await page.getByRole("button", { name: SIGN_IN }).click();
  await expect(page.getByText(email).first()).toBeVisible();
}

/** The "open" link of `project` on the account page — the one whose href is the project's host. */
const openLinkOf = (page: Page, project: string) =>
  page.getByRole("link", { name: OPEN }).and(page.locator(`[href*="//${project}."]`));

/** The capnweb fork as a browser bundle: its ESM build has no imports, so its one `export {…}` line
 *  becomes `globalThis.capnweb = {…}` and the module runs as an inline script tag on any page —
 *  the /demo page inlines the very same bundle. */
const capnwebBrowserBundle = (() => {
  const esm = join(dirname(createRequire(import.meta.url).resolve("capnweb")), "index.js");
  return readFileSync(esm, "utf8").replace(
    /^export \{([^}]*)\};?\s*$/m,
    (_line, names: string) =>
      `globalThis.capnweb = {${names
        .split(",")
        .map((entry) => {
          const [local, exported] = entry.trim().split(/\s+as\s+/);
          return exported ? `${exported}: ${local}` : local;
        })
        .join(", ")}};`,
  );
})();

async function loadCapnwebInto(page: Page): Promise<void> {
  await page.addScriptTag({ type: "module", content: capnwebBrowserBundle });
  await page.waitForFunction(() => "capnweb" in globalThis);
}

/** From THIS page, dial `<apiOrigin>/api` over a WebSocket (the handshake carries the page's Origin
 *  and whatever cookies the browser attaches) and ask `authenticate({ type: "from-server-cookie"
 *  }).whoami()`: the principal, or the refusal's code and message. */
async function whoamiViaCookieFrom(
  page: Page,
  apiOrigin: string,
): Promise<{ ok: true; who: unknown } | { ok: false; code?: string; message: string }> {
  await loadCapnwebInto(page);
  return page.evaluate(async (apiOrigin) => {
    const { newWebSocketRpcSession } = (globalThis as any).capnweb;
    const api = newWebSocketRpcSession(`${apiOrigin.replace(/^http/, "ws")}/api`);
    try {
      const who = await api.authenticate({ type: "from-server-cookie" }).whoami();
      return { ok: true as const, who: JSON.parse(JSON.stringify(who)) };
    } catch (error: any) {
      return { ok: false as const, code: error?.code, message: String(error?.message ?? error) };
    } finally {
      api[Symbol.dispose]?.();
    }
  }, apiOrigin);
}

/** Submit a form from THIS page — a top-level POST navigation, the browser stamping the page's
 *  Origin on it: the classic cross-site request. Resolves to the response's status and body. */
async function postFormFrom(
  page: Page,
  action: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url() === action),
    page.evaluate(
      ({ action, fields }) => {
        // `document` through globalThis: the tests' tsconfig carries no DOM lib, and this runs in the page
        const { document } = globalThis as any;
        const form = document.createElement("form");
        form.method = "post";
        form.action = action;
        for (const [name, value] of Object.entries(fields)) {
          const input = document.createElement("input");
          input.name = name;
          input.value = value;
          form.append(input);
        }
        document.body.append(form);
        form.submit();
      },
      { action, fields },
    ),
  ]);
  return { status: response.status(), body: await response.text() };
}

// ── the OAuth client, in node (what an MCP client does off the browser) ──

/** A redirect URI for a client that is never sent anywhere (the signed-out /authorize row). */
const REDIRECT_URI = "https://client.test/callback";

/** An MCP client's LOOPBACK LISTENER (RFC 8252 §7.3 — Claude Code's and Cursor's shape; the
 *  provider allows any port on 127.0.0.1): the browser is redirected here with the code, the
 *  listener answers a page, and the test reads the URL the browser landed on. (A `page.route` on a
 *  fictional host cannot stand in: Playwright does not intercept the redirected request.) */
async function loopbackListener(): Promise<{ redirectUri: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>client callback</title><p>authorized</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** DCR at /oauth/register: a public client (no secret; PKCE is its proof). */
async function registerClient(
  baseURL: string,
  clientName: string,
  redirectUri = REDIRECT_URI,
): Promise<{ client_id: string }> {
  const response = await fetch(new URL("/oauth/register", baseURL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as { client_id: string };
}

/** The /authorize query for `clientId`: response_type=code, the `project` scope, the pinned
 *  resource `<origin>/mcp`, a fresh PKCE pair (S256) and state. */
async function authorizeQuery(
  baseURL: string,
  clientId: string,
  redirectUri = REDIRECT_URI,
): Promise<{ query: URLSearchParams; verifier: string; state: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = stamp();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "project",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${new URL(baseURL).origin}/mcp`,
  });
  return { query, verifier, state };
}

/** One JSON-RPC request on /mcp as an MCP client sends it; the message back (a JSON body or one
 *  SSE `data:` frame), or null when the answer is not one (a 401). */
async function mcp(
  baseURL: string,
  method: string,
  params: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; message: any; text: string }> {
  const response = await fetch(new URL("/mcp", baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const data = text.startsWith("event:")
    ? (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice("data:".length)
    : text;
  let message: unknown = null;
  try {
    message = JSON.parse(data);
  } catch {
    /* not JSON — the caller reads `text` */
  }
  return { status: response.status, message, text };
}

/** `tools/call` on /mcp: the tool's text, its `isError`, its structured result. */
async function callTool(
  baseURL: string,
  bearer: string,
  name: string,
  args: unknown,
): Promise<{ status: number; isError?: boolean; text: string; result?: unknown }> {
  const { status, message, text } = await mcp(
    baseURL,
    "tools/call",
    { name, arguments: args },
    { authorization: `Bearer ${bearer}` },
  );
  const result = message?.result as
    | { content: { text: string }[]; structuredContent?: { result: unknown }; isError?: boolean }
    | undefined;
  if (!result) return { status, text };
  return {
    status,
    isError: result.isError,
    text: result.content[0]?.text ?? "",
    result: result.structuredContent?.result,
  };
}

const sessionCookieOf = async (context: BrowserContext, url: string) =>
  (await context.cookies(url)).find((cookie) => cookie.name === SESSION_COOKIE);
const projectSessionCookieOf = async (context: BrowserContext, url: string) =>
  (await context.cookies(url)).find((cookie) => cookie.name === PROJECT_SESSION_COOKIE);

// ═══ 1. LOGIN + THE ACCOUNT PAGE ═══

test("1. login: GET / is the login form; the email submitted, the account page names it; the session is the __Host- cookie — HttpOnly, Secure, SameSite=Lax — invisible to the page's script", async ({
  page,
  context,
  baseURL,
}) => {
  const email = freshEmail("login");
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: EMAIL_FIELD })).toBeVisible();
  await expect(page.getByRole("button", { name: SIGN_IN })).toBeVisible();
  expect(await sessionCookieOf(context, baseURL!)).toBeUndefined();

  await page.getByRole("textbox", { name: EMAIL_FIELD }).fill(email);
  await page.getByRole("button", { name: SIGN_IN }).click();
  await expect(page).toHaveURL(new URL("/", baseURL).toString());
  await expect(page.getByText(email).first()).toBeVisible();

  const cookie = await sessionCookieOf(context, baseURL!);
  expect(cookie, "the session cookie was set on the platform host").toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.secure).toBe(true);
  expect(cookie!.sameSite).toBe("Lax");
  expect(cookie!.path).toBe("/");
  expect(cookie!.domain).toBe(new URL(baseURL!).hostname); // host-only: `__Host-` forbids a Domain
  expect(await page.evaluate(() => (globalThis as any).document.cookie)).toBe(""); // HttpOnly: no script sees it
  // and a reload is still the account page — the cookie, not the form's redirect, is the session
  await page.reload();
  await expect(page.getByText(email).first()).toBeVisible();
});

// ═══ 2. CREATE A PROJECT ═══

test("2. the account page's form creates a project: it appears in the list with an 'open' link to its host", async ({
  page,
  baseURL,
}) => {
  const email = freshEmail("create");
  const project = freshProject("create");
  await signIn(page, email);
  await expect(page.getByRole("link", { name: OPEN })).toHaveCount(0); // a fresh user: no project yet

  await page.getByRole("textbox", { name: PROJECT_FIELD }).fill(project);
  await page.getByRole("button", { name: CREATE }).click();
  await expect(page).toHaveURL(new URL("/", baseURL).toString());
  await expect(page.getByText(project).first()).toBeVisible();

  const open = openLinkOf(page, project);
  await expect(open).toHaveCount(1);
  const href = new URL((await open.getAttribute("href"))!, page.url());
  expect(href.host).toBe(hostWithPort(`${project}.${projectHostnameBase(baseURL!)}`, baseURL!));
  expect(href.pathname).toBe("/.itx/session");
  expect(href.searchParams.get("token"), "the link carries a project token").toBeTruthy();
});

// ═══ 3. THE PROJECT HOST ═══

test("3. 'open' lands the browser on the project's host with the __Host- project cookie set by /.itx/session; on an app host the cookie is the app's principal, and neither the cookie nor a platform bearer reaches the app", async ({
  page,
  context,
  baseURL,
}) => {
  const email = freshEmail("host");
  const project = freshProject("host");
  const base = projectHostnameBase(baseURL!);
  await signIn(page, email);
  await page.getByRole("textbox", { name: PROJECT_FIELD }).fill(project);
  await page.getByRole("button", { name: CREATE }).click();

  // the console's link: /.itx/session on the apex host → 303 → the apex, the config worker's fetch
  const open = openLinkOf(page, project);
  const token = new URL((await open.getAttribute("href"))!, page.url()).searchParams.get("token")!;
  const apexUrl = projectHostUrl(baseURL!, `${project}.${base}`);
  await Promise.all([page.waitForURL(apexUrl), open.click()]);
  expect(new URL(page.url()).host).toBe(hostWithPort(`${project}.${base}`, baseURL!));
  const apexCookie = await projectSessionCookieOf(context, apexUrl);
  expect(apexCookie, "the project-session cookie was set for the apex host").toBeDefined();
  expect(apexCookie!.httpOnly).toBe(true);
  expect(apexCookie!.secure).toBe(true);
  expect(apexCookie!.sameSite).toBe("Lax");
  expect(apexCookie!.domain).toBe(`${project}.${base}`);

  // the fixture app on the project, then the app host
  await provideEcho(baseURL!, project);
  const echoHost = `echo--${project}.${base}`;
  const echoUrl = projectHostUrl(baseURL!, echoHost);

  // FINDING (pinned as today's truth): the console signs the APEX in only — a `__Host-` cookie is
  // its host's alone, so the app host `echo--<project>` sees no session from the "open" link.
  const anonymous = (await (await page.goto(echoUrl))!.json()) as Echo;
  expect(anonymous.headers["x-iterate-app"]).toBe("echo");
  expect(principalOf(anonymous)).toBeNull();
  expect(await projectSessionCookieOf(context, echoUrl)).toBeUndefined();

  // the SAME token verifies for the project on any of its hosts: /.itx/session on the app host
  await page.goto(
    projectHostUrl(baseURL!, echoHost, `/.itx/session?token=${encodeURIComponent(token)}&next=/`),
  );
  await expect(page).toHaveURL(echoUrl);
  expect(await projectSessionCookieOf(context, echoUrl)).toBeDefined();
  const seen = (await (await page.goto(echoUrl))!.json()) as Echo;
  expect(seen.url).toBe(echoUrl);
  expect(seen.headers["x-iterate-app"]).toBe("echo");
  expect(principalOf(seen)).toEqual({ actor: `user_${email}`, email }); // the cookie became the principal
  expect(seen.headers.cookie, "the platform's cookie never reaches the app").toBeUndefined();
  expect(seen.headers.authorization).toBeUndefined();
  // the platform's own two ride in — the principal's stamp and the hop count an app forwards when it
  // fetches its own host (worker.ts) — and nothing an outsider could send (`x-itx-expression`, …)
  expect(
    Object.keys(seen.headers)
      .filter((name) => name.startsWith("x-itx-"))
      .sort(),
  ).toEqual(["x-itx-expression-hops", "x-itx-principal"]);
});

// ═══ 4. FROM-SERVER-COOKIE OVER CAPNWEB, IN THE BROWSER ═══

test("4. on the platform origin, capnweb's authenticate({ type: 'from-server-cookie' }) is the signed-in user; the same call from a project host's page is UNAUTHENTICATED (the same-origin rule)", async ({
  page,
  baseURL,
}) => {
  const email = freshEmail("cookie");
  const project = freshProject("cookie");
  const base = projectHostnameBase(baseURL!);
  const origin = new URL(baseURL!).origin;
  await signIn(page, email);
  await createProjectAs(baseURL!, email, project);
  await provideEcho(baseURL!, project);

  // same origin: the cookie rode the handshake, the call names it, the socket's Origin is ours
  await page.goto("/");
  expect(await whoamiViaCookieFrom(page, origin)).toEqual({
    ok: true,
    who: { actor: `user_${email}`, email },
  });

  // a page on a project host dials the same /api: the socket's Origin is the project host's
  const foreignOrigin = new URL(projectHostUrl(baseURL!, `echo--${project}.${base}`)).origin;
  await page.goto(`${foreignOrigin}/page`);
  const refused = await whoamiViaCookieFrom(page, origin);
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.code).toBe("UNAUTHENTICATED");
  expect(refused.message).toContain(JSON.stringify(foreignOrigin)); // the refusal names the Origin it saw
});

// ═══ 5. THE OAUTH FLOW, AS AN MCP CLIENT DOES IT ═══

test("5. OAuth: DCR, /authorize as the signed-in user with project selection at consent, the code + PKCE exchanged at /oauth/token, the token on /mcp — tools/list, itx.invoke in a granted project, refused in the unchecked one; the .well-known documents", async ({
  page,
  baseURL,
}) => {
  const email = freshEmail("oauth");
  const keep = freshProject("oauth-keep");
  const drop = freshProject("oauth-drop");
  const origin = new URL(baseURL!).origin;
  await createProjectAs(baseURL!, email, keep);
  await createProjectAs(baseURL!, email, drop);
  await signIn(page, email);

  // the metadata documents, fetched in the browser
  const [authorizationServer, protectedResource] = await page.evaluate(() =>
    Promise.all([
      fetch("/.well-known/oauth-authorization-server").then((r) => r.json()),
      fetch("/.well-known/oauth-protected-resource/mcp").then((r) => r.json()),
    ]),
  );
  expect(authorizationServer).toMatchObject({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["project"],
  });
  expect(protectedResource).toMatchObject({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
  });

  // the client registers itself with its loopback listener (node); the browser is sent to /authorize
  const listener = await loopbackListener();
  const clientName = `auth.spec ${stamp()}`;
  const client = await registerClient(baseURL!, clientName, listener.redirectUri);
  const { query, verifier, state } = await authorizeQuery(
    baseURL!,
    client.client_id,
    listener.redirectUri,
  );
  await page.goto(`/authorize?${query}`);
  await expect(page.getByText(clientName).first()).toBeVisible();
  await expect(page.getByText(email).first()).toBeVisible();
  const checkboxes = page.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(2); // her projects, all checked
  for (const checkbox of await checkboxes.all()) await expect(checkbox).toBeChecked();
  await page.getByRole("checkbox", { name: drop }).uncheck();
  await expect(page.getByRole("checkbox", { name: keep })).toBeChecked();

  // approve → 302 to the client's loopback listener, the code and state on the URL
  await Promise.all([
    page.waitForURL((url) => url.href.startsWith(listener.redirectUri)),
    page.getByRole("button", { name: APPROVE }).click(),
  ]);
  const callback = new URL(page.url());
  await listener.close();
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  expect(callback.searchParams.get("state")).toBe(state);
  expect(callback.searchParams.get("iss")).toBe(origin); // RFC 9207

  // the code exchanged with the verifier (node — the client's own back channel)
  const issued = (await (
    await fetch(new URL("/oauth/token", baseURL), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        client_id: client.client_id,
        redirect_uri: listener.redirectUri,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    })
  ).json()) as { access_token?: string; token_type?: string; error?: string };
  expect(issued.access_token, JSON.stringify(issued)).toBeTruthy();
  const bearer = issued.access_token!;

  // the token on /mcp
  const listed = await mcp(baseURL!, "tools/list", {}, { authorization: `Bearer ${bearer}` });
  expect(listed.status, listed.text).toBe(200);
  expect(listed.message.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    "whoami",
    "list_projects",
    "itx.invoke",
  ]);
  expect(JSON.parse((await callTool(baseURL!, bearer, "whoami", {})).text)).toEqual({
    actor: `user_${email}`,
    email,
    projects: [keep],
  });
  const granted = await callTool(baseURL!, bearer, "itx.invoke", {
    project: keep,
    expression: "itx.whoami()",
  });
  expect(granted.isError, granted.text).toBeFalsy();
  expect(granted.result).toEqual({ projectId: keep, path: "/" });
  const refused = await callTool(baseURL!, bearer, "itx.invoke", {
    project: drop,
    expression: "itx.whoami()",
  });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("outside this token's grant");
  // and no bearer at all is the provider's 401 challenge naming the resource document
  const challenged = await fetch(new URL("/mcp", baseURL), { method: "POST" });
  expect(challenged.status).toBe(401);
  expect(challenged.headers.get("www-authenticate")).toContain(
    `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
  );
});

// ═══ 6. THE PROJECT SECRET AS A DEVICE ═══

test("6. the project's API key as a bearer on its host makes the request the project itself ({ actor: 'project:<id>' }); a wrong key stamps nothing and passes through as the app's own bearer", async ({
  page,
  baseURL,
}) => {
  const email = freshEmail("device");
  const project = freshProject("device");
  const base = projectHostnameBase(baseURL!);
  await signIn(page, email);
  await createProjectAs(baseURL!, email, project);
  await provideEcho(baseURL!, project);
  const apiKey = (await itxOf(baseURL!, project).rotateApiKey()) as string;
  expect(apiKey.length).toBeGreaterThan(20);

  // from the platform origin's page: a cross-origin fetch with the key (the echo app is CORS-open)
  await page.goto("/");
  const echoUrl = projectHostUrl(baseURL!, `echo--${project}.${base}`);
  const fetchWithBearer = (bearer: string) =>
    page.evaluate(
      ({ echoUrl, bearer }) =>
        fetch(echoUrl, { headers: { authorization: `Bearer ${bearer}` } }).then(
          (response) => response.json() as Promise<Echo>,
        ),
      { echoUrl, bearer },
    );
  const asDevice = await fetchWithBearer(apiKey);
  expect(principalOf(asDevice)).toEqual({ actor: `project:${project}` });
  expect(
    asDevice.headers.authorization,
    "the platform's bearer never reaches the app",
  ).toBeUndefined();
  expect(asDevice.headers.cookie).toBeUndefined();

  const wrong = await fetchWithBearer("not-the-key");
  expect(principalOf(wrong)).toBeNull();
  expect(wrong.headers.authorization).toBe("Bearer not-the-key"); // an app's own scheme passes through
});

// ═══ 7. LOGOUT ═══

test("7. log out: the account page's button ends the session — / is the login form again, the cookie is gone, and /authorize asks for a sign-in", async ({
  page,
  context,
  baseURL,
}) => {
  const email = freshEmail("logout");
  await signIn(page, email);
  await page.getByRole("button", { name: LOG_OUT }).click();
  await expect(page.getByRole("textbox", { name: EMAIL_FIELD })).toBeVisible();
  await expect(page.getByText(email)).toHaveCount(0);
  expect(await sessionCookieOf(context, baseURL!)).toBeUndefined();
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: EMAIL_FIELD })).toBeVisible();

  // an authorize request signed out: the login form (inline at /authorize today, or /login)
  const client = await registerClient(baseURL!, `auth.spec logout ${stamp()}`);
  const { query } = await authorizeQuery(baseURL!, client.client_id);
  await page.goto(`/authorize?${query}`);
  await expect(page).toHaveURL(/\/(authorize|login)/);
  await expect(page.getByRole("textbox", { name: EMAIL_FIELD })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0); // no consent without a session
});

// ═══ 8. THE CROSS-SITE NEGATIVES ═══

test("8. cross-site: a project host's page cannot POST /projects with the platform cookie (403), cannot spend it over a WebSocket to /api (UNAUTHENTICATED), and /.itx/session?logout is neither a GET (405) nor a foreign POST (403)", async ({
  page,
  context,
  baseURL,
}) => {
  const email = freshEmail("xsite");
  const project = freshProject("xsite");
  const base = projectHostnameBase(baseURL!);
  const origin = new URL(baseURL!).origin;
  await signIn(page, email);
  await createProjectAs(baseURL!, email, project);
  await provideEcho(baseURL!, project);
  const apexUrl = projectHostUrl(baseURL!, `${project}.${base}`);
  const echoPageUrl = projectHostUrl(baseURL!, `echo--${project}.${base}`, "/page");

  // sign the apex host in through the console's own link, so the project cookie exists to attack
  await page.goto("/");
  await Promise.all([page.waitForURL(apexUrl), openLinkOf(page, project).click()]);
  expect(await projectSessionCookieOf(context, apexUrl)).toBeDefined();

  // (a) a form POST from the project host's page to the console's create door: the Origin rule
  await page.goto(echoPageUrl);
  const forged = `${project}-forged`;
  const createAttempt = await postFormFrom(page, `${origin}/projects`, { slug: forged });
  expect(createAttempt.status).toBe(403);
  expect(createAttempt.body).toContain("cross-site");
  const hers = (await apiSession(baseURL!)
    .authenticate({ type: "admin-secret", secret: adminApiSecret(), as: { email } })
    .projects.list()) as { id: string }[];
  expect(hers.map((row) => row.id)).not.toContain(forged);

  // (b) the platform cookie over a WebSocket from the project host's page
  await page.goto(echoPageUrl);
  const refused = await whoamiViaCookieFrom(page, origin);
  expect(refused).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });

  // (c) the project host's session door: a GET cannot end the session, a foreign POST may not
  await page.goto("/"); // the platform origin's page: a navigation from here is cross-site to the host
  const viaGet = await page.goto(`${apexUrl}.itx/session?logout`);
  expect(viaGet!.status()).toBe(405);
  await page.goto("/");
  const viaForeignPost = await postFormFrom(page, `${apexUrl}.itx/session?logout`, {});
  expect(viaForeignPost.status).toBe(403);
  expect(
    await projectSessionCookieOf(context, apexUrl),
    "the project session survived both",
  ).toBeDefined();
});
