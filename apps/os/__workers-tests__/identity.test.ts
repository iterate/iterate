import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { appSession } from "iterate/app-server";
import {
  appConfigOf,
  DEFAULT_GOOGLE_SIGN_IN_SCOPES,
  platformAddressesOf,
  sessionSigningSecretOf,
} from "../src/app-config.ts";
import { verifyClaims } from "../src/caller.ts";
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

test("wrong nonce, signature and unverified email cannot establish issuer identity: each lands on the sign-in page with why", async () => {
  for (const [claims, badSignature, error] of [
    [{ nonce: "foreign-browser" }, false, "Sign-in was refused or expired. Please start again."],
    [{}, true, "Sign-in was refused or expired. Please start again."],
    [{ email_verified: false }, false, "Google must verify your email before you can sign in."],
  ] as const) {
    const response = await identityLogin("google", claims, badSignature);
    expect(signInPageOf(response)).toEqual({ next: "/oauth2/auth?client=test", error });
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
  { name: "wrong nonce", claims: { nonce: "other-browser" }, error: "REFUSED" as const },
  { name: "wrong audience", claims: { aud: "another-client" }, error: "REFUSED" as const },
  { name: "wrong issuer", claims: { iss: "https://google.test" }, error: "REFUSED" as const },
  { name: "expired token", claims: { exp: 1 }, error: "REFUSED" as const },
  { name: "unverified email", claims: { email_verified: false }, error: "UNVERIFIED" as const },
  {
    name: "missing email verification",
    claims: { email_verified: undefined },
    error: "UNVERIFIED" as const,
  },
  { name: "missing email", claims: { email: undefined }, error: "UNVERIFIED" as const },
  { name: "bad signature", claims: {}, signature: true, error: "REFUSED" as const },
  { name: "wrong state", claims: {}, state: true, error: "REFUSED" as const },
])(
  "Cloudflare refuses $name without creating a session, back on the sign-in page with why",
  async ({ claims, signature, state, error }) => {
    const response = await identityLogin("cloudflare", claims, signature, state);
    expect(signInPageOf(response)).toEqual({
      next: "/oauth2/auth?client=test",
      error: {
        REFUSED: "Sign-in was refused or expired. Please start again.",
        UNVERIFIED: "Cloudflare must verify your email before you can sign in.",
      }[error],
    });
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
    expect(signInPageOf(response)).toEqual({
      next: "/",
      error:
        failure === "provider mismatch"
          ? "Sign-in expired. Please start again."
          : "Sign-in was refused or expired. Please start again.",
    });
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
  expect(signInPageOf(response)).toEqual({
    next: "/",
    error: "Google: a fake provider signs in addresses under signin.test alone.",
  });
  expect(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
  ).toBe(false);
  expect(await controlPlane().getUser("ada@iterate.com")).toBeNull();
});

test("GitHub: a person who never approved iterate's Email addresses permission lands on the sign-in page, told how to approve it", async () => {
  const petshop = petshopFakes();
  const refusals = vi.spyOn(console, "info");
  const { response } = await signInThroughFake(petshop, "github", {
    login: "gh-noemail",
    email: "gh-noemail@signin.test",
    emails: "none",
  });
  expect(signInPageOf(response)).toEqual({
    next: "/",
    error:
      "GitHub didn't share your email address with iterate. Revoke iterate at https://github.com/settings/apps/authorizations, then sign in with GitHub again to approve its updated permissions — or sign in another way.",
  });
  expect(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
  ).toBe(false);
  // an expected outcome: logged as the person's refusal, never as a fault
  expect(refusals).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "identity.sign-in-refused",
      provider: "github",
      reason: "github-email-permission",
      acceptedPermissions: "emails=read",
    }),
  );
  expect(await controlPlane().identity("github", String(fakeUserIdOf("gh-noemail")))).toBeNull();
});

test.for<[string, "google" | "cloudflare" | "github"]>([
  ["Google", "google"],
  ["Cloudflare", "cloudflare"],
  ["GitHub", "github"],
])(
  "%s: a callback with no sign-in flow cookie lands on the sign-in page, never an exception",
  async ([, provider]) => {
    const path = {
      google: "/.auth/identity",
      cloudflare: "/.auth/identity/cloudflare",
      github: "/.auth/identity/github",
    }[provider];
    const response = await exports.default.fetch(
      `${ORIGIN}${path}/callback?${new URLSearchParams({ code: "bogus", state: "bogus" })}`,
      { redirect: "manual" },
    );
    expect(signInPageOf(response)).toEqual({
      next: "/",
      error: "Sign-in expired. Please start again.",
    });
  },
);

