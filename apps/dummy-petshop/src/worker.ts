/**
 * dummy-petshop — a deliberately fake third-party service ("the pet shop")
 * for exercising Iterate's integrations & secrets system end to end
 * (apps/os/docs/integrations-and-secrets-design.md §7 S0, "Petshop ×2" §3):
 * ONE pets API behind many authentication doors — an OAuth 2.0 provider with
 * Basic client auth at the token endpoint and short-TTL sealed tokens, a
 * legacy email+password login, a GraphQL session-login door, MCP, typed
 * RPC/OpenAPI surfaces, three WebSocket gateways — plus HMAC-signed outbound
 * webhooks and a test backdoor. GET / documents the whole surface.
 *
 * The worker is stateless: durable state is one JSON blob in the
 * PetshopStateDurableObject (state.ts) and every code/token is a sealed
 * AES-GCM blob (seal.ts). handlePetshopRequest is a plain function of
 * (request, deps), so unit tests drive the full HTTP surface in Node against
 * the real state class over an in-memory storage fake.
 */
import dedent from "dedent";
import {
  bearerTokenFromHeader,
  type GatewayConnectionState,
  type GatewayDeps,
  handleGatewayMessage,
  handleUpgradeAuth,
  helloFrame,
  newGatewayConnection,
  subprotocolAuth,
} from "./gateway.ts";
import { verifyAppJwt } from "./github-app.ts";
import { handleMcpRequest } from "./mcp.ts";
import { type Pet, seedPets } from "./pets.ts";
import { handlePetsRpcRequest, petshopOpenApiDocument } from "./rpc.ts";
import { hmacSha256Hex, nowSeconds, pkceS256, seal, unseal } from "./seal.ts";
import {
  GRAPHQL_LOGIN_PASSWORD,
  GRAPHQL_SESSION_TTL_SECONDS,
  graphqlSessionFromBearer,
  handleGraphqlLogin,
} from "./graphql-login.ts";
import {
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_APP_ID,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_INSTALLATION_ID,
  accessTokenEpochFor,
  type OauthClient,
  type PetshopState,
  PetshopStateDurableObject,
} from "./state.ts";

export { PetshopStateDurableObject };

/** Authorization codes only need to survive the redirect back to the callback. */
const CODE_TTL_SECONDS = 120;

/** GitHub-App installation tokens are deliberately short (design §9 P4 wants
 * refresh exercised): 60s, so an integration that caches one hits real re-mint. */
const INSTALLATION_TOKEN_TTL_SECONDS = 60;

/** Bindings the worker runs with (wrangler.jsonc, generated from the root envs.ts). */
export interface Env {
  /** Immutable id of the Worker version serving this request. */
  CF_VERSION_METADATA: { id: string };
  PETSHOP_STATE: DurableObjectNamespace<PetshopStateDurableObject>;
  /** Seals every code/token; 32 bytes base64. Deploy-minted unless pinned in Doppler (scripts/deploy.ts). */
  PETSHOP_SEAL_KEY: string;
  /** When set, /__backdoor* requires it in the x-petshop-backdoor header. */
  PETSHOP_BACKDOOR_SECRET?: string;
}

/**
 * What route handlers need from the environment. `state` is the Durable
 * Object's RPC stub in production and a plain PetshopStateDurableObject over
 * an in-memory storage fake in unit tests — Pick<> keeps the two
 * structurally interchangeable.
 */
export interface PetshopDeps {
  state: Pick<
    PetshopStateDurableObject,
    | "getState"
    | "createClient"
    | "expireAccessTokens"
    | "revokeRefreshToken"
    | "rotateSigningSecret"
    | "setTokenEndpointFailures"
    | "consumeTokenEndpointFailure"
    | "consumeAuthorizationCode"
    | "registerApp"
  >;
  sealKey: string;
  backdoorSecret?: string;
  /**
   * The account's (fictional) pet catalogue — a per-instance in-memory array
   * (pets.ts), shared by GET /api/pets, the oRPC/OpenAPI procedures, and the
   * MCP tools. In-memory rather than durable because pets are demo data; a
   * fresh array per worker isolate / per test keeps createPet mutations
   * isolated. The default `fetch` seeds one with seedPets().
   */
  pets: Pet[];
}

/** Sealed authorization code; redirectUri is re-checked at exchange (RFC 6749 §4.1.3). */
interface CodePayload {
  t: "code";
  /** Makes the code single-use: recorded spent on first exchange (RFC 6749 §4.1.2). */
  jti: string;
  sub: string;
  clientId: string;
  redirectUri: string;
  exp: number;
  /** PKCE S256 challenge (RFC 7636) when the client sent one at /oauth/authorize.
   * The token endpoint requires the matching code_verifier when this is present;
   * absent for the legacy consent-only lane, which keeps existing e2e green. */
  codeChallenge?: string;
}

/** Sealed access token; `epoch` must still equal this client's revocation epoch. */
interface AccessPayload {
  t: "access";
  sub: string;
  clientId: string;
  epoch: number;
  exp: number;
}

/** Sealed refresh token: never expires, individually revocable via `jti`. */
interface RefreshPayload {
  t: "refresh";
  sub: string;
  clientId: string;
  jti: string;
}

/**
 * Sealed GitHub-App installation token (design §9 P4): what petshop mints when a
 * valid App JWT is exchanged at `POST /app/installations/{id}/access_tokens`. It
 * carries `sub`/`clientId`/`epoch`/`exp` so it flows through the SAME bearer API
 * and revocation model as an OAuth access token (see {@link Grant}), plus the
 * `installationId`/`appId` it was minted for so `/api/me` can name which
 * installation the caller is acting as.
 */
interface InstallationPayload {
  t: "installation";
  sub: string;
  clientId: string;
  installationId: string;
  appId: string;
  epoch: number;
  exp: number;
}

