import type { PublicSessionResponse } from "@iterate-com/auth/client";
import { z } from "zod";
import { authenticateAdminApiSecret } from "~/auth/admin.ts";
import { adminPrincipal, createUserPrincipal, type Principal } from "~/auth/principal.ts";
import type { AppConfig } from "~/config.ts";
import type { ProjectDirectoryRecord } from "~/project-directory.ts";

export const OPERATOR_SESSION_COOKIE = "iterate-operator-session";
const LEGACY_ADMIN_COOKIE = "iterate-admin-auth";
const TOKEN_VERSION = 1;
const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_TTL_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 30;
const SIGNING_CONTEXT = "iterate-operator-session:v1:";

const ProjectGrant = z
  .object({
    audience: z.string(),
    email: z.string(),
    expiresAt: z.number().int(),
    issuedAt: z.number().int(),
    kind: z.literal("project"),
    organization: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
    }),
    project: z.object({
      id: z.string(),
      organizationId: z.string(),
      slug: z.string(),
    }),
    returnTo: z.string(),
    sessionId: z.string(),
    operatorId: z.string(),
    version: z.literal(TOKEN_VERSION),
  })
  .strict();

const AdminGrant = z
  .object({
    audience: z.string(),
    expiresAt: z.number().int(),
    issuedAt: z.number().int(),
    kind: z.literal("admin"),
    returnTo: z.string(),
    sessionId: z.string(),
    operatorId: z.string(),
    version: z.literal(TOKEN_VERSION),
  })
  .strict();

const OperatorGrant = z.discriminatedUnion("kind", [ProjectGrant, AdminGrant]);

export type OperatorGrant = z.infer<typeof OperatorGrant>;

export type AuthenticatedOperatorSession = {
  grant: OperatorGrant;
  principal: Principal;
};

const CreateOperatorSessionRequest = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      operatorId: z.string().trim().min(1).max(256),
      project: z.string().trim().min(1).max(256),
      returnTo: z.string().max(2048).optional(),
      ttlSeconds: z.number().int().min(60).max(MAX_TTL_SECONDS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("admin"),
      operatorId: z.string().trim().min(1).max(256),
      returnTo: z.string().max(2048).optional(),
      ttlSeconds: z.number().int().min(60).max(MAX_TTL_SECONDS).optional(),
    })
    .strict(),
]);

type OperatorSessionHandlerInput = {
  config: AppConfig;
  request: Request;
  resolveProject(reference: string): Promise<ProjectDirectoryRecord | null>;
};

/**
 * The operator-session HTTP surface.
 *
 * POST /api/operator-sessions
 *   Requires the deployment admin API secret as a bearer token. It resolves
 *   the requested project before signing a short-lived, origin-bound grant.
 *   A project grant creates a synthetic operator principal with authority over
 *   exactly that project; it does not adopt or copy a customer identity.
 *
 * GET + POST /api/operator-sessions/redeem
 *   The GET page reads the grant from the URL fragment (never the request URL)
 *   and POSTs it same-origin. The POST verifies it and installs the HttpOnly
 *   cookie. The admin API secret never enters browser storage.
 *
 * DELETE /api/operator-sessions/current
 *   Clears the browser session. Rotation of APP_CONFIG_ADMIN_API_SECRET also
 *   invalidates every outstanding grant and cookie immediately.
 */
export async function handleOperatorSessionRequest(
  input: OperatorSessionHandlerInput,
): Promise<Response> {
  const url = new URL(input.request.url);
  if (url.pathname === "/api/operator-sessions" && input.request.method === "POST") {
    return await createOperatorSessionResponse(input);
  }
  if (url.pathname === "/api/operator-sessions/redeem") {
    if (input.request.method === "GET") return operatorSessionRedeemPage();
    if (input.request.method === "POST") return await redeemOperatorSessionResponse(input);
  }
  if (url.pathname === "/api/operator-sessions/current" && input.request.method === "DELETE") {
    if (!isSameOriginBrowserRequest(input.request)) return forbiddenOriginResponse();
    const headers = noStoreHeaders();
    headers.append("set-cookie", expiredCookie(OPERATOR_SESSION_COOKIE, url));
    headers.append("set-cookie", expiredCookie(LEGACY_ADMIN_COOKIE, url));
    return Response.json({ ok: true }, { headers });
  }
  return new Response("Method Not Allowed", {
    headers: { allow: "GET, POST, DELETE" },
    status: 405,
  });
}

