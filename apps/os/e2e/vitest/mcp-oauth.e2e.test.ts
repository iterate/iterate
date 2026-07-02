import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { requireBaseUrl as requireOsBaseUrl } from "../test-support/os-client.ts";

// End-to-end proof of the Grok-style MCP connect flow: a dynamically
// registered public PKCE client completes the full OAuth authorization-code
// flow against Iterate Auth, receives an OPAQUE access token (no `resource`
// parameter → Better Auth issues a stored opaque token, not a JWT — this is
// exactly what Grok's connector does), and uses it to list tools on the
// deployed OS MCP endpoint.
//
// This exercises the production auth path end to end:
//   - opaque-token introspection in the auth worker (tokens are stored hashed;
//     the lookup must hash the presented bearer — regression guard for the
//     "not_found" bug)
//   - the `sid` null→undefined mapping in the introspection response
//   - session-scoped project-selection gating: `authorize` redirects to
//     `/project-access` until a fresh selection is stored for THIS session
//   - project-grant reconstruction (the token only reaches the selected
//     project, and `exec_js` shows up)
//
// It needs a Better Auth browser session, which without a browser means the
// bootstrap-admin email/password (the auth worker's SERVICE_AUTH_TOKEN). That
// secret lives in the auth Doppler config, not the OS one, so the test skips
// cleanly when it is absent (mirroring the preview smoke's admin-secret gate).
// To run it against a preview slot:
//
//   cd apps/os && doppler run --project auth --config preview_4 -- \
//     env APP_CONFIG_BASE_URL=https://os.iterate-preview-4.com \
//     pnpm e2e -t "project MCP OAuth"

const ADMIN_EMAIL = process.env.E2E_AUTH_ADMIN_EMAIL?.trim() || "admin@nustom.com";
const REDIRECT_URI = "https://iterate-mcp-e2e.example.com/callback";
const SCOPE = "openid profile email offline_access project";

function authOriginFrom(osBaseUrl: URL) {
  const issuer = process.env.APP_CONFIG_ITERATE_AUTH__ISSUER?.trim();
  if (issuer) return new URL(issuer).origin;

  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(osBaseUrl.hostname);
  if (previewMatch) return `https://auth.iterate-preview-${previewMatch[1]}.com`;
  if (osBaseUrl.hostname === "os.iterate.com") return "https://auth.iterate.com";
  throw new Error(
    `Cannot derive auth origin from ${osBaseUrl}. Set APP_CONFIG_ITERATE_AUTH__ISSUER.`,
  );
}

