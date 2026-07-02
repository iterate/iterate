import { DurableObject } from "cloudflare:workers";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import { FakeAuthContext, trustedInternalAuthContext } from "./auth.ts";
import type { Env } from "./env.ts";
import { ItxRpcTarget, ProjectCollectionRpcTarget } from "./rpc-targets.ts";
import type { CfExecutionContext, ItxAuthToken } from "./types.ts";

const DEMO_PREFIX = "/page-debugging";
const CONNECT_PATH = `${DEMO_PREFIX}/connect`;
const CLIENT_PATH = `${DEMO_PREFIX}/client.mjs`;
const REVOKE_PATH = `${DEMO_PREFIX}/revoke`;
const SESSION_PATH = `${DEMO_PREFIX}/session`;
const PROTOCOL_PREFIX = "itx-page-debugging.";
const DEFAULT_PATH = ["debugPage"] as const;
const TOKEN_TTL_MS = 5 * 60_000;

type TokenClaims = {
  exp: number;
  iat: number;
  jti: string;
  path: string[];
  principal: string;
  projectId: string;
  role: "agent" | "provider";
};

export async function handlePageDebuggingDemoRequest(input: {
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname !== DEMO_PREFIX && !url.pathname.startsWith(`${DEMO_PREFIX}/`)) return null;
  const env = input.env as Env & {
    PAGE_DEBUGGING_DEMO: DurableObjectNamespace<PageDebuggingDemoDurableObject>;
  };
  return env.PAGE_DEBUGGING_DEMO.getByName("default").fetch(input.request);
}