async function createOperatorSessionResponse(input: OperatorSessionHandlerInput) {
  if (!isSameOriginBrowserRequest(input.request)) return forbiddenOriginResponse();
  if (!authenticateAdminApiSecret({ config: input.config }, input.request)) {
    return new Response("Unauthorized", { headers: noStoreHeaders(), status: 401 });
  }
  if (!input.request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return new Response("Expected application/json", { headers: noStoreHeaders(), status: 415 });
  }

  let rawBody: unknown;
  try {
    rawBody = await input.request.json();
  } catch {
    return new Response("Invalid JSON", { headers: noStoreHeaders(), status: 400 });
  }
  const parsed = CreateOperatorSessionRequest.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { headers: noStoreHeaders(), status: 400 },
    );
  }

  const audience = new URL(input.request.url).origin;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (parsed.data.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const common = {
    audience,
    expiresAt,
    issuedAt: now,
    returnTo: "",
    sessionId: crypto.randomUUID(),
    operatorId: parsed.data.operatorId,
    version: 1 as const,
  };

  let grant: OperatorGrant;
  let project: ProjectDirectoryRecord | null = null;
  try {
    if (parsed.data.kind === "admin") {
      grant = {
        ...common,
        kind: "admin",
        returnTo: normalizeReturnTo(parsed.data.returnTo ?? "/admin", audience),
      };
    } else {
      project = await input.resolveProject(parsed.data.project);
      if (!project) {
        return Response.json(
          { error: "project_not_found" },
          { headers: noStoreHeaders(), status: 404 },
        );
      }
      // Keep the synthetic principal outside every customer organization.
      // The project claim is the complete authority; using the real owning
      // organization here would let organization-based route fallbacks widen
      // a project grant to sibling projects.
      const organizationId = `operator:${project.id}`;
      grant = {
        ...common,
        email: emailForOperatorId(parsed.data.operatorId),
        kind: "project",
        organization: {
          id: organizationId,
          name: "Project operator access",
          slug: `operator-${project.id.replace(/^prj_/, "").slice(0, 24)}`,
        },
        project: { id: project.id, organizationId, slug: project.slug },
        returnTo: normalizeReturnTo(
          parsed.data.returnTo ?? `/projects/${encodeURIComponent(project.slug)}`,
          audience,
        ),
      };
    }
  } catch (error) {
    return Response.json(
      {
        error: "invalid_return_to",
        message: error instanceof Error ? error.message : String(error),
      },
      { headers: noStoreHeaders(), status: 400 },
    );
  }

  const adminSecret = input.config.adminApiSecret?.exposeSecret();
  if (!adminSecret) {
    return new Response("Operator sessions are not configured", {
      headers: noStoreHeaders(),
      status: 503,
    });
  }
  const token = await signOperatorGrant({ grant, secret: adminSecret });
  const browserUrl = `${audience}/api/operator-sessions/redeem#${new URLSearchParams({ token })}`;

  // Audit only non-secret grant metadata. The signed token and admin bearer
  // are intentionally absent from logs.
  console.info(
    JSON.stringify({
      event: "os.operator_session.issued",
      expiresAt,
      kind: grant.kind,
      projectId: project?.id ?? null,
      sessionId: grant.sessionId,
      operatorId: grant.operatorId,
    }),
  );

  return Response.json(
    {
      browserUrl,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      kind: grant.kind,
      project: project ? { id: project.id, slug: project.slug } : null,
      token,
    },
    { headers: noStoreHeaders() },
  );
}

async function redeemOperatorSessionResponse(input: OperatorSessionHandlerInput) {
  if (!isSameOriginBrowserRequest(input.request)) return forbiddenOriginResponse();
  if (!input.request.headers.get("content-type")?.toLowerCase().startsWith("text/plain")) {
    return new Response("Expected text/plain", { headers: noStoreHeaders(), status: 415 });
  }
  const token = (await input.request.text()).trim();
  const session = await authenticateOperatorToken({
    config: input.config,
    requestUrl: input.request.url,
    token,
  });
  if (!session) {
    return new Response("Invalid or expired operator session", {
      headers: noStoreHeaders(),
      status: 401,
    });
  }

  const url = new URL(input.request.url);
  const headers = noStoreHeaders();
  headers.append("set-cookie", operatorSessionCookie(token, session.grant.expiresAt, url));
  headers.append("set-cookie", expiredCookie(LEGACY_ADMIN_COOKIE, url));
  console.info(
    JSON.stringify({
      event: "os.operator_session.redeemed",
      kind: session.grant.kind,
      projectId: session.grant.kind === "project" ? session.grant.project.id : null,
      sessionId: session.grant.sessionId,
      operatorId: session.grant.operatorId,
    }),
  );
  return Response.json({ ok: true, returnTo: session.grant.returnTo }, { headers });
}

export async function authenticateOperatorSession(input: {
  config: AppConfig;
  request: Request;
}): Promise<AuthenticatedOperatorSession | null> {
  if (!isSameOriginBrowserRequest(input.request)) return null;
  const token = readCookie(input.request.headers.get("cookie"), OPERATOR_SESSION_COOKIE);
  if (!token) return null;
  return await authenticateOperatorToken({
    config: input.config,
    requestUrl: input.request.url,
    token,
  });
}

export async function authenticateOperatorToken(input: {
  config: AppConfig;
  requestUrl: string;
  token: string;
}): Promise<AuthenticatedOperatorSession | null> {
  const secret = input.config.adminApiSecret?.exposeSecret();
  if (!secret) return null;
  const grant = await verifyOperatorGrant({
    audience: new URL(input.requestUrl).origin,
    secret,
    token: input.token,
  });
  return grant ? { grant, principal: principalForGrant(grant) } : null;
}