function mcpOriginFrom(osBaseUrl: URL) {
  const configured = process.env.APP_CONFIG_MCP__BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(osBaseUrl.hostname);
  if (previewMatch) return `https://mcp.iterate-preview-${previewMatch[1]}.com`;
  if (osBaseUrl.hostname === "os.iterate.com") return "https://mcp.iterate.com";
  throw new Error(`Cannot derive MCP origin from ${osBaseUrl}. Set APP_CONFIG_MCP__BASE_URL.`);
}

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A minimal cookie jar + oRPC/better-auth helpers scoped to one auth origin.
function authClient(authOrigin: string) {
  const api = `${authOrigin}/api/auth`;
  const jar = new Map<string, string>();

  function store(res: Response) {
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }

  async function call(url: string, init: RequestInit = {}) {
    const headers: Record<string, string> = { origin: authOrigin, ...(init.headers as object) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    store(res);
    return res;
  }

  // oRPC RPC protocol wraps input/output as { json: ... }.
  async function orpc<T = unknown>(procedure: string, input: unknown): Promise<T> {
    const res = await call(`${authOrigin}/api/orpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    });
    const body = (await res.json().catch(() => null)) as { json?: T } | null;
    if (res.status !== 200) {
      throw new Error(`orpc ${procedure} failed: ${res.status} ${JSON.stringify(body)}`);
    }
    return (body?.json ?? body) as T;
  }

  // better-auth returns OAuth redirects in a JSON body ({ url } / { redirect_uri }).
  const readRedirect = async (res: Response) => {
    const body = (await res.json().catch(() => null)) as {
      url?: string;
      redirect_uri?: string;
    } | null;
    return body?.url ?? body?.redirect_uri ?? res.headers.get("location") ?? null;
  };

  return { api, call, orpc, readRedirect };
}

test("project MCP OAuth opaque-token flow", async () => {
  const password = process.env.SERVICE_AUTH_TOKEN?.trim() || null;
  if (!password) {
    console.log("Skipping MCP OAuth e2e: SERVICE_AUTH_TOKEN not present in this environment.");
    return;
  }

  const osBaseUrl = new URL(requireOsBaseUrl());
  const authOrigin = authOriginFrom(osBaseUrl);
  const mcpOrigin = mcpOriginFrom(osBaseUrl);
  const c = authClient(authOrigin);

  // 1. Bootstrap-admin session (stands in for a browser login).
  const signIn = await c.call(`${c.api}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password }),
  });
  expect(signIn.status, "bootstrap admin sign-in").toBe(200);

  // 2. Ensure an organization + a fresh project to grant the client.
  const orgs = await c.orpc<Array<{ slug: string }>>("user/myOrganizations", {});
  let orgSlug = orgs[0]?.slug;
  if (!orgSlug) {
    const org = await c.orpc<{ slug: string }>("organization/create", {
      name: `MCP E2E Org ${b64url(randomBytes(4))}`,
    });
    orgSlug = org.slug;
  }
  const project = await c.orpc<{ id: string; slug: string }>("project/create", {
    organizationSlug: orgSlug,
    name: `MCP E2E ${b64url(randomBytes(4))}`,
  });
  expect(project.id).toMatch(/^prj_/);

  // 3. Dynamic client registration — a public PKCE client, like Grok.
  const register = await c.call(`${c.api}/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `mcp-e2e-${b64url(randomBytes(6))}`,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const client = (await register.json()) as { client_id: string };
  expect(client.client_id, "dynamic client registration").toBeTruthy();

  // 4. Authorize with PKCE and NO `resource` param → opaque token, like Grok.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const authorizeUrl = new URL(`${c.api}/oauth2/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
  }).toString();

  let redirect = await c.readRedirect(await c.call(authorizeUrl.toString()));
  let redirectUrl = new URL(redirect ?? "", authOrigin);

  // The gating behaviour: with no fresh selection stored for this session, the
  // authorize endpoint must send the user to /project-access — not straight to
  // an authorization code.
  expect(redirectUrl.pathname, "authorize gates on project selection").toContain("/project-access");

  // 5. Store a selection for THIS client + session, then continue postLogin.
  await c.orpc("user/storeOAuthProjectSelection", {
    clientId: client.client_id,
    projectIds: [project.id],
  });
  redirect = await c.readRedirect(
    await c.call(`${c.api}/oauth2/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postLogin: true, oauth_query: redirectUrl.search.replace(/^\?/, "") }),
    }),
  );
  redirectUrl = new URL(redirect ?? "", authOrigin);

  // 6. Accept consent if prompted.
  if (redirectUrl.pathname.includes("consent")) {
    redirect = await c.readRedirect(
      await c.call(`${c.api}/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accept: true,
          oauth_query: redirectUrl.search.replace(/^\?/, ""),
        }),
      }),
    );
    redirectUrl = new URL(redirect ?? "", authOrigin);
  }

  const code = redirectUrl.searchParams.get("code");
  expect(code, "authorization code issued after selection + consent").toBeTruthy();
  expect(redirectUrl.searchParams.get("state")).toBe(state);

  // 7. Exchange the code for an opaque access token.
  const tokenRes = await c.call(`${c.api}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  const token = (await tokenRes.json()) as { access_token: string; token_type: string };
  expect(tokenRes.status, "token exchange").toBe(200);
  // Lock in that we are exercising the OPAQUE path (the bug was here), not the
  // JWT path: a JWT would be three dot-separated segments.
  expect(token.access_token.split(".").length, "token is opaque, not a JWT").toBe(1);

  // 8. Use the opaque token against the real OS MCP endpoint.
  const mcp = async (body: unknown) => {
    const res = await fetch(`${mcpOrigin}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data:")) ?? text;
    const parsed = JSON.parse(dataLine.replace(/^data:\s*/, "")) as {
      result?: { serverInfo?: { name?: string }; tools?: Array<{ name: string }> };
    };
    return { status: res.status, parsed };
  };

  const init = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-oauth-e2e", version: "1.0" },
    },
  });
  expect(init.status, "MCP initialize with opaque bearer").toBe(200);
  expect(init.parsed.result?.serverInfo?.name).toBe("os");

  const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(tools.status, "MCP tools/list").toBe(200);
  const toolNames = tools.parsed.result?.tools?.map((tool) => tool.name) ?? [];
  expect(toolNames, "opaque token grants the project MCP tool surface").toContain("exec_js");

  console.log(
    `MCP OAuth e2e passed for ${osBaseUrl.toString()} (opaque token → tools: ${toolNames.join(", ")})`,
  );
});