test.for<[string, (url: URL) => Response | "unreachable" | null, string, string | null]>([
  [
    "a code GitHub refuses to exchange",
    (url) =>
      url.pathname === "/login/oauth/access_token"
        ? Response.json({ error: "bad_verification_code" })
        : null,
    "Sign-in was refused or expired. Please start again.",
    null,
  ],
  [
    "a token endpoint that cannot be reached",
    (url) => (url.pathname === "/login/oauth/access_token" ? "unreachable" : null),
    "GitHub didn't answer. Please try again.",
    "identity.platform-failure-token",
  ],
  [
    "a token endpoint answering 502",
    (url) =>
      url.pathname === "/login/oauth/access_token"
        ? new Response("bad gateway", { status: 502 })
        : null,
    "GitHub didn't answer. Please try again.",
    "identity.platform-failure-token",
  ],
  [
    "/user answering 503",
    (url) => (url.pathname === "/user" ? new Response("unavailable", { status: 503 }) : null),
    "GitHub didn't answer. Please try again.",
    "identity.platform-failure-user",
  ],
  [
    "/user/emails answering 500",
    (url) => (url.pathname === "/user/emails" ? new Response("oops", { status: 500 }) : null),
    "GitHub didn't answer. Please try again.",
    "identity.platform-failure-emails",
  ],
  [
    "a primary address GitHub has not verified",
    (url) =>
      url.pathname === "/user/emails"
        ? Response.json([{ email: "gh-step@signin.test", primary: true, verified: false }])
        : null,
    "GitHub must verify your primary email before you can sign in.",
    null,
  ],
])(
  "GitHub: %s lands on the sign-in page with why, never an exception",
  async ([, failing, error, warned]) => {
    const petshop = failFetch(petshopFakes(), failing);
    const warnings = vi.spyOn(console, "warn");
    const { response } = await signInThroughFake(petshop, "github", {
      login: "gh-step",
      email: "gh-step@signin.test",
    });
    expect(signInPageOf(response)).toEqual({ next: "/", error });
    if (warned)
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ event: warned, provider: "github" }),
      );
  },
);

test("a second Google subject for an address already linked to one lands on the sign-in page, never a 409 page", async () => {
  await controlPlane().linkIdentity("google", "the-first-google-subject", "taken@signin.test");
  const response = await identityLogin("google", {
    email: "taken@signin.test",
    sub: "taken-google",
  });
  expect(signInPageOf(response)).toMatchObject({
    next: "/oauth2/auth?client=test",
    error: expect.any(String),
  });
});

test("a defect of ours after the provider answered is reported, and the person still lands on the sign-in page", async () => {
  const petshop = petshopFakes();
  failFetch(petshop, (url) =>
    url.pathname === "/user" ? Response.json({ unexpected: "shape" }) : null,
  );
  const issues = vi.spyOn(console, "error");
  const { response } = await signInThroughFake(petshop, "github", {
    login: "gh-defect",
    email: "gh-defect@signin.test",
  });
  expect(signInPageOf(response)).toEqual({
    next: "/",
    error: "Sign-in with GitHub failed. Please try again.",
  });
  expect(issues).toHaveBeenCalledWith(
    expect.objectContaining({ event: "issue", failureSite: "identity.sign-in-failed" }),
  );
});

// ADD A SIGN-IN (identity.ts's link mode): a signed-in person adds a provider's account to their
// own, whatever address the provider reports; they stay signed in as they are, and are sent back to
// `next` — a refusal with `error` on it.
const DASH_SESSIONS = "https://dash.test/sessions";

