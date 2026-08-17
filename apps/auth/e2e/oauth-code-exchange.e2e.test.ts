/**
 * Live e2e for a DEPLOYED auth worker's OAuth2/OIDC provider surface — the
 * authorization-code exchange no other lane drives:
 *
 *   # a preview slot
 *   doppler run --project auth --config preview_3 -- \
 *     env AUTH_BASE_URL=https://auth.iterate-preview-3.com pnpm test:e2e
 *
 *   # local dev (start `pnpm dev` in apps/auth first)
 *   doppler run --project auth --config dev -- \
 *     env AUTH_BASE_URL=http://localhost:7101 pnpm test:e2e
 *
 * Why this exists: on 2026-07-11 streams.iterate.com sign-in broke in
 * production because the app's OAuth client registration and the RFC 8707
 * resource allowlist (src/server/oauth-resources.ts, fixed in PR #1862) went
 * stale after a domain move — and nothing caught it, because every other
 * automated test authenticates with forge-minted JWTs or the first-party OTP
 * flow and never walks the provider's own authorize → code → token protocol.
 *
 * What it proves, from very far away (plain fetch, no better-auth client):
 * discovery advertises this deployment's own endpoints; a third-party-style
 * client can walk dynamic registration → authorize (PKCE) → consent → code →
 * token exchange and receives a JWKS-verifiable access token whose audience
 * is the requested RFC 8707 resource plus Iterate's org claims; the incident
 * resource (https://streams.iterate.com) stays inside the allowlist while an
 * unknown origin is rejected with the exact protocol error; and an
 * unregistered redirect_uri never sees a code — at authorize time or at
 * exchange time, where a bad attempt burns the code for good.
 *
 * Residual gap (deliberate): the suite registers its own client, so drift in
 * per-environment SEED data — e.g. a stale redirect URI on the deployed
 * os/streams client rows in production — is out of reach here; those rows
 * are reconciled by each app's sync-auth-client script and apps/auth's
 * seed-oauth-clients at deploy time. The allowlist, token machinery, and
 * redirect_uri pinning it exercises are the same deployed code paths those
 * first-party clients ride.
 *
 * Identity plumbing: the user + organization are seeded through the
 * service-token `internal.*` oRPC procedures (the documented test-seeding
 * lane), and the session comes from the fixed-OTP email sign-in — dev and
 * preview only; production disables the fixed OTP in envs.ts by design, so
 * this suite cannot run against prd.
 */
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { createAuthContractClient } from "@iterate-com/auth-contract";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ORGANIZATIONS_CLAIM,
  ITERATE_ROLE_CLAIM,
} from "@iterate-com/shared/auth-claims";
import { createCloudflareWorkerVersionOverrideFetch } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { ITERATE_BROWSER_EXTENSION_ORIGIN } from "../src/server/browser-origin.ts";

function requireAuthBaseUrl(): string {
  const value = process.env.AUTH_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      "AUTH_BASE_URL is required for auth e2e tests. Point it at a deployed auth worker " +
        "(https://auth.iterate-preview-N.com) or a local `pnpm dev` (http://localhost:7101).",
    );
  }
  return value.replace(/\/+$/, "");
}

function requireServiceToken(): string {
  const value = process.env.APP_CONFIG_SERVICE_AUTH_TOKEN?.trim();
  if (!value) {
    throw new Error(
      "APP_CONFIG_SERVICE_AUTH_TOKEN is required: it authenticates the internal.* oRPC " +
        "seeding procedures. Run under the target's auth Doppler config, e.g. " +
        "`doppler run --project auth --config preview_3 -- env AUTH_BASE_URL=… pnpm test:e2e`.",
    );
  }
  return value;
}

const baseUrl = requireAuthBaseUrl();
/** better-auth's issuer path on this deployment; all OIDC endpoints live under it. */
const issuer = `${baseUrl}/api/auth`;

