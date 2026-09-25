import { env, exports } from "cloudflare:workers";
import { expect, onTestFinished, test, vi } from "vitest";
import { appSession } from "iterate/app-server";
import { DEFAULT_GOOGLE_SIGN_IN_SCOPES, platformAddressesOf } from "../src/app-config.ts";
import { authorizationForToken } from "../src/oauth.ts";
import { fakeUserIdOf } from "../../dummy-petshop/src/state.ts";
import type { AccountState } from "../src/account/contract.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import {
  controlPlane,
  followConsent,
  ORIGIN,
  petshopFakes,
  signedInMember,
  stub,
} from "./support.ts";

test("Google proves issuer identity; upstream credentials never become app tokens", async () => {
  const response = await identityLogin("google");
  expect(response, await response.clone().text()).toMatchObject({ status: 303 });
  expect(response.headers.get("location")).toBe("/oauth2/auth?client=test");
  const cookies = response.headers.getSetCookie();
  expect(cookies.join()).not.toContain("upstream-google-access-token");
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("__Host-itx-session="))!;
  const session = appSession(
    env.BROWSER_SESSION,
    new Request(ORIGIN, { headers: { cookie: sessionCookie } }),
  )!;
  const auth = await authorizationForToken(
    env,
    (await session.bearer())!,
    platformAddressesOf(env, new Request(`${ORIGIN}/`)),
    "browser-session",
  );
  // the person's id is minted by the control plane; Google's subject names them from now on
  expect(auth?.principal).toEqual({
    actor: expect.stringMatching(/^user_[0-9a-f]{32}$/),
    email: "verified@signin.test",
  });
  expect(await controlPlane().identity("google", "1234567890")).toEqual({
    id: auth?.principal.actor,
    email: "verified@signin.test",
  });
  expect(auth?.grant?.kind).toBe("issuer");
  const api = await exports.default.fetch(`${ORIGIN}/api`, {
    method: "POST",
    body: "",
    headers: { cookie: sessionCookie, origin: ORIGIN },
  });
  expect(api).toMatchObject({ status: 200 });
  expect(cookies).toHaveLength(2); // Cleared Google flow plus the sole app-session cookie.
});

test("Google subject keeps the same principal when its verified email changes", async () => {
  expect(await identityLogin("google")).toMatchObject({ status: 303 });
  const before = await controlPlane().identity("google", "1234567890");
  expect(before).toEqual({ id: expect.stringMatching(/^user_/), email: "verified@signin.test" });
  const response = await identityLogin("google", { email: "changed@signin.test" });
  expect(response).toMatchObject({ status: 303 });
  // the subject still names the same user; the email followed it
  expect(await controlPlane().identity("google", "1234567890")).toEqual({
    id: before!.id,
    email: "changed@signin.test",
  });
  expect(await controlPlane().getUser(before!.id)).toEqual({
    id: before!.id,
    email: "changed@signin.test",
  });
  expect(await controlPlane().getUser("verified@signin.test")).toBeNull();
});

test("wrong nonce, signature and unverified email cannot establish issuer identity", async () => {
  for (const [claims, badSignature, status] of [
    [{ nonce: "foreign-browser" }, false, 400],
    [{}, true, 400],
    [{ email_verified: false }, false, 403],
  ] as const) {
    const response = await identityLogin("google", claims, badSignature);
    expect(response).toMatchObject({ status });
    expect(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
    ).toBe(false);
  }
});

test("an email alone never makes a session: a code follows it; only the administrator credential signs a fixture straight in", async () => {
  const response = await exports.default.fetch(`${ORIGIN}/login`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ email: "unverified@example.com" }),
  });
  expect(response).toMatchObject({ status: 303 });
  expect(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
  ).toBe(false);
  expect(
    await exports.default.fetch("https://unknown.projects.test/.auth/identity/callback"),
  ).toMatchObject({ status: 421 });
});

