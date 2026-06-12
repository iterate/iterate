// Google as an IntegrationDefinition — and the OAuth-refresh-as-derivation
// showcase. The connect choreography journals THREE secrets per account:
//
//   google/{account}/refresh-token       fact (the long-lived grant)
//   google/{account}/oauth-client-secret fact, tier "iterate" (OUR client
//                                        secret — customers and their agents
//                                        see placeholders only)
//   google/{account}/access-token        DERIVED: the standard refresh-token
//                                        exchange, expressed as data — the
//                                        secret system re-derives it inline
//                                        whenever a use finds it stale.
//
// No bespoke refresh code anywhere (the old getFreshGoogleAccessToken is
// gone): freshness is the secret processor reacting to derive-requested.

import type { IntegrationDefinition } from "~/domains/integrations/definition.ts";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";

export const GOOGLE_ACCESS_TOKEN_SECRET_NAME = "access-token";
export const GOOGLE_REFRESH_TOKEN_SECRET_NAME = "refresh-token";
export const GOOGLE_CLIENT_SECRET_SECRET_NAME = "oauth-client-secret";

/** Pure URL builder — the oRPC start-flow procedure supplies the PKCE
 * challenge and the signed state (which carries the verifier). */
export function buildGoogleAuthorizationUrl(input: {
  clientId: string;
  scopes: string[];
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export const googleIntegration: IntegrationDefinition = {
  slug: "google",
  displayName: "Google",
  instructions:
    'Google for this project. itx.integrations.google.gmail.request({ path: "/messages", ' +
    'query: { q: "is:unread" } }) calls the Gmail API as the connected account; the access ' +
    "token is a derived Secret that refreshes itself inline.",

  async fetch(ctx) {
    if (new URL(ctx.request.url).pathname !== "/api/integrations/google/callback") return null;
    const google = ctx.config.integrations.google;
    if (!google) {
      return Response.json({ error: "Google integration is not configured." }, { status: 503 });
    }

    const url = new URL(ctx.request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state) return Response.json({ error: "Missing OAuth state." }, { status: 400 });
    const stateData = await ctx.oauthState.verify(state);
    if (!stateData || stateData.provider !== "google" || !stateData.codeVerifier) {
      return Response.json({ error: "Invalid or expired OAuth state." }, { status: 400 });
    }
    if (url.searchParams.get("error")) {
      return redirectWithError(stateData.callbackUrl, "google_oauth_denied");
    }
    if (!code) return redirectWithError(stateData.callbackUrl, "google_oauth_missing_code");

    const redirectUri = `${ctx.baseUrl.replace(/\/$/, "")}/api/integrations/google/callback`;
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      body: new URLSearchParams({
        client_id: google.oauthClientId,
        client_secret: google.oauthClientSecret.exposeSecret(),
        code,
        code_verifier: stateData.codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    };
    if (!tokenResponse.ok || !tokenData.access_token) {
      return redirectWithError(stateData.callbackUrl, tokenData.error ?? "google_oauth_failed");
    }

    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = (await userInfoResponse.json()) as {
      email?: string;
      id?: string;
      name?: string;
    };
    if (!userInfoResponse.ok || !userInfo.id) {
      return redirectWithError(stateData.callbackUrl, "google_userinfo_failed");
    }

    const account = "default";
    const refreshTokenRef = `getSecret({ key: "${providedSecretSlug({ integration: "google", account, name: GOOGLE_REFRESH_TOKEN_SECRET_NAME })}" })`;
    const clientSecretRef = `getSecret({ key: "${providedSecretSlug({ integration: "google", account, name: GOOGLE_CLIENT_SECRET_SECRET_NAME })}" })`;
    // The derivation (and the client-secret sibling it references) only make
    // sense when Google returned a refresh token; without one the access
    // token is a plain expiring fact and reconnect is the refresh path.
    const canDerive = tokenData.refresh_token != null;
    await ctx.connect({
      account,
      projectId: stateData.projectId,
      ownership: "first-party",
      externalId: userInfo.id,
      displayName: userInfo.email ?? userInfo.id,
      routingKeys: [],
      secrets: [
        ...(canDerive
          ? [
              {
                name: GOOGLE_REFRESH_TOKEN_SECRET_NAME,
                material: tokenData.refresh_token!,
                metadata: { provider: "google", email: userInfo.email },
              },
              {
                name: GOOGLE_CLIENT_SECRET_SECRET_NAME,
                material: google.oauthClientSecret.exposeSecret(),
                tier: "iterate" as const,
                metadata: { provider: "google", description: "iterate's OAuth client secret" },
              },
            ]
          : []),
        {
          name: GOOGLE_ACCESS_TOKEN_SECRET_NAME,
          material: tokenData.access_token,
          ...(tokenData.expires_in == null
            ? {}
            : { expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString() }),
          metadata: {
            provider: "google",
            email: userInfo.email,
            scopes: tokenData.scope?.split(" ") ?? google.scopes,
          },
          ...(canDerive
            ? {
                derivation: {
                  kind: "http-exchange" as const,
                  request: {
                    url: "https://oauth2.googleapis.com/token",
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body:
                      `grant_type=refresh_token&refresh_token=${refreshTokenRef}` +
                      `&client_id=${google.oauthClientId}&client_secret=${clientSecretRef}`,
                  },
                  extract: { materialPointer: "/access_token", expiresInPointer: "/expires_in" },
                  refreshLeewaySeconds: 300,
                },
              }
            : {}),
        },
      ],
    });
    return Response.redirect(stateData.callbackUrl ?? "/", 302);
  },

  providedSecrets: [
    {
      name: GOOGLE_ACCESS_TOKEN_SECRET_NAME,
      description: "Google access token — DERIVED from the refresh token, self-refreshing.",
    },
    {
      name: GOOGLE_REFRESH_TOKEN_SECRET_NAME,
      description: "Google OAuth refresh token (the long-lived grant).",
    },
    {
      name: GOOGLE_CLIENT_SECRET_SECRET_NAME,
      description: "iterate's Google OAuth client secret (tier: iterate).",
    },
  ],

  async createSdk(ctx) {
    const auth = `Bearer ${ctx.secretRef(GOOGLE_ACCESS_TOKEN_SECRET_NAME)}`;
    return {
      gmail: {
        async request(input: {
          path: string;
          method?: string;
          query?: Record<string, string>;
          body?: unknown;
        }) {
          const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me${input.path}`);
          for (const [key, value] of Object.entries(input.query ?? {})) {
            url.searchParams.set(key, value);
          }
          const response = await ctx.fetch(url.toString(), {
            method: input.method ?? "GET",
            headers: {
              authorization: auth,
              ...(input.body == null ? {} : { "content-type": "application/json" }),
            },
            ...(input.body == null ? {} : { body: JSON.stringify(input.body) }),
          });
          if (!response.ok) {
            throw new Error(`Gmail API ${input.path} failed: HTTP ${response.status}`);
          }
          return await response.json();
        },
      },
    };
  },
};

function redirectWithError(callbackUrl: string | undefined, error: string) {
  if (!callbackUrl) return Response.redirect(`/?error=${encodeURIComponent(error)}`, 302);
  const url = new URL(callbackUrl);
  url.searchParams.set("error", error);
  return Response.redirect(url.toString(), 302);
}
