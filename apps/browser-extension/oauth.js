// oauth.js — the OAuth dance the side panel runs by itself, after apps/spa/public/oauth.js:
// discovery, a one-time public-client registration per issuer (RFC 7591), PKCE (S256) through
// Chrome's identity window, refresh. Tokens live in chrome.storage.local — this extension, until it
// signs out; the access token is short-lived (the issuer renews an interactive grant's token hourly).

async function discover(issuer) {
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
  if (!response.ok) throw new Error(`${issuer} is not an OAuth issuer (${response.status})`);
  return response.json();
}

/** Where the issuer sends Chrome back: this extension's identity callback
 *  (`https://<extension id>.chromiumapp.org/`). The manifest's `key` keeps the id, and so this URL,
 *  the same on every install. */
const redirectUri = () => chrome.identity.getRedirectURL();

/** A public client (no secret) registered once per issuer, dynamically — RFC 7591. */
async function clientIdFor(issuer, metadata) {
  const key = `client:${issuer}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) return cached;
  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Iterate Chrome extension",
      redirect_uris: [redirectUri()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!response.ok) throw new Error(`Client registration failed (${response.status})`);
  const { client_id } = await response.json();
  await chrome.storage.local.set({ [key]: client_id });
  return client_id;
}

const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** Sign in at `issuer` in Chrome's identity window (the issuer's own login and consent pages, which
 *  share the profile's cookies), then exchange the code. Resolves with the stored session. */
export async function signIn(issuer) {
  const metadata = await discover(issuer);
  const clientId = await clientIdFor(issuer, metadata);
  const verifier = random();
  const state = random();
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri(),
    code_challenge: base64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    ),
    code_challenge_method: "S256",
    scope: "iterate",
    state,
    resource: `${issuer}/api`,
  }).toString();
  const callback = await chrome.identity.launchWebAuthFlow({ interactive: true, url: url.href });
  if (!callback) throw new Error("The sign-in window closed before the issuer sent Chrome back.");
  const params = new URL(callback).searchParams;
  const oauthError = params.get("error");
  if (oauthError) throw new Error(params.get("error_description") || oauthError);
  if (params.get("state") !== state)
    throw new Error("The OAuth state did not match — start the sign-in again.");
  const code = params.get("code");
  if (!code) throw new Error("The issuer sent Chrome back without an authorization code.");
  const tokens = await tokenRequest(metadata.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: verifier,
    resource: `${issuer}/api`,
  });
  return store(issuer, clientId, tokens);
}

async function tokenRequest(endpoint, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok)
    throw new Error(`The token endpoint answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function store(issuer, clientId, tokens, previousRefreshToken) {
  const session = {
    issuer,
    clientId,
    accessToken: tokens.access_token,
    // Refresh tokens rotate: the newest one wins, the previous one stands in when none came.
    refreshToken: tokens.refresh_token || previousRefreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  await chrome.storage.local.set({ session });
  return session;
}

export async function currentSession() {
  const { session } = await chrome.storage.local.get("session");
  return session && session.accessToken ? session : null;
}

/** The access token, refreshed through the refresh token when it is about to expire. */
export async function freshAccessToken(session) {
  if (Date.now() < session.expiresAt - 30_000) return session.accessToken;
  if (!session.refreshToken)
    throw new Error("The access token expired and the grant cannot refresh. Sign in again.");
  const metadata = await discover(session.issuer);
  const tokens = await tokenRequest(metadata.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
    resource: `${session.issuer}/api`,
  });
  const refreshed = await store(session.issuer, session.clientId, tokens, session.refreshToken);
  return refreshed.accessToken;
}

export async function signOut() {
  await chrome.storage.local.remove("session");
}
