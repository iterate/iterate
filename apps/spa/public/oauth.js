// oauth.js — the OAuth dance a static page runs by itself, no server of its own: discovery, a
// one-time public-client registration (the id kept in localStorage, per issuer), PKCE (S256), the
// callback, refresh. Tokens live in sessionStorage — this tab, until it closes — and the access
// token is short-lived (the issuer renews an interactive grant's token hourly), so a leak is bounded.

const PENDING = "iterate-spa:pending";
const SESSION = "iterate-spa:session";

export async function discover(issuer) {
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
  if (!response.ok) throw new Error(`${issuer} is not an OAuth issuer (${response.status})`);
  return response.json();
}

/** Where the issuer sends the browser back: this page, exactly. */
export function redirectUri() {
  return new URL(location.pathname, location.origin).href;
}

/** A public client (no secret) registered once per issuer, dynamically — RFC 7591. */
async function clientIdFor(issuer, metadata) {
  const key = `iterate-spa:client:${issuer}`;
  const cached = localStorage.getItem(key);
  if (cached) return cached;
  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Iterate static SPA",
      redirect_uris: [redirectUri()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!response.ok) throw new Error(`Client registration failed (${response.status})`);
  const { client_id } = await response.json();
  localStorage.setItem(key, client_id);
  return client_id;
}

const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** Leave for the issuer's consent page; `finishLogin` picks the flow up when it sends us back. */
export async function beginLogin(issuer) {
  const metadata = await discover(issuer);
  const clientId = await clientIdFor(issuer, metadata);
  const verifier = random();
  const state = random();
  sessionStorage.setItem(PENDING, JSON.stringify({ issuer, clientId, verifier, state }));
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
  });
  location.assign(url);
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

function store(issuer, clientId, tokens) {
  const session = {
    issuer,
    clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  sessionStorage.setItem(SESSION, JSON.stringify(session));
  return session;
}

/** The callback half: `?code=&state=` on this page means the issuer sent us back. */
export async function finishLogin() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return null;
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || "null");
  sessionStorage.removeItem(PENDING);
  if (!pending || params.get("state") !== pending.state)
    throw new Error("The OAuth state did not match — start the sign-in again.");
  const metadata = await discover(pending.issuer);
  const tokens = await tokenRequest(metadata.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: pending.clientId,
    code_verifier: pending.verifier,
    resource: `${pending.issuer}/api`,
  });
  history.replaceState(null, "", redirectUri());
  return store(pending.issuer, pending.clientId, tokens);
}

export function currentSession() {
  return JSON.parse(sessionStorage.getItem(SESSION) || "null");
}

/** The access token, refreshed through the refresh token when it is about to expire. */
export async function freshAccessToken(session) {
  if (Date.now() < session.expiresAt - 30_000) return session.accessToken;
  const metadata = await discover(session.issuer);
  const tokens = await tokenRequest(metadata.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
    resource: `${session.issuer}/api`,
  });
  return store(session.issuer, session.clientId, tokens).accessToken;
}

export function logout() {
  sessionStorage.removeItem(SESSION);
}
