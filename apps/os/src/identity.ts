// identity.ts — SIGN IN WITH GOOGLE, CLOUDFLARE OR GITHUB. The provider proves who someone is; its
// credentials never authorize our API. The person is their (provider, subject), linked once by
// verified email (control-plane/catalog.ts `linkIdentity`).
//
// A SIGN-IN KEEPS ITS TOKEN: each provider's one OAuth client serves signing in and connecting
// (APP_CONFIG `integrations.<provider>`: a refresh token only works with the client that issued it),
// so the token the sign-in was given, with the scopes `login.<provider>.scopes` asked for and the
// provider granted, becomes the person's own connection — the secret
// `global:/users/<id>/secrets/<provider>-<subject>`, in the record an integration's callback writes
// for iterate's client (`client: { platform }`), and a platform `<provider>/connected` on
// `/users/<id>`, folded into the account's `state.integrations`. Google issues a refresh token only
// on a consent, so a first sign-in that got none goes back once for the consent screen; a later
// one keeps the refresh token already stored. GitHub is the App's user authorization: its user
// token acts with the App's permissions, and its primary verified address is the email.
//
// A provider pointed at a FAKE (a preview's pet shop, which mints any address) signs in addresses
// under `login.testLink.emailDomain` alone (integrations/rules.ts `fakeProviderEmailRefusal`).
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { cookieValueOf, errorCode, reportIssue, sameOriginPath } from "iterate/lib";
import { signClaims, verifyClaims } from "./caller.ts";
import type { Env } from "./env.ts";
import { EMAIL_NOT_ALLOWED_MESSAGE, emailAllowed } from "./allowed-emails.ts";
import {
  appConfigOf,
  platformAddressesOf,
  sessionSigningSecretOf,
  type AppConfig,
} from "./app-config.ts";
import { startIssuerSession } from "./issuer-session.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import type { UserRecord } from "./control-plane/catalog.ts";
import { IdentityProvider } from "./control-plane/contract.ts";
import type { AccountState } from "./account/contract.ts";
import { appendPlatformFacts, ownerContext } from "./session.ts";
import { cloudflareEndpointsOf } from "./integrations/cloudflare.ts";
import { githubApiOriginOf } from "./integrations/github.ts";
import { googleEndpointsOf } from "./integrations/google.ts";
import { tokenSecretPathOf } from "./integrations/connections.ts";
import {
  fakeProviderEmailRefusal,
  signInAuthorizeParams,
  signInNeedsConsent,
} from "./integrations/rules.ts";
import { isRecord } from "./secrets.ts";

const PATHS = {
  google: "/.auth/identity",
  cloudflare: "/.auth/identity/cloudflare",
  github: "/.auth/identity/github",
} satisfies Record<IdentityProvider, string>;
const NAMES = { google: "Google", cloudflare: "Cloudflare", github: "GitHub" };
const cookieAttributes = "HttpOnly; Secure; SameSite=Lax; Path=/";
const Flow = z.object({
  kind: z.literal("identity-login"),
  provider: IdentityProvider,
  clientId: z.string(),
  redirectUri: z.string(),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  next: z.string(),
  expiresAt: z.number(),
  /** Google went back for the consent screen once already (`signInNeedsConsent`). */
  bounced: z.boolean().default(false),
});
type Flow = z.infer<typeof Flow>;
const VerifiedIdentity = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.literal(true),
  /** the account's picture and display name (the `profile` scope): the consent page's "signed in
   *  as", and the onboarding step's suggested organization name */
  picture: z.url().optional(),
  name: z.string().optional(),
});

/** A sign-in's answer: who, and the token it keeps. */
type SignedIn = {
  identity: z.infer<typeof VerifiedIdentity>;
  /** What the provider calls the account (an address, a GitHub login). */
  account: string;
  tokens: { accessToken: string; refreshToken?: string };
  scopes: string[];
};

/** A provider's sign-in client for this deployment, or null when it is off: its client (the
 *  integration's), what the sign-in asks for, where it answers, and the connection secret's pin and
 *  refresh endpoint. */
