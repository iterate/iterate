// secret-oauth.ts — how a secret obtains its FIRST OAuth tokens, the pure half. `itx.secrets.beginOAuth(path,
// options)` sends a human through the provider's consent page; the provider redirects to the
// platform's one callback (`SECRET_OAUTH_CALLBACK_PATH`, served by worker.ts) with a code; the
// secret's facet exchanges the code (PKCE, RFC 7636) and becomes an ordinary `oauth-refresh-token`
// secret — everything in secrets.ts applies from then on, and no code but that facet ever holds a
// token.
//
// Two pure functions of (options, fetch): `beginSecretOAuth` builds the pending attempt and the
// authorize URL; `completeSecretOAuth` turns the pending attempt and a code into a `SecretRecord`.
// The host (secret/durable-object.ts) signs the `state`, keeps the pending attempt and runs these.
//
// AN INTEGRATION'S CONNECT (src/integrations/) names whose app instead of passing a client in the
// clear: `client: { platform: "slack" }` is the deployment's own (APP_CONFIG `integrations.<provider>`,
// read inside the secret's facet and never copied into the record — the record holds the tokens, and
// a refresh names the same client), `client: { project: "slack" }` the project's own, whose
// credentials this secret already holds (`clientId`, `clientSecret`, and whatever else the app needs,
// such as Slack's `signingSecret`), kept beside the tokens. Either way the redirect URI is the
// provider's `/api/integrations/<provider>/callback`, whose handler finishes the connection. `next`
// is where the callback sends the human once the tokens are stored: the platform's origin or the
// Dash's, nowhere else (`nextUrlOf`).

import * as oauth from "oauth4webapi";
import type { ClientAuth } from "iterate/api";
import { consentAccountRefusal } from "./integrations/rules.ts";
import {
  clientAuthOf,
  isRecord,
  oauthTokenRequest,
  oauthTokensOf,
  originsOf,
  type SecretRecord,
} from "./secrets.ts";

/** How long an OAuth attempt stays open: the signed `state`'s expiry and the pending attempt's. */
export const SECRET_OAUTH_TTL_MS = 10 * 60_000;

/** The providers an integration connects through OAuth, whose callback is
 *  `/api/integrations/<provider>/callback`. */
export const OAUTH_INTEGRATION_PROVIDERS = ["slack", "google", "cloudflare"] as const;
export type OAuthIntegrationProvider = (typeof OAUTH_INTEGRATION_PROVIDERS)[number];
/** Whose app an integration's connect goes through (the header above). */
export type SecretOAuthClient =
  | { platform: OAuthIntegrationProvider }
  | { project: OAuthIntegrationProvider };

/** What `itx.secrets.beginOAuth(path, options)` takes: the provider's two endpoints, the OAuth client
 *  (the project's own in the clear, or an integration's `client`), the scope, the pin, any extra
 *  authorize parameters the provider needs (Google: `access_type=offline`, `prompt=consent` for a
 *  refresh token), and where the human lands afterwards. */
export type SecretOAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Exactly one of `clientId` and `client`. */
  clientId?: string;
  /** Absent for a public client (PKCE alone), and with `client`. */
  clientSecret?: string;
  client?: SecretOAuthClient;
  /** An absolute URL on the platform's origin or the Dash's. */
  next?: string;
  /** How the token endpoint wants the client credential — `ClientAuth` (secrets.ts). */
  clientAuth?: ClientAuth;
  scope?: string;
  /** The origins the tokens may be sent to; defaults to the token endpoint's, which it must include. */
  urls?: string[];
  extra?: Record<string, string>;
  /** The account the tokens must be for — an existing connection's, asked for more: the provider's
   *  id for it (a Slack team, an OpenID `sub`), read off the token response. Another account's
   *  tokens are refused before anything is stored (integrations/rules.ts `consentAccountRefusal`). */
  expectAccount?: string;
};

/** The options validated and normalized — the shape the pending attempt and the exchange read. */
export type NormalizedSecretOAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** "" with `client`: the host resolves it. */
  clientId: string;
  /** "" for a public client, and with `client`. */
  clientSecret: string;
  client: SecretOAuthClient | null;
  clientAuth: ClientAuth;
  scope?: string;
  urls: string[];
  extra: Record<string, string>;
  next: string | null;
  expectAccount: string | null;
};

/** The pending attempt, kept by the secret's facet between the redirect out and the code
 *  back: everything the exchange needs and nothing a browser ever sees. */
