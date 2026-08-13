import type {
  MintProjectAppSessionInput,
  ValidatedProjectAppSession,
  ValidateProjectAppSessionInput,
} from "@iterate-com/auth-contract/worker";
import { ItxAuthenticationError } from "../auth.ts";
import { ITERATE_MARK_SVG } from "../domains/workers/worker-serve-overlay.ts";
import { isSameOriginBrowserRequest } from "./operator-session.ts";

/** A declarative access rule for a project-host web app. */
export type ProjectAuthPolicy = { policy: "project-member" };

/** Browser credentials accepted by a project app's unauthenticated RPC root. */
export type ProjectAuthCredentials = { type: "from-server-cookie" };

/** Identity proven by the app-origin session, safe for app-defined authorization. */
export type ProjectAuthActor = Pick<ValidatedProjectAppSession, "userId">;

/** The request fields consumed by the server-side auth implementation. */
type ProjectAuthRequest = Pick<Request, "body" | "headers" | "method" | "url">;

/** Metadata sent by the worker-side partial-fetch facade for body-free paths. */
export type ProjectAuthRpcMetadata = {
  headers: [string, string][];
  method: string;
  url: string;
};

export function projectAuthRequestFromRpc(
  request: ProjectAuthRpcMetadata | Request,
): ProjectAuthRequest {
  if (request instanceof Request) return request;
  return {
    body: null,
    headers: new Headers(request.headers),
    method: request.method,
    url: request.url,
  };
}

const AUTH_COOKIE = "iterate-project-auth";
const CALLBACK_PATH = "/_iterate/auth/callback";
const LOGIN_PATH = "/_iterate/auth/login";
const LOGOUT_PATH = "/_iterate/auth/logout";
const MAX_TOKEN_BYTES = 8192;

type ValidateSession = (
  input: ValidateProjectAppSessionInput,
) => Promise<ValidatedProjectAppSession | null>;

/** Runtime-check policy values because project code crosses an RPC boundary. */
export function parseProjectAuthPolicy(value: ProjectAuthPolicy): ProjectAuthPolicy {
  if (
    !value ||
    typeof value !== "object" ||
    value.policy !== "project-member" ||
    Object.keys(value).length !== 1
  ) {
    throw new ItxAuthenticationError();
  }
  return value;
}

/**
 * Exchange the ambient, exact-origin project-app cookie for an actor value.
 * This is the server half of an app's explicit Cap'n Web `authenticate()`
 * method: userspace decides which app capability to construct for the actor.
 */
export async function authenticateProjectRequest(input: {
  credentials: ProjectAuthCredentials;
  projectId: string;
  request: ProjectAuthRequest;
  validateSession: ValidateSession;
}): Promise<ProjectAuthActor> {
  if (
    !input.credentials ||
    typeof input.credentials !== "object" ||
    input.credentials.type !== "from-server-cookie" ||
    Object.keys(input.credentials).length !== 1
  ) {
    throw new ItxAuthenticationError();
  }
  // This credential name is deliberately browser-specific. Requiring the
  // WebSocket handshake's exact Origin prevents a hostile site from using a
  // member's browser to exchange this app's ambient cookie.
  if (!input.request.headers.get("origin") || !isSameOriginBrowserRequest(input.request)) {
    throw new ItxAuthenticationError();
  }

  const token = readCookie(input.request.headers.get("cookie"), AUTH_COOKIE);
  if (!token) throw new ItxAuthenticationError();
  const session = await input.validateSession({
    audience: new URL(input.request.url).origin,
    projectId: input.projectId,
    token,
  });
  if (!session) throw new ItxAuthenticationError();
  return { userId: session.userId };
}

/**
 * Project-app auth as a partial fetch. A response means auth owns the request;
 * null means the current request has a live project-member session. The null
 * path inspects metadata only and leaves the request body untouched.
 */
export async function handleProjectAuthFetch(input: {
  osBaseUrl: string | undefined;
  projectId: string;
  request: ProjectAuthRequest;
  validateSession: ValidateSession;
}): Promise<Response | null> {
  const url = new URL(input.request.url);

  if (url.pathname === LOGIN_PATH) {
    if (input.request.method !== "GET") return methodNotAllowed("GET");
    if (!input.osBaseUrl) return unavailable("Project authentication is not configured.");
    return loginRedirect({ osBaseUrl: input.osBaseUrl, requestUrl: url });
  }

  if (url.pathname === CALLBACK_PATH) {
    if (input.request.method === "GET") {
      try {
        normalizeReturnPath(url.searchParams.get("return_to") ?? "/", url.origin);
      } catch (error) {
        return invalidRequest(error);
      }
      return callbackPage();
    }
    if (input.request.method !== "POST") return methodNotAllowed("GET, POST");
    return await redeemSession(input);
  }

  if (url.pathname === LOGOUT_PATH) {
    if (input.request.method !== "POST") return methodNotAllowed("POST");
    if (!isSameOriginBrowserRequest(input.request)) return forbiddenOrigin();
    const headers = noStoreHeaders();
    headers.set("location", "/");
    headers.append("set-cookie", expiredCookie(url));
    return new Response(null, { headers, status: 303 });
  }

  const token = readCookie(input.request.headers.get("cookie"), AUTH_COOKIE);
  if (token) {
    const validation = await validateOrDependencyResponse(input, token, url.origin);
    if (validation instanceof Response) return validation;
    if (validation) return null;
  }

  const login = `${LOGIN_PATH}?${new URLSearchParams({
    return_to: `${url.pathname}${url.search}`,
  })}`;
  const response = isHtmlNavigation(input.request)
    ? loginPage(login)
    : Response.json({ authenticated: false, login }, { headers: noStoreHeaders(), status: 401 });
  if (token) response.headers.append("set-cookie", expiredCookie(url));
  return response;
}

