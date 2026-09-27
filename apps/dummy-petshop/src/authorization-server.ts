/**
 * THE FAKES' ONE AUTHORIZATION SERVER. The shop's own OAuth provider (oauth-provider.ts) and its
 * Slack, Google, Cloudflare and GitHub fakes are each this server at their provider's paths, in
 * their provider's shapes. Consent is at once: authorize redirects with a sealed single-use code.
 * The exchange checks the code's client, expiry, redirect URI (RFC 6749 §4.1.3) and PKCE (RFC 7636,
 * required of a public client), then spends it. Access tokens expire and carry their client's
 * revocation epoch, so `/__backdoor/expire-tokens { clientId }` forces a 401; refresh tokens never
 * expire and are revoked one by one. Every code and token is a sealed blob (seal.ts) whose `t`
 * names its provider and kind, and whose `grant` is what the provider knows of it (an account, its
 * scopes).
 */
import { nowSeconds, pkceS256, seal, unseal } from "./seal.ts";
import { accessTokenEpochFor, type OauthClient, type ShopDeps } from "./state.ts";

/** How long a code lives: GitHub's ten minutes, for every provider. */
const CODE_TTL_SECONDS = 600;

/** Why a code was not exchanged. The fakes whose provider names a refusal apart (Slack's
 *  `invalid_code_verifier`, Google's and GitHub's `redirect_uri_mismatch`) read it; the shop's own
 *  provider answers it as its `error_description`. */
export type CodeRefusal =
  | "not a code of this client"
  | "code expired"
  | "redirect_uri mismatch"
  | "PKCE is required for public clients"
  | "PKCE code_verifier mismatch"
  | "code already used";

interface SealedCode<Grant> {
  t: string;
  jti: string;
  clientId: string;
  /** The redirect URI the authorize request named, which the exchange must repeat. */
  redirectUri?: string;
  codeChallenge?: string;
  exp: number;
  grant: Grant;
}

export interface AccessToken<Grant> {
  t: string;
  clientId: string;
  epoch: number;
  exp: number;
  grant: Grant;
}

export interface RefreshToken<Grant> {
  t: string;
  jti: string;
  clientId?: string;
  grant: Grant;
}

/** A sealed access token of type `t`: `grant` for `clientId`, at the client's revocation epoch now,
 *  for `ttlSeconds`. The servers' access tokens and the GitHub fake's installation tokens. */
export async function sealAccessToken<Grant>(
  deps: ShopDeps,
  t: string,
  clientId: string,
  grant: Grant,
  ttlSeconds: number,
): Promise<string> {
  const token: AccessToken<Grant> = {
    t,
    clientId,
    epoch: accessTokenEpochFor(await deps.state.getState(), clientId),
    exp: nowSeconds() + ttlSeconds,
    grant,
  };
  return seal(token, deps.sealKey);
}

/** A live access token of type `t`: unexpired, at its client's current epoch. Null for anything else. */
export async function openAccessToken<Grant>(
  deps: ShopDeps,
  t: string,
  token: string,
): Promise<AccessToken<Grant> | null> {
  const access = await unseal<AccessToken<Grant>>(token, deps.sealKey);
  if (access?.t !== t || access.exp <= nowSeconds()) return null;
  const epoch = accessTokenEpochFor(await deps.state.getState(), access.clientId);
  return access.epoch === epoch ? access : null;
}

/** The client a token request authenticates as: HTTP Basic (RFC 6749 §2.3.1), or `client_id` and
 *  `client_secret` among its parameters; a public client by `client_id` alone, its PKCE verifier
 *  standing in for a secret. Null when that is no registered client. */
export async function tokenClient(
  deps: ShopDeps,
  request: Request,
  params: Record<string, string | undefined>,
): Promise<{ clientId: string; client: OauthClient } | null> {
  const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  let credentials = { clientId: params.client_id || "", clientSecret: params.client_secret };
  if (basic) {
    try {
      const decoded = atob(basic);
      const colon = decoded.indexOf(":");
      if (colon < 0) return null;
      credentials = {
        clientId: decodeURIComponent(decoded.slice(0, colon)),
        clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
      };
    } catch {
      return null;
    }
  }
  const client = (await deps.state.getState()).clients[credentials.clientId];
  if (!client) return null;
  const authenticated = client.public
    ? !basic && !credentials.clientSecret
    : client.clientSecret === credentials.clientSecret;
  return authenticated ? { clientId: credentials.clientId, client } : null;
}

/** A 302 to `url` with `params` added (the code, the request's `state`, GitHub's install fields);
 *  an absent or empty one is left off. */
export function redirectTo(url: string, params: Record<string, string | undefined>): Response {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) if (value) target.searchParams.set(key, value);
  return Response.redirect(target.toString(), 302);
}