export type PendingSecretOAuth = {
  options: NormalizedSecretOAuthOptions;
  /** The exact redirect URI the authorize URL carried — the exchange must repeat it (RFC 6749 §4.1.3). */
  redirectUri: string;
  codeVerifier: string;
  /** Pairs the callback with THIS attempt (a replayed or foreign state cannot complete it). */
  nonce: string;
  /** Ten minutes: long enough to sign in at the provider, short enough that a stale attempt dies. */
  until: number;
};

/** The claims the platform signs into the `state` parameter — how the callback finds the secret:
 *  `context` is the secret's context, its Durable Object name (`<projectId>.iterate/secrets/<name>`;
 *  under `/users/<id>` or `/organizations/<id>` for a user's or an organization's own secret) — the
 *  callback derives the RESOURCE OWNER from it (context/paths.ts `resourceScope`) and admits the
 *  human by that. `kind` keeps these claims apart from every other claim set the same key signs. */
export type SecretOAuthState = {
  kind: "secret-oauth";
  context: string;
  nonce: string;
  exp: number;
  /** Where the callback redirects once the tokens are stored. */
  next?: string | null;
};

/** The platform's one redirect URI for every project secret's OAuth — registered once per provider. */
export const SECRET_OAUTH_CALLBACK_PATH = "/.secrets/oauth/callback";

/** The redirect URI path of an attempt: an integration's is its provider's callback — the legacy
 *  platform's URL, which iterate's Slack app and Google client are registered with — and every other
 *  attempt's `SECRET_OAUTH_CALLBACK_PATH`. worker.ts serves all of them with the same callback. */
export function secretOAuthCallbackPathOf(client: SecretOAuthClient | null): string {
  if (!client) return SECRET_OAUTH_CALLBACK_PATH;
  return `/api/integrations/${"platform" in client ? client.platform : client.project}/callback`;
}

/** `next` checked: an absolute URL on one of `origins` (the platform's and the Dash's), never an
 *  open redirect; null when absent. */
export function nextUrlOf(next: unknown, origins: readonly string[]): string | null {
  if (!next) return null;
  const url = URL.canParse(String(next)) ? new URL(String(next)) : null;
  if (!url || !origins.includes(url.origin))
    throw new Error(
      `next is an absolute URL on ${origins.join(" or ")}, got ${JSON.stringify(next)}`,
    );
  return url.href;
}

/** The options validated and normalized: http(s) endpoints, the pin as origins (defaulting to the
 *  token endpoint's origin, which it must contain), the client-auth method from the registry, one
 *  client, and `next` on one of `nextOrigins`. */
export function normalizeSecretOAuth(
  options: unknown,
  nextOrigins: readonly string[] = [],
): NormalizedSecretOAuthOptions {
  if (!isRecord(options)) throw new Error("secrets.beginOAuth: options is an object");
  const endpoint = (key: "authorizationEndpoint" | "tokenEndpoint") => {
    const url = new URL(String(options[key]));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`secrets.beginOAuth: ${key} must be an http(s) URL`);
    return url;
  };
  const authorizationEndpoint = endpoint("authorizationEndpoint");
  const tokenEndpoint = endpoint("tokenEndpoint");
  const client = secretOAuthClientOf(options.client);
  if (client && (options.clientId !== undefined || options.clientSecret !== undefined))
    throw new Error("secrets.beginOAuth: pass client, or clientId (and clientSecret), not both");
  if (!client && (typeof options.clientId !== "string" || !options.clientId))
    throw new Error("secrets.beginOAuth: clientId (or client) is required");
  const urls = options.urls === undefined ? [tokenEndpoint.origin] : originsOf(options.urls);
  if (!urls.includes(tokenEndpoint.origin))
    throw new Error(
      `secrets.beginOAuth: tokenEndpoint ${tokenEndpoint.origin} is outside the pin ${urls.join(", ")} — the tokens only ever go toward a pinned host`,
    );
  const extra: Record<string, string> = {};
  if (isRecord(options.extra))
    for (const [key, value] of Object.entries(options.extra)) extra[key] = String(value);
  return {
    authorizationEndpoint: authorizationEndpoint.href,
    tokenEndpoint: tokenEndpoint.href,
    clientId: client ? "" : String(options.clientId),
    clientSecret: typeof options.clientSecret === "string" ? options.clientSecret : "",
    client,
    clientAuth: clientAuthOf(options.clientAuth),
    ...(typeof options.scope === "string" && options.scope && { scope: options.scope }),
    urls,
    extra,
    next: nextUrlOf(options.next, nextOrigins),
    expectAccount:
      typeof options.expectAccount === "string" && options.expectAccount
        ? options.expectAccount
        : null,
  };
}