function signInClientOf(config: AppConfig, provider: IdentityProvider) {
  const { google, cloudflare, github } = config.integrations;
  if (provider === "google" && google && config.login.google) {
    const endpoints = googleEndpointsOf(google.googleOrigin);
    return {
      clientId: google.oauthClientId,
      clientSecret: google.oauthClientSecret.exposeSecret(),
      scopes: config.login.google.scopes,
      issuer: new URL(google.googleOrigin || "https://accounts.google.com"),
      fake: Boolean(google.googleOrigin),
      urls: endpoints.urls,
      tokenEndpoint: endpoints.tokenEndpoint,
    };
  }
  if (provider === "cloudflare" && cloudflare && config.login.cloudflare) {
    const endpoints = cloudflareEndpointsOf(cloudflare.cloudflareOrigin);
    return {
      clientId: cloudflare.oauthClientId,
      clientSecret: cloudflare.oauthClientSecret.exposeSecret(),
      scopes: config.login.cloudflare.scopes,
      issuer: new URL(endpoints.issuer),
      fake: Boolean(cloudflare.cloudflareOrigin),
      urls: endpoints.urls,
      tokenEndpoint: endpoints.tokenEndpoint,
    };
  }
  if (provider === "github" && github && config.login.github) {
    const apiOrigin = githubApiOriginOf(github.githubOrigin);
    return {
      clientId: github.oauthClientId,
      clientSecret: github.oauthClientSecret.exposeSecret(),
      scopes: [],
      issuer: null,
      githubOrigin: github.githubOrigin,
      apiOrigin,
      fake: github.githubOrigin !== "https://github.com",
      urls: [...new Set([github.githubOrigin, apiOrigin])],
      tokenEndpoint: `${github.githubOrigin}/login/oauth/access_token`,
    };
  }
  return null;
}
type SignInClient = NonNullable<ReturnType<typeof signInClientOf>>;