/** A live bearer grant on the pet-shop API: an OAuth/legacy access token or a
 * GitHub-App installation token. Both are epoch-bound and expiring, so
 * {@link accessGrant} validates them identically; only `/api/me` distinguishes
 * them (an installation token names its installation). */
type Grant = AccessPayload | InstallationPayload;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

// The index doubles as endpoint documentation, so anyone poking a deployed
// instance sees the whole surface without opening the repo.
const INDEX = dedent`
  🐾 dummy-petshop — a fake third party for integrations & secrets e2e
     (apps/os/docs/integrations-and-secrets-design.md §7 S0)

  GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 — /mcp's resource + this origin as its auth server
  GET  /.well-known/oauth-authorization-server      RFC 8414 — authorize/token/register endpoints, PKCE S256, auth methods none + client_secret_basic
  POST /oauth/register      RFC 7591 dynamic client registration → a client pinned to its redirect_uris; token_endpoint_auth_method "none" ⇒ public (no secret, PKCE), else confidential
  GET  /oauth/authorize     ?client_id&redirect_uri&state[&code_challenge] — consent page; add &approve=1[&user=x] to skip it (test lane); a DCR client's redirect_uri must be one it registered
  POST /oauth/authorize     consent form submit → 302 redirect_uri?code=…&state=…
  POST /oauth/token         grant_type=authorization_code | refresh_token; confidential = HTTP Basic (RFC 6749 §2.3.1), public = client_id in the body; PKCE code_verifier required for public clients (and any code that carried a challenge, RFC 7636)
  POST /api/legacy-login    {email, password} → {accessToken, expiresInSeconds}; any email, password "correct-horse"
  POST /graphql             GraphQL session-login door: NewSession (any username, password "${GRAPHQL_LOGIN_PASSWORD}")
                            → sealed ~${GRAPHQL_SESSION_TTL_SECONDS}s session token, valid as an ordinary bearer on /api/*
                            (one more way into the ONE pets API); expired/revoked → 401; no refresh grant — re-login is the refresh
  GET  /api/me              bearer whoami: {sub, clientId, tokenExpiresInSeconds}; +{installationId, appId} for an installation token
  GET  /api/pets            the account's (entirely fictional) pets

  POST /app/installations/<installationId>/access_tokens
                            GitHub-App installation token — Authorization: Bearer <App JWT> (RS256 over header.payload, iss=appId, exp future) → {token, expires_at}; token works as a bearer on /api/*

  GET  /openapi.json        OpenAPI 3.1 doc for the typed pets API (listPets/getPet/createPet)
  POST /rpc/*               oRPC handler for the pets API (what an @orpc/client talks); bearer-protected
  GET|POST /api/v2/*        the same pets procedures served REST-shaped (per the OpenAPI doc)
  GET|POST /mcp             MCP server (streamable HTTP): tools list_pets, get_pet, create_pet; bearer-protected — an unauthorized call answers 401 + WWW-Authenticate pointing at the RFC 9728 metadata above (OAuth-protected MCP server)
  GET  /gateway               (websocket) — token in the first {op:identify, token} FRAME (Discord shape)
  GET  /gateway-header        (websocket) — token in the Authorization: Bearer UPGRADE header (OpenAI-Realtime shape)
  GET  /gateway-subprotocol   (websocket) — token in Sec-WebSocket-Protocol as "petshop.access-token.<token>" (browser-WS shape)

  GET  /__backdoor/state                   the whole mutable state, for spec assertions
  POST /__backdoor/clients                 {accessTokenTtlSeconds?} → mint {clientId, clientSecret}
  POST /__backdoor/expire-tokens           {clientId} → invalidate that client's outstanding access tokens
  POST /__backdoor/revoke-refresh-token    {refreshToken} → that refresh token stops working
  POST /__backdoor/rotate-signing-secret   new webhook HMAC secret
  POST /__backdoor/fail-token-endpoint     {clientId,times} → that client's next N token calls return 500
  POST /__backdoor/webhooks/fire           {url, event?, badSignature?} → POST a signed webhook there now
  POST /__backdoor/apps                    {publicKeyPem, appId?, installationId?, webhookSecret?} → register/replace a GitHub-App installation (public key only)
  POST /__backdoor/apps/fire-webhook       {installationId?, url?, event?, badSignature?} → deliver (or, with no url, echo) a webhook signed x-hub-signature-256 with the app's webhookSecret

  Seeded client: ${DEFAULT_CLIENT_ID} / ${DEFAULT_CLIENT_SECRET} · access tokens live ${DEFAULT_ACCESS_TTL_SECONDS}s ·
  webhooks are signed x-petshop-signature-256: sha256=<hex hmac of the raw body> · the backdoor is open
  unless PETSHOP_BACKDOOR_SECRET is set, in which case send it as x-petshop-backdoor.

  Seeded GitHub App: ${DEFAULT_APP_ID} · installation ${DEFAULT_INSTALLATION_ID} (register its RS256 public key via POST /__backdoor/apps) ·
  installation tokens live ${INSTALLATION_TOKEN_TTL_SECONDS}s · App JWTs verify RS256 over header.payload and App webhooks sign x-hub-signature-256.
`;