/** One provider's authorization server over the shop's state: its codes, access tokens and refresh
 *  tokens are `<provider>-code`, `-access` and `-refresh`, each carrying the provider's `Grant`. */
export function fakeAuthorizationServer<Grant>(deps: ShopDeps, provider: string) {
  const types = {
    code: `${provider}-code`,
    access: `${provider}-access`,
    refresh: `${provider}-refresh`,
  };
  return {
    /** Why an authorize request is refused, as the page a person would land on: an unregistered
     *  client, a redirect URI that is not absolute or, for a client registered with redirect URIs
     *  (RFC 7591), not one of them. Null when it is not refused. */
    async authorizeRefusal(clientId: string, redirectUri: string): Promise<Response | null> {
      const client = (await deps.state.getState()).clients[clientId];
      const refusal = !client
        ? `unknown client_id ${JSON.stringify(clientId)} — mint one via POST /__backdoor/clients`
        : !URL.canParse(redirectUri)
          ? "redirect_uri must be an absolute URL"
          : client.redirectUris?.length && !client.redirectUris.includes(redirectUri)
            ? "redirect_uri is not registered for this client"
            : null;
      if (!refusal) return null;
      return Response.json(
        { error: "invalid_request", error_description: refusal },
        { status: 400 },
      );
    },

    /** A single-use code for `grant`. `redirectUri` is the one the authorize request named (GitHub's
     *  install redirect names none); `codeChallenge` its PKCE S256 challenge. */
    code(input: {
      clientId: string;
      redirectUri?: string;
      codeChallenge?: string;
      grant: Grant;
    }): Promise<string> {
      const code: SealedCode<Grant> = {
        t: types.code,
        jti: crypto.randomUUID(),
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge || undefined,
        exp: nowSeconds() + CODE_TTL_SECONDS,
        grant: input.grant,
      };
      return seal(code, deps.sealKey);
    },

    /** The grant a code carries, spent now; or why it is refused. */
    async redeemCode(
      code: string,
      input: {
        clientId: string;
        client: OauthClient;
        redirectUri: string | undefined;
        codeVerifier: string | undefined;
      },
    ): Promise<{ grant: Grant } | { refused: CodeRefusal }> {
      const sealed = await unseal<SealedCode<Grant>>(code, deps.sealKey);
      if (sealed?.t !== types.code || sealed.clientId !== input.clientId)
        return { refused: "not a code of this client" };
      if (sealed.exp <= nowSeconds()) return { refused: "code expired" };
      if ((sealed.redirectUri || input.redirectUri) && input.redirectUri !== sealed.redirectUri)
        return { refused: "redirect_uri mismatch" };
      if (input.client.public && !sealed.codeChallenge)
        return { refused: "PKCE is required for public clients" };
      if (
        sealed.codeChallenge &&
        (await pkceS256(input.codeVerifier || "")) !== sealed.codeChallenge
      )
        return { refused: "PKCE code_verifier mismatch" };
      if (!(await deps.state.consumeAuthorizationCode(sealed.jti)))
        return { refused: "code already used" };
      return { grant: sealed.grant };
    },

    accessToken: (clientId: string, grant: Grant, ttlSeconds: number) =>
      sealAccessToken(deps, types.access, clientId, grant, ttlSeconds),

    openAccessToken: (token: string) => openAccessToken<Grant>(deps, types.access, token),

    /** A refresh token for `grant`. Slack's bot token is one: it never expires, and `auth.revoke`
     *  ends it. */
    refreshToken(clientId: string | undefined, grant: Grant): Promise<string> {
      const refresh: RefreshToken<Grant> = {
        t: types.refresh,
        jti: crypto.randomUUID(),
        clientId,
        grant,
      };
      return seal(refresh, deps.sealKey);
    },

    /** A refresh token not revoked, of `clientId` when one is named. Null for anything else. */
    async openRefreshToken(token: string, clientId?: string): Promise<RefreshToken<Grant> | null> {
      const refresh = await unseal<RefreshToken<Grant>>(token, deps.sealKey);
      if (refresh?.t !== types.refresh || (clientId && refresh.clientId !== clientId)) return null;
      const { revokedRefreshTokenIds } = await deps.state.getState();
      return revokedRefreshTokenIds.includes(refresh.jti) ? null : refresh;
    },

    /** The refresh token stops working; false when `token` is none of this server's. */
    async revokeRefreshToken(token: string): Promise<boolean> {
      const refresh = await unseal<RefreshToken<Grant>>(token, deps.sealKey);
      if (refresh?.t !== types.refresh) return false;
      await deps.state.revokeToken(refresh.jti);
      return true;
    },
  };
}
