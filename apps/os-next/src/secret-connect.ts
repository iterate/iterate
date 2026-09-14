// secret-connect.ts — THE CONNECT HALF of an OAuth-protected API, pure: how a secret obtains its
// FIRST tokens. `itx.secrets.connect(name, options)` sends a human through the provider's consent
// page; the provider redirects to the platform's one callback with a code; the secret's Durable
// Object exchanges the code (PKCE, RFC 7636) and becomes an ordinary `oauth-refresh-token` secret —
// everything in secrets.ts applies from then on, and no code but that object ever holds a token.
//
// Two pure functions of (options, fetch): `beginSecretConnect` builds the pending record and the
// authorize URL; `completeSecretConnect` turns the pending record and a code into a `SecretRecord`.
// The host (secret-durable-object.ts) signs the `state`, keeps the pending record and runs these;
// the callback route (`secretConnectCallback`, below) is where the provider sends the human back.

import { appConfigOf, type AppConfigEnv } from "./app-config.ts";
import { verifyClaims } from "./principal.ts";
import { isRecord, oauthTokenRequest, oauthTokensOf, type SecretRecord } from "./secrets.ts";
import type { SecretDurableObject } from "./secret-durable-object.ts";

/** What `itx.secrets.connect(name, options)` takes: the provider's two endpoints, the project's own
 *  OAuth client (bring-your-own-app), the scope, the pin, and any extra authorize parameters the
 *  provider needs (Google: `access_type=offline`, `prompt=consent` for a refresh token). */
export type SecretConnectOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** Absent for a public client (PKCE alone). */
  clientSecret?: string;
  /** How the token endpoint wants the client credential — see `SecretRefresh`. */
  clientAuth?: "basic" | "body";
  scope?: string;
  /** The origins the tokens may be sent to; the token endpoint must be one of them. */
  urls?: string[];
  extra?: Record<string, string>;
};

/** The pending half, kept by the secret's Durable Object between the redirect out and the code
 *  back: everything the exchange needs and nothing a browser ever sees. */
export type PendingSecretConnect = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  clientAuth: "basic" | "body";
  urls: string[];
  redirectUri: string;
  codeVerifier: string;
  /** Pairs the callback with THIS attempt (a replayed or foreign state cannot complete it). */
  nonce: string;
  /** Ten minutes: long enough to sign in at the provider, short enough that a stale attempt dies. */
  until: number;
};

/** The claims the platform signs into the `state` parameter — how the callback finds the secret. */
export type SecretConnectState = { projectId: string; name: string; nonce: string; exp: number };

export const SECRET_CONNECT_CALLBACK_PATH = "/.auth/connect/callback";

/** The options validated and normalized: http(s) endpoints, the pin as origins, the token endpoint
 *  within the pin. Shared by the built-in (for the catalog fact) and the Durable Object. */
export function normalizeSecretConnect(options: unknown): SecretConnectOptions & {
  urls: string[];
  clientAuth: "basic" | "body";
} {
  if (!isRecord(options)) throw new Error("secrets.connect: options is an object");
  const o = options;
  const endpoint = (key: "authorizationEndpoint" | "tokenEndpoint") => {
    const url = new URL(String(o[key]));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`secrets.connect: ${key} must be an http(s) URL`);
    return url;
  };
  const authorizationEndpoint = endpoint("authorizationEndpoint");
  const tokenEndpoint = endpoint("tokenEndpoint");
  if (typeof o.clientId !== "string" || !o.clientId)
    throw new Error("secrets.connect: clientId is required");
  const urls =
    o.urls === undefined
      ? [tokenEndpoint.origin]
      : [
          ...new Set(
            (Array.isArray(o.urls) ? o.urls : []).map((url) => new URL(String(url)).origin),
          ),
        ];
  if (!urls.includes(tokenEndpoint.origin))
    throw new Error(
      `secrets.connect: tokenEndpoint ${tokenEndpoint.origin} is outside the pin ${urls.join(", ")} — the tokens only ever go toward a pinned host`,
    );
  const extra: Record<string, string> = {};
  if (typeof o.extra === "object" && o.extra)
    for (const [key, value] of Object.entries(o.extra)) extra[key] = String(value);
  return {
    authorizationEndpoint: authorizationEndpoint.href,
    tokenEndpoint: tokenEndpoint.href,
    clientId: o.clientId,
    ...(typeof o.clientSecret === "string" && o.clientSecret && { clientSecret: o.clientSecret }),
    clientAuth: o.clientAuth === "body" ? "body" : "basic",
    ...(typeof o.scope === "string" && o.scope && { scope: o.scope }),
    urls,
    extra,
  };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** The authorization-code request with PKCE S256 (RFC 7636): the pending record the host keeps,
 *  and the URL the human is sent to. `state` is the platform-signed claim the callback verifies
 *  (the host signs it; this function only places it). */
