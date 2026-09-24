// e2e/support/petshop.ts — the deployed dummy-petshop (apps/dummy-petshop), the fake third party the
// secret-cell proofs connect to over plain HTTP: an OAuth 2.0 provider with refresh, a GraphQL
// session-login endpoint speaking the Waitrose wire shape, one bearer-protected pets API, GitHub-App
// style signed webhooks, and a `/__backdoor` console to force expiry, fail the token endpoint and
// fire webhooks. The worker under test fetches it directly (the local worker over the real network,
// the deployed worker from the edge); nothing here proxies for it.

/** The deployed fixture (apps/dummy-petshop) — `PETSHOP_BASE_URL` picks another. */
export const petshopBaseUrl = (): string =>
  (process.env.PETSHOP_BASE_URL?.trim() || "https://dummy-petshop.iterate.workers.dev").replace(
    /\/$/,
    "",
  );

/** A live bearer for `email` at the shop's pets API — a legacy-login token (120 s TTL), so mint one
 *  per test that needs it. */
export async function petshopLegacyBearer(email: string): Promise<string> {
  const response = await fetch(`${petshopBaseUrl()}/api/legacy-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse" }),
  });
  if (!response.ok)
    throw new Error(`pet shop legacy-login answered ${response.status} at ${petshopBaseUrl()}`);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

const backdoorHeaders = (): Record<string, string> => {
  const secret = process.env.PETSHOP_BACKDOOR_SECRET?.trim();
  return secret ? { "x-petshop-backdoor": secret } : {};
};

async function petshopJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${petshopBaseUrl()}${path}`, init);
  if (!response.ok)
    throw new Error(`petshop ${path} -> ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** A fresh OAuth client of its own, so forcing ITS tokens to expire touches no other test. */
export const petshopMintClient = (): Promise<{ clientId: string; clientSecret: string }> =>
  petshopJson("/__backdoor/clients", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: "{}",
  });

/** Bump one client's epoch — every outstanding access token of it answers 401 from now on: the
 *  deterministic way to force a real 401 → refresh. The GraphQL login endpoint is the client
 *  `graphql-session-login`. */
export const petshopExpireTokens = (
  clientId: string,
): Promise<{ clientId: string; accessTokenEpoch: number }> =>
  petshopJson("/__backdoor/expire-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify({ clientId }),
  });

/** Revoke ONE account's GraphQL-login sessions — the shop's per-account epoch
 *  (apps/dummy-petshop/src/graphql-login.ts `graphqlSessionAccountClientId`). The shop serves every
 *  concurrent CI run, so a test forcing a 401 revokes its own account's sessions, never the endpoint's:
 *  an endpoint-wide bump from one run killed the session another run had just minted. */
export const petshopExpireGraphqlSessions = (
  username: string,
): Promise<{ clientId: string; accessTokenEpoch: number }> =>
  petshopExpireTokens(`graphql-session-login:${username}`);

/** A PUBLIC client, dynamically registered (RFC 7591) with one redirect URI — no secret, PKCE
 *  alone at the code exchange, `client_id` in the body on refresh: the MCP-client shape. The
 *  provider then accepts only that redirect URI for it. */
export const petshopRegisterPublicClient = (redirectUri: string): Promise<{ clientId: string }> =>
  petshopJson<{ client_id: string }>("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "os e2e",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }).then((registered) => ({ clientId: registered.client_id }));

/** The provider failing: the next `times` token-endpoint calls for this client answer 500. */
export const petshopFailTokenEndpoint = (
  clientId: string,
  times: number,
): Promise<{ clientId: string; tokenEndpointFailuresRemaining: number }> =>
  petshopJson("/__backdoor/fail-token-endpoint", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify({ clientId, times }),
  });

/** A GitHub App installation of the caller's own, so its webhook secret is the caller's alone. The
 *  shop requires a public key for its App JWT auth; the webhook rows never sign a JWT, so any PEM
 *  string stands. */
export const petshopRegisterApp = (input: {
  installationId: string;
  webhookSecret: string;
}): Promise<unknown> =>
  petshopJson("/__backdoor/apps", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify({ ...input, publicKeyPem: "unused by the webhook rows" }),
  });

/** The shop POSTs `event` to `url` as that installation's webhook, signed the way GitHub signs
 *  (`x-hub-signature-256: sha256=<hex HMAC of the body>`); `badSignature` signs with another key.
 *  Answers the delivery: the receiver's status, 0 with `error` when the POST itself failed. */
export const petshopFireAppWebhook = (input: {
  installationId: string;
  url: string;
  event: unknown;
  badSignature?: boolean;
}): Promise<{ status: number; error?: string }> =>
  petshopJson("/__backdoor/apps/fire-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify(input),
  });

/** Revoke one refresh token at the provider — the next refresh grant with it is `invalid_grant`. */
export const petshopRevokeRefreshToken = (refreshToken: string): Promise<unknown> =>
  petshopJson("/__backdoor/revoke-refresh-token", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify({ refreshToken }),
  });

/** RFC 8414 discovery: the authorization server's metadata, where a connect flow learns the token
 *  endpoint it will later configure as the secret's refresh strategy. */
export const petshopAuthorizationServer = (): Promise<{
  token_endpoint: string;
  authorization_endpoint: string;
}> => petshopJson("/.well-known/oauth-authorization-server");

/** The connect half a trusted party runs ONCE: the consent-free authorize (`approve=1`, the test
 *  shortcut) → the code → the token exchange with HTTP Basic client auth. What lands in the secret. */
export async function petshopConnect(client: {
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const redirectUri = "https://project.example/callback";
  const authorize = new URL(`${petshopBaseUrl()}/oauth/authorize`);
  authorize.searchParams.set("client_id", client.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", "e2e");
  authorize.searchParams.set("approve", "1");
  const redirected = await fetch(authorize, { redirect: "manual" });
  const location = redirected.headers.get("location");
  if (!location) throw new Error(`petshop authorize did not redirect (${redirected.status})`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`petshop authorize redirect had no code: ${location}`);
  const response = await fetch(`${petshopBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`petshop token exchange -> ${response.status}`);
  const tokens = (await response.json()) as { access_token: string; refresh_token: string };
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}