export async function handleProjectAuthStart(input: {
  mintSession(input: MintProjectAppSessionInput): Promise<{ token: string } | null>;
  request: Request;
  resolveProjectId(targetUrl: string): Promise<string | null>;
  session: { userId: string; email?: string; image?: string; name?: string } | null;
}): Promise<Response> {
  if (input.request.method !== "GET") return methodNotAllowed("GET");
  const requestUrl = new URL(input.request.url);

  let target: URL;
  try {
    target = parseProjectReturnUrl(requestUrl.searchParams.get("return_to"));
  } catch (error) {
    return invalidRequest(error);
  }

  let projectId: string | null;
  try {
    projectId = await input.resolveProjectId(target.toString());
  } catch (error) {
    console.error("[project-auth] project resolution failed", error);
    return unavailable("Project authentication is temporarily unavailable.");
  }
  if (!projectId) return new Response("The return_to URL is not a project app.", { status: 400 });

  if (!input.session) {
    const login = new URL("/api/iterate-auth/login", requestUrl.origin);
    login.searchParams.set("return_to", `${requestUrl.pathname}${requestUrl.search}`);
    return redirect(login.toString());
  }

  let issued: { token: string } | null;
  try {
    issued = await input.mintSession({
      audience: target.origin,
      email: input.session.email,
      image: input.session.image,
      name: input.session.name,
      projectId,
      userId: input.session.userId,
    });
  } catch (error) {
    console.error("[project-auth] session mint failed", error);
    return unavailable("Project authentication is temporarily unavailable.");
  }
  if (!issued) return new Response("You do not have access to this project.", { status: 403 });

  const callback = new URL(CALLBACK_PATH, target.origin);
  callback.searchParams.set("return_to", `${target.pathname}${target.search}`);
  callback.hash = new URLSearchParams({ token: issued.token }).toString();
  return redirect(callback.toString());
}

async function redeemSession(input: {
  projectId: string;
  request: ProjectAuthRequest;
  validateSession: ValidateSession;
}): Promise<Response> {
  if (!isSameOriginBrowserRequest(input.request)) return forbiddenOrigin();
  if (!input.request.headers.get("content-type")?.toLowerCase().startsWith("text/plain")) {
    return new Response("Expected text/plain", { headers: noStoreHeaders(), status: 415 });
  }

  const url = new URL(input.request.url);
  let returnTo: string;
  try {
    returnTo = normalizeReturnPath(url.searchParams.get("return_to") ?? "/", url.origin);
  } catch (error) {
    return invalidRequest(error);
  }
  const token = await readBoundedText(input.request, MAX_TOKEN_BYTES);
  if (!token) {
    return new Response("Project auth token is too large", {
      headers: noStoreHeaders(),
      status: 413,
    });
  }

  const validation = await validateOrDependencyResponse(input, token.trim(), url.origin);
  if (validation instanceof Response) return validation;
  if (!validation) {
    const headers = noStoreHeaders();
    headers.append("set-cookie", expiredCookie(url));
    return new Response("Invalid or expired project auth token", { headers, status: 401 });
  }

  const headers = noStoreHeaders();
  headers.append("set-cookie", sessionCookie(token.trim(), validation.expiresAt, url));
  return Response.json({ ok: true, returnTo }, { headers });
}

async function validateOrDependencyResponse(
  input: { projectId: string; validateSession: ValidateSession },
  token: string,
  audience: string,
) {
  try {
    return await input.validateSession({ audience, projectId: input.projectId, token });
  } catch (error) {
    console.error("[project-auth] session validation failed", error);
    return unavailable("Project authentication is temporarily unavailable.");
  }
}

function loginRedirect(input: { osBaseUrl: string; requestUrl: URL }) {
  let returnTo: string;
  try {
    returnTo = normalizeReturnPath(
      input.requestUrl.searchParams.get("return_to") ?? "/",
      input.requestUrl.origin,
    );
  } catch (error) {
    return invalidRequest(error);
  }
  const start = new URL("/api/project-auth/start", input.osBaseUrl);
  start.searchParams.set("return_to", new URL(returnTo, input.requestUrl.origin).toString());
  return redirect(start.toString());
}