/** A refusal the person reads: the sign-in page's words, never a stack. */
class SignInRefused extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function identityResponse(request: Request, env: Env) {
  const url = new URL(request.url);
  const provider = (["cloudflare", "github", "google"] as const).find((name) =>
    [PATHS[name], `${PATHS[name]}/callback`].includes(url.pathname),
  );
  if (!provider) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const config = appConfigOf(env);
  const client = signInClientOf(config, provider);
  if (!client) return new Response(`${NAMES[provider]} sign-in is not configured`, { status: 503 });
  const cookie = `__Host-itx-${provider}-identity-flow`;
  const as = client.issuer
    ? await oauth
        .discoveryRequest(client.issuer)
        .then((response) => oauth.processDiscoveryResponse(client.issuer!, response))
    : null;
  const { platformOrigin } = platformAddressesOf(env, request);
  const redirectUri = `${platformOrigin}${PATHS[provider]}/callback`;
  const signingSecret = await sessionSigningSecretOf(config);
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  /** Off to the provider's authorize page, the flow in a signed cookie. */
  const authorize = async (flow: Flow, consentFor?: string) => {
    const authorization = new URL(
      as ? as.authorization_endpoint! : `${client.githubOrigin}/login/oauth/authorize`,
    );
    authorization.search = new URLSearchParams(
      signInAuthorizeParams(provider, {
        clientId: client.clientId,
        redirectUri,
        scopes: client.scopes,
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: await oauth.calculatePKCECodeChallenge(flow.verifier),
        consentFor,
      }),
    ).toString();
    const flowCookie = `${cookie}=${await signClaims(flow, signingSecret)}; ${cookieAttributes}; Max-Age=600`;
    if (new TextEncoder().encode(flowCookie).length > 4096)
      return new Response("The sign-in request exceeds the browser cookie limit.", { status: 400 });
    headers.set("Set-Cookie", flowCookie);
    headers.set("Location", authorization.href);
    return new Response(null, { status: 302, headers });
  };
  const newFlow = (next: string, bounced: boolean): Flow => ({
    kind: "identity-login",
    provider,
    clientId: client.clientId,
    redirectUri,
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    verifier: oauth.generateRandomCodeVerifier(),
    next,
    expiresAt: Date.now() + 600_000,
    bounced,
  });
  if (url.pathname === PATHS[provider])
    return authorize(
      newFlow(sameOriginPath(url.searchParams.get("next") || "/", platformOrigin), false),
    );
  headers.append("Set-Cookie", `${cookie}=; ${cookieAttributes}; Max-Age=0`);
  const signed = cookieValueOf(request.headers.get("cookie"), cookie);
  const parsedFlow = Flow.safeParse(signed && (await verifyClaims(signed, signingSecret)));
  if (
    !parsedFlow.success ||
    parsedFlow.data.expiresAt <= Date.now() ||
    parsedFlow.data.provider !== provider ||
    parsedFlow.data.clientId !== client.clientId ||
    parsedFlow.data.redirectUri !== redirectUri
  )
    return new Response("Sign-in expired. Please start again.", { status: 400, headers });
  const flow = parsedFlow.data;
  try {
    const signedIn = as
      ? await oidcSignIn(as, client, url, flow, redirectUri)
      : await githubSignIn(client, url, flow, redirectUri);
    const { identity } = signedIn;
    if (client.fake) {
      const refusal = fakeProviderEmailRefusal(
        identity.email,
        config.login.testLink?.emailDomain ?? null,
      );
      if (refusal) throw new SignInRefused(`${NAMES[provider]}: ${refusal}.`, 403);
    }
    if (!emailAllowed(config.login.allowedEmails, identity.email)) {
      const query = new URLSearchParams({ next: flow.next, error: EMAIL_NOT_ALLOWED_MESSAGE });
      headers.set("Location", `/login?${query}`);
      return new Response(null, { status: 303, headers });
    }
    // The provider and its stable subject together name the person (the control plane's rule: link
    // once by verified email, then by the subject); an email change cannot change the actor.
    const user = await new ControlPlane(env).linkIdentity(provider, identity.sub, identity.email);
    const connection = await personConnectionOf(env, user, provider, identity.sub);
    if (
      signInNeedsConsent({
        provider,
        refreshToken: Boolean(signedIn.tokens.refreshToken),
        connected: Boolean(connection),
        bounced: flow.bounced,
      })
    )
      return authorize(newFlow(flow.next, true), identity.email);
    // The person is signed in whatever becomes of the token: a failure to keep it is reported, and
    // the next sign-in (or a connect) keeps one.
    await keepSignInToken(env, client, provider, user, signedIn, connection).catch(
      (error: unknown) => reportIssue("identity.keep-token-failed", error, { provider }),
    );
    const session = await startIssuerSession(env, request, user, flow.next, {
      picture: identity.picture,
      name: identity.name,
    });
    if ("error" in session) {
      const query = new URLSearchParams({ next: flow.next, error: session.error });
      headers.set("Location", `/login?${query}`);
      return new Response(null, { status: 303, headers });
    }
    headers.append("Set-Cookie", session.setCookie);
    headers.set("Location", session.location);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    if (error instanceof SignInRefused)
      return new Response(error.message, { status: error.status, headers });
    if (errorCode(error) === "IDENTITY_CONFLICT")
      return new Response(error instanceof Error ? error.message : "Account identity conflict", {
        status: 409,
        headers,
      });
    if (
      error instanceof oauth.AuthorizationResponseError ||
      error instanceof oauth.OperationProcessingError ||
      (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant")
    )
      return new Response("Sign-in was refused or expired. Please start again.", {
        status: 400,
        headers,
      });
    throw error;
  }
}

/** Google's and Cloudflare's answer: the code exchanged (PKCE, the nonce checked), the ID token's
 *  verified claims, the tokens and the scopes the provider says it granted. */
async function oidcSignIn(
  as: oauth.AuthorizationServer,
  client: SignInClient,
  url: URL,
  flow: Flow,
  redirectUri: string,
): Promise<SignedIn> {
  const oauthClient = { client_id: client.clientId };
  const parameters = oauth.validateAuthResponse(as, oauthClient, url, flow.state);
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    oauthClient,
    oauth.ClientSecretPost(client.clientSecret),
    parameters,
    redirectUri,
    flow.verifier,
  );
  const tokens = await oauth.processAuthorizationCodeResponse(as, oauthClient, response, {
    expectedNonce: flow.nonce,
    requireIdToken: true,
  });
  await oauth.validateApplicationLevelSignature(as, response);
  const identity = VerifiedIdentity.safeParse(oauth.getValidatedIdTokenClaims(tokens));
  if (!identity.success)
    throw new SignInRefused(
      `${NAMES[flow.provider]} must verify your email before you can sign in.`,
      403,
    );
  return {
    identity: identity.data,
    account: identity.data.email,
    tokens: {
      accessToken: tokens.access_token,
      // absent, not undefined: the merge that keeps a stored refresh token spreads these fields
      // oxlint-disable-next-line iterate/simple-truthiness-check -- a key present as undefined would overwrite the stored refresh token in the merge
      ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
    },
    scopes: tokens.scope ? tokens.scope.split(" ") : [...client.scopes],
  };
}

/** GitHub's answer: the App's user token for the code, the user, and their primary verified
 *  address — GitHub's user authorization is OAuth without OpenID Connect. */