export class PageDebuggingDemoDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === DEMO_PREFIX || url.pathname === `${DEMO_PREFIX}/`) {
      return htmlResponse(pageDebuggingDemoHtml());
    }

    if (url.pathname === CLIENT_PATH) {
      return new Response(PAGE_DEBUGGING_CLIENT_MODULE, {
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/javascript; charset=utf-8",
        },
      });
    }

    if (url.pathname === SESSION_PATH) {
      if (request.method === "OPTIONS") return corsResponse();
      if (request.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }
      return Response.json(await createDemoSession(this.env, this.ctx, this.ctx.storage, request), {
        headers: { "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === REVOKE_PATH) {
      if (request.method === "OPTIONS") return corsResponse();
      if (request.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }
      const claims = await verifyDemoToken(
        this.env,
        this.ctx.storage,
        tokenFromAuthorization(request),
      );
      if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json(await revokeDemoTokens(this.ctx.storage, claims), {
        headers: { "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === CONNECT_PATH) {
      const claims = await verifyDemoToken(this.env, this.ctx.storage, tokenFromProtocol(request));
      if (!claims) return new Response("unauthorized", { status: 401 });

      const response = newWorkersWebSocketRpcResponse(
        request,
        new ItxRpcTarget({
          auth: new FakeAuthContext(tokenForProject(claims)),
          ctx: this.ctx,
          projectId: claims.projectId,
        }),
      );
      const acceptedProtocol = acceptedPageDebuggingProtocol(request);
      if (acceptedProtocol) response.headers.set("Sec-WebSocket-Protocol", acceptedProtocol);
      return response;
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }
}

type DemoSession = {
  agentToken: string;
  connectUrl: string;
  path: string[];
  providerToken: string;
  projectId: string;
  snippet: string;
};

async function createDemoSession(
  env: Env,
  ctx: CfExecutionContext,
  storage: DurableObjectState["storage"],
  request: Request,
): Promise<DemoSession> {
  const body = (await request
    .clone()
    .json()
    .catch(() => ({}))) as { path?: unknown; projectId?: unknown };
  const path =
    Array.isArray(body.path) && body.path.every((segment) => typeof segment === "string")
      ? body.path
      : [...DEFAULT_PATH];
  const projectId =
    typeof body.projectId === "string" ? body.projectId : `prj_page_debug_${randomTokenId()}`;
  await ensureDemoProject(ctx, projectId);
  const origin = new URL(request.url).origin;
  const providerClaims = newTokenClaims({ path, projectId, role: "provider" });
  const agentClaims = newTokenClaims({ path, projectId, role: "agent" });
  await storage.put(tokenStorageKey(providerClaims.jti), providerClaims);
  await storage.put(tokenStorageKey(agentClaims.jti), agentClaims);
  await deleteExpiredTokens(storage);
  const providerToken = await mintDemoToken(env, providerClaims);
  const agentToken = await mintDemoToken(env, agentClaims);
  const connectUrl = websocketUrl(new URL(CONNECT_PATH, origin));
  return {
    agentToken,
    connectUrl,
    path,
    projectId,
    providerToken,
    snippet: generateSnippet({
      clientModuleUrl: new URL(CLIENT_PATH, origin).toString(),
      connectUrl,
      path,
      projectId,
      revokeUrl: new URL(REVOKE_PATH, origin).toString(),
      token: providerToken,
    }),
  };
}

function newTokenClaims(input: {
  path: string[];
  projectId: string;
  role: TokenClaims["role"];
}): TokenClaims {
  return {
    exp: Date.now() + TOKEN_TTL_MS,
    iat: Date.now(),
    jti: randomTokenId(),
    path: input.path,
    principal: "page-debugging-demo",
    projectId: input.projectId,
    role: input.role,
  };
}

function randomTokenId() {
  return crypto.randomUUID().replaceAll("-", "");
}

async function ensureDemoProject(ctx: CfExecutionContext, projectId: string) {
  const projects = new ProjectCollectionRpcTarget({
    auth: trustedInternalAuthContext(),
    ctx,
  });
  await projects.create({ projectId, slug: projectId.replace(/^prj_/, "") });
}

function tokenForProject(claims: TokenClaims): ItxAuthToken {
  return {
    principal: claims.principal,
    projectScopes: [claims.projectId],
    type: "user",
  };
}

function generateSnippet(input: {
  clientModuleUrl: string;
  connectUrl: string;
  path: string[];
  projectId: string;
  revokeUrl: string;
  token: string;
}) {
  return [
    "(async () => {",
    `  const { connectPageTools } = await import(${JSON.stringify(input.clientModuleUrl)});`,
    "  window.__itxPageDebugging = await connectPageTools({",
    `    connectUrl: ${JSON.stringify(input.connectUrl)},`,
    `    projectId: ${JSON.stringify(input.projectId)},`,
    `    revokeUrl: ${JSON.stringify(input.revokeUrl)},`,
    `    token: ${JSON.stringify(input.token)},`,
    `    path: ${JSON.stringify(input.path)},`,
    "  });",
    `  console.log("[itx] PageTools provided at ${input.path.join(".")}. Keep window.__itxPageDebugging while debugging.");`,
    "})();",
  ].join("\n");
}

async function mintDemoToken(env: Env, claims: TokenClaims): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  return `${body}.${await sign(env, body)}`;
}

async function verifyDemoToken(
  env: Env,
  storage: DurableObjectState["storage"],
  token: string | null,
): Promise<TokenClaims | null> {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = await sign(env, body);
  if (!constantTimeEqual(signature, expected)) return null;
  let claims: TokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as TokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
  if (typeof claims.projectId !== "string" || !claims.projectId.startsWith("prj_")) return null;
  if (typeof claims.principal !== "string" || !claims.principal) return null;
  if (claims.role !== "agent" && claims.role !== "provider") return null;
  if (!Array.isArray(claims.path) || !claims.path.every((segment) => typeof segment === "string")) {
    return null;
  }
  const stored = await storage.get<TokenClaims>(tokenStorageKey(claims.jti));
  if (
    !stored ||
    stored.exp !== claims.exp ||
    stored.projectId !== claims.projectId ||
    stored.role !== claims.role
  ) {
    return null;
  }
  return claims;
}

async function deleteExpiredTokens(storage: DurableObjectState["storage"]) {
  const now = Date.now();
  const tokens = await storage.list<TokenClaims>({ prefix: "token:" });
  const expired = [...tokens].filter(([, claims]) => claims.exp < now).map(([key]) => key);
  if (expired.length > 0) await storage.delete(expired);
}

function tokenStorageKey(jti: string) {
  return `token:${jti}`;
}

async function revokeDemoTokens(storage: DurableObjectState["storage"], claims: TokenClaims) {
  const tokens = await storage.list<TokenClaims>({ prefix: "token:" });
  const keys = [...tokens]
    .filter(([, tokenClaims]) => tokenClaims.projectId === claims.projectId)
    .map(([key]) => key);
  if (keys.length > 0) await storage.delete(keys);
  return { ok: true, revoked: keys.length };
}

async function sign(env: Env, body: string) {
  const secret = env.SECRET_ENCRYPTION_KEY ?? "minimal-itx-v4-page-debugging-demo";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tokenFromProtocol(request: Request) {
  const protocol = acceptedPageDebuggingProtocol(request);
  return protocol ? protocol.slice(PROTOCOL_PREFIX.length) : null;
}

function tokenFromAuthorization(request: Request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
}

function acceptedPageDebuggingProtocol(request: Request) {
  return (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith(PROTOCOL_PREFIX));
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(input)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(input: string) {
  const padded = input
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function websocketUrl(url: URL) {
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function corsResponse() {
  return new Response(null, {
    headers: {
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-origin": "*",
    },
    status: 204,
  });
}

function htmlResponse(body: string) {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function pageDebuggingDemoHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ITX Page Debugging Demo</title>
    <style>
      :root {
        color: #1f2933;
        background: #f7f8fa;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      body { margin: 0; }
      main {
        width: min(1180px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }
      h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.1; letter-spacing: 0; }
      h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: 0; }
      p { line-height: 1.5; }
      .intro { max-width: 780px; margin: 0 0 24px; color: #52606d; }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr);
        gap: 20px;
        align-items: start;
      }
      section, aside {
        border: 1px solid #d9e2ec;
        border-radius: 8px;
        background: white;
        padding: 18px;
      }
      .target {
        min-height: 360px;
        display: grid;
        gap: 16px;
      }
      .target-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: end;
      }
      button {
        border: 1px solid #9fb3c8;
        border-radius: 6px;
        background: #ffffff;
        color: #1f2933;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
        min-height: 38px;
        padding: 8px 12px;
      }
      button.primary {
        border-color: #0f766e;
        background: #0f766e;
        color: white;
      }
      button:disabled { cursor: not-allowed; opacity: 0.55; }
      label { display: grid; gap: 6px; font-weight: 650; }
      input, textarea {
        border: 1px solid #bcccdc;
        border-radius: 6px;
        font: inherit;
        padding: 9px 10px;
      }
      textarea, pre {
        width: 100%;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      textarea {
        min-height: 240px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .screenshot-preview {
        display: none;
        border: 1px solid #bcccdc;
        border-radius: 6px;
        margin-top: 14px;
        max-height: 420px;
        max-width: 100%;
        object-fit: contain;
        background: #f8fafc;
      }
      pre {
        border: 1px solid #d9e2ec;
        border-radius: 6px;
        background: #f0f4f8;
        margin: 0;
        max-height: 300px;
        padding: 12px;
        font-size: 12px;
      }
      ol { padding-left: 22px; }
      li { margin: 8px 0; line-height: 1.45; }
      code {
        border-radius: 4px;
        background: #eef2f7;
        padding: 2px 4px;
      }
      .status {
        min-height: 24px;
        color: #334e68;
        font-weight: 650;
      }
      .counter {
        display: inline-grid;
        place-items: center;
        border: 1px solid #bcccdc;
        border-radius: 8px;
        width: 76px;
        height: 56px;
        background: #f8fafc;
        font-size: 24px;
        font-weight: 750;
      }
      @media (max-width: 860px) {
        .grid { grid-template-columns: 1fr; }
        main { width: min(100vw - 24px, 680px); padding-top: 20px; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>ITX Page Debugging Demo</h1>
      <p class="intro">
        This page is served by the minimal ITX v4 worker. Generate the snippet, paste it into this tab's console,
        then use the agent-side controls to drive the page through a live Cap'n Web capability.
      </p>
      <div class="grid">
        <section>
          <h2>Target Page</h2>
          <div class="target" aria-label="Target demo surface">
            <p>
              The controls below are ordinary DOM. The snippet mounts a <code>PageTools</code> capability backed by
              this page, and the agent controls call it through the worker.
            </p>
            <div class="target-row">
              <button id="increment" type="button">Increment counter</button>
              <span id="counter" class="counter" data-testid="counter">0</span>
            </div>
            <label>
              Message
              <input id="message" aria-label="Message" placeholder="agent will fill this" />
            </label>
            <p id="targetStatus" role="status">Waiting for the snippet.</p>
          </div>
        </section>

        <aside>
          <h2>Live Demo Script</h2>
          <ol>
            <li>Copy the snippet, open any page in this browser, and paste it into that page's DevTools console.</li>
            <li>Click <strong>Take Screenshot</strong>, <strong>Snapshot</strong>, <strong>Click counter</strong>, or <strong>Fill message</strong>.</li>
            <li>Show that the calls crossed the worker and came back into the target page.</li>
            <li>Use <strong>Run in this tab</strong> only for the no-DevTools shortcut.</li>
          </ol>
          <div class="target-row">
            <button id="copySnippet" class="primary" type="button">Copy snippet</button>
            <button id="runHere" type="button">Run in this tab</button>
            <button id="generateSnippet" type="button">Refresh snippet</button>
          </div>
          <p id="snippetStatus" class="status"></p>
          <textarea id="snippet" aria-label="Console snippet" spellcheck="false"></textarea>
        </aside>
      </div>

      <section style="margin-top: 20px">
        <h2>Agent-Side Controls</h2>
        <p>
          These buttons open a separate capnweb socket to <code>${CONNECT_PATH}</code> with the same HMAC token.
          They call the mounted <code>debugPage</code> capability from this control page, even when the snippet
          was pasted into a different tab.
        </p>
        <div class="target-row">
          <button id="agentSnapshot" type="button">Snapshot</button>
          <button id="agentScreenshot" type="button">Take Screenshot</button>
          <button id="agentClick" type="button">Click counter</button>
          <button id="agentFill" type="button">Fill message</button>
          <button id="agentDescribe" type="button">Describe input</button>
        </div>
        <img id="screenshotPreview" class="screenshot-preview" alt="Latest target page screenshot" />
        <p id="screenshotMeta" class="status"></p>
        <pre id="agentOutput" aria-live="polite">Generate and run the snippet first.</pre>
      </section>
    </main>
    <script type="module">
      const snippetEl = document.querySelector("#snippet");
      const snippetStatus = document.querySelector("#snippetStatus");
      const agentOutput = document.querySelector("#agentOutput");
      const targetStatus = document.querySelector("#targetStatus");
      const screenshotMeta = document.querySelector("#screenshotMeta");
      const screenshotPreview = document.querySelector("#screenshotPreview");
      let session;
      let agentProject;
      let agentProjectId;

      document.querySelector("#increment").addEventListener("click", () => {
        const counter = document.querySelector("#counter");
        counter.textContent = String(Number(counter.textContent || "0") + 1);
      });

      async function generateSession() {
        agentProject = undefined;
        agentProjectId = undefined;
        snippetStatus.textContent = "Generating snippet...";
        const response = await fetch("${SESSION_PATH}", { method: "POST" });
        session = await response.json();
        snippetEl.value = session.snippet;
        snippetStatus.textContent = "Snippet ready. Copy it into a target page, or run it here for the shortcut.";
        agentOutput.textContent = JSON.stringify({
          connectUrl: session.connectUrl,
          path: session.path,
          projectId: session.projectId,
        }, null, 2);
      }

      async function copySnippet() {
        await navigator.clipboard.writeText(snippetEl.value);
        snippetStatus.textContent = "Snippet copied.";
      }

      async function runSnippetHere() {
        if (!snippetEl.value.trim()) await generateSession();
        await (0, eval)(snippetEl.value);
        targetStatus.textContent = "Snippet connected. PageTools is mounted at debugPage.";
      }

      async function pageCapability() {
        if (!session) await generateSession();
        if (!agentProject || agentProjectId !== session.projectId) {
          const { connectPageItx } = await import("${CLIENT_PATH}");
          agentProject = connectPageItx({
            connectUrl: session.connectUrl,
            token: session.agentToken,
          });
          agentProjectId = session.projectId;
        }
        return resolveCapabilityPath(agentProject, session.path);
      }

      function resolveCapabilityPath(root, path) {
        const capability = path.reduce((target, segment) => target?.[segment], root);
        if (!capability) throw new Error("Capability not found at " + path.join("."));
        return capability;
      }

      async function runAgentAction(label, action) {
        try {
          agentOutput.textContent = label + "...";
          const page = await pageCapability();
          const result = await action(page);
          agentOutput.textContent = JSON.stringify(result, null, 2);
        } catch (error) {
          agentOutput.textContent = String(error && error.stack ? error.stack : error);
        }
      }

      document.querySelector("#generateSnippet").addEventListener("click", generateSession);
      document.querySelector("#copySnippet").addEventListener("click", copySnippet);
      document.querySelector("#runHere").addEventListener("click", runSnippetHere);
      document.querySelector("#agentSnapshot").addEventListener("click", () =>
        runAgentAction("Snapshot", (page) => page.snapshot()));
      document.querySelector("#agentScreenshot").addEventListener("click", () =>
        runAgentAction("Screenshot", async (page) => {
          const image = await page.screenshot({ mode: "auto", maxWidth: 960, quality: 0.65 });
          if (image.error) return image;
          screenshotPreview.src = "data:" + image.mime + ";base64," + image.base64;
          screenshotPreview.style.display = "block";
          screenshotMeta.textContent =
            "Latest screenshot: " + image.width + "x" + image.height + " via " + image.mode + ".";
          return {
            height: image.height,
            mime: image.mime,
            mode: image.mode,
            width: image.width,
            base64: image.base64 ? image.base64.slice(0, 80) + "..." : undefined,
            base64Length: image.base64?.length ?? 0,
          };
        }));
      document.querySelector("#agentClick").addEventListener("click", () =>
        runAgentAction("Clicking", async (page) => {
          await page.getByRole("button", { name: "Increment counter" }).click();
          return { counter: await page.getByTestId("counter").textContent() };
        }));
      document.querySelector("#agentFill").addEventListener("click", () =>
        runAgentAction("Filling", async (page) => {
          await page.getByLabelText("Message").fill("hello from ITX");
          return { message: await page.getByLabelText("Message").inputValue() };
        }));
      document.querySelector("#agentDescribe").addEventListener("click", () =>
        runAgentAction("Describing", (page) => page.getByLabelText("Message").describe()));

      await generateSession();
    </script>
  </body>
</html>`;
}

const PAGE_DEBUGGING_CLIENT_MODULE = `
import { newWebSocketRpcSession, RpcTarget } from "https://esm.sh/capnweb@0.8.0";
import { queryAllByLabelText, queryAllByPlaceholderText, queryAllByRole, queryAllByTestId, queryAllByText, waitFor } from "https://esm.sh/@testing-library/dom@10.4.1?bundle";
import userEvent from "https://esm.sh/@testing-library/user-event@14.6.1?bundle";

const PROTOCOL_PREFIX = ${JSON.stringify(PROTOCOL_PREFIX)};
const SHARING_WIDGET_ID = "__itx_page_debugging_widget";

export function connectPageItx({ connectUrl, token }) {
  return newWebSocketRpcSession(new WebSocket(connectUrl, [PROTOCOL_PREFIX + token]));
}

export async function connectPageTools({ connectUrl, installCaptureButton = true, path = ["debugPage"], revokeUrl, token }) {
  const project = connectPageItx({ connectUrl, token });
  const tools = new PageTools();
  const provision = await project.provideCapability({
    capability: tools,
    flattenNestedPaths: false,
    instructions: PAGE_TOOLS_INSTRUCTIONS,
    path,
    type: "live",
    types: PAGE_TOOLS_TYPES,
  });
  if (installCaptureButton) installIterateSharingWidget({ path, project, provision, revokeUrl, token, tools });
  return { project, provision, tools };
}

function installIterateSharingWidget({ path, project, provision, revokeUrl, token, tools }) {
  let host;
  try {
    host = hostDocument();
  } catch {
    return;
  }
  host.getElementById(SHARING_WIDGET_ID)?.remove();

  const widget = host.createElement("div");
  widget.id = SHARING_WIDGET_ID;
  widget.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "font:13px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
  ].join(";");

  const logo = host.createElement("button");
  logo.type = "button";
  logo.setAttribute("aria-label", "Open ITERATE sharing menu");
  logo.style.cssText = [
    "align-items:center",
    "background:#111827",
    "border:0",
    "border-radius:999px",
    "box-shadow:0 12px 32px rgba(15,23,42,.28)",
    "color:#fff",
    "cursor:pointer",
    "display:flex",
    "font:800 12px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "gap:8px",
    "letter-spacing:0",
    "padding:10px 13px",
  ].join(";");
  logo.innerHTML =
    '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 500 500" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex:0 0 auto;border-radius:5px"><rect width="500" height="500" fill="black"/><path d="M264.649 170.149H289.821L286.092 186.904L276.303 233.444L270.709 259.971L263.717 293.015L258.124 320.008L251.131 352.586L249.267 364.687V371.668L249.733 372.133H253.462L259.522 369.806L266.048 365.617L275.371 357.24L282.829 349.328L286.558 345.14L288.888 346.071L294.948 350.725L308 360.498L307.068 362.36L303.339 367.944L296.813 376.322L291.685 382.837L286.558 388.422L282.363 393.076L275.837 399.592L272.108 402.849L267.446 406.573L262.785 409.83L256.725 413.554L247.869 417.742L238.08 420.535L231.554 421H224.096L216.637 420.069L211.51 418.673L206.382 416.811L201.255 413.088L196.594 408.434L192.865 400.988L191.466 394.938L191 389.818V383.768L193.797 365.152L199.857 335.832L207.315 301.392L224.096 223.205L225.028 216.224V206.916L224.562 205.054L222.231 204.123L219.434 203.193L206.382 203.658L196.127 204.589H193.331V178.526L194.263 175.734L258.59 170.615L264.649 170.149Z" fill="white"/><path d="M264.649 78H268.844L275.836 78.9308L282.362 80.7924L287.49 83.5848L292.151 87.7734L295.414 92.8928L297.278 96.616L299.143 105.924L299.609 113.836L299.143 118.49L298.677 122.213L296.812 128.729L293.549 134.779L290.286 138.502L286.091 141.76L282.362 143.621L278.167 145.018L274.438 145.948L267.912 146.414H260.92L254.394 145.483L249.267 144.087L244.139 141.294L239.944 138.037L236.681 133.383L233.884 127.332L232.486 121.282L232.02 117.559V108.716L232.952 101.735L234.816 95.6852L237.613 90.1004L240.41 86.3772L246.936 82.1886L252.529 79.8616L259.522 78.4654L264.649 78Z" fill="white"/></svg><span>ITERATE</span>';

  const menu = host.createElement("div");
  menu.style.cssText = [
    "background:#fff",
    "border:1px solid #d9e2ec",
    "border-radius:8px",
    "bottom:52px",
    "box-shadow:0 18px 44px rgba(15,23,42,.22)",
    "color:#1f2933",
    "display:none",
    "min-width:250px",
    "overflow:hidden",
    "position:absolute",
    "right:0",
  ].join(";");

  const header = host.createElement("div");
  header.style.cssText = "padding:12px 12px 8px;border-bottom:1px solid #eef2f7";
  header.innerHTML =
    '<div style="font-weight:750">Sharing with ITERATE</div><div style="color:#52606d;font-size:12px;margin-top:3px">Mounted at ' +
    escapeHtml(path.join(".")) +
    '</div>';

  const status = host.createElement("div");
  status.style.cssText =
    "background:#f8fafc;color:#334e68;font-size:12px;line-height:1.35;min-height:34px;padding:9px 12px";
  status.textContent = "Connected. Use the demo page to drive this tab.";

  const preview = host.createElement("img");
  preview.alt = "Last screenshot shared with ITERATE";
  preview.style.cssText =
    "display:none;width:100%;max-height:120px;object-fit:cover;border-top:1px solid #eef2f7";

  const actions = host.createElement("div");
  actions.style.cssText = "display:grid;padding:6px";

  const shareScreenshot = menuButton(host, "Share a screenshot");
  shareScreenshot.addEventListener("click", async () => {
    shareScreenshot.disabled = true;
    status.textContent = "Preparing screenshot...";
    const image = await tools.screenshot({ mode: "auto", maxWidth: 960, quality: 0.65 });
    if (image.error) {
      status.textContent = image.hint || image.message || image.error;
    } else {
      tools.sharedScreenshot = image;
      preview.src = "data:" + image.mime + ";base64," + image.base64;
      preview.style.display = "block";
      status.textContent = "Screenshot shared: " + image.width + "x" + image.height + " via " + image.mode + ".";
    }
    shareScreenshot.disabled = false;
  });

  const enableCapture = menuButton(host, "Enable screen capture");
  enableCapture.addEventListener("click", async () => {
    enableCapture.disabled = true;
    status.textContent = "Choose this browser tab in the picker...";
    const result = await tools.enableScreenCapture();
    if (result.ok) {
      status.textContent = "Screen capture enabled. Screenshots now use true host-tab pixels.";
      enableCapture.textContent = "Screen capture enabled";
    } else {
      enableCapture.disabled = false;
      status.textContent = result.message || result.hint || result.error;
      console.error("[itx] screen capture setup failed", result);
    }
  });

  const copyUrl = menuButton(host, "Copy page URL");
  copyUrl.addEventListener("click", async () => {
    await host.defaultView?.navigator.clipboard?.writeText(host.defaultView.location.href);
    status.textContent = "Page URL copied.";
  });

  const stopSharing = menuButton(host, "Stop sharing");
  stopSharing.style.color = "#b42318";
  stopSharing.addEventListener("click", async () => {
    stopSharing.disabled = true;
    status.textContent = "Stopping sharing...";
    try {
      await provision.revoke?.();
      project?.[Symbol.dispose]?.();
      if (revokeUrl) {
        await fetch(revokeUrl, {
          headers: { authorization: "Bearer " + token },
          method: "POST",
        });
      }
    } finally {
      widget.remove();
    }
  });

  actions.append(shareScreenshot, enableCapture, copyUrl, stopSharing);
  menu.append(header, actions, status, preview);
  widget.append(menu, logo);
  logo.addEventListener("click", () => {
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });
  host.body.appendChild(widget);
}

function menuButton(host, label) {
  const button = host.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = [
    "background:#fff",
    "border:0",
    "border-radius:6px",
    "color:#1f2933",
    "cursor:pointer",
    "font:600 13px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "padding:9px 10px",
    "text-align:left",
  ].join(";");
  button.addEventListener("mouseenter", () => {
    if (!button.disabled) button.style.background = "#f0f4f8";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "#fff";
  });
  return button;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hostDocument() {
  if (!window.top || window.top === window) return document;
  try {
    const topDocument = window.top.document;
    if (!topDocument?.body) throw new Error("missing top document body");
    return topDocument;
  } catch {
    throw new Error("top-document-not-accessible: paste the snippet into the host page, not a cross-origin iframe");
  }
}

function errorMessage(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

export class PageTools extends RpcTarget {
  constructor({ root } = {}) {
    super();
    const host = hostDocument();
    this.document = host;
    this.window = host.defaultView || window;
    this.root = root || host.body;
    this.user = userEvent.setup({ document: host, pointerEventsCheck: 0 });
  }

  snapshot() {
    const elements = Array.from(this.root.querySelectorAll("*"))
      .map((element) => describeElement(element))
      .filter((element) => element.role || element.name || element.text)
      .slice(0, 100);
    return {
      title: this.document.title,
      url: this.window.location.href,
      text: this.root.innerText,
      elements,
    };
  }

  async enableScreenCapture() {
    try {
      if (!this.window.navigator.mediaDevices?.getDisplayMedia) {
        return {
          error: "screen-capture-unavailable",
          hint: "This browser does not expose navigator.mediaDevices.getDisplayMedia().",
        };
      }
      const stream = await this.window.navigator.mediaDevices.getDisplayMedia({
        audio: false,
        preferCurrentTab: true,
        video: { frameRate: 4 },
      });
      const video = this.document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      this.captureVideo = video;
      const [track] = stream.getVideoTracks();
      track?.addEventListener("ended", () => {
        this.captureVideo = undefined;
      });
      return { ok: true };
    } catch (error) {
      return {
        error: "screen-capture-denied",
        message: errorMessage(error),
      };
    }
  }

  async screenshot(options = {}) {
    const mode = options.mode || "auto";
    const maxWidth = options.maxWidth || 1280;
    const quality = options.quality || 0.7;
    const useCapture = mode === "capture" || (mode === "auto" && this.captureVideo);

    try {
      let canvas;
      let sourceMode;
      if (useCapture) {
        const video = this.captureVideo;
        if (!video) {
          return {
            error: "screen-capture-not-enabled",
            hint: "Paste the snippet into the target host page, click its Enable Host Capture button, then retry.",
          };
        }
        sourceMode = "capture";
        const scale = Math.min(1, maxWidth / Math.max(video.videoWidth, 1));
        canvas = this.document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      } else {
        sourceMode = "render";
        const { toCanvas } = await import("https://esm.sh/html-to-image@1.11.13?bundle");
        const node = options.selector
          ? this.document.querySelector(options.selector)
          : this.document.documentElement;
        if (!node) return { error: "selector-not-found", selector: options.selector };
        const width = Math.max(node.scrollWidth || 0, node.getBoundingClientRect().width || 0, 1);
        const pixelRatio = Math.min(1, maxWidth / width);
        const widget = this.document.getElementById(SHARING_WIDGET_ID);
        const filter = (candidate) => {
          if (!(candidate instanceof this.window.Element)) return true;
          if (widget && (candidate === widget || widget.contains(candidate))) return false;
          if (
            candidate instanceof this.window.HTMLImageElement &&
            !candidate.currentSrc &&
            !candidate.getAttribute("src")
          ) {
            return false;
          }
          return true;
        };
        canvas = await toCanvas(node, { filter, pixelRatio });
      }

      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      return {
        base64: dataUrl.split(",")[1],
        height: canvas.height,
        mime: "image/jpeg",
        mode: sourceMode,
        width: canvas.width,
      };
    } catch (error) {
      return {
        error: "screenshot-failed",
        message: errorMessage(error),
      };
    }
  }

  html(selector) {
    const element = selector ? this.document.querySelector(selector) : this.document.documentElement;
    return element ? element.outerHTML : null;
  }

  text(selector) {
    const element = selector ? this.document.querySelector(selector) : this.root;
    return element ? element.innerText : null;
  }

  url() {
    return this.window.location.href;
  }

  title() {
    return this.document.title;
  }

  async keyboard(text) {
    await this.user.keyboard(text);
    return true;
  }

  async tab(opts) {
    await this.user.tab(opts);
    return true;
  }

  getByRole(role, options = {}) {
    return new Locator(this, () => queryAllByRole(this.root, role, options), "getByRole(" + role + ")");
  }

  getByLabelText(text, options = {}) {
    return new Locator(this, () => queryAllByLabelText(this.root, text, options), "getByLabelText(" + text + ")");
  }

  getByText(text, options = {}) {
    return new Locator(this, () => queryAllByText(this.root, text, options), "getByText(" + text + ")");
  }

  getByPlaceholderText(text, options = {}) {
    return new Locator(this, () => queryAllByPlaceholderText(this.root, text, options), "getByPlaceholderText(" + text + ")");
  }

  getByTestId(id) {
    return new Locator(this, () => queryAllByTestId(this.root, id), "getByTestId(" + id + ")");
  }

  locator(selector) {
    return new Locator(this, () => Array.from(this.root.querySelectorAll(selector)), "locator(" + selector + ")");
  }
}

export class Locator extends RpcTarget {
  constructor(tools, query, description, index) {
    super();
    this.tools = tools;
    this.query = query;
    this.description = description;
    this.index = index;
  }

  nth(index) {
    return new Locator(this.tools, this.query, this.description + ".nth(" + index + ")", index);
  }

  count() {
    return this.query().length;
  }

  exists() {
    return this.query().length > 0;
  }

  async click() {
    await this.tools.user.click(this.one());
    return true;
  }

  async dblClick() {
    await this.tools.user.dblClick(this.one());
    return true;
  }

  async hover() {
    await this.tools.user.hover(this.one());
    return true;
  }

  async fill(value) {
    const element = this.one();
    await this.tools.user.clear(element);
    await this.tools.user.type(element, value);
    return true;
  }

  async type(text) {
    await this.tools.user.type(this.one(), text);
    return true;
  }

  async clear() {
    await this.tools.user.clear(this.one());
    return true;
  }

  async selectOptions(values) {
    await this.tools.user.selectOptions(this.one(), values);
    return true;
  }

  async check() {
    const element = this.one();
    if (!element.checked) await this.tools.user.click(element);
    return true;
  }

  async uncheck() {
    const element = this.one();
    if (element.checked) await this.tools.user.click(element);
    return true;
  }

  async press(keys) {
    this.one().focus();
    await this.tools.user.keyboard(keys);
    return true;
  }

  textContent() {
    return this.one().textContent;
  }

  inputValue() {
    const element = this.one();
    return "value" in element ? element.value : null;
  }

  getAttribute(name) {
    return this.one().getAttribute(name);
  }

  isVisible() {
    const element = this.query()[this.index ?? 0];
    return !!element && isVisible(element);
  }

  async waitFor(options = {}) {
    await waitFor(() => {
      if (!this.exists()) throw new Error(this.description + " is not present yet");
    }, { timeout: options.timeout ?? 5000 });
    return this.describe();
  }

  describe() {
    return describeElement(this.one());
  }

  one() {
    const elements = this.query();
    if (this.index !== undefined) {
      const element = elements[this.index];
      if (!element) throw new Error(this.description + " not found; " + elements.length + " matches");
      return element;
    }
    if (elements.length === 0) throw new Error(this.description + " not found");
    if (elements.length > 1) throw new Error(this.description + " is ambiguous; " + elements.length + " matches");
    return elements[0];
  }
}

function describeElement(element) {
  const rect = element.getBoundingClientRect();
  return {
    attrs: Object.fromEntries(Array.from(element.attributes ?? []).map((attr) => [attr.name, attr.value])),
    name: accessibleName(element) || undefined,
    rect: { h: rect.height, w: rect.width, x: rect.x, y: rect.y },
    role: roleOf(element) || undefined,
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || element.textContent || "").trim().slice(0, 200) || undefined,
    visible: isVisible(element),
  };
}

function accessibleName(element) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.innerText || "")
      .join(" ")
      .trim();
  }
  const label = element.labels?.[0]?.innerText;
  return (
    element.getAttribute("aria-label") ||
    label ||
    element.getAttribute("alt") ||
    element.getAttribute("placeholder") ||
    (roleOf(element) ? (element.innerText || element.textContent || "").trim() : "")
  );
}

function roleOf(element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit") return "button";
    return "textbox";
  }
  return "";
}

function isVisible(element) {
  const style = (element.ownerDocument.defaultView || window).getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

const PAGE_TOOLS_INSTRUCTIONS = "In-page PageTools. Use snapshot first for semantic structure. Use screenshot when visual layout, canvas, iframe, or styling matters. Screen capture is host-tab pixels after the user enables capture in the target page; render mode is a silent host-DOM fallback.";
const PAGE_TOOLS_TYPES = "export type Capability = PageTools; interface ScreenshotResult { mime?: string; base64?: string; width?: number; height?: number; mode?: 'capture' | 'render'; error?: string; hint?: string; message?: string; } interface PageTools { snapshot(): Promise<unknown>; enableScreenCapture(): Promise<unknown>; screenshot(options?: { mode?: 'auto' | 'capture' | 'render'; maxWidth?: number; quality?: number; selector?: string }): Promise<ScreenshotResult>; getByRole(role: string, options?: { name?: string }): Locator; getByLabelText(text: string): Locator; getByText(text: string): Locator; locator(selector: string): Locator; } interface Locator { click(): Promise<boolean>; fill(value: string): Promise<boolean>; textContent(): Promise<string | null>; inputValue(): Promise<string | null>; describe(): Promise<unknown>; }";
`;
