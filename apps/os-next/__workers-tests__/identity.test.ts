import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { appSession } from "iterate/next/app-server";
import { authorizationForToken } from "../src/oauth.ts";
import { directory } from "../src/directory.ts";
import { cleanGrantActivity } from "../src/oauth.ts";
import type { Env } from "../src/control-plane.ts";
import schema from "../src/control-plane.sql?raw";

const bindings = env as unknown as Env;
const origin = "https://control.test";
const encode = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

beforeAll(async () => {
  await bindings.DB.batch(
    schema
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => bindings.DB.prepare(s)),
  );
});
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
    if (url.origin === origin) return SELF.fetch(new Request(input, init));
    throw new Error(`Unexpected identity fixture fetch: ${url}`);
  });
  const begin = await SELF.fetch(`${origin}${path}?next=%2Foauth2%2Fauth%3Fclient%3Dtest`, {
    redirect: "manual",
  });
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
  return SELF.fetch(
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
    bindings.BROWSER_SESSION,
    new Request(origin, { headers: { cookie: sessionCookie } }),
  )!;
  const auth = await authorizationForToken(
    bindings,
    ctx,
    (await session.bearer())!,
    "https://control.test",
  );
  await waitOnExecutionContext(ctx);
  expect(auth?.principal).toEqual({
    actor: expect.stringMatching(/^user_google_/),
    email: "verified@example.com",
  });
  expect(auth?.grant?.kind).toBe("issuer");
  const api = await SELF.fetch(`${origin}/api`, {
    method: "POST",
    body: "",
    headers: { cookie: sessionCookie, origin },
  });
  expect(api.status).toBe(200);
  expect(cookies).toHaveLength(2); // Cleared Google flow plus the sole app-session cookie.
});

test("Google subject keeps the same principal when its verified email changes", async () => {
  const registry = directory(bindings.DB);
  const before = await registry.upsertIdentityUser(
    "google",
    "email-change-subject",
    "before@identity.test",
  );
  const response = await identityLogin("google", {
    sub: "email-change-subject",
    email: "changed@example.com",
  });
  expect(response.status).toBe(303);
  const row = await bindings.DB.prepare("SELECT id, email FROM users WHERE id = ?")
    .bind(before.id)
    .first();
  expect(row).toEqual({ id: before.id, email: "changed@example.com" });
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
  const response = await SELF.fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ email: "unverified@example.com" }),
  });
  expect(response.status).toBe(303);
  expect(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
  ).toBe(false);
  expect((await SELF.fetch("https://unknown.projects.test/.auth/identity/callback")).status).toBe(
    421,
  );
});

test("activity cleanup retains recent authority and unresolved provider cleanup", async () => {
  const old = Date.now() - 32 * 24 * 3600_000;
  for (const [id, used, revoked, pending] of [
    ["old-use", old, null, 0],
    ["old-revoke", null, old, 0],
    ["current", Date.now(), null, 0],
    ["pending", old, old, 1],
  ] as const)
    await bindings.DB.prepare(
      "INSERT INTO oauth_activity (user_id, grant_id, last_used_at, revoked_at, cleanup_pending) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("cleanup-test", id, used, revoked, pending)
      .run();
  await cleanGrantActivity(bindings);
  const rows = await bindings.DB.prepare(
    "SELECT grant_id FROM oauth_activity WHERE user_id = ? ORDER BY grant_id",
  )
    .bind("cleanup-test")
    .all();
  expect(rows.results).toEqual([{ grant_id: "current" }, { grant_id: "pending" }]);
});

test("verified Google identity adopts a fixture account once and cannot take another linked identity", async () => {
  const registry = directory(bindings.DB);
  const fixture = await registry.upsertUser("fixture@identity.test");
  const linked = await registry.upsertIdentityUser("google", "fixture-subject", fixture.email);
  expect(linked.id).toBe(fixture.id);
  await expect(
    registry.upsertIdentityUser("google", "different-subject", fixture.email),
  ).rejects.toThrow(/another linked account/);
  const changed = await registry.upsertIdentityUser(
    "google",
    "fixture-subject",
    "new@identity.test",
  );
  expect(changed.id).toBe(fixture.id);
  const oldEmail = await registry.upsertUser("fixture@identity.test");
  expect(oldEmail.id).not.toBe(fixture.id);
  expect(await registry.upsertUser(changed.email)).toEqual(changed);
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
    bindings.BROWSER_SESSION,
    new Request(origin, { headers: { cookie: sessionCookie } }),
  )!;
  const auth = await authorizationForToken(bindings, ctx, (await session.bearer())!, origin);
  await waitOnExecutionContext(ctx);
  expect(auth?.principal).toEqual({
    actor: expect.stringMatching(/^user_cloudflare_/),
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
  const registry = directory(bindings.DB);
  const google = await registry.upsertIdentityUser(
    "google",
    "same-subject",
    "google-only@identity.test",
  );
  const cloudflare = await registry.upsertIdentityUser(
    "cloudflare",
    "same-subject",
    "cf-only@identity.test",
  );
  expect(google.id).not.toBe(cloudflare.id);
  const linked = await registry.upsertIdentityUser("cloudflare", "linked-cf", google.email);
  expect(linked.id).toBe(google.id);
  await expect(
    registry.upsertIdentityUser("cloudflare", "another-cf", google.email),
  ).rejects.toThrow(/another linked account/);
  await expect(
    registry.upsertIdentityUser("cloudflare", "same-subject", google.email),
  ).rejects.toThrow(/another account/);
});

test("existing Google identity links migrate without changing users or memberships", async () => {
  const registry = directory(bindings.DB);
  const existing = await registry.upsertUser("legacy@identity.test", "user_google_legacy");
  const org = await registry.createOrg(existing.id, "Legacy identity org");
  await bindings.DB.prepare("INSERT INTO google_identities (subject, user_id) VALUES (?, ?)")
    .bind("legacy-subject", existing.id)
    .run();
  for (let pass = 0; pass < 2; pass++) {
    await bindings.DB.batch(
      schema
        .replace(/--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => bindings.DB.prepare(s)),
    );
    expect(await registry.upsertIdentityUser("google", "legacy-subject", existing.email)).toEqual(
      existing,
    );
  }
  expect((await registry.listOrgs(existing.id)).some((entry) => entry.id === org.id)).toBe(true);
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
      if (url.origin === origin) return SELF.fetch(new Request(input, init));
      throw new Error(`Unexpected token exchange for ${failure}`);
    });
    const begin = await SELF.fetch(`${origin}/.auth/identity/cloudflare`, { redirect: "manual" });
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
    const response = await SELF.fetch(`${origin}${path}?${params}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(
      response.headers.getSetCookie().some((value) => value.startsWith("__Host-itx-session=")),
    ).toBe(false);
  },
);
