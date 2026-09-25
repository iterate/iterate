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
// A CALLBACK NEVER THROWS: whatever goes wrong after the provider sends the browser back lands the
// person on the sign-in page with why (`/login?next&error`, 303), split three ways in the logs:
//  - a REFUSAL (`SignInRefused`: an expired or foreign flow, a declined consent, a code the provider
//    will not exchange, an unverified email, a GitHub user who never approved the App's "Email
//    addresses" permission, an identity conflict) is an expected outcome, logged at info as
//    `identity.sign-in-refused` with its `reason`;
//  - the PROVIDER unreachable or answering a server error (`ProviderUnavailable`) is a platform
//    failure, a warn `identity.platform-failure-<step>` the prd fault alarm counts;
//  - anything else is a defect of ours, reported at error level (`identity.sign-in-failed`).
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

const REFUSED = "Sign-in was refused or expired. Please start again.";
/** GitHub answers `/user/emails` 403 to a user token whose user never approved the App's "Email
 *  addresses" account permission — one who authorized the App before it asked for it. GitHub asks
 *  them only on a fresh authorization ("Approving updated permissions for a GitHub App": the App
 *  "will prompt you to reauthorize the app in order to enable the new account permissions"). */
const GITHUB_EMAIL_PERMISSION_MESSAGE =
  "GitHub didn't share your email address with iterate. Revoke iterate at https://github.com/settings/apps/authorizations, then sign in with GitHub again to approve its updated permissions — or sign in another way.";

/** A refusal the person reads on the sign-in page — an expected outcome, never a fault: `reason`
 *  names it in the log, with `details` beside it. */
class SignInRefused extends Error {
  readonly reason: string;
  readonly details: Record<string, string | number | undefined>;
  constructor(
    message: string,
    reason: string,
    details: Record<string, string | number | undefined> = {},
  ) {
    super(message);
    this.reason = reason;
    this.details = details;
  }
}

/** The provider unreachable at `step`, or answering it with a server error: a platform failure. */
class ProviderUnavailable extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.step = step;
  }
}

/** A provider's answer at `step`: a failure to reach it, or a server error or rate limit from it,
 *  is `ProviderUnavailable`. */
