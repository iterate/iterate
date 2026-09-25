// e2e/support/petshop.ts — the deployed dummy-petshop (apps/dummy-petshop), the fake third party the
// secret-cell proofs connect to over plain HTTP: an OAuth 2.0 provider with refresh, a GraphQL
// session-login endpoint speaking the Waitrose wire shape, a Tesco-shaped two-step login (a CSRF
// token and its cookie, then the form), one bearer-protected pets API, GitHub-App
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

/** Revoke ONE account's Tesco-login tokens (apps/dummy-petshop/src/tesco-login.ts
 *  `tescoLoginClientId`): its tokens answer 401 from now on, no other run's. */
export const petshopExpireTescoTokens = (
  email: string,
): Promise<{ clientId: string; accessTokenEpoch: number }> =>
  petshopExpireTokens(`tesco-login:${email}`);

/** The Tesco-shaped two-step login at the shop as a secret's exchange code (`refresh: { kind:
 *  "worker", source }`): the form's CSRF token and the cookie that binds it, then the form, with the
 *  material's `email` and `password` → the material with a fresh `accessToken`. */
export const petshopTescoExchangeSource = (): string => `
export async function exchange(material, fetch) {
  const form = await fetch("${petshopBaseUrl()}/api/tesco/login");
  if (!form.ok) throw new Error("the login form answered " + form.status);
  const { csrf } = await form.json();
  const cookie = form.headers.get("set-cookie").split(";")[0];
  const response = await fetch("${petshopBaseUrl()}/api/tesco/login", {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ email: material.email, password: material.password, _csrf: csrf }),
  });
  if (!response.ok) throw new Error("the login answered " + response.status);
  const { access_token } = await response.json();
  return { ...material, accessToken: access_token };
}
`;

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

/** The shop's Slack fake (apps/dummy-petshop/src/slack.ts) POSTs `event` to `url` signed the way
 *  Slack signs (`x-slack-signature: v0=<hex HMAC of "v0:<ts>:<body>">` under `signingSecret`, or
 *  another key with `badSignature`). Answers the receiver's status and JSON body. */
export const petshopSlackFireWebhook = (input: {
  url: string;
  signingSecret: string;
  event: unknown;
  badSignature?: boolean;
}): Promise<{ status: number; body: unknown; error?: string }> =>
  petshopJson("/__backdoor/slack/fire-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify(input),
  });

/** What the Slack fake's `chat.postMessage` recorded for a workspace, oldest first. */
export const petshopSlackMessages = (
  teamId: string,
): Promise<{ messages: { channel: string; text: string }[] }> =>
  petshopJson(`/__backdoor/slack/messages?team=${encodeURIComponent(teamId)}`, {
    headers: backdoorHeaders(),
  });

/** Register a GitHub App installation with the shop's GitHub fake (apps/dummy-petshop/src/github.ts):
 *  the App's PUBLIC key (installation tokens are minted from an App JWT it verifies), its webhook
 *  secret, where the install redirects (the App's Callback URL), the organization it is on, and the
 *  user who administers it. */
export const petshopRegisterGithubInstallation = (input: {
  installationId: string;
  appId: string;
  appSlug: string;
  publicKeyPem: string;
  webhookSecret: string;
  callbackUrl: string;
  accountLogin: string;
  adminLogin: string;
}): Promise<{ installationId: string; appId: string }> =>
  petshopJson("/__backdoor/apps", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify({
      ...input,
      account: { login: input.accountLogin, type: "Organization" },
      users: [{ login: input.adminLogin, role: "admin" }],
    }),
  });

/** The shop's GitHub fake POSTs `event` to `url` as GitHub delivers a webhook: signed
 *  `x-hub-signature-256` with the installation's webhook secret (another key with `badSignature`),
 *  named by `x-github-delivery` and `x-github-event`. Answers the receiver's status and JSON body. */
export const petshopGithubFireWebhook = (input: {
  installationId: string;
  url: string;
  event: unknown;
  deliveryId?: string;
  eventName?: string;
  badSignature?: boolean;
}): Promise<{ status: number; body: unknown; error?: string }> =>
  petshopJson("/__backdoor/apps/fire-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify(input),
  });

/** Seed a pull request the installation reaches at the shop's GitHub fake: its head commit and its
 *  files, which `GET /repos/<o>/<r>/pulls/<n>/files` then answers. */
export const petshopGithubSeedPull = (input: {
  installationId: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  files: { filename: string; status: string; patch: string }[];
}): Promise<{ ok: true }> =>
  petshopJson("/__backdoor/github/pulls", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify(input),
  });

/** The check runs an installation posted to the shop's GitHub fake, oldest first. */
export const petshopGithubCheckRuns = (
  installationId: string,
): Promise<{
  check_runs: {
    head_sha: string;
    name: string;
    conclusion: string | null;
    external_id: string | null;
    output: { summary?: string } | null;
  }[];
}> =>
  petshopJson(`/__backdoor/github/check-runs?installation=${encodeURIComponent(installationId)}`, {
    headers: backdoorHeaders(),
  });