test("verified Google identity adopts a fixture account once and cannot take another linked identity", async () => {
  // the rules are the control plane's (src/control-plane/catalog.ts `linkIdentity`)
  const registry = controlPlane();
  const fixture = await registry.ensureUser("fixture@identity.test");
  expect(fixture).toEqual({ id: expect.stringMatching(/^user_/), email: "fixture@identity.test" });
  const linked = await registry.linkIdentity("google", "fixture-subject", fixture.email);
  expect(linked).toEqual(fixture);
  // a second Google identity cannot adopt an already-linked account (the processor's rule: "link
  // once by verified email, then resolve by the provider's stable subject")
  await expect(
    registry.linkIdentity("google", "different-subject", fixture.email),
  ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
  expect(await registry.identity("google", "different-subject")).toBeNull();
  // the linked subject's email change follows it: the old address is free again
  const changed = await registry.linkIdentity("google", "fixture-subject", "new@identity.test");
  expect(changed).toEqual({ id: fixture.id, email: "new@identity.test" });
  const oldEmail = await registry.ensureUser("fixture@identity.test");
  expect(oldEmail).not.toMatchObject({ id: fixture.id });
  expect(await registry.ensureUser(changed.email)).toEqual(changed);
  // but not onto an address another account holds
  await expect(
    registry.linkIdentity("google", "fixture-subject", oldEmail.email),
  ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
  expect(await registry.identity("google", "fixture-subject")).toEqual(changed);
});

test("Cloudflare's verified ID token creates the same revocable issuer session, with no deployment grant", async () => {
  const response = await identityLogin("cloudflare", {
    sub: "cf-user",
    email: "cloudflare@signin.test",
  });
  expect(response, await response.clone().text()).toMatchObject({ status: 303 });
  expect(response.headers.get("location")).toBe("/oauth2/auth?client=test");
  const cookies = response.headers.getSetCookie();
  expect(cookies.join()).not.toContain("upstream-google-access-token");
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("__Host-itx-session="))!;
  const session = appSession(
    env.BROWSER_SESSION,
    new Request(ORIGIN, { headers: { cookie: sessionCookie } }),
  )!;
  const auth = await authorizationForToken(
    env,
    (await session.bearer())!,
    platformAddressesOf(env, new Request(ORIGIN)),
    "browser-session",
  );
  expect(auth?.principal).toEqual({
    actor: expect.stringMatching(/^user_[0-9a-f]{32}$/),
    email: "cloudflare@signin.test",
  });
  expect(auth?.grant?.kind).toBe("issuer");
});

test.for([
  { name: "wrong nonce", claims: { nonce: "other-browser" }, status: 400 },
  { name: "wrong audience", claims: { aud: "another-client" }, status: 400 },
  { name: "wrong issuer", claims: { iss: "https://google.test" }, status: 400 },
  { name: "expired token", claims: { exp: 1 }, status: 400 },
  { name: "unverified email", claims: { email_verified: false }, status: 403 },
  { name: "missing email verification", claims: { email_verified: undefined }, status: 403 },
  { name: "missing email", claims: { email: undefined }, status: 403 },
  { name: "bad signature", claims: {}, signature: true, status: 400 },
  { name: "wrong state", claims: {}, state: true, status: 400 },
])(
  "Cloudflare refuses $name without creating a session",
  async ({ claims, signature, state, status }) => {
    const response = await identityLogin("cloudflare", claims, signature, state);
    expect(response).toMatchObject({ status });
    expect(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
    ).toBe(false);
  },
);

test("provider subjects are independent, while verified email links Google and Cloudflare to the same user", async () => {
  const registry = controlPlane();
  const google = await registry.linkIdentity("google", "same-subject", "google-only@identity.test");
  const cloudflare = await registry.linkIdentity(
    "cloudflare",
    "same-subject",
    "cf-only@identity.test",
  );
  expect(google).not.toMatchObject({ id: cloudflare.id });
  // a Cloudflare subject adopts the Google-linked person by verified email — one subject per
  // provider, so a second Cloudflare subject cannot
  const linked = await registry.linkIdentity("cloudflare", "linked-cf", google.email);
  expect(linked).toEqual(google);
  await expect(
    registry.linkIdentity("cloudflare", "another-cf", google.email),
  ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
  // a subject linked to one person cannot take another person's email
  await expect(
    registry.linkIdentity("cloudflare", "same-subject", google.email),
  ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
  expect(await registry.identity("cloudflare", "same-subject")).toEqual(cloudflare);
});

test.for(["provider mismatch", "declined consent"])(
  "identity callback refuses %s before exchanging a code",
  async (failure) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        const issuer = url.href.slice(0, -"/.well-known/openid-configuration".length);
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/auth`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      if (url.origin === ORIGIN) return exports.default.fetch(new Request(input, init));
      throw new Error(`Unexpected token exchange for ${failure}`);
    });
    onTestFinished(() => {
      fetchSpy.mockRestore();
    });
    const begin = await exports.default.fetch(`${ORIGIN}/.auth/identity/cloudflare`, {
      redirect: "manual",
    });
    const authorization = new URL(begin.headers.get("location")!);
    let cookie = begin.headers.get("set-cookie")!.split(";")[0]!;
    let path = "/.auth/identity/cloudflare/callback";
    const params = new URLSearchParams({ state: authorization.searchParams.get("state")! });
    if (failure === "provider mismatch") {
      path = "/.auth/identity/callback";
      cookie = cookie.replace(
        "__Host-itx-cloudflare-identity-flow",
        "__Host-itx-google-identity-flow",
      );
      params.set("code", "cloudflare-code");
    } else {
      params.set("error", "access_denied");
    }
    const response = await exports.default.fetch(`${ORIGIN}${path}?${params}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(response).toMatchObject({ status: 400 });
    expect(
      response.headers.getSetCookie().some((value) => value.startsWith("__Host-itx-session=")),
    ).toBe(false);
  },
);

// A SIGN-IN KEEPS ITS TOKEN (identity.ts): through the pet shop's fakes, iterate's one client per
// provider signs the person in and their token becomes their own connection — the secret on
// `/users/<id>` and the row the account folds — which their own egress then uses.
test("Google: a first sign-in with no refresh token goes back once for the consent screen, and the person's connection holds the refresh token and the granted scopes", async () => {
  const petshop = petshopFakes();
  const email = "ada@signin.test";
  const { response, authorizations } = await signInThroughFake(petshop, "google", { email });
  expect(response, await response.clone().text()).toMatchObject({ status: 303 });
  // the account picker every time; the consent screen once more for the refresh token
  expect(authorizations.map((url) => url.searchParams.get("prompt"))).toEqual([
    "select_account",
    "select_account consent",
  ]);
  expect(authorizations[1]!.searchParams.get("login_hint")).toBe(email);
  const subject = String(fakeUserIdOf(email));
  const { person, account } = await personOf("google", subject);
  expect(account).toMatchObject({
    integrations: {
      [`/integrations/google/${subject}`]: {
        provider: "google",
        connection: subject,
        client: "iterate",
        account: email,
        externalId: subject,
        scopes: DEFAULT_GOOGLE_SIGN_IN_SCOPES,
      },
    },
    secrets: {
      [`/secrets/google-${subject}`]: {
        urls: ["https://google.test"],
        refresh: "oauth-refresh-token",
      },
    },
  });
  // the person's own egress uses it; a forced expiry refreshes through iterate's client
  await petshop.state.expireAccessTokens("petshop-default");
  const profile = await person.fetch(
    new Request("https://google.test/gmail/v1/users/me/profile", {
      headers: {
        authorization: `Bearer getSecret("/secrets/google-${subject}", { field: "accessToken" })`,
      },
    }),
  );
  expect(await profile.json()).toMatchObject({ emailAddress: email });
  // signing in again brings no refresh token and asks nothing more: the stored one is kept
  const again = await signInThroughFake(petshop, "google", { email });
  expect(again.response).toMatchObject({ status: 303 });
  expect(again.authorizations).toHaveLength(1);
  await petshop.state.expireAccessTokens("petshop-default");
  const refreshed = await person.fetch(
    new Request("https://google.test/oauth2/v2/userinfo", {
      headers: {
        authorization: `Bearer getSecret("/secrets/google-${subject}", { field: "accessToken" })`,
      },
    }),
  );
  expect(refreshed).toMatchObject({ status: 200 });
});

test("Cloudflare and GitHub: the sign-in's token is the person's connection, refreshed through iterate's client", async () => {
  const petshop = petshopFakes();
  const cloudflare = await signInThroughFake(petshop, "cloudflare", { email: "cy@signin.test" });
  expect(cloudflare.response, await cloudflare.response.clone().text()).toMatchObject({
    status: 303,
  });
  const github = await signInThroughFake(petshop, "github", {
    login: "gh-ada",
    email: "gh-ada@signin.test",
  });
  expect(github.response, await github.response.clone().text()).toMatchObject({ status: 303 });
  for (const [provider, subject, account, api] of [
    [
      "cloudflare",
      String(fakeUserIdOf("cy@signin.test")),
      "cy@signin.test",
      "https://cloudflare.test/client/v4/user",
    ],
    ["github", String(fakeUserIdOf("gh-ada")), "gh-ada", "https://github.test/user"],
  ] as const) {
    const { person, account: state } = await personOf(provider, subject);
    expect(state.integrations[`/integrations/${provider}/${subject}`]).toMatchObject({
      account,
      externalId: subject,
    });
    expect(state.secrets[`/secrets/${provider}-${subject}`]).toMatchObject({
      refresh: "oauth-refresh-token",
    });
    await petshop.state.expireAccessTokens("petshop-default");
    const used = await person.fetch(
      new Request(api, {
        headers: {
          authorization: `Bearer getSecret("/secrets/${provider}-${subject}", { field: "accessToken" })`,
          "user-agent": "iterate",
        },
      }),
    );
    expect(used, `${provider}: ${await used.clone().text()}`).toMatchObject({ status: 200 });
  }
});

test("a person disconnects the connection a Cloudflare or GitHub sign-in kept, and their account lists it no more", async () => {
  const petshop = petshopFakes();
  for (const [provider, choices, subject] of [
    ["cloudflare", { email: "dc@signin.test" }, String(fakeUserIdOf("dc@signin.test"))],
    ["github", { login: "gh-dc", email: "gh-dc@signin.test" }, String(fakeUserIdOf("gh-dc"))],
  ] as const) {
    expect((await signInThroughFake(petshop, provider, choices)).response).toMatchObject({
      status: 303,
    });
    const { user, person } = await personOf(provider, subject);
    await person.invoke(
      [
        "itx",
        "facets",
        ["get", "account"],
        ["disconnectIntegration", { provider, connection: subject }],
      ],
      [],
      { principal: { actor: user.id, email: user.email } },
    );
    expect(Object.keys((await personOf(provider, subject)).account.integrations), provider).toEqual(
      [],
    );
  }
});

test("signing in with the Google account a person connected before keeps that one connection", async () => {
  const email = "earlier@signin.test";
  const { session, cookie } = await signedInMember(email);
  const petshop = petshopFakes();
  const { authorizationUrl, connection } = await session.user.integrations.connect("google", {
    next: `${ORIGIN}/`,
  });
  const back = await followConsent(petshop, `${authorizationUrl}&email=${email}`, cookie);
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  const { response } = await signInThroughFake(petshop, "google", { email });
  expect(response).toMatchObject({ status: 303 });
  const subject = String(fakeUserIdOf(email));
  const { account } = await personOf("google", subject);
  expect(account).toMatchObject({
    integrations: { [`/integrations/google/${connection}`]: { externalId: subject } },
  });
  // the next sign-in finds the same connection by its subject again
  expect((await signInThroughFake(petshop, "google", { email })).response).toMatchObject({
    status: 303,
  });
  expect(Object.keys((await personOf("google", subject)).account.integrations)).toEqual([
    `/integrations/google/${connection}`,
  ]);
});

test("a fake provider signs in an address under the test-link domain alone", async () => {
  const petshop = petshopFakes();
  const { response } = await signInThroughFake(petshop, "google", { email: "ada@iterate.com" });
  expect(response).toMatchObject({ status: 403 });
  expect(await response.text()).toContain("under signin.test alone");
  expect(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
  ).toBe(false);
  expect(await controlPlane().getUser("ada@iterate.com")).toBeNull();
});

/** A browser signing in through a pet-shop fake: the platform's redirect to the provider (its
 *  authorize URL recorded, `choices` added as the person's picks), the fake's consent at once, and
 *  the platform's callback — again while the platform sends the browser back for consent. */
async function signInThroughFake(
  petshop: ReturnType<typeof petshopFakes>,
  provider: "google" | "cloudflare" | "github",
  choices: Record<string, string>,
) {
  const path = {
    google: "/.auth/identity",
    cloudflare: "/.auth/identity/cloudflare",
    github: "/.auth/identity/github",
  }[provider];
  let response = await exports.default.fetch(`${ORIGIN}${path}?next=%2F`, { redirect: "manual" });
  const authorizations: URL[] = [];
  while (response.status === 302 && authorizations.length < 3) {
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const authorization = new URL(response.headers.get("location")!);
    authorizations.push(new URL(authorization));
    for (const [key, value] of Object.entries(choices)) authorization.searchParams.set(key, value);
    const consent = (await petshop.handle(new Request(authorization)))!;
    response = await exports.default.fetch(consent.headers.get("location")!, {
      headers: { cookie },
      redirect: "manual",
    });
  }
  return { response, authorizations };
}

/** The person a provider's subject names: their own context, and their account's state. */
async function personOf(provider: "google" | "cloudflare" | "github", subject: string) {
  const user = (await controlPlane().identity(provider, subject))!;
  const person = stub(
    DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path: `/users/${user.id}` }),
  );
  const { state } = (await person.invoke(["itx", "facets", ["get", "account"], ["snapshot"]], [], {
    principal: { actor: user.id, email: user.email },
  })) as { state: AccountState };
  return { user, person, account: state };
}

