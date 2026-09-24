import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { appSession } from "iterate/next/app-server";
import { platformAddressesOf } from "../src/app-config.ts";
import { authorizationForToken } from "../src/oauth.ts";
import { ControlPlane } from "../src/control-plane/edge.ts";
const origin = "https://control.test";
const encode = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
/** The control plane as the edge holds it (src/control-plane/edge.ts) — the same reads identity.ts
 *  links a Google sign-in through, and the catalog the links are read back from. */
const controlPlane = () => new ControlPlane(env.CONTROL_PLANE);

afterEach(() => vi.restoreAllMocks());

async function identityLogin(
  provider: "google" | "cloudflare",
  overrides: Record<string, unknown> = {},
  invalidSignature = false,
  wrongState = false,
) {
  const issuer =
    provider === "google" ? "https://accounts.google.com" : "https://dash.cloudflare.com";
  const path = provider === "google" ? "/.auth/identity" : "/.auth/identity/cloudflare";
  const tokenEndpoint =
    provider === "google" ? "https://oauth2.googleapis.com/token" : `${issuer}/oauth2/token`;
  const jwksEndpoint =
    provider === "google"
      ? "https://www.googleapis.com/oauth2/v3/certs"
      : `${issuer}/.well-known/jwks.json`;
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
    if (url.origin === origin) return exports.default.fetch(new Request(input, init));
    throw new Error(`Unexpected identity fixture fetch: ${url}`);
  });
  const begin = await exports.default.fetch(
    `${origin}${path}?next=%2Foauth2%2Fauth%3Fclient%3Dtest`,
    {
      redirect: "manual",
    },
  );
  expect(begin.status).toBe(302);
  const authorization = new URL(begin.headers.get("location")!);
  expect(authorization.searchParams.get("scope")).toBe(
    provider === "google" ? "openid email profile" : "openid user-details.read",
  );
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${origin}${path}/callback`);
  const cookie = begin.headers.get("set-cookie")!.split(";")[0]!;
  const claims = {
    iss: issuer,
    sub: "1234567890",
    aud: `${provider}-test-client`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: authorization.searchParams.get("nonce"),
    email: "verified@example.com",
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
    token_type: "Bearer",
    expires_in: 3600,
    id_token: `${signingInput}.${encodedSignature}`,
  };
  return exports.default.fetch(
    `${origin}${path}/callback?code=test-code&state=${wrongState ? "foreign-state" : authorization.searchParams.get("state")}`,
    {
      headers: { cookie },
      redirect: "manual",
    },
  );
}

test("Google proves issuer identity; upstream credentials never become app tokens", async () => {
  const response = await identityLogin("google");
  expect(response.status, await response.clone().text()).toBe(303);
  expect(response.headers.get("location")).toBe("/oauth2/auth?client=test");
  const cookies = response.headers.getSetCookie();
  expect(cookies.join()).not.toContain("upstream-google-access-token");
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("__Host-itx-session="))!;
  const ctx = createExecutionContext();
  const session = appSession(
    env.BROWSER_SESSION,
    new Request(origin, { headers: { cookie: sessionCookie } }),
  )!;
  const auth = await authorizationForToken(
    env,
    ctx,
    (await session.bearer())!,
    platformAddressesOf(env, new Request(`${origin}/`)),
  );
  await waitOnExecutionContext(ctx);
  // the person's id is minted by the control plane; Google's subject names them from now on
  expect(auth?.principal).toEqual({
    actor: expect.stringMatching(/^user_[0-9a-f]{32}$/),
    email: "verified@example.com",
  });
  expect(await controlPlane().identity("google", "1234567890")).toEqual({
    id: auth?.principal.actor,
    email: "verified@example.com",
  });
  expect(auth?.grant?.kind).toBe("issuer");
  const api = await exports.default.fetch(`${origin}/api`, {
    method: "POST",
    body: "",
    headers: { cookie: sessionCookie, origin },
  });
  expect(api.status).toBe(200);
  expect(cookies).toHaveLength(2); // Cleared Google flow plus the sole app-session cookie.
});

test("Google subject keeps the same principal when its verified email changes", async () => {
  expect((await identityLogin("google")).status).toBe(303);
  const before = await controlPlane().identity("google", "1234567890");
  expect(before).toEqual({ id: expect.stringMatching(/^user_/), email: "verified@example.com" });
  const response = await identityLogin("google", { email: "changed@example.com" });
  expect(response.status).toBe(303);
  // the subject still names the same user; the email followed it
  expect(await controlPlane().identity("google", "1234567890")).toEqual({
    id: before!.id,
    email: "changed@example.com",
  });
  expect(await controlPlane().getUser(before!.id)).toEqual({
    id: before!.id,
    email: "changed@example.com",
  });
  expect(await controlPlane().getUser("verified@example.com")).toBeNull();
});

test("wrong nonce, signature and unverified email cannot establish issuer identity", async () => {
  for (const [claims, badSignature, status] of [
    [{ nonce: "foreign-browser" }, false, 400],
    [{}, true, 400],
    [{ email_verified: false }, false, 403],
  ] as const) {
    const response = await identityLogin("google", claims, badSignature);
    expect(response.status).toBe(status);
    expect(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
    ).toBe(false);
  }
});

test("an email alone never makes a session: a code follows it; only the administrator credential signs a fixture straight in", async () => {
  const response = await exports.default.fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ email: "unverified@example.com" }),
  });
  expect(response.status).toBe(303);
  expect(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
  ).toBe(false);
  expect(
    (await exports.default.fetch("https://unknown.projects.test/.auth/identity/callback")).status,
  ).toBe(421);
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
  expect(oldEmail.id).not.toBe(fixture.id);
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
    email: "cloudflare@identity.test",
  });
  expect(response.status, await response.clone().text()).toBe(303);
  expect(response.headers.get("location")).toBe("/oauth2/auth?client=test");
  const cookies = response.headers.getSetCookie();
  expect(cookies.join()).not.toContain("upstream-google-access-token");
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("__Host-itx-session="))!;
  const ctx = createExecutionContext();
  const session = appSession(
    env.BROWSER_SESSION,
    new Request(origin, { headers: { cookie: sessionCookie } }),
  )!;
  const auth = await authorizationForToken(
    env,
    ctx,
    (await session.bearer())!,
    platformAddressesOf(env, new Request(origin)),
  );
  await waitOnExecutionContext(ctx);
  expect(auth?.principal).toEqual({
    actor: expect.stringMatching(/^user_[0-9a-f]{32}$/),
    email: "cloudflare@identity.test",
  });
  expect(auth?.grant?.kind).toBe("issuer");
});

test.for([
  { name: "wrong nonce", claims: { nonce: "other-browser" }, status: 400 },
  { name: "wrong audience", claims: { aud: "another-client" }, status: 400 },
  { name: "wrong issuer", claims: { iss: "https://accounts.google.com" }, status: 400 },
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
    expect(response.status).toBe(status);
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
  expect(google.id).not.toBe(cloudflare.id);
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
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/oauth2/auth`,
          token_endpoint: `${url.origin}/oauth2/token`,
          jwks_uri: `${url.origin}/.well-known/jwks.json`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      if (url.origin === origin) return exports.default.fetch(new Request(input, init));
      throw new Error(`Unexpected token exchange for ${failure}`);
    });
    const begin = await exports.default.fetch(`${origin}/.auth/identity/cloudflare`, {
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
    const response = await exports.default.fetch(`${origin}${path}?${params}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(
      response.headers.getSetCookie().some((value) => value.startsWith("__Host-itx-session=")),
    ).toBe(false);
  },
);