function parseProjectReturnUrl(rawValue: string | null): URL {
  if (!rawValue || rawValue.length > 2048) throw new Error("Invalid return_to URL");
  const url = new URL(rawValue);
  if (url.username || url.password || url.hash) throw new Error("Invalid return_to URL");
  if (url.protocol !== "https:" && !isLocalHost(url.hostname)) {
    throw new Error("return_to must use HTTPS");
  }
  return url;
}

function normalizeReturnPath(value: string, origin: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 2048) {
    throw new Error("return_to must be a same-origin path");
  }
  const resolved = new URL(value, origin);
  if (resolved.origin !== origin) throw new Error("return_to must stay on this origin");
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function isHtmlNavigation(request: Pick<Request, "headers" | "method">) {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    request.headers.get("accept")?.includes("text/html")
  );
}

async function readBoundedText(
  request: Pick<Request, "body">,
  maximumBytes: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function readCookie(cookieHeader: string | null, name: string) {
  for (const part of cookieHeader?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function sessionCookie(token: string, expiresAt: number, url: URL) {
  const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  return [
    `${AUTH_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(url.protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function expiredCookie(url: URL) {
  return [
    `${AUTH_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(url.protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function loginPage(login: string) {
  const nonce = randomNonce();
  const headers = htmlHeaders();
  // The sign-in button is a plain link ON PURPOSE. Chromium applies a form's
  // form-action CSP to the submission's ENTIRE redirect chain, and the
  // logged-out leg of this navigation crosses OS and the iterate-auth origin
  // — a form submit died silently at the auth hop (observed live,
  // 2026-07-21). Anchors are outside form-action entirely, so the policy
  // stays maximally strict: nothing loads but the nonce'd stylesheet.
  headers.set(
    "content-security-policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Sign in</title>
    <style nonce="${nonce}">
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; color: #0a0a0a; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
      main { padding: 32px 24px; width: 100%; max-width: 400px; box-sizing: border-box; }
      header { display: flex; align-items: center; gap: 16px; }
      .mark { width: 48px; height: 48px; border-radius: 22.37%; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12); flex-shrink: 0; }
      h1 { margin: 0; font-size: 17px; font-weight: 600; }
      p { margin: 0; color: #737373; font-size: 14px; }
      a { display: block; margin-top: 24px; padding: 11px 16px; background: #0a0a0a; color: #fff; border-radius: 10px; font-weight: 500; text-decoration: none; text-align: center; }
      a:hover { background: #262626; }
      a:focus-visible { outline: 2px solid #0a0a0a; outline-offset: 2px; }
    </style>
  </head>
  <body>
    <main>
      <header>
        ${ITERATE_MARK_SVG}
        <div>
          <h1>Sign in to iterate</h1>
          <p>This app is available to project members.</p>
        </div>
      </header>
      <a href="${escapeHtml(login)}">Continue with iterate</a>
    </main>
  </body>
</html>`,
    { headers },
  );
}

function callbackPage() {
  const nonce = randomNonce();
  const script = `(async()=>{const token=new URLSearchParams(location.hash.slice(1)).get("token");history.replaceState(null,"",location.pathname+location.search);if(!token)throw new Error("Missing project auth token.");const response=await fetch(location.pathname+location.search,{body:token,credentials:"same-origin",headers:{"content-type":"text/plain"},method:"POST"});if(!response.ok)throw new Error(await response.text());const result=await response.json();location.replace(result.returnTo)})().catch(error=>{document.querySelector("main").textContent=error instanceof Error?error.message:String(error)});`;
  const headers = htmlHeaders();
  headers.set(
    "content-security-policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Signing in</title></head><body><main>Signing in…</main><script nonce="${nonce}">${script}</script></body></html>`,
    { headers },
  );
}

function randomNonce() {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(18))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function redirect(location: string) {
  const headers = noStoreHeaders();
  headers.set("location", location);
  return new Response(null, { headers, status: 302 });
}

function methodNotAllowed(allow: string) {
  const headers = noStoreHeaders();
  headers.set("allow", allow);
  return new Response("Method Not Allowed", { headers, status: 405 });
}

function invalidRequest(error: unknown) {
  return new Response(error instanceof Error ? error.message : "Invalid request", {
    headers: noStoreHeaders(),
    status: 400,
  });
}

function unavailable(message: string) {
  return new Response(message, { headers: noStoreHeaders(), status: 503 });
}

function forbiddenOrigin() {
  return new Response("Forbidden origin", { headers: noStoreHeaders(), status: 403 });
}

function htmlHeaders() {
  const headers = noStoreHeaders();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-frame-options", "DENY");
  return headers;
}

function noStoreHeaders() {
  return new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function isLocalHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}
