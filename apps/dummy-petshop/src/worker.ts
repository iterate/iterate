/**
 * dummy-petshop — a deliberately fake third-party service ("the pet shop")
 * for exercising Iterate's integrations & secrets system end to end
 * (apps/os/docs/integrations-and-secrets-design.md §7 S0, "Petshop ×2" §3):
 * an OAuth 2.0 provider with Basic client auth at the token endpoint and
 * short-TTL sealed tokens, a Waitrose-shaped legacy email+password login,
 * a small bearer-protected API, HMAC-signed outbound webhooks, and a test
 * backdoor. GET / documents the whole surface.
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
import { hmacSha256Hex, nowSeconds, seal, unseal } from "./seal.ts";
import {
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_APP_ID,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_INSTALLATION_ID,
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
}

/** Sealed access token; `epoch` must still equal the state's accessTokenEpoch. */
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

  GET  /oauth/authorize     ?client_id&redirect_uri&state — consent page; add &approve=1[&user=x] to skip it (test lane)
  POST /oauth/authorize     consent form submit → 302 redirect_uri?code=…&state=…
  POST /oauth/token         grant_type=authorization_code | refresh_token; HTTP Basic client auth (RFC 6749 §2.3.1)
  POST /api/legacy-login    {email, password} → {accessToken, expiresInSeconds}; any email, password "correct-horse"
  GET  /api/me              bearer whoami: {sub, clientId, tokenExpiresInSeconds}; +{installationId, appId} for an installation token
  GET  /api/pets            the account's (entirely fictional) pets

  POST /app/installations/<installationId>/access_tokens
                            GitHub-App installation token — Authorization: Bearer <App JWT> (RS256 over header.payload, iss=appId, exp future) → {token, expires_at}; token works as a bearer on /api/*

  GET  /openapi.json        OpenAPI 3.1 doc for the typed pets API (listPets/getPet/createPet)
  POST /rpc/*               oRPC handler for the pets API (what an @orpc/client talks); bearer-protected
  GET|POST /api/v2/*        the same pets procedures served REST-shaped (per the OpenAPI doc)
  GET|POST /mcp             MCP server (streamable HTTP): tools list_pets, get_pet, create_pet; bearer-protected
  GET  /gateway               (websocket) — token in the first {op:identify, token} FRAME (Discord shape)
  GET  /gateway-header        (websocket) — token in the Authorization: Bearer UPGRADE header (OpenAI-Realtime shape)
  GET  /gateway-subprotocol   (websocket) — token in Sec-WebSocket-Protocol as "petshop.access-token.<token>" (browser-WS shape)

  GET  /__backdoor/state                   the whole mutable state, for spec assertions
  POST /__backdoor/clients                 {accessTokenTtlSeconds?} → mint {clientId, clientSecret}
  POST /__backdoor/expire-tokens           invalidate every outstanding access token (epoch bump)
  POST /__backdoor/revoke-refresh-token    {refreshToken} → that refresh token stops working
  POST /__backdoor/rotate-signing-secret   new webhook HMAC secret
  POST /__backdoor/fail-token-endpoint     {times} → next N POST /oauth/token calls return 500
  POST /__backdoor/webhooks/fire           {url, event?, badSignature?} → POST a signed webhook there now
  POST /__backdoor/apps                    {publicKeyPem, appId?, installationId?, webhookSecret?} → register/replace a GitHub-App installation (public key only)
  POST /__backdoor/apps/fire-webhook       {installationId?, url?, event?, badSignature?} → deliver (or, with no url, echo) a webhook signed x-hub-signature-256 with the app's webhookSecret

  Seeded client: ${DEFAULT_CLIENT_ID} / ${DEFAULT_CLIENT_SECRET} · access tokens live ${DEFAULT_ACCESS_TTL_SECONDS}s ·
  webhooks are signed x-petshop-signature-256: sha256=<hex hmac of the raw body> · the backdoor is open
  unless PETSHOP_BACKDOOR_SECRET is set, in which case send it as x-petshop-backdoor.

  Seeded GitHub App: ${DEFAULT_APP_ID} · installation ${DEFAULT_INSTALLATION_ID} (register its RS256 public key via POST /__backdoor/apps) ·
  installation tokens live ${INSTALLATION_TOKEN_TTL_SECONDS}s · App JWTs verify RS256 over header.payload and App webhooks sign x-hub-signature-256.
`;

function consentPage(params: { clientId: string; redirectUri: string; state: string }): string {
  const hidden = (
    [
      ["client_id", params.clientId],
      ["redirect_uri", params.redirectUri],
      ["state", params.state],
    ] as const
  )
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

/** The authorize-time validations: registered client_id, absolute redirect_uri. Null when acceptable. */
async function authorizeRejection(
  deps: PetshopDeps,
  clientId: string,
  redirectUri: string,
): Promise<Response | null> {
  const state = await deps.state.getState();
  if (!state.clients[clientId]) {
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
  return null;
}

async function mintCodeRedirect(
  params: { clientId: string; redirectUri: string; state: string; user: string },
  deps: PetshopDeps,
): Promise<Response> {
  const payload: CodePayload = {
    t: "code",
    jti: crypto.randomUUID(),
    sub: params.user.slice(0, 64) || "Demo User",
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    exp: nowSeconds() + CODE_TTL_SECONDS,
  };
  const target = new URL(params.redirectUri);
  target.searchParams.set("code", await seal(payload, deps.sealKey));
  if (params.state) target.searchParams.set("state", params.state);
  return Response.redirect(target.toString(), 302);
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
  if (await deps.state.consumeTokenEndpointFailure()) {
    return json(
      {
        error: "temporarily_unavailable",
        error_description: "backdoor-scheduled failure (POST /__backdoor/fail-token-endpoint)",
      },
      500,
    );
  }
  const credentials = basicClientCredentials(request);
  const state = await deps.state.getState();
  const client = credentials ? state.clients[credentials.clientId] : undefined;
  if (!credentials || !client || client.clientSecret !== credentials.clientSecret) {
    return json({ error: "invalid_client" }, 401, {
      "www-authenticate": 'Basic realm="dummy-petshop"',
    });
  }
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    const code = await unseal<CodePayload>(form.get("code") ?? "", deps.sealKey);
    if (!code || code.t !== "code" || code.clientId !== credentials.clientId) {
      return json({ error: "invalid_grant" }, 400);
    }
    if (code.exp < nowSeconds()) {
      return json({ error: "invalid_grant", error_description: "code expired" }, 400);
    }
    if (code.redirectUri !== (form.get("redirect_uri") ?? "")) {
      return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    // Single-use: a replayed code is rejected (RFC 6749 §4.1.2).
    if (!(await deps.state.consumeAuthorizationCode(code.jti))) {
      return json({ error: "invalid_grant", error_description: "code already used" }, 400);
    }
    // Re-read the epoch at issue time: the awaits above release the DO input
    // gate, so a concurrent expire-tokens could have bumped the epoch since the
    // snapshot — stamping the stale epoch would mint a token that 401s at once.
    return issueTokens({
      sub: code.sub,
      clientId: credentials.clientId,
      ttlSeconds: client.accessTokenTtlSeconds,
      epoch: (await deps.state.getState()).accessTokenEpoch,
      sealKey: deps.sealKey,
    });
  }
  if (grantType === "refresh_token") {
    const refresh = await unseal<RefreshPayload>(form.get("refresh_token") ?? "", deps.sealKey);
    if (!refresh || refresh.t !== "refresh" || refresh.clientId !== credentials.clientId) {
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
      clientId: credentials.clientId,
      ttlSeconds: client.accessTokenTtlSeconds,
      epoch: current.accessTokenEpoch,
      sealKey: deps.sealKey,
    });
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

/**
 * The Waitrose stand-in (design R8): email+password → short-TTL bearer
 * token, no refresh token — re-minting through this endpoint IS the refresh
 * path. Deterministic for e2e: any email, password "correct-horse".
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
    epoch: state.accessTokenEpoch,
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
    // Re-read the epoch at seal time (verifyAppJwt released the input gate) so a
    // concurrent expire-tokens can't make this token 401 immediately — same
    // freshness the OAuth token path has.
    epoch: (await deps.state.getState()).accessTokenEpoch,
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
  const grant = await unseal<Grant>(header.slice(7).trim(), deps.sealKey);
  if (!grant || (grant.t !== "access" && grant.t !== "installation")) return null;
  if (grant.exp < nowSeconds()) return null;
  if (grant.epoch !== (await deps.state.getState()).accessTokenEpoch) return null;
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
}): Promise<{ url: string; status: number; signature: string; payload: string }> {
  const body = JSON.stringify(input.payload);
  const signature = `sha256=${await hmacSha256Hex(input.secret, body)}`;
  const signatureHeader = input.signatureHeader ?? "x-petshop-signature-256";
  const response = await fetch(input.url, {
    method: "POST",
    headers: { "content-type": "application/json", [signatureHeader]: signature },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return { url: input.url, status: response?.status ?? 0, signature, payload: body };
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
    return json({ accessTokenEpoch: await deps.state.expireAccessTokens() });
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
    const times = (await readJson(request)).times;
    if (typeof times !== "number" || !Number.isInteger(times) || times < 0) {
      return json(
        { error: "invalid_request", error_description: "times must be a non-negative integer" },
        400,
      );
    }
    await deps.state.setTokenEndpointFailures(times);
    return json({ tokenEndpointFailuresRemaining: times });
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
 * key and a per-call read of the CURRENT access-token epoch (so a token revoked
 * between upgrade and auth is rejected, exactly like the HTTP routes). */
function gatewayDeps(deps: PetshopDeps): GatewayDeps {
  return {
    sealKey: deps.sealKey,
    getAccessTokenEpoch: () => deps.state.getState().then((s) => s.accessTokenEpoch),
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
 * Wire the per-frame ECHO loop shared by all three gateways: once a connection
 * is identified (by IDENTIFY frame or a valid upgrade), every further frame runs
 * through `handleGatewayMessage`, which echoes it. The frame shape also does its
 * IDENTIFY here (the connection starts un-identified); the header/subprotocol
 * shapes pass an already-identified connection, so this only ever echoes for
 * them. Any per-frame failure closes with the auth-failed code, never throws.
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
  attachGatewayEchoLoop(server, { identified: auth.identified }, deps);
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
  attachGatewayEchoLoop(server, { identified: auth.identified }, deps);
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
  if (key === "GET /oauth/authorize") {
    const params = {
      clientId: url.searchParams.get("client_id") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      state: url.searchParams.get("state") ?? "",
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
    if (!grant) return json({ error: "invalid_token" }, 401);
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
  fetch(request: Request, env: Env): Promise<Response> {
    return handlePetshopRequest(request, {
      state: env.PETSHOP_STATE.get(env.PETSHOP_STATE.idFromName("global")),
      sealKey: env.PETSHOP_SEAL_KEY,
      backdoorSecret: env.PETSHOP_BACKDOOR_SECRET,
      pets: petCatalogue,
    });
  },
};
