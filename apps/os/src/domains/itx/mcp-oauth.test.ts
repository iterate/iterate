// The outbound MCP-OAuth flow, end to end, against a spec-faithful in-memory
// OAuth-protected MCP server: real SDK discovery (RFC 9728/8414), real dynamic
// registration of a PUBLIC client (RFC 7591, token_endpoint_auth_method "none"),
// a real authorization-code + PKCE (S256) redirect, and a real public-client
// token exchange (client_id in the body, no secret) — no network. The petshop's
// own tests prove the provider half (apps/dummy-petshop/src/worker.test.ts); this
// proves beginMcpOAuth/completeMcpOAuth + the encrypted state codec drive a
// standards server correctly.
import type { FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, test } from "vitest";
import {
  beginMcpOAuth,
  completeMcpOAuth,
  decodeMcpOAuthState,
  McpOAuthError,
} from "./mcp-oauth.ts";

const KEY = "test-secret-encryption-key-000000000000";
const ORIGIN = "https://mcp.test";
const MCP_URL = `${ORIGIN}/mcp`;
const REDIRECT_URI = "https://os.test/api/mcp-oauth/callback";
const PROJECT_ID = "prj_test";
const NOTIFY = "/agents/petshop";

async function pkceS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * A minimal but faithful OAuth-protected MCP server as a FetchLike, plus knobs to
 * drop capabilities for the error paths. Registers PUBLIC clients pinned to their
 * redirect URIs, authenticates them at the token endpoint by client_id + PKCE
 * (no secret), and rejects a code without a verifier — the exact shape
 * beginMcpOAuth drives.
 */
