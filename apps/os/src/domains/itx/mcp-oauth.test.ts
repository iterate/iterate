// The outbound MCP-OAuth flow, end to end, against a spec-faithful in-memory
// OAuth-protected MCP server: real SDK discovery (RFC 9728/8414), real dynamic
// registration (RFC 7591), a real authorization-code + PKCE (S256) redirect,
// and a real Basic-auth token exchange — no network. The petshop's own tests
// prove the provider half (apps/dummy-petshop/src/worker.test.ts); this proves
// beginMcpOAuth/completeMcpOAuth + the encrypted state codec drive a standards
// server correctly.
import type { FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, test } from "vitest";
import { beginMcpOAuth, completeMcpOAuth, McpOAuthError } from "./mcp-oauth.ts";

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
 * A minimal but faithful OAuth-protected MCP server as a FetchLike, plus knobs
 * to drop capabilities (no auth advertising / no dynamic registration) for the
 * error paths. Confidential clients, Basic auth at the token endpoint, and PKCE
 * S256 verification — the exact shape beginMcpOAuth expects.
 */
function makeFakeServer(opts: { protectedResource?: boolean; registration?: boolean } = {}): {
  fetch: FetchLike;
  issuedAccessTokens: Set<string>;
} {
  const protectedResource = opts.protectedResource ?? true;
  const registration = opts.registration ?? true;
  const clients = new Map<string, string>(); // clientId -> clientSecret
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge?: string }>();
  const issuedAccessTokens = new Set<string>();
  const refreshTokens = new Set<string>();

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const basic = (request: Request): { id: string; secret: string } | null => {
    const header = request.headers.get("authorization") ?? "";
    if (!/^basic /i.test(header)) return null;
    const [id, secret] = atob(header.slice(6)).split(":");
    return id && secret ? { id, secret } : null;
  };

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
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }

    if (key === "POST /oauth/register") {
      const clientId = `client-${clients.size + 1}`;
      const clientSecret = `secret-${clients.size + 1}`;
      clients.set(clientId, clientSecret);
      return json(
        {
          client_id: clientId,
          client_secret: clientSecret,
          client_id_issued_at: 1,
          client_secret_expires_at: 0,
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "client_secret_basic",
        },
        201,
      );
    }

    // Consent-free approve lane (the browser step the test drives directly).
    if (key === "GET /oauth/authorize") {
      const code = `code-${codes.size + 1}`;
      const challenge = url.searchParams.get("code_challenge") ?? undefined;
      codes.set(code, {
        clientId: url.searchParams.get("client_id") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        ...(challenge ? { challenge } : {}),
      });
      const target = new URL(url.searchParams.get("redirect_uri") ?? REDIRECT_URI);
      target.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) target.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: target.toString() } });
    }

    if (key === "POST /oauth/token") {
      const creds = basic(request);
      if (!creds || clients.get(creds.id) !== creds.secret) {
        return json({ error: "invalid_client" }, 401);
      }
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        if (!code || code.clientId !== creds.id) return json({ error: "invalid_grant" }, 400);
        if (code.redirectUri !== form.get("redirect_uri")) {
          return json({ error: "invalid_grant", error_description: "redirect mismatch" }, 400);
        }
        if (code.challenge !== undefined) {
          const verifier = form.get("code_verifier") ?? "";
          if (!verifier || (await pkceS256(verifier)) !== code.challenge) {
            return json({ error: "invalid_grant", error_description: "pkce" }, 400);
          }
        }
        codes.delete(form.get("code") ?? "");
        const accessToken = `at-${issuedAccessTokens.size + 1}`;
        const refreshToken = `rt-${refreshTokens.size + 1}`;
        issuedAccessTokens.add(accessToken);
        refreshTokens.add(refreshToken);
        return json({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "bearer",
          expires_in: 120,
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (!refreshTokens.has(form.get("refresh_token") ?? "")) {
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

/** Drive the "user clicks the link and signs in" step: follow the authorization
 * URL to the fake's approve lane and pull code+state off the redirect. */
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
  test("begin → approve → complete yields a usable, refreshable token", async () => {
    const server = makeFakeServer();
    const begin = await beginMcpOAuth({
      mcpUrl: MCP_URL,
      path: "/secrets/mcp/petshop",
      redirectUri: REDIRECT_URI,
      notify: NOTIFY,
      projectId: PROJECT_ID,
      encryptionKey: KEY,
      fetchFn: server.fetch,
    });

    // The link points at the provider's authorize endpoint, carries PKCE + our
    // callback, and does not leak the client secret in the clear.
    const authUrl = new URL(begin.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(`${ORIGIN}/oauth/authorize`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(begin.authorizationServer).toBe(ORIGIN);
    expect(begin.authorizationUrl).not.toContain("secret-1");

    const { code, state } = await approve(server.fetch, begin.authorizationUrl);
    const result = await completeMcpOAuth({
      code,
      state,
      encryptionKey: KEY,
      fetchFn: server.fetch,
    });

    expect(result.path).toBe("/secrets/mcp/petshop");
    expect(result.notify).toBe(NOTIFY);
    expect(result.mcpUrl).toBe(MCP_URL);
    expect(result.egressOrigins).toEqual([ORIGIN]);
    // Confidential client → material carries the client creds and the refresh
    // strategy reads them from material.
    expect(result.secret.material.accessToken).toBeTruthy();
    expect(result.secret.material.refreshToken).toBeTruthy();
    expect(result.secret.material.clientSecret).toBeTruthy();
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

    // ...and the stored refresh material mints a fresh token via Basic auth,
    // exactly as the Secret DO's oauth-refresh-token strategy will.
    const refreshed = await server.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${result.secret.material.clientId}:${result.secret.material.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: result.secret.material.refreshToken!,
      }),
    });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { access_token: string }).access_token).toBeTruthy();
  });

  test("a server that is not OAuth-protected fails with a helpful message", async () => {
    const server = makeFakeServer({ protectedResource: false });
    await expect(
      beginMcpOAuth({
        mcpUrl: MCP_URL,
        path: "/secrets/mcp/x",
        redirectUri: REDIRECT_URI,
        projectId: PROJECT_ID,
        encryptionKey: KEY,
        fetchFn: server.fetch,
      }),
    ).rejects.toThrow(McpOAuthError);
  });

  test("a server without dynamic registration is rejected", async () => {
    const server = makeFakeServer({ registration: false });
    await expect(
      beginMcpOAuth({
        mcpUrl: MCP_URL,
        path: "/secrets/mcp/x",
        redirectUri: REDIRECT_URI,
        projectId: PROJECT_ID,
        encryptionKey: KEY,
        fetchFn: server.fetch,
      }),
    ).rejects.toThrow(/dynamic client registration/);
  });

  test("a tampered or foreign-key state is rejected at completion", async () => {
    const server = makeFakeServer();
    const begin = await beginMcpOAuth({
      mcpUrl: MCP_URL,
      path: "/secrets/mcp/x",
      redirectUri: REDIRECT_URI,
      projectId: PROJECT_ID,
      encryptionKey: KEY,
      fetchFn: server.fetch,
    });
    const { code, state } = await approve(server.fetch, begin.authorizationUrl);
    // Wrong encryption key (another deployment) cannot read the state.
    await expect(
      completeMcpOAuth({ code, state, encryptionKey: "a-different-key", fetchFn: server.fetch }),
    ).rejects.toThrow(McpOAuthError);
    // A truncated state token is malformed.
    await expect(
      completeMcpOAuth({
        code,
        state: state.slice(0, 10),
        encryptionKey: KEY,
        fetchFn: server.fetch,
      }),
    ).rejects.toThrow(McpOAuthError);
  });
});
