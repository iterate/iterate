// Browser acceptance for the current OAuth contract. Google identity proof is
// covered separately; deployed runs use the explicit administrator login fixture.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- Bounded fixture setup; browser actions use the app's real WebSocket.
import { newHttpBatchRpcSession } from "capnweb";
import { transformSync } from "esbuild";
import type { Session, UnauthenticatedSession } from "../src/session.ts";
import { authorizationCodeRequest } from "../src/client/oauth.ts";

const claudeClient = "https://claude.ai/oauth/claude-code-client-metadata";
const stamp = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
const isLocal = (origin: string) => new URL(origin).hostname === "localhost";
const adminSecret = (origin: string) => {
  const secret = process.env.ADMIN_API_SECRET || (isLocal(origin) && "dev-admin-api-secret");
  if (!secret) throw new Error("ADMIN_API_SECRET is required for the deployed identity fixture");
  return secret;
};

async function signIn(page: Page, origin: string, email: string, next = "/") {
  if (isLocal(origin)) {
    await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    return;
  }
  await page.getByRole("link", { name: "Continue with Google", exact: true }).waitFor();
  const response = await page.request.post(`${origin}/login`, {
    headers: { Authorization: `Bearer ${adminSecret(origin)}` },
    form: { email, next },
    maxRedirects: 0,
  });
  expect(response.status(), await response.text()).toBe(302);
  await response.dispose();
  await page.goto(new URL(next, origin).href);
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

test("first Claude consent creates the organization and project in the SPA before granting MCP access", async ({
  page,
  context,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const resource = process.env.MCP_BASE_URL || `${origin}/mcp`;
  const email = `consent-${stamp()}@example.com`;
  const project = `consent-${stamp()}`;
  const otherProject = `unselected-${stamp()}`;
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
  // Repeated resource keys and '+' form encoding must survive the TanStack SPA.
  const expectedState = `${flow.state} + OAuth state`;
  flow.url.searchParams.set("state", expectedState);
  const sockets: string[] = [];
  const errors: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(flow.url.href);
    await signIn(page, origin, email, flow.url.pathname + flow.url.search);
    await Promise.race([
      page.getByRole("heading", { name: "Authorize Claude Code", exact: true }).waitFor(),
      callback.then((url) => {
        throw new Error(
          `Authorization ended before consent: ${url.searchParams.get("error")}: ${url.searchParams.get("error_description")}`,
        );
      }),
    ]);
    await page
      .getByRole("heading", { name: "Create your first organization", exact: true })
      .waitFor();
    expect(new URL(page.url()).search).toBe(flow.url.search);
    await page
      .getByRole("textbox", { name: "Organization name", exact: true })
      .fill("First consent studio");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await page.getByRole("textbox", { name: "Project name", exact: true }).fill(project);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const choice = page.getByRole("checkbox", {
      name: `${project} in First consent studio`,
      exact: true,
    });
    await choice.waitFor();
    expect(await choice.isChecked()).toBe(true);
    const future = page.getByRole("checkbox", {
      name: "All my current and future projects",
      exact: true,
    });
    expect(await future.isChecked()).toBe(false);
    await choice.uncheck();
    expect(await page.getByRole("button", { name: "Approve", exact: true }).isDisabled()).toBe(
      true,
    );
    // Refreshing the directory during onboarding must preserve the user's choices.
    await page.locator("summary").filter({ hasText: "Create a project or organization" }).click();
    await page
      .getByRole("textbox", { name: "Organization name", exact: true })
      .fill("Second studio");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await page.getByRole("textbox", { name: "Project name", exact: true }).fill(otherProject);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const otherChoice = page.getByRole("checkbox", {
      name: `${otherProject} in Second studio`,
      exact: true,
    });
    await otherChoice.waitFor();
    expect(await otherChoice.isChecked()).toBe(true);
    expect(await choice.isChecked()).toBe(false);
    await page.getByRole("region", { name: "First consent studio", exact: true }).waitFor();
    await page.getByRole("region", { name: "Second studio", exact: true }).waitFor();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /^0 selected$/ })
      .waitFor();
    expect(await page.getByRole("button", { name: "Approve", exact: true }).isDisabled()).toBe(
      true,
    );
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /^2 selected$/ })
      .waitFor();
    await otherChoice.uncheck();
    await future.check();
    expect(await choice.isChecked()).toBe(true);
    expect(await otherChoice.isChecked()).toBe(true);
    expect(await otherChoice.isDisabled()).toBe(true);
    await future.uncheck();
    expect(await choice.isChecked()).toBe(true);
    expect(await otherChoice.isChecked()).toBe(false);
    await page
      .getByRole("status")
      .filter({ hasText: /^1 selected$/ })
      .waitFor();
    expect(new URL(page.url()).search).toBe(flow.url.search);
    expect(sockets.filter((url) => new URL(url).pathname === "/api")).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath("first-consent.png"), fullPage: true });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
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
    const identity = await mcp(resource, tokens.access_token, "whoami");
    expect(JSON.parse(identity.result.content[0].text)).toMatchObject({ email });
    const projects = await mcp(resource, tokens.access_token, "list_projects");
    expect(projects.result.isError).toBe(false);
    expect(projects.result.content[0].text).toContain(project);
    expect(projects.result.content[0].text).not.toContain(otherProject);
    const denied = await mcp(resource, tokens.access_token, "itx.invoke", {
      project: otherProject,
      expression: "itx.kv.get('x')",
    });
    expect(denied.result.isError).toBe(true);
    // The issuer grant and the Claude grant are the only two sessions created.
    const headers = await cookieHeaders(context, origin);
    // eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded inventory assertion after the UI flow.
    using api = newHttpBatchRpcSession<Session>(new Request(`${origin}/api`, { headers }));
    const inventory = await api.grants.list();
    expect(inventory.items).toHaveLength(2);
    expect(inventory.items.filter((item) => item.current)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the same Notes app and dashboard work on their own origin and through a project config worker", async ({
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
  await page.goto(`${origin}/login`);
  await signIn(page, origin, email);
  await page.getByRole("textbox", { name: "New project" }).fill(project);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: "open", exact: true }).waitFor();
  const projectOrigin = new URL(
    (await page.getByRole("link", { name: "open", exact: true }).getAttribute("href"))!,
  ).origin;
  const source = transformSync(
    readFileSync(resolve(import.meta.dirname, "../../../../apps/notes/config-worker.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  ).code;
  // Install the repository's actual config-worker source, preserving its auth.require gate.
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- One operator fixture installs the proxy; all app interactions are real browser RPC.
  using operator = newHttpBatchRpcSession<UnauthenticatedSession>(`${origin}/internal/rpc`);
  await operator
    .authenticate({ type: "admin-secret", secret: adminSecret(origin) })
    .projects.get(project)
    .provide("itx.worker", ["itx", "workers", ["get", { source: { "cap.js": source } }]]);
  await page.goto(notesOrigin);
  await page.getByRole("link", { name: "Log in with Iterate", exact: true }).click();
  await page
    .getByRole("heading", { name: `Authorize ${new URL(notesOrigin).host}`, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("textbox", { name: project, exact: true }).fill(note);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Saved$/ })
    .waitFor();
  await page.reload();
  expect(await page.getByRole("textbox", { name: project, exact: true }).inputValue()).toBe(note);
  await page.getByRole("link", { name: "Project dashboard", exact: true }).click();
  await page.getByRole("heading", { name: `Signed in as ${email}`, exact: true }).waitFor();
  await page.getByRole("link", { name: "open", exact: true }).waitFor();
  await page.goto(`${projectOrigin}/notes`);
  await page
    .getByRole("heading", { name: `Authorize ${new URL(projectOrigin).host}`, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  expect(await page.getByRole("textbox", { name: project, exact: true }).inputValue()).toBe(note);
  await page
    .getByRole("textbox", { name: project, exact: true })
    .fill(`${note}; edited through the project proxy`);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Saved$/ })
    .waitFor();
  await page.goto(`${notesOrigin}/notes`);
  expect(await page.getByRole("textbox", { name: project, exact: true }).inputValue()).toBe(
    `${note}; edited through the project proxy`,
  );
  await page.goto(`${origin}/sessions`);
  const appSession = page.getByRole("row").filter({ hasText: new URL(projectOrigin).host });
  await appSession.getByRole("button", { name: "Log out", exact: true }).click();
  await page.goto(`${projectOrigin}/notes`);
  await page
    .getByRole("heading", { name: `Authorize ${new URL(projectOrigin).host}`, exact: true })
    .waitFor();
  // The independently granted Notes session remains usable after proxy revocation.
  await page.goto(`${notesOrigin}/notes`);
  await page.getByRole("textbox", { name: project, exact: true }).waitFor();
  const cookies = await context.cookies();
  expect(
    cookies
      .filter((cookie) => cookie.name.startsWith("__Host-itx-session"))
      .every((cookie) => cookie.httpOnly && cookie.secure),
  ).toBe(true);
});