async function identityLogin(
  provider: "google" | "cloudflare",
  overrides: Record<string, unknown> = {},
  invalidSignature = false,
  wrongState = false,
) {
  // iterate's clients in this suite (wrangler.test.jsonc): Google's at google.test, Cloudflare's
  // issuer under cloudflare.test — answered here by hand, so each row can bend one claim
  const issuer =
    provider === "google" ? "https://google.test" : "https://cloudflare.test/cloudflare";
  const path = provider === "google" ? "/.auth/identity" : "/.auth/identity/cloudflare";
  const tokenEndpoint = provider === "google" ? `${issuer}/token` : `${issuer}/oauth2/token`;
  const jwksEndpoint =
    provider === "google" ? `${issuer}/oauth2/v3/certs` : `${issuer}/.well-known/jwks.json`;
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: `${provider}-test`,
    alg: "RS256",
    use: "sig",
  };
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/auth`,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksEndpoint,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
  let tokenResponse: object | undefined;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === `${issuer}/.well-known/openid-configuration`) return Response.json(metadata);
    if (url.href === jwksEndpoint) return Response.json({ keys: [jwk] });
    if (url.href === tokenEndpoint && tokenResponse) return Response.json(tokenResponse);
    if (url.origin === ORIGIN) return exports.default.fetch(new Request(input, init));
    throw new Error(`Unexpected identity fixture fetch: ${url}`);
  });
  onTestFinished(() => {
    fetchSpy.mockRestore();
  });
  const begin = await exports.default.fetch(
    `${ORIGIN}${path}?next=%2Foauth2%2Fauth%3Fclient%3Dtest`,
    {
      redirect: "manual",
    },
  );
  expect(begin).toMatchObject({ status: 302 });
  const authorization = new URL(begin.headers.get("location")!);
  expect(authorization.searchParams.get("scope")).toBe(
    provider === "google"
      ? DEFAULT_GOOGLE_SIGN_IN_SCOPES.join(" ")
      : "openid user-details.read offline_access",
  );
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${ORIGIN}${path}/callback`);
  const cookie = begin.headers.get("set-cookie")!.split(";")[0]!;
  const claims = {
    iss: issuer,
    sub: "1234567890",
    aud: "petshop-default",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: authorization.searchParams.get("nonce"),
    email: "verified@signin.test",
    email_verified: true,
    ...overrides,
  };
  const signingInput = `${encode({ alg: "RS256", kid: `${provider}-test` })}.${encode(claims)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  if (invalidSignature) signature[0] ^= 1;
  const encodedSignature = btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  tokenResponse = {
    access_token: "upstream-google-access-token",
    // a first Google sign-in with none goes back for the consent screen (the fakes' tests below)
    refresh_token: "upstream-refresh-token",
    token_type: "Bearer",
    expires_in: 3600,
    id_token: `${signingInput}.${encodedSignature}`,
  };
  return exports.default.fetch(
    `${ORIGIN}${path}/callback?code=test-code&state=${wrongState ? "foreign-state" : authorization.searchParams.get("state")}`,
    {
      headers: { cookie },
      redirect: "manual",
    },
  );
}

function encode(value: unknown) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