/** A production first-party resource; the allowlist is compiled into every deployment. */
const OS_RESOURCE = "https://os.iterate.com";
/**
 * THE incident resource: streams.iterate.com fell out of the RFC 8707
 * allowlist after its domain move (PR #1862). Keeping it exchangeable is the
 * regression this suite exists for.
 */
const STREAMS_RESOURCE = "https://streams.iterate.com";

const runId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const email = `oauth-exchange-${runId}+test@nustom.com`.toLowerCase();

// A static verifier is fine: PKCE binds each CODE to the challenge; codes are
// minted fresh per exchange below.
const PKCE_VERIFIER = `e2e-verifier-${"n".repeat(52)}`;
let pkceChallenge: string;

type OAuthClient = { clientId: string; clientSecret: string; redirectUri: string };

/** Provisioned once in beforeAll; tests only read it and mint their own codes. */
let fx: {
  cookie: string;
  user: { id: string };
  org: { id: string; name: string; slug: string };
  /** Client used by the rejection-arm tests (the happy path registers its own). */
  armsClient: OAuthClient;
};

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("base64url");
}

/**
 * better-auth CSRF-checks cookie-bearing POSTs against trustedOrigins, so
 * every protocol POST identifies as the auth app's own origin (the consent
 * and register calls come from its UI in real life).
 */
function postJson(cookie: string | null, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...(cookie && { cookie }),
    },
    body: JSON.stringify(body),
  };
}

const authFetch = createCloudflareWorkerVersionOverrideFetch(
  globalThis.fetch.bind(globalThis),
  process.env,
);

/** Session-authenticated dynamic registration → confidential client (secret + PKCE). */
async function registerClient(cookie: string, label: string): Promise<OAuthClient> {
  const redirectUri = `http://127.0.0.1:8123/oauth/callback/${label}-${runId}`;
  const response = await authFetch(
    `${issuer}/oauth2/register`,
    postJson(cookie, {
      client_name: `auth e2e ${label} ${runId}`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "client_secret_basic",
    }),
  );
  expect(response.status).toBe(200);
  const registration = (await response.json()) as {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
    public: boolean;
  };
  expect(registration.redirect_uris).toEqual([redirectUri]);
  expect(registration.public).toBe(false);
  expect(registration.client_secret).toBeTruthy();
  return {
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
    redirectUri,
  };
}