async function githubSignIn(
  client: SignInClient,
  url: URL,
  flow: Flow,
  redirectUri: string,
): Promise<SignedIn> {
  if (url.searchParams.get("state") !== flow.state || url.searchParams.get("error"))
    throw new SignInRefused("Sign-in was refused or expired. Please start again.", 400);
  const exchange = await fetch(client.tokenEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: url.searchParams.get("code") || "",
      redirect_uri: redirectUri,
      code_verifier: flow.verifier,
    }),
  });
  const tokens: unknown = await exchange.json().catch(() => null);
  if (!isRecord(tokens) || typeof tokens.access_token !== "string")
    throw new SignInRefused("Sign-in was refused or expired. Please start again.", 400);
  const accessToken = tokens.access_token;
  const github = async (path: string) => {
    const response = await fetch(`${client.apiOrigin}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "iterate",
      },
    });
    if (!response.ok) throw new Error(`GitHub's ${path} answered ${response.status}`);
    return (await response.json()) as unknown;
  };
  const user = z
    .object({
      id: z.number(),
      login: z.string(),
      name: z.string().nullish(),
      avatar_url: z.url().optional(),
    })
    .parse(await github("/user"));
  const emails = z
    .array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }))
    .parse(await github("/user/emails"));
  const primary = emails.find((email) => email.primary && email.verified);
  if (!primary)
    throw new SignInRefused("GitHub must verify your primary email before you can sign in.", 403);
  return {
    identity: {
      sub: String(user.id),
      email: primary.email,
      email_verified: true,
      picture: user.avatar_url,
      name: user.name || user.login,
    },
    account: user.login,
    tokens: {
      accessToken,
      ...(typeof tokens.refresh_token === "string" && { refreshToken: tokens.refresh_token }),
    },
    scopes: [],
  };
}

/** The person's own context: `global:/users/<id>`. */
const personContext = (env: Env, user: UserRecord) =>
  ownerContext(env.ITERATE_CONTEXT, { account: user.id });

/** The name of the person's connection to this account at the provider — one a connect made
 *  before (under its own name), or a sign-in's (named by the subject) — or null. */
async function personConnectionOf(
  env: Env,
  user: UserRecord,
  provider: IdentityProvider,
  subject: string,
): Promise<string | null> {
  // The platform's own read of the account facet; `invoke` is untyped across the DO hop, and
  // `snapshot` answers the account contract's state.
  const { state } = (await personContext(env, user).invoke(
    ["itx", "builtins", "facets", ["get", "account"], ["snapshot"]],
    [],
    { principal: { actor: user.id, email: user.email } },
  )) as { state: AccountState };
  const row = Object.values(state.integrations).find(
    (known) => known.provider === provider && known.externalId === subject,
  );
  return row?.connection ?? null;
}

/** The sign-in's token as the person's own connection — the one they hold to this account already,
 *  or a new one named by the subject: the secret (the stored refresh token kept when this answer
 *  brought none), then `<provider>/connected` on their account. */
async function keepSignInToken(
  env: Env,
  client: SignInClient,
  provider: IdentityProvider,
  user: UserRecord,
  signedIn: SignedIn,
  existing: string | null,
): Promise<void> {
  const caller = { principal: { actor: user.id, email: user.email } };
  const connection = existing || signedIn.identity.sub;
  const merge = Boolean(existing) && !signedIn.tokens.refreshToken;
  await personContext(env, user).invoke(["itx", "processors", ["enable", "account"]], [], caller);
  await personContext(env, user).invoke(
    [
      "itx",
      "builtins",
      "secrets",
      [
        "set",
        tokenSecretPathOf(provider, connection),
        signedIn.tokens,
        {
          urls: client.urls,
          ...((signedIn.tokens.refreshToken || merge) && {
            refresh: {
              kind: "oauth-refresh-token",
              tokenEndpoint: client.tokenEndpoint,
              clientAuth: "client_secret_post",
              client: { platform: provider },
            },
          }),
          merge,
        },
      ],
    ],
    [],
    caller,
  );
  await appendPlatformFacts(
    env.ITERATE_CONTEXT,
    { account: user.id },
    {
      type: `events.iterate.com/${provider}/connected`,
      payload: {
        connection,
        client: "iterate",
        account: signedIn.account,
        externalId: signedIn.identity.sub,
        ...(signedIn.scopes.length > 0 && { scopes: signedIn.scopes }),
      },
    },
    caller,
    { folded: true },
  );
}