test.for<[string, "google" | "cloudflare" | "github", Record<string, string>, string]>([
  ["Google", "google", { email: "g-add@signin.test" }, "g-add@signin.test"],
  ["Cloudflare", "cloudflare", { email: "cf-add@signin.test" }, "cf-add@signin.test"],
  ["GitHub", "github", { login: "gh-add", email: "gh-add@signin.test" }, "gh-add"],
])(
  "%s: a person signed in with the password adds the account; it signs in to them, their email stays, and its token is their connection",
  async ([, provider, choices, account]) => {
    const email = `add-${provider}@example.test`;
    const { cookie } = await signedInMember(email);
    const person = (await controlPlane().getUser(email))!;
    const petshop = petshopFakes();
    const { response } = await signInThroughFake(petshop, provider, choices, {
      session: cookie,
      person: person.id,
      next: DASH_SESSIONS,
    });
    expect(response, await response.clone().text()).toMatchObject({ status: 303 });
    expect(response.headers.get("location")).toBe(DASH_SESSIONS);
    expect(
      response.headers.getSetCookie().some((value) => value.startsWith("__Host-itx-session=")),
    ).toBe(false);
    const subject = String(fakeUserIdOf(choices.login || choices.email!));
    const { user, account: state } = await personOf(provider, subject);
    expect(user).toEqual(person);
    expect(await controlPlane().getUser(choices.email!)).toBeNull();
    expect(state.integrations[`/integrations/${provider}/${subject}`]).toMatchObject({
      account,
      externalId: subject,
    });
    // signing in with it from now on signs the browser in as them, their email still theirs
    const later = await signInThroughFake(petshop, provider, choices);
    expect(await principalOf(later.response)).toEqual({ actor: person.id, email });
    expect(await controlPlane().getUser(person.id)).toEqual(person);
  },
);

test.for<{
  name: string;
  rounds: Record<string, string>[];
  switched: boolean;
  added: string | null;
}>([
  {
    name: "cancels it",
    rounds: [{ email: "g-cancel@signin.test" }, { cancel: "1" }],
    switched: false,
    added: null,
  },
  {
    name: "answers it as another of their Google accounts",
    rounds: [{ email: "g-first@signin.test" }, { email: "g-second@signin.test" }],
    switched: false,
    added: "g-second@signin.test",
  },
  {
    name: "is signed in as someone else by then",
    rounds: [{ email: "g-late@signin.test" }],
    switched: true,
    added: null,
  },
])(
  "Google: a person adding their account who $name at the consent screen adds only the account they consented as",
  async ({ rounds, switched, added }) => {
    const email = rounds[0]!.email!.replace("@signin.test", "@example.test");
    const { cookie } = await signedInMember(email);
    const { cookie: other } = await signedInMember(`other-${email}`);
    const person = (await controlPlane().getUser(email))!;
    const petshop = petshopFakes();
    const { response, authorizations } = await signInThroughFake(petshop, "google", rounds, {
      session: cookie,
      person: person.id,
      next: DASH_SESSIONS,
      sessionAtCallback: switched ? [cookie, other] : cookie,
    });
    // the account picker, then the consent screen for a refresh token
    expect(authorizations).toHaveLength(2);
    expect(nextPageOf(response)).toMatchObject({
      href: DASH_SESSIONS,
      error: added ? null : expect.any(String),
    });
    for (const round of rounds.filter((picked) => picked.email))
      expect(
        await controlPlane().identity("google", String(fakeUserIdOf(round.email!))),
        round.email,
      ).toEqual(round.email === added ? person : null);
  },
);

test("adding a sign-in the person already has keeps its token again, and they stay who they are", async () => {
  const petshop = petshopFakes();
  const choices = { login: "gh-again", email: "gh-again@signin.test" };
  const signIn = await signInThroughFake(petshop, "github", choices);
  const session = signIn.response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-itx-session="))!
    .split(";")[0]!;
  const subject = String(fakeUserIdOf("gh-again"));
  const { user, person } = await personOf("github", subject);
  // the token gone, the identity still theirs (as when an operator moved it onto them)
  await person.invoke(
    [
      "itx",
      "facets",
      ["get", "account"],
      ["disconnectIntegration", { provider: "github", connection: subject }],
    ],
    [],
    { principal: { actor: user.id, email: user.email } },
  );
  expect(Object.keys((await personOf("github", subject)).account.integrations)).toEqual([]);
  const { response } = await signInThroughFake(petshop, "github", choices, {
    session,
    person: user.id,
    next: DASH_SESSIONS,
  });
  expect(response.headers.get("location")).toBe(DASH_SESSIONS);
  const after = await personOf("github", subject);
  expect(after).toMatchObject({ user });
  expect(Object.keys(after.account.integrations)).toEqual([`/integrations/github/${subject}`]);
});

