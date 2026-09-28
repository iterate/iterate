// oauth.js — THE OAUTH CLIENT of a page with no server of its own, one file for the static SPA
// (which serves it as written) and the Chrome extension (whose build copies it into its dist/):
// discovery, a public-client registration at each sign-in (RFC 7591), PKCE (S256), the callback,
// and refresh through the rotating refresh token, for the scope `iterate` and the resource
// `<issuer>/api`. The client id lives in the sign-in in flight and then in the session, nowhere
// else. Its host says where things are kept and how the browser gets to the issuer and back:
//   - `sessions` keeps the sign-in in flight and the session (the SPA: this tab's sessionStorage;
//     the extension: chrome.storage.local, until sign-out);
//   - `redirectUri` is where the issuer sends the browser back, and `launch(url)` opens the
//     issuer's authorization URL and resolves with the URL it came back to (Chrome's identity
//     window). A page that navigates to the issuer never resolves: it is loaded again at
//     `redirectUri` and hands that URL to `finishSignIn` itself.
// The access token is short-lived (the issuer renews an interactive grant's token hourly), so a
// leak is bounded.

const PENDING = "oauth:pending";
const SESSION = "oauth:session";

/** A Web Storage area (localStorage, sessionStorage) as a store: JSON values by key. */
export const webStore = (storage) => ({
  get: async (key) => JSON.parse(storage.getItem(key) || "null"),
  set: async (key, value) => storage.setItem(key, JSON.stringify(value)),
  remove: async (key) => storage.removeItem(key),
});

const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function discover(issuer) {
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
  if (!response.ok) throw new Error(`${issuer} is not an OAuth issuer (${response.status})`);
  return response.json();
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

/** The client: `registration` is what the issuer's consent page shows of it (`client_name`,
 *  `client_uri`, `logo_uri`). */
export function oauthClient({ sessions, redirectUri, launch, registration }) {
  /** A public client (no secret), registered for this sign-in. */
  async function register(metadata) {
    const response = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...registration,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    if (!response.ok) throw new Error(`Client registration failed (${response.status})`);
    const { client_id } = await response.json();
    return client_id;
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
    await sessions.set(SESSION, session);
    return session;
  }

  /** The callback half: the URL the issuer sent the browser back to, `?code=&state=` or
   *  `?error=`. Resolves with the stored session. */
  async function finishSignIn(callback) {
    const pending = await sessions.get(PENDING);
    await sessions.remove(PENDING);
    const params = new URL(callback).searchParams;
    const oauthError = params.get("error");
    if (oauthError) throw new Error(params.get("error_description") || oauthError);
    if (!pending || params.get("state") !== pending.state)
      throw new Error("The OAuth state did not match — start the sign-in again.");
    const code = params.get("code");
    if (!code) throw new Error("The issuer sent the browser back without an authorization code.");
    const metadata = await discover(pending.issuer);
    const tokens = await tokenRequest(metadata.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      resource: `${pending.issuer}/api`,
    });
    return store(pending.issuer, pending.clientId, tokens);
  }

  return {
    /** Sign in at `issuer`: its own login and consent pages, through `launch`. Resolves with the
     *  stored session once `launch` does. */
    async signIn(issuer) {
      const metadata = await discover(issuer);
      const clientId = await register(metadata);
      const verifier = random();
      const state = random();
      await sessions.set(PENDING, { issuer, clientId, verifier, state });
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: base64url(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
        ),
        code_challenge_method: "S256",
        scope: "iterate",
        state,
        resource: `${issuer}/api`,
      }).toString();
      // A closed identity window leaves no verifier behind.
      const callback = await launch(url.href).catch(async (error) => {
        await sessions.remove(PENDING);
        throw error;
      });
      return finishSignIn(callback);
    },
    finishSignIn,
    /** The stored session, or null — read fresh each time: a refresh rotates the token in it. */
    session: async () => (await sessions.get(SESSION)) || null,
    /** The access token, refreshed through the refresh token when it is about to expire. */
    async freshAccessToken() {
      const session = await sessions.get(SESSION);
      if (!session) throw new Error("Not signed in.");
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
      return (await store(session.issuer, session.clientId, tokens, session.refreshToken))
        .accessToken;
    },
    signOut: () => sessions.remove(SESSION),
  };
}