/** `client` checked: absent, or `{ platform }` / `{ project }` naming an OAuth integration's provider. */
function secretOAuthClientOf(value: unknown): SecretOAuthClient | null {
  if (value === undefined) return null;
  const provider = (key: string) =>
    isRecord(value) && OAUTH_INTEGRATION_PROVIDERS.find((name) => name === value[key]);
  const platform = provider("platform");
  if (platform) return { platform };
  const project = provider("project");
  if (project) return { project };
  throw new Error(
    `secrets.beginOAuth: client is { platform } or { project } naming one of ${OAUTH_INTEGRATION_PROVIDERS.join(", ")}, got ${JSON.stringify(value)}`,
  );
}

/** The authorization-code request with PKCE S256 (RFC 7636): the pending attempt the host keeps,
 *  and the URL the human is sent to. `state` is the platform-signed claim the callback verifies
 *  (the host signs it; this function only places it). */
export async function beginSecretOAuth(
  options: NormalizedSecretOAuthOptions,
  attempt: { redirectUri: string; state: string; nonce: string; now?: number },
): Promise<{ pending: PendingSecretOAuth; authorizationUrl: string }> {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const url = new URL(options.authorizationEndpoint);
  const params: Record<string, string | undefined> = {
    ...options.extra,
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: attempt.redirectUri,
    state: attempt.state,
    code_challenge: await oauth.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    scope: options.scope,
  };
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return {
    pending: {
      options,
      redirectUri: attempt.redirectUri,
      codeVerifier,
      nonce: attempt.nonce,
      until: (attempt.now ?? Date.now()) + SECRET_OAUTH_TTL_MS,
    },
    authorizationUrl: url.href,
  };
}

/** The code exchange: the pending attempt + the provider's code → the secret's record, with the
 *  `oauth-refresh-token` strategy pointing at the same token endpoint. `credentials` are the client's
 *  as the host resolved them (by default the ones passed in the clear), and `kept` the material the secret already holds that stays beside the
 *  tokens (a project's own app's). The deployment's client (`{ platform }`) is never written into
 *  the record: its tokens alone, and a refresh — when the provider issued a refresh token — that
 *  names the same client. */
export async function completeSecretOAuth(
  pending: PendingSecretOAuth,
  code: string,
  fetchFn: (request: Request) => Promise<Response>,
  credentials: { clientId: string; clientSecret: string; kept: Record<string, unknown> } = {
    clientId: pending.options.clientId,
    clientSecret: pending.options.clientSecret,
    kept: {},
  },
): Promise<SecretRecord> {
  const { options } = pending;
  const response = await fetchFn(
    oauthTokenRequest({
      tokenEndpoint: options.tokenEndpoint,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      clientAuth: options.clientAuth,
      params: {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      },
    }),
  );
  if (options.expectAccount) {
    const refusal = consentAccountRefusal(
      options.expectAccount,
      await response
        .clone()
        .json()
        .catch(() => null),
    );
    if (refusal) throw new Error(refusal);
  }
  const tokens = await oauthTokensOf(response, "oauth");
  const refresh = {
    kind: "oauth-refresh-token" as const,
    tokenEndpoint: options.tokenEndpoint,
    clientAuth: options.clientAuth,
  };
  if (options.client && "platform" in options.client)
    return {
      material: tokens,
      urls: options.urls,
      refresh: tokens.refreshToken ? { ...refresh, client: options.client } : null,
    };
  return {
    material: {
      ...credentials.kept,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret, // "" for a public client — the refresh grant then sends client_id alone
      ...tokens,
    },
    urls: options.urls,
    refresh,
  };
}

/** The signed claims, shape-checked field by field — the signature proved WHO wrote them, this
 *  proves WHAT they are before a project id or a name reaches a Durable Object name. */
export function isSecretOAuthState(claims: unknown): claims is SecretOAuthState {
  return (
    isRecord(claims) &&
    claims.kind === "secret-oauth" &&
    typeof claims.context === "string" &&
    typeof claims.nonce === "string" &&
    typeof claims.exp === "number" &&
    typeof (claims.next ?? "") === "string"
  );
}