test.for(["signed in as someone else", "signed out"])(
  "adding a sign-in whose browser is %s by the time the provider answers is refused, back on next with why",
  async (by) => {
    const { cookie: ada } = await signedInMember(`ada-${by.length}@example.test`);
    const adaId = (await controlPlane().getUser(`ada-${by.length}@example.test`))!.id;
    const { cookie: bob } = await signedInMember(`bob-${by.length}@example.test`);
    const petshop = petshopFakes();
    const refusals = vi.spyOn(console, "info");
    const login = `gh-switched-${by.length}`;
    const { response } = await signInThroughFake(
      petshop,
      "github",
      { login, email: `${login}@signin.test` },
      {
        session: ada,
        person: adaId,
        next: DASH_SESSIONS,
        sessionAtCallback: by === "signed out" ? "__Host-itx-session=signed-out" : bob,
      },
    );
    expect(nextPageOf(response)).toEqual({
      href: DASH_SESSIONS,
      error: "Your sign-in changed while you were at GitHub. Please start again.",
    });
    expect(refusals).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "identity.sign-in-refused",
        provider: "github",
        reason: "link-session-changed",
      }),
    );
    expect(await controlPlane().identity("github", String(fakeUserIdOf(login)))).toBeNull();
  },
);

test("adding a GitHub account another person signs in with is refused, back on next with why", async () => {
  const { cookie } = await signedInMember("taker@example.test");
  const petshop = petshopFakes();
  const choices = { login: "gh-taken", email: "gh-taken@signin.test" };
  expect((await signInThroughFake(petshop, "github", choices)).response).toMatchObject({
    status: 303,
  });
  const holder = await controlPlane().identity("github", String(fakeUserIdOf("gh-taken")));
  const next = "https://dash.test/projects/p/integrations?connect=github";
  const { response } = await signInThroughFake(petshop, "github", choices, {
    session: cookie,
    person: (await controlPlane().getUser("taker@example.test"))!.id,
    next,
  });
  expect(nextPageOf(response)).toEqual({
    href: next,
    error: "This GitHub account signs in to another iterate account.",
  });
  expect(await controlPlane().identity("github", String(fakeUserIdOf("gh-taken")))).toEqual(holder);
});

test("adding a sign-in starts only from a browser signed in as the person the link names, and only toward the platform or the Dash", async () => {
  const start = (query: Record<string, string>, cookie?: string) =>
    exports.default.fetch(`${ORIGIN}/.auth/identity/github?${new URLSearchParams(query)}`, {
      redirect: "manual",
      ...(cookie && { headers: { cookie } }),
    });
  const { cookie } = await signedInMember("starter@example.test");
  const starter = (await controlPlane().getUser("starter@example.test"))!;
  // nobody signed in: sign in first, and come back to add it
  const link = `/.auth/identity/github?${new URLSearchParams({ link: starter.id, next: DASH_SESSIONS })}`;
  const anonymous = await start({ link: starter.id, next: DASH_SESSIONS });
  expect(anonymous).toMatchObject({ status: 302 });
  expect(anonymous.headers.get("location")).toBe(`/login?${new URLSearchParams({ next: link })}`);
  // signed in as someone else than the Dash that made the link: switch account first
  const { cookie: someoneElse } = await signedInMember("someone-else@example.test");
  const refusals = vi.spyOn(console, "info");
  expect(signInPageOf(await start({ link: starter.id, next: DASH_SESSIONS }, someoneElse))).toEqual(
    {
      next: link,
      error:
        "This browser is signed in to iterate as someone else. Switch account to add it to yours.",
    },
  );
  expect(refusals).toHaveBeenCalledWith(
    expect.objectContaining({ event: "identity.sign-in-refused", reason: "link-person-mismatch" }),
  );
  for (const next of ["https://evil.test/sessions", "//evil.test/", "javascript:alert(1)"]) {
    const response = await start({ link: starter.id, next }, cookie);
    expect(signInPageOf(response), next).toEqual({
      next: "/",
      error: "That link can't add a sign-in. Please start again from your account.",
    });
  }
  for (const [next, landing] of [
    [DASH_SESSIONS, DASH_SESSIONS],
    ["/login", `${ORIGIN}/login`],
  ] as const) {
    const response = await start({ link: starter.id, next }, cookie);
    expect(response, next).toMatchObject({ status: 302 });
    expect(new URL(response.headers.get("location")!), next).toMatchObject({
      origin: "https://github.test",
    });
    // a flow of its own kind, which a sign-in's callback (an older version's too) refuses
    const flow = response.headers.getSetCookie()[0]!.split(";")[0]!.split("=")[1]!;
    expect(
      await verifyClaims(flow, await sessionSigningSecretOf(appConfigOf(env))),
      next,
    ).toMatchObject({ kind: "identity-link", linkTo: starter.id, next: landing });
  }
});