function consentPage(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const hidden = (
    [
      ["client_id", params.clientId],
      ["redirect_uri", params.redirectUri],
      ["state", params.state],
      // PKCE challenge rides through the consent POST so the browser lane
      // (human clicks Approve) proves the same code_verifier at token time
      // as the consent-free &approve=1 lane.
      ["code_challenge", params.codeChallenge],
    ] as const
  )
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`)
    .join("\n");
  return dedent`
    <!doctype html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Pet Shop — authorize</title>
    <style>
      body{font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fef9f0}
      main{background:#fff;border-radius:12px;box-shadow:0 2px 24px rgba(0,0,0,.08);padding:2.5rem;width:22rem}
      h1{font-size:1.2rem;margin:0 0 .5rem} p{color:#555;font-size:.9rem}
      label{display:block;font-size:.8rem;font-weight:600;margin:1rem 0 .3rem}
      input[type=text]{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #ccc;border-radius:8px}
      button{margin-top:1.5rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#d97706;color:#fff;font-weight:600;font-size:1rem;cursor:pointer}
    </style></head>
    <body><main>
    <h1>🐾 Pet Shop</h1>
    <p><b>${escapeHtml(params.clientId)}</b> wants access to your (entirely fictional) pets.</p>
    <form method="post" action="/oauth/authorize">
    ${hidden}
    <label for="user">Your name</label>
    <input type="text" id="user" name="user" value="Demo User" />
    <button type="submit">Approve</button>
    </form>
    </main></body></html>
  `;
}

/** The authorize-time validations: registered client_id, absolute redirect_uri,
 * and — for a dynamically-registered client — exact membership in the redirect
 * URIs it registered (RFC 7591 / the MCP authorization spec; prevents an
 * open-redirect / code-theft hole). Seeded/backdoor clients register none and
 * accept any absolute URI. Null when acceptable. */
async function authorizeRejection(
  deps: PetshopDeps,
  clientId: string,
  redirectUri: string,
): Promise<Response | null> {
  const state = await deps.state.getState();
  const client = state.clients[clientId];
  if (!client) {
    return json(
      {
        error: "invalid_request",
        error_description: `unknown client_id ${JSON.stringify(clientId)} — mint one via POST /__backdoor/clients`,
      },
      400,
    );
  }
  if (!URL.canParse(redirectUri)) {
    return json(
      { error: "invalid_request", error_description: "redirect_uri must be an absolute URL" },
      400,
    );
  }
  if (
    client.redirectUris &&
    client.redirectUris.length > 0 &&
    !client.redirectUris.includes(redirectUri)
  ) {
    return json(
      {
        error: "invalid_request",
        error_description: "redirect_uri is not registered for this client",
      },
      400,
    );
  }
  return null;
}

async function mintCodeRedirect(
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    user: string;
    codeChallenge: string;
  },
  deps: PetshopDeps,
): Promise<Response> {
  const payload: CodePayload = {
    t: "code",
    jti: crypto.randomUUID(),
    sub: params.user.slice(0, 64) || "Demo User",
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    exp: nowSeconds() + CODE_TTL_SECONDS,
    ...(params.codeChallenge ? { codeChallenge: params.codeChallenge } : {}),
  };
  const target = new URL(params.redirectUri);
  target.searchParams.set("code", await seal(payload, deps.sealKey));
  if (params.state) target.searchParams.set("state", params.state);
  return Response.redirect(target.toString(), 302);
}

// ---------------------------------------------------------------------------
// MCP OAuth discovery (RFC 9728 protected-resource + RFC 8414 auth-server
// metadata + RFC 7591 dynamic client registration). These make /mcp a
// standards "OAuth-protected MCP server": a client that hits /mcp unauthorized
// reads the WWW-Authenticate `resource_metadata` URL, discovers this origin as
// its own authorization server, registers a client, and runs the code+PKCE
// flow against the endpoints already served above. This is the door the OS
// outbound MCP-OAuth flow (itx.mcp.beginOAuth) is proven against.
// ---------------------------------------------------------------------------

/** RFC 9728: /mcp is the protected resource and this same origin is its
 * authorization server. Served at both /.well-known/oauth-protected-resource
 * and the resource-suffixed /.well-known/oauth-protected-resource/mcp. */
function protectedResourceMetadata(origin: string) {
  return { resource: `${origin}/mcp`, authorization_servers: [origin] };
}

/** RFC 8414: the endpoints an MCP OAuth client discovers to register, start the
 * code+PKCE flow, and exchange/refresh tokens. Supports both a public client
 * (token_endpoint_auth_method "none" + PKCE — the standard MCP shape) and a
 * confidential one (client_secret_basic). PKCE S256 either way. */
function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    scopes_supported: ["pets:read", "pets:write"],
  };
}

/** RFC 7591 dynamic client registration: the client POSTs its redirect_uris (+
 * optional metadata) and petshop mints a fresh client, PINNED to exactly those
 * redirect URIs. `token_endpoint_auth_method: "none"` mints a public client (no
 * secret, PKCE-authenticated — the standard MCP shape); anything else mints a
 * confidential client whose secret the token endpoint enforces via Basic auth. */
async function registerOAuthClient(request: Request, deps: PetshopDeps): Promise<Response> {
  const body = await readJson(request);
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((value): value is string => typeof value === "string")
    : [];
  if (redirectUris.length === 0 || !redirectUris.every((value) => URL.canParse(value))) {
    return json(
      { error: "invalid_redirect_uri", error_description: "redirect_uris must be absolute URLs" },
      400,
    );
  }
  const isPublic = body.token_endpoint_auth_method === "none";
  const { clientId, clientSecret } = await deps.state.createClient({
    redirectUris,
    ...(isPublic ? { public: true } : {}),
  });
  return json(
    {
      client_id: clientId,
      ...(isPublic ? {} : { client_secret: clientSecret }),
      client_id_issued_at: nowSeconds(),
      // 0 = never expires (RFC 7591 §3.2.1).
      ...(isPublic ? {} : { client_secret_expires_at: 0 }),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: isPublic ? "none" : "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: typeof body.client_name === "string" ? body.client_name : "mcp-client",
    },
    201,
  );
}

/** RFC 6749 §2.3.1 HTTP Basic client auth — the required-to-support method the OS side's Basic-auth header placeholder exercises. */
function basicClientCredentials(
  request: Request,
): { clientId: string; clientSecret: string } | null {
  const header = request.headers.get("authorization") ?? "";
  if (!/^basic /i.test(header)) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, colon)),
      clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}

async function issueTokens(input: {
  sub: string;
  clientId: string;
  ttlSeconds: number;
  epoch: number;
  sealKey: string;
}): Promise<Response> {
  const access: AccessPayload = {
    t: "access",
    sub: input.sub,
    clientId: input.clientId,
    epoch: input.epoch,
    exp: nowSeconds() + input.ttlSeconds,
  };
  const refresh: RefreshPayload = {
    t: "refresh",
    sub: input.sub,
    clientId: input.clientId,
    jti: crypto.randomUUID(),
  };
  return json({
    access_token: await seal(access, input.sealKey),
    token_type: "bearer",
    expires_in: input.ttlSeconds,
    refresh_token: await seal(refresh, input.sealKey),
  });
}

async function tokenEndpoint(request: Request, deps: PetshopDeps): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const state = await deps.state.getState();
  const auth = authenticateTokenClient(request, form, state);
  if (auth instanceof Response) return auth;
  const { clientId, client } = auth;
  if (await deps.state.consumeTokenEndpointFailure(clientId)) {
    return json(
      {
        error: "temporarily_unavailable",
        error_description: "backdoor-scheduled failure (POST /__backdoor/fail-token-endpoint)",
      },
      500,
    );
  }
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    const code = await unseal<CodePayload>(form.get("code") ?? "", deps.sealKey);
    if (!code || code.t !== "code" || code.clientId !== clientId) {
      return json({ error: "invalid_grant" }, 400);
    }
    if (code.exp < nowSeconds()) {
      return json({ error: "invalid_grant", error_description: "code expired" }, 400);
    }
    if (code.redirectUri !== (form.get("redirect_uri") ?? "")) {
      return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    // PKCE (RFC 7636). A public client has no secret, so PKCE is its ONLY proof
    // and is mandatory. A confidential client is verified when it sent a
    // challenge (the legacy consent-only lane sends none — no verifier required).
    if (client.public && code.codeChallenge === undefined) {
      return json(
        { error: "invalid_grant", error_description: "PKCE is required for public clients" },
        400,
      );
    }
    if (code.codeChallenge !== undefined) {
      const verifier = form.get("code_verifier") ?? "";
      if (!verifier || (await pkceS256(verifier)) !== code.codeChallenge) {
        return json(
          { error: "invalid_grant", error_description: "PKCE code_verifier mismatch" },
          400,
        );
      }
    }
    // Single-use: a replayed code is rejected (RFC 6749 §4.1.2).
    if (!(await deps.state.consumeAuthorizationCode(code.jti))) {
      return json({ error: "invalid_grant", error_description: "code already used" }, 400);
    }
    // Re-read this client's epoch at issue time: the awaits above release the
    // DO input gate, so concurrent targeted expiry could otherwise make the
    // replacement token invalid as soon as it is minted.
    return issueTokens({
      sub: code.sub,
      clientId,
      ttlSeconds: client.accessTokenTtlSeconds,
      epoch: accessTokenEpochFor(await deps.state.getState(), clientId),
      sealKey: deps.sealKey,
    });
  }
  if (grantType === "refresh_token") {
    const refresh = await unseal<RefreshPayload>(form.get("refresh_token") ?? "", deps.sealKey);
    if (!refresh || refresh.t !== "refresh" || refresh.clientId !== clientId) {
      return json({ error: "invalid_grant" }, 400);
    }
    // Re-read fresh state so the revocation check and the stamped epoch agree
    // with what accessGrant will validate against (same input-gate race).
    const current = await deps.state.getState();
    if (current.revokedRefreshTokenIds.includes(refresh.jti)) {
      return json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400);
    }
    return issueTokens({
      sub: refresh.sub,
      clientId,
      ttlSeconds: client.accessTokenTtlSeconds,
      epoch: accessTokenEpochFor(current, clientId),
      sealKey: deps.sealKey,
    });
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

/** Authenticate the token-endpoint caller: a confidential client presents HTTP
 * Basic (RFC 6749 §2.3.1); a public client presents client_id in the body, its
 * PKCE verifier standing in for a secret (verified per authorization_code grant).
 * Returns the resolved client, or a 401 Response. */
function authenticateTokenClient(
  request: Request,
  form: URLSearchParams,
  state: PetshopState,
): { clientId: string; client: OauthClient } | Response {
  const unauthorized = () =>
    json({ error: "invalid_client" }, 401, { "www-authenticate": 'Basic realm="dummy-petshop"' });
  const basic = basicClientCredentials(request);
  if (basic) {
    const client = state.clients[basic.clientId];
    if (!client || client.public || client.clientSecret !== basic.clientSecret)
      return unauthorized();
    return { clientId: basic.clientId, client };
  }
  const clientId = form.get("client_id") ?? "";
  const client = state.clients[clientId];
  if (!client || !client.public) return unauthorized();
  return { clientId, client };
}

/**
 * The legacy email+password login (design R8): email+password → short-TTL
 * bearer token, no refresh token — re-minting through this endpoint IS the
 * refresh path. Deterministic for e2e: any email, password "correct-horse".
 */
async function legacyLogin(request: Request, deps: PetshopDeps): Promise<Response> {
  const body = await readJson(request);
  const email = typeof body.email === "string" ? body.email : "";
  if (!email || body.password !== "correct-horse") {
    return json({ error: "invalid_credentials" }, 401);
  }
  const state = await deps.state.getState();
  const access: AccessPayload = {
    t: "access",
    sub: email,
    clientId: "legacy-login",
    epoch: accessTokenEpochFor(state, "legacy-login"),
    exp: nowSeconds() + DEFAULT_ACCESS_TTL_SECONDS,
  };
  return json({
    accessToken: await seal(access, deps.sealKey),
    expiresInSeconds: DEFAULT_ACCESS_TTL_SECONDS,
  });
}

/**
 * The GitHub-App installation-token endpoint (design §9 P4, ADR 0006):
 * `POST /app/installations/{installationId}/access_tokens` with an App JWT in
 * `Authorization: Bearer`. petshop holds ONLY the app's PUBLIC key, so all it
 * can do is VERIFY: the JWT's RS256 signature (the OS side signed
 * `header.payload` with the App private key via the secrets `sign()` compute
 * method — the key never left its secret), `iss` = the app id, `exp` in the
 * future. On success it mints a short-TTL sealed installation token accepted by
 * the same bearer API as OAuth access tokens. Every failure — unknown/keyless
 * installation, missing/malformed/mis-signed/expired JWT, wrong issuer — is a
 * flat 401, mirroring GitHub.
 */
async function appInstallationAccessToken(
  installationId: string,
  request: Request,
  deps: PetshopDeps,
): Promise<Response> {
  const state = await deps.state.getState();
  const app = state.apps[installationId];
  if (!app || !app.publicKeyPem) {
    return json(
      {
        error: "invalid_installation",
        error_description: `unknown or keyless installation ${JSON.stringify(installationId)} — register its public key via POST /__backdoor/apps`,
      },
      401,
    );
  }
  const header = request.headers.get("authorization") ?? "";
  if (!/^bearer /i.test(header)) {
    return json(
      { error: "invalid_jwt", error_description: "Authorization: Bearer <App JWT> required" },
      401,
    );
  }
  const verification = await verifyAppJwt({
    jwt: header.slice(7).trim(),
    publicKeyPem: app.publicKeyPem,
    expectedAppId: app.appId,
    now: nowSeconds(),
  });
  if (!verification.ok) {
    return json({ error: "invalid_jwt", error_description: verification.reason }, 401);
  }
  const exp = nowSeconds() + INSTALLATION_TOKEN_TTL_SECONDS;
  const payload: InstallationPayload = {
    t: "installation",
    sub: `installation:${installationId}`,
    clientId: app.appId,
    installationId,
    appId: app.appId,
    // Re-read this App client's epoch at seal time (verifyAppJwt released the
    // input gate), matching the OAuth token path's revocation freshness.
    epoch: accessTokenEpochFor(await deps.state.getState(), app.appId),
    exp,
  };
  // GitHub answers 201 Created with { token, expires_at } (ISO 8601 UTC).
  return json(
    { token: await seal(payload, deps.sealKey), expires_at: new Date(exp * 1000).toISOString() },
    201,
  );
}

/** Resolve the request's bearer token to a live grant — an OAuth/legacy access
 * token or a GitHub-App installation token — or null (absent, tampered,
 * expired, epoch-revoked). Both grant types are validated identically. */
async function accessGrant(request: Request, deps: PetshopDeps): Promise<Grant | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!/^bearer /i.test(header)) return null;
  const token = header.slice(7).trim();
  const grant = await unseal<Grant>(token, deps.sealKey);
  if (!grant) return null;
  if ((grant as { t?: string }).t === "graphql-session") {
    // The GraphQL login door's session is one more way in to the SAME API:
    // adapt it to an access-shaped grant (its "client" is the auth style —
    // this login flow has no OAuth client).
    const session = await graphqlSessionFromBearer(token, {
      sealKey: deps.sealKey,
      getAccessTokenEpoch: () =>
        deps.state.getState().then((state) => accessTokenEpochFor(state, "graphql-session-login")),
    });
    if (!session) return null;
    return {
      t: "access",
      sub: session.sub,
      clientId: "graphql-session-login",
      epoch: session.epoch,
      exp: session.exp,
    };
  }
  if (grant.t !== "access" && grant.t !== "installation") return null;
  if (grant.exp < nowSeconds()) return null;
  if (grant.epoch !== accessTokenEpochFor(await deps.state.getState(), grant.clientId)) return null;
  return grant;
}

/** POST a JSON payload signed GitHub-style: `<header>: sha256=<hex hmac>`.
 * `signatureHeader` defaults to petshop's OAuth-webhook header; the GitHub-App
 * webhook lane passes `x-hub-signature-256`. Delivery failure is reported, not
 * thrown. */
async function deliverWebhook(input: {
  url: string;
  secret: string;
  payload: unknown;
  signatureHeader?: string;
}): Promise<{ url: string; status: number; signature: string; payload: string; error?: string }> {
  const body = JSON.stringify(input.payload);
  const signature = `sha256=${await hmacSha256Hex(input.secret, body)}`;
  const signatureHeader = input.signatureHeader ?? "x-petshop-signature-256";
  let error: string | undefined;
  const response = await fetch(input.url, {
    method: "POST",
    headers: { "content-type": "application/json", [signatureHeader]: signature },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch((cause: unknown) => {
    // status 0 = the fetch itself failed; carry WHY (a bare 0 made transient
    // CI loopback failures undiagnosable).
    error = cause instanceof Error ? (cause.cause ?? cause).toString() : String(cause);
    return null;
  });
  return {
    url: input.url,
    status: response?.status ?? 0,
    signature,
    payload: body,
    ...(error === undefined ? {} : { error }),
  };
}

async function backdoor(key: string, request: Request, deps: PetshopDeps): Promise<Response> {
  if (deps.backdoorSecret && request.headers.get("x-petshop-backdoor") !== deps.backdoorSecret) {
    return json(
      { error: "backdoor_locked", error_description: "send the x-petshop-backdoor header" },
      403,
    );
  }
  if (key === "GET /__backdoor/state") return json(await deps.state.getState());
  if (key === "POST /__backdoor/clients") {
    const body = await readJson(request);
    const ttl = body.accessTokenTtlSeconds;
    return json(
      await deps.state.createClient(
        typeof ttl === "number" && ttl > 0 ? { accessTokenTtlSeconds: Math.ceil(ttl) } : {},
      ),
      201,
    );
  }
  if (key === "POST /__backdoor/expire-tokens") {
    const clientId = (await readJson(request)).clientId;
    if (typeof clientId !== "string" || clientId.length === 0) {
      return json(
        {
          error: "invalid_request",
          error_description: "clientId is required so expiry cannot affect unrelated tests",
        },
        400,
      );
    }
    return json({ clientId, accessTokenEpoch: await deps.state.expireAccessTokens(clientId) });
  }
  if (key === "POST /__backdoor/revoke-refresh-token") {
    const body = await readJson(request);
    const token = typeof body.refreshToken === "string" ? body.refreshToken : "";
    const refresh = await unseal<RefreshPayload>(token, deps.sealKey);
    if (!refresh || refresh.t !== "refresh") {
      return json(
        {
          error: "invalid_request",
          error_description: "refreshToken must be a sealed refresh token",
        },
        400,
      );
    }
    await deps.state.revokeRefreshToken(refresh.jti);
    return json({ revokedRefreshTokenId: refresh.jti });
  }
  if (key === "POST /__backdoor/rotate-signing-secret") {
    return json({ webhookSigningSecret: await deps.state.rotateSigningSecret() });
  }
  if (key === "POST /__backdoor/fail-token-endpoint") {
    const body = await readJson(request);
    const clientId = body.clientId;
    const times = body.times;
    if (typeof clientId !== "string" || clientId.length === 0) {
      return json(
        {
          error: "invalid_request",
          error_description: "clientId is required so failures cannot affect unrelated tests",
        },
        400,
      );
    }
    if (typeof times !== "number" || !Number.isInteger(times) || times < 0) {
      return json(
        { error: "invalid_request", error_description: "times must be a non-negative integer" },
        400,
      );
    }
    await deps.state.setTokenEndpointFailures(clientId, times);
    return json({ clientId, tokenEndpointFailuresRemaining: times });
  }
  if (key === "POST /__backdoor/webhooks/fire") {
    const body = await readJson(request);
    const url = typeof body.url === "string" ? body.url : "";
    if (!URL.canParse(url)) {
      return json(
        { error: "invalid_request", error_description: "url must be an absolute URL" },
        400,
      );
    }
    const state = await deps.state.getState();
    return json(
      await deliverWebhook({
        url,
        secret: body.badSignature
          ? "definitely-not-the-signing-secret"
          : state.webhookSigningSecret,
        payload: body.event ?? { event: "petshop.test", firedAt: new Date().toISOString() },
      }),
    );
  }
  if (key === "POST /__backdoor/apps") {
    // Register/replace a GitHub App installation's PUBLIC key — how the OS e2e
    // installs the key matching the private key it signs App JWTs with. The
    // private key never comes near petshop.
    const body = await readJson(request);
    if (typeof body.publicKeyPem !== "string" || body.publicKeyPem.length === 0) {
      return json(
        {
          error: "invalid_request",
          error_description: "publicKeyPem (RS256 SPKI PEM) is required",
        },
        400,
      );
    }
    return json(
      await deps.state.registerApp({
        appId: typeof body.appId === "string" ? body.appId : undefined,
        installationId: typeof body.installationId === "string" ? body.installationId : undefined,
        publicKeyPem: body.publicKeyPem,
        webhookSecret: typeof body.webhookSecret === "string" ? body.webhookSecret : undefined,
      }),
      201,
    );
  }
  if (key === "POST /__backdoor/apps/fire-webhook") {
    // The App-webhook analogue of /__backdoor/webhooks/fire, scoped to an
    // installation + its webhookSecret and signed GitHub-style
    // (x-hub-signature-256). With a `url` it delivers; without one it just
    // returns the signed body ("echo"), so signature specs need no receiver.
    const body = await readJson(request);
    const installationId =
      typeof body.installationId === "string" ? body.installationId : DEFAULT_INSTALLATION_ID;
    const app = (await deps.state.getState()).apps[installationId];
    if (!app) {
      return json(
        {
          error: "invalid_request",
          error_description: `unknown installationId ${JSON.stringify(installationId)} — register one via POST /__backdoor/apps`,
        },
        400,
      );
    }
    const secret = body.badSignature ? "definitely-not-the-webhook-secret" : app.webhookSecret;
    const payload = body.event ?? {
      event: "installation.ping",
      installationId,
      firedAt: new Date().toISOString(),
    };
    const url = typeof body.url === "string" ? body.url : "";
    if (!url) {
      const bodyText = JSON.stringify(payload);
      return json({
        installationId,
        url: null,
        status: 0,
        signature: `sha256=${await hmacSha256Hex(secret, bodyText)}`,
        payload: bodyText,
      });
    }
    if (!URL.canParse(url)) {
      return json(
        { error: "invalid_request", error_description: "url must be an absolute URL" },
        400,
      );
    }
    return json({
      installationId,
      ...(await deliverWebhook({
        url,
        secret,
        payload,
        signatureHeader: "x-hub-signature-256",
      })),
    });
  }
  return json({ error: "not_found" }, 404);
}

/** The gateway's validation deps, projected from the request deps: the sealing
 * key and a per-call read of the token client's CURRENT revocation epoch. */
function gatewayDeps(deps: PetshopDeps): GatewayDeps {
  return {
    sealKey: deps.sealKey,
    getAccessTokenEpoch: (clientId) =>
      deps.state.getState().then((state) => accessTokenEpochFor(state, clientId)),
  };
}

/** Send a reaction's frames in order, then close if it asked to. */
function applyReaction(
  server: WebSocket,
  reaction: { send: string[]; close?: { code: number; reason: string } },
): void {
  for (const frame of reaction.send) server.send(frame);
  if (reaction.close) server.close(reaction.close.code, reaction.close.reason);
}

/**
 * Wire the per-frame ECHO loop: once a connection is identified (by IDENTIFY
 * frame or a valid upgrade), every further frame runs through
 * `handleGatewayMessage`, which echoes it. The frame shape does its IDENTIFY
 * here (the connection starts un-identified); the header/subprotocol shapes
 * attach this only AFTER a successful upgrade auth, so it only ever echoes for
 * them — a failed upgrade gets no loop at all (upgrade auth is those shapes'
 * only auth). Any per-frame failure closes with the auth-failed code.
 */
function attachGatewayEchoLoop(
  server: WebSocket,
  connection: GatewayConnectionState,
  deps: PetshopDeps,
): void {
  server.addEventListener("message", (event) => {
    // Node/tests may hand us a string; a real client can also send binary.
    const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    void handleGatewayMessage(connection, raw, gatewayDeps(deps))
      .then((reaction) => applyReaction(server, reaction))
      .catch(() => server.close(4001, "authentication failed"));
  });
}

/**
 * The Discord-style gateway (integrations-and-secrets-design.md §R2, §9 D6):
 * accept a WebSocket, greet with a hello frame, and run the protocol through
 * `handleGatewayMessage` — the credential rides *inside* the IDENTIFY frame, so
 * authentication happens on the first client frame, not at the upgrade. On the
 * OS side a secret worker holds the token (SECRET.read()) and sends the frame.
 */
async function gatewayUpgrade(request: Request, deps: PetshopDeps): Promise<Response> {
  const guard = requireWebsocketUpgrade(request, "/gateway");
  if (guard) return guard;

  const [client, server] = websocketPair();
  const connection = newGatewayConnection();
  server.send(helloFrame());
  attachGatewayEchoLoop(server, connection, deps);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * The OpenAI-Realtime-style gateway (§9 D6): the sealed access token rides in
 * the `Authorization: Bearer` UPGRADE header. On the OS side that header is a
 * `getSecret(...)` placeholder substituted at the jailed outbound before the
 * dial, so the worker never holds the token. Auth happens at the handshake:
 * a valid token opens an already-identified socket that then echoes frames.
 */
async function gatewayHeaderUpgrade(request: Request, deps: PetshopDeps): Promise<Response> {
  const guard = requireWebsocketUpgrade(request, "/gateway-header");
  if (guard) return guard;

  const [client, server] = websocketPair();
  server.send(helloFrame());
  const token = bearerTokenFromHeader(request.headers.get("authorization"));
  const auth = await handleUpgradeAuth(token, gatewayDeps(deps));
  applyReaction(server, auth);
  // Upgrade auth is this shape's ONLY auth: on failure the socket is closing,
  // and attaching no loop keeps a racing IDENTIFY frame from authing instead.
  if (auth.identified) attachGatewayEchoLoop(server, { identified: true }, deps);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * The browser-WS-style gateway (§9 D6): the token is smuggled in
 * `Sec-WebSocket-Protocol` as `petshop.access-token.<token>` (browsers cannot
 * set arbitrary headers). We extract + validate it at the handshake and echo
 * back the REAL selected subprotocol (never the token carrier) in the 101, per
 * the WebSocket spec. On the OS side the carrier value is a `getSecret(...)`
 * placeholder substituted at the jailed outbound.
 */
async function gatewaySubprotocolUpgrade(request: Request, deps: PetshopDeps): Promise<Response> {
  const guard = requireWebsocketUpgrade(request, "/gateway-subprotocol");
  if (guard) return guard;

  const { token, selected } = subprotocolAuth(request.headers.get("sec-websocket-protocol"));
  const [client, server] = websocketPair();
  server.send(helloFrame());
  const auth = await handleUpgradeAuth(token, gatewayDeps(deps));
  applyReaction(server, auth);
  // Upgrade auth is this shape's ONLY auth: on failure the socket is closing,
  // and attaching no loop keeps a racing IDENTIFY frame from authing instead.
  if (auth.identified) attachGatewayEchoLoop(server, { identified: true }, deps);
  // The selected subprotocol must be echoed in the 101 handshake response (RFC
  // 6455 §4.2.2). It is a real protocol, never the credential carrier.
  return new Response(null, {
    status: 101,
    webSocket: client,
    ...(selected === null ? {} : { headers: { "sec-websocket-protocol": selected } }),
  });
}

/** The 426 guard every gateway shares: a plain (non-Upgrade) request is not a
 * socket. Returns the error response, or null when the request is an upgrade. */
function requireWebsocketUpgrade(request: Request, path: string): Response | null {
  if (request.headers.get("Upgrade") === "websocket") return null;
  return json({ error: "upgrade_required", error_description: `GET ${path} is a websocket` }, 426);
}

/** Construct a WebSocketPair as `[client, server]` with the server end accepted. */
function websocketPair(): [WebSocket, WebSocket] {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  return [client, server];
}

export async function handlePetshopRequest(request: Request, deps: PetshopDeps): Promise<Response> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;

  if (key === "GET /") {
    return new Response(INDEX, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  // MCP OAuth discovery documents (served unauthenticated, by spec).
  if (
    key === "GET /.well-known/oauth-protected-resource" ||
    key === "GET /.well-known/oauth-protected-resource/mcp"
  ) {
    return json(protectedResourceMetadata(url.origin));
  }
  if (key === "GET /.well-known/oauth-authorization-server") {
    return json(authorizationServerMetadata(url.origin));
  }
  if (key === "POST /oauth/register") return registerOAuthClient(request, deps);
  if (key === "GET /oauth/authorize") {
    const params = {
      clientId: url.searchParams.get("client_id") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      state: url.searchParams.get("state") ?? "",
      codeChallenge: url.searchParams.get("code_challenge") ?? "",
    };
    const rejection = await authorizeRejection(deps, params.clientId, params.redirectUri);
    if (rejection) return rejection;
    // The consent-free lane: specs and agents append &approve=1 instead of
    // scripting a form submit; browsers land on the consent page.
    if (url.searchParams.get("approve") === "1") {
      return mintCodeRedirect({ ...params, user: url.searchParams.get("user") ?? "" }, deps);
    }
    return new Response(consentPage(params), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (key === "POST /oauth/authorize") {
    const form = await request.formData();
    const params = {
      clientId: String(form.get("client_id") ?? ""),
      redirectUri: String(form.get("redirect_uri") ?? ""),
      state: String(form.get("state") ?? ""),
      user: String(form.get("user") ?? ""),
      codeChallenge: String(form.get("code_challenge") ?? ""),
    };
    const rejection = await authorizeRejection(deps, params.clientId, params.redirectUri);
    return rejection ?? (await mintCodeRedirect(params, deps));
  }
  if (key === "POST /oauth/token") return tokenEndpoint(request, deps);
  // GitHub-App installation-token minting: the installationId is a path segment,
  // so this is matched by shape rather than the exact-key table (§9 P4).
  if (request.method === "POST") {
    const match = url.pathname.match(/^\/app\/installations\/([^/]+)\/access_tokens$/);
    if (match) {
      return appInstallationAccessToken(decodeURIComponent(match[1]), request, deps);
    }
  }
  if (key === "POST /api/legacy-login") return legacyLogin(request, deps);
  // The GraphQL session-login door (graphql-login.ts): one more way to
  // authenticate against the same pets API.
  if (key === "POST /graphql") {
    return handleGraphqlLogin(request, {
      sealKey: deps.sealKey,
      getAccessTokenEpoch: () =>
        deps.state.getState().then((state) => accessTokenEpochFor(state, "graphql-session-login")),
    });
  }
  if (key === "GET /api/me" || key === "GET /api/pets") {
    const grant = await accessGrant(request, deps);
    if (!grant) return json({ error: "invalid_token" }, 401);
    if (key === "GET /api/me") {
      return json({
        sub: grant.sub,
        clientId: grant.clientId,
        tokenExpiresInSeconds: grant.exp - nowSeconds(),
        // An installation token names which GitHub-App installation it acts as,
        // so the OS side can assert it minted the token it expected (§9 P4).
        ...(grant.t === "installation"
          ? { installationId: grant.installationId, appId: grant.appId }
          : {}),
      });
    }
    return json({ owner: grant.sub, pets: deps.pets });
  }
  // The typed surfaces — oRPC (/rpc), the REST-shaped OpenAPI handler
  // (/api/v2), and MCP (/mcp) — all share the shop's OAuth bearer check and
  // the same in-memory pet catalogue.
  if (key === "GET /openapi.json") {
    if (!(await accessGrant(request, deps))) return json({ error: "invalid_token" }, 401);
    return json(await petshopOpenApiDocument(url.origin));
  }
  if (url.pathname.startsWith("/rpc") || url.pathname.startsWith("/api/v2")) {
    const grant = await accessGrant(request, deps);
    if (!grant) return json({ error: "invalid_token" }, 401);
    const response = await handlePetsRpcRequest(
      request,
      { owner: grant.sub, pets: deps.pets },
      url.pathname.startsWith("/rpc") ? "rpc" : "openapi",
    );
    return response ?? json({ error: "not_found" }, 404);
  }
  if (url.pathname === "/mcp") {
    const grant = await accessGrant(request, deps);
    if (!grant) {
      // Point an unauthorized MCP client at its protected-resource metadata
      // (RFC 9728 §5.1) so it can discover this origin's OAuth endpoints.
      return json({ error: "invalid_token" }, 401, {
        "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    return handleMcpRequest(request, { owner: grant.sub, pets: deps.pets });
  }
  // The WebSocket gateways (§9 D6). Three shapes, same sealed access token,
  // presented three ways — the OS side proves it can inject the credential into
  // each: a frame (/gateway), the Authorization upgrade header (/gateway-header),
  // and the Sec-WebSocket-Protocol upgrade header (/gateway-subprotocol).
  if (key === "GET /gateway") return gatewayUpgrade(request, deps);
  if (key === "GET /gateway-header") return gatewayHeaderUpgrade(request, deps);
  if (key === "GET /gateway-subprotocol") return gatewaySubprotocolUpgrade(request, deps);
  if (url.pathname.startsWith("/__backdoor/")) return backdoor(key, request, deps);
  return json({ error: "not_found" }, 404);
}

// Seeded ONCE per isolate (not per request) so createPet / create_pet
// mutations persist for the isolate's lifetime rather than resetting on the
// next fetch. Still not durable across isolates — a deliberately simple demo
// catalogue for a test fixture; the durable, backdoor-controlled state lives
// in the Durable Object.
const petCatalogue = seedPets();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handlePetshopRequest(request, {
      state: env.PETSHOP_STATE.get(env.PETSHOP_STATE.idFromName("global")),
      sealKey: env.PETSHOP_SEAL_KEY,
      backdoorSecret: env.PETSHOP_BACKDOOR_SECRET,
      pets: petCatalogue,
    });
    if (request.method !== "GET" || new URL(request.url).pathname !== "/") return response;

    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-iterate-worker-version", env.CF_VERSION_METADATA.id);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  },
};