async function providerFetch(step: string, input: string, init?: RequestInit) {
  const response = await fetch(input, init).catch((error: unknown) => {
    throw new ProviderUnavailable(step, error);
  });
  if (response.status >= 500 || response.status === 429)
    throw new ProviderUnavailable(step, `${new URL(input).pathname} answered ${response.status}`);
  return response;
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
  /** Google's and Cloudflare's OpenID configuration (GitHub has none). */
  const discover = () =>
    client.issuer
      ? oauth
          .discoveryRequest(client.issuer)
          .then((response) => oauth.processDiscoveryResponse(client.issuer!, response))
          .catch((error: unknown) => {
            throw new ProviderUnavailable("discovery", error);
          })
      : null;
  const { platformOrigin } = platformAddressesOf(env, request);
  const redirectUri = `${platformOrigin}${PATHS[provider]}/callback`;
  const signingSecret = await sessionSigningSecretOf(config);
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  /** Off to the provider's authorize page, the flow in a signed cookie. */
  const authorize = async (
    as: oauth.AuthorizationServer | null,
    flow: Flow,
    consentFor?: string,
  ) => {
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
      await discover(),
      newFlow(sameOriginPath(url.searchParams.get("next") || "/", platformOrigin), false),
    );
  headers.append("Set-Cookie", `${cookie}=; ${cookieAttributes}; Max-Age=0`);
  /** Back to the sign-in page, `error` on it. */
  const toSignInPage = (next: string, error: string) => {
    headers.set("Location", `/login?${new URLSearchParams({ next, error })}`);
    return new Response(null, { status: 303, headers });
  };
  const refused = (next: string, refusal: SignInRefused) => {
    console.info({
      ...refusal.details,
      event: "identity.sign-in-refused",
      provider,
      reason: refusal.reason,
    });
    return toSignInPage(next, refusal.message);
  };
  const signed = cookieValueOf(request.headers.get("cookie"), cookie);
  const parsedFlow = Flow.safeParse(signed && (await verifyClaims(signed, signingSecret)));
  if (
    !parsedFlow.success ||
    parsedFlow.data.expiresAt <= Date.now() ||
    parsedFlow.data.provider !== provider ||
    parsedFlow.data.clientId !== client.clientId ||
    parsedFlow.data.redirectUri !== redirectUri
  )
    return refused("/", new SignInRefused("Sign-in expired. Please start again.", "flow-expired"));
  const flow = parsedFlow.data;
  try {
    const as = await discover();
    const signedIn = as
      ? await oidcSignIn(as, client, url, flow, redirectUri)
      : await githubSignIn(client, url, flow, redirectUri);
    const { identity } = signedIn;
    if (client.fake) {
      const refusal = fakeProviderEmailRefusal(
        identity.email,
        config.login.testLink?.emailDomain ?? null,
      );
      if (refusal)
        throw new SignInRefused(`${NAMES[provider]}: ${refusal}.`, "fake-provider-email");
    }
    if (!emailAllowed(config.login.allowedEmails, identity.email))
      throw new SignInRefused(EMAIL_NOT_ALLOWED_MESSAGE, "email-not-allowed");
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
      return authorize(as, newFlow(flow.next, true), identity.email);
    // The person is signed in whatever becomes of the token: a failure to keep it is reported, and
    // the next sign-in (or a connect) keeps one.
    await keepSignInToken(env, client, provider, user, signedIn, connection).catch(
      (error: unknown) => reportIssue("identity.keep-token-failed", error, { provider }),
    );
    const session = await startIssuerSession(env, request, user, flow.next, {
      picture: identity.picture,
      name: identity.name,
    });
    // its failures are logged where they happen (issuer-session.ts)
    if ("error" in session) return toSignInPage(flow.next, session.error);
    headers.append("Set-Cookie", session.setCookie);
    headers.set("Location", session.location);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    if (error instanceof SignInRefused) return refused(flow.next, error);
    if (errorCode(error) === "IDENTITY_CONFLICT")
      return refused(
        flow.next,
        new SignInRefused(
          error instanceof Error ? error.message : "Account identity conflict",
          "identity-conflict",
        ),
      );
    if (
      error instanceof oauth.AuthorizationResponseError ||
      error instanceof oauth.OperationProcessingError ||
      (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant")
    )
      return refused(flow.next, new SignInRefused(REFUSED, "provider-refused"));
    if (error instanceof ProviderUnavailable) {
      console.warn({
        event: `identity.platform-failure-${error.step}`,
        provider,
        message: error.message,
      });
      return toSignInPage(flow.next, `${NAMES[provider]} didn't answer. Please try again.`);
    }
    reportIssue("identity.sign-in-failed", error, { provider });
    return toSignInPage(flow.next, `Sign-in with ${NAMES[provider]} failed. Please try again.`);
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
  const response = await oauth
    .authorizationCodeGrantRequest(
      as,
      oauthClient,
      oauth.ClientSecretPost(client.clientSecret),
      parameters,
      redirectUri,
      flow.verifier,
    )
    .catch((error: unknown) => {
      throw new ProviderUnavailable("token", error);
    });
  if (response.status >= 500 || response.status === 429)
    throw new ProviderUnavailable("token", `the token endpoint answered ${response.status}`);
  const tokens = await oauth.processAuthorizationCodeResponse(as, oauthClient, response, {
    expectedNonce: flow.nonce,
    requireIdToken: true,
  });
  await oauth.validateApplicationLevelSignature(as, response);
  const identity = VerifiedIdentity.safeParse(oauth.getValidatedIdTokenClaims(tokens));
  if (!identity.success)
    throw new SignInRefused(
      `${NAMES[flow.provider]} must verify your email before you can sign in.`,
      "email-unverified",
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
    throw new SignInRefused(REFUSED, "provider-refused");
  const exchange = await providerFetch("token", client.tokenEndpoint, {
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
  // GitHub refuses an exchange (a spent or foreign code) with HTTP 200 and an `error`
  if (!isRecord(tokens) || typeof tokens.access_token !== "string")
    throw new SignInRefused(REFUSED, "provider-refused", {
      error: isRecord(tokens) && typeof tokens.error === "string" ? tokens.error : undefined,
    });
  const accessToken = tokens.access_token;
  const github = async (path: "/user" | "/user/emails") => {
    const response = await providerFetch(
      path === "/user" ? "user" : "emails",
      `${client.apiOrigin}${path}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "iterate",
        },
      },
    );
    // the user never approved the App's "Email addresses" permission; GitHub names what it wanted
    if (path === "/user/emails" && response.status === 403)
      throw new SignInRefused(GITHUB_EMAIL_PERMISSION_MESSAGE, "github-email-permission", {
        acceptedPermissions: response.headers.get("x-accepted-github-permissions") ?? undefined,
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
    throw new SignInRefused(
      "GitHub must verify your primary email before you can sign in.",
      "email-unverified",
    );
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
