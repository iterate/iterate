// OAuth against the iterate auth worker, phone edition.
//
// Ported near-verbatim from the voice-ios-app branch (PR #1605)
// apps/mobile/src/lib/auth.ts, where this flow was live-verified against
// auth.iterate-dev.com. Divergences: app scheme "iterate" (not
// "iterate-voice") and the registered client name. Reconcile mechanically
// when that branch merges.
//
// The flow mirrors what MCP clients already do against this deployment:
// discover the authorization server from the OS host's RFC 9728 protected-
// resource metadata, dynamically register a public client (RFC 7591 —
// registration is deliberately open), then authorization-code + PKCE in an
// in-app browser. The access token carries iterate's org/project claims and
// is presented to `/api` as `{ type: "bearer", token }`.
//
// Refresh discipline: better-auth rotates the refresh token on every use and
// treats rotated-token reuse as theft — so refreshes are single-flighted and
// the new refresh token is persisted before the new access token is released
// to callers.

import * as AuthSession from "expo-auth-session";
import { clearStoredAuth, getStoredAuth, setStoredAuth } from "./storage.ts";

const SCOPES = ["openid", "profile", "email", "offline_access", "project"];
// In Expo Go this resolves to an exp:// deep link back into Expo Go; in a
// standalone/dev-client build it uses the app scheme below. Either way it's
// what gets dynamically registered, so the two stay consistent per-runtime.
const REDIRECT_URI = AuthSession.makeRedirectUri({
  scheme: "iterate",
  path: "oauth/callback",
});

/**
 * The RFC 8707 resource (token audience) for an OS deployment. Must exactly
 * match an entry in the auth worker's valid-audience list
 * (apps/auth/src/server/oauth-resources.ts) — for local dev servers on
 * arbitrary ports that's the stable portless loopback origin.
 */
export function osResource(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return `http://${url.hostname}`;
  }
  return url.origin;
}

export async function discoverIssuer(baseUrl: string): Promise<string> {
  try {
    const response = await fetch(
      new URL("/api/mcp/.well-known/oauth-protected-resource", baseUrl).toString(),
    );
    if (response.ok) {
      const metadata = (await response.json()) as { authorization_servers?: string[] };
      const issuer = metadata.authorization_servers?.[0];
      if (issuer) return issuer;
    }
  } catch {
    // fall through to the hostname convention
  }
  const url = new URL(baseUrl);
  if (!url.hostname.startsWith("os.")) {
    throw new Error(
      `Can't discover the auth server for ${baseUrl} — it didn't serve protected-resource metadata and its hostname doesn't follow the os.* convention.`,
    );
  }
  return `https://${url.hostname.replace(/^os\./, "auth.")}/api/auth`;
}

type OidcConfig = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};

async function fetchOidcConfig(issuer: string): Promise<OidcConfig> {
  const response = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${response.status}`);
  return (await response.json()) as OidcConfig;
}

async function registerClient(config: OidcConfig): Promise<string> {
  const response = await fetch(config.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Iterate (iOS)",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth client registration failed: ${await response.text()}`);
  }
  const registered = (await response.json()) as { client_id: string };
  return registered.client_id;
}

/**
 * Interactive sign-in: opens the system in-app browser, runs the code+PKCE
 * flow (including the auth worker's project-selection page), and persists the
 * resulting refresh token. Returns once tokens are live.
 */
export async function signIn(baseUrl: string): Promise<void> {
  const issuer = await discoverIssuer(baseUrl);
  const config = await fetchOidcConfig(issuer);
  const clientId = await registerClient(config);
  const resource = osResource(baseUrl);

  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    usePKCE: true,
    extraParams: { resource },
  });
  const result = await request.promptAsync({
    authorizationEndpoint: config.authorization_endpoint,
  });
  if (result.type !== "success") {
    throw new Error(result.type === "error" ? String(result.error) : `sign-in ${result.type}`);
  }

  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri: REDIRECT_URI,
      extraParams: { code_verifier: request.codeVerifier || "", resource },
    },
    { tokenEndpoint: config.token_endpoint },
  );
  if (!tokens.refreshToken) {
    throw new Error("The auth server didn't return a refresh token (offline_access missing?).");
  }

  await setStoredAuth(baseUrl, { issuer, clientId, refreshToken: tokens.refreshToken });
  cacheAccessToken(baseUrl, tokens.accessToken, tokens.expiresIn || 60);
}

export async function hasSignIn(baseUrl: string): Promise<boolean> {
  return (await getStoredAuth(baseUrl)) !== null;
}

export async function signOut(baseUrl: string): Promise<void> {
  await clearStoredAuth(baseUrl);
  accessTokens.delete(baseUrl);
  refreshInFlight.delete(baseUrl);
}

// ---------------------------------------------------------------------------
// Access tokens: in-memory cache + single-flight, rotation-safe refresh.
// ---------------------------------------------------------------------------

const EXPIRY_BUFFER_MS = 60_000;
const accessTokens = new Map<string, { token: string; expiresAt: number }>();
const refreshInFlight = new Map<string, Promise<string>>();

function cacheAccessToken(baseUrl: string, token: string, expiresInSeconds: number) {
  accessTokens.set(baseUrl, { token, expiresAt: Date.now() + expiresInSeconds * 1000 });
}

/**
 * A live access token, refreshing proactively when the cached one is inside
 * the expiry buffer. Throws `SignInRequiredError` when there's nothing to
 * refresh with — the caller should route to the sign-in screen.
 */
export async function getAccessToken(
  baseUrl: string,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const cached = accessTokens.get(baseUrl);
  if (!options.forceRefresh && cached && cached.expiresAt - Date.now() > EXPIRY_BUFFER_MS) {
    return cached.token;
  }

  const inFlight = refreshInFlight.get(baseUrl);
  if (inFlight) return inFlight;

  const refresh = (async () => {
    const stored = await getStoredAuth(baseUrl);
    if (!stored) throw new SignInRequiredError("Not signed in.");
    const config = await fetchOidcConfig(stored.issuer);
    const response = await fetch(config.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: stored.clientId,
        resource: osResource(baseUrl),
      }).toString(),
    });
    if (!response.ok) {
      // Revoked/expired/rotated-and-reused: this sign-in is dead. Clear it so
      // the UI drops to the login screen instead of retrying forever.
      await clearStoredAuth(baseUrl);
      accessTokens.delete(baseUrl);
      throw new SignInRequiredError(`Session expired (${response.status}). Sign in again.`);
    }
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    // Rotation safety: the new refresh token hits the keychain BEFORE the new
    // access token is released — a crash between the two costs one refresh,
    // not the whole session.
    if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
      await setStoredAuth(baseUrl, { ...stored, refreshToken: tokens.refresh_token });
    }
    cacheAccessToken(baseUrl, tokens.access_token, tokens.expires_in || 60);
    return tokens.access_token;
  })().finally(() => refreshInFlight.delete(baseUrl));

  refreshInFlight.set(baseUrl, refresh);
  return refresh;
}

export class SignInRequiredError extends Error {}