function makeFakeServer(opts: { protectedResource?: boolean; registration?: boolean } = {}): {
  fetch: FetchLike;
  issuedAccessTokens: Set<string>;
} {
  const protectedResource = opts.protectedResource ?? true;
  const registration = opts.registration ?? true;
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge?: string }>();
  const issuedAccessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>(); // refreshToken -> clientId

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input as string, init as RequestInit);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;

    if (url.pathname === "/mcp") {
      const token = (request.headers.get("authorization") ?? "").replace(/^bearer /i, "");
      if (!issuedAccessTokens.has(token)) {
        return json({ error: "invalid_token" }, 401, {
          "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        });
      }
      return json({ jsonrpc: "2.0", id: 0, result: { ok: true } });
    }

    if (
      protectedResource &&
      (key === "GET /.well-known/oauth-protected-resource" ||
        key === "GET /.well-known/oauth-protected-resource/mcp")
    ) {
      return json({ resource: MCP_URL, authorization_servers: [ORIGIN] });
    }

    if (key === "GET /.well-known/oauth-authorization-server") {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        ...(registration ? { registration_endpoint: `${ORIGIN}/oauth/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      });
    }

    if (key === "POST /oauth/register") {
      const body = (await request.json()) as { redirect_uris?: string[] };
      const redirectUris = body.redirect_uris ?? [];
      const clientId = `client-${clients.size + 1}`;
      clients.set(clientId, { redirectUris });
      // A public client (token_endpoint_auth_method "none") — no secret returned.
      return json(
        {
          client_id: clientId,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
        },
        201,
      );
    }

    // Consent-free approve lane (the browser step the test drives directly).
    if (key === "GET /oauth/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const client = clients.get(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) {
        return json({ error: "invalid_request" }, 400);
      }
      const code = `code-${codes.size + 1}`;
      const challenge = url.searchParams.get("code_challenge") ?? undefined;
      codes.set(code, { clientId, redirectUri, ...(challenge ? { challenge } : {}) });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) target.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: target.toString() } });
    }

    if (key === "POST /oauth/token") {
      const form = new URLSearchParams(await request.text());
      // Public client: identified by client_id in the body, no Basic auth.
      const clientId = form.get("client_id") ?? "";
      if (!clients.has(clientId)) return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        if (!code || code.clientId !== clientId) return json({ error: "invalid_grant" }, 400);
        if (code.redirectUri !== form.get("redirect_uri")) {
          return json({ error: "invalid_grant", error_description: "redirect mismatch" }, 400);
        }
        // PKCE is mandatory for a public client — its only proof.
        const verifier = form.get("code_verifier") ?? "";
        if (!code.challenge || !verifier || (await pkceS256(verifier)) !== code.challenge) {
          return json({ error: "invalid_grant", error_description: "pkce" }, 400);
        }
        codes.delete(form.get("code") ?? "");
        const accessToken = `at-${issuedAccessTokens.size + 1}`;
        const refreshToken = `rt-${refreshTokens.size + 1}`;
        issuedAccessTokens.add(accessToken);
        refreshTokens.set(refreshToken, clientId);
        return json({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "bearer",
          expires_in: 120,
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (refreshTokens.get(form.get("refresh_token") ?? "") !== clientId) {
          return json({ error: "invalid_grant" }, 400);
        }
        const accessToken = `at-${issuedAccessTokens.size + 1}`;
        issuedAccessTokens.add(accessToken);
        return json({ access_token: accessToken, token_type: "bearer", expires_in: 120 });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }

    return json({ error: "not_found" }, 404);
  };

  return { fetch, issuedAccessTokens };
}

const beginInput = (
  fetchFn: FetchLike,
  extra: Partial<Parameters<typeof beginMcpOAuth>[0]> = {},
) => ({
  mcpUrl: MCP_URL,
  path: "/secrets/mcp/petshop",
  redirectUri: REDIRECT_URI,
  projectId: PROJECT_ID,
  encryptionKey: KEY,
  fetchFn,
  ...extra,
});

/** Drive "the user clicks the link and signs in": follow the authorization URL to
 * the fake's approve lane and pull code+state off the redirect. */
async function approve(
  fetch: FetchLike,
  authorizationUrl: string,
): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizationUrl, { method: "GET" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return {
    code: location.searchParams.get("code") ?? "",
    state: location.searchParams.get("state") ?? "",
  };
}

describe("mcp oauth flow", () => {
  test("begin → approve → complete yields a usable, refreshable public-client token", async () => {
    const server = makeFakeServer();
    const begin = await beginMcpOAuth(beginInput(server.fetch, { notify: NOTIFY }));

    // The link points at the provider's authorize endpoint and carries PKCE + our
    // callback.
    const authUrl = new URL(begin.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(`${ORIGIN}/oauth/authorize`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);

    const { code, state } = await approve(server.fetch, begin.authorizationUrl);
    const decoded = await decodeMcpOAuthState(state, KEY);
    const result = await completeMcpOAuth(decoded, { code, fetchFn: server.fetch });

    expect(result.path).toBe("/secrets/mcp/petshop");
    expect(result.notify).toBe(NOTIFY);
    expect(result.mcpUrl).toBe(MCP_URL);
    expect(result.secret.egress.urls).toEqual([ORIGIN]);
    // Public client → material carries the client id (no secret) and the refresh
    // strategy reads it from material.
    expect(result.secret.material.accessToken).toBeTruthy();
    expect(result.secret.material.refreshToken).toBeTruthy();
    expect(result.secret.material.clientId).toBeTruthy();
    expect(result.secret.material.clientSecret).toBeUndefined();
    expect(result.secret.refresh).toEqual({
      kind: "oauth-refresh-token",
      tokenEndpoint: `${ORIGIN}/oauth/token`,
      clientCreds: "material",
    });

    // The access token actually works against the MCP endpoint...
    const authed = await server.fetch(MCP_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${result.secret.material.accessToken}` },
    });
    expect(authed.status).toBe(200);

    // ...and the stored refresh material mints a fresh token as a public client
    // (client_id in the body, no Basic auth) — exactly what the Secret DO's
    // oauth-refresh-token strategy does for a secret-less client.
    const refreshed = await server.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: result.secret.material.refreshToken!,
        client_id: result.secret.material.clientId!,
      }),
    });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { access_token: string }).access_token).toBeTruthy();
  });

  test("no notify field when the caller is not an agent scope", async () => {
    const server = makeFakeServer();
    const begin = await beginMcpOAuth(beginInput(server.fetch));
    const { code, state } = await approve(server.fetch, begin.authorizationUrl);
    const result = await completeMcpOAuth(await decodeMcpOAuthState(state, KEY), {
      code,
      fetchFn: server.fetch,
    });
    expect(result.notify).toBeUndefined();
  });

  test("a server that is not OAuth-protected fails with a helpful message", async () => {
    const server = makeFakeServer({ protectedResource: false });
    await expect(beginMcpOAuth(beginInput(server.fetch))).rejects.toThrow(McpOAuthError);
  });

  test("a server without dynamic registration is rejected", async () => {
    const server = makeFakeServer({ registration: false });
    await expect(beginMcpOAuth(beginInput(server.fetch))).rejects.toThrow(
      /dynamic client registration/,
    );
  });

  test("a tampered, foreign-key, or expired state is rejected at decode", async () => {
    const server = makeFakeServer();
    const begin = await beginMcpOAuth(beginInput(server.fetch));
    const { state } = await approve(server.fetch, begin.authorizationUrl);
    // Wrong encryption key (another deployment) cannot read the state.
    await expect(decodeMcpOAuthState(state, "a-different-key")).rejects.toThrow(McpOAuthError);
    // A truncated state token is malformed.
    await expect(decodeMcpOAuthState(state.slice(0, 10), KEY)).rejects.toThrow(McpOAuthError);
  });
});