export function publicSessionForOperator(
  session: AuthenticatedOperatorSession | null | undefined,
): PublicSessionResponse {
  if (!session) return { authenticated: false };
  const { grant } = session;
  if (grant.kind === "admin") {
    return {
      authenticated: true,
      user: {
        email: emailForOperatorId(grant.operatorId),
        id: grant.operatorId,
        isAdmin: true,
        name: grant.operatorId,
        role: "admin",
      },
      session: {
        activeOrganizationId: null,
        expiresAt: grant.expiresAt,
        organizations: [],
        projects: [],
        scope: "operator admin",
        sessionId: grant.sessionId,
      },
    };
  }
  return {
    authenticated: true,
    user: {
      email: grant.email,
      id: grant.operatorId,
      isAdmin: false,
      name: grant.operatorId,
      role: "member",
    },
    session: {
      activeOrganizationId: grant.organization.id,
      expiresAt: grant.expiresAt,
      organizations: [{ ...grant.organization, role: "admin" }],
      projects: [grant.project],
      scope: "operator project",
      sessionId: grant.sessionId,
    },
  };
}

function principalForGrant(grant: OperatorGrant): Principal {
  if (grant.kind === "admin") return adminPrincipal;
  return createUserPrincipal({
    email: grant.email,
    organizations: [{ ...grant.organization, role: "admin" }],
    projects: [grant.project],
    sessionId: grant.sessionId,
    userId: grant.operatorId,
  });
}

async function signOperatorGrant(input: { grant: OperatorGrant; secret: string }): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(input.grant)));
  const signature = await sign(input.secret, payload);
  return `${payload}.${base64UrlEncode(signature)}`;
}

export async function verifyOperatorGrant(input: {
  audience: string;
  now?: number;
  secret: string;
  token: string;
}): Promise<OperatorGrant | null> {
  const [payload, signature, extra] = input.token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  let signatureBytes: Uint8Array;
  let rawClaims: unknown;
  try {
    signatureBytes = base64UrlDecode(signature);
    rawClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as unknown;
  } catch {
    return null;
  }
  const validSignature = await verify(input.secret, payload, signatureBytes);
  if (!validSignature) return null;

  const parsed = OperatorGrant.safeParse(rawClaims);
  if (!parsed.success) return null;
  const grant = parsed.data;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (grant.audience !== new URL(input.audience).origin) return null;
  if (grant.issuedAt > now + CLOCK_SKEW_SECONDS || grant.expiresAt <= now) return null;
  if (grant.expiresAt - grant.issuedAt > MAX_TTL_SECONDS) return null;
  try {
    normalizeReturnTo(grant.returnTo, grant.audience);
  } catch {
    return null;
  }
  return grant;
}

/** Browser ambient credentials are accepted only from this exact origin.
 * Non-browser clients normally omit Origin and authenticate explicitly. */
export function isSameOriginBrowserRequest(request: Request): boolean {
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin === null) return true;
  try {
    return new URL(rawOrigin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function normalizeReturnTo(value: string, audience: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("returnTo must be a same-origin absolute path");
  }
  const resolved = new URL(value, audience);
  if (resolved.origin !== new URL(audience).origin) {
    throw new Error("returnTo must stay on the operator-session origin");
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function emailForOperatorId(operatorId: string) {
  return operatorId.includes("@")
    ? operatorId
    : `${operatorId.replace(/[^a-zA-Z0-9._+-]/gu, "-")}@operator.invalid`;
}

async function hmacKey(secret: string, usages: KeyUsage[]) {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    usages,
  );
}

async function sign(secret: string, payload: string) {
  const key = await hmacKey(secret, ["sign"]);
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${SIGNING_CONTEXT}${payload}`)),
  );
}

async function verify(secret: string, payload: string, signature: Uint8Array) {
  const key = await hmacKey(secret, ["verify"]);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature as BufferSource,
    new TextEncoder().encode(`${SIGNING_CONTEXT}${payload}`),
  );
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return null;
}

function operatorSessionCookie(token: string, expiresAt: number, url: URL) {
  const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  return [
    `${OPERATOR_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(url.protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function expiredCookie(name: string, url: URL) {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(url.protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function noStoreHeaders() {
  return new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function forbiddenOriginResponse() {
  return new Response("Forbidden origin", { headers: noStoreHeaders(), status: 403 });
}

function operatorSessionRedeemPage() {
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)));
  const script = `
(async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  if (!token) throw new Error("Missing operator session grant.");
  const response = await fetch(location.pathname, {
    body: token,
    credentials: "same-origin",
    headers: { "content-type": "text/plain" },
    method: "POST",
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  location.replace(result.returnTo);
})().catch((error) => {
  document.querySelector("main").textContent = error instanceof Error ? error.message : String(error);
});`;
  const headers = noStoreHeaders();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set(
    "content-security-policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  headers.set("x-frame-options", "DENY");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Operator session</title></head><body><main>Creating operator session...</main><script nonce="${nonce}">${script}</script></body></html>`,
    { headers },
  );
}