/** A browser signing in through a pet-shop fake: the platform's redirect to the provider (its
 *  authorize URL recorded, `choices` added as the person's picks), the fake's consent at once, and
 *  the platform's callback — again while the platform sends the browser back for consent. With
 *  `link`, the browser signed in as `session` adds the account to `person` (the Dash's link names
 *  them) instead, back to `next` (`sessionAtCallback`: the session the browser holds by the time
 *  the provider answers).
 *  A list of `choices` or of `sessionAtCallback` is one per round, its last repeated; a round's
 *  `cancel` declines at the provider. */
async function signInThroughFake(
  petshop: ReturnType<typeof petshopFakes>,
  provider: "google" | "cloudflare" | "github",
  choices: Record<string, string> | Record<string, string>[],
  link?: { session: string; person: string; next: string; sessionAtCallback?: string | string[] },
) {
  const path = {
    google: "/.auth/identity",
    cloudflare: "/.auth/identity/cloudflare",
    github: "/.auth/identity/github",
  }[provider];
  let response = await exports.default.fetch(
    link
      ? `${ORIGIN}${path}?${new URLSearchParams({ link: link.person, next: link.next })}`
      : `${ORIGIN}${path}?next=%2F`,
    { redirect: "manual", ...(link && { headers: { cookie: link.session } }) },
  );
  const authorizations: URL[] = [];
  const at = <T>(value: T | T[], round: number) =>
    Array.isArray(value) ? value[Math.min(round, value.length - 1)]! : value;
  while (response.status === 302 && authorizations.length < 3) {
    const round = authorizations.length;
    const flow = response.headers.get("set-cookie")!.split(";")[0]!;
    const authorization = new URL(response.headers.get("location")!);
    authorizations.push(new URL(authorization));
    const picks = at(choices, round);
    let back: string;
    if (picks.cancel)
      back = `${authorization.searchParams.get("redirect_uri")}?${new URLSearchParams({ error: "access_denied", state: authorization.searchParams.get("state")! })}`;
    else {
      for (const [key, value] of Object.entries(picks)) authorization.searchParams.set(key, value);
      back = (await petshop.handle(new Request(authorization)))!.headers.get("location")!;
    }
    const session = link && at(link.sessionAtCallback || link.session, round);
    response = await exports.default.fetch(back, {
      headers: { cookie: session ? `${session}; ${flow}` : flow },
      redirect: "manual",
    });
  }
  return { response, authorizations };
}

/** Whom a sign-in's answer signed the browser in as: its new session's principal. */
async function principalOf(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-itx-session="))!
    .split(";")[0]!;
  const session = appSession(env.BROWSER_SESSION, new Request(ORIGIN, { headers: { cookie } }))!;
  const auth = await authorizationForToken(
    env,
    (await session.bearer())!,
    platformAddressesOf(env, new Request(ORIGIN)),
    "browser-session",
  );
  return auth?.principal;
}

/** Where an added sign-in's refusal sent the browser: back to `next`, the `error` beside it. */
function nextPageOf(response: Response) {
  expect(response).toMatchObject({ status: 303 });
  const location = new URL(response.headers.get("location")!);
  const error = location.searchParams.get("error");
  location.searchParams.delete("error");
  return { href: location.href, error };
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
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === `${issuer}/.well-known/openid-configuration`) return Response.json(metadata);
    if (url.href === jwksEndpoint) return Response.json({ keys: [jwk] });
    if (url.href === tokenEndpoint && tokenResponse) return Response.json(tokenResponse);
    if (url.origin === ORIGIN) return exports.default.fetch(new Request(input, init));
    throw new Error(`Unexpected identity fixture fetch: ${url}`);
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

/** Where a sign-in callback sent the browser, when it is the sign-in page: `next` and the `error`
 *  the page shows. */
function signInPageOf(response: Response) {
  expect(response).toMatchObject({ status: 303 });
  const location = new URL(response.headers.get("location")!, ORIGIN);
  expect(location).toMatchObject({ pathname: "/login" });
  return { next: location.searchParams.get("next"), error: location.searchParams.get("error") };
}

/** The pet shop's fakes, with one GitHub request answered by `failing` instead: a response, or
 *  "unreachable" for a fetch that throws; null passes the request to the fake. */
function failFetch(
  petshop: ReturnType<typeof petshopFakes>,
  failing: (url: URL) => Response | "unreachable" | null,
) {
  const spy = vi.mocked(globalThis.fetch);
  const answer = spy.getMockImplementation()!;
  spy.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const failure = url.hostname === "github.test" ? failing(url) : null;
    if (failure === "unreachable") throw new TypeError("Network connection lost.");
    return failure || answer(input, init);
  });
  return petshop;
}