export async function beginSecretConnect(
  options: ReturnType<typeof normalizeSecretConnect>,
  attempt: { redirectUri: string; state: string; nonce: string; now?: number },
): Promise<{ pending: PendingSecretConnect; authorizationUrl: string }> {
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))),
  );
  const url = new URL(options.authorizationEndpoint);
  const params: Record<string, string | undefined> = {
    ...options.extra,
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: attempt.redirectUri,
    state: attempt.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: options.scope,
  };
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return {
    pending: {
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      clientSecret: options.clientSecret || "",
      clientAuth: options.clientAuth,
      urls: options.urls,
      redirectUri: attempt.redirectUri,
      codeVerifier,
      nonce: attempt.nonce,
      until: (attempt.now ?? Date.now()) + 10 * 60_000,
    },
    authorizationUrl: url.href,
  };
}

/** The code exchange: the pending record + the provider's code → the secret's first record, with
 *  the `oauth-refresh-token` strategy pointing at the same token endpoint. */
export async function completeSecretConnect(
  pending: PendingSecretConnect,
  code: string,
  fetchFn: (request: Request) => Promise<Response>,
): Promise<SecretRecord> {
  const response = await fetchFn(
    oauthTokenRequest({
      tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      clientAuth: pending.clientAuth,
      params: {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      },
    }),
  );
  const tokens = await oauthTokensOf(response, "connect");
  return {
    material: {
      clientId: pending.clientId,
      clientSecret: pending.clientSecret, // "" for a public client — the refresh grant then sends client_id alone
      ...tokens,
    },
    urls: pending.urls,
    refresh: {
      kind: "oauth-refresh-token",
      tokenEndpoint: pending.tokenEndpoint,
      ...(pending.clientAuth === "body" && { clientAuth: "body" as const }),
    },
  };
}

/** THE ONE CALLBACK on the platform host, `/.auth/connect/callback`: the provider sends the human
 *  back here with `code` and `state`; the signed state names the secret, the secret's Durable Object
 *  finishes the exchange. Registered once per provider as the redirect URI (bring-your-own-app). A
 *  failure is a 400 with the reason, never a credential. */
export async function secretConnectCallback(
  request: Request,
  env: AppConfigEnv & { SECRET: DurableObjectNamespace<SecretDurableObject> },
): Promise<Response> {
  const url = new URL(request.url);
  const config = appConfigOf(env);
  const answer = (status: number, text: string) =>
    new Response(`${text}\n`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  const claims = await verifyClaims(
    url.searchParams.get("state") ?? "",
    config.sessionSecret.exposeSecret(),
  );
  if (!isSecretConnectState(claims) || claims.exp <= Date.now())
    return answer(400, "This connect link is not one the platform issued, or it has expired.");
  const denied = url.searchParams.get("error");
  if (denied) return answer(400, `The provider declined the connection: ${denied}`);
  const code = url.searchParams.get("code");
  if (!code) return answer(400, "The provider sent no authorization code.");
  try {
    await env.SECRET.getByName(`${claims.projectId}:${claims.name}`).completeConnect({
      code,
      nonce: claims.nonce,
    });
  } catch (error) {
    return answer(
      400,
      `Connecting ${claims.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return answer(
    200,
    `Connected: the secret "${claims.name}" of project ${claims.projectId} now holds the tokens. You can close this tab.`,
  );
}

/** The signed claims, shape-checked field by field — the signature proved WHO wrote them, this
 *  proves WHAT they are before a project id or a name reaches a Durable Object name. */
function isSecretConnectState(claims: unknown): claims is SecretConnectState {
  return (
    isRecord(claims) &&
    typeof claims.projectId === "string" &&
    typeof claims.name === "string" &&
    typeof claims.nonce === "string" &&
    typeof claims.exp === "number"
  );
}