function authorizeUrlFor(client: OAuthClient, overrides: Record<string, string> = {}): URL {
  const url = new URL(`${issuer}/oauth2/authorize`);
  const params = {
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: `state-${runId}`,
    code_challenge: pkceChallenge,
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

/**
 * GET /oauth2/authorize as a signed-in user. With `accept: application/json`
 * the provider answers `{redirect: true, url}` instead of a 302, which pins
 * the target URL without needing a redirect-following fetch.
 */
async function authorizeJson(
  url: URL,
  cookie: string,
): Promise<{ redirect: boolean; url: string }> {
  const response = await authFetch(url, {
    headers: { cookie, accept: "application/json" },
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { redirect: boolean; url: string };
}

/**
 * Accept the consent screen the way the /consent UI does: POST the signed
 * query (everything up to and including `sig` from the consent page URL)
 * back to the provider. Returns the callback URL carrying the code.
 */
async function acceptConsent(consentPageUrl: string, cookie: string): Promise<URL> {
  const params = new URL(consentPageUrl, baseUrl).searchParams;
  const signedParams = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    signedParams.append(key, value);
    if (key === "sig") break;
  }
  const response = await authFetch(
    `${issuer}/oauth2/consent`,
    postJson(cookie, { accept: true, oauth_query: signedParams.toString() }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { redirect: boolean; url: string };
  return new URL(body.url);
}

/**
 * Mint a fresh single-use authorization code for `client`. Handles both
 * authorize outcomes (straight code redirect, or consent hop on the client's
 * first authorization) so tests stay order-independent.
 */
async function mintAuthorizationCode(client: OAuthClient, cookie: string): Promise<string> {
  const body = await authorizeJson(authorizeUrlFor(client), cookie);
  const target = new URL(body.url, baseUrl);
  const callbackUrl =
    target.pathname === "/consent" ? await acceptConsent(body.url, cookie) : target;
  const code = callbackUrl.searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

async function exchangeToken(body: Record<string, string>, origin?: string): Promise<Response> {
  return authFetch(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin && {
        origin,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
      }),
    },
    body: new URLSearchParams(body),
  });
}

function codeExchangeBody(client: OAuthClient, code: string): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code_verifier: PKCE_VERIFIER,
  };
}

beforeAll(async () => {
  pkceChallenge = await sha256Base64Url(PKCE_VERIFIER);

  // Seed a user with one organization through the service-token lane. Without
  // an organization the authorize flow parks on /project-access onboarding
  // (auth-plugins.ts postLogin.shouldRedirect) instead of issuing a code.
  const serviceClient = createAuthContractClient({
    baseUrl,
    fetch: authFetch,
    serviceToken: requireServiceToken(),
  });
  const user = await serviceClient.internal.user.upsertVerifiedEmail({
    email,
    name: "OAuth exchange e2e",
  });
  const org = await serviceClient.internal.organization.createForUser({
    userId: user.id,
    name: `OAuth e2e org ${runId}`,
  });

  // Sign the seeded user in over plain HTTP via the fixed test OTP.
  const sendOtp = await authFetch(
    `${issuer}/email-otp/send-verification-otp`,
    postJson(null, { email, type: "sign-in" }),
  );
  expect(sendOtp.status).toBe(200);
  const signIn = await authFetch(
    `${issuer}/sign-in/email-otp`,
    postJson(null, { email, otp: "424242" }),
  );
  if (signIn.status !== 200) {
    throw new Error(
      `email-otp sign-in failed (${signIn.status}): ${await signIn.text()} — this suite needs a ` +
        "deployment with the fixed test OTP (APP_CONFIG_FIXED_TEST_OTP_ENABLED; dev and preview " +
        "have it, production disables it by design).",
    );
  }
  const cookie = signIn.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  expect(cookie).toContain("session_token");

  fx = { cookie, user: { id: user.id }, org, armsClient: await registerClient(cookie, "arms") };
});

describe("deployed auth OAuth2/OIDC provider", () => {
  test("discovery advertises this deployment's own endpoints", async () => {
    // The incident class: after a domain move, a deployment whose advertised
    // issuer/endpoints stop matching its public origin strands every relying
    // party. Exact equality against AUTH_BASE_URL is the point.
    const response = await authFetch(`${baseUrl}/api/auth/.well-known/openid-configuration`);
    expect(response.status).toBe(200);
    const discovery = (await response.json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      userinfo_endpoint: `${issuer}/oauth2/userinfo`,
      registration_endpoint: `${issuer}/oauth2/register`,
      jwks_uri: `${issuer}/jwks`,
      scopes_supported: ["openid", "profile", "email", "offline_access", "project"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
    // The Codex↔RMCP handoff workaround (src/server/oauth-metadata.ts): `iss`
    // is still emitted on authorization responses but must not be advertised.
    expect(discovery).not.toHaveProperty("authorization_response_iss_parameter_supported");
  });

  test("a third-party client walks registration → authorize → consent → code → token", async () => {
    // Own client so this test always exercises the first-authorization
    // consent hop regardless of what the other tests have done.
    const client = await registerClient(fx.cookie, "happy");

    // 1. authorize: no code before consent — the provider sends the user to
    //    its consent page with the signed OAuth query.
    const authorizeBody = await authorizeJson(authorizeUrlFor(client), fx.cookie);
    const consentTarget = new URL(authorizeBody.url, baseUrl);
    expect(consentTarget.pathname).toBe("/consent");
    expect(consentTarget.searchParams.get("code")).toBeNull();
    expect(consentTarget.searchParams.get("sig")).toBeTruthy();

    // 2. accepting consent redirects to the registered redirect_uri with a
    //    code, the echoed state, and the RFC 9207 iss.
    const callbackUrl = await acceptConsent(authorizeBody.url, fx.cookie);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(client.redirectUri);
    expect(callbackUrl.searchParams.get("state")).toBe(`state-${runId}`);
    expect(callbackUrl.searchParams.get("iss")).toBe(issuer);
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    // 3. token exchange with the RFC 8707 resource OS itself uses.
    // Chrome attaches the extension origin and Fetch Metadata headers to its
    // service-worker fetch. The metadata forces better-auth's origin check;
    // omitting it makes a non-browser test silently skip the failing branch.
    const tokenResponse = await exchangeToken(
      {
        ...codeExchangeBody(client, code!),
        resource: OS_RESOURCE,
      },
      ITERATE_BROWSER_EXTENSION_ORIGIN,
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      id_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens.token_type).toBe("Bearer");
    // 30 minutes — accessTokenExpiresIn in src/server/auth-plugins.ts.
    expect(tokens.expires_in).toBe(1800);
    expect(tokens.scope).toBe("openid profile email offline_access");
    expect(tokens.refresh_token).toBeTruthy();

    // 4. the access token verifies against this deployment's own JWKS and
    //    carries the resource audience plus Iterate's claims.
    const jwksResponse = await authFetch(`${issuer}/jwks`);
    expect(jwksResponse.status).toBe(200);
    const jwks = createLocalJWKSet(await jwksResponse.json());
    const { payload } = await jwtVerify(tokens.access_token, jwks, {
      issuer,
      audience: OS_RESOURCE,
    });
    // The openid scope appends the provider's own userinfo endpoint to aud.
    expect(payload.aud).toEqual([OS_RESOURCE, `${issuer}/oauth2/userinfo`]);
    expect(payload.azp).toBe(client.clientId);
    expect(payload.sub).toBe(fx.user.id);
    expect(payload.scope).toBe("openid profile email offline_access");
    expect(payload[ITERATE_IS_ADMIN_CLAIM]).toBe(false);
    expect(payload[ITERATE_ROLE_CLAIM]).toBe("user");
    expect(payload[ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]).toEqual([
      { id: fx.org.id, name: fx.org.name, slug: fx.org.slug, role: "owner" },
    ]);
    expect(payload[ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]).toEqual([]);

    // 5. the ID token is for this client and subject.
    const idClaims = (await jwtVerify(tokens.id_token, jwks, { issuer, audience: client.clientId }))
      .payload;
    expect(idClaims.sub).toBe(fx.user.id);
    expect(idClaims.email).toBe(email);

    // 6. the bearer works at userinfo (the second audience minted above).
    const userinfo = await authFetch(`${issuer}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(200);
    const profile = (await userinfo.json()) as Record<string, unknown>;
    expect(profile).toMatchObject({ sub: fx.user.id, email, email_verified: true });
    expect(profile[ITERATE_ORGANIZATIONS_CLAIM]).toEqual([
      { id: fx.org.id, name: fx.org.name, slug: fx.org.slug, role: "owner" },
    ]);
  });

  test("login_hint survives into the signed /login redirect for signed-out users", async () => {
    // The mobile preview deep-link flow (specs/mobile/preview-deeplink-hints.spec.ts)
    // depends on this hop: an UNAUTHENTICATED authorize request carrying a
    // login_hint must 302 to /login with the hint still in the query — the
    // login page prefills it and offers "Continue as <email>". The stock
    // @better-auth/oauth-provider authorize endpoint STRIPS undeclared query
    // keys, so this is the executable spec for the login_hint entry in
    // patches/@better-auth__oauth-provider@1.6.9.patch. If a rewrite drops
    // the patch, this test names exactly what must be reimplemented.
    const hint = "pr9999+test@nustom.com";
    // project_hint rides the same patched endpoint schema — a template-carrying
    // login link needs both to survive this hop together.
    const projectHint = "pr9999-template-waiter-chef";
    // No cookie: a fresh phone has no session. Like authorizeJson above, ask
    // for the JSON envelope ({redirect: true, url}) — better-auth serves that
    // to API clients where a browser would get the 302 with the same URL.
    const response = await authFetch(
      authorizeUrlFor(fx.armsClient, { login_hint: hint, project_hint: projectHint }).toString(),
      { headers: { accept: "application/json" }, redirect: "manual" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { redirect: boolean; url: string };
    expect(body.redirect).toBe(true);
    const redirect = new URL(body.url, baseUrl);
    expect(redirect.pathname).toBe("/login");
    expect(redirect.searchParams.get("login_hint")).toBe(hint);
    expect(redirect.searchParams.get("project_hint")).toBe(projectHint);
    // Still the SIGNED redirect — the hint rides inside the signature, so the
    // post-login authorize re-entry can't be tampered with.
    expect(redirect.searchParams.get("sig")).toBeTruthy();
  });

  test("an unregistered redirect_uri never receives a code at authorize time", async () => {
    const body = await authorizeJson(
      authorizeUrlFor(fx.armsClient, { redirect_uri: "https://attacker.example/steal" }),
      fx.cookie,
    );
    // The user lands on the provider's own error page — nothing is sent to
    // the attacker origin.
    const errorUrl = new URL(body.url, baseUrl);
    expect(errorUrl.origin).toBe(new URL(baseUrl).origin);
    expect(errorUrl.pathname).toBe("/api/auth/error");
    expect(errorUrl.searchParams.get("error")).toBe("invalid_redirect");
    expect(errorUrl.searchParams.get("error_description")).toBe("invalid redirect uri");
    expect(errorUrl.searchParams.get("code")).toBeNull();
  });

  test("the token exchange re-validates redirect_uri and burns the code", async () => {
    const code = await mintAuthorizationCode(fx.armsClient, fx.cookie);

    const mismatched = await exchangeToken({
      ...codeExchangeBody(fx.armsClient, code),
      redirect_uri: "https://attacker.example/steal",
    });
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toEqual({
      error: "invalid_request",
      error_description: "redirect_uri mismatch",
    });

    // Codes are single-use at first touch: the failed attempt consumed it, so
    // it cannot be salvaged afterwards with the registered redirect_uri.
    const salvage = await exchangeToken(codeExchangeBody(fx.armsClient, code));
    expect(salvage.status).toBe(401);
    expect(await salvage.json()).toEqual({
      error: "invalid_verification",
      error_description: "Invalid code",
    });
  });

  test("RFC 8707: the incident resource stays allowlisted; unknown resources get the exact protocol error", async () => {
    // Positive control — the exact registration that went stale in the
    // 2026-07-11 incident. The allowlist is compiled into every deployment,
    // so preview/dev prove the production entries too.
    const streamsCode = await mintAuthorizationCode(fx.armsClient, fx.cookie);
    const streamsResponse = await exchangeToken({
      ...codeExchangeBody(fx.armsClient, streamsCode),
      resource: STREAMS_RESOURCE,
    });
    expect(streamsResponse.status).toBe(200);
    const streamsClaims = decodeJwt(
      ((await streamsResponse.json()) as { access_token: string }).access_token,
    );
    expect(streamsClaims.aud).toEqual([STREAMS_RESOURCE, `${issuer}/oauth2/userinfo`]);

    // Rejection arm: a resource outside src/server/oauth-resources.ts.
    const code = await mintAuthorizationCode(fx.armsClient, fx.cookie);
    const rejected = await exchangeToken({
      ...codeExchangeBody(fx.armsClient, code),
      resource: "https://not-an-iterate-resource.example",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "invalid_request",
      error_description: "requested resource invalid",
    });
  });
});
