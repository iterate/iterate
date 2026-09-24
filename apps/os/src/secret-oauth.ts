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

import * as oauth from "oauth4webapi";
import type { ClientAuth } from "iterate/next/api";
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

/** What `itx.secrets.beginOAuth(path, options)` takes: the provider's two endpoints, the project's
 *  own OAuth client (bring-your-own-app), the scope, the pin, and any extra authorize parameters the
 *  provider needs (Google: `access_type=offline`, `prompt=consent` for a refresh token). */
export type SecretOAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** Absent for a public client (PKCE alone). */
  clientSecret?: string;
  /** How the token endpoint wants the client credential — `ClientAuth` (secrets.ts). */
  clientAuth?: ClientAuth;
  scope?: string;
  /** The origins the tokens may be sent to; defaults to the token endpoint's, which it must include. */
  urls?: string[];
  extra?: Record<string, string>;
};

/** The options validated and normalized — the shape the pending attempt and the exchange read. */
export type NormalizedSecretOAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** "" for a public client. */
  clientSecret: string;
  clientAuth: ClientAuth;
  scope?: string;
  urls: string[];
  extra: Record<string, string>;
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
};

/** The platform's one redirect URI for every project secret's OAuth — registered once per provider. */
export const SECRET_OAUTH_CALLBACK_PATH = "/.secrets/oauth/callback";

/** The options validated and normalized: http(s) endpoints, the pin as origins (defaulting to the
 *  token endpoint's origin, which it must contain), the client-auth method from the registry. */
export function normalizeSecretOAuth(options: unknown): NormalizedSecretOAuthOptions {
  if (!isRecord(options)) throw new Error("secrets.beginOAuth: options is an object");
  const endpoint = (key: "authorizationEndpoint" | "tokenEndpoint") => {
    const url = new URL(String(options[key]));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`secrets.beginOAuth: ${key} must be an http(s) URL`);
    return url;
  };
  const authorizationEndpoint = endpoint("authorizationEndpoint");
  const tokenEndpoint = endpoint("tokenEndpoint");
  if (typeof options.clientId !== "string" || !options.clientId)
    throw new Error("secrets.beginOAuth: clientId is required");
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
    clientId: options.clientId,
    clientSecret: typeof options.clientSecret === "string" ? options.clientSecret : "",
    clientAuth: clientAuthOf(options.clientAuth),
    ...(typeof options.scope === "string" && options.scope && { scope: options.scope }),
    urls,
    extra,
  };
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

/** The code exchange: the pending attempt + the provider's code → the secret's first record, with
 *  the `oauth-refresh-token` strategy pointing at the same token endpoint. */
export async function completeSecretOAuth(
  pending: PendingSecretOAuth,
  code: string,
  fetchFn: (request: Request) => Promise<Response>,
): Promise<SecretRecord> {
  const { options } = pending;
  const response = await fetchFn(
    oauthTokenRequest({
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      clientAuth: options.clientAuth,
      params: {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      },
    }),
  );
  const tokens = await oauthTokensOf(response, "oauth");
  return {
    material: {
      clientId: options.clientId,
      clientSecret: options.clientSecret, // "" for a public client — the refresh grant then sends client_id alone
      ...tokens,
    },
    urls: options.urls,
    refresh: {
      kind: "oauth-refresh-token",
      tokenEndpoint: options.tokenEndpoint,
      clientAuth: options.clientAuth,
    },
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
    typeof claims.exp === "number"
  );
}
